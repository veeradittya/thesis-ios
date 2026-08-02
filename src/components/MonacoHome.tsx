"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import { computeHomeLayout, MOBILE_BREAKPOINT, MOBILE_CARD_HEIGHTS } from "@/lib/cardLayout";
import { StaticLayoutContext } from "@/components/ui/useMovableCard";
import { readQuoteCache, writeQuoteCache } from "@/lib/priceCache";
import { MarketHoursPill } from "@/components/MarketHoursPill";
import { SignInButtons } from "@/components/SignInButtons";
import { LedgerCard } from "@/components/LedgerCard";
import { PortfolioLedger } from "@/components/PortfolioLedger";
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
import { DashboardTabs, type DashTab } from "@/components/DashboardTabs";
import { PortfolioOverview } from "@/components/PortfolioOverview";
import { demoPortfolio, type ParsedPortfolio } from "@/lib/parsePortfolio";
import { ensureMarkets } from "@/lib/marketsStore";
import { installRetrievalTimer, setRetrievalReporter } from "@/lib/retrievalTimer";
import { PullToRefresh } from "@/components/PullToRefresh";
import { ThesisIntro } from "@/components/ThesisIntro";
import { SignupScreen, DEV_SKIP_AUTH } from "@/components/SignupScreen";
import { Onboarding } from "@/components/Onboarding";
import { FirstBriefWaiting } from "@/components/FirstBriefWaiting";

