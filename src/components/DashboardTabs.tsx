"use client";

import { motion } from "motion/react";

// Phone-only Dashboard sub-tabs. A Transitions.dev-style sliding pill (the selected
// tab's fill glides between tabs) sitting on a liquid-glass bar that matches the nav.
export type DashTab = "news" | "markets" | "extra";

const TABS: { id: DashTab; label: string }[] = [
  { id: "extra", label: "Analyst Sentiment" },
  { id: "news", label: "News" },
  { id: "markets", label: "Prediction Markets" },
];

export function DashboardTabs({ active, onChange }: { active: DashTab; onChange: (t: DashTab) => void }) {
  return (
    <div className="flex justify-center">
      <div
        role="tablist"
        className="relative inline-flex items-center gap-[3px] rounded-full p-[3px]"
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
                  style={{ backgroundColor: "rgba(255,255,255,0.14)", boxShadow: "0 1px 2px rgba(0,0,0,0.25)" }}
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
