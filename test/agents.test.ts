// Pure helpers from the agent layer. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeSelect } from "../src/lib/sqlGuard.ts";
import { toTelegramHtml } from "../src/lib/util.ts";
import { isEarlyStage } from "../src/pipeline/visa.ts";

test("orchestrator SQL guard allows single SELECT/WITH", () => {
  assert.equal(safeSelect("SELECT COUNT(*) FROM applications;"), "SELECT COUNT(*) FROM applications");
  assert.ok(safeSelect("with x as (select 1) select * from x"));
});

test("orchestrator SQL guard rejects writes, DDL and stacked statements", () => {
  for (const q of [
    "DELETE FROM jobs",
    "SELECT 1; DROP TABLE jobs",
    "UPDATE applications SET status='offer'",
    "PRAGMA table_info(jobs)",
    "SELECT * FROM jobs WHERE id IN (SELECT 1) ; insert into kv values (1,2)",
    "WITH x AS (DELETE FROM jobs RETURNING *) SELECT * FROM x",
  ]) assert.throws(() => safeSelect(q), undefined, q);
});

test("LLM answers are escaped for Telegram but keep **bold**", () => {
  assert.equal(toTelegramHtml("**3** apps <script>"), "<b>3</b> apps &lt;script&gt;");
});

test("early-stage detection for the visa agent", () => {
  assert.equal(isEarlyStage({ funded_stage: "Seed", headcount: null }), true);
  assert.equal(isEarlyStage({ funded_stage: "pre-seed", headcount: null }), true);
  assert.equal(isEarlyStage({ funded_stage: null, headcount: "12" }), true);
  assert.equal(isEarlyStage({ funded_stage: "Series B", headcount: "250" }), false);
  assert.equal(isEarlyStage({ funded_stage: null, headcount: "unknown" }), false);
});

import { texDates, texEscape } from "../src/lib/tex.ts";

test("LaTeX escaping keeps CV text safe", () => {
  assert.equal(texEscape("R&D: 100% on C# & x_1"), String.raw`R\&D: 100\% on C\# \& x\_1`);
  assert.equal(texEscape("LLM × Law, GPA ≥ 9.0"), String.raw`LLM $\times$ Law, GPA $\geq$ 9.0`);
  assert.equal(texEscape(String.raw`a\b {c}`), String.raw`a\textbackslash{}b \{c\}`);
  assert.equal(texDates("Feb 2026", "Aug 2026"), "Feb 2026 -- Aug 2026");
  assert.equal(texDates("Aug 2026"), "Aug 2026");
});

import { daysUntil, evidenceMentionsDate, parseIsoDate } from "../src/lib/dates.ts";

test("deadline evidence must actually contain the date", () => {
  assert.ok(evidenceMentionsDate("Applications for the Spring 2027 batch close on March 1st.", "2027-03-01"));
  assert.ok(evidenceMentionsDate("Deadline: 1 Mar 2027 (23:59 CET)", "2027-03-01"));
  assert.ok(evidenceMentionsDate("apply before 01/03/2027", "2027-03-01"));
  assert.ok(evidenceMentionsDate("deadline 2027-03-01", "2027-03-01"));
  assert.ok(!evidenceMentionsDate("Applications close in early March.", "2027-03-01"));
  assert.ok(!evidenceMentionsDate("Deadline: 11 March 2027", "2027-03-01"));
  assert.ok(!evidenceMentionsDate("Deadline: March 15", "2027-03-01"));
  assert.ok(!evidenceMentionsDate(null, "2027-03-01"));
});

test("date helpers", () => {
  assert.equal(parseIsoDate("2027-02-30"), null);
  assert.equal(daysUntil("2026-11-25", "2026-11-11"), 14);
  assert.equal(daysUntil("2026-11-10", "2026-11-11"), -1);
});
