"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useMovableCard } from "@/components/ui/useMovableCard";
import { usePollingActive } from "@/components/ui/usePollingActive";
import { PredictionChart, RangeToggle, type ChartRange, type ChartSeries } from "@/components/PredictionChart";
import type { MarketLite } from "@/lib/oddpool";

// Wire shapes (mirror @/lib/oddpool payloads).
interface Outcome { market_id: string; question: string; exchange: string; yes: number | null; volume: number | null; liquidity: number | null; event_id: string; active?: boolean }
interface Series { market_id: string; label: string; points: Array<{ ts: string; close: number }> }
interface Detail { event_id: string; exchange: string; title: string; category: string | null; status: string | null; totalVolume: number; totalLiquidity: number; outcomes: Outcome[]; chart: Series[] }
interface WhaleTrade { taker_side: string; trade_size_usd: number; price: number; market_title: string; trader_wallet?: string; timestamp: string }
interface WhaleOutcome { marketId: string; label: string; yesVolume: number; noVolume: number; total: number; count: number }
interface Whale { tradeCount: number; totalVolume: number; yesVolume: number; noVolume: number; outcomes: WhaleOutcome[]; trades: WhaleTrade[] }

export interface EventStub { event_id: string; exchange: string; title: string; category: string | null; image?: string | null }

const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
function fmtUSD(v: number | null | undefined): string {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
}
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const shortTicker = (mid: string) => {
  // Polymarket market ids are long hex hashes (0x…) with no ticker — truncate them.
  if (/^0x[0-9a-f]{6,}$/i.test(mid)) return `${mid.slice(0, 6)}…${mid.slice(-4)}`;
  const p = mid.split("-");
  return p[p.length - 1] || mid;
};
const venueLabel = (v: string) => (v === "kalshi" ? "Kalshi" : v === "polymarket" ? "Polymarket" : v);
const COLORS = ["#34d399", "#38bdf8", "#fbbf24", "#e879f9", "#f87171"];

