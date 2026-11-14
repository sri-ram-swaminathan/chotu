// ─────────────────────────────────────────────────────────────────────────────
// DEADLINE AGENT — every accelerator batch, PhD call, hackathon and posting deadline, without you typing any.
//
// Four sources feed one `deadlines` table:
//   1. Opportunities   — any job/PhD/accelerator/hackathon with a deadline (from watched pages, emails, /add)
//                        is copied over every tick (syncJobDeadlines, no LLM).
//   2. Deadline hunter — for each program in targets.yaml (accelerators, PhD programs, hackathons) the SEARCH
//                        AGENT looks up the next batch's deadline: daily until one is found, then weekly.
//   3. You             — constraints.yaml `deadlines` are mirrored in (kind "personal").
//   4. Chat            — "add a deadline: ELLIS PhD, Dec 1" via the orchestrator's add_deadline tool.
//
// Borrowed from career-ops' closing-soon.mjs: never guess. A hunted date only counts as "verified" when
// the quoted source sentence actually contains it (lib/dates.ts); otherwise it's shown as "unverified".
// Overdue items stay visible for a few days instead of silently disappearing.
//
// Reminders go out at 14 / 7 / 3 / 1 days before (configurable), each threshold once.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod";
import type { Env } from "../env";
import { all, first, kvGet, kvSet, run } from "../lib/db";
import { daysUntil, evidenceMentionsDate, parseIsoDate } from "../lib/dates";
import { addDays, escapeHtml, localDay, normalizeCompany, nowIso, truncate, uid } from "../lib/util";
import { LLM } from "../llm/provider";
import { enqueue } from "../pipeline/tasks";
import type { Profile } from "../profile/profile";
import { notify, type Keyboard } from "../telegram/api";
import { searchAndExtract } from "./searchAgent";

export interface DeadlineInput {
  org: string; title: string; kind: string; date: string | null;
  confidence?: "verified" | "unverified"; evidence?: string | null; sourceUrl?: string | null; jobId?: string | null;
}

export interface DeadlineRow {
  id: string; org: string; title: string; kind: string; date: string | null; status: string; confidence: string;
  evidence: string | null; source_url: string | null; reminded_days: number | null;
}

/** Insert or refresh a deadline. Never resurrects one you marked done/dismissed. Returns false if invalid. */
export async function upsertDeadline(env: Env, d: DeadlineInput): Promise<boolean> {
  const orgNorm = normalizeCompany(d.org) || d.org.toLowerCase();
  const now = nowIso();
  if (d.date) {
    if (!parseIsoDate(d.date)) return false;
    await run(env.DB,
      `INSERT INTO deadlines(id, org, org_norm, title, kind, date, status, confidence, evidence, source_url, job_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_norm, date) WHERE date IS NOT NULL DO UPDATE SET
         title = CASE WHEN excluded.confidence = 'verified' THEN excluded.title ELSE deadlines.title END,
         confidence = CASE WHEN deadlines.confidence = 'verified' OR excluded.confidence = 'verified' THEN 'verified' ELSE 'unverified' END,
         evidence = COALESCE(excluded.evidence, deadlines.evidence),
         source_url = COALESCE(deadlines.source_url, excluded.source_url),
         job_id = COALESCE(deadlines.job_id, excluded.job_id),
         updated_at = excluded.updated_at`,
      uid(), d.org, orgNorm, truncate(d.title, 160), d.kind, d.date, d.confidence ?? "verified",
      d.evidence ? truncate(d.evidence, 400) : null, d.sourceUrl ?? null, d.jobId ?? null, now, now);
  } else {
    await run(env.DB,
      `INSERT INTO deadlines(id, org, org_norm, title, kind, date, status, confidence, evidence, source_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'rolling', 'verified', ?, ?, ?, ?)
       ON CONFLICT(org_norm, title) WHERE date IS NULL DO UPDATE SET
         evidence = COALESCE(excluded.evidence, deadlines.evidence), updated_at = excluded.updated_at`,
      uid(), d.org, orgNorm, truncate(d.title, 160), d.kind, d.evidence ? truncate(d.evidence, 400) : null, d.sourceUrl ?? null, now, now);
  }
  return true;
}

// ── Source 1: opportunities that carry a deadline ────────────────────────────
/** Copy new deadlines from the jobs table. A job's own description must mention the date to count as verified. */
export async function syncJobDeadlines(env: Env): Promise<number> {
  const rows = await all<{ id: string; title: string; kind: string; deadline: string; url: string | null; description: string | null; company: string }>(env.DB, `
    SELECT j.id, j.title, j.kind, j.deadline, j.url, j.description, c.name AS company
    FROM jobs j JOIN companies c ON c.id = j.company_id
    WHERE j.deadline IS NOT NULL AND j.deadline >= date('now', '-1 day') AND j.visa != 'blocked'
      AND (j.kind NOT IN ('job','internship') OR j.stage != 'filtered_out')   -- programs are always interesting
      AND NOT EXISTS (SELECT 1 FROM deadlines d WHERE d.job_id = j.id)
    LIMIT 40`);
  let n = 0;
  for (const r of rows) {
    const ok = await upsertDeadline(env, {
      org: r.company, title: r.title, kind: r.kind, date: r.deadline, jobId: r.id,
      sourceUrl: r.url?.startsWith("http") ? r.url : null,
      confidence: evidenceMentionsDate(r.description, r.deadline) ? "verified" : "unverified",
    });
    if (ok) n++;
  }
  return n;
}

