// Parsing what you type after /like. Pure (tests import it directly).
import { detectAts } from "../sources/ats.ts";

/** "/like <company or URL> — <why>". Separators: " — ", " – ", " - ", " | ", ": ". Pure, for tests. */
export function parseLike(text: string): { target: string; reason: string } | null {
  const body = text.replace(/^\/like(@\w+)?\s*/i, "").trim();
  if (!body) return null;
  const m = body.match(/^(\S+:\/\/\S+)\s+(?:[—–|:-]\s*)?([\s\S]+)$/) // URL first: its own ":" isn't a separator
    ?? body.match(/^(.+?)\s+[—–|-]\s+([\s\S]+)$/)
    ?? body.match(/^([^:]+?):\s+([\s\S]+)$/);
  if (!m) return { target: body, reason: "" };
  return { target: m[1]!.trim(), reason: m[2]!.trim() };
}

/** Company name + domain from what you typed (a name, a website, or a careers URL). */
export function companyFromTarget(target: string): { name: string; domain: string | null; url: string | null } {
  if (!/^https?:\/\//i.test(target)) return { name: target, domain: null, url: null };
  const u = new URL(target);
  const host = u.hostname.replace(/^www\./, "");
  const ats = detectAts(target);
  // On an ATS host the company is the slug (jobs.ashbyhq.com/sereact); otherwise the website's name.
  const raw = ats ? ats.slug.split(/[./]/)[0]! : host.split(".").slice(-2, -1)[0] ?? host;
  const name = raw.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { name, domain: ats ? null : host, url: target };
}
