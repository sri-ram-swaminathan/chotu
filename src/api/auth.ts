import type { Env } from "../env";

/** Constant-time string compare (prevents timing attacks on the token). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isAuthorized(req: Request, env: Env): boolean {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return !!env.API_TOKEN && safeEqual(token, env.API_TOKEN);
}

async function hmac(env: Env, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.API_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Resume links are shareable without exposing your API token: each link carries its own signature. */
export async function signedResumeUrl(env: Env, resumeId: string, ext: "" | ".tex" = ""): Promise<string> {
  return `${env.PUBLIC_URL.replace(/\/$/, "")}/resume/${resumeId}${ext}?sig=${await hmac(env, `resume:${resumeId}`)}`;
}

/** One tap → Overleaf fetches the signed .tex and compiles it to a PDF (pdfLaTeX, same as your template). */
export async function overleafUrl(env: Env, resumeId: string): Promise<string> {
  return `https://www.overleaf.com/docs?snip_uri=${encodeURIComponent(await signedResumeUrl(env, resumeId, ".tex"))}&engine=pdflatex`;
}

/** The deadlines calendar (web page + .ics feed) is opened from your phone and by calendar apps: a signed key, not the API token. */
export const calendarSig = (env: Env) => hmac(env, "calendar:v1");
export async function verifyCalendarSig(env: Env, sig: string | null): Promise<boolean> {
  return !!sig && safeEqual(sig, await calendarSig(env));
}

export async function verifyResumeSig(env: Env, resumeId: string, sig: string | null): Promise<boolean> {
  return !!sig && safeEqual(sig, await hmac(env, `resume:${resumeId}`));
}
