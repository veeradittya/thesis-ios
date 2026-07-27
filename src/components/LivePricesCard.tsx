"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useMovableCard } from "@/components/ui/useMovableCard";
import { readQuoteCache, writeQuoteCache } from "@/lib/priceCache";

interface Asset {
  ticker: string;
  name: string | null;
}
interface Row {
  price: number | null;
  prevClose: number | null;
  change: number | null;
  percent: number | null;
  flashDir: "up" | "down" | null;
  flashTs: number;
}

const fmtPrice = (v: number | null) => (v == null ? "—" : v.toFixed(2));
const fmtPct = (v: number | null) => (v == null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

export function LivePricesCard({
  assets,
  onOpenChart,
  refreshSignal,
  x = 1560,
  y = 110,
  width = 360,
  height = 500,
}: {
  assets: Asset[];
  onOpenChart: (asset: Asset) => void;
  refreshSignal?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}) {
  const { style, dragHandle, resizeHandle, raise } = useMovableCard("prices", { x, y, w: width, h: height }, { minW: 280, minH: 240 });
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");

  const symbols = assets.map((a) => a.ticker).filter(Boolean).join(",");

  useEffect(() => {
    if (!symbols) { setRows({}); return; }
    // Drop rows for tickers no longer held (ledger edit) so removed holdings don't linger; the
    // fresh snapshot repopulates the active set.
    const active = new Set(symbols.split(","));
    setRows((prev) => {
      const next: Record<string, Row> = {};
      for (const [sym, row] of Object.entries(prev)) if (active.has(sym)) next[sym] = row;
      return next;
    });
    // Seed from the local cache immediately so prices show before the fetch returns.
    const cached = readQuoteCache([...active]);
    if (Object.keys(cached).length) {
      setRows((prev) => {
        const next = { ...prev };
        for (const [sym, c] of Object.entries(cached)) if (!next[sym]) next[sym] = { price: c.price, prevClose: c.prevClose ?? null, change: c.change ?? null, percent: c.percent, flashDir: null, flashTs: 0 };
        return next;
      });
    }
    // Fetch once on load / on refreshSignal — no interval polling. Each fetch diffs against the last
    // price to keep the up/down tick flash; the flash-fade effect clears it.
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/quote?symbols=${encodeURIComponent(symbols)}`);
        const j = await r.json();
        const q = (j.quotes || {}) as Record<string, { price: number | null; prevClose: number | null; change: number | null; percent: number | null }>;
        if (cancelled) return;
        const now = Date.now();
        setRows((prev) => {
          const next = { ...prev };
          for (const [sym, v] of Object.entries(q)) {
            const old = prev[sym];
            const prevPrice = old?.price ?? null;
            let dir: "up" | "down" | null = old?.flashDir ?? null;
            let flashTs = old?.flashTs ?? 0;
            if (prevPrice != null && v.price != null && v.price !== prevPrice) {
              dir = v.price > prevPrice ? "up" : "down";
              flashTs = now;
            }
            next[sym] = { price: v.price, prevClose: v.prevClose, change: v.change, percent: v.percent, flashDir: dir, flashTs };
          }
          return next;
        });
        writeQuoteCache(q);
        setStatus("live");
      } catch {
        if (!cancelled) setStatus((s) => (s === "live" ? "live" : "error"));
      }
    })();

    return () => { cancelled = true; };
  }, [symbols, refreshSignal]);

  // Fade out tick flashes ~450ms after the last trade (only re-renders when needed).
  useEffect(() => {
    const id = setInterval(() => {
      setRows((prev) => {
        const now = Date.now();
        let changed = false;
        const next = { ...prev };
        for (const k in next) {
          if (next[k].flashDir && now - next[k].flashTs > 450) {
            next[k] = { ...next[k], flashDir: null };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 250);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      onPointerDown={raise}
      style={style}
      className="fade-in absolute flex flex-col overflow-hidden rounded-[20px] border border-white/[0.06] bg-[#0e0e0e] font-sans tracking-[-0.01em] shadow-[0_24px_70px_rgba(0,0,0,0.55)]"
    >
      {/* header — drag handle */}
      <div {...dragHandle} className="flex shrink-0 cursor-move touch-none select-none items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div>
          <h2 className="text-[16px] font-semibold text-white">Live Prices</h2>
        </div>
        {status !== "live" && (
          <span className="mt-0.5 shrink-0 text-[10px] uppercase tracking-wider text-[#8a8a8a]">
            {status === "connecting" ? "connecting…" : "reconnecting…"}
          </span>
        )}
      </div>

      {/* body — rows */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-1.5">
        {assets.map((a) => {
          const r = rows[a.ticker];
          const up = (r?.percent ?? 0) >= 0;
          const flash = r?.flashDir;
          return (
            <button
              key={a.ticker}
              onClick={() => onOpenChart(a)}
              title={`Open ${a.ticker} live chart`}
              className="flex w-full items-center justify-between gap-3 border-t border-white/[0.06] py-2.5 text-left transition-colors first:border-t-0 hover:bg-white/[0.03]"
            >
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-white">{a.ticker}</p>
                {a.name && <p className="truncate text-[11px] text-[#8a8a8a]">{a.name}</p>}
              </div>
              <div className="shrink-0 text-right">
                <p
                  className={cn(
                    "rounded px-1 text-[13px] tabular-nums text-white transition-colors duration-200",
                    flash === "up" ? "bg-emerald-500/25" : flash === "down" ? "bg-rose-500/25" : "bg-transparent",
                  )}
                >
                  {fmtPrice(r?.price ?? null)}
                </p>
                <p className={cn("mt-0.5 text-[11px] tabular-nums", r?.percent == null ? "text-[#8a8a8a]" : up ? "text-emerald-400" : "text-rose-400")}>
                  {fmtPct(r?.percent ?? null)}
                </p>
              </div>
            </button>
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
