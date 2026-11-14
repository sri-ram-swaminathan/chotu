// Minimal Telegram Bot API client. Docs: https://core.telegram.org/bots/api
//
// Chotu runs TWO bots (both optional-but-recommended):
//   main  — the assistant: daily recommendations, check-ins, chat ("how many applications last week?")
//   alert — the pager: instant pings when a fresh, good posting appears. A separate bot means you can
//           give it a loud notification sound and keep the main chat calm.
// If TELEGRAM_ALERT_BOT_TOKEN isn't set, alerts simply go through the main bot.
import type { Env } from "../env";

export interface InlineButton { text: string; callback_data?: string; url?: string }
export type Keyboard = InlineButton[][];
export type Bot = "main" | "alert";

function token(env: Env, bot: Bot): string | undefined {
  return bot === "alert" ? env.TELEGRAM_ALERT_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN : env.TELEGRAM_BOT_TOKEN;
}

export async function tg<T = unknown>(env: Env, method: string, body: Record<string, unknown>, bot: Bot = "main"): Promise<T | null> {
  const t = token(env, bot);
  if (!t) return null;
  const res = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
  return data.result ?? null;
}

/** Send an HTML-formatted message to you. Long messages are split (Telegram max is 4096 chars). */
export async function notify(
  env: Env, html: string, keyboard?: Keyboard, chatId = env.TELEGRAM_CHAT_ID, bot: Bot = "main",
): Promise<number | null> {
  if (!chatId) return null;
  const chunks = splitMessage(html, 3900);
  let lastId: number | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const msg = await tg<{ message_id: number }>(env, "sendMessage", {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(isLast && keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }, bot);
    lastId = msg?.message_id ?? lastId;
  }
  return lastId;
}

/** Ping through the alert bot (falls back to the main bot). */
export const alertNotify = (env: Env, html: string, keyboard?: Keyboard) => notify(env, html, keyboard, env.TELEGRAM_CHAT_ID, "alert");

/** "Chotu is typing…" — shown while the orchestrator thinks. Best effort. */
export async function typing(env: Env, bot: Bot = "main") {
  if (!env.TELEGRAM_CHAT_ID) return;
  try { await tg(env, "sendChatAction", { chat_id: env.TELEGRAM_CHAT_ID, action: "typing" }, bot); } catch { /* ignore */ }
}

function splitMessage(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}
