"use client";

import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import type { MarketLite, MarketEvent, EventOutcomeLite } from "@/lib/oddpool";
import type { ParsedHolding } from "@/lib/parsePortfolio";
import type { EventStub } from "@/components/EventDetailCard";
import { useMovableCard, StaticLayoutContext } from "@/components/ui/useMovableCard";
import { marketsSig, getMarketsEntry, ensureMarkets, subscribeMarkets, MARKETS_TTL } from "@/lib/marketsStore";

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
  onOpenEvent?: (ev: EventStub) => void;
}) {
  const { style, dragHandle, resizeHandle, raise } = useMovableCard("markets", { x, y, w: width, h: height }, { minW: 360, minH: 260 });
  // On the mobile stack the card sheds its border/fill/shadow and sits directly on the page
  // background; on the desktop movable canvas it keeps its card chrome so it stays draggable.
  const isStatic = useContext(StaticLayoutContext);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (t: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });

  // Per-event accordion: multi-outcome events stay collapsed until the user taps the question,
  // so the normal state shows just the questions, not every outcome underneath them.
  const [openEvents, setOpenEvents] = useState<Set<string>>(new Set());
  const toggleEvent = (id: string) =>
    setOpenEvents((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Markets come from a shared cache (lib/marketsStore) that the app prefetches on launch and keeps
  // across mounts — so leaving and returning to this tab paints instantly instead of re-showing the
  // "Scanning live markets…" spinner. We just subscribe here and nudge a refresh on the same cadence.
  const sig = useMemo(() => marketsSig(holdings), [holdings]);
  const entry = useSyncExternalStore(subscribeMarkets, () => getMarketsEntry(sig), () => undefined);
  useEffect(() => {
    ensureMarkets(holdings);
    const id = setInterval(() => ensureMarkets(holdings, { force: true }), MARKETS_TTL);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const data = entry?.payload ?? null;
  const err = data ? null : entry?.err ?? null;
  const loading = !data && !err; // spinner only when we have nothing cached yet

  // Drop events under MIN_VOLUME (by total trade volume), recompute each asset's count from the
  // survivors, and hide any asset left with no events at all.
  const assets = useMemo(
    () =>
      (data?.assets ?? [])
        .map((a) => {
          const events = a.events.filter((e) => (e.volume ?? 0) >= MIN_VOLUME);
          return { ...a, events, count: events.length };
        })
        .filter((a) => a.events.length > 0),
    [data],
  );

  // An event's outcome → the MarketLite the market-detail card expects.
  const outcomeToLite = (o: EventOutcomeLite, ev: MarketEvent): MarketLite => ({
    market_id: o.market_id, question: o.question, exchange: ev.exchange,
    yes: o.yes, volume: o.volume, liquidity: o.liquidity, event_id: ev.event_id,
  });

  return (
    <div
      onPointerDown={raise}
      style={isStatic ? { boxShadow: "0 0 0 1px rgba(251,146,60,0.08), 0 12px 48px -16px rgba(244,120,80,0.22)" } : style}
      className={cn(
        "fade-in flex flex-col font-sans tracking-[-0.01em]",
        // Mobile: same rounded card + sunset-tinted edge glow as the portfolio's "Your Holdings" box.
        isStatic
          ? "relative w-full overflow-hidden rounded-2xl border border-white/[0.09]"
          : "absolute overflow-hidden rounded-[20px] border border-white/[0.06] bg-[#0e0e0e] shadow-[0_24px_70px_rgba(0,0,0,0.55)]",
      )}
    >
      {/* header — drag handle */}
      <div {...dragHandle} className="shrink-0 cursor-move touch-none select-none px-5 pt-4 pb-1">
        <h2 className="text-[12px] uppercase tracking-wider text-white">Portfolio Relevant Markets</h2>
      </div>

      {/* body — list. On mobile the card grows to its content (no inner scroll); on desktop the
          fixed-height card scrolls internally. */}
      <div className={cn("px-5 pt-1 pb-2", !isStatic && "no-scrollbar min-h-0 flex-1 overflow-y-auto")}>
        {loading && <p className="mt-10 animate-pulse text-center text-[13px] text-[#8a8a8a]">Scanning live markets…</p>}
        {err && !data && <p className="mt-10 text-center text-[13px] text-rose-400">{err}</p>}
        {data && !loading && !assets.length && (
          <p className="mt-10 text-center text-[12px] text-[#666]">{holdings.length ? "No prediction markets across these holdings yet." : "Add holdings to see related markets."}</p>
        )}

        {assets.map((a) => {
          const isExp = expanded.has(a.ticker);
          const shown = isExp ? a.events : a.events.slice(0, 6);
          return (
            <div key={a.ticker} className="mb-2 last:mb-0">
              <div className="flex items-baseline justify-between border-b border-white/[0.06] pb-0.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12.5px] font-medium leading-tight text-white">{a.ticker}</span>
                </div>
              </div>
              {shown.map((ev, i) => {
                // Every event — single OR multi-outcome — collapses to just its question; the numbers
                // (probabilities + trade volume) only appear once the question is pressed. A single
                // market reveals its Yes/No sides; a multi-outcome event reveals every outcome.
                const evOpen = openEvents.has(ev.event_id);
                const noProb = ev.yes == null ? null : 1 - ev.yes;
                return (
                  <div key={ev.event_id} className="mt-0.5 first:mt-0">
                    <button
                      onClick={() => toggleEvent(ev.event_id)}
                      aria-expanded={evOpen}
                      className={cn(
                        "group -mx-2 flex w-full rounded-md px-2 text-left transition-colors hover:bg-white/[0.04]",
                        // First question sits tight under the ticker; the rest keep even vertical padding.
                        i === 0 ? "pt-1 pb-1.5" : "py-1.5",
                      )}
                    >
                      <span className="min-w-0 flex-1 text-[12px] font-medium leading-[1.35] text-white/80">{ev.title}</span>
                    </button>
                    {evOpen && (
                      <div className="ml-1 border-l border-white/[0.08] pl-2.5">
                        {ev.single
                          ? // Single market → Yes / No, each with its probability + the market's trade volume.
                            [
                              { key: "yes", label: "Yes", prob: ev.yes },
                              { key: "no", label: "No", prob: noProb },
                            ].map((side) => (
                              <div key={side.key} className="-mx-1 flex w-full items-center gap-1.5 px-1 py-1">
                                <span className="min-w-0 flex-1 text-[11.5px] text-white/75">{side.label}</span>
                                <span className={cn("w-8 shrink-0 text-right text-[11.5px] tabular-nums", (side.prob ?? 0) >= 0.5 ? "text-emerald-400" : "text-white/90")}>
                                  {pct(side.prob)}
                                </span>
                                <span className="w-11 shrink-0 text-right text-[11.5px] tabular-nums text-[#8a8a8a]">{fmtUSD(ev.volume)}</span>
                              </div>
                            ))
                          : ev.outcomes.map((o) => (
                              <button
                                key={o.market_id}
                                onClick={() => onOpenMarket(outcomeToLite(o, ev), a.ticker)}
                                className="-mx-1 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-white/[0.04]"
                              >
                                <span className="line-clamp-2 min-w-0 flex-1 text-[11.5px] text-white/75">{o.label}</span>
                                <span className={cn("w-8 shrink-0 text-right text-[11.5px] tabular-nums", (o.yes ?? 0) >= 0.5 ? "text-emerald-400" : "text-white/90")}>
                                  {pct(o.yes)}
                                </span>
                                <span className="w-11 shrink-0 text-right text-[11.5px] tabular-nums text-[#8a8a8a]">{fmtUSD(o.volume)}</span>
                              </button>
                            ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {a.events.length > 6 && (
                <button onClick={() => toggle(a.ticker)} className="mt-1 pl-3.5 text-[10px] text-[#8a8a8a] transition-colors hover:text-white">
                  {isExp ? "Show less" : `+${a.events.length - 6} more`}
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
