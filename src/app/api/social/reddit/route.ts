import { NextResponse } from "next/server";
import fixture from "@/data/reddit-social.fixture.json";
import { getRedditSocialRows, putRedditSocialRows } from "@/lib/turso";
import {
  filterRedditSnapshots,
  normalizeRedditSnapshot,
  snapshotsAreStale,
  type RedditSocialResponse,
} from "@/lib/redditSocial";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requestedTickers(req: Request): string[] {
  return (new URL(req.url).searchParams.get("tickers") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))
    .slice(0, 30);
}

export async function GET(req: Request) {
  const tickers = requestedTickers(req);
  const stored = await getRedditSocialRows(tickers);
  const live = stored.flatMap((raw) => {
    try {
      const snapshot = normalizeRedditSnapshot(JSON.parse(raw));
      return snapshot ? [snapshot] : [];
    } catch {
      return [];
    }
  });
  const fallback = fixture.flatMap((row) => {
    const snapshot = normalizeRedditSnapshot(row);
    return snapshot ? [snapshot] : [];
  });
  const source = live.length ? "live" : "fixture";
  const snapshots = filterRedditSnapshots(live.length ? live : fallback, tickers);
  const generatedAt = snapshots.length
    ? snapshots.reduce((latest, row) => Date.parse(row.generatedAt) > Date.parse(latest) ? row.generatedAt : latest, snapshots[0].generatedAt)
    : null;
  const body: RedditSocialResponse = { snapshots, generatedAt, stale: snapshotsAreStale(snapshots), source };
  return NextResponse.json(body, { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=3600" } });
}

export async function POST(req: Request) {
  const secret = process.env.REDDIT_INGEST_SECRET;
  const supplied = req.headers.get("authorization");
  if (!secret || supplied !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const values = Array.isArray(input) ? input : (input as { snapshots?: unknown })?.snapshots;
  if (!Array.isArray(values)) return NextResponse.json({ error: "Expected snapshots array" }, { status: 400 });
  const snapshots = values.map(normalizeRedditSnapshot).filter((v): v is NonNullable<typeof v> => Boolean(v));
  if (!snapshots.length || snapshots.length > 100) return NextResponse.json({ error: "No valid snapshots" }, { status: 400 });
  await putRedditSocialRows(snapshots.map((row) => ({
    ticker: row.ticker,
    mentions: row.mentions,
    generatedAt: row.generatedAt,
    payload: JSON.stringify(row),
  })));
  return NextResponse.json({ stored: snapshots.length, generatedAt: snapshots[0].generatedAt });
}
