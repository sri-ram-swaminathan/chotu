// ─────────────────────────────────────────────────────────────────────────────
// DISCOVERY AGENT (LangGraph) — weekly. Finds companies and roles you never told it about.
//
//   START → reflect → search → extract → END
//
// • reflect — LLM reads your profile + what you APPLIED to vs IGNORED (and why) and proposes
//             hypotheses: adjacent roles, sectors, and concrete search queries.
//             e.g. "applied to 3 eval/LLM-infra roles, ignored fintech → search 'LLM evaluation startup Amsterdam seed'"
// • search  — runs those queries (Tavily / Gemini grounding)
// • extract — LLM pulls out concrete companies, rates relevance; new ones get tracked,
//             the best get a research task (→ dossier → outreach → maybe an "explore" slot).
// ─────────────────────────────────────────────────────────────────────────────
import { Annotation, END, START, StateGraph } from "@langchain/langgraph/web";
import { z } from "zod";
import type { Env } from "../env";
import { first } from "../lib/db";
import { feedbackDigest } from "../orchestrator/feedback";
import { normalizeCompany, nowIso, truncate } from "../lib/util";
import { LLM } from "../llm/provider";
import { enqueue } from "../pipeline/tasks";
import { profileDigest, type Profile } from "../profile/profile";
import { upsertCompany } from "../profile/sync";
import { webSearch, type SearchResult } from "./tools";

const Hypotheses = z.object({
  observations: z.array(z.string()),
  adjacent_roles: z.array(z.string()),
  queries: z.array(z.string()).min(1).max(6),
});

const Found = z.object({
  companies: z.array(z.object({
    name: z.string(), domain: z.string().nullable(), location: z.string().nullable(),
    what: z.string(), stage: z.string().nullable(), relevance: z.number().min(0).max(10), why: z.string(),
  })),
});

const DiscoveryState = Annotation.Root({
  history: Annotation<string>(),
  hypotheses: Annotation<z.infer<typeof Hypotheses> | null>(),
  results: Annotation<{ query: string; hits: SearchResult[] }[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  found: Annotation<z.infer<typeof Found>["companies"]>(),
});
type S = typeof DiscoveryState.State;

export function buildDiscoveryGraph(env: Env, profile: Profile, llm: LLM) {
  async function reflect(s: S): Promise<Partial<S>> {
    const { data } = await llm.json({
      purpose: "discovery_reflect", tier: "reasoning", temperature: 0.7,
      system: `You are a creative career strategist. From the candidate's profile and their recent decisions, infer what they
really respond to, then propose adjacent roles and 3-6 web search queries that would surface SMALL, relevant companies
(startups, scale-ups, research labs) they haven't seen — especially in Amsterdam, Eindhoven/Brainport, Delft, Rotterdam,
Utrecht, and remote-EU. Prefer queries like "<niche> startup <city> seed round 2026" or "<technology> company Netherlands hiring".
Include at least one query outside their obvious lane (exploration).`,
      prompt: `PROFILE:\n${profileDigest(profile, { includeBullets: false })}\n\nRECENT DECISIONS:\n${s.history}\n\nReturn JSON: {observations: [str], adjacent_roles: [str], queries: [str]}`,
    }, Hypotheses);
    return { hypotheses: data };
  }

  async function search(s: S): Promise<Partial<S>> {
    const results = [];
    for (const q of s.hypotheses!.queries) results.push({ query: q, hits: await webSearch(env, q, 6) });
    return { results };
  }

  async function extract(s: S): Promise<Partial<S>> {
    const text = s.results.map((r) => `## ${r.query}\n${r.hits.map((h) => `- ${h.title} ${h.url}\n  ${h.content}`).join("\n")}`).join("\n\n");
    const { data } = await llm.json({
      purpose: "discovery_extract", tier: "reasoning",
      system: "Extract concrete companies (not media outlets, VCs or job boards) from these search results, and rate relevance 0-10 for the candidate.",
      prompt: `PROFILE:\n${profileDigest(profile, { includeBullets: false })}\n\nSEARCH RESULTS:\n${truncate(text, 14000)}\n\nReturn JSON: {companies:[{name, domain, location, what, stage, relevance, why}]}`,
    }, Found);
    return { found: data.companies };
  }

  return new StateGraph(DiscoveryState)
    .addNode("reflect", reflect)
    .addNode("search", search)
    .addNode("extract", extract)
    .addEdge(START, "reflect")
    .addEdge("reflect", "search")
    .addEdge("search", "extract")
    .addEdge("extract", END)
    .compile();
}

export async function runDiscovery(env: Env, profile: Profile) {
  // Recommendations AND alerts you acted on / skipped, with reasons (orchestrator/feedback.ts).
  const history = await feedbackDigest(env, 30);

  const graph = buildDiscoveryGraph(env, profile, new LLM(env));
  const out = await graph.invoke({ history });
  let added = 0, queued = 0;
  for (const c of out.found.filter((c) => c.relevance >= 6)) {
    const existed = await first(env.DB, "SELECT 1 FROM companies WHERE normalized_name = ?", normalizeCompany(c.name));
    const id = await upsertCompany(env, { name: c.name, domain: c.domain, region: c.location, funded_stage: c.stage, source: "discovery" });
    if (!existed) added++;
    if (c.relevance >= 8 && queued < 3) {
      await enqueue(env, "research_company", { companyId: id }, `research:${id}:${nowIso().slice(0, 7)}`);
      queued++;
    }
  }
  return { hypotheses: out.hypotheses, found: out.found.length, added, queued };
}
