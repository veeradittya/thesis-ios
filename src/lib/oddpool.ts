// Server-side Oddpool client (https://docs.oddpool.com) — cross-venue Kalshi + Polymarket
// prediction-market data. The API key stays on the server; the browser never sees it.
// Free tier is rate-limited (1k req/mo + bursty 429s), so we cache assembled payloads.

const BASE = "https://api.oddpool.com";

function apiKey(): string {
  const k = process.env.ODDPOOL_API_KEY;
  if (!k) throw new Error("ODDPOOL_API_KEY is not set");
  return k;
}

async function oddpoolGet<T>(path: string, retries = 1): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "X-API-Key": apiKey(), Accept: "application/json" },
    // Lean on Next's data cache so reloads/HMR don't burn the free-tier quota.
    next: { revalidate: 300 },
  });
  if (res.status === 429 && retries > 0) {
    // Free-tier burst limit — back off briefly and retry once.
    await new Promise((r) => setTimeout(r, 1200));
    return oddpoolGet<T>(path, retries - 1);
  }
  if (!res.ok) throw new Error(`Oddpool ${res.status} for ${path}`);
  return (await res.json()) as T;
}

// Uncached fetch — for dynamic data (whale feed/stats) that must reflect backfill + recent trades.
async function oddpoolGetFresh<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { headers: { "X-API-Key": apiKey(), Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`Oddpool ${res.status} for ${path}`);
  return (await res.json()) as T;
}

export interface OPEvent {
  event_id: string;
  exchange: string;
  series_id: string;
  title: string;
  category: string | null;
  status: string;
  image_url: string | null;
  discovered_at: string;
  market_count: number;
  total_volume: number | null;
  total_liquidity: number | null;
  market_questions?: string[];
}

export interface OPMarket {
  market_id: string;
  exchange: string;
  series_id: string;
  question: string;
  category: string | null;
  status: string;
  volume: number | null;
  liquidity: number | null;
  last_yes_price: string | null;
  last_no_price: string | null;
  event_id: string;
  event_title: string;
  slug: string;
  discovered_at: string;
  settled_at: string | null;
}

export interface OPOhlcv {
  market_id: string;
  question: string;
  status: string;
  result: string | null;
  scheduled_close_at: string | null;
  interval: string;
  snapshot_cadence: string;
  window_start: string;
  window_end: string;
  stats: {
    window_open: number | null;
    window_close: number | null;
    window_high: number | null;
    window_low: number | null;
    window_volume: number | null;
    change_pct: number | null;
    change_1d: number | null;
    change_7d: number | null;
    change_30d: number | null;
  };
  bars: Array<{ ts: string; open: number; high: number; low: number; close: number; volume: number }>;
}

export type LadderMarket = OPMarket & { yes: number | null; strike: number | null };

export interface PredictionPayload {
  ticker: string;
  source: string;
  fetchedAt: string;
  event: OPEvent;
  markets: LadderMarket[];
  headline: {
    market_id: string;
    question: string;
    strike: number | null;
    yes: number | null;
    last_yes_price: string | null;
    last_no_price: string | null;
    volume: number | null;
    liquidity: number | null;
    status: string;
    scheduled_close_at: string | null;
    settled_at: string | null;
    interval: string | null;
    snapshot_cadence: string | null;
    window_start: string | null;
    window_end: string | null;
    stats: OPOhlcv["stats"] | null;
    bars: Array<{ ts: string; close: number }>;
  };
}

