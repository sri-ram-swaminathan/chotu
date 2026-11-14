// ─────────────────────────────────────────────────────────────────────────────
// EMAIL AGENT (LangGraph) — triages every email in your job-search inbox.
//
//   START → classify ─┬─ job_alert          → extractJobs     ─┐
//                     ├─ application_update → applicationUpdate┤
//                     ├─ opportunity        → opportunity      ├─→ END
//                     ├─ funding_news       → fundingNews      ┤
//                     └─ newsletter / noise ───────────────────┘
//
// `classify` uses the CHEAP tier (Workers AI) — it runs on every email. Extraction uses the
// reasoning tier only when there's something worth extracting. This is cost-aware routing.
//
// The "funding_news" branch is a discovery engine: "Startup X raised €8M" in a newsletter
// becomes a tracked company and (if relevant) a research task — jobs you'd never have searched for.
// ─────────────────────────────────────────────────────────────────────────────
import { Annotation, END, START, StateGraph } from "@langchain/langgraph/web";
import { z } from "zod";
import type { Env } from "../env";
import { all, first, run } from "../lib/db";
import { normalizeCompany, nowIso, truncate, uid } from "../lib/util";
import { LLM } from "../llm/provider";
import { ingestJobs } from "../pipeline/ingest";
import { enqueue } from "../pipeline/tasks";
import { profileDigest, type Profile } from "../profile/profile";
import { upsertCompany } from "../profile/sync";
import { queueAlerts } from "./alertAgent";

const Category = z.enum(["job_alert", "application_update", "opportunity", "funding_news", "newsletter", "noise"]);
type Category = z.infer<typeof Category>;

export interface Notification { urgent: boolean; text: string }

