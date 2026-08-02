"use client";

import { useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import type { ParsedPortfolio } from "@/lib/parsePortfolio";
import { PortfolioLedger } from "@/components/PortfolioLedger";

// New-user onboarding. ONE long page inside a phone-shaped glass card (same dimensions as the sign-up
// card): each question is a full-height section, dimmed until it's active — the Daily-Briefing reveal —
// and pressing Continue auto-scrolls to the next one. Collected profile is handed back via onComplete.
//
// Native permission steps (notifications, Face ID) postMessage to iOS-shell bridges when present and fall
// back to no-ops in the browser — the shell must implement `thesisEnableNotifications`/`thesisEnableFaceID`.

export interface OnboardingProfile {
  name: string;
  ledger: ParsedPortfolio;
  portfolioThesis: string;
  risk: number; // 0..4
  notifications: boolean;
  faceId: boolean;
}

const RISK_LABELS = ["Cautious", "Steady", "Balanced", "Aggressive", "Fearless"];

const STEPS = ["name", "portfolio", "portfolioThesis", "assetThesis", "risk", "notifications", "faceid", "done"] as const;

// The Analyst-Sentiment-card sheen: a bright top inner edge + hairline ring + soft drop shadow.
const CARD_SHEEN = "inset 0 1px 0 rgba(255,255,255,0.16), 0 0 0 1px rgba(255,255,255,0.06), 0 30px 90px -20px rgba(0,0,0,0.7)";
const BTN_SHEEN = "inset 0 1px 0 rgba(255,255,255,0.14), 0 0 0 1px rgba(255,255,255,0.10)";
const glassBtn = "rounded-full px-8 py-3 text-[15px] font-medium text-white transition-transform active:scale-[0.98]";
const glassBtnStyle = { background: "rgba(0,0,0,0.42)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", boxShadow: BTN_SHEEN } as const;
// Text fields: dark glass — near-black fill, backdrop blur, a bright top-edge sheen + hairline ring.
const field = "w-full rounded-xl bg-black/40 px-4 py-3 text-[16px] text-white outline-none ring-1 ring-white/10 backdrop-blur-md placeholder:text-white/35 focus:ring-white/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]";

// Hours from now until the next 8 AM America/New_York agent run (when a new user's first brief lands).
function hoursUntilFirstBrief(): number {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const target = new Date(et);
  target.setHours(8, 0, 0, 0);
  if (et.getTime() >= target.getTime()) target.setDate(target.getDate() + 1);
  return Math.max(1, Math.round((target.getTime() - et.getTime()) / 3.6e6));
}

function nativeBridge(name: string, payload: Record<string, unknown> = {}): boolean {
  try {
    const h = (window as unknown as { webkit?: { messageHandlers?: Record<string, { postMessage: (m: unknown) => void }> } })
      .webkit?.messageHandlers?.[name];
    if (h) { h.postMessage(payload); return true; }
  } catch {}
  return false;
}

const emptyLedger = (name: string): ParsedPortfolio => ({
  fileName: "",
  portfolioName: name ? `${name}’s Portfolio` : "My Portfolio",
  sheetName: "",
  rowCount: 0,
  totalValue: null,
  holdings: [],
  mappedColumns: {},
});

// Risk slider: a thick pill track with 5 stop dots and a small white knob that snaps to a level.
// Module-level (stable component type) so it isn't remounted on every Onboarding re-render.
function RiskSlider({ value, onChange, stops, onInteract }: { value: number; onChange: (v: number) => void; stops: number; onInteract?: () => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const KNOB = 26;
  const update = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const usable = Math.max(1, rect.width - KNOB);
    const x = Math.max(0, Math.min(usable, clientX - rect.left - KNOB / 2));
    onChange(Math.round((x / usable) * (stops - 1)));
  };
  const pct = stops > 1 ? value / (stops - 1) : 0;
  return (
    <div
      ref={trackRef}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={stops - 1}
      aria-valuenow={value}
      aria-label="Risk tolerance"
      tabIndex={0}
      onKeyDown={(e) => {
        onInteract?.();
        if (e.key === "ArrowRight" || e.key === "ArrowUp") onChange(Math.min(stops - 1, value + 1));
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") onChange(Math.max(0, value - 1));
      }}
      onPointerDown={(e) => { onInteract?.(); e.currentTarget.setPointerCapture(e.pointerId); update(e.clientX); }}
      onPointerMove={(e) => { if (e.buttons === 1) update(e.clientX); }}
      className="relative h-10 w-full cursor-pointer touch-none select-none rounded-2xl"
      style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14), 0 0 0 1px rgba(255,255,255,0.10), inset 0 2px 5px rgba(0,0,0,0.55)" }}
    >
      {Array.from({ length: stops }).map((_, i) => (
        <span
          key={i}
          className={`pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${i === value ? "bg-transparent" : "bg-white/25"}`}
          style={{ top: "50%", left: `calc(${KNOB / 2}px + ${stops > 1 ? i / (stops - 1) : 0} * (100% - ${KNOB}px))` }}
        />
      ))}
      <motion.div
        className="pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full bg-white"
        style={{ width: KNOB, height: KNOB, boxShadow: "0 2px 10px rgba(0,0,0,0.55)" }}
        animate={{ left: `calc(${pct} * (100% - ${KNOB}px))` }}
        transition={{ type: "spring", stiffness: 520, damping: 42 }}
      />
    </div>
  );
}

