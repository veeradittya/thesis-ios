"use client";

// Hivemind — the market-pulse page. One place to read the pulse of the whole portfolio and
// every holding across ALL signals we collect: the daily analyst research, analyst consensus,
// Reddit chatter, YouTube coverage, prediction markets, news, and price action.
//
// Layout:
//   • HERO       — a pulse orb (sentiment aura) + live market-hours clock + a one-line read.
//   • HOLDINGS   — one card per holding: cross-signal overview + a full signal breakdown.
//   • OPPORTUNITIES — tickers you don't hold that are lighting up the social/market feeds.
//
// All synthesis (the pulse + the plain-language overview) lives in src/lib/hivemind.ts so the
// deterministic read here can later be swapped for an LLM without touching this file.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  ChevronDown,
  ExternalLink,
  LineChart,
  MessageCircle,
  Newspaper,
  Radio,
  SlidersHorizontal,
  TrendingUp,
  Users,
  Video,
} from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";
import { computeMarketState } from "@/lib/marketHours";
import type { RedditSocialResponse, RedditSocialSnapshot } from "@/lib/redditSocial";
import type { YouTubeSocialResponse, YouTubeSocialVideo } from "@/lib/youtubeSocial";
import {
  aggregatePortfolioPulse,
  assetAction,
  assetConviction,
  assetNotability,
  marketsOverview,
  newsOverview,
  signalLean,
  synthesizeAsset,
  youtubeLean,
  type AssetAction,
  type AssetConviction,
  type AssetMarket,
  type AssetPulse,
  type AssetSignals,
  type BriefFact,
  type PortfolioPulse,
  type SignalLean,
} from "@/lib/hivemind";

type PointAction = AssetAction["label"];
type BriefPoint = { short: string; detail: string; facts?: BriefFact[]; action?: PointAction };
type OverviewData = { headline: string | null; points: BriefPoint[] | null };

// House style: the tilde never appears in any overview text (write "about"/"around"). Applied at the
// render sites so it holds regardless of which agent or source produced the string.
const noTilde = (s?: string | null): string => (s ? s.replace(/~\s*/g, "about ") : "");

// The liquid-glass sheen shared by every dashboard card (matches the Analyst Sentiment cards).
const SHEEN = "inset 0 1px 0 rgba(255,255,255,0.2), 0 0 0 1px rgba(255,255,255,0.05), 0 12px 40px -18px rgba(0,0,0,0.5)";
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

// ---------------------------------------------------------------------------------------
// API response shapes we consume (see src/lib/*.ts + the route files).
// ---------------------------------------------------------------------------------------
interface Quote { symbol: string; price: number | null; percent: number | null; dayLow?: number | null; dayHigh?: number | null }
interface RecCounts { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number }
interface Rec { label: string; score: number; analysts: number; period: string; counts: RecCounts }
interface Metric { week52High: number | null; week52Low: number | null }
interface MonitorResult { ticker: string; name: string; verdict: string; risk: number | null; rationale: string; signals: string; researchedAt: string }
interface MonitorPayload { memo: string | null; updatedAt: string | null; results: MonitorResult[] }
interface NewsArticle { id: string; ticker: string; provider: string; source: string; headline: string; summary: string; url: string; image: string | null; datetime: number }
interface MarketOutcome { market_id: string; question: string; label: string; yes: number | null; volume: number | null; liquidity: number | null }
interface MarketEvent { event_id: string; exchange: string; title: string; category: string | null; single: boolean; yes: number | null; volume: number | null; outcomes: MarketOutcome[] }
interface MarketsAsset { ticker: string; label: string; count: number; events: MarketEvent[] }
interface MarketsPayload { assets: MarketsAsset[] }

// FMP analyst price-target consensus for a ticker.
interface TargetWindow { avg: number | null; count: number | null }
interface PriceTarget {
  high: number | null; low: number | null; consensus: number | null; median: number | null;
  trend: { year: TargetWindow; quarter: TargetWindow; month: TargetWindow } | null;
}

interface Bundle {
  quotes: Record<string, Quote>;
  recs: Record<string, Rec>;
  targets: Record<string, PriceTarget>;
  metrics: Record<string, Metric>;
  briefs: Record<string, string>;
  monitor: Record<string, MonitorResult>;
  memo: string | null;
  reddit: RedditSocialSnapshot[];
  redditStale: boolean;
  youtube: Record<string, YouTubeSocialVideo[]>;
  youtubeLeans: Record<string, string>; // agent's per-ticker youtube lean
  youtubeSummaries: Record<string, string>; // agent's per-ticker youtube overview
  news: Record<string, NewsArticle[]>;
  newsOverviews: Record<string, string>; // news agent's per-ticker overview
  newsLeans: Record<string, string>; // news agent's per-ticker lean
  markets: Record<string, MarketsAsset>;
  generatedAt: string | null;
}

const EMPTY_BUNDLE: Bundle = {
  quotes: {}, recs: {}, targets: {}, metrics: {}, briefs: {}, monitor: {}, memo: null,
  reddit: [], redditStale: false, youtube: {}, youtubeLeans: {}, youtubeSummaries: {}, news: {}, newsOverviews: {}, newsLeans: {}, markets: {}, generatedAt: null,
};

// ---------------------------------------------------------------------------------------
// fetch helper — always resolves (never throws), with a per-call timeout so one hung
// live-only feed (markets, news) can't wedge the whole page.
// ---------------------------------------------------------------------------------------
async function safeJSON<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T | null> {
  const { timeoutMs = 12000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctrl.signal, ...rest });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const norm = (t: string) => t.trim().toUpperCase();

// ---------------------------------------------------------------------------------------
// Small shared UI atoms
// ---------------------------------------------------------------------------------------
function GlassCard({ children, className = "", style, onClick }: { children: React.ReactNode; className?: string; style?: React.CSSProperties; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={`relative overflow-hidden rounded-2xl border border-white/[0.09] ${className}`} style={{ boxShadow: SHEEN, ...style }}>
      {children}
    </div>
  );
}

// The directional read for a single signal family (Strong Buy … Strong Sell), inferred from its raw data.
const LEAN_STYLE: Record<SignalLean, string> = {
  "Strong Buy": "text-emerald-400/75",
  Buy: "text-emerald-400/75",
  Neutral: "text-white/40",
  Sell: "text-rose-400/80",
  "Strong Sell": "text-rose-400/80",
};
function LeanTag({ lean }: { lean: SignalLean }) {
  return <span className={`shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] ${LEAN_STYLE[lean]}`}>{lean}</span>;
}

// v1: how many INDEPENDENT, reliable signals agree — separates real signal from crowd noise.
function ConvictionBadge({ c }: { c: AssetConviction }) {
  const label = c.redditOnly ? "Unconfirmed" : c.level === "high" ? "High conviction" : c.level === "medium" ? "Some conviction" : "Low conviction";
  const dots = c.redditOnly ? 0 : c.level === "high" ? 3 : c.level === "medium" ? 2 : 1;
  const color = c.redditOnly ? "bg-amber-300/70" : c.level === "high" ? "bg-emerald-300" : c.level === "medium" ? "bg-white/60" : "bg-white/35";
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-white/40" title={c.redditOnly ? "Only Reddit chatter backs this" : `${c.agree} of ${c.total} reliable signals agree`}>
      <span className="flex items-center gap-0.5">
        {[0, 1, 2].map((i) => <span key={i} className={`h-1.5 w-1.5 rounded-full ${i < dots ? color : "bg-white/[0.12]"}`} />)}
      </span>
      {label}
    </span>
  );
}

