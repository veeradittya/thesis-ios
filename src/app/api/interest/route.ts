import { NextResponse } from "next/server";
import { saveLandingInterest } from "@/lib/turso";

export const dynamic = "force-dynamic";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      email?: unknown;
      name?: unknown;
      kind?: unknown;
      company?: unknown;
    };

    // Quietly accept bot-filled honeypots without storing them.
    if (body.company) return NextResponse.json({ ok: true });

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
    const kind = body.kind === "beta" ? "beta" : "updates";

    if (!EMAIL.test(email) || email.length > 254) {
      return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
    }

    await saveLandingInterest({ email, name: name || null, kind });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Landing interest submission failed", error);
    return NextResponse.json({ error: "We couldn't save that just now. Please try again." }, { status: 500 });
  }
}
