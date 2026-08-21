# Hivemind social-listening pipeline

Dashboard → Hivemind combines two compact public feeds:

- `GET /api/social/reddit` serves seven-day discussion summaries and links to source threads.
- `GET /api/social/youtube` serves videos published in the last 24 hours, transcript excerpts, and links to YouTube.

Raw Reddit posts/comments and full YouTube transcripts remain on the research host. Only the compact
snapshots are published to the app. When Turso is unavailable, the APIs fall back to the checked-in
fixtures so local and preview builds remain usable.

## Daily jobs on the research host

The `herbert` crontab runs the Reddit pipeline at 04:05 and YouTube at 04:35 America/New_York. `flock`
prevents overlapping runs. Logs and lock files live under `~/.local/state/hivemind/`.

Reddit executes `/home/shared/LabDataP3/herbert/scripts/reddit_daily.sh`: it fetches exactly the previous
24 hours, rebuilds the rolling seven-day analysis, asks the locally authenticated Codex CLI for one
structured, evidence-grounded summary batch, then publishes. If Codex is unavailable or times out, the
validated deterministic summaries are published instead. YouTube executes
`/home/herbert/Shinri/thesis/youtube-research/scripts/youtube_daily.sh`: it searches the previous 24 hours,
collects available transcripts, caches transcript-only Codex summaries by content hash, then publishes
a 24-hour snapshot. When a transcript has no summary, the UI falls back to its matched excerpt.

## Production publication

Set the same random `SOCIAL_INGEST_SECRET` in Vercel and both private collector `.env` files. Set
`SOCIAL_INGEST_ENDPOINT=https://<production-host>` on the collector host. Both ingestion endpoints are
write-protected; their GET endpoints remain public and read-only.

For a safe payload inspection without publishing:

```bash
python scripts/publish_reddit_social.py --dry-run --output /tmp/reddit-social.json
python /home/herbert/Shinri/thesis/youtube-research/scripts/publish_youtube_social.py \
  --dry-run --output /tmp/youtube-social.json
```

If a collection or publication fails, the last good row remains available and the UI marks snapshots
stale after 36 hours.
