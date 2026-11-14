// ─────────────────────────────────────────────────────────────────────────────
// VISA AGENT — "for established companies, always do a visa check".
//
// Layered, cheapest first (the same funnel idea as the job pipeline):
//   1. IND register hit            → confirmed  (free, authoritative for NL)
//   2. Cached verdict < 60 days    → reuse
//   3. Early-stage startup         → rules only (funded = likely). Startups rarely say anything public
//                                    about sponsorship; the outreach pitch is the way in, not a search.
//   4. Everyone else (established, or size unknown, or outside NL where the IND register says nothing)
//                                  → the SEARCH AGENT looks for evidence, an LLM gives a verdict.
//
// The verdict is stored on the company (companies.visa_status) and used by the recommender,
// the alert agent and the research agent. "unlikely" companies are never recommended.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod";
import type { Env } from "../env";
import { first, run } from "../lib/db";
import { nowIso, truncate } from "../lib/util";
import { LLM } from "../llm/provider";
import { isEarlyStage, isNetherlandsLocation, visaVerdict } from "../pipeline/visa";

export { isEarlyStage };
import { searchAndExtract } from "./searchAgent";

export type CompanyVisa = "confirmed" | "likely" | "unknown" | "unlikely";

interface CompanyRow {
  id: string; name: string; domain: string | null; region: string | null; ind_sponsor: number;
  funded_stage: string | null; funding_eur: number | null; headcount: string | null;
  visa_status: string | null; visa_evidence: string | null; visa_checked_at: string | null;
}

const VisaAnswer = z.object({
  verdict: z.enum(["confirmed", "likely", "unknown", "unlikely"]),
  reasoning: z.string(),
});

const FRESH_MS = 60 * 86_400_000;

export async function checkVisa(
  env: Env, companyId: string, opts: { location?: string | null; force?: boolean } = {}, llm = new LLM(env),
): Promise<{ status: CompanyVisa; evidence: string; searched: boolean }> {
  const c = await first<CompanyRow>(env.DB, "SELECT * FROM companies WHERE id = ?", companyId);
  if (!c) throw new Error(`company ${companyId} not found`);

  const save = async (status: CompanyVisa, evidence: string, searched: boolean) => {
    await run(env.DB, "UPDATE companies SET visa_status = ?, visa_evidence = ?, visa_checked_at = ? WHERE id = ?",
      status, truncate(evidence, 1500), nowIso(), companyId);
    return { status, evidence, searched };
  };

  // The IND register only covers jobs in the Netherlands; for a job elsewhere, check that country instead.
  const outsideNL = isNetherlandsLocation(opts.location) === false;
  if (c.ind_sponsor && !outsideNL) return save("confirmed", "Listed on the IND public register of recognised sponsors (erkende referenten).", false);

  const cachedFromIND = (c.visa_evidence ?? "").startsWith("Listed on the IND");
  if (!opts.force && !(outsideNL && cachedFromIND) && c.visa_status && c.visa_checked_at && Date.now() - Date.parse(c.visa_checked_at) < FRESH_MS) {
    return { status: c.visa_status as CompanyVisa, evidence: c.visa_evidence ?? "", searched: false };
  }

  if (isEarlyStage(c)) {
    const v = visaVerdict({ mention: "none", indSponsor: false, fundedStage: c.funded_stage, fundingEur: c.funding_eur });
    return save(v === "likely" ? "likely" : "unknown",
      `Early-stage startup (${c.funded_stage ?? c.headcount ?? "small"}): no public sponsorship policy expected. ` +
      (v === "likely" ? "Funded, so it can become a recognised sponsor for the right hire — pitch directly." : "Unfunded/unknown funding — sponsorship is a real risk."), false);
  }

  const where = opts.location || c.region || "";
  const nl = /netherlands|nederland|amsterdam|rotterdam|eindhoven|utrecht|delft|leiden|hague|haag/i.test(where);
  const queries = [
    `${c.name} visa sponsorship ${where}`.trim(),
    nl ? `${c.name} erkend referent IND kennismigrant` : `${c.name} relocation work permit international candidates`,
  ];
  const { data, sources } = await searchAndExtract(env, {
    goal: `Does ${c.name}${c.domain ? ` (${c.domain})` : ""} sponsor work visas / work permits for non-EU hires${where ? ` in ${where}` : ""}?`,
    queries, readTop: 1,
    purpose: "visa_check",
    instruction: `You assess whether a company sponsors work visas for a non-EU graduate${where ? ` in ${where}` : ""}.
confirmed = public evidence they sponsor (careers page, job ads mentioning visa/relocation support, on a government sponsor register, Blue Card hires).
likely = large international employer with many foreign hires but no explicit statement.
unlikely = explicit statements that they don't sponsor, or roles require citizenship / security clearance${nl ? ", or an established Dutch company that is NOT a recognised IND sponsor" : ""}.
unknown = not enough evidence.`,
    schema: VisaAnswer,
    jsonShape: `{"verdict": "confirmed"|"likely"|"unknown"|"unlikely", "reasoning": "2-3 sentences citing the evidence"}`,
  }, llm);
  return save(data.verdict, `${data.reasoning}${sources.length ? `\nSources: ${sources.slice(0, 3).join(" ")}` : ""}`, true);
}

/** Badge text used in Telegram cards. */
export const VISA_BADGE: Record<string, string> = {
  confirmed: "🟢 sponsor", likely: "🟡 likely", unknown: "⚪ unverified", unlikely: "🔴 unlikely", blocked: "🔴 no sponsorship",
};
