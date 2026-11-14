-- Deadlines: accelerator batches, PhD calls, hackathons, job closing dates — collected automatically.
-- Sources: watched pages / emails (via jobs.deadline), the deadline hunter (web search per program), and you.
CREATE TABLE deadlines (
  id            TEXT PRIMARY KEY,
  org           TEXT NOT NULL,              -- "Y Combinator", "Antler", "ELLIS"
  org_norm      TEXT NOT NULL,
  title         TEXT NOT NULL,              -- "Spring 2027 batch", "PhD call 2027", "ML Engineer posting closes"
  kind          TEXT NOT NULL,              -- accelerator | phd | hackathon | event | job | personal
  date          TEXT,                       -- YYYY-MM-DD; NULL for rolling admissions
  status        TEXT NOT NULL DEFAULT 'open', -- open | rolling | done | dismissed
  confidence    TEXT NOT NULL DEFAULT 'verified', -- verified (date found in the quoted source) | unverified
  evidence      TEXT,                       -- the sentence the date came from
  source_url    TEXT,
  job_id        TEXT REFERENCES jobs(id),
  reminded_days INTEGER,                    -- smallest reminder threshold already sent (14/7/3/1)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- One deadline per organisation per date: re-finding it from another source updates instead of duplicating.
CREATE UNIQUE INDEX idx_deadlines_org_date ON deadlines(org_norm, date) WHERE date IS NOT NULL;
CREATE UNIQUE INDEX idx_deadlines_org_rolling ON deadlines(org_norm, title) WHERE date IS NULL;
CREATE INDEX idx_deadlines_date ON deadlines(status, date);
