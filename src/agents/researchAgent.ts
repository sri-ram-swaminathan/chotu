// ─────────────────────────────────────────────────────────────────────────────
// RESEARCH AGENT (LangGraph) — open-ended research on demand.
//   "Research computer-vision companies in defence & aerospace in Poland; top 3 for my profile."
//   "Which Eindhoven startups raised a seed round this year and could use an ML engineer?"
//   "What does the ELLIS PhD programme look for?"
//
//   START → plan ─┬─(companies/roles)─► gather ─► extract ─► check ─► rank ─► END
//                 └─(question)────────► gather ─► answer ─────────────────► END
//
// • plan    — LLM reads the request + your profile: what kind of answer, which queries, how many picks
// • gather  — the SEARCH AGENT runs the queries and reads the best pages
// • extract — LLM pulls out concrete candidate companies (name, domain, location, what they do)
// • check   — deterministic: your constraints (pipeline/constraints.ts) + the VISA AGENT for the top few
// • rank    — LLM picks the top N for YOUR profile and, for each, how you could help them even if
//             they're not hiring (proof-of-work ideas, pain points) — the "not immediately hiring" angle
//
// The deep, single-company version (dossier + outreach email) is companyResearch.ts; every pick in a
// report gets a button that runs it.
// ─────────────────────────────────────────────────────────────────────────────
import { Annotation, END, START, StateGraph } from "@langchain/langgraph/web";
import { z } from "zod";
import type { Env } from "../env";
import { first, run } from "../lib/db";
import { escapeHtml, nowIso, truncate, uid } from "../lib/util";
import { LLM } from "../llm/provider";
import { checkConstraints, constraintsDigest } from "../pipeline/constraints";
import { profileDigest, type Profile } from "../profile/profile";
import { upsertCompany } from "../profile/sync";
import { feedbackDigest } from "../orchestrator/feedback";
import { notify, type Keyboard } from "../telegram/api";
import { notesToText, searchAgent, type Note } from "./searchAgent";
import { checkVisa, VISA_BADGE } from "./visaAgent";

const MAX_VISA_CHECKS = 4;

const Plan = z.object({
  mode: z.enum(["companies", "question"]),
  queries: z.array(z.string()).min(1).max(5),
  top_n: z.number().int().min(1).max(10).default(3),
  explicit_location: z.boolean().default(false), // did the user name a place? (then location is a flag, not a blocker)
});

const Candidates = z.object({
  companies: z.array(z.object({
    name: z.string(), domain: z.string().nullable().default(null), location: z.string().nullable().default(null),
    what: z.string(), stage: z.string().nullable().default(null), evidence: z.string().default(""),
  })),
});
type Candidate = z.infer<typeof Candidates>["companies"][number] & {
  companyId?: string; visa?: string; visaNote?: string; blockers?: string[]; flags?: string[];
};

export const ReportSchema = z.object({
  summary: z.string(),
  picks: z.array(z.object({
    name: z.string(),
    why_fit: z.string(),
    how_to_help: z.array(z.string()).default([]),   // concrete ways to be useful even without an opening
    next_step: z.string(),
    risks: z.array(z.string()).default([]),
  })),
  also_considered: z.array(z.string()).default([]),
});
export type Report = z.infer<typeof ReportSchema> & { mode: "companies" | "question"; answer?: string; candidates?: Candidate[] };

