import { NextResponse } from "next/server";
import { getFreshBriefPushTargets, deletePushToken, type PushTarget } from "@/lib/turso";
import { sendApnsPush } from "@/lib/apns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FRESH_WINDOW_MS = 3 * 60 * 60 * 1000; // a brief written in the last ~3h counts as "fresh today"

// Two ways in, both secret-gated:
//   • manual / agent  → header  x-push-secret: <PUSH_SEND_SECRET>
//   • Vercel Cron     → Vercel auto-adds  Authorization: Bearer <CRON_SECRET>  (cron can't set custom headers)
function authorized(req: Request): boolean {
  const s = process.env.PUSH_SEND_SECRET;
  if (s && req.headers.get("x-push-secret") === s) return true;
  const c = process.env.CRON_SECRET;
  if (c && req.headers.get("authorization") === `Bearer ${c}`) return true;
  return false;
}

async function run() {
  const targets = await getFreshBriefPushTargets(FRESH_WINDOW_MS);
  // One push per device token even if a token somehow maps to multiple rows.
  const byToken = new Map<string, PushTarget>();
  for (const t of targets) if (!byToken.has(t.token)) byToken.set(t.token, t);
  const tokens = [...byToken.keys()];
  if (!tokens.length) return { sent: 0, failed: 0, pruned: 0, targets: 0 };

  // Lets you verify the discovery half (fresh-brief users with tokens) before the Apple key exists.
  if (!process.env.APNS_KEY) {
    return { sent: 0, failed: 0, pruned: 0, targets: tokens.length, note: "APNS_KEY not set — found target tokens but did not send" };
  }

  const results = await sendApnsPush(tokens);
  let sent = 0, failed = 0, pruned = 0;
  for (const r of results) {
    if (r.ok) { sent++; continue; }
    failed++;
    if (r.status === 410 || r.reason === "Unregistered" || r.reason === "BadDeviceToken") {
      try { await deletePushToken(r.token); pruned++; } catch {}
    }
  }
  return { sent, failed, pruned, targets: tokens.length };
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "forbidden" }, { status: 401 });
  try {
    return NextResponse.json(await run());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "send failed" }, { status: 502 });
  }
}

// Vercel Cron invokes the path with a GET.
export async function GET(req: Request) {
  return POST(req);
}
