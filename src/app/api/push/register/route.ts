import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { registerPushToken } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { token, platform } → store the SIGNED-IN user's APNs device token so the daily brief push can
// reach them. The user id comes from the session (never the body). 401 for guests — the native shell
// captures a token before login, so the client re-POSTs once the user signs in.
export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "sign in required" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { token?: unknown; platform?: unknown };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const platform = typeof body.platform === "string" ? body.platform.slice(0, 16) : null;
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  try {
    await registerPushToken(token, userId, platform);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "register failed" }, { status: 502 });
  }
}
