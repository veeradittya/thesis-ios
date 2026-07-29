// Shared Guardian Open Platform request helper with API-key fallback.
//
// Keys live in env ONLY (never in code or git): GUARDIAN_API_KEY is tried first, and
// GUARDIAN_API_KEY_FALLBACK is used when the primary is rate-limited (429) or rejected
// (401/403) — most commonly when the free Developer tier's 500-calls/day quota is spent.
// All Guardian callers (guardian.ts, news.ts, tierANews.ts) route through this so the
// fallback behaviour is uniform and can't drift.

export function guardianKeys(): string[] {
  return [process.env.GUARDIAN_API_KEY, process.env.GUARDIAN_API_KEY_FALLBACK].filter(
    (k): k is string => !!k,
  );
}

// Fetch a Guardian URL, appending `api-key` and rotating to the next key on a quota/auth
// failure. `url` must already carry every query param EXCEPT api-key. Returns the first ok
// response; on any non-quota error status it returns immediately; if every key is throttled
// it returns the last failing response (callers already handle !ok by serving stale/empty).
export async function guardianFetch(url: string, init?: RequestInit): Promise<Response> {
  const keys = guardianKeys();
  if (!keys.length) throw new Error("GUARDIAN_API_KEY is not set");
  const sep = url.includes("?") ? "&" : "?";
  let res: Response | undefined;
  for (const key of keys) {
    res = await fetch(`${url}${sep}api-key=${encodeURIComponent(key)}`, init);
    if (res.ok) return res;
    // Rotate to the fallback only on throttle/auth failures; surface anything else as-is.
    if (res.status !== 429 && res.status !== 401 && res.status !== 403) return res;
  }
  return res as Response;
}
