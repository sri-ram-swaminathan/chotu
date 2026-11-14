# Learning Chotu: TypeScript, LangGraph, RAG and "built to scale"

Read the code in this order: each file builds on the previous one, and each starts with a comment explaining *why* it exists.

| # | File | What you learn |
|---|---|---|
| 1 | `src/lib/util.ts` | TypeScript basics: functions, types, regex, pure functions |
| 2 | `migrations/0001_init.sql` | Data modelling: every table, every UNIQUE constraint and why |
| 3 | `src/lib/db.ts` | Talking to SQL safely (bound parameters) |
| 4 | `src/pipeline/visa.ts` + `test/logic.test.ts` | Deterministic rules + unit tests |
| 5 | `src/sources/ats.ts` | Calling external APIs, normalizing messy data into one shape |
| 6 | `src/pipeline/ingest.ts` | The cheap stage of the funnel; batching for platform limits |
| 7 | `src/llm/provider.ts` | Interfaces, fallback chains, budgets, validating LLM output |
| 8 | `src/pipeline/score.ts` | Prompt design with evidence + calibration |
| 9 | `src/agents/emailAgent.ts` | **LangGraph #1**: classification + conditional routing |
| 10 | `src/agents/companyResearch.ts` | **LangGraph #2**: a real agent loop (the LLM picks tools) |
| 11 | `src/agents/discovery.ts` | **LangGraph #3**: a linear "reflect → act" pipeline |
| 12 | `src/pipeline/tasks.ts` + `src/scheduler.ts` | Durable queues, retries, cron |
| 13 | `src/orchestrator/*` | Business rules as code (2 slots, no double-applying), check-ins, the feedback loop |
| 14 | `src/index.ts`, `src/api/routes.ts`, `src/telegram/bot.ts` | HTTP, auth, webhooks, two bots |
| 15 | `src/agents/searchAgent.ts` | **LangGraph #4**: a reusable sub-agent other agents call |
| 16 | `src/agents/visaAgent.ts` + `src/pipeline/constraints.ts` | Layered checks: cheapest evidence first, one rule set everywhere |
| 17 | `src/agents/alertAgent.ts` | Latency vs. cost: cheap gates before LLM calls, priority queues |
| 18 | `src/agents/researchAgent.ts` | **LangGraph #5**: branching graph, deterministic checks between LLM steps |
| 19 | `src/agents/orchestrator.ts` | **LangGraph #6**: a ReAct tool-calling agent — the "multi-agent" glue |

---

## 1. TypeScript in 10 minutes (with examples from this repo)

TypeScript is JavaScript plus **types**: labels that the compiler (`npm run typecheck`) checks before your code ever runs.

```ts
// Variables: const (can't reassign) and let (can). Avoid var.
const slots = 2;
let budget = 300;

// Functions declare parameter and return types.
function truncate(s: string, max: number): string { ... }
// Arrow functions are the same thing, shorter:
const uid = (): string => crypto.randomUUID();

// Interfaces describe the shape of an object.
interface RawJob { company: string; title: string; url: string; location?: string | null }
//                                                              ^ ? = optional, | = "or"

// Union of string literals: the compiler rejects any other value.
type VisaVerdict = "confirmed" | "likely" | "unknown" | "blocked";

// Generics: a type parameter. all<T>() returns T[], so callers get typed rows.
async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]>

// async/await: anything doing I/O (network, database) returns a Promise; `await` waits for it.
const res = await fetch(url);
const data = (await res.json()) as { jobs: RawJob[] };   // `as` = "trust me, it's this shape"
```

**zod** fills the gap that `as` leaves open. Types disappear at runtime, so data from outside (LLM output, HTTP bodies, YAML) has to be **validated**:
```ts
const ScoreSchema = z.object({ fit: z.number().min(0).max(10), summary: z.string() });
type Score = z.infer<typeof ScoreSchema>;      // derive the TS type from the schema: one source of truth
const parsed = ScoreSchema.safeParse(jsonFromLLM);   // { success: true, data } | { success: false, error }
```

Other things you'll see: `?.` (optional chaining: `a?.b` is undefined if `a` is), `??` (fallback for null/undefined), `...` (spread: copy an object or array's contents), and template strings `` `Hello ${name}` ``.

---

## 2. LangGraph: the mental model

An agent framework answers one question: **what runs next?** LangGraph's answer is an explicit graph.

- **State**: one typed object that flows through the graph (`Annotation.Root({...})`).
  - Fields with a **reducer** accumulate. `notes` uses `(a, b) => a.concat(b)`, so each node *appends* notes.
  - Fields without one are simply overwritten.
- **Nodes**: async functions `(state) => Partial<state>`. They return only the fields they change.
- **Edges**: `addEdge("a", "b")` always goes a → b.
- **Conditional edges**: `addConditionalEdges("decide", routerFn, {act: "act", synthesize: "synthesize"})`. The router reads the state and returns the name of the next node.
- **Cycles**: `act → decide → act → …`. This loop is what makes something an *agent*: the LLM decides when it's done. Always cap it (`MAX_AGENT_STEPS`, `recursionLimit`).

The three graphs show the three common shapes:

