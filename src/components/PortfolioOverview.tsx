"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Cell,
  ComposedChart,
  Customized,
  Label,
  Line,
  Pie,
  PieChart,
  Scatter,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { computeFrontier, interpretation, RISK_FREE, type FrontierResult } from "@/lib/portfolioTheory";
import type { ParsedHolding } from "@/lib/parsePortfolio";

const FRONTIER = "#8fb3e0"; // efficient-frontier curve (soft blue)
// shadcn's default chart palette (distinct hues) — used to colour sectors in the sector-allocation view.
const SECTOR_COLORS = ["hsl(220,70%,55%)", "hsl(160,60%,45%)", "hsl(30,80%,55%)", "hsl(280,65%,62%)", "hsl(340,75%,58%)", "hsl(190,65%,50%)", "hsl(50,75%,55%)"];

// GICS sector per ticker (for the sector-allocation view). Unknown tickers fall to "Other".
const SECTORS: Record<string, string> = {
  AAPL: "Technology", MSFT: "Technology", NVDA: "Technology",
  GOOGL: "Communication Services", META: "Communication Services", NFLX: "Communication Services",
  AMZN: "Consumer Discretionary", TSLA: "Consumer Discretionary", HD: "Consumer Discretionary",
  JPM: "Financials", BAC: "Financials", V: "Financials", MA: "Financials",
  JNJ: "Health Care", UNH: "Health Care", LLY: "Health Care", XOM: "Energy", CVX: "Energy",
};
const sectorOf = (t: string) => SECTORS[t.toUpperCase()] ?? "Other";
const ASSET_DOT = "rgba(255,255,255,0.5)"; // individual asset points
const PORT_DOT = "#34d399"; // the current portfolio point (emerald "you are here")

const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const pctTick = (v: number) => `${Math.round(v * 100)}%`;

// A tight "nice" axis: round the domain to a clean step just outside the data so the plot fills the space
// (no dead zone from 0), and return round tick values within it.
function niceAxis(min: number, max: number): { domain: [number, number]; ticks: number[] } {
  const range = Math.max(1e-6, max - min);
  const pow = Math.pow(10, Math.floor(Math.log10(range / 5)));
  const n = range / 5 / pow;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
  const tickLo = Math.max(0, Math.floor(min / step) * step);
  const tickHi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = tickLo; v <= tickHi + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  // The domain hugs the data (with a small buffer so edge dots don't clip) rather than padding out a whole
  // step — so the plot uses the full width — while the ticks stay on the clean round grid.
  const pad = Math.max(range * 0.04, step * 0.15);
  const domain: [number, number] = [tickLo, Math.max(tickHi, max + pad)];
  return { domain, ticks };
}