// ── Source 3: your own deadlines from constraints.yaml ───────────────────────
export async function syncPersonalDeadlines(env: Env, profile: Profile) {
  for (const d of profile.constraints.deadlines) {
    await upsertDeadline(env, { org: "You", title: d.what, kind: "personal", date: d.date, evidence: "constraints.yaml" });
  }
}

// ── Source 2: the deadline hunter ────────────────────────────────────────────
export interface Program { name: string; url: string; kind: string }

/**
 * Programs = watched pages that have a `name` (accelerators, PhD programs, hackathons). Pages without one
 * (e.g. a search-results page listing many PhD positions) are skipped: their individual deadlines arrive
 * through syncJobDeadlines instead.
 */
export function programsOf(profile: Profile): Program[] {
  return profile.targets.watch_pages
    .filter((w) => w.name && w.kind !== "companies")
    .map((w) => ({ name: w.name!, url: w.url, kind: w.kind === "job" ? "accelerator" : w.kind }));
}

const Batch = z.object({
  batch: z.string(),                                     // "Spring 2027 (X27)", "Cohort 12", "2027 PhD call"
  deadline: z.string().nullable().catch(null).default(null), // YYYY-MM-DD
  status: z.enum(["upcoming", "open", "rolling", "late_applications", "closed", "unknown"]).catch("unknown").default("unknown"),
  evidence: z.string().default(""),                      // the exact sentence the date comes from
  source_url: z.string().nullable().catch(null).default(null),
});
// Models sometimes answer with a bare list instead of {batches: [...]}: accept both.
const Batches = z.preprocess((v) => (Array.isArray(v) ? { batches: v } : v), z.object({ batches: z.array(Batch).default([]) }));

/** hunt_deadlines task: find upcoming deadlines for one program and store them. */
export async function huntDeadlines(env: Env, program: Program) {
  const today = localDay(env.TIMEZONE);
  const year = today.slice(0, 4);
  const { data, sources } = await searchAndExtract(env, {
    goal: `When is the application deadline for the next batch / cohort / intake of ${program.name} (${program.url})? Today is ${today}.`,
    queries: [`${program.name} application deadline ${year}`, `${program.name} next batch apply deadline ${+year + 1}`],
    urls: [program.url],
    readTop: 2,
    purpose: "deadline_hunt",
    instruction: `You find application deadlines for a ${program.kind} program. Today is ${today}.
List EVERY batch / cohort / call the notes mention from the last 3 months onwards, including ones whose deadline passed.
For each: batch name; deadline as YYYY-MM-DD (null if no date is written); status:
  upcoming = deadline in the future · open = applications open now, deadline stated · rolling = reviewed on a rolling basis / no deadline ·
  late_applications = deadline passed but late applications are still accepted · closed = deadline passed · unknown.
evidence = the exact sentence from the notes stating the deadline or status (copy it verbatim); source_url = where it came from.
Never infer a date that isn't written down. Prefer the program's own website over third-party articles.`,
    schema: Batches,
    jsonShape: `{"batches":[{"batch": str, "deadline": "YYYY-MM-DD"|null, "status": "upcoming"|"open"|"rolling"|"late_applications"|"closed"|"unknown", "evidence": str, "source_url": str|null}]}`,
  }, new LLM(env));

  // The model reports what it sees; these rules decide what becomes a deadline.
  let found = 0;
  for (const b of data.batches) {
    const date = b.deadline && parseIsoDate(b.deadline) ? b.deadline : null;
    const future = date !== null && daysUntil(date, today) >= -1;
    const rolling = b.status === "rolling" || b.status === "late_applications";
    let ok = false;
    if (future) {
      ok = await upsertDeadline(env, {
        org: program.name, title: b.batch, kind: program.kind, date,
        confidence: evidenceMentionsDate(b.evidence, date!) ? "verified" : "unverified",
        evidence: b.evidence || null, sourceUrl: b.source_url ?? program.url,
      });
    } else if (rolling) {
      ok = await upsertDeadline(env, {
        org: program.name, title: b.status === "late_applications" ? `${b.batch} (late applications open)` : b.batch,
        kind: program.kind, date: null, evidence: b.evidence || null, sourceUrl: b.source_url ?? program.url,
      });
    }
    if (ok) found++;
  }
  void sources;
  await kvSet(env.DB, `deadline_hunt:${program.url}`, nowIso());
  return { program: program.name, found };
}

