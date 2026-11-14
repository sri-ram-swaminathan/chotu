// The daily brief (11:00): everything you need to know, no LLM required — pure SQL.
import type { Env } from "../env";
import { all, first } from "../lib/db";
import { addDays, escapeHtml, localDay } from "../lib/util";
import type { Profile } from "../profile/profile";
import { notify, type Keyboard } from "../telegram/api";
import { prepLine, prepStatus } from "./prep";
import { briefDeadlineLines } from "../agents/deadlineAgent";

export async function buildBrief(env: Env, profile: Profile): Promise<{ html: string; keyboard: Keyboard }> {
  const today = localDay(env.TIMEZONE);
  const lines: string[] = [`☀️ <b>Chotu brief — ${today}</b>`];

  const grad = profile.constraints.graduation;
  if (grad) {
    const days = Math.ceil((Date.parse(grad.length === 7 ? grad + "-01" : grad) - Date.parse(today)) / 86_400_000);
    if (days > 0) lines.push(`🎓 ${days} days to graduation`);
  }

  // Pipeline snapshot
  const p = await first<{ pending: number; intent: number; applied: number; interviewing: number; new24: number; scored: number }>(env.DB, `
    SELECT (SELECT COUNT(*) FROM recommendations WHERE status='pending') AS pending,
           (SELECT COUNT(*) FROM applications WHERE status='intent') AS intent,
           (SELECT COUNT(*) FROM applications WHERE status IN ('applied','outreach_sent','replied')) AS applied,
           (SELECT COUNT(*) FROM applications WHERE status IN ('interview','offer')) AS interviewing,
           (SELECT COUNT(*) FROM jobs WHERE first_seen_at >= datetime('now','-1 day')) AS new24,
           (SELECT COUNT(*) FROM jobs WHERE stage='scored') AS scored`);
  lines.push(`\n📊 <b>Pipeline</b>: ${p?.new24 ?? 0} new postings (24h) · ${p?.scored ?? 0} scored & waiting · ${p?.pending ?? 0} recs pending`);
  lines.push(`📨 ${p?.intent ?? 0} to submit · ${p?.applied ?? 0} in flight · ${p?.interviewing ?? 0} interviewing/offers`);

  // Applications you said you'd send but haven't (intent > 2 days)
  const stale = await all<{ company: string; title: string | null; created_at: string }>(env.DB, `
    SELECT c.name AS company, j.title, a.created_at FROM applications a JOIN companies c ON c.id = a.company_id
    LEFT JOIN jobs j ON j.id = a.job_id WHERE a.status = 'intent' AND a.created_at < datetime('now','-2 days') LIMIT 5`);
  if (stale.length) lines.push(`\n⏳ <b>You said you'd apply</b>:\n` + stale.map((s) => `• ${escapeHtml(s.company)}${s.title ? ` — ${escapeHtml(s.title)}` : ""}`).join("\n"));

  // Follow-ups: applied/outreach with no new event in 7 days
  const follow = await all<{ company: string; status: string; updated_at: string }>(env.DB, `
    SELECT c.name AS company, a.status, a.updated_at FROM applications a JOIN companies c ON c.id = a.company_id
    WHERE a.status IN ('applied','outreach_sent') AND a.updated_at < datetime('now','-7 days') LIMIT 5`);
  if (follow.length) lines.push(`\n🔁 <b>Follow up</b>:\n` + follow.map((f) => `• ${escapeHtml(f.company)} (${f.status} ${f.updated_at.slice(0, 10)})`).join("\n"));

  // Deadlines: accelerator batches, PhD calls, postings and your own — collected by the deadline agent.
  lines.push(...(await briefDeadlineLines(env)));

  // Prep
  const prep = await prepStatus(env);
  if (prep.length) lines.push(`\n📚 <b>Prep today</b>:\n` + prep.map(prepLine).join("\n"));

  // System health
  const llm = await first<{ n: number; fails: number }>(env.DB,
    "SELECT COUNT(*) AS n, SUM(ok = 0) AS fails FROM llm_calls WHERE day = ?", localDay(env.TIMEZONE, new Date(Date.now() - 86_400_000)));
  const failed = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM tasks WHERE status = 'failed'");
  lines.push(`\n⚙️ Yesterday: ${llm?.n ?? 0} LLM calls (${llm?.fails ?? 0} failed) · ${failed?.n ?? 0} failed tasks`);

  const keyboard: Keyboard = prep.slice(0, 4).map((it) => [
    { text: `+1 ${it.title.slice(0, 20)}`, callback_data: `log:${it.id}:1` },
    { text: `+5`, callback_data: `log:${it.id}:5` },
  ]);
  return { html: lines.join("\n"), keyboard };
}


export async function sendBrief(env: Env, profile: Profile) {
  const b = await buildBrief(env, profile);
  await notify(env, b.html, b.keyboard);
}
