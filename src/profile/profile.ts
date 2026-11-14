// The profile is YOUR source of truth: files in profile/ are synced into D1 (table profile_files)
// and parsed here. Every agent reads the profile through this module.
import YAML from "yaml";
import { z } from "zod";
import type { Env } from "../env";
import { all, kvGet } from "../lib/db";
import { BOARD_PROVIDERS } from "../sources/boards";

// ── Schemas: they document the expected shape AND validate it at runtime. ─────
const Bullet = z.union([z.string(), z.object({ text: z.string(), tags: z.array(z.string()).optional() })]);
const Entry = z.object({
  id: z.string(),
  title: z.string().optional(),        // role or project name
  org: z.string().optional(),          // company / university
  location: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  url: z.string().optional(),
  stack: z.string().optional(),        // "Python, PyTorch, xarray" — shown after the title in the LaTeX CV
  tags: z.array(z.string()).optional(),
  bullets: z.array(Bullet).default([]),
});
export type CvEntry = z.infer<typeof Entry>;

export const CvSchema = z.object({
  basics: z.object({
    name: z.string(),
    headline: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    location: z.string().optional(),
    links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
  }),
  summary: z.string().optional(),
  education: z.array(Entry).default([]),
  experience: z.array(Entry).default([]),
  projects: z.array(Entry).default([]),
  skills: z.record(z.array(z.string())).default({}),
  awards: z.array(z.string()).default([]),
});
export type Cv = z.infer<typeof CvSchema>;

export const ConstraintsSchema = z.object({
  graduation: z.string().optional(),
  visa: z
    .object({
      needs_sponsorship: z.boolean().default(true),
      notes: z.string().optional(),
    })
    .default({ needs_sponsorship: true }),
  locations: z
    .object({
      preferred: z.array(z.string()).default([]),
      acceptable: z.array(z.string()).default([]),
      allow_remote: z.boolean().default(true),
      exclude_regions: z.array(z.string()).default([]),
    })
    .default({}),
  seniority: z
    .object({
      exclude_title_words: z.array(z.string()).default([]),
    })
    .default({}),
  // Opportunity kinds you don't want at all (e.g. internship). Postings whose title reads like one
  // ("intern", "stagiair", "werkstudent", "thesis") count as that kind even if the source says "job".
  exclude_kinds: z.array(z.enum(["job", "internship", "phd", "accelerator", "hackathon", "event"])).default([]),
  dealbreaker_phrases: z.array(z.string()).default([]),
  deadlines: z.array(z.object({ date: z.string(), what: z.string() })).default([]),
});
export type Constraints = z.infer<typeof ConstraintsSchema>;

export const ScoringSchema = z.object({
  weights: z.object({ fit: z.number(), interest: z.number() }).default({ fit: 0.5, interest: 0.5 }),
  keywords: z
    .object({
      positive: z.record(z.number()).default({}),
      negative: z.record(z.number()).default({}),
    })
    .default({}),
  min_keyword_score: z.number().default(1),
  // career-ops scoring (src/pipeline/careerOps.ts), computed in the same LLM call as fit/interest.
  career_ops: z
    .object({
      weight: z.number().default(0.5),                 // share of career-ops' global score in the ranking (0-1)
      recommend_min_band: z.enum(["strong_apply", "apply", "maybe", "skip"]).default("maybe"), // never recommend below
      alert_min_band: z.enum(["strong_apply", "apply", "maybe", "skip"]).default("apply"),     // instant pings need this
      research_min_band: z.enum(["strong_apply", "apply", "maybe", "skip"]).default("strong_apply"), // auto dossier
    })
    .default({}),
  // Your target role archetypes (career-ops "North Star"): a posting matching none of them scores north_star 1.
  archetypes: z.array(z.object({ name: z.string(), signals: z.array(z.string()).default([]) })).default([]),
  // What a good culture looks like for you; evidence against it caps the culture dimension at 2/5.
  culture_screen: z.object({ require: z.array(z.string()).default([]) }).default({}),
  research_threshold: z.number().default(7),
  research_per_day: z.number().default(3),     // max automatic company dossiers per day (LLM-hungry)
  llm_scores_per_tick: z.number().default(3),
  // Alert agent: instant pings for fresh postings. Tuned to be rare enough that you act on every one.
  alerts: z
    .object({
      enabled: z.boolean().default(true),
      min_keyword_score: z.number().default(4),   // cheap pre-filter before spending an LLM call
      min_score: z.number().default(6.5),         // combined fit×interest needed to ping you
      max_per_day: z.number().default(8),
      max_age_days: z.number().default(3),        // ignore postings older than this (when the date is known)
    })
    .default({}),
  // Recommender agent: picks the daily 2 from the scored pool, learning from your feedback.
  recommender: z
    .object({
      rerank_with_llm: z.boolean().default(true), // false = pure score ordering
      candidates: z.number().default(8),          // how many top candidates the LLM compares
    })
    .default({}),
});
export type Scoring = z.infer<typeof ScoringSchema>;