const EmailState = Annotation.Root({
  emailId: Annotation<string>(),
  from: Annotation<string>(),
  subject: Annotation<string>(),
  body: Annotation<string>(),
  category: Annotation<Category>(),
  summary: Annotation<string>(),
  notifications: Annotation<Notification[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});
type S = typeof EmailState.State;

export function buildEmailGraph(env: Env, profile: Profile, llm: LLM) {
  const emailText = (s: S, max = 9000) => `From: ${s.from}\nSubject: ${s.subject}\n\n${truncate(s.body, max)}`;

  async function classify(s: S): Promise<Partial<S>> {
    const { data } = await llm.json(
      {
        purpose: "email_classify",
        tier: "cheap",
        system: `Classify an email from a job seeker's inbox. Categories:
job_alert: lists one or more job postings (LinkedIn/Indeed/Welcome to the Jungle alerts, job digests).
application_update: about an application the person submitted (confirmation, rejection, interview invite, recruiter reply, offer).
opportunity: a single non-job opportunity with a deadline: hackathon, accelerator/incubator call, PhD position, fellowship, competition, event.
funding_news: newsletter/news reporting startups raising money, launching, or expanding.
newsletter: other newsletters/articles. noise: marketing, receipts, security codes, spam.`,
        prompt: `${emailText(s, 3000)}\n\nReturn JSON: {"category": one of the categories, "summary": "one sentence"}`,
      },
      z.object({ category: Category, summary: z.string() }),
    );
    return { category: data.category, summary: data.summary };
  }

  async function extractJobs(s: S): Promise<Partial<S>> {
    const { data } = await llm.json(
      {
        purpose: "email_extract_jobs",
        tier: "bulk",
        system: "Extract every job posting listed in this job-alert email. Use the exact URLs present in the email. Skip ads and 'similar searches' links.",
        prompt: `${emailText(s)}\n\nReturn JSON: {"jobs": [{"title": str, "company": str, "location": str|null, "url": str, "snippet": str|null}]}`,
      },
      z.object({ jobs: z.array(z.object({ title: z.string(), company: z.string(), location: z.string().nullable().optional(), url: z.string(), snippet: z.string().nullable().optional() })) }),
    );
    const raws = data.jobs
      .filter((j) => /^https?:\/\//.test(j.url))
      .map((j) => ({ company: j.company, title: j.title, url: cleanTrackingUrl(j.url), location: j.location ?? null, description: j.snippet ?? null }));
    const stats = await ingestJobs(env, profile, raws, `email:${s.emailId}`);
    // Job-alert emails are the freshest source there is → hand new matches to the alert agent.
    const alerts = await queueAlerts(env, profile, stats.jobIds, `email:${s.emailId}`);
    return { summary: `${s.summary} — extracted ${raws.length} jobs, ${stats.passed} passed filters, ${alerts} sent to the alert agent.` };
  }

  async function applicationUpdate(s: S): Promise<Partial<S>> {
    const { data } = await llm.json(
      {
        purpose: "email_application_update",
        tier: "bulk",
        system: "Extract what happened with a job application from this email.",
        prompt: `${emailText(s)}\n\nReturn JSON: {"company": str, "role": str|null, "event": "applied"|"replied"|"interview"|"offer"|"rejected", "action_needed": str|null, "deadline": "YYYY-MM-DD"|null}`,
      },
      z.object({
        company: z.string(), role: z.string().nullable(), event: z.enum(["applied", "replied", "interview", "offer", "rejected"]),
        action_needed: z.string().nullable(), deadline: z.string().nullable(),
      }),
    );
    const app = await first<{ id: string }>(
      env.DB,
      `SELECT a.id FROM applications a JOIN companies c ON c.id = a.company_id WHERE c.normalized_name = ? ORDER BY a.updated_at DESC LIMIT 1`,
      normalizeCompany(data.company),
    );
    if (app) {
      const now = nowIso();
      await run(env.DB, "INSERT INTO application_events(id, application_id, type, note, source, at) VALUES (?, ?, ?, ?, ?, ?)",
        uid(), app.id, data.event, s.summary, `email:${s.emailId}`, now);
      await run(env.DB, "UPDATE applications SET status = ?, updated_at = ? WHERE id = ?", data.event, now, app.id);
    }
    const icon = { offer: "🎉", interview: "📅", replied: "💬", rejected: "🪦", applied: "📨" }[data.event];
    return {
      notifications: [{
        urgent: data.event !== "applied",
        text: `${icon} <b>${data.company}</b>${data.role ? ` — ${data.role}` : ""}: ${data.event}${app ? "" : " (not in tracker yet)"}\n${s.summary}` +
          (data.action_needed ? `\n👉 ${data.action_needed}${data.deadline ? ` by ${data.deadline}` : ""}` : ""),
      }],
    };
  }

  async function opportunity(s: S): Promise<Partial<S>> {
    const { data } = await llm.json(
      {
        purpose: "email_opportunity",
        tier: "bulk",
        system: "Extract the opportunity described in this email and judge relevance to the candidate.",
        prompt: `CANDIDATE:\n${profileDigest(profile, { includeBullets: false })}\n\nEMAIL:\n${emailText(s)}\n\nReturn JSON: {"title": str, "organization": str, "kind": "hackathon"|"accelerator"|"phd"|"event"|"job", "url": str|null, "location": str|null, "deadline": "YYYY-MM-DD"|null, "relevance": 0-10, "why": str}`,
      },
      z.object({
        title: z.string(), organization: z.string(), kind: z.enum(["hackathon", "accelerator", "phd", "event", "job"]),
        url: z.string().nullable(), location: z.string().nullable(), deadline: z.string().nullable(), relevance: z.number(), why: z.string(),
      }),
    );
    if (data.relevance >= 5) {
      await ingestJobs(env, profile, [{
        company: data.organization, title: data.title, kind: data.kind, url: data.url ?? `email:${s.emailId}`,
        location: data.location, deadline: data.deadline, description: `${data.why}\n\n${truncate(s.body, 4000)}`,
      }], `email:${s.emailId}`);
    }
    const daysLeft = data.deadline ? (Date.parse(data.deadline) - Date.now()) / 86_400_000 : Infinity;
    const urgent = data.relevance >= 6 && daysLeft <= 7;
    return {
      notifications: urgent
        ? [{ urgent: true, text: `⏰ <b>${data.title}</b> (${data.kind}, ${data.organization}) — deadline ${data.deadline}\n${data.why}${data.url ? `\n${data.url}` : ""}` }]
        : [],
    };
  }

  async function fundingNews(s: S): Promise<Partial<S>> {
    const { data } = await llm.json(
      {
        purpose: "email_funding_news",
        tier: "bulk",
        system: "Extract startups mentioned as raising money / launching / expanding. Judge relevance for the candidate (would they want to work there?).",
        prompt: `CANDIDATE:\n${profileDigest(profile, { includeBullets: false })}\n\nEMAIL:\n${emailText(s)}\n\nReturn JSON: {"companies": [{"name": str, "domain": str|null, "stage": str|null, "amount_eur": number|null, "location": str|null, "what": str, "relevance": 0-10}]}`,
      },
      z.object({ companies: z.array(z.object({
        name: z.string(), domain: z.string().nullable(), stage: z.string().nullable(), amount_eur: z.number().nullable(),
        location: z.string().nullable(), what: z.string(), relevance: z.number(),
      })) }),
    );
    const relevant = data.companies.filter((c) => c.relevance >= 7);
    for (const c of data.companies.filter((c) => c.relevance >= 5)) {
      const id = await upsertCompany(env, {
        name: c.name, domain: c.domain, funded_stage: c.stage, funding_eur: c.amount_eur ? Math.round(c.amount_eur) : null,
        region: c.location, source: "email",
      });
      if (c.relevance >= 7) await enqueue(env, "research_company", { companyId: id }, `research:${id}:${nowIso().slice(0, 7)}`);
    }
    return { summary: `${s.summary} — ${data.companies.length} companies, ${relevant.length} queued for research.` };
  }

  const route = (s: S) => s.category;

  return new StateGraph(EmailState)
    .addNode("classify", classify)
    .addNode("extractJobs", extractJobs)
    .addNode("applicationUpdate", applicationUpdate)
    .addNode("opportunity", opportunity)
    .addNode("fundingNews", fundingNews)
    .addEdge(START, "classify")
    .addConditionalEdges("classify", route, {
      job_alert: "extractJobs",
      application_update: "applicationUpdate",
      opportunity: "opportunity",
      funding_news: "fundingNews",
      newsletter: END,
      noise: END,
    })
    .addEdge("extractJobs", END)
    .addEdge("applicationUpdate", END)
    .addEdge("opportunity", END)
    .addEdge("fundingNews", END)
    .compile();
}

/** LinkedIn & co. wrap links in tracking redirects; strip query noise so dedupe-by-URL works. */
function cleanTrackingUrl(url: string): string {
  try {
    const u = new URL(url);
    const li = u.pathname.match(/\/jobs\/view\/(\d+)/);
    if (u.hostname.includes("linkedin.com") && li) return `https://www.linkedin.com/jobs/view/${li[1]}/`;
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|trk|ref|refId|trackingId|lipi|midToken|midSig|eid|otpToken)/i.test(p)) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url;
  }
}

