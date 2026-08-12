import sqlite3
from datetime import datetime, timezone

import pytest

import database


def _insert(**overrides):
    defaults = dict(
        platform="twitter",
        author=None,
        content="post content",
        url=None,
        captured_at=datetime.now(timezone.utc).isoformat(),
        summary="a summary",
        tags=[],
        action_required=False,
        deadlines=[],
    )
    defaults.update(overrides)
    return database.insert_post(**defaults)


def test_insert_and_get_post(isolated_db):
    post_id = _insert(
        platform="linkedin",
        author="Jane",
        content="hello world",
        url="https://example.com",
        tags=["a", "b"],
        action_required=True,
        deadlines=[{"text": "by Friday", "iso_date": "2026-08-14", "confidence": 0.9}],
    )
    assert post_id == 1

    record = database.get_post(post_id)
    assert record is not None
    assert record["platform"] == "linkedin"
    assert record["tags"] == ["a", "b"]
    assert record["deadlines"][0]["iso_date"] == "2026-08-14"
    assert record["external_url"] is None
    assert record["contact_email"] is None
    assert record["action_type"] == "none"


def test_insert_and_get_post_with_action_fields(isolated_db):
    post_id = _insert(
        external_url="https://forms.gle/abc123",
        contact_email="jane@acme.com",
        action_type="job_form",
    )

    record = database.get_post(post_id)
    assert record is not None
    assert record["external_url"] == "https://forms.gle/abc123"
    assert record["contact_email"] == "jane@acme.com"
    assert record["action_type"] == "job_form"


def test_get_missing_post_returns_none(isolated_db):
    assert database.get_post(12345) is None


def test_contact_email_defaults_to_none(isolated_db):
    post_id = _insert()
    assert database.get_post(post_id)["contact_email"] is None


def test_contact_email_round_trips(isolated_db):
    post_id = _insert(contact_email="jane@example.com")
    assert database.get_post(post_id)["contact_email"] == "jane@example.com"


def test_list_posts_orders_newest_first(isolated_db):
    for i in range(3):
        _insert(content=f"post {i}")

    posts = database.list_posts()
    assert [p["content"] for p in posts] == ["post 2", "post 1", "post 0"]


def test_list_posts_respects_limit_and_offset(isolated_db):
    for i in range(5):
        _insert(content=f"post {i}")

    page = database.list_posts(limit=2, offset=1)
    assert [p["content"] for p in page] == ["post 3", "post 2"]


def test_connection_is_closed_after_use(isolated_db):
    with database.get_connection() as conn:
        conn.execute("SELECT 1")

    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")
