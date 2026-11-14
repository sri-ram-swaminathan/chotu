// ─────────────────────────────────────────────────────────────────────────────
// The LLM layer. The rest of the codebase never talks to Gemini/Groq/etc directly —
// it calls `llm.json(...)` or `llm.text(...)` and this file decides WHO answers.
//
// Why: free tiers rate-limit you, and no single free tier covers a day of Chotu's work
// (~200 calls, ~600K tokens). So we pool several free providers. Each one carries its
// published quota (see pool.ts); before every call the router checks our own usage ledger
// and skips providers that are full, so the work flows down the chain automatically.
//
// Provider/model lineup lives in the POOL section of the LLM constructor below — if a
// provider retires a model, that's the one place to change.
// ─────────────────────────────────────────────────────────────────────────────
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Env } from "../env";
import { all, kvGet, kvSet, run } from "../lib/db";
import { errMsg, localDay, nowIso, parseLooseJson } from "../lib/util";
import { estimateTokens, isDailyLimitMessage, NO_USAGE, quotaBlock, stripThinking, type Quota, type Usage } from "./pool";

export type Tier = "reasoning" | "bulk" | "cheap";

export interface LLMRequest {
  purpose: string;              // logged — lets you see what the budget is spent on
  system?: string;
  prompt: string;
  json?: boolean;               // ask the provider for JSON output mode
  temperature?: number;
  maxTokens?: number;
  /**
   * "reasoning" = quality matters, low volume (chat, research synthesis, outreach, CV tailoring).
   * "bulk"      = high volume, structured (scoring, extraction, deadline hunting): free high-quota models first.
   * "cheap"     = trivial classification.
   */
  tier?: Tier;
}

export interface LLMResult { text: string; tokens?: number }

export interface LLMProvider {
  name: string;
  model: string;
  /** Published free-tier limits. Omitted = unknown; we rely on the 429 circuit breaker instead. */
  quota?: Quota;
  /** "provider" = the quota is shared by all models of this provider (OpenRouter's :free pool). */
  quotaScope?: "model" | "provider";
  complete(req: LLMRequest): Promise<LLMResult>;
}

export class RateLimitError extends Error {
  /** true = the provider's DAILY quota is used up: skip it until tomorrow instead of retrying every tick. */
  constructor(message: string, public daily = false) { super(message); }
}

// A provider that hangs must not block the chain: give up and fall through to the next one.
const PROVIDER_TIMEOUT_MS = 45_000;

// ── Google Gemini (free tier via AI Studio key) ──────────────────────────────
class GeminiProvider implements LLMProvider {
  constructor(private apiKey: string, public model: string, public name = "gemini", public quota?: Quota) {}

  async complete(req: LLMRequest): Promise<LLMResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const body = {
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      generationConfig: {
        temperature: req.temperature ?? 0.3,
        // Gemini 3.x "thinks" before answering, and thinking tokens count against maxOutputTokens: with the
        // default level a 4k budget can be spent entirely on thinking, truncating the JSON. Low thinking is
        // ~3x faster and plenty for scoring/extraction; the generous token cap is a safety margin.
        maxOutputTokens: Math.max(req.maxTokens ?? 4096, 8192),
        thinkingConfig: { thinkingLevel: "low" },
        ...(req.json ? { responseMimeType: "application/json" } : {}),
      },
    };
    const send = () => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    let res = await send();
    // 503 = "high demand", usually gone within seconds: one quick retry before falling through the chain.
    if (res.status === 503) { await new Promise((r) => setTimeout(r, 1500)); res = await send(); }
    if (res.status === 429) {
      const body = await res.text();
      // Free tier: "Generate content requests per day limit exceeded" (quotaId ...PerDay...) → done for today.
      const daily = /PerDay|per day/i.test(body);
      throw new RateLimitError(`${this.model} 429${daily ? " (daily quota)" : ""}`, daily);
    }
    if (res.status === 503) throw new RateLimitError(`${this.model} 503`);
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { totalTokenCount?: number };
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text) throw new Error("gemini returned empty response");
    return { text, tokens: data.usageMetadata?.totalTokenCount };
  }
}

