"use client";

import { useContext, useEffect, useRef, useState } from "react";
import type React from "react";
import { cn } from "@/lib/utils";
import { stripCitations } from "@/lib/briefText";
import { useMovableCard, StaticLayoutContext } from "@/components/ui/useMovableCard";

// Daily Briefing — reads the scheduled agent's pre-computed output (portfolio overview memo + each
// holding's shared per-asset research) from Turso via /api/monitor and shows it with progressive
// disclosure. No LLM runs on open. The last payload is cached in localStorage so the card paints
// instantly and only re-renders when the data actually changes. On the phone stack (StaticLayout)
// the card grows to fit ALL holdings (no inner scroll); global .static-card CSS steps text up a notch.

const VERDICT_LABEL: Record<string, string> = { holds_up: "Holds up", weakening: "Weakening", at_risk: "At risk", watch: "Watch" };
const VERDICT_STYLE: Record<string, string> = { holds_up: "text-emerald-400", weakening: "text-amber-300", at_risk: "text-rose-400", watch: "text-[#8a8a8a]" };
const SIGNAL_LABEL: Record<string, string> = { odds: "Odds", orderbook: "Order book", markets: "Markets", whale: "Whale flow", news: "News", filing: "Filing", filings: "Filings", earnings: "Earnings", pricing: "Pricing", price: "Price", robotaxi: "Robotaxi", macro: "Macro", correlation: "Correlation", position: "Position", thesis: "Thesis" };

interface Result { ticker: string; name: string; verdict: string; risk: number | null; rationale: string; signals: string; researchedAt: string }
interface Payload { memo: string | null; updatedAt: string | null; results: Result[]; error?: string }

// Render prose with inline [text](url) links; everything else is plain (React-escaped) text.
function renderLinked(md: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m.index > last) out.push(md.slice(last, m.index));
    out.push(
      <a key={m.index} href={m[2]} target="_blank" rel="noreferrer" className="text-white underline decoration-white/30 underline-offset-2 transition-colors hover:decoration-white">
        {m[1]}
      </a>,
    );
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push(md.slice(last));
  return out;
}
// Strip markdown links + bold to plain text for the glance lines.
const plain = (md: string) => md.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1").replace(/\*\*/g, "");

// Risk band → colour (high risk = rose, low = emerald). Higher number = more risk.
function riskColor(r: number | null): string {
  if (r == null) return "text-[#6b6b6b]";
  if (r >= 70) return "text-rose-400";
  if (r >= 45) return "text-amber-300";
  return "text-emerald-400";
}
// "2026-07-24T21:13:00Z" → "Jul 24, 2026 · 5:13 PM ET"
function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  return `${date} · ${time} ET`;
}

