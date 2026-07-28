"use client";

import { useCallback, useContext, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useMovableCard, StaticLayoutContext } from "@/components/ui/useMovableCard";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { MacroAddPicker } from "@/components/MacroAddPicker";

// Wire types (redeclared — the server module @/lib/macroFeed imports `ws`, so we don't import it here).
interface MacroOutcome { outcome: string; label: string; prob: number | null; kalshiProb: number | null; polyProb: number | null; depthUsd: number }
interface MacroDist { eventKey: string; seq: number; publishedTs: number; outcomes: MacroOutcome[] }
export interface MacroEvent { eventKey: string; title: string; type: string; category: string | null; label: string | null; agency: string | null; description: string | null; sourceUrl: string | null; venues: string[]; releaseAt: string }

const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
function countdown(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const d = t - now;
  if (d <= 0) return "now";
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const DISMISS_KEY = "thesis.macro.dismissed";
const ADD_KEY = "thesis.macro.added";
// Only surface signals releasing within this horizon (10 days).
const HORIZON_MS = 10 * 24 * 3600 * 1000;

export function MacroSignalsCard({
  x = 560,
  y = 180,
  width = 440,
  height = 520,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  onClose: () => void; // retained for API compatibility — the in-card close (✕) button was removed
  onOpenEvent: (ev: MacroEvent) => void;
}) {
  const { style, dragHandle, resizeHandle, raise } = useMovableCard("macro", { x, y, w: width, h: height }, { minW: 340, minH: 260 });
  const isStatic = useContext(StaticLayoutContext);
  // Each event collapses to its title; its outcome distribution only shows once the title is tapped.
  const [openEvents, setOpenEvents] = useState<Set<string>>(new Set());
  const toggleEvent = (key: string) =>
    setOpenEvents((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const [events, setEvents] = useState<MacroEvent[]>([]);
  const [dists, setDists] = useState<Record<string, MacroDist>>({});
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || "[]")); } catch { return new Set(); }
  });
  const [added, setAdded] = useState<MacroEvent[]>(() => {
    try { return JSON.parse(localStorage.getItem(ADD_KEY) || "[]"); } catch { return []; }
  });
  const [menu, setMenu] = useState<{ vx: number; vy: number; eventKey: string | null } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Merge a live distribution into state.
  const applyDist = useCallback((d: MacroDist) => {
    setDists((p) => ({ ...p, [d.eventKey]: d }));
    setStatus("live");
  }, []);

  // Default set: catalog + live distributions.
  useEffect(() => {
    const es = new EventSource("/api/macro");
    es.addEventListener("catalog", (e) => { try { setEvents(JSON.parse((e as MessageEvent).data)); setStatus("live"); } catch {} });
    es.addEventListener("dist", (e) => { try { applyDist(JSON.parse((e as MessageEvent).data)); } catch {} });
    es.onerror = () => setStatus("error");
    return () => es.close();
  }, [applyDist]);

  // Added (non-default) signals each get their own live dist stream.
  const extraStr = added.filter((a) => !events.some((e) => e.eventKey === a.eventKey)).map((a) => a.eventKey).join("|");
  useEffect(() => {
    if (!extraStr) return;
    const keys = extraStr.split("|");
    const srcs = keys.map((k) => {
      const es = new EventSource(`/api/macro/event?key=${encodeURIComponent(k)}`);
      es.addEventListener("dist", (e) => { try { applyDist(JSON.parse((e as MessageEvent).data)); } catch {} });
      return es;
    });
    return () => { srcs.forEach((es) => es.close()); };
  }, [extraStr, applyDist]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const dismiss = (key: string) => {
    setDismissed((prev) => { const n = new Set(prev); n.add(key); try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...n])); } catch {} return n; });
    setMenu(null);
  };
  const addSignal = (ev: MacroEvent) => {
    setDismissed((prev) => { if (!prev.has(ev.eventKey)) return prev; const n = new Set(prev); n.delete(ev.eventKey); try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...n])); } catch {} return n; });
    setAdded((prev) => {
      if (events.some((e) => e.eventKey === ev.eventKey) || prev.some((a) => a.eventKey === ev.eventKey)) return prev;
      const n = [...prev, ev];
      try { localStorage.setItem(ADD_KEY, JSON.stringify(n)); } catch {}
      return n;
    });
    setPickerOpen(false);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const row = (e.target as HTMLElement).closest("[data-event-key]") as HTMLElement | null;
    e.preventDefault();
    e.stopPropagation(); // suppress the global platform menu while over this card
    setMenu({ vx: e.clientX, vy: e.clientY, eventKey: row?.dataset.eventKey || null });
  };

  const byKey = new Map<string, MacroEvent>();
  for (const e of [...events, ...added]) if (!byKey.has(e.eventKey)) byKey.set(e.eventKey, e);
  const shown = [...byKey.values()]
    .filter((e) => !dismissed.has(e.eventKey))
    .filter((e) => {
      const t = Date.parse(e.releaseAt);
      return !Number.isNaN(t) && t - now <= HORIZON_MS;
    })
    .sort((a, b) => Date.parse(a.releaseAt) - Date.parse(b.releaseAt));

  const menuItems: MenuItem[] = menu
    ? [{ label: "Add Signal", onClick: () => setPickerOpen(true) }, ...(menu.eventKey ? [{ label: "Close Signal", onClick: () => dismiss(menu.eventKey as string) }] : [])]
    : [];

  return (
    <div
      onPointerDown={raise}
      onContextMenu={onContextMenu}
      style={isStatic ? { boxShadow: "0 0 0 1px rgba(251,146,60,0.08), 0 12px 48px -16px rgba(244,120,80,0.22)" } : style}
      className={cn(
        "fade-in flex flex-col overflow-hidden font-sans tracking-[-0.01em]",
        // Mobile: same rounded card + sunset-tinted edge glow as the portfolio's "Your Holdings" box.
        isStatic
          ? "relative w-full rounded-2xl border border-white/[0.09]"
          : "absolute rounded-[20px] border border-white/[0.06] bg-[#0e0e0e] shadow-[0_24px_70px_rgba(0,0,0,0.55)]",
      )}
    >
      {/* header — drag handle */}
      <div {...dragHandle} className="flex shrink-0 cursor-move touch-none select-none items-center justify-between gap-3 px-5 pt-4 pb-3">
        <h2 className="text-[12px] uppercase tracking-wider text-white">Macro Signals</h2>
        {status !== "live" && (
          <span className="text-[10px] uppercase tracking-wider text-[#8a8a8a]">{status === "connecting" ? "connecting…" : "reconnecting…"}</span>
        )}
      </div>

      {/* body — event rows; each collapses to its title until tapped. On mobile the card grows to its
          content (no inner scroll); on desktop the fixed-height card scrolls internally. */}
      <div className={cn("px-5 py-1.5", !isStatic && "no-scrollbar min-h-0 flex-1 overflow-y-auto")}>
        {status === "connecting" && !shown.length && <p className="mt-10 animate-pulse text-center text-[13px] text-[#8a8a8a]">Connecting to macro feed…</p>}
        {status === "error" && !shown.length && <p className="mt-10 text-center text-[13px] text-rose-400">Macro feed unavailable.</p>}
        {status === "live" && !shown.length && (
          <p className="mt-10 text-center text-[12px] text-[#666]">No signals — right-click → Add Signal.</p>
        )}

        {shown.map((ev) => {
          const d = dists[ev.eventKey];
          const cd = countdown(ev.releaseAt, now);
          const t = Date.parse(ev.releaseAt);
          const soon = !isNaN(t) && t - now < 24 * 3600_000;
          const outs = (d?.outcomes ?? []).filter((o) => o.prob != null); // skip outcomes with no quote yet
          const evOpen = openEvents.has(ev.eventKey);
          return (
            <div key={ev.eventKey} data-event-key={ev.eventKey} className="border-t border-white/[0.06] py-2.5 first:border-t-0">
              {/* event title (full text, wraps) + countdown — tap to reveal the outcome distribution */}
              <button
                onClick={() => toggleEvent(ev.eventKey)}
                aria-expanded={evOpen}
                title="Tap to expand · right-click to add/close"
                className="group flex w-full items-start justify-between gap-3 text-left"
              >
                <span className="min-w-0 flex-1 text-[12.5px] font-medium leading-[1.3] text-white/90 group-hover:text-white">{ev.title}</span>
                <span className={cn("mt-px shrink-0 text-[11px] tabular-nums", cd === "now" || soon ? "text-amber-300" : "text-[#8a8a8a]")}>
                  {cd === "now" ? "now" : `in ${cd}`}
                </span>
              </button>

              {/* every priced outcome with its probability (revealed only when expanded) */}
              {evOpen &&
                (outs.length ? (
                  <div className="ml-1 mt-1.5 border-l border-white/[0.08] pl-2.5">
                    {outs.map((o) => (
                      <div key={o.outcome} className="flex w-full items-start gap-2 py-1">
                        <span className="min-w-0 flex-1 text-[11.5px] leading-[1.3] text-white/75">{o.label}</span>
                        <span className={cn("mt-px shrink-0 text-right text-[11.5px] tabular-nums", (o.prob ?? 0) >= 0.5 ? "text-emerald-400" : "text-white/90")}>
                          {pct(o.prob)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-[#666]">Awaiting quotes…</p>
                ))}
            </div>
          );
        })}
      </div>

      {/* resize handle */}
      <div
        {...resizeHandle}
        className="absolute bottom-0 right-0 z-20 flex h-7 w-7 cursor-nwse-resize touch-none items-end justify-end p-1.5 text-white/40 transition-colors hover:text-white/80"
        title="Drag to resize"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M11 4L4 11M11 8L8 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </div>

      {menu && <ContextMenu x={menu.vx} y={menu.vy} items={menuItems} onClose={() => setMenu(null)} />}
      {pickerOpen && <MacroAddPicker excludeKeys={shown.map((e) => e.eventKey)} onPick={addSignal} onClose={() => setPickerOpen(false)} />}
    </div>
  );
}
