// ─────────────────────────────────────────────────────────────────────────────
// Job BOARDS: site-wide feeds that list many companies at once (vs. ats.ts, which reads ONE company's board).
// Picked from career-ops' supported boards (github.com/career-ops-hq/career-ops, docs/SUPPORTED_JOB_BOARDS.md)
// for being public, keyless, and relevant to an AI/ML graduate who wants the Netherlands/EU:
//
//   arbeitnow    EU/DACH board, JSON API                 arbeitnow.com/api/job-board-api
//   landingjobs  European tech board, JSON API           landing.jobs/api/v1/jobs
//   speedrun     a16z speedrun portfolio startups        speedrun-talent-network.com/api/v1/jobs
//   jobicy       remote jobs, filterable by country      jobicy.com/api/v2/remote-jobs?geo=…
//   startupjobs  startup.jobs RSS                        startup.jobs/feeds/jobs
//   hackernews   latest "Ask HN: Who is hiring?" thread  hn.algolia.com (one comment = one company)
//
// Deterministic: no LLM. Boards return hundreds of mostly irrelevant postings, so the scheduler runs them
// through the free triage filter BEFORE ingesting (see fetch_board in scheduler.ts) — only plausible
// matches get stored.
// ─────────────────────────────────────────────────────────────────────────────
import { decodeEntities, fetchWithTimeout, htmlToText } from "../lib/util.ts";
import type { RawJob } from "./ats";

export const BOARD_PROVIDERS = ["arbeitnow", "landingjobs", "speedrun", "jobicy", "startupjobs", "hackernews"] as const;
export type BoardProvider = (typeof BOARD_PROVIDERS)[number];

export interface BoardConfig {
  provider: BoardProvider;
  name?: string;
  geo?: string;   // jobicy only: country/region slug, e.g. "netherlands", "europe"
  pages?: number; // paginated boards: how many pages of newest postings to read (default 2)
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, 20000);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

const parseArr = <T>(v: unknown): T[] => {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string") { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [];
};

async function arbeitnow(pages: number): Promise<RawJob[]> {
  type R = { data: { slug: string; company_name: string; title: string; description: string; remote: boolean; url: string; location: string; created_at: number }[] };
  const out: RawJob[] = [];
  for (let p = 1; p <= pages; p++) {
    const d = await getJson<R>(`https://www.arbeitnow.com/api/job-board-api?page=${p}`);
    if (!d.data?.length) break;
    out.push(...d.data.map((j) => ({
      company: j.company_name, title: j.title, url: j.url, location: j.location, remote: j.remote,
      description: htmlToText(j.description ?? ""), postedAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
    })));
  }
  return out;
}

