"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ThinkingOrb } from "thinking-orbs";

// The ONE screen a brand-new user sees after onboarding, until their first Daily Brief is generated. The
// scheduled analyst agent runs at 08:00 America/New_York, so this counts down (to the second) to that run:
// the Analyst-Sentiment orb on top, a live HH:MM:SS timer just below it. Owns its own 1s tick.

// Once the countdown reaches 08:00 the agent runs, but the brief takes a little while to write and the app
// only detects it on the next /api/monitor poll. During that window we DON'T roll the countdown over to
// tomorrow — we return 0 so the screen shows a "generating" state instead. After the grace window (agent
// clearly didn't produce), we fall through to tomorrow's run.
const GENERATING_GRACE_MS = 30 * 60 * 1000; // 30 min after 08:00 ET

// Milliseconds remaining until the next 08:00 America/New_York run — or 0 while the brief is generating.
function msUntilNextBrief(): number {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const target = new Date(et);
  target.setHours(8, 0, 0, 0);
  if (et.getTime() >= target.getTime()) {
    if (et.getTime() - target.getTime() <= GENERATING_GRACE_MS) return 0; // brief is being generated right now
    target.setDate(target.getDate() + 1); // past the grace window → count down to tomorrow's run
  }
  return Math.max(0, target.getTime() - et.getTime());
}

function parts(ms: number): { h: string; m: string; s: string } {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return { h: p(Math.floor(s / 3600)), m: p(Math.floor((s % 3600) / 60)), s: p(s % 60) };
}

export function FirstBriefWaiting() {
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    setMs(msUntilNextBrief());
    const id = setInterval(() => setMs(msUntilNextBrief()), 1000);
    return () => clearInterval(id);
  }, []);
  const generating = ms != null && ms <= 0; // countdown reached 08:00 ET → brief is being written now

  return (
    <motion.div
      className="flex min-h-[100dvh] flex-col items-center justify-center bg-black px-8 pb-28 text-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      {/* The Analyst-Sentiment orb, enlarged (scale the shipped 64 up; the box reserves the footprint). */}
      <div className="flex items-center justify-center" style={{ width: 100, height: 100 }}>
        <div style={{ transform: "scale(1.5625)", transformOrigin: "center" }}>
          <ThinkingOrb state="solving" size={64} speed={0.6} theme="dark" />
        </div>
      </div>

      {/* Primary line (text) + supporting line (subtext), below the orb. */}
      {/* Loading label — left→right sheen (same shimmer as the brief's "scroll to read"). */}
      <p className="mt-9 shimmer-coming-soon text-[13px] font-semibold uppercase tracking-[0.28em]">
        Researching....
      </p>

      <p className="mt-4 max-w-[330px] text-[20px] font-semibold leading-snug text-white">
        All good things take time.
      </p>
      <p className="mt-3 max-w-[290px] text-[14px] leading-snug text-white/50">
        We will notify you when your dashboard is ready.
      </p>

      {/* The live countdown — in a liquid-glass pill with a sheen, below the text body. Once it reaches
          08:00 ET it flips to a "generating" state instead of freezing at zero / rolling over to tomorrow. */}
      <div
        className="mt-8 rounded-full px-7 py-3"
        style={{
          background: "rgba(255,255,255,0.05)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22), 0 0 0 1px rgba(255,255,255,0.08), 0 20px 50px -20px rgba(0,0,0,0.75)",
        }}
      >
        {generating ? (
          <span className="shimmer-coming-soon text-[16px] font-semibold tracking-wide">Generating your brief…</span>
        ) : (
          <div className="flex items-baseline font-semibold tabular-nums text-white" style={{ fontSize: 29, letterSpacing: "0.01em" }}>
            {ms == null ? (
              "—"
            ) : (
              (() => {
                const t = parts(ms);
                const u = "ml-0.5 text-[0.66em] font-medium text-white/45"; // dimmed unit indicator
                return (
                  <>
                    <span>{t.h}<span className={u}>h</span></span>
                    <span className="ml-2.5">{t.m}<span className={u}>m</span></span>
                    <span className="ml-2.5">{t.s}<span className={u}>s</span></span>
                  </>
                );
              })()
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
