import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getLatestMonitor } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The public example portfolio the scheduled agent keeps fresh — shown to signed-out visitors, and
// used as the fallback brief for a freshly-signed-in user until their own has been generated.
const DEMO_USER = "pilot";

// GET → the latest scheduled-agent run (portfolio memo + per-holding verdicts) for the CURRENT
// user. The scope comes from the session, so signed-in users only ever see their own brief and
// signed-out visitors get the shared demo. Any ?user= query param is ignored.
//
// New signed-in users have no agent output yet (the agent runs on a schedule), so their brief would
// render half-empty. Until the agent has generated their own brief — signalled by their portfolio
// memo existing — we serve the full demo brief instead, so nothing looks missing.
export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json(await getLatestMonitor(DEMO_USER));

    const mine = await getLatestMonitor(userId);
    if (mine.memo) return NextResponse.json(mine); // their own brief is ready
    return NextResponse.json(await getLatestMonitor(DEMO_USER)); // fall back to the demo until it is
  } catch (e) {
    return NextResponse.json(
      { memo: null, updatedAt: null, results: [], error: e instanceof Error ? e.message : "monitor failed" },
      { status: 502 },
    );
  }
}
