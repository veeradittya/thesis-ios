// Server-side prediction-market chat agent. Uses the Dartmouth LLM gateway
// (OpenAI-compatible / Open WebUI, model anthropic.claude-sonnet-4-5) with tool-calling
// access to live Oddpool data. All keys stay on the server; the browser hits /api/chat.

import { searchMarkets, getPortfolioMarkets, getWhaleFeed } from "@/lib/oddpool";

const BASE = process.env.DARTMOUTH_GATEWAY_BASE;
const MODEL = process.env.DARTMOUTH_MODEL;

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

const pct = (y: number | null | undefined) => (y == null ? "?" : `${Math.round(y * 100)}%`);

// OpenAI-style function/tool schemas.
const tools = [
  {
    type: "function",
    function: {
      name: "search_markets",
      description:
        "Search live Kalshi + Polymarket prediction markets by free-text query (a company, person, ticker, event, or topic). Returns active markets with YES probability, trading volume, and venue. Use for ANY market or event the user asks about — rate cuts, elections, crypto prices, company milestones, etc.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search terms, e.g. 'Fed rate cut July', 'Tesla largest company', 'Bitcoin 150k'." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_portfolio_markets",
      description:
        "Get the active prediction markets relevant to the user's portfolio holdings, grouped by ticker, with YES probabilities and volumes. Use when the user asks about markets tied to their portfolio overall or to a specific holding they own.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_whale_feed",
      description:
        "Get recent large (>= $1,000) prediction-market trades ('whale' trades) on the user's tracked events, plus 24h volume / trade count / average trade size. Use for questions about whale activity, large trades, or smart-money flow.",
      parameters: { type: "object", properties: {} },
    },
  },
];

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    if (name === "search_markets") {
      const ms = await searchMarkets(String(input?.query ?? ""), 8);
      if (!ms.length) return JSON.stringify({ markets: [], note: "No active markets matched that query." });
      return JSON.stringify({
        markets: ms.map((m) => ({ question: m.question, yes: pct(m.yes), volume: m.volume, venue: m.exchange, market_id: m.market_id })),
      });
    }
    if (name === "get_portfolio_markets") {
      const p = await getPortfolioMarkets();
      return JSON.stringify({
        assetCount: p.assetCount,
        marketCount: p.marketCount,
        assets: p.assets.map((a) => ({
          ticker: a.ticker,
          label: a.label,
          event_count: a.count,
          top_events: a.events.slice(0, 6).map((e) => ({
            event: e.title,
            volume: e.volume,
            outcomes: e.outcomes.map((o) => ({ outcome: o.label, question: o.question, yes: pct(o.yes), volume: o.volume })),
          })),
        })),
      });
    }
    if (name === "get_whale_feed") {
      const w = await getWhaleFeed();
      return JSON.stringify({
        stats: w.stats,
        tracked_events: w.trackedCount,
        recent_trades: w.trades.slice(0, 15).map((t) => ({
          market: t.market_title,
          side: t.taker_side || t.outcome,
          size_usd: t.trade_size_usd,
          price_cents: t.price,
          wallet: t.trader_wallet,
          when: t.timestamp,
        })),
      });
    }
    return JSON.stringify({ error: `unknown tool ${name}` });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : "tool failed" });
  }
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface GwMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
}

async function gateway(messages: unknown[]): Promise<GwMessage> {
  const key = process.env.DARTMOUTH_API_KEY;
  if (!BASE || !MODEL || !key) throw new Error("Dartmouth LLM gateway is not configured (DARTMOUTH_* env).");
  const res = await fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: 0.3, max_tokens: 1024 }),
  });
  if (!res.ok) throw new Error(`Gateway ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const msg = j?.choices?.[0]?.message as GwMessage | undefined;
  if (!msg) throw new Error("Gateway returned no message.");
  return msg;
}

export async function runChat(history: ChatMsg[], portfolio?: string): Promise<{ reply: string }> {
  const system = [
    "You are Thesis Copilot, a sharp prediction-market analyst embedded in the Thesis portfolio dashboard.",
    "You answer questions about prediction markets (Kalshi + Polymarket) using LIVE data from the Oddpool API via your tools.",
    "Today is 2026-06-30. ALWAYS call a tool to get real numbers — never invent probabilities, prices, or volumes.",
    "Quote probabilities as percentages and name the market and venue. Be concise: 2-5 sentences or a short bullet list — this renders in a small chat panel. Use light markdown (bold tickers, bullet lists).",
    "If a tool returns nothing relevant, say so plainly rather than guessing.",
    portfolio ? `The user's portfolio: ${portfolio}` : "The user's portfolio is not loaded yet.",
  ].join("\n");

  const messages: unknown[] = [{ role: "system", content: system }, ...history.map((m) => ({ role: m.role, content: m.content }))];

  for (let i = 0; i < 5; i++) {
    const msg = await gateway(messages);

    if (msg.tool_calls && msg.tool_calls.length) {
      // Echo the assistant's tool request back (clean shape), then append each result.
      messages.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } })),
      });
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {}
        const out = await runTool(tc.function.name, args);
        messages.push({ role: "tool", tool_call_id: tc.id, content: out });
      }
      continue;
    }

    return { reply: (msg.content || "").trim() || "(no response)" };
  }

  return { reply: "I couldn't finish that — it needed too many lookups. Try narrowing the question." };
}
