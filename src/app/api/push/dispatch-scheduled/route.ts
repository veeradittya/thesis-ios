import { NextResponse } from "next/server";
import { getDueScheduledPushes, getAllPushTargets, markScheduledPushSent, deletePushToken } from "@/lib/turso";
import { sendApnsPush } from "@/lib/apns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Two ways in, both secret-gated (identical to send-brief):
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
  const nowIso = new Date().toISOString();
  const due = await getDueScheduledPushes(nowIso);
  if (!due.length) return { due: 0, sent: 0, failed: 0, pruned: 0 };

  // Lets you verify the discovery half (due rows) before the Apple key exists.
  if (!process.env.APNS_KEY) {
    return { due: due.length, sent: 0, failed: 0, pruned: 0, note: "APNS_KEY not set — found due rows but did not send" };
  }

  // Map each user to their current device token(s).
  const byUser = new Map<string, string[]>();
  for (const t of await getAllPushTargets()) {
    const arr = byUser.get(t.userId) || [];
    arr.push(t.token);
    byUser.set(t.userId, arr);
  }

  let sent = 0;
  let failed = 0;
  let pruned = 0;
  for (const row of due) {
    const tokens = byUser.get(row.userId) || [];
    if (!tokens.length) {
      // The user has no registered device anymore — retire the row so it doesn't linger forever.
      await markScheduledPushSent(row.id);
      continue;
    }
    // Mirrors BRIEF_PAYLOAD; the takeaway text is the body and the custom keys deep-link the tap to
    // the Hivemind dashboard (native app must map view:"dashboard" + dash:"hivemind" → the Hivemind tab).
    const payload = {
      aps: { alert: { title: "Thesis", body: row.body }, sound: "default" },
      view: "dashboard",
      dash: "hivemind",
    };
    const results = await sendApnsPush(tokens, payload);
    let anyOk = false;
    let retriable = false;
    for (const r of results) {
      if (r.ok) { sent++; anyOk = true; continue; }
      failed++;
      if (r.status === 410 || r.reason === "Unregistered" || r.reason === "BadDeviceToken") {
        try { await deletePushToken(r.token); pruned++; } catch {}
      } else {
        retriable = true; // a transient failure — leave the row for the next dispatch tick
      }
    }
    // Stamp sent unless there's a transient failure worth retrying (a delivered-to-some or all-dead push
    // is done; an all-transient-fail push stays unsent and retries on the next poll).
    if (anyOk || !retriable) await markScheduledPushSent(row.id);
  }
  return { due: due.length, sent, failed, pruned };
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "forbidden" }, { status: 401 });
  try {
    return NextResponse.json(await run());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "dispatch failed" }, { status: 502 });
  }
}

// Vercel Cron invokes the path with a GET.
export async function GET(req: Request) {
  return POST(req);
}
