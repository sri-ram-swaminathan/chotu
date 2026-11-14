// ─────────────────────────────────────────────────────────────────────────────
// COMPANY RESEARCH AGENT (LangGraph)
//
// Goal: for a (usually small) company, build a dossier good enough to write a handcrafted
// outreach email with a concrete proof-of-work idea — instead of being applicant #10,000.
//
// Graph:
//
//   START → seed ──► decide ──(need more)──► act ──┐
//                      ▲                           │
//                      └───────────────────────────┘
//                      │(enough / max steps)
//                      ▼
//                  synthesize → contacts → outreach → END
//
// • seed       — deterministic: homepage, about/team/careers pages, two searches via the SEARCH AGENT,
//                and a VISA AGENT check (established companies get a web-evidence verdict)
// • decide     — LLM chooses the next tool call (search or fetch) or says "enough"   ← the "agent" part
// • act        — runs that tool, appends notes
// • synthesize — LLM writes a structured dossier (validated with zod)
// • contacts   — deterministic: who in your LinkedIn network works there?
// • outreach   — LLM drafts the email in YOUR voice, citing only real CV entries
// ─────────────────────────────────────────────────────────────────────────────
import { Annotation, END, START, StateGraph } from "@langchain/langgraph/web";
import { z } from "zod";
import type { Env } from "../env";
import { all, first, run } from "../lib/db";
import { nowIso, truncate, uid } from "../lib/util";
import { LLM } from "../llm/provider";
import { profileDigest, writingSamples, type Profile } from "../profile/profile";
import { fetchPage, interestingLinks, webSearch } from "./tools";
import { notesToText, searchAgent, type Note } from "./searchAgent";
import { checkVisa } from "./visaAgent";

const MAX_AGENT_STEPS = 3;

interface CompanyRow { id: string; name: string; domain: string | null; region: string | null; funded_stage: string | null; ind_sponsor: number; tags: string | null }
interface ContactRow { first_name: string; last_name: string; position: string; url: string }

const NextAction = z.object({
  enough: z.boolean(),
  action: z.enum(["search", "fetch", "none"]).default("none"),
  query: z.string().optional(),
  url: z.string().optional(),
  reason: z.string().default(""),
});

// LLMs write "2-3 days" or "~2" for estimates: take the first number, default 3.
const EffortDays = z.preprocess((v) => (typeof v === "string" ? Number(v.match(/\d+(\.\d+)?/)?.[0]) : v), z.number().catch(3));

export const DossierSchema = z.object({
  one_liner: z.string(),
  product: z.string(),
  customers: z.string().default(""),
  business_model: z.string().default(""),
  stage: z.string().default("unknown"),
  funding: z.object({
    total_eur: z.coerce.number().nullable().catch(null).default(null),
    last_round: z.string().nullable().default(null),
    investors: z.array(z.string()).default([]),
  }).default({}),
  headcount_estimate: z.string().default("unknown"),
  hq: z.string().default("unknown"),
  locations: z.array(z.string()).default([]),
  tech_stack: z.array(z.string()).default([]),
  recent_news: z.array(z.string()).default([]),
  hiring_signals: z.array(z.string()).default([]),
  people: z.array(z.object({ name: z.string(), role: z.string(), why_contact: z.string().default("") })).default([]),
  visa_assessment: z.object({ verdict: z.enum(["confirmed", "likely", "unknown", "unlikely"]), reasoning: z.string() }),
  fit_for_me: z.object({ score: z.coerce.number().min(0).max(10), reasons: z.array(z.string()).default([]) }),
  interest_for_me: z.object({ score: z.coerce.number().min(0).max(10), reasons: z.array(z.string()).default([]) }),
  pain_points_i_could_help_with: z.array(z.string()).default([]),
  proof_of_work_ideas: z.array(z.object({ title: z.string(), description: z.string(), effort_days: EffortDays })).default([]),
  red_flags: z.array(z.string()).default([]),
});
export type Dossier = z.infer<typeof DossierSchema>;

export const OutreachSchema = z.object({
  recipient_name: z.string().nullable(),
  recipient_role: z.string(),
  channel: z.enum(["email", "linkedin"]),
  subject: z.string(),
  body: z.string(),
  proof_of_work: z.object({ title: z.string(), description: z.string(), effort_days: EffortDays }),
  warm_intro_message: z.string().nullable().default(null),
  follow_up_days: z.coerce.number().catch(5).default(5),
});
export type Outreach = z.infer<typeof OutreachSchema>;

