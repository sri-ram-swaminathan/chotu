-- Chotu schema v1. Applied with: npm run db:migrate:remote
-- Conventions: ids are TEXT (random UUIDs) except where noted; timestamps are ISO-8601 strings (UTC).
-- Every UNIQUE constraint below is deliberate: it makes re-running any pipeline step harmless (idempotency).

-- ───────────────────────── Profile ─────────────────────────
-- Raw files from the profile/ folder (cv.yaml, goals.md, ...), synced by scripts/sync-profile.mjs.
CREATE TABLE profile_files (
  path        TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ───────────────────────── Companies ─────────────────────────
CREATE TABLE companies (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL UNIQUE,      -- "Foo B.V." and "foo" collapse to the same row
  domain           TEXT,
  ats              TEXT,                      -- greenhouse | lever | ashby | recruitee | personio | workable
  ats_slug         TEXT,                      -- board token / subdomain on that ATS
  region           TEXT,                      -- e.g. amsterdam, eindhoven, remote-eu
  tags             TEXT,                      -- comma separated, from targets.yaml
  ind_sponsor      INTEGER NOT NULL DEFAULT 0,-- 1 = on the IND recognised-sponsor register
  funded_stage     TEXT,                      -- pre-seed | seed | series-a | ... (manual or researched)
  funding_eur      INTEGER,
  headcount        TEXT,
  source           TEXT NOT NULL DEFAULT 'manual', -- manual | targets | email | discovery | research
  created_at       TEXT NOT NULL,
  last_fetched_at  TEXT
);

-- IND public register (erkende referenten). Kept separate from companies: it has ~10k rows,
-- most of which you'll never care about. We match against it by normalized name.
CREATE TABLE sponsors (
  normalized_name TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kvk             TEXT,
  register        TEXT NOT NULL DEFAULT 'ind-nl',
  imported_at     TEXT NOT NULL
);

-- ───────────────────────── Jobs ─────────────────────────
-- One row per real-world opportunity. kind lets PhDs, accelerators and hackathons share the pipeline.
CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  company_id       TEXT REFERENCES companies(id),
  kind             TEXT NOT NULL DEFAULT 'job',  -- job | internship | phd | accelerator | hackathon | event
  title            TEXT NOT NULL,
  location         TEXT,
  remote           INTEGER NOT NULL DEFAULT 0,
  url              TEXT,
  description      TEXT,
  deadline         TEXT,
  posted_at        TEXT,
  dedupe_key       TEXT NOT NULL UNIQUE,         -- normalized company + title + city
  -- pipeline state machine: new → filtered_out | ranked → scored → recommended → decided
  stage            TEXT NOT NULL DEFAULT 'new',
  filter_reason    TEXT,
  visa             TEXT,                         -- confirmed | likely | unknown | blocked
  keyword_score    REAL,
  first_seen_at    TEXT NOT NULL
);
CREATE INDEX idx_jobs_stage ON jobs(stage);
CREATE INDEX idx_jobs_company ON jobs(company_id);

-- Every place we saw the job (ATS, LinkedIn alert email, newsletter...). Many postings → one job.
CREATE TABLE postings (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  source      TEXT NOT NULL,
  url         TEXT NOT NULL UNIQUE,
  seen_at     TEXT NOT NULL
);

-- Full-text index (BM25) over jobs — the "classic keyword retrieval" option. No vector DB needed yet.
CREATE VIRTUAL TABLE jobs_fts USING fts5(title, description, location, content='jobs', content_rowid='rowid');
CREATE TRIGGER jobs_ai AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, description, location) VALUES (new.rowid, new.title, new.description, new.location);
END;
CREATE TRIGGER jobs_ad AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, description, location) VALUES ('delete', old.rowid, old.title, old.description, old.location);
END;
CREATE TRIGGER jobs_au AFTER UPDATE OF title, description, location ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, description, location) VALUES ('delete', old.rowid, old.title, old.description, old.location);
  INSERT INTO jobs_fts(rowid, title, description, location) VALUES (new.rowid, new.title, new.description, new.location);
END;

-- LLM two-axis evaluation. One row per job (re-scoring overwrites).
CREATE TABLE scores (
  job_id             TEXT PRIMARY KEY REFERENCES jobs(id),
  fit                REAL NOT NULL,   -- 0-10: am I a strong applicant?
  interest           REAL NOT NULL,   -- 0-10: does it match what I want?
  combined           REAL NOT NULL,
  summary            TEXT NOT NULL,
  fit_evidence       TEXT,            -- JSON arrays
  fit_gaps           TEXT,
  interest_evidence  TEXT,
  visa_mention       TEXT,            -- sponsors | no_sponsorship | none
  model              TEXT NOT NULL,
  scored_at          TEXT NOT NULL
);

