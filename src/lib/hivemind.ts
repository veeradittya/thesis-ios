// Hivemind — deterministic, client-side signal synthesis.
//
// This is the "brain" of the Hivemind page: it rolls the raw per-asset signals we already
// collect (daily analyst research, analyst consensus, Reddit chatter, YouTube coverage,
// prediction markets, news, price action) into a single directional *pulse* plus a plain-
// language *overview*. There is intentionally NO LLM here — the read is composed from
// templates and small lexicons so it runs instantly on the client with no key or latency.
//
// It lives in its own module (not the component) for two reasons:
//   1. it's pure and unit-testable, and
//   2. `synthesizeAsset` / `aggregatePortfolioPulse` are the exact seam we'll later swap
//      for a real LLM-written overview (agent-in-Turso or on-demand call) without touching
//      the UI. Keep the return shapes stable and the UI won't care where the prose came from.

import type { RedditSocialSnapshot } from "./redditSocial";
import type { YouTubeSocialVideo } from "./youtubeSocial";

export type PulseLabel = "Bullish" | "Constructive" | "Mixed" | "Cautious" | "Bearish";
export type Tone = "positive" | "neutral" | "negative";

export interface AssetMarket {
  question: string;
  yes: number | null; // 0..1 implied probability of the "yes" outcome
  volume: number | null;
}

// Everything we can know about one ticker. Every field is optional — coverage varies asset
// to asset, and the synthesis renormalizes over whatever is actually present.
export interface AssetSignals {
  ticker: string;
  name?: string | null;
  // price (Finnhub quote)
  price?: number | null;
  changePct?: number | null; // day change %
  // analyst — daily agent research (Turso `assets`) + Finnhub consensus
  verdict?: string | null; // holds_up | watch | weakening | at_risk
  risk?: number | null; // 0..100, higher = riskier
  rationale?: string | null; // the agent's plain-language research narrative (with source links)
  agentSignals?: Record<string, string> | null; // the agent's `signals` JSON: the concrete evidence it pulled (e.g. price/news/analyst)
  brief?: string | null; // analyst_brief prose
  recLabel?: string | null; // Strong Buy … Strong Sell
  recAnalysts?: number | null;
  // social
  reddit?: RedditSocialSnapshot | null;
  videos?: YouTubeSocialVideo[];
  // prediction markets (Oddpool)
  markets?: AssetMarket[];
  // news (multi-source, per-ticker)
  newsCount?: number;
  newsHeadlines?: string[];
  newsItems?: Array<{ headline: string; url: string }>; // headline + source link
}

// A fact shown at the deepest drill-down level, optionally linked to its source.
export interface BriefFact {
  text: string;
  url?: string;
}

export type SignalKey = "analyst" | "reddit" | "markets" | "news" | "price";

export interface SignalContribution {
  key: SignalKey;
  present: boolean;
  score: number; // -1..1 directional lean (0 when a family is attention-only)
  magnitude: number; // 0..1 strength/attention (drives how much it's trusted)
  weight: number; // normalized share of the final score actually applied
  label: string; // short human phrase for the breakdown chips
}

export interface AssetPulse {
  ticker: string;
  score: number; // -1..1
  label: PulseLabel;
  tone: Tone;
  color: string; // tailwind text-* class for the pulse chip
  overview: string; // the plain-language cross-signal read (2-4 sentences)
  contributions: SignalContribution[];
  signalCount: number; // how many distinct signal families were present
}

export interface PortfolioPulse {
  score: number; // -1..1 (weight-averaged over holdings)
  label: PulseLabel;
  tone: Tone;
  color: string;
  tint: string; // solid hex used to recolor the orb's dots (multiply blend)
  speed: number; // 0.4..0.95 orb speed ∝ conviction
  headline: string; // one-line portfolio read
  positive: number; // # holdings leaning positive
  negative: number; // # holdings leaning negative
  total: number;
}

