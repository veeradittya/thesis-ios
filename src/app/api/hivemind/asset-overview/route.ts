import { NextResponse } from "next/server";
import { generateAssetOverviews } from "@/lib/hivemindAssetOverview";

export const runtime = "nodejs";
export const maxDuration = 60;

// The per-holding read shown at the top of each asset card. The client hands us the same per-holding
// signal snapshots the portfolio overview uses; the SYSTEM prompt + gateway/Anthropic call + parsing
// all live in src/lib/hivemindAssetOverview.ts (shared with the server-side page builder). This route
// is just the HTTP shell: key gate, body validation, and mapping a "no usable model output" throw to 502.
export async function POST(req: Request) {
  const dartmouthKey = process.env.DARTMOUTH_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  // No key → return an empty map; the client keeps skeletons pulsing (never a deterministic fallback).
  if (!dartmouthKey && !anthropicKey) return NextResponse.json({ overviews: {} });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const holdings = (body as { holdings?: unknown })?.holdings;
  if (!Array.isArray(holdings) || !holdings.length) {
    return NextResponse.json({ error: "holdings is required." }, { status: 400 });
  }

  try {
    return NextResponse.json({ overviews: await generateAssetOverviews(holdings) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Asset overview failed." }, { status: 502 });
  }
}
