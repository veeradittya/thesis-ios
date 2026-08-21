import assert from "node:assert/strict";
import test from "node:test";
import { filterYouTubeSnapshots, normalizeYouTubeSnapshot, youtubeSnapshotsAreStale } from "../src/lib/youtubeSocial.ts";

const row = {
  ticker: "nvda",
  generatedAt: "2026-08-16T12:00:00Z",
  windowHours: 168,
  videos: [{
    videoId: "abcdefghijk",
    ticker: "NVDA",
    title: "Nvidia stock update",
    channel: "Research",
    publishedAt: "2026-08-16T10:00:00Z",
    viewCount: 100,
    thumbnailUrl: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
    videoSummary: "The creator argues that data-center demand supports Nvidia, while identifying valuation as the principal risk.",
    transcriptExcerpt: "An evidence excerpt.",
  }],
};

test("normalizes safe YouTube snapshots", () => {
  const normalized = normalizeYouTubeSnapshot(row);
  assert.equal(normalized?.ticker, "NVDA");
  assert.equal(normalized?.videos[0].viewCount, 100);
  assert.match(normalized?.videos[0].videoSummary || "", /data-center demand/);
});

test("drops non-YouTube links and malformed snapshots", () => {
  const unsafe = normalizeYouTubeSnapshot({ ...row, videos: [{ ...row.videos[0], url: "https://example.com" }] });
  assert.deepEqual(unsafe?.videos, []);
  assert.equal(normalizeYouTubeSnapshot({ ...row, generatedAt: "invalid" }), null);
});

test("filters by portfolio ticker and reports staleness", () => {
  const nvda = normalizeYouTubeSnapshot(row)!;
  const aapl = normalizeYouTubeSnapshot({ ...row, ticker: "AAPL", videos: [{ ...row.videos[0], ticker: "AAPL" }] })!;
  assert.deepEqual(filterYouTubeSnapshots([nvda, aapl], ["AAPL"]).map((value) => value.ticker), ["AAPL"]);
  assert.equal(youtubeSnapshotsAreStale([nvda], Date.parse("2026-08-17T23:59:59Z")), false);
  assert.equal(youtubeSnapshotsAreStale([nvda], Date.parse("2026-08-18T00:00:01Z")), true);
});
