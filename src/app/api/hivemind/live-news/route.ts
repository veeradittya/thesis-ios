import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Live News — resolves Bloomberg Television's CURRENT live YouTube broadcast so the Hivemind
// "Live News" card can embed the stream inline. Bloomberg runs a 24/7 live channel, but the
// live video id rotates when the stream restarts, so we can't hardcode it. We fetch the
// channel's /live page server-side (avoids CORS) and read the canonical watch?v= id off it.
//
// The channel `live_stream?channel=` embed form is unreliable (error 153), so the client embeds
// the resolved specific video id instead; it falls back to the channel form only if we return none.

// Bloomberg Television's YouTube channel (verified: author "Bloomberg Television", 24/7 live).
const CHANNEL_ID = "UCIALMKvObZNtJ6AmdCLP7Lg";
const LIVE_PAGE = `https://www.youtube.com/channel/${CHANNEL_ID}/live`;

// A desktop UA gets us the full watch page with the canonical link; the mobile page is thinner.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const TTL_MS = 5 * 60 * 1000; // re-resolve at most every 5 minutes
let cache: { videoId: string | null; isLive: boolean; title: string | null; at: number } | null = null;

function extract(html: string): { videoId: string | null; isLive: boolean; title: string | null } {
  // Canonical link on a live watch page: <link rel="canonical" href="https://www.youtube.com/watch?v=XXXX">
  const canonical = html.match(/rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{6,20})"/);
  const og = html.match(/property="og:url"\s+content="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{6,20})"/);
  const videoId = canonical?.[1] || og?.[1] || null;
  const isLive = /"isLiveNow":true|BADGE_STYLE_TYPE_LIVE_NOW|"iconType":"LIVE"/.test(html);
  const title = html.match(/"videoDetails":\{[^}]*?"title":"([^"]{1,160})"/)?.[1]?.replace(/\\u0026/g, "&") || null;
  return { videoId, isLive, title };
}

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS && cache.videoId) {
    return NextResponse.json({ videoId: cache.videoId, isLive: cache.isLive, title: cache.title, channelId: CHANNEL_ID });
  }

  try {
    const res = await fetch(LIVE_PAGE, {
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const { videoId, isLive, title } = extract(await res.text());
      if (videoId) {
        cache = { videoId, isLive, title, at: now };
        return NextResponse.json({ videoId, isLive, title, channelId: CHANNEL_ID });
      }
    }
  } catch {
    // fall through to whatever we have cached / the client's channel-form fallback
  }

  if (cache?.videoId) {
    return NextResponse.json({ videoId: cache.videoId, isLive: cache.isLive, title: cache.title, channelId: CHANNEL_ID });
  }
  // No id resolved: tell the client to use the channel live_stream fallback.
  return NextResponse.json({ videoId: null, isLive: false, title: null, channelId: CHANNEL_ID });
}
