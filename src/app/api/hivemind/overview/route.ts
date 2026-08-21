import { NextResponse } from "next/server";
import { generateOverview } from "@/lib/hivemindOverview";

export const runtime = "nodejs";
export const maxDuration = 60;

// The Hivemind top-of-page read. The client hands us a compact JSON snapshot of the portfolio and,
// per holding, every signal we score; the SYSTEM prompt + gateway/Anthropic call + parsing all live in
// src/lib/hivemindOverview.ts (shared with the server-side takeaway scheduler). This route is just the
// HTTP shell: key gate, body validation, and mapping a "no usable model output" throw to a 502.
export async function POST(req: Request) {
  const dartmouthKey = process.env.DARTMOUTH_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  // No key → return nulls so the client silently keeps its deterministic read (no error surfaced).
  if (!dartmouthKey && !anthropicKey) return NextResponse.json({ headline: null, points: null });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const snapshot = (body as { snapshot?: unknown })?.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return NextResponse.json({ error: "snapshot is required." }, { status: 400 });
  }

  try {
    return NextResponse.json(await generateOverview(snapshot));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Overview failed." }, { status: 502 });
  }
}
