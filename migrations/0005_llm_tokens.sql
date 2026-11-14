-- LLM pool: track tokens per call so the router can respect each free provider's tokens/minute and
-- tokens/day limits (Groq's 200K tokens/day per model is the binding limit, not its request count).
ALTER TABLE llm_calls ADD COLUMN tokens INTEGER;

-- Backfill old rows with a ~4 chars/token estimate so today's usage isn't under-counted after deploy.
UPDATE llm_calls SET tokens = CASE WHEN ok = 1 THEN (COALESCE(input_chars, 0) + COALESCE(output_chars, 0)) / 4 ELSE 0 END;

-- The router reads the last 24 h of the ledger before every call.
CREATE INDEX idx_llm_calls_at ON llm_calls(at);
