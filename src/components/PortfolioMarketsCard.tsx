"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { MarketsPayload, MarketLite } from "@/lib/oddpool";
import type { ParsedHolding } from "@/lib/parsePortfolio";
import { useMovableCard } from "@/components/ui/useMovableCard";

// Markets thinner than this (trade volume, USD) are hidden — too illiquid to be worth surfacing.
const MIN_VOLUME = 2000;

const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
function fmtUSD(v: number | null | undefined): string {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

export function PortfolioMarketsCard({
  holdings,
  x = 530,
  y = 110,
  width = 520,
  height = 560,
  onOpenMarket,
}: {
  holdings: ParsedHolding[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  onOpenMarket: (market: MarketLite, ticker: string) => void;
}) {
  const { style, dragHandle, resizeHandle, raise } = useMovableCard("markets", { x, y, w: width, h: height }, { minW: 360, minH: 260 });

  const [data, setData] = useState<MarketsPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (t: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });

  // Signature over the fields the query depends on — refetch only when holdings meaningfully change.
  const sig = useMemo(() => JSON.stringify(holdings.map((h) => [h.ticker, h.name, h.weight])), [holdings]);
  const loadedRef = useRef(false); // once we have data, refetch silently (keep old rows, no spinner)

  useEffect(() => {
    let cancelled = false;
    const body = JSON.stringify({ holdings: holdings.map((h) => ({ ticker: h.ticker, name: h.name, weight: h.weight })) });
    const load = () =>
      fetch("/api/prediction/markets", { method: "POST", headers: { "Content-Type": "application/json" }, body })
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          if (j.error) {
            if (!loadedRef.current) setErr(j.error);
          } else {
            setData(j);
            loadedRef.current = true;
            setErr(null);
          }
        })
        .catch(() => { if (!cancelled && !loadedRef.current) setErr("Couldn't load markets."); })
        .finally(() => { if (!cancelled) setLoading(false); });
    const t = setTimeout(load, loadedRef.current ? 400 : 0); // debounce edits; first load fires immediately
    const id = setInterval(load, 600_000); // refresh odds every 10 min
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Drop markets under MIN_VOLUME, recompute each asset's count from the survivors, and hide any
  // asset left with no markets at all.
  const assets = useMemo(
    () =>
      (data?.assets ?? [])
        .map((a) => {
          const markets = a.markets.filter((m) => (m.volume ?? 0) >= MIN_VOLUME);
          return { ...a, markets, count: markets.length };
        })
        .filter((a) => a.markets.length > 0),
    [data],
  );

  return (
    <div
      onPointerDown={raise}
      style={style}
      className="fade-in absolute flex flex-col overflow-hidden rounded-[20px] border border-white/[0.06] bg-[#0e0e0e] font-sans tracking-[-0.01em] shadow-[0_24px_70px_rgba(0,0,0,0.55)]"
    >
      {/* header — drag handle */}
      <div {...dragHandle} className="shrink-0 cursor-move touch-none select-none px-5 pt-4 pb-2.5">
        <h2 className="text-[16px] font-semibold text-white">Asset Related Markets</h2>
      </div>

      {/* body — list */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {loading && <p className="mt-10 animate-pulse text-center text-[13px] text-[#8a8a8a]">Scanning live markets…</p>}
        {err && !data && <p className="mt-10 text-center text-[13px] text-rose-400">{err}</p>}
        {data && !loading && !assets.length && (
          <p className="mt-10 text-center text-[12px] text-[#666]">{holdings.length ? "No prediction markets across these holdings yet." : "Add holdings to see related markets."}</p>
        )}

        {assets.map((a) => {
          const isExp = expanded.has(a.ticker);
          const shown = isExp ? a.markets : a.markets.slice(0, 8);
          return (
            <div key={a.ticker} className="mb-3 last:mb-0">
              <div className="flex items-baseline justify-between border-b border-white/[0.06] pb-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-white">{a.ticker}</span>
                  <span className="text-[11px] text-[#8a8a8a]">{a.label}</span>
                </div>
                <span className="text-[10px] uppercase tracking-wider text-[#8a8a8a]">{a.count} mkts</span>
              </div>
              {shown.map((m) => (
                <button
                  key={m.market_id}
                  onClick={() => onOpenMarket(m, a.ticker)}
                  className="-mx-2 flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
                >
                  <span className="line-clamp-2 min-w-0 flex-1 text-[12px] leading-[1.25] text-white/90">{m.question}</span>
                  <span className={cn("mt-px w-9 shrink-0 text-right text-[12px] tabular-nums", (m.yes ?? 0) >= 0.5 ? "text-emerald-400" : "text-white")}>
                    {pct(m.yes)}
                  </span>
                  <span className="mt-px w-12 shrink-0 text-right text-[10px] tabular-nums text-[#8a8a8a]">{fmtUSD(m.volume)}</span>
                </button>
              ))}
              {a.markets.length > 8 && (
                <button onClick={() => toggle(a.ticker)} className="mt-1 pl-3.5 text-[10px] text-[#8a8a8a] transition-colors hover:text-white">
                  {isExp ? "Show less" : `+${a.markets.length - 8} more`}
                </button>
              )}
            </div>
          );
        })}
      </div>

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
