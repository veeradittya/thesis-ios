import { NextResponse } from "next/server";
import { getAllPushTargets, getHoldings, insertScheduledPushes, countScheduledPushesForUserOnDate } from "@/lib/turso";
import { generateTakeaways } from "@/lib/portfolioTakeaways";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_TAKEAWAYS_PER_USER = 5;

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

// The wall-clock UTC offset (minutes) of a timezone at a given instant, e.g. America/New_York → -240
// (EDT) or -300 (EST). Derived via Intl so EDT/EST is handled automatically, no hardcoded offsets.
function tzOffsetMinutes(timeZone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>;
  const hour = p.hour === "24" ? "00" : p.hour; // Intl can emit hour "24" at midnight
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  return Math.round((asUTC - at.getTime()) / 60000);
}

// Today's trading-day window in America/New_York, expressed as UTC epoch ms, plus the ET run-date
// string. 09:00-16:00 ET never crosses a DST boundary (transitions happen at 02:00), so a single
// same-day offset is correct for the whole window.
function etWindow(now: Date): { startMs: number; endMs: number; runDate: string } {
  const timeZone = "America/New_York";
  const dparts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const y = +dparts.year;
  const m = +dparts.month;
  const d = +dparts.day;
  const runDate = `${dparts.year}-${dparts.month}-${dparts.day}`;

  // Offset for this ET day: probe an instant near ET noon so we never straddle the 02:00 DST switch.
  const guess = tzOffsetMinutes(timeZone, now);
  const noonInstant = new Date(Date.UTC(y, m - 1, d, 12, 0, 0) - guess * 60000);
  const offMin = tzOffsetMinutes(timeZone, noonInstant);

  const startMs = Date.UTC(y, m - 1, d, 9, 0, 0) - offMin * 60000;
  const endMs = Date.UTC(y, m - 1, d, 16, 0, 0) - offMin * 60000;
  return { startMs, endMs, runDate };
}

async function run() {
  const now = new Date();
  const { startMs, endMs, runDate } = etWindow(now);
  const span = Math.max(1, endMs - startMs);

  const targets = await getAllPushTargets();
  const userIds = [...new Set(targets.map((t) => t.userId).filter(Boolean))];

  let users = 0;
  let scheduled = 0;
  for (const userId of userIds) {
    // Per-user/day dedupe: skip anyone already scheduled for today's ET date.
    if ((await countScheduledPushesForUserOnDate(userId, runDate)) > 0) continue;

    const holdings = await getHoldings(userId);
    if (holdings.length < 1) continue;

    const points = await generateTakeaways(userId, holdings);
    if (!points.length) continue;

    // One notification per takeaway, each at an INDEPENDENT uniformly-random instant in [09:00, 16:00) ET.
    const rows = points.slice(0, MAX_TAKEAWAYS_PER_USER).map((p) => ({
      userId,
      title: "Thesis",
      body: p.short,
      fireAt: new Date(startMs + Math.random() * span).toISOString(),
      runDate,
    }));
    await insertScheduledPushes(rows);
    users++;
    scheduled += rows.length;
  }

  return { users, scheduled };
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "forbidden" }, { status: 401 });
  try {
    return NextResponse.json(await run());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "schedule failed" }, { status: 502 });
  }
}

// Vercel Cron invokes the path with a GET.
export async function GET(req: Request) {
  return POST(req);
}
