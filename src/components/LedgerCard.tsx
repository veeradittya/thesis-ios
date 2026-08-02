"use client";

import { useRef, useState } from "react";
import type { ParsedPortfolio, ParsedHolding } from "@/lib/parsePortfolio";
import { normalizeLedger, makeHolding } from "@/lib/parsePortfolio";
import { useMovableCard } from "@/components/ui/useMovableCard";

// Movable + resizable dark-fintech ledger card. Drag by the header; resize from the
// bottom-right handle. Position/size persist to localStorage (see useMovableCard).
// When `editable` (authenticated client), the card can add/edit/remove holdings; edits
// commit to the parent via `onChange` (on blur / add / remove / pick) so the whole
// dashboard — markets card, live prices, chat context — updates from the same ledger.
// Typing a ticker or name shows a symbol-search dropdown; picking fills both fields.

function fmtUSD(v: number | null): string {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${Math.round(v).toLocaleString("en-US")}`;
  return `$${v.toFixed(2)}`;
}
function monogram(s: string): string {
  const t = s.replace(/[^A-Za-z0-9]/g, "");
  return (t.slice(0, 2) || "?").toUpperCase();
}

// Draft rows keep raw input strings so partial numbers ("12.") type cleanly. Weight (a percent) is the
// only per-holding number now — shares/price are gone from the editor.
interface DraftRow { ticker: string; name: string; weight: string; thesis: string }
const numOrNull = (s: string): number | null => {
  const t = s.replace(/[,$\s]/g, "");
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
};
const toDraft = (h: ParsedHolding): DraftRow => ({
  ticker: h.ticker,
  name: h.name === h.ticker ? "" : h.name,
  weight: h.weight != null ? String(+(h.weight * 100).toFixed(2)) : "", // fraction → percent
  thesis: h.thesis || "",
});
function rebuild(base: ParsedPortfolio, rows: DraftRow[]): ParsedPortfolio {
  const holdings = rows
    .filter((r) => r.ticker.trim() || r.name.trim())
    .map((r) => makeHolding(r.ticker, r.name, numOrNull(r.weight), r.thesis));
  const { totalValue } = normalizeLedger(holdings);
  return { ...base, holdings, totalValue, rowCount: holdings.length };
}

interface Sym { symbol: string; description: string }
interface Suggest { i: number; anchor: { left: number; top: number; width: number }; results: Sym[] }

export function LedgerCard({
  data,
  editable = false,
  onChange,
  x = 40,
  y = 110,
  width = 460,
  height = 470,
}: {
  data: ParsedPortfolio;
  editable?: boolean;
  onChange?: (next: ParsedPortfolio) => void;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}) {
  const { style, dragHandle, resizeHandle, raise } = useMovableCard("ledger", { x, y, w: width, h: height }, { minW: 320, minH: 220 });

  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [nameDraft, setNameDraft] = useState("");
  const [sug, setSug] = useState<Suggest | null>(null);
  const symTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startEdit = () => {
    setRows(data.holdings.map(toDraft));
    setNameDraft(data.portfolioName);
    setEditing(true);
  };
  const commit = (nextRows: DraftRow[], name = nameDraft) => onChange?.({ ...rebuild(data, nextRows), portfolioName: name.trim() || "My Portfolio" });
  const setRow = (i: number, patch: Partial<DraftRow>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, { ticker: "", name: "", weight: "", thesis: "" }]);
  const removeRow = (i: number) => { const next = rows.filter((_, j) => j !== i); setRows(next); commit(next); };
  const noop = (e: React.PointerEvent) => e.stopPropagation(); // keep header controls from starting a drag

  // Symbol-search typeahead (Finnhub via /api/symbol-search) — fired from either field.
  const querySym = (i: number, value: string, el: HTMLInputElement) => {
    const q = value.trim();
    if (symTimer.current) clearTimeout(symTimer.current);
    if (q.length < 2) { setSug(null); return; }
    const r = el.getBoundingClientRect();
    const anchor = { left: r.left, top: r.bottom + 4, width: r.width };
    symTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/symbol-search?q=${encodeURIComponent(q)}`);
        const j = await res.json();
        const results: Sym[] = Array.isArray(j.results) ? j.results.slice(0, 6) : [];
        setSug(results.length ? { i, anchor, results } : null);
      } catch { setSug(null); }
    }, 220);
  };
  const pickSym = (i: number, s: Sym) => {
    const next = rows.map((r, j) => (j === i ? { ...r, ticker: s.symbol, name: s.description } : r));
    setRows(next);
    commit(next);
    setSug(null);
  };

  const isEmpty = data.holdings.length === 0;

  return (
    <div
      onPointerDown={raise}
      style={style}
      className="fade-in absolute flex flex-col overflow-hidden rounded-[20px] border border-white/[0.06] bg-[#0e0e0e] font-sans tracking-[-0.01em] shadow-[0_24px_70px_rgba(0,0,0,0.55)]"
    >
      {/* header — drag handle */}
      <div {...dragHandle} className="flex shrink-0 cursor-move touch-none select-none items-start justify-between gap-4 px-5 pt-5 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold text-white">Ledger</h2>
          {editing && (
            <input
              value={nameDraft}
              onPointerDown={noop}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => commit(rows)}
              className="mt-1 w-full rounded-md bg-white/[0.05] px-2 py-1 text-[15px] font-semibold text-white outline-none ring-1 ring-white/10 focus:ring-white/25"
              placeholder="Portfolio name"
            />
          )}
        </div>
        <div className="flex shrink-0 items-start gap-3">
          {editable && (
            <button
              onPointerDown={noop}
              onClick={() => { if (editing) { commit(rows); setEditing(false); setSug(null); } else startEdit(); }}
              className="rounded-full border border-white/10 px-3 py-1 text-[11px] font-medium text-white/85 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              {editing ? "Done" : "Edit"}
            </button>
          )}
          {data.totalValue != null && !editing && (
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider text-[#8a8a8a]">Total value</p>
              <p className="mt-1 text-[24px] font-semibold leading-none tracking-[-0.02em] text-white">{fmtUSD(data.totalValue)}</p>
            </div>
          )}
        </div>
      </div>

      {/* body */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {editing ? (
          <>
            {rows.map((r, i) => (
              <div key={i} className="border-t border-white/[0.06] py-2.5 first:border-t-0">
                {/* line 1 — ticker + name (both typeahead) + remove */}
                <div className="flex items-center gap-1.5">
                  <input
                    value={r.ticker}
                    onChange={(e) => { setRow(i, { ticker: e.target.value.toUpperCase() }); querySym(i, e.target.value, e.target); }}
                    onKeyDown={(e) => e.key === "Escape" && setSug(null)}
                    onBlur={() => commit(rows)}
                    placeholder="TICKER"
                    className="w-[76px] shrink-0 rounded-md bg-white/[0.04] px-2 py-1.5 text-[12px] font-medium uppercase text-white/90 outline-none ring-1 ring-white/10 placeholder:text-[#5a5a5a] focus:ring-white/25"
                  />
                  <input
                    value={r.name}
                    onChange={(e) => { setRow(i, { name: e.target.value }); querySym(i, e.target.value, e.target); }}
                    onKeyDown={(e) => e.key === "Escape" && setSug(null)}
                    onBlur={() => commit(rows)}
                    placeholder="Company name"
                    className="min-w-0 flex-1 rounded-md bg-white/[0.04] px-2 py-1.5 text-[12px] text-white/90 outline-none ring-1 ring-white/10 placeholder:text-[#5a5a5a] focus:ring-white/25"
                  />
                  <button onClick={() => removeRow(i)} title="Remove" className="shrink-0 rounded-md p-1 text-[#8a8a8a] transition-colors hover:bg-white/[0.06] hover:text-rose-300">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                </div>
                {/* line 2 — weight (percent of the portfolio) */}
                <div className="mt-1.5 flex items-center gap-1.5">
                  <div className="relative min-w-0 flex-1">
                    <input
                      value={r.weight}
                      onChange={(e) => setRow(i, { weight: e.target.value })}
                      onBlur={() => commit(rows)}
                      inputMode="decimal"
                      placeholder="Weight"
                      className="w-full rounded-md bg-white/[0.04] px-2 py-1 pr-7 text-[11.5px] tabular-nums text-white/85 outline-none ring-1 ring-white/10 placeholder:text-[#5a5a5a] focus:ring-white/25"
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11.5px] text-white/40">%</span>
                  </div>
                  <span className="w-[21px] shrink-0" aria-hidden />
                </div>
                {/* line 3 — optional thesis / reason-for-holding (drives the Thesis Monitor) */}
                <textarea
                  value={r.thesis}
                  onPointerDown={noop}
                  onChange={(e) => setRow(i, { thesis: e.target.value })}
                  onBlur={() => commit(rows)}
                  rows={2}
                  placeholder="Why you hold it (optional) — tracked by the Thesis Monitor"
                  className="no-scrollbar mt-1.5 w-full resize-none rounded-md bg-white/[0.04] px-2 py-1.5 text-[11.5px] leading-snug text-white/85 outline-none ring-1 ring-white/10 placeholder:text-[#5a5a5a] focus:ring-white/25"
                />
              </div>
            ))}
            <button onClick={addRow} className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/15 py-2 text-[12px] text-[#9a9a9a] transition-colors hover:border-white/30 hover:text-white">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              Add holding
            </button>
          </>
        ) : isEmpty ? (
          <div className="mt-8 flex flex-col items-center gap-3 px-4 text-center">
            <p className="text-[13px] text-white/80">No holdings yet.</p>
            {editable ? (
              <button onClick={startEdit} className="rounded-full bg-white px-4 py-1.5 text-[12px] font-medium text-black transition-colors hover:bg-[#e6e6e6]">Add holdings</button>
            ) : (
              <p className="text-[11.5px] text-[#666]">Sign in to build your own portfolio.</p>
            )}
          </div>
        ) : (
          data.holdings.map((h, i) => {
            const sub = h.name && h.name !== h.ticker ? h.name : "";
            const weightStr = h.weight != null ? `${(h.weight * 100).toFixed(1)}%` : "";
            return (
              <div key={`${h.ticker}-${i}`} className="flex items-center gap-3 border-t border-white/[0.06] py-2.5 first:border-t-0">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-[#1a1a1a] text-[10px] font-medium text-[#cdcdcd]">
                  {monogram(h.ticker)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-white">{h.ticker}</p>
                  {sub && <p className="truncate text-[11.5px] text-[#8a8a8a]">{sub}</p>}
                </div>
                <div className="shrink-0 text-right">
                  {/* valued ledgers (xlsx) show $ with weight beneath; weight-only ledgers show weight as the headline */}
                  {h.value != null && <p className="text-[13px] tabular-nums text-white">{fmtUSD(h.value)}</p>}
                  {weightStr && (
                    <p className={h.value != null ? "text-[11px] tabular-nums text-[#8a8a8a]" : "text-[14px] tabular-nums text-white"}>{weightStr}</p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* symbol-search dropdown — fixed so the card's overflow doesn't clip it */}
      {editing && sug && sug.results.length > 0 && (
        <div
          className="no-scrollbar fixed z-[80] max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-[#141414]/97 py-1 shadow-[0_18px_50px_rgba(0,0,0,0.65)] backdrop-blur"
          style={{ left: sug.anchor.left, top: sug.anchor.top, width: Math.max(sug.anchor.width, 248) }}
        >
          {sug.results.map((s) => (
            <button
              key={s.symbol}
              onMouseDown={(e) => { e.preventDefault(); pickSym(sug.i, s); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-white/[0.07]"
            >
              <span className="w-14 shrink-0 text-[11px] font-semibold text-white">{s.symbol}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-[#9a9a9a]">{s.description}</span>
            </button>
          ))}
        </div>
      )}

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
