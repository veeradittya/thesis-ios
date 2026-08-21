"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Typewriter reveal speed (characters per second). The network fills a buffer; a pacer reveals it at
// this rate so the text streams in smoothly and deliberately, slower than raw model tokens.
const REVEAL_CPS = 78;

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const STARTERS = [
  "What's the biggest risk in my portfolio right now?",
  "Where do Reddit and the analysts disagree on my holdings?",
  "What's my Sharpe ratio and how diversified am I?",
  "Any whale activity or prediction-market moves on my names?",
];

// A short, time-of-day greeting for the empty state.
function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning.";
  if (h < 18) return "Good afternoon.";
  return "Good evening.";
}

const IMG_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

// An inline image the assistant embedded from tool data (e.g. a news thumbnail). Hides itself if the
// source fails to load so a dead URL never leaves a broken-image box.
function ChatImage({ alt, url }: { alt: string; url: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      onError={() => setOk(false)}
      className="my-2 max-h-60 w-full rounded-xl border border-white/[0.06] object-cover"
    />
  );
}

// Light inline markdown → render **bold** and `code`; strip any stray "*" and any leftover image markdown
// so no raw symbol ever shows (images are rendered as blocks in renderAssistant).
function renderInline(text: string, keyBase: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={`${keyBase}-${i}`} className="font-semibold text-white">{p.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/.test(p)) return <code key={`${keyBase}-${i}`} className="rounded bg-white/10 px-1 py-0.5 text-[12px] tabular-nums">{p.slice(1, -1)}</code>;
    return <span key={`${keyBase}-${i}`}>{p.replace(IMG_RE, "").replace(/\*/g, "")}</span>;
  });
}

// A line chart the assistant emitted as <chart>{...}</chart> (e.g. the efficient frontier). Renders a
// clean SVG curve on an app-styled card instead of a wall of numbers.
const CHART_RE = /<chart>([\s\S]*?)<\/chart>/;
const MARKER_COLORS: Record<string, string> = {
  amber: "rgba(251,191,36,0.95)",
  emerald: "rgba(52,211,153,0.95)",
  rose: "rgba(251,113,133,0.95)",
  sky: "rgba(56,189,248,0.95)",
  white: "rgba(255,255,255,0.9)",
};
type Marker = { x: number; y: number; label?: string; color?: string };
function ChartBlock({ raw }: { raw: string }) {
  let spec: { title?: string; xLabel?: string; yLabel?: string; points?: unknown; markers?: unknown };
  try {
    spec = JSON.parse(raw);
  } catch {
    return null;
  }
  const pts = (Array.isArray(spec.points) ? spec.points : [])
    .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number" && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [p[0], p[1]] as [number, number]);
  if (pts.length < 2) return null;
  const markers: Marker[] = (Array.isArray(spec.markers) ? spec.markers : [])
    .filter((mk): mk is Marker => !!mk && typeof mk === "object" && typeof (mk as Marker).x === "number" && typeof (mk as Marker).y === "number" && Number.isFinite((mk as Marker).x) && Number.isFinite((mk as Marker).y));
  // Axis range spans the curve AND every marker, so an off-frontier point (e.g. the current portfolio) shows.
  const xs = [...pts.map((p) => p[0]), ...markers.map((m) => m.x)];
  const ys = [...pts.map((p) => p[1]), ...markers.map((m) => m.y)];
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const W = 340, H = markers.length ? 210 : 190, padL = 40, padR = 16, padT = spec.title ? 12 : 14, padB = 34;
  const sx = (x: number) => padL + (maxX === minX ? 0.5 : (x - minX) / (maxX - minX)) * (W - padL - padR);
  const sy = (y: number) => H - padB - (maxY === minY ? 0.5 : (y - minY) / (maxY - minY)) * (H - padT - padB);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ");
  const cMaxX = Math.max(...pts.map((p) => p[0]));
  const cMinX = Math.min(...pts.map((p) => p[0]));
  const area = `${line} L${sx(cMaxX).toFixed(1)},${(H - padB).toFixed(1)} L${sx(cMinX).toFixed(1)},${(H - padB).toFixed(1)} Z`;
  const fmt = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toString() : (Math.round(n * 10) / 10).toString());
  return (
    <div className="my-1 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
      {spec.title && <p className="mb-1.5 px-1 text-[13px] font-medium text-white/80">{spec.title}</p>}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={spec.title || "chart"}>
        <defs>
          <linearGradient id="cg" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(52,211,153,0.26)" />
            <stop offset="100%" stopColor="rgba(52,211,153,0)" />
          </linearGradient>
        </defs>
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="rgba(255,255,255,0.14)" strokeWidth="1" />
        <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="rgba(255,255,255,0.14)" strokeWidth="1" />
        <path d={area} fill="url(#cg)" />
        <path d={line} fill="none" stroke="rgba(52,211,153,0.9)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
        {markers.map((mk, i) => {
          const cx = sx(mk.x), cy = sy(mk.y);
          const color = MARKER_COLORS[String(mk.color || "").toLowerCase()] || MARKER_COLORS.sky;
          const right = cx > W - 70;
          const r = markers.length > 6 ? 2.7 : 3.4;
          return (
            <g key={i}>
              <circle cx={cx} cy={cy} r={r} fill={color} stroke="#0b0b0b" strokeWidth="1" />
              {mk.label && (
                <text x={right ? cx - 5 : cx + 5} y={cy - 4.5} textAnchor={right ? "end" : "start"} fontSize="9" fontWeight="600" fill={color}>
                  {mk.label}
                </text>
              )}
            </g>
          );
        })}
        <text x={padL - 6} y={sy(maxY) + 3} textAnchor="end" fontSize="9" fill="#8a8a8a">{fmt(maxY)}</text>
        <text x={padL - 6} y={sy(minY) + 3} textAnchor="end" fontSize="9" fill="#8a8a8a">{fmt(minY)}</text>
        <text x={sx(minX)} y={H - padB + 14} textAnchor="middle" fontSize="9" fill="#8a8a8a">{fmt(minX)}</text>
        <text x={sx(maxX)} y={H - padB + 14} textAnchor="middle" fontSize="9" fill="#8a8a8a">{fmt(maxX)}</text>
        {spec.xLabel && <text x={(padL + W - padR) / 2} y={H - 5} textAnchor="middle" fontSize="9.5" fill="#737373">{spec.xLabel}</text>}
        {spec.yLabel && (
          <text x={11} y={(padT + H - padB) / 2} textAnchor="middle" fontSize="9.5" fill="#737373" transform={`rotate(-90 11 ${(padT + H - padB) / 2})`}>
            {spec.yLabel}
          </text>
        )}
      </svg>
    </div>
  );
}

