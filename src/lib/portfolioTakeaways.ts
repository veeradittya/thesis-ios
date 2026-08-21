// Server-side portfolio takeaways — the same editorial takeaways the Hivemind top card shows, but
// assembled entirely on the server (no browser, no /api self-calls) so a scheduler can generate them
// for every user. It ports the client's snapshot assembly (Hivemind.tsx `buildSnapshot` + the
// per-holding `AssetSignals` build) to the server, feeds it through the SAME deterministic synthesis
// (src/lib/hivemind.ts) and the SAME LLM overview prompt (src/lib/hivemindOverview.ts), so it yields
// the same `points` the on-open client call would. Node-only.

import {
  aggregatePortfolioPulse,
  synthesizeAsset,
  type AssetMarket,
  type AssetPulse,
  type AssetSignals,
  type PortfolioPulse,
} from "@/lib/hivemind";
import { generateOverview, type BriefPoint } from "@/lib/hivemindOverview";
import {
  getAnalystBriefs,
  getLatestMonitor,
  getNewsOverviews,
  getRedditSocialRows,
  getYouTubeSocialRows,
  type MonitorResult,
} from "@/lib/turso";
import { getQuotes } from "@/lib/prices";
import { getRecommendations } from "@/lib/recommendation";
import { getPriceTargets } from "@/lib/priceTargets";
import { getNews, type Article } from "@/lib/news";
import { getPortfolioMarkets, type HoldingLite, type MarketsAsset } from "@/lib/oddpool";
import { filterRedditSnapshots, normalizeRedditSnapshot, type RedditSocialSnapshot } from "@/lib/redditSocial";
import { filterYouTubeSnapshots, normalizeYouTubeSnapshot } from "@/lib/youtubeSocial";
import type { YouTubeSocialVideo } from "@/lib/youtubeSocial";

const norm = (t: string) => (t || "").trim().toUpperCase();

export interface TakeawayHolding {
  ticker: string;
  name?: string | null;
  weight?: number | null;
}

// Flatten a holding's grouped prediction-market events into the flat AssetMarket[] the synthesis
// reads (mirrors Hivemind.tsx `flattenMarkets`).
function flattenMarkets(asset: MarketsAsset): AssetMarket[] {
  const out: AssetMarket[] = [];
  for (const ev of asset.events) {
    if (ev.single || !ev.outcomes.length) out.push({ question: ev.title, yes: ev.yes, volume: ev.volume });
    else for (const o of ev.outcomes) out.push({ question: o.question || o.label, yes: o.yes, volume: o.volume });
  }
  return out;
}

