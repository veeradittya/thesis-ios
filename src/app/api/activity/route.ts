import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { logActivityBatch, touchUser } from "@/lib/turso";
import { deviceLabel } from "@/lib/device";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RawEvent { event?: unknown; detail?: unknown; ms?: unknown; ts?: unknown }

// Normalize a client event into a storable row (cap strings, coerce ms, keep the client timestamp).
function normalize(e: RawEvent) {
  const event = (e?.event ?? "").toString().slice(0, 64);
  if (!event) return null;
  const detail = e?.detail == null ? null : (typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)).slice(0, 500);
  const msNum = typeof e?.ms === "number" ? e.ms : Number(e?.ms);
  const durationMs = Number.isFinite(msNum) && msNum >= 0 ? Math.min(Math.round(msNum), 600_000) : null;
  const ts = typeof e?.ts === "string" ? e.ts : null;
  return { event, detail, durationMs, ts };
}

// POST { events: [{event, detail?, ms?, ts?}, ...] }  (or legacy { event, detail?, ms? })
// Append the SIGNED-IN user's activity. The user id comes from the session, never the request, so a
// client can only log its own activity. The whole batch is written in ONE DB round-trip and the
// profile is touched once. Fire-and-forget from the app; feeds the backend monitoring dashboard.
export async function POST(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "sign in required" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { events?: RawEvent[] } & RawEvent;
    const raw = Array.isArray(body.events) ? body.events : body.event != null ? [body] : [];
    const events = raw.map(normalize).filter((e): e is NonNullable<typeof e> => e !== null).slice(0, 200);
    if (!events.length) return NextResponse.json({ error: "no events" }, { status: 400 });

    // Device make/model is best-effort from the request's User-Agent (the client can't be trusted to
    // report its own device, and the UA is the only server-visible signal).
    const ua = req.headers.get("user-agent");
    const device = deviceLabel(ua);

    // Write the whole batch in one round-trip AND backfill the user's Google profile once.
    await Promise.all([
      logActivityBatch(userId, events),
      touchUser(userId, session.user?.email ?? null, session.user?.name ?? null, device, ua ? ua.slice(0, 400) : null),
    ]);
    return NextResponse.json({ ok: true, n: events.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "log failed" }, { status: 502 });
  }
}
