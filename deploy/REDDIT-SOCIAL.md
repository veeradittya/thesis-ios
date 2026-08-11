# Reddit social-listening pipeline

The app serves compact, derived seven-day Reddit snapshots from `GET /api/social/reddit`. Raw posts,
comments, SQLite, CSV, and Parquet evidence stay on the research host and are never deployed to Vercel.

## Local UI development

With Turso unset, the API uses `src/data/reddit-social.fixture.json`. Run the normal app dev server and
open Dashboard → Analyst Sentiment. The fixture is intentionally marked stale so the stale-data state is
always exercised locally.

## Production publication

Set the same random `REDDIT_INGEST_SECRET` in Vercel and in the collector host's private environment.
Set `REDDIT_INGEST_ENDPOINT=https://thesis-ios.vercel.app` on the collector host. After a successful raw
update, regenerate analysis and publish it:

```bash
cd /home/shared/LabDataP3/herbert
.venv/bin/python -m reddit_scraper update
.venv/bin/python -m reddit_analysis stock-summary --days 7 --top 20
.venv/bin/python /home/herbert/Shinri/thesis/thesis-ios/scripts/publish_reddit_social.py
```

Use `--dry-run --output /tmp/reddit-social.json` to validate without changing production. Publication
upserts one compact Turso row per ticker. If collection, analysis, or publication fails, the last good
snapshot remains available; the UI labels it stale after 36 hours.

The existing `reddit-scraper.service` only runs the first command and is not installed on this host yet.
Before enabling its timer, replace its `ExecStart` with a reviewed wrapper that runs all three commands
sequentially and stops on the first failure.
