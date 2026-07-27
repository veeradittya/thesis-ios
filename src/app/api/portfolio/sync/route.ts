import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { syncHoldings } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const count = await syncHoldings(userId, Array.isArray(body.holdings) ? body.holdings : []);
    return NextResponse.json({ ok: true, count });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "sync failed" }, { status: 502 });
  }
}