// ── Any OpenAI-compatible API (Groq, OpenRouter, a custom fallback) ──────────
interface CompatOptions {
  quota?: Quota;
  quotaScope?: "model" | "provider";
  /** false = the provider/model rejects response_format; we ask for JSON in the prompt instead. */
  jsonMode?: boolean;
  /** Provider-specific request fields, e.g. Groq's reasoning_effort for gpt-oss. */
  extraBody?: Record<string, unknown>;
  /** Extra headers, e.g. OpenRouter's X-Title. */
  headers?: Record<string, string>;
}

class OpenAICompatProvider implements LLMProvider {
  quota?: Quota;
  quotaScope?: "model" | "provider";
  constructor(public name: string, private baseUrl: string, private apiKey: string | undefined, public model: string,
              private opts: CompatOptions = {}) {
    this.quota = opts.quota;
    this.quotaScope = opts.quotaScope;
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    const jsonMode = req.json && this.opts.jsonMode !== false;
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.json && !jsonMode ? `${req.prompt}\n\nRespond with JSON only.` : req.prompt },
    ];
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...this.opts.headers,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: req.temperature ?? 0.3,
        max_tokens: req.maxTokens ?? 4096,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...this.opts.extraBody,
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    // 429 = rate limited. 413 = Groq's "request too large for your tokens-per-minute limit". Both → next provider.
    if (res.status === 429 || res.status === 413) {
      const body = await res.text();
      // Groq: x-ratelimit-remaining-requests counts requests per DAY; 0 means we're done for today.
      const daily = res.headers.get("x-ratelimit-remaining-requests") === "0" || isDailyLimitMessage(body);
      throw new RateLimitError(`${this.name}/${this.model} ${res.status}${daily ? " (daily quota)" : ""}: ${body.slice(0, 120)}`, daily);
    }
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const text = stripThinking(data.choices?.[0]?.message?.content ?? "");
    if (!text) throw new Error(`${this.name} returned empty response`);
    return { text, tokens: data.usage?.total_tokens };
  }
}

// ── Anthropic Claude (paid API key — the capped last-resort backup) ──────────
// Uses Anthropic's official SDK. Pay-as-you-go: it only costs money when every free provider fails,
// and its quota below caps how many calls per day it can take.
// Thinking is always on for Claude Opus 5.5; `effort` controls depth and cost (low for cheap tasks).
// `fallbacks: "default"` lets the API retry on another Claude model if a safety classifier declines.
class AnthropicProvider implements LLMProvider {
  name = "anthropic";
  private client: Anthropic;
  constructor(apiKey: string, public model: string, public quota?: Quota) {
    this.client = new Anthropic({ apiKey, timeout: PROVIDER_TIMEOUT_MS, maxRetries: 1 });
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    try {
      const res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: Math.max(req.maxTokens ?? 4096, 2048), // room for thinking + answer
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: "user", content: req.json ? `${req.prompt}

Respond with JSON only.` : req.prompt }],
        output_config: { effort: req.tier === "cheap" ? "low" : "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      if (res.stop_reason === "refusal") throw new Error(`anthropic refused (${res.stop_details?.category ?? "unknown"})`);
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      if (!text) throw new Error(`anthropic returned no text (stop_reason ${res.stop_reason})`);
      return { text, tokens: res.usage.input_tokens + res.usage.output_tokens };
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new RateLimitError("anthropic 429");
      throw e;
    }
  }
}

// ── Cloudflare Workers AI (runs inside Cloudflare, no key needed) ────────────
// Free allowance is 10,000 "neurons"/day across all models (~70 of our calls on llama-3.3-70b).
// Neurons aren't tokens, so no quota here — the 4006 error trips the daily circuit breaker.
class WorkersAIProvider implements LLMProvider {
  name = "workers-ai";
  constructor(private ai: Ai, public model: string) {}

