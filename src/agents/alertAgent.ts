// ─────────────────────────────────────────────────────────────────────────────
// ALERT AGENT — "the moment a good job appears, ping me; applying early is crucial".
//
// The recommender is slow and deliberate (2 a day, after a check-in). The alert agent is the opposite:
// it reacts to FRESH postings within minutes and pings you through the alert bot.
//
//   new postings (email alert / ATS poll / watched page)
//        │  queueAlerts()  — free filters: passed triage, keyword score, posting age, daily cap,
//        │                   not a company you rejected, not the first-ever crawl of a company
//        ▼
//   alert_job task (priority 10 → runs before everything else)
//        │  runAlert()     — LLM score (fit × interest) → visa agent check → threshold
//        ▼
//   🚨 alert bot: [✅ Applying now] [❌ Not for me → why?] [🔎 Research]
//
// Your answers land in the `alerts` table and feed the same feedback loop as recommendations.
// Alerted jobs are never re-sent as daily recommendations.
// ─────────────────────────────────────────────────────────────────────────────
import type { Env } from "../env";
import { all, first, run } from "../lib/db";
import { escapeHtml, nowIso, truncate, uid } from "../lib/util";
import { LLM } from "../llm/provider";
import { scoreJob } from "../pipeline/score";
import { enqueue } from "../pipeline/tasks";
import type { Profile } from "../profile/profile";
import { alertNotify, type Keyboard } from "../telegram/api";
import { DISLIKED_COMPANIES_SQL } from "../orchestrator/feedback";
import { checkVisa, VISA_BADGE } from "./visaAgent";
import { careerOpsLine, meetsBand } from "../pipeline/careerOps";

/** Cheap gate: decide which freshly ingested jobs deserve an alert_job task. No LLM calls. */
export async function queueAlerts(env: Env, profile: Profile, jobIds: string[], source: string, opts: { initialCrawl?: boolean } = {}) {
  const a = profile.scoring.alerts;
  // First crawl of a company returns its whole backlog — those aren't "new", they go to the recommender pool.
  if (!a.enabled || opts.initialCrawl || !jobIds.length) return 0;
  const minPosted = new Date(Date.now() - a.max_age_days * 86_400_000).toISOString();
  let queued = 0;
  for (let i = 0; i < jobIds.length; i += 90) {
    const chunk = jobIds.slice(i, i + 90);
    const rows = await all<{ id: string }>(env.DB, `
      SELECT id FROM jobs
      WHERE id IN (${chunk.map(() => "?").join(",")})
        AND stage = 'ranked'
        AND (kind NOT IN ('job','internship') OR keyword_score >= ?)
        AND (posted_at IS NULL OR posted_at >= ?)
        AND company_id NOT IN (${DISLIKED_COMPANIES_SQL})
      ORDER BY keyword_score DESC LIMIT 10`, ...chunk, a.min_keyword_score, minPosted);
    for (const r of rows) {
      await enqueue(env, "alert_job", { jobId: r.id, source }, `alert:${r.id}`);
      queued++;
    }
  }
  return queued;
}

interface AlertJob {
  id: string; title: string; kind: string; location: string | null; url: string | null; posted_at: string | null; deadline: string | null;
  company_id: string; company: string; visa: string; stage: string;
}

