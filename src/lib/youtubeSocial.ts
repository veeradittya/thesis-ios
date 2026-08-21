export interface YouTubeSocialVideo {
  videoId: string;
  ticker: string;
  title: string;
  channel: string;
  publishedAt: string;
  viewCount: number | null;
  thumbnailUrl: string | null;
  url: string;
  videoSummary: string | null;
  transcriptExcerpt: string | null;
}

export interface YouTubeSocialSnapshot {
  ticker: string;
  videos: YouTubeSocialVideo[];
  generatedAt: string;
  windowHours: number;
  lean: string | null; // the analyst agent's directional read (Strong Buy … Strong Sell), if provided
  summary: string | null; // the agent's short overview of the YouTube signal for this asset
}

const YT_LEAN_LABELS = /^(Strong Buy|Buy|Neutral|Sell|Strong Sell)$/;

export interface YouTubeSocialResponse {
  snapshots: YouTubeSocialSnapshot[];
  generatedAt: string | null;
  stale: boolean;
  source: "live" | "fixture";
}

const MAX_AGE_MS = 36 * 60 * 60 * 1000;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeYouTubeSnapshot(value: unknown): YouTubeSocialSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const ticker = text(raw.ticker, 12).toUpperCase();
  const generatedAt = text(raw.generatedAt, 40);
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker) || Number.isNaN(Date.parse(generatedAt))) return null;
  const videos = (Array.isArray(raw.videos) ? raw.videos : []).slice(0, 8).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const videoId = text(item.videoId, 20);
    const url = text(item.url, 500);
    const title = text(item.title, 240);
    const publishedAt = text(item.publishedAt, 40);
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId) || !title || Number.isNaN(Date.parse(publishedAt)) ||
        !/^https:\/\/(www\.)?youtube\.com\/watch\?v=/i.test(url)) return [];
    const views = Number(item.viewCount);
    const thumbnail = text(item.thumbnailUrl, 500);
    return [{
      videoId,
      ticker,
      title,
      channel: text(item.channel, 160),
      publishedAt,
      viewCount: item.viewCount != null && Number.isFinite(views) && views >= 0 ? views : null,
      thumbnailUrl: /^https:\/\/i\.ytimg\.com\//i.test(thumbnail) ? thumbnail : null,
      url,
      videoSummary: text(item.videoSummary, 700) || null,
      transcriptExcerpt: text(item.transcriptExcerpt, 600) || null,
    }];
  });
  const lean = text(raw.lean, 12);
  return {
    ticker,
    videos,
    generatedAt,
    windowHours: Number.isFinite(Number(raw.windowHours)) ? Math.max(1, Number(raw.windowHours)) : 24,
    lean: YT_LEAN_LABELS.test(lean) ? lean : null,
    summary: text(raw.summary, 700) || null,
  };
}

export function filterYouTubeSnapshots(snapshots: YouTubeSocialSnapshot[], tickers: string[]): YouTubeSocialSnapshot[] {
  const wanted = new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean));
  return (wanted.size ? snapshots.filter((row) => wanted.has(row.ticker)) : snapshots)
    .filter((row) => row.videos.length)
    .sort((a, b) => Date.parse(b.videos[0].publishedAt) - Date.parse(a.videos[0].publishedAt));
}

export function youtubeSnapshotsAreStale(snapshots: YouTubeSocialSnapshot[], now = Date.now()): boolean {
  if (!snapshots.length) return true;
  const newest = Math.max(...snapshots.map((row) => Date.parse(row.generatedAt)).filter(Number.isFinite));
  return !Number.isFinite(newest) || now - newest > MAX_AGE_MS;
}
