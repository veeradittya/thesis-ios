import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { logActivity, touchUser } from "@/lib/turso";
import { deviceLabel } from "@/lib/device";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { event, detail?, ms? } → append an activity row for the SIGNED-IN user. The user id comes
// from the session, never the request, so a client can only log its own activity. `ms` is how long a
// timed retrieval took. Fire-and-forget from the app; feeds the backend monitoring dashboard.
export async function POST(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "sign in required" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { event?: string; detail?: unknown; ms?: unknown };
    const event = (body.event || "").toString().slice(0, 64);
    if (!event) return NextResponse.json({ error: "event required" }, { status: 400 });
    const detail =
      body.detail == null ? null : (typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)).slice(0, 500);
    const msNum = typeof body.ms === "number" ? body.ms : Number(body.ms);
    const ms = Number.isFinite(msNum) && msNum >= 0 ? Math.min(Math.round(msNum), 600_000) : null;

    // Device make/model is best-effort from the request's User-Agent (the client can't be trusted to
    // report its own device, and the UA is the only server-visible signal).
    const ua = req.headers.get("user-agent");
    const device = deviceLabel(ua);

    // Log the event AND backfill the user's Google profile (email/name/last_seen/device) from the
    // session + request, so every signed-in user shows up named with the device they're on.
    await Promise.all([
      logActivity(userId, event, detail, ms),
      touchUser(userId, session.user?.email ?? null, session.user?.name ?? null, device, ua ? ua.slice(0, 400) : null),
    ]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "log failed" }, { status: 502 });
  }
}
