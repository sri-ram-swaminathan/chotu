// ─────────────────────────────────────────────────────────────────────────────
// RECOMMENDER AGENT — picks your daily 2.
//
// Split on purpose into RULES (plain code — invariants must be deterministic) and JUDGEMENT (LLM):
//
// Rules
//   1. At most N (=2) pending recommendations at any time, and at most N new ones per day.
//   2. New ones come from the daily run, from deciding on pending ones (check-in), or /more.
//   3. Never recommend a company you've applied to, have pending, rejected ("don't like company"),
//      or that the visa agent marked "unlikely". Never re-send a job you were already alerted about.
//   4. Slot 1 = best match ("exploit"); slot 2 = exploration (PhD, accelerator, startup outreach,
//      visa-"likely" startups) so the system doesn't only reinforce what it already knows.
//   5. Visa gate: before a company is recommended, the visa agent checks it (cached 60 days).
//
// Judgement
//   The top-K candidates by score go to an LLM together with your recent apply/skip history and
//   reasons (feedback.ts). It reorders them and writes a one-line "why this, why today" pitch.
//   If the LLM is unavailable, plain score order is used — the system degrades, it doesn't stop.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod";
import type { Env } from "../env";
import { all, first, kvGet, kvSet, run } from "../lib/db";
import { escapeHtml, localDay, nowIso, truncate, uid } from "../lib/util";
import { LLM } from "../llm/provider";
import { enqueue } from "../pipeline/tasks";
import { loadProfile, profileDigest, type Profile } from "../profile/profile";
import { notify, type Keyboard } from "../telegram/api";
import type { Dossier, Outreach } from "../agents/companyResearch";
import { checkVisa, VISA_BADGE } from "../agents/visaAgent";
import { DISLIKED_COMPANIES_SQL, feedbackDigest, IGNORE_REASONS } from "./feedback";
import { careerOpsLine, SCORE_BANDS, type BandId } from "../pipeline/careerOps";

export { IGNORE_REASONS };

interface Candidate {
  job_id: string | null; company_id: string; score: number; kind: string; title: string; company: string;
  location: string | null; visa: string | null; summary: string | null;
  co_global?: number | null; co_band?: string | null; co_decision?: string | null; co_archetype?: string | null; co_legitimacy?: string | null;
}

// Companies that are "taken" or ruled out.
const EXCLUDED_COMPANIES = `
  SELECT company_id FROM applications WHERE status NOT IN ('rejected','withdrawn')
  UNION SELECT company_id FROM recommendations WHERE status = 'pending' AND company_id IS NOT NULL
  UNION SELECT id FROM companies WHERE visa_status = 'unlikely'
  UNION ${DISLIKED_COMPANIES_SQL}`;

// career-ops gate: never recommend below the configured band, nor anything career-ops says to Skip.
// Jobs scored before career-ops existed (co_global NULL) still compete on the old score until re-scored.
let minCareerOps = 3.0;
const careerOpsGate = `(s.co_global IS NULL OR (s.co_global >= ? AND COALESCE(s.co_decision, '') != 'Skip'))`;

async function topJobs(env: Env, where: string, k: number): Promise<Candidate[]> {
  return all<Candidate>(
    env.DB,
    `SELECT j.id AS job_id, j.company_id, s.combined AS score, j.kind, j.title, c.name AS company, j.location, j.visa, s.summary,
            s.co_global, s.co_band, s.co_decision, s.co_archetype, s.co_legitimacy
     FROM jobs j JOIN scores s ON s.job_id = j.id JOIN companies c ON c.id = j.company_id
     WHERE j.stage = 'scored' AND j.visa != 'blocked'
       AND (j.deadline IS NULL OR j.deadline >= date('now'))
       AND j.company_id NOT IN (${EXCLUDED_COMPANIES})
       AND j.id NOT IN (SELECT job_id FROM alerts)
       AND ${careerOpsGate}
       AND ${where}
     ORDER BY (s.co_decision = 'Apply') DESC, s.combined DESC LIMIT ?`,
    minCareerOps, k,
  );
}