```
Email (router):        classify ─┬─► extractJobs ──► END        LLM picks a branch once
                                 ├─► applicationUpdate ─► END
                                 └─► …

Research (agent loop): seed ─► decide ⇄ act ─► synthesize ─► contacts ─► outreach ─► END
                                 LLM picks tools until "enough"

Discovery (pipeline):  reflect ─► search ─► extract ─► END    fixed steps, LLM in each

Orchestrator (ReAct):  think ⇄ act ─► END                      LLM picks a TOOL each step; tools wrap
                                                               SQL, the research/visa/search agents, trackers
```

**Multi-agent, concretely.** "Agents" here are just graphs with a clear job and a function you can call.
The orchestrator doesn't share memory with the research agent: it calls a tool that queues a
`research_topic` task, and the research agent reports back to you on its own. Agents communicate through
**function calls** (search agent, visa agent: fast, inline) or the **task queue** (research: slow, durable).
That second pattern is why the system survives timeouts and restarts.

**Tool-calling without provider lock-in.** Native function-calling APIs differ between Gemini, OpenAI and
Workers AI. The orchestrator asks for a JSON action instead (`{"tool": ..., "args": ...}`), validates it
with zod, and feeds validation errors back to the model as the observation. Same trick as
`companyResearch.ts`'s `decide` node, generalised to ~17 tools.

**Design rule used throughout:** LLMs make *judgments* (is this relevant? what should I search?). Code enforces *invariants* (max 2 pending, no double-apply, visa blocked = never shown). `contacts` in the research graph is a plain DB query on purpose: there's no reason to ask an LLM something SQL answers exactly.

What's next to learn: **checkpointers** (persist graph state between runs) and **interrupts** (pause a graph for human approval). Good exercise: make `outreach` interrupt so you approve the draft in Telegram before it's saved. You'd write a small D1-backed checkpointer, since LangGraph.js doesn't ship one for D1.

---

## 3. Why there's no vector database (yet)

RAG = Retrieve relevant context, then Generate with it. Ask what needs retrieving:

| Data | Size | Retrieval used | Why |
|---|---|---|---|
| Your profile | ~5k tokens | **None**: the whole digest goes in the prompt | It fits comfortably; retrieval could only drop relevant facts |
| Jobs | thousands | **SQL filters + keyword score**, then the LLM on the top N | Cheap, explainable, deterministic |
| Job search box | thousands | **SQLite FTS5 / BM25** (`jobs_fts` table) | Real full-text ranking with zero infrastructure |
| Company notes | per run | **None**: notes go straight into the prompt | Already scoped to one company |

**When embeddings earn their place** (via Cloudflare Vectorize + Workers AI `bge` embeddings):
1. **Semantic dedupe**: the same role worded differently on three sites.
2. **Semantic ranking**: "MLOps" should match your "deployment pipeline" project even with zero keyword overlap.
3. **Discovery**: "companies similar to the ones I applied to."

**Measure before you build:**
1. Export ~40 jobs and label them good, ok or bad yourself.
2. Rank them three ways: keyword score, embedding cosine similarity to your profile, and *hybrid* (Reciprocal Rank Fusion: `score = Σ 1/(60 + rank_i)`).
3. Compute precision@10 for each.

If hybrid beats keyword by a meaningful margin, add Vectorize. This is how retrieval decisions get made in industry, and it's a strong interview story.

---

## 4. What "built to scale" means in this codebase

| Principle | Where | Why it matters |
|---|---|---|
| **Idempotency** | UNIQUE on `postings.url`, `jobs.dedupe_key`, `emails.message_id`, `tasks.dedupe_key` | Re-running anything is harmless, so retries are safe |
| **Durable queue + retries with backoff** | `pipeline/tasks.ts` | One failing site or a 429 doesn't break the run; nothing is lost |
| **Cost-aware funnel** | ingest (free) → keyword rank (free) → LLM (budgeted) | 1,300 postings cost ~0 LLM calls before ranking |
| **Batching for platform limits** | `ingestJobs` | D1 allows 50 queries per invocation on free: 300 jobs ≈ 10 batched writes, not 900 queries |
| **Provider pool + quotas** | `llm/provider.ts`, `llm/pool.ts` | Several free providers; each call skips ones that would exceed their RPM/RPD/TPM/TPD (tracked in `llm_calls`) |
| **Validate all untrusted input** | zod on LLM output, API bodies, profile YAML | Bad data fails loudly at the boundary instead of corrupting state |
| **Append-only event log** | `application_events` | Full history; status is derived, never lost |
| **Observability** | `runs`, `llm_calls`, `tasks` tables + System tab | You can see what happened, what it cost, what failed |
| **Schema migrations** | `migrations/` | Database changes are versioned code, not hand edits |
| **Stateless compute** | the Worker keeps nothing in memory | Cloudflare can run it anywhere, any number of copies |
| **Multi-tenant ready (next step)** | — | Add `user_id` to every table and this becomes a product |

---

## 5. Exercises, roughly in order of difficulty

1. Add a new ATS (SmartRecruiters) in `sources/ats.ts` and a unit test for its parser.
2. Use ignore reasons: if you ignore 3+ jobs for "location: X", suggest adding X to `exclude_regions`.
3. Add a "follow-up draft" button that writes a follow-up email for applications stuck at `applied` for 7+ days.
4. Run the BM25-vs-embeddings experiment from §3.
5. Add a LangGraph interrupt for outreach approval (§2).
6. Add `user_id` everywhere and support a second user.
