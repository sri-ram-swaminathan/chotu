// FEEDBACK LOOP — every "applied" / "not for me (because …)" you give, on a recommendation OR an
// alert, ends up here. Three consumers:
//   • the recommender agent (reranks tomorrow's candidates with this history in its prompt)
//   • the discovery + research agents (what you respond to → what to look for)
//   • hard rules in SQL (you said "don't like this company" → never recommend it again)
import type { Env } from "../env";
import { all, kvGet, kvSet, run } from "../lib/db";
import { nowIso, truncate } from "../lib/util";

export const IGNORE_REASONS: Record<string, string> = {
  interest: "Not interesting",
  fit: "Weak fit",
  visa: "Visa risk",
  location: "Location",
  seniority: "Too senior",
  company: "Don't like company",
  timing: "No time / deadline",
  other: "✍️ Other (type it)",
};

export interface Decision {
  kind: "recommendation" | "alert";
  status: string; reason: string | null; note: string | null;
  title: string | null; company: string; summary: string | null; at: string | null;
}

/** Most recent decisions across recommendations and alerts, newest first. */
export async function recentDecisions(env: Env, limit = 40): Promise<Decision[]> {
  return all<Decision>(env.DB, `
    SELECT * FROM (
      SELECT 'recommendation' AS kind, r.status, r.ignore_reason AS reason, r.reason_note AS note, j.title, c.name AS company,
             s.summary, r.decided_at AS at
      FROM recommendations r JOIN companies c ON c.id = r.company_id
      LEFT JOIN jobs j ON j.id = r.job_id LEFT JOIN scores s ON s.job_id = r.job_id
      WHERE r.status != 'pending'
      UNION ALL
      SELECT 'alert', a.status, a.reason, a.reason_note, j.title, c.name, s.summary, a.decided_at
      FROM alerts a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id
      LEFT JOIN scores s ON s.job_id = a.job_id
      WHERE a.status != 'sent'
    ) ORDER BY at DESC LIMIT ?`, limit);
}

/** Text block for LLM prompts: what you applied to, what you skipped and why. */
export async function feedbackDigest(env: Env, limit = 30): Promise<string> {
  const d = await recentDecisions(env, limit);
  if (!d.length) return "(no decisions yet — rely on the profile and goals)";
  const counts = new Map<string, number>();
  for (const x of d) if (x.reason) counts.set(x.reason, (counts.get(x.reason) ?? 0) + 1);
  const tally = [...counts].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${IGNORE_REASONS[r] ?? r}×${n}`).join(", ");
  return (tally ? `Skip reasons so far: ${tally}\n` : "") + d.map((x) =>
    `- ${x.status.toUpperCase()}${x.reason ? ` (${IGNORE_REASONS[x.reason] ?? x.reason}${x.note ? `: "${truncate(x.note, 120)}"` : ""})` : ""}: ` +
    `${x.title ?? "direct outreach"} @ ${x.company}${x.summary ? ` — ${truncate(x.summary, 120)}` : ""}`).join("\n");
}

/** Companies you explicitly rejected ("Don't like company") — excluded from recs and alerts. */
export const DISLIKED_COMPANIES_SQL = `
  SELECT company_id FROM recommendations WHERE ignore_reason = 'company'
  UNION SELECT j.company_id FROM alerts a JOIN jobs j ON j.id = a.job_id WHERE a.reason = 'company'`;

// ── Free-text reasons ────────────────────────────────────────────────────────
// Tapping "✍️ Other" arms a one-shot capture: the NEXT text message you send is stored as the
// reason instead of going to the chat orchestrator. Expires after 30 minutes.
type Target = { kind: "rec" | "alert" | "app"; id: string; at: string };

export async function awaitReason(env: Env, kind: Target["kind"], id: string) {
  await kvSet(env.DB, "await_reason", JSON.stringify({ kind, id, at: nowIso() } satisfies Target));
}

/** Returns true if `text` was consumed as a reason. */
export async function consumeReason(env: Env, text: string): Promise<boolean> {
  const raw = await kvGet(env.DB, "await_reason");
  if (!raw) return false;                       // "" = nothing armed
  await kvSet(env.DB, "await_reason", "");
  const t = JSON.parse(raw) as Target;
  if (Date.now() - Date.parse(t.at) > 30 * 60_000) return false;
  const note = truncate(text, 500);
  if (t.kind === "rec") await run(env.DB, "UPDATE recommendations SET reason_note = ? WHERE id = ?", note, t.id);
  else if (t.kind === "alert") await run(env.DB, "UPDATE alerts SET reason_note = ? WHERE id = ?", note, t.id);
  else await run(env.DB, "UPDATE applications SET notes = COALESCE(notes || '\n', '') || ? WHERE id = ?", `dropped: ${note}`, t.id);
  return true;
}
