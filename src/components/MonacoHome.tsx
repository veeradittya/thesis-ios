"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import { computeHomeLayout, MOBILE_BREAKPOINT, MOBILE_CARD_HEIGHTS } from "@/lib/cardLayout";
import { StaticLayoutContext } from "@/components/ui/useMovableCard";
import { LedgerCard } from "@/components/LedgerCard";
import { ThesisMonitorCard } from "@/components/ThesisMonitorCard";
import { BriefReveal } from "@/components/BriefReveal";
import { PortfolioMarketsCard } from "@/components/PortfolioMarketsCard";
import { MarketDetailCard, type OpenMarket } from "@/components/MarketDetailCard";
import { WhaleCard } from "@/components/WhaleCard";
import { OddpoolChatCard } from "@/components/OddpoolChatCard";
import { MarketHoursCard } from "@/components/MarketHoursCard";
import { NewsAlertCard } from "@/components/NewsAlertCard";
import { ArticleCard } from "@/components/ArticleCard";
import { LivePricesCard } from "@/components/LivePricesCard";
import { ChartCard } from "@/components/ChartCard";
import { MacroSignalsCard, type MacroEvent } from "@/components/MacroSignalsCard";
import { MacroEventCard } from "@/components/MacroEventCard";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { EventDetailCard, type EventStub } from "@/components/EventDetailCard";
import { SearchCard, type SearchMode } from "@/components/SearchCard";
import { SignalSearchCard } from "@/components/SignalSearchCard";
import { demoPortfolio, type ParsedPortfolio } from "@/lib/parsePortfolio";

// Bump when the default seed changes so stale localStorage ledgers don't override the new demo.
const GUEST_LEDGER_KEY = "thesis.guest.ledger.v2";
const acctLedgerKey = (scope: string) => `thesis.${scope}.ledger.v2`;
import type { NewsItem } from "@/lib/guardian";
import type { MarketLite } from "@/lib/oddpool";

// Homepage restyled to Monaco (monaco.com): true-black canvas, Inter with -0.02em
// tracking, near-white text, hairline borders, a white pill CTA. Nav items are ours.

// Scrollable card canvas (cards persist their own position/size to localStorage).
// Default card positions come from computeHomeLayout (responsive masonry); the
// *displayed* canvas grows dynamically to keep CANVAS_MARGIN of free space beyond the
// right/bottom-most card (small screens use a slim margin so phones don't side-scroll).
const CANVAS_H = 1500; // findEmptySpot vertical scan depth (×2)
const CANVAS_W_SCAN = 2000; // findEmptySpot horizontal scan cap
const CANVAS_MARGIN = 400;
const CANVAS_MIN_W = 1600; // SSR-safe fallbacks; real mins come from the viewport
const CANVAS_MIN_H = 1000;

