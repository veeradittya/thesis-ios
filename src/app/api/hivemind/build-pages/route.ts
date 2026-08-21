import { NextResponse } from "next/server";
import { getDistinctHoldingUserIds, getHoldings, putHivemindPage } from "@/lib/turso";
import { buildHivemindPage } from "@/lib/hivemindPage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Scheduled Hivemind page builder: for every user that holds a position, build the whole page ONCE
// (bundle + takeaways + per-asset overviews) and store it in Turso, so the app reads it with no live
// LLM/synthesis. Runs after the 6:30 ET agents (see vercel.json cron), plus manual/secret-gated runs.
//
// Two ways in, both secret-gated (same pattern as /api/push/send-brief):
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
  const userIds = await getDistinctHoldingUserIds();
  let built = 0;
  let failed = 0;
  // Serial: each user's page is its own multi-source fan-out + up to two LLM calls; running them one
  // at a time keeps memory + upstream rate limits sane within the 300s budget.
  for (const userId of userIds) {
    try {
      const holdings = await getHoldings(userId);
      if (!holdings.length) continue; // nothing to build for an empty portfolio
      const page = await buildHivemindPage(userId, holdings);
      await putHivemindPage(userId, JSON.stringify(page), page.generatedAt);
      built++;
    } catch {
      failed++; // one user's failure must not abort the whole run
    }
  }
  return { users: userIds.length, built, failed };
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "forbidden" }, { status: 401 });
  try {
    return NextResponse.json(await run());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "build failed" }, { status: 502 });
  }
}

// Vercel Cron invokes the path with a GET.
export async function GET(req: Request) {
  return POST(req);
}
