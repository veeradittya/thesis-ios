// Mean-variance portfolio theory for the Overview tab. For this local prototype the per-asset capital-
// market assumptions (expected return μ, volatility σ) and the pairwise correlations are ILLUSTRATIVE
// stand-ins — not live estimates. They're enough to build a covariance matrix and derive the classic
// (Markowitz) efficient frontier analytically, the tangency (max-Sharpe) portfolio, and per-asset stats.

export const RISK_FREE = 0.04; // annual risk-free rate, used for Sharpe ratios

// Illustrative annualized expected return + volatility per demo ticker. Unknown tickers fall back below.
const CMA: Record<string, { name: string; mu: number; sigma: number }> = {
  AAPL: { name: "Apple", mu: 0.12, sigma: 0.26 },
  MSFT: { name: "Microsoft", mu: 0.13, sigma: 0.24 },
  NVDA: { name: "NVIDIA", mu: 0.28, sigma: 0.5 },
  AMZN: { name: "Amazon", mu: 0.15, sigma: 0.32 },
  TSLA: { name: "Tesla", mu: 0.2, sigma: 0.55 },
  GOOGL: { name: "Alphabet", mu: 0.11, sigma: 0.27 },
};

// Pairwise correlations (symmetric); missing pairs use DEFAULT_CORR.
const DEFAULT_CORR = 0.5;
const CORR: Record<string, number> = {
  "AAPL|MSFT": 0.62, "AAPL|NVDA": 0.5, "AAPL|AMZN": 0.55, "AAPL|TSLA": 0.42, "AAPL|GOOGL": 0.6,
  "MSFT|NVDA": 0.56, "MSFT|AMZN": 0.6, "MSFT|TSLA": 0.4, "MSFT|GOOGL": 0.66,
  "NVDA|AMZN": 0.5, "NVDA|TSLA": 0.52, "NVDA|GOOGL": 0.5,
  "AMZN|TSLA": 0.45, "AMZN|GOOGL": 0.6,
  "TSLA|GOOGL": 0.4,
};
function corr(a: string, b: string): number {
  if (a === b) return 1;
  return CORR[`${a}|${b}`] ?? CORR[`${b}|${a}`] ?? DEFAULT_CORR;
}
// Unknown tickers get deterministic but VARIED assumptions derived from the symbol, so no two are ever
// identical — which would make the covariance matrix degenerate (D≈0) and blow the frontier math up. This
// keeps the model well-posed for ANY portfolio; the daily agent will replace these with real estimates.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function cma(ticker: string): { name: string; mu: number; sigma: number } {
  const known = CMA[ticker];
  if (known) return known;
  const h = hashStr(ticker);
  return { name: ticker, mu: 0.08 + (h % 130) / 1000, sigma: 0.22 + ((h >>> 8) % 280) / 1000 }; // μ 8–21%, σ 22–50%
}

export interface AssetStat {
  ticker: string;
  name: string;
  mu: number; // expected return
  sigma: number; // standard deviation
  sharpe: number; // (mu - rf) / sigma
  weight: number; // current portfolio weight
  minWeight: number; // min weight across the efficient frontier
  maxWeight: number; // max weight across the efficient frontier
}
export interface FrontierPoint { risk: number; ret: number }
export interface FrontierResult {
  tickers: string[];
  assets: AssetStat[];
  frontier: FrontierPoint[]; // the efficient (upper) frontier curve
  corr: number[][]; // correlation matrix in `tickers` order
  portfolio: { ret: number; risk: number; sharpe: number };
  minVar: { ret: number; risk: number };
  maxSharpe: { ret: number; risk: number; sharpe: number; weights: number[] };
}

// ── linear algebra ────────────────────────────────────────────────────────────────────────────────
function invert(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]); // [m | I]
  for (let col = 0; col < n; col++) {
    // partial pivot
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    [a[col], a[piv]] = [a[piv], a[col]];
    const d = a[col][col] || 1e-12;
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}
const matVec = (M: number[][], v: number[]) => M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
const dot = (a: number[], v: number[]) => a.reduce((s, x, j) => s + x * v[j], 0);

