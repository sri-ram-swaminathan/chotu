// Small, pure helpers used everywhere. "Pure" = no I/O, so they're trivial to test.

export const uid = (): string => crypto.randomUUID();
export const nowIso = (): string => new Date().toISOString();

/** YYYY-MM-DD for "today" in the given IANA timezone (e.g. Europe/Amsterdam). */
export function localDay(tz: string, date: Date = new Date()): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function addDays(day: string, n: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const LEGAL_SUFFIXES =
  /\b(b\.?v\.?|n\.?v\.?|gmbh|ag|ltd|limited|inc|incorporated|llc|plc|s\.?a\.?|sas|bv|holding|holdings|group|technologies|technology|labs?|the)\b/g;

/** "Foo Technologies B.V." → "foo". Used to match the same company across sources. */
export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/&/g, " and ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** "Senior ML Engineer (m/f/d)" → "senior ml engineer" */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\((m|f|w|d|x|all genders?)[\/|,\s\w]*\)/g, " ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function dedupeKey(company: string, title: string, location?: string | null): string {
  const city = (location ?? "").toLowerCase().split(/[,/|-]/)[0]?.replace(/[^a-z]/g, "") ?? "";
  return `${normalizeCompany(company)}|${normalizeTitle(title)}|${city}`;
}

/** Very small HTML → text converter. Good enough for job descriptions and web pages. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)));
}

export function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/** Escape text for Telegram's HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** LLM text → Telegram HTML: escape everything, then allow **bold**. */
export function toTelegramHtml(s: string): string {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

/** Parse JSON that an LLM produced — tolerates ```json fences and leading prose. */
export function parseLooseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[\[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("LLM did not return JSON: " + truncate(text, 200));
  }
}

/** fetch() with a timeout and a polite, generic user agent. */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", "Mozilla/5.0 (compatible; ChotuBot/0.1; personal job search assistant)");
    return await fetch(url, { ...init, headers, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
