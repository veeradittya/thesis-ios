import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { setUserName } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { name } → store the SIGNED-IN user's chosen display name (from onboarding) in Turso. The id comes
// from the session (never the body), so no client can rename another account. Mainly for beta-code
// accounts, which have no OAuth profile name: this is what a later sign-in with the same code reads back.
export async function POST(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "sign in required" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

    await setUserName(userId, name.slice(0, 80));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "save failed" }, { status: 502 });
  }
}
