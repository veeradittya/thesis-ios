# Hivemind data model

The research host is the system of record. The app receives only compact per-ticker derivatives; raw
Reddit text, raw YouTube API resources, full transcripts, and timestamped transcript segments stay on
the host.

## Reddit SQLite: `data/reddit.sqlite`

| Layer | Table | Key / relationship | Purpose |
| --- | --- | --- | --- |
| Raw | `submissions` | `id` primary key | Post text, title, author, subreddit, scores, permalink, creation/retrieval times. |
| Raw | `comments` | `id` primary key; `submission_id → submissions.id` | Comment body, parent/thread identity, author, score, depth, creation/retrieval times. |
| Operations | `collection_runs` | `run_id` primary key | One row per subreddit/run with requested window, counts, provider, status, and errors. |
| Operations | `subreddit_checkpoints` | `subreddit` primary key | Checkpoint for incremental `update` mode; fixed 24-hour backfills do not require it. |

Reddit analysis is file-based staging under `data/analysis/`:

- `reddit_stock_ranking_7d.parquet`: one row per configured ticker with matched post/comment, author,
  and thread counts.
- `reddit_stock_context_7d.parquet`: one row per selected top ticker containing the complete assembled
  evidence objects and its final summary.
- `reddit_stock_context_7d.csv`: portable version of the context table; evidence is JSON text.
- `reddit_stock_context_7d.metadata.json`: analysis window, input counts, universe version, and summary
  model provenance.

## YouTube SQLite: `data/youtube.sqlite`

| Layer | Table | Key / relationship | Purpose |
| --- | --- | --- | --- |
| Raw | `videos` | `video_id` primary key | Normalized Data API metadata plus the complete API resource in `raw_json`. |
| Raw | `transcripts` | `video_id` primary/foreign key → `videos` | Availability, language, generated/manual flag, full text, timestamped segments, and retrieval error. |
| Staging | `stock_matches` | composite `video_id, ticker`; `video_id → videos` | Many-to-many discovery provenance: ticker, exact query, and whether title/description matched. |
| Staging | `video_summaries` | `video_id` primary/foreign key → `videos` | Two-sentence transcript derivative, model version, source SHA-256, and generation time. |
| Operations | `collection_runs` | integer `id` primary key | Search/candidate/match/transcript counts, ticker set, status, and errors for each run. |

`video_summaries.source_sha256` is the incremental boundary: an unchanged transcript reuses its cached
summary; a changed transcript is summarized again. Videos without a transcript-derived summary are not
published to Hivemind.

## App serving tables (Turso)

| Table | Grain | Columns |
| --- | --- | --- |
| `reddit_social_snapshots` | one current row per ticker | `ticker`, `mentions`, `generated_at`, compact JSON `payload` |
| `youtube_social_snapshots` | one current row per ticker | `ticker`, `generated_at`, compact JSON `payload` |

The JSON payload keeps the API contract version-flexible. Reddit payloads contain counts, summary, and
up to three source-thread links. YouTube payloads contain the video metadata, transcript summary, short
matched excerpt, thumbnail, and canonical video link. Checked-in fixture JSON follows the same contract
for local and preview builds when Turso is unavailable.