// The Overview tab: portfolio allocation + Markowitz efficient frontier + per-asset stats, correlations,
// and a short model read. Runs off the ledger's asset weights (the demo portfolio has them allocated).
// `user` is the signed-in id: when present we prefer the agent's daily plain-language overview (written to
// portfolio_analytics each morning) over the deterministic client read. Guests/demo have no user → client read.
export function PortfolioOverview({ holdings, user }: { holdings: ParsedHolding[]; user?: string }) {
  const result = useMemo(() => computeFrontier(holdings.map((h) => ({ ticker: h.ticker, weight: h.weight }))), [holdings]);
  const clientInterp = useMemo(() => (result ? interpretation(result) : []), [result]);
  const [expanded, setExpanded] = useState(false);
  const [agentOverview, setAgentOverview] = useState<string | null>(null);

  useEffect(() => {
    if (!user) { setAgentOverview(null); return; }
    let cancelled = false;
    fetch(`/api/portfolio-analytics?user=${encodeURIComponent(user)}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && typeof d.aiOverview === "string" && d.aiOverview.trim()) setAgentOverview(d.aiOverview.trim()); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user]);

  // Prefer the agent's overview when present; split into sentences so the brief/more toggle still works.
  const interp = useMemo(
    () => (agentOverview ? agentOverview.split(/(?<=[.!?])\s+/).filter(Boolean) : clientInterp),
    [agentOverview, clientInterp],
  );

  if (!result) {
    return (
      <div className="rounded-2xl border border-white/[0.09] px-4 py-8 text-center text-[13px] text-white/45">
        Add at least two holdings with allocations to see the portfolio overview.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      {/* AI overview — succinct, embedded straight on the background right under the title. */}
      <div className="px-1">
        <p className="text-[12px] uppercase tracking-wider text-white">Overview</p>
        <p className="mt-2 text-[15.5px] leading-relaxed text-white">{expanded ? interp.join(" ") : interp[0]}</p>
        {interp.length > 1 && (
          <button onClick={() => setExpanded((v) => !v)} className="mt-1.5 text-[13px] font-medium text-white/50 transition-colors hover:text-white/80">
            {expanded ? "less" : "more"}
          </button>
        )}
      </div>

      <Allocation result={result} />
      <Frontier result={result} />
      <AssetsMatrix result={result} />
      <Correlations result={result} />

      {/* Model disclaimer, at the very end of the page. */}
      <p className="px-1 pt-1 text-[11.5px] leading-snug text-white/35">
        Illustrative model using assumed return, risk and correlations. Not live estimates or advice.
      </p>
    </div>
  );
}

function Card({ title, subtitle, action, info, children }: { title: string; subtitle?: string; action?: React.ReactNode; info?: string; children: React.ReactNode }) {
  const [showInfo, setShowInfo] = useState(false);
  return (
    <div
      className="w-full rounded-2xl border border-white/[0.09] px-4 py-4"
      style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2), 0 0 0 1px rgba(255,255,255,0.05), 0 12px 40px -18px rgba(0,0,0,0.5)" }}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5">
            <h3 className="text-[15px] font-semibold text-white">{title}</h3>
            {info && (
              <button
                onClick={() => setShowInfo((v) => !v)}
                aria-label={`What is ${title}?`}
                className={`grid h-[15px] w-[15px] place-items-center rounded-full border text-[9.5px] font-semibold transition-colors ${showInfo ? "border-white/40 text-white/80" : "border-white/25 text-white/45 hover:text-white/70"}`}
              >
                i
              </button>
            )}
          </div>
          {subtitle && <p className="mt-0.5 text-[12px] leading-snug text-white/45">{subtitle}</p>}
        </div>
        {action}
      </div>
      {info && showInfo && (
        <div className="mb-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-[12.5px] leading-relaxed text-white/65">
          {info}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Allocation ring (donut) — toggles between by-asset and by-sector ──────────────────────────────────
function Allocation({ result }: { result: FrontierResult }) {
  const [mode, setMode] = useState<"asset" | "sector">("asset");

  // Aggregate into the chosen grouping, sorted by weight.
  const groups = useMemo(() => {
    if (mode === "asset") return result.assets.map((a) => ({ label: a.ticker, weight: a.weight }));
    const m = new Map<string, number>();
    for (const a of result.assets) m.set(sectorOf(a.ticker), (m.get(sectorOf(a.ticker)) ?? 0) + a.weight);
    return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([label, weight]) => ({ label, weight }));
  }, [mode, result]);

  const n = groups.length;
  // Assets: shades of one blue. Sectors: distinct shadcn hues.
  const shade = (i: number) => `hsl(214, 44%, ${(56 - (i / Math.max(1, n - 1)) * 34).toFixed(1)}%)`;
  const data = groups.map((g, i) => ({ ...g, color: mode === "sector" ? SECTOR_COLORS[i % SECTOR_COLORS.length] : shade(i) }));
  const config: ChartConfig = Object.fromEntries(data.map((d) => [d.label, { label: d.label, color: d.color }]));
  const RAD = Math.PI / 180;

  return (
    <Card
      title="Allocation"
      action={<Toggle mode={mode} onChange={setMode} />}
      info="This shows how your money is split across what you own. Each slice is one holding (or one sector), and its size is how big that position is compared to the rest."
    >
      <ChartContainer config={config} className="mx-auto aspect-square h-[230px]">
        <PieChart>
          <Pie
            data={data}
            dataKey="weight"
            nameKey="label"
            innerRadius="50%"
            outerRadius="92%"
            paddingAngle={2}
            strokeWidth={0}
            labelLine={false}
            label={(p: { cx: number; cy: number; midAngle: number; innerRadius: number; outerRadius: number; index: number }) => {
              const r = (p.innerRadius + p.outerRadius) / 2;
              const x = p.cx + r * Math.cos(-p.midAngle * RAD);
              const y = p.cy + r * Math.sin(-p.midAngle * RAD);
              const seg = data[p.index];
              const words = seg.label.split(" "); // wrap multi-word (sector) names so the full name shows
              const nameFs = mode === "sector" ? 11.5 : 12;
              const lines = words.length + 1; // words + the % line
              const startDy = -((lines - 1) * 1.05) / 2;
              return (
                <text x={x} y={y} textAnchor="middle" dominantBaseline="middle" style={{ pointerEvents: "none" }}>
                  {words.map((w, k) => (
                    <tspan key={k} x={x} dy={`${k === 0 ? startDy : 1.05}em`} style={{ fontSize: nameFs, fontWeight: 600, fill: "#fff" }}>{w}</tspan>
                  ))}
                  <tspan x={x} dy="1.05em" style={{ fontSize: nameFs - 1.5, fill: "rgba(255,255,255,0.9)" }}>{pct1(seg.weight)}</tspan>
                </text>
              );
            }}
          >
            {data.map((d) => (
              <Cell key={d.label} fill={d.color} />
            ))}
            <Label
              content={({ viewBox }) => {
                if (!viewBox || !("cx" in viewBox)) return null;
                const { cx, cy } = viewBox as { cx: number; cy: number };
                return (
                  <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                    <tspan x={cx} y={cy - 6} className="fill-white text-[18px] font-semibold">{data.length}</tspan>
                    <tspan x={cx} y={cy + 12} className="fill-white/40 text-[11px]">{mode === "asset" ? "assets" : "sectors"}</tspan>
                  </text>
                );
              }}
            />
          </Pie>
        </PieChart>
      </ChartContainer>
    </Card>
  );
}

// Liquid-glass segmented toggle (Asset / Sector) for the Allocation card header.
function Toggle({ mode, onChange }: { mode: "asset" | "sector"; onChange: (m: "asset" | "sector") => void }) {
  return (
    <div
      className="inline-flex shrink-0 items-center rounded-full p-[2px]"
      style={{ background: "rgba(255,255,255,0.06)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12), 0 0 0 1px rgba(255,255,255,0.08)" }}
    >
      {(["asset", "sector"] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors ${mode === m ? "text-white" : "text-white/50"}`}
          style={mode === m ? { background: "rgba(255,255,255,0.16)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.3), 0 1px 3px rgba(0,0,0,0.35)" } : undefined}
        >
          {m === "asset" ? "Asset" : "Sector"}
        </button>
      ))}
    </div>
  );
}

