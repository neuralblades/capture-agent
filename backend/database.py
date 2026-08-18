"""SQLite persistence for captured posts and their extracted data."""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Literal, Optional

DB_PATH = Path(__file__).parent / "capture_agent.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    author TEXT,
    content TEXT NOT NULL,
    url TEXT,
    captured_at TEXT NOT NULL,
    summary TEXT NOT NULL,
    tags TEXT NOT NULL,
    action_required INTEGER NOT NULL,
    deadlines TEXT NOT NULL,
    external_url TEXT,
    contact_email TEXT,
    action_type TEXT NOT NULL DEFAULT 'none',
    category TEXT NOT NULL DEFAULT 'General',
    is_opportunity INTEGER NOT NULL DEFAULT 0,
    posted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    label TEXT,
    last_checked_at TEXT,
    last_seen_guid TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    """Yield a connection that commits/rolls back on exit and is always closed.

    ``sqlite3.Connection`` used as a context manager only handles the
    transaction (commit on success, rollback on exception) — it does not
    close the connection. Wrap that behavior here so every call site gets
    both without having to remember `conn.close()`.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


# Columns added to `posts` after its initial release. CREATE TABLE IF NOT
# EXISTS is a no-op against a database file that already exists on disk (the
# .db file is gitignored, so every local/deployed instance has its own), so
# init_db() also backfills any of these that are missing via ALTER TABLE.
_COLUMN_MIGRATIONS: list[tuple[str, str]] = [
    ("external_url", "ALTER TABLE posts ADD COLUMN external_url TEXT"),
    ("contact_email", "ALTER TABLE posts ADD COLUMN contact_email TEXT"),
    ("action_type", "ALTER TABLE posts ADD COLUMN action_type TEXT NOT NULL DEFAULT 'none'"),
    ("match_score", "ALTER TABLE posts ADD COLUMN match_score INTEGER"),
    ("category", "ALTER TABLE posts ADD COLUMN category TEXT NOT NULL DEFAULT 'General'"),
    ("is_opportunity", "ALTER TABLE posts ADD COLUMN is_opportunity INTEGER NOT NULL DEFAULT 0"),
    ("posted_at", "ALTER TABLE posts ADD COLUMN posted_at TEXT"),
    ("status", "ALTER TABLE posts ADD COLUMN status TEXT"),
    ("notes", "ALTER TABLE posts ADD COLUMN notes TEXT"),
    ("resurface_at", "ALTER TABLE posts ADD COLUMN resurface_at TEXT"),
]


def init_db() -> None:
    with get_connection() as conn:
        conn.executescript(SCHEMA)
        existing_columns = {row["name"] for row in conn.execute("PRAGMA table_info(posts)")}
        for column, ddl in _COLUMN_MIGRATIONS:
            if column not in existing_columns:
                conn.execute(ddl)


def insert_post(
    *,
    platform: str,
    author: Optional[str],
    content: str,
    url: Optional[str],
    captured_at: str,
    summary: str,
    tags: list[str],
    action_required: bool,
    deadlines: list[dict[str, Any]],
    external_url: Optional[str] = None,
    contact_email: Optional[str] = None,
    action_type: str = "none",
    category: str = "General",
    is_opportunity: bool = False,
    posted_at: Optional[str] = None,
) -> int:
    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO posts (
                platform, author, content, url, captured_at, summary, tags,
                action_required, deadlines, external_url, contact_email, action_type, category, is_opportunity, posted_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                platform,
                author,
                content,
                url,
                captured_at,
                summary,
                json.dumps(tags),
                int(action_required),
                json.dumps(deadlines),
                external_url,
                contact_email,
                action_type,
                category,
                int(is_opportunity),
                posted_at,
            ),
        )
        return cursor.lastrowid


def row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "platform": row["platform"],
        "author": row["author"],
        "content": row["content"],
        "url": row["url"],
        "captured_at": row["captured_at"],
        "summary": row["summary"],
        "tags": json.loads(row["tags"]),
        "action_required": bool(row["action_required"]),
        "deadlines": json.loads(row["deadlines"]),
        "external_url": row["external_url"],
        "contact_email": row["contact_email"],
        "action_type": row["action_type"],
        "match_score": row["match_score"],
        "category": row["category"],
        "is_opportunity": bool(row["is_opportunity"]),
        "posted_at": row["posted_at"],
        "status": row["status"],
        "notes": row["notes"],
        "resurface_at": row["resurface_at"],
        "created_at": row["created_at"],
    }


def list_posts(limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM posts ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [row_to_dict(row) for row in rows]


def get_post(post_id: int) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
    return row_to_dict(row) if row else None


def get_post_by_url(url: str) -> Optional[dict[str, Any]]:
    """Most recent post captured from this URL, if any."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM posts WHERE url = ? ORDER BY id DESC LIMIT 1", (url,)
        ).fetchone()
    return row_to_dict(row) if row else None


