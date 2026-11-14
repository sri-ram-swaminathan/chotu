// LaTeX helpers for tailored CVs (pure, unit-tested). CV text in profile/cv.yaml is plain text;
// everything is escaped here so a "%" or "&" in a bullet can't break the PDF build.

const MAP: Record<string, string> = {
  "\\": "\\textbackslash{}", "&": "\\&", "%": "\\%", $: "\\$", "#": "\\#", _: "\\_", "{": "\\{", "}": "\\}",
  "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
  "×": "$\\times$", "≥": "$\\geq$", "≤": "$\\leq$", "→": "$\\rightarrow$", "–": "--", "—": "---",
  "“": "``", "”": "''", "‘": "`", "’": "'", "…": "\\ldots{}",
};

/** Escape plain text for LaTeX, character by character (so escapes never get re-escaped). */
export function texEscape(s: string): string {
  let out = "";
  for (const ch of s) out += MAP[ch] ?? ch;
  return out;
}

/** "Feb 2026" + "Aug 2026" → "Feb 2026 -- Aug 2026"; single-month roles show one date. */
export function texDates(start?: string, end?: string): string {
  return [start, end].filter(Boolean).map((d) => texEscape(d!)).join(" -- ");
}
