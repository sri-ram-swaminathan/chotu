// Visa logic is deliberately deterministic (rules, not an LLM): it's a hard constraint,
// so it must be predictable and explainable. The LLM only *adds* a signal (visa_mention)
// when it reads the full description during scoring.

export type VisaMention = "sponsors" | "no_sponsorship" | "none";
export type VisaVerdict = "confirmed" | "likely" | "unknown" | "blocked";

const NEGATIVE = [
  /\b(no|not|unable to|cannot|can't|won't|will not|do not|don't|does not|doesn't)\s+(offer|provide|support|sponsor|arrange)\w*\s+(any\s+)?(visa|work permit|sponsorship|relocation)/i,
  /\b(visa|work permit)\s+sponsorship\s+(is\s+)?(not|un)\s*(available|possible|offered|provided)/i,
  /\bsponsorship\s+is\s+not\s+(available|possible|offered|provided)/i,
  /\bwithout\s+(the\s+)?(need|requirement)\s+(for|of)\s+(visa\s+)?sponsorship/i,
  /\bmust\s+(already\s+)?(have|hold|possess)\s+(a\s+)?(valid\s+)?(the\s+)?(right|permit|authori[sz]ation|eu work permit)\s+to\s+work/i,
  /\b(only|exclusively)\s+(consider|accept)\w*\s+(candidates|applicants)\s+(with|who\s+(have|hold))\s+(a\s+)?(valid\s+)?(eu|eea|dutch|existing)/i,
  /\b(eu|eea)\s+(citizenship|passport|nationality)\s+(is\s+)?required/i,
  /\bnot\s+able\s+to\s+sponsor/i,
];

const POSITIVE = [
  /\bvisa\s+sponsorship\s+(is\s+)?(available|provided|offered|possible)/i,
  /\b(we|will|can)\s+(sponsor|support|arrange|assist with)\s+(your\s+)?(the\s+)?(visa|work permit|relocation)/i,
  /\b(highly skilled migrant|kennismigrant|hsm visa|blue card)\b/i,
  /\brelocation\s+(support|package|assistance)/i,
];

export function visaMentionFromText(text: string | null | undefined): VisaMention {
  if (!text) return "none";
  if (NEGATIVE.some((r) => r.test(text))) return "no_sponsorship";
  if (POSITIVE.some((r) => r.test(text))) return "sponsors";
  return "none";
}

const FUNDED_STAGES = /seed|series|growth|ipo|public|acquired|scale-?up|unicorn/i;

export function visaVerdict(input: {
  mention: VisaMention;
  indSponsor: boolean;
  fundedStage?: string | null;
  fundingEur?: number | null;
}): VisaVerdict {
  if (input.mention === "no_sponsorship") return "blocked";
  if (input.mention === "sponsors" || input.indSponsor) return "confirmed";
  // Funded startups often can (and will, for the right person) become a recognised sponsor.
  if ((input.fundingEur ?? 0) >= 2_000_000 || (input.fundedStage && FUNDED_STAGES.test(input.fundedStage))) return "likely";
  return "unknown";
}

const EARLY_STAGE = /pre-?seed|^seed|angel|bootstrapp|stealth/i;

/**
 * Early-stage = small/young enough that a public sponsorship policy wouldn't exist, so the visa agent
 * uses rules instead of a web search. Everything else counts as "established" and gets searched.
 */
export function isEarlyStage(c: { funded_stage: string | null; headcount: string | null }): boolean {
  if (c.funded_stage && EARLY_STAGE.test(c.funded_stage)) return true;
  const n = Number((c.headcount ?? "").match(/\d+/)?.[0] ?? NaN);
  return Number.isFinite(n) && n > 0 && n <= 30;
}

// The IND register is the DUTCH sponsor register: it only proves sponsorship for jobs in the Netherlands.
// A London or Berlin job at a company with a Dutch entity needs that country's own check.
const NL_MARKERS = /\b(netherlands|nederland|holland|amsterdam|rotterdam|eindhoven|utrecht|delft|den haag|the hague|'s-gravenhage|leiden|groningen|maastricht|heerlen|nijmegen|veldhoven|amersfoort|sassenheim|noordwijk|enschede|wageningen|haarlem|hilversum|maassluis|'s-hertogenbosch|den bosch|arnhem|tilburg|breda|zwolle|almere|schiphol)\b|,\s*nl\b/i;

/** true = in NL, false = clearly elsewhere, null = unknown/remote (benefit of the doubt for NL companies). */
export function isNetherlandsLocation(location: string | null | undefined): boolean | null {
  const loc = (location ?? "").trim();
  if (!loc || /^remote$/i.test(loc)) return null;
  return NL_MARKERS.test(loc);
}
