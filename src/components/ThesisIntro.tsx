"use client";

import { Component, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import dynamic from "next/dynamic";
import { Spotlight } from "@/components/ui/spotlight-new";
import { TextGenerateEffect } from "@/components/ui/text-generate-effect";

// three.js / react-three-fiber (heavy) live behind this dynamic import, so they're code-split into their
// own chunk and only downloaded when the globe actually renders (first launch) — never in the main bundle.
const ThesisIntroGlobe = dynamic(
  () => import("@/components/ThesisIntroGlobe").then((m) => m.ThesisIntroGlobe),
  { ssr: false, loading: () => null },
);

// First-launch brand moment. Flow:
//   1. a rotating globe appears and 2. accelerates,
//   3. the subtext generates in beneath it, then 4. the globe + subtext fade out together,
//   5. "THESIS" rises and FLIP-animates into the exact spot it occupies in the floating nav bar,
//      handing off as the overlay fades to reveal the identical real nav wordmark underneath.
// Shows ONCE per install.

const SEEN_KEY = "thesis.intro.v1";
// DEV ONLY: when true, the intro replays on EVERY reload and never marks itself seen — for local
// tuning. false = once-per-install (shipping).
const ALWAYS_REPLAY = false;
const SUBTEXT = "Your worldview, monitored around the clock.";
const EASE = [0.22, 1, 0.36, 1] as const;
const HERO_Y = 0.5; // hero wordmark vertical center

// Whole intro is tuned to run < 5s: globe (with subtext) ~2.6s, then a quick handoff to THESIS → nav.
const SUB_IN_MS = 1300; // into the globe (while it's still slowing), when the subtext generates in
const GLOBE_MS = 2600; // globe + subtext visible, then the globe fades / THESIS takes its place
const ENTER_HOLD_MS = 1100; // THESIS visible on its own before it morphs into the nav (+0.5s hold before exit)

type Phase = "measure" | "globe" | "globeout" | "enter" | "morph" | "reveal";
type Geo = { startX: number; startY: number; endX: number; endY: number; scale: number; fontSize: number };

// If the globe (WebGL/three.js) throws while rendering, drop it silently — the rest of the intro
// (subtext, THESIS handoff) still plays and the timed phases carry it through to the reveal.
class GlobeErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function ThesisIntro() {
  const [phase, setPhase] = useState<Phase>("measure");
  const [dead, setDead] = useState(false); // already seen, or finished → render nothing
  const [showSub, setShowSub] = useState(false); // subtext appears partway through the globe
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const geo = useRef<Geo | null>(null);

  // Measure the nav wordmark + hero geometry before first paint, then start the globe.
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    let seen = false;
    try {
      seen = !!localStorage.getItem(SEEN_KEY);
    } catch {
      /* private mode → just play it */
    }
    if (seen && !ALWAYS_REPLAY) {
      setDead(true);
      return;
    }
    // Skip the heavy animated intro for reduced-motion users, and where WebGL (the globe) is unavailable.
    try {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        setDead(true);
        return;
      }
    } catch {
      /* matchMedia unavailable → ignore */
    }
    try {
      const test = document.createElement("canvas");
      if (!(test.getContext("webgl") || test.getContext("experimental-webgl"))) {
        setDead(true);
        return;
      }
    } catch {
      setDead(true);
      return;
    }
    const nav = document.querySelector("[data-thesis-wordmark]") as HTMLElement | null;
    const probe = probeRef.current;
    if (!nav || !probe) {
      setDead(true); // can't line up the handoff → skip rather than show a floating splash
      return;
    }
    const navRect = nav.getBoundingClientRect();
    const wr = probe.getBoundingClientRect(); // natural wordmark size at nav font-size
    const w = wr.width || 1;
    const h = wr.height || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.min(2.4, (vw * 0.6) / w); // hero size, never wider than 60% of the screen

    // x/y move the element's CENTER (transformOrigin: center; element pinned at fixed 0,0 → center at w/2,h/2).
    geo.current = {
      startX: vw / 2 - w / 2,
      startY: vh * HERO_Y - h / 2,
      endX: navRect.left + navRect.width / 2 - w / 2,
      endY: navRect.top + navRect.height / 2 - h / 2,
      scale,
      fontSize: parseFloat(getComputedStyle(nav).fontSize) || 20,
    };

    setPhase("globe");
  }, []);

  // Per-phase timers. globe→globeout and enter→morph are timed; other transitions are driven by an
  // onAnimationComplete. Each run's timers are cleared when the phase changes.
  useEffect(() => {
    const local: ReturnType<typeof setTimeout>[] = [];
    if (phase === "globe") {
      local.push(setTimeout(() => setShowSub(true), SUB_IN_MS));
      local.push(setTimeout(() => setPhase((p) => (p === "globe" ? "globeout" : p)), GLOBE_MS));
    } else if (phase === "enter") {
      local.push(setTimeout(() => setPhase((p) => (p === "enter" ? "morph" : p)), ENTER_HOLD_MS));
    }
    return () => local.forEach(clearTimeout);
  }, [phase]);

  if (dead) return null;

  const finish = () => {
    if (!ALWAYS_REPLAY) {
      try {
        localStorage.setItem(SEEN_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    setDead(true);
  };
  const skip = () => setPhase("reveal");

  const g = geo.current;
  const wordStyle: React.CSSProperties = {
    fontFamily: "var(--font-serif), Georgia, serif",
    fontWeight: 500,
    letterSpacing: "0.05em",
    lineHeight: 1,
    color: "#fff",
    whiteSpace: "nowrap",
  };
  const onGlobe = phase === "globe" || phase === "globeout";
  const atNav = phase === "morph" || phase === "reveal";

  return (
    <>
      {/* hidden probe — always mounted so we can measure the wordmark's natural size before painting */}
      <span
        ref={probeRef}
        aria-hidden
        style={{ ...wordStyle, position: "fixed", left: -9999, top: 0, opacity: 0, pointerEvents: "none", fontSize: "clamp(17px, 1.8vw + 10px, 26px)" }}
      >
        THESIS
      </span>

      {phase !== "measure" && g && (
        <motion.div
          className="fixed inset-0 z-[100] overflow-hidden"
          style={{ backgroundColor: "#040405" }}
          initial={{ opacity: 1 }}
          animate={{ opacity: phase === "reveal" ? 0 : 1 }}
          transition={{ duration: 0.3, ease: "easeInOut" }}
          onAnimationComplete={() => {
            if (phase === "reveal") finish();
          }}
          onClick={skip}
          aria-hidden
        >
          {/* Subtle neutral-white spotlight (Aceternity) — very faint, matches the black/white brand. */}
          <Spotlight
            gradientFirst="radial-gradient(68.54% 68.72% at 55.02% 31.46%, hsla(0,0%,100%,.007) 0, hsla(0,0%,100%,.0022) 50%, hsla(0,0%,100%,0) 80%)"
            gradientSecond="radial-gradient(50% 50% at 50% 50%, hsla(0,0%,100%,.0045) 0, hsla(0,0%,100%,.0018) 80%, transparent 100%)"
            gradientThird="radial-gradient(50% 50% at 50% 50%, hsla(0,0%,100%,.003) 0, hsla(0,0%,100%,.0012) 80%, transparent 100%)"
            duration={8}
          />

          {/* 1–2) the accelerating globe (fades out with the subtext) */}
          {onGlobe && (
            <motion.div
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: phase === "globeout" ? 0 : 1 }}
              transition={{ duration: phase === "globeout" ? 0.5 : 0.9, ease: "easeInOut" }}
              onAnimationComplete={() => {
                if (phase === "globeout") setPhase("enter");
              }}
            >
              <GlobeErrorBoundary>
                <ThesisIntroGlobe />
              </GlobeErrorBoundary>
            </motion.div>
          )}

          {/* 3) the subtext — generates in beneath the globe and STAYS; dissolves out (fade + soft blur)
              when THESIS starts to exit */}
          {showSub && (
            <motion.div
              className="pointer-events-none fixed left-0 right-0 text-center"
              style={{ top: "58%", fontFamily: "var(--font-inter), system-ui, sans-serif", fontWeight: 400, fontSize: "17.5px", letterSpacing: "0.01em", color: "#fff", padding: "0 32px", textShadow: "0 1px 4px rgba(0,0,0,0.55)" }}
              initial={{ opacity: 1, filter: "blur(0px)" }}
              animate={{ opacity: atNav ? 0 : 1, filter: atNav ? "blur(5px)" : "blur(0px)" }}
              transition={{ duration: 0.5, ease: "easeInOut" }}
            >
              <TextGenerateEffect words={SUBTEXT} filter duration={0.3} wordStagger={0.05} />
            </motion.div>
          )}

          {/* 5) the wordmark — crossfades into the globe's place as it fades, then morphs into the nav spot */}
          {(phase === "globeout" || phase === "enter" || atNav) && (
            <motion.span
              style={{ ...wordStyle, fontSize: g.fontSize, position: "fixed", left: 0, top: 0, transformOrigin: "center", willChange: "transform, opacity" }}
              initial={{ opacity: 0, x: g.startX, y: g.startY, scale: g.scale }}
              animate={
                atNav
                  ? { opacity: 1, x: g.endX, y: g.endY, scale: 1 } // morph + reveal rest at the nav spot
                  : { opacity: 1, x: g.startX, y: g.startY, scale: g.scale } // fade in at the hero (the globe's place)
              }
              transition={atNav ? { duration: 0.6, ease: EASE } : { duration: 0.5, ease: EASE }}
              onAnimationComplete={() => {
                if (phase === "morph") setPhase("reveal");
              }}
            >
              THESIS
            </motion.span>
          )}
        </motion.div>
      )}
    </>
  );
}
