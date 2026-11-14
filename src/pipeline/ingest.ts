// Stage 1 of the funnel: everything that comes in (ATS, email alerts, watched pages, /add)
// goes through ingestJobs(). It is cheap — no LLM calls — so it can handle thousands of postings.
//
//   raw posting → dedupe → hard filters (location, seniority, dealbreakers, visa) → keyword rank
//
// Only jobs that survive reach the (expensive, rate-limited) LLM scoring step.
import type { Env } from "../env";
import { all, first } from "../lib/db";
import { dedupeKey, nowIso, uid } from "../lib/util";
import type { Profile } from "../profile/profile";
import { upsertCompany } from "../profile/sync";
import type { RawJob } from "../sources/ats";
import { isNetherlandsLocation, visaMentionFromText, visaVerdict } from "./visa";
import { INTERNSHIP_TITLE } from "./kinds";

export interface TriageResult { pass: boolean; reason?: string; keywordScore: number }

/** Pure function: easy to unit test, easy to reason about. */
export function triage(job: RawJob, profile: Profile, company: { ind_sponsor: number; funded_stage: string | null; funding_eur: number | null }) {
  const c = profile.constraints;
  const title = job.title.toLowerCase();
  const desc = (job.description ?? "").toLowerCase();
  const loc = (job.location ?? "").toLowerCase();
  const kind = job.kind ?? "job";

  const mention = visaMentionFromText(job.description);
  const visa = c.visa.needs_sponsorship
    ? visaVerdict({ mention, indSponsor: !!company.ind_sponsor && isNetherlandsLocation(job.location) !== false, fundedStage: company.funded_stage, fundingEur: company.funding_eur })
    : "confirmed";

  const result = (pass: boolean, reason?: string, keywordScore = 0) => ({ pass, reason, keywordScore, visa });

  if (visa === "blocked") return result(false, "visa: posting says no sponsorship");

  // Unwanted kinds (constraints.yaml exclude_kinds). Internships often arrive labelled "job", so the title decides too.
  const effectiveKind = kind === "job" && INTERNSHIP_TITLE.test(title) ? "internship" : kind;
  if ((c.exclude_kinds ?? []).includes(effectiveKind as never)) return result(false, `kind: ${effectiveKind}`);

  if (kind === "job" || kind === "internship") {
    const bad = c.seniority.exclude_title_words.find((w) => new RegExp(`\\b${escapeRe(w.toLowerCase())}\\b`).test(title));
    if (bad) return result(false, `seniority: "${bad}" in title`);
  }

  // "Remote" doesn't help if it's remote-in-the-US: check excluded regions first.
  const where = `${loc} ${title}`;
  const excluded = c.locations.exclude_regions.find((r) => new RegExp(`\\b${escapeRe(r.toLowerCase())}\\b`).test(where));
  if (excluded) return result(false, `location: excluded region "${excluded}"`);

  const places = [...c.locations.preferred, ...c.locations.acceptable].map((p) => p.toLowerCase());
  const remoteOk = c.locations.allow_remote && (job.remote || /remote/.test(loc));
  if (loc && places.length && !remoteOk && !places.some((p) => loc.includes(p))) {
    return result(false, `location: ${job.location}`);
  }

  const breaker = c.dealbreaker_phrases.find((p) => desc.includes(p.toLowerCase()));
  if (breaker) return result(false, `dealbreaker: "${breaker}"`);

  // Keyword score: title matches count 3x. This is the "classic keyword retrieval" ranking —
  // crude but free, and it decides which jobs deserve an LLM call.
  let score = 0;
  for (const [kw, w] of Object.entries(profile.scoring.keywords.positive)) {
    const k = kw.toLowerCase();
    if (title.includes(k)) score += 3 * w;
    else if (desc.includes(k)) score += w;
  }
  for (const [kw, w] of Object.entries(profile.scoring.keywords.negative)) {
    const k = kw.toLowerCase();
    if (title.includes(k) || desc.includes(k)) score -= Math.abs(w);
  }
  // Non-job opportunities (PhD, accelerator, hackathon) come from curated sources; don't keyword-gate them.
  if ((kind === "job" || kind === "internship") && score < profile.scoring.min_keyword_score) {
    return result(false, `keywords: score ${score} < ${profile.scoring.min_keyword_score}`, score);
  }
  return result(true, undefined, score);
}


