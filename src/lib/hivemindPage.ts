// Precomputed per-user Hivemind page — the WHOLE page (the exact client `Bundle`, the top-of-page
// editorial takeaways, and the per-asset overviews) built ONCE per scheduled run and stored in Turso,
// so the app reads it with no live LLM/synthesis. Analysis is frozen to the run; the client overlays
// live price separately, so we only store build-time data (build-time quotes live in `bundle.quotes`).
//
// The Bundle mirrors — key for key — the shape `fetchBundle()` returns in src/components/Hivemind.tsx
// (which we must not edit and which does not export the type). Values reuse the underlying lib types
// (structural supersets of Hivemind.tsx's local interfaces), so the stored JSON carries exactly the
// keys the client reads.

import { fetchHivemindData, snapshotFromData, type HivemindFetch, type TakeawayHolding } from "@/lib/portfolioTakeaways";
import { generateOverview, type BriefPoint, type OverviewResult } from "@/lib/hivemindOverview";
import { generateAssetOverviews } from "@/lib/hivemindAssetOverview";
import type { Quote } from "@/lib/prices";
import type { Recommendation } from "@/lib/recommendation";
import type { PriceTarget } from "@/lib/priceTargets";
import type { StockMetric } from "@/lib/metrics";
import type { MonitorResult } from "@/lib/turso";
import type { Article } from "@/lib/news";
import type { MarketsAsset } from "@/lib/oddpool";
import { snapshotsAreStale, type RedditSocialSnapshot } from "@/lib/redditSocial";
import type { YouTubeSocialVideo } from "@/lib/youtubeSocial";

const norm = (t: string) => (t || "").trim().toUpperCase();

// The EXACT shape `fetchBundle()` returns in Hivemind.tsx (same keys, same order).
export interface HivemindBundle {
  quotes: Record<string, Quote>;
  recs: Record<string, Recommendation>;
  targets: Record<string, PriceTarget>;
  metrics: Record<string, StockMetric>;
  briefs: Record<string, string>;
  monitor: Record<string, MonitorResult>;
  memo: string | null;
  reddit: RedditSocialSnapshot[];
  redditStale: boolean;
  youtube: Record<string, YouTubeSocialVideo[]>;
  youtubeLeans: Record<string, string>; // agent's per-ticker youtube lean
  youtubeSummaries: Record<string, string>; // agent's per-ticker youtube overview
  news: Record<string, Article[]>;
  newsOverviews: Record<string, string>; // news agent's per-ticker overview
  newsLeans: Record<string, string>; // news agent's per-ticker lean
  markets: Record<string, MarketsAsset>;
  generatedAt: string | null;
}

// The full stored payload for one user's Hivemind page.
export interface HivemindPage {
  generatedAt: string; // ISO — when this page was built (distinct from bundle.generatedAt, the reddit run)
  bundle: HivemindBundle;
  takeaways: { headline: string | null; points: BriefPoint[] | null };
  assetOverviews: Record<string, string>; // TICKER -> overview text
}

// Assemble the exact client Bundle from already-fetched data (no re-fetch). Mirrors Hivemind.tsx
// `fetchBundle` field for field.
function assembleBundle(data: HivemindFetch): HivemindBundle {
  const monitor: Record<string, MonitorResult> = {};
  for (const r of data.monitor.results || []) monitor[norm(r.ticker)] = r;

  const youtube: Record<string, YouTubeSocialVideo[]> = {};
  const youtubeLeans: Record<string, string> = {};
  const youtubeSummaries: Record<string, string> = {};
  for (const snap of data.youtubeAll) {
    if (snap.videos.length) youtube[norm(snap.ticker)] = snap.videos;
    if (snap.lean) youtubeLeans[norm(snap.ticker)] = snap.lean;
    if (snap.summary) youtubeSummaries[norm(snap.ticker)] = snap.summary;
  }

  const news: Record<string, Article[]> = {};
  for (const a of data.articles) (news[norm(a.ticker)] ||= []).push(a);

  const newsOverviews: Record<string, string> = {};
  const newsLeans: Record<string, string> = {};
  for (const [t, o] of Object.entries(data.newsOverviews)) {
    if (o?.summary) newsOverviews[norm(t)] = o.summary;
    if (o?.lean) newsLeans[norm(t)] = o.lean;
  }

  const markets: Record<string, MarketsAsset> = {};
  for (const a of data.markets.assets || []) if (a.events.length) markets[norm(a.ticker)] = a;

  return {
    quotes: data.quotes,
    recs: data.recs,
    targets: data.targets,
    metrics: data.metrics,
    briefs: data.briefs,
    monitor,
    memo: data.monitor.memo ?? null,
    reddit: data.redditAll,
    redditStale: snapshotsAreStale(data.redditAll),
    youtube,
    youtubeLeans,
    youtubeSummaries,
    news,
    newsOverviews,
    newsLeans,
    markets,
    generatedAt: data.redditGeneratedAt,
  };
}

// Build the exact client Bundle for one user entirely from server sources.
export async function buildServerBundle(userId: string, holdings: TakeawayHolding[]): Promise<HivemindBundle> {
  return assembleBundle(await fetchHivemindData(userId, holdings));
}

// Build the WHOLE Hivemind page for one user: the Bundle, the editorial takeaways, and the per-asset
// overviews, all off ONE fetch fan-out. The two LLM calls are wrapped so a failure yields empty
// (rather than aborting the page) — a page with a bundle but no takeaways/overviews is still useful.
export async function buildHivemindPage(userId: string, holdings: TakeawayHolding[]): Promise<HivemindPage> {
  const data = await fetchHivemindData(userId, holdings);
  const bundle = assembleBundle(data);
  const snapshot = snapshotFromData(data);

  let takeaways: OverviewResult = { headline: null, points: null };
  let assetOverviews: Record<string, string> = {};
  if (snapshot.holdings.length) {
    [takeaways, assetOverviews] = await Promise.all([
      generateOverview(snapshot).catch(() => ({ headline: null, points: null }) as OverviewResult),
      generateAssetOverviews(snapshot.holdings).catch(() => ({} as Record<string, string>)),
    ]);
  }

  return { generatedAt: new Date().toISOString(), bundle, takeaways, assetOverviews };
}
