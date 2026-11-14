-- 1. Companies YOU flagged as interesting (/like), with your reasoning. Feeds the "beliefs" document
--    (kv 'beliefs'), which every scoring/recommendation/research prompt reads via profileDigest.
CREATE TABLE company_interest (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  reason      TEXT NOT NULL,
  input       TEXT,              -- what you typed (name or URL)
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_company_interest_company ON company_interest(company_id);

-- 2. No more internships (constraints.yaml exclude_kinds: [internship]). Take existing ones out of the pool.
--    Same title patterns as INTERNSHIP_TITLE in src/pipeline/ingest.ts (SQLite has no regex, so LIKE).
UPDATE jobs SET stage = 'filtered_out', filter_reason = 'kind: internship'
WHERE stage IN ('ranked', 'scored')
  AND (kind = 'internship'
    OR ' ' || lower(title) || ' ' LIKE '% intern %'
    OR ' ' || lower(title) || ' ' LIKE '% interns %'
    OR lower(title) LIKE '%internship%'
    OR lower(title) LIKE '%intern,%' OR lower(title) LIKE '%intern)%' OR lower(title) LIKE '%(intern%'
    OR lower(title) LIKE '%stagiair%'
    OR lower(title) LIKE '%afstudeer%'
    OR lower(title) LIKE '%werkstudent%'
    OR lower(title) LIKE '%working student%'
    OR lower(title) LIKE '%thesis%'
    OR lower(title) LIKE '%praktik%');

-- Pending recommendations for those jobs would block one of your 2 daily slots: close them as skipped.
UPDATE recommendations SET status = 'ignored', ignore_reason = 'other', reason_note = 'No longer looking for internships',
  decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'pending' AND job_id IN (SELECT id FROM jobs WHERE filter_reason = 'kind: internship');
