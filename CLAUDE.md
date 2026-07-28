# Thesis — betathesis.com

A B2C prediction-market portfolio dashboard: a movable-card canvas over the Oddpool prediction-market
API (Kalshi + Polymarket), Guardian/NYT news, Finnhub live prices, and a Dartmouth-hosted Claude for
AI features. Single page (`src/components/MonacoHome.tsx`) rendered at `/`.

**Stack:** Next.js 16 (App Router / Turbopack) · React 19 · TypeScript · Tailwind v4 · Auth.js v5
(Google sign-in, JWT, no DB — state cached in the browser via localStorage).

## Run
- Dev: `npm run dev` (port 3000).
- Prod build: `npm run build` → standalone server at `.next/standalone/server.js` (`output: "standalone"`).
- Typecheck: `npx tsc --noEmit`.

## Env / secrets
All API keys are **server-side only** (used in `src/lib/*` and `src/app/api/*`; never in the client bundle).
They live in `.env.local` (dev) and `.env.production` (prod) — **both gitignored, never commit them**.
The complete required-key list with placeholders is in `.env.production.example`.

## Daily Briefing — the scheduled AI analyst (Claude Managed Agent)
The **Daily Briefing** card (`src/components/ThesisMonitorCard.tsx`; first card, desktop + mobile) is **not**
an on-open LLM call. It reads pre-computed rows from **Turso** (libSQL) that a **Claude Managed Agent (CMA)**
writes once a day. The agent (`thesis-risk-analyst`, Opus 4.8 **medium** effort) runs on a scheduled
deployment (cron `0 8 * * *` America/New_York) plus manual runs, in an Anthropic-hosted sandbox (bash +
Python + web_search/web_fetch), with a persistent memory store and a vault holding the Oddpool + Turso creds.

**How the analysis is generated — ONE agent, TWO phases per run (no separate agent for the portfolio level):**
1. **Per-stock research (shared, deduplicated).** `SELECT DISTINCT ticker FROM holdings` across *all*
   portfolios; for each ticker not already fresh (`assets.researched_at` < ~20h), research it — Oddpool order
   books / whale / odds, Tier-A news, SEC filings, anomaly math — and UPSERT **one** row into the shared
   `assets` table (`verdict`, `risk` 0-100 where higher = more risk, plain-language `rationale`, `signals`
   JSON). One row per ticker, reused by every portfolio that holds it → a stock is never researched twice in a day.
2. **Per-portfolio synthesis (collation).** Once the asset rows are fresh, the **same** agent runs
   `SELECT DISTINCT user_id FROM holdings`; for each portfolio it reads that user's holdings joined to the
   shared `assets` rows, weights by position size, finds cross-holding structure a single stock can't show
   (concentration, shared sector/macro exposure, earnings clusters), and writes **one** plain-language
   overview to `portfolios(user_id, memo, updated_at)`. This is model synthesis over the shared research +
   memory — not a mechanical roll-up of the per-stock verdicts, and not a second agent.

**Turso schema:** `holdings(user_id,ticker,name,weight,thesis)` (the portfolios — written by the app),
`assets(ticker PK, verdict, risk, rationale, signals, researched_at)` (shared per-stock research — written by
the agent), `portfolios(user_id PK, memo, updated_at)` (per-portfolio overview — written by the agent).

**Data flow:** ledger edit → `/api/portfolio/sync` → `holdings`; the agent reads `holdings` and writes
`assets` + `portfolios`; card → `/api/monitor?user=<scope>` → `getLatestMonitor()` (joins a portfolio's
holdings to the shared `assets` and reads its memo) → card, which caches the payload in localStorage and
re-renders only on change. Server-side Turso access lives in `src/lib/turso.ts` (HTTP pipeline API, no deps).