// Map a holding's company name to a clean Guardian search term ("Amazon.com, Inc." → "Amazon").
function cleanCompany(name: string): string {
  return name
    .replace(/[.,].*$/, "")
    .replace(/\b(Corporation|Corp|Incorporated|Inc|Co|Company|Holdings?|Ltd|Limited|PLC|Group|Platforms|Technologies|Technology|The)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// In-flow wrapper for a card in the mobile stack: reserves the card's readable height
// while the card itself (absolute + 100%×100% under StaticLayoutContext) fills it.
function MobileSlot({ h, auto, children }: { h?: number; auto?: boolean; children: React.ReactNode }) {
  // `auto` → no fixed height; the wrapper grows to the (in-flow) card's content (used by the
  // Daily Briefing so all holdings fit without an inner scroll).
  return (
    <div className="static-card relative w-full shrink-0" style={auto ? undefined : { height: h }}>
      {children}
    </div>
  );
}

// One-time migration: Macro Signals + Search used to be right-click spawns positioned at the
// cursor and are now PRE-SEEDED core cards laid out by the packer. Drop any stale per-card box a
// prior session saved for them (thesis.layout.{macro,search}) so they adopt the computed layout.
// Runs once per browser at module load — before any card mounts and restores its saved box.
if (typeof window !== "undefined") {
  try {
    if (!localStorage.getItem("thesis.preseed.v1")) {
      localStorage.removeItem("thesis.layout.macro");
      localStorage.removeItem("thesis.layout.search");
      localStorage.setItem("thesis.preseed.v1", "1");
    }
  } catch {}
}

export function MonacoHome() {
  const [ledger, setLedger] = useState<ParsedPortfolio | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  // Viewport-driven layout — desktop packs cards to fill the viewport height exactly
  // and reflows on every resize (untouched cards follow; dragged/resized ones keep
  // their persisted box). Under MOBILE_BREAKPOINT the canvas is swapped for a native
  // vertical stack (no absolute positioning, no drag).
  const [vp, setVp] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const measure = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const homeL = useMemo(() => computeHomeLayout(vp.w || 1440, vp.h || 900), [vp.w, vp.h]);
  const isMobile = (vp.w || 1440) < MOBILE_BREAKPOINT;

  // Desktop canvas panning: click-drag on empty background scrolls the view (grab
  // cursor). Card interactions are untouched — pan only starts when the pointer goes
  // down on the canvas itself, and every card fully covers its own area.
  const panRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== canvasRef.current) return;
    const main = mainRef.current;
    if (!main) return;
    panRef.current = { x: e.clientX, y: e.clientY, sl: main.scrollLeft, st: main.scrollTop };
    setPanning(true);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  };
  const movePan = (e: React.PointerEvent) => {
    const p = panRef.current;
    const main = mainRef.current;
    if (!p || !main) return;
    main.scrollLeft = p.sl - (e.clientX - p.x);
    main.scrollTop = p.st - (e.clientY - p.y);
  };
  const endPan = (e: React.PointerEvent) => {
    if (!panRef.current) return;
    panRef.current = null;
    setPanning(false);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  };

  // Auth (Google sign-in) + the account dropdown.
  const { data: session, status } = useSession();
  const [acctMenu, setAcctMenu] = useState(false);
  const [mobilePage, setMobilePage] = useState<"brief" | "portfolio">("brief"); // phone-only: which stack to show
  const [navCondensed, setNavCondensed] = useState(false); // phone Brief: nav shrinks on scroll-down
  useEffect(() => setNavCondensed(false), [mobilePage]); // restore the nav when switching pages
  const userId = session?.user?.id ?? null;
  const authed = !!userId; // authenticated client → editable, per-account, persisted ledger
  const scope = authed ? `u.${userId}` : null; // localStorage namespace for this account
  const firstName = (session?.user?.name || "").trim().split(/\s+/)[0] || null; // names the seeded ledger for a signed-in user
  // Shared scope tying the ledger, the scheduled agent, and the Daily Briefing together (demo = one portfolio).
  const MONITOR_USER = "pilot";

  // Ephemeral "coming soon" pill for not-yet-built nav items.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1900);
  };
  const [openMarkets, setOpenMarkets] = useState<Array<OpenMarket & { _x: number; _y: number }>>([]);

  // Find a free spot on the canvas for a new card (so it lands in empty space).
  function findEmptySpot(w: number, h: number): { x: number; y: number } {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 80, y: 140 };
    const cr = canvas.getBoundingClientRect();
    const rects = [...canvas.querySelectorAll<HTMLElement>(".fade-in.absolute")].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height };
    });
    const pad = 16;
    const hit = (x: number, y: number) =>
      rects.some((r) => x < r.x + r.w + pad && x + w + pad > r.x && y < r.y + r.h + pad && y + h + pad > r.y);
    // Scan only within the visible canvas width so spawned cards never land off-screen
    // on narrow viewports; if nothing fits, drop the card below the stacked region.
    const maxX = Math.max(20, Math.min(canvas.clientWidth, CANVAS_W_SCAN) - w - 20);
    for (let y = 20; y + h <= CANVAS_H * 2; y += 40) for (let x = 20; x <= maxX; x += 40) if (!hit(x, y)) return { x, y };
    const maxB = rects.reduce((m, r) => Math.max(m, r.y + r.h), 20);
    return { x: 20, y: maxB + 20 };
  }

  // Keep CANVAS_MARGIN of free canvas beyond the right/bottom-most card at all times.
  // A MutationObserver on the canvas catches cards being added/removed (childList) and
  // moved/resized (their inline style changes), then re-sizes the canvas on the next frame.
  const [canvasSize, setCanvasSize] = useState({ w: CANVAS_MIN_W, h: CANVAS_MIN_H });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const recompute = () => {
      raf = 0;
      const cr = canvas.getBoundingClientRect();
      let maxR = 0, maxB = 0;
      for (const el of Array.from(canvas.children) as HTMLElement[]) {
        if (!el.offsetWidth && !el.offsetHeight) continue;
        const r = el.getBoundingClientRect();
        maxR = Math.max(maxR, r.right - cr.left);
        maxB = Math.max(maxB, r.bottom - cr.top);
      }
      // Canvas is at least the viewport; beyond the stacked region keep a pannable
      // margin (the canvas only exists on desktop — phones render a native stack).
      const vw = mainRef.current?.clientWidth ?? CANVAS_MIN_W;
      const vh = mainRef.current?.clientHeight ?? CANVAS_MIN_H;
      const w = Math.max(vw, Math.round(maxR) + CANVAS_MARGIN);
      const h = Math.max(vh, Math.round(maxB) + CANVAS_MARGIN);
      setCanvasSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h })); // bail if unchanged (no observer loop)
    };
    const schedule = () => { if (!raf) raf = window.setTimeout(recompute, 32); }; // coalesce bursts; setTimeout fires even when rAF is throttled
    const mo = new MutationObserver(schedule);
    mo.observe(canvas, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", schedule); // viewport changes move the min bounds too
    schedule();
    return () => { mo.disconnect(); window.removeEventListener("resize", schedule); if (raf) clearTimeout(raf); };
  }, [ledger, isMobile]); // (re)attach when the canvas mounts (needs `ledger`, desktop only)

  function openMarket(m: MarketLite, ticker: string) {
    setOpenMarkets((prev) => {
      if (prev.some((p) => p.market_id === m.market_id)) return prev;
      const spot = findEmptySpot(460, 540);
      return [...prev, { ...m, ticker, _x: spot.x, _y: spot.y }];
    });
  }
  function closeMarket(id: string) {
    setOpenMarkets((prev) => prev.filter((p) => p.market_id !== id));
  }

  const [openArticles, setOpenArticles] = useState<Array<NewsItem & { _x: number; _y: number }>>([]);
  function openArticle(item: NewsItem) {
    setOpenArticles((prev) => {
      if (prev.some((p) => p.id === item.id)) return prev;
      const spot = findEmptySpot(480, 600);
      return [...prev, { ...item, _x: spot.x, _y: spot.y }];
    });
  }
  function closeArticle(id: string) {
    setOpenArticles((prev) => prev.filter((p) => p.id !== id));
  }

  const [openCharts, setOpenCharts] = useState<Array<{ ticker: string; name: string | null; _x: number; _y: number }>>([]);
  function openChart(asset: { ticker: string; name: string | null }) {
    setOpenCharts((prev) => {
      if (prev.some((p) => p.ticker === asset.ticker)) return prev;
      const spot = findEmptySpot(560, 340);
      return [...prev, { ...asset, _x: spot.x, _y: spot.y }];
    });
  }
  function closeChart(ticker: string) {
    setOpenCharts((prev) => prev.filter((p) => p.ticker !== ticker));
  }

  // Global right-click menu + the cards it can spawn.
  const [menu, setMenu] = useState<{ vx: number; vy: number } | null>(null);
  // Macro Signals is PRE-SEEDED on the dashboard (open by default); closing persists a dismissal.
  const [macroOpen, setMacroOpen] = useState(true);
  function onCanvasContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setMenu({ vx: e.clientX, vy: e.clientY });
  }
  const openMacro = () => setMacroOpen(true); // re-open from the right-click menu
  const closeMacro = () => setMacroOpen(false); // dismissal persisted by the effect below (desktop only)

  // Macro event detail cards (spawned by clicking a row in the Macro Signals card).
  const [openMacroEvents, setOpenMacroEvents] = useState<Array<MacroEvent & { _x: number; _y: number }>>([]);
  function openMacroEvent(ev: MacroEvent) {
    setOpenMacroEvents((prev) => {
      if (prev.some((p) => p.eventKey === ev.eventKey)) return prev;
      const spot = findEmptySpot(460, 560);
      return [...prev, { ...ev, _x: spot.x, _y: spot.y }];
    });
  }
  function closeMacroEvent(key: string) {
    setOpenMacroEvents((prev) => prev.filter((p) => p.eventKey !== key));
  }

  // Prediction-market event detail cards (Search → Events). Validation stub = one real event.
  const [openEvents, setOpenEvents] = useState<Array<EventStub & { _x: number; _y: number }>>([]);
  function openEvent(ev: EventStub) {
    setOpenEvents((prev) => {
      if (prev.some((p) => p.event_id === ev.event_id)) return prev;
      const spot = findEmptySpot(480, 600);
      return [...prev, { ...ev, _x: spot.x, _y: spot.y }];
    });
  }
  function closeEvent(id: string) {
    setOpenEvents((prev) => prev.filter((p) => p.event_id !== id));
  }

  // Prediction-market Search card — PRE-SEEDED on the dashboard (open in "markets" mode by default;
  // closing persists a dismissal). Single instance; Events/Markets modes.
  const [search, setSearch] = useState<{ mode: SearchMode } | null>({ mode: "markets" });
  const openSearch = (mode: SearchMode) => setSearch({ mode }); // (re-)open from the right-click menu
  const closeSearch = () => setSearch(null);

  // Signal-search cards — right-click a headline → "Find Signals". One card per article.
  const [openSignals, setOpenSignals] = useState<Array<NewsItem & { _x: number; _y: number }>>([]);
  function openSignalSearch(item: NewsItem) {
    setOpenSignals((prev) => {
      if (prev.some((p) => p.id === item.id)) return prev;
      const spot = findEmptySpot(440, 500);
      return [...prev, { ...item, _x: spot.x, _y: spot.y }];
    });
  }
  function closeSignal(id: string) {
    setOpenSignals((prev) => prev.filter((p) => p.id !== id));
  }

  // Persist the Search card and the event/market cards it spawns, so they survive reloads
  // until manually closed. (Per-card position/size is already persisted by useMovableCard;
  // here we persist *which* cards are open.) Restore on mount, then write on change — the
  // `hydrated` gate stops the initial empty state from clobbering the saved cards.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const m = JSON.parse(localStorage.getItem("thesis.markets.open") || "[]");
      if (Array.isArray(m) && m.length) setOpenMarkets(m);
      const e = JSON.parse(localStorage.getItem("thesis.events.open") || "[]");
      if (Array.isArray(e) && e.length) setOpenEvents(e);
      const macroV = localStorage.getItem("thesis.macro.open");
      if (macroV === "0") setMacroOpen(false); // pre-seeded, but the user dismissed it
      const s = localStorage.getItem("thesis.search.open");
      if (s === "closed") setSearch(null); // pre-seeded, but the user dismissed it
      else if (s === "events" || s === "markets") setSearch({ mode: s });
      const g = JSON.parse(localStorage.getItem("thesis.signals.open") || "[]");
      if (Array.isArray(g) && g.length) setOpenSignals(g);
    } catch {}
    setHydrated(true);
  }, []);
  // Phones don't persist anything (per user): the stack is a fixed, read-through view —
  // it still RESTORES desktop-opened cards, but never writes back.
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  useEffect(() => { if (hydrated && !isMobileRef.current) try { localStorage.setItem("thesis.markets.open", JSON.stringify(openMarkets)); } catch {} }, [openMarkets, hydrated]);
  useEffect(() => { if (hydrated && !isMobileRef.current) try { localStorage.setItem("thesis.events.open", JSON.stringify(openEvents)); } catch {} }, [openEvents, hydrated]);
  useEffect(() => { if (hydrated && !isMobileRef.current) try { localStorage.setItem("thesis.signals.open", JSON.stringify(openSignals)); } catch {} }, [openSignals, hydrated]);
  useEffect(() => { if (hydrated && !isMobileRef.current) try { localStorage.setItem("thesis.macro.open", macroOpen ? "1" : "0"); } catch {} }, [macroOpen, hydrated]);
  useEffect(() => { if (hydrated && !isMobileRef.current) try { localStorage.setItem("thesis.search.open", search ? search.mode : "closed"); } catch {} }, [search, hydrated]);

  const menuItems: MenuItem[] = [
    {
      label: "Prediction Markets",
      children: [
        { label: "Macro Signals", onClick: openMacro },
        {
          label: "Search",
          children: [
            { label: "Events", onClick: () => openSearch("events") },
            { label: "Markets", onClick: () => openSearch("markets") },
          ],
        },
      ],
    },
  ];

  // Ledger source:
  //  • guest → restore a locally-edited portfolio, else seed the PanAgora demo. Guests can edit;
  //    their ledger persists browser-locally (guest scope) and promotes to the account on sign-in.
  //  • authenticated → restore this account's cached ledger, else promote a guest ledger / seed PanAgora.
  // `ledgerScope` tracks which scope the loaded ledger belongs to, so the persist effect writes to
  // the right bucket and never before the restore completes.
  const [ledgerScope, setLedgerScope] = useState<string | null>(null);
  useEffect(() => {
    if (status === "loading") return; // wait for the session to resolve before choosing a source
    let cancelled = false;
    const loadGuestLedger = (): ParsedPortfolio | null => {
      try {
        const g = JSON.parse(localStorage.getItem(GUEST_LEDGER_KEY) || "null");
        return g && Array.isArray(g.holdings) ? (g as ParsedPortfolio) : null;
      } catch { return null; }
    };
    (async () => {
      if (authed && scope) {
        try {
          const saved = localStorage.getItem(acctLedgerKey(scope));
          if (saved) {
            const p = JSON.parse(saved);
            if (!cancelled && p && Array.isArray(p.holdings)) { setLedger(p); setLedgerScope(scope); return; }
          }
        } catch {}
        // First sign-in → promote a guest-built portfolio if present, else seed the retail demo
        // (named after the user). Edits now persist to this account; clear the guest bucket so it can't leak.
        const promoted = loadGuestLedger();
        const seed = promoted ?? demoPortfolio();
        if (!cancelled) { setLedger(promoted ? seed : firstName ? { ...seed, portfolioName: firstName } : seed); setLedgerScope(scope); }
        try { localStorage.removeItem(GUEST_LEDGER_KEY); } catch {}
      } else {
        // Guest → restore a locally-edited portfolio, else seed the retail demo (both editable).
        const seed = loadGuestLedger() ?? demoPortfolio();
        if (!cancelled && seed) { setLedger(seed); setLedgerScope("guest"); }
      }
    })();
    return () => { cancelled = true; };
  }, [status, authed, scope, firstName]);

  // Persist an authenticated user's ledger to their namespace (edits, uploads). Guarded on
  // `ledgerScope === scope` so we never save before restore, or save one account's ledger under another.
  useEffect(() => {
    if (!ledger) return;
    if (authed && scope && ledgerScope === scope) {
      try { localStorage.setItem(acctLedgerKey(scope), JSON.stringify(ledger)); } catch {}
    } else if (!authed && ledgerScope === "guest") {
      // Guest edits persist browser-locally (ephemeral; promoted to the account on sign-in).
      try { localStorage.setItem(GUEST_LEDGER_KEY, JSON.stringify(ledger)); } catch {}
    }
  }, [ledger, authed, scope, ledgerScope]);

  // Link the ledger to the daily agent: mirror the current holdings (+ theses) into Turso under the
  // scope the scheduled agent reads and the Daily Briefing renders. Debounced so live ledger edits
  // coalesce into one write; the next agent pass then analyzes exactly what's in the ledger.
  useEffect(() => {
    if (!ledger || !ledgerScope) return;
    const holdings = ledger.holdings
      .filter((h) => h.ticker)
      .map((h) => ({ ticker: h.ticker, name: h.name ?? null, weight: h.weight ?? null, thesis: h.thesis ?? null }));
    const t = setTimeout(() => {
      fetch("/api/portfolio/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: MONITOR_USER, holdings }),
      }).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [ledger, ledgerScope]);

  // Monaco's exact .text-nav: Inter, grey-light #f6f6f6, fluid size + tracking.
  const navText = {
    fontFamily: "var(--font-inter)",
    color: "#f6f6f6",
    fontWeight: 400,
    lineHeight: 1.6,
    fontSize: "clamp(12px, calc(7.43px + 0.446vw), 16px)",
    letterSpacing: "clamp(-0.32px, calc(-0.103px - 0.009vw), -0.24px)",
  };
  // Phone Brief page: the nav pill shrinks while scrolling down (navCondensed), restores on scroll-up.
  const navSmall = isMobile && mobilePage === "brief" && navCondensed;

  // Compact portfolio context handed to the chat assistant.
  const portfolioCtx = ledger
    ? `Portfolio "${ledger.portfolioName}". Holdings (ticker, weight): ${ledger.holdings
        .slice(0, 15)
        .map((h) => `${h.ticker}${h.weight != null ? ` ${(h.weight * 100).toFixed(1)}%` : ""}`)
        .join("; ")}.`
    : undefined;

  // Guardian search query built from the portfolio's company names for the news card.
  const newsQuery = ledger
    ? ledger.holdings
        .slice(0, 8)
        .map((h) => cleanCompany(h.name || h.ticker))
        .filter(Boolean)
        .map((n) => `"${n}"`)
        .join(" OR ")
    : "";

  // Tickers for the live-prices websocket card.
  const priceAssets = ledger
    ? ledger.holdings.slice(0, 12).map((h) => ({ ticker: h.ticker, name: h.name ?? null })).filter((a) => a.ticker)
    : [];

  return (
    <div className={`bg-black font-sans tracking-[-0.02em] text-[#fafafa] antialiased ${isMobile ? "min-h-dvh overflow-x-clip" : "flex h-screen flex-col"}`}>
      {/* ── Nav: exact Monaco floating liquid-glass pill ───── */}
      <header className="pointer-events-none fixed inset-x-0 top-6 z-50 w-full px-4">
        <div className="mx-auto flex w-full max-w-[1920px] flex-col items-center">
          <div
            className="pointer-events-auto relative flex items-center rounded-[16px] transition-all duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{
              width: "min(100%, 855px)",
              height: navSmall ? 38 : 55,
              backgroundColor: "#3a3a3a66",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
            }}
          >
            {/* left links — tighter gaps/padding on phones so the pill scales proportionally */}
            <nav className="flex flex-1 shrink-0 items-center justify-start gap-4 pl-4 sm:gap-8 sm:pl-[25px]">
              {/* mobile (<768): Brief / Portfolio page tabs */}
              <button
                onClick={() => { setMobilePage("brief"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                style={navText}
                className={`capitalize transition-opacity md:hidden ${mobilePage === "brief" ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
              >
                Brief
              </button>
              <button
                onClick={() => { setMobilePage("portfolio"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                style={navText}
                className={`capitalize transition-opacity md:hidden ${mobilePage === "portfolio" ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
              >
                Portfolio
              </button>
              {/* desktop (≥768): Portfolio (scroll home) / Plays */}
              <button
                onClick={() => mainRef.current?.scrollTo({ left: 0, top: 0, behavior: "smooth" })}
                style={navText}
                className="hidden capitalize opacity-80 transition-opacity hover:opacity-100 md:block"
              >
                Portfolio
              </button>
              <button onClick={() => showToast("Plays — coming soon")} style={navText} className="hidden capitalize opacity-80 transition-opacity hover:opacity-100 md:block">
                Plays
              </button>
            </nav>

            {/* center logo — serif all-caps wordmark (Monaco style); scales down on phones */}
            {/* Centering lives on the wrapper; the scale lives on the inner button so they don't
                fight. Scaling (GPU, sub-pixel) is far smoother than animating font-size. */}
            <div className="absolute left-1/2 z-10 -translate-x-1/2">
              <button
                className="text-white"
                style={{ fontFamily: "var(--font-serif), Georgia, serif", fontSize: "clamp(17px, 1.8vw + 10px, 26px)", fontWeight: 500, letterSpacing: "0.05em", lineHeight: 1, transformOrigin: "center", transform: navSmall ? "scale(0.82)" : "scale(1)", transition: "transform 380ms cubic-bezier(0.22,1,0.36,1)" }}
              >
                THESIS
              </button>
            </div>

            {/* right actions — Dispatch (text; hidden on phones), then Log in / account (oval pill, extreme right) */}
            <div className="flex flex-1 shrink-0 items-center justify-end gap-4 pr-4 sm:gap-8 sm:pr-[25px]">
              <button onClick={() => showToast("Dispatch — coming soon")} style={navText} className="hidden opacity-80 transition-opacity hover:opacity-100 sm:block">
                Dispatch
              </button>
              {session?.user ? (
                isMobile ? (
                  // Phone: the profile avatar doesn't fit the compact nav — plain-text log out instead.
                  <button onClick={() => signOut()} style={navText} className="opacity-85 transition-opacity hover:opacity-100">
                    Log out
                  </button>
                ) : (
                <div className="relative">
                  <button
                    onClick={() => setAcctMenu((v) => !v)}
                    title={session.user.email ?? session.user.name ?? "Account"}
                    className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-white/10 text-[13px] font-medium text-white ring-1 ring-white/15 transition-colors hover:ring-white/40"
                  >
                    {session.user.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={session.user.image} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      (session.user.name ?? session.user.email ?? "U").slice(0, 1).toUpperCase()
                    )}
                  </button>
                  {acctMenu && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setAcctMenu(false)} />
                      <div className="absolute right-0 top-[46px] z-50 w-56 overflow-hidden rounded-[14px] border border-white/10 bg-[#141414]/95 shadow-[0_20px_50px_rgba(0,0,0,0.6)] backdrop-blur">
                        <div className="border-b border-white/[0.06] px-4 py-3">
                          <p className="truncate text-[12.5px] font-medium text-white">{session.user.name ?? "Signed in"}</p>
                          {session.user.email && <p className="truncate text-[11px] text-[#8a8a8a]">{session.user.email}</p>}
                        </div>
                        <button
                          onClick={() => { setAcctMenu(false); signOut(); }}
                          className="block w-full px-4 py-2.5 text-left text-[12.5px] text-white/85 transition-colors hover:bg-white/[0.06] hover:text-white"
                        >
                          Sign out
                        </button>
                      </div>
                    </>
                  )}
                </div>
                )
              ) : (
                <button
                  onClick={() => signIn("google")}
                  className={`inline-flex items-center justify-center whitespace-nowrap transition-all duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${navSmall ? "text-white/85 hover:text-white" : "rounded-[42px] bg-black text-white hover:bg-white hover:text-black"}`}
                  style={{
                    height: navSmall ? 24 : 40,
                    padding: navSmall ? "0px" : "9px 16px",
                    fontWeight: 400,
                    lineHeight: 1.4,
                    fontSize: "clamp(12px, calc(7.43px + 0.446vw), 16px)",
                    letterSpacing: "clamp(-0.32px, calc(-0.103px - 0.009vw), -0.24px)",
                  }}
                >
                  Log in
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ephemeral "coming soon" pill for not-yet-built nav items */}
      {toast && (
        <div className="pointer-events-none fixed inset-x-0 top-[92px] z-[60] flex justify-center">
          <div className="fade-in rounded-full border border-white/10 bg-[#1a1a1a]/90 px-4 py-2 text-[12.5px] text-white/90 shadow-[0_12px_40px_rgba(0,0,0,0.5)] backdrop-blur">
            {toast}
          </div>
        </div>
      )}

      {/* ── Body: desktop = pannable card canvas · mobile = native vertical stack ── */}
      {/* Mobile: no nested scroll container — the DOCUMENT scrolls (smoothest native path:
          momentum, rubber-band, URL-bar collapse). Desktop keeps the pannable scroller. */}
      <main ref={mainRef} className={isMobile ? "relative" : "no-scrollbar relative flex-1 overflow-auto"}>
        {!ledger ? (
          // Brief seed-load moment — land straight on the pre-seeded dashboard (the old
          // upload-a-portfolio dropzone is gone; xlsx upload lives on in parsePortfolio).
          <div className="flex h-full min-h-[70dvh] items-center justify-center">
            <div className="dot-loader" role="status" aria-label="Loading portfolio" />
          </div>
        ) : isMobile ? (
          // Mobile (<768px): full-width cards in normal flow, natively scrollable; drag,
          // resize and canvas interactions are disabled (StaticLayoutContext).
          <StaticLayoutContext.Provider value={true}>
            {mobilePage === "brief" ? (
              // "Brief" tab — EXPERIMENT: the daily-brief text as a sticky-scroll reveal, one chunk at a
              // time. Full-bleed (no top padding) so the text slides UNDER the liquid-glass nav. Swap
              // back to <ThesisMonitorCard/> to revert.
              <BriefReveal user={MONITOR_USER} onCondense={setNavCondensed} />
            ) : (
              // "Portfolio" tab — everything else (ledger onward), without the briefing.
              <div className="flex flex-col gap-3.5 px-3.5 pb-8 pt-24">
              <MobileSlot h={MOBILE_CARD_HEIGHTS.ledger}><LedgerCard data={ledger} editable onChange={setLedger} /></MobileSlot>

              {/* Prediction-market trio (markets · macro · search) — each immediately followed by
                  the cards it spawns, so a spawned card opens right after its origin card. */}
              <MobileSlot h={MOBILE_CARD_HEIGHTS.markets}><PortfolioMarketsCard holdings={ledger.holdings} onOpenMarket={openMarket} /></MobileSlot>
              {openMarkets.map((m) => (
                <MobileSlot key={m.market_id} h={560}><MarketDetailCard market={m} onClose={() => closeMarket(m.market_id)} /></MobileSlot>
              ))}

              {macroOpen && (
                <MobileSlot h={MOBILE_CARD_HEIGHTS.macro}><MacroSignalsCard onClose={closeMacro} onOpenEvent={openMacroEvent} /></MobileSlot>
              )}
              {openMacroEvents.map((ev) => (
                <MobileSlot key={ev.eventKey} h={560}><MacroEventCard event={ev} onClose={() => closeMacroEvent(ev.eventKey)} /></MobileSlot>
              ))}

              {search && (
                <MobileSlot h={MOBILE_CARD_HEIGHTS.search}>
                  <SearchCard mode={search.mode} onModeChange={(m) => setSearch((prev) => (prev ? { ...prev, mode: m } : prev))} onClose={closeSearch} onOpenEvent={openEvent} onOpenMarket={openMarket} />
                </MobileSlot>
              )}
              {openEvents.map((ev) => (
                <MobileSlot key={ev.event_id} h={600}><EventDetailCard event={ev} onClose={() => closeEvent(ev.event_id)} onOpenMarket={openMarket} /></MobileSlot>
              ))}

              <MobileSlot h={MOBILE_CARD_HEIGHTS.chat}><OddpoolChatCard portfolio={portfolioCtx} /></MobileSlot>
              <MobileSlot h={MOBILE_CARD_HEIGHTS.whale}><WhaleCard /></MobileSlot>

              <MobileSlot h={MOBILE_CARD_HEIGHTS.prices}><LivePricesCard assets={priceAssets} onOpenChart={openChart} /></MobileSlot>
              {openCharts.map((c) => (
                <MobileSlot key={c.ticker} h={340}><ChartCard symbol={c.ticker} name={c.name} onClose={() => closeChart(c.ticker)} /></MobileSlot>
              ))}

              <MobileSlot h={MOBILE_CARD_HEIGHTS.news}><NewsAlertCard query={newsQuery} onOpenArticle={openArticle} onFindSignals={openSignalSearch} /></MobileSlot>
              {openArticles.map((a) => (
                <MobileSlot key={a.id} h={600}><ArticleCard item={a} onClose={() => closeArticle(a.id)} /></MobileSlot>
              ))}
              {openSignals.map((a) => (
                <MobileSlot key={a.id} h={520}><SignalSearchCard article={a} onClose={() => closeSignal(a.id)} onOpenEvent={openEvent} onOpenMarket={openMarket} /></MobileSlot>
              ))}

              <MobileSlot h={MOBILE_CARD_HEIGHTS.hours}><MarketHoursCard /></MobileSlot>
              </div>
            )}
          </StaticLayoutContext.Provider>
        ) : (
          <div
            ref={canvasRef}
            onContextMenu={onCanvasContextMenu}
            onPointerDown={startPan}
            onPointerMove={movePan}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            className={`relative ${panning ? "cursor-grabbing" : "cursor-grab"}`}
            style={{ width: canvasSize.w, height: canvasSize.h }}
          >
            {/* default positions/sizes come from the fill-height packer (computeHomeLayout) */}
            <LedgerCard data={ledger} editable onChange={setLedger} x={homeL.ledger.x} y={homeL.ledger.y} width={homeL.ledger.w} height={homeL.ledger.h} />
            <ThesisMonitorCard user={MONITOR_USER} x={homeL.monitor.x} y={homeL.monitor.y} width={homeL.monitor.w} height={homeL.monitor.h} />
            <PortfolioMarketsCard holdings={ledger.holdings} x={homeL.markets.x} y={homeL.markets.y} width={homeL.markets.w} height={homeL.markets.h} onOpenMarket={openMarket} />
            <WhaleCard x={homeL.whale.x} y={homeL.whale.y} width={homeL.whale.w} height={homeL.whale.h} />
            <OddpoolChatCard portfolio={portfolioCtx} x={homeL.chat.x} y={homeL.chat.y} width={homeL.chat.w} height={homeL.chat.h} />
            <MarketHoursCard x={homeL.hours.x} y={homeL.hours.y} width={homeL.hours.w} height={homeL.hours.h} />
            <NewsAlertCard query={newsQuery} onOpenArticle={openArticle} onFindSignals={openSignalSearch} x={homeL.news.x} y={homeL.news.y} width={homeL.news.w} height={homeL.news.h} />
            <LivePricesCard assets={priceAssets} onOpenChart={openChart} x={homeL.prices.x} y={homeL.prices.y} width={homeL.prices.w} height={homeL.prices.h} />
            {openMarkets.map((m) => (
              <MarketDetailCard key={m.market_id} market={m} x={m._x} y={m._y} onClose={() => closeMarket(m.market_id)} />
            ))}
            {openArticles.map((a) => (
              <ArticleCard key={a.id} item={a} x={a._x} y={a._y} onClose={() => closeArticle(a.id)} />
            ))}
            {openCharts.map((c) => (
              <ChartCard key={c.ticker} symbol={c.ticker} name={c.name} x={c._x} y={c._y} onClose={() => closeChart(c.ticker)} />
            ))}
            {macroOpen && <MacroSignalsCard x={homeL.macro.x} y={homeL.macro.y} width={homeL.macro.w} height={homeL.macro.h} onClose={closeMacro} onOpenEvent={openMacroEvent} />}
            {openMacroEvents.map((ev) => (
              <MacroEventCard key={ev.eventKey} event={ev} x={ev._x} y={ev._y} onClose={() => closeMacroEvent(ev.eventKey)} />
            ))}
            {openEvents.map((ev) => (
              <EventDetailCard key={ev.event_id} event={ev} x={ev._x} y={ev._y} onClose={() => closeEvent(ev.event_id)} onOpenMarket={openMarket} />
            ))}
            {search && (
              <SearchCard
                mode={search.mode}
                onModeChange={(m) => setSearch((prev) => (prev ? { ...prev, mode: m } : prev))}
                x={homeL.search.x}
                y={homeL.search.y}
                width={homeL.search.w}
                height={homeL.search.h}
                onClose={closeSearch}
                onOpenEvent={openEvent}
                onOpenMarket={openMarket}
              />
            )}
            {openSignals.map((a) => (
              <SignalSearchCard key={a.id} article={a} x={a._x} y={a._y} onClose={() => closeSignal(a.id)} onOpenEvent={openEvent} onOpenMarket={openMarket} />
            ))}
          </div>
        )}
      </main>

      {menu && <ContextMenu x={menu.vx} y={menu.vy} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}
