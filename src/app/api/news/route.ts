import { NextResponse } from "next/server";
import { getNews } from "@/lib/news";
import { getNewsOverviews } from "@/lib/turso";

export const runtime = "nodejs";
export const maxDuration = 30;

// GET ?tickers=NVDA,AAPL → { articles, overviews } — thin wrapper over src/lib/news.ts (the
// fetch/merge logic lives there so /api/analyze can reuse it), plus the news agent's per-ticker
// overview + lean from Turso when present.
export async function GET(req: Request) {
  const tickers = (new URL(req.url).searchParams.get("tickers") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 8);
  if (!tickers.length) return NextResponse.json({ articles: [], overviews: {} });
  const [articles, overviews] = await Promise.all([getNews(tickers), getNewsOverviews(tickers)]);
  return NextResponse.json({ articles, overviews });
}
