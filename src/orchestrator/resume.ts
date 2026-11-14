// Tailored resumes. The rule: the LLM may only SELECT, REORDER and REWORD bullets that exist in
// profile/cv.yaml. It returns which source bullets each output bullet came from, and we verify it:
//   • unknown entry ids / bullet indexes → dropped
//   • any number in a rewritten bullet that isn't in its source bullets → reverted to the original
// That second check catches the most common LLM resume lie: invented metrics.
// Output: LaTeX rendered into YOUR template (profile/resume_template.tex), opened in Overleaf with one tap,
// plus an HTML version as a quick preview.
import { z } from "zod";
import type { Env } from "../env";
import { first, run } from "../lib/db";
import { escapeHtml, nowIso, truncate, uid } from "../lib/util";
import { LLM } from "../llm/provider";
import { bulletText, profileDigest, type Cv, type CvEntry, type Profile } from "../profile/profile";
import { texDates, texEscape } from "../lib/tex";

const Selected = z.object({
  id: z.string(),
  bullets: z.array(z.object({ from: z.array(z.number().int()).min(1), text: z.string() })),
});
const TailorSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  experience: z.array(Selected),
  projects: z.array(Selected),
  skills: z.record(z.array(z.string())),
});

const numbersIn = (s: string) => s.match(/\d+(?:[.,]\d+)?/g) ?? [];

function verify(sel: z.infer<typeof Selected>[], source: CvEntry[], warnings: string[]) {
  const byId = new Map(source.map((e) => [e.id, e]));
  const order = new Map(source.map((e, i) => [e.id, i]));
  // Keep cv.yaml's order (reverse-chronological), whatever order the LLM returned.
  sel = [...sel].sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  return sel.flatMap((s) => {
    const entry = byId.get(s.id);
    if (!entry) { warnings.push(`dropped unknown entry "${s.id}"`); return []; }
    const bullets = s.bullets.flatMap((b) => {
      const src = b.from.map((i) => entry.bullets[i]).filter((x) => x !== undefined).map(bulletText);
      if (!src.length) { warnings.push(`${s.id}: bullet with invalid source index dropped`); return []; }
      const allowed = new Set(src.flatMap(numbersIn));
      const invented = numbersIn(b.text).filter((n) => !allowed.has(n));
      if (invented.length) {
        warnings.push(`${s.id}: reverted bullet with invented numbers (${invented.join(", ")})`);
        return [src[0]!];
      }
      return [b.text];
    });
    return [{ entry, bullets }];
  });
}

export async function tailorResume(env: Env, profile: Profile, applicationId: string) {
  const app = await first<{ job_id: string | null; title: string | null; description: string | null; company: string }>(
    env.DB,
    `SELECT a.job_id, j.title, j.description, c.name AS company FROM applications a
     JOIN companies c ON c.id = a.company_id LEFT JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
    applicationId,
  );
  if (!app) throw new Error("application not found");
  const research = await first<{ dossier: string }>(env.DB,
    "SELECT dossier FROM company_research WHERE company_id = (SELECT company_id FROM applications WHERE id = ?) ORDER BY created_at DESC LIMIT 1", applicationId);

  const cvIndexed = (entries: CvEntry[]) =>
    entries.map((e) => `[${e.id}] ${e.title ?? ""} @ ${e.org ?? ""}\n${e.bullets.map((b, i) => `  (${i}) ${bulletText(b)}`).join("\n")}`).join("\n");

  const llm = new LLM(env);
  const { data, model } = await llm.json({
    purpose: "tailor_resume",
    tier: "reasoning",
    maxTokens: 6000,
    system: `You tailor a one-page resume for a specific role. You may ONLY use content from the master CV.
For each output bullet give "from": the indexes of the source bullets it is based on, and "text": a tightened rewrite that
mirrors the job's language where truthful. Never add numbers, tools, or claims that are not in the cited source bullets.
Pick the 2-4 most relevant experience entries and 2-3 most relevant projects, max 4 bullets each, most relevant first.
skills: reorder/select the candidate's existing skills by relevance (do not add new ones).`,
    prompt: `JOB: ${app.title ?? "(direct outreach)"} at ${app.company}
${truncate(app.description, 5000)}
${research ? `\nCOMPANY DOSSIER:\n${truncate(research.dossier, 2500)}` : ""}

MASTER CV — EXPERIENCE (id, bullets with indexes):
${cvIndexed(profile.cv.experience)}

MASTER CV — PROJECTS:
${cvIndexed(profile.cv.projects)}

SKILLS: ${JSON.stringify(profile.cv.skills)}
GOALS (context only): ${truncate(profile.goals, 800)}

Return JSON: {headline, summary (2 sentences, only true claims), experience:[{id, bullets:[{from:[int], text}]}], projects:[same], skills:{category:[skill]}}`,
  }, TailorSchema);

  const warnings: string[] = [];
  const experience = verify(data.experience, profile.cv.experience, warnings);
  const projects = verify(data.projects, profile.cv.projects, warnings);
  const allSkills = new Set(Object.values(profile.cv.skills).flat().map((s) => s.toLowerCase()));
  const skills: Record<string, string[]> = {};
  for (const [category, list] of Object.entries(data.skills)) {
    const kept = list.filter((s) => allSkills.has(s.toLowerCase())); // never add skills you didn't list
    if (kept.length) skills[category] = kept;
  }
  const rendered = { headline: data.headline, summary: data.summary, experience, projects, skills };
  const html = renderResume(profile, rendered);
  const tex = profile.resumeTemplateTex ? renderLatex(profile.resumeTemplateTex, rendered) : null;
  const id = uid();
  await run(env.DB, "INSERT INTO resumes(id, application_id, content, html, tex, warnings, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id, applicationId, JSON.stringify(data), html, tex, JSON.stringify(warnings), model, nowIso());
  return { id, warnings, hasTex: !!tex };
}