const ResearchState = Annotation.Root({
  request: Annotation<string>(),
  plan: Annotation<z.infer<typeof Plan> | null>(),
  notes: Annotation<Note[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  sources: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  candidates: Annotation<Candidate[]>(),
  report: Annotation<Report | null>(),
  model: Annotation<string>(),
});
type S = typeof ResearchState.State;

export function buildResearchAgent(env: Env, profile: Profile, llm: LLM) {
  const digest = profileDigest(profile, { includeBullets: false });

  async function plan(s: S): Promise<Partial<S>> {
    const { data } = await llm.json({
      purpose: "research_plan", tier: "reasoning",
      system: `You plan web research for a job seeker. mode = "companies" if the request asks to find/compare/shortlist
companies, startups, labs, roles or programmes; "question" if it asks for an explanation or a fact.
Write 2-5 specific search queries (names, sectors, cities, years — e.g. "computer vision defence startup Poland 2026").
top_n = how many picks the user asked for (default 3). explicit_location = true if the user named a country/city.`,
      prompt: `REQUEST: ${s.request}\n\nCANDIDATE (for context):\n${truncate(digest, 2500)}\n\nReturn JSON: {mode, queries, top_n, explicit_location}`,
    }, Plan);
    return { plan: data };
  }

  async function gather(s: S): Promise<Partial<S>> {
    const { notes, sources } = await searchAgent(env, { goal: s.request, queries: s.plan!.queries, maxQueries: 5, readTop: 3 }, llm);
    return { notes, sources };
  }

  const route = (s: S) => (s.plan?.mode === "question" ? "answer" : "extract");

  async function answer(s: S): Promise<Partial<S>> {
    const { text, model } = await llm.text({
      purpose: "research_answer", tier: "reasoning",
      system: "Answer the job seeker's question from the notes only, concisely, with the most useful specifics for THEM. Cite source URLs inline. Say what's unknown.",
      prompt: `CANDIDATE:\n${truncate(digest, 2500)}\n\nQUESTION: ${s.request}\n\nNOTES:${notesToText(s.notes)}`,
    });
    return { report: { mode: "question", answer: text, summary: truncate(text, 300), picks: [], also_considered: [] }, model };
  }

  async function extract(s: S): Promise<Partial<S>> {
    const { data } = await llm.json({
      purpose: "research_extract", tier: "bulk",
      system: `Extract concrete organisations (companies, startups, labs, programmes) relevant to the request from the notes.
Exclude media outlets, VCs, job boards and list-article publishers. Use only facts in the notes; null when unknown.`,
      prompt: `REQUEST: ${s.request}\n\nNOTES:${notesToText(s.notes)}\n\nReturn JSON: {"companies":[{name, domain, location, what, stage, evidence}]} (max 10)`,
    }, Candidates);
    return { candidates: data.companies.slice(0, 10) };
  }

  // Deterministic constraint check + visa agent on the first few. No LLM judgement on hard rules.
  async function check(s: S): Promise<Partial<S>> {
    const out: Candidate[] = [];
    let visaChecks = 0;
    for (const c of s.candidates) {
      const companyId = await upsertCompany(env, { name: c.name, domain: c.domain, region: c.location, funded_stage: c.stage, source: "research" });
      let visa: string | undefined;
      let visaNote: string | undefined;
      if (profile.constraints.visa.needs_sponsorship && visaChecks < MAX_VISA_CHECKS) {
        try {
          const v = await checkVisa(env, companyId, { location: c.location }, llm);
          visa = v.status; visaNote = v.evidence; if (v.searched) visaChecks++;
        } catch { /* a failed visa check leaves it "unverified" */ }
      }
      const res = checkConstraints(profile.constraints, { location: c.location, text: `${c.what} ${c.evidence}`, visa },
        { explicitLocation: s.plan!.explicit_location });
      out.push({ ...c, companyId, visa, visaNote, blockers: res.blockers, flags: res.flags });
    }
    return { candidates: out };
  }

  async function rank(s: S): Promise<Partial<S>> {
    const viable = s.candidates.filter((c) => !c.blockers?.length);
    const lines = (cs: Candidate[]) => cs.map((c) =>
      `- ${c.name}${c.domain ? ` (${c.domain})` : ""} | ${c.location ?? "?"} | ${c.stage ?? "?"} | visa: ${c.visa ?? "unverified"}` +
      `${c.flags?.length ? ` | flags: ${c.flags.join("; ")}` : ""}\n  ${c.what}${c.evidence ? ` — ${truncate(c.evidence, 200)}` : ""}`).join("\n");
    const { data, model } = await llm.json({
      purpose: "research_rank", tier: "reasoning", maxTokens: 5000,
      system: `You are the candidate's career strategist. From the viable candidates, pick the top ${s.plan!.top_n} for THIS candidate.
For each pick: why_fit (cite profile specifics), how_to_help (2-3 concrete things the candidate could build or offer
this team even if they are NOT hiring — small, specific, related to the company's product), next_step (one action), risks
(visa, location, seniority, sector — be honest). Prefer visa confirmed/likely. Use the candidate's past decisions to
infer taste. Never pick a company listed under BLOCKED.`,
      prompt: `REQUEST: ${s.request}

CANDIDATE:
${digest}

CONSTRAINTS:
${constraintsDigest(profile.constraints)}

PAST DECISIONS:
${await feedbackDigest(env, 20)}

VIABLE CANDIDATES:
${lines(viable) || "(none)"}

BLOCKED (do not pick): ${s.candidates.filter((c) => c.blockers?.length).map((c) => `${c.name} (${c.blockers!.join("; ")})`).join(", ") || "none"}

Return JSON: {summary, picks:[{name, why_fit, how_to_help:[...], next_step, risks:[...]}], also_considered:[names]}`,
    }, ReportSchema);
    return { report: { ...data, mode: "companies", candidates: s.candidates }, model };
  }

  return new StateGraph(ResearchState)
    .addNode("makePlan", plan)
    .addNode("gather", gather)
    .addNode("answer", answer)
    .addNode("extract", extract)
    .addNode("check", check)
    .addNode("rank", rank)
    .addEdge(START, "makePlan")
    .addEdge("makePlan", "gather")
    .addConditionalEdges("gather", route, { answer: "answer", extract: "extract" })
    .addEdge("answer", END)
    .addEdge("extract", "check")
    .addEdge("check", "rank")
    .addEdge("rank", END)
    .compile();
}

/** Create a report row (status queued). The research_topic task fills it in. */
export async function createReport(env: Env, request: string): Promise<string> {
  const id = uid();
  await run(env.DB, "INSERT INTO research_reports(id, request, status, created_at) VALUES (?, ?, 'queued', ?)", id, request, nowIso());
  return id;
}

/** research_topic task handler. */
export async function runResearchReport(env: Env, profile: Profile, reportId: string) {
  const row = await first<{ request: string; status: string }>(env.DB, "SELECT request, status FROM research_reports WHERE id = ?", reportId);
  if (!row || row.status === "done") return;
  try {
    const out = await buildResearchAgent(env, profile, new LLM(env)).invoke({ request: row.request }, { recursionLimit: 20 });
    const report = out.report as Report;
    await run(env.DB, "UPDATE research_reports SET status='done', report=?, sources=?, model=?, finished_at=? WHERE id=?",
      JSON.stringify(report), JSON.stringify([...new Set(out.sources)]), out.model ?? null, nowIso(), reportId);
    const { html, keyboard } = reportHtml(row.request, report);
    await notify(env, html, keyboard);
  } catch (e) {
    await run(env.DB, "UPDATE research_reports SET status='failed', report=?, finished_at=? WHERE id=?",
      JSON.stringify({ error: String(e) }), nowIso(), reportId);
    throw e; // let the queue retry
  }
}

export function reportHtml(request: string, r: Report): { html: string; keyboard: Keyboard } {
  if (r.mode === "question") return { html: `🔬 <b>${escapeHtml(truncate(request, 120))}</b>\n\n${escapeHtml(r.answer ?? r.summary)}`, keyboard: [] };
  const byName = new Map((r.candidates ?? []).map((c) => [c.name.toLowerCase(), c]));
  const lines = [`🔬 <b>${escapeHtml(truncate(request, 120))}</b>`, escapeHtml(r.summary)];
  const keyboard: Keyboard = [];
  r.picks.forEach((p, i) => {
    const c = byName.get(p.name.toLowerCase());
    lines.push(`\n<b>${i + 1}. ${escapeHtml(p.name)}</b>${c?.location ? ` · ${escapeHtml(c.location)}` : ""}${c ? ` · 🛂 ${VISA_BADGE[c.visa ?? "unknown"] ?? "⚪"}` : ""}`);
    if (c?.what) lines.push(`<i>${escapeHtml(truncate(c.what, 160))}</i>`);
    lines.push(`✅ ${escapeHtml(p.why_fit)}`);
    for (const h of p.how_to_help.slice(0, 3)) lines.push(`🛠 ${escapeHtml(h)}`);
    if (p.risks.length) lines.push(`⚠️ ${escapeHtml(p.risks.join("; "))}`);
    lines.push(`👉 ${escapeHtml(p.next_step)}`);
    if (c?.companyId) keyboard.push([{ text: `🏢 Dossier + outreach: ${truncate(p.name, 24)}`, callback_data: `research:${c.companyId}` }]);
  });
  if (r.also_considered.length) lines.push(`\nAlso considered: ${escapeHtml(r.also_considered.slice(0, 8).join(", "))}`);
  const blocked = (r.candidates ?? []).filter((c) => c.blockers?.length);
  if (blocked.length) lines.push(`Filtered by your constraints: ${escapeHtml(blocked.slice(0, 6).map((c) => `${c.name} (${c.blockers![0]})`).join(", "))}`);
  return { html: lines.join("\n"), keyboard };
}
