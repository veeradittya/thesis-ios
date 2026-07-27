// Local cache for the last /api/quote snapshot, so the portfolio shows prices instantly on load
// (before the one refresh fetch returns) and survives navigation. Prices are the same for everyone,
// so a single browser-wide key is fine. We no longer poll on an interval — prices refresh on page
// load and on pull-to-refresh only.

export interface CachedQuote {
  price: number | null;
  prevClose?: number | null;
  change?: number | null;
  percent: number | null;
}

const KEY = "thesis.quotes.v1";

export function readQuoteCache(symbols: string[]): Record<string, CachedQuote> {
  if (typeof window === "undefined") return {};
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, CachedQuote>;
    const out: Record<string, CachedQuote> = {};
    for (const s of symbols) if (all[s]) out[s] = all[s];
    return out;
  } catch {
    return {};
  }
}

export function writeQuoteCache(quotes: Record<string, CachedQuote>): void {
  if (typeof window === "undefined") return;
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, CachedQuote>;
    Object.assign(all, quotes);
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}