/** Queue hunts: daily for programs with no known upcoming deadline, every `search_every_days` otherwise. */
export async function queueDeadlineHunts(env: Env, profile: Profile) {
  const today = localDay(env.TIMEZONE);
  const every = profile.targets.deadlines.search_every_days;
  let queued = 0;
  for (const p of programsOf(profile)) {
    const last = await kvGet(env.DB, `deadline_hunt:${p.url}`);
    const ageDays = last ? (Date.now() - Date.parse(last)) / 86_400_000 : Infinity;
    const upcoming = await first(env.DB,
      "SELECT 1 FROM deadlines WHERE org_norm = ? AND status IN ('open','rolling') AND (date IS NULL OR date >= ?) LIMIT 1",
      normalizeCompany(p.name) || p.name.toLowerCase(), today);
    if (ageDays < (upcoming ? every : 1)) continue;
    await enqueue(env, "hunt_deadlines", p, `hunt:${p.url}:${today}`);
    queued++;
  }
  return queued;
}

// ── Reading + reminders ──────────────────────────────────────────────────────
export async function upcomingDeadlines(env: Env, days: number, opts: { overdueDays?: number } = {}) {
  const today = localDay(env.TIMEZONE);
  return all<DeadlineRow>(env.DB,
    `SELECT * FROM deadlines WHERE status = 'open' AND date BETWEEN ? AND ? ORDER BY date, org`,
    addDays(today, -(opts.overdueDays ?? 0)), addDays(today, days));
}

export const rollingPrograms = (env: Env) =>
  all<DeadlineRow>(env.DB, "SELECT * FROM deadlines WHERE status = 'rolling' ORDER BY org");

const fmtDate = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** One line per deadline, for the brief, /deadlines and reminders. */
export function deadlineLine(d: DeadlineRow, today: string): string {
  const n = d.date ? daysUntil(d.date, today) : NaN;
  const when = !d.date ? "rolling" : n < 0 ? `⚠️ ${-n}d overdue` : n === 0 ? "<b>today</b>" : n === 1 ? "<b>tomorrow</b>" : `in ${n}d`;
  const label = `${escapeHtml(d.org)}: ${escapeHtml(d.title)}`;
  return `• ${d.date ? fmtDate(d.date) + " · " : ""}${when} — ${d.source_url ? `<a href="${d.source_url}">${label}</a>` : label}` +
    (d.confidence === "unverified" ? " <i>(unverified)</i>" : "");
}

/** Daily: ping each deadline as it crosses 14 / 7 / 3 / 1 days out (each threshold once). */
export async function sendDeadlineReminders(env: Env, profile: Profile) {
  const today = localDay(env.TIMEZONE);
  const thresholds = [...profile.targets.deadlines.remind_days].sort((a, b) => b - a);
  const rows = await upcomingDeadlines(env, Math.max(...thresholds));
  const due = rows.flatMap((d) => {
    const n = daysUntil(d.date!, today);
    const t = [...thresholds].reverse().find((x) => n <= x);          // smallest threshold the deadline is within
    return t !== undefined && (d.reminded_days === null || d.reminded_days > t) ? [{ d, t }] : [];
  });
  if (!due.length) return 0;
  const keyboard: Keyboard = due.slice(0, 6).map(({ d }) => [
    { text: `✅ ${truncate(d.org, 18)}: done`, callback_data: `dl:d:${d.id}` },
    { text: "🔕 Skip", callback_data: `dl:x:${d.id}` },
  ]);
  await notify(env, `⏰ <b>Deadlines coming up</b>\n${due.map(({ d }) => deadlineLine(d, today)).join("\n")}`, keyboard);
  for (const { d, t } of due) await run(env.DB, "UPDATE deadlines SET reminded_days = ? WHERE id = ?", t, d.id);
  return due.length;
}

/** Brief section: next 30 days + anything overdue in the last 3 days + rolling programs. */
export async function briefDeadlineLines(env: Env): Promise<string[]> {
  const today = localDay(env.TIMEZONE);
  const rows = await upcomingDeadlines(env, 30, { overdueDays: 3 });
  const rolling = await rollingPrograms(env);
  if (!rows.length && !rolling.length) return [];
  const lines = [`\n📅 <b>Deadlines</b> (next 30 days)`];
  lines.push(...rows.slice(0, 10).map((d) => deadlineLine(d, today)));
  if (rows.length > 10) lines.push(`…and ${rows.length - 10} more — /deadlines`);
  if (rolling.length) lines.push(`🔁 Rolling admissions: ${rolling.slice(0, 6).map((r) => escapeHtml(r.org)).join(", ")}`);
  return lines;
}
