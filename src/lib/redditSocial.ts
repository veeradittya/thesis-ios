export interface RedditSocialSource {
  subreddit: string;
  title: string;
  score: number;
  url: string;
}

export interface RedditSocialSnapshot {
  ticker: string;
  windowHours: number;
  mentions: number;
  submissions: number;
  comments: number;
  uniqueAuthors: number;
  uniqueThreads: number;
  mentionChangePct: number | null;
  summary: string;
  lean: string | null; // the analyst agent's directional read (Strong Buy … Strong Sell), if provided
  topSources: RedditSocialSource[];
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
}

const LEAN_LABELS = /^(Strong Buy|Buy|Neutral|Sell|Strong Sell)$/;

export interface RedditSocialResponse {
  snapshots: RedditSocialSnapshot[];
  generatedAt: string | null;
  stale: boolean;
  source: "live" | "fixture";
}

const MAX_SNAPSHOT_AGE_MS = 36 * 60 * 60 * 1000;

function finiteNonNegative(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeRedditSnapshot(value: unknown): RedditSocialSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const ticker = cleanText(raw.ticker, 12).toUpperCase();
  const generatedAt = cleanText(raw.generatedAt, 40);
  const summary = cleanText(raw.summary, 1200);
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker) || !summary || Number.isNaN(Date.parse(generatedAt))) return null;

  const sources = Array.isArray(raw.topSources) ? raw.topSources : [];
  const topSources: RedditSocialSource[] = sources.slice(0, 5).flatMap((source) => {
    if (!source || typeof source !== "object") return [];
    const item = source as Record<string, unknown>;
    const url = cleanText(item.url, 500);
    if (!/^https:\/\/(www\.)?reddit\.com\//i.test(url)) return [];
    return [{
      subreddit: cleanText(item.subreddit, 40),
      title: cleanText(item.title, 240),
      score: finiteNonNegative(item.score) ?? 0,
      url,
    }];
  });

  const change = raw.mentionChangePct == null ? null : Number(raw.mentionChangePct);
  const lean = cleanText(raw.lean, 12);
  return {
    ticker,
    windowHours: finiteNonNegative(raw.windowHours) ?? 168,
    mentions: finiteNonNegative(raw.mentions) ?? 0,
    submissions: finiteNonNegative(raw.submissions) ?? 0,
    comments: finiteNonNegative(raw.comments) ?? 0,
    uniqueAuthors: finiteNonNegative(raw.uniqueAuthors) ?? 0,
    uniqueThreads: finiteNonNegative(raw.uniqueThreads) ?? 0,
    mentionChangePct: Number.isFinite(change) ? change : null,
    summary,
    lean: LEAN_LABELS.test(lean) ? lean : null,
    topSources,
    generatedAt,
    windowStart: cleanText(raw.windowStart, 40),
    windowEnd: cleanText(raw.windowEnd, 40),
  };
}

export function snapshotsAreStale(snapshots: RedditSocialSnapshot[], now = Date.now()): boolean {
  if (!snapshots.length) return true;
  const newest = Math.max(...snapshots.map((s) => Date.parse(s.generatedAt)).filter(Number.isFinite));
  return !Number.isFinite(newest) || now - newest > MAX_SNAPSHOT_AGE_MS;
}

export function filterRedditSnapshots(snapshots: RedditSocialSnapshot[], tickers: string[]): RedditSocialSnapshot[] {
  const wanted = new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean));
  const filtered = wanted.size ? snapshots.filter((s) => wanted.has(s.ticker)) : snapshots;
  return filtered.sort((a, b) => b.mentions - a.mentions);
}
