"use client";

import { useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useTransform, type AnimationPlaybackControls } from "motion/react";

// Apple-style pull-to-refresh for a document-scrolled mobile page.
//  • iOS rubber-band: the content follows your finger ~1:1 at first and resists more the further you
//    pull, so you can always drag further — it never feels capped.
//  • The moment the pull crosses the threshold — even while you keep holding — the spinner starts
//    spinning and onRefresh fires. It stays reactive: you can keep pulling while it loads.
//  • When onRefresh settles (data ready), everything springs back on its own, whether or not you've
//    let go. Real spring physics (not CSS easing) for a buttery down + up.
//  • EVERYTHING (card + names + prices) moves as one unit — nothing scales "inside" the card.
const THRESHOLD = 80; // resisted px that commits the refresh
const REST = 60; // where the content parks (finger up) while the spinner spins
const DIM = 520; // rubber-band dimension — higher = more travel before it stiffens
const MIN_SPIN = 650; // keep the spinner visible at least this long
const HARD_STOP = 6000; // safety: settle even if onRefresh never resolves
const DOWN_SPRING = { type: "spring", stiffness: 260, damping: 30, mass: 0.9 } as const; // park/settle
const UP_SPRING = { type: "spring", stiffness: 320, damping: 34, mass: 0.85 } as const; // spring back

// iOS rubber band: slope 1 at the origin (feels 1:1), asymptotically resists as you pull further.
const rubber = (dy: number) => (dy <= 0 ? 0 : (1 - 1 / (dy / DIM + 1)) * DIM);

export function PullToRefresh({ onRefresh, children }: { onRefresh: () => void | Promise<void>; children: React.ReactNode }) {
  const y = useMotionValue(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const armed = useRef(false);
  const triggered = useRef(false);
  const refreshingRef = useRef(false);
  const consumed = useRef(false); // gesture finished returning — ignore further finger movement
  const anim = useRef<AnimationPlaybackControls | null>(null);

  // Derived spinner visuals — driven straight off the motion value (no React re-renders).
  const progress = useTransform(y, [0, THRESHOLD], [0, 1], { clamp: true });
  const spinnerOpacity = useTransform(y, [6, THRESHOLD * 0.85], [0, 1], { clamp: true });
  const spinnerY = useTransform(y, (v) => Math.max(0, Math.min(v - 30, 22)));
  const spinnerRotate = useTransform(progress, [0, 1], [0, 300]);
  const spinnerScale = useTransform(progress, [0, 1], [0.65, 1]);

  useEffect(() => {
    const spring = (to: number, opts: typeof DOWN_SPRING | typeof UP_SPRING) => {
      anim.current?.stop();
      anim.current = animate(y, to, opts);
    };

    const finish = () => {
      refreshingRef.current = false;
      triggered.current = false;
      consumed.current = true; // stop tracking so the spring back isn't fought by the finger
      setRefreshing(false);
      spring(0, UP_SPRING);
    };

    const trigger = () => {
      if (triggered.current) return;
      triggered.current = true;
      refreshingRef.current = true;
      setRefreshing(true);
      const t0 = Date.now();
      let done = false;
      const complete = () => {
        if (done) return;
        done = true;
        window.setTimeout(finish, Math.max(0, MIN_SPIN - (Date.now() - t0)));
      };
      Promise.resolve(onRefresh()).then(complete, complete);
      window.setTimeout(complete, HARD_STOP);
    };

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current || e.touches.length !== 1) { armed.current = false; return; }
      if (window.scrollY <= 0) {
        anim.current?.stop();
        startY.current = e.touches[0].clientY;
        armed.current = true;
        consumed.current = false;
      } else {
        armed.current = false;
        startY.current = null;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!armed.current || consumed.current || startY.current == null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0) { if (y.get()) y.set(0); return; }
      if (window.scrollY > 0) { armed.current = false; y.set(0); return; }
      e.preventDefault(); // take over from native rubber-band while pulling at the top
      const resisted = rubber(dy);
      y.set(resisted); // reactive: keep following the finger, even after the refresh has fired
      if (!triggered.current && resisted >= THRESHOLD) trigger();
    };
    const onEnd = () => {
      if (!armed.current) return;
      armed.current = false;
      startY.current = null;
      if (consumed.current) return; // already springing home
      if (refreshingRef.current) spring(REST, DOWN_SPRING); // parked while the fetch finishes
      else spring(0, UP_SPRING); // didn't commit → spring back
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
      anim.current?.stop();
    };
  }, [onRefresh, y]);

  return (
    <div className="relative">
      {/* Spinner rides just above the content as it opens a gap, then parks near the top. */}
      <motion.div
        className="pointer-events-none absolute inset-x-0 top-1 z-30 flex justify-center"
        style={{ y: spinnerY, opacity: spinnerOpacity }}
      >
        <motion.div
          className={`h-7 w-7 rounded-full border-2 border-white/20 border-t-white/80 ${refreshing ? "animate-spin" : ""}`}
          style={refreshing ? undefined : { rotate: spinnerRotate, scale: spinnerScale }}
        />
      </motion.div>
      {/* EVERYTHING moves as one unit on the GPU (translateY), sprung by physics. */}
      <motion.div style={{ y, willChange: "transform" }}>{children}</motion.div>
    </div>
  );
}
