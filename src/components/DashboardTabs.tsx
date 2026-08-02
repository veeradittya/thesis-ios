"use client";

import { motion } from "motion/react";

// Phone-only Dashboard sub-tabs. A Transitions.dev-style sliding pill (the selected
// tab's fill glides between tabs) sitting on a liquid-glass bar that matches the nav.
export type DashTab = "overview" | "news" | "markets" | "extra";

const TABS: { id: DashTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "extra", label: "Analyst Sentiment" },
  { id: "news", label: "News" },
  { id: "markets", label: "Prediction Markets" },
];

export function DashboardTabs({ active, onChange }: { active: DashTab; onChange: (t: DashTab) => void }) {
  return (
    // Horizontally scrollable so the four tabs never clip on a narrow phone; centered when they fit.
    <div className="no-scrollbar flex overflow-x-auto">
      <div
        role="tablist"
        className="relative mx-auto inline-flex items-center gap-[3px] rounded-full p-[3px]"
        style={{
          // Same frosted glass as the floating nav (translucent grey + heavy blur).
          backgroundColor: "#3a3a3a66",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
        }}
      >
        {TABS.map((t) => {
          const selected = active === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={selected}
              onClick={() => onChange(t.id)}
              className="relative z-[1] whitespace-nowrap rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-colors duration-200"
              style={{ color: selected ? "#ffffff" : "rgba(193,193,193,0.82)" }}
            >
              {selected && (
                // Shared-layout pill glides (and reshapes to each tab's width) on selection.
                <motion.span
                  layoutId="dashTabPill"
                  className="absolute inset-0 -z-[1] rounded-full"
                  style={{
                    // Liquid-glass toggle: a frosted, saturated lens that slides between tabs — a
                    // translucent fill + backdrop blur/saturate, a bright top sheen, and a soft lift.
                    backgroundColor: "rgba(255,255,255,0.14)",
                    backdropFilter: "blur(12px) saturate(180%)",
                    WebkitBackdropFilter: "blur(12px) saturate(180%)",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -1px 1px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.32)",
                  }}
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                />
              )}
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
