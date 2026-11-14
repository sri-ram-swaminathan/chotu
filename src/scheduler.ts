// The heartbeat. Cron Triggers call these on a schedule (see wrangler.jsonc):
//   every 5 min  → tick():       queue due fetches, poll Gmail, run a batch of tasks (alerts first), score a few jobs
//   11:00 local  → daily():      brief → check-in on pending suggestions → fill free recommendation slots
//   Mondays      → weekly():     discovery + refresh the IND sponsor register
//
// Agents and where they run:
//   search agent    — called by the others (agents/searchAgent.ts)
//   alert agent     — alert_job tasks, priority 10 (agents/alertAgent.ts)
//   research agent  — research_topic / research_company tasks (agents/researchAgent.ts, companyResearch.ts)
//   visa agent      — inline from recommender/alerts/research, or visa_check tasks (agents/visaAgent.ts)
//   recommender     — daily() and check-in callbacks (orchestrator/recommend.ts)
//   orchestrator    — Telegram chat, inline in the webhook (agents/orchestrator.ts)
import type { Env } from "./env";
import { all, first, kvGet, kvSet, run } from "./lib/db";
import { escapeHtml, errMsg, normalizeCompany, nowIso, truncate } from "./lib/util";
import { processEmail } from "./agents/emailAgent";
import { researchCompany } from "./agents/companyResearch";
import { runDiscovery } from "./agents/discovery";
import { ingestJobs, triage } from "./pipeline/ingest";
import { scoreBacklog } from "./pipeline/score";
import { enqueue, runTasks, type Handler, type TaskType } from "./pipeline/tasks";

// Tasks short enough to run right after a webhook/email (those get ~30 s of background time).
// Research and discovery take minutes → only the cron runner (15 min limit) picks them up.
const LIGHT_TASKS: TaskType[] = ["process_email", "alert_job", "add_job_url", "tailor_resume", "visa_check", "like_company"];
import { loadProfile, type Profile } from "./profile/profile";
import { fetchAts } from "./sources/ats";
import { boardKey, fetchBoard, type BoardConfig } from "./sources/boards";
import { likeCompany } from "./orchestrator/interests";
import { careerOpsLine } from "./pipeline/careerOps";
import { pollGmail } from "./sources/email";
import { refreshIndRegister } from "./sources/ind";
import { addJobFromUrl, watchPage } from "./sources/watch";
import { sendBrief } from "./orchestrator/brief";
import { fillSlots } from "./orchestrator/recommend";
import { tailorResume } from "./orchestrator/resume";
import { notify } from "./telegram/api";
import { overleafUrl, signedResumeUrl } from "./api/auth";
import { queueAlerts, runAlert } from "./agents/alertAgent";
import { runResearchReport } from "./agents/researchAgent";
import { checkVisa } from "./agents/visaAgent";
import { sendCheckin } from "./orchestrator/checkin";
import {
  huntDeadlines, queueDeadlineHunts, sendDeadlineReminders, syncJobDeadlines, syncPersonalDeadlines, type Program,
} from "./agents/deadlineAgent";

