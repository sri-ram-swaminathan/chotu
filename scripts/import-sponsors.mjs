// Import the IND recognised-sponsor register from your laptop (backup for the weekly cron job,
// which may hit CPU limits on the free plan). Fetches the public register, parses it, uploads in chunks.
//   npm run sync-sponsors   (or: node scripts/import-sponsors.mjs path/to/saved-page.html)
import { readFileSync } from "node:fs";
import { api } from "./_config.mjs";

const URL = "https://ind.nl/en/public-register-recognised-sponsors/public-register-regular-labour-and-highly-skilled-migrants";
const html = process.argv[2] ? readFileSync(process.argv[2], "utf8") : await (await fetch(URL)).text();

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const rows = [];
for (const [, tr] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
  const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, c]) => decode(c.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
  if (cells[0] && !/^organi[sz]ation/i.test(cells[0])) rows.push({ name: cells[0], kvk: cells.find((c) => /^\d{8}$/.test(c)) ?? null });
}
console.log(`Parsed ${rows.length} sponsors`);
if (rows.length < 500) { console.error("That looks wrong — the page layout may have changed. Save the page and pass the file path."); process.exit(1); }

let stored = 0;
for (let i = 0; i < rows.length; i += 1000) {
  stored += (await api("/api/admin/sponsors", { rows: rows.slice(i, i + 1000) })).stored;
  console.log(`  ${stored}/${rows.length}`);
}
console.log("✓ done");
