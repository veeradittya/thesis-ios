import { NextResponse } from "next/server";
import { getRecommendations } from "@/lib/recommendation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?symbols=AAPL,NVDA → { recommendations: { AAPL: {label,score,analysts,period}, ... } }.
// Names with no analyst coverage are omitted (the card hides the tag).
export async function GET(req: Request) {
  const symbols = (new URL(req.url).searchParams.get("symbols") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 30);
  if (!symbols.length) return NextResponse.json({ recommendations: {} });
  try {
    return NextResponse.json({ recommendations: await getRecommendations(symbols) });
  } catch (e) {
    return NextResponse.json({ recommendations: {}, error: e instanceof Error ? e.message : "Recommendation failed." }, { status: 502 });
  }
}
