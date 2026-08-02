// Real per-ticker market statistics (annualized volatility σ and beta-to-market β) from Alpaca daily
// bars, cached on the shared `assets` row. A single-factor model then implies every pairwise
// correlation from these O(N) numbers (see computeFrontier), so we never store any price history.
//
// The cache is shared across all portfolios and refreshed lazily: a ticker is (re)computed only when
// it is missing or older than TTL_DAYS. In practice that means one Alpaca call the first time any user
// adds a given stock, then instant cache hits for every later edit — weight changes and removals fetch
// nothing (they don't change correlations). Compute is pure math; no LLM/agent tokens involved.

import { getMarketStats, setMarketStats, type MarketStat } from "@/lib/turso";
import type { MarketData } from "@/lib/portfolioTheory";

const MARKET = "SPY"; // market proxy
const TTL_DAYS = 7; // β/σ move slowly; a week-old value is fine
const WINDOW_DAYS = 370; // ~1 year of calendar days → ~252 trading days
const TRADING_DAYS = 252;
const MIN_RETURNS = 40; // need a reasonable history for a stable estimate

const ALPACA_ID = process.env.ALPACA_API_KEY_ID || "";
const ALPACA_SECRET = process.env.ALPACA_API_SECRET_KEY || "";

// Fetch adjusted daily closes for several symbols in one paginated call. Returns date→close per symbol.
async function fetchDailyCloses(symbols: string[]): Promise<Record<string, Map<string, number>>> {
  const out: Record<string, Map<string, number>> = {};
  if (!symbols.length || !ALPACA_ID || !ALPACA_SECRET) return out;
  const start = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const headers = { "APCA-API-KEY-ID": ALPACA_ID, "APCA-API-SECRET-KEY": ALPACA_SECRET };
  let pageToken = "";
  for (let page = 0; page < 20; page++) {
    const u = new URL("https://data.alpaca.markets/v2/stocks/bars");
    u.searchParams.set("symbols", symbols.join(","));
    u.searchParams.set("timeframe", "1Day");
    u.searchParams.set("start", start);
    u.searchParams.set("adjustment", "all");
    u.searchParams.set("feed", "iex");
    u.searchParams.set("limit", "10000");
    if (pageToken) u.searchParams.set("page_token", pageToken);
    const res = await fetch(u, { headers, cache: "no-store" });
    if (!res.ok) throw new Error(`Alpaca ${res.status}`);
    const j = (await res.json()) as { bars?: Record<string, Array<{ t: string; c: number }>>; next_page_token?: string | null };
    for (const [sym, bars] of Object.entries(j.bars || {})) {
      const m = out[sym] || (out[sym] = new Map());
      for (const b of bars) m.set(b.t.slice(0, 10), b.c);
    }
    if (!j.next_page_token) break;
    pageToken = j.next_page_token;
  }
  return out;
}

// Log-return series (date → return) from a date→close map.
function returns(closes: Map<string, number>): Map<string, number> {
  const dates = [...closes.keys()].sort();
  const r = new Map<string, number>();
  for (let i = 1; i < dates.length; i++) {
    const prev = closes.get(dates[i - 1])!, cur = closes.get(dates[i])!;
    if (prev > 0 && cur > 0) r.set(dates[i], Math.log(cur / prev));
  }
  return r;
}
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
};

// Compute σ (annualized) + β (vs market) for each ticker from fetched closes. Market gets β = 1.
function computeStats(closesBySym: Record<string, Map<string, number>>): { stats: Record<string, { beta: number; sigma: number }>; sigmaMkt: number } | null {
  const mktCloses = closesBySym[MARKET];
  if (!mktCloses || mktCloses.size < MIN_RETURNS) return null;
  const mktRet = returns(mktCloses);
  const mktDates = [...mktRet.keys()].sort();
  const mktVarArr = mktDates.map((d) => mktRet.get(d)!);
  const mktMean = mean(mktVarArr);
  const mktVar = mktVarArr.reduce((s, x) => s + (x - mktMean) * (x - mktMean), 0) / mktVarArr.length || 1e-9;
  const sigmaMkt = std(mktVarArr) * Math.sqrt(TRADING_DAYS);

  const stats: Record<string, { beta: number; sigma: number }> = { [MARKET]: { beta: 1, sigma: sigmaMkt } };
  for (const [sym, closes] of Object.entries(closesBySym)) {
    if (sym === MARKET) continue;
    const ret = returns(closes);
    const dates = mktDates.filter((d) => ret.has(d)); // align on common trading days
    if (dates.length < MIN_RETURNS) continue;
    const x = dates.map((d) => ret.get(d)!);
    const y = dates.map((d) => mktRet.get(d)!);
    const mx = mean(x), my = mean(y);
    let cov = 0;
    for (let i = 0; i < dates.length; i++) cov += (x[i] - mx) * (y[i] - my);
    cov /= dates.length;
    stats[sym] = { beta: cov / mktVar, sigma: std(x) * Math.sqrt(TRADING_DAYS) };
  }
  return { stats, sigmaMkt };
}

function isStale(s: MarketStat | undefined, now: number): boolean {
  if (!s || s.mktAt == null) return true;
  const t = Date.parse(s.mktAt);
  return !Number.isFinite(t) || now - t > TTL_DAYS * 864e5;
}

// Ensure fresh β/σ exist for the given tickers, fetching from Alpaca ONLY the missing/stale ones
// (plus the market proxy when any recompute is needed). Returns MarketData for computeFrontier, or
// null if the market proxy is unavailable (→ callers fall back to illustrative assumptions).
export async function ensureMarketStats(tickers: string[]): Promise<MarketData | null> {
  const uniq = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))];
  const now = Date.now();
  const cached = await getMarketStats([...uniq, MARKET]);

  const stale = uniq.filter((t) => isStale(cached[t], now));
  const mktStale = isStale(cached[MARKET], now);

  if ((stale.length || mktStale) && ALPACA_ID && ALPACA_SECRET) {
    try {
      // Always include the market proxy — computing any β needs its return series.
      const toFetch = [...new Set([...stale, MARKET])];
      const closes = await fetchDailyCloses(toFetch);
      const computed = computeStats(closes);
      if (computed) {
        const at = new Date(now).toISOString();
        const write = Object.entries(computed.stats)
          .filter(([, v]) => Number.isFinite(v.beta) && Number.isFinite(v.sigma) && v.sigma > 0)
          .map(([ticker, v]) => ({ ticker, beta: v.beta, sigma: v.sigma, mktAt: at }));
        if (write.length) {
          await setMarketStats(write);
          for (const w of write) cached[w.ticker] = { ticker: w.ticker, beta: w.beta, sigma: w.sigma, mktAt: w.mktAt };
        }
      }
    } catch {
      /* Alpaca hiccup → use whatever is cached; missing tickers fall back to illustrative */
    }
  }

  const mkt = cached[MARKET];
  if (!mkt) return null; // no market volatility → can't imply correlations; illustrative everywhere
  const sigma: Record<string, number> = {};
  const beta: Record<string, number> = {};
  for (const t of uniq) {
    const s = cached[t];
    if (s) { sigma[t] = s.sigma; beta[t] = s.beta; }
  }
  return { sigma, beta, sigmaMkt: mkt.sigma };
}
