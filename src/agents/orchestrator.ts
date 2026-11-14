// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR (LangGraph) — the brain behind the main Telegram bot.
// Any message that isn't a /command lands here:
//   "How many applications did I make last week?"
//   "What were the last 3 suggestions I ignored?"
//   "Research computer-vision companies in defence & aerospace in Poland and give me the top 3 for my profile."
//
//   START → think ──(tool)──► act ──┐
//             ▲                      │
//             └──────────────────────┘
//             │(answer / step limit)
//             ▼
//            END
//
// This is a ReAct loop: the LLM picks ONE tool per step (as JSON), we run it, append the result
// ("observation"), and repeat until it answers. Tools are the system's capabilities: read-only SQL over
// the backend, the search agent, the research agent, the visa agent, the recommender, the trackers.
//
// Why JSON actions instead of native function-calling? It works identically on every provider in the
// fallback chain (Gemini, Groq/OpenRouter, Workers AI). Same pattern as companyResearch.ts's `decide`.
//
// Long work (research reports, company dossiers) is QUEUED, not run inline: a Telegram webhook only
// gets ~30 s of background time, while the cron runner gets 15 minutes. The orchestrator says
// "on it" and the research agent messages you when it's done.
// ─────────────────────────────────────────────────────────────────────────────
import { Annotation, END, START, StateGraph } from "@langchain/langgraph/web";
import { z } from "zod";
import type { Env } from "../env";
import { all, first, run } from "../lib/db";
import { localDay, nowIso, toTelegramHtml, truncate } from "../lib/util";
import { safeSelect } from "../lib/sqlGuard";
import { LLM } from "../llm/provider";
import { constraintsDigest } from "../pipeline/constraints";
import { enqueue } from "../pipeline/tasks";
import { profileDigest, type Profile } from "../profile/profile";
import { upsertCompany } from "../profile/sync";
import { feedbackDigest } from "../orchestrator/feedback";
import { logPrep, prepLine, prepStatus } from "../orchestrator/prep";
import { addApplicationEvent, createApplication, fillSlots } from "../orchestrator/recommend";
import { createReport } from "./researchAgent";
import { notesToText, readWebsite, searchAgent } from "./searchAgent";
import { checkVisa } from "./visaAgent";
import { deadlineLine, rollingPrograms, upcomingDeadlines, upsertDeadline } from "./deadlineAgent";

const MAX_STEPS = 6;
const TIME_BUDGET_MS = 22_000; // stay inside the webhook's background-time window

export const SCHEMA_DOC = `SQLite (Cloudflare D1). Timestamps are ISO-8601 UTC text; compare with datetime('now','-7 days').
companies(id, name, domain, region, tags, ind_sponsor 0/1, funded_stage, headcount, visa_status confirmed|likely|unknown|unlikely, visa_evidence, source)
jobs(id, company_id, kind job|internship|phd|accelerator|hackathon|event, title, location, url, deadline, posted_at,
     stage new|filtered_out|ranked|scored|score_failed|recommended|decided, filter_reason, visa confirmed|likely|unknown|blocked, keyword_score, first_seen_at)
scores(job_id, fit 0-10, interest 0-10, combined (ranking, 0-10), summary, fit_evidence JSON, fit_gaps JSON, scored_at,
  career-ops rubric 1-5: co_global, co_cv_match, co_north_star, co_comp, co_culture, co_red_flags, co_red_flag_notes JSON,
  co_archetype, co_band strong_apply|apply|maybe|skip, co_decision Apply|Consider|Skip|Research first, co_legitimacy high|caution|suspicious)
recommendations(id, job_id NULL for outreach, company_id, slot_type best|explore, status pending|applied|ignored,
     ignore_reason interest|fit|visa|location|seniority|company|timing|other, reason_note, pitch, checkin_count, created_at, decided_at)
     -- status 'applied' = you decided to apply (an application row exists)
alerts(id, job_id, score, status sent|applied|ignored, reason, reason_note, sent_at, decided_at)
applications(id, job_id, company_id, status intent|applied|outreach_sent|replied|interview|offer|rejected|withdrawn, channel, notes, created_at, updated_at)
application_events(id, application_id, type intent|applied|outreach_sent|replied|interview|offer|rejected|withdrawn|note, note, source, at)
     -- "applications submitted in a period" = application_events with type IN ('applied','outreach_sent') and \`at\` in range
company_research(id, company_id, dossier JSON, outreach JSON, created_at)
research_reports(id, request, status, report JSON, created_at)
deadlines(org, title, kind accelerator|phd|hackathon|event|job|personal, date YYYY-MM-DD or NULL=rolling, status open|rolling|done|dismissed, confidence verified|unverified, source_url)
emails(id, from_addr, subject, received_at, category job_alert|application_update|opportunity|funding_news|newsletter|noise, summary)
prep_items(id, title, unit, daily_target, weekly_target, total_target, deadline) · prep_logs(item_id, day YYYY-MM-DD, amount, note)
contacts(first_name, last_name, company, position) · llm_calls(day, provider, purpose, ok) · tasks(type, status, last_error)`;

