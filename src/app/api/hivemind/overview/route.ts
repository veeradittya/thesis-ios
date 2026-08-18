import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const maxDuration = 60;

const GATEWAY_BASE = process.env.DARTMOUTH_GATEWAY_BASE || "https://chat.dartmouth.edu/api";
const GATEWAY_MODEL = process.env.DARTMOUTH_MODEL || "anthropic.claude-sonnet-4-5-20250929";

// The Hivemind top-of-page read. The client hands us a compact JSON snapshot of the portfolio and,
// per holding, every signal we score. The model's job is EDITORIAL: a short headline naming the day's
// real story, plus a few terse key points that each expand to a fuller explanation on tap.
const SYSTEM = `You are the market analyst behind Thesis's "Hivemind", a portfolio pulse that fuses every signal we track for a user's holdings.

You receive a JSON snapshot of one user's portfolio: an overall pulse, and per holding the signals we track. Per holding these include: today's price move, the Wall Street analyst consensus and how many analysts, Reddit buzz with mention counts and a short note on what people are saying, prediction-market implied probabilities, YouTube coverage, news volume with a couple of headlines, and "dailyResearch" from our analyst agent, which is the richest source: a plain-language "rationale" it wrote and an "evidence" object of the concrete facts it actually pulled (specific price context, news items, analyst targets, filings, etc.).

Ground everything in real facts, and attribute each fact to its ORIGINAL source, not to us. When a fact comes from the dailyResearch, its evidence names the real source: a news outlet (e.g. WSJ, Bloomberg), an analyst firm (e.g. TD Cowen, UBS, KeyBanc), or a named person (e.g. Gary Black). Cite THAT specific source and the specific fact (the real news item, price target, or number). NEVER say "the daily research", "our research", "the analyst agent", "the verdict", or "the research reads/flags/holds up" - the user does not care about our internal pipeline, only the underlying fact and who reported it. A bare label like "the verdict is weak" or "the research holds up" is meaningless on its own; state the actual fact and its source instead. Do not invent, imply, or cite any numeric "risk score"; we do not provide one and such a number would not be reliable.

Return ONLY a JSON object (no prose, no markdown code fences) of exactly this shape:
{
  "headline": "<the single most interesting or non-obvious insight across all the signals, as a short phrase of 4 to 10 words>",
  "points": [
    {
      "short": "<a 5 to 9 word label with enough context to stand on its own, not a cryptic fragment>",
      "action": "<the single implied move for the user on this, EXACTLY one of: Add, Trim, Fade, Watch, Hold. Fade = the crowd is hot but the reliable signals point the other way. Omit if genuinely no move is implied.>",
      "detail": "<one or two sentences, 15 to 35 words, explaining it with specific tickers and numbers>",
      "facts": [{ "text": "<a comprehensive, self-contained fact: the specific numbers, the context, and what it indicates>", "url": "<optional source link for THIS fact, copied verbatim from this holding's sources list; omit entirely if none of the provided sources is where this fact comes from>" }]
    }
  ]
}

The headline is the hardest and single most important part, and it is where you must use the most judgment. It MUST reveal something the user could not figure out just by glancing at today's prices. Never state the biggest gainer, decliner, or mover, or any single obvious price fact; the user can already see that on any chart and it is worthless here. Instead, hunt across EVERY signal for the one non-obvious, counter-intuitive insight that could actually help them act before it becomes obvious to everyone: a divergence where the crowd and the smart money disagree, a name where sentiment and the numbers point opposite ways, an overlooked or early signal, or a likely mispricing. Think like an investor hunting for an edge, weigh the whole picture, and pull out the single most revealing thing across the portfolio.

Then write it in plain, precise, simple English that anyone understands at a glance. This matters more than sounding clever:
- Name the specific signals involved. Say "Reddit", "prediction markets", "analysts", "the daily research". Do NOT use vague words like "the crowd", "the market", "the Street", "contracts", or "the tape".
- No trader jargon or slang. Do NOT use words like "fade", "piling in", "bleeds", "bid", "conviction". Use everyday words a normal person would.
- Prefer a clear sentence structure: a subject, what is happening, and the twist. It should read like a plain statement, not a headline pun.
- Good (non-obvious and precise): "Reddit loves Google, but prediction markets expect it to fall", "Nvidia has the most analyst coverage but the quietest Reddit", "Analysts back Amazon while prediction markets quietly bet against it". Bad (obvious price facts or vague/jargony): "Microsoft is today's biggest decliner", "MSFT fell 3%", "Portfolio looks constructive", "Markets fade GOOGL even as Reddit piles in".

Points rules:
- 3 or 4 points, ordered by TRADE VALUE: the most decision-useful first.
- Every point must be simple, powerful, and ACTIONABLE. It has to help the user decide to buy, add, trim, hold, or watch a specific name. Before writing a point, ask "what could this make or save me?" The best points surface a likely mispricing, an under-appreciated catalyst or risk, or a divergence that points to a DIRECTION (for example the crowd is piling into a name that prediction markets are quietly betting will fall, so the odds say fade the hype).
- Do NOT write descriptive trivia with no trade implication. "Nvidia has the most analyst coverage but the quietest Reddit" is useless, it tells the user nothing they can act on. If a point would not change how someone positions the stock, cut it.
- Be concrete: name the ticker, the number, and what it implies for the position. Keep it tight, no filler.
- "short" is a clear, punchy label that carries the trade angle (about 5 to 9 words), plain words, no jargon. "detail" explains the setup and why it matters for a decision in a sentence or two.
- Each holding may include a "sources" list of real links (Reddit threads, news articles, research sources). For each fact, if one of that holding's sources is where the fact comes from, attach its "url" copied VERBATIM from that list. NEVER invent, guess, shorten, or modify a URL, and never attach a url that is not in the provided sources; omit "url" entirely when no provided source fits (for example price or prediction-market facts).
- "facts" are the evidence behind the point, revealed at the deepest drill-down level, and they must be COMPREHENSIVE. Each fact stands on its own and gives the full picture: the specific numbers, the context around them, and what they indicate, in a complete sentence (or two). NEVER write a thin, label-only fact like "Nvidia's research verdict holds up" or "Apple is on watch"; restating a bare label conveys nothing and is useless. Instead lean on the signals that carry real substance and spell them out. Good facts: "Reddit logged 248 mentions of Google from 212 different users this week, by far the most of any holding, driven by talk of a new Berkshire stake.", "Across 11 prediction markets, the implied odds lean to the downside for Google, effectively betting against the Reddit enthusiasm.", "70 analysts cover Google with an overall Buy consensus, yet the daily research only rates it 'watch', its middle grade, so the professional signals are mixed." Pull the real data from the snapshot: the actual Reddit discussion topics and mention or voice counts, the specific prediction-market questions and their implied percentages, exact price moves, analyst counts and consensus, and specific news headlines. Every fact must be a real value from the snapshot.
- Never use em dashes anywhere. Output only the JSON object.`;