  async complete(req: LLMRequest): Promise<LLMResult> {
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.json ? req.prompt + "\n\nRespond with JSON only." : req.prompt },
    ];
    // The Ai binding is typed per-model; we keep the model configurable, so we loosen the type here.
    type Out = { response?: unknown; choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } };
    const runner = this.ai as unknown as { run(model: string, input: unknown): Promise<Out> };
    let out: Out;
    try {
      out = await runner.run(this.model, { messages, max_tokens: req.maxTokens ?? 2048, temperature: req.temperature ?? 0.3 });
    } catch (e) {
      // "4006: you have used up your daily free allocation of 10,000 neurons" → skip until tomorrow.
      if (/4006|daily free allocation/i.test(String(e))) throw new RateLimitError(`workers-ai daily allocation used up`, true);
      throw e;
    }
    // Older models return { response }, newer ones an OpenAI-style { choices }. JSON mode may return an object.
    const raw = out.response ?? out.choices?.[0]?.message?.content ?? "";
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (!text) throw new Error("workers-ai returned empty response");
    return { text, tokens: out.usage?.total_tokens };
  }
}

export interface QuotaRow { provider: string; model: string; quota?: Quota; usage: Usage; tiers: Tier[] }

// ── The router ───────────────────────────────────────────────────────────────
export class LLM {
  private chains: Record<Tier, LLMProvider[]>;
  private all: LLMProvider[];

  constructor(private env: Env) {
    // ═══ POOL ═══ Free-tier limits as published (Groq: console.groq.com/docs/rate-limits, checked 2026-11-13;
    // OpenRouter: openrouter.ai/docs/api-reference/limits). Tokens, not requests, are the real limit:
    // a score_job call is ~4K tokens, so Groq's 200K tokens/day ≈ 50 calls per model.
    const GROQ = "https://api.groq.com/openai/v1";
    const groq = (model: string, extraBody?: Record<string, unknown>) => env.GROQ_API_KEY
      ? new OpenAICompatProvider("groq", GROQ, env.GROQ_API_KEY, model,
          { quota: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000 }, extraBody })
      : null;
    // gpt-oss models reason before answering; "low" keeps that short so the answer fits the token budget.
    const groq120 = groq("openai/gpt-oss-120b", { reasoning_effort: "low" });
    const groq20 = groq("openai/gpt-oss-20b", { reasoning_effort: "low" });
    const groqQwen = groq("qwen/qwen3.8-27b");

