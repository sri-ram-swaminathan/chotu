// ─────────────────────────────────────────────────────────────────────────────
// INTERESTS & BELIEFS — you tell Chotu about companies you find interesting, and why.
//
//   /like Sereact — robot manipulation with foundation models, small team, Stuttgart is fine
//   /like https://jobs.ashbyhq.com/sereact — …
//
// What happens (task "like_company"):
//   1. The company is added/updated and its job board found (from the URL, or by probing the usual ATSs),
//      so its openings are fetched every day from now on.
//   2. Your reason is stored (table company_interest).
//   3. The BELIEFS document is rewritten: a short list of what Chotu has learned about your preferences,
//      from every company you flagged + your apply/skip feedback. It's stored in kv "beliefs" and
//      loadProfile() puts it into every profile digest, so scoring ("interest"), the daily recommender,
//      discovery and research all use it.
//   4. A company dossier is queued (research agent), with outreach ideas.
//
// See your beliefs any time with /beliefs. They're regenerated from the evidence each time, not appended,
// so a preference you've since contradicted fades out.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod";
import type { Env } from "../env";
import { all, first, kvGet, kvSet, run } from "../lib/db";
import { escapeHtml, normalizeCompany, nowIso, truncate, uid } from "../lib/util";
import { LLM } from "../llm/provider";
import { enqueue } from "../pipeline/tasks";
import { upsertCompany } from "../profile/sync";
import { detectAts, probeAts } from "../sources/ats";
import { companyFromTarget } from "./likeParse";
export { parseLike } from "./likeParse";
import { feedbackDigest } from "./feedback";

export async function likeCompany(env: Env, p: { input: string; reason: string }) {
  const { name, domain, url } = companyFromTarget(p.input);
  const known = await first<{ id: string; name: string; ats: string | null; ats_slug: string | null; domain: string | null }>(env.DB,
    "SELECT id, name, ats, ats_slug, domain FROM companies WHERE normalized_name = ? OR (? IS NOT NULL AND domain = ?) LIMIT 1",
    normalizeCompany(name), domain, domain);
  const board = (url && detectAts(url)) || (known?.ats ? { ats: known.ats, slug: known.ats_slug! } : await probeAts(name, domain ?? known?.domain));
  const companyId = await upsertCompany(env, {
    name: known?.name ?? name, domain, ats: board?.ats ?? null, ats_slug: board?.slug ?? null, tags: "liked", source: "liked",
  });
  await run(env.DB, "INSERT INTO company_interest(id, company_id, reason, input, created_at) VALUES (?, ?, ?, ?, ?)",
    uid(), companyId, truncate(p.reason, 1000), p.input, nowIso());

  if (board) await enqueue(env, "fetch_company", { companyId }, `fetch:${companyId}:liked`);
  await enqueue(env, "research_company", { companyId }, `research:${companyId}:${nowIso().slice(0, 10)}`);
  const beliefs = await updateBeliefs(env).catch(() => null); // LLM down → beliefs refresh next time
  return { companyId, name: known?.name ?? name, board, beliefs };
}

export async function interestDigest(env: Env, limit = 30): Promise<string> {
  const rows = await all<{ name: string; reason: string; tags: string | null; created_at: string }>(env.DB,
    `SELECT c.name, i.reason, c.tags, i.created_at FROM company_interest i JOIN companies c ON c.id = i.company_id
     ORDER BY i.created_at DESC LIMIT ?`, limit);
  return rows.map((r) => `- ${r.name}${r.tags ? ` [${r.tags}]` : ""}: "${truncate(r.reason, 300)}"`).join("\n");
}

const BeliefsSchema = z.object({ beliefs: z.array(z.string()).min(1).max(15) });

/** Re-derive the beliefs document from ALL evidence (flagged companies + decisions). */
export async function updateBeliefs(env: Env): Promise<string> {
  const [interests, decisions, previous] = await Promise.all([interestDigest(env, 40), feedbackDigest(env, 30), kvGet(env.DB, "beliefs")]);
  const { data } = await new LLM(env).json({
    purpose: "update_beliefs", tier: "reasoning", temperature: 0.2, maxTokens: 1200,
    system: `You maintain a short, evidence-based model of one job seeker's preferences, used to rank opportunities for them.
Write 5-12 beliefs. Each: one sentence, specific and actionable (domains, problem types, company stage/size, team, location,
tech, culture), ending with the evidence in brackets, e.g. "Drawn to robot-manipulation startups that train their own
foundation models [Sereact, 1X]". Prefer the candidate's own words. Where evidence conflicts, trust newer evidence. Don't
invent preferences there is no evidence for; don't restate generic things every candidate wants.`,
    prompt: `COMPANIES THE CANDIDATE FLAGGED AS INTERESTING (newest first) and why:\n${interests || "(none)"}\n\n` +
      `THEIR APPLY / SKIP DECISIONS:\n${decisions}\n\nPREVIOUS BELIEFS (revise, don't just append):\n${previous || "(none)"}\n\n` +
      `Return JSON: {"beliefs": [str]}`,
  }, BeliefsSchema);
  const doc = data.beliefs.map((b) => `- ${b}`).join("\n");
  await kvSet(env.DB, "beliefs", doc);
  await kvSet(env.DB, "beliefs_updated_at", nowIso());
  return doc;
}

export async function beliefsMessage(env: Env): Promise<string> {
  const [doc, at, n] = await Promise.all([
    kvGet(env.DB, "beliefs"), kvGet(env.DB, "beliefs_updated_at"),
    first<{ n: number }>(env.DB, "SELECT COUNT(DISTINCT company_id) AS n FROM company_interest"),
  ]);
  if (!doc) return "🧠 No beliefs yet. Flag a company you like:\n<code>/like Sereact — robot learning with foundation models, small strong team</code>";
  return `🧠 <b>What I've learned about you</b> <i>(from ${n?.n ?? 0} companies you flagged + your feedback; updated ${escapeHtml((at ?? "").slice(0, 10))})</i>\n${escapeHtml(doc)}`;
}