def category_counts() -> list[dict[str, Any]]:
    """Unique categories currently present, with post counts, plus an 'All' total.

    'All' is listed first, followed by categories ordered by count (most
    posts first, ties broken alphabetically) so the busiest filter pills show
    up first in the side panel.
    """
    with get_connection() as conn:
        total = conn.execute("SELECT COUNT(*) AS n FROM posts").fetchone()["n"]
        rows = conn.execute(
            "SELECT category AS name, COUNT(*) AS count FROM posts GROUP BY category ORDER BY count DESC, name ASC"
        ).fetchall()
    return [{"name": "All", "count": total}] + [{"name": row["name"], "count": row["count"]} for row in rows]


def platform_counts() -> list[dict[str, Any]]:
    """Unique platforms currently present, with post counts, plus an 'All' total.

    Same shape/ordering as category_counts() -- 'All' first, then platforms
    ordered by count (most posts first, ties broken alphabetically).
    """
    with get_connection() as conn:
        total = conn.execute("SELECT COUNT(*) AS n FROM posts").fetchone()["n"]
        rows = conn.execute(
            "SELECT platform AS name, COUNT(*) AS count FROM posts GROUP BY platform ORDER BY count DESC, name ASC"
        ).fetchall()
    return [{"name": "All", "count": total}] + [{"name": row["name"], "count": row["count"]} for row in rows]


def _parse_captured_at(value: str) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    # A handful of legacy/manually-inserted rows may lack an offset; treat
    # them as already-UTC rather than assuming the server's local timezone.
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _bucket_keys(window_start: date, window_end: date, bucket: Literal["day", "week"]) -> list[date]:
    """Every bucket key in [window_start, window_end], inclusive, so the trend
    response is zero-filled and gap-free rather than only listing days/weeks
    that happen to have captures."""
    if bucket == "day":
        return [window_start + timedelta(days=i) for i in range((window_end - window_start).days + 1)]

    # Week buckets are keyed by their Monday, so a window whose start/end
    # fall mid-week still produces every week those days belong to.
    first_week = window_start - timedelta(days=window_start.weekday())
    last_week = window_end - timedelta(days=window_end.weekday())
    weeks = []
    cursor = first_week
    while cursor <= last_week:
        weeks.append(cursor)
        cursor += timedelta(days=7)
    return weeks


def trend_counts(days: int = 30, bucket: Literal["day", "week"] = "day") -> list[dict[str, Any]]:
    """Capture counts bucketed by day or week (keyed by captured_at, in UTC)
    over a trailing window of `days` ending today (inclusive on both ends).

    Grouping happens in Python rather than SQL: captured_at is stored as
    whatever ISO 8601 offset the client/server produced it with, and string
    comparison/GROUP BY against that column would silently mis-bucket values
    near a UTC day boundary that weren't captured in UTC.
    """
    now = datetime.now(timezone.utc)
    window_end = now.date()
    window_start = window_end - timedelta(days=days - 1)

    with get_connection() as conn:
        rows = conn.execute("SELECT captured_at FROM posts").fetchall()

    counts: dict[date, int] = {}
    for row in rows:
        parsed = _parse_captured_at(row["captured_at"])
        if parsed is None:
            continue
        day = parsed.astimezone(timezone.utc).date()
        if day < window_start or day > window_end:
            continue
        key = day if bucket == "day" else day - timedelta(days=day.weekday())
        counts[key] = counts.get(key, 0) + 1

    return [{"bucket": key.isoformat(), "count": counts.get(key, 0)} for key in _bucket_keys(window_start, window_end, bucket)]


