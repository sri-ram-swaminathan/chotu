// Two ways email gets into Chotu — pick one:
//
// A) Cloudflare Email Routing (instant, recommended): put a domain on Cloudflare, route
//    jobs@yourdomain → this Worker, and add a Gmail filter forwarding everything there.
//    Cloudflare calls the `email()` handler in index.ts for each message.
//
// B) Gmail API polling (no domain needed): every tick we list recent messages via OAuth.
import PostalMime from "postal-mime";
import type { Env } from "../env";
import { storeEmail } from "../agents/emailAgent";
import { htmlToText } from "../lib/util";

export async function handleIncomingEmail(message: ForwardableEmailMessage, env: Env) {
  const parsed = await PostalMime.parse(message.raw);
  const body = parsed.text?.trim() || htmlToText(parsed.html ?? "");
  // Keep links visible for the job extractor: append hrefs from the HTML version.
  const links = [...(parsed.html ?? "").matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]).slice(0, 80);
  await storeEmail(env, {
    messageId: parsed.messageId || `${message.from}-${Date.now()}`,
    from: parsed.from?.address ?? message.from,
    subject: parsed.subject ?? "",
    body: links.length ? `${body}\n\nLINKS:\n${links.join("\n")}` : body,
    receivedAt: parsed.date ? new Date(parsed.date).toISOString() : undefined,
  });
}

// ── Gmail API polling ────────────────────────────────────────────────────────
async function gmailAccessToken(env: Env): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID!,
      client_secret: env.GMAIL_CLIENT_SECRET!,
      refresh_token: env.GMAIL_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`gmail token ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

function b64urlDecode(data: string): string {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: { name: string; value: string }[] }

function collectBodies(part: GmailPart, out: { text: string[]; html: string[] }) {
  if (part.body?.data) {
    if (part.mimeType === "text/plain") out.text.push(b64urlDecode(part.body.data));
    else if (part.mimeType === "text/html") out.html.push(b64urlDecode(part.body.data));
  }
  for (const p of part.parts ?? []) collectBodies(p, out);
}

/** Pull up to `max` messages from the last 2 days. Already-stored ids are skipped by the DB's UNIQUE constraint. */
export async function pollGmail(env: Env, max = 10): Promise<number> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) return 0;
  const token = await gmailAccessToken(env);
  const auth = { authorization: `Bearer ${token}` };
  const list = (await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=newer_than:2d&maxResults=${max}`, { headers: auth })).json()) as {
    messages?: { id: string }[];
  };
  let stored = 0;
  for (const { id } of list.messages ?? []) {
    const exists = await env.DB.prepare("SELECT 1 FROM emails WHERE message_id = ?").bind(`gmail:${id}`).first();
    if (exists) continue;
    const msg = (await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: auth })).json()) as {
      payload: GmailPart; internalDate?: string;
    };
    const header = (n: string) => msg.payload.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    const bodies = { text: [] as string[], html: [] as string[] };
    collectBodies(msg.payload, bodies);
    const html = bodies.html.join("\n");
    const links = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]).slice(0, 80);
    const body = (bodies.text.join("\n").trim() || htmlToText(html)) + (links.length ? `\n\nLINKS:\n${links.join("\n")}` : "");
    if (await storeEmail(env, {
      messageId: `gmail:${id}`,
      from: header("from"),
      subject: header("subject"),
      body,
      receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined,
    })) stored++;
  }
  return stored;
}