export async function processEmail(env: Env, profile: Profile, emailId: string): Promise<Notification[]> {
  const e = await first<{ id: string; from_addr: string; subject: string; body: string; processed_at: string | null }>(
    env.DB, "SELECT id, from_addr, subject, body, processed_at FROM emails WHERE id = ?", emailId);
  if (!e || e.processed_at) return []; // idempotent
  const graph = buildEmailGraph(env, profile, new LLM(env));
  const out = await graph.invoke({ emailId: e.id, from: e.from_addr ?? "", subject: e.subject ?? "", body: e.body ?? "" });
  await run(env.DB, "UPDATE emails SET category = ?, summary = ?, processed_at = ? WHERE id = ?", out.category, out.summary, nowIso(), e.id);
  return out.notifications;
}

/** Store an incoming email (from Email Routing or Gmail polling) and queue it for the agent. */
export async function storeEmail(env: Env, m: { messageId: string; from: string; subject: string; body: string; receivedAt?: string }) {
  const id = uid();
  const res = await run(
    env.DB,
    `INSERT INTO emails(id, message_id, from_addr, subject, received_at, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`,
    id, m.messageId, m.from, m.subject, m.receivedAt ?? nowIso(), truncate(m.body, 60000),
  );
  if (res.meta.changes) await enqueue(env, "process_email", { emailId: id }, `email:${id}`);
  return res.meta.changes > 0;
}

export async function recentEmails(env: Env, limit = 50) {
  return all(env.DB, "SELECT id, from_addr, subject, received_at, category, summary FROM emails ORDER BY received_at DESC LIMIT ?", limit);
}