// ---------------------------------------------------------------------------------------
// Lexicons — tiny, deliberately conservative. Tone is a weak signal; we lean on it only
// lightly and always pair it with an attention magnitude so a loud-but-vague asset doesn't
// get a strong directional read it hasn't earned.
// ---------------------------------------------------------------------------------------
const BULL_WORDS = [
  "beat", "beats", "surge", "surges", "rally", "rallies", "upgrade", "upgraded", "bullish",
  "soar", "soars", "jump", "jumps", "record", "growth", "strong", "outperform", "breakout",
  "upside", "gains", "gain", "pop", "rebound", "momentum", "buy", "accelerate", "raise", "raised",
  "tops", "topped", "expand", "expansion", "demand", "wins", "win", "boom",
];
const BEAR_WORDS = [
  "miss", "misses", "missed", "plunge", "plunges", "downgrade", "downgraded", "bearish", "crash",
  "drop", "drops", "fall", "falls", "weak", "weakness", "cut", "cuts", "lawsuit", "probe", "warning",
  "warn", "decline", "declines", "slump", "dump", "sink", "sinks", "fear", "fears", "bubble",
  "overvalued", "tumble", "tumbles", "selloff", "layoff", "layoffs", "recall", "delay", "delays",
  "loss", "losses", "slowdown", "headwind", "headwinds", "concern", "concerns", "risk", "risks",
];

function lexiconTone(text: string): number {
  if (!text) return 0;
  const words = text.toLowerCase().match(/[a-z]+/g);
  if (!words) return 0;
  let bull = 0;
  let bear = 0;
  const bullSet = new Set(BULL_WORDS);
  const bearSet = new Set(BEAR_WORDS);
  for (const w of words) {
    if (bullSet.has(w)) bull++;
    else if (bearSet.has(w)) bear++;
  }
  const total = bull + bear;
  if (!total) return 0;
  return (bull - bear) / total; // -1..1
}

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const round = (v: number, dp = 0) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

// ---------------------------------------------------------------------------------------
// Per-family scorers → { score (-1..1 directional), magnitude (0..1 strength), label }
// ---------------------------------------------------------------------------------------

