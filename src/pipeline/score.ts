// Stage 2 of the funnel: the LLM reads the full job + your profile and scores two axes.
//   fit      — would a hiring manager see you as a strong applicant?
//   interest — does this match what YOU want (goals.md)?
// It must cite evidence, so you can audit why something scored high.
import { z } from "zod";
import type { Env } from "../env";
import { all, first, run } from "../lib/db";
import { nowIso, truncate } from "../lib/util";
import { LLM } from "../llm/provider";
import { profileDigest, type Profile } from "../profile/profile";
import { enqueue } from "./tasks";
import { fetchJobDescription } from "../sources/ats";
import { isNetherlandsLocation } from "./visa";
import { bandForScore, blendScores, CONFIDENCE, decisionFor, LEGITIMACY, meetsBand } from "./careerOps";

// Lenient where it's harmless (numbers as strings, one evidence item too many, a long summary) so a good
// score isn't thrown away over formatting; strict where it matters (the visa enum, the 0-10 range).
const list = z.array(z.string()).default([]).transform((a) => a.slice(0, 6));
const dim = z.coerce.number().min(1).max(5);
const ScoreSchema = z.object({
  fit: z.coerce.number().min(0).max(10),
  fit_evidence: list,
  fit_gaps: list,
  interest: z.coerce.number().min(0).max(10),
  interest_evidence: list,
  visa_mention: z.enum(["sponsors", "no_sponsorship", "none"]).catch("none"),
  seniority_ok: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]),
  summary: z.string().transform((s) => s.slice(0, 600)),
  // career-ops evaluation (see careerOps.ts). Optional + lenient: a model that skips it still yields a usable score.
  career_ops: z.object({
    cv_match: dim,
    north_star: dim,
    comp: dim.nullable().catch(null),
    culture: dim.nullable().catch(null),
    red_flags: dim,
    red_flag_notes: list,
    archetype: z.string().nullable().catch(null),
    global: z.coerce.number().min(1).max(5),
    legitimacy: z.enum(LEGITIMACY).catch("high"),
    confidence: z.enum(CONFIDENCE).catch("medium"),
  }).optional().catch(undefined),
});

const SYSTEM = `You are a blunt, well-calibrated career advisor evaluating one opportunity for one candidate.
Scores are 0-10 and must be calibrated: 5 = average applicant / neutral interest, 8 = clearly strong, 10 is rare.
"fit" = how strong this candidate's application would look to the hiring team, based ONLY on the profile's evidence.
"interest" = how well it matches the candidate's stated goals and interests.
Evidence items must quote or reference specific profile entries by their [id] or the job text. Be concise.
visa_mention: "no_sponsorship" only if the posting explicitly rules out sponsorship / requires existing right to work;
"sponsors" if it explicitly offers sponsorship or relocation; otherwise "none".
seniority_ok: false if the role clearly needs far more experience than a graduating MSc student has.
summary: 2-3 sentences — what the role is and the single most important reason to apply or not.

ALSO evaluate with the career-ops rubric, in "career_ops" (every dimension 1-5):
- cv_match: skills, experience, proof points vs the requirements.
- north_star: fit with the candidate's TARGET ARCHETYPES (listed in the prompt). 5 = exact target role, 1 = unrelated.
  If the role matches none of them, set archetype null and north_star 1 — do not force it into the nearest one.
- comp: salary vs market for this role and location (5 = top quartile, 1 = well below). null if no salary information.
- culture: against the CULTURE SCREEN. Most criteria evidenced → 4-5; some evidenced, none contradicted → 3;
  evidence contradicts them → at most 2; no evidence at all → null (never default to 3).
- red_flags: 5 = none, 1 = serious blockers (unrealistic requirements, wrong seniority, legacy maintenance, etc.); list them in red_flag_notes.
- global: ONE holistic 1-5 judgment integrating the five (no formula). 4.5+ strong apply, 4.0+ apply, 3.0+ maybe, below 3 skip.
- legitimacy: is this a real, active opening? "high", "caution" (mixed signals) or "suspicious" (several ghost-posting signs:
  very old posting, generic or contradictory requirements, no concrete tech). Doesn't change the number.
- confidence: evidence behind this evaluation — "high" only if every dimension is grounded in the posting/profile, "low" if the
  description is missing or too thin.`;

interface JobRow {
  id: string; title: string; kind: string; location: string | null; description: string | null; url: string | null;
  deadline: string | null; company_id: string; company: string; ind_sponsor: number; funded_stage: string | null; visa: string;
  posted_at: string | null;
}

