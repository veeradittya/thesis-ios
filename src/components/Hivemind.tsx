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
  Flame,
  LineChart,
  MessageCircle,
  Newspaper,
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
  composePortfolioBrief,
  synthesizeAsset,
  type AssetMarket,
  type AssetPulse,
  type AssetSignals,
  type BriefFact,
  type PortfolioPulse,
} from "@/lib/hivemind";

type BriefPoint = { short: string; detail: string; facts?: BriefFact[] };
type OverviewData = { headline: string | null; points: BriefPoint[] | null };

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

interface Bundle {
  quotes: Record<string, Quote>;
  recs: Record<string, Rec>;
  metrics: Record<string, Metric>;
  briefs: Record<string, string>;
  monitor: Record<string, MonitorResult>;
  memo: string | null;
  reddit: RedditSocialSnapshot[];
  redditStale: boolean;
  youtube: Record<string, YouTubeSocialVideo[]>;
  news: Record<string, NewsArticle[]>;
  markets: Record<string, MarketsAsset>;
  generatedAt: string | null;
}

const EMPTY_BUNDLE: Bundle = {
  quotes: {}, recs: {}, metrics: {}, briefs: {}, monitor: {}, memo: null,
  reddit: [], redditStale: false, youtube: {}, news: {}, markets: {}, generatedAt: null,
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

function PulseChip({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25)" }} className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium ring-1 ring-white/15 backdrop-blur-md ${color}`}>
      {label}
    </span>
  );
}

