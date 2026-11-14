// DAILY CHECK-IN — "before I get new suggestions, ask whether I applied to the last ones".
//
// Every morning, before new recommendations go out, Chotu asks about:
//   • pending recommendations you haven't decided on → [✅ Applied] [⏳ Keep] [❌ Not applying → why?]
//   • applications you said you'd send but haven't confirmed → [✅ Submitted] [⏳ Still on it] [❌ Dropped]
// Each answer frees a slot and immediately pulls a replacement (capped at 2 new per day, see recommend.ts).
// "Keep" leaves the slot occupied — you're still working on it. The reasons go to the feedback loop.
import type { Env } from "../env";
import { all, first, run } from "../lib/db";
import { escapeHtml, nowIso, truncate } from "../lib/util";
import { notify, type Keyboard } from "../telegram/api";
import { awaitReason } from "./feedback";
import { addApplicationEvent, decide, fillSlots } from "./recommend";

interface PendingRec { id: string; title: string | null; company: string; created_at: string; checkin_count: number }
interface IntentApp { id: string; title: string | null; company: string; created_at: string }

/** Sends the check-in. Returns how many items it asked about (0 = nothing to ask). */
export async function sendCheckin(env: Env): Promise<number> {
  const recs = await all<PendingRec>(env.DB, `
    SELECT r.id, j.title, c.name AS company, r.created_at, r.checkin_count FROM recommendations r
    JOIN companies c ON c.id = r.company_id LEFT JOIN jobs j ON j.id = r.job_id
    WHERE r.status = 'pending' AND r.created_at < datetime('now', '-12 hours') ORDER BY r.created_at`);
  const intents = await all<IntentApp>(env.DB, `
    SELECT a.id, j.title, c.name AS company, a.created_at FROM applications a
    JOIN companies c ON c.id = a.company_id LEFT JOIN jobs j ON j.id = a.job_id
    WHERE a.status = 'intent' AND a.created_at < datetime('now', '-20 hours') ORDER BY a.created_at LIMIT 6`);
  if (!recs.length && !intents.length) return 0;

  await notify(env, `📝 <b>Check-in before today's suggestions</b>\nTap one button per item. New suggestions fill the slots you free up.`);
  for (const r of recs) {
    const age = Math.round((Date.now() - Date.parse(r.created_at)) / 86_400_000);
    await notify(env,
      `🎯 <b>${escapeHtml(r.title ?? "Direct outreach")}</b> — ${escapeHtml(r.company)}\nSuggested ${age}d ago${r.checkin_count ? ` · kept ${r.checkin_count}×` : ""}. Did you apply?`,
      [[{ text: "✅ Applied", callback_data: `ck:a:${r.id}` }, { text: "⏳ Keep", callback_data: `ck:k:${r.id}` }, { text: "❌ Not applying", callback_data: `ck:n:${r.id}` }]]);
    await run(env.DB, "UPDATE recommendations SET last_checkin_at = ? WHERE id = ?", nowIso(), r.id);
  }
  for (const a of intents) {
    await notify(env,
      `📨 You said you'd apply: <b>${escapeHtml(truncate(a.title ?? "outreach", 60))}</b> — ${escapeHtml(a.company)} (${a.created_at.slice(0, 10)}). Submitted?`,
      [[{ text: "✅ Submitted", callback_data: `ia:s:${a.id}` }, { text: "⏳ Still on it", callback_data: `ia:k:${a.id}` }, { text: "❌ Dropped", callback_data: `ia:d:${a.id}` }]]);
  }
  return recs.length + intents.length;
}

/** Handle a check-in button. Returns the label to show in place of the buttons, and an optional follow-up keyboard. */
export async function handleCheckin(env: Env, kind: "ck" | "ia", action: string, id: string): Promise<{ label: string; keyboard?: Keyboard; refill: boolean }> {
  if (kind === "ck") {
    if (action === "a") {
      const res = await decide(env, id, "applied", undefined, { submitted: true });
      return { label: "already" in res ? `Already ${res.already}` : "✅ Applied — logged", refill: true };
    }
    if (action === "k") {
      await run(env.DB, "UPDATE recommendations SET checkin_count = checkin_count + 1 WHERE id = ?", id);
      return { label: "⏳ Kept — still in your slots", refill: false };
    }
    // "Not applying" → reuse the recommendation ignore flow (reason buttons)
    const { IGNORE_REASONS } = await import("./feedback");
    const res = await decide(env, id, "ignored");
    if ("already" in res) return { label: `Already ${res.already}`, refill: false };
    return {
      label: "❌ Not applying — why?",
      keyboard: Object.entries(IGNORE_REASONS).map(([code, text]) => [{ text, callback_data: `why:${id}:${code}` }]),
      refill: true,
    };
  }
  // ia = an application in 'intent'
  const app = await first<{ status: string; channel: string | null }>(env.DB, "SELECT status, channel FROM applications WHERE id = ?", id);
  if (!app) return { label: "Not found", refill: false };
  if (app.status !== "intent") return { label: `Already ${app.status}`, refill: false };
  if (action === "s") {
    await addApplicationEvent(env, id, app.channel === "email-outreach" ? "outreach_sent" : "applied", "confirmed at check-in", "telegram");
    return { label: "✅ Submitted — logged", refill: false };
  }
  if (action === "k") return { label: "⏳ OK — I'll ask again tomorrow", refill: false };
  await addApplicationEvent(env, id, "withdrawn", "dropped at check-in", "telegram");
  await awaitReason(env, "app", id);
  return {
    label: "❌ Dropped — why? (optional: type a reason now)",
    refill: false,
  };
}

/** After a decision: pull replacements (respects the 2-new-per-day cap). */
export async function refill(env: Env) {
  return fillSlots(env);
}