// A compact, LLM-ready snapshot of the portfolio: the overall pulse plus, per holding, every signal
// we scored. Ported verbatim from Hivemind.tsx `buildSnapshot` so `generateOverview` yields the same
// points. Kept small (drop nulls, truncate the Reddit note, top-2/3 headlines) so the prompt stays cheap.
const round2 = (v: number) => Math.round(v * 100) / 100;
function buildSnapshot(
  portfolio: PortfolioPulse,
  items: Array<{ holding: { weight: number | null }; pulse: AssetPulse; signals: AssetSignals }>,
) {
  const holdings = items
    .filter((i) => i.pulse.signalCount > 0)
    .map(({ holding, pulse, signals: s }) => {
      const mk = pulse.contributions.find((c) => c.key === "markets");
      const clean = <T,>(o: T): T => JSON.parse(JSON.stringify(o, (_k, v) => (v == null || v === "" || (Array.isArray(v) && !v.length) ? undefined : v)));
      // Real source links the model MAY attach to a fact: Reddit threads, news articles, and the
      // source links the agent embedded in its research. Validated against the snapshot server-side,
      // so the model can only use one of these, never a hallucinated URL.
      const sources: Array<{ label: string; url: string }> = [];
      for (const t of (s.reddit?.topSources || []).slice(0, 3)) sources.push({ label: `Reddit: ${t.title}`, url: t.url });
      for (const n of (s.newsItems || []).slice(0, 3)) sources.push({ label: n.headline, url: n.url });
      for (const m of Array.from((s.rationale || "").matchAll(/\[([^\]]+)\]\(([^)]+)\)/g))) sources.push({ label: m[1], url: m[2] });
      const validSources = sources.filter((x) => /^https?:\/\//.test(x.url)).slice(0, 8);
      return clean({
        ticker: s.ticker,
        name: s.name || undefined,
        weightPct: holding.weight != null ? Math.round(holding.weight * 100) : undefined,
        pulse: pulse.label,
        price: s.price ?? undefined,
        dayChangePct: typeof s.changePct === "number" ? round2(s.changePct) : undefined,
        verdict: s.verdict || undefined,
        // the agent's actual daily research: its plain-language narrative and the concrete evidence it
        // pulled (price/news/analyst breakdown), so the model can quote specifics, not just the verdict.
        dailyResearch: s.rationale || s.agentSignals ? { rationale: s.rationale?.slice(0, 600) || undefined, evidence: s.agentSignals || undefined } : undefined,
        analystConsensus: s.recLabel || undefined,
        analystCount: s.recAnalysts ?? undefined,
        reddit: s.reddit && s.reddit.mentions > 0 ? { mentions: s.reddit.mentions, voices: s.reddit.uniqueAuthors, wowChangePct: s.reddit.mentionChangePct ?? undefined, note: s.reddit.summary?.slice(0, 320) } : undefined,
        predictionMarkets: mk?.present
          ? {
              count: s.markets?.length || 0,
              lean: mk.score > 0.15 ? "upside" : mk.score < -0.15 ? "downside" : "split",
              // the actual questions + implied odds, so facts can cite specifics rather than just "lean: downside"
              top: (s.markets || [])
                .filter((m) => m.yes != null)
                .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
                .slice(0, 3)
                .map((m) => ({ question: m.question.slice(0, 110), yesPct: Math.round((m.yes as number) * 100) })),
            }
          : undefined,
        newsCount: s.newsCount || undefined,
        headlines: (s.newsHeadlines || []).slice(0, 3),
        youtubeVideos: s.videos?.length || undefined,
        sources: validSources.length ? validSources : undefined,
      });
    });
  return {
    portfolio: { pulse: portfolio.label, holdingsLeaningPositive: portfolio.positive, holdingsCautious: portfolio.negative, holdingsWithSignals: portfolio.total },
    holdings,
  };
}

