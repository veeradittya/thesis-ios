import { NextResponse } from "next/server";
import { getHivemindPage } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?user=<scope> → the precomputed Hivemind page for that user (the stored
// { generatedAt, bundle, takeaways, assetOverviews }), built once per scheduled run by
// /api/hivemind/build-pages. No secret — this is a public read, like /api/monitor. When no page has
// been built yet, every field comes back null so the client can fall back to its live fetch path.
export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user") || "";
  try {
    const row = user ? await getHivemindPage(user) : null;
    if (!row) {
      return NextResponse.json({ generatedAt: null, bundle: null, takeaways: null, assetOverviews: null });
    }
    return NextResponse.json(JSON.parse(row.payload));
  } catch {
    return NextResponse.json({ generatedAt: null, bundle: null, takeaways: null, assetOverviews: null });
  }
}
