# Portfolio Chat — feature notes

This branch (`feature/portfolio-chat`) isolates the AI **Chat** feature so it can evolve separately from
`feature/hivemind-live-news`. The two core files are committed here:

- `src/components/HivemindChat.tsx` — the full-screen, streaming chat UI (typewriter pacer, spaced
  paragraphs with **bold** hierarchy, inline images, SVG charts, progressive disclosure, scroll-to-bottom,
  time-of-day greeting, liquid-glass ask bar).
- `src/app/api/hivemind/chat/route.ts` — the backend: Anthropic SDK, **model routing** (a Haiku classifier
  picks Haiku / Sonnet 4.5 / Opus 4.8 by query complexity), a manual tool-use loop with **full data
  access** (prediction markets + whale trades, quotes, analyst ratings + price targets, Reddit/YouTube
  social, news, the daily agent's research + memo, the MPT portfolio analytics, a read-only Turso SQL
  escape hatch, and Tier-A web search), and a **streaming SSE** response. Replies are held to a house style
  (succinct, no bullets, no em dashes, no "~"), can embed news images (`![alt](url)`) and charts
  (`<chart>{...}</chart>`, including the efficient frontier with per-asset + portfolio markers).

## Dependencies (why this was branched off hivemind, not main)
The chat route imports lib changes that live on `feature/hivemind-live-news`:
`src/lib/redditSocial.ts` + `src/lib/youtubeSocial.ts` (the `lean` / `summary` snapshot fields and their
normalizers/filters) and `src/lib/turso.ts` (`readOnlyQuery`, `getNewsOverviews`, the social-row readers).
To build this branch, rebase/merge those lib changes in, or branch this off the hivemind branch.

## Wiring (removed from the hivemind branch — re-apply here when integrating)
1. `src/components/DashboardTabs.tsx`: add `"chat"` to the `DashTab` union and a `{ id: "chat", label: "Chat" }`
   entry to `TABS`.
2. `src/components/MonacoHome.tsx`:
   - `import { HivemindChat } from "@/components/HivemindChat";`
   - render block: `{dashTab === "chat" && <HivemindChat holdings={ledger.holdings} user={monitorUser} />}`
   - add `chat: "chat"` to `DASH_TO_NATIVE`, and `chat: "chat"` to both the `?dash=` deep-link map and the
     `__thesisSetDashTab` map.
3. Backend key: uses `ANTHROPIC_API_KEY` (already in `.env.local`). Optional web search: `TAVILY_API_KEY`.

## Contract (UI ↔ backend)
`POST /api/hivemind/chat` · body `{ messages:[{role,content}], user?, holdings?:[{ticker,name,weight}] }`
· streams SSE events `{t:"d",v}` (text delta) · `{t:"reset"}` (clear preamble) · `{t:"err",v}`.
