"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ExternalLink, MessageCircle, RefreshCw, Users, Video } from "lucide-react";
import type { RedditSocialResponse, RedditSocialSnapshot } from "@/lib/redditSocial";
import type { YouTubeSocialResponse, YouTubeSocialVideo } from "@/lib/youtubeSocial";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
type Platform = "reddit" | "youtube";

function ageLabel(value: string | null): string {
  if (!value) return "No snapshot";
  const age = Date.now() - Date.parse(value);
  if (!Number.isFinite(age) || age < 0) return "Updated recently";
  const hours = Math.floor(age / 3_600_000);
  if (hours < 1) return "Updated this hour";
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

function publishedLabel(value: string): string {
  const age = Date.now() - Date.parse(value);
  if (!Number.isFinite(age) || age < 0) return "Recently";
  const hours = Math.floor(age / 3_600_000);
  if (hours < 1) return "This hour";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function LoadingCards() {
  return <>{[0, 1].map((key) => (
    <div key={key} className="animate-pulse rounded-2xl border border-white/[0.09] px-4 py-4">
      <div className="h-4 w-24 rounded bg-white/10" />
      <div className="mt-3 h-3 w-full rounded bg-white/[0.07]" />
      <div className="mt-2 h-3 w-4/5 rounded bg-white/[0.07]" />
    </div>
  ))}</>;
}

function RedditCard({ snapshot }: { snapshot: RedditSocialSnapshot }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.025]">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="w-full px-4 py-4 text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[16px] font-medium text-white">{snapshot.ticker}</p>
            <p className="mt-0.5 text-[12px] text-[#8a8a8a]">Reddit · trailing {Math.round(snapshot.windowHours / 24)} days</p>
          </div>
          <ChevronDown className={`mt-1 h-4 w-4 text-white/45 transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div><p className="text-[15px] tabular-nums text-white">{compact.format(snapshot.mentions)}</p><p className="text-[10px] uppercase tracking-wide text-[#737373]">mentions</p></div>
          <div><p className="flex items-center gap-1 text-[15px] tabular-nums text-white"><Users className="h-3 w-3 text-white/45" />{compact.format(snapshot.uniqueAuthors)}</p><p className="text-[10px] uppercase tracking-wide text-[#737373]">voices</p></div>
          <div><p className="flex items-center gap-1 text-[15px] tabular-nums text-white"><MessageCircle className="h-3 w-3 text-white/45" />{compact.format(snapshot.uniqueThreads)}</p><p className="text-[10px] uppercase tracking-wide text-[#737373]">threads</p></div>
        </div>
      </button>
      {open && (
        <div className="border-t border-white/[0.08] px-4 pb-4 pt-3.5">
          <p className="text-[14px] leading-relaxed text-white/75">{snapshot.summary}</p>
          {snapshot.topSources.length > 0 && (
            <div className="mt-4 space-y-2.5">
              <p className="text-[10px] uppercase tracking-[0.12em] text-[#737373]">Open discussions</p>
              {snapshot.topSources.map((source) => (
                <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="flex items-start justify-between gap-3 rounded-xl bg-white/[0.035] px-3 py-2.5">
                  <span className="min-w-0"><span className="block text-[13px] leading-snug text-white/80">{source.title}</span><span className="mt-1 block text-[11px] text-[#737373]">r/{source.subreddit} · {compact.format(source.score)} points</span></span>
                  <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/35" />
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function VideoCard({ video }: { video: YouTubeSocialVideo }) {
  return (
    <a href={video.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.025]">
      <div className="flex gap-3 p-3">
        <div className="relative h-[72px] w-[120px] shrink-0 overflow-hidden rounded-xl bg-white/[0.05]">
          {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" className="h-full w-full object-cover" /> : <Video className="absolute inset-0 m-auto h-6 w-6 text-white/25" />}
          <span className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-medium text-white">{video.ticker}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="line-clamp-2 text-[13px] font-medium leading-snug text-white/85">{video.title}</p>
            <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/30" />
          </div>
          <p className="mt-1 truncate text-[11px] text-[#8a8a8a]">{video.channel}</p>
          <p className="mt-1 text-[10px] text-[#666]">{video.viewCount == null ? "Views unavailable" : `${compact.format(video.viewCount)} views`} · {publishedLabel(video.publishedAt)}</p>
        </div>
      </div>
      {video.transcriptExcerpt && <p className="border-t border-white/[0.07] px-3 py-2.5 text-[12px] leading-relaxed text-white/55">{video.transcriptExcerpt}</p>}
    </a>
  );
}

function Empty({ children }: { children: string }) {
  return <div className="rounded-2xl border border-white/[0.09] px-4 py-5 text-center text-[13px] text-white/55">{children}</div>;
}

export function RedditSocialListening({ tickers }: { tickers: string[] }) {
  const tickerKey = [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))].join(",");
  const symbols = useMemo(() => tickerKey ? tickerKey.split(",") : [], [tickerKey]);
  const [platform, setPlatform] = useState<Platform>("reddit");
  const [reddit, setReddit] = useState<RedditSocialResponse | null>(null);
  const [youtube, setYoutube] = useState<YouTubeSocialResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const query = symbols.length ? `?tickers=${encodeURIComponent(symbols.join(","))}` : "";
    try {
      const [redditResponse, youtubeResponse] = await Promise.all([
        fetch(`/api/social/reddit${query}`, { cache: "no-store" }),
        fetch(`/api/social/youtube${query}`, { cache: "no-store" }),
      ]);
      if (!redditResponse.ok || !youtubeResponse.ok) throw new Error("Hivemind retrieval failed");
      const [redditData, youtubeData] = await Promise.all([redditResponse.json(), youtubeResponse.json()]);
      setReddit(redditData);
      setYoutube(youtubeData);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [symbols]);

  useEffect(() => { void load(); }, [load]);
  const activeData = platform === "reddit" ? reddit : youtube;
  const youtubeVideos = useMemo(() => {
    const seen = new Set<string>();
    return (youtube?.snapshots.flatMap((snapshot) => snapshot.videos) || [])
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .filter((video) => {
        if (seen.has(video.videoId)) return false;
        seen.add(video.videoId);
        return true;
      })
      .slice(0, 60);
  }, [youtube]);

  return (
    <section aria-labelledby="hivemind-heading" className="space-y-3">
      <div className="flex items-end justify-between gap-3 px-1">
        <div>
          <p className="text-[10px] uppercase tracking-[0.15em] text-[#737373]">Social intelligence</p>
          <h2 id="hivemind-heading" className="mt-0.5 text-[20px] font-medium text-white">Hivemind</h2>
          <p className={`mt-0.5 text-[11px] ${activeData?.stale ? "text-amber-300/80" : "text-[#737373]"}`}>
            {activeData?.stale ? "Snapshot is stale · " : ""}{ageLabel(activeData?.generatedAt ?? null)}
          </p>
        </div>
        <button type="button" onClick={() => void load()} aria-label="Refresh Hivemind" className="rounded-full p-2 text-white/45 hover:bg-white/[0.06] hover:text-white/75"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></button>
      </div>

      <div className="grid grid-cols-2 rounded-xl bg-white/[0.045] p-1">
        {(["reddit", "youtube"] as Platform[]).map((value) => (
          <button key={value} type="button" onClick={() => setPlatform(value)} className={`rounded-lg py-2 text-[12px] font-medium capitalize transition-colors ${platform === value ? "bg-white/[0.12] text-white" : "text-white/45"}`}>{value}</button>
        ))}
      </div>

      {loading && !reddit && !youtube ? <LoadingCards /> : error ? <Empty>Hivemind is temporarily unavailable.</Empty> : platform === "reddit" ? (
        reddit?.snapshots.length ? reddit.snapshots.map((snapshot) => <RedditCard key={snapshot.ticker} snapshot={snapshot} />) : <Empty>No tracked Reddit discussion for this portfolio yet.</Empty>
      ) : youtubeVideos.length ? (
        youtubeVideos.map((video) => <VideoCard key={video.videoId} video={video} />)
      ) : <Empty>No recent YouTube videos for this portfolio yet.</Empty>}

      <p className="px-1 text-[10px] leading-relaxed text-[#666]">Public discussion is informational and is not investment advice. Open Reddit threads and YouTube videos to inspect the original source.</p>
    </section>
  );
}