/** Companies with a fresh dossier + outreach draft but no open job — pitch them directly. */
async function topOutreach(env: Env, k: number): Promise<Candidate[]> {
  const rows = await all<{ company_id: string; company: string; dossier: string; region: string | null }>(
    env.DB,
    `SELECT r.company_id, c.name AS company, r.dossier, c.region FROM company_research r JOIN companies c ON c.id = r.company_id
     WHERE r.outreach IS NOT NULL AND r.created_at >= datetime('now', '-45 days')
       AND r.company_id NOT IN (${EXCLUDED_COMPANIES})
       AND r.company_id NOT IN (SELECT company_id FROM recommendations WHERE company_id IS NOT NULL AND created_at >= datetime('now','-60 days'))
     ORDER BY r.created_at DESC LIMIT 20`,
  );
  return rows.map((r) => {
    const d = JSON.parse(r.dossier) as Dossier;
    return {
      job_id: null, company_id: r.company_id, score: (d.fit_for_me.score + d.interest_for_me.score) / 2, kind: "outreach",
      title: "Direct outreach", company: r.company, location: d.hq ?? r.region, visa: d.visa_assessment.verdict, summary: d.one_liner,
    };
  }).sort((a, b) => b.score - a.score).slice(0, k);
}

async function pool(env: Env, profile: Profile, slot: "best" | "explore", k: number): Promise<Candidate[]> {
  const band: BandId = profile.scoring.career_ops.recommend_min_band;
  minCareerOps = SCORE_BANDS.find((b) => b.id === band)?.min ?? 3.0;
  const best = () => topJobs(env, "j.kind IN ('job','internship')", k);
  const explore = async () => (await Promise.all([
    topJobs(env, "j.kind NOT IN ('job','internship')", k),                    // PhD, accelerator, hackathon
    topJobs(env, "j.kind IN ('job','internship') AND j.visa = 'likely'", k),  // funded startup, unlisted sponsor
    topOutreach(env, k),                                                       // researched company, no posting
  ])).flat().sort((a, b) => b.score - a.score);
  let list = slot === "best" ? await best() : await explore();
  if (!list.length) list = slot === "best" ? await explore() : await best(); // fall back to the other pool
  const dedup = new Map<string, Candidate>();
  for (const c of list) if (!dedup.has(c.job_id ?? `co:${c.company_id}`)) dedup.set(c.job_id ?? `co:${c.company_id}`, c);
  return [...dedup.values()].slice(0, k);
}

const Rerank = z.object({ order: z.array(z.object({ index: z.number().int(), pitch: z.string() })).min(1) });

/** LLM judgement: reorder candidates using your feedback history. Falls back to score order. */
async function rerank(env: Env, profile: Profile, slot: string, cands: Candidate[]): Promise<{ c: Candidate; pitch: string | null }[]> {
  const fallback = cands.map((c) => ({ c, pitch: null as string | null }));
  if (!profile.scoring.recommender.rerank_with_llm || cands.length < 2) return fallback;
  try {
    const { data } = await new LLM(env).json({
      purpose: "recommend_rerank", tier: "reasoning", temperature: 0.2,
      system: `You are the candidate's recommender. Order the candidates for the "${slot}" slot (${slot === "best"
        ? "the single strongest opportunity to act on today"
        : "an exploration pick: PhD, accelerator, startup outreach — something adjacent they might not have looked for"}).
Weigh: score (career-ops "Apply" beats "Consider"), the candidate's stated goals, and especially their PAST DECISIONS — avoid what they keep skipping (and why),
lean toward what they applied to. For each, write a one-sentence pitch: why this, why today (deadline, freshness, a specific
match). Return all indices, best first.`,
      prompt: `CANDIDATE PROFILE:\n${truncate(profileDigest(profile, { includeBullets: false }), 3000)}\n\nPAST DECISIONS:\n${await feedbackDigest(env, 25)}\n\nCANDIDATES:\n` +
        cands.map((c, i) => `[${i}] ${c.title} @ ${c.company} (${c.kind}) | ${c.location ?? "?"} | score ${c.score.toFixed(1)}${c.co_global != null ? ` | career-ops ${careerOpsLine({ co_global: c.co_global, co_band: c.co_band ?? null, co_decision: c.co_decision ?? null, co_archetype: c.co_archetype ?? null, co_legitimacy: c.co_legitimacy })}` : ""} | visa ${c.visa ?? "?"}\n    ${truncate(c.summary, 220)}`).join("\n") +
        `\n\nReturn JSON: {"order":[{"index": n, "pitch": "..."}]}`,
    }, Rerank);
    const seen = new Set<number>();
    const ordered: { c: Candidate; pitch: string | null }[] = [];
    for (const o of data.order) {
      const c = cands[o.index];
      if (!c || seen.has(o.index)) continue;
      seen.add(o.index);
      ordered.push({ c, pitch: o.pitch });
    }
    return [...ordered, ...fallback.filter((_, i) => !seen.has(i))];
  } catch {
    return fallback;
  }
}