const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface IngestStats { seen: number; inserted: number; passed: number; duplicates: number }

type CompanyLite = { id: string; ind_sponsor: number; funded_stage: string | null; funding_eur: number | null };

/** SELECT ... WHERE col IN (?, ?, ...) in chunks (D1 allows max 100 bound parameters per query). */
async function existingIn(env: Env, sql: (placeholders: string) => string, values: string[]) {
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < values.length; i += 90) {
    const chunk = values.slice(i, i + 90);
    rows.push(...(await all<Record<string, string>>(env.DB, sql(chunk.map(() => "?").join(",")), ...chunk)));
  }
  return rows;
}

/**
 * Batch-oriented on purpose: D1 limits queries per Worker invocation (50 on the free plan,
 * 1000 on paid). A naive "3 queries per job" loop dies on a company with 300 openings.
 * Here a 300-job ingest costs ~3 lookups + ~10 batched writes, regardless of size.
 */
export async function ingestJobs(env: Env, profile: Profile, raws: RawJob[], source: string): Promise<IngestStats & { jobIds: string[] }> {
  const valid = raws.filter((r) => r.title && r.url && r.company);
  const stats = { seen: raws.length, inserted: 0, passed: 0, duplicates: 0 };
  const jobIds: string[] = [];
  if (!valid.length) return { ...stats, jobIds };

  // 1. Skip URLs we've already seen (one query per 90 URLs).
  const seenUrls = new Set((await existingIn(env, (ph) => `SELECT url FROM postings WHERE url IN (${ph})`, [...new Set(valid.map((r) => r.url))])).map((r) => r.url));
  const fresh = valid.filter((r) => !seenUrls.has(r.url));
  stats.duplicates += valid.length - fresh.length;
  if (!fresh.length) return { ...stats, jobIds };

  // 2. Companies (usually just one for an ATS feed; a handful for an email digest).
  const companies = new Map<string, CompanyLite>();
  for (const name of new Set(fresh.map((r) => r.company))) {
    const id = await upsertCompany(env, { name, source });
    companies.set(name, (await first<CompanyLite>(env.DB, "SELECT id, ind_sponsor, funded_stage, funding_eur FROM companies WHERE id = ?", id))!);
  }

  // 3. Which of these jobs do we already know under another URL?
  const keyed = fresh.map((r) => ({ raw: r, key: dedupeKey(r.company, r.title, r.location) }));
  const known = new Map((await existingIn(env, (ph) => `SELECT id, dedupe_key FROM jobs WHERE dedupe_key IN (${ph})`, [...new Set(keyed.map((k) => k.key))]))
    .map((r) => [r.dedupe_key!, r.id!]));

  // 4. Build all writes, then send them in batches.
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const { raw, key } of keyed) {
    let jobId = known.get(key);
    if (!jobId) {
      const company = companies.get(raw.company)!;
      const t = triage(raw, profile, company);
      jobId = uid();
      known.set(key, jobId); // same job twice in one batch → second becomes a posting
      stmts.push(env.DB.prepare(
        `INSERT INTO jobs(id, company_id, kind, title, location, remote, url, description, deadline, posted_at,
                          dedupe_key, stage, filter_reason, visa, keyword_score, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
      ).bind(jobId, company.id, raw.kind ?? "job", raw.title, raw.location ?? null, raw.remote ? 1 : 0, raw.url,
        raw.description ?? null, raw.deadline ?? null, raw.postedAt ?? null, key,
        t.pass ? "ranked" : "filtered_out", t.reason ?? null, t.visa, t.keywordScore, now));
      stats.inserted++;
      if (t.pass) { stats.passed++; jobIds.push(jobId); }
    } else {
      stats.duplicates++; // same job, new source (e.g. a LinkedIn alert for a job we already have from the ATS)
    }
    stmts.push(env.DB.prepare("INSERT INTO postings(id, job_id, source, url, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO NOTHING")
      .bind(uid(), jobId, source, raw.url, now));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { ...stats, jobIds };
}