// A run of plain text → spaced paragraphs (no bullets) + inline images, with **bold** for hierarchy.
// Any stray list marker or table pipe is neutralized so nothing renders as broken markup.
function renderParagraphs(text: string, keyBase: string) {
  const blocks: React.ReactNode[] = [];
  for (const para of text.split(/\n+/)) {
    if (/^[\s|:.-]*$/.test(para) && /\|/.test(para)) continue; // drop table separator rows
    const joined = para
      .replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "") // strip a stray list marker
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .replace(/\s*\|\s*/g, "   ") // flatten any table pipes into spacing
      .trim();
    if (!joined) continue;
    const images: { alt: string; url: string }[] = [];
    const textOnly = joined.replace(new RegExp(IMG_RE.source, "g"), (_m, alt: string, url: string) => {
      images.push({ alt, url });
      return "";
    }).trim();
    if (textOnly) blocks.push(<p key={`${keyBase}-p-${blocks.length}`}>{renderInline(textOnly, `${keyBase}-${blocks.length}`)}</p>);
    for (const img of images) blocks.push(<ChatImage key={`${keyBase}-img-${blocks.length}`} alt={img.alt} url={img.url} />);
  }
  return <div className="space-y-4">{blocks}</div>;
}

// Render an assistant message: charts (<chart>...</chart>) rendered as graphs, everything else as spaced
// paragraphs. An unclosed <chart> mid-stream is hidden (shown as a shimmer) so raw JSON never leaks.
function renderAssistant(text: string) {
  const open = text.lastIndexOf("<chart>");
  const close = text.lastIndexOf("</chart>");
  let working = text;
  let pending = false;
  if (open !== -1 && (close === -1 || close < open)) {
    working = text.slice(0, open);
    pending = true;
  }
  const out: React.ReactNode[] = [];
  const re = new RegExp(CHART_RE.source, "g");
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(working)) !== null) {
    const before = working.slice(lastIdx, m.index);
    if (before.trim()) out.push(<div key={key++}>{renderParagraphs(before, `s${key}`)}</div>);
    out.push(<ChartBlock key={key++} raw={m[1]} />);
    lastIdx = m.index + m[0].length;
  }
  const rest = working.slice(lastIdx);
  if (rest.trim() || out.length === 0) out.push(<div key={key++}>{renderParagraphs(rest, `s${key}`)}</div>);
  if (pending) out.push(<div key={key++} className="my-1 h-28 animate-pulse rounded-2xl bg-white/[0.04]" />);
  return <div className="space-y-4">{out}</div>;
}

