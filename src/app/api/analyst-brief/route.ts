import { NextResponse } from "next/server";
import { getAnalystBriefs } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?symbols=AAPL,NVDA → { briefs: { AAPL: "...", ... } }.
// Reads assets.analyst_brief (written by the daily agent). Tickers without a brief are omitted.
export async function GET(req: Request) {
  const symbols = (new URL(req.url).searchParams.get("symbols") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 40);
  if (!symbols.length) return NextResponse.json({ briefs: {} });
  try {
    return NextResponse.json({ briefs: await getAnalystBriefs(symbols) });
  } catch (e) {
    return NextResponse.json({ briefs: {}, error: e instanceof Error ? e.message : "Brief fetch failed." }, { status: 502 });
  }
}
