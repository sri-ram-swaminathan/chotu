// JSON API for the dashboard (public/index.html) and the sync scripts. All routes need the API token.
import { z } from "zod";
import type { Env } from "../env";
import { all, first } from "../lib/db";
import { localDay } from "../lib/util";
import { recentEmails } from "../agents/emailAgent";
import { enqueue } from "../pipeline/tasks";
import { syncProfile } from "../profile/sync";
import { storeSponsors } from "../sources/ind";
import { addApplicationEvent, createApplication, decide, fillSlots } from "../orchestrator/recommend";
import { logPrep, prepStatus } from "../orchestrator/prep";
import { buildBrief } from "../orchestrator/brief";
import { loadProfile } from "../profile/profile";
import { signedResumeUrl } from "./auth";
import { LLM } from "../llm/provider";
import { calendarLinks } from "./calendar";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

type Route = { method: string; pattern: RegExp; handler: (env: Env, req: Request, m: RegExpMatchArray, ctx: ExecutionContext) => Promise<Response> };
const routes: Route[] = [];
const route = (method: string, path: string, handler: Route["handler"]) =>
  routes.push({ method, pattern: new RegExp("^" + path.replace(/:(\w+)/g, "([^/]+)") + "$"), handler });

// ── Overview ─────────────────────────────────────────────────────────────────
route("GET", "/api/summary", async (env) => {
  const counts = await first(env.DB, `SELECT
    (SELECT COUNT(*) FROM companies) AS companies,
    (SELECT COUNT(*) FROM jobs) AS jobs,
    (SELECT COUNT(*) FROM jobs WHERE stage='ranked') AS ranked,
    (SELECT COUNT(*) FROM jobs WHERE stage='scored') AS scored,
    (SELECT COUNT(*) FROM jobs WHERE stage='filtered_out') AS filtered,
    (SELECT COUNT(*) FROM recommendations WHERE status='pending') AS pending,
    (SELECT COUNT(*) FROM applications) AS applications,
    (SELECT COUNT(*) FROM company_research) AS dossiers,
    (SELECT COUNT(*) FROM emails) AS emails,
    (SELECT COUNT(*) FROM sponsors) AS sponsors,
    (SELECT COUNT(*) FROM tasks WHERE status='queued') AS queued,
    (SELECT COUNT(*) FROM tasks WHERE status='failed') AS failed_tasks`);
  const llm = await all(env.DB, `SELECT provider, purpose, COUNT(*) AS calls, SUM(ok=0) AS failures, SUM(input_chars) AS input_chars
    FROM llm_calls WHERE day = ? GROUP BY provider, purpose ORDER BY calls DESC`, localDay(env.TIMEZONE));
  const appStatus = await all(env.DB, "SELECT status, COUNT(*) AS n FROM applications GROUP BY status");
  const filterReasons = await all(env.DB, `SELECT substr(filter_reason, 1, instr(filter_reason || ':', ':') - 1) AS reason, COUNT(*) AS n
    FROM jobs WHERE stage='filtered_out' GROUP BY reason ORDER BY n DESC`);
  const quota = await new LLM(env).quotaReport();
  return json({ counts, llm, quota, appStatus, filterReasons, budget: Number(env.LLM_DAILY_CALL_BUDGET) });
});

// The dashboard links to the calendar page; the page itself uses a signed key instead of the API token.
route("GET", "/api/calendar-links", async (env) => json(await calendarLinks(env)));

// One tiny request to every LLM provider — checks keys, model IDs and provider-specific params.
route("POST", "/api/llm/probe", async (env) => json(await new LLM(env).probe()));

route("GET", "/api/brief", async (env) => json(await buildBrief(env, await loadProfile(env))));