async function landingjobs(pages: number): Promise<RawJob[]> {
  type J = { title: string; url: string; remote: boolean; role_description?: string; main_requirements?: string; published_at?: string; expires_at?: string; locations?: unknown; company_name?: string };
  const out: RawJob[] = [];
  for (let p = 0; p < pages; p++) {
    const d = await getJson<J[]>(`https://landing.jobs/api/v1/jobs?limit=50&offset=${p * 50}`);
    if (!d.length) break;
    for (const j of d) {
      const locs = parseArr<{ city?: string; country_code?: string }>(j.locations);
      out.push({
        // The API has no company name field; the URL is landing.jobs/at/<company-slug>/<job-slug>.
        company: j.company_name ?? slugToName(j.url.match(/\/at\/([^/]+)\//)?.[1] ?? "unknown"),
        title: j.title, url: j.url, remote: j.remote,
        location: locs.map((l) => [l.city, countryName(l.country_code)].filter(Boolean).join(", ")).join(" / ") || null,
        description: htmlToText(`${j.role_description ?? ""}\n${j.main_requirements ?? ""}`),
        postedAt: j.published_at ?? null, deadline: j.expires_at ?? null,
      });
    }
  }
  return out;
}

async function speedrun(pages: number): Promise<RawJob[]> {
  type R = { jobs: { title: string; company: string; url: string; location?: string; remote?: boolean; workplace_type?: string; published_at?: string; stealth?: boolean }[] };
  const out: RawJob[] = [];
  for (let p = 1; p <= pages; p++) {
    const d = await getJson<R>(`https://speedrun-talent-network.com/api/v1/jobs?page=${p}`);
    if (!d.jobs?.length) break;
    out.push(...d.jobs.filter((j) => !j.stealth).map((j) => ({
      company: j.company, title: j.title.trim(), url: j.url, location: j.location ?? null,
      remote: !!j.remote || j.workplace_type === "Remote", description: null, postedAt: j.published_at ?? null,
    })));
  }
  return out;
}

async function jobicy(geo = "europe"): Promise<RawJob[]> {
  type R = { jobs?: { url: string; jobTitle: string; companyName: string; jobGeo?: string; jobDescription?: string; pubDate?: string }[] };
  const d = await getJson<R>(`https://jobicy.com/api/v2/remote-jobs?count=50&geo=${encodeURIComponent(geo)}`);
  return (d.jobs ?? []).map((j) => ({
    company: decodeEntities(j.companyName), title: decodeEntities(j.jobTitle), url: j.url,
    // Jobicy is remote-only; jobGeo is where you may work from ("Netherlands", "Europe", "EMEA").
    location: `Remote, ${j.jobGeo ?? geo}`, remote: true,
    description: htmlToText(j.jobDescription ?? ""), postedAt: j.pubDate ?? null,
  }));
}

/** startup.jobs RSS: "<Role> at <Company>", the description's last line is the location. */
export function parseStartupJobsRss(xml: string): RawJob[] {
  const tag = (block: string, name: string) =>
    decodeEntities(block.match(new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`))?.[1]?.trim() ?? "");
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap(([, b]) => {
    const title = tag(b!, "title");
    const m = title.match(/^(.*) at (.+)$/);
    if (!m) return [];
    const desc = decodeEntities(tag(b!, "description"));
    const lines = desc.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const location = lines.length > 1 ? lines[lines.length - 1]!.split(" · ")[0]! : null;
    const pub = tag(b!, "pubDate");
    return [{
      company: m[2]!.trim(), title: m[1]!.trim(), url: tag(b!, "guid") || tag(b!, "link").split("?")[0]!,
      location, remote: /remote/i.test(location ?? ""), description: desc, postedAt: pub ? new Date(pub).toISOString() : null,
    }];
  });
}

async function startupjobs(): Promise<RawJob[]> {
  const res = await fetchWithTimeout("https://startup.jobs/feeds/jobs", {}, 20000);
  if (!res.ok) throw new Error(`startup.jobs → HTTP ${res.status}`);
  return parseStartupJobsRss(await res.text());
}

/**
 * One top-level comment = one company, conventionally "Company | Role | Location | …" on the first line.
 * Exported for tests.
 */
export function parseHnComment(c: { id: number; text?: string | null; created_at?: string }): RawJob | null {
  if (!c.text) return null;
  const firstPara = decodeEntities(c.text.split(/<p>/i)[0]!.replace(/<[^>]+>/g, "")).trim();
  const parts = firstPara.split("|").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2 || parts[0]!.length > 80) return null;
  const roleIdx = parts.findIndex((p, i) => i > 0 && /engineer|scientist|developer|research|ml|ai\b|machine learning|founding|phd|data/i.test(p));
  const where = parts.filter((p, i) => i > 0 && i !== roleIdx && /remote|onsite|hybrid|[A-Z][a-z]+,|\b(EU|UK|US|NL|Europe|Amsterdam|Berlin|London|Paris|Munich|Zurich)\b/.test(p));
  return {
    company: parts[0]!, title: parts[roleIdx > 0 ? roleIdx : 1]!,
    url: `https://news.ycombinator.com/item?id=${c.id}`,
    location: where.join(" | ") || null, remote: where.some((w) => /remote/i.test(w)),
    description: htmlToText(c.text), postedAt: c.created_at ?? null,
  };
}

async function hackernews(): Promise<RawJob[]> {
  type Hits = { hits: { objectID: string; title: string }[] };
  const threads = await getJson<Hits>("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5");
  const thread = threads.hits.find((h) => /who is hiring/i.test(h.title));
  if (!thread) return [];
  type Item = { children?: { id: number; text?: string | null; created_at?: string }[] };
  const item = await getJson<Item>(`https://hn.algolia.com/api/v1/items/${thread.objectID}`);
  return (item.children ?? []).map(parseHnComment).filter((j): j is RawJob => j !== null);
}

export async function fetchBoard(b: BoardConfig): Promise<RawJob[]> {
  const pages = Math.max(1, Math.min(b.pages ?? 2, 5));
  switch (b.provider) {
    case "arbeitnow": return arbeitnow(pages);
    case "landingjobs": return landingjobs(pages);
    case "speedrun": return speedrun(pages);
    case "jobicy": return jobicy(b.geo);
    case "startupjobs": return startupjobs();
    case "hackernews": return hackernews();
  }
}

export const boardKey = (b: BoardConfig) => `${b.provider}${b.geo ? `:${b.geo}` : ""}`;

function slugToName(slug: string) {
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

const COUNTRIES: Record<string, string> = {
  NL: "Netherlands", DE: "Germany", PT: "Portugal", ES: "Spain", FR: "France", BE: "Belgium", GB: "United Kingdom",
  UK: "United Kingdom", IE: "Ireland", CH: "Switzerland", AT: "Austria", PL: "Poland", IT: "Italy", SE: "Sweden",
  DK: "Denmark", FI: "Finland", NO: "Norway", LU: "Luxembourg", CZ: "Czech Republic", RO: "Romania", GR: "Greece",
};
const countryName = (code?: string) => (code ? COUNTRIES[code.toUpperCase()] ?? code : undefined);