// Collapsible sub-section inside a holding's signal breakdown.
function SignalSection({ icon, title, meta, children, defaultOpen = false }: { icon: React.ReactNode; title: string; meta?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl bg-white/[0.025]">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left">
        <span className="text-white/45">{icon}</span>
        <span className="text-[13px] font-medium text-white/85">{title}</span>
        {meta}
        <ChevronDown className={`ml-auto h-3.5 w-3.5 text-white/40 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="px-3 pb-3.5 pt-0.5">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// HERO — pulse orb + market clock + one-line read
// ---------------------------------------------------------------------------------------
// The ThinkingOrb ships monochrome (white ink on a transparent canvas, no color prop). We recolor
// the dots to the pulse colour with a multiply overlay: multiply(white dot, tint) = tint, while the
// transparent gaps multiply against the near-black card (#0e0e0e) and stay dark — so only the dots
// pick up colour, no visible square.
function PulseOrb({ tint, speed, active }: { tint: string; speed: number; active: boolean }) {
  return (
    <div className="relative h-16 w-16 shrink-0">
      <ThinkingOrb state="solving" size={64} speed={speed} theme="dark" />
      {/* Only tint the orb while the market is open; otherwise leave it plain white. */}
      {active && <div className="pointer-events-none absolute inset-0" style={{ background: tint, mixBlendMode: "multiply" }} />}
    </div>
  );
}

const HIVEMIND_INFO = "Hivemind is a reflection of the world's thinking. It ingests petabytes of qualitative and quantitative data every second, across mainstream and niche sources and tracks the pulse of the market in real time.";

function Hero({ pulse, points }: { pulse: ReturnType<typeof aggregatePortfolioPulse>; points: BriefPoint[] | null }) {
  const [showInfo, setShowInfo] = useState(false);
  const [openPoint, setOpenPoint] = useState<number | null>(null); // level 2: which notification's body is open
  const [openFacts, setOpenFacts] = useState<number | null>(null); // level 3: which notification's facts are open
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = now ? computeMarketState(now) : null;
  const statusColor = !s ? "text-[#8a8a8a]" : s.phase === "open" ? "text-emerald-400" : "text-rose-500";

  return (
    <GlassCard className="px-4 py-4">
      {/* info tag — top-right corner of the card */}
      <button
        type="button"
        onClick={() => setShowInfo((v) => !v)}
        aria-label="What is Hivemind?"
        className={`absolute right-3 top-3 z-10 grid h-[15px] w-[15px] place-items-center rounded-full border text-[9.5px] font-semibold transition-colors ${showInfo ? "border-white/40 text-white/80" : "border-white/25 text-white/45 hover:text-white/70"}`}
      >
        i
      </button>
      <div className="flex items-center gap-4">
        <PulseOrb tint={pulse.tint} speed={pulse.speed} active={s?.phase === "open"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-0.5 text-[13.8px] leading-tight" style={{ fontFamily: "var(--font-inter)" }}>
            <span className="text-[16.42px] uppercase tracking-[0.15em] text-white">Hivemind</span>
            <span className={statusColor}>NYSE · Nasdaq</span>
            <span className="text-[12.42px] text-[#8a8a8a]"><span className="tabular-nums text-white/85">{s ? s.clock : " "}</span> ET</span>
            {s && <span className="text-[12.42px] text-[#8a8a8a]">{s.countdownLabel} {s.countdownText}</span>}
          </div>
        </div>
      </div>
      {showInfo && (
        <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-[12.5px] leading-relaxed text-white/65">
          {HIVEMIND_INFO}
        </div>
      )}
      {/* Notifications live inside this card: each a tap-to-expand takeaway with the facts behind it.
          Until the real (LLM-written) read lands, pulse skeleton rows — never deterministic fallback text. */}
      <ul className="mt-3.5 space-y-1">
        {points === null ? (
          ["86%", "72%", "90%", "64%"].map((w, i) => (
            <li key={i} className="py-1.5">
              <div className="h-[13px] animate-pulse rounded bg-white/[0.06]" style={{ width: w, animationDelay: `${i * 120}ms` }} />
            </li>
          ))
        ) : (
          points.map((pt, i) => {
          const showDetail = openPoint === i;
          const showFacts = openFacts === i;
          const hasFacts = !!pt.facts && pt.facts.length > 0;
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => { setOpenPoint((v) => (v === i ? null : i)); setOpenFacts(null); }}
                aria-expanded={showDetail}
                className="block w-full py-1 text-left"
              >
                <span className="block text-[14.58px] leading-snug text-white/85">{noTilde(pt.short)}</span>
              </button>
              {showDetail && (
                <div className="mb-1.5 mr-1 pt-0.5">
                  <button
                    type="button"
                    onClick={() => hasFacts && setOpenFacts((v) => (v === i ? null : i))}
                    aria-expanded={showFacts}
                    className={`flex w-full items-start gap-2 text-left ${hasFacts ? "" : "cursor-default"}`}
                  >
                    <span className="flex-1 text-[12.5px] leading-relaxed text-white/65">{noTilde(pt.detail)}</span>
                    {hasFacts && <ChevronDown className={`mt-[3px] h-3 w-3 shrink-0 text-white/30 transition-transform ${showFacts ? "rotate-180" : ""}`} />}
                  </button>
                  {showFacts && hasFacts && (
                    <div className="mt-2 space-y-2 rounded-lg bg-white/[0.03] px-3 py-2.5">
                      <p className="text-[10px] uppercase tracking-[0.12em] text-[#737373]">The facts</p>
                      {pt.facts!.map((f, j) =>
                        f.url ? (
                          <a key={j} href={f.url} target="_blank" rel="noreferrer" className="group flex items-start gap-1.5 text-[12px] leading-relaxed text-white/70 hover:text-white/90">
                            <span className="underline decoration-white/20 underline-offset-2 transition-colors group-hover:decoration-white/50">{f.text}</span>
                            <ExternalLink className="mt-[3px] h-3 w-3 shrink-0 text-white/35 group-hover:text-white/60" />
                          </a>
                        ) : (
                          <p key={j} className="text-[12px] leading-relaxed text-white/60">{f.text}</p>
                        ),
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
          })
        )}
      </ul>
    </GlassCard>
  );
}

// ---------------------------------------------------------------------------------------
// Signal breakdown blocks
// ---------------------------------------------------------------------------------------
// Map a Wall-Street consensus label to the shared 5-point signal vocabulary (Hold → Neutral), so the
// consensus tag renders identically to the other signal LeanTags.
function recToLean(label: string): SignalLean {
  return label === "Strong Buy" ? "Strong Buy" : label === "Buy" ? "Buy" : label === "Sell" ? "Sell" : label === "Strong Sell" ? "Strong Sell" : "Neutral";
}
const RATING_ROWS: Array<[string, keyof RecCounts]> = [["Strong Buy", "strongBuy"], ["Buy", "buy"], ["Hold", "hold"], ["Sell", "sell"], ["Strong Sell", "strongSell"]];

// A tiny line chart of the average analyst target over trailing windows (Year → Quarter → Month),
// so the direction the consensus target is moving is visible at a glance.
function TargetTrend({ trend }: { trend: NonNullable<PriceTarget["trend"]> }) {
  const pts = [
    { label: "Year", w: trend.year },
    { label: "Quarter", w: trend.quarter },
    { label: "Month", w: trend.month },
  ].filter((p): p is { label: string; w: { avg: number; count: number | null } } => p.w.avg != null && p.w.avg > 0);
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.w.avg);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = (max - min) * 0.4 || max * 0.05 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const W = 300;
  const H = 78;
  const padX = 30;
  const padTop = 16;
  const padBot = 18;
  const x = (i: number) => padX + (i * (W - 2 * padX)) / (pts.length - 1);
  const y = (v: number) => padTop + (1 - (v - lo) / (hi - lo || 1)) * (H - padTop - padBot);
  const up = vals[vals.length - 1] >= vals[0];
  const stroke = up ? "rgba(52,211,153,0.75)" : "rgba(251,113,133,0.75)";
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.w.avg).toFixed(1)}`).join(" ");
  return (
    <div className="mt-2.5" style={{ maxWidth: 320 }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Average analyst price target over the last year, quarter and month">
        <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p, i) => (
          <g key={p.label}>
            <circle cx={x(i)} cy={y(p.w.avg)} r="2.6" fill={stroke} />
            <text x={x(i)} y={y(p.w.avg) - 6} textAnchor="middle" fontSize="10" fill="rgba(255,255,255,0.82)">${Math.round(p.w.avg)}</text>
            <text x={x(i)} y={H - 5} textAnchor="middle" fontSize="9" fill="#737373">{p.label}</text>
          </g>
        ))}
      </svg>
      <p className="mt-1 text-right text-[10px] text-[#737373]">Avg analyst target, trailing window</p>
    </div>
  );
}