// ── Recommendations ──────────────────────────────────────────────────────────
route("GET", "/api/recommendations", async (env, req) => {
  const status = new URL(req.url).searchParams.get("status") ?? "pending";
  return json(await all(env.DB, `
    SELECT r.*, c.name AS company, j.title, j.kind, j.location, j.url, j.visa, j.deadline, s.fit, s.interest, s.summary
    FROM recommendations r JOIN companies c ON c.id = r.company_id LEFT JOIN jobs j ON j.id = r.job_id
    LEFT JOIN scores s ON s.job_id = r.job_id WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 100`, status));
});
route("POST", "/api/recommendations/fill", async (env) => json({ created: await fillSlots(env) }));
route("POST", "/api/recommendations/:id/decide", async (env, req, m) => {
  const body = z.object({ decision: z.enum(["applied", "ignored"]), reason: z.string().optional() }).parse(await req.json());
  return json(await decide(env, m[1]!, body.decision, body.reason));
});

// ── Jobs (with BM25 full-text search) ────────────────────────────────────────
route("GET", "/api/jobs", async (env, req) => {
  const p = new URL(req.url).searchParams;
  const q = p.get("q")?.trim();
  const stage = p.get("stage");
  const kind = p.get("kind");
  const where: string[] = [];
  const params: unknown[] = [];
  if (stage) { where.push("j.stage = ?"); params.push(stage); }
  if (kind) { where.push("j.kind = ?"); params.push(kind); }
  let from = "jobs j";
  let order = "COALESCE(s.combined, -1) DESC, j.keyword_score DESC";
  if (q) {
    // FTS5 query: quote each term so user input can't inject FTS syntax.
    from = "jobs_fts f JOIN jobs j ON j.rowid = f.rowid";
    where.push("jobs_fts MATCH ?");
    params.push(q.split(/\s+/).map((t) => `"${t.replace(/"/g, "")}"`).join(" "));
    order = "bm25(jobs_fts)";
  }
  const rows = await all(env.DB, `
    SELECT j.id, j.kind, j.title, j.location, j.url, j.stage, j.filter_reason, j.visa, j.keyword_score, j.deadline, j.first_seen_at,
           c.name AS company, c.id AS company_id, s.fit, s.interest, s.combined, s.summary, s.co_global, s.co_band, s.co_decision, s.co_archetype
    FROM ${from} JOIN companies c ON c.id = j.company_id LEFT JOIN scores s ON s.job_id = j.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT 200`, ...params);
  return json(rows);
});
route("GET", "/api/jobs/:id", async (env, _req, m) => {
  const job = await first(env.DB, `SELECT j.*, c.name AS company, s.fit, s.interest, s.combined, s.summary, s.fit_evidence, s.fit_gaps,
    s.interest_evidence, s.model, s.chotu_combined, s.co_global, s.co_cv_match, s.co_north_star, s.co_comp,
    s.co_culture, s.co_red_flags, s.co_red_flag_notes, s.co_archetype, s.co_band, s.co_decision, s.co_legitimacy, s.co_confidence
    FROM jobs j JOIN companies c ON c.id = j.company_id LEFT JOIN scores s ON s.job_id = j.id WHERE j.id = ?`, m[1]);
  const postings = await all(env.DB, "SELECT source, url, seen_at FROM postings WHERE job_id = ?", m[1]);
  return job ? json({ ...job, postings }) : json({ error: "not found" }, 404);
});
route("POST", "/api/jobs", async (env, req, _m, ctx) => {
  const body = z.object({ url: z.string().url(), description: z.string().optional() }).parse(await req.json());
  await enqueue(env, "add_job_url", { url: body.url, pasted: body.description ?? null });
  ctx.waitUntil(import("../scheduler").then(({ tick }) => tick(env, { tasksOnly: true })));
  return json({ queued: true }, 202);
});

// ── Applications ─────────────────────────────────────────────────────────────
route("GET", "/api/applications", async (env) => json(await all(env.DB, `
  SELECT a.*, c.name AS company, j.title, j.url,
         (SELECT id FROM resumes WHERE application_id = a.id ORDER BY created_at DESC LIMIT 1) AS resume_id
  FROM applications a JOIN companies c ON c.id = a.company_id LEFT JOIN jobs j ON j.id = a.job_id ORDER BY a.updated_at DESC`)));
