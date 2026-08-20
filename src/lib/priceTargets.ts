// Analyst price-target data per stock, from FMP (Financial Modeling Prep) stable API:
//  • consensus  — high / low / consensus / median across analysts.
//  • trend      — the average target over trailing windows (last year / quarter / month) + counts,
//                 so the client can plot how the consensus target has been moving.
// Server-side only — holds FMP_API_KEY. Targets move slowly, so we cache for hours. Names with no
// coverage return nothing (the client hides the section). Batched, mirroring recommendation.ts.

const BASE = "https://financialmodelingprep.com/stable";

export interface TargetWindow {
  avg: number | null;
  count: number | null;
}
export interface PriceTarget {
  high: number | null;
  low: number | null;
  consensus: number | null;
  median: number | null;
  // Trailing-window average targets (broad → recent), for the trend graph.
  trend: { year: TargetWindow; quarter: TargetWindow; month: TargetWindow } | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function fetchConsensus(sym: string, key: string): Promise<Pick<PriceTarget, "high" | "low" | "consensus" | "median"> | null> {
  const res = await fetch(`${BASE}/price-target-consensus?symbol=${encodeURIComponent(sym)}&apikey=${key}`, { next: { revalidate: 43200 } });
  if (!res.ok) return null;
  const j = await res.json();
  const r = Array.isArray(j) ? (j[0] as Record<string, unknown> | undefined) : undefined;
  if (!r) return null;
  return { high: num(r.targetHigh), low: num(r.targetLow), consensus: num(r.targetConsensus), median: num(r.targetMedian) };
}

async function fetchTrend(sym: string, key: string): Promise<PriceTarget["trend"]> {
  const res = await fetch(`${BASE}/price-target-summary?symbol=${encodeURIComponent(sym)}&apikey=${key}`, { next: { revalidate: 43200 } });
  if (!res.ok) return null;
  const j = await res.json();
  const r = Array.isArray(j) ? (j[0] as Record<string, unknown> | undefined) : undefined;
  if (!r) return null;
  return {
    year: { avg: num(r.lastYearAvgPriceTarget), count: num(r.lastYearCount) },
    quarter: { avg: num(r.lastQuarterAvgPriceTarget), count: num(r.lastQuarterCount) },
    month: { avg: num(r.lastMonthAvgPriceTarget), count: num(r.lastMonthCount) },
  };
}

const cache = new Map<string, { at: number; data: PriceTarget | null }>();
const TTL = 12 * 60 * 60 * 1000; // 12h — consensus targets change slowly

export async function getPriceTargets(symbols: string[]): Promise<Record<string, PriceTarget>> {
  const key = process.env.FMP_API_KEY;
  if (!key) return {};
  const now = Date.now();
  const out: Record<string, PriceTarget> = {};
  await Promise.all(
    symbols.map(async (raw) => {
      const sym = raw.trim().toUpperCase();
      if (!sym) return;
      const hit = cache.get(sym);
      if (hit && now - hit.at < TTL) {
        if (hit.data) out[sym] = hit.data;
        return;
      }
      try {
        const [consensus, trend] = await Promise.all([fetchConsensus(sym, key), fetchTrend(sym, key)]);
        const data: PriceTarget | null =
          consensus && (consensus.consensus != null || consensus.high != null) ? { ...consensus, trend } : null;
        cache.set(sym, { at: now, data });
        if (data) out[sym] = data;
      } catch {
        if (hit?.data) out[sym] = hit.data; // serve stale on a transient error
      }
    }),
  );
  return out;
}
