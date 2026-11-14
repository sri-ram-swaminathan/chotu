// ─────────────────────────────────────────────────────────────────────────────
// career-ops' scoring system (github.com/career-ops-hq/career-ops, MIT), used ALONGSIDE Chotu's fit/interest.
//
// Five dimensions, each 1-5, integrated by the LLM into ONE holistic global score (no arithmetic formula):
//   cv_match     skills, experience, proof points vs the posting
//   north_star   fit with YOUR target archetypes (scoring.yaml `archetypes`); a role matching none of them = 1
//   comp         salary vs market (5 = top quartile); null when the posting has no salary info
//   culture      culture/growth/stability vs your culture_screen; null when there's no evidence (never a default 3)
//   red_flags    5 = none … 1 = serious blockers
// Plus two things that DON'T change the number: posting legitimacy (is it a real, active opening?) and
// evidence confidence.
//
// The score → action table below is a direct port of career-ops' lib/score-action.mjs. Keep it the only one.
// Dependency-free so tests can import it.
// ─────────────────────────────────────────────────────────────────────────────

export const SCORE_MIN = 0;
export const SCORE_MAX = 5;

export type BandId = "strong_apply" | "apply" | "maybe" | "skip";
export type Decision = "Apply" | "Consider" | "Skip" | "Research first";

export const SCORE_BANDS: readonly { id: BandId; label: string; min: number; decision: Decision }[] = Object.freeze([
  { id: "strong_apply", label: "Strong apply", min: 4.5, decision: "Apply" },
  { id: "apply", label: "Apply", min: 4.0, decision: "Apply" },
  { id: "maybe", label: "Maybe", min: 3.0, decision: "Consider" },
  { id: "skip", label: "Skip", min: SCORE_MIN, decision: "Skip" },
]);

export const APPLY_MIN = 4.0;
export const STRONG_APPLY_MIN = 4.5;
export const MAYBE_MIN = 3.0;

export function bandForScore(score: number | null | undefined) {
  if (typeof score !== "number" || !Number.isFinite(score) || score < SCORE_MIN || score > SCORE_MAX) return null;
  return SCORE_BANDS.find((b) => score >= b.min) ?? null;
}

/** A hard stop (e.g. no visa sponsorship) forces Skip; a suspicious posting forces "Research first". Neither changes the number. */
export function decisionFor(score: number | null | undefined, opts: { hardStop?: boolean; suspicious?: boolean } = {}): Decision | null {
  const band = bandForScore(score);
  if (!band) return null;
  if (opts.hardStop) return "Skip";
  if (opts.suspicious) return "Research first";
  return band.decision;
}

/** Does a score clear a configured band ("apply" = 4.0+, "maybe" = 3.0+, …)? */
export function meetsBand(score: number | null | undefined, band: BandId): boolean {
  const floor = SCORE_BANDS.find((b) => b.id === band)?.min ?? MAYBE_MIN;
  return typeof score === "number" && score >= floor;
}

/**
 * Chotu's ranking number (0-10 scale, `scores.combined`): its own fit/interest blend, mixed with the
 * career-ops global score (×2 to reach 0-10). weight 0 = Chotu only, 1 = career-ops only.
 */
export function blendScores(chotu: number, careerOpsGlobal: number | null | undefined, weight: number): number {
  if (typeof careerOpsGlobal !== "number" || !Number.isFinite(careerOpsGlobal)) return chotu;
  const w = Math.min(1, Math.max(0, weight));
  return (1 - w) * chotu + w * careerOpsGlobal * 2;
}

export const LEGITIMACY = ["high", "caution", "suspicious"] as const;
export const CONFIDENCE = ["high", "medium", "low"] as const;

/** One-line summary for Telegram/dashboard: "4.3/5 · Apply · AI agents". */
export function careerOpsLine(s: { co_global: number | null; co_band: string | null; co_decision: string | null; co_archetype: string | null; co_legitimacy?: string | null }): string {
  if (s.co_global == null) return "";
  const band = SCORE_BANDS.find((b) => b.id === s.co_band)?.label ?? s.co_band ?? "";
  const decision = s.co_decision && s.co_decision !== "Apply" ? ` → ${s.co_decision}` : "";
  return `${s.co_global.toFixed(1)}/5 · ${band}${decision}${s.co_archetype ? ` · 🧭 ${s.co_archetype}` : " · 🧭 no target archetype"}` +
    (s.co_legitimacy === "suspicious" ? " · ⚠️ possible ghost posting" : s.co_legitimacy === "caution" ? " · posting: mixed signals" : "");
}
