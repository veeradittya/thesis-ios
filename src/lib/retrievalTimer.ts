// Times how long each data retrieval (news + every other tab) takes on the client and hands the
// elapsed ms to a reporter (MonacoHome logs it as a "retrieval" activity event). Installed once as a
// thin wrapper around window.fetch so we don't have to touch every call site. Only curated /api
// endpoints are timed — typeahead, auth polling, the activity log itself, and streaming chat are
// skipped so the feed stays signal, not noise.

// Ordered longest-prefix-first so /api/prediction/markets wins over /api/prediction.
const LABELS: Array<[string, string]> = [
  ["/api/news", "news"],
  ["/api/prediction/markets", "asset markets"],
  ["/api/prediction/market", "market detail"],
  ["/api/prediction/radar", "market radar"],
  ["/api/prediction", "prediction markets"],
  ["/api/whales/market", "market whales"],
  ["/api/whales", "whale tracker"],
  ["/api/guardian", "news article"],
  ["/api/monitor", "brief"],
  ["/api/quote", "quotes"],
  ["/api/prices/history", "price history"],
  ["/api/signals", "signal search"],
  ["/api/macro/event/volumes", "macro volumes"],
  ["/api/macro/catalog", "macro catalog"],
  ["/api/macro", "macro"],
  ["/api/recommend", "recommendations"],
  ["/api/thesis-ideas", "thesis ideas"],
  ["/api/oddpool", "event odds"],
];

function labelFor(path: string): string | null {
  for (const [prefix, label] of LABELS) if (path.startsWith(prefix)) return label;
  return null;
}

function pathOf(input: RequestInfo | URL): string {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(raw, window.location.origin).pathname;
  } catch {
    return "";
  }
}

type Reporter = (label: string, ms: number) => void;
let reporter: Reporter | null = null;
export function setRetrievalReporter(fn: Reporter | null): void {
  reporter = fn;
}

// Idempotent: patch window.fetch exactly once for the life of the page.
export function installRetrievalTimer(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __retrievalTimed?: boolean };
  if (w.__retrievalTimed) return;
  w.__retrievalTimed = true;

  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const label = reporter ? labelFor(pathOf(input)) : null;
    if (!label) return orig(input, init);
    const t0 = performance.now();
    try {
      const res = await orig(input, init);
      reporter?.(label, Math.round(performance.now() - t0));
      return res;
    } catch (e) {
      // Network failure still took time — record it so a slow/failed retrieval is visible.
      reporter?.(label, Math.round(performance.now() - t0));
      throw e;
    }
  };
}
