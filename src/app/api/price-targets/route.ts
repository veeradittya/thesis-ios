import { NextResponse } from "next/server";
import { getPriceTargets } from "@/lib/priceTargets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?symbols=AAPL,NVDA → { targets: { AAPL: {high,low,consensus,median}, ... } }.
// Names with no analyst price-target coverage are omitted (the card hides the section).
export async function GET(req: Request) {
  const symbols = (new URL(req.url).searchParams.get("symbols") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 30);
  if (!symbols.length) return NextResponse.json({ targets: {} });
  try {
    return NextResponse.json({ targets: await getPriceTargets(symbols) });
  } catch (e) {
    return NextResponse.json({ targets: {}, error: e instanceof Error ? e.message : "Price targets failed." }, { status: 502 });
  }
}
