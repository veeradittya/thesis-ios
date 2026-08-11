"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ExternalLink, MessageCircle, RefreshCw, Users } from "lucide-react";
import type { RedditSocialResponse, RedditSocialSnapshot } from "@/lib/redditSocial";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function freshnessLabel(generatedAt: string | null): string {
  if (!generatedAt) return "No snapshot";
  const age = Date.now() - Date.parse(generatedAt);
  if (!Number.isFinite(age) || age < 0) return "Updated recently";
  const hours = Math.floor(age / 3_600_000);
  if (hours < 1) return "Updated this hour";
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

function LoadingCard() {
  return (
    <div className="animate-pulse rounded-2xl border border-white/[0.09] px-4 py-4">
      <div className="h-4 w-24 rounded bg-white/10" />
      <div className="mt-3 h-3 w-full rounded bg-white/[0.07]" />
      <div className="mt-2 h-3 w-4/5 rounded bg-white/[0.07]" />
    </div>
  );
}

function SnapshotCard({ snapshot }: { snapshot: RedditSocialSnapshot }) {
  const [open, setOpen] = useState(false);
  const change = snapshot.mentionChangePct;
  return (
    <article className="overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.025]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="w-full px-4 py-4 text-left"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-medium text-white">{snapshot.ticker}</span>
              {change != null && (
                <span className={`text-[11px] tabular-nums ${change >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                  {change >= 0 ? "+" : ""}{change.toFixed(0)}%
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12px] text-[#8a8a8a]">Reddit · trailing {Math.round(snapshot.windowHours / 24)} days</p>
          </div>
          <ChevronDown className={`mt-1 h-4 w-4 text-white/45 transition-transform ${open ? "rotate-180" : ""}`} />
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <div>
            <p className="text-[15px] tabular-nums text-white">{compact.format(snapshot.mentions)}</p>
            <p className="text-[10px] uppercase tracking-wide text-[#737373]">mentions</p>
          </div>
          <div>
            <p className="flex items-center gap-1 text-[15px] tabular-nums text-white"><Users className="h-3 w-3 text-white/45" />{compact.format(snapshot.uniqueAuthors)}</p>
            <p className="text-[10px] uppercase tracking-wide text-[#737373]">voices</p>
          </div>
          <div>
            <p className="flex items-center gap-1 text-[15px] tabular-nums text-white"><MessageCircle className="h-3 w-3 text-white/45" />{compact.format(snapshot.uniqueThreads)}</p>
            <p className="text-[10px] uppercase tracking-wide text-[#737373]">threads</p>
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-white/[0.08] px-4 pb-4 pt-3.5">
          <p className="text-[14px] leading-relaxed text-white/75">{snapshot.summary}</p>
          {snapshot.topSources.length > 0 && (
            <div className="mt-4 space-y-2.5">
              <p className="text-[10px] uppercase tracking-[0.12em] text-[#737373]">High-signal threads</p>
              {snapshot.topSources.map((source) => (
                <a
                  key={source.url}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-start justify-between gap-3 rounded-xl bg-white/[0.035] px-3 py-2.5"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-white/80">{source.title}</span>
                    <span className="mt-0.5 block text-[11px] text-[#737373]">r/{source.subreddit} · {compact.format(source.score)} points</span>
                  </span>
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

export function RedditSocialListening({ tickers }: { tickers: string[] }) {
  // MonacoHome re-renders for its market clock, and passes a freshly mapped ticker array each time.
  // Key memoization by VALUE so those unrelated renders never refetch this slow-moving snapshot.
  const tickerKey = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))].join(",");
  const symbols = useMemo(() => tickerKey ? tickerKey.split(",") : [], [tickerKey]);
  const [data, setData] = useState<RedditSocialResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const query = symbols.length ? `?tickers=${encodeURIComponent(symbols.join(","))}` : "";
      const response = await fetch(`/api/social/reddit${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Reddit social ${response.status}`);
      setData(await response.json());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [symbols]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section aria-labelledby="reddit-pulse-heading" className="space-y-3">
      <div className="flex items-end justify-between gap-3 px-1">
        <div>
          <p className="text-[10px] uppercase tracking-[0.15em] text-[#737373]">Social listening</p>
          <h2 id="reddit-pulse-heading" className="mt-0.5 text-[18px] font-medium text-white">Reddit pulse</h2>
          <p className={`mt-0.5 text-[11px] ${data?.stale ? "text-amber-300/80" : "text-[#737373]"}`}>
            {data?.stale ? "Snapshot is stale · " : ""}{freshnessLabel(data?.generatedAt ?? null)}
          </p>
        </div>
        <button type="button" onClick={() => void load()} aria-label="Refresh Reddit pulse" className="rounded-full p-2 text-white/45 hover:bg-white/[0.06] hover:text-white/75">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {loading && !data ? <><LoadingCard /><LoadingCard /></> : error ? (
        <div className="rounded-2xl border border-white/[0.09] px-4 py-5 text-center">
          <p className="text-[13px] text-white/65">Reddit discussion is temporarily unavailable.</p>
          <button type="button" onClick={() => void load()} className="mt-2 text-[12px] text-white underline underline-offset-4">Try again</button>
        </div>
      ) : data?.snapshots.length ? (
        data.snapshots.map((snapshot) => <SnapshotCard key={snapshot.ticker} snapshot={snapshot} />)
      ) : (
        <div className="rounded-2xl border border-white/[0.09] px-4 py-5 text-center text-[13px] text-white/55">
          No tracked Reddit discussion for this portfolio yet.
        </div>
      )}
      <p className="px-1 text-[10px] leading-relaxed text-[#666]">Discussion volume is informational and is not investment advice. Counts reflect matched public Reddit posts and comments.</p>
    </section>
  );
}