export function ThesisMonitorCard({
  user = "pilot",
  x = 40,
  y = 110,
  width = 460,
  height = 560,
}: {
  user?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}) {
  const isStatic = useContext(StaticLayoutContext); // true in the phone stack → grow to fit content
  const { style, dragHandle, resizeHandle, raise } = useMovableCard("monitor", { x, y, w: width, h: height }, { minW: 340, minH: 280 });
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const lastJson = useRef<string>("");

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `thesis.monitor.${user}`;
    // Paint from the last cached payload immediately, before the network resolves.
    try {
      const c = localStorage.getItem(cacheKey);
      if (c) {
        const j = JSON.parse(c) as Payload;
        if (j && Array.isArray(j.results)) { lastJson.current = c; setData(j); setLoading(false); }
      }
    } catch {}

    const load = () =>
      fetch(`/api/monitor?user=${encodeURIComponent(user)}`)
        .then((r) => r.json())
        .then((j: Payload) => {
          if (cancelled) return;
          if (j.error && !(j.results && j.results.length)) {
            if (!lastJson.current) setErr(j.error); // keep cached view if we have one
            return;
          }
          setErr(null);
          const next = JSON.stringify({ memo: j.memo, updatedAt: j.updatedAt, results: j.results });
          if (next !== lastJson.current) {
            lastJson.current = next;
            setData(j);
            try { localStorage.setItem(cacheKey, next); } catch {}
          }
        })
        .catch(() => { if (!cancelled && !lastJson.current) setErr("Couldn't load the briefing."); })
        .finally(() => { if (!cancelled) setLoading(false); });
    load();
    const id = setInterval(load, 600_000); // agent writes ~once/day; revalidate occasionally
    return () => { cancelled = true; clearInterval(id); };
  }, [user]);

  const toggle = (t: string) => setOpenRows((p) => { const n = new Set(p); if (n.has(t)) n.delete(t); else n.add(t); return n; });

  const results = data?.results ?? [];
  const stamp = fmtDateTime(data?.updatedAt ?? null);

  return (
    <div
      onPointerDown={raise}
      style={isStatic ? undefined : style}
      className={cn(
        "fade-in flex flex-col overflow-hidden rounded-[20px] border border-white/[0.06] bg-[#0e0e0e] font-sans tracking-[-0.01em] shadow-[0_24px_70px_rgba(0,0,0,0.55)]",
        isStatic ? "relative w-full" : "absolute",
      )}
    >
      {/* header — drag handle */}
      <div {...dragHandle} className="flex shrink-0 cursor-move touch-none select-none items-baseline justify-between gap-3 px-5 pt-4 pb-3">
        <h2 className="text-[16px] font-semibold text-white">Daily Briefing</h2>
      </div>

      {/* body — scrolls within a fixed height on desktop; grows to fit on the phone stack */}
      <div className={cn("no-scrollbar px-5", isStatic ? "pb-4" : "min-h-0 flex-1 overflow-y-auto pb-2")}>
        {loading && !data && <p className="mt-10 animate-pulse text-center text-[13px] text-[#8a8a8a]">Loading briefing…</p>}
        {err && !results.length && <p className="mt-10 text-center text-[13px] text-rose-400">{err}</p>}
        {data && !results.length && !loading && !err && (
          <p className="mt-10 text-center text-[12px] text-[#666]">Your briefing runs each morning — check back soon.</p>
        )}

        {/* dated portfolio-state overview — shown in full, justified, never truncated */}
        {data?.memo && (
          <div className="mb-1 w-full border-b border-white/[0.06] pb-3 pt-0.5">
            {stamp && <p className="text-[9px] uppercase tracking-wider text-[#8a8a8a]">{stamp}</p>}
            <p className="mt-1 text-justify text-[12.5px] leading-snug text-white/90">{renderLinked(stripCitations(data.memo))}</p>
          </div>
        )}

        {/* per-holding glance rows → tap to expand */}
        {results.map((r) => {
          const open = openRows.has(r.ticker);
          let sig: Record<string, string> = {};
          try { const p = JSON.parse(r.signals || "{}"); if (p && typeof p === "object") sig = p as Record<string, string>; } catch {}
          return (
            <div key={r.ticker} className="border-b border-white/[0.06] last:border-b-0">
              <button onClick={() => toggle(r.ticker)} className="flex w-full items-start gap-2.5 py-3 text-left">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-semibold text-white">{r.ticker}</span>
                    <span className={cn("text-[11px] font-medium", VERDICT_STYLE[r.verdict] || VERDICT_STYLE.watch)}>{VERDICT_LABEL[r.verdict] || "Watch"}</span>
                    {r.risk != null && (
                      <span className="text-[10px] tabular-nums text-[#6b6b6b]">
                        · Risk <span className={cn("font-medium", riskColor(r.risk))}>{r.risk}</span>
                      </span>
                    )}
                  </div>
                  <p className={cn("mt-0.5 text-[11.5px] leading-snug text-white/70", !open && "line-clamp-2")}>
                    {open ? renderLinked(stripCitations(r.rationale)) : plain(stripCitations(r.rationale))}
                  </p>
                </div>
                <span className="mt-0.5 shrink-0 text-[13px] leading-none text-[#6b6b6b]">{open ? "−" : "+"}</span>
              </button>
              {open && Object.keys(sig).length > 0 && (
                <div className="space-y-1 pb-3">
                  {Object.entries(sig).map(([k, v]) => (
                    <div key={k} className="flex gap-2 text-[11px] leading-snug">
                      <span className="w-[70px] shrink-0 text-[#8a8a8a]">{SIGNAL_LABEL[k] || k}</span>
                      <span className="min-w-0 flex-1 text-white/75">{renderLinked(String(v))}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* resize handle (hidden on the phone stack via .static-card CSS) */}
      <div {...resizeHandle} className="absolute bottom-0 right-0 z-20 flex h-7 w-7 cursor-nwse-resize touch-none items-end justify-end p-1.5 text-white/40 transition-colors hover:text-white/80" title="Drag to resize">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M11 4L4 11M11 8L8 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
