// Point your Telegram bot(s) at the deployed Worker.
//   npm run telegram:webhook
// Tokens come from .dev.vars (or env). The URL is CHOTU_URL if set, otherwise PUBLIC_URL from wrangler.jsonc.
// Main bot → /telegram/webhook (assistant). Alert bot (optional) → /telegram/alert-webhook (pager).
import { readFileSync } from "node:fs";
import { env } from "./_config.mjs";

// Telegram must reach the DEPLOYED worker, so default to the PUBLIC_URL configured for deploys.
const publicUrl = readFileSync("wrangler.jsonc", "utf8").match(/"PUBLIC_URL"\s*:\s*"([^"]+)"/)?.[1];
const CHOTU_URL = (process.env.CHOTU_URL || publicUrl || "").replace(/\/$/, "");

const secret = env.TELEGRAM_WEBHOOK_SECRET;
if (!env.TELEGRAM_BOT_TOKEN || !secret) throw new Error("Need TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (env or .dev.vars)");
if (!CHOTU_URL || CHOTU_URL.includes("localhost")) throw new Error("Set PUBLIC_URL in wrangler.jsonc (or CHOTU_URL) to your workers.dev URL — Telegram can't reach localhost");
console.log(`Pointing webhooks at ${CHOTU_URL}`);

const call = async (token, method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return res.json();
};

const commands = (list) => ({ commands: list.map(([command, description]) => ({ command, description })) });

// Main assistant bot
console.log("main:", await call(env.TELEGRAM_BOT_TOKEN, "setWebhook", {
  url: `${CHOTU_URL}/telegram/webhook`, secret_token: secret, allowed_updates: ["message", "callback_query"],
}));
console.log(await call(env.TELEGRAM_BOT_TOKEN, "setMyCommands", commands([
  ["recs", "Pending recommendations"], ["more", "Fill empty slots"], ["checkin", "Did I apply to the pending ones?"],
  ["apps", "Applications"], ["alerts", "Recent alerts"], ["add", "Add a job by URL"], ["research", "Research a company or topic"],
  ["prep", "Today's prep"], ["log", "Log prep progress"], ["discover", "Find new companies"], ["brief", "Daily brief"],
  ["like", "Flag a company you like (+ why)"], ["beliefs", "What Chotu learned about you"], ["calendar", "Deadlines calendar"], ["stats", "System stats"], ["quota", "Free LLM quota left"], ["help", "Help"],
])));

// Optional alert bot
if (env.TELEGRAM_ALERT_BOT_TOKEN) {
  console.log("alert:", await call(env.TELEGRAM_ALERT_BOT_TOKEN, "setWebhook", {
    url: `${CHOTU_URL}/telegram/alert-webhook`, secret_token: secret, allowed_updates: ["message", "callback_query"],
  }));
  console.log(await call(env.TELEGRAM_ALERT_BOT_TOKEN, "setMyCommands", commands([["alerts", "Recent alerts"], ["help", "Help"]])));
  console.log("Open the alert bot in Telegram and press Start once, so it's allowed to message you.");
} else {
  console.log("No TELEGRAM_ALERT_BOT_TOKEN — alerts will come through the main bot.");
}