export async function scoreJob(env: Env, profile: Profile, jobId: string, llm = new LLM(env)) {
  const job = await first<JobRow>(
    env.DB,
    `SELECT j.*, c.name AS company, c.ind_sponsor, c.funded_stage FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?`,
    jobId,
  );
  if (!job) throw new Error(`job ${jobId} not found`);
  // Some sources (Workday) list jobs without descriptions: fetch it now, only for jobs worth scoring.
  if (!job.description && job.url) {
    const desc = await fetchJobDescription(job.url).catch(() => null);
    if (desc) {
      job.description = desc;
      await run(env.DB, "UPDATE jobs SET description = ? WHERE id = ?", desc, job.id);
    }
  }

  const archetypes = profile.scoring.archetypes.map((a) => `- ${a.name}${a.signals.length ? ` (signals: ${a.signals.join(", ")})` : ""}`).join("\n");
  const culture = profile.scoring.culture_screen.require.map((r) => `- ${r}`).join("\n");
  const prompt = `CANDIDATE PROFILE
${profileDigest(profile)}

OPPORTUNITY (${job.kind})
Company: ${job.company}${job.funded_stage ? ` (stage: ${job.funded_stage})` : ""}${job.ind_sponsor ? " [IND recognised sponsor]" : ""}
Title: ${job.title}
Location: ${job.location ?? "unknown"}
${job.deadline ? `Deadline: ${job.deadline}\n` : ""}Description:
${job.posted_at ? `Posted: ${job.posted_at.slice(0, 10)} (today is ${nowIso().slice(0, 10)})\n` : ""}Description:
${truncate(job.description, 7000) || "(no description available — score conservatively from the title)"}

TARGET ARCHETYPES (North Star)
${archetypes || "(none defined — judge north_star against the goals above)"}

CULTURE SCREEN (what a good culture means for this candidate)
${culture || "(none defined — judge culture from company size, stage and stability)"}

Return JSON with keys: fit, fit_evidence, fit_gaps, interest, interest_evidence, visa_mention, seniority_ok, summary,
career_ops: {cv_match, north_star, comp, culture, red_flags, red_flag_notes, archetype, global, legitimacy, confidence}.`;

  const { data, model } = await llm.json({ purpose: "score_job", system: SYSTEM, prompt, tier: "bulk", temperature: 0.2 }, ScoreSchema);

  const w = profile.scoring.weights;
  let chotu = (w.fit * data.fit + w.interest * data.interest) / (w.fit + w.interest);
  if (!data.seniority_ok) chotu -= 2;
  if (job.visa === "unknown") chotu -= 0.5; // small nudge toward companies that can definitely sponsor
  let closingSoon = 0;
  if (job.deadline) {
    const days = (Date.parse(job.deadline) - Date.now()) / 86_400_000;
    if (days >= 0 && days < 10) closingSoon = 0.5; // closing soon → surface it
  }

  // career-ops: band + decision from its own score→action table. A no-sponsorship clause is a hard stop.
  const co = data.career_ops;
  const hardStop = data.visa_mention === "no_sponsorship" && profile.constraints.visa.needs_sponsorship;
  const band = co ? bandForScore(co.global)?.id ?? null : null;
  const decision = co ? decisionFor(co.global, { hardStop, suspicious: co.legitimacy === "suspicious" }) : null;
  const combined = blendScores(chotu, co?.global, profile.scoring.career_ops.weight) + closingSoon;

  await run(
    env.DB,
    `INSERT INTO scores(job_id, fit, interest, combined, summary, fit_evidence, fit_gaps, interest_evidence, visa_mention, model, scored_at,
                        chotu_combined, co_global, co_cv_match, co_north_star, co_comp, co_culture, co_red_flags, co_red_flag_notes,
                        co_archetype, co_band, co_decision, co_legitimacy, co_confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET fit=excluded.fit, interest=excluded.interest, combined=excluded.combined,
       summary=excluded.summary, fit_evidence=excluded.fit_evidence, fit_gaps=excluded.fit_gaps,
       interest_evidence=excluded.interest_evidence, visa_mention=excluded.visa_mention, model=excluded.model, scored_at=excluded.scored_at,
       chotu_combined=excluded.chotu_combined, co_global=excluded.co_global, co_cv_match=excluded.co_cv_match,
       co_north_star=excluded.co_north_star, co_comp=excluded.co_comp, co_culture=excluded.co_culture, co_red_flags=excluded.co_red_flags,
       co_red_flag_notes=excluded.co_red_flag_notes, co_archetype=excluded.co_archetype, co_band=excluded.co_band,
       co_decision=excluded.co_decision, co_legitimacy=excluded.co_legitimacy, co_confidence=excluded.co_confidence`,
    job.id, data.fit, data.interest, combined, data.summary, JSON.stringify(data.fit_evidence), JSON.stringify(data.fit_gaps),
    JSON.stringify(data.interest_evidence), data.visa_mention, model, nowIso(),
    chotu, co?.global ?? null, co?.cv_match ?? null, co?.north_star ?? null, co?.comp ?? null, co?.culture ?? null,
    co?.red_flags ?? null, co ? JSON.stringify(co.red_flag_notes) : null, co?.archetype ?? null, band, decision,
    co?.legitimacy ?? null, co?.confidence ?? null,
  );

  if (hardStop) {
    await run(env.DB, "UPDATE jobs SET stage='filtered_out', visa='blocked', filter_reason='visa: LLM found no-sponsorship clause' WHERE id=?", job.id);
    return { combined, blocked: true };
  }
  // Re-check the company: the IND register (or our matching of it) may have changed since this job was ingested.
  const indCounts = !!job.ind_sponsor && isNetherlandsLocation(job.location) !== false; // IND = Dutch jobs only
  const visa = data.visa_mention === "sponsors" || indCounts ? "confirmed" : job.visa;
  await run(env.DB, "UPDATE jobs SET stage='scored', visa=? WHERE id=?", visa, job.id);

  // Strong candidates trigger company research automatically (once per company per month).
  // Research is the most LLM-hungry agent (~15-20 calls per dossier), so cap automatic dossiers per day.
  const researchedToday = await first<{ n: number }>(env.DB,
    "SELECT COUNT(*) AS n FROM tasks WHERE type = 'research_company' AND created_at >= datetime('now', '-24 hours')");
  const strong = co ? meetsBand(co.global, profile.scoring.career_ops.research_min_band) && decision === "Apply"
                    : combined >= profile.scoring.research_threshold;
  if (strong && (researchedToday?.n ?? 0) < profile.scoring.research_per_day) {
    const month = nowIso().slice(0, 7);
    await enqueue(env, "research_company", { companyId: job.company_id, jobId: job.id }, `research:${job.company_id}:${month}`);
  }
  return { combined, blocked: false };
}

