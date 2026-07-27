// Client-side cache + prefetch for "Asset Related Markets" (the /api/prediction/markets payload).
// The markets query is a slow Oddpool fan-out, and PortfolioMarketsCard unmounts whenever you leave
// the Markets tab — so without this, every return refetched from scratch and showed the
// "Scanning live markets…" spinner again. This module keeps the last payload per holdings-signature
// (in memory + localStorage) and lets the app kick the fetch off at launch, so the card paints
// instantly from cache and only refreshes silently in the background.
import type { MarketsPayload } from "@/lib/oddpool";
import type { ParsedHolding } from "@/lib/parsePortfolio";

export const MARKETS_TTL = 600_000; // 10 min — matches the card's old refresh cadence
const LS_KEY = "thesis.markets.v1";

// The stored object reference is replaced only on a real state change (then we emit), so it is a
// stable snapshot between renders — exactly what useSyncExternalStore needs.
type Entry = { payload: MarketsPayload | null; at: number; err: string | null; promise: Promise<void> | null };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

export function marketsSig(holdings: ParsedHolding[]): string {
  return JSON.stringify(holdings.map((h) => [h.ticker, h.name, h.weight]));
}

function emit() {
  for (const l of listeners) l();
}

export function subscribeMarkets(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// The current cached entry for a signature (or undefined). Returns the stored object as-is so its
// reference stays stable between emits — do not mutate it.
export function getMarketsEntry(sig: string): Entry | undefined {
  return cache.get(sig);
}

// Fire a fetch if the cache is missing/stale for these holdings and none is already in flight.
// Cheap + idempotent — safe to call on launch, on every mount, or on holdings edits.
export function ensureMarkets(holdings: ParsedHolding[], opts?: { force?: boolean }): void {
  if (typeof window === "undefined") return; // client-only
  const sig = marketsSig(holdings);
  const e = cache.get(sig);
  if (e?.promise) return; // already loading
  if (e?.payload && Date.now() - e.at < MARKETS_TTL && !opts?.force) return; // still fresh

  const body = JSON.stringify({ holdings: holdings.map((h) => ({ ticker: h.ticker, name: h.name, weight: h.weight })) });
  const promise = fetch("/api/prediction/markets", { method: "POST", headers: { "Content-Type": "application/json" }, body })
    .then((r) => r.json())
    .then((j: MarketsPayload & { error?: string }) => {
      const prev = cache.get(sig);
      if (j?.error) {
        // keep any previously good rows; only surface the error when we have nothing to show
        cache.set(sig, { payload: prev?.payload ?? null, at: prev?.at ?? 0, err: prev?.payload ? null : j.error, promise: null });
      } else {
        const at = Date.now();
        cache.set(sig, { payload: j, at, err: null, promise: null });
        try {
          localStorage.setItem(LS_KEY, JSON.stringify({ sig, payload: j, at }));
        } catch {
          /* quota / private mode — in-memory cache still works */
        }
      }
    })
    .catch(() => {
      const prev = cache.get(sig);
      cache.set(sig, { payload: prev?.payload ?? null, at: prev?.at ?? 0, err: prev?.payload ? null : "Couldn't load markets.", promise: null });
    })
    .finally(emit);

  // mark in-flight, preserving any stale payload so the card keeps showing it (no spinner) mid-refresh
  cache.set(sig, { payload: e?.payload ?? null, at: e?.at ?? 0, err: null, promise });
  emit();
}

// Seed the in-memory cache from localStorage once, so a fresh page load paints instantly for the
// same holdings before the network responds. No-op on the server / when nothing is stored.
if (typeof window !== "undefined") {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const { sig, payload, at } = JSON.parse(raw);
      if (sig && payload) cache.set(sig, { payload, at: at ?? 0, err: null, promise: null });
    }
  } catch {
    /* ignore a corrupt cache */
  }
}