// Strip code fences and slice to the outermost object before parsing (gateway returns plain text).
function extractJson(s: string): unknown {
  let t = s.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

// No em dashes (turn dash separators into commas, keep numeric ranges as hyphens), trim.
function clean(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .trim()
    .slice(0, max);
}

export async function POST(req: Request) {
  const dartmouthKey = process.env.DARTMOUTH_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  // No key → return nulls so the client silently keeps its deterministic read (no error surfaced).
  if (!dartmouthKey && !anthropicKey) return NextResponse.json({ headline: null, points: null });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const snapshot = (body as { snapshot?: unknown })?.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return NextResponse.json({ error: "snapshot is required." }, { status: 400 });
  }
  const userMsg = JSON.stringify(snapshot).slice(0, 12000); // hard cap on prompt size

  try {
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
            max_tokens: 2000,
            temperature: 0.4, // enough room to find the angle, low enough to stay plain and precise
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
          max_tokens: 2000,
          system: SYSTEM,
          messages: [{ role: "user", content: userMsg }],
        });
      raw = (r.content || []).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
    }
    if (!raw) {
      return NextResponse.json({ error: gatewayErr || "No model output." }, { status: 502 });
    }

    // Parse defensively; on any malformed output fall back to nulls (client keeps its deterministic read).
    let parsed: { headline?: unknown; points?: unknown };
    try {
      parsed = extractJson(raw) as { headline?: unknown; points?: unknown };
    } catch {
      return NextResponse.json({ headline: null, points: null });
    }
    // Allowlist of URLs actually present in the snapshot — a fact may only link to one of these, so the
    // model cannot hallucinate a source. (Normalize by stripping any trailing punctuation.)
    const stripUrl = (u: string) => u.trim().replace(/[.,;)\]]+$/, "");
    const allowedUrls = new Set((userMsg.match(/https?:\/\/[^\s"'<>)]+/g) || []).map(stripUrl));

    const headline = clean(parsed.headline, 90) || null;
    const points = (Array.isArray(parsed.points) ? parsed.points : [])
      .map((p) => {
        const o = p as { short?: unknown; detail?: unknown; facts?: unknown; action?: unknown };
        const ACTIONS = ["Add", "Trim", "Fade", "Watch", "Hold"];
        const action = typeof o.action === "string" && ACTIONS.includes(o.action) ? o.action : undefined;
        const facts = (Array.isArray(o.facts) ? o.facts : [])
          .map((f): { text: string; url?: string } | null => {
            if (typeof f === "string") {
              const t = clean(f, 260);
              return t ? { text: t } : null;
            }
            const fo = f as { text?: unknown; url?: unknown };
            const text = clean(fo.text, 260);
            if (!text) return null;
            const url = typeof fo.url === "string" && allowedUrls.has(stripUrl(fo.url)) ? stripUrl(fo.url) : undefined;
            return url ? { text, url } : { text };
          })
          .filter((f): f is { text: string; url?: string } => !!f)
          .slice(0, 4);
        return { short: clean(o.short, 80), action, detail: clean(o.detail, 300), facts };
      })
      .filter((p) => p.short && p.detail)
      .slice(0, 4);
    return NextResponse.json({ headline, points: points.length ? points : null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Overview failed." }, { status: 502 });
  }
}