function num(s: string | null | undefined): number | null {
  if (s == null) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Implied YES probability (0..1): prefer the YES last price; fall back to 1 - NO.
function impliedYes(m: OPMarket): number | null {
  const y = num(m.last_yes_price);
  if (y != null && y > 0) return y;
  const no = num(m.last_no_price);
  if (no != null) return Math.max(0, Math.min(1, 1 - no));
  return y;
}

function strikeOf(q: string): number | null {
  const m = q.match(/\$([\d,]+(?:\.\d+)?)/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : null;
}

let cache: { at: number; data: PredictionPayload } | null = null;
const TTL = 5 * 60 * 1000;

export async function getNvdaPrediction(): Promise<PredictionPayload> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;

  try {
    const events = await oddpoolGet<OPEvent[]>("/search/events?q=nvidia");

    // Prefer live, NVDA-specific, multi-outcome price events — they read as a clean
    // probability ladder (a market-implied distribution of where the stock lands).
    const candidates = events
      .filter((e) => e.status === "active" && /nvda|nvidia/i.test(e.title) && e.market_count >= 3)
      .sort((a, b) => {
        const score = (e: OPEvent) =>
          (e.total_volume || 0) +
          (e.exchange.startsWith("polymarket") ? 50_000 : 0) +
          (/close above|hit|reach|price/i.test(e.title) ? 30_000 : 0);
        return score(b) - score(a);
      });

    // Fetch markets for the top few candidates and prefer the event with the most
    // *contested* outcomes (probabilities mid-range, not already resolved to 0/1) —
    // that's the live, still-uncertain distribution worth showing.
    const scored: Array<{ ev: OPEvent; active: LadderMarket[]; contested: number }> = [];
    for (const ev of candidates.slice(0, 4)) {
      let ms: OPMarket[];
      try {
        ms = await oddpoolGet<OPMarket[]>(`/search/events/${encodeURIComponent(ev.event_id)}/markets`);
      } catch {
        continue;
      }
      const active = ms
        .filter((m) => m.status === "active")
        .map((m) => ({ ...m, yes: impliedYes(m), strike: strikeOf(m.question) }));
      const contested = active.filter((m) => m.yes != null && m.yes > 0.05 && m.yes < 0.95).length;
      scored.push({ ev, active, contested });
      if (contested >= 3) break; // good enough — stop early to conserve quota
    }
    if (!scored.length) throw new Error("No live NVDA prediction events found.");

    scored.sort(
      (a, b) =>
        b.contested - a.contested ||
        b.active.length - a.active.length ||
        (b.ev.total_volume || 0) - (a.ev.total_volume || 0),
    );
    const best = scored[0];
    const chosen = best.ev;
    const markets: LadderMarket[] = best.active.slice().sort((a, b) => {
      if (a.strike != null && b.strike != null) return a.strike - b.strike;
      return (b.volume || 0) - (a.volume || 0);
    });

    // Headline = the most *contested* active market (closest to 50/50) with real flow —
    // that's the threshold the market is actually deciding on right now.
    const withYes = markets.filter((m) => m.yes != null && (m.volume || 0) > 0);
    const pool = withYes.length ? withYes : markets;
    const headlineMkt =
      pool
        .slice()
        .sort((a, b) => {
          const d = (m: LadderMarket) => (m.yes == null ? 99 : Math.abs(m.yes - 0.5));
          return d(a) - d(b);
        })[0] || markets[0];

    let ohlcv: OPOhlcv | null = null;
    if (headlineMkt) {
      try {
        const arr = await oddpoolGet<OPOhlcv[]>(
          `/markets/ohlcv?market_ids=${encodeURIComponent(headlineMkt.market_id)}&interval=6h`,
        );
        ohlcv = Array.isArray(arr) ? arr[0] ?? null : null;
      } catch {
        /* rate-limited or no history — degrade gracefully (no sparkline) */
      }
    }

    const data: PredictionPayload = {
      ticker: "NVDA",
      source: "Oddpool",
      fetchedAt: new Date().toISOString(),
      event: chosen,
      markets,
      headline: {
        market_id: headlineMkt.market_id,
        question: headlineMkt.question,
        strike: headlineMkt.strike,
        yes: headlineMkt.yes,
        last_yes_price: headlineMkt.last_yes_price,
        last_no_price: headlineMkt.last_no_price,
        volume: headlineMkt.volume,
        liquidity: headlineMkt.liquidity,
        status: headlineMkt.status,
        scheduled_close_at: ohlcv?.scheduled_close_at ?? null,
        settled_at: headlineMkt.settled_at,
        interval: ohlcv?.interval ?? null,
        snapshot_cadence: ohlcv?.snapshot_cadence ?? null,
        window_start: ohlcv?.window_start ?? null,
        window_end: ohlcv?.window_end ?? null,
        stats: ohlcv?.stats ?? null,
        bars: (ohlcv?.bars ?? []).map((b) => ({ ts: b.ts, close: b.close })).slice(-48),
      },
    };

    cache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (cache) return cache.data; // serve stale on failure rather than erroring the card
    throw e;
  }
}

// ─── Portfolio-wide prediction radar ──────────────────────────────────────────
// Best discovery approach: hit /search/markets?q=<company> per holding — that
// endpoint returns markets *with* live prices in one call. We filter by status +
// a name/ticker regex (search is fuzzy, so this drops cross-matches), then collapse
// each event's price-ladder rungs into a single "question" with a representative odds.

const RADAR_ASSETS: Array<{ ticker: string; label: string; q: string; re: RegExp }> = [
  { ticker: "NVDA", label: "NVIDIA", q: "nvidia", re: /nvidia|nvda/i },
  { ticker: "AAPL", label: "Apple", q: "apple", re: /apple|aapl/i },
  { ticker: "MSFT", label: "Microsoft", q: "microsoft", re: /microsoft|msft/i },
  { ticker: "GOOGL", label: "Alphabet", q: "google", re: /alphabet|google|googl/i },
  { ticker: "AMZN", label: "Amazon", q: "amazon", re: /amazon|amzn/i },
  { ticker: "META", label: "Meta", q: "meta", re: /meta platforms|\(meta\)/i },
  { ticker: "TSLA", label: "Tesla", q: "tesla", re: /tesla|tsla/i },
  { ticker: "AVGO", label: "Broadcom", q: "broadcom", re: /broadcom|avgo/i },
  { ticker: "PLTR", label: "Palantir", q: "palantir", re: /palantir|pltr/i },
];

export interface RadarEvent {
  event_id: string;
  title: string;
  exchange: string;
  yes: number | null;
  volume: number;
  marketCount: number;
}
export interface RadarAsset {
  ticker: string;
  label: string;
  eventCount: number;
  totalVolume: number;
  events: RadarEvent[];
}
export interface RadarPayload {
  source: string;
  fetchedAt: string;
  assetCount: number;
  questionCount: number;
  assets: RadarAsset[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let radarCache: { at: number; data: RadarPayload } | null = null;
const RADAR_TTL = 10 * 60 * 1000;

export async function getPortfolioPredictionRadar(): Promise<RadarPayload> {
  if (radarCache && Date.now() - radarCache.at < RADAR_TTL) return radarCache.data;

  try {
    const assets: RadarAsset[] = [];
    for (const a of RADAR_ASSETS) {
      let ms: OPMarket[];
      try {
        ms = await oddpoolGet<OPMarket[]>(`/search/markets?q=${encodeURIComponent(a.q)}`);
      } catch {
        continue;
      }
      const active = ms.filter(
        (m) => m.status === "active" && (a.re.test(m.question || "") || a.re.test(m.event_title || "")),
      );

      // One row per event (collapse "$160 / $168 / $176…" rungs into one question).
      const byEvent = new Map<string, OPMarket[]>();
      for (const m of active) {
        const arr = byEvent.get(m.event_id) || [];
        arr.push(m);
        byEvent.set(m.event_id, arr);
      }

      const events: RadarEvent[] = [...byEvent.entries()]
        .map(([id, mk]) => {
          const yeses = mk.map(impliedYes).filter((y): y is number => y != null);
          // representative odds = the most contested outcome in the event
          const yes =
            yeses.length > 0 ? yeses.slice().sort((p, q) => Math.abs(p - 0.5) - Math.abs(q - 0.5))[0] : null;
          const volume = mk.reduce((s, m) => s + (m.volume || 0), 0);
          const title = mk.length === 1 ? mk[0].question : mk[0].event_title || mk[0].question;
          return { event_id: id, title, exchange: mk[0].exchange, yes, volume, marketCount: mk.length };
        })
        .sort((x, y) => y.volume - x.volume);

      if (!events.length) continue;
      assets.push({
        ticker: a.ticker,
        label: a.label,
        eventCount: events.length,
        totalVolume: events.reduce((s, e) => s + e.volume, 0),
        events: events.slice(0, 6),
      });
      await sleep(150); // be gentle with the free-tier burst limit
    }

    assets.sort((x, y) => y.totalVolume - x.totalVolume);
    const data: RadarPayload = {
      source: "Oddpool",
      fetchedAt: new Date().toISOString(),
      assetCount: assets.length,
      questionCount: assets.reduce((s, a) => s + a.eventCount, 0),
      assets,
    };
    radarCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (radarCache) return radarCache.data;
    throw e;
  }
}

// ─── Flat portfolio markets (drill-down enabled) ──────────────────────────────

export interface MarketLite {
  market_id: string;
  question: string;
  exchange: string;
  yes: number | null;
  volume: number | null;
  liquidity: number | null;
  event_id: string;
  eventCount?: number; // set when this row stands in for a multi-outcome event (N sub-markets, same question)
}
export interface MarketsAsset {
  ticker: string;
  label: string;
  count: number;
  markets: MarketLite[];
}
export interface MarketsPayload {
  source: string;
  fetchedAt: string;
  assetCount: number;
  marketCount: number;
  assets: MarketsAsset[];
}

const MAX_MARKET_ASSETS = 12; // cap Oddpool calls/latency for large portfolios
type MarketAssetDef = { ticker: string; label: string; q: string; re: RegExp };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function cleanCompanyName(name: string): string {
  return name
    .replace(/[.,].*$/, "")
    .replace(/\b(Corporation|Corp|Incorporated|Inc|Co|Company|Holdings?|Ltd|Limited|PLC|Group|Platforms|Technologies|Technology|The)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface HoldingLite { ticker: string; name?: string | null; weight?: number | null }

// Curated overrides where an auto-derived query/regex would be unsafe: generic words ("meta"),
// or share-class dupes (GOOG/GOOGL collapse to one Alphabet via `alias`). Keyed by ticker.
const MARKET_ASSET_OVERRIDES: Record<string, MarketAssetDef> = {
  NVDA: { ticker: "NVDA", label: "NVIDIA", q: "nvidia", re: /nvidia|nvda/i },
  AAPL: { ticker: "AAPL", label: "Apple", q: "apple", re: /apple|aapl/i },
  MSFT: { ticker: "MSFT", label: "Microsoft", q: "microsoft", re: /microsoft|msft/i },
  GOOGL: { ticker: "GOOGL", label: "Alphabet", q: "google", re: /alphabet|google|googl/i },
  GOOG: { ticker: "GOOGL", label: "Alphabet", q: "google", re: /alphabet|google|googl/i }, // collapse share class → GOOGL
  AMZN: { ticker: "AMZN", label: "Amazon", q: "amazon", re: /amazon|amzn/i },
  META: { ticker: "META", label: "Meta", q: "meta", re: /meta platforms|\(meta\)/i },
  TSLA: { ticker: "TSLA", label: "Tesla", q: "tesla", re: /tesla|tsla/i },
  AVGO: { ticker: "AVGO", label: "Broadcom", q: "broadcom", re: /broadcom|avgo/i },
  PLTR: { ticker: "PLTR", label: "Palantir", q: "palantir", re: /palantir|pltr/i },
};

// Holding → market-search asset. Curated override if present, else derive from ticker + company
// name, skipping ≤2-char tickers as bare regex alternatives (they collide, e.g. "MA" in "romance").
function assetForHolding(h: HoldingLite): MarketAssetDef | null {
  const ticker = (h.ticker || "").trim().toUpperCase();
  if (!ticker) return null;
  const ov = MARKET_ASSET_OVERRIDES[ticker];
  if (ov) return ov;
  const clean = cleanCompanyName(h.name || "");
  const alts: string[] = [];
  if (clean) alts.push(escapeRe(clean));
  if (ticker.length >= 3) alts.push(`\\b${escapeRe(ticker)}\\b`);
  if (!alts.length) return null; // nothing safe to match on (2-char ticker, no name)
  return { ticker, label: clean || ticker, q: (clean || ticker).toLowerCase(), re: new RegExp(alts.join("|"), "i") };
}

// Holdings → deduped, capped list of market-search asset defs, kept in ledger order (holdings
// arrive value-sorted from the ledger, so iterating in place matches the ledger's display order
// AND caps to the top holdings).
function assetDefsFor(holdings: HoldingLite[]): MarketAssetDef[] {
  const seen = new Set<string>();
  const out: MarketAssetDef[] = [];
  for (const h of holdings) {
    const a = assetForHolding(h);
    if (!a || seen.has(a.ticker)) continue;
    seen.add(a.ticker);
    out.push(a);
    if (out.length >= MAX_MARKET_ASSETS) break;
  }
  return out;
}

// Group key for collapsing look-alike markets: lower-case the question and strip resolution-date
// phrases ("on August 31", "by end of July 2026", "week of July 27 2026", stray years) so markets
// that differ ONLY by date share a key. Thresholds / entities / HIGH-LOW are preserved, so genuinely
// different bets stay distinct.
const MONTHS_RE = "january|february|march|april|may|june|july|august|september|october|november|december";
function normalizeQuestion(q: string): string {
  const date = `(?:${MONTHS_RE})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?`;
  return (q || "")
    .toLowerCase()
    .replace(new RegExp(`\\b(?:on|by|before|after|through|until|as of|end of|week of)\\s+${date}`, "g"), "")
    .replace(new RegExp(`\\b(?:end of|week of)\\s+(?:${MONTHS_RE})(?:\\s+\\d{4})?`, "g"), "")
    .replace(new RegExp(`\\b${date}`, "g"), "")
    .replace(/\b20\d{2}\b/g, "")
    .replace(/[?.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchMarketsFor(a: MarketAssetDef): Promise<MarketsAsset | null> {
  let ms: OPMarket[];
  try {
    ms = await oddpoolGet<OPMarket[]>(`/search/markets?q=${encodeURIComponent(a.q)}`);
  } catch {
    return null;
  }
  const active = ms
    .filter((m) => m.status === "active" && !m.settled_at && (a.re.test(m.question || "") || a.re.test(m.event_title || "")))
    .map((m) => ({
      market_id: m.market_id,
      question: m.question,
      exchange: m.exchange,
      yes: impliedYes(m),
      volume: m.volume,
      liquidity: m.liquidity,
      event_id: m.event_id,
    }))
    .filter((m) => m.yes != null)
    .sort((x, y) => (y.volume || 0) - (x.volume || 0));
  // Collapse look-alike rows. Group by date-normalized question, then:
  //  • group shares ONE event_id → a multi-outcome event (e.g. a Kalshi earnings-mention event whose
  //    sub-markets all carry the same generic question) → one row tagged with its size (eventCount)
  //    that opens the whole event (outcomes are named by ticker suffix inside the detail card).
  //  • group spans DIFFERENT event_ids → the same market repeated across dates ("Will NVIDIA be the
  //    largest company … on July 31 / August 31 / December 31?") → keep just the highest-volume one.
  // `active` is volume-desc, so group[0] is the top member and grouping preserves that order.
  const groups = new Map<string, MarketLite[]>();
  for (const m of active) {
    const key = normalizeQuestion(m.question);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(m);
    else groups.set(key, [m]);
  }
  const markets: MarketLite[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) { markets.push(g[0]); continue; }
    const sameEvent = g.every((m) => m.event_id === g[0].event_id);
    if (sameEvent) markets.push({ ...g[0], yes: null, volume: g.reduce((s, m) => s + (m.volume || 0), 0), eventCount: g.length });
    else markets.push(g[0]);
  }
  markets.sort((x, y) => (y.volume || 0) - (x.volume || 0)); // event rows now carry summed volume
  if (!markets.length) return null;
  return { ticker: a.ticker, label: a.label, count: markets.length, markets };
}

// Per-portfolio cache keyed by the resolved ticker set (10-min TTL). A single global cache would
// serve one portfolio's markets to another once the holdings became dynamic.
const marketsCacheByKey = new Map<string, { at: number; data: MarketsPayload }>();

// Prediction markets grouped by holding. `holdings` provided → driven by the caller's portfolio
// (empty array → empty result); omitted → the default RADAR_ASSETS demo set (guest/no-input).
export async function getPortfolioMarkets(holdings?: HoldingLite[]): Promise<MarketsPayload> {
  const defs = holdings !== undefined ? assetDefsFor(holdings) : RADAR_ASSETS;
  const cacheKey = holdings !== undefined ? defs.map((d) => d.ticker).sort().join(",") || "__empty__" : "__default__";

  const hit = marketsCacheByKey.get(cacheKey);
  if (hit && Date.now() - hit.at < RADAR_TTL) return hit.data;

  try {
    const assets: MarketsAsset[] = [];
    for (const a of defs) {
      const asset = await fetchMarketsFor(a);
      if (asset) assets.push(asset);
      await sleep(120);
    }
    // no re-sort — `defs` (and thus `assets`) is already in ledger order
    const data: MarketsPayload = {
      source: "Oddpool",
      fetchedAt: new Date().toISOString(),
      assetCount: assets.length,
      marketCount: assets.reduce((s, a) => s + a.count, 0),
      assets,
    };
    if (marketsCacheByKey.size > 24) marketsCacheByKey.clear(); // simple bound
    marketsCacheByKey.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch (e) {
    if (hit) return hit.data;
    throw e;
  }
}

// Free-text market search for the chat assistant — top active markets for any query.
export async function searchMarkets(q: string, limit = 8): Promise<MarketLite[]> {
  if (!q.trim()) return [];
  let ms: OPMarket[];
  try {
    ms = await oddpoolGet<OPMarket[]>(`/search/markets?q=${encodeURIComponent(q)}`);
  } catch {
    return [];
  }
  return ms
    .filter((m) => m.status === "active" && !m.settled_at)
    .map((m) => ({
      market_id: m.market_id,
      question: m.question,
      exchange: m.exchange,
      yes: impliedYes(m),
      volume: m.volume,
      liquidity: m.liquidity,
      event_id: m.event_id,
    }))
    .filter((m) => m.yes != null)
    .sort((x, y) => (y.volume || 0) - (x.volume || 0))
    .slice(0, limit);
}

// ─── Per-market drill-down: probability bars + live quote + book + trades ──────

export interface MarketDetail {
  market_id: string;
  exchange: string;
  yes: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  scheduledCloseAt: string | null;
  stats: OPOhlcv["stats"] | null;
  bars: Array<{ ts: string; c: number }>;
  book: { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> } | null;
  trades: Array<{ ts: number; side: string; price: number; size: number }>;
}

interface TobSnap {
  asset_id: string;
  timestamp: number;
  best_bid: number;
  best_ask: number;
  mid: number;
  spread: number;
}
interface ObSnap {
  asset_id: string;
  timestamp: number;
  bids: Array<{ price: string; size: number }>;
  asks: Array<{ price: string; size: number }>;
}

// Chart time-range → OHLCV window/interval. The API snapshot cadence floor is 6h
// (sub-6h → 400), so 24h resolves to only ~4 bars; 30d uses daily bars.
export type ChartRange = "24h" | "3d" | "7d" | "30d";
const RANGE_PARAMS: Record<ChartRange, { last: string; interval: string }> = {
  "24h": { last: "24h", interval: "6h" },
  "3d": { last: "3d", interval: "6h" },
  "7d": { last: "7d", interval: "6h" },
  "30d": { last: "30d", interval: "1d" },
};
const rangeParams = (r?: string) => RANGE_PARAMS[(r as ChartRange) || "30d"] || RANGE_PARAMS["30d"];

export async function getMarketDetail(
  marketId: string,
  exchange: string,
  yesHint: number | null,
  opts: { ohlcv?: boolean; range?: string } = {},
): Promise<MarketDetail> {
  const enc = encodeURIComponent(marketId);
  const venue = /polymarket/i.test(exchange) ? "polymarket" : "kalshi";
  const isPoly = venue === "polymarket";
  const out: MarketDetail = {
    market_id: marketId,
    exchange,
    yes: yesHint,
    bid: null,
    ask: null,
    spread: null,
    scheduledCloseAt: null,
    stats: null,
    bars: [],
    book: null,
    trades: [],
  };

  // Probability history (YES close over time) — skipped in quote-only polling.
  if (opts.ohlcv !== false) {
    try {
      const { last, interval } = rangeParams(opts.range);
      const arr = await oddpoolGet<OPOhlcv[]>(`/markets/ohlcv?market_ids=${enc}&last=${last}&interval=${interval}`);
      const o = Array.isArray(arr) ? arr[0] : null;
      if (o) {
        out.stats = o.stats;
        out.scheduledCloseAt = o.scheduled_close_at;
        out.bars = (o.bars || [])
          .filter((b) => b.close != null && Number.isFinite(b.close))
          .map((b) => ({ ts: b.ts, c: b.close }))
          .slice(-80);
      }
    } catch {}
  }

  if (isPoly) {
    // ── Polymarket: 2 asset_ids (YES + complement). Pick YES; if only the NO side
    //    has a book (extreme markets), invert it into YES terms.
    let yesAsset: string | null = null;
    let inverted = false;
    try {
      const tob = await oddpoolGet<{ snapshots: TobSnap[] }>(`/historical/polymarket/top-of-book?market_id=${enc}&limit=50`);
      const byAsset = new Map<string, TobSnap>();
      for (const s of tob.snapshots || []) {
        const cur = byAsset.get(s.asset_id);
        if (!cur || s.timestamp > cur.timestamp) byAsset.set(s.asset_id, s);
      }
      const snaps = [...byAsset.values()];
      // Effective mid — fall back to bid/ask when mid is null (thin sides).
      const emid = (s: TobSnap): number | null =>
        s.mid != null ? s.mid : s.best_bid != null && s.best_ask != null ? (s.best_bid + s.best_ask) / 2 : s.best_bid ?? s.best_ask ?? null;
      let pick: TobSnap | undefined = snaps[0];
      if (yesHint != null && snaps.length) {
        let best = Infinity;
        for (const s of snaps) {
          const d = Math.abs((emid(s) ?? 0.5) - yesHint);
          if (d < best) {
            best = d;
            pick = s;
          }
        }
      }
      if (pick) {
        yesAsset = pick.asset_id;
        const m = emid(pick);
        inverted = yesHint != null && m != null && Math.abs(m - (1 - yesHint)) < Math.abs(m - yesHint);
        if (inverted) {
          out.bid = pick.best_ask != null ? 1 - pick.best_ask : null;
          out.ask = pick.best_bid != null ? 1 - pick.best_bid : null;
          out.spread = pick.spread;
          out.yes = m != null ? 1 - m : yesHint;
        } else {
          out.bid = pick.best_bid;
          out.ask = pick.best_ask;
          out.spread = pick.spread;
          if (m != null) out.yes = m;
        }
      }
    } catch {}
    try {
      const ob = await oddpoolGet<{ snapshots: ObSnap[] }>(`/historical/polymarket/orderbook?market_id=${enc}&limit=20`);
      let snaps = ob.snapshots || [];
      if (yesAsset) snaps = snaps.filter((s) => s.asset_id === yesAsset);
      const latest = snaps.sort((a, b) => b.timestamp - a.timestamp)[0];
      if (latest) {
        let bids = (latest.bids || []).map((b) => ({ price: +b.price, size: +b.size }));
        let asks = (latest.asks || []).map((a) => ({ price: +a.price, size: +a.size }));
        if (inverted) {
          const nb = asks.map((a) => ({ price: 1 - a.price, size: a.size }));
          const na = bids.map((b) => ({ price: 1 - b.price, size: b.size }));
          bids = nb;
          asks = na;
        }
        out.book = {
          bids: bids.sort((a, b) => b.price - a.price).slice(0, 6),
          asks: asks.sort((a, b) => a.price - b.price).slice(0, 6),
        };
      }
    } catch {}
    try {
      const tr = await oddpoolGet<{ trades: Array<{ asset_id?: string; timestamp: number; side?: string; price?: string | number; size?: number }> }>(
        `/historical/polymarket/trades?market_id=${enc}&limit=120`,
      );
      let trades = tr.trades || [];
      if (yesAsset) trades = trades.filter((t) => t.asset_id === yesAsset);
      out.trades = trades.slice(0, 12).map((t) => {
        let price = +(t.price ?? 0);
        let side = String(t.side || "");
        if (inverted) {
          price = 1 - price;
          side = /buy/i.test(side) ? "sell" : /sell/i.test(side) ? "buy" : side;
        }
        return { ts: t.timestamp, side, price, size: +(t.size ?? 0) };
      });
    } catch {}
  } else {
    // ── Kalshi: single YES-denominated market (no asset_id). Book = yes_bids / no_bids.
    try {
      const tob = await oddpoolGet<{ snapshots: Array<{ timestamp: number; best_yes_bid: number | null; best_yes_ask: number | null; mid: number | null; spread: number | null }> }>(
        `/historical/kalshi/top-of-book?market_id=${enc}&limit=4`,
      );
      const s = (tob.snapshots || []).sort((a, b) => b.timestamp - a.timestamp)[0];
      if (s) {
        out.bid = s.best_yes_bid;
        out.ask = s.best_yes_ask;
        out.spread = s.spread != null ? s.spread : s.best_yes_ask != null && s.best_yes_bid != null ? s.best_yes_ask - s.best_yes_bid : null;
        if (s.mid != null) out.yes = s.mid;
        else if (s.best_yes_bid != null && s.best_yes_ask != null) out.yes = (s.best_yes_bid + s.best_yes_ask) / 2;
      }
    } catch {}
    try {
      const ob = await oddpoolGet<{ snapshots: Array<{ timestamp: number; yes_bids?: Array<{ price: string; size: number }>; no_bids?: Array<{ price: string; size: number }> }> }>(
        `/historical/kalshi/orderbook?market_id=${enc}&limit=2&granularity=1m`,
      );
      const s = (ob.snapshots || []).sort((a, b) => b.timestamp - a.timestamp)[0];
      if (s) {
        const bids = (s.yes_bids || []).map((b) => ({ price: +b.price, size: +b.size }));
        const asks = (s.no_bids || []).map((b) => ({ price: 1 - +b.price, size: +b.size })); // NO bid @p ⇒ YES ask @1-p
        out.book = {
          bids: bids.sort((a, b) => b.price - a.price).slice(0, 6),
          asks: asks.sort((a, b) => a.price - b.price).slice(0, 6),
        };
      }
    } catch {}
    try {
      const tr = await oddpoolGet<{ trades: Array<{ created_time?: string; timestamp?: number; taker_side?: string; side?: string; yes_price?: number; price?: number; count?: number; size?: number }> }>(
        `/historical/kalshi/trades?market_id=${enc}&limit=20`,
      );
      out.trades = (tr.trades || []).slice(0, 12).map((t) => ({
        ts: t.timestamp ?? (t.created_time ? Date.parse(t.created_time) : 0),
        side: String(t.taker_side || t.side || ""),
        price: +(t.yes_price ?? t.price ?? 0),
        size: +(t.count ?? t.size ?? 0),
      }));
    } catch {}
  }

  return out;
}

// ─── Whale tracker (Pro) ──────────────────────────────────────────────────────
// Whale data is scoped to events the account *tracks*. We auto-subscribe the
// portfolio's top events (idempotent) then serve the cross-event whale feed.

async function oddpoolPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "X-API-Key": apiKey(), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Oddpool ${res.status} for ${path}`);
  return (await res.json()) as T;
}

async function oddpoolDelete(path: string): Promise<void> {
  const res = await fetch(BASE + path, { method: "DELETE", headers: { "X-API-Key": apiKey(), Accept: "application/json" }, cache: "no-store" });
  if (!res.ok && res.status !== 404) throw new Error(`Oddpool ${res.status} for ${path}`);
}

// ── Whale-tracking hygiene ─────────────────────────────────────────────────
// Whale data requires POSTing each event onto the Pro account (a write). Detail
// cards track on open, so unrestricted search/browsing would grow the account's
// tracked list without bound. We cap the events tracked *via detail cards* (an
// LRU by view-recency) and auto-untrack the least-recently-viewed once over the
// cap. Portfolio + pre-existing tracked events are protected and never pruned.
const BROWSE_TRACK_CAP = 40;
const browsedTracks: string[] = []; // `${exchange}:${event_ticker}`, oldest → newest
const protectedTracks = new Set<string>();
const trackKey = (exchange: string, ticker: string) => `${exchange.replace(/_us$/, "")}:${ticker}`;

function noteBrowseTrack(exchange: string, ticker: string): void {
  if (!ticker) return;
  const key = trackKey(exchange, ticker);
  if (protectedTracks.has(key)) return;
  const i = browsedTracks.indexOf(key);
  if (i >= 0) browsedTracks.splice(i, 1);
  browsedTracks.push(key);
  while (browsedTracks.length > BROWSE_TRACK_CAP) {
    const stale = browsedTracks.shift();
    if (!stale) break;
    const sep = stale.indexOf(":");
    const ex = stale.slice(0, sep), tk = stale.slice(sep + 1);
    eventIdCache.delete(tk);
    void oddpoolDelete(`/whales/user/events/by-ticker/${ex}/${encodeURIComponent(tk)}`).catch(() => {});
  }
}

export interface WhaleTrade {
  id: number;
  platform: string;
  event_title: string;
  market_title: string;
  market_ticker: string;
  outcome: string;
  timestamp: string;
  taker_side: string;
  trade_size_usd: number;
  price: number;
  count: number;
  trader_wallet?: string;
  transaction_hash?: string;
}
export interface WhalePayload {
  source: string;
  fetchedAt: string;
  trackedCount: number;
  stats: { total_volume_24h: number; total_trades_24h: number; avg_trade_size: number };
  trades: WhaleTrade[];
}

const WHALE_THRESHOLD = 1000;
let whaleTracked = false;

async function ensureWhaleTracking(): Promise<void> {
  if (whaleTracked) return;
  try {
    const ev = await oddpoolGet<{ tracked_events?: Array<{ event_ticker?: string; platform?: string }> }>("/whales/user/events");
    // Protect everything already tracked (portfolio + prior) from browse-prune.
    for (const t of ev.tracked_events || []) if (t.event_ticker && t.platform) protectedTracks.add(trackKey(t.platform, t.event_ticker));
    if ((ev.tracked_events?.length || 0) >= 4) {
      whaleTracked = true;
      return;
    }
  } catch {}

  // Discover the top 2 events per holding and subscribe (POST is idempotent).
  const events = new Map<string, { exchange: string; event_ticker: string }>();
  for (const a of RADAR_ASSETS) {
    try {
      const ms = await oddpoolGet<OPMarket[]>(`/search/markets?q=${encodeURIComponent(a.q)}`);
      const active = ms
        .filter((m) => m.status === "active" && !m.settled_at)
        .sort((x, y) => (y.volume || 0) - (x.volume || 0));
      let n = 0;
      for (const m of active) {
        if (events.has(m.event_id)) continue;
        events.set(m.event_id, { exchange: m.exchange.replace(/_us$/, ""), event_ticker: m.event_id });
        if (++n >= 2) break;
      }
    } catch {}
    await sleep(100);
  }
  for (const e of [...events.values()].slice(0, 12)) {
    protectedTracks.add(trackKey(e.exchange, e.event_ticker));
    try {
      await oddpoolPost("/whales/user/events/by-ticker", {
        exchange: e.exchange,
        event_ticker: e.event_ticker,
        whale_threshold_usd: WHALE_THRESHOLD,
      });
    } catch {}
    await sleep(80);
  }
  whaleTracked = true;
}

let whaleCache: { at: number; data: WhalePayload } | null = null;
const WHALE_TTL = 45 * 1000;

export async function getWhaleFeed(): Promise<WhalePayload> {
  if (whaleCache && Date.now() - whaleCache.at < WHALE_TTL) return whaleCache.data;
  try {
    await ensureWhaleTracking();
    const feed = await oddpoolGet<{ trades?: WhaleTrade[]; stats?: WhalePayload["stats"] }>(
      `/whales/user/feed?limit=40&min_trade_size=${WHALE_THRESHOLD}`,
    );
    let trackedCount = 0;
    try {
      const ev = await oddpoolGet<{ tracked_events?: unknown[] }>("/whales/user/events");
      trackedCount = ev.tracked_events?.length || 0;
    } catch {}
    const trades = (feed.trades || []).slice(0, 40);
    const vol = trades.reduce((s, t) => s + (t.trade_size_usd || 0), 0);
    const stats =
      feed.stats || {
        total_volume_24h: vol,
        total_trades_24h: trades.length,
        avg_trade_size: trades.length ? vol / trades.length : 0,
      };
    const data: WhalePayload = { source: "Oddpool", fetchedAt: new Date().toISOString(), trackedCount, stats, trades };
    whaleCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (whaleCache) return whaleCache.data;
    throw e;
  }
}

// Per-market whale history: ensure the event is tracked (idempotent, cached id),
// then filter the event's whale feed to this market.
export interface MarketWhales {
  marketId: string;
  count: number;
  totalVolume: number;
  largest: number;
  yesVolume: number;
  noVolume: number;
  yesCount: number;
  noCount: number;
  trades: WhaleTrade[];
}
const eventIdCache = new Map<string, number>();
export async function getMarketWhales(marketId: string, eventTicker: string, exchange: string): Promise<MarketWhales> {
  noteBrowseTrack(exchange, eventTicker);
  let numericId = eventIdCache.get(eventTicker);
  if (numericId == null) {
    try {
      const res = await oddpoolPost<{ event_id?: number }>("/whales/user/events/by-ticker", {
        exchange: exchange.replace(/_us$/, ""),
        event_ticker: eventTicker,
        whale_threshold_usd: WHALE_THRESHOLD,
      });
      if (res.event_id != null) {
        numericId = res.event_id;
        eventIdCache.set(eventTicker, numericId);
      }
    } catch {}
  }
  let trades: WhaleTrade[] = [];
  try {
    const path =
      numericId != null
        ? `/whales/user/feed?event_id=${numericId}&limit=100&min_trade_size=${WHALE_THRESHOLD}`
        : `/whales/user/feed?limit=150&min_trade_size=${WHALE_THRESHOLD}`;
    const feed = await oddpoolGet<{ trades?: WhaleTrade[] }>(path);
    trades = (feed.trades || []).filter((t) => t.market_ticker === marketId);
  } catch {}
  const totalVolume = trades.reduce((s, t) => s + (t.trade_size_usd || 0), 0);
  const largest = trades.reduce((m, t) => Math.max(m, t.trade_size_usd || 0), 0);
  let yesVolume = 0, noVolume = 0, yesCount = 0, noCount = 0;
  for (const t of trades) {
    const v = t.trade_size_usd || 0;
    if (t.taker_side === "yes") { yesVolume += v; yesCount += 1; }
    else if (t.taker_side === "no") { noVolume += v; noCount += 1; }
  }
  return { marketId, count: trades.length, totalVolume, largest, yesVolume, noVolume, yesCount, noCount, trades: trades.slice(0, 15) };
}

// ─── Event detail (chart + outcomes + odds) for the search/browse feature ────────
export interface EventOutcome { market_id: string; question: string; exchange: string; yes: number | null; volume: number | null; liquidity: number | null; event_id: string; active: boolean }
export interface EventChartSeries { market_id: string; label: string; points: Array<{ ts: string; close: number }> }
export interface EventDetailPayload {
  event_id: string;
  exchange: string;
  title: string;
  category: string | null;
  status: string | null;
  totalVolume: number;
  totalLiquidity: number;
  outcomes: EventOutcome[];
  chart: EventChartSeries[];
  fetchedAt: string;
}
interface EventOhlcvResp { outcomes?: Array<{ market_id: string; outcome_label?: string; bars?: Array<{ ts: string; close: number | null }> }> }

export async function getEventDetail(eventId: string, exchange: string, range?: string): Promise<EventDetailPayload> {
  const enc = encodeURIComponent(eventId);
  const { last, interval } = rangeParams(range);
  const [mkRaw, chRaw] = await Promise.all([
    oddpoolGet<OPMarket[]>(`/search/events/${enc}/markets`).catch(() => [] as OPMarket[]),
    oddpoolGet<EventOhlcvResp>(`/events/${enc}/ohlcv?last=${last}&interval=${interval}`).catch(() => ({}) as EventOhlcvResp),
  ]);
  const ms = Array.isArray(mkRaw) ? mkRaw : [];
  const outcomes: EventOutcome[] = ms
    .map((m) => ({ market_id: m.market_id, question: m.question, exchange: m.exchange, yes: impliedYes(m), volume: m.volume, liquidity: m.liquidity, event_id: m.event_id, active: m.status === "active" && !m.settled_at }))
    .sort((a, b) => (b.volume || 0) - (a.volume || 0));
  const rank = new Map(outcomes.map((o, i) => [o.market_id, i] as const));
  // Drop outdated (resolved/settled) outcomes from the CHART — keep only markets still
  // trading, matching Oddpool's own site. The outcomes LIST below stays complete.
  const activeIds = new Set(ms.filter((m) => m.status === "active" && !m.settled_at).map((m) => m.market_id));
  const allSeries: EventChartSeries[] = (chRaw.outcomes || [])
    .map((o) => ({ market_id: o.market_id, label: o.outcome_label || o.market_id, points: (o.bars || []).filter((b) => b.close != null).map((b) => ({ ts: b.ts, close: b.close as number })) }))
    .filter((s) => s.points.length >= 2);
  const liveSeries = allSeries.filter((s) => activeIds.has(s.market_id));
  // If every outcome has resolved (fully-closed event), fall back to showing them all.
  const chart: EventChartSeries[] = (liveSeries.length ? liveSeries : allSeries)
    .sort((a, b) => (rank.get(a.market_id) ?? 99) - (rank.get(b.market_id) ?? 99))
    .slice(0, 5);
  return {
    event_id: eventId,
    exchange: exchange.replace(/_us$/, ""),
    title: ms[0]?.event_title || eventId,
    category: ms[0]?.category ?? null,
    // Event is active if ANY outcome market is still trading; otherwise fall back to the
    // top market's status. (ms[0] is the highest-volume market, which may have already resolved.)
    status: ms.some((m) => m.status === "active") ? "active" : (ms[0]?.status ?? null),
    totalVolume: outcomes.reduce((s, o) => s + (o.volume || 0), 0),
    totalLiquidity: outcomes.reduce((s, o) => s + (o.liquidity || 0), 0),
    outcomes,
    chart,
    fetchedAt: new Date().toISOString(),
  };
}

// Event-level whale activity + sentiment (yes vs no $). Tracks the event (idempotent, cached id).
export interface EventWhaleOutcome { marketId: string; label: string; yesVolume: number; noVolume: number; total: number; count: number }
export interface EventWhales { eventId: string; tradeCount: number; totalVolume: number; yesVolume: number; noVolume: number; outcomes: EventWhaleOutcome[]; trades: WhaleTrade[] }
export async function getEventWhales(eventTicker: string, exchange: string): Promise<EventWhales> {
  noteBrowseTrack(exchange, eventTicker);
  let numericId = eventIdCache.get(eventTicker);
  if (numericId == null) {
    try {
      const res = await oddpoolPost<{ event_id?: number }>("/whales/user/events/by-ticker", {
        exchange: exchange.replace(/_us$/, ""),
        event_ticker: eventTicker,
        whale_threshold_usd: WHALE_THRESHOLD,
      });
      if (res.event_id != null) numericId = res.event_id;
    } catch {
      /* already-tracked events return a 4xx here — fall through to the tracked-list lookup */
    }
    if (numericId == null) {
      try {
        const list = await oddpoolGetFresh<{ tracked_events?: Array<{ event_id: number; event_ticker: string }> }>("/whales/user/events");
        const hit = (list.tracked_events || []).find((e) => e.event_ticker === eventTicker);
        if (hit) numericId = hit.event_id;
      } catch {}
    }
    if (numericId != null) eventIdCache.set(eventTicker, numericId);
  }
  let trades: WhaleTrade[] = [];
  let yesVolume = 0, noVolume = 0, tradeCount = 0, totalVolume = 0;
  if (numericId != null) {
    try {
      const feed = await oddpoolGetFresh<{ trades?: WhaleTrade[] }>(`/whales/user/feed?event_id=${numericId}&limit=100&min_trade_size=${WHALE_THRESHOLD}`);
      trades = feed.trades || [];
    } catch {}
    try {
      const st = await oddpoolGetFresh<{ stats?: { trade_count?: number; total_volume?: number; yes_volume?: number; no_volume?: number } }>(`/whales/user/event/${numericId}/stats?period=all`);
      const s = st.stats || {};
      tradeCount = s.trade_count || 0;
      totalVolume = s.total_volume || 0;
      yesVolume = s.yes_volume || 0;
      noVolume = s.no_volume || 0;
    } catch {}
  }
  if (yesVolume === 0 && noVolume === 0) for (const t of trades) { const v = t.trade_size_usd || 0; if (t.taker_side === "yes") yesVolume += v; else if (t.taker_side === "no") noVolume += v; }
  if (!totalVolume) totalVolume = trades.reduce((s, t) => s + (t.trade_size_usd || 0), 0);
  if (!tradeCount) tradeCount = trades.length;
  // Per-outcome YES/NO breakdown (from the fetched feed) for the diverging bar chart.
  const byOutcome = new Map<string, EventWhaleOutcome>();
  for (const t of trades) {
    const key = t.market_ticker || t.market_title || "?";
    const cur = byOutcome.get(key) || { marketId: t.market_ticker || key, label: t.market_title || key, yesVolume: 0, noVolume: 0, total: 0, count: 0 };
    const v = t.trade_size_usd || 0;
    if (t.taker_side === "yes") cur.yesVolume += v;
    else if (t.taker_side === "no") cur.noVolume += v;
    cur.total = cur.yesVolume + cur.noVolume;
    cur.count += 1;
    byOutcome.set(key, cur);
  }
  const whaleOutcomes = [...byOutcome.values()].filter((o) => o.total > 0).sort((a, b) => b.total - a.total);
  return { eventId: eventTicker, tradeCount, totalVolume, yesVolume, noVolume, outcomes: whaleOutcomes, trades: trades.slice(0, 15) };
}

// ── Search (events + markets) ──────────────────────────────────────────────
// /search/{events,markets} require q OR series_id (else 400); an empty query
// falls back to /search/recent/* (exchange + limit only — other filters ignored).
export interface SearchParams {
  q?: string;
  exchange?: string; // "" = all
  status?: string; // active | closed
  category?: string;
  minVolume?: number;
  minLiquidity?: number; // markets only
  sortBy?: string; // relevance | volume | newest | liquidity | markets
  limit?: number;
  offset?: number;
}
export interface EventResult {
  event_id: string; exchange: string; title: string; category: string | null; status: string | null;
  totalVolume: number | null; totalLiquidity: number | null; marketCount: number | null; image: string | null;
}
export interface MarketResult {
  market_id: string; question: string; exchange: string; yes: number | null;
  volume: number | null; liquidity: number | null; event_id: string; category: string | null; status: string | null;
}
interface OPEventSearch { event_id: string; exchange: string; title: string; category: string | null; status?: string; total_volume?: number | null; total_liquidity?: number | null; market_count?: number | null; image_url?: string | null }

const clampLimit = (n?: number) => String(Math.min(100, Math.max(1, n || 25)));
function searchQuery(p: SearchParams, markets: boolean): string {
  const sp = new URLSearchParams();
  if (p.q) sp.set("q", p.q);
  if (p.exchange) sp.set("exchange", p.exchange);
  if (p.status) sp.set("status", p.status);
  if (p.category) sp.set("category", p.category);
  if (p.minVolume) sp.set("min_volume", String(p.minVolume));
  if (markets && p.minLiquidity) sp.set("min_liquidity", String(p.minLiquidity));
  if (p.sortBy && (p.sortBy !== "relevance" || p.q)) sp.set("sort_by", p.sortBy); // relevance needs q
  sp.set("limit", clampLimit(p.limit));
  if (p.offset) sp.set("offset", String(p.offset));
  return sp.toString();
}
function recentQuery(p: SearchParams): string {
  const sp = new URLSearchParams();
  if (p.exchange) sp.set("exchange", p.exchange);
  sp.set("limit", clampLimit(p.limit));
  return sp.toString();
}

export async function searchEventsFull(p: SearchParams): Promise<EventResult[]> {
  const hasQ = !!p.q?.trim();
  let raw: OPEventSearch[] = [];
  try {
    raw = await oddpoolGet<OPEventSearch[]>(hasQ ? `/search/events?${searchQuery(p, false)}` : `/search/recent/events?${recentQuery(p)}`);
  } catch { raw = []; }
  return (Array.isArray(raw) ? raw : []).map((e) => ({
    event_id: e.event_id,
    exchange: (e.exchange || "").replace(/_us$/, ""),
    title: e.title,
    category: e.category ?? null,
    status: e.status ?? null,
    totalVolume: e.total_volume ?? null,
    totalLiquidity: e.total_liquidity ?? null,
    marketCount: e.market_count ?? null,
    image: e.image_url ?? null,
  }));
}

export async function searchMarketsFull(p: SearchParams): Promise<MarketResult[]> {
  const hasQ = !!p.q?.trim();
  let raw: OPMarket[] = [];
  try {
    raw = await oddpoolGet<OPMarket[]>(hasQ ? `/search/markets?${searchQuery(p, true)}` : `/search/recent/markets?${recentQuery(p)}`);
  } catch { raw = []; }
  return (Array.isArray(raw) ? raw : []).map((m) => ({
    market_id: m.market_id,
    question: m.question,
    exchange: (m.exchange || "").replace(/_us$/, ""),
    yes: impliedYes(m),
    volume: m.volume,
    liquidity: m.liquidity,
    event_id: m.event_id,
    category: m.category ?? null,
    status: m.status ?? null,
  }));
}