// Build the full mean-variance model + efficient frontier for a set of weighted holdings.
export function computeFrontier(holdings: Array<{ ticker: string; weight: number | null }>): FrontierResult | null {
  const rows = holdings
    .filter((h) => h.ticker)
    .map((h) => ({ ticker: h.ticker.toUpperCase(), weight: Math.max(0, h.weight ?? 0) }));
  if (rows.length < 2) return null; // need at least two assets for a frontier

  const tickers = rows.map((r) => r.ticker);
  const n = tickers.length;
  const mu = tickers.map((t) => cma(t).mu);
  const sigma = tickers.map((t) => cma(t).sigma);
  const wsum = rows.reduce((s, r) => s + r.weight, 0) || 1;
  const weights = rows.map((r) => r.weight / wsum); // normalize to sum 1

  // correlation + covariance matrices
  const C = tickers.map((a) => tickers.map((b) => corr(a, b)));
  const cov = tickers.map((_, i) => tickers.map((__, j) => C[i][j] * sigma[i] * sigma[j]));
  const inv = invert(cov);

  const ones = mu.map(() => 1);
  const invOnes = matVec(inv, ones);
  const invMu = matVec(inv, mu);
  const A = dot(ones, invOnes);
  const B = dot(ones, invMu);
  const Cc = dot(mu, invMu);
  const D = A * Cc - B * B || 1e-12;

  const portRet = dot(weights, mu);
  const portVar = dot(weights, matVec(cov, weights));
  const portRisk = Math.sqrt(Math.max(0, portVar));
  const mkSharpe = (ret: number, risk: number) => (risk > 1e-9 ? (ret - RISK_FREE) / risk : 0);

  // min-variance portfolio
  const mvRet = B / A;
  const mvRisk = Math.sqrt(Math.max(0, 1 / A));

  // efficient frontier: sample target returns from the min-variance return up to a bit past the top asset
  const topMu = Math.max(...mu);
  const hi = topMu + 0.02;
  const STEPS = 60;
  const frontier: FrontierPoint[] = [];
  const wMin = new Array(n).fill(Infinity);
  const wMax = new Array(n).fill(-Infinity);
  for (let k = 0; k <= STEPS; k++) {
    const m = mvRet + ((hi - mvRet) * k) / STEPS;
    const variance = (A * m * m - 2 * B * m + Cc) / D;
    frontier.push({ risk: Math.sqrt(Math.max(0, variance)), ret: m });
    // weights along the frontier: w = g*(C-Bm)/D + h*(Am-B)/D  where g=inv·ones, h=inv·mu
    const g = (Cc - B * m) / D;
    const hh = (A * m - B) / D;
    for (let i = 0; i < n; i++) {
      const wi = invOnes[i] * g + invMu[i] * hh;
      wMin[i] = Math.min(wMin[i], wi);
      wMax[i] = Math.max(wMax[i], wi);
    }
  }

  // tangency (max-Sharpe) portfolio: w ∝ inv·(mu - rf)
  const excess = mu.map((m) => m - RISK_FREE);
  const invEx = matVec(inv, excess);
  const invExSum = invEx.reduce((s, x) => s + x, 0) || 1e-12;
  const tanW = invEx.map((x) => x / invExSum);
  const tanRet = dot(tanW, mu);
  const tanRisk = Math.sqrt(Math.max(0, dot(tanW, matVec(cov, tanW))));

  const assets: AssetStat[] = tickers.map((t, i) => ({
    ticker: t,
    name: cma(t).name,
    mu: mu[i],
    sigma: sigma[i],
    sharpe: mkSharpe(mu[i], sigma[i]),
    weight: weights[i],
    minWeight: wMin[i],
    maxWeight: wMax[i],
  }));

  return {
    tickers,
    assets,
    frontier,
    corr: C,
    portfolio: { ret: portRet, risk: portRisk, sharpe: mkSharpe(portRet, portRisk) },
    minVar: { ret: mvRet, risk: mvRisk },
    maxSharpe: { ret: tanRet, risk: tanRisk, sharpe: mkSharpe(tanRet, tanRisk), weights: tanW },
  };
}

// A short, deterministic "AI overview" — a succinct plain-language read of the model (no em dashes).
export function interpretation(r: FrontierResult): string[] {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const bestSharpe = [...r.assets].sort((a, b) => b.sharpe - a.sharpe)[0];
  const top = [...r.assets].sort((a, b) => b.weight - a.weight)[0];
  let s = 0, c = 0;
  for (let i = 0; i < r.tickers.length; i++)
    for (let j = i + 1; j < r.tickers.length; j++) { s += r.corr[i][j]; c++; }
  const avgCorr = c ? s / c : 0;
  const roomToImprove = r.maxSharpe.sharpe - r.portfolio.sharpe > 0.05;

  return [
    `In an average year this mix aims for about ${pct(r.portfolio.ret)} growth, with its value swinging up and down by roughly ${pct(r.portfolio.risk)} along the way.`,
    `${bestSharpe.ticker} gives you the most reward for the risk it carries. ${roomToImprove ? "A more balanced mix could earn a little more return for the same risk." : "Your mix is already well balanced for the risk you take."}`,
    `${top.ticker} is your biggest holding at ${pct(top.weight)}. Your stocks tend to ${avgCorr > 0.55 ? "rise and fall together" : "move somewhat together"}, so they may not cushion each other when the market drops.`,
  ];
}