// Normalize an agent verdict to a lookup key ("At Risk" / "holds-up" → "at_risk" / "holds_up").
export function normVerdict(v?: string | null): string {
  return (v || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
// The agent's grading vocabulary (superset — the live values are holds_up / watch / weak, but we
// map the strong/at_risk ends too so a wider grade set still scores).
const VERDICT_SCORE: Record<string, number> = {
  holds_up: 1,
  strong: 1,
  strengthening: 0.75,
  watch: 0,
  neutral: 0,
  weak: -0.5,
  weakening: -0.5,
  softening: -0.4,
  at_risk: -1,
  deteriorating: -0.85,
};
const VERDICT_PHRASE: Record<string, string> = {
  holds_up: "holding up",
  strong: "looking strong",
  strengthening: "strengthening",
  watch: "on watch",
  neutral: "looking neutral",
  weak: "looking weak",
  weakening: "weakening",
  softening: "softening",
  at_risk: "at risk",
  deteriorating: "deteriorating",
};
const REC_SCORE: Record<string, number> = {
  "Strong Buy": 1,
  Buy: 0.5,
  Hold: 0,
  Sell: -0.5,
  "Strong Sell": -1,
};

function analystSignal(s: AssetSignals): SignalContribution {
  const vk = normVerdict(s.verdict);
  const hasVerdict = vk in VERDICT_SCORE;
  const hasRisk = typeof s.risk === "number" && Number.isFinite(s.risk);
  const hasRec = typeof s.recLabel === "string" && s.recLabel in REC_SCORE;
  const present = hasVerdict || hasRisk || hasRec;

  // Blend the daily agent verdict, the 0-100 risk score, and the Street consensus.
  const parts: Array<[number, number]> = []; // [value, weight]
  if (hasVerdict) parts.push([VERDICT_SCORE[vk], 0.5]);
  if (hasRisk) parts.push([clamp((50 - (s.risk as number)) / 50), 0.3]); // risk 0 → +1, 100 → -1
  if (hasRec) parts.push([REC_SCORE[s.recLabel as string], 0.4]);
  const wsum = parts.reduce((a, [, w]) => a + w, 0) || 1;
  const score = clamp(parts.reduce((a, [v, w]) => a + v * w, 0) / wsum);

  const bits: string[] = [];
  if (hasVerdict) bits.push(VERDICT_PHRASE[vk]);
  if (hasRec) bits.push(s.recLabel as string);
  const label = present ? (bits.join(" · ") || "researched") : "No analyst read";
  return { key: "analyst", present, score, magnitude: present ? 0.9 : 0, weight: 0, label };
}

function redditSignal(s: AssetSignals): SignalContribution {
  const snap = s.reddit;
  const present = !!snap && snap.mentions > 0;
  if (!snap || !present) {
    return { key: "reddit", present: false, score: 0, magnitude: 0, weight: 0, label: "No chatter" };
  }
  const tone = lexiconTone(snap.summary);
  // Attention magnitude from raw volume (log-scaled: ~1 by a few hundred mentions).
  const magnitude = clamp(Math.log10(snap.mentions + 1) / 2.4, 0, 1);
  // Direction is tone, lightly amplified by week-over-week momentum sign when we have it.
  const momentum = snap.mentionChangePct == null ? 0 : clamp(snap.mentionChangePct / 100) * 0.25;
  const score = clamp(tone + (tone !== 0 ? momentum : 0));
  const volPhrase = magnitude > 0.66 ? "loud" : magnitude > 0.33 ? "active" : "quiet";
  return {
    key: "reddit",
    present: true,
    score,
    magnitude,
    weight: 0,
    label: `${volPhrase} · ${snap.mentions} mentions`,
  };
}

// Prediction-market direction is genuinely hard to read deterministically (a "yes" can mean
// bullish OR bearish depending on the question), so we only take a directional lean when the
// question clearly frames an upside/downside threshold; otherwise markets count as *attention*.
function marketsSignal(s: AssetSignals): SignalContribution {
  const markets = (s.markets || []).filter((m) => m.question);
  const present = markets.length > 0;
  if (!present) {
    return { key: "markets", present: false, score: 0, magnitude: 0, weight: 0, label: "No markets" };
  }
  let lean = 0;
  let leanCount = 0;
  for (const m of markets) {
    if (m.yes == null) continue;
    const q = m.question.toLowerCase();
    const up = /\b(above|over|exceed|reach|hit|higher|at least|\+)\b/.test(q);
    const down = /\b(below|under|drop|fall|lower|less than|recession|crash)\b/.test(q);
    if (up && !down) {
      lean += (m.yes - 0.5) * 2;
      leanCount++;
    } else if (down && !up) {
      lean += (0.5 - m.yes) * 2;
      leanCount++;
    }
  }
  const score = leanCount ? clamp(lean / leanCount) : 0;
  const magnitude = clamp(0.35 + markets.length * 0.12, 0, 1);
  return {
    key: "markets",
    present: true,
    score,
    magnitude,
    weight: 0,
    label: `${markets.length} market${markets.length > 1 ? "s" : ""}`,
  };
}

function newsSignal(s: AssetSignals): SignalContribution {
  const heads = s.newsHeadlines || [];
  const count = s.newsCount ?? heads.length;
  const present = count > 0;
  if (!present) {
    return { key: "news", present: false, score: 0, magnitude: 0, weight: 0, label: "No news" };
  }
  const tone = lexiconTone(heads.join(" . "));
  const magnitude = clamp(0.3 + count * 0.08, 0, 1);
  return { key: "news", present: true, score: clamp(tone), magnitude, weight: 0, label: `${count} article${count > 1 ? "s" : ""}` };
}

function priceSignal(s: AssetSignals): SignalContribution {
  const pct = s.changePct;
  const present = typeof pct === "number" && Number.isFinite(pct);
  if (!present) {
    return { key: "price", present: false, score: 0, magnitude: 0, weight: 0, label: "No quote" };
  }
  const score = clamp((pct as number) / 3); // ±3% day move = full lean
  const magnitude = clamp(Math.abs(pct as number) / 3, 0, 1);
  const sign = (pct as number) >= 0 ? "+" : "";
  return { key: "price", present: true, score, magnitude, weight: 0, label: `${sign}${round(pct as number, 2)}% today` };
}

// Base importance of each family, before renormalizing over the ones actually present.
const BASE_WEIGHT: Record<SignalKey, number> = {
  analyst: 0.32,
  reddit: 0.2,
  markets: 0.18,
  news: 0.1,
  price: 0.2,
};

function bandLabel(score: number): PulseLabel {
  if (score >= 0.35) return "Bullish";
  if (score >= 0.12) return "Constructive";
  if (score > -0.12) return "Mixed";
  if (score > -0.35) return "Cautious";
  return "Bearish";
}

const LABEL_TONE: Record<PulseLabel, Tone> = {
  Bullish: "positive",
  Constructive: "positive",
  Mixed: "neutral",
  Cautious: "negative",
  Bearish: "negative",
};
const LABEL_COLOR: Record<PulseLabel, string> = {
  Bullish: "text-emerald-400",
  Constructive: "text-emerald-300",
  Mixed: "text-amber-300",
  Cautious: "text-rose-300",
  Bearish: "text-rose-500",
};

// ---------------------------------------------------------------------------------------
// The main entry points.
// ---------------------------------------------------------------------------------------

export function synthesizeAsset(s: AssetSignals): AssetPulse {
  const contributions = [analystSignal(s), redditSignal(s), marketsSignal(s), newsSignal(s), priceSignal(s)];
  const present = contributions.filter((c) => c.present);

  // Effective weight = base importance × how much strength/attention the family carries,
  // renormalized so the applied weights sum to 1 over the present families. This lets an
  // asset with only two signals still produce a sensible, well-scaled score.
  const effective = present.map((c) => BASE_WEIGHT[c.key] * (0.4 + 0.6 * c.magnitude));
  const wsum = effective.reduce((a, w) => a + w, 0) || 1;
  present.forEach((c, i) => {
    c.weight = effective[i] / wsum;
  });

  const score = clamp(present.reduce((a, c) => a + c.score * c.weight, 0));
  const label = bandLabel(score);

  return {
    ticker: s.ticker,
    score,
    label,
    tone: LABEL_TONE[label],
    color: LABEL_COLOR[label],
    overview: composeOverview(s, contributions, label),
    contributions,
    signalCount: present.length,
  };
}

// Pull ONE concrete fact from the agent's evidence (which already names its source, e.g. "(WSJ)" or
// "TD Cowen Buy $460"), so the overview can state that specific fact directly, no pipeline framing.
function researchQuote(s: AssetSignals): string | null {
  const ev = s.agentSignals;
  const raw = ev?.news || ev?.headline || ev?.catalyst || ev?.analyst;
  if (raw && raw.trim()) {
    const first = raw.split(/\s*;\s*/)[0]?.trim();
    if (first) return first.slice(0, 160);
  }
  if (s.rationale && s.rationale.trim()) {
    const noLinks = s.rationale.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // strip markdown links, keep text
    const firstClause = noLinks.split(/(?<=[.;])\s+/)[0] || noLinks;
    return firstClause.trim().slice(0, 160);
  }
  return null;
}

function composeOverview(s: AssetSignals, contributions: SignalContribution[], label: PulseLabel): string {
  const by = (k: SignalKey) => contributions.find((c) => c.key === k)!;
  const sentences: Array<{ text: string; weight: number }> = [];

  const analyst = by("analyst");
  if (analyst.present) {
    // State the specific fact directly (the evidence already names its source), not "the daily
    // research says X" and not a bare verdict label. Consensus is its own sentence.
    const rq = researchQuote(s);
    if (rq) {
      const fact = /[.!?]$/.test(rq) ? rq : `${rq}.`;
      sentences.push({ text: capitalize(fact), weight: analyst.weight + 0.01 });
    }
    if (s.recLabel && s.recLabel in REC_SCORE) {
      const who = s.recAnalysts ? ` across ${s.recAnalysts} analysts` : "";
      sentences.push({ text: `The Street rates ${s.ticker} ${s.recLabel}${who}.`, weight: analyst.weight });
    }
  }

  const reddit = by("reddit");
  if (reddit.present && s.reddit) {
    const vol = reddit.magnitude > 0.66 ? "loud" : reddit.magnitude > 0.33 ? "active" : "quiet";
    const chg = s.reddit.mentionChangePct == null ? "" : ` (${s.reddit.mentionChangePct >= 0 ? "+" : ""}${round(s.reddit.mentionChangePct)}% w/w)`;
    const toneWord = reddit.score > 0.15 ? ", skewing positive" : reddit.score < -0.15 ? ", skewing negative" : "";
    sentences.push({ text: `Reddit is ${vol} with ${s.reddit.mentions} mentions${chg}${toneWord}.`, weight: reddit.weight });
  }

  const markets = by("markets");
  if (markets.present) {
    const lean = markets.score > 0.15 ? "lean to the upside" : markets.score < -0.15 ? "lean to the downside" : "are split";
    sentences.push({ text: `Prediction markets ${lean} across ${markets.label}.`, weight: markets.weight });
  }

  const news = by("news");
  if (news.present) {
    const toneWord = news.score > 0.15 ? ", broadly constructive" : news.score < -0.15 ? ", running negative" : "";
    sentences.push({ text: `${capitalize(news.label)} in the last stretch${toneWord}.`, weight: news.weight });
  }

  const price = by("price");
  if (price.present && typeof s.changePct === "number") {
    const move = s.changePct >= 0.3 ? "up" : s.changePct <= -0.3 ? "down" : "flat";
    sentences.push({ text: `Shares are ${move} ${price.label.replace(/ today$/, "")} on the day.`, weight: price.weight });
  }

  if (!sentences.length) return `No signals yet for ${s.ticker}. Coverage will fill in as the feeds refresh.`;

  // Lead with the verdict, then the two strongest contributing signals, then the rest —
  // capped so the read stays a glance, not a wall.
  const lead = `Signals lean ${label.toLowerCase()}.`;
  const ordered = sentences.sort((a, b) => b.weight - a.weight).map((x) => x.text);
  return [lead, ...ordered].slice(0, 5).join(" ");
}

function capitalize(t: string): string {
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

// Weight-average the per-asset pulses into one portfolio number that drives the orb.
export function aggregatePortfolioPulse(
  pulses: Array<{ pulse: AssetPulse; weight: number }>,
): PortfolioPulse {
  const usable = pulses.filter((p) => p.pulse.signalCount > 0);
  const total = usable.length;
  if (!total) {
    return {
      score: 0,
      label: "Mixed",
      tone: "neutral",
      color: LABEL_COLOR.Mixed,
      tint: TINT.neutral,
      speed: 0.55,
      headline: "No signals yet. Coverage fills in as the feeds refresh.",
      positive: 0,
      negative: 0,
      total: 0,
    };
  }
  const wsum = usable.reduce((a, p) => a + (p.weight > 0 ? p.weight : 1), 0) || 1;
  const score = clamp(usable.reduce((a, p) => a + p.pulse.score * (p.weight > 0 ? p.weight : 1), 0) / wsum);
  const label = bandLabel(score);
  const positive = usable.filter((p) => p.pulse.tone === "positive").length;
  const negative = usable.filter((p) => p.pulse.tone === "negative").length;

  const tone = LABEL_TONE[label];
  const lead = `${positive} of ${total} holding${total > 1 ? "s" : ""} ${positive === 1 ? "is" : "are"} leaning positive`;
  const headline = `Your portfolio is leaning ${label.toLowerCase()} today, with ${lead}.`;

  return {
    score,
    label,
    tone,
    color: LABEL_COLOR[label],
    tint: TINT[tone],
    speed: 0.45 + Math.abs(score) * 0.5, // 0.45..0.95
    headline,
    positive,
    negative,
    total,
  };
}

// Solid pulse colours used to recolor the orb's white dots via a multiply overlay.
const TINT: Record<Tone, string> = {
  positive: "#34d399", // emerald-400
  neutral: "#fcd34d", // amber-300
  negative: "#fb7185", // rose-400
};

export interface PortfolioBrief {
  headline: string;
  points: Array<{ short: string; detail: string; facts: BriefFact[] }>;
}

// Deterministic version of the top-card read: a short headline + a few terse points, each with a
// fuller detail line and the concrete facts behind it, to reveal on tap. Shown instantly and
// whenever the LLM version is unavailable.
export function composePortfolioBrief(
  assets: Array<{ pulse: AssetPulse; signals: AssetSignals }>,
  portfolio: PortfolioPulse,
): PortfolioBrief {
  const live = assets.filter((a) => a.pulse.signalCount > 0);
  if (!live.length) {
    return { headline: "Awaiting signals", points: [{ short: "No signals yet", detail: "The portfolio read fills in as the feeds refresh across your holdings.", facts: [] }] };
  }
  const points: Array<{ short: string; detail: string; facts: BriefFact[] }> = [];

  // Biggest day mover (if material).
  const priced = live.filter((a) => typeof a.signals.changePct === "number");
  let mover: (typeof live)[number] | null = null;
  if (priced.length) {
    const top = priced.reduce((m, a) => (Math.abs(a.signals.changePct as number) > Math.abs(m.signals.changePct as number) ? a : m));
    if (Math.abs(top.signals.changePct as number) >= 1) {
      mover = top;
      const p = top.signals.changePct as number;
      const dir = p >= 0 ? "up" : "down";
      points.push({
        short: `${top.signals.ticker} is the biggest mover today`,
        detail: `${top.signals.name || top.signals.ticker} is ${dir} ${round(Math.abs(p), 2)}% on the day, the largest move across your holdings.`,
        facts: [{ text: `The live price feed shows ${top.signals.name || top.signals.ticker} ${dir} ${round(Math.abs(p), 2)}% today, the largest move across your holdings.` }],
      });
    }
  }

  // Prediction-market lean across the book (a real fact: implied probabilities).
  const leans = live
    .map((a) => a.pulse.contributions.find((c) => c.key === "markets"))
    .filter((c): c is NonNullable<typeof c> => !!c && c.present);
  if (leans.length) {
    const avg = leans.reduce((s, c) => s + c.score, 0) / leans.length;
    const dir = avg > 0.1 ? "up" : avg < -0.1 ? "down" : "split";
    points.push({
      short: `Prediction markets lean ${dir} overall`,
      detail: `Across ${leans.length} holdings with prediction markets, the implied probabilities lean ${avg > 0.1 ? "to the upside" : avg < -0.1 ? "to the downside" : "split, with no clear direction"}.`,
      facts: [{ text: `Prediction markets are live on ${leans.length} of your holdings, and their combined implied odds lean ${avg > 0.1 ? "to the upside" : avg < -0.1 ? "to the downside" : "neither direction"}.` }],
    });
  }

  // Loudest on Reddit.
  const social = live.filter((a) => a.signals.reddit && a.signals.reddit.mentions > 0);
  if (social.length) {
    const loud = social.reduce((m, a) => ((a.signals.reddit?.mentions ?? 0) > (m.signals.reddit?.mentions ?? 0) ? a : m));
    const total = social.reduce((s, a) => s + (a.signals.reddit?.mentions ?? 0), 0);
    points.push({
      short: `${loud.signals.ticker} is the loudest name on Reddit`,
      detail: `${loud.signals.ticker} leads the chatter with ${loud.signals.reddit?.mentions} mentions, out of ${total} across the portfolio.`,
      facts: [{ text: `Reddit logged ${loud.signals.reddit?.mentions} mentions of ${loud.signals.ticker} over the past week, the most of any holding.`, url: loud.signals.reddit?.topSources?.[0]?.url }, { text: `${total} mentions across your whole portfolio in the same window.` }],
    });
  }

  // Overall breadth (grounding point).
  points.push({
    short: `${portfolio.positive} of ${portfolio.total} holdings leaning positive`,
    detail: `Across ${portfolio.total} holdings with signals, the book reads ${portfolio.label.toLowerCase()}: ${portfolio.positive} leaning positive and ${portfolio.negative} cautious.`,
    facts: [{ text: `${portfolio.positive} of ${portfolio.total} holdings read positive across our combined signals.` }, { text: `${portfolio.negative} read cautious.` }],
  });

  // Headline: surface a DIVERGENCE between signals (the interesting, non-obvious thing a user can't
  // get by glancing at prices), never a bare price fact like "biggest decliner".
  const marketLeanOf = (a: (typeof live)[number]) => {
    const c = a.pulse.contributions.find((x) => x.key === "markets");
    return c && c.present ? c.score : null;
  };
  const vscore = (a: (typeof live)[number]) => (normVerdict(a.signals.verdict) in VERDICT_SCORE ? VERDICT_SCORE[normVerdict(a.signals.verdict)] : null);
  const rscore = (a: (typeof live)[number]) => (a.signals.recLabel && a.signals.recLabel in REC_SCORE ? REC_SCORE[a.signals.recLabel] : null);
  const loud = social.length ? social.reduce((m, a) => ((a.signals.reddit?.mentions ?? 0) > (m.signals.reddit?.mentions ?? 0) ? a : m)) : null;

  let headline = "";
  // a. Analysts rate it a buy, but prediction markets expect it to fall.
  const aVsM = live.find((x) => (rscore(x) ?? 0) > 0 && (marketLeanOf(x) ?? 0) < -0.1);
  if (aVsM) headline = `Analysts back ${aVsM.signals.ticker}, but prediction markets expect it to fall`;
  // b. The loudest Reddit name that prediction markets are betting against.
  if (!headline && loud && (marketLeanOf(loud) ?? 0) < -0.1) headline = `Reddit sentiment on ${loud.signals.ticker} is bullish while prediction markets price a decline`;
  // c. Research looks weak, but prediction markets expect a rise.
  const vVsM = live.find((x) => (vscore(x) ?? 0) < 0 && (marketLeanOf(x) ?? 0) > 0.1);
  if (!headline && vVsM) headline = `${vVsM.signals.ticker}'s research looks weak, but prediction markets expect a rise`;
  // d. The loudest Reddit name whose daily research is unconvinced.
  if (!headline && loud && (vscore(loud) ?? 0) < 0) headline = `Reddit discussion of ${loud.signals.ticker} is heavy while the daily research stays cautious`;
  // e. Last resort: a plain read, still not a price fact.
  if (!headline) headline = `Signals lean ${portfolio.label.toLowerCase()}, with sentiment and the numbers not fully aligned`;
  return { headline, points: points.slice(0, 4) };
}

// ---------------------------------------------------------------------------------------
// v1 signal-to-noise helpers: notability (ranking + collapsing quiet names), an action lean,
// and conviction (how many independent, reliable signals agree). All pure + deterministic.
// ---------------------------------------------------------------------------------------

const dirContribs = (pulse: AssetPulse) => pulse.contributions.filter((c) => c.present && c.key !== "news");

// How much is HAPPENING for this asset right now, 0..1 — drives ranking and collapsing the quiet ones.
export function assetNotability(pulse: AssetPulse, s: AssetSignals): number {
  const priceMag = typeof s.changePct === "number" ? Math.min(Math.abs(s.changePct) / 3, 1) : 0;
  const dirs = dirContribs(pulse).map((c) => c.score);
  const divergence = dirs.length > 1 ? clamp((Math.max(...dirs) - Math.min(...dirs)) / 2, 0, 1) : 0;
  const redditSpike = s.reddit?.mentionChangePct != null ? Math.min(Math.abs(s.reddit.mentionChangePct) / 100, 1) : 0;
  const conviction = Math.abs(pulse.score);
  const coverage = Math.min(pulse.signalCount / 5, 1);
  const raw = 0.3 * priceMag + 0.3 * divergence + 0.2 * redditSpike + 0.2 * conviction;
  return clamp(raw * (0.6 + 0.4 * coverage), 0, 1); // damp names with thin signal coverage
}

export interface AssetAction {
  label: "Add" | "Trim" | "Fade" | "Watch" | "Hold";
  tone: Tone;
  note: string;
}
const marketOf = (pulse: AssetPulse) => pulse.contributions.find((c) => c.key === "markets");

// A simple, decision-oriented lean derived from the signals.
export function assetAction(pulse: AssetPulse, s: AssetSignals): AssetAction {
  const score = pulse.score;
  const mkt = marketOf(pulse);
  const redditLoud = (s.reddit?.mentions ?? 0) >= 100 || (s.reddit?.mentionChangePct ?? 0) >= 40;
  const marketBear = !!mkt?.present && mkt.score < -0.15;
  const marketBull = !!mkt?.present && mkt.score > 0.15;
  const verdictWeak = normVerdict(s.verdict) in VERDICT_SCORE && VERDICT_SCORE[normVerdict(s.verdict)] < 0;

  if (redditLoud && marketBear) return { label: "Fade", tone: "negative", note: "Reddit bullish but prediction markets price a decline" };
  if (score <= -0.3 || (verdictWeak && marketBear)) return { label: "Trim", tone: "negative", note: "signals lean negative" };
  if (score >= 0.3 && (marketBull || pulse.tone === "positive")) return { label: "Add", tone: "positive", note: "signals line up to the upside" };
  if (mkt?.present && Math.abs(mkt.score) > 0.15 && Math.sign(mkt.score) !== (Math.sign(score) || 1)) return { label: "Watch", tone: "neutral", note: "signals disagree" };
  if (Math.abs(score) < 0.12) return { label: "Watch", tone: "neutral", note: "no clear edge yet" };
  return { label: "Hold", tone: "neutral", note: "steady" };
}

export interface AssetConviction {
  level: "high" | "medium" | "low";
  agree: number;
  total: number;
  redditOnly: boolean;
}

// How many INDEPENDENT, RELIABLE signals agree with the pulse direction (Reddit is crowd noise, not counted).
export function assetConviction(pulse: AssetPulse): AssetConviction {
  const sign = Math.sign(pulse.score) || 1;
  const reliable = pulse.contributions.filter(
    (c) => c.present && (c.key === "analyst" || c.key === "markets" || c.key === "price") && Math.abs(c.score) > 0.1,
  );
  const agree = reliable.filter((c) => Math.sign(c.score) === sign).length;
  const total = reliable.length;
  const redditPresent = !!pulse.contributions.find((c) => c.key === "reddit")?.present;
  const level: AssetConviction["level"] = agree >= 3 ? "high" : agree >= 2 ? "medium" : "low";
  return { level, agree, total, redditOnly: total === 0 && redditPresent };
}

// ---------------------------------------------------------------------------------------
// Per-signal directional lean — a plain Strong Buy … Strong Sell read for EACH signal family,
// so a holding's breakdown shows what every signal POINTS TO, not just how much of it there is.
// Every lean is inferred from that family's raw data: the same -1..1 scores that drive the pulse
// (analyst consensus + agent verdict, Reddit tone, prediction-market odds, news-headline tone).
// YouTube is attention-only in the pulse, so its lean is inferred here from the videos' text.
// ---------------------------------------------------------------------------------------
export type SignalLean = "Strong Buy" | "Buy" | "Neutral" | "Sell" | "Strong Sell";

export function leanLabel(score: number): SignalLean {
  if (score >= 0.45) return "Strong Buy";
  if (score >= 0.15) return "Buy";
  if (score > -0.15) return "Neutral";
  if (score > -0.45) return "Sell";
  return "Strong Sell";
}

// The lean for one signal family off a computed pulse (null when that family has no signal).
export function signalLean(pulse: AssetPulse, key: SignalKey): SignalLean | null {
  const c = pulse.contributions.find((x) => x.key === key);
  return c && c.present ? leanLabel(c.score) : null;
}

// YouTube coverage isn't scored into the pulse, so infer its lean straight from the video text
// (titles + agent summaries + transcript excerpts), using the same lexicon the news/Reddit tones use.
export function youtubeLean(
  videos: Array<{ title?: string | null; videoSummary?: string | null; transcriptExcerpt?: string | null }>,
): SignalLean | null {
  if (!videos?.length) return null;
  const text = videos
    .map((v) => [v.title, v.videoSummary, v.transcriptExcerpt].filter(Boolean).join(". "))
    .join(" . ")
    .trim();
  if (!text) return null;
  return leanLabel(lexiconTone(text));
}
