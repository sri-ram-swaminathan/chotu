// Generic "watch this page" source — for anything without an API: PhD portals (AcademicTransfer,
// EURAXESS search pages), accelerator calls (Antler, Rockstart, HighTechXL, YC), Brainport/StartupAmsterdam
// job boards, university group pages. We hash the page text; only when it CHANGES do we pay for an LLM call
// to extract opportunities. (JavaScript-rendered pages won't work with plain fetch — prefer their RSS/alerts.)
import { z } from "zod";
import type { Env } from "../env";
import { first, kvGet, kvSet, run } from "../lib/db";
import { truncate } from "../lib/util";
import { LLM } from "../llm/provider";
import { fetchPage } from "../agents/tools";
import { ingestJobs } from "../pipeline/ingest";
import { scoreJob } from "../pipeline/score";
import { enqueue } from "../pipeline/tasks";
import { profileDigest, type Profile } from "../profile/profile";
import { upsertCompany } from "../profile/sync";
import { queueAlerts } from "../agents/alertAgent";
import { dedupeKey, nowIso } from "../lib/util";

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const Opps = z.object({
  items: z.array(z.object({
    title: z.string(), organization: z.string(), url: z.string().nullable(), location: z.string().nullable(),
    deadline: z.string().nullable(), description: z.string().nullable(),
  })),
});

const Companies = z.object({
  companies: z.array(z.object({ name: z.string(), domain: z.string().nullable(), what: z.string(), relevance: z.number() })),
});

export async function watchPage(env: Env, profile: Profile, w: { url: string; kind: string }) {
  const page = await fetchPage(w.url, 20000);
  if (!page) throw new Error(`could not fetch ${w.url}`);
  const hash = await sha256(page.text);
  const key = `watch:${w.url}`;
  const previous = await kvGet(env.DB, key);
  if (previous === hash) return { changed: false };

  const llm = new LLM(env);
  if (w.kind === "companies") {
    const { data } = await llm.json({
      purpose: "watch_companies", tier: "bulk",
      system: "Extract companies listed on this page and rate how relevant each is as an employer for the candidate (0-10).",
      prompt: `CANDIDATE:\n${profileDigest(profile, { includeBullets: false })}\n\nPAGE (${page.url}):\n${truncate(page.text, 15000)}\n\nReturn JSON: {"companies":[{"name","domain","what","relevance"}]}`,
    }, Companies);
    for (const c of data.companies.filter((c) => c.relevance >= 6)) {
      const id = await upsertCompany(env, { name: c.name, domain: c.domain, source: "discovery" });
      if (c.relevance >= 8) await enqueue(env, "research_company", { companyId: id }, `research:${id}:${nowIso().slice(0, 7)}`);
    }
  } else {
    const { data } = await llm.json({
      purpose: "watch_extract", tier: "bulk",
      system: `Extract every ${w.kind} opportunity listed on this page. Use absolute URLs if present. Dates as YYYY-MM-DD.`,
      prompt: `PAGE (${page.url}):\n${truncate(page.text, 15000)}\n\nReturn JSON: {"items":[{"title","organization","url","location","deadline","description"}]}`,
    }, Opps);
    const stats = await ingestJobs(env, profile, data.items.map((i) => ({
      company: i.organization, title: i.title, url: i.url ?? `${w.url}#${encodeURIComponent(i.title)}`,
      location: i.location, deadline: i.deadline, description: i.description, kind: w.kind,
    })), `watch:${w.url}`);
    // A changed page = new listings. First-ever read is a backlog, not news (no alerts).
    await queueAlerts(env, profile, stats.jobIds, `watch:${w.url}`, { initialCrawl: !previous });
  }
  await kvSet(env.DB, key, hash);
  return { changed: true };
}

const ExtractedJob = z.object({
  company: z.string(), title: z.string(), location: z.string().nullable(),
  kind: z.enum(["job", "internship", "phd", "accelerator", "hackathon", "event"]),
  deadline: z.string().nullable(), description: z.string(),
});

/** /add <url> [pasted description] — manual entry. Bypasses filters (you chose it) but still scores it. */
export async function addJobFromUrl(env: Env, profile: Profile, url: string, pasted?: string) {
  const page = pasted ? null : await fetchPage(url, 12000);
  const text = pasted || page?.text;
  if (!text) throw new Error("Couldn't read that page (login wall?). Send: /add <url> followed by the pasted job description.");
  const llm = new LLM(env);
  const { data } = await llm.json({
    purpose: "add_job_extract", tier: "bulk",
    system: "Extract the job/opportunity from this page. description = the full responsibilities + requirements text, cleaned.",
    prompt: `URL: ${url}\n\n${truncate(text, 12000)}\n\nReturn JSON: {company, title, location, kind, deadline, description}`,
  }, ExtractedJob);
  await ingestJobs(env, profile, [{ ...data, url }], "manual");
  const job = await first<{ id: string; stage: string }>(env.DB, "SELECT id, stage FROM jobs WHERE dedupe_key = ?", dedupeKey(data.company, data.title, data.location));
  if (!job) throw new Error("ingest failed");
  if (job.stage === "filtered_out") await run(env.DB, "UPDATE jobs SET stage='ranked' WHERE id=?", job.id);
  const s = await scoreJob(env, profile, job.id, llm);
  return { jobId: job.id, ...data, combined: s.combined, blocked: s.blocked };
}
