import sqlite3
from datetime import datetime, timedelta, timezone

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
    assert record["match_score"] is None


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


def test_get_post_by_url_returns_most_recent_match(isolated_db):
    _insert(url="https://x.com/a/status/1", content="first capture")
    second_id = _insert(url="https://x.com/a/status/1", content="second capture")

    record = database.get_post_by_url("https://x.com/a/status/1")
    assert record is not None
    assert record["id"] == second_id
    assert record["content"] == "second capture"


def test_get_post_by_url_returns_none_when_no_match(isolated_db):
    assert database.get_post_by_url("https://x.com/nope/status/1") is None


def test_update_match_score_sets_score_and_returns_true(isolated_db):
    post_id = _insert()

    assert database.update_match_score(post_id, 85) is True
    assert database.get_post(post_id)["match_score"] == 85


def test_update_match_score_returns_false_when_missing(isolated_db):
    assert database.update_match_score(99999, 85) is False


def test_get_post_by_url_and_content_returns_most_recent_exact_match(isolated_db):
    _insert(url="https://example.com/article", content="first capture")
    second_id = _insert(url="https://example.com/article", content="first capture")

    record = database.get_post_by_url_and_content("https://example.com/article", "first capture")
    assert record is not None
    assert record["id"] == second_id


def test_get_post_by_url_and_content_does_not_match_different_content_at_same_url(isolated_db):
    _insert(url="https://example.com/article", content="quote A")

    assert database.get_post_by_url_and_content("https://example.com/article", "quote B") is None


def test_delete_post_removes_row_and_returns_true(isolated_db):
    post_id = _insert()

    assert database.delete_post(post_id) is True
    assert database.get_post(post_id) is None


def test_delete_post_returns_false_when_missing(isolated_db):
    assert database.delete_post(99999) is False


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


