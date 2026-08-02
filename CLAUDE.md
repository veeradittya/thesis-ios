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
`assets(ticker PK, verdict, risk, rationale, signals, analyst_brief, researched_at)` (shared per-stock research —
written by the agent; `analyst_brief` is the succinct plain-language analyst-sentiment line the Analyst Sentiment
card shows, read via `/api/analyst-brief`), `portfolios(user_id PK, memo, updated_at)` (per-portfolio overview —
written by the agent), `theses(user_id, ticker, thesis_text, assumptions, status, status_rationale,
last_reviewed_at, last_alerted_at; PK (user_id,ticker))` (**Thesis Watch** — the agent's working model of each
user's per-stock investment thesis: it decomposes `holdings.thesis` into load-bearing assumptions + leading
indicators, checks them daily, and grades `status` intact|watch|stressed. The brief mentions a thesis ONLY when
it's under stress — silence means intact. Separate from `holdings` on purpose: `holdings` is `INSERT OR REPLACE`d
on every ledger sync, so agent-owned thesis state must not live there), `portfolio_analytics(user_id PK,
analytics, ai_overview, updated_at)` (**Overview tab** — the app writes `analytics`, a JSON snapshot of the
portfolio's modern-portfolio-theory model, on every ledger edit; the agent reads it and writes `ai_overview`,
the plain-language read shown atop the Overview tab. See the Overview section below).

**Data flow:** ledger edit → `/api/portfolio/sync` → `holdings` **and** `portfolio_analytics.analytics` (the
route recomputes the MPT model via `computeFrontier` and stores it); the agent reads `holdings` +
`portfolio_analytics.analytics` and writes `assets` + `portfolios` + `portfolio_analytics.ai_overview`; the
Daily Briefing card → `/api/monitor?user=<scope>` → `getLatestMonitor()` (joins a portfolio's holdings to the
shared `assets` and reads its memo); the Overview tab → `/api/portfolio-analytics?user=<scope>` →
`getPortfolioAnalytics()` (the agent's `ai_overview`, with the client falling back to a deterministic read when
absent). Cards cache their payload in localStorage and re-render only on change. Server-side Turso access lives
in `src/lib/turso.ts` (HTTP pipeline API, no deps).

## Overview tab — the modern-portfolio-theory page (per-user)
The **Overview** sub-tab of the dashboard (`src/components/PortfolioOverview.tsx`, first dash tab) is a pure
client-side render of Markowitz mean-variance theory over the ledger's **weights**: an allocation ring
(asset/sector), a Markowitz efficient frontier (pinch-zoomable), per-asset expected-return/risk/Sharpe, and a
correlation matrix — all computed by `src/lib/portfolioTheory.ts` (`computeFrontier`). The math runs off asset
**weights only** (no shares/price); the illustrative per-asset return/vol/correlation assumptions are
deterministic stand-ins the agent refines. Guests see the fixed demo; signed-in users see their own holdings.
The short plain-language read at the top comes from the agent (`portfolio_analytics.ai_overview`) when present,
else the deterministic `interpretation()` in `portfolioTheory.ts`. **Weight-only model:** every holding carries
a weight (a percent, stored as a 0..1 fraction) — it is the single per-holding input in onboarding and both
editors (`PortfolioLedger.tsx` mobile, `LedgerCard.tsx` desktop); shares/price were removed from the manual
editors (xlsx uploads may still carry them). To regenerate the agent's overview end-to-end the CMA agent's
system prompt (`prompts/thesis-risk-analyst.system.md`) must be redeployed — see that file's PORTFOLIO
ANALYTICS section; deploy via `POST /v1/agents/{id}` then repoint the deployment (same flow as any prompt edit).

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

## Sign-in — Google + Apple, and native one-tap for both
Auth.js v5 (JWT, no DB). Providers in `src/auth.ts`: **Google**, **Apple** (both web OAuth, run inside the
WKWebView), plus two Credentials providers for the smooth in-app flows — **`google-native`** and
**`apple-native`**. The account entry is a chooser (`SignInButtons.tsx`) — mobile shows it on the Account
tab, desktop in a modal — never a single provider directly. All yield ONE identity per person:
`token.sub` = the Google/Apple `sub`, and a native sign-in matches its web counterpart (native + web
Google are one identity; native + web Apple are one identity). Apple's `sub` is a separate namespace, so
an Apple login is a distinct user from the same person's Google login.

**Native Google one-tap** (`google-native`): the iOS shell runs `GIDSignIn` (system account picker,
shares the device Google session → nothing typed), gets a Google **ID token**, and hands it to the
WKWebView. Server verifies it (`src/lib/googleVerify.ts`, Google tokeninfo) and mints our session cookie
*in the webview*. **Native contract — DO NOT break (two halves):**
- Outbound: the "Continue with Google" button (`SignInButtons.tsx`), when
  `window.webkit.messageHandlers.thesisGoogleSignIn` exists, calls its `.postMessage({})` instead of the
  web flow. The shell registers that message handler → runs `GIDSignIn` → then calls the inbound bridge.
  Everywhere the handler is absent (desktop, mobile web) it falls back to web `signIn("google")`.
- Inbound: `window.__thesisNativeGoogleSignIn(idToken) → Promise<boolean>` must stay defined
  (`NativeGoogleSignIn.tsx`, mounted in `Providers`); it calls `signIn("google-native", { idToken })` and
  reloads on success. Resolves `false` on failure so the native side can retry.
- Configure `GIDSignIn` with `serverClientID = AUTH_GOOGLE_ID` so the ID token's `aud` is the web client
  id → the verified `sub` matches web Google sign-in (one identity). Optional `GOOGLE_IOS_CLIENT_ID` env
  also whitelists tokens minted for the iOS client id. No secret needed; the button-based web Google flow
  is unaffected and works without any of this.

**Native Apple** (`apple-native`): Apple's web flow is unreliable in the WKWebView, so in-app the shell
presents the system Apple sheet and hands back a native identity token. Server verifies it
(`src/lib/appleVerify.ts`, jose against Apple's JWKS) and mints our session cookie *in the webview*.
**Native contract — DO NOT break (two halves):**
- Outbound: the "Continue with Apple" button (`SignInButtons.tsx`), when
  `window.webkit.messageHandlers.thesisAppleSignIn` exists, calls its `.postMessage({})` instead of the
  web flow; absent (desktop, mobile web) it falls back to web `signIn("apple")`.
- Inbound: `window.__thesisNativeAppleSignIn({ identityToken, nonce, email?, name? }) → Promise<boolean>`
  must stay defined (`NativeAppleSignIn.tsx`, mounted in `Providers`); it calls `signIn("apple-native",
  …)` and reloads on success (`false` on failure so native can retry). `email`/`name` arrive ONLY on the
  user's first authorization.
- Verification requires `aud === APPLE_NATIVE_AUD` (the app **bundle id**, default `com.betathesis.app`)
  and `sha256hex(nonce) === token.nonce` (native sends the RAW nonce; token carries its SHA-256 hex). NO
  secret/key — native identity tokens are verified against Apple's public keys.

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
