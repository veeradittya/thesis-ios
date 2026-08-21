import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Live News — resolves Bloomberg Television's CURRENT live YouTube broadcast so the Hivemind
// "Live News" card can embed the stream inline. Bloomberg runs a 24/7 live channel, but the live
// video id rotates when the stream restarts, so we can't hardcode it.
//
// Resolution order:
//   1. YouTube Data API v3 (IP-independent) when YOUTUBE_API_KEY is set — the reliable path. YouTube
//      serves Vercel's datacenter IP a consent/bot page, so the scrape below is unreliable in prod.
//   2. Hardened HTML scrape of the /live page (consent cookies, longer timeout, ytInitialData fallback).
//   3. null → the client renders a "Watch on YouTube" external-link state (NOT the error-153
//      live_stream?channel= embed).

const CHANNEL_ID = "UCIALMKvObZNtJ6AmdCLP7Lg"; // Bloomberg Television (24/7 live)
const LIVE_PAGE = `https://www.youtube.com/channel/${CHANNEL_ID}/live`;
const CHANNEL_URL = `https://www.youtube.com/channel/${CHANNEL_ID}/live`;

// A desktop UA gets us the full watch page with the canonical link; the mobile page is thinner.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const TTL_MS = 5 * 60 * 1000; // re-resolve at most every 5 minutes
type Resolved = { videoId: string; isLive: boolean; title: string | null };
let cache: (Resolved & { at: number }) | null = null;

// 1) Preferred: YouTube Data API v3. Same key the app can share (add YOUTUBE_API_KEY to env).
async function resolveViaApi(): Promise<Resolved | null> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  try {
    const url =
      `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${CHANNEL_ID}` +
      `&eventType=live&type=video&maxResults=1&key=${key}`;
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { items?: Array<{ id?: { videoId?: string } }> };
    const videoId = j.items?.[0]?.id?.videoId;
    return videoId ? { videoId, isLive: true, title: null } : null;
  } catch {
    return null;
  }
}

function extract(html: string): Resolved | null {
  // Canonical link on a live watch page: <link rel="canonical" href="…/watch?v=XXXX">
  const canonical = html.match(/rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{6,20})"/);
  const og = html.match(/property="og:url"\s+content="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{6,20})"/);
  // Fallback: the first videoId in ytInitialData / playerResponse — present even when the consent page
  // strips the canonical/og tags.
  const inData = html.match(/"videoId":"([A-Za-z0-9_-]{11})"/);
  const videoId = canonical?.[1] || og?.[1] || inData?.[1] || null;
  if (!videoId) return null;
  const isLive = /"isLiveNow":true|BADGE_STYLE_TYPE_LIVE_NOW|"iconType":"LIVE"/.test(html);
  const title = html.match(/"videoDetails":\{[^}]*?"title":"([^"]{1,160})"/)?.[1]?.replace(/\\u0026/g, "&") || null;
  return { videoId, isLive, title };
}

// 2) Hardened scrape: consent cookies (so datacenter IPs get the real page, not a consent wall),
// follow redirects, 10s timeout.
async function resolveViaScrape(): Promise<Resolved | null> {
  try {
    const res = await fetch(LIVE_PAGE, {
      headers: {
        "user-agent": UA,
        "accept-language": "en-US,en;q=0.9",
        cookie: "SOCS=CAI; CONSENT=YES+1",
      },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return extract(await res.text());
  } catch {
    return null;
  }
}

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) {
    const { videoId, isLive, title } = cache;
    return NextResponse.json({ videoId, isLive, title, channelId: CHANNEL_ID, channelUrl: CHANNEL_URL });
  }

  const resolved = (await resolveViaApi()) || (await resolveViaScrape());
  if (resolved) {
    cache = { ...resolved, at: now };
    return NextResponse.json({ ...resolved, channelId: CHANNEL_ID, channelUrl: CHANNEL_URL });
  }

  // Serve a slightly stale id rather than nothing, if we have one.
  if (cache) {
    const { videoId, isLive, title } = cache;
    return NextResponse.json({ videoId, isLive, title, channelId: CHANNEL_ID, channelUrl: CHANNEL_URL });
  }

  // Nothing resolved → the client shows a "Watch on YouTube" external link (never the error-153 embed).
  return NextResponse.json({ videoId: null, isLive: false, title: null, channelId: CHANNEL_ID, channelUrl: CHANNEL_URL });
}
