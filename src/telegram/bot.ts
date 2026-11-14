// Telegram webhook: your phone is the primary interface.
//   /commands       → fast, deterministic shortcuts (no LLM)
//   plain messages  → the ORCHESTRATOR agent (agents/orchestrator.ts), which can query the backend and
//                     dispatch the research / search / visa / recommender agents on demand
//   inline buttons  → decisions on recommendations, check-ins and alerts (feed the recommender)
//
// Two bots share this handler. `bot` says which one received the update, so answers and button edits
// go back through the same bot (Telegram requires that).
import type { Env } from "../env";
import { all, first } from "../lib/db";
import { escapeHtml, localDay, nowIso, truncate } from "../lib/util";
import type { Outreach } from "../agents/companyResearch";
import { decideAlert } from "../agents/alertAgent";
import { deadlineLine, rollingPrograms, upcomingDeadlines } from "../agents/deadlineAgent";
import { chat } from "../agents/orchestrator";
import { createReport } from "../agents/researchAgent";
import { enqueue } from "../pipeline/tasks";
import { loadProfile } from "../profile/profile";
import { upsertCompany } from "../profile/sync";
import { sendBrief } from "../orchestrator/brief";
import { handleCheckin, refill, sendCheckin } from "../orchestrator/checkin";
import { awaitReason, consumeReason, IGNORE_REASONS } from "../orchestrator/feedback";
import { logPrep, prepLine, prepStatus } from "../orchestrator/prep";
import {
  addApplicationEvent, createApplication, decide, fillSlots, outreachHtml, recommendationCard,
} from "../orchestrator/recommend";
import { notify, tg, typing, type Bot } from "./api";
import { LLM } from "../llm/provider";
import { beliefsMessage, parseLike } from "../orchestrator/interests";
import { calendarLinks } from "../api/calendar";

