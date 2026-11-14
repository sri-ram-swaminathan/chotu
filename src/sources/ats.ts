// Fetchers for company career pages hosted on common Applicant Tracking Systems (ATS).
// These are PUBLIC JSON/XML endpoints the companies' own career pages use — clean data,
// no login, no scraping arms race. This is how you cover hundreds of startups reliably.
//
// To find a company's ATS: open their careers page and look at the job links:
//   boards.greenhouse.io/<slug>  jobs.lever.co/<slug>  jobs.ashbyhq.com/<slug>
//   <slug>.recruitee.com  <slug>.jobs.personio.de  apply.workable.com/<slug>
import { decodeEntities, fetchWithTimeout, htmlToText } from "../lib/util.ts";

export interface RawJob {
  company: string;
  title: string;
  url: string;
  location?: string | null;
  remote?: boolean;
  description?: string | null;
  postedAt?: string | null;
  deadline?: string | null;
  kind?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

const isRemote = (s?: string | null) => !!s && /remote|anywhere|hybrid/i.test(s);

export async function fetchGreenhouse(company: string, slug: string): Promise<RawJob[]> {
  type R = { jobs: { title: string; absolute_url: string; location?: { name?: string }; content?: string; updated_at?: string }[] };
  const data = await getJson<R>(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return data.jobs.map((j) => ({
    company,
    title: j.title,
    url: j.absolute_url,
    location: j.location?.name ?? null,
    remote: isRemote(j.location?.name),
    // Greenhouse double-encodes HTML in `content`
    description: htmlToText(decodeEntities(j.content ?? "")),
    postedAt: j.updated_at ?? null,
  }));
}

export async function fetchLever(company: string, slug: string, eu = false): Promise<RawJob[]> {
  type R = { text: string; hostedUrl: string; categories?: { location?: string; commitment?: string }; descriptionPlain?: string; lists?: { text: string; content: string }[]; createdAt?: number; workplaceType?: string }[];
  const host = eu ? "api.eu.lever.co" : "api.lever.co";
  const data = await getJson<R>(`https://${host}/v0/postings/${slug}?mode=json`);
  return data.map((j) => ({
    company,
    title: j.text,
    url: j.hostedUrl,
    location: j.categories?.location ?? null,
    remote: j.workplaceType === "remote" || isRemote(j.categories?.location),
    description: [j.descriptionPlain ?? "", ...(j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`)].join("\n\n"),
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }));
}

export async function fetchAshby(company: string, slug: string): Promise<RawJob[]> {
  type R = { jobs: { title: string; jobUrl: string; location?: string; isRemote?: boolean; descriptionPlain?: string; publishedAt?: string }[] };
  const data = await getJson<R>(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return data.jobs.map((j) => ({
    company,
    title: j.title,
    url: j.jobUrl,
    location: j.location ?? null,
    remote: !!j.isRemote,
    description: j.descriptionPlain ?? null,
    postedAt: j.publishedAt ?? null,
  }));
}

export async function fetchRecruitee(company: string, slug: string): Promise<RawJob[]> {
  type R = { offers: { title: string; careers_url: string; location?: string; city?: string; remote?: boolean; description?: string; requirements?: string; published_at?: string }[] };
  const data = await getJson<R>(`https://${slug}.recruitee.com/api/offers/`);
  return data.offers.map((j) => ({
    company,
    title: j.title,
    url: j.careers_url,
    location: j.location ?? j.city ?? null,
    remote: !!j.remote,
    description: htmlToText(`${j.description ?? ""}\n${j.requirements ?? ""}`),
    postedAt: j.published_at ?? null,
  }));
}

export async function fetchWorkable(company: string, slug: string): Promise<RawJob[]> {
  type R = { jobs: { title: string; url: string; shortcode: string; city?: string; country?: string; telecommuting?: boolean; description?: string; published_on?: string }[] };
  const data = await getJson<R>(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
  return data.jobs.map((j) => ({
    company,
    title: j.title,
    url: j.url || `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
    location: [j.city, j.country].filter(Boolean).join(", ") || null,
    remote: !!j.telecommuting,
    description: htmlToText(j.description ?? ""),
    postedAt: j.published_on ?? null,
  }));
}

/** Personio exposes an XML feed. Workers have no DOMParser, so we parse the simple structure with regex. */
export async function fetchPersonio(company: string, slug: string): Promise<RawJob[]> {
  let xml = "";
  for (const tld of ["de", "com"]) {
    const res = await fetchWithTimeout(`https://${slug}.jobs.personio.${tld}/xml?language=en`);
    if (res.ok) { xml = await res.text(); break; }
  }
  if (!xml) throw new Error(`personio feed not found for ${slug}`);
  const tag = (block: string, name: string) =>
    block.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`))?.[1]?.trim() ?? "";
  const tld = xml.includes("personio.com") ? "com" : "de";
  return [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)].map(([, block]) => {
    const id = tag(block!, "id");
    const descs = [...block!.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)]
      .map(([, d]) => `${tag(d!, "name")}\n${htmlToText(tag(d!, "value"))}`)
      .join("\n\n");
    return {
      company,
      title: decodeEntities(tag(block!, "name")),
      url: `https://${slug}.jobs.personio.${tld}/job/${id}`,
      location: decodeEntities(tag(block!, "office")) || null,
      description: descs,
      postedAt: tag(block!, "createdAt") || null,
    };
  });
}

// ── Workday (ASML-style big corporations: Philips, ING, Shell…) ───────────────
// slug = "<tenant>.<datacenter>/<site>", e.g. "philips.wd3/jobs-and-careers".
// Big employers have 500-2000 openings, so we only pull the newest matches for a few search terms
// (one request each) instead of the whole board. The list API has no descriptions: those are fetched
// later, only for jobs that survive the free filters (see fetchJobDescription).
export const WORKDAY_DEFAULT_SEARCH = ["machine learning", "computer vision", "deep learning", "data scientist", "AI engineer"];

const workdayParts = (slug: string) => {
  const [host, site] = slug.split("/");
  if (!host || !site) throw new Error(`workday slug must look like "tenant.wd3/site", got "${slug}"`);
  return { base: `https://${host}.myworkdayjobs.com`, tenant: host.split(".")[0]!, site };
};

/** "Posted 3 Days Ago" / "Posted Today" / "Posted 30+ Days Ago" → ISO date. */
export function workdayPostedOn(s: string | undefined, now = Date.now()): string | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes("today")) return new Date(now).toISOString();
  if (t.includes("yesterday")) return new Date(now - 86_400_000).toISOString();
  const n = Number(t.match(/(\d+)\+?\s*day/)?.[1]);
  return Number.isFinite(n) ? new Date(now - n * 86_400_000).toISOString() : null;
}

export async function fetchWorkday(company: string, slug: string, search: string[] = WORKDAY_DEFAULT_SEARCH): Promise<RawJob[]> {
  const { base, tenant, site } = workdayParts(slug);
  type R = { jobPostings?: { title: string; externalPath?: string; locationsText?: string; postedOn?: string }[] };
  const jobs = new Map<string, RawJob>();
  for (const q of search) {
    const res = await fetchWithTimeout(`${base}/wday/cxs/${tenant}/${site}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: q }),
    });
    if (!res.ok) throw new Error(`workday ${slug} → HTTP ${res.status}`);
    for (const j of ((await res.json()) as R).jobPostings ?? []) {
      if (!j.externalPath || jobs.has(j.externalPath)) continue;
      jobs.set(j.externalPath, {
        company, title: j.title, url: `${base}/en-US/${site}${j.externalPath}`,
        location: j.locationsText ?? null, remote: isRemote(j.locationsText), description: null,
        postedAt: workdayPostedOn(j.postedOn),
      });
    }
  }
  return [...jobs.values()];
}

/** Fill in a missing description (Workday list results have none). Returns null if not supported. */
export async function fetchJobDescription(url: string): Promise<string | null> {
  const m = url.match(/^(https:\/\/([\w-]+)\.wd\d+\.myworkdayjobs\.com)\/[\w-]+\/([^/]+)(\/job\/.+)$/);
  if (!m) return null;
  const [, base, tenant, site, path] = m;
  const res = await fetchWithTimeout(`${base}/wday/cxs/${tenant}/${site}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const d = (await res.json()) as { jobPostingInfo?: { jobDescription?: string; location?: string } };
  return d.jobPostingInfo?.jobDescription ? htmlToText(d.jobPostingInfo.jobDescription) : null;
}

/** Recognise an ATS job-board URL → { ats, slug }. Pure, for tests and for /like <careers URL>. */
export function detectAts(url: string): { ats: string; slug: string } | null {
  const rules: [RegExp, string, (m: RegExpMatchArray) => string][] = [
    [/greenhouse\.io\/(?:v1\/boards\/|embed\/job_board\?for=)?([\w-]+)/i, "greenhouse", (m) => m[1]!],
    [/jobs\.eu\.lever\.co\/([\w-]+)/i, "lever-eu", (m) => m[1]!],
    [/jobs\.lever\.co\/([\w-]+)/i, "lever", (m) => m[1]!],
    [/ashbyhq\.com\/(?:posting-api\/job-board\/)?([\w.-]+)/i, "ashby", (m) => m[1]!],
    [/([\w-]+)\.recruitee\.com/i, "recruitee", (m) => m[1]!],
    [/apply\.workable\.com\/(?:api\/v1\/widget\/accounts\/)?([\w-]+)/i, "workable", (m) => m[1]!],
    [/([\w-]+)\.jobs\.personio\.(?:de|com)/i, "personio", (m) => m[1]!],
    [/([\w-]+\.wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)/i, "workday", (m) => `${m[1]}/${m[2]}`],
  ];
  for (const [re, ats, slug] of rules) {
    const m = url.match(re);
    if (m && !["jobs", "boards", "embed", "api"].includes(m[1]!.toLowerCase())) return { ats, slug: slug(m) };
  }
  return null;
}

/**
 * Guess a company's public job board from its name: try the usual slugs on each ATS and keep the first that
 * answers with at least one job. ~10 cheap requests; used when you /like a company without a careers URL.
 */
export async function probeAts(name: string, domain?: string | null): Promise<{ ats: string; slug: string } | null> {
  const base = name.toLowerCase().replace(/\b(b\.?v\.?|gmbh|inc|ltd|ai|labs?)\b/g, "").trim();
  const slugs = [...new Set([
    base.replace(/[^a-z0-9]+/g, ""), base.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    name.toLowerCase().replace(/[^a-z0-9]+/g, ""), domain?.split(".")[0]?.toLowerCase(),
  ].filter((s): s is string => !!s && s.length >= 2))].slice(0, 3);
  for (const slug of slugs) {
    for (const ats of ["ashby", "greenhouse", "lever", "recruitee", "workable", "personio"]) {
      try {
        const jobs = await fetchAts(name, ats, slug);
        if (jobs.length) return { ats, slug };
      } catch { /* not on this ATS */ }
    }
  }
  return null;
}

export async function fetchAts(company: string, ats: string, slug: string, search?: string[]): Promise<RawJob[]> {
  switch (ats) {
    case "workday": return fetchWorkday(company, slug, search?.length ? search : undefined);
    case "greenhouse": return fetchGreenhouse(company, slug);
    case "lever": return fetchLever(company, slug);
    case "lever-eu": return fetchLever(company, slug, true);
    case "ashby": return fetchAshby(company, slug);
    case "recruitee": return fetchRecruitee(company, slug);
    case "workable": return fetchWorkable(company, slug);
    case "personio": return fetchPersonio(company, slug);
    default: throw new Error(`unsupported ATS: ${ats}`);
  }
}
