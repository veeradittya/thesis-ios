import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { deleteAccount } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// In-app account deletion (App Store Guideline 5.1.1(v) — MANDATORY). Deletes ALL of the signed-in
// user's data from Turso (holdings, portfolios, push_tokens, users, activity_log); never the shared
// `assets` table. The user id comes from the session (never the body). 401 for guests.
export async function POST() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "sign in required" }, { status: 401 });

  try {
    await deleteAccount(userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "delete failed" }, { status: 500 });
  }
}
