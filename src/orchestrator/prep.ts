// Preparation tracker: LeetCode, textbooks, projects, courses — anything in profile/prep.yaml.
import type { Env } from "../env";
import { all, first, run } from "../lib/db";
import { addDays, localDay, nowIso, uid } from "../lib/util";

export interface PrepItem {
  id: string; type: string; title: string; unit: string;
  daily_target: number | null; weekly_target: number | null; total_target: number | null; deadline: string | null;
}

export interface PrepStatus extends PrepItem {
  today: number; week: number; total: number; streak: number;
  /** what you need per day from now to hit total_target by the deadline */
  pacePerDay: number | null;
  dueToday: number | null;
}

export async function logPrep(env: Env, itemQuery: string, amount: number, note: string | null) {
  const item = await first<PrepItem>(
    env.DB,
    "SELECT * FROM prep_items WHERE active = 1 AND (id = ? OR lower(title) LIKE ?) ORDER BY id = ? DESC LIMIT 1",
    itemQuery.toLowerCase(), `%${itemQuery.toLowerCase()}%`, itemQuery.toLowerCase(),
  );
  if (!item) throw new Error(`No prep item matching "${itemQuery}". Try /prep to see ids.`);
  await run(env.DB, "INSERT INTO prep_logs(id, item_id, day, amount, note, at) VALUES (?, ?, ?, ?, ?, ?)",
    uid(), item.id, localDay(env.TIMEZONE), amount, note, nowIso());
  return item;
}

export async function prepStatus(env: Env): Promise<PrepStatus[]> {
  const today = localDay(env.TIMEZONE);
  // Week starts Monday.
  const dow = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7;
  const weekStart = addDays(today, -dow);
  const items = await all<PrepItem>(env.DB, "SELECT * FROM prep_items WHERE active = 1 ORDER BY type, id");
  const out: PrepStatus[] = [];
  for (const it of items) {
    const sums = await first<{ today: number; week: number; total: number }>(
      env.DB,
      `SELECT COALESCE(SUM(CASE WHEN day = ? THEN amount END), 0) AS today,
              COALESCE(SUM(CASE WHEN day >= ? THEN amount END), 0) AS week,
              COALESCE(SUM(amount), 0) AS total
       FROM prep_logs WHERE item_id = ?`,
      today, weekStart, it.id,
    );
    const days = new Set((await all<{ day: string }>(env.DB,
      "SELECT DISTINCT day FROM prep_logs WHERE item_id = ? AND day >= ?", it.id, addDays(today, -60))).map((d) => d.day));
    // Streak counts back from today (or yesterday, if nothing logged yet today).
    let streak = 0;
    let cursor = days.has(today) ? today : addDays(today, -1);
    while (days.has(cursor)) { streak++; cursor = addDays(cursor, -1); }

    let pacePerDay: number | null = null;
    if (it.total_target && it.deadline) {
      const daysLeft = Math.max(1, Math.ceil((Date.parse(it.deadline) - Date.parse(today)) / 86_400_000));
      pacePerDay = Math.max(0, (it.total_target - (sums?.total ?? 0)) / daysLeft);
    }
    const weeklyDaily = it.weekly_target ? Math.max(0, (it.weekly_target - (sums?.week ?? 0) + (sums?.today ?? 0)) / (7 - dow)) : null;
    const dueToday = it.daily_target ?? (pacePerDay !== null ? Math.ceil(pacePerDay) : weeklyDaily !== null ? Math.ceil(weeklyDaily) : null);
    out.push({ ...it, today: sums?.today ?? 0, week: sums?.week ?? 0, total: sums?.total ?? 0, streak, pacePerDay, dueToday });
  }
  return out;
}

export function prepLine(p: PrepStatus): string {
  const done = p.dueToday !== null && p.today >= p.dueToday;
  const target = p.dueToday !== null ? `${p.today}/${p.dueToday} ${p.unit} today` : `${p.today} ${p.unit} today`;
  const week = p.weekly_target ? ` · week ${p.week}/${p.weekly_target}` : "";
  const total = p.total_target ? ` · total ${p.total}/${p.total_target}` : "";
  const streak = p.streak ? ` · 🔥${p.streak}` : "";
  return `${done ? "✅" : "⬜"} <b>${p.title}</b> [${p.id}] — ${target}${week}${total}${streak}`;
}