// State = the data that flows between nodes. Fields with a reducer ACCUMULATE (notes, steps);
// fields without one are simply overwritten by whichever node returns them last.
const ResearchState = Annotation.Root({
  companyId: Annotation<string>(),
  jobId: Annotation<string | null>(),
  company: Annotation<CompanyRow>(),
  notes: Annotation<Note[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  steps: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  next: Annotation<z.infer<typeof NextAction> | null>(),
  dossier: Annotation<Dossier | null>(),
  contacts: Annotation<ContactRow[]>(),
  outreach: Annotation<Outreach | null>(),
  model: Annotation<string>(),
});
type S = typeof ResearchState.State;

export function buildResearchGraph(env: Env, profile: Profile, llm: LLM) {
  // ── Node: seed (no LLM) ────────────────────────────────────────────────────
  async function seed(s: S): Promise<Partial<S>> {
    const company = (await first<CompanyRow>(env.DB, "SELECT * FROM companies WHERE id = ?", s.companyId))!;
    const notes: Note[] = [];

    if (!company.domain) {
      const hits = await webSearch(env, `${company.name} company official website`, 5);
      const site = hits.find((h) => h.url && !/linkedin|crunchbase|wikipedia|glassdoor|indeed|dealroom|facebook|twitter|x\.com/i.test(h.url));
      if (site) company.domain = new URL(site.url).hostname.replace(/^www\./, "");
    }
    if (company.domain) {
      const home = `https://${company.domain}`;
      const page = await fetchPage(home, 4000);
      if (page) notes.push({ source: page.url, title: `Homepage: ${page.title}`, text: page.text });
      const links = await interestingLinks(home);
      const priority = (u: string) => (/about|team|company|mission/.test(u) ? 0 : /careers|jobs/.test(u) ? 1 : 2);
      for (const link of links.sort((a, b) => priority(a) - priority(b)).slice(0, 3)) {
        const p = await fetchPage(link, 3000);
        if (p) notes.push({ source: p.url, title: p.title, text: p.text });
      }
    }
    const searched = await searchAgent(env, {
      goal: `Background on ${company.name}`,
      queries: [`${company.name} startup funding round investors`, `${company.name} news ${new Date().getFullYear()}`],
      readTop: 0, // we already read their own site above
    }, llm);
    notes.push(...searched.notes.filter((n) => n.text !== "(no results)"));
    // Visa agent: established companies get a web check; its verdict goes into the notes for synthesis.
    try {
      const v = await checkVisa(env, company.id, { location: company.region }, llm);
      notes.push({ source: "visa agent", title: `Visa check: ${v.status}`, text: v.evidence });
    } catch { /* non-fatal: synthesis falls back to "unknown" */ }
    if (s.jobId) {
      const job = await first<{ title: string; description: string | null }>(env.DB, "SELECT title, description FROM jobs WHERE id = ?", s.jobId);
      if (job) notes.push({ source: "job posting", title: `Open role: ${job.title}`, text: truncate(job.description, 3000) });
    }
    return { company, notes };
  }

  // ── Node: decide (LLM picks the next tool) ─────────────────────────────────
  async function decide(s: S): Promise<Partial<S>> {
    if (s.steps >= MAX_AGENT_STEPS) return { next: { enough: true, action: "none", reason: "max steps" } };
    const { data } = await llm.json(
      {
        purpose: "research_decide",
        tier: "reasoning",
        system: `You are a research agent preparing a dossier on a company so a job seeker can write a highly specific outreach email.
The dossier needs: what they build, customers, stage & funding, team size, key people (founders/CTO/hiring manager), tech stack, recent news, hiring signals, and problems the candidate could help with.
Decide if the notes are enough. If not, choose ONE tool call: "search" (web search query) or "fetch" (a specific URL likely to contain missing facts, e.g. a team page or blog post).`,
        prompt: `Company: ${s.company.name} (${s.company.domain ?? "no domain"})
Steps used: ${s.steps}/${MAX_AGENT_STEPS}
NOTES SO FAR:${notesToText(s.notes, 9000)}

Return JSON: {"enough": bool, "action": "search"|"fetch"|"none", "query"?: string, "url"?: string, "reason": string}`,
      },
      NextAction,
    );
    return { next: data };
  }

  // ── Node: act (run the chosen tool) ────────────────────────────────────────
  async function act(s: S): Promise<Partial<S>> {
    const n = s.next!;
    const notes: Note[] = [];
    if (n.action === "search" && n.query) {
      const r = await searchAgent(env, { goal: n.query, queries: [n.query], readTop: 1 }, llm);
      notes.push(...r.notes);
    } else if (n.action === "fetch" && n.url) {
      const p = await fetchPage(n.url, 4000);
      notes.push({ source: n.url, title: p?.title ?? n.url, text: p?.text ?? "(could not fetch)" });
    }
    return { notes, steps: 1 };
  }

  // Conditional edge: the router function returns the NAME of the next node.
  const afterDecide = (s: S) => (s.next?.enough || s.next?.action === "none" || s.steps >= MAX_AGENT_STEPS ? "synthesize" : "act");

  // ── Node: synthesize (LLM → structured dossier) ────────────────────────────
  async function synthesize(s: S): Promise<Partial<S>> {
    const { data, model } = await llm.json(
      {
        purpose: "research_synthesize",
        tier: "reasoning",
        maxTokens: 6000,
        system: `You write precise company dossiers for a job seeker. Use ONLY facts present in the notes; write "unknown" rather than guessing.
Score fit_for_me and interest_for_me 0-10 against the candidate profile (5 = neutral). Proof-of-work ideas must be small (1-5 days), concrete,
directly relevant to the company's product, and buildable by this candidate given their skills. Visa: the candidate needs Dutch/EU work sponsorship;
"confirmed" only if on the IND register or the company states it sponsors.`,
        prompt: `CANDIDATE PROFILE
${profileDigest(profile, { includeBullets: false })}

COMPANY: ${s.company.name} | domain: ${s.company.domain ?? "?"} | IND recognised sponsor: ${s.company.ind_sponsor ? "YES" : "no/unknown"}
NOTES:${notesToText(s.notes)}

Return the dossier JSON with keys: one_liner, product, customers, business_model, stage, funding{total_eur,last_round,investors},
headcount_estimate, hq, locations, tech_stack, recent_news, hiring_signals, people[{name,role,why_contact}], visa_assessment{verdict,reasoning},
fit_for_me{score,reasons}, interest_for_me{score,reasons}, pain_points_i_could_help_with, proof_of_work_ideas[{title,description,effort_days}], red_flags.`,
      },
      DossierSchema,
    );
    return { dossier: data, model };
  }

  // ── Node: contacts (deterministic DB lookup) ───────────────────────────────
  async function contacts(s: S): Promise<Partial<S>> {
    const rows = await all<ContactRow>(
      env.DB,
      "SELECT first_name, last_name, position, url FROM contacts WHERE normalized_company = (SELECT normalized_name FROM companies WHERE id = ?) LIMIT 10",
      s.companyId,
    );
    return { contacts: rows };
  }

  // ── Node: outreach (LLM drafts in your voice) ──────────────────────────────
  async function outreach(s: S): Promise<Partial<S>> {
    const d = s.dossier!;
    const known = s.contacts.map((c) => `${c.first_name} ${c.last_name} — ${c.position}`).join("; ");
    const { data } = await llm.json(
      {
        purpose: "research_outreach",
        tier: "reasoning",
        temperature: 0.6,
        system: `You draft cold outreach for a graduating MSc student to a specific person at a startup/scale-up.
Rules: max 150 words in the body. Open with something specific about THEIR company (from the dossier), not about the sender.
Reference at most two concrete proof points from the candidate profile, using only facts that are actually in the profile — never invent metrics or experience.
Offer the proof-of-work idea as something the candidate will build/share, and end with a low-friction ask (15-minute call or feedback on the idea).
Do NOT mention visas in the first email. No clichés ("I hope this finds you well", "passionate", "synergy").
Match the tone and phrasing of the candidate's writing samples. Pick the best recipient from the dossier's people (founder/CTO at small companies).
If the candidate knows someone at the company, also write warm_intro_message: a short, friendly note asking that contact for an intro or advice.`,
        prompt: `CANDIDATE PROFILE
${profileDigest(profile)}

WRITING SAMPLES (match this voice):
${writingSamples(profile) || "(none provided — write plainly and directly)"}

COMPANY DOSSIER
${JSON.stringify(d, null, 1)}

PEOPLE THE CANDIDATE KNOWS THERE: ${known || "none"}

Return JSON: {recipient_name, recipient_role, channel: "email"|"linkedin", subject, body, proof_of_work{title,description,effort_days}, warm_intro_message, follow_up_days}`,
      },
      OutreachSchema,
    );
    return { outreach: data };
  }

  return new StateGraph(ResearchState)
    .addNode("seed", seed)
    .addNode("decide", decide)
    .addNode("act", act)
    .addNode("synthesize", synthesize)
    .addNode("findContacts", contacts)
    .addNode("draftOutreach", outreach)
    .addEdge(START, "seed")
    .addEdge("seed", "decide")
    .addConditionalEdges("decide", afterDecide, { act: "act", synthesize: "synthesize" })
    .addEdge("act", "decide")
    .addEdge("synthesize", "findContacts")
    .addEdge("findContacts", "draftOutreach")
    .addEdge("draftOutreach", END)
    .compile();
}

/** Run the agent for one company and persist the result. Returns the research row id. */
export async function researchCompany(env: Env, profile: Profile, companyId: string, jobId: string | null = null) {
  const llm = new LLM(env);
  const graph = buildResearchGraph(env, profile, llm);
  const out = await graph.invoke({ companyId, jobId }, { recursionLimit: 20 });
  const d = out.dossier!;
  const id = uid();
  await run(
    env.DB,
    "INSERT INTO company_research(id, company_id, dossier, sources, outreach, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id, companyId, JSON.stringify(d), JSON.stringify(out.notes.map((n: Note) => n.source)),
    out.outreach ? JSON.stringify(out.outreach) : null, out.model, nowIso(),
  );
  // Feed what we learned back into the company record (used by the visa rules).
  await run(
    env.DB,
    `UPDATE companies SET domain = COALESCE(domain, ?), funded_stage = COALESCE(funded_stage, ?),
       funding_eur = COALESCE(funding_eur, ?), headcount = ? WHERE id = ?`,
    out.company.domain, d.stage !== "unknown" ? d.stage : null, d.funding.total_eur, d.headcount_estimate, companyId,
  );
  return { id, company: out.company as CompanyRow, dossier: d, outreach: out.outreach as Outreach | null, contacts: out.contacts as ContactRow[] };
}