// ── Efficient frontier (pinch-zoomable) ───────────────────────────────────────────────────────────────
type View = { x0: number; x1: number; y0: number; y1: number };
function Frontier({ result }: { result: FrontierResult }) {
  const frontierData = result.frontier.map((f) => ({ x: f.risk, y: f.ret }));
  const assetPts = result.assets.map((a) => ({ x: a.sigma, y: a.mu, ticker: a.ticker }));
  const portPt = [{ x: result.portfolio.risk, y: result.portfolio.ret, ticker: "Portfolio" }];

  const ptsX = [...assetPts.map((p) => p.x), result.portfolio.risk];
  const ptsY = [...assetPts.map((p) => p.y), result.portfolio.ret];
  // The x right-edge follows the rightmost ASSET (not the frontier's high-risk tail) so no point clips.
  const xa = niceAxis(Math.min(...frontierData.map((d) => d.x), ...ptsX), Math.max(...ptsX));
  const ya = niceAxis(Math.min(...frontierData.map((d) => d.y), ...ptsY), Math.max(...frontierData.map((d) => d.y), ...ptsY));
  const fullX = xa.domain, fullY = ya.domain;

  // Pinch-to-zoom: `view` is the visible data window (null = full). Zooming in spreads the points, so the
  // label de-collision has room to reveal tickers that were hidden when everything was bunched up.
  const [view, setView] = useState<View | null>(null);
  const [hover, setHover] = useState<{ px: number; py: number; x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const g = useRef<{ dist: number; cx: number; cy: number; view: View } | null>(null);
  const lastTap = useRef(0);

  const dom: View = view ?? { x0: fullX[0], x1: fullX[1], y0: fullY[0], y1: fullY[1] };
  const inWin = (t: number, lo: number, hi: number) => t >= lo - 1e-9 && t <= hi + 1e-9;
  const xticks = view ? niceAxis(dom.x0, dom.x1).ticks.filter((t) => inWin(t, dom.x0, dom.x1)) : xa.ticks;
  const yticks = view ? niceAxis(dom.y0, dom.y1).ticks.filter((t) => inWin(t, dom.y0, dom.y1)) : ya.ticks;

  const clamp = (v: View): View => {
    const fw = fullX[1] - fullX[0], fh = fullY[1] - fullY[0];
    const w = Math.min(v.x1 - v.x0, fw), h = Math.min(v.y1 - v.y0, fh);
    let cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2;
    let x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    if (x0 < fullX[0]) { x1 += fullX[0] - x0; x0 = fullX[0]; }
    if (x1 > fullX[1]) { x0 -= x1 - fullX[1]; x1 = fullX[1]; }
    if (y0 < fullY[0]) { y1 += fullY[0] - y0; y0 = fullY[0]; }
    if (y1 > fullY[1]) { y0 -= y1 - fullY[1]; y1 = fullY[1]; }
    return { x0, x1, y0, y1 };
  };
  const PL = 40, PT = 16;
  const insets = (r: DOMRect) => ({ PL, PT, plotW: Math.max(1, r.width - 56), plotH: Math.max(1, r.height - 56) });

  // Map the exact pointer position to its (volatility, return) by reading both axes at the cursor. The
  // dot sits where the user actually taps — not snapped to the curve.
  const computeHover = (clientX: number, clientY: number) => {
    if (!wrapRef.current) return null;
    const r = wrapRef.current.getBoundingClientRect();
    const { plotW, plotH } = insets(r);
    const fx = (clientX - r.left - PL) / plotW;
    const fy = (clientY - r.top - PT) / plotH;
    if (fx < -0.03 || fx > 1.03 || fy < -0.03 || fy > 1.03) return null;
    const cfx = Math.min(1, Math.max(0, fx)), cfy = Math.min(1, Math.max(0, fy));
    const x = dom.x0 + cfx * (dom.x1 - dom.x0);
    const y = dom.y1 - cfy * (dom.y1 - dom.y0);
    return { px: PL + cfx * plotW, py: PT + cfy * plotH, x, y };
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1];
      g.current = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2, view: { ...dom } };
      setHover(null);
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) { setView(null); setHover(null); } // double-tap → reset
      lastTap.current = now;
      g.current = null;
      setHover(computeHover(e.touches[0].clientX, e.touches[0].clientY)); // single tap → crosshair tooltip
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!wrapRef.current) return;
    if (e.touches.length === 2 && g.current) {
      const r = wrapRef.current.getBoundingClientRect();
      const { plotW, plotH } = insets(r);
      const a = e.touches[0], b = e.touches[1];
      const ratio = Math.max(0.3, Math.min(6, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / (g.current.dist || 1)));
      const v0 = g.current.view;
      const w = (v0.x1 - v0.x0) / ratio, h = (v0.y1 - v0.y0) / ratio;
      const fx = Math.min(1, Math.max(0, (g.current.cx - r.left - PL) / plotW));
      const fy = Math.min(1, Math.max(0, (g.current.cy - r.top - PT) / plotH));
      const dataX = v0.x0 + fx * (v0.x1 - v0.x0), dataY = v0.y1 - fy * (v0.y1 - v0.y0);
      setView(clamp({ x0: dataX - fx * w, x1: dataX - fx * w + w, y0: dataY - (1 - fy) * h, y1: dataY + fy * h }));
    } else if (e.touches.length === 1) {
      setHover(computeHover(e.touches[0].clientX, e.touches[0].clientY)); // drag one finger → move the crosshair
    }
  };
  const onTouchEnd = (e: React.TouchEvent) => { if (e.touches.length === 0) g.current = null; };
  const onMouseMove = (e: React.MouseEvent) => setHover(computeHover(e.clientX, e.clientY));
  const onMouseLeave = () => setHover(null);

  return (
    <Card
      title="Efficient Frontier"
      info="Each dot is one holding. The higher it sits the more it tends to grow, and the further right the more its price swings around (more risk). The curved line is the best growth you could aim for at each level of risk, and the green dot is where your current mix lands."
    >
      <div className="mb-1 px-0.5 text-[10px] font-medium uppercase tracking-wider text-white/35">Return</div>
      <div
        ref={wrapRef}
        className="relative"
        style={{ touchAction: "none" }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        {view && (
          <button onClick={() => setView(null)} className="absolute right-1 top-1 z-20 rounded-full border border-white/15 bg-black/50 px-2.5 py-1 text-[10.5px] font-medium text-white/70 backdrop-blur-md">Reset</button>
        )}
        <ChartContainer config={{}} className="h-[240px] w-full">
          <ComposedChart data={frontierData} margin={{ top: 16, right: 16, bottom: 24, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis type="number" dataKey="x" domain={[dom.x0, dom.x1]} ticks={xticks} allowDataOverflow tickFormatter={pctTick} tickLine={false} axisLine={false}>
              <Label value="Volatility (risk)" position="insideBottom" offset={-12} className="fill-white/40 text-[11px]" />
            </XAxis>
            <YAxis type="number" dataKey="y" domain={[dom.y0, dom.y1]} ticks={yticks} allowDataOverflow tickFormatter={pctTick} width={36} tickLine={false} axisLine={false} />
            <Line dataKey="y" type="monotone" stroke={FRONTIER} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Scatter data={assetPts} dataKey="y" fill={ASSET_DOT} />
            <Scatter data={portPt} dataKey="y" fill={PORT_DOT} shape="circle" />
            {/* Asset labels: close to their dot, rightmost on the left, de-collided against every marker. */}
            <Customized component={(props: unknown) => <AssetLabels chart={props} assets={assetPts} obstacles={[...assetPts, ...portPt]} />} />
          </ComposedChart>
        </ChartContainer>
        {/* Custom crosshair tooltip — tap/hover anywhere maps to the frontier point at that risk. */}
        {hover && (
          <>
            <div className="pointer-events-none absolute top-4 bottom-10 z-10" style={{ left: hover.px, borderLeft: "1px dashed rgba(255,255,255,0.28)" }} />
            <div className="pointer-events-none absolute z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-black" style={{ left: hover.px, top: hover.py, background: FRONTIER }} />
            <div
              className="pointer-events-none absolute z-20 min-w-[8.5rem] rounded-xl border border-white/10 bg-black/90 px-3 py-2 text-[12px] backdrop-blur-md"
              style={{ left: Math.min(hover.px + 12, (wrapRef.current?.clientWidth ?? 300) - 150), top: Math.max(4, hover.py - 58) }}
            >
              <TipRow k="Return" v={pct1(hover.y)} />
              <TipRow k="Volatility" v={pct1(hover.x)} />
              <TipRow k="Sharpe" v={(hover.x > 1e-9 ? (hover.y - RISK_FREE) / hover.x : 0).toFixed(2)} />
            </div>
          </>
        )}
      </div>
      <div className="mt-2 flex items-center justify-center gap-4 text-[11px] text-white/45">
        <Legend color={FRONTIER} label="Frontier" line />
        <Legend color={ASSET_DOT} label="Assets" />
        <Legend color={PORT_DOT} label="Your portfolio" />
      </div>
    </Card>
  );
}

function Legend({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      {line ? <span className="h-[2px] w-4 rounded-full" style={{ background: color }} /> : <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
      {label}
    </span>
  );
}

function TipRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center gap-6 text-white/55">
      <span>{k}</span>
      <span className="ml-auto font-medium tabular-nums text-white">{v}</span>
    </div>
  );
}

// Renders each asset's ticker just beside its dot. The rightmost dot is labelled on its LEFT (so it never
// runs off the right edge); every other dot on its RIGHT. Labels are nudged vertically to clear every
// marker and each other, and clamped inside the plot. Runs via <Customized/> so it has the pixel scales.
type ChartInternals = {
  xAxisMap?: Record<string, { scale?: (v: number) => number }>;
  yAxisMap?: Record<string, { scale?: (v: number) => number }>;
  offset?: { left: number; top: number; width: number; height: number };
};
function AssetLabels({ chart, assets, obstacles }: { chart: unknown; assets: { x: number; y: number; ticker: string }[]; obstacles: { x: number; y: number }[] }) {
  const c = chart as ChartInternals;
  const xScale = c.xAxisMap && Object.values(c.xAxisMap)[0]?.scale;
  const yScale = c.yAxisMap && Object.values(c.yAxisMap)[0]?.scale;
  const off = c.offset;
  if (!xScale || !yScale || !off) return null;

  const LH = 11, GAP = 7; // label line height + gap from the dot
  const measure = (t: string) => Math.max(18, t.length * 6);
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  for (const o of obstacles) placed.push({ x: xScale(o.x) - 5, y: yScale(o.y) - 5, w: 10, h: 10 }); // every dot is an obstacle
  const hit = (r: { x: number; y: number; w: number; h: number }) =>
    placed.some((p) => !(r.x + r.w < p.x || r.x > p.x + p.w || r.y + r.h < p.y || r.y > p.y + p.h));
  const clampX = (x: number, w: number) => Math.max(off.left + 1, Math.min(off.left + off.width - w - 1, x));
  const clampY = (y: number) => Math.max(off.top + LH - 1, Math.min(off.top + off.height - 2, y));

  const pts = assets.map((a) => ({ ticker: a.ticker, px: xScale(a.x), py: yScale(a.y), w: measure(a.ticker) }));
  const rightmost = Math.max(...pts.map((p) => p.px));

  const out = pts
    .slice()
    .sort((a, b) => a.px - b.px)
    .map((p) => {
      const anchor: "start" | "end" = p.px >= rightmost - 0.5 ? "end" : "start"; // rightmost → left of dot
      let rectX = clampX(anchor === "end" ? p.px - GAP - p.w : p.px + GAP, p.w);
      let ty = clampY(p.py + 3);
      for (const dy of [3, -12, 14, -25, 27, -38, 40]) {
        ty = clampY(p.py + dy);
        rectX = clampX(anchor === "end" ? p.px - GAP - p.w : p.px + GAP, p.w);
        const r = { x: rectX, y: ty - LH + 2, w: p.w, h: LH };
        if (!hit(r) || dy === 40) { placed.push(r); break; }
      }
      return { ticker: p.ticker, tx: anchor === "end" ? rectX + p.w : rectX, ty, anchor };
    });

  return (
    <g style={{ pointerEvents: "none" }}>
      {out.map((o, i) => (
        <text key={i} x={o.tx} y={o.ty} textAnchor={o.anchor} style={{ fontSize: 9.5, fontWeight: 500, fill: "rgba(255,255,255,0.62)" }}>
          {o.ticker}
        </text>
      ))}
    </g>
  );
}

// ── Efficient-frontier assets matrix ──────────────────────────────────────────────────────────────────
function AssetsMatrix({ result }: { result: FrontierResult }) {
  return (
    <Card
      title="Assets"
      info="One row per holding. It shows how much it might grow in a year, how much its price tends to swing, a simple score of reward for the risk taken, and the smallest and largest share it would take in the best balanced mixes."
    >
      <table className="w-full border-collapse text-left text-[11.5px]">
        <thead>
          <tr className="text-white/40">
            <th className="py-2 pr-3 font-medium">Asset</th>
            <th className="py-2 pr-3 font-medium">Return</th>
            <th className="py-2 pr-3 font-medium">Std Dev</th>
            <th className="py-2 pr-3 font-medium">Sharpe</th>
            <th className="py-2 pr-3 font-medium">Min</th>
            <th className="py-2 font-medium">Max</th>
          </tr>
        </thead>
        <tbody>
          {result.assets.map((a) => (
            <tr key={a.ticker} className="border-t border-white/[0.06]">
              <td className="py-2 pr-3 text-white">{a.ticker}</td>
              <td className="py-2 pr-3 tabular-nums text-white/75">{pct1(a.mu)}</td>
              <td className="py-2 pr-3 tabular-nums text-white/75">{pct1(a.sigma)}</td>
              <td className="py-2 pr-3 tabular-nums text-white/75">{a.sharpe.toFixed(2)}</td>
              <td className="py-2 pr-3 tabular-nums text-white/50">{pct1(a.minWeight)}</td>
              <td className="py-2 tabular-nums text-white/50">{pct1(a.maxWeight)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ── Asset correlations matrix ─────────────────────────────────────────────────────────────────────────
function Correlations({ result }: { result: FrontierResult }) {
  const { tickers, corr } = result;
  return (
    <Card
      title="Asset Correlations"
      info="This shows how often your holdings move in the same direction. A value near 1.00 means two holdings tend to rise and fall together. Lower numbers are better, because holdings that move differently help steady your portfolio when one drops."
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-center text-[10.5px]">
          <thead>
            <tr>
              <th className="w-[1%] whitespace-nowrap px-0.5 pb-1" />
              {tickers.map((t) => (
                <th key={t} className="px-0.5 pb-1 font-medium text-white/50">{t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tickers.map((rowT, i) => (
              <tr key={rowT}>
                <th className="w-[1%] whitespace-nowrap pr-1.5 text-right font-medium text-white/50">{rowT}</th>
                {tickers.map((colT, j) => {
                  const v = corr[i][j];
                  return (
                    <td key={colT} className="p-[1.5px]">
                      <div
                        className="rounded-[5px] py-1 tabular-nums text-white/85"
                        style={{ background: `rgba(143,179,224,${(0.06 + v * 0.42).toFixed(3)})` }}
                      >
                        {v.toFixed(2)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