/** Visa gate. True = OK to recommend. Uses the cached company verdict when fresh. */
async function visaOk(env: Env, profile: Profile, c: Candidate): Promise<boolean> {
  if (!profile.constraints.visa.needs_sponsorship || c.visa === "confirmed") return true;
  try {
    const v = await checkVisa(env, c.company_id, { location: c.location });
    if (v.status === "confirmed" && c.job_id) await run(env.DB, "UPDATE jobs SET visa = 'confirmed' WHERE id = ?", c.job_id);
    return v.status !== "unlikely";
  } catch {
    return true; // a search outage shouldn't block recommendations; the card shows "unverified"
  }
}

const dayKey = (env: Env) => `recs_created:${localDay(env.TIMEZONE)}`;

/**
 * Fill free slots. `force` (/more) ignores the per-day cap but never the pending-slot cap.
 * Returns the ids of newly created recommendations (each one is sent to Telegram).
 */
export async function fillSlots(env: Env, opts: { max?: number; force?: boolean } = {}) {
  const slots = Number(env.RECOMMENDATION_SLOTS);
  const pending = await all<{ slot_type: string }>(env.DB, "SELECT slot_type FROM recommendations WHERE status = 'pending'");
  const createdToday = Number((await kvGet(env.DB, dayKey(env))) || 0);
  let free = Math.min(slots - pending.length, opts.max ?? slots);
  if (!opts.force) free = Math.min(free, slots - createdToday);
  const created: string[] = [];
  if (free <= 0) return created;

  const profile = await loadProfile(env);
  const k = profile.scoring.recommender.candidates;
  const taken = pending.map((p) => p.slot_type);

  for (let i = 0; i < free; i++) {
    // Keep one of each slot type when possible.
    const slot: "best" | "explore" = !taken.includes("best") ? "best" : !taken.includes("explore") ? "explore" : "best";
    const ranked = await rerank(env, profile, slot, await pool(env, profile, slot, k));
    let pick: { c: Candidate; pitch: string | null } | null = null;
    for (const r of ranked.slice(0, 4)) { // at most 4 visa checks per slot
      if (await visaOk(env, profile, r.c)) { pick = r; break; }
    }
    if (!pick) break;
    taken.push(slot);
    const id = uid();
    await run(env.DB, "INSERT INTO recommendations(id, job_id, company_id, slot_type, status, pitch, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      id, pick.c.job_id, pick.c.company_id, slot, pick.pitch, nowIso());
    if (pick.c.job_id) await run(env.DB, "UPDATE jobs SET stage = 'recommended' WHERE id = ?", pick.c.job_id);
    await kvSet(env.DB, dayKey(env), String(createdToday + created.length + 1));
    const msgId = await sendRecommendation(env, id);
    if (msgId) await run(env.DB, "UPDATE recommendations SET telegram_msg_id = ? WHERE id = ?", msgId, id);
    created.push(id);
  }
  return created;
}

export async function recommendationCard(env: Env, recId: string): Promise<{ html: string; keyboard: Keyboard } | null> {
  const r = await first<{
    id: string; slot_type: string; job_id: string | null; company_id: string; title: string | null; kind: string | null; location: string | null;
    url: string | null; deadline: string | null; visa: string | null; company: string; ind_sponsor: number; funded_stage: string | null;
    fit: number | null; interest: number | null; summary: string | null; fit_evidence: string | null; fit_gaps: string | null;
    pitch: string | null; visa_status: string | null;
    co_global: number | null; co_band: string | null; co_decision: string | null; co_archetype: string | null; co_legitimacy: string | null;
    co_cv_match: number | null; co_north_star: number | null; co_comp: number | null; co_culture: number | null; co_red_flags: number | null;
    co_red_flag_notes: string | null;
  }>(
    env.DB,
    `SELECT r.id, r.slot_type, r.job_id, r.company_id, j.title, j.kind, j.location, j.url, j.deadline, j.visa,
            c.name AS company, c.ind_sponsor, c.funded_stage, s.fit, s.interest, s.summary, s.fit_evidence, s.fit_gaps,
            r.pitch, c.visa_status, s.co_global, s.co_band, s.co_decision, s.co_archetype, s.co_legitimacy,
            s.co_cv_match, s.co_north_star, s.co_comp, s.co_culture, s.co_red_flags, s.co_red_flag_notes
     FROM recommendations r JOIN companies c ON c.id = r.company_id
     LEFT JOIN jobs j ON j.id = r.job_id LEFT JOIN scores s ON s.job_id = r.job_id WHERE r.id = ?`,
    recId,
  );
  if (!r) return null;
  const research = await first<{ dossier: string; outreach: string | null }>(
    env.DB, "SELECT dossier, outreach FROM company_research WHERE company_id = ? ORDER BY created_at DESC LIMIT 1", r.company_id);
  const d = research ? (JSON.parse(research.dossier) as Dossier) : null;
  const o = research?.outreach ? (JSON.parse(research.outreach) as Outreach) : null;
  const known = await first<{ n: number }>(env.DB,
    "SELECT COUNT(*) AS n FROM contacts WHERE normalized_company = (SELECT normalized_name FROM companies WHERE id = ?)", r.company_id);

  // Job-level evidence (posting text) wins; otherwise show the visa agent's company verdict.
  const visaKey = r.visa === "confirmed" || r.visa === "blocked" ? r.visa : r.visa_status ?? r.visa ?? "unknown";
  const visaBadge = VISA_BADGE[visaKey] ?? "⚪";
  const lines: string[] = [];
  lines.push(r.slot_type === "best" ? "🎯 <b>Best match</b>" : "🧭 <b>Explore</b>");
  if (r.pitch) lines.push(`<i>${escapeHtml(r.pitch)}</i>`);
  if (r.job_id) {
    lines.push(`<b>${escapeHtml(r.title ?? "")}</b> — ${escapeHtml(r.company)}${r.kind && r.kind !== "job" ? ` <i>(${r.kind})</i>` : ""}`);
    lines.push(`📍 ${escapeHtml(r.location ?? "?")}   🛂 ${visaBadge}${r.deadline ? `   ⏳ ${r.deadline}` : ""}`);
    if (r.fit !== null) lines.push(`Fit <b>${r.fit}/10</b> · Interest <b>${r.interest}/10</b>`);
    if (r.co_global != null) {
      lines.push(`📊 career-ops <b>${escapeHtml(careerOpsLine(r))}</b>`);
      lines.push(`<i>${dimsLine(r)}</i>`);
      const flags = r.co_red_flag_notes ? (JSON.parse(r.co_red_flag_notes) as string[]).slice(0, 2) : [];
      if (flags.length) lines.push(flags.map((f) => `🚩 ${escapeHtml(f)}`).join(NL));
    }
    if (r.summary) lines.push(`\n${escapeHtml(r.summary)}`);
    const ev = r.fit_evidence ? (JSON.parse(r.fit_evidence) as string[]).slice(0, 3) : [];
    const gaps = r.fit_gaps ? (JSON.parse(r.fit_gaps) as string[]).slice(0, 2) : [];
    if (ev.length) lines.push(`\n✅ ${ev.map(escapeHtml).join("\n✅ ")}`);
    if (gaps.length) lines.push(`⚠️ ${gaps.map(escapeHtml).join("\n⚠️ ")}`);
  } else {
    lines.push(`<b>${escapeHtml(r.company)}</b> — no open role; pitch them directly   🛂 ${visaBadge}`);
  }
  if (d) {
    lines.push(`\n🏢 ${escapeHtml(d.one_liner)} · ${escapeHtml(d.stage)} · ${escapeHtml(d.headcount_estimate)} people`);
    if (d.proof_of_work_ideas[0]) lines.push(`🛠 Proof of work: <i>${escapeHtml(d.proof_of_work_ideas[0].title)}</i> (~${d.proof_of_work_ideas[0].effort_days}d)`);
  }
  if (o) lines.push(`✉️ Outreach draft ready → ${escapeHtml(o.recipient_name ?? o.recipient_role)}`);
  if (known?.n) lines.push(`🤝 You know ${known.n} ${known.n === 1 ? "person" : "people"} there`);
  if (r.url?.startsWith("http")) lines.push(`\n<a href="${r.url}">Open posting</a>`);

  const keyboard: Keyboard = [
    [{ text: "✅ I'll apply", callback_data: `apply:${r.id}` }, { text: "❌ Not for me", callback_data: `ignore:${r.id}` }],
    [
      research ? { text: "✉️ Show outreach", callback_data: `outreach:${r.company_id}` } : { text: "🔎 Research company", callback_data: `research:${r.company_id}` },
    ],
  ];
  return { html: lines.join("\n"), keyboard };
}

export async function sendRecommendation(env: Env, recId: string) {
  const card = await recommendationCard(env, recId);
  return card ? notify(env, card.html, card.keyboard) : null;
}

/**
 * Decide on a recommendation.
 *   applied  — "I'll apply": creates an application (status intent), tailors a resume, researches the company.
 *              The check-in later asks whether you actually submitted it.
 *   ignored  — with an optional reason code (feedback.ts) that tunes future recommendations.
 * The UNIQUE constraint on applications.job_id makes double-applying impossible.
 */
export async function decide(env: Env, recId: string, decision: "applied" | "ignored", reason?: string, opts: { submitted?: boolean } = {}) {
  const rec = await first<{ id: string; job_id: string | null; company_id: string; status: string }>(
    env.DB, "SELECT id, job_id, company_id, status FROM recommendations WHERE id = ?", recId);
  if (!rec) throw new Error("recommendation not found");
  if (rec.status !== "pending" && !(rec.status === "ignored" && reason)) return { already: rec.status };
  const now = nowIso();
  await run(env.DB, "UPDATE recommendations SET status = ?, ignore_reason = COALESCE(?, ignore_reason), decided_at = COALESCE(decided_at, ?) WHERE id = ?",
    decision, reason ?? null, now, recId);
  if (rec.job_id) await run(env.DB, "UPDATE jobs SET stage = 'decided' WHERE id = ?", rec.job_id);

  if (decision === "applied") {
    const prior = await all<{ title: string | null; status: string; created_at: string }>(env.DB,
      `SELECT j.title, a.status, a.created_at FROM applications a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.company_id = ?`, rec.company_id);
    const appId = await createApplication(env, rec.company_id, rec.job_id, rec.job_id ? "portal" : "email-outreach", "telegram");
    if (opts.submitted) await addApplicationEvent(env, appId, rec.job_id ? "applied" : "outreach_sent", "confirmed at check-in", "telegram");
    else if (rec.job_id) await enqueue(env, "tailor_resume", { applicationId: appId }, `resume:${appId}`);
    const research = await first(env.DB, "SELECT 1 FROM company_research WHERE company_id = ? AND created_at >= datetime('now','-30 days')", rec.company_id);
    if (!research) await enqueue(env, "research_company", { companyId: rec.company_id, jobId: rec.job_id }, `research:${rec.company_id}:${now.slice(0, 7)}`);
    return { applicationId: appId, priorAtCompany: prior };
  }
  return {};
}

export async function createApplication(env: Env, companyId: string, jobId: string | null, channel: string, source: string) {
  if (jobId) {
    const existing = await first<{ id: string }>(env.DB, "SELECT id FROM applications WHERE job_id = ?", jobId);
    if (existing) return existing.id;
  }
  const id = uid();
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO applications(id, job_id, company_id, status, channel, created_at, updated_at) VALUES (?, ?, ?, 'intent', ?, ?, ?)")
      .bind(id, jobId, companyId, channel, now, now),
    env.DB.prepare("INSERT INTO application_events(id, application_id, type, note, source, at) VALUES (?, ?, 'intent', NULL, ?, ?)")
      .bind(uid(), id, source, now),
  ]);
  return id;
}

