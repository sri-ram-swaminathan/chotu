// Quota logic for the LLM pool (src/llm/pool.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDailyLimitMessage, NO_USAGE, quotaBlock, stripThinking } from "../src/llm/pool.ts";

const groq = { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000 };

test("a call that fits passes", () => {
  assert.equal(quotaBlock(groq, NO_USAGE, 4000), null);
  assert.equal(quotaBlock(undefined, { reqMin: 999, tokMin: 9e9, reqDay: 9e9, tokDay: 9e9 }, 4000), null);
});

test("per-minute token limit blocks, but not for the day", () => {
  const b = quotaBlock(groq, { ...NO_USAGE, reqMin: 1, tokMin: 4000, reqDay: 1, tokDay: 4000 }, 4000);
  assert.ok(b && !b.daily && /minute tokens/.test(b.reason));
});

test("daily token limit blocks for the day (with 10% safety margin)", () => {
  const b = quotaBlock(groq, { ...NO_USAGE, reqDay: 45, tokDay: 177_000 }, 4000);
  assert.ok(b?.daily && /daily tokens/.test(b.reason));
});

test("a prompt bigger than the per-minute limit can never fit", () => {
  const b = quotaBlock(groq, NO_USAGE, 9000);
  assert.ok(b && !b.daily && /exceeds/.test(b.reason));
});

test("daily request cap", () => {
  assert.ok(quotaBlock({ rpd: 20 }, { ...NO_USAGE, reqDay: 18 }, 100)?.daily);
  assert.equal(quotaBlock({ rpd: 20 }, { ...NO_USAGE, reqDay: 17 }, 100), null);
});

test("daily-limit 429 messages are recognised", () => {
  assert.ok(isDailyLimitMessage("Rate limit reached for model `openai/gpt-oss-20b` on tokens per day (TPD): Limit 200000"));
  assert.ok(isDailyLimitMessage('{"error":{"message":"Rate limit exceeded: free-models-per-day"}}'));
  assert.ok(!isDailyLimitMessage("Rate limit reached on tokens per minute (TPM): Limit 8000"));
});

test("think tags are stripped", () => {
  assert.equal(stripThinking('<think>hmm\nok</think>\n{"a":1}'), '{"a":1}');
});
