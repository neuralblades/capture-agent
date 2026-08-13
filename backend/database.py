"""SQLite persistence for captured posts and their extracted data."""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

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
]


def init_db() -> None:
    with get_connection() as conn:
        conn.execute(SCHEMA)
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
) -> int:
    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO posts (
                platform, author, content, url, captured_at, summary, tags,
                action_required, deadlines, external_url, contact_email, action_type
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    """Most recent post captured from this URL, if any -- used to make /capture
    idempotent for the same tweet instead of inserting a duplicate row."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM posts WHERE url = ? ORDER BY id DESC LIMIT 1", (url,)
        ).fetchone()
    return row_to_dict(row) if row else None


def delete_post(post_id: int) -> bool:
    """Returns True if a row was deleted, False if post_id didn't exist."""
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM posts WHERE id = ?", (post_id,))
    return cursor.rowcount > 0
