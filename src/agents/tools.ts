// Tools the agents can use. A "tool" is just a function with a clear contract;
// the agent (LLM) decides WHICH tool to call and with WHAT arguments.
import type { Env } from "../env";
import { run } from "../lib/db";
import { fetchWithTimeout, htmlToText, localDay, nowIso, truncate } from "../lib/util";

export interface SearchResult { title: string; url: string; content: string }

/** Web search. Prefers Tavily (built for agents, free tier); falls back to Gemini's Google Search grounding. */
export async function webSearch(env: Env, query: string, maxResults = 5): Promise<SearchResult[]> {
  if (env.TAVILY_API_KEY) {
    const res = await fetchWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic" }),
    });
    if (res.ok) {
      const data = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
      return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, content: truncate(r.content, 800) }));
    }
  }
  if (env.GEMINI_API_KEY) return geminiGroundedSearch(env, query);
  return [];
}

async function geminiGroundedSearch(env: Env, query: string): Promise<SearchResult[]> {
  const t0 = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_LITE_MODEL || env.GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `Search the web and report concise factual findings for: ${query}` }] }],
      tools: [{ google_search: {} }],
    }),
  });
  await run(env.DB,
    `INSERT INTO llm_calls(day, provider, model, purpose, ok, input_chars, output_chars, ms, at) VALUES (?, 'gemini', ?, 'web_search', ?, ?, 0, ?, ?)`,
    localDay(env.TIMEZONE), env.GEMINI_LITE_MODEL || env.GEMINI_MODEL, res.ok ? 1 : 0, query.length, Date.now() - t0, nowIso());
  if (!res.ok) return [];
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; groundingMetadata?: { groundingChunks?: { web?: { uri: string; title: string } }[] } }[];
  };
  const cand = data.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
  if (!chunks.length) return text ? [{ title: "search summary", url: "", content: truncate(text, 1500) }] : [];
  return [
    { title: "search summary", url: "", content: truncate(text, 1500) },
    ...chunks.filter((c) => c.web).map((c) => ({ title: c.web!.title, url: c.web!.uri, content: "" })),
  ];
}

/** Fetch a page and return readable text. Returns null instead of throwing — agents handle missing pages. */
export async function fetchPage(url: string, maxChars = 5000): Promise<{ url: string; title: string; text: string } | null> {
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "text/html" } }, 12000);
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const html = await res.text();
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? url;
    return { url: res.url || url, title, text: truncate(htmlToText(html), maxChars) };
  } catch {
    return null;
  }
}

/** Find same-site links on a homepage that look like about/team/careers/blog pages. */
export async function interestingLinks(homepage: string): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(homepage, {}, 12000);
    if (!res.ok) return [];
    const html = await res.text();
    const base = new URL(res.url || homepage);
    const links = new Set<string>();
    for (const [, href] of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
      try {
        const u = new URL(href!, base);
        if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
        if (/\/(about|team|company|careers|jobs|mission|blog|news|customers|product|pricing)(\/|$)/i.test(u.pathname)) {
          links.add(u.origin + u.pathname);
        }
      } catch { /* bad href */ }
    }
    return [...links].slice(0, 8);
  } catch {
    return [];
  }
}