/** The alert_job task handler: score, visa-check, and ping if it clears the bar. */
export async function runAlert(env: Env, profile: Profile, p: { jobId: string; source?: string }) {
  const a = profile.scoring.alerts;
  if (await first(env.DB, "SELECT 1 FROM alerts WHERE job_id = ?", p.jobId)) return { sent: false, why: "already alerted" };
  const sent24 = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM alerts WHERE sent_at >= ?", new Date(Date.now() - 86_400_000).toISOString());
  if ((sent24?.n ?? 0) >= a.max_per_day) return { sent: false, why: "daily alert cap" }; // stays in the pool for the recommender

  const llm = new LLM(env);
  const load = () => first<AlertJob>(env.DB, `SELECT j.id, j.title, j.kind, j.location, j.url, j.posted_at, j.deadline, j.company_id,
      c.name AS company, j.visa, j.stage FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?`, p.jobId);
  let job = await load();
  if (!job) return { sent: false, why: "job gone" };
  if (job.stage === "ranked") {
    const s = await scoreJob(env, profile, job.id, llm);
    if (s.blocked) return { sent: false, why: "no sponsorship" };
    job = (await load())!;
  }
  if (!["scored", "ranked"].includes(job.stage)) return { sent: false, why: `stage ${job.stage}` };
  const s = await first<{ fit: number; interest: number; combined: number; summary: string; fit_gaps: string | null;
    co_global: number | null; co_band: string | null; co_decision: string | null; co_archetype: string | null; co_legitimacy: string | null }>(env.DB,
    `SELECT fit, interest, combined, summary, fit_gaps, co_global, co_band, co_decision, co_archetype, co_legitimacy
     FROM scores WHERE job_id = ?`, job.id);
  if (!s || s.combined < a.min_score) return { sent: false, why: `score ${s?.combined ?? "?"} < ${a.min_score}` };
  // career-ops gate: an instant ping means "drop everything and apply" — only for its Apply band, never for a
  // posting it flags as a possible ghost ("Research first") or a Skip.
  if (s.co_global != null) {
    const minBand = profile.scoring.career_ops.alert_min_band;
    if (!meetsBand(s.co_global, minBand)) return { sent: false, why: `career-ops ${s.co_global} below ${minBand}` };
    if (s.co_decision !== "Apply") return { sent: false, why: `career-ops decision ${s.co_decision}` };
  }

  // Visa check for anything not already confirmed (the visa agent decides how deep to go).
  let visa = job.visa;
  if (visa !== "confirmed" && profile.constraints.visa.needs_sponsorship) {
    const v = await checkVisa(env, job.company_id, { location: job.location }, llm);
    if (v.status === "unlikely") return { sent: false, why: "visa unlikely" };
    if (v.status === "confirmed") { visa = "confirmed"; await run(env.DB, "UPDATE jobs SET visa = 'confirmed' WHERE id = ?", job.id); }
  }

  const id = uid();
  await run(env.DB, "INSERT INTO alerts(id, job_id, score, source, status, sent_at) VALUES (?, ?, ?, ?, 'sent', ?) ON CONFLICT(job_id) DO NOTHING",
    id, job.id, s.combined, p.source ?? null, nowIso());
  const gaps = s.fit_gaps ? (JSON.parse(s.fit_gaps) as string[]).slice(0, 1) : [];
  const html = [
    `🚨 <b>New: ${escapeHtml(job.title)}</b> — ${escapeHtml(job.company)}${job.kind !== "job" ? ` <i>(${job.kind})</i>` : ""}`,
    `📍 ${escapeHtml(job.location ?? "?")}   🛂 ${VISA_BADGE[visa] ?? visa}${job.posted_at ? `   🕒 posted ${job.posted_at.slice(0, 10)}` : ""}${job.deadline ? `   ⏳ ${job.deadline}` : ""}`,
    `Fit <b>${s.fit}/10</b> · Interest <b>${s.interest}/10</b>`,
    s.co_global != null ? `📊 career-ops <b>${escapeHtml(careerOpsLine(s))}</b>` : "",
    escapeHtml(truncate(s.summary, 400)),
    gaps.length ? `⚠️ ${escapeHtml(gaps[0]!)}` : "",
    job.url?.startsWith("http") ? `\n👉 <a href="${job.url}">Apply now</a> — early applications get read first` : "",
  ].filter(Boolean).join("\n");
  const keyboard: Keyboard = [
    [{ text: "✅ Applying now", callback_data: `al:apply:${id}` }, { text: "❌ Not for me", callback_data: `al:no:${id}` }],
    [{ text: "🔎 Research company", callback_data: `research:${job.company_id}` }],
  ];
  const msgId = await alertNotify(env, html, keyboard);
  if (msgId) await run(env.DB, "UPDATE alerts SET telegram_msg_id = ? WHERE id = ?", msgId, id);
  return { sent: true, alertId: id };
}

/** Button handlers (called from the Telegram callback router). */
export async function decideAlert(env: Env, alertId: string, decision: "applied" | "ignored", reason?: string) {
  const al = await first<{ id: string; job_id: string; status: string; company_id: string }>(env.DB,
    "SELECT a.id, a.job_id, a.status, j.company_id FROM alerts a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?", alertId);
  if (!al) throw new Error("alert not found");
  if (al.status !== "sent" && !(al.status === "ignored" && reason)) return { already: al.status };
  await run(env.DB, "UPDATE alerts SET status = ?, reason = COALESCE(?, reason), decided_at = COALESCE(decided_at, ?) WHERE id = ?",
    decision, reason ?? null, nowIso(), alertId);
  await run(env.DB, "UPDATE jobs SET stage = 'decided' WHERE id = ?", al.job_id);
  if (decision === "applied") {
    const { createApplication } = await import("../orchestrator/recommend");
    const appId = await createApplication(env, al.company_id, al.job_id, "portal", "alert");
    await enqueue(env, "tailor_resume", { applicationId: appId }, `resume:${appId}`);
    return { applicationId: appId };
  }
  return {};
}