export const TargetsSchema = z.object({
  fetch_every_hours: z.number().default(24),   // how often each company's job board is polled
  deadlines: z
    .object({
      remind_days: z.array(z.number()).default([14, 7, 3, 1]),   // ping when a deadline is this many days away
      search_every_days: z.number().default(7),                  // re-check programs whose next deadline is known
    })
    .default({}),
  companies: z
    .array(
      z.object({
        name: z.string(),
        domain: z.string().optional(),
        ats: z.enum(["greenhouse", "lever", "lever-eu", "ashby", "recruitee", "personio", "workable", "workday"]).optional(),
        slug: z.string().optional(),
        search: z.array(z.string()).optional(), // workday only: search terms (default: ML/CV/DL/data science/AI)
        region: z.string().optional(),
        tags: z.array(z.string()).default([]),
        funded_stage: z.string().optional(),
        research: z.boolean().default(false), // queue company research on sync
      }),
    )
    .default([]),
  // Site-wide job boards (src/sources/boards.ts). Each runs once per fetch_every_hours.
  boards: z
    .array(
      z.object({
        provider: z.enum(BOARD_PROVIDERS),
        name: z.string().optional(),
        geo: z.string().optional(),     // jobicy: "netherlands", "europe", …
        pages: z.number().optional(),   // paginated boards: pages of newest postings per run
      }),
    )
    .default([]),
  watch_pages: z
    .array(
      z.object({
        url: z.string(),
        name: z.string().optional(),   // program name for deadlines ("Y Combinator"); defaults to note/hostname
        kind: z.enum(["job", "phd", "accelerator", "hackathon", "event", "companies"]).default("job"),
        every_hours: z.number().default(24),
        note: z.string().optional(),
      }),
    )
    .default([]),
});
export type Targets = z.infer<typeof TargetsSchema>;

export const PrepSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        type: z.string().default("other"),
        title: z.string(),
        unit: z.string().default("sessions"),
        daily_target: z.number().optional(),
        weekly_target: z.number().optional(),
        total_target: z.number().optional(),
        deadline: z.string().optional(),
        active: z.boolean().default(true),
      }),
    )
    .default([]),
});

export interface Profile {
  cv: Cv;
  goals: string;
  constraints: Constraints;
  scoring: Scoring;
  targets: Targets;
  writing: { path: string; content: string }[];
  resumeTemplate: string | null;
  resumeTemplateTex: string | null;   // profile/resume_template.tex — the LaTeX base for tailored CVs
  files: Record<string, string>;
  /** What Chotu has learned about your preferences from companies you flagged and your feedback (kv "beliefs"). */
  beliefs: string;
}