function AnalystBlock({ monitor, rec, brief, target, price }: { monitor?: MonitorResult; rec?: Rec; brief?: string; target?: PriceTarget; price?: number | null }) {
  const maxCount = rec?.counts ? Math.max(1, ...Object.values(rec.counts)) : 1;
  // The agent's research narrative (markdown links flattened to plain text).
  const rationale = (monitor?.rationale || brief || "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
  const hasTarget = !!target && (target.consensus != null || target.high != null);
  const upside = hasTarget && target!.consensus != null && price != null && price > 0 ? (target!.consensus - price) / price : null;
  return (
    <div className="space-y-3">
      {rationale && (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-[#737373]">Thesis Research</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-white/70">{noTilde(rationale)}</p>
        </div>
      )}
      {hasTarget && (
        <div>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <p className="text-[11px] uppercase tracking-wide text-[#737373]">Price target</p>
            {upside != null && <span className={`text-[11px] tabular-nums ${upside >= 0 ? "text-emerald-400/80" : "text-rose-400/80"}`}>{upside >= 0 ? "+" : ""}{(upside * 100).toFixed(0)}% {upside >= 0 ? "upside" : "downside"} from avg</span>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[13px]">
            {target!.consensus != null && <span className="font-medium tabular-nums text-white/85">${target!.consensus.toFixed(0)} <span className="text-[11px] font-normal text-[#737373]">avg</span></span>}
            {target!.median != null && <span className="tabular-nums text-white/65">${target!.median.toFixed(0)} <span className="text-[11px] text-[#737373]">median</span></span>}
            {target!.low != null && <span className="tabular-nums text-white/55">${target!.low.toFixed(0)} <span className="text-[11px] text-[#737373]">low</span></span>}
            {target!.high != null && <span className="tabular-nums text-white/55">${target!.high.toFixed(0)} <span className="text-[11px] text-[#737373]">high</span></span>}
          </div>
          {target!.trend && <TargetTrend trend={target!.trend} />}
        </div>
      )}
      {rec && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[12px] text-[#8a8a8a]">Consensus <LeanTag lean={recToLean(rec.label)} />{rec.analysts ? <span className="text-[#737373]">· {rec.analysts} analysts</span> : null}</div>
          <div className="flex flex-col gap-1">
            {RATING_ROWS.map(([label, key]) => (
              <div key={key} className="flex items-center gap-2.5">
                <span className="w-[68px] shrink-0 text-[10px] text-white/60">{label}</span>
                <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-[3px] bg-white/[0.05]"><div className="h-full rounded-[3px]" style={{ width: `${(rec.counts[key] / maxCount) * 100}%`, background: "#b7bac2" }} /></div>
                <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-white/60">{rec.counts[key]}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!rationale && !rec && <p className="text-[12px] text-[#737373]">No research yet for this ticker.</p>}
    </div>
  );
}

function RedditBlock({ snap }: { snap: RedditSocialSnapshot }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="mentions" value={compact.format(snap.mentions)} />
        <Stat label="voices" value={compact.format(snap.uniqueAuthors)} icon={<Users className="h-3 w-3 text-white/45" />} />
        <Stat label="threads" value={compact.format(snap.uniqueThreads)} icon={<MessageCircle className="h-3 w-3 text-white/45" />} />
      </div>
      {snap.summary && <p className="text-[13px] leading-relaxed text-white/70">{noTilde(snap.summary)}</p>}
      {snap.topSources.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-[0.12em] text-[#737373]">Open discussions</p>
          {snap.topSources.map((src) => (
            <a key={src.url} href={src.url} target="_blank" rel="noreferrer" className="flex items-start justify-between gap-3 rounded-lg bg-white/[0.035] px-3 py-2">
              <span className="min-w-0"><span className="block text-[12px] leading-snug text-white/80">{src.title}</span><span className="mt-0.5 block text-[10px] text-[#737373]">r/{src.subreddit} · {compact.format(src.score)} pts</span></span>
              <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/35" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div>
      <p className="flex items-center gap-1 text-[15px] tabular-nums text-white">{icon}{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-[#737373]">{label}</p>
    </div>
  );
}

// One short overview of the YouTube signal for the asset, then the relevant videos listed (no
// per-video summaries — the agent only produces the ticker-level overview).
function YouTubeBlock({ videos, overview }: { videos: YouTubeSocialVideo[]; overview?: string | null }) {
  return (
    <div className="space-y-2.5">
      {overview && <p className="text-[13px] leading-relaxed text-white/70">{noTilde(overview)}</p>}
      <div className="space-y-1.5">
        {videos.map((v) => (
          <a key={v.videoId} href={v.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg bg-white/[0.035] p-2 transition-colors hover:bg-white/[0.06]">
            <div className="relative h-[44px] w-[74px] shrink-0 overflow-hidden rounded-md bg-white/[0.05]">
              {v.thumbnailUrl ? <img src={v.thumbnailUrl} alt="" className="h-full w-full object-cover" /> : <Video className="absolute inset-0 m-auto h-4 w-4 text-white/25" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[12px] font-medium leading-snug text-white/85">{v.title}</p>
              <p className="mt-0.5 truncate text-[10px] text-[#8a8a8a]">{v.channel}</p>
            </div>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-white/30" />
          </a>
        ))}
      </div>
    </div>
  );
}

function MarketsBlock({ asset }: { asset: MarketsAsset }) {
  return (
    <div className="space-y-2.5">
      <p className="text-[13px] leading-relaxed text-white/70">{noTilde(marketsOverview(flattenMarkets(asset)))}</p>
      {asset.events.slice(0, 5).map((ev) => {
        const rows = ev.single || !ev.outcomes.length
          ? [{ q: ev.title, yes: ev.yes }]
          : ev.outcomes.slice(0, 4).map((o) => ({ q: o.question || o.label, yes: o.yes }));
        return (
          <div key={ev.event_id} className="rounded-lg bg-white/[0.035] px-3 py-2.5">
            {!ev.single && ev.outcomes.length > 0 && <p className="mb-1.5 text-[12px] font-medium text-white/80">{ev.title}</p>}
            <div className="space-y-2.5">
              {rows.map((r, i) => (
                <div key={i}>
                  <p className="text-[12px] leading-snug text-white/75">{r.q}</p>
                  {r.yes != null && (
                    <div className="mt-1 flex items-center gap-4 text-[11px] font-medium tabular-nums">
                      <span className="text-emerald-300">Yes {Math.round(r.yes * 100)}%</span>
                      <span className="text-rose-300">No {Math.round((1 - r.yes) * 100)}%</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NewsBlock({ articles, overview }: { articles: NewsArticle[]; overview?: string }) {
  // Prefer the news agent's overview; fall back to the deterministic headline read when absent.
  const read = overview || newsOverview(articles.map((a) => a.headline), articles.length);
  return (
    <div className="space-y-2">
      <p className="text-[13px] leading-relaxed text-white/70">{noTilde(read)}</p>
      {articles.slice(0, 6).map((a) => (
        <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="flex items-start justify-between gap-3 rounded-lg bg-white/[0.035] px-3 py-2">
          <span className="min-w-0">
            <span className="block text-[12px] leading-snug text-white/80">{a.headline}</span>
            <span className="mt-0.5 block text-[10px] text-[#737373]">{a.source} · {relTime(a.datetime)}</span>
          </span>
          <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/35" />
        </a>
      ))}
    </div>
  );
}

function PriceRange({ quote, metric }: { quote?: Quote; metric?: Metric }) {
  const cur = quote?.price ?? null;
  if (cur == null) return <p className="text-[12px] text-[#737373]">No live quote.</p>;
  const lo = metric?.week52Low ?? quote?.dayLow ?? null;
  const hi = metric?.week52High ?? quote?.dayHigh ?? null;
  if (lo == null || hi == null || hi <= lo) return <p className="text-[12px] text-[#737373]">Range unavailable.</p>;
  const span = hi - lo;
  const pos = (v: number) => Math.min(100, Math.max(0, ((v - lo) / span) * 100));
  const hasDay = quote?.dayLow != null && quote?.dayHigh != null && quote.dayHigh > quote.dayLow;
  const wk52 = metric?.week52Low != null && metric?.week52High != null;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]"><span className="text-[#8a8a8a]">{wk52 ? "52-week range" : "Day range"}</span><span className="tabular-nums text-white">{cur.toFixed(2)}</span></div>
      <div className="relative mt-2 h-3 rounded-[3px] bg-white/[0.08]">
        {hasDay && wk52 && <div className="absolute top-0 h-full rounded-[2px] bg-amber-400/45" style={{ left: `${pos(quote!.dayLow!)}%`, width: `${Math.max(2, pos(quote!.dayHigh!) - pos(quote!.dayLow!))}%` }} />}
        <div className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" style={{ left: `${pos(cur)}%`, boxShadow: "0 0 0 2px rgba(0,0,0,0.45)" }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-[#8a8a8a]"><span>Low <span className="tabular-nums text-white/85">{lo.toFixed(2)}</span></span><span>High <span className="tabular-nums text-white/85">{hi.toFixed(2)}</span></span></div>
    </div>
  );
}

function relTime(ms: number): string {
  const age = Date.now() - ms;
  if (!Number.isFinite(age) || age < 0) return "recently";
  const h = Math.floor(age / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// A compact coverage chip on the collapsed card — shows which families have data.
function CoverageChip({ icon, on, label }: { icon: React.ReactNode; on: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] ${on ? "bg-white/[0.06] text-white/70" : "text-white/20"}`} title={label}>
      {icon}
    </span>
  );
}

// ---------------------------------------------------------------------------------------
// Per-holding card
// ---------------------------------------------------------------------------------------
function HoldingCard({ pulse, overview, name, quote, monitor, rec, target, metric, brief, reddit, videos, ytLeanAgent, ytOverview, markets, news, newsSummary, action, conviction, defaultOpen }: {
  pulse: AssetPulse; overview?: string | null; name?: string | null; quote?: Quote; monitor?: MonitorResult; rec?: Rec; target?: PriceTarget; metric?: Metric;
  brief?: string; reddit?: RedditSocialSnapshot; videos?: YouTubeSocialVideo[]; ytLeanAgent?: string; ytOverview?: string; markets?: MarketsAsset; news?: NewsArticle[]; newsSummary?: string;
  action: AssetAction; conviction: AssetConviction; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const pct = quote?.percent ?? null;
  const up = (pct ?? 0) >= 0;
  const hasAnalyst = !!(monitor || rec || brief || target);
  const hasReddit = !!reddit && reddit.mentions > 0;
  const hasVideos = !!videos && videos.length > 0;
  const hasMarkets = !!markets && markets.events.length > 0;
  const hasNews = !!news && news.length > 0;

  // Per-signal directional lean (Strong Buy … Strong Sell), inferred from each family's raw data —
  // shown beside the signal name so the breakdown reads as "what each signal points to", not a count.
  const analystLean = signalLean(pulse, "analyst");
  const redditLean = signalLean(pulse, "reddit");
  const marketsLean = signalLean(pulse, "markets");
  const newsLean = signalLean(pulse, "news");
  const ytLean = youtubeLean(videos ?? [], ytLeanAgent);

  return (
    <GlassCard className="px-4 py-4">
      {/* header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[16px] font-medium leading-tight text-white">{pulse.ticker}</p>
          {name && <p className="mt-0.5 truncate text-[13px] leading-tight text-[#8a8a8a]">{name}</p>}
        </div>
        <div className="flex shrink-0 items-baseline gap-2.5">
          {quote?.price != null && (
            <div className="text-right">
              <p className="text-[15px] leading-tight tabular-nums text-white">{quote.price.toFixed(2)}</p>
              <p className={`text-[12px] leading-tight tabular-nums ${pct == null ? "text-[#8a8a8a]" : up ? "text-emerald-400" : "text-rose-400"}`}>{pct == null ? "" : `${up ? "+" : ""}${pct.toFixed(2)}%`}</p>
            </div>
          )}
        </div>
      </div>

      {/* v1: conviction — how many independent, reliable signals agree */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <ConvictionBadge c={conviction} />
      </div>

      {/* the cross-signal overview — LLM-written from the real signals; pulse skeleton lines until it lands */}
      {overview == null ? (
        <div className="mt-2.5 space-y-2" aria-hidden>
          {["100%", "94%", "68%"].map((w, i) => (
            <div key={i} className="h-[13px] animate-pulse rounded bg-white/[0.06]" style={{ width: w, animationDelay: `${i * 120}ms` }} />
          ))}
        </div>
      ) : (
        <p className="mt-2.5 text-[14px] leading-relaxed text-white/80">{noTilde(overview)}</p>
      )}

      {/* coverage rail + expand toggle */}
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-3 flex w-full items-center gap-1.5">
        <CoverageChip on={hasAnalyst} icon={<TrendingUp className="h-3 w-3" />} label="Analyst" />
        <CoverageChip on={hasReddit} icon={<MessageCircle className="h-3 w-3" />} label="Reddit" />
        <CoverageChip on={hasVideos} icon={<Video className="h-3 w-3" />} label="YouTube" />
        <CoverageChip on={hasMarkets} icon={<BarChart3 className="h-3 w-3" />} label="Markets" />
        <CoverageChip on={hasNews} icon={<Newspaper className="h-3 w-3" />} label="News" />
        <span className="ml-auto flex items-center gap-1 text-[11px] text-white/45">{open ? "Hide" : "Signal breakdown"}<ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} /></span>
      </button>

      {/* full breakdown */}
      {open && (
        <div className="mt-3 space-y-2 border-t border-white/[0.08] pt-3">
          <SignalSection icon={<TrendingUp className="h-3.5 w-3.5" />} title="Analyst" meta={analystLean && <LeanTag lean={analystLean} />} defaultOpen>
            <AnalystBlock monitor={monitor} rec={rec} brief={brief} target={target} price={quote?.price ?? null} />
          </SignalSection>
          {hasReddit && (
            <SignalSection icon={<MessageCircle className="h-3.5 w-3.5" />} title="Reddit" meta={redditLean && <LeanTag lean={redditLean} />}>
              <RedditBlock snap={reddit!} />
            </SignalSection>
          )}
          {hasVideos && (
            <SignalSection icon={<Video className="h-3.5 w-3.5" />} title="YouTube" meta={ytLean && <LeanTag lean={ytLean} />}>
              <YouTubeBlock videos={videos!} overview={ytOverview} />
            </SignalSection>
          )}
          {hasMarkets && (
            <SignalSection icon={<BarChart3 className="h-3.5 w-3.5" />} title="Prediction markets" meta={marketsLean && <LeanTag lean={marketsLean} />}>
              <MarketsBlock asset={markets!} />
            </SignalSection>
          )}
          {hasNews && (
            <SignalSection icon={<Newspaper className="h-3.5 w-3.5" />} title="News" meta={newsLean && <LeanTag lean={newsLean} />}>
              <NewsBlock articles={news!} overview={newsSummary} />
            </SignalSection>
          )}
          <SignalSection icon={<LineChart className="h-3.5 w-3.5" />} title="Price">
            <PriceRange quote={quote} metric={metric} />
          </SignalSection>
        </div>
      )}
    </GlassCard>
  );
}

type HoldingCardProps = React.ComponentProps<typeof HoldingCard>;

// v1: a quiet holding collapses to a single line (ticker · price · lean); tap to expand the full card.
function QuietHolding(props: HoldingCardProps) {
  const [expanded, setExpanded] = useState(false);
  if (expanded) return <HoldingCard {...props} defaultOpen={false} />;
  const { pulse, name, quote } = props;
  const pct = quote?.percent ?? null;
  const up = (pct ?? 0) >= 0;
  return (
    <button type="button" onClick={() => setExpanded(true)} aria-label={`Expand ${pulse.ticker}`} className="relative flex w-full items-center gap-3 overflow-hidden rounded-2xl border border-white/[0.07] px-4 py-2.5 text-left" style={{ boxShadow: SHEEN }}>
      <span className="text-[14px] font-medium text-white">{pulse.ticker}</span>
      {name && <span className="min-w-0 flex-1 truncate text-[12px] text-white/35">{name}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-2.5 tabular-nums">
        {quote?.price != null && (
          <>
            <span className="text-[13px] text-white/70">{quote.price.toFixed(2)}</span>
            <span className={`text-[11px] ${pct == null ? "text-white/40" : up ? "text-emerald-400/80" : "text-rose-400/80"}`}>{pct == null ? "" : `${up ? "+" : ""}${pct.toFixed(1)}%`}</span>
          </>
        )}
        <ChevronDown className="h-3.5 w-3.5 -rotate-90 text-white/25" />
      </span>
    </button>
  );
}

// v1: a small toggle pill for the global filter bar.
function TogglePill({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon?: React.ReactNode; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-medium transition-colors ${active ? "bg-white/[0.14] text-white ring-1 ring-white/20" : "bg-white/[0.05] text-white/50 ring-1 ring-white/10 hover:text-white/75"}`}
      style={active ? { boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2)" } : undefined}
    >
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------------------
// Live News — Bloomberg Television, streamed inline. "Attach" resolves the channel's current
// live broadcast (via /api/hivemind/live-news) and embeds it; the card expands to a 16:9 player.
// ---------------------------------------------------------------------------------------
const LIVE_NEWS_CHANNEL = "UCIALMKvObZNtJ6AmdCLP7Lg"; // Bloomberg Television
const LIVE_NEWS_URL = `https://www.youtube.com/channel/${LIVE_NEWS_CHANNEL}/live`;

function LiveNewsCard() {
  const [attached, setAttached] = useState(false);
  const [loading, setLoading] = useState(false);
  const [src, setSrc] = useState<string | null>(null); // embed URL when a live videoId resolved; null → external-link state
  const [watchUrl, setWatchUrl] = useState(LIVE_NEWS_URL); // "Watch on YouTube" link (opens externally)

  const attach = useCallback(async () => {
    setLoading(true);
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    // Muted autoplay + playsinline is the only combination guaranteed to play inline in the iOS
    // WKWebView shell; the on-player control lets the user unmute. rel=0 keeps it Bloomberg-only.
    const params = (base: string) => {
      const q = new URLSearchParams({ autoplay: "1", mute: "1", playsinline: "1", rel: "0", modestbranding: "1" });
      if (origin) q.set("origin", origin);
      return `${base}?${q.toString()}`;
    };
    // Only embed a resolved specific videoId. The channel `live_stream?channel=` form is NOT used — it
    // errors 153 in production. When no id resolves, fall back to a "Watch on YouTube" link instead.
    let embed: string | null = null;
    let url = LIVE_NEWS_URL;
    try {
      const res = await fetch("/api/hivemind/live-news", { cache: "no-store" });
      const data = (await res.json()) as { videoId?: string | null; channelUrl?: string };
      if (typeof data?.channelUrl === "string" && data.channelUrl) url = data.channelUrl;
      if (data?.videoId) embed = params(`https://www.youtube.com/embed/${data.videoId}`);
    } catch {
      // keep the external-link fallback
    }
    setSrc(embed);
    setWatchUrl(url);
    setAttached(true);
    setLoading(false);
  }, []);

  const detach = useCallback(() => {
    setAttached(false);
    setSrc(null);
  }, []);

  return (
    <GlassCard>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2 w-2">
            {attached && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500/70" />}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${attached ? "bg-rose-500" : "bg-white/25"}`} />
          </span>
          <div>
            <p className="text-[13.5px] font-medium leading-tight text-white">Live News</p>
            <p className="text-[11px] leading-tight text-white/45">Bloomberg Television</p>
          </div>
        </div>
        <button
          type="button"
          onClick={attached ? detach : attach}
          disabled={loading}
          aria-pressed={attached}
          className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11.5px] font-medium transition-colors disabled:opacity-60 ${
            attached
              ? "bg-white/[0.05] text-white/55 ring-1 ring-white/10 hover:text-white/80"
              : "bg-white/[0.14] text-white ring-1 ring-white/20"
          }`}
          style={attached ? undefined : { boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2)" }}
        >
          <Radio className="h-3.5 w-3.5" />
          {loading ? "Connecting…" : attached ? "Detach" : "Attach"}
        </button>
      </div>
      {attached && (
        <div className="relative w-full border-t border-white/[0.08] bg-black" style={{ aspectRatio: "16 / 9" }}>
          {src ? (
            <>
              <iframe
                key={src}
                src={src}
                title="Bloomberg Television — Live"
                className="absolute inset-0 h-full w-full"
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
              {/* Escape hatch: if the embed is blocked ("Video unavailable"), the user can still open it. */}
              <a
                href={watchUrl}
                target="_blank"
                rel="noreferrer"
                className="absolute bottom-2 right-2 z-10 inline-flex items-center gap-1 rounded-full bg-black/65 px-2.5 py-1 text-[10.5px] font-medium text-white/75 backdrop-blur-md transition-colors hover:text-white"
              >
                <ExternalLink className="h-3 w-3" />
                YouTube
              </a>
            </>
          ) : loading ? (
            <div className="absolute inset-0 grid place-items-center text-[12px] text-white/40">Connecting to Bloomberg Television…</div>
          ) : (
            // No embeddable live id resolved (or blocked on the server IP) → offer the external stream.
            <a href={watchUrl} target="_blank" rel="noreferrer" className="absolute inset-0 grid place-items-center px-4 text-center">
              <span className="flex flex-col items-center gap-2.5">
                <span className="grid h-11 w-11 place-items-center rounded-full bg-rose-600/90">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 text-white"><path d="M8 5v14l11-7z" /></svg>
                </span>
                <span className="text-[13px] font-medium text-white/85">Watch Bloomberg Television live</span>
                <span className="inline-flex items-center gap-1 text-[11px] text-white/45"><ExternalLink className="h-3 w-3" /> Opens in YouTube</span>
              </span>
            </a>
          )}
        </div>
      )}
    </GlassCard>
  );
}

function LoadingSkeleton() {
  return (
    <>
      {[0, 1, 2].map((k) => (
        <div key={k} className="animate-pulse rounded-2xl border border-white/[0.09] px-4 py-4">
          <div className="h-4 w-24 rounded bg-white/10" />
          <div className="mt-3 h-3 w-full rounded bg-white/[0.07]" />
          <div className="mt-2 h-3 w-4/5 rounded bg-white/[0.07]" />
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------------------
// Module-level fetch + short-TTL cache + in-flight de-dupe. This survives the brief mount/unmount
// churn during hydration (and React StrictMode's double-mount in dev), so the 9-request fan-out
// fires once per (holdings, user) scope instead of once per remount. Instances that mount while a
// fetch is in flight join its promise rather than starting their own.
type HeldLite = { ticker: string; name: string; weight: number | null };
let hivemindCache: { key: string; bundle: Bundle; at: number } | null = null;
let hivemindInFlight: { key: string; promise: Promise<Bundle> } | null = null;
const HIVEMIND_TTL = 60_000;

async function fetchBundle(held: HeldLite[], user?: string): Promise<Bundle> {
  const symbolsQ = held.length ? `?symbols=${encodeURIComponent(held.map((h) => h.ticker).join(","))}` : "";
  const newsQ = held.length ? `?tickers=${encodeURIComponent(held.slice(0, 8).map((h) => h.ticker).join(","))}` : "";
  const [quoteR, recR, targetR, metricR, briefR, monitorR, redditR, youtubeR, newsR, marketsR] = await Promise.all([
    held.length ? safeJSON<{ quotes: Record<string, Quote> }>(`/api/quote${symbolsQ}`) : Promise.resolve(null),
    held.length ? safeJSON<{ recommendations: Record<string, Rec> }>(`/api/recommendation${symbolsQ}`) : Promise.resolve(null),
    held.length ? safeJSON<{ targets: Record<string, PriceTarget> }>(`/api/price-targets${symbolsQ}`) : Promise.resolve(null),
    held.length ? safeJSON<{ metrics: Record<string, Metric> }>(`/api/metrics${symbolsQ}`) : Promise.resolve(null),
    held.length ? safeJSON<{ briefs: Record<string, string> }>(`/api/analyst-brief${symbolsQ}`) : Promise.resolve(null),
    safeJSON<MonitorPayload>(`/api/monitor${user ? `?user=${encodeURIComponent(user)}` : ""}`),
    safeJSON<RedditSocialResponse>(`/api/social/reddit`), // unfiltered → held + opportunities
    safeJSON<YouTubeSocialResponse>(`/api/social/youtube`),
    held.length ? safeJSON<{ articles: NewsArticle[]; overviews?: Record<string, { summary: string | null; lean: string | null }> }>(`/api/news${newsQ}`, { timeoutMs: 16000 }) : Promise.resolve(null),
    held.length ? safeJSON<MarketsPayload>(`/api/prediction/markets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ holdings: held.map((h) => ({ ticker: h.ticker, name: h.name, weight: h.weight })) }), timeoutMs: 16000 }) : Promise.resolve(null),
  ]);

  const monitor: Record<string, MonitorResult> = {};
  for (const r of monitorR?.results || []) monitor[norm(r.ticker)] = r;
  const youtube: Record<string, YouTubeSocialVideo[]> = {};
  const youtubeLeans: Record<string, string> = {};
  const youtubeSummaries: Record<string, string> = {};
  for (const snap of youtubeR?.snapshots || []) {
    if (snap.videos.length) youtube[norm(snap.ticker)] = snap.videos;
    if (snap.lean) youtubeLeans[norm(snap.ticker)] = snap.lean;
    if (snap.summary) youtubeSummaries[norm(snap.ticker)] = snap.summary;
  }
  const news: Record<string, NewsArticle[]> = {};
  for (const a of newsR?.articles || []) (news[norm(a.ticker)] ||= []).push(a);
  const newsOverviews: Record<string, string> = {};
  const newsLeans: Record<string, string> = {};
  for (const [t, o] of Object.entries(newsR?.overviews || {})) {
    if (o?.summary) newsOverviews[norm(t)] = o.summary;
    if (o?.lean) newsLeans[norm(t)] = o.lean;
  }
  const markets: Record<string, MarketsAsset> = {};
  for (const a of marketsR?.assets || []) if (a.events.length) markets[norm(a.ticker)] = a;

  return {
    quotes: quoteR?.quotes || {},
    recs: recR?.recommendations || {},
    targets: targetR?.targets || {},
    metrics: metricR?.metrics || {},
    briefs: briefR?.briefs || {},
    monitor,
    memo: monitorR?.memo ?? null,
    reddit: redditR?.snapshots || [],
    redditStale: !!redditR?.stale,
    youtube,
    youtubeLeans,
    youtubeSummaries,
    news,
    newsOverviews,
    newsLeans,
    markets,
    generatedAt: redditR?.generatedAt ?? null,
  };
}

// A compact, LLM-ready snapshot of the portfolio: the overall pulse plus, per holding, every signal
// we scored. This is what the model reads to decide what leads. Kept small (drop nulls, truncate the
// Reddit note, top-2 headlines) so the prompt stays cheap.
const round2 = (v: number) => Math.round(v * 100) / 100;
function buildSnapshot(portfolio: PortfolioPulse, items: Array<{ holding: { weight: number | null }; pulse: AssetPulse; signals: AssetSignals }>) {
  const holdings = items
    .filter((i) => i.pulse.signalCount > 0)
    .map(({ holding, pulse, signals: s }) => {
      const mk = pulse.contributions.find((c) => c.key === "markets");
      const clean = <T,>(o: T): T => JSON.parse(JSON.stringify(o, (_k, v) => (v == null || v === "" || (Array.isArray(v) && !v.length) ? undefined : v)));
      // Real source links the model MAY attach to a fact: Reddit threads, news articles, and the
      // source links the agent embedded in its research. Validated server-side against the snapshot,
      // so the model can only use one of these, never a hallucinated URL.
      const sources: Array<{ label: string; url: string }> = [];
      for (const t of (s.reddit?.topSources || []).slice(0, 3)) sources.push({ label: `Reddit: ${t.title}`, url: t.url });
      for (const n of (s.newsItems || []).slice(0, 3)) sources.push({ label: n.headline, url: n.url });
      for (const m of Array.from((s.rationale || "").matchAll(/\[([^\]]+)\]\(([^)]+)\)/g))) sources.push({ label: m[1], url: m[2] });
      const validSources = sources.filter((x) => /^https?:\/\//.test(x.url)).slice(0, 8);
      return clean({
        ticker: s.ticker,
        name: s.name || undefined,
        weightPct: holding.weight != null ? Math.round(holding.weight * 100) : undefined,
        pulse: pulse.label,
        price: s.price ?? undefined,
        dayChangePct: typeof s.changePct === "number" ? round2(s.changePct) : undefined,
        verdict: s.verdict || undefined,
        // the agent's actual daily research: its plain-language narrative and the concrete evidence it
        // pulled (price/news/analyst breakdown), so the model can quote specifics, not just the verdict.
        dailyResearch: s.rationale || s.agentSignals ? { rationale: s.rationale?.slice(0, 600) || undefined, evidence: s.agentSignals || undefined } : undefined,
        analystConsensus: s.recLabel || undefined,
        analystCount: s.recAnalysts ?? undefined,
        reddit: s.reddit && s.reddit.mentions > 0 ? { mentions: s.reddit.mentions, voices: s.reddit.uniqueAuthors, wowChangePct: s.reddit.mentionChangePct ?? undefined, note: s.reddit.summary?.slice(0, 320) } : undefined,
        predictionMarkets: mk?.present
          ? {
              count: s.markets?.length || 0,
              lean: mk.score > 0.15 ? "upside" : mk.score < -0.15 ? "downside" : "split",
              // the actual questions + implied odds, so facts can cite specifics rather than just "lean: downside"
              top: (s.markets || [])
                .filter((m) => m.yes != null)
                .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
                .slice(0, 3)
                .map((m) => ({ question: m.question.slice(0, 110), yesPct: Math.round((m.yes as number) * 100) })),
            }
          : undefined,
        newsCount: s.newsCount || undefined,
        headlines: (s.newsHeadlines || []).slice(0, 3),
        youtubeVideos: s.videos?.length || undefined,
        sources: validSources.length ? validSources : undefined,
      });
    });
  return {
    portfolio: { pulse: portfolio.label, holdingsLeaningPositive: portfolio.positive, holdingsCautious: portfolio.negative, holdingsWithSignals: portfolio.total },
    holdings,
  };
}

// LLM overview fetch (headline + terse points), cached + de-duped by snapshot fingerprint so remounts
// and identical data reuse one call. Returns null on any failure so the caller keeps its deterministic read.
let overviewCache: { key: string; data: OverviewData } | null = null;
let overviewInFlight: { key: string; promise: Promise<OverviewData | null> } | null = null;

async function fetchOverview(snapshot: object): Promise<OverviewData | null> {
  const r = await safeJSON<OverviewData>("/api/hivemind/overview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshot }),
    timeoutMs: 55000, // the opus fallback (used while the Dartmouth gateway is over budget) can take ~20-30s
  });
  if (!r) return null;
  const headline = typeof r.headline === "string" && r.headline.trim() ? r.headline.trim() : null;
  const points = Array.isArray(r.points) && r.points.length ? r.points : null;
  return headline || points ? { headline, points } : null;
}

// Per-asset LLM overview (one batched call → { ticker: overview }), cached + de-duped by the same
// snapshot fingerprint. Returns null on any failure so each card keeps its skeleton pulsing.
let assetOverviewCache: { key: string; data: Record<string, string> } | null = null;
let assetOverviewInFlight: { key: string; promise: Promise<Record<string, string> | null> } | null = null;

async function fetchAssetOverviews(holdings: object[]): Promise<Record<string, string> | null> {
  const r = await safeJSON<{ overviews?: Record<string, string> }>("/api/hivemind/asset-overview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ holdings }),
    timeoutMs: 55000, // the opus fallback (used while the Dartmouth gateway is over budget) can take ~20-30s
  });
  if (!r || !r.overviews || typeof r.overviews !== "object" || !Object.keys(r.overviews).length) return null;
  return r.overviews;
}

// v1: "since you last checked" — diff this visit's per-ticker state against the last visit stored in
// localStorage, surface only what MOVED (price, Reddit volume, research verdict, pulse), then re-save.
export function Hivemind({ holdings, user }: { holdings: Array<{ ticker: string; name?: string; weight?: number | null }>; user?: string }) {
  const held = useMemo(() => {
    const seen = new Set<string>();
    return holdings
      .map((h) => ({ ticker: norm(h.ticker || ""), name: h.name || "", weight: h.weight ?? null }))
      .filter((h) => h.ticker && !seen.has(h.ticker) && seen.add(h.ticker));
  }, [holdings]);
  const heldKey = held.map((h) => h.ticker).join(",");
  const heldSet = useMemo(() => new Set(held.map((h) => h.ticker)), [heldKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const cacheKey = `${heldKey}|${user ?? ""}`;
  const warm = hivemindCache?.key === cacheKey ? hivemindCache : null;
  const [bundle, setBundle] = useState<Bundle>(() => warm?.bundle ?? EMPTY_BUNDLE);
  const [loading, setLoading] = useState(() => !warm);
  const reqId = useRef(0);

  const load = useCallback(async (force = false) => {
    const id = ++reqId.current;
    const key = `${heldKey}|${user ?? ""}`;
    // Fresh cache → paint instantly, no network (covers hydration remounts).
    if (!force && hivemindCache?.key === key && Date.now() - hivemindCache.at < HIVEMIND_TTL) {
      setBundle(hivemindCache.bundle);
      setLoading(false);
      return;
    }
    setLoading(true);
    // Join an in-flight fan-out for the same scope, or start one (and cache its result).
    let promise: Promise<Bundle>;
    if (!force && hivemindInFlight?.key === key) {
      promise = hivemindInFlight.promise;
    } else {
      promise = fetchBundle(held, user);
      hivemindInFlight = { key, promise };
      promise
        .then((b) => { hivemindCache = { key, bundle: b, at: Date.now() }; })
        .catch(() => {})
        .finally(() => { if (hivemindInFlight?.key === key) hivemindInFlight = null; });
    }
    try {
      const b = await promise;
      if (id === reqId.current) { setBundle(b); setLoading(false); }
    } catch {
      if (id === reqId.current) setLoading(false);
    }
  }, [heldKey, user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load]);

  // Build per-holding signals → pulses, then the portfolio aggregate.
  const redditByTicker = useMemo(() => {
    const m: Record<string, RedditSocialSnapshot> = {};
    for (const s of bundle.reddit) m[norm(s.ticker)] = s;
    return m;
  }, [bundle.reddit]);

  const holdingPulses = useMemo(() => held.map((h) => {
    const rec = bundle.recs[h.ticker];
    const mon = bundle.monitor[h.ticker];
    const reddit = redditByTicker[h.ticker];
    const marketsAsset = bundle.markets[h.ticker];
    const newsArr = bundle.news[h.ticker];
    // The agent's `signals` is a JSON string of the concrete evidence it pulled (price/news/analyst).
    let agentSignals: Record<string, string> | null = null;
    if (mon?.signals) {
      try {
        const parsed = JSON.parse(mon.signals);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          agentSignals = Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""),
          );
        }
      } catch { /* leave null */ }
    }
    const signals: AssetSignals = {
      ticker: h.ticker,
      name: h.name,
      price: bundle.quotes[h.ticker]?.price ?? null,
      changePct: bundle.quotes[h.ticker]?.percent ?? null,
      verdict: mon?.verdict ?? null,
      risk: mon?.risk ?? null,
      rationale: mon?.rationale ?? null,
      agentSignals,
      brief: bundle.briefs[h.ticker] ?? null,
      recLabel: rec?.label ?? null,
      recAnalysts: rec?.analysts ?? null,
      reddit: reddit ?? null,
      videos: bundle.youtube[h.ticker] ?? [],
      markets: marketsAsset ? flattenMarkets(marketsAsset) : [],
      newsCount: newsArr?.length ?? 0,
      newsHeadlines: (newsArr || []).map((a) => a.headline),
      newsItems: (newsArr || []).map((a) => ({ headline: a.headline, url: a.url })),
      newsLean: bundle.newsLeans[h.ticker],
    };
    return { holding: h, pulse: synthesizeAsset(signals), signals };
  }), [held, bundle, redditByTicker]);

  const portfolioPulse = useMemo(() => aggregatePortfolioPulse(
    holdingPulses.map((p) => ({ pulse: p.pulse, weight: p.holding.weight ?? 1 })),
  ), [holdingPulses]);

  // v1: per-holding analytics — notability (drives ranking + collapsing), a one-line signal-lean
  // note, and conviction (how many independent reliable signals agree). Ranked most-notable first.
  const holdingViews = useMemo(
    () =>
      holdingPulses
        .map(({ holding, pulse, signals }) => ({
          holding,
          pulse,
          signals,
          notability: assetNotability(pulse, signals),
          action: assetAction(pulse, signals),
          conviction: assetConviction(pulse),
        }))
        .sort((a, b) => b.notability - a.notability),
    [holdingPulses],
  );

  const [signalOnly, setSignalOnly] = useState(false);
  const [highConviction, setHighConviction] = useState(false);


  // The top-of-page read: a few terse, tappable points, written by the LLM from the real signal
  // snapshot. Until that lands the Hero pulses skeleton rows — we never show deterministic fallback text.
  const snapshot = useMemo(() => buildSnapshot(portfolioPulse, holdingPulses), [portfolioPulse, holdingPulses]);
  const snapshotKey = useMemo(() => JSON.stringify(snapshot), [snapshot]);
  const [llm, setLlm] = useState<OverviewData | null>(() => (overviewCache?.key === snapshotKey ? overviewCache.data : null));
  useEffect(() => {
    const key = snapshotKey;
    if (!snapshot.holdings.length) { setLlm(null); return; }
    if (overviewCache?.key === key) { setLlm(overviewCache.data); return; }
    setLlm(null); // fall back to the deterministic brief while the LLM version is generated
    let cancelled = false;
    (async () => {
      let promise: Promise<OverviewData | null>;
      if (overviewInFlight?.key === key) {
        promise = overviewInFlight.promise;
      } else {
        promise = fetchOverview(snapshot);
        overviewInFlight = { key, promise };
        promise.then((d) => { if (d) overviewCache = { key, data: d }; }).catch(() => {}).finally(() => { if (overviewInFlight?.key === key) overviewInFlight = null; });
      }
      const data = await promise;
      if (!cancelled && data) setLlm(data);
    })();
    return () => { cancelled = true; };
  }, [snapshotKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-asset LLM overviews, fetched in parallel with the portfolio read. Each card skeletons until
  // its ticker's overview lands; we never fall back to deterministic text.
  const [assetOverviews, setAssetOverviews] = useState<Record<string, string> | null>(
    () => (assetOverviewCache?.key === snapshotKey ? assetOverviewCache.data : null),
  );
  useEffect(() => {
    const key = snapshotKey;
    if (!snapshot.holdings.length) { setAssetOverviews(null); return; }
    if (assetOverviewCache?.key === key) { setAssetOverviews(assetOverviewCache.data); return; }
    setAssetOverviews(null);
    let cancelled = false;
    (async () => {
      let promise: Promise<Record<string, string> | null>;
      if (assetOverviewInFlight?.key === key) {
        promise = assetOverviewInFlight.promise;
      } else {
        promise = fetchAssetOverviews(snapshot.holdings);
        assetOverviewInFlight = { key, promise };
        promise.then((d) => { if (d) assetOverviewCache = { key, data: d }; }).catch(() => {}).finally(() => { if (assetOverviewInFlight?.key === key) assetOverviewInFlight = null; });
      }
      const data = await promise;
      if (!cancelled && data) setAssetOverviews(data);
    })();
    return () => { cancelled = true; };
  }, [snapshotKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only the real LLM read is shown; null → the Hero pulses skeletons until it loads.
  // Trim takeaways (the risk-off "reduce" call) float to the top; stable sort keeps the rest in order.
  const points: BriefPoint[] | null = llm?.points
    ? [...llm.points].sort((a, b) => Number(b.action === "Trim") - Number(a.action === "Trim"))
    : null;

  const showLoading = loading && !holdingPulses.some((p) => p.pulse.signalCount > 0);

  // v1 ranking + collapse: notable names on top (top one auto-expanded), quiet names collapsed to rows.
  const NOTABLE = 0.28;
  let notable = holdingViews.filter((v) => v.notability >= NOTABLE);
  let quiet = holdingViews.filter((v) => v.notability < NOTABLE);
  if (notable.length === 0 && holdingViews.length) { notable = holdingViews.slice(0, 1); quiet = holdingViews.slice(1); }
  if (highConviction) { notable = notable.filter((v) => v.conviction.level === "high"); quiet = []; }
  if (signalOnly) quiet = [];
  const cardProps = (v: (typeof holdingViews)[number]) => ({
    pulse: v.pulse,
    overview: assetOverviews?.[String(v.holding.ticker).toUpperCase()] ?? null,
    name: v.holding.name,
    quote: bundle.quotes[v.holding.ticker],
    monitor: bundle.monitor[v.holding.ticker],
    rec: bundle.recs[v.holding.ticker],
    target: bundle.targets[v.holding.ticker],
    metric: bundle.metrics[v.holding.ticker],
    brief: bundle.briefs[v.holding.ticker],
    reddit: redditByTicker[v.holding.ticker],
    videos: bundle.youtube[v.holding.ticker],
    ytLeanAgent: bundle.youtubeLeans[v.holding.ticker],
    ytOverview: bundle.youtubeSummaries[v.holding.ticker],
    markets: bundle.markets[v.holding.ticker],
    news: bundle.news[v.holding.ticker],
    newsSummary: bundle.newsOverviews[v.holding.ticker],
    action: v.action,
    conviction: v.conviction,
  });

  return (
    <section aria-label="Hivemind" className="space-y-3">
      <Hero pulse={portfolioPulse} points={points} />

      <LiveNewsCard />

      {showLoading ? (
        <LoadingSkeleton />
      ) : (
        <>
          {held.length > 0 && (
            <>
              {/* v1 filter bar */}
              <div className="flex items-center gap-2 px-1 pt-1">
                <TogglePill active={signalOnly} onClick={() => setSignalOnly((v) => !v)} icon={<SlidersHorizontal className="h-3.5 w-3.5" />}>Signal only</TogglePill>
                <TogglePill active={highConviction} onClick={() => setHighConviction((v) => !v)}>High conviction</TogglePill>
              </div>

              {/* v1 ranked notable holdings (top one auto-expanded) */}
              {notable.map((v, i) => <HoldingCard key={v.holding.ticker} {...cardProps(v)} defaultOpen={i === 0} />)}
              {notable.length === 0 && <p className="px-1 py-2 text-center text-[13px] text-white/45">No high-conviction holdings right now.</p>}

              {/* v1 quiet holdings, collapsed to one-line rows */}
              {quiet.length > 0 && (
                <>
                  <div className="flex items-center gap-2.5 px-1 pt-2 text-[10px] uppercase tracking-[0.14em] text-white/30">
                    <span>Quiet</span>
                    <span className="h-px flex-1 bg-white/[0.08]" />
                    <span>{quiet.length}</span>
                  </div>
                  {quiet.map((v) => <QuietHolding key={v.holding.ticker} {...cardProps(v)} />)}
                </>
              )}
            </>
          )}

          {held.length === 0 && <p className="px-1 pt-4 text-center text-[13px] text-[#8a8a8a]">Add holdings on the Portfolio tab to see your portfolio pulse.</p>}
        </>
      )}
    </section>
  );
}

function flattenMarkets(asset: MarketsAsset): AssetMarket[] {
  const out: AssetMarket[] = [];
  for (const ev of asset.events) {
    if (ev.single || !ev.outcomes.length) out.push({ question: ev.title, yes: ev.yes, volume: ev.volume });
    else for (const o of ev.outcomes) out.push({ question: o.question || o.label, yes: o.yes, volume: o.volume });
  }
  return out;
}
