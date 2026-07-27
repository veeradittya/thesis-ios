// Personalized onboarding stock suggestions — v1 heuristic (no ML). Ranks a curated universe of
// heavily-covered US large/mega-caps by (a) whether they're Finnhub sector-peers of the user's
// picks and (b) a popularity prior (array order), then caps per sector for diversity. Suggestions
// are confined to this covered universe so the daily thesis analysis always has news to work with;
// the onboarding search box handles anything outside it.
//
// Sources behind this design (deep-research): Finnhub /stock/peers (content-based similarity),
// popularity/coverage prior for cold-start, sector-diversity cap. Deferred: live 13F/ETF-overlap
// co-holding signals and embedding models.

export interface Suggestion {
  symbol: string;
  name: string;
  sector: string;
}

// Rank = array order (retail-interest / mega-cap first). One sector each.
const UNIVERSE: Suggestion[] = [
  { symbol: "NVDA", name: "NVIDIA", sector: "Semiconductors" },
  { symbol: "TSLA", name: "Tesla", sector: "Auto & EV" },
  { symbol: "AAPL", name: "Apple", sector: "Technology" },
  { symbol: "AMZN", name: "Amazon", sector: "Consumer" },
  { symbol: "MSFT", name: "Microsoft", sector: "Technology" },
  { symbol: "GOOGL", name: "Alphabet", sector: "Technology" },
  { symbol: "META", name: "Meta Platforms", sector: "Communication" },
  { symbol: "AMD", name: "Advanced Micro Devices", sector: "Semiconductors" },
  { symbol: "PLTR", name: "Palantir", sector: "Technology" },
  { symbol: "COIN", name: "Coinbase", sector: "Crypto" },
  { symbol: "AVGO", name: "Broadcom", sector: "Semiconductors" },
  { symbol: "MSTR", name: "MicroStrategy", sector: "Crypto" },
  { symbol: "HOOD", name: "Robinhood", sector: "Financials" },
  { symbol: "NFLX", name: "Netflix", sector: "Communication" },
  { symbol: "DIS", name: "Walt Disney", sector: "Communication" },
  { symbol: "COST", name: "Costco", sector: "Consumer" },
  { symbol: "WMT", name: "Walmart", sector: "Consumer" },
  { symbol: "JPM", name: "JPMorgan Chase", sector: "Financials" },
  { symbol: "V", name: "Visa", sector: "Financials" },
  { symbol: "MA", name: "Mastercard", sector: "Financials" },
  { symbol: "LLY", name: "Eli Lilly", sector: "Healthcare" },
  { symbol: "UNH", name: "UnitedHealth", sector: "Healthcare" },
  { symbol: "PYPL", name: "PayPal", sector: "Financials" },
  { symbol: "F", name: "Ford", sector: "Auto & EV" },
  { symbol: "GM", name: "General Motors", sector: "Auto & EV" },
  { symbol: "RIVN", name: "Rivian", sector: "Auto & EV" },
  { symbol: "INTC", name: "Intel", sector: "Semiconductors" },
  { symbol: "MU", name: "Micron", sector: "Semiconductors" },
  { symbol: "QCOM", name: "Qualcomm", sector: "Semiconductors" },
  { symbol: "ORCL", name: "Oracle", sector: "Technology" },
  { symbol: "CRM", name: "Salesforce", sector: "Technology" },
  { symbol: "ADBE", name: "Adobe", sector: "Technology" },
  { symbol: "CSCO", name: "Cisco", sector: "Technology" },
  { symbol: "TXN", name: "Texas Instruments", sector: "Semiconductors" },
  { symbol: "ARM", name: "Arm Holdings", sector: "Semiconductors" },
  { symbol: "HD", name: "Home Depot", sector: "Consumer" },
  { symbol: "NKE", name: "Nike", sector: "Consumer" },
  { symbol: "SBUX", name: "Starbucks", sector: "Consumer" },
  { symbol: "MCD", name: "McDonald's", sector: "Consumer" },
  { symbol: "BAC", name: "Bank of America", sector: "Financials" },
  { symbol: "GS", name: "Goldman Sachs", sector: "Financials" },
  { symbol: "JNJ", name: "Johnson & Johnson", sector: "Healthcare" },
  { symbol: "PFE", name: "Pfizer", sector: "Healthcare" },
  { symbol: "XOM", name: "Exxon Mobil", sector: "Energy" },
  { symbol: "CVX", name: "Chevron", sector: "Energy" },
  { symbol: "SPY", name: "S&P 500 ETF", sector: "Index / ETF" },
  { symbol: "QQQ", name: "Nasdaq-100 ETF", sector: "Index / ETF" },
  { symbol: "VOO", name: "Vanguard S&P 500 ETF", sector: "Index / ETF" },
];

