// ─────────────────────────────────────────────────────────────────────────────
// Quota bookkeeping for the LLM pool. Pure functions only (no runtime imports), so the
// unit tests can import this file directly.
//
// Idea: every free provider publishes limits — requests/minute (RPM), requests/day (RPD),
// tokens/minute (TPM), tokens/day (TPD). Instead of firing requests until one returns 429,
// the router checks our own ledger (the llm_calls table) and SKIPS a provider that would go
// over. That keeps us from burning retries, and spreads the day's work across every provider.
//
// Windows are rolling (last 60 s / last 24 h), not calendar days: providers reset at different
// times (Gemini at midnight Pacific, Groq on a rolling window), and a rolling window is
// conservative for all of them.
// ─────────────────────────────────────────────────────────────────────────────

export interface Quota {
  rpm?: number;   // requests per minute
  rpd?: number;   // requests per day
  tpm?: number;   // tokens (input + output) per minute
  tpd?: number;   // tokens per day
}

export interface Usage {
  reqMin: number; // requests in the last 60 s
  tokMin: number; // tokens in the last 60 s
  reqDay: number; // requests in the last 24 h
  tokDay: number; // tokens in the last 24 h
}

export const NO_USAGE: Usage = { reqMin: 0, tokMin: 0, reqDay: 0, tokDay: 0 };

/** Stay a little under the published limits: our ledger can't see requests made outside Chotu. */
export const SAFETY = 0.9;
const cap = (n: number) => Math.max(1, Math.floor(n * SAFETY));

/** ~4 characters per token for English text — good enough for budgeting. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/**
 * Would this call fit in the provider's quota? Returns null if yes, otherwise a short reason.
 * `est` = estimated tokens for the call (prompt + expected output).
 * `daily` in the result = the reason won't go away within a minute (skip for the rest of the window).
 */
export function quotaBlock(q: Quota | undefined, u: Usage, est: number): { reason: string; daily: boolean } | null {
  if (!q) return null;
  if (q.tpm && est > cap(q.tpm)) return { reason: `prompt (~${est} tok) exceeds ${q.tpm} tokens/min`, daily: false };
  if (q.rpd && u.reqDay >= cap(q.rpd)) return { reason: `daily requests used (${u.reqDay}/${q.rpd})`, daily: true };
  if (q.tpd && u.tokDay + est > cap(q.tpd)) return { reason: `daily tokens used (${u.tokDay}/${q.tpd})`, daily: true };
  if (q.rpm && u.reqMin >= cap(q.rpm)) return { reason: `minute requests used (${u.reqMin}/${q.rpm})`, daily: false };
  if (q.tpm && u.tokMin + est > cap(q.tpm)) return { reason: `minute tokens used (${u.tokMin}/${q.tpm})`, daily: false };
  return null;
}

/** Is a 429/413 body about a DAILY limit (→ skip until tomorrow) rather than a per-minute one? */
export const isDailyLimitMessage = (s: string) =>
  /per[ -_]?day|daily|\bRPD\b|\bTPD\b|free-models-per-day/i.test(s);

/** Reasoning models sometimes put their chain of thought in <think> tags inside the answer. */
export const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