// Legend / tooltip / whale-chart label: outcomes share a long event-title prefix
// ("US-Iran Final Nuclear Deal by August 31, 2026?") — keep just the distinguishing
// "Month Day" date ("August 31"). Falls back to the "by/before <tail>" clause, then the
// full text, for non date-cutoff outcomes (e.g. "Before 2027", categorical events).
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
function outcomeLabel(q: string): string {
  const s = (q || "").trim().replace(/\?+\s*$/, "").trim();
  const md = s.match(new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}\\b`, "i"));
  if (md) return md[0].replace(/\s+/g, " ");
  const i = s.toLowerCase().search(/\b(?:by|before|after|on|above|below|under|over)\s/);
  if (i >= 0) { const t = s.slice(i); return t.charAt(0).toUpperCase() + t.slice(1); }
  return s;
}

// Concise chart/whale labels for a whole event: strip the prefix + suffix shared by
// every outcome, leaving just the distinguisher — the date for date-cutoff events
// ("US-Iran … by August 31, 2026?" → "August 31") and the entity for categorical
// events ("Will Trump meet Xi Jinping before Jan 1, 2027?" → "Xi Jinping"). Falls
// back to the per-label heuristic when there's no shared affix.
function labelOutcomes(questions: string[]): string[] {
  const clean = questions.map((q) => (q || "").trim().replace(/\?+\s*$/, "").trim());
  if (clean.length <= 1) return clean.map((s) => outcomeLabel(s));
  let pre = clean[0], suf = clean[0];
  for (const s of clean) {
    let i = 0; while (i < pre.length && i < s.length && pre[i] === s[i]) i++; pre = pre.slice(0, i);
    let j = 0; while (j < suf.length && j < s.length && suf[suf.length - 1 - j] === s[s.length - 1 - j]) j++; suf = suf.slice(suf.length - j);
  }
  pre = pre.replace(/\S+$/, ""); // back off to a word boundary so we never cut mid-word
  suf = suf.replace(/^\S+/, "");
  const trim = (s: string) => s.replace(/^[\s,:;–-]+/, "").replace(/[\s,:;–-]+$/, "").trim();
  return clean.map((s) => {
    let r = s;
    if (pre && r.startsWith(pre)) r = r.slice(pre.length);
    if (suf && r.length > suf.length && r.endsWith(suf)) r = r.slice(0, r.length - suf.length);
    r = trim(r);
    return r || outcomeLabel(s);
  });
}

export function EventDetailCard({
  event,
  x = 200,
  y = 200,
  onClose,
  onOpenMarket,
}: {
  event: EventStub;
  x?: number;
  y?: number;
  onClose: () => void;
  onOpenMarket: (m: MarketLite, ticker: string) => void;
}) {
  const { style, dragHandle, resizeHandle, raise } = useMovableCard(`event:${event.event_id}`, { x, y, w: 480, h: 600 }, { minW: 380, minH: 340 });
  const cardRef = useRef<HTMLDivElement>(null);
  const activeRef = usePollingActive(cardRef);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [whale, setWhale] = useState<Whale | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [range, setRange] = useState<ChartRange>("30d");

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/oddpool/event?id=${encodeURIComponent(event.event_id)}&exchange=${encodeURIComponent(event.exchange)}&range=${range}`)
        .then((r) => r.json())
        .then((j) => { if (!alive) return; if (j.error) setErr(j.error); else { setDetail(j as Detail); setErr(null); } })
        .catch(() => alive && setErr("Couldn't load event."));
    load(); // initial load always; recurring poll pauses when the card is inactive
    const id = setInterval(() => { if (activeRef.current) load(); }, 45000);
    return () => { alive = false; clearInterval(id); };
  }, [event.event_id, event.exchange, range]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/oddpool/event/whale?id=${encodeURIComponent(event.event_id)}&exchange=${encodeURIComponent(event.exchange)}`)
        .then((r) => r.json())
        .then((j) => { if (alive && !j.error) setWhale(j as Whale); })
        .catch(() => {});
    load();
    const id = setInterval(() => { if (activeRef.current) load(); }, 30000); // whale backfills after tracking
    return () => { alive = false; clearInterval(id); };
  }, [event.event_id, event.exchange]);

  const outcomes = detail?.outcomes || [];
  const byMkt = new Map(outcomes.map((o) => [o.market_id, o] as const));
  // Concise labels shared by the chart legend/tooltip + whale chart (common-affix strip). When every
  // outcome carries the same question (e.g. a Kalshi "mention" event), the affix strip collapses to
  // identical/blank labels — fall back to the market_id suffix (GEMI, IPHO, SIRI…) so each outcome
  // is still named/distinguishable.
  const rawLabels = labelOutcomes(outcomes.map((o) => o.question));
  const suffixLabels = outcomes.length > 1 && new Set(rawLabels.map((l) => (l || "").trim().toLowerCase())).size <= 1;
  const shortLabels = suffixLabels ? outcomes.map((o) => shortTicker(o.market_id)) : rawLabels;
  const labelByMkt = new Map(outcomes.map((o, i) => [o.market_id, shortLabels[i]] as const));
  // Server already dropped outdated outcomes + capped to the top 5. Give each series a
  // live tail (the current YES quote) so the line tip tracks the latest price.
  const chartSeries: ChartSeries[] = (detail?.chart || []).map((s, i) => ({
    key: s.market_id,
    label: labelByMkt.get(s.market_id) || outcomeLabel(byMkt.get(s.market_id)?.question || s.label),
    color: COLORS[i % COLORS.length],
    points: s.points.map((p) => ({ t: Date.parse(p.ts), c: p.close })),
    live: byMkt.get(s.market_id)?.yes ?? null,
  }));
  // Whale-by-outcome diverging chart. Drop resolved/outdated outcomes (like the prob
  // chart + Oddpool's own view) — otherwise a settled leg's huge accumulated volume
  // dwarfs the live ones. Color each to its chart line (else gray); share one scale so
  // YES/NO $ are visually comparable; totals/count reflect only the displayed outcomes.
  const seriesColor = new Map(chartSeries.map((s) => [s.key, s.color] as const));
  const inactiveIds = new Set(outcomes.filter((o) => o.active === false).map((o) => o.market_id));
  const whaleOutcomes = (whale?.outcomes || []).filter((o) => !inactiveIds.has(o.marketId));
  const whaleTotal = whaleOutcomes.reduce((s, o) => s + o.total, 0);
  const whaleCount = whaleOutcomes.reduce((s, o) => s + o.count, 0);
  const whaleScale = Math.max(1, ...whaleOutcomes.flatMap((o) => [o.yesVolume, o.noVolume]));

  return (
    <div
      ref={cardRef}
      onPointerDown={raise}
      style={style}
      className="fade-in absolute flex flex-col overflow-hidden rounded-[20px] border border-white/[0.06] bg-[#0e0e0e] font-sans tracking-[-0.01em] shadow-[0_24px_70px_rgba(0,0,0,0.55)]"
    >
      {/* header */}
      <div {...dragHandle} className="flex shrink-0 cursor-move touch-none select-none items-start justify-between gap-3 border-b border-white/[0.06] px-5 pt-4 pb-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-[#8a8a8a]">
            {(event.category || "Event")} · {venueLabel(event.exchange)}
          </p>
          <h2 className="mt-1 line-clamp-2 text-[15px] font-semibold text-white">{detail?.title || event.title}</h2>
        </div>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={onClose} title="Close" className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[#8a8a8a] transition-colors hover:bg-white/10 hover:text-white">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {err && <p className="mt-6 text-center text-[13px] text-rose-400">{err}</p>}
        {!detail && !err && <p className="mt-10 animate-pulse text-center text-[13px] text-[#8a8a8a]">Loading event…</p>}

        {detail && (
          <>
            <div className="flex items-center gap-4 text-[11px] tabular-nums text-[#8a8a8a]">
              <span>Vol <span className="text-white/80">{fmtUSD(detail.totalVolume)}</span></span>
              <span>Liq <span className="text-white/80">{fmtUSD(detail.totalLiquidity)}</span></span>
              <span className="capitalize">{detail.status || ""}</span>
            </div>

            {/* multi-outcome chart — active outcomes only, range-selectable */}
            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-[#8a8a8a]">Probability</span>
                <RangeToggle value={range} onChange={setRange} />
              </div>
              <PredictionChart series={chartSeries} range={range} height={144} />
              {chartSeries.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                  {chartSeries.map((s) => (
                    <span key={s.key} className="flex items-center gap-1.5 text-[10px] text-[#8a8a8a]">
                      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                      <span className="max-w-[150px] truncate">{s.label}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* outcomes → open market card */}
            <p className="mb-1 mt-4 text-[10px] uppercase tracking-wider text-[#8a8a8a]">Outcomes · {outcomes.length}</p>
            {outcomes.map((o) => (
              <button
                key={o.market_id}
                onClick={() => onOpenMarket({ market_id: o.market_id, question: o.question, exchange: o.exchange, yes: o.yes, volume: o.volume, liquidity: o.liquidity, event_id: o.event_id }, shortTicker(o.market_id))}
                title="Open market detail"
                className="-mx-2 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
              >
                <span className="line-clamp-1 min-w-0 flex-1 text-[12px] text-white/90">{suffixLabels ? shortTicker(o.market_id) : o.question}</span>
                <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-[#8a8a8a]">{fmtUSD(o.volume)}</span>
                <span className={cn("w-9 shrink-0 text-right text-[12px] font-semibold tabular-nums", (o.yes ?? 0) >= 0.5 ? "text-emerald-400" : "text-white")}>{pct(o.yes)}</span>
              </button>
            ))}

            {/* whale activity — diverging YES/NO bar per outcome */}
            <div className="mt-4 border-t border-white/[0.06] pt-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[10px] uppercase tracking-wider text-[#8a8a8a]">Whale activity by outcome</p>
                {whaleOutcomes.length > 0 && <span className="shrink-0 text-right text-[10px] tabular-nums text-[#8a8a8a]">{fmtUSD(whaleTotal)} · {whaleCount} trades</span>}
              </div>
              {!whale && <p className="mt-2 animate-pulse text-[11px] text-[#8a8a8a]">Loading whale activity…</p>}
              {whale && whale.tradeCount === 0 && <p className="mt-2 text-[11px] text-[#666]">No ≥$1K trades yet (may still be backfilling).</p>}
              {whale && whale.tradeCount > 0 && (
                <>
                  {whaleOutcomes.length > 0 && (
                    <div className="mt-2.5">
                      {/* NO / YES headers over the center divider */}
                      <div className="mb-1 flex items-center">
                        <span className="w-[92px] shrink-0" />
                        <div className="relative h-3 flex-1">
                          <span className="absolute left-1/2 -translate-x-[calc(100%+5px)] text-[8.5px] font-medium uppercase tracking-wider text-rose-400/70">No</span>
                          <span className="absolute left-1/2 translate-x-[5px] text-[8.5px] font-medium uppercase tracking-wider text-emerald-400/70">Yes</span>
                        </div>
                        <span className="w-12 shrink-0 text-right text-[8.5px] font-medium uppercase tracking-wider text-[#8a8a8a]">Total</span>
                      </div>
                      {whaleOutcomes.map((o) => {
                        const noW = (o.noVolume / whaleScale) * 50;
                        const yesW = (o.yesVolume / whaleScale) * 50;
                        return (
                          <div key={o.marketId} className="flex items-center gap-2 py-[3px]">
                            <span className="flex w-[92px] shrink-0 items-center gap-1.5">
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: seriesColor.get(o.marketId) || "#6b7280" }} />
                              <span className="truncate text-[11px] text-white/85">{labelByMkt.get(o.marketId) || outcomeLabel(o.label)}</span>
                            </span>
                            <div className="relative h-4 flex-1">
                              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/15" />
                              {o.noVolume > 0 && (
                                <div className="absolute inset-y-0 flex items-center justify-end overflow-hidden rounded-l-[3px] bg-rose-500/80 pr-1" style={{ right: "50%", width: `${noW}%` }}>
                                  {noW > 13 && <span className="text-[9px] font-medium tabular-nums text-white">{fmtUSD(o.noVolume)}</span>}
                                </div>
                              )}
                              {o.yesVolume > 0 && (
                                <div className="absolute inset-y-0 flex items-center overflow-hidden rounded-r-[3px] bg-emerald-500/80 pl-1" style={{ left: "50%", width: `${yesW}%` }}>
                                  {yesW > 13 && <span className="text-[9px] font-medium tabular-nums text-white">{fmtUSD(o.yesVolume)}</span>}
                                </div>
                              )}
                            </div>
                            <span className="w-12 shrink-0 text-right text-[11px] font-semibold tabular-nums text-white">{fmtUSD(o.total)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="mt-3 space-y-1">
                    {whale.trades.slice(0, 6).map((t, i) => (
                      <div key={i} className="flex items-center gap-2 text-[10.5px] tabular-nums text-[#8a8a8a]">
                        <span className={cn("w-8 shrink-0 rounded px-1 text-center text-[9px] font-semibold uppercase", t.taker_side === "yes" ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300")}>{t.taker_side}</span>
                        <span className="w-12 shrink-0 text-white/80">{fmtUSD(t.trade_size_usd)}</span>
                        <span className="w-9 shrink-0">{Math.round(t.price)}¢</span>
                        <span className="min-w-0 flex-1 truncate">{t.market_title}</span>
                        <span className="shrink-0">{relTime(t.timestamp)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div {...resizeHandle} className="absolute bottom-0 right-0 z-20 flex h-7 w-7 cursor-nwse-resize touch-none items-end justify-end p-1.5 text-white/40 transition-colors hover:text-white/80" title="Drag to resize">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M11 4L4 11M11 8L8 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </div>
    </div>
  );
}
