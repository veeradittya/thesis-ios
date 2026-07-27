"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { cn } from "@/lib/utils";
import type { ParsedPortfolio, ParsedHolding } from "@/lib/parsePortfolio";
import { normalizeLedger, makeHolding } from "@/lib/parsePortfolio";
import { readQuoteCache, writeQuoteCache } from "@/lib/priceCache";
import { useOutsideClick } from "@/hooks/use-outside-click";
import { BorderBeam } from "border-beam";

// Mobile Portfolio page ledger — holdings sit directly on the black background (no card shell).
// • Tap a holding to expand it with the Aceternity Expandable-Card reactivity: the row morphs
//   (shared-layout `layoutId`) into a centered modal, with the ticker + weight morphing individually
//   and the edit form fading in. Closes on the ✕, on Escape, or on a click outside (useOutsideClick).
// • Swipe a holding left to reveal Remove, or right to reveal Edit (opens the editor) — Apple-Music style.
// Edits commit to the parent ledger via onChange, so the rest of the dashboard + the daily-briefing
// agent read the same holdings. (Desktop keeps the movable LedgerCard.)

const fmtUSD = (v: number | null): string => {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${Math.round(v).toLocaleString("en-US")}`;
  return `$${v.toFixed(2)}`;
};
const numOrNull = (s: string): number | null => {
  const t = s.replace(/[,$\s]/g, "");
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
};
// Live-quote formatting — matches the Live Prices card.
const fmtPrice = (v: number | null) => (v == null ? "—" : v.toFixed(2));
const fmtPct = (v: number | null) => (v == null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
interface Quote { price: number | null; percent: number | null; flashDir: "up" | "down" | null; flashTs: number }

// Draft rows keep raw input strings so partial numbers ("12.") type cleanly.
interface DraftRow { ticker: string; name: string; shares: string; price: string; thesis: string }
const toDraft = (h: ParsedHolding): DraftRow => ({
  ticker: h.ticker,
  name: h.name === h.ticker ? "" : h.name,
  shares: h.shares != null ? String(h.shares) : "",
  price: h.price != null ? String(h.price) : "",
  thesis: h.thesis || "",
});
function rebuild(base: ParsedPortfolio, rows: DraftRow[]): ParsedPortfolio {
  const holdings = rows
    .filter((r) => r.ticker.trim() || r.name.trim())
    .map((r) => makeHolding(r.ticker, r.name, numOrNull(r.shares), numOrNull(r.price), r.thesis));
  const { totalValue } = normalizeLedger(holdings);
  return { ...base, holdings, totalValue, rowCount: holdings.length };
}

interface Sym { symbol: string; description: string }
interface Sugg { symbol: string; name: string; sector: string }

const SearchGlyph = ({ className }: { className?: string }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className}>
    <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
  </svg>
);
const RefreshGlyph = ({ className }: { className?: string }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);
// Shared spring for the search magnifier ⇄ bar morph — smooth, minimal overshoot.
const SEARCH_MORPH = { type: "spring", stiffness: 420, damping: 40 } as const;
// Row → card expand: a firm spring with high damping so the box settles fast and clean (no wobble),
// which keeps the non-uniform scale phase short — the window where text could look distorted.
const CARD_MORPH = { type: "spring", stiffness: 520, damping: 46 } as const;

export function PortfolioLedger({ data, onChange, refreshSignal, onRefreshed }: { data: ParsedPortfolio; onChange?: (next: ParsedPortfolio) => void; refreshSignal?: number; onRefreshed?: () => void }) {
  const id = useId(); // scopes the shared layoutIds to this instance (Aceternity pattern)
  const [rows, setRows] = useState<DraftRow[]>(() => data.holdings.map(toDraft));
  const [expanded, setExpanded] = useState<number | null>(null);

  // Re-seed from the parent when the ledger changes externally (initial load, sign-in swap) — but
  // never while a holding is open for editing (that would clobber in-progress input).
  const sig = data.holdings.map((h) => `${h.ticker}:${h.shares}:${h.price}:${h.thesis || ""}`).join("|");
  useEffect(() => {
    if (expanded == null) setRows(data.holdings.map(toDraft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const commit = (next: DraftRow[]) => onChange?.(rebuild(data, next));
  const setRow = (i: number, patch: Partial<DraftRow>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => { const next = rows.filter((_, j) => j !== i); setExpanded(null); setRows(next); commit(next); };
  // Append a holding by ticker/name (from the search box or a suggestion); skip blanks + duplicates.
  const addHolding = (ticker: string, name: string) => {
    const t = ticker.trim().toUpperCase();
    if (!t || rows.some((r) => r.ticker.trim().toUpperCase() === t)) return;
    const next = [...rows, { ticker: t, name: name && name.toUpperCase() !== t ? name : "", shares: "", price: "", thesis: "" }];
    setRows(next);
    commit(next);
  };

  // Live value/weight from the drafts, so the editor stays consistent while typing.
  const vals = rows.map((r) => { const s = numOrNull(r.shares), p = numOrNull(r.price); return s != null && p != null ? s * p : null; });
  const total = vals.some((v) => v != null) ? vals.reduce<number>((a, v) => a + (v || 0), 0) : null;
  const weightPct = (i: number) => (total && vals[i] != null ? (vals[i]! / total) * 100 : null);

  // Live prices for each holding. No interval polling — we fetch once on load (seeded instantly from
  // the local cache) and again on pull-to-refresh (refreshSignal bumps). When a fetch brings a NEW
  // price, the number swaps in and flashes green/up or red/down; the OLD price stays until then.
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const onRefreshedRef = useRef(onRefreshed); // latest completion callback (kept out of effect deps)
  onRefreshedRef.current = onRefreshed;
  const symbols = rows.map((r) => r.ticker.trim().toUpperCase()).filter(Boolean).join(",");
  useEffect(() => {
    if (!symbols) { setQuotes({}); return; }
    const active = symbols.split(",");
    const activeSet = new Set(active);
    // Seed from cache immediately (drop tickers no longer held), so prices show before the fetch.
    const cached = readQuoteCache(active);
    setQuotes((prev) => {
      const next: Record<string, Quote> = {};
      for (const [s, q] of Object.entries(prev)) if (activeSet.has(s)) next[s] = q;
      for (const [s, c] of Object.entries(cached)) if (!next[s]) next[s] = { price: c.price, percent: c.percent, flashDir: null, flashTs: 0 };
      return next;
    });
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/quote?symbols=${encodeURIComponent(symbols)}`);
        const j = await r.json();
        const q = (j.quotes || {}) as Record<string, { price: number | null; percent: number | null }>;
        if (cancelled) return;
        const now = Date.now();
        setQuotes((prev) => {
          const next = { ...prev };
          for (const [sym, v] of Object.entries(q)) {
            const prevPrice = prev[sym]?.price ?? null;
            let dir = prev[sym]?.flashDir ?? null;
            let flashTs = prev[sym]?.flashTs ?? 0;
            if (prevPrice != null && v.price != null && v.price !== prevPrice) { dir = v.price > prevPrice ? "up" : "down"; flashTs = now; }
            next[sym] = { price: v.price, percent: v.percent, flashDir: dir, flashTs };
          }
          return next;
        });
        writeQuoteCache(q);
      } catch {
        /* keep the old prices on a failed fetch */
      } finally {
        if (!cancelled) onRefreshedRef.current?.(); // let pull-to-refresh spring back once loaded
      }
    })();
    return () => { cancelled = true; };
  }, [symbols, refreshSignal]);
  // Fade the flash ~600ms after a price change.
  useEffect(() => {
    const iv = setInterval(() => {
      setQuotes((prev) => {
        const now = Date.now(); let changed = false; const next = { ...prev };
        for (const k in next) if (next[k].flashDir && now - next[k].flashTs > 600) { next[k] = { ...next[k], flashDir: null }; changed = true; }
        return changed ? next : prev;
      });
    }, 250);
    return () => clearInterval(iv);
  }, []);

  // Search-to-add (Finnhub symbol search) — debounced typeahead below the gooey search box.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Sym[]>([]);
  const [searchOpen, setSearchOpen] = useState(false); // gooey box expanded → fade the heading behind it
  const [dissolving, setDissolving] = useState<string | null>(null); // old query dissolving on a clear
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = (v: string) => {
    setQuery(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = v.trim();
    if (q.length < 2) { setResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      try { const r = await fetch(`/api/symbol-search?q=${encodeURIComponent(q)}`); const j = await r.json(); setResults(Array.isArray(j.results) ? j.results : []); }
      catch { setResults([]); }
    }, 220);
  };
  const pickSearch = (s: Sym) => { addHolding(s.symbol, s.description); setQuery(""); setResults([]); };

  // Portfolio-aware suggestions (Spotify-style): /api/recommend looks at the current holdings and
  // suggests peers from a covered universe. Seeded instantly from a local cache (so repeat visits
  // never show a blank/skeleton), then refreshed. Re-fetches whenever the holdings change.
  const [suggestions, setSuggestions] = useState<Sugg[]>([]);
  const [suggLoaded, setSuggLoaded] = useState(false); // false + empty → show the skeleton
  const [suggPage, setSuggPage] = useState(0); // refresh button cycles the suggestion pool
  useEffect(() => {
    const cacheKey = `${symbols}|${suggPage}`;
    try {
      const raw = localStorage.getItem("thesis.suggestions.v1");
      if (raw) { const c = JSON.parse(raw); if (c.k === cacheKey && Array.isArray(c.s)) { setSuggestions(c.s); setSuggLoaded(true); } }
    } catch {}
    let cancelled = false;
    fetch(`/api/recommend?picks=${encodeURIComponent(symbols)}&page=${suggPage}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const s = (Array.isArray(j.suggestions) ? j.suggestions : []) as Sugg[];
        setSuggestions(s);
        setSuggLoaded(true);
        try { localStorage.setItem("thesis.suggestions.v1", JSON.stringify({ k: cacheKey, s })); } catch {}
      })
      .catch(() => { if (!cancelled) setSuggLoaded(true); });
    return () => { cancelled = true; };
  }, [symbols, suggPage]);

  return (
    <div className="pt-2 pb-10">
      {/* holdings — a rounded card wrapped by an animated BorderBeam on its outline. Rows are
          swipe-to-remove / tap-to-expand, overflow-hidden so the swipe reveal clips to the corners. */}
      <BorderBeam size="md" colorVariant="sunset" strength={0.83}>
      <div className="overflow-hidden rounded-2xl border border-white/[0.09]">
      <p className="px-4 pb-1.5 pt-4 text-[12px] uppercase tracking-wider text-white">Your Holdings</p>
      <ul className="flex flex-col">
        {rows.map((r, i) => {
          const q = quotes[r.ticker.trim().toUpperCase()];
          const up = (q?.percent ?? 0) >= 0;
          const flash = q?.flashDir;
          return (
            // Key by ticker (not index) so removing a swiped row doesn't leave its neighbour open.
            <SwipeRow key={r.ticker || `row-${i}`} onRemove={() => removeRow(i)} onOpen={() => setExpanded(i)}>
              {/* Only the card container carries a layoutId — nested layout children fight the row's
                  horizontal drag (swipe), so the contents are plain and morph with the card. */}
              <motion.div layoutId={`card-${i}-${id}`} className="flex w-full items-center justify-between gap-3 py-1">
                <div className="min-w-0">
                  <p className="text-[16px] font-medium leading-tight text-white">{r.ticker || "New holding"}</p>
                  {r.name && <p className="truncate text-[13px] leading-tight text-[#8a8a8a]">{r.name}</p>}
                </div>
                <div className="shrink-0 text-right">
                  <p className={cn(
                    "rounded px-1 text-[16px] leading-tight tabular-nums text-white transition-colors duration-300",
                    flash === "up" ? "bg-emerald-500/25" : flash === "down" ? "bg-rose-500/25" : "bg-transparent",
                  )}>
                    {fmtPrice(q?.price ?? null)}
                  </p>
                  <p className={cn("text-[13px] leading-tight tabular-nums", q?.percent == null ? "text-[#8a8a8a]" : up ? "text-emerald-400" : "text-rose-400")}>
                    {fmtPct(q?.percent ?? null)}
                  </p>
                </div>
              </motion.div>
            </SwipeRow>
          );
        })}
      </ul>
      </div>
      </BorderBeam>

      {/* add assets — one divider, then a heading with a magnifier at the right that morphs (shared
          layoutId) into a full-width search bar right under the heading, plus the suggestions. */}
      {symbols.length > 0 && (
        <div className="mt-3 px-1 pt-4">
          <div className="flex h-8 items-center justify-between">
            <p className="text-[12px] uppercase tracking-wider text-white">Suggested for you</p>
            <div className="flex items-center gap-2.5">
              {/* refresh — cycles to a new page of portfolio-aware suggestions */}
              <button
                onClick={() => setSuggPage((p) => p + 1)}
                aria-label="Refresh suggestions"
                className="grid size-8 shrink-0 place-items-center rounded-full bg-black text-white/70 ring-1 ring-white/15 transition-colors hover:text-white"
              >
                <motion.span animate={{ rotate: suggPage * 360 }} transition={{ duration: 0.5, ease: "easeOut" }} className="grid place-items-center">
                  <RefreshGlyph />
                </motion.span>
              </button>
              {!searchOpen && (
                <motion.button
                  layoutId="assetSearch"
                  transition={SEARCH_MORPH}
                  onClick={() => setSearchOpen(true)}
                  aria-label="Search assets"
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-black text-white/80 ring-1 ring-white/15 transition-colors hover:text-white"
                >
                  <motion.span layoutId="assetSearchIcon" transition={SEARCH_MORPH} className="shrink-0">
                    <SearchGlyph />
                  </motion.span>
                </motion.button>
              )}
            </div>
          </div>

          {searchOpen && (
            <div className="relative mt-2">
              <BorderBeam size="pulse-inner" colorVariant="ocean" strength={0.83}>
              <motion.div layoutId="assetSearch" transition={SEARCH_MORPH} className="relative flex h-10 items-center gap-2.5 overflow-hidden rounded-full bg-black px-4 ring-1 ring-white/15">
                <motion.span layoutId="assetSearchIcon" transition={SEARCH_MORPH} className="shrink-0 text-white/55">
                  <SearchGlyph />
                </motion.span>
                <input
                  ref={searchInputRef}
                  autoFocus
                  value={query}
                  onChange={(e) => onSearch(e.target.value)}
                  onBlur={() => { if (!query.trim() && !dissolving) setSearchOpen(false); }}
                  placeholder="Search assets…"
                  className="min-w-0 flex-1 bg-transparent text-[15px] text-white outline-none placeholder:text-white/40"
                />
                {/* Clear-with-dissolve (adapted from the Transitions.dev clear effect): on a clear the
                    old query sinks + blurs + fades while a soft glow streak pulses under it. */}
                {dissolving && (
                  <>
                    <motion.div
                      key={`glow-${dissolving}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: [0, 0.6, 0] }}
                      transition={{ duration: 0.5, times: [0, 0.15, 1], ease: "easeOut" }}
                      className="pointer-events-none absolute inset-y-0 left-[42px] right-9 my-auto h-2.5 rounded-full [background:radial-gradient(ellipse_at_center,rgba(255,255,255,0.55),transparent_72%)] [mix-blend-mode:screen]"
                    />
                    <motion.span
                      key={`mirror-${dissolving}`}
                      initial={{ y: 0, opacity: 1, filter: "blur(0px)" }}
                      animate={{ y: 12, opacity: 0, filter: "blur(2px)" }}
                      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                      onAnimationComplete={() => setDissolving(null)}
                      className="pointer-events-none absolute left-[42px] top-0 flex h-full items-center whitespace-nowrap text-[15px] text-white"
                    >
                      {dissolving}
                    </motion.span>
                  </>
                )}
                <button
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (query.trim()) { setDissolving(query); onSearch(""); searchInputRef.current?.focus({ preventScroll: true }); }
                    else { setSearchOpen(false); }
                  }}
                  aria-label={query.trim() ? "Clear search" : "Close search"}
                  className="relative z-10 shrink-0 text-white/45 transition-colors hover:text-white"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </motion.div>
              </BorderBeam>
              {results.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-2xl border border-white/10 bg-[#161616] shadow-[0_18px_50px_rgba(0,0,0,0.6)]">
                  {results.map((s) => (
                    <button key={s.symbol} onMouseDown={(e) => { e.preventDefault(); pickSearch(s); }} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.06]">
                      <span className="w-16 shrink-0 text-[14px] font-semibold text-white">{s.symbol}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[#9a9a9a]">{s.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <ul className="mt-1.5 flex flex-col">
            {suggestions.length === 0 && !suggLoaded
              ? // Skeleton while the first suggestions load — so the area never looks empty.
                Array.from({ length: 5 }).map((_, i) => (
                  <li key={`sk-${i}`} className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-1 py-1.5 last:border-b-0">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="h-3.5 w-16 animate-pulse rounded bg-white/[0.08]" />
                      <div className="h-3 w-40 max-w-[70%] animate-pulse rounded bg-white/[0.05]" />
                    </div>
                    <div className="h-7 w-14 shrink-0 animate-pulse rounded-full bg-white/[0.06]" />
                  </li>
                ))
              : suggestions.map((s) => (
                  <li key={s.symbol}>
                    <div onClick={() => addHolding(s.symbol, s.name)} role="button" tabIndex={0} className="group flex w-full cursor-pointer items-center justify-between gap-3 border-b border-white/[0.06] px-1 py-1.5 text-left transition-colors last:border-b-0 hover:bg-white/[0.02]">
                      <div className="min-w-0">
                        <p className="text-[16px] font-medium leading-tight text-white">{s.symbol}</p>
                        <p className="truncate text-[13px] leading-tight text-[#8a8a8a]">{s.name} · {s.sector}</p>
                      </div>
                      {/* BorderBeam on the Add pill outline — the same sunset beam as the holdings card (sm preset, tuned for small elements) */}
                      <BorderBeam size="sm" colorVariant="sunset" strength={0.83} className="shrink-0">
                        <span className="block rounded-full border border-white/10 bg-black px-3.5 py-1 text-[13px] font-medium text-white">Add</span>
                      </BorderBeam>
                    </div>
                  </li>
                ))}
          </ul>
        </div>
      )}

      {/* expanded editor — the Aceternity expandable-card modal */}
      <AnimatePresence>
        {expanded != null && rows[expanded] && (
          <ExpandedEditor
            key="editor"
            index={expanded}
            uid={id}
            row={rows[expanded]}
            weightPct={weightPct(expanded)}
            value={vals[expanded]}
            onField={(patch) => setRow(expanded, patch)}
            onCommit={() => commit(rows)}
            onRemove={() => removeRow(expanded)}
            onClose={() => { commit(rows); setExpanded(null); }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// A single holding row: right-swipe reveals Edit (opens the editor), left-swipe reveals Remove
// (Apple-Music style). A plain tap opens the editor; a tap while swiped closes the swipe.
function SwipeRow({ children, onRemove, onOpen }: { children: ReactNode; onRemove: () => void; onOpen: () => void }) {
  const OFFSET = 96;
  const x = useMotionValue(0);        // live horizontal position of the row (driven by the drag)
  const [dir, setDir] = useState<-1 | 0 | 1>(0);
  const moved = useRef(false);        // set while a horizontal drag is in progress → the tap must not open

  // The pills react in real time to the drag: fade + scale in as the row slides, so the action
  // "grows" out from under the row and settles when released. Edit ← right-swipe, Remove ← left-swipe.
  const editOpacity = useTransform(x, [10, OFFSET], [0, 1], { clamp: true });
  const editScale = useTransform(x, [0, OFFSET], [0.6, 1], { clamp: true });
  const removeOpacity = useTransform(x, [-OFFSET, -10], [1, 0], { clamp: true });
  const removeScale = useTransform(x, [-OFFSET, 0], [1, 0.6], { clamp: true });

  const snap = (target: number) => {
    setDir(target < 0 ? -1 : target > 0 ? 1 : 0);
    animate(x, target, { type: "spring", stiffness: 500, damping: 42 });
  };

  return (
    <li className="relative">
      {/* Edit pill — left, revealed on a right-swipe */}
      <motion.div style={{ opacity: editOpacity, scale: editScale, willChange: "transform, opacity" }} className="pointer-events-none absolute inset-y-0 left-0 flex origin-left items-center pl-2">
        <button
          onClick={() => { snap(0); onOpen(); }}
          className={`flex h-[calc(100%-10px)] items-center justify-center rounded-full bg-emerald-600 px-5 text-[13px] font-medium text-white ${dir === 1 ? "pointer-events-auto" : "pointer-events-none"}`}
        >
          Edit
        </button>
      </motion.div>
      {/* Remove pill — right, revealed on a left-swipe */}
      <motion.div style={{ opacity: removeOpacity, scale: removeScale, willChange: "transform, opacity" }} className="pointer-events-none absolute inset-y-0 right-0 flex origin-right items-center pr-2">
        <button
          onClick={onRemove}
          className={`flex h-[calc(100%-10px)] items-center justify-center rounded-full bg-rose-600 px-5 text-[13px] font-medium text-white ${dir === -1 ? "pointer-events-auto" : "pointer-events-none"}`}
        >
          Remove
        </button>
      </motion.div>

      <motion.div
        drag="x"
        style={{ x, touchAction: "pan-y", willChange: "transform" }} // GPU transform; vertical scroll passes through
        dragConstraints={{ left: -OFFSET, right: OFFSET }}
        dragElastic={0.06}
        dragMomentum={false} // no post-release coast — snap decides where it lands (cheaper on slow devices)
        onPointerDown={() => { moved.current = false; }}
        onDrag={(_, info) => { if (Math.abs(info.offset.x) > 10) moved.current = true; }}
        onDragEnd={(_, info) => { snap(info.offset.x < -46 ? -OFFSET : info.offset.x > 46 ? OFFSET : 0); }}
        onTap={() => {
          if (moved.current) return;            // a swipe just happened — don't open
          if (dir !== 0) { snap(0); return; }   // a swiped-open row → first tap closes it
          onOpen();
        }}
        className="relative z-10 cursor-pointer bg-black px-4"
      >
        {children}
      </motion.div>
    </li>
  );
}

function ExpandedEditor({
  index, uid, row, weightPct, value, onField, onCommit, onRemove, onClose,
}: {
  index: number;
  uid: string;
  row: DraftRow;
  weightPct: number | null;
  value: number | null;
  onField: (patch: Partial<DraftRow>) => void;
  onCommit: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [sug, setSug] = useState<Sym[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lock the background scroll + close on Escape while open (Aceternity pattern).
  useEffect(() => {
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = ""; document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  useOutsideClick(ref, onClose);

  // Symbol-search typeahead (Finnhub via /api/symbol-search) — fired from ticker or name.
  const querySym = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    const q = v.trim();
    if (q.length < 2) { setSug([]); return; }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/symbol-search?q=${encodeURIComponent(q)}`);
        const j = await res.json();
        setSug(Array.isArray(j.results) ? j.results.slice(0, 6) : []);
      } catch { setSug([]); }
    }, 220);
  };

  const field = "w-full rounded-lg bg-white/[0.04] px-3 py-2 text-[15px] text-white outline-none ring-1 ring-white/10 placeholder:text-[#5a5a5a] focus:ring-white/25";
  const label = "mb-1 block text-[12px] uppercase tracking-wider text-[#8a8a8a]";

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm"
      />
      <div className="fixed inset-0 z-[100] grid place-items-center p-4">
        <motion.div
          layoutId={`card-${index}-${uid}`}
          ref={ref}
          transition={CARD_MORPH}
          style={{ willChange: "transform" }}
          className="relative w-full max-w-[400px] overflow-hidden rounded-[22px] border border-white/[0.08] bg-black shadow-[0_30px_90px_rgba(0,0,0,0.7)]"
        >
          {/* Inner content fades in only AFTER the box has finished morphing, and fades out almost
              instantly on close — so the ticker/name text is never on screen while the box is being
              non-uniformly scaled (which is what makes text look stretched/distorted). */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.16, delay: 0.26 } }}
            exit={{ opacity: 0, transition: { duration: 0.05 } }}
          >
            {/* header */}
            <div className="flex items-center gap-2.5 px-5 pt-5">
              <input
                value={row.ticker}
                onChange={(e) => { onField({ ticker: e.target.value.toUpperCase() }); querySym(e.target.value); }}
                onBlur={onCommit}
                placeholder="TICKER"
                className="min-w-0 flex-1 bg-transparent text-[23px] font-semibold uppercase text-white outline-none placeholder:text-[#5a5a5a]"
              />
              {weightPct != null && (
                <p className="shrink-0 text-[15px] tabular-nums text-white/60">{weightPct.toFixed(1)}%</p>
              )}
              <button
                onClick={onClose}
                aria-label="Close"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white text-black"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>

            {/* form */}
            <div className="px-5 pb-5 pt-3">
            {/* company (typeahead) */}
            <div className="relative">
              <input
                value={row.name}
                onChange={(e) => { onField({ name: e.target.value }); querySym(e.target.value); }}
                onBlur={onCommit}
                placeholder="Company name"
                className={field}
              />
              {sug.length > 0 && (
                <div className="absolute left-0 right-0 top-[46px] z-20 overflow-hidden rounded-lg border border-white/10 bg-[#161616] shadow-[0_18px_50px_rgba(0,0,0,0.6)]">
                  {sug.map((s) => (
                    <button
                      key={s.symbol}
                      onMouseDown={(e) => { e.preventDefault(); onField({ ticker: s.symbol, name: s.description }); setSug([]); onCommit(); }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.07]"
                    >
                      <span className="w-14 shrink-0 text-[13px] font-semibold text-white">{s.symbol}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[#9a9a9a]">{s.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* shares + purchase price (editable) */}
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <label className="block">
                <span className={label}>Shares</span>
                <input value={row.shares} onChange={(e) => onField({ shares: e.target.value })} onBlur={onCommit} inputMode="decimal" placeholder="0" className={`${field} tabular-nums`} />
              </label>
              <label className="block">
                <span className={label}>Purchase price</span>
                <input value={row.price} onChange={(e) => onField({ price: e.target.value })} onBlur={onCommit} inputMode="decimal" placeholder="$0.00" className={`${field} tabular-nums`} />
              </label>
            </div>

            {/* value (auto-computed, read-only) */}
            <div className="mt-2.5 rounded-lg bg-white/[0.02] px-3 py-2">
              <span className={label}>Value</span>
              <span className="block text-[16px] font-medium tabular-nums text-white">{fmtUSD(value)}</span>
            </div>

            {/* thesis */}
            <label className="mt-3 block">
              <span className={label}>Thesis</span>
              <textarea value={row.thesis} onChange={(e) => onField({ thesis: e.target.value })} onBlur={onCommit} rows={3} placeholder="Why you hold it — tracked by the daily briefing" className={`${field} no-scrollbar resize-none leading-snug`} />
            </label>

            {/* actions */}
            <div className="mt-4 flex items-center gap-2.5">
              <button onClick={onRemove} className="rounded-full border border-rose-500/30 px-4 py-2 text-[14px] font-medium text-rose-300 transition-colors hover:bg-rose-500/10">Remove</button>
              <button onClick={onClose} className="ml-auto rounded-full bg-white px-5 py-2 text-[14px] font-medium text-black transition-colors hover:bg-[#e6e6e6]">Done</button>
            </div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </>
  );
}
