import { NextResponse } from "next/server";
import { getPortfolioAnalytics } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?user=<id> → the stored modern-portfolio-theory analytics + the agent's plain-language overview
// for that portfolio. Same read-by-scope shape as /api/monitor; the payload is derived (not sensitive).
// Returns nulls when nothing is stored yet so the client falls back to computing the overview locally.
export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user");
  if (!user) return NextResponse.json({ error: "user required" }, { status: 400 });
  try {
    const data = await getPortfolioAnalytics(user);
    return NextResponse.json(data ?? { analytics: null, aiOverview: null, updatedAt: null }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "read failed" }, { status: 502 });
  }
}
