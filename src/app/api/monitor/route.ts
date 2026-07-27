import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getLatestMonitor } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The public example portfolio the scheduled agent keeps fresh — shown to signed-out visitors so
// the Daily Briefing has something to render before you sign in.
const DEMO_USER = "pilot";

// GET → the latest scheduled-agent run (portfolio memo + per-holding verdicts) for the CURRENT
// user. The scope comes from the session, so signed-in users only ever see their own brief and
// signed-out visitors get the shared demo. Any ?user= query param is ignored (no reading another
// account's brief by guessing an id).
export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id ?? DEMO_USER;
    return NextResponse.json(await getLatestMonitor(userId));
  } catch (e) {
    return NextResponse.json(
      { memo: null, updatedAt: null, results: [], error: e instanceof Error ? e.message : "monitor failed" },
      { status: 502 },
    );
  }
}