export function Onboarding({
  initialName = "",
  onComplete,
  onClose,
}: {
  initialName?: string;
  onComplete: (profile: OnboardingProfile) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const secRefs = useRef<(HTMLElement | null)[]>([]);

  const [name, setName] = useState(initialName);
  const [ledger, setLedger] = useState<ParsedPortfolio>(() => emptyLedger(initialName));
  const [portfolioThesis, setPortfolioThesis] = useState("");
  const [risk, setRisk] = useState(2);
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const [showNameContinue, setShowNameContinue] = useState(false); // latches true at 3+ letters, then persists
  const [riskTouched, setRiskTouched] = useState(false); // Continue on the risk page appears once the slider is touched
  const briefHours = useMemo(hoursUntilFirstBrief, []);

  const holdings = ledger.holdings.filter((h) => h.ticker);

  // Continue-driven navigation: advance the active section and smooth-scroll it to the top.
  const goTo = (i: number) => {
    const c = Math.max(0, Math.min(STEPS.length - 1, i));
    setActive(c);
    requestAnimationFrame(() => secRefs.current[c]?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const next = () => goTo(active + 1);
  const back = () => (active === 0 ? onClose() : goTo(active - 1));

  const finish = () =>
    onComplete({ name: name.trim(), ledger, portfolioThesis: portfolioThesis.trim(), risk, notifications: true, faceId: true });

  const setAssetThesis = (ticker: string, thesis: string) =>
    setLedger((p) => ({ ...p, holdings: p.holdings.map((h) => (h.ticker === ticker ? { ...h, thesis } : h)) }));

  const title = "text-[24px] font-semibold leading-tight text-white"; // app sans, reduced size

  // Each question is a full-height section; only the active one is bright + interactive. This is a plain
  // render function (NOT a nested component) so React reconciles the sections across renders instead of
  // remounting them on every keystroke — otherwise the portfolio search magnifier's layout animation
  // would re-fire and "sprint" down the page.
  const sec = (i: number, children: React.ReactNode, center = true) => (
    <motion.section
      key={i}
      ref={(el) => { secRefs.current[i] = el; }}
      animate={{ opacity: active === i ? 1 : 0.16 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      style={{ pointerEvents: active === i ? "auto" : "none" }}
      className={`flex min-h-full flex-col px-6 pb-8 pt-16 ${center ? "justify-center" : ""}`}
    >
      {children}
    </motion.section>
  );

  return (
    <motion.div className="fixed inset-0 z-[110]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} role="dialog" aria-modal>
      {/* blurred backdrop over the app behind */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-xl" />

      {/* the card — same dimensions as the sign-up card, dark glass with the analyst-card sheen */}
      <div
        className="absolute overflow-hidden rounded-[34px]"
        style={{
          top: "calc(env(safe-area-inset-top) + 14px)",
          bottom: "calc(env(safe-area-inset-bottom) + 14px)",
          left: 14,
          right: 14,
          background: "#000",
          boxShadow: CARD_SHEEN,
        }}
      >
        {/* back / close — no progress bar */}
        <button onClick={back} aria-label="Back" className="absolute left-4 top-4 z-10 text-white/45 transition-colors hover:text-white">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
        </button>

        <div className="no-scrollbar h-full overflow-y-auto">
          {/* 1) NAME */}
          {sec(0, (
            <>
              <h1 className={title}>What should we call you?</h1>
              <input
                autoFocus
                value={name}
                onChange={(e) => { const v = e.target.value; setName(v); if (v.trim().length >= 3) setShowNameContinue(true); }}
                onKeyDown={(e) => { if (e.key === "Enter" && showNameContinue) next(); }}
                placeholder="Your name"
                className={`${field} mt-6`}
              />
              {/* plain white text (no pill); appears once 3+ letters are typed, then persists; centered */}
              {showNameContinue && (
                <motion.button
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  onClick={next}
                  className="mt-5 self-center text-[16px] font-medium text-white transition-opacity hover:opacity-80"
                >
                  Continue
                </motion.button>
              )}
            </>
          ))}

          {/* 2) PORTFOLIO */}
          {sec(1, (
            <>
              <h1 className={title}>Set up your portfolio</h1>
              <div className="-mx-1 mt-4 flex-1">
                <PortfolioLedger data={ledger} onChange={setLedger} />
              </div>
              {holdings.length > 0 && (
                <button onClick={next} className={`${glassBtn} mt-2 self-center`} style={glassBtnStyle}>
                  Continue with {holdings.length} asset{holdings.length > 1 ? "s" : ""}
                </button>
              )}
            </>
          ), false)}

          {/* 3) PORTFOLIO THESIS */}
          {sec(2, (
            <>
              <h1 className={title}>How do you invest?</h1>
              <p className="mt-2 text-[14px] leading-snug text-white/55">Tell us if you have a thesis on how you invest and what your goals are.</p>
              <textarea
                value={portfolioThesis}
                onChange={(e) => setPortfolioThesis(e.target.value)}
                rows={6}
                placeholder="e.g. Long-term AI and compute buildout. Concentrate in the leaders, trim on froth, and add on fear."
                className={`${field} no-scrollbar mt-6 resize-none leading-snug`}
              />
              {portfolioThesis.trim() ? (
                <motion.button initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} onClick={next} className={`${glassBtn} mt-6 self-center`} style={glassBtnStyle}>Continue</motion.button>
              ) : (
                <button onClick={next} className="mt-6 self-center text-[15px] font-medium text-white/45 transition-colors hover:text-white">Skip for now</button>
              )}
            </>
          ))}

          {/* 4) PER-ASSET THESIS */}
          {sec(3, (
            <>
              <h1 className={title}>A thesis for any of these?</h1>
              <p className="mt-2 text-[14px] leading-snug text-white/55">Tap an asset to add why you hold it. (Optional.)</p>
              <ul className="mt-6 flex flex-col gap-2.5">
                {holdings.map((h) => {
                  const open = openAsset === h.ticker;
                  return (
                    <li key={h.ticker} className="overflow-hidden rounded-xl ring-1 ring-white/[0.08]" style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)" }}>
                      <button onClick={() => setOpenAsset(open ? null : h.ticker)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
                        <span className="min-w-0">
                          <span className="text-[16px] font-medium text-white">{h.ticker}</span>
                          {h.name && h.name !== h.ticker && <span className="ml-2 text-[13px] text-white/45">{h.name}</span>}
                        </span>
                        <span className="shrink-0 text-[12px] text-white/45">{h.thesis?.trim() ? "edit" : open ? "" : "add"}</span>
                      </button>
                      {open && (
                        <div className="px-3 pb-3">
                          <textarea
                            autoFocus
                            value={h.thesis || ""}
                            onChange={(e) => setAssetThesis(h.ticker, e.target.value)}
                            rows={3}
                            placeholder={`Why do you hold ${h.ticker}?`}
                            className={`${field} no-scrollbar resize-none text-[15px] leading-snug`}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="mt-6 flex flex-col items-center">
                {holdings.some((h) => h.thesis?.trim()) ? (
                  <motion.button initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} onClick={next} className={glassBtn} style={glassBtnStyle}>Continue</motion.button>
                ) : (
                  <button onClick={next} className="text-[15px] font-medium text-white/45 transition-colors hover:text-white">Skip for now</button>
                )}
              </div>
            </>
          ), false)}

          {/* 5) RISK TOLERANCE */}
          {sec(4, (
            <>
              <h1 className={title}>What’s your risk appetite?</h1>
              <p className="mt-2 text-[14px] leading-snug text-white/55">Slide to the level that fits you.</p>
              <div className="mt-16 flex flex-col items-center">
                {/* the current level's word — updates as you slide */}
                <div className="h-9">
                  <motion.div key={risk} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }} className="text-[21px] font-semibold text-white">
                    {RISK_LABELS[risk]}
                  </motion.div>
                </div>
                <div className="mt-10 w-full px-2">
                  <RiskSlider value={risk} onChange={setRisk} stops={RISK_LABELS.length} onInteract={() => setRiskTouched(true)} />
                </div>
              </div>
              {riskTouched && (
                <motion.button initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} onClick={next} className={`${glassBtn} mt-16 self-center`} style={glassBtnStyle}>Continue</motion.button>
              )}
            </>
          ))}

          {/* 6) NOTIFICATIONS */}
          {sec(5, (
            <div className="flex flex-col items-center text-center">
              <div className="text-[46px]">🔔</div>
              <h1 className={`mt-5 ${title}`}>Stay in the loop</h1>
              <p className="mt-3 max-w-[320px] text-[15px] leading-snug text-white/60">We’ll send one gentle nudge the moment your daily brief is ready — nothing else.</p>
              <button onClick={() => { nativeBridge("thesisEnableNotifications"); next(); }} className={`${glassBtn} mt-8`} style={glassBtnStyle}>Enable notifications</button>
              <button onClick={next} className="mt-4 text-[15px] font-medium text-white/55 transition-colors hover:text-white">Not now</button>
            </div>
          ))}

          {/* 7) FACE ID */}
          {sec(6, (
            <div className="flex flex-col items-center text-center">
              <div className="text-[46px]">🔒</div>
              <h1 className={`mt-5 ${title}`}>Lock it with Face ID</h1>
              <p className="mt-3 max-w-[320px] text-[15px] leading-snug text-white/60">Add a quick Face ID check so only you can open your portfolio.</p>
              <button onClick={() => { nativeBridge("thesisEnableFaceID"); next(); }} className={`${glassBtn} mt-8`} style={glassBtnStyle}>Enable Face ID</button>
              <button onClick={next} className="mt-4 text-[15px] font-medium text-white/55 transition-colors hover:text-white">Maybe later</button>
            </div>
          ))}

          {/* 8) DONE */}
          {sec(7, (
            <div className="flex flex-col items-center text-center">
              <h1 className="text-[28px] font-semibold leading-tight text-white">You’re all set{name.trim() ? `, ${name.trim()}` : ""}.</h1>
              <p className="mt-4 max-w-[340px] text-[16px] leading-relaxed text-white/70">
                Your first brief will be ready in about <span className="text-white">{briefHours} hour{briefHours === 1 ? "" : "s"}</span>. You’ll be notified when it’s available.
              </p>
              <button onClick={finish} className={`${glassBtn} mt-8`} style={glassBtnStyle}>Explore Thesis</button>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
