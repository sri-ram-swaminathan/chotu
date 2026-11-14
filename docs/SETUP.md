# 🛠️ Chotu: full setup & usage guide

Back to the [README](../README.md) · How it works inside: [LEARN.md](LEARN.md)

## Architecture: a team of agents

```
 Sources                     Agents                                         You (Telegram)
 ───────                     ──────                                         ──────────────
 Job boards / ATS APIs ─┐
 Email alerts ──────────┼──► SEARCH AGENT (web search + reading pages) ◄── used by every agent below
 PhD / accelerator pages┤        │
 Startup sites ─────────┘        ▼
                          ingest → filters (visa · location · seniority) → LLM score (fit × interest)
                                 │                                  │
             fresh posting ──────┤                                  ▼
                                 ▼                           RECOMMENDER AGENT ──► 🤖 main bot: 2 picks/day
                          ALERT AGENT ──► 🚨 alert bot:        ▲  (learns from your      ▲ morning check-in:
                          (minutes, not days)  apply now?      │   apply/skip reasons)   │ "did you apply?"
                                                               │                         │
                          VISA AGENT ── every company before it reaches you (IND register → web evidence)
                          RESEARCH AGENT ── "CV companies in defence in Poland, top 3" → report + how-to-help ideas
                                 ▲                                                        │
                                 └──────────────── ORCHESTRATOR (chat) ◄─────────────────┘
                                   "how many applications last week?" · "last 3 suggestions I ignored?"

 Backend (D1): profile · applications + events · alerts · recommendations + reasons · research · prep · emails · logs
```

| Agent | File | Runs |
|---|---|---|
| Search | `src/agents/searchAgent.ts` | called by the others |
| Alert | `src/agents/alertAgent.ts` | on every fresh posting (email alert, ATS poll, watched page), priority queue |
| Research (topic) | `src/agents/researchAgent.ts` | on demand from chat / `/research`; reports in ~5-10 min |
| Research (company) | `src/agents/companyResearch.ts` | dossier + outreach email + proof-of-work idea |
| Visa | `src/agents/visaAgent.ts` | before any recommendation/alert, inside research |
| Recommender | `src/orchestrator/recommend.ts` | daily 11:00 after the check-in, and when you free a slot |
| Orchestrator | `src/agents/orchestrator.ts` | any non-command message to the main bot |
| Email triage / Discovery | `src/agents/emailAgent.ts`, `discovery.ts` | every email / weekly |

## Setup (≈30 minutes)

### 0. Prerequisites
- Node.js 20+ (`winget install OpenJS.NodeJS.LTS`), then `npm install`
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)

### 1. Accounts & keys
| What | Where | Secret name |
|---|---|---|
| Gemini API key (free) | https://aistudio.google.com/apikey | `GEMINI_API_KEY` |
| Telegram bot (main assistant) | Telegram → @BotFather → `/newbot` | `TELEGRAM_BOT_TOKEN` |
| Telegram bot (alerts, optional) | @BotFather → `/newbot` again, e.g. "Chotu Alerts" | `TELEGRAM_ALERT_BOT_TOKEN` |
| Web search for research (free tier, optional but recommended) | https://tavily.com | `TAVILY_API_KEY` |
| Groq API key (free, recommended) | https://console.groq.com/keys | `GROQ_API_KEY` — 3 models × 200K tokens/day |
| OpenRouter API key (free, optional) | https://openrouter.ai/settings/keys | `OPENROUTER_API_KEY` — `:free` models, 50 req/day |
| Extra OpenAI-compatible LLM (optional) | any provider | `FALLBACK_LLM_BASE_URL`, `FALLBACK_LLM_API_KEY`, `FALLBACK_LLM_MODEL` |

### 2. Create the database and deploy
```bash
npx wrangler login
npx wrangler d1 create chotu            # copy the database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler deploy                     # prints your URL: https://chotu.<you>.workers.dev
```
Put that URL in `wrangler.jsonc` → `vars.PUBLIC_URL`, then set secrets:
```bash
npx wrangler secret put API_TOKEN                 # any long random string — your dashboard password
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_ALERT_BOT_TOKEN  # optional: separate bot for instant alerts
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # another random string
npx wrangler secret put TAVILY_API_KEY            # optional
npx wrangler deploy
```

### 3. Connect Telegram
```bash
# PowerShell: $env:CHOTU_URL="https://chotu.<you>.workers.dev"; $env:TELEGRAM_BOT_TOKEN="..."; $env:TELEGRAM_WEBHOOK_SECRET="..."
CHOTU_URL=https://chotu.<you>.workers.dev TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npm run telegram:webhook
```
(Add `TELEGRAM_ALERT_BOT_TOKEN=...` to that command to register the alert bot too.)
Send `/start` to your bot → it replies with your chat id → `npx wrangler secret put TELEGRAM_CHAT_ID`.
If you made an alert bot, open it and press **Start** once so it's allowed to message you.

### 4. Fill in your profile and sync it
Edit the files in `profile/` (start with `cv.yaml`, `goals.md`, `targets.yaml`), then:
```bash
CHOTU_URL=https://chotu.<you>.workers.dev CHOTU_TOKEN=<API_TOKEN> npm run sync-profile
CHOTU_URL=https://chotu.<you>.workers.dev CHOTU_TOKEN=<API_TOKEN> npm run sync-sponsors   # IND register (13k sponsors)
```
Optional: LinkedIn → Settings → Data privacy → *Get a copy of your data* → Connections. Save as
`profile/contacts.csv` (git-ignored) and sync again — research dossiers will show who you know.