// Bump when the default seed changes so stale localStorage ledgers don't override the new demo.
const GUEST_LEDGER_KEY = "thesis.guest.ledger.v2";
const acctLedgerKey = (scope: string) => `thesis.${scope}.ledger.v2`;
// "Has this account finished onboarding on this device?" — keyed PER ACCOUNT (not global) so a new beta
// code onboards even on a device where a different account onboarded before. The real new-vs-returning
// signal is the account's Turso portfolio; this only guards a user who onboarded but built no holdings.
const onboardingSeenKey = (uid: string | null) => `thesis.onboarding.v1.${uid ?? "local"}`;
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
// Price / day-change formatters — identical to the holdings ledger.
const fmtPrice = (v: number | null) => (v == null ? "—" : v.toFixed(2));
const fmtPct = (v: number | null) => (v == null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

// Analyst-recommendation pill: fully transparent glass (backdrop-blur + white glass-edge ring, no tint,
// no sheen) with coloured text by sentiment (bullish = emerald, hold = amber, bearish = rose).
const recColor = (label: string) =>
  label === "Strong Buy" || label === "Buy"
    ? "text-emerald-300"
    : label === "Hold"
      ? "text-amber-300"
      : "text-rose-300"; // Sell / Strong Sell

// The five Finnhub rating buckets, most-bullish first — rows of the expanded ratings breakdown.
const RATING_ROWS: Array<[string, "strongBuy" | "buy" | "hold" | "sell" | "strongSell"]> = [
  ["Strong Buy", "strongBuy"],
  ["Buy", "buy"],
  ["Hold", "hold"],
  ["Sell", "sell"],
  ["Strong Sell", "strongSell"],
];

// low ── current-dot ── high range slider (Day Range / 52-Week Range on the Analyst Sentiment cards).
// The current price is labelled top-right (with a dot glyph matching the marker); Low/High are labelled below.
function RangeSlider({ label, low, cur, high }: { label: string; low: number; cur: number; high: number }) {
  const pct = high > low ? Math.min(100, Math.max(0, ((cur - low) / (high - low)) * 100)) : 50;
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[#8a8a8a]">{label}</span>
        <span className="text-[11.5px] font-medium tabular-nums text-white">{cur.toFixed(2)}</span>
      </div>
      <div className="relative mt-2 h-4 rounded-[3px] bg-white/[0.08]">
        <div
          className="absolute top-1/2 h-2.5 w-2.5 rounded-full bg-white"
          style={{ left: `${pct}%`, transform: "translate(-50%, -50%)", boxShadow: "0 0 0 2px rgba(0,0,0,0.45)" }}
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between text-[10px]">
        <span className="text-[#8a8a8a]">Low <span className="tabular-nums text-white/85">{low.toFixed(2)}</span></span>
        <span className="text-[#8a8a8a]">High <span className="tabular-nums text-white/85">{high.toFixed(2)}</span></span>
      </div>
    </div>
  );
}

// Combined range slider: one 52-week track with TODAY's range highlighted as an inner band and the
// current-price dot. Today's range sits inside the year (often near an edge) with no room for inline
// labels, so an arrow points down at that band; the ends are the 52-week low/high, the dot is "now".
function CombinedRangeSlider({ week52Low, week52High, cur, dayLow, dayHigh }: { week52Low: number; week52High: number; cur: number; dayLow?: number | null; dayHigh?: number | null }) {
  const span = week52High - week52Low || 1;
  const pos = (v: number) => Math.min(100, Math.max(0, ((v - week52Low) / span) * 100));
  const curPos = pos(cur);
  const hasDay = dayLow != null && dayHigh != null && dayHigh > dayLow;
  const dLow = hasDay ? pos(dayLow!) : 0;
  const dHigh = hasDay ? pos(dayHigh!) : 0;
  const dayMid = (dLow + dHigh) / 2;
  return (
    <div>
      <span className="text-[13px] text-[#8a8a8a]">Price Range</span>
      {/* Day-range callout — an arrow points down at today's (tight) amber band inside the 52-week track. */}
      {hasDay && (
        <div className="relative mt-3 h-4 text-[9.5px] tabular-nums text-amber-300/90">
          <span
            className="absolute bottom-1.5 whitespace-nowrap"
            style={{ left: `${dayMid}%`, transform: `translateX(${dayMid > 66 ? "-90%" : dayMid < 34 ? "-10%" : "-50%"})` }}
          >
            Day {dayLow!.toFixed(2)}–{dayHigh!.toFixed(2)}
          </span>
          <span className="absolute bottom-0 -translate-x-1/2 leading-none text-amber-400/70" style={{ left: `${dayMid}%` }}>
            ▾
          </span>
        </div>
      )}
      <div className={`relative ${hasDay ? "" : "mt-2"} h-4 rounded-[3px] bg-white/[0.08]`}>
        {hasDay && (
          <div className="absolute top-0 h-full rounded-[2px] bg-amber-400/45" style={{ left: `${dLow}%`, width: `${Math.max(2, dHigh - dLow)}%` }} />
        )}
        <div
          className="absolute top-0 h-full w-[2px] rounded-full bg-white"
          style={{ left: `${curPos}%`, transform: "translateX(-50%)", boxShadow: "0 0 0 1px rgba(0,0,0,0.5)" }}
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between text-[10px]">
        <span className="text-[#8a8a8a]">52W Low <span className="tabular-nums text-white/85">{week52Low.toFixed(2)}</span></span>
        <span className="text-[#8a8a8a]">52W High <span className="tabular-nums text-white/85">{week52High.toFixed(2)}</span></span>
      </div>
    </div>
  );
}

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

// Compact financial disclaimer shown under informational content (brief / markets / sentiment) so the
// app never reads as transactional. The fuller version lives on the Account → About panel.
function MobileDisclaimer() {
  return (
    <p className="px-5 pb-3 pt-1 text-[11px] leading-snug text-[#6b6b6b]">
      For informational purposes only. Not investment, financial, or trading advice. Thesis is not a
      broker-dealer and executes no trades or bets. Do your own research.
    </p>
  );
}

// The iOS shell's bridge surface. It sets `__thesisNativeChrome` before our JS runs, calls the two
// setters to drive tab state, and listens on `thesisNav` (tab-state reports) and `thesisChrome`
// (whether a full-screen web takeover — sign-up gate / onboarding — wants the native bars hidden).
type ThesisWindow = Window & {
  __thesisNativeChrome?: boolean;
  __thesisSetTab?: (tab: string) => void;
  __thesisSetDashTab?: (sub: string) => void;
  // Face ID app-lock: the shell publishes this on every load (available === true only on a real device
  // with biometrics/passcode set), and applies a toggle on the next launch. Toggling posts a boolean.
  __thesisAppLock?: { available?: boolean; enabled?: boolean };
  webkit?: {
    messageHandlers?: {
      thesisNav?: { postMessage: (m: unknown) => void };
      thesisChrome?: { postMessage: (m: unknown) => void };
      thesisSetAppLock?: { postMessage: (m: unknown) => void };
    };
  };
};

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
  // `isMobile` is false until the first post-mount measurement (vp starts at 0), so the very first
  // paint would otherwise render the DESKTOP layout — flashing the nav (logo pops out of flow, the
  // Log-in→Account button morphs) and mis-centring the loader before snapping to mobile. Gate the
  // whole shell on `mounted`: until we've measured the viewport we show one layout-neutral loader,
  // so the real UI only ever renders once, with the correct breakpoint. No effect on load speed —
  // `mounted` flips on the first effect, long before the (session + ledger) fetches that gate content.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
  const { data: sessionData, status: sessionStatus, update: updateSession } = useSession();
  // DEV ONLY (auto-off in production builds): land straight in the signed-in app without OAuth so the
  // logged-in UI can be worked on. Synthesizes an authenticated session over the demo scope ("pilot"), so
  // the brief + portfolio show demo content but in editable / "my account" mode. A real sign-in still
  // takes precedence. Set to false to get the guest + sign-up-gate flow back in dev.
  const DEV_FORCE_LOGIN = false; // set true (or process.env.NODE_ENV === "development") to preview the signed-in app without OAuth
  const [devSignedOut, setDevSignedOut] = useState(false); // dev: "Log out" drops to the guest demo instead of re-forcing pilot
  const devForced = DEV_FORCE_LOGIN && !sessionData?.user && !devSignedOut;
  const session = devForced
    ? ({ user: { id: "pilot", name: "Dev User", email: "dev@thesis.local" }, expires: "" } as typeof sessionData)
    : sessionData;
  const status = devForced ? "authenticated" : sessionStatus;
  // Log out → guest demo. In dev (no real session) this just drops the synthetic pilot login so the
  // signed-out state is observable; otherwise it's a normal next-auth sign-out (which reloads to the demo).
  const handleLogout = () => {
    if (DEV_FORCE_LOGIN && !sessionData?.user) { setDevSignedOut(true); return; }
    signOut();
  };
  const [acctMenu, setAcctMenu] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false); // desktop: sign-in chooser modal (Google + Apple)
  const [signupDismissed, setSignupDismissed] = useState(false); // logged-out sign-up gate → "later" dismisses
  const [signupReady, setSignupReady] = useState(false); // sign-up gate waits 7s so a guest can explore first
  const [onboarding, setOnboarding] = useState(false); // new-user onboarding wizard (post sign-in / ?onboard=1)
  const [onboarded, setOnboarded] = useState(false); // completed onboarding → treat like a set-up account (editable portfolio)
  const [awaitedAfterOnboard, setAwaitedAfterOnboard] = useState(false); // just finished onboarding → show the "first brief" countdown
  const [firstBriefReady, setFirstBriefReady] = useState<boolean | null>(null); // has THIS account's first brief been generated? (null=unknown)
  const [mobilePage, setMobilePage] = useState<"brief" | "dashboard" | "portfolio" | "account">("brief"); // phone-only: which stack to show
  const [dashTab, setDashTab] = useState<DashTab>("news"); // phone-only: Dashboard sub-tab (News · Prediction Markets · Extra)
  // Native iOS shell renders its OWN glass bottom-nav + Dashboard slider. It sets this flag before our JS
  // runs; when present we yield our web nav/slider, pad for the floating native bars, and drive/report tab
  // state over a bridge. Absent (desktop / mobile-web) → everything below is unchanged. Read once via a
  // lazy initializer — the whole shell is gated on `mounted`, so this is set before the real UI renders.
  const [nativeChrome] = useState<boolean>(
    () => typeof window !== "undefined" && (window as ThesisWindow).__thesisNativeChrome === true,
  );
  // Deep link: tapping the daily-brief push opens the app with ?view=brief. Honour ?view= on load.
  // ?onboard=1 forces the onboarding wizard (local preview, since real sign-in won't complete in a browser).
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const v = q.get("view");
      if (v === "brief" || v === "dashboard" || v === "portfolio") setMobilePage(v);
      if (q.get("onboard") === "1") setOnboarding(true);
    } catch {}
  }, []);
  // Contract map between our internal Dashboard sub-tab ids and the native slider's strings.
  const DASH_TO_NATIVE: Record<DashTab, "overview" | "analyst" | "news" | "markets"> = { overview: "overview", extra: "analyst", news: "news", markets: "markets" };
  // Inbound bridge: let the native bars drive our tab state (no reload). Defined only in native mode.
  useEffect(() => {
    if (!nativeChrome || typeof window === "undefined") return;
    const w = window as ThesisWindow;
    w.__thesisSetTab = (tab) => {
      if (tab === "brief" || tab === "dashboard" || tab === "portfolio" || tab === "account") setMobilePage(tab);
    };
    w.__thesisSetDashTab = (sub) => {
      const map: Record<string, DashTab> = { overview: "overview", analyst: "extra", news: "news", markets: "markets" };
      if (map[sub]) setDashTab(map[sub]);
    };
    return () => { delete w.__thesisSetTab; delete w.__thesisSetDashTab; };
  }, [nativeChrome]);
  // Outbound bridge: report the current tab + Dashboard sub-tab so the native bars stay in sync. Fires on
  // mount (initial sync — fixes "native says Brief while web is on Dashboard") and on every change from any
  // source (native call, ?view= deep link, in-content button). No-op / skipped when not in native mode.
  useEffect(() => {
    if (!nativeChrome || typeof window === "undefined") return;
    (window as ThesisWindow).webkit?.messageHandlers?.thesisNav?.postMessage({ tab: mobilePage, dashTab: DASH_TO_NATIVE[dashTab] });
  }, [nativeChrome, mobilePage, dashTab]); // eslint-disable-line react-hooks/exhaustive-deps
  // A full-screen web takeover (the sign-up gate or the onboarding wizard) must sit ABOVE the native bars
  // — a web z-index can't paint over a native view, so ask the shell to hide its bottom nav + slider while
  // one is up, and restore them when it closes. Fires on mount and whenever a takeover opens/closes.
  useEffect(() => {
    if (!nativeChrome || typeof window === "undefined") return;
    const takeover = (status === "unauthenticated" && !signupDismissed && signupReady) || onboarding;
    (window as ThesisWindow).webkit?.messageHandlers?.thesisChrome?.postMessage({ hidden: takeover });
  }, [nativeChrome, status, signupDismissed, onboarding]);

  // Live quotes for the Analyst Sentiment cards — SAME pipeline as the holdings ledger (/api/quote +
  // the shared price cache). Seeded from cache and fetched once when that tab is open.
  type SentimentQuote = { price: number | null; percent: number | null; dayLow?: number | null; dayHigh?: number | null };
  const [sentimentQuotes, setSentimentQuotes] = useState<Record<string, SentimentQuote>>({});
  const holdingSymbols = useMemo(
    () => (ledger?.holdings ?? []).map((h) => h.ticker.trim().toUpperCase()).filter(Boolean).join(","),
    [ledger],
  );
  useEffect(() => {
    if (dashTab !== "extra" || !holdingSymbols) return;
    const active = holdingSymbols.split(",");
    const cached = readQuoteCache(active);
    setSentimentQuotes((prev) => {
      const next = { ...prev };
      for (const [s, c] of Object.entries(cached)) if (next[s] == null) next[s] = { price: c.price, percent: c.percent };
      return next;
    });
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/quote?symbols=${encodeURIComponent(holdingSymbols)}`);
        const j = await r.json();
        const q = (j.quotes || {}) as Record<string, SentimentQuote>;
        if (cancelled) return;
        setSentimentQuotes((prev) => ({ ...prev, ...q }));
        writeQuoteCache(q);
      } catch {
        /* keep whatever prices we already have */
      }
    })();
    return () => { cancelled = true; };
  }, [dashTab, holdingSymbols]);

  // Average analyst recommendation per holding (Finnhub via /api/recommendation) — server-cached, so
  // this is cheap on repeat tab visits. Uncovered names (e.g. crypto) are simply absent from the map.
  type RecCounts = { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number };
  const [recommendations, setRecommendations] = useState<Record<string, { label: string; score: number; analysts: number; period: string; counts: RecCounts }>>({});
  // Which Analyst Sentiment cards have their ratings breakdown expanded.
  const [openRatings, setOpenRatings] = useState<Set<string>>(new Set());
  const toggleRatings = (sym: string) =>
    setOpenRatings((prev) => {
      const n = new Set(prev);
      if (n.has(sym)) n.delete(sym);
      else n.add(sym);
      return n;
    });
  useEffect(() => {
    if (dashTab !== "extra" || !holdingSymbols) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/recommendation?symbols=${encodeURIComponent(holdingSymbols)}`);
        const j = await r.json();
        if (!cancelled) setRecommendations(j.recommendations || {});
      } catch {
        /* keep whatever we have */
      }
    })();
    return () => { cancelled = true; };
  }, [dashTab, holdingSymbols]);

  // 52-week range per holding (Finnhub via /api/metrics) — feeds the 52-Week Range slider.
  const [metrics, setMetrics] = useState<Record<string, { week52High: number | null; week52Low: number | null }>>({});
  useEffect(() => {
    if (dashTab !== "extra" || !holdingSymbols) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/metrics?symbols=${encodeURIComponent(holdingSymbols)}`);
        const j = await r.json();
        if (!cancelled) setMetrics(j.metrics || {});
      } catch {
        /* keep whatever we have */
      }
    })();
    return () => { cancelled = true; };
  }, [dashTab, holdingSymbols]);

  // Per-stock analyst-sentiment brief (agent-written, from Turso via /api/analyst-brief).
  const [analystBriefs, setAnalystBriefs] = useState<Record<string, string>>({});
  useEffect(() => {
    if (dashTab !== "extra" || !holdingSymbols) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/analyst-brief?symbols=${encodeURIComponent(holdingSymbols)}`);
        const j = await r.json();
        if (!cancelled) setAnalystBriefs(j.briefs || {});
      } catch {
        /* keep whatever we have */
      }
    })();
    return () => { cancelled = true; };
  }, [dashTab, holdingSymbols]);
  const [navCondensed, setNavCondensed] = useState(false); // phone: nav shrinks on scroll-down
  const [priceRefresh, setPriceRefresh] = useState(0); // bumped by pull-to-refresh to re-fetch live prices
  const priceRefreshResolve = useRef<(() => void) | null>(null); // resolves when the triggered fetch lands
  // Pull-to-refresh handler: bump the signal and resolve once PortfolioLedger reports the fetch done,
  // so the gesture springs back exactly when the fresh prices are ready. MUST be stable (useCallback)
  // — if its identity changed each render, PullToRefresh's effect would tear down and stop the
  // in-flight spring-back animation.
  const refreshPrices = useCallback(
    () =>
      new Promise<void>((resolve) => {
        priceRefreshResolve.current = resolve;
        setPriceRefresh((n) => n + 1);
      }),
    [],
  );
  // Same pull-to-refresh contract for the Portfolio Headlines (News) tab — bump the signal, resolve when
  // NewsAlertCard reports its re-fetch landed. Stable identity so PullToRefresh's effect isn't torn down.
  const [newsRefresh, setNewsRefresh] = useState(0);
  const newsRefreshResolve = useRef<(() => void) | null>(null);
  const refreshNews = useCallback(
    () =>
      new Promise<void>((resolve) => {
        newsRefreshResolve.current = resolve;
        setNewsRefresh((n) => n + 1);
      }),
    [],
  );
  useEffect(() => setNavCondensed(false), [mobilePage]); // restore the nav when switching pages
  useEffect(() => { if (mobilePage !== "account") setAcctView("menu"); }, [mobilePage]); // leave Account → back to its menu

  // Backend monitoring: log which feature/page a SIGNED-IN user opens + timed retrievals. Events are
  // QUEUED and flushed in a single batched POST (debounced ~1.5s, and on page-hide) instead of one
  // request per event — the server writes the whole batch in one DB round-trip. Guests are ignored.
  const activityQueue = useRef<Array<{ event: string; detail?: unknown; ms?: number; ts: string }>>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushActivity = useCallback(() => {
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    const events = activityQueue.current;
    if (!events.length) return;
    activityQueue.current = [];
    // keepalive so an in-flight flush still completes if the page is being torn down.
    fetch("/api/activity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }), keepalive: true }).catch(() => {});
  }, []);
  const logEvent = (event: string, detail?: unknown, ms?: number) => {
    if (!session?.user) return;
    activityQueue.current.push({ event, detail, ms, ts: new Date().toISOString() });
    if (!flushTimer.current) flushTimer.current = setTimeout(flushActivity, 1500);
  };
  // Flush the queue when the tab is hidden/closed so nothing is lost.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flushActivity(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushActivity);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushActivity);
      flushActivity(); // flush anything pending on unmount
    };
  }, [flushActivity]);
  useEffect(() => {
    logEvent("view", mobilePage === "dashboard" ? { page: "dashboard", tab: dashTab } : { page: mobilePage });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobilePage, dashTab, session?.user]);

  // Time every news/tab data retrieval and log the latency (server labels it fast/standard/slow).
  // The fetch wrapper is installed once; the reporter is (de)registered with the current session so
  // only signed-in users' retrievals are recorded.
  useEffect(() => { installRetrievalTimer(); }, []);
  useEffect(() => {
    if (!session?.user) { setRetrievalReporter(null); return; }
    setRetrievalReporter((label, ms) => logEvent("retrieval", { label }, ms));
    return () => setRetrievalReporter(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user]);
  // Nav-condense on scroll — the same protocol BriefReveal uses (shrink after scrolling down past a
  // small threshold, restore on scroll-up or at the very top; accumulate per-direction so a tiny nudge
  // doesn't flip it). Brief drives this from inside BriefReveal (its own scroll container); the
  // Dashboard/Portfolio/Account pages scroll the DOCUMENT, so mirror it on the window here.
  const navScrollAccum = useRef(0);
  useEffect(() => {
    if (!isMobile || mobilePage === "brief") return; // Brief is handled inside BriefReveal
    navScrollAccum.current = 0;
    let prev = window.scrollY;
    const onScroll = () => {
      const latest = window.scrollY;
      const d = latest - prev;
      prev = latest;
      if (d === 0) return;
      if (latest <= 6) { navScrollAccum.current = 0; setNavCondensed(false); return; }
      if (Math.sign(d) !== Math.sign(navScrollAccum.current)) navScrollAccum.current = 0; // direction reversed
      navScrollAccum.current += d;
      if (navScrollAccum.current > 40) setNavCondensed(true);
      else if (navScrollAccum.current < -40) setNavCondensed(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isMobile, mobilePage]);
  const userId = session?.user?.id ?? null;
  const authed = !!userId; // authenticated client → editable, per-account, persisted ledger
  const scope = authed ? `u.${userId}` : null; // localStorage namespace for this account
  const firstName = (session?.user?.name || "").trim().split(/\s+/)[0] || null; // names the seeded ledger for a signed-in user

  // In-app account deletion (App Store Guideline 5.1.1(v)): confirm → POST /api/account/delete → signOut.
  const [acctDeleting, setAcctDeleting] = useState(false);
  const [acctDeleted, setAcctDeleted] = useState(false);
  const [acctDeleteError, setAcctDeleteError] = useState(false);
  const [acctView, setAcctView] = useState<"menu" | "about" | "delete">("menu"); // Account tab: stacked menu → sub-pages
  // Face ID app-lock — a native toggle. Read the shell's published state on mount; only surfaced when the
  // device supports it. Toggling posts a boolean to the shell, which applies it on the next app launch.
  const [appLock, setAppLock] = useState<{ available: boolean; enabled: boolean }>({ available: false, enabled: false });
  useEffect(() => {
    const a = (window as ThesisWindow).__thesisAppLock;
    setAppLock({ available: a?.available === true, enabled: a?.enabled === true });
  }, []);
  const toggleAppLock = () => {
    const on = !appLock.enabled;
    try { (window as ThesisWindow).webkit?.messageHandlers?.thesisSetAppLock?.postMessage(on); } catch {}
    setAppLock((s) => ({ ...s, enabled: on }));
  };
  // Let a logged-out visitor explore for 7s before the sign-up gate slides in (rather than gating on load).
  useEffect(() => {
    if (status !== "unauthenticated") { setSignupReady(false); return; }
    const t = setTimeout(() => setSignupReady(true), 7000);
    return () => clearTimeout(t);
  }, [status]);
  const handleDeleteAccount = async () => {
    setAcctDeleting(true);
    setAcctDeleteError(false);
    try {
      const res = await fetch("/api/account/delete", { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      // Drop this account's locally cached ledger so it can't be re-synced after deletion.
      try { if (scope) localStorage.removeItem(acctLedgerKey(scope)); } catch {}
      setAcctDeleted(true);
      await signOut({ redirect: false }); // clear the session in place; the deleted screen stays shown
    } catch {
      setAcctDeleting(false);
      setAcctDeleteError(true);
    }
  };
  // The Turso scope for the scheduled agent + Daily Briefing. Signed-in users read/write their OWN
  // portfolio (keyed by their account id); signed-out visitors see the shared public demo ("pilot").
  // The /api routes re-derive this from the session server-side — this value only drives which brief
  // the client fetches and how it caches it, never who the server reads/writes.
  const DEMO_USER = "pilot";
  const monitorUser = authed && userId ? userId : DEMO_USER;

  // Has THIS signed-in account's first Daily Brief been generated yet? A brand-new account has none until
  // the 8am ET agent runs — until then it sees the "first brief" countdown instead of the app. Poll so the
  // screen clears itself the moment the brief lands. Guests/unknown stay null (their demo brief always exists).
  useEffect(() => {
    if (!authed || !userId) { setFirstBriefReady(null); return; }
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch(`/api/monitor?user=${encodeURIComponent(userId)}`);
        const j = (await r.json()) as { memo?: string | null; results?: unknown[] };
        if (!cancelled) setFirstBriefReady(!!(j?.memo || (Array.isArray(j?.results) && j.results.length)));
      } catch { if (!cancelled) setFirstBriefReady((v) => v ?? false); }
    };
    check();
    const id = setInterval(check, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [authed, userId]);

  // Prefetch Asset Related Markets as soon as the ledger is ready — regardless of which page/tab is
  // showing — so opening the Markets tab paints from the shared cache instead of the "Scanning live
  // markets…" spinner. Cheap + de-duped in lib/marketsStore (TTL + in-flight guard).
  useEffect(() => {
    if (ledger) ensureMarkets(ledger.holdings);
  }, [ledger]);

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
    } catch {}
    setHydrated(true);
  }, []);
  // Phones don't persist anything (per user): the stack is a fixed, read-through view —
  // it still RESTORES desktop-opened cards, but never writes back.
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  useEffect(() => { if (hydrated && !isMobileRef.current) try { localStorage.setItem("thesis.markets.open", JSON.stringify(openMarkets)); } catch {} }, [openMarkets, hydrated]);
  useEffect(() => { if (hydrated && !isMobileRef.current) try { localStorage.setItem("thesis.events.open", JSON.stringify(openEvents)); } catch {} }, [openEvents, hydrated]);
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
  //  • guest (signed out) → ALWAYS the fixed, read-only demo. Nothing a guest does persists, so the demo
  //    is identical for every signed-out visitor and can never drift.
  //  • authenticated → restore this account's cached ledger (this device), else its Turso portfolio
  //    (cross-device), else seed the demo as a starting point. Edits persist to this account only.
  // `ledgerScope` tracks which scope the loaded ledger belongs to, so the persist effect writes to
  // the right bucket (and only for a signed-in account) and never before the restore completes.
  const [ledgerScope, setLedgerScope] = useState<string | null>(null);
  useEffect(() => {
    if (status === "loading") return; // wait for the session to resolve before choosing a source
    let cancelled = false;
    (async () => {
      if (authed && scope) {
        // Has this account been ACTIVATED (finished onboarding at least once)? Signals, cross-device:
        //  • a beta code proves it by the display name restored from Turso — set ONLY by finishing
        //    onboarding, so a brand-new code has no name and is NOT activated;
        //  • every account also leaves a local per-account "seen" flag on the device it onboarded on.
        // This matters because we seed a demo under a new account's scope below, which the persist effect
        // caches. If we trusted that cache, a brand-new beta code would look "returning" on its 2nd visit
        // and skip onboarding. So a not-yet-activated beta code NEVER uses the local cache — its new-vs-
        // returning status is decided by the Turso portfolio. (Google/Apple keep the instant cache path.)
        const isBeta = (userId ?? "").startsWith("beta_");
        let seenLocal = false;
        try { seenLocal = !!localStorage.getItem(onboardingSeenKey(userId)); } catch {}
        const activated = seenLocal || (isBeta && !!firstName);
        if (!isBeta || activated) {
          try {
            const saved = localStorage.getItem(acctLedgerKey(scope));
            if (saved) {
              const p = JSON.parse(saved);
              if (!cancelled && p && Array.isArray(p.holdings)) { setLedger(p); setLedgerScope(scope); return; }
            }
          } catch {}
        }
        // This account's server-side portfolio in Turso — the source of truth that follows it across
        // devices. Present → a returning account: load it and go straight to the app.
        try {
          const r = await fetch("/api/portfolio/sync");
          if (r.ok) {
            const j = (await r.json()) as { holdings?: Array<{ ticker: string; name: string | null; weight: number | null; thesis: string | null }> };
            if (!cancelled && Array.isArray(j.holdings) && j.holdings.length) {
              const holdings = j.holdings.map((h) => ({
                ticker: h.ticker, name: h.name || h.ticker, shares: null, price: null, value: null, weight: h.weight, gain: null,
                ...(h.thesis ? { thesis: h.thesis } : {}),
              }));
              setLedger({ fileName: "", portfolioName: firstName || "My Portfolio", sheetName: "", rowCount: holdings.length, totalValue: null, holdings, mappedColumns: {} });
              setLedgerScope(scope);
              try { localStorage.removeItem(GUEST_LEDGER_KEY); } catch {}
              return;
            }
          }
        } catch {}
        if (cancelled) return;
        // No portfolio anywhere → a NEW account. Run the whole onboarding flow (a new beta code always
        // lands here). Seed the demo underneath as the starting point; a signed-out guest's demo is NEVER
        // promoted onto an account.
        const seed = firstName ? { ...demoPortfolio(), portfolioName: firstName } : demoPortfolio();
        // For a not-yet-activated account the seeded demo is DISPLAY-ONLY: park it under a sentinel scope
        // so NEITHER the localStorage-persist NOR the Turso-sync effect mirrors it. Otherwise the demo is
        // written to the account as if it were the user's own portfolio, and the account then looks
        // "returning" — locally AND on the server (the cross-device source of truth) — on its next sign-in,
        // skipping onboarding. Onboarding completion promotes the real portfolio to the account scope.
        if (!cancelled) { setLedger(seed); setLedgerScope(activated ? scope : `seed:${scope}`); }
        try { localStorage.removeItem(GUEST_LEDGER_KEY); } catch {} // retire any stale guest ledger
        if (!cancelled && !activated && !DEV_FORCE_LOGIN) setOnboarding(true);
      } else {
        // Signed out → ALWAYS the fixed, read-only demo. Nothing a guest does persists, and any stale
        // guest ledger from an older build is cleared, so the demo can never drift between visitors/visits.
        try { localStorage.removeItem(GUEST_LEDGER_KEY); } catch {}
        if (!cancelled) { setLedger(demoPortfolio()); setLedgerScope("guest"); }
      }
    })();
    return () => { cancelled = true; };
  }, [status, authed, scope, firstName]);

  // Persist an authenticated user's ledger to their namespace (edits, uploads). Guarded on
  // `ledgerScope === scope` so we never save before restore, or save one account's ledger under another.
  useEffect(() => {
    if (!ledger) return;
    // ONLY a signed-in account persists its ledger (per-account, this device). A signed-out guest never
    // writes anything — the demo stays constant and read-only for everyone who isn't logged in.
    if (authed && scope && ledgerScope === scope) {
      try { localStorage.setItem(acctLedgerKey(scope), JSON.stringify(ledger)); } catch {}
    }
  }, [ledger, authed, scope, ledgerScope]);

  // Link the ledger to the daily agent: mirror the current holdings (+ theses) into Turso under the
  // scope the scheduled agent reads and the Daily Briefing renders. Debounced so live ledger edits
  // coalesce into one write; the next agent pass then analyzes exactly what's in the ledger.
  useEffect(() => {
    // Only signed-in users mirror their ledger to Turso (the agent's per-user source of truth); the
    // server keys it to their account from the session. Guests stay browser-local until they sign in.
    // Guard on ledgerScope === scope so we never sync before this account's ledger has loaded.
    if (!ledger || !authed || ledgerScope !== scope) return;
    const holdings = ledger.holdings
      .filter((h) => h.ticker)
      .map((h) => ({ ticker: h.ticker, name: h.name ?? null, weight: h.weight ?? null, thesis: h.thesis ?? null }));
    const t = setTimeout(() => {
      fetch("/api/portfolio/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ holdings }),
      }).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [ledger, ledgerScope, authed, scope]);

  // Monaco's exact .text-nav: Inter, grey-light #f6f6f6, fluid size + tracking.
  const navText = {
    fontFamily: "var(--font-inter)",
    color: "#f6f6f6",
    fontWeight: 400,
    lineHeight: 1.6,
    fontSize: "clamp(12px, calc(7.43px + 0.446vw), 16px)",
    letterSpacing: "clamp(-0.32px, calc(-0.103px - 0.009vw), -0.24px)",
  };
  // Phone (every page): the nav pill shrinks while scrolling down (navCondensed), restores on scroll-up.
  const navSmall = isMobile && navCondensed;
  // In the native iOS shell the OS renders the bottom nav + Dashboard slider, so we drop our own web
  // chrome (the floating pill + the DashboardTabs slider). Desktop / mobile-web keep them.
  const hideWebChrome = isMobile && nativeChrome;

  // The "first brief" countdown takes over the whole app for a brand-new account until its first brief is
  // generated. Show it (a) right after onboarding (covers the local ?onboard=1 preview too), or (b) on any
  // load where a signed-in account has its own set-up portfolio but no brief yet — reload-safe, and it
  // clears itself when the monitor poll reports the brief has landed. `=== false` (not `!== true`) on the
  // reload path so a returning user never flashes it while readiness is still unknown (null).
  const hasOwnPortfolio = authed && ledgerScope === scope && !!ledger && ledger.holdings.some((h) => h.ticker);
  const showFirstBriefWait =
    (awaitedAfterOnboard && firstBriefReady !== true) || (hasOwnPortfolio && firstBriefReady === false);

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

  // First-paint / loading gate: one full-viewport, breakpoint-neutral loader (no nav, no layout
  // branching → identical on the server and the first client render, so no hydration flash) until the
  // viewport is measured AND the ledger is ready. Then the correct shell renders exactly once.
  if (!mounted || !ledger) {
    return (
      <div className="grid min-h-dvh place-items-center bg-black">
        {/* Left→right shimmer loading indicator (13px). */}
        <span
          className="shimmer-coming-soon"
          role="status"
          aria-label="Loading"
          style={{ fontFamily: "var(--font-inter)", fontWeight: 400, fontSize: "13px", lineHeight: 1.4, letterSpacing: "clamp(-0.32px, calc(-0.103px - 0.009vw), -0.24px)" }}
        >
          Loading....
        </span>
      </div>
    );
  }

  return (
    <div className={`bg-black font-sans tracking-[-0.02em] text-[#fafafa] antialiased ${isMobile ? "min-h-dvh overflow-x-clip" : "flex h-screen flex-col"}`}>
      {/* ── Floating liquid-glass nav pill — the pre-fork betathesis nav, unified across breakpoints.
          The entire pill sits at the BOTTOM on phones (safe-area aware); top-6 on desktop (≥768px).
          Hidden inside the native iOS shell — the OS draws its own bottom nav there. ───── */}
      {!hideWebChrome && (
      <header className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+16px)] z-50 w-full px-4 md:bottom-auto md:top-6">
        <div className="mx-auto flex w-full max-w-[1920px] flex-col items-center">
          <div
            className="pointer-events-auto relative flex items-center rounded-[16px] transition-all duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{
              width: "min(100%, 855px)",
              height: navSmall ? 38 : 55,
              backgroundColor: "#3a3a3a4d",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
            }}
          >
            {/* left links — tighter gaps/padding on phones so the pill scales proportionally */}
            <nav className="flex flex-1 shrink-0 items-center justify-evenly md:justify-start md:gap-8 md:pl-[25px]">
              {/* mobile (<768): Brief / Dashboard page tabs (Portfolio lives on the right of the logo) */}
              <button
                onClick={() => { setMobilePage("brief"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                style={navText}
                className={`capitalize transition-opacity md:hidden ${mobilePage === "brief" ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
              >
                Brief
              </button>
              <button
                onClick={() => { setMobilePage("dashboard"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                style={navText}
                className={`capitalize transition-opacity md:hidden ${mobilePage === "dashboard" ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
              >
                Dashboard
              </button>
              {/* desktop (≥768): Portfolio scrolls home */}
              <button
                onClick={() => mainRef.current?.scrollTo({ left: 0, top: 0, behavior: "smooth" })}
                style={navText}
                className="hidden capitalize opacity-80 transition-opacity hover:opacity-100 md:block"
              >
                Portfolio
              </button>
            </nav>

            {/* center logo — serif all-caps wordmark (Monaco style); scales down on phones */}
            {/* Phone: the logo is an in-flow flex item between the two flex-1 groups — equal flex space
                keeps it centered, but it now reserves real width so the tabs can't slide under it (the
                bug the absolute-centered desktop version had once a 4th tab was added). Desktop keeps
                absolute centering. Scale (GPU, sub-pixel) is smoother than animating font-size. */}
            <div className={isMobile ? "z-10 shrink-0" : "absolute left-1/2 z-10 -translate-x-1/2"}>
              <button
                data-thesis-wordmark
                className="text-white"
                style={{ fontFamily: "var(--font-serif), Georgia, serif", fontSize: "clamp(17px, 1.8vw + 10px, 26px)", fontWeight: 500, letterSpacing: "0.05em", lineHeight: 1, transformOrigin: "center", transform: navSmall ? "scale(0.82)" : "scale(1)", transition: "transform 380ms cubic-bezier(0.22,1,0.36,1)" }}
              >
                THESIS
              </button>
            </div>

            {/* right actions — mobile Portfolio tab (right of the logo), then Log in / account */}
            <div className="flex flex-1 shrink-0 items-center justify-evenly md:justify-end md:gap-8 md:pr-[25px]">
              <button
                onClick={() => { setMobilePage("portfolio"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                style={navText}
                className={`capitalize transition-opacity md:hidden ${mobilePage === "portfolio" ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
              >
                Portfolio
              </button>
              {session?.user ? (
                isMobile ? (
                  // Phone: keep the label "Account" (never relabel to "Log out") — tapping it opens the
                  // Account page, which is where the logout lives. Active/dimmed like the other page tabs.
                  <button
                    onClick={() => { setMobilePage("account"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                    style={navText}
                    className={`capitalize transition-opacity ${mobilePage === "account" ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
                  >
                    Account
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
                          onClick={() => { setAcctMenu(false); handleLogout(); }}
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
                  onClick={() => {
                    // New user: open the sign-in chooser (Google + Apple), never a single provider
                    // directly. Phone → the Account page hosts the chooser; desktop → a modal.
                    if (isMobile) { setMobilePage("account"); window.scrollTo({ top: 0, behavior: "smooth" }); }
                    else setSignInOpen(true);
                  }}
                  className={
                    isMobile
                      ? // Phone: no pill — plain text that reads as a peer of the other tabs (so THESIS
                        // stays centered) and brightens to full opacity when its Account page is active.
                        `whitespace-nowrap transition-opacity ${mobilePage === "account" ? "opacity-100" : "opacity-50 hover:opacity-100"}`
                      : "inline-flex items-center justify-center whitespace-nowrap rounded-[42px] bg-black text-white transition-all duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-white hover:text-black"
                  }
                  style={
                    isMobile
                      ? navText
                      : {
                          height: 40,
                          padding: "9px 16px",
                          fontWeight: 400,
                          lineHeight: 1.4,
                          fontSize: "clamp(12px, calc(7.43px + 0.446vw), 16px)",
                          letterSpacing: "clamp(-0.32px, calc(-0.103px - 0.009vw), -0.24px)",
                        }
                  }
                >
                  {isMobile ? "Account" : "Log in"}
                </button>
              )}
            </div>
          </div>
        </div>
      </header>
      )}


      {/* Desktop sign-in chooser — both options (Apple + Google) with equal prominence, opened from
          the "Log in" nav button. (Phone hosts the same chooser on its Account page.) */}
      {signInOpen && !session?.user && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center px-6">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setSignInOpen(false)} />
          <div className="relative z-10 w-full max-w-[380px] rounded-[20px] border border-white/10 bg-[#141414]/95 p-8 shadow-[0_24px_70px_rgba(0,0,0,0.65)]">
            <button
              onClick={() => setSignInOpen(false)}
              aria-label="Close"
              className="absolute right-4 top-4 grid h-7 w-7 place-items-center rounded-full text-[15px] text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/80"
            >
              ✕
            </button>
            <div className="mb-9 text-center">
              <p className="text-[26px] font-medium text-white">Log in or sign up</p>
              <p className="mx-auto mt-3.5 max-w-[300px] text-[18.5px] leading-snug text-[#bcbcbc]">
                {"You'll get access to a customizable portfolio, a daily brief, insights, and more."}
              </p>
            </div>
            <div className="flex justify-center">
              <SignInButtons />
            </div>
          </div>
        </div>
      )}

      {/* ── Body: desktop = pannable card canvas · mobile = native vertical stack ── */}
      {/* Mobile: no nested scroll container — the DOCUMENT scrolls (smoothest native path:
          momentum, rubber-band, URL-bar collapse). Desktop keeps the pannable scroller. */}
      <main ref={mainRef} className={isMobile ? "relative" : "no-scrollbar relative flex-1 overflow-auto"}>
        {isMobile ? (
          // Mobile (<768px): full-width cards in normal flow, natively scrollable; drag,
          // resize and canvas interactions are disabled (StaticLayoutContext).
          <StaticLayoutContext.Provider value={true}>
            {mobilePage === "brief" ? (
              // "Brief" tab — before the account's first brief exists, serve the waiting screen; otherwise
              // the daily-brief sticky-scroll reveal. Full-bleed so the text slides UNDER the glass nav.
              showFirstBriefWait ? (
                <FirstBriefWaiting />
              ) : (
                <BriefReveal user={monitorUser} onCondense={setNavCondensed} />
              )
            ) : mobilePage === "account" ? (
              acctDeleted ? (
                // Post-deletion confirmation — the session is being cleared underneath this.
                <div className="flex min-h-[calc(100dvh-180px)] flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-[20px] font-medium text-white">Account deleted</p>
                  <p className="max-w-[300px] text-[14px] leading-snug text-[#8a8a8a]">
                    Your account and all of your data have been permanently removed.
                  </p>
                </div>
              ) : session?.user ? (
                // "Account" tab, signed in. A stacked menu (identity + Log out + tappable rows) whose rows
                // open their own page in place: About, Privacy Policy (the /privacy route), Delete Account.
                <div className={`mx-auto flex w-full max-w-[440px] flex-col gap-5 px-6 pt-[calc(env(safe-area-inset-top)+32px)] ${nativeChrome ? "pb-[calc(env(safe-area-inset-bottom)+76px)]" : "pb-28"}`}>
                  {acctView === "menu" ? (
                    <>
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-[12px] uppercase tracking-wider text-[#8a8a8a]">Account</p>
                          <p className="mt-1.5 truncate text-[15px] text-white">{session.user.name ?? "Signed in"}</p>
                          {session.user.email && <p className="truncate text-[13px] text-[#8a8a8a]">{session.user.email}</p>}
                        </div>
                        <button
                          onClick={handleLogout}
                          className="shrink-0 rounded-full border border-white/15 bg-white/[0.06] px-6 py-2 text-[14px] font-medium text-white transition-colors hover:bg-white/[0.12]"
                        >
                          Log out
                        </button>
                      </div>

                      {/* Face ID app-lock — only on a device that supports it. Applies on next launch. */}
                      {appLock.available && (
                        <div className="mt-2 flex items-start justify-between gap-4 rounded-2xl border border-white/[0.09] bg-white/[0.03] px-4 py-4">
                          <div className="min-w-0">
                            <p className="text-[15px] text-white">Lock with Face ID</p>
                            <p className="mt-1 text-[13px] leading-snug text-[#8a8a8a]">
                              Require Face ID each time you open the app so only you can see your portfolio.
                            </p>
                          </div>
                          <button
                            role="switch"
                            aria-checked={appLock.enabled}
                            aria-label="Lock Thesis with Face ID"
                            onClick={toggleAppLock}
                            className={`relative mt-0.5 h-[30px] w-[50px] shrink-0 rounded-full transition-colors ${appLock.enabled ? "bg-[#34C759]" : "bg-white/15"}`}
                          >
                            <span className={`absolute top-[3px] h-6 w-6 rounded-full bg-white shadow transition-all ${appLock.enabled ? "left-[23px]" : "left-[3px]"}`} />
                          </button>
                        </div>
                      )}

                      {/* Stacked options — each row opens its respective page. */}
                      <div className="mt-2 flex flex-col gap-2.5">
                        <button
                          onClick={() => setAcctView("about")}
                          className="flex w-full items-center justify-between rounded-2xl border border-white/[0.09] bg-white/[0.03] px-4 py-4 text-left transition-colors hover:bg-white/[0.06]"
                        >
                          <span className="text-[15px] text-white">About</span>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/40" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
                        </button>
                        <a
                          href="/privacy"
                          className="flex w-full items-center justify-between rounded-2xl border border-white/[0.09] bg-white/[0.03] px-4 py-4 transition-colors hover:bg-white/[0.06]"
                        >
                          <span className="text-[15px] text-white">Privacy Policy</span>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/40" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
                        </a>
                        <button
                          onClick={() => { setAcctView("delete"); setAcctDeleteError(false); }}
                          className="flex w-full items-center justify-between rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] px-4 py-4 text-left transition-colors hover:bg-rose-500/[0.09]"
                        >
                          <span className="text-[15px] text-rose-300">Delete Account</span>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-rose-300/50" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
                        </button>
                      </div>
                    </>
                  ) : acctView === "about" ? (
                    <>
                      <button onClick={() => setAcctView("menu")} className="-ml-1 flex items-center gap-1 self-start text-[14px] text-white/55 transition-colors hover:text-white">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
                        Account
                      </button>
                      <h2 className="text-[22px] font-semibold text-white">About</h2>
                      <p className="text-[14px] leading-relaxed text-[#a8a8a8]">
                        Thesis is for informational purposes only and is not investment, financial, or trading
                        advice. Prediction-market data is informational; Thesis is not a broker-dealer and does not
                        execute trades or bets. Do your own research.
                      </p>
                    </>
                  ) : (
                    // Delete Account page — App Store Guideline 5.1.1(v). Opening this page is the deliberate
                    // step; the button below performs the permanent, irreversible deletion.
                    <>
                      <button onClick={() => setAcctView("menu")} className="-ml-1 flex items-center gap-1 self-start text-[14px] text-white/55 transition-colors hover:text-white">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
                        Account
                      </button>
                      <h2 className="text-[22px] font-semibold text-white">Delete Account</h2>
                      <p className="text-[14px] leading-relaxed text-[#a8a8a8]">
                        This permanently deletes your account and all of your data — your portfolio, theses, and
                        settings. This can&apos;t be undone.
                      </p>
                      {acctDeleteError && (
                        <p className="text-[13px] text-rose-300">Couldn&apos;t delete your account. Please try again.</p>
                      )}
                      <button
                        onClick={handleDeleteAccount}
                        disabled={acctDeleting}
                        className="mt-1 self-start rounded-full bg-rose-500 px-6 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-rose-400 disabled:opacity-60"
                      >
                        {acctDeleting ? "Deleting…" : "Delete everything"}
                      </button>
                    </>
                  )}
                </div>
              ) : (
                // "Account" tab, signed out — the sign-in page: both options (Apple + Google), equal
                // prominence, before the fold (App Store Guideline 4.8 / Apple HIG).
                <div className="flex min-h-[calc(100dvh-180px)] flex-col items-center justify-center gap-9 px-6">
                  <div className="text-center">
                    <p className="text-[25px] font-medium text-white">Log in or sign up</p>
                    <p className="mx-auto mt-3.5 max-w-[300px] text-[18.5px] leading-snug text-[#bcbcbc]">
                      {"You'll get access to a customizable portfolio, a daily brief, insights, and more."}
                    </p>
                  </div>
                  {/* Same as the sign-up gate: a new user who signs in here lands in onboarding. In prod
                      that's driven by new-user detection after real auth (see the portfolio-load effect);
                      DEV_SKIP_AUTH lets the flow be previewed without signing in. */}
                  <SignInButtons onOverride={DEV_SKIP_AUTH ? () => setOnboarding(true) : undefined} />
                </div>
              )
            ) : mobilePage === "portfolio" ? (
              // "Portfolio" tab — before the first brief exists, serve the waiting screen; otherwise the
              // ledger embedded straight on the black background (no card): tap a holding to expand-edit
              // it, swipe to remove. Drives every other card + the agent. Pull down to refresh prices.
              showFirstBriefWait ? (
                <FirstBriefWaiting />
              ) : (
              <PullToRefresh onRefresh={refreshPrices}>
                <div className={`px-4 pt-[calc(env(safe-area-inset-top)+16px)] ${nativeChrome ? "pb-[calc(env(safe-area-inset-bottom)+76px)]" : "pb-[calc(env(safe-area-inset-bottom)+96px)]"}`}>
                  <PortfolioLedger
                    data={ledger}
                    onChange={setLedger}
                    readOnly={!authed && !onboarded}
                    refreshSignal={priceRefresh}
                    onRefreshed={() => { priceRefreshResolve.current?.(); priceRefreshResolve.current = null; }}
                  />
                </div>
              </PullToRefresh>
              )
            ) : showFirstBriefWait ? (
              // "Dashboard" tab, waiting — the sub-tab slider floats at the top (absolute) so the centered
              // waiting block lands at the SAME viewport position as on Brief/Portfolio (no slider offset).
              <div className="relative">
                {!nativeChrome && (
                  <div className="absolute inset-x-0 top-0 z-10 px-3.5 pt-[calc(env(safe-area-inset-top)+16px)]">
                    <DashboardTabs active={dashTab} onChange={setDashTab} />
                  </div>
                )}
                <FirstBriefWaiting />
              </div>
            ) : (
              // "Dashboard" tab — the sub-tab slider over the three sliding sub-tabs of content.
              <div className={`flex flex-col gap-3.5 px-3.5 ${nativeChrome ? "pt-[calc(env(safe-area-inset-top)+64px)] pb-[calc(env(safe-area-inset-bottom)+76px)]" : "pt-[calc(env(safe-area-inset-top)+16px)] pb-[calc(env(safe-area-inset-bottom)+96px)]"}`}>
              {/* Native shell draws its own Dashboard slider at the top; hide ours there. */}
              {!nativeChrome && <DashboardTabs active={dashTab} onChange={setDashTab} />}
              <>

              {/* Overview — portfolio allocation + efficient frontier + correlations + a model read. */}
              {dashTab === "overview" && <PortfolioOverview holdings={ledger.holdings} user={userId ?? undefined} />}

              {/* News — Portfolio Headlines embedded straight on the background. Tapping a headline
                  opens the article as a blurred full-screen overlay (rendered below), not inline. */}
              {dashTab === "news" && (
                <PullToRefresh onRefresh={refreshNews}>
                  <NewsAlertCard
                    embedded
                    query={newsQuery}
                    onOpenArticle={openArticle}
                    refreshSignal={newsRefresh}
                    onRefreshed={() => { newsRefreshResolve.current?.(); newsRefreshResolve.current = null; }}
                  />
                  <MobileDisclaimer />
                </PullToRefresh>
              )}

              {/* Prediction Markets — markets · macro · whale · chat · search, each immediately followed
                  by the cards it spawns, so a spawned card opens right after its origin. */}
              {dashTab === "markets" && (
                <>
                  <MobileSlot auto><WhaleCard /></MobileSlot>

                  <MobileSlot auto><PortfolioMarketsCard holdings={ledger.holdings} onOpenMarket={openMarket} onOpenEvent={openEvent} /></MobileSlot>
                  {openMarkets.map((m) => (
                    <MobileSlot key={m.market_id} h={560}><MarketDetailCard market={m} onClose={() => closeMarket(m.market_id)} /></MobileSlot>
                  ))}

                  {macroOpen && (
                    <MobileSlot auto><MacroSignalsCard onClose={closeMacro} onOpenEvent={openMacroEvent} /></MobileSlot>
                  )}
                  {openMacroEvents.map((ev) => (
                    <MobileSlot key={ev.eventKey} h={560}><MacroEventCard event={ev} onClose={() => closeMacroEvent(ev.eventKey)} /></MobileSlot>
                  ))}

                  {openEvents.map((ev) => (
                    <MobileSlot key={ev.event_id} h={600}><EventDetailCard event={ev} onClose={() => closeEvent(ev.event_id)} onOpenMarket={openMarket} /></MobileSlot>
                  ))}
                  <MobileDisclaimer />
                </>
              )}

              {/* Analyst Sentiment — one bordered card per holding (same sunset-glow border as the
                  portfolio's "Your Holdings" box). Card body is a shell for the sentiment content. */}
              {dashTab === "extra" && (
                <>
                  <MarketHoursPill />
                  {ledger.holdings.map((h, i) => {
                    const sym = (h.ticker || "").trim().toUpperCase();
                    const q = sentimentQuotes[sym];
                    const up = (q?.percent ?? 0) >= 0;
                    const rec = recommendations[sym];
                    const isOpen = openRatings.has(sym);
                    const maxCount = rec?.counts ? Math.max(1, rec.counts.strongBuy, rec.counts.buy, rec.counts.hold, rec.counts.sell, rec.counts.strongSell) : 1;
                    const met = metrics[sym];
                    const cur = q?.price ?? null;
                    const dayReady = q?.dayLow != null && q?.dayHigh != null && cur != null && q.dayHigh > q.dayLow;
                    const wk52Ready = met?.week52Low != null && met?.week52High != null && cur != null && met.week52High > met.week52Low;
                    return (
                      <div
                        key={`${h.ticker}-${i}`}
                        onClick={rec ? () => toggleRatings(sym) : undefined}
                        className={`relative w-full overflow-hidden rounded-2xl border border-white/[0.09] px-4 py-4 ${rec ? "cursor-pointer" : ""}`}
                        style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2), 0 0 0 1px rgba(255,255,255,0.05), 0 12px 40px -18px rgba(0,0,0,0.5)" }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[16px] font-medium leading-tight text-white">{h.ticker || "New holding"}</p>
                            {h.name && <p className="mt-0.5 truncate text-[13px] leading-tight text-[#8a8a8a]">{h.name}</p>}
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-[16px] leading-tight tabular-nums text-white">{fmtPrice(q?.price ?? null)}</p>
                            <p className={`mt-0.5 text-[13px] leading-tight tabular-nums ${q?.percent == null ? "text-[#8a8a8a]" : up ? "text-emerald-400" : "text-rose-400"}`}>
                              {fmtPct(q?.percent ?? null)}
                            </p>
                          </div>
                        </div>
                        {analystBriefs[sym] && (
                          <p className="mt-2.5 text-[15px] leading-snug text-white/75">{analystBriefs[sym]}</p>
                        )}
                        {rec && (
                          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                            <span className="text-[13px] text-[#8a8a8a]">Average Analyst Recommendation:</span>
                            <span
                              style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25)" }}
                              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[13px] font-medium ring-1 ring-white/15 backdrop-blur-md ${recColor(rec.label)}`}
                            >
                              {rec.label}
                            </span>
                          </div>
                        )}

                        {/* Current-month analyst ratings breakdown (Finnhub-native buckets) — tap to reveal. */}
                        {rec?.counts && isOpen && (
                          <div className="mt-3.5 flex flex-col gap-1 border-t border-white/[0.08] pt-3.5">
                            {RATING_ROWS.map(([label, keyName]) => {
                              const c = rec.counts[keyName];
                              return (
                                <div key={keyName} className="flex items-center gap-2.5">
                                  <span className="w-[76px] shrink-0 text-[11px] text-white/70">{label}</span>
                                  <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-[3px] bg-white/[0.05]">
                                    <div
                                      className="h-full rounded-[3px]"
                                      style={{ width: `${(c / maxCount) * 100}%`, background: "#b7bac2" }}
                                    />
                                  </div>
                                  <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-white/70">{c}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Combined 52-week + day range slider (Finnhub-sourced). Falls back to a day-only
                            slider when the 52-week range isn't available. */}
                        {isOpen && (dayReady || wk52Ready) && (
                          <div className="mt-3.5 border-t border-white/[0.08] pt-3.5">
                            {wk52Ready ? (
                              <CombinedRangeSlider week52Low={met!.week52Low!} week52High={met!.week52High!} cur={cur!} dayLow={q?.dayLow} dayHigh={q?.dayHigh} />
                            ) : (
                              <RangeSlider label="Day Range" low={q!.dayLow!} cur={cur!} high={q!.dayHigh!} />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {ledger.holdings.length === 0 && (
                    <p className="px-1 pt-6 text-center text-[13px] text-[#8a8a8a]">Add holdings on the Portfolio tab to see analyst sentiment.</p>
                  )}
                  <MobileDisclaimer />
                </>
              )}
                </>
              </div>
            )}

            {/* Article reader — a blurred overlay that brings the piece to the foreground and blurs
                everything behind it. It sits BELOW the nav (z-40 < nav's z-50) so the floating nav
                stays sharp and on top; the panel is pushed down to clear the pill. Tap backdrop to close. */}
            {openArticles.length > 0 && (() => {
              const a = openArticles[openArticles.length - 1];
              return (
                <div
                  className="fade-in fixed inset-0 z-40 flex items-start justify-center px-4 pb-4 pt-[92px]"
                  style={{ backgroundColor: "rgba(6,6,9,0.58)", backdropFilter: "blur(30px) saturate(165%)", WebkitBackdropFilter: "blur(30px) saturate(165%)" }}
                  onClick={() => closeArticle(a.id)}
                >
                  <div className="relative h-[calc(100dvh-108px)] max-h-[760px] w-full max-w-[440px]" onClick={(e) => e.stopPropagation()}>
                    <ArticleCard item={a} onClose={() => closeArticle(a.id)} />
                  </div>
                </div>
              );
            })()}
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
            <LedgerCard data={ledger} editable={authed || onboarded} onChange={setLedger} x={homeL.ledger.x} y={homeL.ledger.y} width={homeL.ledger.w} height={homeL.ledger.h} />
            <ThesisMonitorCard user={monitorUser} x={homeL.monitor.x} y={homeL.monitor.y} width={homeL.monitor.w} height={homeL.monitor.h} />
            <PortfolioMarketsCard holdings={ledger.holdings} x={homeL.markets.x} y={homeL.markets.y} width={homeL.markets.w} height={homeL.markets.h} onOpenMarket={openMarket} onOpenEvent={openEvent} />
            <WhaleCard x={homeL.whale.x} y={homeL.whale.y} width={homeL.whale.w} height={homeL.whale.h} />
            <OddpoolChatCard portfolio={portfolioCtx} x={homeL.chat.x} y={homeL.chat.y} width={homeL.chat.w} height={homeL.chat.h} />
            <MarketHoursCard x={homeL.hours.x} y={homeL.hours.y} width={homeL.hours.w} height={homeL.hours.h} />
            <NewsAlertCard query={newsQuery} onOpenArticle={openArticle} x={homeL.news.x} y={homeL.news.y} width={homeL.news.w} height={homeL.news.h} />
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
          </div>
        )}
      </main>

      {menu && <ContextMenu x={menu.vx} y={menu.vy} items={menuItems} onClose={() => setMenu(null)} />}

      {/* Sign-up gate for logged-out visitors — slides in 7s after the session resolves to a guest, so they
          can explore first. "Sign up now" flips the card to Google/Apple sign-in; "later" dismisses it. */}
      {status === "unauthenticated" && !signupDismissed && signupReady && (
        <SignupScreen
          onLater={() => setSignupDismissed(true)}
          onSignedIn={() => { setSignupDismissed(true); setOnboarding(true); }}
        />
      )}

      {/* New-user onboarding wizard (name → portfolio → theses → risk → permissions → done). Launched for a
          freshly signed-in NEW user; ?onboard=1 forces it for local preview. */}
      {onboarding && (
        <Onboarding
          initialName={(session?.user?.name || "").trim().split(/\s+/)[0] || ""}
          onClose={() => setOnboarding(false)}
          onComplete={(profile) => {
            try {
              localStorage.setItem(onboardingSeenKey(userId), JSON.stringify({ ...profile, holdings: undefined }));
            } catch {}
            // Persist the chosen name to the account so a later sign-in (esp. a beta code, which has no
            // OAuth name) retrieves it, and reflect it in the current session immediately.
            const nm = profile.name.trim();
            if (nm && authed) {
              fetch("/api/profile/name", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: nm }) }).catch(() => {});
              void updateSession?.({ name: nm })?.catch(() => {});
            }
            if (profile.ledger) setLedger(profile.ledger);
            setLedgerScope(scope); // onboarding done → promote off the display-only sentinel so this account's portfolio persists + syncs to Turso
            setOnboarded(true); // holdings + theses now belong to a real (set-up) portfolio → editable, drives every card
            setOnboarding(false);
            setAwaitedAfterOnboard(true); // → the "first brief" countdown until their brief is generated
            setMobilePage("brief"); // where they land once the countdown clears
            window.scrollTo({ top: 0 });
          }}
        />
      )}

      {/* First-launch brand moment — self-gates on localStorage, morphs into the nav wordmark. */}
      <ThesisIntro />
    </div>
  );
}