def get_post_by_url_and_content(url: str, content: str) -> Optional[dict[str, Any]]:
    """Most recent post with this exact (url, content) pair, if any -- used to
    make /capture idempotent for a re-capture of the same source. Matching on
    url alone isn't enough: a tweet or LinkedIn post has one fixed url per
    piece of content, but a web_selection capture's url is just the page it
    was selected from, so two different highlighted passages from the same
    page share a url and must not be collapsed into one post."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM posts WHERE url = ? AND content = ? ORDER BY id DESC LIMIT 1",
            (url, content),
        ).fetchone()
    return row_to_dict(row) if row else None


def delete_post(post_id: int) -> bool:
    """Returns True if a row was deleted, False if post_id didn't exist."""
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM posts WHERE id = ?", (post_id,))
    return cursor.rowcount > 0


def update_match_score(post_id: int, match_score: int) -> bool:
    """Returns True if a row was updated, False if post_id didn't exist."""
    with get_connection() as conn:
        cursor = conn.execute(
            "UPDATE posts SET match_score = ? WHERE id = ?", (match_score, post_id)
        )
    return cursor.rowcount > 0


_UNSET: Any = object()


def update_post_fields(
    post_id: int,
    *,
    status: Optional[str] = _UNSET,
    notes: Optional[str] = _UNSET,
    resurface_at: Optional[str] = _UNSET,
) -> bool:
    """Updates any subset of status/notes/resurface_at on a post. A parameter
    left at its _UNSET default is left untouched; pass None explicitly to
    clear that column. Returns True if a row was updated, False if post_id
    didn't exist."""
    updates: dict[str, Optional[str]] = {}
    if status is not _UNSET:
        updates["status"] = status
    if notes is not _UNSET:
        updates["notes"] = notes
    if resurface_at is not _UNSET:
        updates["resurface_at"] = resurface_at

    if not updates:
        return get_post(post_id) is not None

    columns = ", ".join(f"{column} = ?" for column in updates)
    with get_connection() as conn:
        cursor = conn.execute(
            f"UPDATE posts SET {columns} WHERE id = ?", (*updates.values(), post_id)
        )
    return cursor.rowcount > 0


def feed_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "url": row["url"],
        "label": row["label"],
        "last_checked_at": row["last_checked_at"],
        "last_seen_guid": row["last_seen_guid"],
        "created_at": row["created_at"],
    }


def add_feed(*, url: str, label: Optional[str]) -> int:
    with get_connection() as conn:
        cursor = conn.execute("INSERT INTO feeds (url, label) VALUES (?, ?)", (url, label))
        return cursor.lastrowid


def list_feeds() -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM feeds ORDER BY id ASC").fetchall()
    return [feed_row_to_dict(row) for row in rows]


def get_feed(feed_id: int) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM feeds WHERE id = ?", (feed_id,)).fetchone()
    return feed_row_to_dict(row) if row else None


def delete_feed(feed_id: int) -> bool:
    """Returns True if a row was deleted, False if feed_id didn't exist."""
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM feeds WHERE id = ?", (feed_id,))
    return cursor.rowcount > 0


def update_feed_poll_state(feed_id: int, *, last_seen_guid: Optional[str]) -> None:
    """Records that a feed was just polled and the newest entry guid seen."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE feeds SET last_checked_at = ?, last_seen_guid = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), last_seen_guid, feed_id),
        )