def test_init_db_migrates_legacy_table_missing_new_columns(tmp_path, monkeypatch):
    db_path = tmp_path / "legacy.db"
    monkeypatch.setattr(database, "DB_PATH", db_path)

    # Simulate a database created before external_url/contact_email/action_type existed.
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE posts (
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
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    conn.commit()
    conn.close()

    database.init_db()

    post_id = _insert(action_type="cold_email", contact_email="a@b.com")
    record = database.get_post(post_id)
    assert record is not None
    assert record["action_type"] == "cold_email"
    assert record["contact_email"] == "a@b.com"
    assert record["external_url"] is None
    assert record["match_score"] is None
    assert record["is_opportunity"] is False
    assert record["posted_at"] is None
    assert record["status"] is None
    assert record["notes"] is None
    assert record["resurface_at"] is None
    assert record["image_url"] is None


def test_init_db_is_idempotent_on_already_migrated_table(isolated_db):
    database.init_db()
    database.init_db()

    post_id = _insert(action_type="general_link")
    record = database.get_post(post_id)
    assert record is not None
    assert record["action_type"] == "general_link"


def test_category_defaults_to_general(isolated_db):
    post_id = _insert()
    assert database.get_post(post_id)["category"] == "General"


def test_category_round_trips(isolated_db):
    post_id = _insert(category="AI Tools")
    assert database.get_post(post_id)["category"] == "AI Tools"


def test_is_opportunity_defaults_to_false(isolated_db):
    post_id = _insert()
    assert database.get_post(post_id)["is_opportunity"] is False


def test_is_opportunity_round_trips(isolated_db):
    post_id = _insert(is_opportunity=True)
    assert database.get_post(post_id)["is_opportunity"] is True


def test_posted_at_defaults_to_none(isolated_db):
    post_id = _insert()
    assert database.get_post(post_id)["posted_at"] is None


def test_posted_at_round_trips(isolated_db):
    post_id = _insert(posted_at="2026-08-10T09:00:00+00:00")
    assert database.get_post(post_id)["posted_at"] == "2026-08-10T09:00:00+00:00"


def test_image_url_defaults_to_none(isolated_db):
    post_id = _insert()
    assert database.get_post(post_id)["image_url"] is None


def test_image_url_round_trips(isolated_db):
    post_id = _insert(image_url="https://example.com/photo.jpg")
    assert database.get_post(post_id)["image_url"] == "https://example.com/photo.jpg"


def test_status_notes_resurface_at_default_to_none(isolated_db):
    post_id = _insert()
    record = database.get_post(post_id)
    assert record["status"] is None
    assert record["notes"] is None
    assert record["resurface_at"] is None


def test_update_post_fields_sets_only_given_fields(isolated_db):
    post_id = _insert()

    assert database.update_post_fields(post_id, status="applied") is True
    record = database.get_post(post_id)
    assert record["status"] == "applied"
    assert record["notes"] is None
    assert record["resurface_at"] is None


def test_update_post_fields_updates_multiple_fields_at_once(isolated_db):
    post_id = _insert()

    database.update_post_fields(
        post_id, status="read", notes="Interesting read", resurface_at="2026-09-01T00:00:00+00:00"
    )
    record = database.get_post(post_id)
    assert record["status"] == "read"
    assert record["notes"] == "Interesting read"
    assert record["resurface_at"] == "2026-09-01T00:00:00+00:00"


def test_update_post_fields_leaves_unspecified_fields_untouched(isolated_db):
    post_id = _insert()
    database.update_post_fields(post_id, status="applied", notes="first note")

    database.update_post_fields(post_id, status="withdrawn")

    record = database.get_post(post_id)
    assert record["status"] == "withdrawn"
    assert record["notes"] == "first note"


def test_update_post_fields_can_explicitly_clear_a_field(isolated_db):
    post_id = _insert()
    database.update_post_fields(post_id, status="applied")

    database.update_post_fields(post_id, status=None)

    assert database.get_post(post_id)["status"] is None


def test_update_post_fields_with_no_fields_returns_existence(isolated_db):
    post_id = _insert()
    assert database.update_post_fields(post_id) is True
    assert database.update_post_fields(999999) is False


def test_update_post_fields_returns_false_when_missing(isolated_db):
    assert database.update_post_fields(999999, status="applied") is False


def test_count_applied_opportunities_empty_db_returns_zero(isolated_db):
    assert database.count_applied_opportunities() == 0


def test_count_applied_opportunities_counts_only_applied_opportunities(isolated_db):
    applied_opportunity = _insert(is_opportunity=True)
    database.update_post_fields(applied_opportunity, status="applied")

    unapplied_opportunity = _insert(is_opportunity=True)
    database.update_post_fields(unapplied_opportunity, status="read")

    # Not an opportunity -- must not count even though its free-text status
    # happens to also be "applied" (e.g. set via the sidepanel's plain status
    # field on a non-opportunity item).
    applied_non_opportunity = _insert(is_opportunity=False)
    database.update_post_fields(applied_non_opportunity, status="applied")

    assert database.count_applied_opportunities() == 1


def test_count_applied_opportunities_not_capped_by_list_posts_page_size(isolated_db):
    # GET /posts defaults to limit=50; this count must reflect the whole
    # table, not just whatever page happens to be loaded client-side.
    for _ in range(60):
        _insert(is_opportunity=True)
    oldest_id = 1
    database.update_post_fields(oldest_id, status="applied")

    assert database.count_applied_opportunities() == 1
    assert oldest_id not in [p["id"] for p in database.list_posts(limit=50)]


def test_category_counts_includes_all_total_and_per_category_counts(isolated_db):
    _insert(category="AI Tools")
    _insert(category="AI Tools")
    _insert(category="Finance")

    counts = database.category_counts()
    assert counts[0] == {"name": "All", "count": 3}
    assert {"name": "AI Tools", "count": 2} in counts
    assert {"name": "Finance", "count": 1} in counts


def test_category_counts_orders_by_count_desc_then_name(isolated_db):
    _insert(category="Zebra")
    _insert(category="Alpha")
    _insert(category="Alpha")

    counts = database.category_counts()
    assert [c["name"] for c in counts] == ["All", "Alpha", "Zebra"]


def test_category_counts_empty_db_returns_only_all_zero(isolated_db):
    assert database.category_counts() == [{"name": "All", "count": 0}]


def test_platform_counts_includes_all_total_and_per_platform_counts(isolated_db):
    _insert(platform="twitter")
    _insert(platform="twitter")
    _insert(platform="linkedin")

    counts = database.platform_counts()
    assert counts[0] == {"name": "All", "count": 3}
    assert {"name": "twitter", "count": 2} in counts
    assert {"name": "linkedin", "count": 1} in counts


def test_platform_counts_orders_by_count_desc_then_name(isolated_db):
    _insert(platform="web_selection")
    _insert(platform="linkedin")
    _insert(platform="linkedin")

    counts = database.platform_counts()
    assert [c["name"] for c in counts] == ["All", "linkedin", "web_selection"]


def test_platform_counts_empty_db_returns_only_all_zero(isolated_db):
    assert database.platform_counts() == [{"name": "All", "count": 0}]


def test_trend_counts_zero_fills_default_30_day_window(isolated_db):
    trend = database.trend_counts()

    assert len(trend) == 30
    assert all(b["count"] == 0 for b in trend)
    today = datetime.now(timezone.utc).date()
    assert trend[-1]["bucket"] == today.isoformat()
    assert trend[0]["bucket"] == (today - timedelta(days=29)).isoformat()


def test_trend_counts_buckets_by_captured_at_day(isolated_db):
    now = datetime.now(timezone.utc)
    _insert(captured_at=now.isoformat())
    _insert(captured_at=now.isoformat())
    _insert(captured_at=(now - timedelta(days=1)).isoformat())

    trend = database.trend_counts(days=30)
    by_bucket = {b["bucket"]: b["count"] for b in trend}
    assert by_bucket[now.date().isoformat()] == 2
    assert by_bucket[(now - timedelta(days=1)).date().isoformat()] == 1


def test_trend_counts_excludes_captures_older_than_window_no_off_by_one(isolated_db):
    now = datetime.now(timezone.utc)
    # Exactly at the boundary (today - (days-1)): must be included.
    _insert(captured_at=(now - timedelta(days=6)).isoformat())
    # One day older than the boundary: must be excluded.
    _insert(captured_at=(now - timedelta(days=7)).isoformat())

    trend = database.trend_counts(days=7)
    assert len(trend) == 7
    assert sum(b["count"] for b in trend) == 1
    assert trend[0]["bucket"] == (now.date() - timedelta(days=6)).isoformat()


def test_trend_counts_week_bucket_keys_by_monday_and_covers_window(isolated_db):
    now = datetime.now(timezone.utc)
    _insert(captured_at=now.isoformat())

    trend = database.trend_counts(days=14, bucket="week")
    for b in trend:
        bucket_date = datetime.fromisoformat(b["bucket"]).date()
        assert bucket_date.weekday() == 0  # Monday

    current_week_monday = (now.date() - timedelta(days=now.date().weekday())).isoformat()
    by_bucket = {b["bucket"]: b["count"] for b in trend}
    assert by_bucket[current_week_monday] == 1


def test_connection_is_closed_after_use(isolated_db):
    with database.get_connection() as conn:
        conn.execute("SELECT 1")

    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_add_and_list_feeds(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")
    assert feed_id == 1

    feeds = database.list_feeds()
    assert len(feeds) == 1
    assert feeds[0]["url"] == "https://blog.example.com/feed.xml"
    assert feeds[0]["label"] == "Example Blog"
    assert feeds[0]["last_checked_at"] is None
    assert feeds[0]["last_seen_guid"] is None


def test_add_feed_label_is_optional(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label=None)
    assert database.get_feed(feed_id)["label"] is None


def test_get_feed_returns_none_when_missing(isolated_db):
    assert database.get_feed(999) is None


def test_list_feeds_orders_oldest_first(isolated_db):
    database.add_feed(url="https://a.example.com/feed.xml", label="A")
    database.add_feed(url="https://b.example.com/feed.xml", label="B")

    feeds = database.list_feeds()
    assert [f["label"] for f in feeds] == ["A", "B"]


def test_delete_feed_removes_row_and_returns_true(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")

    assert database.delete_feed(feed_id) is True
    assert database.get_feed(feed_id) is None


def test_delete_feed_returns_false_when_missing(isolated_db):
    assert database.delete_feed(999) is False


def test_update_feed_poll_state_sets_last_checked_and_guid(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")

    database.update_feed_poll_state(feed_id, last_seen_guid="entry-42")

    feed = database.get_feed(feed_id)
    assert feed["last_seen_guid"] == "entry-42"
    assert feed["last_checked_at"] is not None


def test_update_feed_poll_state_accepts_none_guid(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")

    database.update_feed_poll_state(feed_id, last_seen_guid=None)

    feed = database.get_feed(feed_id)
    assert feed["last_seen_guid"] is None
    assert feed["last_checked_at"] is not None
