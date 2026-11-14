// ─────────────────────────────────────────────────────────────────────────────
// SEARCH AGENT (LangGraph) — the web layer the other agents ask for evidence.
// tools.ts holds the primitives (webSearch, fetchPage); this agent turns a GOAL into queries, runs them,
// and reads the best pages. The research, visa, company-research and chat agents go through it.
// (Two deterministic crawlers still call the primitives directly: watched pages and the company-site
// crawl in companyResearch's seed — they know exactly which URL they want.)
//
//   START → plan ──► search ──► read ──► END
//
// • plan   — turn a goal into 1-N search queries (LLM; skipped if the caller passes queries)
// • search — run them (Tavily → Gemini Google-grounding fallback, see tools.ts)
// • read   — fetch the most promising pages (distinct domains, no aggregators) and turn them into text
//
// It returns NOTES (source, title, text). Turning notes into structured answers is the caller's job
// — or use searchAndExtract() which adds a zod-validated extraction step.
// ─────────────────────────────────────────────────────────────────────────────
import { Annotation, END, START, StateGraph } from "@langchain/langgraph/web";
import { z } from "zod";
import type { Env } from "../env";
import { truncate } from "../lib/util";
import { LLM } from "../llm/provider";
import { fetchPage, webSearch, type SearchResult } from "./tools";

export interface Note { source: string; title: string; text: string }

export interface SearchRequest {
  goal: string;                // what we're trying to find out, in plain language
  queries?: string[];          // skip planning and run these
  maxQueries?: number;         // default 3
  readTop?: number;            // how many result pages to open and read (default 2)
  urls?: string[];             // pages to read no matter what the search returns (e.g. the program's own site)
  context?: string;            // extra context for query planning (e.g. candidate profile digest)
}

// Sites that are great for search snippets but useless/blocked to fetch directly.
const SKIP_READ = /linkedin\.com|facebook\.com|twitter\.com|x\.com|instagram\.com|glassdoor\.|indeed\.|youtube\.com|crunchbase\.com|pitchbook\.com/i;

const SearchState = Annotation.Root({
  req: Annotation<SearchRequest>(),
  queries: Annotation<string[]>(),
  hits: Annotation<{ query: string; results: SearchResult[] }[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  notes: Annotation<Note[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});
type S = typeof SearchState.State;

export function buildSearchGraph(env: Env, llm: LLM) {
  async function plan(s: S): Promise<Partial<S>> {
    const max = s.req.maxQueries ?? 3;
    if (s.req.queries?.length) return { queries: s.req.queries.slice(0, max) };
    const { data } = await llm.json({
      purpose: "search_plan", tier: "cheap",
      system: `You write web search queries. Given a research goal, return ${max} short, diverse Google-style queries
that together would find the answer. Include specific names, places and years when relevant. No boolean operators.`,
      prompt: `GOAL: ${s.req.goal}${s.req.context ? `\nCONTEXT:\n${truncate(s.req.context, 1500)}` : ""}\n\nReturn JSON: {"queries": [string]}`,
    }, z.object({ queries: z.array(z.string()).min(1) }));
    return { queries: data.queries.slice(0, max) };
  }

  async function search(s: S): Promise<Partial<S>> {
    const hits = [];
    for (const q of s.queries) hits.push({ query: q, results: await webSearch(env, q, 6) });
    const notes: Note[] = hits.map((h) => ({
      source: `search: ${h.query}`,
      title: `Search: ${h.query}`,
      text: h.results.map((r) => `- ${r.title} ${r.url}\n  ${r.content}`).join("\n") || "(no results)",
    }));
    return { hits, notes };
  }

  async function read(s: S): Promise<Partial<S>> {
    const urls: string[] = [...(s.req.urls ?? [])];
    const n = (s.req.readTop ?? 2) + urls.length;
    if (n <= 0) return {};
    // Round-robin across queries so we read the top hit of EACH query, not 3 hits of the first.
    const domains = new Set<string>(urls.map((u) => { try { return new URL(u).hostname; } catch { return u; } }));
    for (let rank = 0; rank < 6 && urls.length < n; rank++) {
      for (const h of s.hits) {
        const r = h.results[rank];
        if (!r?.url || SKIP_READ.test(r.url)) continue;
        let d: string;
        try { d = new URL(r.url).hostname; } catch { continue; }
        if (domains.has(d)) continue;
        domains.add(d);
        urls.push(r.url);
        if (urls.length >= n) break;
      }
    }
    const notes: Note[] = [];
    for (const u of urls) {
      const p = await fetchPage(u, 4000);
      if (p) notes.push({ source: p.url, title: p.title, text: p.text });
    }
    return { notes };
  }

  return new StateGraph(SearchState)
    .addNode("plan", plan)
    .addNode("search", search)
    .addNode("read", read)
    .addEdge(START, "plan")
    .addEdge("plan", "search")
    .addEdge("search", "read")
    .addEdge("read", END)
    .compile();
}

export async function searchAgent(env: Env, req: SearchRequest, llm = new LLM(env)): Promise<{ notes: Note[]; sources: string[] }> {
  const out = await buildSearchGraph(env, llm).invoke({ req });
  const sources = [...new Set(out.notes.map((n: Note) => n.source).filter((u: string) => u.startsWith("http")))] as string[];
  return { notes: out.notes, sources };
}

export function notesToText(notes: Note[], max = 14000): string {
  let out = "";
  for (const n of notes) {
    const chunk = `\n### ${n.title} (${n.source})\n${n.text}\n`;
    if (out.length + chunk.length > max) { out += truncate(chunk, Math.max(0, max - out.length)); break; }
    out += chunk;
  }
  return out;
}

/** Search, then extract a structured answer validated by `schema`. */
export async function searchAndExtract<Sch extends z.ZodTypeAny>(
  env: Env,
  req: SearchRequest & { purpose: string; instruction: string; schema: Sch; jsonShape: string },
  llm = new LLM(env),
): Promise<{ data: z.infer<Sch>; notes: Note[]; sources: string[]; model: string }> {
  const { notes, sources } = await searchAgent(env, req, llm);
  const { data, model } = await llm.json({
    purpose: req.purpose, tier: "bulk",
    system: `${req.instruction}\nUse ONLY facts in the notes. If the notes don't say, answer "unknown" rather than guessing.`,
    prompt: `GOAL: ${req.goal}\n\nNOTES:${notesToText(notes)}\n\nReturn JSON: ${req.jsonShape}`,
  }, req.schema);
  return { data, notes, sources, model };
}

/** "Understand this website": fetch one URL and answer a question about it. */
export async function readWebsite(env: Env, url: string, question: string, llm = new LLM(env)): Promise<string> {
  const page = await fetchPage(url, 12000);
  if (!page) return `Could not read ${url} (blocked, login wall, or JavaScript-only page).`;
  const { text } = await llm.text({
    purpose: "read_website", tier: "reasoning",
    system: "Answer the question using only the page content. Be concise and concrete. Say so if the page doesn't contain the answer.",
    prompt: `PAGE ${page.url} — ${page.title}\n${page.text}\n\nQUESTION: ${question}`,
  });
  return text;
}