const NAME_BY_SYMBOL = new Map(UNIVERSE.map((u) => [u.symbol, u]));
export const UNIVERSE_SYMBOLS = UNIVERSE.map((u) => u.symbol);
export function lookupSuggestion(symbol: string): Suggestion | undefined {
  return NAME_BY_SYMBOL.get(symbol.trim().toUpperCase());
}

const FINNHUB = "https://finnhub.io/api/v1";
const peerCache = new Map<string, { at: number; peers: string[] }>();
const PEER_TTL = 24 * 3600e3;

async function peersOf(ticker: string, key: string): Promise<string[]> {
  const hit = peerCache.get(ticker);
  if (hit && Date.now() - hit.at < PEER_TTL) return hit.peers;
  try {
    const r = await fetch(`${FINNHUB}/stock/peers?symbol=${encodeURIComponent(ticker)}&token=${key}`, { cache: "no-store" });
    if (!r.ok) return [];
    const arr = await r.json();
    const peers = Array.isArray(arr) ? arr.map((s) => String(s).toUpperCase()) : [];
    peerCache.set(ticker, { at: Date.now(), peers });
    return peers;
  } catch {
    return [];
  }
}

const PAGE = 7;
const SECTOR_CAP = 3;
const PEER_BUDGET_MS = 600; // never block the section longer than this on live peer calls

// picks → 7 diversified suggestions from the covered universe. `page` cycles the pool (refresh).
export async function recommend(picks: string[], page = 0): Promise<Suggestion[]> {
  const key = process.env.FINNHUB_API_KEY;
  const pickSet = new Set(picks.map((p) => p.trim().toUpperCase()).filter(Boolean));

  // Peer-overlap score: how many of the user's picks list this symbol as a sector peer. This only
  // REORDERS a fixed universe, so it's never worth stalling the UI: race the live Finnhub calls
  // against a short budget and fall back to the popularity ranking if they don't beat it. The
  // in-flight fetches still populate the module cache, so warm requests get the personalised order.
  const peerScore = new Map<string, number>();
  if (key && pickSet.size) {
    const all = Promise.all([...pickSet].slice(0, 8).map((p) => peersOf(p, key)));
    const budget = new Promise<string[][]>((resolve) => setTimeout(() => resolve([]), PEER_BUDGET_MS));
    const lists = await Promise.race([all, budget]);
    for (const list of lists) for (const s of list) peerScore.set(s, (peerScore.get(s) || 0) + 1);
  }

  // Rank the universe: more peer overlap first, then popularity (original order). Exclude picks.
  const ranked = UNIVERSE.map((u, i) => ({ u, i }))
    .filter((x) => !pickSet.has(x.u.symbol))
    .sort((a, b) => (peerScore.get(b.u.symbol) || 0) - (peerScore.get(a.u.symbol) || 0) || a.i - b.i)
    .map((x) => x.u);

  // Sector-diversity cap: the first pass takes ≤3 per sector; leftovers append after (for deep pages).
  const perSector = new Map<string, number>();
  const diversified: Suggestion[] = [];
  const overflow: Suggestion[] = [];
  for (const s of ranked) {
    const n = perSector.get(s.sector) || 0;
    if (n < SECTOR_CAP) {
      perSector.set(s.sector, n + 1);
      diversified.push(s);
    } else overflow.push(s);
  }
  const pool = [...diversified, ...overflow];
  if (!pool.length) return [];

  // Cyclic slice so refresh always returns a full page of 7, wrapping around the pool.
  const start = (page * PAGE) % pool.length;
  const out: Suggestion[] = [];
  for (let k = 0; k < Math.min(PAGE, pool.length); k++) out.push(pool[(start + k) % pool.length]);
  return out;
}