// Assemble the portfolio snapshot for one user entirely from server sources, mirroring the client's
// fetch fan-out + per-holding AssetSignals build (Hivemind.tsx `fetchBundle` + `holdingPulses`).
export async function buildServerSnapshot(userId: string, holdings: TakeawayHolding[]): Promise<ReturnType<typeof buildSnapshot>> {
  // Dedup + normalize holdings, preserving ledger order (as the client's `held` does).
  const seen = new Set<string>();
  const held = holdings
    .map((h) => ({ ticker: norm(h.ticker), name: (h.name || "") as string, weight: h.weight ?? null }))
    .filter((h) => h.ticker && !seen.has(h.ticker) && seen.add(h.ticker));

  if (!held.length) {
    const portfolio = aggregatePortfolioPulse([]);
    return buildSnapshot(portfolio, []);
  }

  const tickers = held.map((h) => h.ticker);
  const holdingLites: HoldingLite[] = held.map((h) => ({ ticker: h.ticker, name: h.name, weight: h.weight }));

  const [quotes, recs, targets, briefs, monitor, redditPayloads, youtubePayloads, articles, newsOverviews, marketsPayload] = await Promise.all([
    getQuotes(tickers),
    getRecommendations(tickers),
    getPriceTargets(tickers), // fetched to mirror the client bundle; not part of the snapshot itself
    getAnalystBriefs(tickers),
    getLatestMonitor(userId),
    getRedditSocialRows(tickers),
    getYouTubeSocialRows(tickers),
    getNews(tickers.slice(0, 8)),
    getNewsOverviews(tickers),
    getPortfolioMarkets(holdingLites),
  ]);
  void targets; // parity fetch only

  // Agent research per ticker.
  const monitorByTicker: Record<string, MonitorResult> = {};
  for (const r of monitor.results || []) monitorByTicker[norm(r.ticker)] = r;

  // Reddit: normalize the stored payloads, then filter/sort to the held tickers (mirrors the route).
  const redditLive = redditPayloads.flatMap((raw) => {
    try { const snap = normalizeRedditSnapshot(JSON.parse(raw)); return snap ? [snap] : []; } catch { return []; }
  });
  const redditByTicker: Record<string, RedditSocialSnapshot> = {};
  for (const snap of filterRedditSnapshots(redditLive, tickers)) redditByTicker[norm(snap.ticker)] = snap;

  // YouTube: normalize + filter, then split into per-ticker videos / lean.
  const youtubeLive = youtubePayloads.flatMap((raw) => {
    try { const row = normalizeYouTubeSnapshot(JSON.parse(raw)); return row ? [row] : []; } catch { return []; }
  });
  const youtubeByTicker: Record<string, YouTubeSocialVideo[]> = {};
  for (const snap of filterYouTubeSnapshots(youtubeLive, tickers)) {
    if (snap.videos.length) youtubeByTicker[norm(snap.ticker)] = snap.videos;
  }

  // News grouped by ticker + the agent's per-ticker lean.
  const newsByTicker: Record<string, Article[]> = {};
  for (const a of articles) (newsByTicker[norm(a.ticker)] ||= []).push(a);
  const newsLeanByTicker: Record<string, string> = {};
  for (const [t, o] of Object.entries(newsOverviews)) if (o?.lean) newsLeanByTicker[norm(t)] = o.lean;

  // Prediction markets grouped by ticker.
  const marketsByTicker: Record<string, MarketsAsset> = {};
  for (const a of marketsPayload.assets || []) if (a.events.length) marketsByTicker[norm(a.ticker)] = a;

  // Build per-holding AssetSignals → pulse (mirrors Hivemind.tsx `holdingPulses`).
  const holdingPulses = held.map((h) => {
    const mon = monitorByTicker[h.ticker];
    const marketsAsset = marketsByTicker[h.ticker];
    const newsArr = newsByTicker[h.ticker];
    let agentSignals: Record<string, string> | null = null;
    if (mon?.signals) {
      try {
        const parsed = JSON.parse(mon.signals);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          agentSignals = Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""),
          );
        }
      } catch { /* leave null */ }
    }
    const signals: AssetSignals = {
      ticker: h.ticker,
      name: h.name,
      price: quotes[h.ticker]?.price ?? null,
      changePct: quotes[h.ticker]?.percent ?? null,
      verdict: mon?.verdict ?? null,
      risk: mon?.risk ?? null,
      rationale: mon?.rationale ?? null,
      agentSignals,
      brief: briefs[h.ticker] ?? null,
      recLabel: recs[h.ticker]?.label ?? null,
      recAnalysts: recs[h.ticker]?.analysts ?? null,
      reddit: redditByTicker[h.ticker] ?? null,
      videos: youtubeByTicker[h.ticker] ?? [],
      markets: marketsAsset ? flattenMarkets(marketsAsset) : [],
      newsCount: newsArr?.length ?? 0,
      newsHeadlines: (newsArr || []).map((a) => a.headline),
      newsItems: (newsArr || []).map((a) => ({ headline: a.headline, url: a.url })),
      newsLean: newsLeanByTicker[h.ticker],
    };
    return { holding: h, pulse: synthesizeAsset(signals), signals };
  });

  const portfolio = aggregatePortfolioPulse(holdingPulses.map((p) => ({ pulse: p.pulse, weight: p.holding.weight ?? 1 })));
  return buildSnapshot(portfolio, holdingPulses);
}

// Full pipeline for one user: build the snapshot from server sources, then run the same LLM overview
// prompt the client uses, and return just the takeaway `points` (empty array on no key / no output).
export async function generateTakeaways(userId: string, holdings: TakeawayHolding[]): Promise<BriefPoint[]> {
  const snapshot = await buildServerSnapshot(userId, holdings);
  if (!snapshot.holdings.length) return [];
  try {
    const { points } = await generateOverview(snapshot);
    return points ?? [];
  } catch {
    // A "no model output" throw (gateway down + no Anthropic key) → no takeaways this run.
    return [];
  }
}
