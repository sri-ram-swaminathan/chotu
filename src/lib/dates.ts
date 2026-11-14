// Date helpers for deadlines (pure, unit-tested — no imports).
//
// The deadline hunter asks an LLM for a date AND the sentence it came from. We only trust the date
// ("verified") if that sentence actually contains it — the same no-guessing rule career-ops'
// closing-soon.mjs uses: a date we can't tie to the source is flagged, never silently believed.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "2027-03-01" → Date at UTC noon (avoids timezone off-by-one), or null if not a real calendar date. */
export function parseIsoDate(iso: string | null | undefined): Date | null {
  const m = (iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, 12));
  return d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]! ? d : null;
}

/** Whole days from `today` (YYYY-MM-DD) to `iso`; negative = overdue. */
export function daysUntil(iso: string, today: string): number {
  const a = parseIsoDate(iso), b = parseIsoDate(today);
  if (!a || !b) return NaN;
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * Does `evidence` mention the calendar date `iso`? Accepts the forms deadlines are written in:
 * 2027-03-01 · 1 March 2027 · March 1st · Mar 1 · 1 Mar · 01/03/2027 · 3/1/2027 · 1.3.2027
 */
export function evidenceMentionsDate(evidence: string | null | undefined, iso: string): boolean {
  const d = parseIsoDate(iso);
  if (!d || !evidence) return false;
  const text = evidence.toLowerCase();
  if (text.includes(iso)) return true;
  const day = d.getUTCDate(), month = d.getUTCMonth() + 1;
  const full = MONTHS[month - 1]!, abbr = full.slice(0, 3);
  const dayRe = `0?${day}(?:st|nd|rd|th)?`;
  const named = new RegExp(`(?<!\\d)${dayRe}\\s+(?:of\\s+)?(?:${full}|${abbr})\\b|\\b(?:${full}|${abbr})\\.?\\s+${dayRe}(?!\\d)`);
  if (named.test(text)) return true;
  const mm = `0?${month}`, dd = `0?${day}`;
  const numeric = new RegExp(`(?<!\\d)(?:${dd}[/.-]${mm}|${mm}[/.-]${dd})[/.-](?:\\d{4}|\\d{2})(?!\\d)`);
  return numeric.test(text);
}