// ── Rendering ────────────────────────────────────────────────────────────────
interface Rendered {
  headline: string; summary: string;
  experience: { entry: CvEntry; bullets: string[] }[];
  projects: { entry: CvEntry; bullets: string[] }[];
  skills: Record<string, string[]>;
}

const e = escapeHtml;
const section = (items: { entry: CvEntry; bullets: string[] }[]) =>
  items.map(({ entry, bullets }) => `
  <div class="entry">
    <div class="entry-head"><span class="title">${e(entry.title ?? "")}</span>${entry.org ? `<span class="org"> — ${e(entry.org)}</span>` : ""}
      <span class="dates">${e([entry.start, entry.end].filter(Boolean).join(" – "))}</span></div>
    ${entry.location ? `<div class="loc">${e(entry.location)}</div>` : ""}
    <ul>${bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul>
  </div>`).join("");

export function renderResume(profile: Profile, r: Rendered): string {
  const cv: Cv = profile.cv;
  const b = cv.basics;
  const contact = [b.email, b.phone, b.location, ...b.links.map((l) => `<a href="${e(l.url)}">${e(l.label)}</a>`)]
    .filter(Boolean).map((x) => (x!.startsWith("<a") ? x! : e(x!))).join(" · ");
  const education = section(cv.education.map((entry) => ({ entry, bullets: entry.bullets.map(bulletText) })));
  const skills = Object.entries(r.skills).map(([k, v]) => `<div><b>${e(k)}:</b> ${e(v.join(", "))}</div>`).join("");
  const vars: Record<string, string> = {
    name: e(b.name), headline: e(r.headline), contact, summary: e(r.summary),
    experience: section(r.experience), projects: section(r.projects), education, skills,
    awards: cv.awards.map((a) => `<li>${e(a)}</li>`).join(""),
  };
  const template = profile.resumeTemplate ?? DEFAULT_TEMPLATE;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

// ── LaTeX ────────────────────────────────────────────────────────────────────
// The template is your own .tex file. Chotu only replaces three marker lines:
//   %%CHOTU:EXPERIENCE%%   → \section{Experience} + the selected roles
//   %%CHOTU:PROJECTS%%     → \section{Extracurriculars} + the selected hackathons/projects
//   %%CHOTU:SKILLS%%       → the selected skill lines (put fixed lines like certificates after it)
// Everything else (header, education, certificates) stays exactly as you wrote it.
function texEntry(entry: CvEntry, bullets: string[]): string {
  const right = [entry.location ? texEscape(entry.location) : "", texDates(entry.start, entry.end)]
    .filter(Boolean).map((x) => `\\textit{${x}}`).join("\n\n        ");
  const title = `\\textbf{${texEscape(entry.title ?? "")}}${entry.stack ? ` $|$ \\textit{\\small ${texEscape(entry.stack)}}` : ""}`;
  const org = entry.org ? `\n\n            \\textit{${texEscape(entry.org)}}` : "";
  return [
    `        \\begin{twocolentry}{`,
    `        ${right}}`,
    `            ${title}${org}`,
    `        \\end{twocolentry}`,
    ``,
    `        \\vspace{0.05 cm}`,
    `        \\begin{onecolentry}`,
    `            \\begin{highlights}`,
    ...bullets.map((b) => `                \\item ${texEscape(b)}`),
    `            \\end{highlights}`,
    `        \\end{onecolentry}`,
  ].join("\n");
}

const texSection = (heading: string, items: { entry: CvEntry; bullets: string[] }[]) =>
  items.length
    ? `    \\section{${heading}}\n\n${items.map((i) => texEntry(i.entry, i.bullets)).join("\n\n        \\vspace{0.12 cm}\n\n")}\n`
    : "";

export function renderLatex(template: string, r: Rendered): string {
  const skills = Object.entries(r.skills)
    .map(([k, v]) => `            \\textbf{${texEscape(k)}:} ${texEscape(v.join(", "))}`)
    .join("\n\n            \\vspace{0.08 cm}\n");
  // Function replacements: LaTeX is full of "$", which string replacements would interpret.
  return template
    .replace(/^.*%%CHOTU:EXPERIENCE%%.*$/m, () => texSection("Experience", r.experience))
    .replace(/^.*%%CHOTU:PROJECTS%%.*$/m, () => texSection("Extracurriculars", r.projects))
    .replace(/^.*%%CHOTU:SKILLS%%.*$/m, () => skills);
}

const DEFAULT_TEMPLATE = `<!doctype html><html><head><meta charset="utf-8"><title>{{name}} — Resume</title>
<style>body{font:10.5pt/1.35 Georgia,serif;max-width:780px;margin:24px auto;color:#111}h1{margin:0;font-size:20pt}
h2{font-size:11pt;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #999;margin:14px 0 6px}
.entry{margin-bottom:6px}.entry-head{display:flex;gap:4px}.dates{margin-left:auto;color:#555}.title{font-weight:bold}
ul{margin:2px 0 0 18px;padding:0}li{margin:1px 0}.contact{color:#333}@page{margin:14mm}</style></head><body>
<h1>{{name}}</h1><div>{{headline}}</div><div class="contact">{{contact}}</div>
<h2>Summary</h2><p>{{summary}}</p><h2>Experience</h2>{{experience}}<h2>Projects</h2>{{projects}}
<h2>Education</h2>{{education}}<h2>Skills</h2>{{skills}}</body></html>`;
