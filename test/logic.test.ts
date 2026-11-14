// Unit tests for the pure, deterministic parts of Chotu. Run: npm test
// (Node runs .ts directly via built-in type stripping — no build step.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeKey, normalizeCompany, normalizeTitle, parseLooseJson } from "../src/lib/util.ts";
import { visaMentionFromText, visaVerdict } from "../src/pipeline/visa.ts";

test("company names normalize across legal suffixes", () => {
  assert.equal(normalizeCompany("Adyen N.V."), normalizeCompany("adyen"));
  assert.equal(normalizeCompany("Picnic Technologies B.V."), "picnic");
  assert.equal(normalizeCompany("Société Générale"), "societe generale");
});

test("titles drop gender markers", () => {
  assert.equal(normalizeTitle("ML Engineer (m/f/d)"), "ml engineer");
  assert.equal(normalizeTitle("Backend Engineer (all genders)"), "backend engineer");
});

test("same job on two sites has the same dedupe key", () => {
  assert.equal(dedupeKey("Mollie B.V.", "Software Engineer (m/f/d)", "Amsterdam, NL"), dedupeKey("Mollie", "Software Engineer", "Amsterdam"));
});

test("explicit no-sponsorship clauses are detected", () => {
  for (const t of [
    "Unfortunately we are unable to offer visa sponsorship for this role.",
    "You must already have the right to work in the Netherlands.",
    "Visa sponsorship is not available.",
    "We do not provide sponsorship.",
  ]) assert.equal(visaMentionFromText(t), "no_sponsorship", t);
});

test("positive sponsorship signals are detected", () => {
  assert.equal(visaMentionFromText("We sponsor your visa as a recognised sponsor (kennismigrant)."), "sponsors");
  assert.equal(visaMentionFromText("Relocation package included"), "sponsors");
  assert.equal(visaMentionFromText("Join our team in Amsterdam!"), "none");
});

test("visa verdict rules", () => {
  assert.equal(visaVerdict({ mention: "no_sponsorship", indSponsor: true }), "blocked"); // explicit text wins
  assert.equal(visaVerdict({ mention: "none", indSponsor: true }), "confirmed");
  assert.equal(visaVerdict({ mention: "none", indSponsor: false, fundedStage: "Series A" }), "likely");
  assert.equal(visaVerdict({ mention: "none", indSponsor: false, fundingEur: 5_000_000 }), "likely");
  assert.equal(visaVerdict({ mention: "none", indSponsor: false }), "unknown");
});

test("LLM JSON parsing tolerates fences and prose", () => {
  assert.deepEqual(parseLooseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseLooseJson('Sure! Here it is: {"a":[1,2]} hope that helps'), { a: [1, 2] });
});

// ── v2: multi-agent layer ────────────────────────────────────────────────────
import { checkConstraints } from "../src/pipeline/constraints.ts";

// Same shape ConstraintsSchema produces (built by hand: profile.ts has runtime imports node can't resolve).
const constraints = {
  visa: { needs_sponsorship: true },
  locations: { preferred: ["amsterdam", "netherlands"], acceptable: ["berlin"], allow_remote: true, exclude_regions: ["united states"] },
  seniority: { exclude_title_words: [] },
  dealbreaker_phrases: ["security clearance required"],
  deadlines: [],
};

test("constraints: visa verdicts block or flag", () => {
  assert.equal(checkConstraints(constraints, { location: "Amsterdam", visa: "confirmed" }).ok, true);
  assert.equal(checkConstraints(constraints, { location: "Amsterdam", visa: "unlikely" }).ok, false);
  assert.deepEqual(checkConstraints(constraints, { location: "Amsterdam" }).flags, ["visa: unverified"]);
});

test("constraints: an explicit location request turns a blocker into a flag", () => {
  const standing = checkConstraints(constraints, { location: "Warsaw, Poland", visa: "likely" });
  assert.equal(standing.ok, false);
  const asked = checkConstraints(constraints, { location: "Warsaw, Poland", visa: "likely" }, { explicitLocation: true });
  assert.equal(asked.ok, true);
  assert.equal(asked.flags.length, 1);
});

test("constraints: dealbreakers and excluded regions always block", () => {
  assert.equal(checkConstraints(constraints, { location: "Berlin", text: "Security clearance required.", visa: "confirmed" }).ok, false);
  assert.equal(checkConstraints(constraints, { location: "Remote - United States", visa: "confirmed" }).ok, false);
  assert.equal(checkConstraints(constraints, { location: "Remote (EU)", visa: "confirmed" }).ok, true);
});

import { isNetherlandsLocation } from "../src/pipeline/visa.ts";

test("IND confirmation only applies to jobs in the Netherlands", () => {
  assert.equal(isNetherlandsLocation("Amsterdam"), true);
  assert.equal(isNetherlandsLocation("Sassenheim, The Netherlands"), true);
  assert.equal(isNetherlandsLocation("Delft, Zuid-Holland, NL"), true);
  assert.equal(isNetherlandsLocation("London, United Kingdom"), false);
  assert.equal(isNetherlandsLocation("Berlin, Germany"), false);
  assert.equal(isNetherlandsLocation(""), null);
  assert.equal(isNetherlandsLocation("Remote"), null);
});
