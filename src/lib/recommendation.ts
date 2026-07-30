// Average analyst recommendation per stock, from Finnhub's monthly recommendation-trends
// (strongBuy/buy/hold/sell/strongSell analyst counts). We reduce the NEWEST month to a
// weighted-mean label (Finnhub-native buckets). Server-side only — holds FINNHUB_API_KEY.
// Analyst trends move ~monthly, so we cache for hours. Names with no coverage return nothing
// (the client hides the tag).

const BASE = "https://finnhub.io/api/v1";

export interface RecCounts {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export interface Recommendation {
  label: string; // Strong Buy | Buy | Hold | Sell | Strong Sell
  score: number; // weighted mean on a 5 (strongBuy) … 1 (strongSell) scale
  analysts: number; // total analysts in the newest month
  period: string; // month the consensus is from, e.g. "2026-07-01"
  counts: RecCounts; // the newest month's per-bucket analyst counts
}

interface FinnhubRec {
  symbol: string;
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

// Finnhub-native vocabulary: Strong Buy / Buy / Hold / Sell / Strong Sell.
function toLabel(mean: number): string {
  if (mean >= 4.5) return "Strong Buy";
  if (mean >= 3.5) return "Buy";
  if (mean >= 2.5) return "Hold";
  if (mean >= 1.5) return "Sell";
  return "Strong Sell";
}

// Newest month (rows[0]) → weighted-mean label, or null when there's no analyst coverage.
function reduce(rows: FinnhubRec[] | null): Recommendation | null {
  if (!rows || !rows.length) return null;
  const r = rows[0];
  const n = (r.strongBuy || 0) + (r.buy || 0) + (r.hold || 0) + (r.sell || 0) + (r.strongSell || 0);
  if (!n) return null;
  const mean = (5 * r.strongBuy + 4 * r.buy + 3 * r.hold + 2 * r.sell + 1 * r.strongSell) / n;
  return {
    label: toLabel(mean),
    score: Math.round(mean * 100) / 100,
    analysts: n,
    period: r.period,
    counts: { strongBuy: r.strongBuy, buy: r.buy, hold: r.hold, sell: r.sell, strongSell: r.strongSell },
  };
}

const cache = new Map<string, { at: number; data: Recommendation | null }>();
const TTL = 12 * 60 * 60 * 1000; // 12h — the underlying data only changes monthly

export async function getRecommendations(symbols: string[]): Promise<Record<string, Recommendation>> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return {};
  const now = Date.now();
  const out: Record<string, Recommendation> = {};
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
        const res = await fetch(`${BASE}/stock/recommendation?symbol=${encodeURIComponent(sym)}&token=${key}`, {
          next: { revalidate: 43200 },
        });
        if (!res.ok) throw new Error(`finnhub ${res.status}`);
        const j = (await res.json()) as FinnhubRec[];
        const rec = reduce(Array.isArray(j) ? j : null);
        cache.set(sym, { at: now, data: rec });
        if (rec) out[sym] = rec;
      } catch {
        if (hit?.data) out[sym] = hit.data; // serve stale on a transient error
      }
    }),
  );
  return out;
}
