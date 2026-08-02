"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { SignInButtons } from "@/components/SignInButtons";

// Sign-up gate for logged-out visitors. A phone-shaped card, slightly smaller than the screen, sits over
// the app — everything outside the card is blurred. The card is a background photo dimmed by an opaque
// scrim. It has two phases on the SAME card: the marketing intro ("Sign up now" / "later"), then the
// sign-in options (Continue with Google / Apple). Sign-in itself is handled by SignInButtons (native
// sheet in the iOS shell, web OAuth elsewhere); on success the session resolves and, for a NEW user,
// MonacoHome launches the onboarding flow.
// Each visitor is served ONE backdrop at random from this subset — drop more files in public/signup/ and
// list them here to grow it. (Currently just the water photo.)
const BG_IMAGES = ["/signup/water.jpg"];

// LOCAL ONLY: when true, "Continue with Google/Apple" skips real auth and jumps straight into onboarding,
// so the onboarding pages can be iterated on without signing in. MUST be false to ship. Shared with the
// Account-tab sign-in (MonacoHome) so that flow can preview onboarding the same way.
export const DEV_SKIP_AUTH = false;

export function SignupScreen({ onLater, onSignedIn }: { onLater: () => void; onSignedIn: () => void }) {
  // Pick a backdrop at random, once per mount — which image a visitor sees is completely random.
  const [bgImage] = useState(() => BG_IMAGES[Math.floor(Math.random() * BG_IMAGES.length)]);
  const [phase, setPhase] = useState<"intro" | "signin">("intro");
  return (
    <motion.div
      className="fixed inset-0 z-[95]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      role="dialog"
      aria-modal
      aria-label="Sign up"
    >
      {/* everything outside the card — the app behind, blurred + slightly dimmed */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-xl" />

      {/* the card — phone-shaped, a little smaller than the screen */}
      <div
        className="absolute overflow-hidden rounded-[34px] border border-white/10 shadow-[0_30px_90px_rgba(0,0,0,0.6)]"
        style={{
          top: "calc(env(safe-area-inset-top) + 14px)",
          bottom: "calc(env(safe-area-inset-bottom) + 14px)",
          left: 14,
          right: 14,
        }}
      >
        {/* background photo — blurred into a soft backdrop; extended past the card edges so the blur never
            reveals a faded border. It lives in its OWN rounded clip layer promoted to a compositing layer
            (translateZ): WebKit's overflow:hidden + border-radius won't clip a filtered child, so on the
            WKWebView the blur would otherwise spill past the card's rounded border — this contains it. */}
        <div className="absolute inset-0 overflow-hidden rounded-[34px]" style={{ transform: "translateZ(0)" }}>
          <div className="absolute bg-cover bg-center" style={{ inset: "-24px", backgroundImage: `url(${bgImage})`, filter: "blur(5px)" }} />
        </div>
        {/* scrim — a light overall dim (kept translucent so the photo reads) plus a bottom-weighted
            gradient so the bottom-third title/subtext/buttons stay legible; the blur shows through up top */}
        <div className="absolute inset-0 bg-black/40" />
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.55) 28%, rgba(0,0,0,0) 60%)" }}
        />

        {/* content — grouped in the bottom third; swaps between the marketing intro and sign-in options */}
        <div className="relative flex h-full flex-col justify-end p-8">
          <AnimatePresence mode="wait">
            {phase === "intro" ? (
              <motion.div key="intro" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22 }}>
                <h1
                  className="text-[38px] text-white"
                  style={{ fontFamily: "var(--font-serif), Georgia, serif", fontWeight: 500, lineHeight: 1.05 }}
                >
                  Transform the way you invest
                </h1>
                <p className="mt-5 max-w-[330px] text-[16px] leading-snug text-white/75">
                  Get access to daily briefings, thesis integration, insights and more.
                </p>

                <div className="mt-8 flex items-center gap-6">
                  <button
                    onClick={() => setPhase("signin")}
                    className="rounded-full bg-[#ece9e0] px-7 py-3.5 text-[16px] font-medium text-black transition-colors hover:bg-white"
                  >
                    Sign up now
                  </button>
                  <button
                    onClick={onLater}
                    className="text-[16px] font-medium text-white/90 transition-colors hover:text-white"
                  >
                    later
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div key="signin" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22 }}>
                <h1
                  className="text-[30px] text-white"
                  style={{ fontFamily: "var(--font-serif), Georgia, serif", fontWeight: 500, lineHeight: 1.06 }}
                >
                  Sign in or log in
                </h1>
                <p className="mt-3 max-w-[330px] text-[15px] leading-snug text-white/70">
                  Continue with your Google or Apple account to set up your portfolio.
                </p>

                <div className="mt-7 flex flex-col items-center">
                  <SignInButtons callbackUrl="/" onOverride={DEV_SKIP_AUTH ? onSignedIn : undefined} />
                  <button
                    onClick={onLater}
                    className="mt-5 text-[15px] font-medium text-white/70 transition-colors hover:text-white"
                  >
                    Later
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
