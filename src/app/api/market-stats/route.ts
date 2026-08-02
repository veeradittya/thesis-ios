import { NextResponse } from "next/server";
import { getMarketStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?tickers=A,B,C → cached real β/σ per ticker + the market's annualized volatility (σmkt), so the
// Overview can render real correlations client-side. READ-ONLY: never fetches Alpaca (that happens in
// /api/portfolio/sync when holdings change) — missing tickers are simply absent and fall back to the
// illustrative model. Market data is not user-specific, so this needs no auth.
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("tickers") || "";
  const tickers = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) return NextResponse.json({ stats: {}, sigmaMkt: null });
  try {
    const cache = await getMarketStats([...tickers, "SPY"]);
    const stats: Record<string, { beta: number; sigma: number }> = {};
    for (const t of tickers) if (cache[t]) stats[t] = { beta: cache[t].beta, sigma: cache[t].sigma };
    const spy = cache["SPY"];
    return NextResponse.json({ stats, sigmaMkt: spy ? spy.sigma : null }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ stats: {}, sigmaMkt: null });
  }
}
