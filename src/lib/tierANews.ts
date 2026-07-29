// Tier-A news search (The Guardian + The New York Times), exposed to the analysis model as a
// TOOL so Opus researches the last ~24h itself rather than being spoon-fed context. Both are
// reputable primary outlets; results carry real article URLs for citation.

import { guardianFetch, guardianKeys } from "@/lib/guardianFetch";

export interface TierAResult {
  headline: string;
  source: string;
  url: string;
  published: string;
  snippet: string;
}

const strip = (s?: string) => (s || "").replace(/<[^>]+>/g, "").trim();
const dayStr = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

async function guardian(query: string, days = 2): Promise<TierAResult[]> {
  const url = `https://content.guardianapis.com/search?q=${encodeURIComponent(
    query,
  )}&order-by=newest&from-date=${dayStr(days * 864e5)}&show-fields=trailText&page-size=6`;
  const r = await guardianFetch(url, { cache: "no-store" });
  if (!r.ok) return [];
  const j = (await r.json()) as { response?: { results?: Array<{ webTitle?: string; webUrl?: string; webPublicationDate?: string; fields?: { trailText?: string } }> } };
  return (j?.response?.results || []).map((x) => ({
    headline: x.webTitle || "",
    source: "The Guardian",
    url: x.webUrl || "",
    published: x.webPublicationDate || "",
    snippet: strip(x.fields?.trailText),
  }));
}

async function nyt(query: string, key: string, days = 2): Promise<TierAResult[]> {
  const url = `https://api.nytimes.com/svc/search/v2/articlesearch.json?q=${encodeURIComponent(
    query,
  )}&sort=newest&begin_date=${dayStr(days * 864e5).replace(/-/g, "")}&api-key=${key}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return [];
  const j = (await r.json()) as { response?: { docs?: Array<{ web_url?: string; abstract?: string; snippet?: string; pub_date?: string; headline?: { main?: string } }> } };
  return (j?.response?.docs || []).slice(0, 6).map((d) => ({
    headline: d.headline?.main || "",
    source: "The New York Times",
    url: d.web_url || "",
    published: d.pub_date || "",
    snippet: d.abstract || d.snippet || "",
  }));
}

// Newest-first Tier-A results for a free-text query (the model chooses the query).
export async function searchTierANews(query: string, days = 2): Promise<TierAResult[]> {
  const gu = guardianKeys().length > 0;
  const ny = process.env.NYT_API_KEY;
  const [g, n] = await Promise.all([
    gu ? guardian(query, days).catch(() => [] as TierAResult[]) : Promise.resolve([] as TierAResult[]),
    ny ? nyt(query, ny, days).catch(() => [] as TierAResult[]) : Promise.resolve([] as TierAResult[]),
  ]);
  return [...g, ...n]
    .filter((a) => a.headline && a.url)
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, 8);
}