// Collapsible sub-section inside a holding's signal breakdown.
function SignalSection({ icon, title, meta, children, defaultOpen = false }: { icon: React.ReactNode; title: string; meta?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl bg-white/[0.025]">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left">
        <span className="text-white/45">{icon}</span>
        <span className="text-[13px] font-medium text-white/85">{title}</span>
        {meta && <span className="text-[11px] text-[#737373]">{meta}</span>}
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

function Hero({ pulse, headline, points }: { pulse: ReturnType<typeof aggregatePortfolioPulse>; headline: string; points: BriefPoint[] }) {
  const [showInfo, setShowInfo] = useState(false);
  const [openPoint, setOpenPoint] = useState<number | null>(null); // level 2: which takeaway's detail is open
  const [openFacts, setOpenFacts] = useState<number | null>(null); // level 3: which takeaway's facts are open
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
            <span className={statusColor}>NYSE · Nasdaq</span>
            <span className="text-[12.42px] text-[#8a8a8a]"><span className="tabular-nums text-white/85">{s ? s.clock : " "}</span> ET</span>
            {s && <span className="text-[12.42px] text-[#8a8a8a]">{s.countdownLabel} {s.countdownText}</span>}
          </div>
        </div>
      </div>
      <p className="mt-3.5 text-[18px] font-medium leading-snug text-white">{headline}</p>
      {showInfo && (
        <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-[12.5px] leading-relaxed text-white/65">
          {HIVEMIND_INFO}
        </div>
      )}
      <ul className="mt-3.5 space-y-1">
        {points.map((pt, i) => {
          const showDetail = openPoint === i;
          const showFacts = openFacts === i;
          const hasFacts = !!pt.facts && pt.facts.length > 0;
          return (
            <li key={i}>
              {/* Level 1 — the takeaway. Tap to reveal the expanded takeaway. */}
              <button
                type="button"
                onClick={() => { setOpenPoint((v) => (v === i ? null : i)); setOpenFacts(null); }}
                aria-expanded={showDetail}
                className="flex w-full items-start gap-2.5 py-1 text-left"
              >
                <span className="flex-1 text-[13.5px] leading-snug text-white/85">{pt.short}</span>
                <ChevronDown className={`mt-[3px] h-3.5 w-3.5 shrink-0 text-white/35 transition-transform ${showDetail ? "rotate-180" : ""}`} />
              </button>

              {/* Level 2 — the expanded takeaway. Tap to reveal the exact facts behind it. */}
              {showDetail && (
                <div className="mb-1.5 mr-1 pt-0.5">
                  <button
                    type="button"
                    onClick={() => hasFacts && setOpenFacts((v) => (v === i ? null : i))}
                    aria-expanded={showFacts}
                    className={`flex w-full items-start gap-2 text-left ${hasFacts ? "" : "cursor-default"}`}
                  >
                    <span className="flex-1 text-[12.5px] leading-relaxed text-white/65">{pt.detail}</span>
                    {hasFacts && <ChevronDown className={`mt-[3px] h-3 w-3 shrink-0 text-white/30 transition-transform ${showFacts ? "rotate-180" : ""}`} />}
                  </button>

                  {/* Level 3 — the exact facts, with where each one comes from. */}
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
        })}
      </ul>
    </GlassCard>
  );
}

// ---------------------------------------------------------------------------------------
// Signal breakdown blocks
// ---------------------------------------------------------------------------------------
function recColor(label: string): string {
  return label === "Strong Buy" || label === "Buy" ? "text-emerald-300" : label === "Hold" ? "text-amber-300" : "text-rose-300";
}
const RATING_ROWS: Array<[string, keyof RecCounts]> = [["Strong Buy", "strongBuy"], ["Buy", "buy"], ["Hold", "hold"], ["Sell", "sell"], ["Strong Sell", "strongSell"]];

function AnalystBlock({ monitor, rec, brief }: { monitor?: MonitorResult; rec?: Rec; brief?: string }) {
  const maxCount = rec?.counts ? Math.max(1, ...Object.values(rec.counts)) : 1;
  // The agent's research narrative (markdown links flattened to plain text) and the concrete evidence
  // it pulled (price / news / analyst), parsed from its signals JSON.
  const rationale = (monitor?.rationale || brief || "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
  let evidence: Array<[string, string]> = [];
  if (monitor?.signals) {
    try {
      const p = JSON.parse(monitor.signals);
      if (p && typeof p === "object" && !Array.isArray(p)) evidence = Object.entries(p).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1]);
    } catch { /* ignore */ }
  }
  return (
    <div className="space-y-3">
      {(rationale || evidence.length > 0) && (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-[#737373]">Thesis Research</p>
          {rationale && <p className="mt-1.5 text-[13px] leading-relaxed text-white/70">{rationale}</p>}
          {evidence.length > 0 && (
            <div className="mt-2.5 space-y-1.5">
              {evidence.map(([k, v]) => (
                <p key={k} className="text-[12px] leading-relaxed text-white/55">
                  <span className="uppercase tracking-wide text-[#737373]">{k}</span> {v}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      {rec && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[12px] text-[#8a8a8a]">Consensus <span className={`font-medium ${recColor(rec.label)}`}>{rec.label}</span>{rec.analysts ? <span className="text-[#737373]">· {rec.analysts} analysts</span> : null}</div>
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
      {!rationale && evidence.length === 0 && !rec && <p className="text-[12px] text-[#737373]">No research yet for this ticker.</p>}
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
      {snap.summary && <p className="text-[13px] leading-relaxed text-white/70">{snap.summary}</p>}
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

function YouTubeBlock({ videos }: { videos: YouTubeSocialVideo[] }) {
  return (
    <div className="space-y-2.5">
      {videos.map((v) => (
        <a key={v.videoId} href={v.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg bg-white/[0.035]">
          <div className="flex gap-3 p-2.5">
            <div className="relative h-[60px] w-[100px] shrink-0 overflow-hidden rounded-md bg-white/[0.05]">
              {v.thumbnailUrl ? <img src={v.thumbnailUrl} alt="" className="h-full w-full object-cover" /> : <Video className="absolute inset-0 m-auto h-5 w-5 text-white/25" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[12px] font-medium leading-snug text-white/85">{v.title}</p>
              <p className="mt-1 truncate text-[10px] text-[#8a8a8a]">{v.channel}</p>
            </div>
            <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/30" />
          </div>
          {(v.videoSummary || v.transcriptExcerpt) && (
            <p className="border-t border-white/[0.06] px-2.5 py-2 text-[11px] leading-relaxed text-white/55">{v.videoSummary || v.transcriptExcerpt}</p>
          )}
        </a>
      ))}
    </div>
  );
}

function MarketsBlock({ asset }: { asset: MarketsAsset }) {
  return (
    <div className="space-y-2.5">
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

function NewsBlock({ articles }: { articles: NewsArticle[] }) {
  return (
    <div className="space-y-2">
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
function HoldingCard({ pulse, name, quote, monitor, rec, metric, brief, reddit, videos, markets, news }: {
  pulse: AssetPulse; name?: string | null; quote?: Quote; monitor?: MonitorResult; rec?: Rec; metric?: Metric;
  brief?: string; reddit?: RedditSocialSnapshot; videos?: YouTubeSocialVideo[]; markets?: MarketsAsset; news?: NewsArticle[];
}) {
  const [open, setOpen] = useState(false);
  const pct = quote?.percent ?? null;
  const up = (pct ?? 0) >= 0;
  const hasAnalyst = !!(monitor || rec || brief);
  const hasReddit = !!reddit && reddit.mentions > 0;
  const hasVideos = !!videos && videos.length > 0;
  const hasMarkets = !!markets && markets.events.length > 0;
  const hasNews = !!news && news.length > 0;

  return (
    <GlassCard className="px-4 py-4">
      {/* header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[16px] font-medium leading-tight text-white">{pulse.ticker}</p>
          {name && <p className="mt-0.5 truncate text-[13px] leading-tight text-[#8a8a8a]">{name}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {quote?.price != null && (
            <div className="text-right">
              <p className="text-[15px] leading-tight tabular-nums text-white">{quote.price.toFixed(2)}</p>
              <p className={`text-[12px] leading-tight tabular-nums ${pct == null ? "text-[#8a8a8a]" : up ? "text-emerald-400" : "text-rose-400"}`}>{pct == null ? "" : `${up ? "+" : ""}${pct.toFixed(2)}%`}</p>
            </div>
          )}
          <PulseChip label={pulse.label} color={pulse.color} />
        </div>
      </div>

      {/* the cross-signal overview — the "interpretation across all signals" */}
      <p className="mt-3 text-[14px] leading-relaxed text-white/80">{pulse.overview}</p>

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
          <SignalSection icon={<TrendingUp className="h-3.5 w-3.5" />} title="Analyst" meta={rec?.label} defaultOpen>
            <AnalystBlock monitor={monitor} rec={rec} brief={brief} />
          </SignalSection>
          {hasReddit && (
            <SignalSection icon={<MessageCircle className="h-3.5 w-3.5" />} title="Reddit" meta={`${reddit!.mentions} mentions`}>
              <RedditBlock snap={reddit!} />
            </SignalSection>
          )}
          {hasVideos && (
            <SignalSection icon={<Video className="h-3.5 w-3.5" />} title="YouTube" meta={`${videos!.length} video${videos!.length > 1 ? "s" : ""}`}>
              <YouTubeBlock videos={videos!} />
            </SignalSection>
          )}
          {hasMarkets && (
            <SignalSection icon={<BarChart3 className="h-3.5 w-3.5" />} title="Prediction markets" meta={`${markets!.count} market${markets!.count > 1 ? "s" : ""}`}>
              <MarketsBlock asset={markets!} />
            </SignalSection>
          )}
          {hasNews && (
            <SignalSection icon={<Newspaper className="h-3.5 w-3.5" />} title="News" meta={`${news!.length} article${news!.length > 1 ? "s" : ""}`}>
              <NewsBlock articles={news!} />
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

// ---------------------------------------------------------------------------------------
// Opportunity card (non-portfolio ticker, lighter — social-driven)
// ---------------------------------------------------------------------------------------
function OpportunityCard({ pulse, reddit, videos }: { pulse: AssetPulse; reddit?: RedditSocialSnapshot; videos?: YouTubeSocialVideo[] }) {
  const [open, setOpen] = useState(false);
  return (
    <GlassCard className="px-4 py-3.5">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full text-left">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <p className="text-[15px] font-medium text-white">{pulse.ticker}</p>
            <PulseChip label={pulse.label} color={pulse.color} />
          </div>
          <div className="flex items-center gap-3 text-[11px] text-[#8a8a8a]">
            {reddit && <span className="tabular-nums">{compact.format(reddit.mentions)} mentions</span>}
            {videos && videos.length > 0 && <span className="flex items-center gap-1"><Video className="h-3 w-3" />{videos.length}</span>}
            <ChevronDown className={`h-3.5 w-3.5 text-white/40 transition-transform ${open ? "rotate-180" : ""}`} />
          </div>
        </div>
        <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-white/65">{pulse.overview}</p>
      </button>
      {open && (
        <div className="mt-3 space-y-2 border-t border-white/[0.08] pt-3">
          {reddit && <RedditBlock snap={reddit} />}
          {videos && videos.length > 0 && <YouTubeBlock videos={videos.slice(0, 3)} />}
        </div>
      )}
    </GlassCard>
  );
}

function SectionHeading({ children, hint }: { children: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-1 pt-1">
      <h3 className="text-[13px] font-medium uppercase tracking-[0.14em] text-white/55">{children}</h3>
      {hint && <span className="text-[11px] text-[#737373]">{hint}</span>}
    </div>
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
  const [quoteR, recR, metricR, briefR, monitorR, redditR, youtubeR, newsR, marketsR] = await Promise.all([
    held.length ? safeJSON<{ quotes: Record<string, Quote> }>(`/api/quote${symbolsQ}`) : Promise.resolve(null),
    held.length ? safeJSON<{ recommendations: Record<string, Rec> }>(`/api/recommendation${symbolsQ}`) : Promise.resolve(null),
    held.length ? safeJSON<{ metrics: Record<string, Metric> }>(`/api/metrics${symbolsQ}`) : Promise.resolve(null),
    held.length ? safeJSON<{ briefs: Record<string, string> }>(`/api/analyst-brief${symbolsQ}`) : Promise.resolve(null),
    safeJSON<MonitorPayload>(`/api/monitor${user ? `?user=${encodeURIComponent(user)}` : ""}`),
    safeJSON<RedditSocialResponse>(`/api/social/reddit`), // unfiltered → held + opportunities
    safeJSON<YouTubeSocialResponse>(`/api/social/youtube`),
    held.length ? safeJSON<{ articles: NewsArticle[] }>(`/api/news${newsQ}`, { timeoutMs: 16000 }) : Promise.resolve(null),
    held.length ? safeJSON<MarketsPayload>(`/api/prediction/markets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ holdings: held.map((h) => ({ ticker: h.ticker, name: h.name, weight: h.weight })) }), timeoutMs: 16000 }) : Promise.resolve(null),
  ]);

  const monitor: Record<string, MonitorResult> = {};
  for (const r of monitorR?.results || []) monitor[norm(r.ticker)] = r;
  const youtube: Record<string, YouTubeSocialVideo[]> = {};
  for (const snap of youtubeR?.snapshots || []) if (snap.videos.length) youtube[norm(snap.ticker)] = snap.videos;
  const news: Record<string, NewsArticle[]> = {};
  for (const a of newsR?.articles || []) (news[norm(a.ticker)] ||= []).push(a);
  const markets: Record<string, MarketsAsset> = {};
  for (const a of marketsR?.assets || []) if (a.events.length) markets[norm(a.ticker)] = a;

  return {
    quotes: quoteR?.quotes || {},
    recs: recR?.recommendations || {},
    metrics: metricR?.metrics || {},
    briefs: briefR?.briefs || {},
    monitor,
    memo: monitorR?.memo ?? null,
    reddit: redditR?.snapshots || [],
    redditStale: !!redditR?.stale,
    youtube,
    news,
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
    };
    return { holding: h, pulse: synthesizeAsset(signals), signals };
  }), [held, bundle, redditByTicker]);

  const portfolioPulse = useMemo(() => aggregatePortfolioPulse(
    holdingPulses.map((p) => ({ pulse: p.pulse, weight: p.holding.weight ?? 1 })),
  ), [holdingPulses]);

  // The top-of-page read: a short headline + a few terse, tappable points. Two tiers: a deterministic
  // brief shown instantly, then the LLM-written version (headline + points organized by what matters
  // most) swapped in when it lands.
  const fallback = useMemo(
    () => composePortfolioBrief(holdingPulses.map((p) => ({ pulse: p.pulse, signals: p.signals })), portfolioPulse),
    [holdingPulses, portfolioPulse],
  );
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

  const headline = llm?.headline || fallback.headline;
  const points = llm?.points || fallback.points;

  // Opportunities: tickers in the social feeds we don't hold, ranked by Reddit mentions.
  const opportunities = useMemo(() => {
    const pool = new Map<string, { reddit?: RedditSocialSnapshot; videos?: YouTubeSocialVideo[] }>();
    for (const s of bundle.reddit) { const t = norm(s.ticker); if (!heldSet.has(t)) (pool.get(t) || pool.set(t, {}).get(t)!).reddit = s; }
    for (const [t, vids] of Object.entries(bundle.youtube)) { if (!heldSet.has(t)) (pool.get(t) || pool.set(t, {}).get(t)!).videos = vids; }
    return [...pool.entries()]
      .map(([ticker, d]) => ({
        ticker,
        reddit: d.reddit,
        videos: d.videos,
        pulse: synthesizeAsset({ ticker, reddit: d.reddit ?? null, videos: d.videos ?? [], newsHeadlines: [] }),
        mentions: d.reddit?.mentions ?? 0,
      }))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 8);
  }, [bundle.reddit, bundle.youtube, heldSet]);

  const showLoading = loading && !holdingPulses.some((p) => p.pulse.signalCount > 0) && !opportunities.length;

  return (
    <section aria-label="Hivemind" className="space-y-3">
      <Hero pulse={portfolioPulse} headline={headline} points={points} />

      {showLoading ? (
        <LoadingSkeleton />
      ) : (
        <>
          {held.length > 0 && (
            <>
              {holdingPulses.map(({ holding, pulse }) => (
                <HoldingCard
                  key={holding.ticker}
                  pulse={pulse}
                  name={holding.name}
                  quote={bundle.quotes[holding.ticker]}
                  monitor={bundle.monitor[holding.ticker]}
                  rec={bundle.recs[holding.ticker]}
                  metric={bundle.metrics[holding.ticker]}
                  brief={bundle.briefs[holding.ticker]}
                  reddit={redditByTicker[holding.ticker]}
                  videos={bundle.youtube[holding.ticker]}
                  markets={bundle.markets[holding.ticker]}
                  news={bundle.news[holding.ticker]}
                />
              ))}
            </>
          )}

          {held.length === 0 && <p className="px-1 pt-4 text-center text-[13px] text-[#8a8a8a]">Add holdings on the Portfolio tab to see your portfolio pulse.</p>}

          {opportunities.length > 0 && (
            <>
              <SectionHeading hint="not in your portfolio">Opportunities</SectionHeading>
              <GlassCard className="flex items-center gap-2.5 px-4 py-2.5">
                <Flame className="h-4 w-4 shrink-0 text-amber-300/80" />
                <p className="text-[12px] leading-snug text-white/60">Tickers lighting up across Reddit &amp; YouTube that you don&apos;t hold, surfaced as market opportunities.</p>
              </GlassCard>
              {opportunities.map((o) => <OpportunityCard key={o.ticker} pulse={o.pulse} reddit={o.reddit} videos={o.videos} />)}
            </>
          )}
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
