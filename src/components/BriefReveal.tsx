"use client";

import { useEffect, useRef, useState } from "react";
import type React from "react";
import { motion, useMotionValueEvent, useScroll } from "motion/react";
import { stripCitations } from "@/lib/briefText";

// EXPERIMENT (mobile Brief page only): the daily-brief text as a sticky-scroll reveal — one chunk
// at a time (headline takeaways, then each holding). The active chunk shows at full strength; the
// rest dim out, so the reader follows a little text at a time. Text sits directly on the page's
// black background (no card). Mechanism adapted from Aceternity's Sticky Scroll.

// Drop em dashes (—) — replace with a comma so clauses still read cleanly. En dashes (date ranges) stay.
const deDash = (s: string) => s.replace(/\s*—\s*/g, ", ");
// Render prose with inline [text](url) links (no underline — links read as plain text).
function renderLinked(md: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m.index > last) out.push(md.slice(last, m.index));
    out.push(
      <a key={m.index} href={m[2]} target="_blank" rel="noreferrer" className="text-white">
        {m[1]}
      </a>,
    );
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push(md.slice(last));
  return out;
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  return `${date} · ${time} ET`;
}

interface Result { ticker: string; name: string; verdict: string; risk: number | null; rationale: string; signals: string; researchedAt: string }
interface Payload { memo: string | null; updatedAt: string | null; results: Result[]; error?: string }

export function BriefReveal({ user = "pilot", onCondense }: { user?: string; onCondense?: (condensed: boolean) => void }) {
  const [data, setData] = useState<Payload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `thesis.monitor.${user}`;
    try {
      const c = localStorage.getItem(cacheKey);
      if (c) { const j = JSON.parse(c) as Payload; if (j && Array.isArray(j.results)) setData(j); }
    } catch {}
    fetch(`/api/monitor?user=${encodeURIComponent(user)}`)
      .then((r) => r.json())
      .then((j: Payload) => {
        if (cancelled) return;
        if (j.error && !(j.results && j.results.length)) return;
        setData(j);
        try { localStorage.setItem(cacheKey, JSON.stringify({ memo: j.memo, updatedAt: j.updatedAt, results: j.results })); } catch {}
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user]);

  const ref = useRef<HTMLDivElement>(null);
  const accum = useRef(0); // scroll distance since the last direction change (nav-condense threshold)
  const { scrollY, scrollYProgress } = useScroll({ container: ref, offset: ["start start", "end start"] });
  const [active, setActive] = useState(0);

  const stamp = fmtDateTime(data?.updatedAt ?? null);
  // Only holdings the agent has actually written up become sections. A freshly-added stock has no
  // research yet (empty rationale), so it would otherwise render as an empty block under its ticker —
  // skip it and let the memo + already-researched holdings stand until the next brief is generated.
  const results = (data?.results ?? []).filter((r) => (r.rationale || "").trim().length > 0);
  // headline first, then one section per holding (API already sorts by risk desc → TSLA leads)
  const sections: Array<{ key: string; node: React.ReactNode }> = [];
  if (data && (data.memo || results.length)) {
    // First chunk: just the title + date/time.
    sections.push({
      key: "title",
      node: (
        <>
          <h2 className="text-[32px] font-semibold leading-tight text-white">Daily Briefing</h2>
          {stamp && <p className="mt-3 text-[12px] uppercase tracking-wider text-[#8a8a8a]">{stamp}</p>}
        </>
      ),
    });
  }
  if (data?.memo) {
    // Second chunk: the headline — the day's key takeaways, one per line, highlighted + spaced.
    const takeaways = data.memo.split(/\n+/).map((s) => deDash(stripCitations(s.trim()))).filter(Boolean);
    sections.push({
      key: "headline",
      node: (
        <div className="space-y-6">
          {takeaways.map((t, i) => {
            // Split each takeaway at its first sentence: the key sentence stays bright white; any
            // supporting context after it is dimmed a step so the takeaway itself stands out.
            const m = t.match(/^([\s\S]*?[.!?])\s+([\s\S]+)$/);
            const head = m ? m[1] : t;
            const tail = m ? m[2] : "";
            return (
              <p key={i} className="text-[19px] leading-relaxed">
                <span className="text-white">{renderLinked(head)}</span>
                {tail && <span className="text-white/50"> {renderLinked(tail)}</span>}
              </p>
            );
          })}
        </div>
      ),
    });
  }
  for (const r of results) {
    sections.push({
      key: r.ticker,
      node: (
        <>
          <span className="text-[24px] font-semibold text-white">{r.ticker}</span>
          {/* Asset paragraph: linked ("highlighted") phrases stay pure white; the connecting prose
              is a step darker (70%) than the headline to give each paragraph internal hierarchy. */}
          <p className="mt-4 text-[18px] leading-relaxed text-white/70">{renderLinked(deDash(stripCitations(r.rationale)))}</p>
        </>
      ),
    });
  }
  const n = sections.length;

  useMotionValueEvent(scrollYProgress, "change", (latest) => {
    if (n < 2) return;
    const bps = sections.map((_, i) => i / n);
    const closest = bps.reduce((acc, bp, i) => (Math.abs(latest - bp) < Math.abs(latest - bps[acc]) ? i : acc), 0);
    setActive(closest);
  });

  // Shrink the floating nav after a threshold of scrolling down; restore on scroll-up or at the top.
  // Accumulate distance in the current direction so a tiny nudge doesn't flip it.
  useMotionValueEvent(scrollY, "change", (latest) => {
    const prev = scrollY.getPrevious() ?? 0;
    const d = latest - prev;
    if (d === 0) return;
    if (latest <= 6) { accum.current = 0; onCondense?.(false); return; }
    if (Math.sign(d) !== Math.sign(accum.current)) accum.current = 0; // direction reversed → restart count
    accum.current += d;
    if (accum.current > 40) onCondense?.(true);
    else if (accum.current < -40) onCondense?.(false);
  });
  useEffect(() => () => onCondense?.(false), [onCondense]); // restore the nav when leaving Brief

  return (
    <div ref={ref} className="no-scrollbar relative h-[100dvh] overflow-y-auto">
      {n === 0 ? (
        <p className="flex h-full items-center justify-center text-[15px] text-[#8a8a8a]">Loading briefing…</p>
      ) : (
        <div className="px-5">
          <div className="h-[13vh]" />
          {sections.map((s, i) => (
            <motion.section
              key={s.key}
              initial={false}
              animate={{ opacity: active === i ? 1 : 0.16 }}
              transition={{ duration: 0.35 }}
              className="flex min-h-[64vh] flex-col justify-center"
            >
              {s.node}
            </motion.section>
          ))}
          <p className="pt-2 text-[11px] leading-snug text-[#6b6b6b]">
            For informational purposes only. Not investment, financial, or trading advice. Do your own research.
          </p>
          <div className="h-[26vh]" />
        </div>
      )}
    </div>
  );
}
