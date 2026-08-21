import { NextResponse } from "next/server";
import fixture from "@/data/youtube-social.fixture.json";
import { getYouTubeSocialRows, putYouTubeSocialRows } from "@/lib/turso";
import {
  filterYouTubeSnapshots,
  normalizeYouTubeSnapshot,
  youtubeSnapshotsAreStale,
  type YouTubeSocialResponse,
} from "@/lib/youtubeSocial";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tickers(req: Request): string[] {
  return (new URL(req.url).searchParams.get("tickers") || "").split(",")
    .map((ticker) => ticker.trim().toUpperCase())
    .filter((ticker) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker))
    .slice(0, 30);
}

export async function GET(req: Request) {
  const requested = tickers(req);
  const stored = await getYouTubeSocialRows(requested);
  const live = stored.flatMap((raw) => {
    try { const row = normalizeYouTubeSnapshot(JSON.parse(raw)); return row ? [row] : []; }
    catch { return []; }
  });
  const fixtureValues: unknown[] = Array.isArray(fixture)
    ? fixture
    : ((fixture as unknown as { snapshots?: unknown[] }).snapshots || []);
  const fallback = fixtureValues.flatMap((raw) => {
    const row = normalizeYouTubeSnapshot(raw);
    return row ? [row] : [];
  });
  const source = live.length ? "live" : "fixture";
  const snapshots = filterYouTubeSnapshots(live.length ? live : fallback, requested);
  const generatedAt = snapshots.length
    ? snapshots.reduce((latest, row) => Date.parse(row.generatedAt) > Date.parse(latest) ? row.generatedAt : latest, snapshots[0].generatedAt)
    : null;
  const body: YouTubeSocialResponse = { snapshots, generatedAt, stale: youtubeSnapshotsAreStale(snapshots), source };
  return NextResponse.json(body, { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=3600" } });
}

export async function POST(req: Request) {
  const secret = process.env.SOCIAL_INGEST_SECRET || process.env.REDDIT_INGEST_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let input: unknown;
  try { input = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const values = Array.isArray(input) ? input : (input as { snapshots?: unknown })?.snapshots;
  if (!Array.isArray(values)) return NextResponse.json({ error: "Expected snapshots array" }, { status: 400 });
  const snapshots = values.map(normalizeYouTubeSnapshot).filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (!snapshots.length || snapshots.length > 100) return NextResponse.json({ error: "No valid snapshots" }, { status: 400 });
  await putYouTubeSocialRows(snapshots.map((row) => ({ ticker: row.ticker, generatedAt: row.generatedAt, payload: JSON.stringify(row) })));
  return NextResponse.json({ stored: snapshots.length, generatedAt: snapshots[0].generatedAt });
}
