// Shared config for the helper scripts: reads CHOTU_URL / CHOTU_TOKEN from the environment,
// falling back to .dev.vars (local dev) so you don't have to export anything.
import { existsSync, readFileSync } from "node:fs";

function devVars() {
  if (!existsSync(".dev.vars")) return {};
  return Object.fromEntries(
    readFileSync(".dev.vars", "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+#.*$/, "").match(/^([A-Z_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  );
}

const vars = devVars();
export const CHOTU_URL = (process.env.CHOTU_URL || "http://localhost:8787").replace(/\/$/, "");
export const CHOTU_TOKEN = process.env.CHOTU_TOKEN || vars.API_TOKEN;
export const env = { ...vars, ...process.env };

export async function api(path, body) {
  if (!CHOTU_TOKEN) throw new Error("Set CHOTU_TOKEN (your API_TOKEN secret) or create .dev.vars");
  const res = await fetch(CHOTU_URL + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${CHOTU_TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return JSON.parse(text);
}