route("GET", "/api/applications/:id", async (env, _req, m) => {
  const app = await first(env.DB, `SELECT a.*, c.name AS company, j.title, j.url FROM applications a
    JOIN companies c ON c.id = a.company_id LEFT JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`, m[1]);
  const events = await all(env.DB, "SELECT * FROM application_events WHERE application_id = ? ORDER BY at", m[1]);
  const resume = await first<{ id: string }>(env.DB, "SELECT id FROM resumes WHERE application_id = ? ORDER BY created_at DESC LIMIT 1", m[1]);
  return json({ ...app, events, resumeUrl: resume ? await signedResumeUrl(env, resume.id) : null });
});
route("POST", "/api/applications", async (env, req) => {
  // Manual entry: "I applied to X" for things outside Chotu. Warns on duplicates.
  const body = z.object({ company: z.string(), jobId: z.string().optional(), channel: z.string().default("portal") }).parse(await req.json());
  const { upsertCompany } = await import("../profile/sync");
  const companyId = await upsertCompany(env, { name: body.company, source: "manual" });
  const prior = await all(env.DB, "SELECT id, status, created_at FROM applications WHERE company_id = ?", companyId);
  const id = await createApplication(env, companyId, body.jobId ?? null, body.channel, "dashboard");
  return json({ id, priorAtCompany: prior });
});
route("POST", "/api/applications/:id/events", async (env, req, m) => {
  const body = z.object({ type: z.string(), note: z.string().optional() }).parse(await req.json());
  await addApplicationEvent(env, m[1]!, body.type, body.note ?? null, "dashboard");
  return json({ ok: true });
});
route("POST", "/api/applications/:id/resume", async (env, _req, m, ctx) => {
  await enqueue(env, "tailor_resume", { applicationId: m[1] }, `resume:${m[1]}:${Date.now()}`);
  ctx.waitUntil(import("../scheduler").then(({ tick }) => tick(env, { tasksOnly: true })));
  return json({ queued: true }, 202);
});

// ── Companies + research ─────────────────────────────────────────────────────
route("GET", "/api/companies", async (env) => json(await all(env.DB, `
  SELECT c.*, (SELECT COUNT(*) FROM jobs WHERE company_id = c.id) AS jobs,
         (SELECT COUNT(*) FROM contacts WHERE normalized_company = c.normalized_name) AS contacts,
         (SELECT created_at FROM company_research WHERE company_id = c.id ORDER BY created_at DESC LIMIT 1) AS researched_at
  FROM companies c ORDER BY researched_at IS NULL, researched_at DESC, c.name LIMIT 500`)));
route("GET", "/api/companies/:id", async (env, _req, m) => {
  const company = await first(env.DB, "SELECT * FROM companies WHERE id = ?", m[1]);
  if (!company) return json({ error: "not found" }, 404);
  const research = await first(env.DB, "SELECT * FROM company_research WHERE company_id = ? ORDER BY created_at DESC LIMIT 1", m[1]);
  const jobs = await all(env.DB, `SELECT j.id, j.title, j.stage, j.url, s.combined FROM jobs j LEFT JOIN scores s ON s.job_id = j.id
    WHERE j.company_id = ? ORDER BY s.combined DESC`, m[1]);
  const contacts = await all(env.DB, "SELECT first_name, last_name, position, url FROM contacts WHERE normalized_company = ?", (company as { normalized_name: string }).normalized_name);
  const applications = await all(env.DB, "SELECT id, status, channel, created_at FROM applications WHERE company_id = ?", m[1]);
  return json({ company, research, jobs, contacts, applications });
});
route("POST", "/api/companies/:id/research", async (env, _req, m, ctx) => {
  await enqueue(env, "research_company", { companyId: m[1] }, `research:${m[1]}:${Date.now()}`);
  ctx.waitUntil(import("../scheduler").then(({ tick }) => tick(env, { tasksOnly: true })));
  return json({ queued: true }, 202);
});

// ── Prep ─────────────────────────────────────────────────────────────────────
route("GET", "/api/prep", async (env) => {
  const status = await prepStatus(env);
  const history = await all(env.DB, "SELECT item_id, day, SUM(amount) AS amount FROM prep_logs WHERE day >= date('now','-84 days') GROUP BY item_id, day");
  return json({ status, history });
});
route("POST", "/api/prep/log", async (env, req) => {
  const body = z.object({ item: z.string(), amount: z.number(), note: z.string().optional() }).parse(await req.json());
  await logPrep(env, body.item, body.amount, body.note ?? null);
  return json({ ok: true });
});

