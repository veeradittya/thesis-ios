import { NextResponse } from "next/server";
import { getMetrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?symbols=AAPL,NVDA → { metrics: { AAPL: {week52High,week52Low}, ... } }.
// Symbols with no metric data are omitted.
export async function GET(req: Request) {
  const symbols = (new URL(req.url).searchParams.get("symbols") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 30);
  if (!symbols.length) return NextResponse.json({ metrics: {} });
  try {
    return NextResponse.json({ metrics: await getMetrics(symbols) });
  } catch (e) {
    return NextResponse.json({ metrics: {}, error: e instanceof Error ? e.message : "Metrics failed." }, { status: 502 });
  }
}
