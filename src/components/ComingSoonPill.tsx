"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ThinkingOrb } from "thinking-orbs";
import { computeMarketState } from "@/lib/marketHours";

// Matches the floating-nav labels (Inter, weight 400) so the text reads as a peer of
// Brief / Dashboard / Portfolio / Account.
const NAV_TEXT: React.CSSProperties = {
  fontFamily: "var(--font-inter)",
  fontWeight: 400,
  lineHeight: 1.6,
  fontSize: "clamp(12px, calc(7.43px + 0.446vw), 16px)",
  letterSpacing: "clamp(-0.32px, calc(-0.103px - 0.009vw), -0.24px)",
};

// Analyst Sentiment placeholder — a thinking orb + shimmering "Coming Soon" inside a liquid-glass
// pill, carrying the market-hours readout that used to live in the standalone clock card:
// the two markets (NYSE · Nasdaq), the live ET clock, and the open/close countdown.
// Owns its own 1s tick so only this pill re-renders each second.
export function ComingSoonPill() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const s = now ? computeMarketState(now) : null;
  const statusColor = !s ? "text-[#8a8a8a]" : s.phase === "open" ? "text-emerald-400" : "text-rose-500";

  return (
    <div
      className="flex w-full items-center gap-3 rounded-2xl border border-white/[0.09] px-4 py-4"
      style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2), 0 0 0 1px rgba(255,255,255,0.05), 0 12px 40px -18px rgba(0,0,0,0.5)" }}
    >
      <ThinkingOrb state="solving" size={64} speed={0.7} theme="dark" />
      <div className="flex flex-col gap-0.5">
        <span className={cn("font-normal", statusColor)} style={{ ...NAV_TEXT, fontSize: "13px", lineHeight: 1.4 }}>
          NYSE · Nasdaq
        </span>
        <span className="text-[#8a8a8a]" style={{ ...NAV_TEXT, fontSize: "13px", lineHeight: 1.4 }}>
          <span className="tabular-nums text-white/85">{s ? s.clock : "—"}</span> ET
        </span>
        {s && (
          <span className="text-[#8a8a8a]" style={{ ...NAV_TEXT, fontSize: "13px", lineHeight: 1.4 }}>
            {s.countdownLabel} {s.countdownText}
          </span>
        )}
      </div>
    </div>
  );
}
