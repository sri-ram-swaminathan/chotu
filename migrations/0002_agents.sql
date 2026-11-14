-- Chotu schema v2: the multi-agent layer (alert agent, visa checks, topic research, check-ins,
-- the conversational orchestrator). Applied with: npm run db:migrate:remote

-- ───────────────────────── Visa checks (search-agent backed) ─────────────────────────
-- The IND register only covers the Netherlands. For everything else (and for established NL
-- companies NOT on the register) the visa agent searches the web and stores a verdict here.
ALTER TABLE companies ADD COLUMN visa_status TEXT;       -- confirmed | likely | unknown | unlikely
ALTER TABLE companies ADD COLUMN visa_evidence TEXT;     -- one-paragraph reasoning + sources
ALTER TABLE companies ADD COLUMN visa_checked_at TEXT;

-- ───────────────────────── Recommendations: check-ins + feedback ─────────────────────────
ALTER TABLE recommendations ADD COLUMN pitch TEXT;              -- "why this, why today" from the recommender
ALTER TABLE recommendations ADD COLUMN reason_note TEXT;        -- free-text reason you typed
ALTER TABLE recommendations ADD COLUMN checkin_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recommendations ADD COLUMN last_checkin_at TEXT;

-- ───────────────────────── Alerts ─────────────────────────
-- Every instant ping the alert agent sent. A job is alerted at most once (UNIQUE).
CREATE TABLE alerts (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  score           REAL,
  source          TEXT,                      -- email:<id> | ats:<name> | watch:<url>
  status          TEXT NOT NULL DEFAULT 'sent', -- sent | applied | ignored
  reason          TEXT,                      -- ignore reason code
  reason_note     TEXT,
  telegram_msg_id INTEGER,
  sent_at         TEXT NOT NULL,
  decided_at      TEXT
);
CREATE INDEX idx_alerts_sent ON alerts(sent_at);

-- ───────────────────────── Topic research reports ─────────────────────────
-- "Research computer-vision companies in defence & aerospace in Poland, top 3 for my profile."
CREATE TABLE research_reports (
  id          TEXT PRIMARY KEY,
  request     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued', -- queued | done | failed
  report      TEXT,                           -- JSON (see src/agents/researchAgent.ts)
  sources     TEXT,                           -- JSON array of URLs
  model       TEXT,
  created_at  TEXT NOT NULL,
  finished_at TEXT
);

-- ───────────────────────── Conversation memory for the orchestrator ─────────────────────────
CREATE TABLE chat_messages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  role     TEXT NOT NULL,     -- user | assistant
  content  TEXT NOT NULL,
  at       TEXT NOT NULL
);

-- ───────────────────────── Task priority ─────────────────────────
-- Alerts must not wait behind a backlog of page fetches: higher priority runs first.
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_tasks_priority ON tasks(status, priority, run_after);