export async function addApplicationEvent(env: Env, applicationId: string, type: string, note: string | null, source: string) {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO application_events(id, application_id, type, note, source, at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(uid(), applicationId, type, note, source, now),
    ...(type === "note" ? [] : [env.DB.prepare("UPDATE applications SET status = ?, updated_at = ? WHERE id = ?").bind(type, now, applicationId)]),
  ]);
}

export function outreachHtml(company: string, o: Outreach): string {
  return [
    `✉️ <b>Outreach — ${escapeHtml(company)}</b>`,
    `To: ${escapeHtml(o.recipient_name ?? "?")} (${escapeHtml(o.recipient_role)}) via ${o.channel}`,
    `Subject: <b>${escapeHtml(o.subject)}</b>`,
    `\n${escapeHtml(o.body)}`,
    `\n🛠 <b>Proof of work:</b> ${escapeHtml(o.proof_of_work.title)} (~${o.proof_of_work.effort_days}d)\n${escapeHtml(truncate(o.proof_of_work.description, 600))}`,
    o.warm_intro_message ? `\n🤝 <b>Warm intro ask:</b>\n${escapeHtml(o.warm_intro_message)}` : "",
    `\n⏰ Follow up after ${o.follow_up_days} days if no reply.`,
  ].filter(Boolean).join("\n");
}

const NL = String.fromCharCode(10);

/** "CV 4 · North Star 5 · Comp – · Culture 3 · Red flags 5" ("–" = no evidence, as career-ops prescribes). */
export function dimsLine(r: { co_cv_match: number | null; co_north_star: number | null; co_comp: number | null; co_culture: number | null; co_red_flags: number | null }) {
  const f = (n: number | null) => (n == null ? "–" : String(Math.round(n * 10) / 10));
  return `CV ${f(r.co_cv_match)} · North Star ${f(r.co_north_star)} · Comp ${f(r.co_comp)} · Culture ${f(r.co_culture)} · Red flags ${f(r.co_red_flags)}`;
}
