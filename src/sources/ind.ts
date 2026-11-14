// IND public register of recognised sponsors ("erkende referenten"), category
// "regular labour and highly skilled migrants". Companies on it can sponsor a Dutch
// highly-skilled-migrant permit. Refreshed weekly by cron, or pushed from your laptop with
// scripts/import-sponsors.mjs if the page layout changes.
import type { Env } from "../env";
import { run } from "../lib/db";
import { decodeEntities, fetchWithTimeout, normalizeCompany, nowIso } from "../lib/util";

export const IND_REGISTER_URL =
  "https://ind.nl/en/public-register-recognised-sponsors/public-register-regular-labour-and-highly-skilled-migrants";

export interface SponsorRow { name: string; kvk?: string | null }

/** Pull (name, KvK number) pairs out of the register's HTML table. */
export function parseIndHtml(html: string): SponsorRow[] {
  const rows: SponsorRow[] = [];
  for (const [, tr] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, c]) =>
      decodeEntities(c!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
    );
    if (cells.length >= 1 && cells[0] && !/^organi[sz]ation/i.test(cells[0])) {
      rows.push({ name: cells[0], kvk: cells.find((c) => /^\d{8}$/.test(c)) ?? null });
    }
  }
  return rows;
}

export async function storeSponsors(env: Env, rows: SponsorRow[]): Promise<number> {
  const now = nowIso();
  const stmts = rows
    .map((r) => ({ ...r, norm: normalizeCompany(r.name) }))
    .filter((r) => r.norm)
    .map((r) =>
      env.DB.prepare(
        `INSERT INTO sponsors(normalized_name, name, kvk, register, imported_at) VALUES (?, ?, ?, 'ind-nl', ?)
         ON CONFLICT(normalized_name) DO UPDATE SET imported_at = excluded.imported_at`,
      ).bind(r.norm, r.name, r.kvk ?? null, now),
    );
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
  // Re-flag companies we track.
  await run(env.DB, `UPDATE companies SET ind_sponsor = 1 WHERE normalized_name IN (SELECT normalized_name FROM sponsors)`);
  return stmts.length;
}

export async function refreshIndRegister(env: Env): Promise<number> {
  const res = await fetchWithTimeout(IND_REGISTER_URL, {}, 30000);
  if (!res.ok) throw new Error(`IND register HTTP ${res.status}`);
  const rows = parseIndHtml(await res.text());
  if (rows.length < 500) throw new Error(`IND register parse looks wrong (${rows.length} rows) — page layout may have changed`);
  return storeSponsors(env, rows);
}