    // OpenRouter: all ":free" models share ONE account-wide quota — 20/min and 50/day
    // (1,000/day once the account has ever bought $10 of credits).
    const openrouter = env.OPENROUTER_API_KEY
      ? new OpenAICompatProvider("openrouter", "https://openrouter.ai/api/v1", env.OPENROUTER_API_KEY,
          env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free", {
            quota: { rpm: 20, rpd: Number(env.OPENROUTER_DAILY_REQUESTS || 50) },
            quotaScope: "provider",
            jsonMode: false, // many :free models reject response_format
            headers: { "X-Title": "Chotu" },
          })
      : null;

    // Gemini: the better model has a tiny daily quota (20 requests for 3.5 Flash); lite carries volume.
    // Lite's limits vary per project and aren't published, so it relies on the 429 circuit breaker.
    const gemini = env.GEMINI_API_KEY ? new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL, "gemini", { rpd: 20 }) : null;
    const geminiLite = env.GEMINI_API_KEY && env.GEMINI_LITE_MODEL
      ? new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_LITE_MODEL, "gemini-lite") : null;

    // Any other OpenAI-compatible endpoint you want to bolt on (set FALLBACK_LLM_* secrets).
    const fallback = env.FALLBACK_LLM_BASE_URL && env.FALLBACK_LLM_MODEL
      ? new OpenAICompatProvider(new URL(env.FALLBACK_LLM_BASE_URL).hostname, env.FALLBACK_LLM_BASE_URL,
          env.FALLBACK_LLM_API_KEY, env.FALLBACK_LLM_MODEL)
      : null;
    const workers = env.AI ? new WorkersAIProvider(env.AI, env.WORKERS_AI_TEXT_MODEL) : null;
    // Paid: hard daily cap so a bad day can't turn into a bill.
    const claude = env.ANTHROPIC_API_KEY
      ? new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || "claude-opus-5-5",
          { rpd: Number(env.ANTHROPIC_DAILY_CALLS || 20) })
      : null;

    // Order = who answers first. Quality first for reasoning; biggest free quotas first for bulk.
    // When a provider is full (quota) or failing (429/503), the call moves to the next one.
    const present = (xs: (LLMProvider | null)[]) => xs.filter((x): x is LLMProvider => x !== null);
    this.chains = {
      reasoning: present([gemini, groq120, groqQwen, geminiLite, openrouter, groq20, fallback, workers, claude]),
      bulk: present([geminiLite, groq20, groqQwen, groq120, openrouter, workers, fallback, gemini, claude]),
      cheap: present([groq20, geminiLite, workers, groqQwen, openrouter, fallback, claude]),
    };
    this.all = [...new Set(Object.values(this.chains).flat())];
  }

  /** How many SUCCESSFUL calls we've made today (failed calls cost nothing, so they don't eat the budget). */
  async callsToday(): Promise<number> {
    const rows = await all<{ n: number }>(this.env.DB, "SELECT COUNT(*) AS n FROM llm_calls WHERE day = ? AND ok = 1", localDay(this.env.TIMEZONE));
    return rows[0]?.n ?? 0;
  }

  async budgetLeft(): Promise<number> {
    return Number(this.env.LLM_DAILY_CALL_BUDGET) - (await this.callsToday());
  }

  /** Requests/tokens per provider+model over the last minute and the last 24 h, from the llm_calls ledger. */
  private async usage(): Promise<Map<string, Usage>> {
    const now = Date.now();
    const minAgo = new Date(now - 60_000).toISOString();
    const rows = await all<{ provider: string; model: string; req_day: number; tok_day: number; req_min: number; tok_min: number }>(
      this.env.DB,
      `SELECT provider, model, COUNT(*) AS req_day, COALESCE(SUM(tokens), 0) AS tok_day,
              SUM(at >= ?) AS req_min, COALESCE(SUM(CASE WHEN at >= ? THEN tokens END), 0) AS tok_min
       FROM llm_calls WHERE at >= ? GROUP BY provider, model`,
      minAgo, minAgo, new Date(now - 86_400_000).toISOString(),
    );
    const map = new Map<string, Usage>();
    const add = (key: string, r: (typeof rows)[number]) => {
      const u = map.get(key) ?? { ...NO_USAGE };
      map.set(key, { reqMin: u.reqMin + r.req_min, tokMin: u.tokMin + r.tok_min, reqDay: u.reqDay + r.req_day, tokDay: u.tokDay + r.tok_day });
    };
    for (const r of rows) { add(`${r.provider}|${r.model}`, r); add(`${r.provider}|*`, r); }
    return map;
  }

  private usageFor(p: LLMProvider, map: Map<string, Usage>): Usage {
    return map.get(`${p.name}|${p.quotaScope === "provider" ? "*" : p.model}`) ?? NO_USAGE;
  }

  /** For /quota and the dashboard: every provider, its limits and what we've used. */
  async quotaReport(): Promise<QuotaRow[]> {
    const map = await this.usage();
    return this.all.map((p) => ({
      provider: p.name, model: p.model, quota: p.quota, usage: this.usageFor(p, map),
      tiers: (Object.keys(this.chains) as Tier[]).filter((t) => this.chains[t].includes(p)),
    }));
  }

  /**
   * Health check: one tiny JSON request to EVERY provider, bypassing the chain. Use it after adding a key
   * or when a provider may have retired a model (POST /api/llm/probe). Costs one request per provider.
   */
  async probe(): Promise<{ provider: string; model: string; ok: boolean; ms: number; detail: string }[]> {
    const req: LLMRequest = { purpose: "probe", prompt: 'Return {"ok": true} as JSON.', json: true, maxTokens: 300, tier: "cheap" };
    return Promise.all(this.all.map(async (p) => {
      const t0 = Date.now();
      try {
        const out = await p.complete(req);
        await this.log(p, req, true, out.text.length, Date.now() - t0, undefined, out.tokens ?? 50);
        return { provider: p.name, model: p.model, ok: true, ms: Date.now() - t0, detail: out.text.slice(0, 80) };
      } catch (e) {
        await this.log(p, req, false, 0, Date.now() - t0, errMsg(e), 0);
        return { provider: p.name, model: p.model, ok: false, ms: Date.now() - t0, detail: errMsg(e).slice(0, 300) };
      }
    }));
  }

  async text(req: LLMRequest): Promise<{ text: string; model: string }> {
    if ((await this.budgetLeft()) <= 0) throw new Error("daily LLM budget exhausted");
    const chain = this.chains[req.tier ?? "reasoning"];
    const day = localDay(this.env.TIMEZONE);
    // Prompt tokens + a typical answer (most of ours are < 1K tokens; maxTokens is a ceiling, not a forecast).
    const est = estimateTokens((req.system?.length ?? 0) + req.prompt.length) + Math.min(req.maxTokens ?? 1000, 1000);
    const usage = await this.usage();
    const errors: string[] = [];
    for (const p of chain) {
      const exhaustedKey = `llm_exhausted:${p.model}:${day}`;
      if (await kvGet(this.env.DB, exhaustedKey)) { errors.push(`${p.name}: daily quota used up`); continue; }
      const blocked = quotaBlock(p.quota, this.usageFor(p, usage), est);
      if (blocked) { errors.push(`${p.name}/${p.model}: ${blocked.reason}`); continue; } // skipped calls aren't logged
      const t0 = Date.now();
      try {
        const out = await p.complete(req);
        const tokens = out.tokens ?? est;
        await this.log(p, req, true, out.text.length, Date.now() - t0, undefined, tokens);
        return { text: out.text, model: `${p.name}/${p.model}` };
      } catch (e) {
        await this.log(p, req, false, 0, Date.now() - t0, errMsg(e), 0);
        errors.push(`${p.name}: ${errMsg(e)}`);
        if (e instanceof RateLimitError && e.daily) await kvSet(this.env.DB, exhaustedKey, nowIso()); // circuit breaker
        // fall through to the next provider
      }
    }
    throw new Error("all LLM providers failed — " + errors.join(" | "));
  }

  /**
   * Ask for JSON and validate it against a zod schema. If validation fails we retry once,
   * telling the model exactly what was wrong. LLM output is untrusted input: always validate.
   */
  async json<S extends z.ZodTypeAny>(req: LLMRequest, schema: S): Promise<{ data: z.infer<S>; model: string }> {
    let prompt = req.prompt;
    let last = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text, model } = await this.text({ ...req, prompt, json: true });
      try {
        const parsed = schema.safeParse(parseLooseJson(text));
        if (parsed.success) return { data: parsed.data, model };
        last = `${model}: ${parsed.error.message.slice(0, 300)}`;
        prompt = `${req.prompt}\n\nYour previous answer failed validation: ${parsed.error.message.slice(0, 500)}\nReturn corrected JSON only.`;
      } catch (e) {
        last = `${model}: ${errMsg(e)}`;
        prompt = `${req.prompt}\n\nYour previous answer was not valid JSON (${errMsg(e)}). Return JSON only.`;
      }
    }
    // Keep the reason: it ends up in jobs.filter_reason / tasks.last_error where you can see it.
    throw new Error(`LLM JSON validation failed for ${req.purpose} — ${last}`);
  }

  private async log(p: LLMProvider, req: LLMRequest, ok: boolean, outChars: number, ms: number, error: string | undefined, tokens: number) {
    await run(
      this.env.DB,
      `INSERT INTO llm_calls(day, provider, model, purpose, ok, input_chars, output_chars, ms, error, at, tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      localDay(this.env.TIMEZONE), p.name, p.model, req.purpose, ok ? 1 : 0,
      (req.system?.length ?? 0) + req.prompt.length, outChars, ms, error ?? null, nowIso(), tokens,
    );
  }
}
