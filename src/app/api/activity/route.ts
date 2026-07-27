import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { logActivity, touchUser } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { event, detail? } → append an activity row for the SIGNED-IN user. The user id comes from
// the session, never the request, so a client can only log its own activity. Fire-and-forget from
// the app; feeds the backend monitoring dashboard's per-user timeline.
export async function POST(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "sign in required" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { event?: string; detail?: unknown };
    const event = (body.event || "").toString().slice(0, 64);
    if (!event) return NextResponse.json({ error: "event required" }, { status: 400 });
    const detail =
      body.detail == null ? null : (typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)).slice(0, 500);

    // Log the event AND backfill the user's Google profile (email/name/last_seen) from the session,
    // so every signed-in user shows up named — even ones who signed in before recording shipped.
    await Promise.all([
      logActivity(userId, event, detail),
      touchUser(userId, session.user?.email ?? null, session.user?.name ?? null),
    ]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "log failed" }, { status: 502 });
  }
}