/** Score the top-N keyword-ranked jobs that haven't been scored yet. Called every tick. */
export async function scoreBacklog(env: Env, profile: Profile, limit: number) {
  const llm = new LLM(env);
  const budget = await llm.budgetLeft();
  // Keep 30% of the daily budget for email triage, research and on-demand requests.
  const reserve = Math.floor(Number(env.LLM_DAILY_CALL_BUDGET) * 0.3);
  const n = Math.min(limit, Math.max(0, budget - reserve));
  if (n <= 0) return { scored: 0 };
  let jobs = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM jobs WHERE stage = 'ranked'
     ORDER BY (kind NOT IN ('job','internship')) DESC, keyword_score DESC, first_seen_at DESC LIMIT ?`,
    n,
  );
  // Nothing new to score → re-score jobs scored before career-ops scoring existed, best first, still-live ones only
  // (not yet recommended/alerted/applied, seen in the last 45 days). Uses the same spare budget, so it backfills gradually.
  if (!jobs.length) {
    jobs = await all<{ id: string }>(env.DB,
      `SELECT j.id FROM jobs j JOIN scores s ON s.job_id = j.id
       WHERE j.stage = 'scored' AND s.co_global IS NULL AND j.first_seen_at >= datetime('now', '-45 days')
         AND j.id NOT IN (SELECT job_id FROM recommendations WHERE job_id IS NOT NULL)
         AND j.id NOT IN (SELECT job_id FROM alerts)
       ORDER BY s.combined DESC LIMIT ?`, n);
  }
  let scored = 0;
  for (const j of jobs) {
    try { await scoreJob(env, profile, j.id, llm); scored++; }
    catch (e) {
      // Provider outage / budget → leave it 'ranked' and retry next tick.
      if (String(e).includes("all LLM providers failed") || String(e).includes("budget")) break;
      // Anything else (e.g. the model keeps returning invalid JSON) → park it so we don't loop forever.
      await run(env.DB, "UPDATE jobs SET stage='score_failed', filter_reason=? WHERE id=?", String(e).slice(0, 300), j.id);
    }
  }
  return { scored };
}
