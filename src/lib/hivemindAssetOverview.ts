// Hivemind per-asset overview generation — the short plain-language read shown at the top of each
// holding's card. Extracted from src/app/api/hivemind/asset-overview/route.ts so BOTH the on-open
// client call (that route) AND the server-side page builder (src/lib/hivemindPage.ts) run the exact
// same prompt + parsing, byte-for-byte. Node-only (uses the Anthropic SDK fallback).

import Anthropic from "@anthropic-ai/sdk";

const GATEWAY_BASE = process.env.DARTMOUTH_GATEWAY_BASE || "https://chat.dartmouth.edu/api";
const GATEWAY_MODEL = process.env.DARTMOUTH_MODEL || "anthropic.claude-sonnet-4-5-20250929";

// The per-holding read shown at the top of each asset card. We receive the same per-holding signal
// snapshots the portfolio overview uses; for EACH holding the model writes one plain-language
// paragraph that synthesizes across every signal into a coherent read of where the name stands now.
const SYSTEM = `You are the market analyst behind Thesis's "Hivemind", a portfolio pulse that fuses every signal we track for a user's holdings.

You receive a JSON array "holdings". Each holding carries the signals we track: today's price move, the Wall Street analyst consensus and how many analysts, Reddit buzz with mention counts and a short note on what people are saying, prediction-market implied probabilities, YouTube coverage, news volume with a couple of headlines, and "dailyResearch" from our analyst agent, which is the richest source: a plain-language "rationale" it wrote and an "evidence" object of the concrete facts it pulled (specific price context, news items, analyst targets, filings, etc.).

For EACH holding, write ONE short overview: AT MOST 2 sentences and AT MOST 40 words total. Plain, precise English that lands the single most useful read of where the name stands right now. It is the summary at the top of that holding's card, so make every word earn its place, then stop.

Do NOT catalogue every signal. Pick the ONE or TWO that matter most for this name right now and state only those; a tight one-sentence read beats a full sweep. Omit the rest.

The card ALREADY shows the ticker, the current price, and today's percent change right next to this text. So NEVER restate the price, the day's move, or whether the stock is up or down today; repeating what is already on screen is wasted space. Lead instead with the non-obvious cross-signal read the user cannot see at a glance: where the signals agree or diverge, and what it implies.

Ground everything in real facts from that holding's snapshot, and attribute each fact to its ORIGINAL source, not to us. When a fact comes from dailyResearch, its evidence names the real source: a news outlet (e.g. WSJ, Bloomberg), an analyst firm (e.g. TD Cowen, UBS, KeyBanc), or a named person. Cite THAT specific source and the specific fact. NEVER say "the daily research", "our research", "the analyst agent", "the verdict", or "the research reads/flags/holds up"; the user cares only about the underlying fact and who reported it. Do not invent, imply, or cite any numeric "risk score".

Style rules (these matter more than sounding clever):
- Be tight. No filler, no throat-clearing, no restating the obvious. If a clause does not add a new fact or a real implication, cut it.
- Professional, not casual. Do NOT use anthropomorphic or forum-style phrasing like "Reddit loves X", "the crowd hates Y", "everyone is piling in". Describe sentiment precisely: "Reddit sentiment on the name is strongly bullish", "prediction markets imply a decline".
- Name the specific signals: "Reddit", "prediction markets", "analysts", "the news". Do NOT use vague words like "the crowd", "the market", "the Street", "the tape".
- No trader jargon or slang ("fade", "piling in", "bleeds", "bid"). Plain professional wording.
- State only the numbers that carry weight and are NOT already on the card: mention counts, analyst counts and consensus, implied percentages, specific headlines. Do NOT state the price or the daily percentage move.
- Do NOT editorialize about how much signal there is. Never write meta-commentary like "the signal is thin", "coverage is sparse", "sentiment is mixed", or "little discussion". If a signal is quiet, simply omit it and lean on the signals that carry substance.
- Never use em dashes. Never use the "~" character; write "about" instead.

Return ONLY a JSON object (no prose, no markdown code fences) mapping each ticker EXACTLY as given to its overview string:
{ "TICKER": "<the 2 to 4 sentence overview>", ... }
Every ticker in the input must appear exactly once. Base every statement on the real values in that holding's snapshot; never invent a number or a fact.`;

// Strip code fences and slice to the outermost object before parsing (gateway returns plain text).
function extractJson(s: string): unknown {
  let t = s.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

// No em dashes (turn dash separators into commas, keep numeric ranges as hyphens), no "~", trim.
function clean(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/~\s*/g, "about ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .trim();
}

// Keep the overview short WITHOUT cutting mid-word: prefer the last complete sentence under `max`,
// otherwise fall back to the last whole word. Never emits a dangling fragment like "Benzinga suggeste".
function tighten(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (lastStop > max * 0.5) return slice.slice(0, lastStop + 1).trim();
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim();
}

// Turn the per-holding signal snapshots into a { TICKER: overview } map. Same dual path as the
// portfolio overview: primary is the Dartmouth gateway, falling back to the Anthropic SDK. Returns
// {} when no key is configured or the model output is malformed; THROWS (gateway error, or "No model
// output.") when a key exists but no usable output came back — the calling route maps that to a 502,
// so route behaviour is byte-for-byte identical to before.
export async function generateAssetOverviews(holdings: unknown[]): Promise<Record<string, string>> {
  const dartmouthKey = process.env.DARTMOUTH_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  // No key → empty map (the client keeps skeletons pulsing; the page builder stores no overviews).
  if (!dartmouthKey && !anthropicKey) return {};

  // The set of tickers we expect back, so we only surface overviews for real inputs.
  const wanted = new Set(
    holdings
      .map((h) => (h as { ticker?: unknown })?.ticker)
      .filter((t): t is string => typeof t === "string" && !!t)
      .map((t) => t.toUpperCase()),
  );
  const userMsg = JSON.stringify({ holdings }).slice(0, 14000); // hard cap on prompt size

  let raw = "";
  let gatewayErr = "";
  // Primary: the Dartmouth gateway.
  if (dartmouthKey) {
    try {
      const res = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${dartmouthKey}` },
        body: JSON.stringify({
          model: GATEWAY_MODEL,
          max_tokens: 2500,
          temperature: 0.4,
          tool_choice: "none",
          tools: [],
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: userMsg },
          ],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        raw = data?.choices?.[0]?.message?.content ?? "";
      } else {
        gatewayErr = `gateway ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`;
      }
    } catch (e) {
      gatewayErr = e instanceof Error ? e.message : "gateway request failed";
    }
  }
  // Fallback to the Anthropic SDK when the gateway is unavailable (over budget, down, errored) or absent.
  if (!raw && anthropicKey) {
    const client = new Anthropic({ apiKey: anthropicKey });
    const r = await (client as unknown as { messages: { create: (p: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> } })
      .messages.create({
        model: "claude-opus-4-8",
        max_tokens: 2500,
        system: SYSTEM,
        messages: [{ role: "user", content: userMsg }],
      });
    raw = (r.content || []).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
  }
  if (!raw) {
    throw new Error(gatewayErr || "No model output.");
  }

  // Parse defensively; on malformed output return an empty map (client keeps skeletons pulsing).
  let parsed: Record<string, unknown>;
  try {
    parsed = extractJson(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  const overviews: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed || {})) {
    const ticker = k.toUpperCase();
    if (!wanted.has(ticker)) continue; // only real inputs, never a hallucinated ticker
    const text = tighten(clean(v), 300);
    if (text) overviews[ticker] = text;
  }
  return overviews;
}