// ── Agents: alerts, research reports, feedback, chat ─────────────────────────
route("GET", "/api/alerts", async (env) => json(await all(env.DB, `
  SELECT a.*, j.title, j.url, j.location, c.name AS company FROM alerts a JOIN jobs j ON j.id = a.job_id
  JOIN companies c ON c.id = j.company_id ORDER BY a.sent_at DESC LIMIT 100`)));
route("GET", "/api/research-reports", async (env) => json(await all(env.DB,
  "SELECT id, request, status, report, created_at, finished_at FROM research_reports ORDER BY created_at DESC LIMIT 50")));
route("POST", "/api/research", async (env, req) => {
  const body = z.object({ request: z.string().min(3) }).parse(await req.json());
  const { createReport } = await import("../agents/researchAgent");
  const id = await createReport(env, body.request);
  await enqueue(env, "research_topic", { reportId: id }, `topic:${id}`);
  return json({ id, queued: true }, 202);
});
route("GET", "/api/deadlines", async (env) => json(await all(env.DB,
  "SELECT * FROM deadlines WHERE status IN ('open','rolling') ORDER BY date IS NULL, date LIMIT 300")));
route("GET", "/api/feedback", async (env) => {
  const { recentDecisions } = await import("../orchestrator/feedback");
  return json(await recentDecisions(env, 100));
});
// Same brain as the Telegram bot — handy for testing the orchestrator from curl or the dashboard.
route("POST", "/api/chat", async (env, req) => {
  const body = z.object({ message: z.string().min(1) }).parse(await req.json());
  const { chat } = await import("../agents/orchestrator");
  return json({ html: await chat(env, await loadProfile(env), body.message) });
});
route("POST", "/api/admin/checkin", async (env) => {
  const { sendCheckin } = await import("../orchestrator/checkin");
  return json({ asked: await sendCheckin(env) });
});

// ── Ops ──────────────────────────────────────────────────────────────────────
route("GET", "/api/emails", async (env) => json(await recentEmails(env)));
route("GET", "/api/runs", async (env) => json({
  runs: await all(env.DB, "SELECT * FROM runs ORDER BY id DESC LIMIT 50"),
  tasks: await all(env.DB, "SELECT id, type, status, attempts, last_error, run_after, updated_at FROM tasks WHERE status != 'done' ORDER BY updated_at DESC LIMIT 100"),
}));
route("POST", "/api/admin/tick", async (env) => {
  const { tick } = await import("../scheduler");
  return json(await tick(env));
});
route("POST", "/api/admin/daily", async (env) => {
  const { daily } = await import("../scheduler");
  return json(await daily(env));
});
route("POST", "/api/admin/profile", async (env, req) => {
  const body = z.object({ files: z.record(z.string()) }).parse(await req.json());
  return json(await syncProfile(env, body.files));
});
route("POST", "/api/admin/sponsors", async (env, req) => {
  const body = z.object({ rows: z.array(z.object({ name: z.string(), kvk: z.string().nullable().optional() })) }).parse(await req.json());
  return json({ stored: await storeSponsors(env, body.rows) });
});
route("POST", "/api/admin/discover", async (env, _req, _m, ctx) => {
  await enqueue(env, "discover", {}, `discover:${Date.now()}`);
  ctx.waitUntil(import("../scheduler").then(({ tick }) => tick(env, { tasksOnly: true })));
  return json({ queued: true }, 202);
});
route("POST", "/api/admin/retry-failed", async (env) => {
  await env.DB.prepare("UPDATE tasks SET status='queued', attempts=0, run_after=? WHERE status='failed'").bind(new Date().toISOString()).run();
  return json({ ok: true });
});

export async function handleApi(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (m) {
      try {
        return await r.handler(env, req, m, ctx);
      } catch (e) {
        if (e instanceof z.ZodError) return json({ error: "invalid request", issues: e.issues }, 400);
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }
  }
  return json({ error: "not found" }, 404);
}
