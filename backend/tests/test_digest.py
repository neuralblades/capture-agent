from datetime import datetime, timedelta, timezone

import digest

NOW = datetime(2026, 8, 18, 12, 0, tzinfo=timezone.utc)


def make_post(**overrides):
    post = {
        "id": 1,
        "platform": "twitter",
        "author": "Jane",
        "content": "Some captured content that is long enough to need an excerpt eventually maybe.",
        "summary": "A summary",
        "category": "General",
        "is_opportunity": False,
        "match_score": None,
        "deadlines": [],
        "posted_at": None,
        "captured_at": NOW.isoformat(),
        "image_url": None,
    }
    post.update(overrides)
    return post


def test_recency_component_decays_by_half_life():
    fresh = make_post(captured_at=NOW.isoformat())
    half_life_old = make_post(captured_at=(NOW - timedelta(hours=digest.RECENCY_HALF_LIFE_HOURS)).isoformat())

    fresh_score = digest.hotness_score(fresh, NOW)
    half_life_score = digest.hotness_score(half_life_old, NOW)

    assert fresh_score == digest.RECENCY_WEIGHT
    assert half_life_score == digest.RECENCY_WEIGHT * 0.5


def test_match_component_only_applies_to_opportunities():
    scored_opportunity = make_post(is_opportunity=True, match_score=80, captured_at=None)
    scored_non_opportunity = make_post(is_opportunity=False, match_score=80, captured_at=None)

    assert digest.hotness_score(scored_opportunity, NOW) == digest.MATCH_WEIGHT * 0.8
    assert digest.hotness_score(scored_non_opportunity, NOW) == 0.0


def test_deadline_component_peaks_now_and_decays_to_zero_at_horizon():
    # iso_date carries date-only granularity (see models.Deadline), which
    # fromisoformat parses as midnight -- anchor "now" to midnight here too
    # so "0 days until" is exactly representable.
    midnight = NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    due_now = make_post(captured_at=None, deadlines=[{"text": "today", "iso_date": midnight.date().isoformat(), "confidence": 0.9}])
    at_horizon = make_post(
        captured_at=None,
        deadlines=[
            {
                "text": "in two weeks",
                "iso_date": (midnight + timedelta(days=digest.DEADLINE_HORIZON_DAYS)).date().isoformat(),
                "confidence": 0.9,
            }
        ],
    )
    passed = make_post(
        captured_at=None,
        deadlines=[{"text": "last week", "iso_date": (midnight - timedelta(days=7)).date().isoformat(), "confidence": 0.9}],
    )

    assert digest.hotness_score(due_now, midnight) == digest.DEADLINE_WEIGHT
    assert digest.hotness_score(at_horizon, midnight) == 0.0
    assert digest.hotness_score(passed, midnight) == 0.0


def test_earliest_deadline_picked_when_multiple_present():
    post = make_post(
        captured_at=None,
        deadlines=[
            {"text": "later", "iso_date": (NOW + timedelta(days=10)).date().isoformat(), "confidence": 0.9},
            {"text": "sooner", "iso_date": (NOW + timedelta(days=1)).date().isoformat(), "confidence": 0.9},
            {"text": "unresolved", "iso_date": None, "confidence": 0.2},
        ],
    )
    earliest = digest._earliest_deadline(post)
    assert earliest["text"] == "sooner"


def test_rank_posts_orders_by_hotness_desc_and_ties_by_id_desc():
    stale = make_post(id=1, captured_at=(NOW - timedelta(days=30)).isoformat())
    fresh = make_post(id=2, captured_at=NOW.isoformat())
    tie_a = make_post(id=3, captured_at=None)
    tie_b = make_post(id=4, captured_at=None)

    ranked = digest.rank_posts([stale, fresh, tie_a, tie_b], NOW)
    ranked_ids = [p["id"] for p in ranked]

    assert ranked_ids[0] == 2  # fresh, most recent, ranks first
    assert ranked_ids[1] == 1  # stale but still has some recency signal
    assert ranked_ids[2:] == [4, 3]  # zero-signal ties broken by id desc


def test_build_digest_splits_front_page_and_chunks_inside_pages():
    posts = [make_post(id=i, captured_at=(NOW - timedelta(hours=i)).isoformat()) for i in range(1, 26)]
    result = digest.build_digest(posts, now=NOW, front_page_size=5)

    assert len(result["front_page"]) == 5
    inside_ids = [p["id"] for chunk in result["inside_page_chunks"] for p in chunk]
    assert len(inside_ids) == 20
    assert [len(chunk) for chunk in result["inside_page_chunks"]] == [10, 10]


def test_safe_image_url_rejects_non_http_schemes():
    assert digest._safe_image_url("https://example.com/a.jpg") == "https://example.com/a.jpg"
    assert digest._safe_image_url("javascript:alert(1)") is None
    assert digest._safe_image_url(None) is None
    assert digest._safe_image_url(123) is None


def test_render_digest_html_renders_hero_for_item_with_image():
    post = make_post(id=1, image_url="https://example.com/hero.jpg", summary="Hero headline")
    html = digest.render_digest_html([post], now=NOW, front_page_size=5)

    assert 'class="hero"' in html
    assert '<img src="https://example.com/hero.jpg"' in html
    assert "Hero headline" in html


def test_render_digest_html_renders_text_only_for_item_without_image_even_on_front_page():
    post = make_post(id=1, image_url=None, summary="Text only headline")
    html = digest.render_digest_html([post], now=NOW, front_page_size=5)

    assert 'class="hero"' not in html
    assert "<img" not in html
    assert "Text only headline" in html


def test_render_digest_html_handles_no_posts():
    html = digest.render_digest_html([], now=NOW)
    assert "Nothing captured yet" in html
    assert "<img" not in html
