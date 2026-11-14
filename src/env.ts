// Every binding and secret the Worker can see. Cloudflare injects this object into each handler.
// Bindings (DB, AI, ASSETS) come from wrangler.jsonc; secrets come from `wrangler secret put`.
export interface Env {
  DB: D1Database;
  AI?: Ai;                            // Workers AI — absent in `npm run dev:offline`
  ASSETS: Fetcher;

  // vars (wrangler.jsonc)
  GEMINI_MODEL: string;               // quality model (small free daily quota) — chat, research, writing
  GEMINI_LITE_MODEL?: string;         // high-quota model — scoring, extraction, deadline hunting
  WORKERS_AI_TEXT_MODEL: string;
  TIMEZONE: string;
  RECOMMENDATION_SLOTS: string;
  LLM_DAILY_CALL_BUDGET: string;
  TICK_BATCH_SIZE: string;
  PUBLIC_URL: string;               // e.g. https://chotu.<you>.workers.dev — used in links

  // secrets
  API_TOKEN: string;
  GEMINI_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;          // main assistant bot
  TELEGRAM_ALERT_BOT_TOKEN?: string;    // optional second bot for instant job alerts
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  FALLBACK_LLM_BASE_URL?: string;
  FALLBACK_LLM_API_KEY?: string;
  FALLBACK_LLM_MODEL?: string;
  GROQ_API_KEY?: string;                // free: console.groq.com — 3 models × 200K tokens/day
  OPENROUTER_API_KEY?: string;          // free: openrouter.ai — ":free" models, 50 requests/day shared
  OPENROUTER_MODEL?: string;            // default google/gemma-4-31b-it:free
  OPENROUTER_DAILY_REQUESTS?: string;   // 50, or 1000 once the account has bought $10 of credits
  ANTHROPIC_DAILY_CALLS?: string;       // hard cap on paid Claude calls per day (default 20)
  TAVILY_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;           // optional paid backup LLM (console.anthropic.com)
  ANTHROPIC_MODEL?: string;             // default claude-opus-5-5
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
}
