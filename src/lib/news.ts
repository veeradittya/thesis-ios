// Multi-source per-ticker news (Alpaca/Benzinga + Finnhub + NYT + Guardian), server-side.
// Extracted from the old /api/news route so the analysis pipeline can reuse it directly
// (no HTTP self-call). All API keys stay server-side.

import { guardianFetch, guardianKeys } from "@/lib/guardianFetch";

export interface Article {
  id: string;
  ticker: string;
  provider: "Alpaca" | "Finnhub" | "NYT" | "Guardian";
  source: string;
  headline: string;
  summary: string;
  url: string;
  image: string | null;
  datetime: number; // unix ms
}

export const RECENCY_MS = 45 * 864e5; // drop coverage older than ~45 days

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function stripTags(s: string): string {
  return (s || "").replace(/<[^>]+>/g, "").trim();
}

function decodeEntities(s: string): string {
  return (s || "")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function clean(s: string): string {
  return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
}

// Text-search APIs (NYT/Guardian) match loosely, so keep only articles that actually
// name the company (full name, or its most distinctive token).
function relevantTo(text: string, name: string): boolean {
  const t = text.toLowerCase();
  if (t.includes(name.toLowerCase())) return true;
  const longest = name
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .sort((a, b) => b.length - a.length)[0];
  return longest ? t.includes(longest) : true;
}

// Resolve a ticker to a clean company name for text-search APIs (NYT/Guardian),
// e.g. "NVDA" -> "NVIDIA". Falls back to the ticker if the lookup fails.
async function companyName(ticker: string, key: string): Promise<string> {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${key}`,
      { cache: "no-store" },
    );
    if (!res.ok) return ticker;
    const d = (await res.json()) as { name?: string };
    const cleaned = (d?.name || "")
      .replace(/[,.]/g, " ")
      .replace(/\b(Corporation|Corp|Inc|Incorporated|Company|Co|Ltd|Limited|PLC|Holdings?|Group|The)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned || ticker;
  } catch {
    return ticker;
  }
}

async function alpacaNews(ticker: string, idKey: string, secretKey: string): Promise<Article[]> {
  const url = `https://data.alpaca.markets/v1beta1/news?symbols=${encodeURIComponent(ticker)}&limit=30&sort=desc`;
  const res = await fetch(url, {
    headers: { "APCA-API-KEY-ID": idKey, "APCA-API-SECRET-KEY": secretKey },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    news?: Array<{
      id?: number;
      headline?: string;
      summary?: string;
      url?: string;
      source?: string;
      created_at?: string;
      images?: Array<{ size?: string; url?: string }>;
    }>;
  };
  const news = data?.news ?? [];
  return news
    .map((n) => {
      const img = n.images?.find((i) => i.size === "large") || n.images?.[0];
      return {
        id: `ap_${n.id}`,
        ticker,
        provider: "Alpaca" as const,
        source: n.source || "Benzinga",
        headline: n.headline || "",
        summary: n.summary || "",
        url: n.url || "",
        image: img?.url || null,
        datetime: n.created_at ? Date.parse(n.created_at) : 0,
      };
    })
    .filter((a) => a.headline && a.url);
}

async function finnhubNews(ticker: string, key: string): Promise<Article[]> {
  const to = new Date();
  const from = new Date(Date.now() - 30 * 864e5);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(
    ticker,
  )}&from=${ymd(from)}&to=${ymd(to)}&token=${key}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{
    id?: number;
    headline?: string;
    summary?: string;
    url?: string;
    image?: string;
    source?: string;
    datetime?: number;
  }>;
  if (!Array.isArray(data)) return [];
  return data
    .slice(0, 40)
    .map((a) => ({
      id: `fh_${a.id}`,
      ticker,
      provider: "Finnhub" as const,
      source: a.source || "Newswire",
      headline: a.headline || "",
      summary: a.summary || "",
      url: a.url || "",
      image: a.image || null,
      datetime: (a.datetime || 0) * 1000,
    }))
    .filter((a) => a.headline && a.url);
}

async function nytNews(query: string, ticker: string, key: string): Promise<Article[]> {
  const url = `https://api.nytimes.com/svc/search/v2/articlesearch.json?q=${encodeURIComponent(
    query,
  )}&sort=newest&api-key=${key}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    response?: {
      docs?: Array<{
        _id?: string;
        web_url?: string;
        abstract?: string;
        snippet?: string;
        pub_date?: string;
        headline?: { main?: string };
        multimedia?: Array<{ url?: string }>;
      }>;
    };
  };
  const docs = data?.response?.docs ?? [];
  return docs
    .slice(0, 6)
    .map((d) => {
      const mm = (d.multimedia || []).find((m) => m.url);
      return {
        id: `nyt_${d._id}`,
        ticker,
        provider: "NYT" as const,
        source: "The New York Times",
        headline: d.headline?.main || "",
        summary: d.abstract || d.snippet || "",
        url: d.web_url || "",
        image: mm?.url ? `https://www.nytimes.com/${mm.url}` : null,
        datetime: d.pub_date ? Date.parse(d.pub_date) : 0,
      };
    })
    .filter((a) => a.headline && a.url && relevantTo(`${a.headline} ${a.summary}`, query));
}