// Normalize on the client (the stream sends raw text): no em dashes, no "~". Stray "*" is dropped in
// renderInline; matched **bold** still renders.
function cleanText(s: string): string {
  return s
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/~\s*/g, "about ");
}

// Assistant turn — embedded directly on the app background (no bubble). While it is still streaming
// (`live`) it shows in full so the text reveals progressively; once complete, a long answer is clamped to
// a preview with a soft mask fade and a "Show more" toggle so the thread stays short.
const COLLAPSED_MAX = 148; // px — roughly six lines before we offer "Show more"
function AssistantMessage({ content, live, latest }: { content: string; live?: boolean; latest?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [clampable, setClampable] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (bodyRef.current) setClampable(bodyRef.current.scrollHeight > COLLAPSED_MAX + 24);
  }, [content]);
  // The latest reply (and one still streaming) stays fully open; only OLDER replies collapse to a preview
  // so the thread stays short.
  const canCollapse = clampable && !live && !latest;
  const collapsed = canCollapse && !expanded;
  return (
    <div className="text-[15.4px] leading-[1.65] text-white/90">
      <div
        ref={bodyRef}
        className="overflow-hidden transition-[max-height] duration-200"
        style={
          collapsed
            ? { maxHeight: COLLAPSED_MAX, maskImage: "linear-gradient(to bottom, #000 62%, transparent)", WebkitMaskImage: "linear-gradient(to bottom, #000 62%, transparent)" }
            : undefined
        }
      >
        {renderAssistant(cleanText(content))}
      </div>
      {canCollapse && (
        <button onClick={() => setExpanded((v) => !v)} className="mt-1.5 text-[13.2px] font-medium text-white/45 transition-colors hover:text-white/70">
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// Full-screen embedded chat for the mobile Dashboard's "Chat" sub-tab. Fills the viewport between the
// sub-tabs and the floating nav (edge to edge), on the app's own dark background. Talks to the
// model-switching backend at /api/hivemind/chat (tool access to every signal, source, API, and the DB).
export function HivemindChat({
  holdings,
  user,
}: {
  holdings: Array<{ ticker: string; name?: string; weight?: number | null }>;
  user?: string;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [turnKey, setTurnKey] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastUserRef = useRef<HTMLDivElement>(null);
  // Typewriter pacing: the network fills targetText; a rAF pacer reveals it slowly into the message.
  const targetTextRef = useRef("");
  const shownCountRef = useRef(0);
  const streamDoneRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Do NOT autoscroll to the end of a reply. On each send, bring the user's new message to the top of the
  // viewport so they read the answer from its start as it streams in below; the reply never yanks scroll.
  useLayoutEffect(() => {
    if (turnKey) lastUserRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [turnKey]);

  // Cancel any in-flight stream + pacer if the chat unmounts (e.g. switching sub-tabs).
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }
  function scrollToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  async function send(text: string) {
    const q = text.trim();
    if (!q || streaming) return;
    setErr(null);
    const history: Msg[] = [...msgs, { role: "user", content: q }];
    const assistantIdx = history.length; // the streaming placeholder sits right after the user turn
    setMsgs([...history, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);
    setTurnKey((k) => k + 1);

    targetTextRef.current = "";
    shownCountRef.current = 0;
    streamDoneRef.current = false;

    const setAssistant = (txt: string) =>
      setMsgs((m) => {
        if (!m[assistantIdx]) return m;
        const c = [...m];
        c[assistantIdx] = { role: "assistant", content: txt };
        return c;
      });

    // Pacer: reveal buffered text into the message at REVEAL_CPS, independent of how fast it arrives.
    let last: number | null = null;
    let carry = 0;
    const tick = (ts: number) => {
      if (last == null) last = ts;
      carry += ((ts - last) / 1000) * REVEAL_CPS;
      last = ts;
      const target = targetTextRef.current;
      let shown = shownCountRef.current;
      if (shown > target.length) shown = 0; // a reset shrank the buffer
      if (carry >= 1 && shown < target.length) {
        shown = Math.min(target.length, shown + Math.floor(carry));
        carry -= Math.floor(carry);
        shownCountRef.current = shown;
        setAssistant(target.slice(0, shown));
      }
      if (streamDoneRef.current && shown >= targetTextRef.current.length) {
        rafRef.current = null;
        setStreaming(false);
        setMsgs((m) => m.filter((msg) => !(msg.role === "assistant" && msg.content.trim() === "")));
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/hivemind/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          user,
          holdings: holdings.map((h) => ({ ticker: h.ticker, name: h.name, weight: h.weight ?? null })),
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        setErr("Couldn't reach the assistant.");
        return;
      }
      // Read the SSE stream: {t:"d",v} delta · {t:"reset"} clear · {t:"done"} · {t:"err",v}.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const line = chunk.startsWith("data:") ? chunk.slice(5).trim() : chunk.trim();
          if (!line) continue;
          let ev: { t?: string; v?: string };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.t === "d") targetTextRef.current += ev.v ?? "";
          else if (ev.t === "reset") {
            targetTextRef.current = "";
            shownCountRef.current = 0;
            setAssistant("");
          } else if (ev.t === "err") setErr(ev.v || "Something went wrong.");
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setErr("Couldn't reach the assistant.");
    } finally {
      streamDoneRef.current = true; // let the pacer drain the last buffered text, then it ends streaming
      abortRef.current = null;
    }
  }

  const empty = msgs.length === 0 && !streaming;
  const lastIdx = msgs.length - 1;
  let lastUserIdx = -1;
  for (let i = lastIdx; i >= 0; i--) if (msgs[i].role === "user") { lastUserIdx = i; break; }
  const awaitingFirstToken = streaming && lastIdx >= 0 && msgs[lastIdx].role === "assistant" && msgs[lastIdx].content === "";

  return (
    // Break out of the dashboard column's horizontal padding (-mx-3.5) and fill the height between the
    // sub-tabs and the floating nav, so the chat reads as a full-screen surface on the app background.
    <div
      className="relative -mx-3.5 flex flex-col overflow-hidden"
      style={{ height: "calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 170px)" }}
    >
      {/* messages */}
      <div ref={scrollRef} onScroll={onScroll} className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4" style={{ fontFamily: "var(--font-inter)" }}>
        {empty && (
          <div className="flex h-full flex-col justify-end gap-3.5 pb-2">
            <p className="px-1 text-[24.2px] font-medium tracking-tight text-white/90">{greeting()}</p>
            <div className="space-y-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="block w-full rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-left text-[14.85px] leading-snug text-white/80 transition-colors hover:bg-white/[0.05] active:bg-white/[0.06]"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {!empty && (
          <div className="space-y-5">
            {msgs.map((m, i) =>
              m.role === "user" ? (
                <div key={i} ref={i === lastUserIdx ? lastUserRef : undefined} className="flex scroll-mt-3 justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-white/[0.10] px-3.5 py-2.5 text-[15.4px] leading-relaxed text-white">
                    {m.content}
                  </div>
                </div>
              ) : m.content === "" ? null : (
                <AssistantMessage key={i} content={m.content} live={streaming && i === lastIdx} latest={i === lastIdx} />
              ),
            )}

            {awaitingFirstToken && (
              <div className="flex items-center gap-1.5 py-1">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/40" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/40 [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/40 [animation-delay:300ms]" />
              </div>
            )}

            {err && <p className="text-[12.5px] text-rose-400">{err}</p>}
          </div>
        )}
      </div>

      {/* scroll-to-bottom — appears only when scrolled up from the latest */}
      {!empty && !atBottom && (
        <button
          onClick={scrollToBottom}
          aria-label="Scroll to latest"
          className="absolute bottom-[74px] left-1/2 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-white/10 bg-[#1a1a1a]/90 text-white/80 backdrop-blur transition-colors hover:text-white"
          style={{ boxShadow: "0 6px 20px rgba(0,0,0,0.45)" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      )}

      {/* input — liquid-glass ask bar (frosted lens + top sheen + soft lift), matching the app's toggles */}
      <div className="shrink-0 px-3.5 pb-2 pt-1.5">
        <div
          className="flex items-end gap-2 rounded-[22px] border border-white/[0.12] px-2 py-1.5 transition-colors focus-within:border-white/25"
          style={{
            backgroundColor: "rgba(255,255,255,0.055)",
            backdropFilter: "blur(16px) saturate(170%)",
            WebkitBackdropFilter: "blur(16px) saturate(170%)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25), inset 0 -1px 1px rgba(0,0,0,0.18), 0 8px 24px rgba(0,0,0,0.38)",
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Ask about your portfolio…"
            rows={1}
            className="no-scrollbar max-h-32 min-h-[36px] flex-1 resize-none bg-transparent px-2.5 py-2 text-[16px] text-white placeholder:text-[#6a6a6a] focus:outline-none"
          />
          <button
            onClick={() => send(input)}
            disabled={streaming || !input.trim()}
            className="mb-0.5 grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-white text-black transition-opacity disabled:opacity-25"
            title="Send"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
