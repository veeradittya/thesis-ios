// Per-stock 52-week high/low from Finnhub's /stock/metric endpoint (FREE — feeds the 52-Week
// Range widget). Server-side only — holds FINNHUB_API_KEY. The range moves slowly, so cache hours.
// (Analyst price targets live behind Finnhub's premium /stock/price-target — not fetched here.)

const BASE = "https://finnhub.io/api/v1";

export interface StockMetric {
  week52High: number | null;
  week52Low: number | null;
}

const cache = new Map<string, { at: number; data: StockMetric | null }>();
const TTL = 12 * 60 * 60 * 1000; // 12h — 52-week range moves slowly

export async function getMetrics(symbols: string[]): Promise<Record<string, StockMetric>> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return {};
  const now = Date.now();
  const out: Record<string, StockMetric> = {};
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
        const res = await fetch(`${BASE}/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all&token=${key}`, { next: { revalidate: 43200 } });
        if (!res.ok) throw new Error(`finnhub ${res.status}`);
        const m = ((await res.json()) as { metric?: Record<string, number | null | undefined> }).metric || {};
        const data: StockMetric = { week52High: m["52WeekHigh"] ?? null, week52Low: m["52WeekLow"] ?? null };
        const ok = data.week52High != null && data.week52Low != null;
        cache.set(sym, { at: now, data: ok ? data : null });
        if (ok) out[sym] = data;
      } catch {
        if (hit?.data) out[sym] = hit.data; // serve stale on a transient error
      }
    }),
  );
  return out;
}
