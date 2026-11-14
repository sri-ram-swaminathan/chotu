// The deadlines calendar: one data source (the deadlines table), three views.
//   /calendar?k=…        web page (public/calendar.html) — month grid + agenda, filter by kind
//   /calendar.json?k=…   what that page reads
//   /calendar.ics?k=…    iCalendar feed: subscribe once in Google/Apple/Outlook Calendar and it stays in sync
// `k` is an HMAC of your API token (see auth.ts), so the link works on your phone without logging in and
// can be revoked by rotating API_TOKEN.
import type { Env } from "../env";
import { all, run } from "../lib/db";
import { nowIso } from "../lib/util";
import { calendarSig } from "./auth";
import type { CalendarItem } from "./ics";

export type { CalendarItem } from "./ics";
export { toIcs } from "./ics";

export async function calendarLinks(env: Env) {
  const base = env.PUBLIC_URL.replace(/\/$/, "");
  const k = await calendarSig(env);
  return { web: `${base}/calendar?k=${k}`, ics: `${base}/calendar.ics?k=${k}`, json: `${base}/calendar.json?k=${k}` };
}

export async function calendarItems(env: Env): Promise<CalendarItem[]> {
  // Everything still open, plus the last 60 days of done/overdue items so the month view isn't empty behind you.
  return all<CalendarItem>(env.DB, `
    SELECT d.id, d.org, d.title, d.kind, d.date, d.status, d.confidence, d.evidence, d.source_url, j.url AS job_url
    FROM deadlines d LEFT JOIN jobs j ON j.id = d.job_id
    WHERE d.status IN ('open', 'rolling') OR (d.status = 'done' AND d.date >= date('now', '-60 days'))
    ORDER BY d.date IS NULL, d.date LIMIT 500`);
}

/** Mark done / dismiss from the web calendar. */
export async function setDeadlineStatus(env: Env, id: string, status: string) {
  if (!["open", "done", "dismissed"].includes(status)) throw new Error("bad status");
  await run(env.DB, "UPDATE deadlines SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), id);
}
