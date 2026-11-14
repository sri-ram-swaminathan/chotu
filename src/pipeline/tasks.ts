// A durable work queue built on one SQL table.
//
// Why not just do everything inside the cron handler? Because work fails: a site times out,
// Gemini returns 429. With a queue, each unit of work is retried independently with exponential
// backoff, nothing is lost if the Worker is killed mid-run, and you can SEE the backlog in the
// dashboard. This is the core pattern behind "systems that scale": small, idempotent, retryable units.
import type { Env } from "../env";
import { all, run } from "../lib/db";
import { errMsg, nowIso, uid } from "../lib/util";

export type TaskType =
  | "fetch_company"
  | "watch_page"
  | "process_email"
  | "research_company"
  | "tailor_resume"
  | "add_job_url"
  | "discover"
  | "alert_job"        // alert agent: score a fresh posting and ping you if it's good
  | "visa_check"       // visa agent: web-search a company's sponsorship stance
  | "research_topic"   // research agent: open-ended request from chat ("CV companies in Poland…")
  | "hunt_deadlines"   // deadline agent: find the next batch deadline of one accelerator / PhD program
  | "fetch_board"      // a site-wide job board (sources/boards.ts)
  | "like_company";    // you flagged a company: find its board, store your reason, update beliefs

/** Higher runs first. Alerts are time-critical: applying early matters. */
export const PRIORITY: Partial<Record<TaskType, number>> = {
  alert_job: 10, process_email: 9, add_job_url: 8, like_company: 8, research_topic: 6, research_company: 5, visa_check: 4, hunt_deadlines: 3,
};

export interface Task {
  id: string;
  type: TaskType;
  payload: string;
  attempts: number;
}

const MAX_ATTEMPTS = 5;

/** Queue a task. If dedupeKey is given and already exists, this is a no-op (idempotent). */
export async function enqueue(env: Env, type: TaskType, payload: unknown, dedupeKey?: string, runAfter?: string) {
  const now = nowIso();
  await run(
    env.DB,
    `INSERT INTO tasks(id, type, payload, dedupe_key, status, attempts, run_after, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
    uid(), type, JSON.stringify(payload), dedupeKey ?? null, runAfter ?? now, PRIORITY[type] ?? 0, now, now,
  );
}

export type Handler = (env: Env, payload: any) => Promise<void>;

/**
 * Claim and run up to `limit` ready tasks. Heavier task types cost more of the batch budget,
 * which keeps each cron invocation within Cloudflare's per-request subrequest/CPU limits.
 */
export async function runTasks(env: Env, handlers: Record<TaskType, Handler>, limit: number, opts: { types?: TaskType[] } = {}) {
  const cost: Partial<Record<TaskType, number>> = {
    research_company: 4, research_topic: 6, discover: 4, watch_page: 2, tailor_resume: 2, alert_job: 2, visa_check: 2, fetch_company: 2, hunt_deadlines: 3, fetch_board: 3, like_company: 3,
  };
  const ready = await all<Task>(
    env.DB,
    `SELECT id, type, payload, attempts FROM tasks
     WHERE status = 'queued' AND run_after <= ?
       ${opts.types ? `AND type IN (${opts.types.map(() => "?").join(",")})` : ""}
     ORDER BY priority DESC, run_after LIMIT ?`,
    nowIso(), ...(opts.types ?? []), limit * 2,
  );
  // Recover tasks stuck in "running" (the Worker died mid-task). Cron invocations can run up to
  // 15 minutes, so anything still "running" after 20 is dead.
  await run(
    env.DB,
    `UPDATE tasks SET status = 'queued' WHERE status = 'running' AND updated_at < ?`,
    new Date(Date.now() - 20 * 60_000).toISOString(),
  );

  const stats = { done: 0, failed: 0, retried: 0 };
  let budget = limit;
  for (const t of ready) {
    const c = cost[t.type] ?? 1;
    if (c > budget) continue;
    budget -= c;
    // Atomic claim: only one invocation can flip queued → running.
    const claim = await run(env.DB, "UPDATE tasks SET status='running', updated_at=? WHERE id=? AND status='queued'", nowIso(), t.id);
    if (!claim.meta.changes) continue;
    try {
      await handlers[t.type](env, JSON.parse(t.payload));
      await run(env.DB, "UPDATE tasks SET status='done', updated_at=?, last_error=NULL WHERE id=?", nowIso(), t.id);
      stats.done++;
    } catch (e) {
      const attempts = t.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      // Exponential backoff: 2, 4, 8, 16 minutes (+ jitter)
      const delayMs = 2 ** attempts * 60_000 + Math.random() * 30_000;
      await run(
        env.DB,
        "UPDATE tasks SET status=?, attempts=?, last_error=?, run_after=?, updated_at=? WHERE id=?",
        giveUp ? "failed" : "queued", attempts, errMsg(e).slice(0, 1000),
        new Date(Date.now() + delayMs).toISOString(), nowIso(), t.id,
      );
      giveUp ? stats.failed++ : stats.retried++;
    }
    if (budget <= 0) break;
  }
  return stats;
}