-- ───────────────────────── Decisions ─────────────────────────
-- The 2-slot rule lives here: the orchestrator only creates rows while COUNT(status='pending') < slots.
CREATE TABLE recommendations (
  id             TEXT PRIMARY KEY,
  job_id         TEXT REFERENCES jobs(id),
  company_id     TEXT REFERENCES companies(id),   -- for pure outreach recs (startup with no posting)
  slot_type      TEXT NOT NULL,                   -- best | explore
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | applied | ignored
  ignore_reason  TEXT,
  telegram_msg_id INTEGER,
  created_at     TEXT NOT NULL,
  decided_at     TEXT
);
CREATE INDEX idx_recs_status ON recommendations(status);
-- A job can only ever be recommended once.
CREATE UNIQUE INDEX idx_recs_job ON recommendations(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE applications (
  id           TEXT PRIMARY KEY,
  job_id       TEXT UNIQUE REFERENCES jobs(id),   -- UNIQUE = you cannot double-apply to the same job
  company_id   TEXT NOT NULL REFERENCES companies(id),
  status       TEXT NOT NULL DEFAULT 'intent',    -- cached latest event type
  channel      TEXT,                              -- portal | email-outreach | referral
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_apps_company ON applications(company_id);

-- Append-only history. Status is derived from the latest event; nothing is ever lost.
CREATE TABLE application_events (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES applications(id),
  type            TEXT NOT NULL,  -- intent | applied | outreach_sent | replied | interview | offer | rejected | withdrawn | note
  note            TEXT,
  source          TEXT,           -- telegram | dashboard | email:<id>
  at              TEXT NOT NULL
);

-- Tailored resumes, always derived from profile/cv.yaml + profile/resume_template.html.
CREATE TABLE resumes (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES applications(id),
  content         TEXT NOT NULL,   -- JSON: the selection/rewrites the LLM made (auditable)
  html            TEXT NOT NULL,
  warnings        TEXT,            -- JSON: guardrail corrections (e.g. invented numbers reverted)
  model           TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_resumes_app ON resumes(application_id, created_at);

-- ───────────────────────── Company research + outreach ─────────────────────────
CREATE TABLE company_research (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  dossier       TEXT NOT NULL,      -- JSON (see src/agents/companyResearch.ts)
  sources       TEXT,               -- JSON array of URLs used
  outreach      TEXT,               -- JSON: { subject, body, recipient_hint, proof_of_work }
  model         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_research_company ON company_research(company_id, created_at);

-- LinkedIn "Connections.csv" export → who do I know where?
CREATE TABLE contacts (
  id               TEXT PRIMARY KEY,
  first_name       TEXT,
  last_name        TEXT,
  company          TEXT,
  normalized_company TEXT,
  position         TEXT,
  url              TEXT UNIQUE,
  email            TEXT,
  connected_on     TEXT
);
CREATE INDEX idx_contacts_company ON contacts(normalized_company);

-- ───────────────────────── Email ─────────────────────────
CREATE TABLE emails (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL UNIQUE,  -- RFC Message-ID or Gmail id: processing is idempotent
  from_addr     TEXT,
  subject       TEXT,
  received_at   TEXT NOT NULL,
  body          TEXT,
  category      TEXT,                  -- job_alert | application_update | opportunity | funding_news | newsletter | noise
  summary       TEXT,
  processed_at  TEXT
);

-- ───────────────────────── Preparation ─────────────────────────
CREATE TABLE prep_items (
  id           TEXT PRIMARY KEY,       -- slug from prep.yaml, e.g. "leetcode"
  type         TEXT NOT NULL,          -- leetcode | book | project | course | other
  title        TEXT NOT NULL,
  unit         TEXT NOT NULL,          -- problems | pages | hours | chapters
  daily_target REAL,
  weekly_target REAL,
  total_target REAL,                   -- e.g. 600 pages in the book
  deadline     TEXT,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE prep_logs (
  id        TEXT PRIMARY KEY,
  item_id   TEXT NOT NULL REFERENCES prep_items(id),
  day       TEXT NOT NULL,             -- YYYY-MM-DD in your timezone
  amount    REAL NOT NULL,
  note      TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX idx_prep_logs_item_day ON prep_logs(item_id, day);

-- ───────────────────────── Infrastructure ─────────────────────────
-- A tiny durable work queue in SQL. The 10-minute cron pulls a batch, runs it, marks it done or
-- schedules a retry with backoff. (Cloudflare Queues would also work; this is free and inspectable.)
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,          -- fetch_company | score_job | research_company | process_email | ...
  payload      TEXT NOT NULL,          -- JSON
  dedupe_key   TEXT UNIQUE,            -- prevents the same task being queued twice
  status       TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  run_after    TEXT NOT NULL,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_tasks_ready ON tasks(status, run_after);

-- LLM usage ledger: enforces the daily budget and shows what the system costs (tokens) per provider.
CREATE TABLE llm_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  day          TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  ok           INTEGER NOT NULL,
  input_chars  INTEGER,
  output_chars INTEGER,
  ms           INTEGER,
  error        TEXT,
  at           TEXT NOT NULL
);
CREATE INDEX idx_llm_calls_day ON llm_calls(day);

-- Observability: one row per cron tick / pipeline run.
CREATE TABLE runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  stats       TEXT,                    -- JSON counters
  error       TEXT
);

-- Small key/value store for cursors and settings (e.g. last Gmail history id).
CREATE TABLE kv (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
