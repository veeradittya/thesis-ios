// Server-side Finnhub quote seed for the live-prices card. The API key stays on the
// server; live ticks come over a websocket relayed via /api/prices (see priceStream.ts).

const BASE = "https://finnhub.io/api/v1";

function apiKey(): string {
  const k = process.env.FINNHUB_API_KEY;
  if (!k) throw new Error("FINNHUB_API_KEY is not set");
  return k;
}

export interface Quote {
  symbol: string;
  price: number | null; // current/last
  prevClose: number | null; // for change% reference
  change: number | null;
  percent: number | null;
  dayLow: number | null; // today's low  (Finnhub `l`) — feeds the Day Range widget
  dayHigh: number | null; // today's high (Finnhub `h`)
}

// Seed snapshot: current price + previous close so the card can show change% immediately.
export async function getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  const key = apiKey();
  const out: Record<string, Quote> = {};
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const r = await fetch(`${BASE}/quote?symbol=${encodeURIComponent(s)}&token=${key}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { c?: number; pc?: number; d?: number; dp?: number; l?: number; h?: number };
        out[s] = { symbol: s, price: d.c ?? null, prevClose: d.pc ?? null, change: d.d ?? null, percent: d.dp ?? null, dayLow: d.l ?? null, dayHigh: d.h ?? null };
      } catch {
        /* skip this symbol */
      }
    }),
  );
  return out;
}