### 5. Connect your job-alert inbox (pick one)
- **A. Instant (recommended, needs a ~€10/yr domain on Cloudflare):** Cloudflare dashboard → your domain →
  Email → Email Routing → route `jobs@yourdomain` to the `chotu` Worker. In the Gmail account: Settings →
  Forwarding → forward to `jobs@yourdomain`.
- **B. Free polling:** create an OAuth client in Google Cloud (no billing needed), get a refresh token with
  the Gmail read-only scope via https://developers.google.com/oauthplayground, then set `GMAIL_CLIENT_ID`,
  `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`.

Then subscribe that inbox to alerts from LinkedIn, Welcome to the Jungle, EURAXESS, FindAPhD, Devpost,
YC's Work at a Startup, startup newsletters (funding news becomes company discovery).

### 6. Open the dashboard
`https://chotu.<you>.workers.dev` → paste your `API_TOKEN`. System → *Run tick now* to start immediately.

## Daily use
**Just talk to the main bot.** Anything that isn't a /command goes to the orchestrator, which queries the
backend and dispatches the other agents:
- *How many applications did I make last week?* · *What were the last 3 suggestions I ignored?*
- *Research computer vision companies in defence and aerospace in Poland and give me the top 3 for my profile*
- *Does Picnic sponsor visas?* · *I applied to Mollie today via a referral* · *What's on my prep list?*

**The daily rhythm (11:00):** brief → check-in on yesterday's suggestions (✅ Applied / ⏳ Keep / ❌ Not
applying → why) → new suggestions fill the slots you freed (max 2 new per day). Your reasons shape tomorrow's picks.

**Alerts (any time):** the alert bot pings fresh, high-scoring, visa-checked postings within minutes of the alert
email arriving (or the next ATS poll). ✅ Applying now / ❌ Not for me → why. Tune in `profile/scoring.yaml → alerts`.

| Shortcut | Does |
|---|---|
| ✅ / ❌ buttons | decide on a recommendation or alert (❌ asks why; "✍️ Other" lets you type it) |
| `/recs` `/more` `/checkin` | pending suggestions / fill empty slots now / run the check-in now |
| `/add <url> [pasted text]` | add & score any posting |
| `/research <company>` · `/research <any request>` | dossier + outreach · research-agent report |
| `/apps` · `/status <id> interview` · `/alerts` | trackers |
| `/prep` · `/log leetcode 2` | prep tracker (brief has one-tap +1 buttons) |
| `/like <company or careers URL> — <why>` · `/beliefs` | flag a company you like: its job board is found and tracked, a dossier is queued, and Chotu rewrites its **beliefs** about your preferences (used by scoring, recommendations, research) |
| `/calendar` | deadlines calendar: web page (month + list) and an `.ics` link to subscribe in Google/Apple Calendar |
| `/discover` · `/brief` · `/stats` · `/quota` | creative search · daily brief now · system stats · free LLM quota left |

Scoring: every job gets Chotu's **fit / interest** (0-10) AND **career-ops' rubric** in the same LLM call: CV match,
North Star (your `archetypes` in scoring.yaml), comp, culture (your `culture_screen`), red flags → one global 1-5 score with
career-ops' bands (Strong apply ≥4.5 · Apply ≥4.0 · Maybe ≥3.0 · Skip), plus a posting-legitimacy check ("Research first"
for possible ghost postings). Ranking blends both (`career_ops.weight`); recommendations never go below Maybe, instant
alerts need Apply, automatic dossiers need Strong apply. Port of career-ops' score table: `src/pipeline/careerOps.ts`.

Job sources: company boards in `profile/targets.yaml` (`companies`, incl. ~70 from career-ops' list) plus site-wide
boards (`boards`: Arbeitnow, Landing.jobs, a16z speedrun, Jobicy, Startup Jobs, HN Who is hiring). Board postings
only get stored if they pass the free filters.

Without Telegram: `curl -X POST $CHOTU_URL/api/chat -H "authorization: Bearer $API_TOKEN" -d '{"message":"how many applications last week?"}'`

## Development
```bash
cp .dev.vars.example .dev.vars    # fill in keys
npm run db:migrate:local
npm run dev:offline               # local server without Workers AI (no Cloudflare login needed)
npm run dev                       # full local server (needs `wrangler login`)
npm run sync-profile              # targets localhost by default
npm test && npm run typecheck
```

## Plan limits — be honest with yourself
Everything fits the **free** plan at personal scale, with one caveat: free Workers get **10 ms CPU** and
**50 D1 queries per invocation**. The pipeline is batched to stay small, but big ATS feeds (Elastic: 400+
jobs) and the research agent can exceed that. If you see `exceeded CPU` / `too many queries` errors in
System → Recent runs, the **$5/month Workers Paid** plan (30 s CPU, 1000 queries) removes the problem.

## Known limitations / next steps
- Company ↔ IND matching is by normalized name: "Elastic" ≠ "Elasticsearch B.V.". Add a legal-name alias if needed.
- JavaScript-rendered pages can't be watched with plain `fetch` (use their email alerts instead).
- Research reports and company dossiers run on the 5-minute cron (a webhook only gets ~30 s), so they arrive in ~5-10 minutes.
- Alerts are as fast as their source: email alerts are near-instant; tracked ATS companies are polled every 12 h.
- The visa agent's web check is evidence-based but not legal advice — "unverified" means exactly that.
- `LLM_DAILY_CALL_BUDGET` (300) is shared by scoring, alerts, research and chat. Raise it if you add a paid model.
- Next: embeddings + Vectorize for semantic dedupe/ranking (see LEARN.md §4 for how to evaluate it first).