// ── Tools ────────────────────────────────────────────────────────────────────
interface ToolCtx { env: Env; profile: Profile; llm: LLM }
interface Tool<A extends z.ZodTypeAny = z.ZodTypeAny> { description: string; args: A; argsDoc: string; run(ctx: ToolCtx, a: z.infer<A>): Promise<string> }
const tool = <A extends z.ZodTypeAny>(t: Tool<A>) => t;

const sinceIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const rowsText = (rows: unknown[]) => (rows.length ? truncate(JSON.stringify(rows, null, 0), 3500) : "(no rows)");

export const TOOLS = {
  stats: tool({
    description: "Activity counts for the last N days: applications started/submitted, recommendations sent/applied/ignored, alerts sent/acted on, jobs seen, emails, interviews.",
    args: z.object({ days: z.number().default(7) }), argsDoc: `{"days": 7}`,
    async run({ env }, a) {
      const t = sinceIso(a.days);
      const row = await first(env.DB, `SELECT
        (SELECT COUNT(*) FROM applications WHERE created_at >= ?1) AS applications_started,
        (SELECT COUNT(*) FROM application_events WHERE type IN ('applied','outreach_sent') AND at >= ?1) AS applications_submitted,
        (SELECT COUNT(*) FROM recommendations WHERE created_at >= ?1) AS recommendations_sent,
        (SELECT COUNT(*) FROM recommendations WHERE decided_at >= ?1 AND status = 'applied') AS recommendations_applied,
        (SELECT COUNT(*) FROM recommendations WHERE decided_at >= ?1 AND status = 'ignored') AS recommendations_ignored,
        (SELECT COUNT(*) FROM alerts WHERE sent_at >= ?1) AS alerts_sent,
        (SELECT COUNT(*) FROM alerts WHERE decided_at >= ?1 AND status = 'applied') AS alerts_applied,
        (SELECT COUNT(*) FROM jobs WHERE first_seen_at >= ?1) AS jobs_seen,
        (SELECT COUNT(*) FROM emails WHERE received_at >= ?1) AS emails_received,
        (SELECT COUNT(*) FROM application_events WHERE type = 'interview' AND at >= ?1) AS interviews`, t);
      return `Since ${t.slice(0, 10)}: ${JSON.stringify(row)}`;
    },
  }),

  recommendations: tool({
    description: "Recent daily recommendations with status, ignore reason and your note. Filter by status.",
    args: z.object({ status: z.enum(["pending", "applied", "ignored", "any"]).default("any"), limit: z.number().default(10) }),
    argsDoc: `{"status": "ignored", "limit": 3}`,
    async run({ env }, a) {
      return rowsText(await all(env.DB, `
        SELECT r.status, r.ignore_reason, r.reason_note, r.slot_type, r.pitch, j.title, c.name AS company, s.combined AS score,
               substr(r.created_at,1,10) AS suggested, substr(r.decided_at,1,10) AS decided
        FROM recommendations r JOIN companies c ON c.id = r.company_id LEFT JOIN jobs j ON j.id = r.job_id LEFT JOIN scores s ON s.job_id = r.job_id
        WHERE (?1 = 'any' OR r.status = ?1) ORDER BY COALESCE(r.decided_at, r.created_at) DESC LIMIT ?2`, a.status, Math.min(a.limit, 30)));
    },
  }),

  alerts: tool({
    description: "Recent instant job alerts and what you did with them.",
    args: z.object({ status: z.enum(["sent", "applied", "ignored", "any"]).default("any"), limit: z.number().default(10) }),
    argsDoc: `{"status": "any", "limit": 10}`,
    async run({ env }, a) {
      return rowsText(await all(env.DB, `
        SELECT a.status, a.reason, a.reason_note, a.score, j.title, c.name AS company, j.url, substr(a.sent_at,1,16) AS sent
        FROM alerts a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id
        WHERE (?1 = 'any' OR a.status = ?1) ORDER BY a.sent_at DESC LIMIT ?2`, a.status, Math.min(a.limit, 30)));
    },
  }),

  applications: tool({
    description: "Your application tracker, optionally filtered by status, company name, or last N days.",
    args: z.object({ status: z.string().optional(), company: z.string().optional(), days: z.number().optional() }),
    argsDoc: `{"status": "interview", "company": "Adyen", "days": 30}`,
    async run({ env }, a) {
      return rowsText(await all(env.DB, `
        SELECT c.name AS company, j.title, a.status, a.channel, substr(a.created_at,1,10) AS started, substr(a.updated_at,1,10) AS updated, a.notes
        FROM applications a JOIN companies c ON c.id = a.company_id LEFT JOIN jobs j ON j.id = a.job_id
        WHERE (?1 IS NULL OR a.status = ?1) AND (?2 IS NULL OR lower(c.name) LIKE '%' || lower(?2) || '%')
          AND (?3 IS NULL OR a.created_at >= ?3)
        ORDER BY a.updated_at DESC LIMIT 40`, a.status ?? null, a.company ?? null, a.days ? sinceIso(a.days) : null));
    },
  }),

  search_jobs: tool({
    description: "Full-text search over every job Chotu has seen (titles, descriptions, locations), best scored first.",
    args: z.object({ query: z.string(), only_viable: z.boolean().default(true), limit: z.number().default(8) }),
    argsDoc: `{"query": "computer vision", "only_viable": true}`,
    async run({ env }, a) {
      const q = a.query.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
      return rowsText(await all(env.DB, `
        SELECT j.title, c.name AS company, j.location, j.kind, j.stage, j.visa, s.combined AS score, j.url
        FROM jobs_fts f JOIN jobs j ON j.rowid = f.rowid JOIN companies c ON c.id = j.company_id LEFT JOIN scores s ON s.job_id = j.id
        WHERE jobs_fts MATCH ?1 AND (?2 = 0 OR j.stage IN ('ranked','scored','recommended'))
        ORDER BY COALESCE(s.combined, -1) DESC, bm25(jobs_fts) LIMIT ?3`, q, a.only_viable ? 1 : 0, Math.min(a.limit, 20)));
    },
  }),

  company: tool({
    description: "Everything Chotu knows about one company: visa status, latest dossier summary, open jobs, your applications.",
    args: z.object({ name: z.string() }), argsDoc: `{"name": "Helsing"}`,
    async run({ env }, a) {
      const c = await first<{ id: string; name: string }>(env.DB,
        "SELECT * FROM companies WHERE lower(name) LIKE '%' || lower(?) || '%' ORDER BY length(name) LIMIT 1", a.name);
      if (!c) return `No company matching "${a.name}". Use research_company to research it.`;
      const research = await first<{ dossier: string; created_at: string }>(env.DB,
        "SELECT dossier, created_at FROM company_research WHERE company_id = ? ORDER BY created_at DESC LIMIT 1", c.id);
      const jobs = await all(env.DB, `SELECT j.title, j.stage, s.combined FROM jobs j LEFT JOIN scores s ON s.job_id = j.id
        WHERE j.company_id = ? AND j.stage != 'filtered_out' ORDER BY s.combined DESC LIMIT 5`, c.id);
      const apps = await all(env.DB, "SELECT status, channel, created_at FROM applications WHERE company_id = ?", c.id);
      return truncate(JSON.stringify({ company: c, dossier: research ? JSON.parse(research.dossier) : null, jobs, applications: apps }), 3500);
    },
  }),

  sql: tool({
    description: "Read-only SQL over the backend, for questions the other tools don't cover. One SELECT; results capped at 50 rows.",
    args: z.object({ query: z.string() }), argsDoc: `{"query": "SELECT ... "}`,
    async run({ env }, a) {
      return rowsText(await all(env.DB, `SELECT * FROM (${safeSelect(a.query)}) LIMIT 50`));
    },
  }),

  research: tool({
    description: "Start the RESEARCH AGENT on an open-ended request (find/compare/shortlist companies, startups, labs, PhD programmes, or answer a question that needs web research). Runs in the background (a few minutes) and messages the user the report with visa checks and how-to-help ideas. Use for anything like 'research X', 'find companies that…', 'top 3 …'.",
    args: z.object({ request: z.string() }), argsDoc: `{"request": "computer vision companies in defence and aerospace in Poland — top 3 for my profile"}`,
    async run({ env }, a) {
      const id = await createReport(env, a.request);
      await enqueue(env, "research_topic", { reportId: id }, `topic:${id}`);
      return `Queued research report ${id.slice(0, 8)}. The research agent will message the user with the results in a few minutes.`;
    },
  }),

  research_company: tool({
    description: "Deep dossier on ONE company + a handcrafted outreach email + proof-of-work idea. Runs in the background.",
    args: z.object({ name: z.string(), domain: z.string().optional() }), argsDoc: `{"name": "Weaviate", "domain": "weaviate.io"}`,
    async run({ env }, a) {
      const id = await upsertCompany(env, { name: a.name, domain: a.domain ?? null, source: "manual" });
      await enqueue(env, "research_company", { companyId: id }, `research:${id}:${nowIso().slice(0, 10)}`);
      return `Queued a dossier for ${a.name}; it will arrive as a separate message in a few minutes.`;
    },
  }),

  web_search: tool({
    description: "Quick web search via the SEARCH AGENT (reads the top page). For a fast factual lookup; use `research` for anything bigger.",
    args: z.object({ query: z.string() }), argsDoc: `{"query": "ELLIS PhD 2027 application deadline"}`,
    async run({ env, llm }, a) {
      const { notes } = await searchAgent(env, { goal: a.query, queries: [a.query], readTop: 1 }, llm);
      return notesToText(notes, 3500);
    },
  }),

  read_url: tool({
    description: "Read one web page and answer a question about it (job posting, company page, programme page).",
    args: z.object({ url: z.string(), question: z.string() }), argsDoc: `{"url": "https://...", "question": "What are the requirements?"}`,
    async run({ env, llm }, a) { return truncate(await readWebsite(env, a.url, a.question, llm), 3000); },
  }),

  visa_check: tool({
    description: "Run the VISA AGENT on a company: does it sponsor work visas? (IND register → cached verdict → web evidence)",
    args: z.object({ company: z.string(), location: z.string().optional() }), argsDoc: `{"company": "Picnic", "location": "Amsterdam"}`,
    async run({ env, llm }, a) {
      const id = await upsertCompany(env, { name: a.company, source: "manual" });
      const v = await checkVisa(env, id, { location: a.location ?? null }, llm);
      return `Visa verdict for ${a.company}: ${v.status}. ${v.evidence}`;
    },
  }),

  recommend_now: tool({
    description: "Ask the RECOMMENDER for new suggestions now (fills empty slots only; pending ones must be decided first). Cards are sent as separate messages.",
    args: z.object({}), argsDoc: `{}`,
    async run({ env }) {
      const created = await fillSlots(env, { force: true });
      return created.length ? `Sent ${created.length} new recommendation card(s).` : "No free slots (decide on pending ones first) or nothing scored yet.";
    },
  }),

  log_application: tool({
    description: "Record an application event, including ones made outside Chotu (e.g. 'I applied to Mollie today', 'Adyen invited me to interview').",
    args: z.object({
      company: z.string(), title: z.string().optional(),
      event: z.enum(["applied", "outreach_sent", "replied", "interview", "offer", "rejected", "withdrawn", "note"]), note: z.string().optional(),
    }),
    argsDoc: `{"company": "Mollie", "event": "applied", "title": "ML Engineer", "note": "via referral"}`,
    async run({ env }, a) {
      const companyId = await upsertCompany(env, { name: a.company, source: "manual" });
      const job = a.title ? await first<{ id: string }>(env.DB,
        "SELECT id FROM jobs WHERE company_id = ? AND lower(title) LIKE '%' || lower(?) || '%' LIMIT 1", companyId, a.title) : null;
      const existing = await first<{ id: string }>(env.DB,
        "SELECT id FROM applications WHERE company_id = ? AND (? IS NULL OR job_id = ?) ORDER BY updated_at DESC LIMIT 1", companyId, job?.id ?? null, job?.id ?? null);
      const appId = existing?.id ?? (await createApplication(env, companyId, job?.id ?? null, "portal", "chat"));
      await addApplicationEvent(env, appId, a.event, [a.title, a.note].filter(Boolean).join(" — ") || null, "chat");
      return `Logged ${a.event} for ${a.company}${existing ? " (existing application)" : " (new application)"}.`;
    },
  }),

  deadlines: tool({
    description: "Upcoming deadlines (accelerator batches, PhD calls, hackathons, job postings, personal) within N days, plus rolling-admission programs. Collected automatically.",
    args: z.object({ days: z.number().default(60) }), argsDoc: `{"days": 60}`,
    async run({ env }, a) {
      const today = localDay(env.TIMEZONE);
      const rows = await upcomingDeadlines(env, a.days, { overdueDays: 7 });
      const rolling = await rollingPrograms(env);
      const strip = (s: string) => s.replace(/<[^>]+>/g, "");
      return [...rows.map((d) => strip(deadlineLine(d, today)) + (d.source_url ? ` (${d.source_url})` : "")),
        ...rolling.map((d) => strip(deadlineLine(d, today)))].join("\n") || "No deadlines found yet.";
    },
  }),

  add_deadline: tool({
    description: "Add a deadline the user mentions (e.g. 'remind me: ELLIS PhD application closes Dec 1'). It gets reminders like the automatic ones.",
    args: z.object({ org: z.string(), title: z.string(), date: z.string().describe("YYYY-MM-DD"), kind: z.enum(["accelerator", "phd", "hackathon", "event", "job", "personal"]).default("personal") }),
    argsDoc: `{"org": "ELLIS", "title": "PhD application", "date": "2026-12-01", "kind": "phd"}`,
    async run({ env }, a) {
      const ok = await upsertDeadline(env, { org: a.org, title: a.title, kind: a.kind, date: a.date, evidence: "added in chat" });
      return ok ? `Added: ${a.org} — ${a.title} on ${a.date}.` : `"${a.date}" isn't a valid YYYY-MM-DD date.`;
    },
  }),

  prep: tool({
    description: "Preparation tracker: status of all items, or log progress on one.",
    args: z.object({ action: z.enum(["status", "log"]), item: z.string().optional(), amount: z.number().optional(), note: z.string().optional() }),
    argsDoc: `{"action": "log", "item": "leetcode", "amount": 2}`,
    async run({ env }, a) {
      if (a.action === "log") {
        if (!a.item || a.amount === undefined) return "Need item and amount to log.";
        await logPrep(env, a.item, a.amount, a.note ?? null);
      }
      return (await prepStatus(env)).map(prepLine).join("\n").replace(/<[^>]+>/g, "") || "No prep items configured.";
    },
  }),

  add_job: tool({
    description: "Add a job posting by URL: Chotu reads it, scores it against the profile and replies with the verdict.",
    args: z.object({ url: z.string(), description: z.string().optional() }), argsDoc: `{"url": "https://..."}`,
    async run({ env }, a) {
      await enqueue(env, "add_job_url", { url: a.url, pasted: a.description ?? null });
      return "Queued; the score arrives as a separate message shortly.";
    },
  }),

  profile: tool({
    description: "The user's profile: CV digest, goals, and hard constraints (visa, locations, dealbreakers), plus their recent decision history.",
    args: z.object({}), argsDoc: `{}`,
    async run({ env, profile }) {
      return truncate(`${profileDigest(profile, { includeBullets: false })}\n\nCONSTRAINTS\n${constraintsDigest(profile.constraints)}\n\nDECISIONS\n${await feedbackDigest(env, 15)}`, 4000);
    },
  }),
} satisfies Record<string, Tool<any>>;

