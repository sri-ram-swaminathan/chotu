-- career-ops' scoring system alongside Chotu's fit/interest (src/pipeline/careerOps.ts).
-- All 1-5. comp and culture are NULL when the posting gives no evidence (career-ops never defaults them to 3).
ALTER TABLE scores ADD COLUMN co_global REAL;
ALTER TABLE scores ADD COLUMN co_cv_match REAL;
ALTER TABLE scores ADD COLUMN co_north_star REAL;
ALTER TABLE scores ADD COLUMN co_comp REAL;
ALTER TABLE scores ADD COLUMN co_culture REAL;
ALTER TABLE scores ADD COLUMN co_red_flags REAL;            -- 5 = none, 1 = serious
ALTER TABLE scores ADD COLUMN co_red_flag_notes TEXT;       -- JSON array
ALTER TABLE scores ADD COLUMN co_archetype TEXT;            -- one of scoring.yaml archetypes, or NULL = matches none
ALTER TABLE scores ADD COLUMN co_band TEXT;                 -- strong_apply | apply | maybe | skip
ALTER TABLE scores ADD COLUMN co_decision TEXT;             -- Apply | Consider | Skip | Research first
ALTER TABLE scores ADD COLUMN co_legitimacy TEXT;           -- high | caution | suspicious
ALTER TABLE scores ADD COLUMN co_confidence TEXT;           -- high | medium | low (evidence behind the evaluation)
ALTER TABLE scores ADD COLUMN chotu_combined REAL;          -- Chotu's own fit/interest blend before mixing in career-ops