async function guardianNews(query: string, ticker: string): Promise<Article[]> {
  const url = `https://content.guardianapis.com/search?q=${encodeURIComponent(
    query,
  )}&order-by=newest&show-fields=trailText,thumbnail&page-size=8`;
  const res = await guardianFetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    response?: {
      results?: Array<{
        id?: string;
        webTitle?: string;
        webUrl?: string;
        webPublicationDate?: string;
        fields?: { trailText?: string; thumbnail?: string };
      }>;
    };
  };
  const results = data?.response?.results ?? [];
  return results
    .map((r) => ({
      id: `gu_${r.id}`,
      ticker,
      provider: "Guardian" as const,
      source: "The Guardian",
      headline: r.webTitle || "",
      summary: stripTags(r.fields?.trailText || ""),
      url: r.webUrl || "",
      image: r.fields?.thumbnail || null,
      datetime: r.webPublicationDate ? Date.parse(r.webPublicationDate) : 0,
    }))
    .filter((a) => a.headline && a.url && relevantTo(`${a.headline} ${a.summary}`, query));
}

// Newest-first, de-duped, recency-capped articles across all providers for the given tickers.
export async function getNews(tickers: string[]): Promise<Article[]> {
  const fh = process.env.FINNHUB_API_KEY;
  const nyt = process.env.NYT_API_KEY;
  const gu = guardianKeys().length > 0;
  const apId = process.env.ALPACA_API_KEY_ID;
  const apSecret = process.env.ALPACA_API_SECRET_KEY;

  const tasks: Promise<Article[]>[] = [];
  for (const t of tickers) {
    // Resolve the readable name once so NYT/Guardian text search is actually about the company.
    const namePromise = fh ? companyName(t, fh) : Promise.resolve(t);
    if (apId && apSecret) tasks.push(alpacaNews(t, apId, apSecret).catch(() => []));
    if (fh) tasks.push(finnhubNews(t, fh).catch(() => []));
    if (nyt) tasks.push(namePromise.then((name) => nytNews(name, t, nyt)).catch(() => []));
    if (gu) tasks.push(namePromise.then((name) => guardianNews(name, t)).catch(() => []));
  }

  const all = (await Promise.all(tasks)).flat();
  const cutoff = Date.now() - RECENCY_MS;
  const seen = new Set<string>();
  const deduped = all.filter((a) => {
    if (a.datetime && a.datetime < cutoff) return false; // drop stale coverage
    const k = a.url.split("?")[0];
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  deduped.sort((a, b) => b.datetime - a.datetime);

  return deduped.slice(0, 60).map((a) => ({ ...a, headline: clean(a.headline), summary: clean(a.summary) }));
}