function handlers(profile: Profile): Record<TaskType, Handler> {
  return {
    async fetch_company(env, { companyId }: { companyId: string }) {
      const c = await first<{ id: string; name: string; ats: string; ats_slug: string; last_fetched_at: string | null }>(env.DB,
        "SELECT id, name, ats, ats_slug, last_fetched_at FROM companies WHERE id = ?", companyId);
      if (!c) return;
      const target = profile.targets.companies.find((t) => normalizeCompany(t.name) === normalizeCompany(c.name));
      const raws = await fetchAts(c.name, c.ats, c.ats_slug, target?.search);
      const stats = await ingestJobs(env, profile, raws, `ats:${c.ats}`);
      // Postings that appeared since the last poll are news → alert agent. The first crawl is a backlog.
      await queueAlerts(env, profile, stats.jobIds, `ats:${c.name}`, { initialCrawl: !c.last_fetched_at });
      await run(env.DB, "UPDATE companies SET last_fetched_at = ? WHERE id = ?", nowIso(), c.id);
    },

    async fetch_board(env, b: BoardConfig) {
      const raws = await fetchBoard(b);
      // Boards list hundreds of postings from hundreds of companies. Run the free triage first (with a neutral
      // company: visa/sponsor info only exists once the company is stored) and only ingest plausible matches,
      // newest first, so one board can't flood the database or the Worker's per-run query limit.
      const neutral = { ind_sponsor: 0, funded_stage: null, funding_eur: null };
      const keep = raws
        .filter((r) => r.title && r.url && r.company && triage(r, profile, neutral).pass)
        .sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""))
        .slice(0, 25);
      const key = `board_fetched:${boardKey(b)}`;
      const initialCrawl = !(await kvGet(env.DB, key));
      const stats = await ingestJobs(env, profile, keep, `board:${boardKey(b)}`);
      await queueAlerts(env, profile, stats.jobIds, `board:${b.name ?? b.provider}`, { initialCrawl });
      await kvSet(env.DB, key, nowIso());
      console.log(`board ${boardKey(b)}: ${raws.length} listed, ${keep.length} passed triage, ${stats.inserted} new`);
    },

    async like_company(env, p: { input: string; reason: string }) {
      const r = await likeCompany(env, p);
      const lines = [
        `💚 <b>${escapeHtml(r.name)}</b> added to your interests.`,
        r.board ? `📋 Job board found (${r.board.ats}) — its openings are checked daily from now on.`
          : "📋 No public job board found — I'll research it and catch its jobs via boards and email alerts.",
        "🏢 Dossier + outreach ideas queued.",
        r.beliefs ? `\n🧠 <b>Updated beliefs</b>\n${escapeHtml(r.beliefs)}` : "\n🧠 Beliefs will refresh when an LLM is free (/beliefs to check).",
      ];
      await notify(env, lines.join("\n"));
    },

    async watch_page(env, w: { url: string; kind: string }) {
      await watchPage(env, profile, w);
    },

    async process_email(env, { emailId }: { emailId: string }) {
      const notes = await processEmail(env, profile, emailId);
      for (const n of notes) await notify(env, n.text);
    },

    async research_company(env, { companyId, jobId }: { companyId: string; jobId?: string }) {
      const r = await researchCompany(env, profile, companyId, jobId ?? null);
      const d = r.dossier;
      const lines = [
        `🏢 <b>Dossier: ${escapeHtml(r.company.name)}</b>`,
        escapeHtml(d.one_liner),
        `Stage: ${escapeHtml(d.stage)} · ${escapeHtml(d.headcount_estimate)} people · ${escapeHtml(d.hq)}`,
        `🛂 Visa: ${d.visa_assessment.verdict} — ${escapeHtml(truncate(d.visa_assessment.reasoning, 160))}`,
        `Fit ${d.fit_for_me.score}/10 · Interest ${d.interest_for_me.score}/10`,
        d.people.length ? `👤 ${d.people.slice(0, 3).map((p) => `${escapeHtml(p.name)} (${escapeHtml(p.role)})`).join(", ")}` : "",
        r.contacts.length ? `🤝 You know: ${r.contacts.map((c) => escapeHtml(`${c.first_name} ${c.last_name}`)).join(", ")}` : "",
        d.proof_of_work_ideas[0] ? `🛠 ${escapeHtml(d.proof_of_work_ideas[0].title)}` : "",
        d.red_flags.length ? `🚩 ${escapeHtml(d.red_flags.slice(0, 2).join("; "))}` : "",
      ].filter(Boolean);
      await notify(env, lines.join("\n"), r.outreach ? [[{ text: "✉️ Show outreach draft", callback_data: `outreach:${companyId}` }]] : undefined);
    },

    async tailor_resume(env, { applicationId }: { applicationId: string }) {
      const res = await tailorResume(env, profile, applicationId);
      const url = await signedResumeUrl(env, res.id);
      const links = res.hasTex
        ? `<a href="${await overleafUrl(env, res.id)}">Open in Overleaf → PDF</a> · <a href="${await signedResumeUrl(env, res.id, ".tex")}">.tex</a> · <a href="${url}">preview</a>`
        : `<a href="${url}">open</a> (Ctrl+P → Save as PDF)`;
      await notify(env, `📄 Tailored CV ready: ${links}` +
        (res.warnings.length ? `\n🛡 Guardrails fixed ${res.warnings.length} issue(s): ${escapeHtml(res.warnings.slice(0, 3).join("; "))}` : ""));
    },

    async alert_job(env, p: { jobId: string; source?: string }) {
      await runAlert(env, profile, p);
    },

    async visa_check(env, { companyId, location }: { companyId: string; location?: string | null }) {
      await checkVisa(env, companyId, { location, force: true });
    },

    async hunt_deadlines(env, program: Program) {
      await huntDeadlines(env, program);
    },

    async research_topic(env, { reportId }: { reportId: string }) {
      await runResearchReport(env, profile, reportId);
    },

    async discover(env) {
      const r = await runDiscovery(env, profile);
      await notify(env, `🧭 <b>Discovery</b>: ${r.found} companies found, ${r.added} new, ${r.queued} queued for research.
` +
        (r.hypotheses?.observations.length ? `What I noticed: ${escapeHtml(r.hypotheses.observations.slice(0, 2).join(" · "))}
` : "") +
        (r.hypotheses?.adjacent_roles.length ? `Adjacent roles to consider: ${escapeHtml(r.hypotheses.adjacent_roles.join(", "))}` : ""));
    },

    async add_job_url(env, { url, pasted }: { url: string; pasted?: string | null }) {
      try {
        const r = await addJobFromUrl(env, profile, url, pasted ?? undefined);
        const s = await first<{ fit: number; interest: number; summary: string; co_global: number | null; co_band: string | null; co_decision: string | null; co_archetype: string | null; co_legitimacy: string | null }>(env.DB,
          "SELECT fit, interest, summary, co_global, co_band, co_decision, co_archetype, co_legitimacy FROM scores WHERE job_id = ?", r.jobId);
        const co = s?.co_global != null ? `\n📊 career-ops ${escapeHtml(careerOpsLine(s))}` : "";
        await notify(env, `➕ <b>${escapeHtml(r.title)}</b> — ${escapeHtml(r.company)}\n` +
          (r.blocked ? "🔴 Posting rules out visa sponsorship." : `Fit ${s?.fit}/10 · Interest ${s?.interest}/10${co}\n${escapeHtml(s?.summary ?? "")}`) +
          `\nIt's in the pool; /more if you have a free slot.`);
      } catch (e) {
        await notify(env, `⚠️ /add failed: ${escapeHtml(errMsg(e))}`);
        // don't rethrow: a bad URL shouldn't be retried 5 times
      }
    },
  };
}