type ToolName = keyof typeof TOOLS;

// ── The graph ────────────────────────────────────────────────────────────────
const Action = z.object({
  thought: z.string().default(""),
  tool: z.string().optional(),
  args: z.record(z.any()).default({}),
  answer: z.string().optional(),
});

interface Step { tool: string; args: unknown; observation: string }

const ChatState = Annotation.Root({
  message: Annotation<string>(),
  history: Annotation<string>(),
  steps: Annotation<Step[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  next: Annotation<z.infer<typeof Action> | null>(),
  answer: Annotation<string | null>(),
  startedAt: Annotation<number>(),
});
type S = typeof ChatState.State;

export function buildOrchestrator(env: Env, profile: Profile, llm: LLM) {
  const toolDoc = Object.entries(TOOLS).map(([n, t]) => `- ${n}: ${t.description}\n  args: ${t.argsDoc}`).join("\n");
  const system = `You are Chotu, ${profile.cv.basics.name}'s personal job-search assistant on Telegram. Today is ${localDay(env.TIMEZONE)} (${env.TIMEZONE}).
You coordinate a team of agents and a backend. Use tools to get facts — never invent numbers, companies or statuses.

TOOLS
${toolDoc}

BACKEND SCHEMA (for the sql tool)
${SCHEMA_DOC}

RULES
- Reply with ONE JSON object per turn: {"thought": "...", "tool": "<name>", "args": {...}}  OR  {"thought": "...", "answer": "..."}.
- Prefer the specific tools (stats, recommendations, alerts, applications) over raw sql. "Last week" = last 7 days.
- Research requests ("research…", "find companies…", "top N…") → the research tool (it runs in the background); then answer
  briefly that it's on its way. Don't try to do big research yourself with web_search.
- Always respect the user's constraints (visa sponsorship, locations, dealbreakers) when advising.
- Answers: short, specific, friendly; plain text with **bold** allowed; lists with "• ". No tables.`;

  async function think(s: S): Promise<Partial<S>> {
    const outOfTime = Date.now() - s.startedAt > TIME_BUDGET_MS || s.steps.length >= MAX_STEPS;
    const scratch = s.steps.map((st, i) => `STEP ${i + 1}: ${st.tool}(${JSON.stringify(st.args)})\nOBSERVATION: ${st.observation}`).join("\n\n");
    const { data } = await llm.json({
      purpose: "chat_orchestrator", tier: "reasoning", temperature: 0.2, maxTokens: 1500, system,
      prompt: `RECENT CONVERSATION:\n${s.history || "(none)"}\n\nUSER: ${s.message}\n\n${scratch ? `WORK SO FAR:\n${scratch}\n\n` : ""}` +
        (outOfTime ? "You are out of steps: give your best answer now with what you have." : "Next action (JSON):"),
    }, Action);
    if (outOfTime && !data.answer) return { next: { ...data, tool: undefined }, answer: "I ran out of time on that one — try asking it more narrowly." };
    return { next: data, answer: data.answer ?? (data.tool ? null : "🤷 I'm not sure how to help with that.") };
  }

  async function act(s: S): Promise<Partial<S>> {
    const n = s.next!;
    const name = n.tool as ToolName;
    const t = TOOLS[name] as Tool | undefined;
    let observation: string;
    if (!t) observation = `Unknown tool "${n.tool}". Available: ${Object.keys(TOOLS).join(", ")}`;
    else {
      const parsed = t.args.safeParse(n.args ?? {});
      if (!parsed.success) observation = `Invalid args: ${parsed.error.message.slice(0, 300)}. Expected ${t.argsDoc}`;
      else {
        try { observation = await t.run({ env, profile, llm }, parsed.data); }
        catch (e) { observation = `Tool error: ${e instanceof Error ? e.message : String(e)}`; }
      }
    }
    return { steps: [{ tool: String(n.tool), args: n.args, observation: truncate(observation, 3500) }] };
  }

  const route = (s: S) => (s.answer ? END : "act");

  return new StateGraph(ChatState)
    .addNode("think", think)
    .addNode("act", act)
    .addEdge(START, "think")
    .addConditionalEdges("think", route, { act: "act", [END]: END })
    .addEdge("act", "think")
    .compile();
}

/** Run one chat turn. Returns Telegram-ready HTML. */
export async function chat(env: Env, profile: Profile, message: string): Promise<string> {
  const past = await all<{ role: string; content: string }>(env.DB, "SELECT role, content FROM chat_messages ORDER BY id DESC LIMIT 8");
  const history = past.reverse().map((m) => `${m.role.toUpperCase()}: ${truncate(m.content, 400)}`).join("\n");
  const out = await buildOrchestrator(env, profile, new LLM(env)).invoke(
    { message, history, startedAt: Date.now() }, { recursionLimit: MAX_STEPS * 2 + 4 });
  const answer = (out.answer as string | null) ?? "Done.";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO chat_messages(role, content, at) VALUES ('user', ?, ?)").bind(truncate(message, 2000), nowIso()),
    env.DB.prepare("INSERT INTO chat_messages(role, content, at) VALUES ('assistant', ?, ?)").bind(truncate(answer, 2000), nowIso()),
  ]);
  // Keep memory small: last 200 messages.
  await run(env.DB, "DELETE FROM chat_messages WHERE id <= (SELECT id FROM chat_messages ORDER BY id DESC LIMIT 1 OFFSET 200)");
  return toTelegramHtml(answer);
}