interface Update {
  message?: { message_id: number; chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
}

const HELP = `<b>Chotu</b> — just talk to me, e.g.
• <i>How many applications did I make last week?</i>
• <i>What were the last 3 suggestions I ignored?</i>
• <i>Research computer vision companies in defence &amp; aerospace in Poland, top 3 for my profile</i>
• <i>Does Picnic sponsor visas?</i> · <i>I applied to Mollie today</i>

<b>Shortcuts</b>
/recs — pending recommendations · /more — fill empty slots now
/checkin — did you apply to the pending ones?
/apps — applications · /status &lt;app-id&gt; &lt;applied|replied|interview|offer|rejected|withdrawn|note&gt; [note]
/alerts — recent instant alerts · /deadlines — upcoming deadlines
/add &lt;url&gt; [pasted description] — add &amp; score a job
/like &lt;company or URL&gt; — &lt;why&gt; — flag a company you like (updates my beliefs) · /beliefs
/calendar — deadlines calendar (web + add to Google/Apple Calendar)
/research &lt;company | any research request&gt;
/prep — today's prep · /log &lt;item&gt; &lt;amount&gt; [note]
/discover — find new companies/roles · /brief · /stats · /quota — free LLM quota left`;

export async function handleTelegram(env: Env, update: Update, ctx: ExecutionContext, bot: Bot = "main") {
  if (update.callback_query) return handleCallback(env, update.callback_query, ctx, bot);
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const reply = (html: string) => notify(env, html, undefined, chatId, bot);

  if (text.startsWith("/start")) {
    return reply(`👋 Your chat id is <code>${chatId}</code>.\nSet it with: <code>npx wrangler secret put TELEGRAM_CHAT_ID</code>\n\n${HELP}`);
  }
  if (chatId !== env.TELEGRAM_CHAT_ID) return; // personal bot: ignore everyone else

  try {
    // Plain text: either a reason you were asked to type, or a question for the orchestrator.
    if (!text.startsWith("/")) {
      if (await consumeReason(env, text)) return reply("📝 Got it — noted as the reason. That shapes tomorrow's picks.");
      await typing(env, bot);
      return reply(await chat(env, await loadProfile(env), text));
    }
    return await command(env, text, ctx, reply);
  } catch (e) {
    return reply(`⚠️ ${escapeHtml(e instanceof Error ? e.message : String(e))}`);
  }
}

async function command(env: Env, text: string, ctx: ExecutionContext, reply: (html: string) => Promise<unknown>) {
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd!.toLowerCase().replace(/@\w+$/, "");
  const args = rest.join(" ");

  switch (cmd) {
    case "/help": return reply(HELP);
    case "/recs": {
      const recs = await all<{ id: string }>(env.DB, "SELECT id FROM recommendations WHERE status='pending' ORDER BY created_at");
      if (!recs.length) return reply("No pending recommendations. /more to pull new ones.");
      for (const r of recs) {
        const card = await recommendationCard(env, r.id);
        if (card) await notify(env, card.html, card.keyboard);
      }
      return;
    }
    case "/more": {
      const created = await fillSlots(env, { force: true });
      if (!created.length) return reply("Slots are full (decide on the pending ones first — /checkin) or nothing scored yet.");
      return;
    }
    case "/checkin": {
      const n = await sendCheckin(env);
      if (!n) return reply("Nothing to check in on — no pending suggestions older than 12h and no unconfirmed applications.");
      return;
    }
    case "/apps": {
      const apps = await all<{ id: string; status: string; company: string; title: string | null }>(env.DB,
        `SELECT a.id, a.status, c.name AS company, j.title FROM applications a
         JOIN companies c ON c.id = a.company_id LEFT JOIN jobs j ON j.id = a.job_id ORDER BY a.updated_at DESC LIMIT 40`);
      if (!apps.length) return reply("No applications yet.");
      const groups = new Map<string, string[]>();
      for (const a of apps) {
        const line = `<code>${a.id.slice(0, 6)}</code> ${escapeHtml(a.company)}${a.title ? ` — ${escapeHtml(truncate(a.title, 40))}` : ""}`;
        groups.set(a.status, [...(groups.get(a.status) ?? []), line]);
      }
      return reply([...groups].map(([s, ls]) => `<b>${s}</b>\n${ls.join("\n")}`).join("\n\n"));
    }
    case "/status": {
      const [prefix, type, ...note] = rest;
      const valid = ["applied", "outreach_sent", "replied", "interview", "offer", "rejected", "withdrawn", "note"];
      if (!prefix || !type || !valid.includes(type)) return reply(`Usage: /status &lt;app-id&gt; &lt;${valid.join("|")}&gt; [note]`);
      const app = await first<{ id: string }>(env.DB, "SELECT id FROM applications WHERE id LIKE ?", `${prefix}%`);
      if (!app) return reply("No application with that id. See /apps.");
      await addApplicationEvent(env, app.id, type, note.join(" ") || null, "telegram");
      return reply(`Updated → <b>${type}</b>`);
    }
    case "/deadlines": {
      const today = localDay(env.TIMEZONE);
      const rows = await upcomingDeadlines(env, 90, { overdueDays: 7 });
      const rolling = await rollingPrograms(env);
      if (!rows.length && !rolling.length) return reply("No deadlines yet. The deadline agent fills these in from your watched programs within a day.");
      return reply([`📅 <b>Deadlines</b> (next 90 days)`, ...rows.slice(0, 30).map((d) => deadlineLine(d, today)),
        rolling.length ? `\n🔁 <b>Rolling admissions</b>\n${rolling.map((d) => deadlineLine(d, today)).join("\n")}` : ""].filter(Boolean).join("\n"));
    }
    case "/alerts": {
      const rows = await all<{ status: string; title: string; company: string; sent_at: string; score: number }>(env.DB,
        `SELECT a.status, j.title, c.name AS company, a.sent_at, a.score FROM alerts a JOIN jobs j ON j.id = a.job_id
         JOIN companies c ON c.id = j.company_id ORDER BY a.sent_at DESC LIMIT 15`);
      if (!rows.length) return reply("No alerts yet. They fire on fresh postings from your alert inbox and tracked companies.");
      const icon: Record<string, string> = { sent: "🔔", applied: "✅", ignored: "❌" };
      return reply(rows.map((r) => `${icon[r.status] ?? ""} ${r.sent_at.slice(5, 16).replace("T", " ")} <b>${escapeHtml(truncate(r.title, 50))}</b> — ${escapeHtml(r.company)} (${r.score?.toFixed(1)})`).join("\n"));
    }
    case "/add": {
      const [url, ...desc] = rest;
      if (!url?.startsWith("http")) return reply("Usage: /add &lt;url&gt; [pasted description]");
      await enqueue(env, "add_job_url", { url, pasted: desc.join(" ") || null });
      ctx.waitUntil(runTasksSoon(env));
      return reply("⏳ Reading and scoring it…");
    }
    case "/like": {
      const like = parseLike(text);
      if (!like) return reply("Usage: <code>/like &lt;company name or careers URL&gt; — &lt;why it interests you&gt;</code>\n" +
        "e.g. <code>/like Sereact — robot manipulation with foundation models, small strong team</code>");
      if (!like.reason) return reply(`Why does <b>${escapeHtml(like.target)}</b> interest you? The reason is what I learn from.\n` +
        `<code>/like ${escapeHtml(like.target)} — your reason</code>`);
      await enqueue(env, "like_company", { input: like.target, reason: like.reason });
      ctx.waitUntil(runTasksSoon(env));
      return reply(`💚 Got it — adding <b>${escapeHtml(like.target)}</b>, finding its job board and updating my beliefs…`);
    }
    case "/beliefs": return reply(await beliefsMessage(env));
    case "/calendar": {
      const l = await calendarLinks(env);
      return reply(`📅 <b>Deadlines calendar</b>\n<a href="${l.web}">Open the calendar</a>\n\n` +
        `Subscribe in your phone/Google Calendar (updates itself):\n<code>${escapeHtml(l.ics)}</code>\n` +
        `<i>Google Calendar → Other calendars → + → From URL. iPhone → Settings → Calendar → Accounts → Add Subscribed Calendar.</i>`);
    }
    case "/research": {
      if (!args) return reply("Usage: /research &lt;company name or domain&gt;  or  /research &lt;any research request&gt;");
      const isDomain = /^[\w-]+(\.[\w-]+)+$/.test(args);
      // Short = a company name → deep dossier. Longer = an open request → the research agent.
      if (isDomain || args.split(/\s+/).length <= 3) {
        const name = isDomain ? args.split(".")[0]! : args;
        const id = await upsertCompany(env, { name, domain: isDomain ? args : null, source: "manual" });
        await enqueue(env, "research_company", { companyId: id }, `research:${id}:${nowIso().slice(0, 10)}`);
        return reply(`🔎 Researching <b>${escapeHtml(name)}</b> — dossier + outreach draft within ~10 minutes.`);
      }
      const reportId = await createReport(env, args);
      await enqueue(env, "research_topic", { reportId }, `topic:${reportId}`);
      return reply(`🔬 On it: <i>${escapeHtml(truncate(args, 200))}</i>\nThe research agent will send the report (with visa checks) within ~10 minutes.`);
    }
    case "/prep": {
      const prep = await prepStatus(env);
      return reply(prep.length ? prep.map(prepLine).join("\n") + "\n\nLog with /log &lt;item&gt; &lt;amount&gt; [note]" : "No prep items. Add them in profile/prep.yaml.");
    }
    case "/log": {
      const [item, amount, ...note] = rest;
      if (!item || !amount || isNaN(Number(amount))) return reply("Usage: /log &lt;item&gt; &lt;amount&gt; [note]   e.g. /log leetcode 2 two-sum, lru-cache");
      const it = await logPrep(env, item, Number(amount), note.join(" ") || null);
      const st = (await prepStatus(env)).find((p) => p.id === it.id);
      return reply(st ? prepLine(st) : "Logged.");
    }
    case "/discover": {
      await enqueue(env, "discover", {}, `discover:${Date.now()}`);
      return reply("🧭 Exploring adjacent companies and roles — results within ~10 minutes.");
    }
    case "/brief": return sendBrief(env, await loadProfile(env));
    case "/stats": {
      const s = await first<Record<string, number>>(env.DB, `SELECT
        (SELECT COUNT(*) FROM companies) AS companies, (SELECT COUNT(*) FROM jobs) AS jobs,
        (SELECT COUNT(*) FROM jobs WHERE stage='scored') AS scored, (SELECT COUNT(*) FROM applications) AS applications,
        (SELECT COUNT(*) FROM alerts) AS alerts, (SELECT COUNT(*) FROM company_research) AS dossiers,
        (SELECT COUNT(*) FROM research_reports) AS reports, (SELECT COUNT(*) FROM emails) AS emails,
        (SELECT COUNT(*) FROM tasks WHERE status='queued') AS queued, (SELECT COUNT(*) FROM tasks WHERE status='failed') AS failed,
        (SELECT COUNT(*) FROM sponsors) AS sponsors`);
      return reply(Object.entries(s ?? {}).map(([k, v]) => `${k}: <b>${v}</b>`).join("\n"));
    }
    case "/quota": {
      // Last 24 h per provider: requests and tokens used vs. the published free-tier limits.
      const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
      const rows = await new LLM(env).quotaReport();
      const lines = rows.map((r) => {
        const req = `${r.usage.reqDay}${r.quota?.rpd ? `/${r.quota.rpd}` : ""} req`;
        const tok = `${k(r.usage.tokDay)}${r.quota?.tpd ? `/${k(r.quota.tpd)}` : ""} tok`;
        return `<b>${escapeHtml(r.provider)}</b> ${escapeHtml(r.model)} — ${req} · ${tok} <i>(${r.tiers.join(", ")})</i>`;
      });
      return reply(`📊 <b>LLM pool, last 24 h</b>\n${lines.join("\n") || "No providers configured."}`);
    }
    default: return reply(HELP);
  }
}

async function handleCallback(env: Env, cb: NonNullable<Update["callback_query"]>, ctx: ExecutionContext, bot: Bot) {
  const chatId = String(cb.message?.chat.id ?? "");
  if (chatId !== env.TELEGRAM_CHAT_ID) return;
  const [action, a, b] = (cb.data ?? "").split(":");
  const answer = (text: string) => tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text }, bot);
  const setKeyboard = (inline_keyboard: unknown[][]) =>
    cb.message && tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard } }, bot);
  const label = (text: string) => setKeyboard([[{ text, callback_data: "noop" }]]);
  const reasonKeyboard = (prefix: string, id: string) =>
    Object.entries(IGNORE_REASONS).map(([code, text]) => [{ text, callback_data: `${prefix}:${id}:${code}` }]);

  switch (action) {
    // ── Recommendation cards ────────────────────────────────────────────────
    case "apply": {
      const res = await decide(env, a!, "applied");
      if ("already" in res) return answer(`Already ${res.already}`);
      await label("✅ Applying — resume being tailored");
      await answer("Marked as applying ✅");
      const prior = res.priorAtCompany ?? [];
      if (prior.length) {
        await notify(env, `⚠️ You already have ${prior.length} application(s) at this company:\n` +
          prior.map((p) => `• ${escapeHtml(p.title ?? "outreach")} — ${p.status} (${p.created_at.slice(0, 10)})`).join("\n"));
      }
      ctx.waitUntil(runTasksSoon(env).then(() => refill(env)));
      return;
    }
    case "ignore": {
      const res = await decide(env, a!, "ignored");
      if ("already" in res) return answer(`Already ${res.already}`);
      await setKeyboard(reasonKeyboard("why", a!));
      return answer("Skipped — why? (tunes tomorrow's picks)");
    }
    case "why": {
      await decide(env, a!, "ignored", b);
      if (b === "other") {
        await awaitReason(env, "rec", a!);
        await label("❌ Skipped — type your reason as the next message");
        return answer("Type the reason as your next message");
      }
      await label(`❌ Skipped: ${IGNORE_REASONS[b!] ?? b}`);
      await answer("Noted");
      ctx.waitUntil(refill(env));
      return;
    }

    // ── Daily check-in ──────────────────────────────────────────────────────
    case "ck":
    case "ia": {
      const res = await handleCheckin(env, action, a!, b!);
      if (res.keyboard) await setKeyboard(res.keyboard);
      else await label(res.label);
      await answer(res.label);
      if (res.refill && !res.keyboard) ctx.waitUntil(refill(env));
      return;
    }

    // ── Alerts ──────────────────────────────────────────────────────────────
    case "al": {
      if (a === "apply") {
        const res = await decideAlert(env, b!, "applied");
        if ("already" in res) return answer(`Already ${res.already}`);
        await label("✅ Applying — tailored resume coming");
        await answer("Go go go 🏃");
        ctx.waitUntil(runTasksSoon(env));
        return;
      }
      const res = await decideAlert(env, b!, "ignored");
      if ("already" in res) return answer(`Already ${res.already}`);
      await setKeyboard(reasonKeyboard("alwhy", b!));
      return answer("Why not? (tunes future alerts)");
    }
    case "alwhy": {
      await decideAlert(env, a!, "ignored", b);
      if (b === "other") {
        await awaitReason(env, "alert", a!);
        await label("❌ Not for me — type your reason as the next message");
        return answer("Type the reason as your next message");
      }
      await label(`❌ Not for me: ${IGNORE_REASONS[b!] ?? b}`);
      return answer("Noted");
    }

    // ── Deadlines ───────────────────────────────────────────────────────────
    case "dl": {
      const status = a === "d" ? "done" : "dismissed";
      await env.DB.prepare("UPDATE deadlines SET status = ?, updated_at = ? WHERE id = ?").bind(status, nowIso(), b).run();
      return answer(status === "done" ? "✅ Marked done" : "🔕 No more reminders for this one");
    }

    // ── Research & outreach ─────────────────────────────────────────────────
    case "research": {
      await enqueue(env, "research_company", { companyId: a }, `research:${a}:${nowIso().slice(0, 10)}`);
      return answer("🔎 Dossier queued — arrives within ~10 minutes");
    }
    case "outreach": {
      const r = await first<{ outreach: string | null; name: string }>(env.DB,
        `SELECT r.outreach, c.name FROM company_research r JOIN companies c ON c.id = r.company_id
         WHERE r.company_id = ? ORDER BY r.created_at DESC LIMIT 1`, a);
      if (!r?.outreach) return answer("No outreach draft yet");
      await answer("");
      return notify(env, outreachHtml(r.name, JSON.parse(r.outreach) as Outreach), [[{ text: "📤 I sent it", callback_data: `sent:${a}` }]]);
    }
    case "sent": {
      const existing = await first<{ id: string }>(env.DB,
        "SELECT id FROM applications WHERE company_id = ? AND status NOT IN ('rejected','withdrawn') ORDER BY updated_at DESC LIMIT 1", a);
      const appId = existing?.id ?? (await createApplication(env, a!, null, "email-outreach", "telegram"));
      await addApplicationEvent(env, appId, "outreach_sent", null, "telegram");
      await label("📤 Sent — I'll remind you to follow up");
      return answer("Logged as sent");
    }
    case "log": {
      const it = await logPrep(env, a!, Number(b ?? 1), null);
      const st = (await prepStatus(env)).find((p) => p.id === it.id);
      return answer(st ? `${st.title}: ${st.today} ${st.unit} today${st.streak ? ` 🔥${st.streak}` : ""}` : "Logged");
    }
    default:
      return answer("");
  }
}

/** Run light queued tasks right away (instead of waiting for the next 5-minute tick). */
async function runTasksSoon(env: Env) {
  const { tick } = await import("../scheduler");
  await tick(env, { tasksOnly: true });
}
