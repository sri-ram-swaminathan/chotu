// Upload profile/ to Chotu.   Local:  npm run sync-profile
//                             Cloud:  CHOTU_URL=https://chotu.you.workers.dev CHOTU_TOKEN=... npm run sync-profile
// Validation happens server-side: a typo in cv.yaml is rejected with a clear error and nothing is overwritten.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { api, CHOTU_URL } from "./_config.mjs";

const ROOT = "profile";
const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ya?ml|md|txt|html|csv|tex)$/i.test(name)) files[relative(ROOT, p).replace(/\\/g, "/")] = readFileSync(p, "utf8");
  }
})(ROOT);

console.log(`Uploading ${Object.keys(files).length} files to ${CHOTU_URL}: ${Object.keys(files).join(", ")}`);
const result = await api("/api/admin/profile", { files });
console.log("✓ synced", result);
