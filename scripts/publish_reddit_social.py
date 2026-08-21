#!/usr/bin/env python3
"""Build and optionally publish the app's compact Reddit social snapshot.

Run this on the collector host after `python -m reddit_analysis stock-summary`.
It reads only derived analysis artifacts; the raw SQLite corpus never leaves the host.
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.request
from pathlib import Path
from typing import Any

import pandas as pd


DEFAULT_ANALYSIS = Path("/home/shared/LabDataP3/herbert/data/analysis")


def _top_sources(evidence: list[dict[str, Any]], limit: int = 3) -> list[dict[str, Any]]:
    candidates: dict[str, dict[str, Any]] = {}
    for item in evidence:
        permalink = item.get("permalink")
        title = str(item.get("title") or "").strip()
        if item.get("type") != "submission" or not permalink or not title:
            continue
        url = str(permalink)
        if url.startswith("/"):
            url = "https://www.reddit.com" + url
        if not url.startswith("https://www.reddit.com/"):
            continue
        candidate = {
            "subreddit": str(item.get("subreddit") or ""),
            "title": title[:240],
            "score": max(0, int(item.get("score") or 0)),
            "url": url,
        }
        existing = candidates.get(url)
        if not existing or candidate["score"] > existing["score"]:
            candidates[url] = candidate
    return sorted(candidates.values(), key=lambda row: row["score"], reverse=True)[:limit]


def build_snapshots(analysis_dir: Path) -> list[dict[str, Any]]:
    context = pd.read_parquet(analysis_dir / "reddit_stock_context_7d.parquet")
    ranking = pd.read_parquet(analysis_dir / "reddit_stock_ranking_7d.parquet")
    metadata = json.loads((analysis_dir / "reddit_stock_context_7d.metadata.json").read_text(encoding="utf-8"))
    selected = set(context["stock_ticker"])
    summaries = {row.stock_ticker: row for row in context.itertuples(index=False)}
    window_start = metadata["window_start_utc"]
    window_end = metadata["window_end_utc"]
    start = pd.Timestamp(window_start)
    end = pd.Timestamp(window_end)
    window_hours = max(1, round((end - start).total_seconds() / 3600))
    snapshots: list[dict[str, Any]] = []
    for row in ranking.itertuples(index=False):
        if row.stock_ticker not in selected:
            continue
        detail = summaries[row.stock_ticker]
        snapshots.append({
            "ticker": row.stock_ticker,
            "windowHours": window_hours,
            "mentions": int(row.total_matching_records),
            "submissions": int(row.matching_submissions),
            "comments": int(row.matching_comments),
            "uniqueAuthors": int(row.unique_authors),
            "uniqueThreads": int(row.unique_threads),
            "mentionChangePct": None,
            "summary": str(detail.summary),
            "topSources": _top_sources(detail.all_information),
            "generatedAt": metadata["analysis_started_utc"],
            "windowStart": window_start,
            "windowEnd": window_end,
        })
    return snapshots


def publish(endpoint: str, secret: str, snapshots: list[dict[str, Any]]) -> dict[str, Any]:
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/api/social/reddit",
        data=json.dumps({"snapshots": snapshots}).encode("utf-8"),
        headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analysis-dir", type=Path, default=DEFAULT_ANALYSIS)
    parser.add_argument("--endpoint", default=os.getenv("SOCIAL_INGEST_ENDPOINT", os.getenv("REDDIT_INGEST_ENDPOINT", "")))
    parser.add_argument("--secret", default=os.getenv("SOCIAL_INGEST_SECRET", os.getenv("REDDIT_INGEST_SECRET", "")))
    parser.add_argument("--output", type=Path, help="Optionally write the compact JSON payload")
    parser.add_argument("--dry-run", action="store_true", help="Validate and print stats without posting")
    args = parser.parse_args()
    snapshots = build_snapshots(args.analysis_dir)
    payload = json.dumps({"snapshots": snapshots}, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(payload, encoding="utf-8")
    size = len(payload.encode("utf-8"))
    print(f"built {len(snapshots)} snapshots ({size:,} bytes)")
    if args.dry_run:
        return
    if not args.endpoint or not args.secret:
        raise SystemExit("SOCIAL_INGEST_ENDPOINT and SOCIAL_INGEST_SECRET are required unless --dry-run is used")
    result = publish(args.endpoint, args.secret, snapshots)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
