// ─────────────────────────────────────────────────────────────────────────────
// Entry point. A Cloudflare Worker exports handlers for each kind of event:
//   fetch     — HTTP requests (dashboard, API, Telegram webhook, resume pages)
//   scheduled — Cron Triggers (the 24/7 heartbeat)
//   email     — Cloudflare Email Routing (instant email ingestion)
// ─────────────────────────────────────────────────────────────────────────────
import type { Env } from "./env";
import { handleApi } from "./api/routes";
import { isAuthorized, verifyCalendarSig, verifyResumeSig } from "./api/auth";
import { calendarItems, calendarLinks, setDeadlineStatus, toIcs } from "./api/calendar";
import { localDay } from "./lib/util";
import { first } from "./lib/db";
import { daily, tick, weekly } from "./scheduler";
import { handleIncomingEmail } from "./sources/email";
import { handleTelegram } from "./telegram/bot";

const DAILY_LOCAL_HOUR = 11;
const localHour = (tz: string, d: Date) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(d));

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Telegram → us. Verified with the secret token we registered in setWebhook.
    // Two bots: /telegram/webhook (main assistant) and /telegram/alert-webhook (alert pager).
    if ((url.pathname === "/telegram/webhook" || url.pathname === "/telegram/alert-webhook") && req.method === "POST") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const update = await req.json();
      const bot = url.pathname === "/telegram/alert-webhook" ? "alert" : "main";
      // Reply 200 immediately; do the work in the background so Telegram doesn't retry.
      ctx.waitUntil(handleTelegram(env, update as never, ctx, bot).catch((e) => console.error("telegram handler", e)));
      return new Response("ok");
    }

    // Tailored resumes: signed links, so you can open them on any device.
    const resume = url.pathname.match(/^\/resume\/([\w-]+)(\.tex)?$/);
    if (resume) {
      if (!(await verifyResumeSig(env, resume[1]!, url.searchParams.get("sig")))) return new Response("forbidden", { status: 403 });
      if (resume[2]) {
        const tex = await first<{ tex: string | null }>(env.DB, "SELECT tex FROM resumes WHERE id = ?", resume[1]);
        return tex?.tex
          ? new Response(tex.tex, { headers: { "content-type": "application/x-tex; charset=utf-8", "content-disposition": `inline; filename="cv-${resume[1]!.slice(0, 8)}.tex"` } })
          : new Response("not found", { status: 404 });
      }
      const row = await first<{ html: string }>(env.DB, "SELECT html FROM resumes WHERE id = ?", resume[1]);
      return row ? new Response(row.html, { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("not found", { status: 404 });
    }

    // Deadlines calendar: page + data + .ics feed, all gated by the signed calendar key (?k=).
    if (url.pathname === "/calendar.json" || url.pathname === "/calendar.ics" || url.pathname.startsWith("/calendar/deadline/")) {
      if (!(await verifyCalendarSig(env, url.searchParams.get("k")))) return new Response("forbidden", { status: 403 });
      if (url.pathname === "/calendar.ics") {
        return new Response(toIcs(await calendarItems(env)), {
          headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="chotu-deadlines.ics"', "cache-control": "max-age=900" },
        });
      }
      if (url.pathname === "/calendar.json") {
        return Response.json({ items: await calendarItems(env), links: await calendarLinks(env), today: localDay(env.TIMEZONE) });
      }
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const { status } = (await req.json()) as { status: string };
      await setDeadlineStatus(env, decodeURIComponent(url.pathname.split("/").pop()!), status);
      return Response.json({ ok: true });
    }

    if (url.pathname.startsWith("/api/")) {
      if (!isAuthorized(req, env)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      return handleApi(env, req, ctx);
    }

    // Everything else: the static dashboard in public/
    return env.ASSETS.fetch(req);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    switch (event.cron) {
      // Daily brief + recommendations at 11:00 Amsterdam time. Cron runs in UTC and Amsterdam shifts between
      // UTC+1 (winter) and UTC+2 (summer), so both 09:00 and 10:00 UTC fire and only the one that is 11:00 local runs.
      case "0 9 * * *":
      case "0 10 * * *":
        if (localHour(env.TIMEZONE, new Date(event.scheduledTime)) === DAILY_LOCAL_HOUR) ctx.waitUntil(daily(env));
        break;
      case "0 3 * * 1": ctx.waitUntil(weekly(env)); break;
      default: ctx.waitUntil(tick(env));
    }
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    // Store it, then process right away: job-alert emails feed the alert agent, and minutes matter.
    ctx.waitUntil(handleIncomingEmail(message, env).then(() => tick(env, { tasksOnly: true })));
  },
} satisfies ExportedHandler<Env>;
