// career-ops scoring port (src/pipeline/careerOps.ts) — bands must match career-ops' lib/score-action.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bandForScore, blendScores, careerOpsLine, decisionFor, meetsBand } from "../src/pipeline/careerOps.ts";

test("score bands match career-ops (4.5 / 4.0 / 3.0)", () => {
  assert.equal(bandForScore(5)?.id, "strong_apply");
  assert.equal(bandForScore(4.5)?.id, "strong_apply");
  assert.equal(bandForScore(4.4)?.id, "apply");
  assert.equal(bandForScore(4.0)?.id, "apply");
  assert.equal(bandForScore(3.9)?.id, "maybe");
  assert.equal(bandForScore(3.0)?.id, "maybe");
  assert.equal(bandForScore(2.9)?.id, "skip");
  assert.equal(bandForScore(6), null);
  assert.equal(bandForScore(Number.NaN), null);
});

test("decisions: hard stop → Skip, suspicious → Research first, number unchanged", () => {
  assert.equal(decisionFor(4.6), "Apply");
  assert.equal(decisionFor(3.5), "Consider");
  assert.equal(decisionFor(2), "Skip");
  assert.equal(decisionFor(4.8, { hardStop: true }), "Skip");
  assert.equal(decisionFor(4.8, { suspicious: true }), "Research first");
});

test("band gates", () => {
  assert.ok(meetsBand(4.0, "apply"));
  assert.ok(!meetsBand(3.9, "apply"));
  assert.ok(meetsBand(3.0, "maybe"));
  assert.ok(!meetsBand(null, "maybe"));
});

test("blend: career-ops 1-5 mapped to 0-10 and mixed by weight", () => {
  assert.equal(blendScores(8, 4, 0.5), 8);       // 0.5*8 + 0.5*8
  assert.equal(blendScores(6, 5, 0.5), 8);       // 0.5*6 + 0.5*10
  assert.equal(blendScores(6, null, 0.5), 6);    // not scored yet → Chotu only
  assert.equal(blendScores(6, 5, 0), 6);
  assert.equal(blendScores(6, 5, 1), 10);
});

test("summary line", () => {
  assert.equal(careerOpsLine({ co_global: 4.3, co_band: "apply", co_decision: "Apply", co_archetype: "AI agents engineer" }), "4.3/5 · Apply · 🧭 AI agents engineer");
  assert.match(careerOpsLine({ co_global: 4.6, co_band: "strong_apply", co_decision: "Research first", co_archetype: null, co_legitimacy: "suspicious" }),
    /Strong apply → Research first · 🧭 no target archetype · ⚠️ possible ghost posting/);
  assert.equal(careerOpsLine({ co_global: null, co_band: null, co_decision: null, co_archetype: null }), "");
});
