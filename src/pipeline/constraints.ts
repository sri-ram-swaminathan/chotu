// The profile's hard constraints, as ONE pure function every agent calls.
//
// ingest.ts's triage() applies them to job postings. This module applies the same rules to anything
// else an agent proposes — a company found by the research agent, a startup from a newsletter — so
// "always check against my constraints" holds everywhere, not just in the job pipeline.
//
// Two levels:
//   blockers — never show this (visa explicitly impossible, excluded region, dealbreaker phrase)
//   flags    — show it, but say why it's risky (location outside your list, visa unknown)
// When YOU explicitly ask for something outside your preferences ("companies in Poland"), location
// becomes a flag instead of a blocker: an explicit request beats a standing preference.
import type { Constraints } from "../profile/profile";

export interface ConstraintInput {
  location?: string | null;
  text?: string | null;                 // description / dossier text to scan for dealbreakers
  visa?: string | null;                 // confirmed | likely | unknown | unlikely | blocked
}

export interface ConstraintResult { ok: boolean; blockers: string[]; flags: string[] }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function checkConstraints(c: Constraints, x: ConstraintInput, opts: { explicitLocation?: boolean } = {}): ConstraintResult {
  const blockers: string[] = [];
  const flags: string[] = [];
  const loc = (x.location ?? "").toLowerCase();
  const text = (x.text ?? "").toLowerCase();

  if (c.visa.needs_sponsorship) {
    if (x.visa === "blocked") blockers.push("visa: explicitly no sponsorship");
    else if (x.visa === "unlikely") blockers.push("visa: company unlikely to sponsor");
    else if (!x.visa || x.visa === "unknown") flags.push("visa: unverified");
  }

  if (loc) {
    const excluded = c.locations.exclude_regions.find((r) => new RegExp(`\\b${escapeRe(r.toLowerCase())}\\b`).test(loc));
    const places = [...c.locations.preferred, ...c.locations.acceptable].map((p) => p.toLowerCase());
    const remote = c.locations.allow_remote && /remote/.test(loc);
    if (excluded && !opts.explicitLocation) blockers.push(`location: excluded region "${excluded}"`);
    else if (excluded) flags.push(`location: "${excluded}" is in your excluded regions`);
    else if (places.length && !remote && !places.some((p) => loc.includes(p))) {
      (opts.explicitLocation ? flags : blockers).push(`location: ${x.location} is outside your preferred/acceptable list`);
    }
  }

  const breaker = c.dealbreaker_phrases.find((p) => text.includes(p.toLowerCase()));
  if (breaker) blockers.push(`dealbreaker: "${breaker}"`);

  return { ok: blockers.length === 0, blockers, flags };
}

/** One line for prompts: lets LLM agents reason with the same rules the code enforces. */
export function constraintsDigest(c: Constraints): string {
  return [
    `Needs visa sponsorship: ${c.visa.needs_sponsorship}${c.visa.notes ? ` (${c.visa.notes.trim()})` : ""}`,
    `Preferred locations: ${c.locations.preferred.join(", ") || "any"}; acceptable: ${c.locations.acceptable.join(", ") || "-"}; remote OK: ${c.locations.allow_remote}`,
    `Excluded regions: ${c.locations.exclude_regions.join(", ") || "-"}`,
    `Excluded seniority words: ${c.seniority.exclude_title_words.join(", ") || "-"}`,
    `Dealbreakers: ${c.dealbreaker_phrases.join("; ") || "-"}`,
    c.graduation ? `Graduation: ${c.graduation}` : "",
  ].filter(Boolean).join("\n");
}