async function recordRun<T>(env: Env, kind: string, fn: () => Promise<T>): Promise<T | undefined> {
  const res = await run(env.DB, "INSERT INTO runs(kind, started_at) VALUES (?, ?)", kind, nowIso());
  const id = res.meta.last_row_id;
  try {
    const stats = await fn();
    await run(env.DB, "UPDATE runs SET finished_at = ?, stats = ? WHERE id = ?", nowIso(), JSON.stringify(stats ?? {}), id);
    return stats;
  } catch (e) {
    await run(env.DB, "UPDATE runs SET finished_at = ?, error = ? WHERE id = ?", nowIso(), errMsg(e), id);
    return undefined;
  }
}

export async function tick(env: Env, opts: { tasksOnly?: boolean } = {}) {
  return recordRun(env, opts.tasksOnly ? "tick:tasks" : "tick", async () => {
    const profile = await loadProfile(env);
    const stats: Record<string, unknown> = {};

    if (!opts.tasksOnly) {
      // 1. Queue job-board fetches for companies not fetched within fetch_every_hours (default 24).
      //    A few per tick spreads the load across the day.
      const everyMs = profile.targets.fetch_every_hours * 3600_000;
      const bucket = Math.floor(Date.now() / everyMs);
      const due = await all<{ id: string }>(env.DB,
        `SELECT id FROM companies WHERE ats IS NOT NULL AND ats_slug IS NOT NULL
         AND (last_fetched_at IS NULL OR last_fetched_at < ?) ORDER BY last_fetched_at IS NOT NULL, last_fetched_at LIMIT 8`,
        new Date(Date.now() - everyMs).toISOString());
      for (const c of due) await enqueue(env, "fetch_company", { companyId: c.id }, `fetch:${c.id}:${bucket}`);

      // 2. Watched pages, bucketed by their refresh interval.
      const hours = Math.floor(Date.now() / 3600_000);
      for (const w of profile.targets.watch_pages) {
        await enqueue(env, "watch_page", { url: w.url, kind: w.kind }, `watch:${w.url}:${Math.floor(hours / w.every_hours)}`);
      }

      // 2a. Site-wide job boards (targets.yaml `boards`), once per fetch_every_hours each.
      for (const b of profile.targets.boards) {
        await enqueue(env, "fetch_board", b, `board:${boardKey(b)}:${bucket}`);
      }

      // 2b. Deadlines: copy any new ones from opportunities (no LLM) and queue program deadline hunts.
      try {
        stats.deadlines = { synced: await syncJobDeadlines(env), huntsQueued: await queueDeadlineHunts(env, profile) };
      } catch (e) { stats.deadlinesError = errMsg(e); }

      // 3. Gmail polling (only if configured; Email Routing pushes instead).
      try { stats.gmail = await pollGmail(env); } catch (e) { stats.gmailError = errMsg(e); }
    }

    // 4. Work the queue (highest priority first).
    const h = handlers(profile);
    stats.tasks = await runTasks(env, h, Number(env.TICK_BATCH_SIZE), opts.tasksOnly ? { types: LIGHT_TASKS } : {});
    // 4b. Alerts queued DURING this tick (e.g. by an email we just processed) shouldn't wait for the next one.
    stats.alerts = await runTasks(env, h, 4, { types: ["alert_job"] });

    // 5. Score a few of the best keyword-ranked jobs with the LLM.
    if (!opts.tasksOnly) stats.scoring = await scoreBacklog(env, profile, profile.scoring.llm_scores_per_tick);
    return stats;
  });
}

export async function daily(env: Env) {
  return recordRun(env, "daily", async () => {
    const profile = await loadProfile(env);
    await syncPersonalDeadlines(env, profile);
    await syncJobDeadlines(env);
    await sendBrief(env, profile);
    const reminded = await sendDeadlineReminders(env, profile);
    // Ask about yesterday's suggestions BEFORE sending new ones. Answers free slots → replacements arrive.
    const asked = await sendCheckin(env);
    const created = await fillSlots(env);
    return { checkinItems: asked, recommendations: created.length, deadlineReminders: reminded };
  });
}

export async function weekly(env: Env) {
  return recordRun(env, "weekly", async () => {
    await enqueue(env, "discover", {}, `discover:${nowIso().slice(0, 10)}`);
    // The IND page is large; on the free plan this may hit CPU limits — `npm run sync-sponsors` is the fallback.
    let sponsors: number | string;
    try { sponsors = await refreshIndRegister(env); } catch (e) { sponsors = errMsg(e); }
    return { sponsors, discoveryQueued: true };
  });
}