function parseYaml<S extends z.ZodTypeAny>(files: Record<string, string>, path: string, schema: S, fallback: unknown): z.infer<S> {
  const raw = files[path];
  const data = raw ? YAML.parse(raw) ?? fallback : fallback;
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`profile/${path} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

export async function loadProfileFiles(env: Env): Promise<Record<string, string>> {
  const rows = await all<{ path: string; content: string }>(env.DB, "SELECT path, content FROM profile_files");
  return Object.fromEntries(rows.map((r) => [r.path, r.content]));
}

export function parseProfile(files: Record<string, string>): Profile {
  return {
    cv: parseYaml(files, "cv.yaml", CvSchema, { basics: { name: "Unknown" } }),
    goals: files["goals.md"] ?? "",
    constraints: parseYaml(files, "constraints.yaml", ConstraintsSchema, {}),
    scoring: parseYaml(files, "scoring.yaml", ScoringSchema, {}),
    targets: parseYaml(files, "targets.yaml", TargetsSchema, {}),
    writing: Object.entries(files)
      .filter(([p]) => p.startsWith("writing/"))
      .map(([path, content]) => ({ path, content })),
    resumeTemplate: files["resume_template.html"] ?? null,
    resumeTemplateTex: files["resume_template.tex"] ?? null,
    files,
    beliefs: "",
  };
}

export async function loadProfile(env: Env): Promise<Profile> {
  const [files, beliefs] = await Promise.all([loadProfileFiles(env), kvGet(env.DB, "beliefs")]);
  return { ...parseProfile(files), beliefs: beliefs ?? "" };
}

export const bulletText = (b: z.infer<typeof Bullet>): string => (typeof b === "string" ? b : b.text);

/** Compact text version of the profile for LLM prompts (~2-5k tokens). */
export function profileDigest(p: Profile, opts: { includeBullets?: boolean } = { includeBullets: true }): string {
  const entry = (e: CvEntry) =>
    `- [${e.id}] ${[e.title, e.org].filter(Boolean).join(" @ ")} ${e.start ? `(${e.start}–${e.end ?? "now"})` : ""}` +
    (e.tags?.length ? ` tags: ${e.tags.join(", ")}` : "") +
    (opts.includeBullets ? "\n" + e.bullets.map((b) => `    • ${bulletText(b)}`).join("\n") : "");
  const c = p.constraints;
  return [
    `# Candidate: ${p.cv.basics.name}${p.cv.basics.headline ? ` — ${p.cv.basics.headline}` : ""}`,
    p.cv.summary ? `Summary: ${p.cv.summary}` : "",
    `## Education\n${p.cv.education.map(entry).join("\n")}`,
    `## Experience\n${p.cv.experience.map(entry).join("\n")}`,
    `## Projects\n${p.cv.projects.map(entry).join("\n")}`,
    `## Skills\n${Object.entries(p.cv.skills).map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n")}`,
    p.cv.awards.length ? `## Awards\n${p.cv.awards.map((a) => `- ${a}`).join("\n")}` : "",
    `## Goals & interests\n${p.goals.trim()}`,
    p.beliefs ? `## Learned preferences (from companies the candidate flagged + their feedback; weigh these for "interest")\n${p.beliefs.trim()}` : "",
    `## Constraints\nGraduation: ${c.graduation ?? "?"}. Needs visa sponsorship: ${c.visa.needs_sponsorship}. ${c.visa.notes ?? ""}\n` +
      `Preferred locations: ${c.locations.preferred.join(", ")}. Acceptable: ${c.locations.acceptable.join(", ")}. Remote OK: ${c.locations.allow_remote}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A few short writing samples, so outreach drafts sound like you and not like an LLM. */
export function writingSamples(p: Profile, maxChars = 3000): string {
  let out = "";
  for (const w of p.writing) {
    if (out.length > maxChars) break;
    out += `\n--- ${w.path} ---\n${w.content.slice(0, Math.max(0, maxChars - out.length))}\n`;
  }
  return out.trim();
}
