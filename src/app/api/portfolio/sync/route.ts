import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { syncHoldings, getHoldings, setPortfolioAnalytics } from "@/lib/turso";
import { computeFrontier } from "@/lib/portfolioTheory";
import { ensureMarketStats } from "@/lib/marketStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → the SIGNED-IN user's holdings from Turso (their account portfolio). Lets the client restore
// the ledger on a device with no local copy, so a portfolio follows the account. Guests get 401.
export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    const holdings = await getHoldings(userId);
    return NextResponse.json({ holdings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "read failed" }, { status: 502 });
  }
}

// POST { holdings:[{ticker,name?,weight?,thesis?}] } → replaces the SIGNED-IN user's holdings in
// Turso, which is the source the scheduled CMA agent reads each pass. The user id comes from the
// session (never the request body), so no client can write to another account's portfolio. Guests
// (no session) are rejected — their edits stay browser-local until they sign in.
export async function POST(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "sign in required" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      holdings?: Array<{ ticker: string; name?: string | null; weight?: number | null; thesis?: string | null }>;
    };
    const holdings = Array.isArray(body.holdings) ? body.holdings : [];
    const count = await syncHoldings(userId, holdings);
    // Recompute + store the modern-portfolio-theory analytics so the daily agent can read them and write
    // its overview. Best-effort — a failure here must never block the holdings sync. (null when <2 assets.)
    // ensureMarketStats refreshes real β/σ from Alpaca ONLY for tickers that are new or stale (so a weight
    // change or a removal fetches nothing); the correlation matrix is then derived from those real numbers.
    try {
      const market = await ensureMarketStats(holdings.map((h) => h.ticker).filter(Boolean));
      const analytics = computeFrontier(holdings.map((h) => ({ ticker: h.ticker, weight: h.weight ?? null })), market);
      await setPortfolioAnalytics(userId, analytics);
    } catch {}
    return NextResponse.json({ ok: true, count });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "sync failed" }, { status: 502 });
  }
}
