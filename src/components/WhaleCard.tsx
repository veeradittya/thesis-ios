"use client";

import { useContext, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import type { WhalePayload, WhaleTrade } from "@/lib/oddpool";
import { useMovableCard, StaticLayoutContext } from "@/components/ui/useMovableCard";

// A single horizontal volume bar (recharts) sized to sit inline beside its Yes/No label; its height
// (13px) matches the ~13px row text. The larger of a question's Yes/No sets the shared scale.
function VolBar({ value, max, color }: { value: number; max: number; color: string }) {
  const gid = `whalebar-${color.replace("#", "")}`;
  return (
    <ResponsiveContainer width="100%" height={13}>
      <BarChart layout="vertical" data={[{ n: "x", v: value }]} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={0}>
        <defs>
          {/* very slight glass: a brighter, more-opaque top fading to a translucent base */}
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.9} />
            <stop offset="45%" stopColor={color} stopOpacity={0.72} />
            <stop offset="100%" stopColor={color} stopOpacity={0.6} />
          </linearGradient>
        </defs>
        <XAxis type="number" domain={[0, max]} hide />
        <YAxis type="category" dataKey="n" hide />
        <Bar dataKey="v" fill={`url(#${gid})`} radius={[2, 2, 2, 2]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function fmtUSD(v: number | null | undefined): string {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}
const cents = (p: number | null | undefined) => (p == null ? "—" : `${(p > 1 ? p : p * 100).toFixed(1)}¢`);
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const wallet = (w?: string) => (w ? `${w.slice(0, 6)}…${w.slice(-4)}` : "");
const isYes = (t: WhaleTrade) => /yes/i.test(t.taker_side || t.outcome);

// One question that saw whale activity, with its Yes/No sides aggregated.
interface QuestionAgg {
  key: string;
  title: string;
  yesVol: number;
  noVol: number;
  yesCount: number;
  noCount: number;
  totalVol: number;
  trades: WhaleTrade[]; // all trades on this question, biggest first
}

export function WhaleCard({ x = 40, y = 680, width = 1010, height = 300 }: { x?: number; y?: number; width?: number; height?: number }) {
  const { style, dragHandle, resizeHandle, raise } = useMovableCard("whale", { x, y, w: width, h: height }, { minW: 380, minH: 240 });
  const isStatic = useContext(StaticLayoutContext);
  const [data, setData] = useState<WhalePayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Each question collapses to its Yes/No summary bar; tap to reveal the individual trades.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  useEffect(() => {
    let cancelled = false;
    const load = (first: boolean) =>
      fetch("/api/whales")
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          if (j.error) setErr(j.error);
          else {
            setData(j);
            setErr(null);
          }
        })
        .catch(() => !cancelled && first && setErr("Couldn't load whale feed."))
        .finally(() => first && !cancelled && setLoading(false));
    load(true);
    const id = setInterval(() => load(false), 12000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Group the raw trades by question, splitting each into Yes/No sides.
  const questions = useMemo<QuestionAgg[]>(() => {
    const map = new Map<string, QuestionAgg>();
    for (const t of data?.trades ?? []) {
      const key = t.market_title || t.market_ticker;
      let q = map.get(key);
      if (!q) {
        q = { key, title: t.market_title, yesVol: 0, noVol: 0, yesCount: 0, noCount: 0, totalVol: 0, trades: [] };
        map.set(key, q);
      }
      const size = t.trade_size_usd || 0;
      if (isYes(t)) {
        q.yesVol += size;
        q.yesCount++;
      } else {
        q.noVol += size;
        q.noCount++;
      }
      q.totalVol += size;
      q.trades.push(t);
    }
    const arr = [...map.values()];
    arr.forEach((q) => q.trades.sort((a, b) => (b.trade_size_usd || 0) - (a.trade_size_usd || 0)));
    return arr.sort((a, b) => b.totalVol - a.totalVol); // biggest whale-traded questions first
  }, [data]);

  return (
    <div
      onPointerDown={raise}
      style={isStatic ? { boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2), 0 0 0 1px rgba(255,255,255,0.05), 0 12px 40px -18px rgba(0,0,0,0.5)" } : style}
      className={cn(
        "fade-in flex flex-col overflow-hidden font-sans tracking-[-0.01em]",
        // Mobile: same rounded card + liquid-glass sheen as the Analyst Sentiment cards.
        isStatic
          ? "relative w-full rounded-2xl border border-white/[0.09]"
          : "absolute rounded-[20px] border border-white/[0.06] bg-[#0e0e0e] shadow-[0_24px_70px_rgba(0,0,0,0.55)]",
      )}
    >
      {/* header — drag handle */}
      <div {...dragHandle} className="shrink-0 cursor-move touch-none select-none px-5 pt-4 pb-0.5">
        <h2 className="text-[12px] uppercase tracking-wider text-white">Whale Watcher</h2>
      </div>

      {/* body — one row per whale-traded question; scrolls within a capped height so the other
          questions are reachable without stretching the card. */}
      <div className={cn("no-scrollbar overflow-y-auto px-5 py-1.5", isStatic ? "max-h-[340px] overscroll-contain" : "min-h-0 flex-1")}>
        {loading && <p className="mt-10 animate-pulse text-center text-[13px] text-[#8a8a8a]">Loading whale trades…</p>}
        {err && !data && <p className="mt-10 text-center text-[13px] text-rose-400">{err}</p>}
        {data && !questions.length && !loading && (
          <p className="mt-10 text-center text-[12px] text-[#666]">No whale trades (≥$1K) on tracked markets yet.</p>
        )}

        {questions.map((q) => {
          const isOpen = open.has(q.key);
          const max = Math.max(1, q.yesVol, q.noVol);
          return (
            <div key={q.key} className="border-t border-white/[0.06] py-2.5 first:border-t-0 first:pt-1">
              {/* question + two labeled volume bars (Yes / No) — tap to reveal the trades */}
              <button onClick={() => toggle(q.key)} aria-expanded={isOpen} className="group w-full text-left">
                <p className="text-[12.5px] font-medium leading-[1.3] text-white/90 group-hover:text-white">{q.title}</p>
                <div className="mt-2 flex flex-col gap-0.5">
                  <div className="flex items-center gap-2 text-[11px] tabular-nums text-emerald-400">
                    <div className="flex w-[76px] shrink-0 items-baseline gap-1">
                      <span className="w-6 shrink-0">Yes</span>
                      <span className="shrink-0">{fmtUSD(q.yesVol)}</span>
                    </div>
                    <div className="min-w-0 flex-1"><VolBar value={q.yesVol} max={max} color="#10b981" /></div>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] tabular-nums text-rose-400">
                    <div className="flex w-[76px] shrink-0 items-baseline gap-1">
                      <span className="w-6 shrink-0">No</span>
                      <span className="shrink-0">{fmtUSD(q.noVol)}</span>
                    </div>
                    <div className="min-w-0 flex-1"><VolBar value={q.noVol} max={max} color="#f43f5e" /></div>
                  </div>
                </div>
              </button>

              {/* individual Yes/No whale trades on this question */}
              {isOpen && (
                <div className="ml-1 mt-2 border-l border-white/[0.08] pl-2.5">
                  {q.trades.map((t) => {
                    const yes = isYes(t);
                    return (
                      <div key={t.id} className="flex items-center gap-2 py-1">
                        <span
                          className={cn(
                            "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                            yes ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400",
                          )}
                        >
                          {yes ? "Yes" : "No"}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[10.5px] tabular-nums text-[#8a8a8a]">
                          {cents(t.price)} · {relTime(t.timestamp)}
                          {t.trader_wallet ? ` · ${wallet(t.trader_wallet)}` : ""}
                        </span>
                        <span className="shrink-0 text-right text-[12px] font-semibold tabular-nums text-white">{fmtUSD(t.trade_size_usd)}</span>
                      </div>
                    );
                  })}
                </div>
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