**Ops:** deployment `depl_01J7Jbyi6VZ8fPNs4xfPH4q6`, agent `agent_01QS4br175KMQzgP9h7Rzyir` (memory store +
vault are bound at the deployment). The agent's behaviour *is* its system prompt — edit via
`POST /v1/agents/{id}` (creates a new version), then repoint the deployment. Manual run:
`POST /v1/deployments/{id}/run`. All CMA calls need `anthropic-beta: managed-agents-2026-04-01` +
`ANTHROPIC_API_KEY`; the app needs `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`.

## Push notifications — "your brief is ready" (mobile)  [shipped c617325]
The native iOS app (WKWebView shell) sends a daily push when a user's Daily Brief is generated:
title "Thesis", body "Your brief for today is ready to view.", tap → opens the Brief tab.

**Server/web pieces (this repo):** `push_tokens` table + `turso.ts` helpers · `POST /api/push/register`
(user id from session, 401 for guests) · `PushRegistration.tsx` (mounted in `Providers`) · `?view=` deep
link in `MonacoHome.tsx` · `apns.ts` (APNs HTTP/2 + ES256 JWT) · `POST /api/push/send-brief` (secret-gated,
fresh-brief ≤3h discovery, dedupe, prune dead tokens) · daily Vercel cron 13:30 UTC (`vercel.json`).

**Contracts the native app depends on — DO NOT break:**
- `window.__thesisRegisterPushToken(token, 'ios')` must stay defined (POSTs the APNs token to
  `/api/push/register`; re-sent after sign-in).
- `?view=brief|dashboard|portfolio` on load must switch the mobile tab.
- Alert payload body must stay "Your brief for today is ready to view." with custom key `view: "brief"`.
- `push_tokens.user_id` and the brief join must key off `session.user.id` (the stable Google `sub`), the
  same id `holdings`/`portfolios` use.

**Open follow-ups:**
1. `getFreshBriefPushTargets` treats `portfolios.updated_at` as an ISO string (`Date.parse`). Verify with a
   real send once APNs env is set: `POST /api/push/send-brief` with header `x-push-secret: <PUSH_SEND_SECRET>`
   should return `targets ≥ 1` for a user with a fresh brief. If the agent writes a non-ISO or timezone-less
   timestamp, the 3h freshness window will misbehave.
2. Reliability: the 13:30 UTC cron fires only ~30 min after the 8 AM ET agent in winter (EST); if the agent
   run runs long, those users are missed (cron is one-shot). Consider having the CMA agent POST
   `/api/push/send-brief` at the end of its run, instead of / in addition to the cron.

**Delivery dependency (not code):** real pushes need the PAID Apple Developer account's APNs key. Env
(Prod+Preview): `APNS_KEY` (.p8 text), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` (= the app's bundle id),
`APNS_ENV` (**sandbox** for dev/direct-install builds, **production** for TestFlight/App Store),
`PUSH_SEND_SECRET`, `CRON_SECRET`. Free Apple accounts cannot do push at all.

## 🚀 Deploying / hosting this site
Self-hosted at `https://betathesis.com` on the box **anton** via a Cloudflare Tunnel + systemd.
**If you are the Claude session on anton (or hosting this site): read and follow
[`deploy/ANTON-HOSTING.md`](deploy/ANTON-HOSTING.md)** — a step-by-step runbook (marks which steps you
run vs. which the human must do in a web console). Overview + what's already prepped: `deploy/README.md`.
Note: `.env.production` is gitignored, so `git pull` does NOT bring the secrets — provision it per Step 0
of that runbook (scp from the Mac, or paste values into `.env.production.example`).

## Conventions
- Cards are movable/resizable (`src/components/ui/useMovableCard.ts`), dark "Monaco.com" aesthetic,
  built from the literal card shell (see any `*Card.tsx`). Layout/open-cards/ledger persist to localStorage.
- Data flow: client card → `/api/*` route → `src/lib/<source>.ts` (holds the key) → third-party API.
- Verify UI changes by driving the app, not by asking the user to check.
