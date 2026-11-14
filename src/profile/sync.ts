// Applies a profile upload: stores the raw files, then projects them into tables
// (targets → companies, prep.yaml → prep_items, contacts.csv → contacts).
import YAML from "yaml";
import type { Env } from "../env";
import { first, run } from "../lib/db";
import { normalizeCompany, nowIso, uid } from "../lib/util";
import { enqueue } from "../pipeline/tasks";
import { parseProfile, PrepSchema } from "./profile";

export async function syncProfile(env: Env, files: Record<string, string>) {
  const now = nowIso();
  // Validate BEFORE writing anything: a typo in cv.yaml should fail loudly, not corrupt state.
  const profile = parseProfile(files);
  const prep = PrepSchema.parse(files["prep.yaml"] ? YAML.parse(files["prep.yaml"]) ?? {} : {});

  const stmts: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM profile_files")];
  for (const [path, content] of Object.entries(files)) {
    if (path === "contacts.csv") continue; // contacts go to their own table, not the profile blob
    stmts.push(env.DB.prepare("INSERT INTO profile_files(path, content, updated_at) VALUES (?, ?, ?)").bind(path, content, now));
  }
  await env.DB.batch(stmts);

  // targets.yaml → companies (upsert by normalized name)
  let companies = 0;
  for (const t of profile.targets.companies) {
    const id = await upsertCompany(env, {
      name: t.name,
      domain: t.domain ?? null,
      ats: t.ats ?? null,
      ats_slug: t.slug ?? null,
      region: t.region ?? null,
      tags: t.tags.join(","),
      funded_stage: t.funded_stage ?? null,
      source: "targets",
    });
    companies++;
    if (t.research) await enqueue(env, "research_company", { companyId: id }, `research:${id}:${now.slice(0, 10)}`);
  }

  // prep.yaml → prep_items
  for (const item of prep.items) {
    await run(
      env.DB,
      `INSERT INTO prep_items(id, type, title, unit, daily_target, weekly_target, total_target, deadline, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type=excluded.type, title=excluded.title, unit=excluded.unit,
         daily_target=excluded.daily_target, weekly_target=excluded.weekly_target,
         total_target=excluded.total_target, deadline=excluded.deadline, active=excluded.active`,
      item.id, item.type, item.title, item.unit, item.daily_target ?? null, item.weekly_target ?? null,
      item.total_target ?? null, item.deadline ?? null, item.active ? 1 : 0,
    );
  }

  const contacts = files["contacts.csv"] ? await importContacts(env, files["contacts.csv"]) : 0;
  return { files: Object.keys(files).length, companies, prepItems: prep.items.length, contacts };
}

export interface CompanyInput {
  name: string;
  domain?: string | null;
  ats?: string | null;
  ats_slug?: string | null;
  region?: string | null;
  tags?: string | null;
  funded_stage?: string | null;
  funding_eur?: number | null;
  source: string;
}

/** Insert or update a company; returns its id. Only overwrites fields that are provided (COALESCE). */
export async function upsertCompany(env: Env, c: CompanyInput): Promise<string> {
  const norm = normalizeCompany(c.name);
  if (!norm) throw new Error(`cannot normalize company name "${c.name}"`);
  // The IND register uses legal names ("ABN AMRO Bank N.V.", "Stichting Deltares"), so besides an exact match we
  // accept the company name as the first or last word(s) of a registered name. Rare false positives are possible
  // ("Planet" ↔ "Planet Payment Netherlands"); normalized names contain only [a-z0-9 ], so LIKE is safe.
  const sponsor = await first<{ n: string }>(env.DB,
    `SELECT normalized_name AS n FROM sponsors WHERE normalized_name = ?1
       OR (length(?1) >= 3 AND (normalized_name LIKE ?1 || ' %' OR normalized_name LIKE '% ' || ?1)) LIMIT 1`, norm);
  await run(
    env.DB,
    `INSERT INTO companies(id, name, normalized_name, domain, ats, ats_slug, region, tags, funded_stage, funding_eur, ind_sponsor, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(normalized_name) DO UPDATE SET
       domain = COALESCE(excluded.domain, companies.domain),
       ats = COALESCE(excluded.ats, companies.ats),
       ats_slug = COALESCE(excluded.ats_slug, companies.ats_slug),
       region = COALESCE(excluded.region, companies.region),
       tags = COALESCE(NULLIF(excluded.tags, ''), companies.tags),
       funded_stage = COALESCE(excluded.funded_stage, companies.funded_stage),
       funding_eur = COALESCE(excluded.funding_eur, companies.funding_eur),
       ind_sponsor = MAX(excluded.ind_sponsor, companies.ind_sponsor)`,
    uid(), c.name, norm, c.domain ?? null, c.ats ?? null, c.ats_slug ?? null, c.region ?? null, c.tags ?? null,
    c.funded_stage ?? null, c.funding_eur ?? null, sponsor ? 1 : 0, c.source, nowIso(),
  );
  const row = await first<{ id: string }>(env.DB, "SELECT id FROM companies WHERE normalized_name = ?", norm);
  return row!.id;
}

// ── LinkedIn Connections.csv import ──────────────────────────────────────────
// LinkedIn: Settings → Data privacy → Get a copy of your data → Connections.
// The file starts with a few "Notes:" lines before the real header row.
export async function importContacts(env: Env, csv: string): Promise<number> {
  const rows = parseCsv(csv);
  const headerIdx = rows.findIndex((r) => r[0]?.trim() === "First Name");
  if (headerIdx < 0) return 0;
  const header = rows[headerIdx]!.map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const [fi, li, ui, ei, ci, pi, di] = ["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"].map(col);
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const company = r[ci!] ?? "";
    const url = r[ui!] || `noid:${r[fi!]}-${r[li!]}-${company}`;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO contacts(id, first_name, last_name, company, normalized_company, position, url, email, connected_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET company=excluded.company, normalized_company=excluded.normalized_company, position=excluded.position`,
      ).bind(uid(), r[fi!] ?? "", r[li!] ?? "", company, normalizeCompany(company), r[pi!] ?? "", url, r[ei!] || null, r[di!] ?? null),
    );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return stmts.length;
}

/** Minimal RFC-4180 CSV parser (handles quotes, escaped quotes, commas and newlines in fields). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}
