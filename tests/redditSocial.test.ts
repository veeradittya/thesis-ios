import assert from "node:assert/strict";
import test from "node:test";
import {
  filterRedditSnapshots,
  normalizeRedditSnapshot,
  snapshotsAreStale,
} from "../src/lib/redditSocial.ts";

const valid = {
  ticker: "nvda",
  windowHours: 168,
  mentions: 42,
  submissions: 2,
  comments: 40,
  uniqueAuthors: 30,
  uniqueThreads: 8,
  mentionChangePct: 12.5,
  summary: "A grounded summary.",
  topSources: [{ subreddit: "stocks", title: "Thread", score: 9, url: "https://www.reddit.com/r/stocks/test" }],
  generatedAt: "2026-08-10T10:00:00Z",
  windowStart: "2026-08-03T10:00:00Z",
  windowEnd: "2026-08-10T10:00:00Z",
};

test("normalizes a valid snapshot and constrains Reddit links", () => {
  const snapshot = normalizeRedditSnapshot(valid);
  assert.equal(snapshot?.ticker, "NVDA");
  assert.equal(snapshot?.topSources.length, 1);
  const unsafe = normalizeRedditSnapshot({ ...valid, topSources: [{ ...valid.topSources[0], url: "https://example.com" }] });
  assert.deepEqual(unsafe?.topSources, []);
});

test("rejects malformed records", () => {
  assert.equal(normalizeRedditSnapshot({ ...valid, ticker: "bad ticker" }), null);
  assert.equal(normalizeRedditSnapshot({ ...valid, generatedAt: "yesterday" }), null);
  assert.equal(normalizeRedditSnapshot({ ...valid, summary: "" }), null);
});

test("filters by portfolio and sorts by discussion volume", () => {
  const nvda = normalizeRedditSnapshot(valid)!;
  const aapl = normalizeRedditSnapshot({ ...valid, ticker: "AAPL", mentions: 100 })!;
  assert.deepEqual(filterRedditSnapshots([nvda, aapl], ["nvda", "AAPL"]).map((row) => row.ticker), ["AAPL", "NVDA"]);
  assert.deepEqual(filterRedditSnapshots([nvda, aapl], ["TSLA"]), []);
});

test("marks snapshots stale after 36 hours", () => {
  const snapshot = normalizeRedditSnapshot(valid)!;
  assert.equal(snapshotsAreStale([snapshot], Date.parse("2026-08-11T21:59:59Z")), false);
  assert.equal(snapshotsAreStale([snapshot], Date.parse("2026-08-11T22:00:01Z")), true);
  assert.equal(snapshotsAreStale([], Date.now()), true);
});
