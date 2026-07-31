"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { useMovableCard } from "@/components/ui/useMovableCard";
import type { NewsItem } from "@/lib/guardian";

const POLL_MS = 120_000; // server caches 5 min; this just keeps the card fresh

// Last-good feed persisted to localStorage so the next open paints instantly (stale-while-revalidate):
// render the cached headlines with no spinner, then silently refresh in the background. Keyed by the
// query so a portfolio change never shows a mismatched feed.
const CACHE_KEY = "thesis.news.cache.v1";
function readNewsCache(query?: string): NewsItem[] | null {
  if (typeof window === "undefined") return null;
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (c && c.query === (query || "") && Array.isArray(c.items) && c.items.length) return c.items as NewsItem[];
  } catch {}
  return null;
}
function writeNewsCache(query: string | undefined, items: NewsItem[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ query: query || "", items, at: Date.now() }));
  } catch {}
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// The Guardian's logo — the fallback when a piece has no image.
const GUARDIAN_LOGO = "https://assets.guim.co.uk/images/guardian-logo-rss.c45beb1bafa34b347ac333af2e6fe23f.png";

// Thumbnail that degrades gracefully: falls back to the Guardian logo — never a broken <img>.
function Thumb({ src, alt }: { src: string | null; alt: string | null }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-white p-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={GUARDIAN_LOGO} alt="The Guardian" className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt || ""} onError={() => setErr(true)} className="h-14 w-14 shrink-0 rounded-lg object-cover" />
  );
}

export function NewsAlertCard({
  query,
  onOpenArticle,
  embedded = false,
  refreshSignal = 0,
  onRefreshed,
  x = 1080,
  y = 826,
  width = 430,
  height = 560,
}: {
  query?: string;
  onOpenArticle: (item: NewsItem) => void;
  embedded?: boolean; // phone: render the feed straight on the page background (no card shell)
  refreshSignal?: number; // bumped by pull-to-refresh to force a re-fetch
  onRefreshed?: () => void; // called when a pull-to-refresh fetch settles (springs the gesture back)
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}) {
  const { style, dragHandle, resizeHandle, raise } = useMovableCard("news", { x, y, w: width, h: height }, { minW: 320, minH: 280 });
  // Seed from the localStorage cache → instant paint, spinner only on a true first-ever visit.
  const [items, setItems] = useState<NewsItem[]>(() => readNewsCache(query) ?? []);
  const [seen, setSeen] = useState<Set<string>>(() => new Set((readNewsCache(query) ?? []).map((i) => i.id)));
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => readNewsCache(query) == null);
  const firstRef = useRef(readNewsCache(query) == null); // cache hit → seen already baselined from the cache

  useEffect(() => {
    let cancelled = false;
    // Paint the cached feed for this query straight away (no spinner); anything the refetch brings in
    // that wasn't cached will flag as "New". No cache → baseline "seen" on the first fetch.
    const cached = readNewsCache(query);
    if (cached) {
      setItems(cached);
      setSeen(new Set(cached.map((i) => i.id)));
      firstRef.current = false;
    } else {
      firstRef.current = true;
    }
    const load = (first: boolean) =>
      fetch(`/api/guardian?q=${encodeURIComponent(query || "")}&takeaways=1`)
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          if (j.error) {
            if (first && !cached) setErr(j.error);
            return;
          }
          const next: NewsItem[] = j.items || [];
          setItems(next);
          setErr(null);
          if (firstRef.current) {
            setSeen(new Set(next.map((i) => i.id))); // nothing is "new" on first load
            firstRef.current = false;
          }
          writeNewsCache(query, next); // persist last-good for the next open
        })
        .catch(() => first && !cancelled && !cached && setErr("Couldn't load news."))
        .finally(() => first && !cancelled && setLoading(false));
    load(true);
    const id = setInterval(() => load(false), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [query]);

  // Pull-to-refresh: re-fetch on a signal bump, then notify so the gesture springs back when done.
  useEffect(() => {
    if (!refreshSignal) return; // 0 = initial mount, nothing to refresh
    let cancelled = false;
    fetch(`/api/guardian?q=${encodeURIComponent(query || "")}&takeaways=1`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const next: NewsItem[] = j.items || [];
        if (!j.error && next.length) {
          setItems(next);
          setErr(null);
          writeNewsCache(query, next);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) onRefreshed?.(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // The headline feed — shared by the card and the embedded (phone) layouts.
  const feed = (
    <>
      {loading && <p className="mt-10 animate-pulse text-center text-[13px] text-[#8a8a8a]">Loading headlines…</p>}
      {err && !items.length && <p className="mt-10 text-center text-[13px] text-rose-400">{err}</p>}
      {!loading && !err && !items.length && <p className="mt-10 text-center text-[12px] text-[#666]">No headlines right now.</p>}

      {/* initial={false}: the cached feed paints without animating; only articles that arrive on a
          later refresh animate in — fading into the top slot while the rest slide down (layout). */}
      <AnimatePresence initial={false}>
        {items.map((i) => {
          const isNew = !seen.has(i.id);
          return (
            <motion.button
              key={i.id}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ height: { duration: 0.42, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.45, ease: "easeOut" } }}
              onClick={() => onOpenArticle(i)}
              className="group flex w-full gap-2 overflow-hidden border-t border-white/[0.06] py-3 text-left first:border-t-0"
            >
              <Thumb src={i.image} alt={i.imageAlt} />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-3 text-[14px] leading-snug text-white/90 group-hover:text-white">
                  {i.takeaway || i.title}{" "}
                  {isNew && (
                    <span className="mr-0.5 rounded-[5px] bg-emerald-500/15 px-1.5 py-px align-middle text-[11px] font-semibold uppercase tracking-wide text-emerald-400">
                      New
                    </span>
                  )}
                  <span className="whitespace-nowrap text-[13.5px] font-normal text-[#8a8a8a]">{relTime(i.published)}</span>
                </p>
              </div>
            </motion.button>
          );
        })}
      </AnimatePresence>
    </>
  );

  // Phone: no card chrome — the feed flows straight on the page background (document scroll).
  if (embedded) {
    return (
      <div className="fade-in font-sans tracking-[-0.01em]">
        <h2 className="px-1 pb-0.5 text-[16px] font-semibold text-white">Portfolio Headlines</h2>
        <div className="px-1">{feed}</div>
      </div>
    );
  }

  return (
    <div
      onPointerDown={raise}
      style={style}
      className="fade-in absolute flex flex-col overflow-hidden rounded-[20px] border border-white/[0.06] bg-[#0e0e0e] font-sans tracking-[-0.01em] shadow-[0_24px_70px_rgba(0,0,0,0.55)]"
    >
      {/* header — drag handle */}
      <div {...dragHandle} className="flex shrink-0 cursor-move touch-none select-none items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div>
          <h2 className="text-[16px] font-semibold text-white">Portfolio Headlines</h2>
        </div>
      </div>

      {/* body — feed */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-2">{feed}</div>

      {/* resize handle */}
      <div
        {...resizeHandle}
        className="absolute bottom-0 right-0 z-20 flex h-7 w-7 cursor-nwse-resize touch-none items-end justify-end p-1.5 text-white/40 transition-colors hover:text-white/80"
        title="Drag to resize"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M11 4L4 11M11 8L8 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
