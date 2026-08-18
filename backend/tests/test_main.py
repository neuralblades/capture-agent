from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from models import Deadline, ExtractionResult, FieldMapping, GeneratedEmail, MatchResult

FAKE_RESULT = ExtractionResult(
    summary="Team asks for feedback on the new design by Friday.",
    tags=["design", "feedback"],
    action_required=True,
    deadlines=[Deadline(text="by Friday", iso_date="2026-08-14", confidence=0.9)],
    is_opportunity=False,
)

FAKE_JOB_RESULT = ExtractionResult(
    summary="Startup is hiring a founding engineer; apply via the linked form.",
    tags=["hiring"],
    action_required=True,
    deadlines=[],
    external_url="https://forms.gle/abc123",
    contact_email="jane@acme.com",
    action_type="job_form",
    is_opportunity=True,
)


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_capture_persists_and_returns_extraction(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        resp = client.post(
            "/capture",
            json={
                "platform": "linkedin",
                "author": "Jane Doe",
                "content": "Please review the new design and send feedback by Friday!",
                "url": "https://linkedin.com/post/123",
            },
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == 1
    assert body["summary"] == FAKE_RESULT.summary
    assert body["tags"] == ["design", "feedback"]
    assert body["action_required"] is True
    assert body["deadlines"][0]["iso_date"] == "2026-08-14"
    assert body["external_url"] is None
    assert body["contact_email"] is None
    assert body["action_type"] == "none"
    assert body["match_score"] is None
    assert body["is_opportunity"] is False
    assert body["posted_at"] is None
    assert body["status"] is None
    assert body["notes"] is None
    assert body["resurface_at"] is None
    assert body["image_url"] is None


def test_capture_persists_and_returns_image_url(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        resp = client.post(
            "/capture",
            json={
                "platform": "twitter",
                "content": "Check out this photo",
                "image_url": "https://pbs.twimg.com/media/abc123.jpg",
            },
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["image_url"] == "https://pbs.twimg.com/media/abc123.jpg"

    get_resp = client.get(f"/posts/{body['id']}")
    assert get_resp.json()["image_url"] == "https://pbs.twimg.com/media/abc123.jpg"


def test_capture_returns_and_persists_external_url_and_contact_email(client):
    with patch("main.extract_post_data", return_value=FAKE_JOB_RESULT):
        resp = client.post(
            "/capture",
            json={
                "platform": "twitter",
                "content": "We're hiring! Apply here or email jane@acme.com",
            },
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["external_url"] == "https://forms.gle/abc123"
    assert body["contact_email"] == "jane@acme.com"
    assert body["action_type"] == "job_form"
    assert body["is_opportunity"] is True

    get_resp = client.get(f"/posts/{body['id']}")
    assert get_resp.status_code == 200
    stored = get_resp.json()
    assert stored["external_url"] == "https://forms.gle/abc123"
    assert stored["contact_email"] == "jane@acme.com"
    assert stored["action_type"] == "job_form"
    assert stored["is_opportunity"] is True


def test_capture_tags_web_selection_platform(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        resp = client.post(
            "/capture",
            json={
                "platform": "web_selection",
                "content": "Some highlighted text captured via the right-click menu.",
                "url": "https://example.com/article",
            },
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["platform"] == "web_selection"
    assert body["author"] is None

    get_resp = client.get(f"/posts/{body['id']}")
    assert get_resp.json()["platform"] == "web_selection"


def test_capture_web_selection_different_content_same_url_creates_separate_posts(client):
    # web_selection's url is the page the text was highlighted on, not
    # anything tied to the selection itself, so two different quotes pulled
    # from the same page must not collide on the url-based dedupe check the
    # way two captures of the same tweet/LinkedIn post correctly do.
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        first = client.post(
            "/capture",
            json={"platform": "web_selection", "content": "quote A", "url": "https://example.com/article"},
        )
        second = client.post(
            "/capture",
            json={"platform": "web_selection", "content": "quote B", "url": "https://example.com/article"},
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] != second.json()["id"]
    assert len(client.get("/posts").json()) == 2


def test_capture_web_selection_same_content_and_url_dedupes(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT) as mock_extract:
        first = client.post(
            "/capture",
            json={"platform": "web_selection", "content": "quote A", "url": "https://example.com/article"},
        )
        second = client.post(
            "/capture",
            json={"platform": "web_selection", "content": "quote A", "url": "https://example.com/article"},
        )

    assert first.json()["id"] == second.json()["id"]
    mock_extract.assert_called_once()
    assert len(client.get("/posts").json()) == 1


def test_capture_defaults_captured_at_when_omitted(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT) as mock_extract:
        resp = client.post(
            "/capture",
            json={"platform": "twitter", "content": "No timestamp provided."},
        )

    assert resp.status_code == 200
    called_captured_at = mock_extract.call_args.args[1]
    assert isinstance(called_captured_at, datetime)
    assert called_captured_at.tzinfo is not None


def test_capture_persists_and_returns_posted_at(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        resp = client.post(
            "/capture",
            json={
                "platform": "linkedin",
                "content": "content here",
                "posted_at": "2026-08-10T09:00:00+00:00",
            },
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["posted_at"] == "2026-08-10T09:00:00+00:00"

    stored = client.get(f"/posts/{body['id']}").json()
    assert stored["posted_at"] == "2026-08-10T09:00:00+00:00"


def test_capture_posted_at_defaults_to_none_when_omitted(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        resp = client.post("/capture", json={"platform": "twitter", "content": "no posted_at here"})

    assert resp.status_code == 200
    assert resp.json()["posted_at"] is None


def test_capture_returns_502_on_extraction_failure(client):
    with patch("main.extract_post_data", side_effect=RuntimeError("boom")):
        resp = client.post(
            "/capture",
            json={"platform": "twitter", "content": "will fail"},
        )

    assert resp.status_code == 502
    assert "boom" in resp.json()["detail"]


def test_list_and_get_posts_round_trip(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        create_resp = client.post(
            "/capture", json={"platform": "linkedin", "content": "content here"}
        )
    post_id = create_resp.json()["id"]

    list_resp = client.get("/posts")
    assert list_resp.status_code == 200
    assert len(list_resp.json()) == 1

    get_resp = client.get(f"/posts/{post_id}")
    assert get_resp.status_code == 200
    assert get_resp.json()["id"] == post_id


def test_get_missing_post_returns_404(client):
    resp = client.get("/posts/999")
    assert resp.status_code == 404


def test_capture_same_url_twice_returns_existing_post_without_reextracting(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT) as mock_extract:
        first = client.post(
            "/capture",
            json={"platform": "twitter", "content": "original text", "url": "https://x.com/a/status/1"},
        )
        second = client.post(
            "/capture",
            json={"platform": "twitter", "content": "original text", "url": "https://x.com/a/status/1"},
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    mock_extract.assert_called_once()

    assert len(client.get("/posts").json()) == 1


def test_capture_without_url_does_not_dedupe(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        first = client.post("/capture", json={"platform": "twitter", "content": "no url here"})
        second = client.post("/capture", json={"platform": "twitter", "content": "no url here"})

    assert first.json()["id"] != second.json()["id"]
    assert len(client.get("/posts").json()) == 2


def test_update_post_sets_status(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        create_resp = client.post("/capture", json={"platform": "twitter", "content": "content"})
    post_id = create_resp.json()["id"]

    resp = client.patch(f"/posts/{post_id}", json={"status": "applied"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "applied"
    assert resp.json()["notes"] is None
    assert resp.json()["resurface_at"] is None

    assert client.get(f"/posts/{post_id}").json()["status"] == "applied"


def test_update_post_accepts_any_subset_of_fields(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        create_resp = client.post("/capture", json={"platform": "twitter", "content": "content"})
    post_id = create_resp.json()["id"]

    resp = client.patch(
        f"/posts/{post_id}",
        json={"notes": "Looks promising", "resurface_at": "2026-09-01T00:00:00+00:00"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["notes"] == "Looks promising"
    assert body["resurface_at"] == "2026-09-01T00:00:00+00:00"
    assert body["status"] is None


def test_update_post_leaves_omitted_fields_untouched(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        create_resp = client.post("/capture", json={"platform": "twitter", "content": "content"})
    post_id = create_resp.json()["id"]

    client.patch(f"/posts/{post_id}", json={"status": "applied", "notes": "first note"})
    resp = client.patch(f"/posts/{post_id}", json={"status": "withdrawn"})

    assert resp.status_code == 200
    assert resp.json()["status"] == "withdrawn"
    assert resp.json()["notes"] == "first note"


def test_update_post_can_explicitly_clear_a_field(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        create_resp = client.post("/capture", json={"platform": "twitter", "content": "content"})
    post_id = create_resp.json()["id"]

    client.patch(f"/posts/{post_id}", json={"status": "applied"})
    resp = client.patch(f"/posts/{post_id}", json={"status": None})

    assert resp.status_code == 200
    assert resp.json()["status"] is None


def test_update_post_returns_404_for_missing_post(client):
    resp = client.patch("/posts/999", json={"status": "applied"})
    assert resp.status_code == 404


def test_delete_post_removes_it(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        create_resp = client.post("/capture", json={"platform": "twitter", "content": "to be dismissed"})
    post_id = create_resp.json()["id"]

    delete_resp = client.delete(f"/posts/{post_id}")
    assert delete_resp.status_code == 204

    assert client.get(f"/posts/{post_id}").status_code == 404
    assert client.get("/posts").json() == []


def test_delete_missing_post_returns_404(client):
    resp = client.delete("/posts/999")
    assert resp.status_code == 404


def test_capture_detects_contact_email_in_content(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        resp = client.post(
            "/capture",
            json={
                "platform": "linkedin",
                "content": "Reach out to jane@example.com if you're interested.",
            },
        )

    assert resp.status_code == 200
    assert resp.json()["contact_email"] == "jane@example.com"


def test_capture_contact_email_is_null_when_absent(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        resp = client.post("/capture", json={"platform": "linkedin", "content": "No email here."})

    assert resp.status_code == 200
    assert resp.json()["contact_email"] is None


FAKE_EMAIL = GeneratedEmail(subject="Loved your post", body="Hi Jane, ...")


def test_generate_email_from_post_id(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        create_resp = client.post(
            "/capture",
            json={"platform": "linkedin", "content": "We're hiring a designer, email jane@example.com"},
        )
    post_id = create_resp.json()["id"]

    with patch("main.generate_cold_email", return_value=FAKE_EMAIL) as mock_generate:
        resp = client.post(
            "/generate-email",
            json={"post_id": post_id, "recipient_email": "jane@example.com"},
        )

    assert resp.status_code == 200
    assert resp.json() == {"subject": "Loved your post", "body": "Hi Jane, ..."}
    _, kwargs = mock_generate.call_args
    assert "hiring a designer" in kwargs["content"]
    assert kwargs["recipient_email"] == "jane@example.com"


def test_generate_email_from_raw_content(client):
    with patch("main.generate_cold_email", return_value=FAKE_EMAIL) as mock_generate:
        resp = client.post(
            "/generate-email",
            json={"content": "Some captured post text", "recipient_email": "jane@example.com"},
        )

    assert resp.status_code == 200
    kwargs = mock_generate.call_args.kwargs
    assert kwargs["content"] == "Some captured post text"


def test_generate_email_requires_post_id_or_content(client):
    resp = client.post("/generate-email", json={"recipient_email": "jane@example.com"})
    assert resp.status_code == 422


def test_generate_email_returns_404_for_missing_post(client):
    resp = client.post("/generate-email", json={"post_id": 999, "recipient_email": "jane@example.com"})
    assert resp.status_code == 404


def test_generate_email_returns_502_on_generation_failure(client):
    with patch("main.generate_cold_email", side_effect=RuntimeError("groq down")):
        resp = client.post(
            "/generate-email",
            json={"content": "post text", "recipient_email": "jane@example.com"},
        )

    assert resp.status_code == 502
    assert "groq down" in resp.json()["detail"]


def test_generate_form_answer_returns_answer(client):
    with patch("main.generate_form_answer", return_value="I'm excited to apply because...") as mock_generate:
        resp = client.post(
            "/generate-form-answer",
            json={
                "question": "Why do you want to join?",
                "profile": {"full_name": "Jane Doe", "email": "jane@example.com"},
            },
        )

    assert resp.status_code == 200
    assert resp.json() == {"answer": "I'm excited to apply because..."}
    args, _ = mock_generate.call_args
    assert args[0] == "Why do you want to join?"
    assert args[1].full_name == "Jane Doe"


def test_generate_form_answer_defaults_profile_when_omitted(client):
    with patch("main.generate_form_answer", return_value="answer") as mock_generate:
        resp = client.post("/generate-form-answer", json={"question": "Why?"})

    assert resp.status_code == 200
    args, _ = mock_generate.call_args
    assert args[1].full_name is None


def test_generate_form_answer_returns_502_on_failure(client):
    with patch("main.generate_form_answer", side_effect=RuntimeError("boom")):
        resp = client.post("/generate-form-answer", json={"question": "Why?"})

    assert resp.status_code == 502
    assert "boom" in resp.json()["detail"]


FAKE_MATCH_RESULT = MatchResult(match_score=85, matching_skills=["Python", "FastAPI"], missing_skills=["Docker"])


def test_calculate_match_returns_score_and_persists_it(client):
    with patch("main.extract_post_data", return_value=FAKE_JOB_RESULT):
        create_resp = client.post(
            "/capture",
            json={"platform": "twitter", "content": "We're hiring a Python + FastAPI + Docker engineer"},
        )
    post_id = create_resp.json()["id"]

    with patch("main.calculate_match_score", return_value=FAKE_MATCH_RESULT) as mock_calculate:
        resp = client.post(
            "/calculate-match",
            json={"post_id": post_id, "resume_text": "Experienced Python and FastAPI developer"},
        )

    assert resp.status_code == 200
    assert resp.json() == {
        "match_score": 85,
        "matching_skills": ["Python", "FastAPI"],
        "missing_skills": ["Docker"],
    }
    args, _ = mock_calculate.call_args
    assert "Python + FastAPI + Docker" in args[0]
    assert args[1] == "Experienced Python and FastAPI developer"

    stored = client.get(f"/posts/{post_id}").json()
    assert stored["match_score"] == 85


def test_calculate_match_returns_404_for_missing_post(client):
    resp = client.post("/calculate-match", json={"post_id": 999, "resume_text": "resume"})
    assert resp.status_code == 404


def test_calculate_match_requires_non_empty_resume_text(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        create_resp = client.post("/capture", json={"platform": "twitter", "content": "content"})
    post_id = create_resp.json()["id"]

    resp = client.post("/calculate-match", json={"post_id": post_id, "resume_text": ""})
    assert resp.status_code == 422


def test_calculate_match_returns_502_on_failure(client):
    with patch("main.extract_post_data", return_value=FAKE_JOB_RESULT):
        create_resp = client.post("/capture", json={"platform": "twitter", "content": "content"})
    post_id = create_resp.json()["id"]

    with patch("main.calculate_match_score", side_effect=RuntimeError("groq down")):
        resp = client.post("/calculate-match", json={"post_id": post_id, "resume_text": "resume"})

    assert resp.status_code == 502
    assert "groq down" in resp.json()["detail"]


def test_calculate_match_returns_400_for_non_opportunity_post(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        create_resp = client.post("/capture", json={"platform": "twitter", "content": "a book recommendation"})
    post_id = create_resp.json()["id"]

    with patch("main.calculate_match_score") as mock_calculate:
        resp = client.post("/calculate-match", json={"post_id": post_id, "resume_text": "resume"})

    assert resp.status_code == 400
    mock_calculate.assert_not_called()

    stored = client.get(f"/posts/{post_id}").json()
    assert stored["match_score"] is None


def test_capture_persists_and_returns_category(client):
    result = FAKE_RESULT.model_copy(update={"category": "AI Tools"})
    with patch("main.extract_post_data", return_value=result):
        resp = client.post("/capture", json={"platform": "twitter", "content": "some AI tool"})

    assert resp.status_code == 200
    assert resp.json()["category"] == "AI Tools"


def test_categories_empty_when_no_posts(client):
    resp = client.get("/categories")
    assert resp.status_code == 200
    assert resp.json() == [{"name": "All", "count": 0}]


def test_applied_count_empty_db_returns_zero(client):
    resp = client.get("/stats/applied-count")
    assert resp.status_code == 200
    assert resp.json() == {"count": 0}


def test_applied_count_reflects_whole_table_not_just_one_page(client):
    with patch("main.extract_post_data", return_value=FAKE_JOB_RESULT):
        for i in range(55):
            client.post("/capture", json={"platform": "twitter", "content": f"opportunity {i}"})

    oldest_post_id = client.get("/posts", params={"limit": 1, "offset": 54}).json()[0]["id"]
    client.patch(f"/posts/{oldest_post_id}", json={"status": "applied"})

    # Default GET /posts page (limit=50) wouldn't include the oldest post.
    assert oldest_post_id not in [p["id"] for p in client.get("/posts").json()]

    resp = client.get("/stats/applied-count")
    assert resp.status_code == 200
    assert resp.json() == {"count": 1}


def test_applied_count_rejects_invalid_window(client):
    resp = client.get("/stats/applied-count", params={"window": "last_month"})
    assert resp.status_code == 422


def test_applied_count_with_window_scopes_to_captures_in_that_window(client):
    with patch("main.extract_post_data", return_value=FAKE_JOB_RESULT):
        resp = client.post("/capture", json={"platform": "twitter", "content": "opportunity today"})
    post_id = resp.json()["id"]
    client.patch(f"/posts/{post_id}", json={"status": "applied"})

    resp = client.get("/stats/applied-count", params={"window": "today"})
    assert resp.status_code == 200
    assert resp.json() == {"count": 1}

    resp = client.get("/stats/applied-count", params={"window": "yesterday"})
    assert resp.status_code == 200
    assert resp.json() == {"count": 0}


def test_captures_count_empty_db_returns_zero(client):
    resp = client.get("/stats/captures-count")
    assert resp.status_code == 200
    assert resp.json() == {"count": 0}


def test_captures_count_counts_only_opportunities_all_time(client):
    with patch("main.extract_post_data", return_value=FAKE_JOB_RESULT):
        client.post("/capture", json={"platform": "twitter", "content": "job 1"})
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        client.post("/capture", json={"platform": "twitter", "content": "non-opportunity"})

    resp = client.get("/stats/captures-count")
    assert resp.status_code == 200
    assert resp.json() == {"count": 1}


def test_captures_count_with_window_scopes_to_today(client):
    with patch("main.extract_post_data", return_value=FAKE_JOB_RESULT):
        client.post("/capture", json={"platform": "twitter", "content": "job today"})

    resp = client.get("/stats/captures-count", params={"window": "today"})
    assert resp.status_code == 200
    assert resp.json() == {"count": 1}

    resp = client.get("/stats/captures-count", params={"window": "yesterday"})
    assert resp.status_code == 200
    assert resp.json() == {"count": 0}


def test_posts_with_window_filters_to_captures_in_that_window(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        resp = client.post("/capture", json={"platform": "twitter", "content": "today's post"})
    today_id = resp.json()["id"]

    old_captured_at = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        client.post(
            "/capture",
            json={"platform": "twitter", "content": "old post", "captured_at": old_captured_at},
        )

    resp = client.get("/posts", params={"window": "today"})
    assert resp.status_code == 200
    ids = [p["id"] for p in resp.json()]
    assert ids == [today_id]


def test_posts_rejects_invalid_window(client):
    resp = client.get("/posts", params={"window": "last_month"})
    assert resp.status_code == 422


def test_categories_aggregates_across_posts(client):
    ai_result = FAKE_RESULT.model_copy(update={"category": "AI Tools"})
    finance_result = FAKE_RESULT.model_copy(update={"category": "Finance"})

    with patch("main.extract_post_data", return_value=ai_result):
        client.post("/capture", json={"platform": "twitter", "content": "post 1"})
        client.post("/capture", json={"platform": "twitter", "content": "post 2"})
    with patch("main.extract_post_data", return_value=finance_result):
        client.post("/capture", json={"platform": "twitter", "content": "post 3"})

    resp = client.get("/categories")
    assert resp.status_code == 200
    body = resp.json()
    assert body[0] == {"name": "All", "count": 3}
    assert {"name": "AI Tools", "count": 2} in body
    assert {"name": "Finance", "count": 1} in body


def test_stats_overview_empty_db(client):
    resp = client.get("/stats/overview")
    assert resp.status_code == 200
    body = resp.json()
    assert body["platform_counts"] == [{"name": "All", "count": 0}]
    assert body["category_counts"] == [{"name": "All", "count": 0}]
    assert body["window_days"] == 30
    assert body["bucket"] == "day"
    assert len(body["trend"]) == 30
    assert sum(b["count"] for b in body["trend"]) == 0


def test_stats_overview_platform_and_category_counts_match_underlying_posts(client):
    ai_result = FAKE_RESULT.model_copy(update={"category": "AI Tools"})
    finance_result = FAKE_RESULT.model_copy(update={"category": "Finance"})

    with patch("main.extract_post_data", return_value=ai_result):
        client.post("/capture", json={"platform": "twitter", "content": "post 1"})
        client.post("/capture", json={"platform": "twitter", "content": "post 2"})
    with patch("main.extract_post_data", return_value=finance_result):
        client.post("/capture", json={"platform": "linkedin", "content": "post 3"})

    resp = client.get("/stats/overview")
    assert resp.status_code == 200
    body = resp.json()

    assert body["platform_counts"][0] == {"name": "All", "count": 3}
    assert {"name": "twitter", "count": 2} in body["platform_counts"]
    assert {"name": "linkedin", "count": 1} in body["platform_counts"]

    assert body["category_counts"][0] == {"name": "All", "count": 3}
    assert {"name": "AI Tools", "count": 2} in body["category_counts"]
    assert {"name": "Finance", "count": 1} in body["category_counts"]

    # Spot-check against the plain listing endpoints the card list/tabs use.
    posts = client.get("/posts").json()
    assert len(posts) == body["platform_counts"][0]["count"]
    categories = client.get("/categories").json()
    assert categories == body["category_counts"]


def test_stats_overview_respects_days_and_bucket_query_params(client):
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        client.post("/capture", json={"platform": "twitter", "content": "post 1"})

    resp = client.get("/stats/overview", params={"days": 7, "bucket": "week"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["window_days"] == 7
    assert body["bucket"] == "week"
    assert sum(b["count"] for b in body["trend"]) == 1


def test_stats_overview_rejects_invalid_bucket(client):
    resp = client.get("/stats/overview", params={"bucket": "month"})
    assert resp.status_code == 422


def test_stats_overview_rejects_non_positive_days(client):
    resp = client.get("/stats/overview", params={"days": 0})
    assert resp.status_code == 422


def test_map_form_fields_returns_mappings(client):
    fake_mappings = [
        FieldMapping(index=0, value="opt-yes"),
        FieldMapping(index=1, value="I'm excited about this role."),
    ]
    with patch("main.map_form_fields", return_value=fake_mappings) as mock_map:
        resp = client.post(
            "/map-form-fields",
            json={
                "fields": [
                    {
                        "index": 0,
                        "type": "radio-group",
                        "label": "Are you authorized to work?",
                        "options": [{"value": "opt-yes", "label": "Yes"}, {"value": "opt-no", "label": "No"}],
                    },
                    {"index": 1, "type": "textarea", "label": "Why do you want to join?"},
                ],
                "profile": {"full_name": "Jane Doe", "work_authorized": True},
            },
        )

    assert resp.status_code == 200
    assert resp.json() == {
        "mappings": [
            {"index": 0, "value": "opt-yes"},
            {"index": 1, "value": "I'm excited about this role."},
        ]
    }
    args, _ = mock_map.call_args
    assert args[0][0].label == "Are you authorized to work?"
    assert args[1].full_name == "Jane Doe"
    assert args[1].work_authorized is True


def test_map_form_fields_defaults_to_empty_when_omitted(client):
    with patch("main.map_form_fields", return_value=[]) as mock_map:
        resp = client.post("/map-form-fields", json={})

    assert resp.status_code == 200
    assert resp.json() == {"mappings": []}
    args, _ = mock_map.call_args
    assert args[0] == []
    assert args[1].full_name is None


def test_map_form_fields_returns_502_on_failure(client):
    with patch("main.map_form_fields", side_effect=RuntimeError("boom")):
        resp = client.post(
            "/map-form-fields",
            json={"fields": [{"index": 0, "type": "text", "label": "City"}]},
        )

    assert resp.status_code == 502
    assert "boom" in resp.json()["detail"]


VALID_FEED_PARSE = SimpleNamespace(bozo=0, version="rss20")
INVALID_FEED_PARSE = SimpleNamespace(bozo=1, version="")


def test_create_feed_validates_and_persists(client):
    with patch("main.feedparser.parse", return_value=VALID_FEED_PARSE):
        resp = client.post(
            "/feeds", json={"url": "https://blog.example.com/feed.xml", "label": "Example Blog"}
        )

    assert resp.status_code == 201
    body = resp.json()
    assert body["url"] == "https://blog.example.com/feed.xml"
    assert body["label"] == "Example Blog"
    assert body["last_checked_at"] is None
    assert body["last_seen_guid"] is None

    list_resp = client.get("/feeds")
    assert list_resp.status_code == 200
    assert len(list_resp.json()) == 1


def test_create_feed_rejects_url_that_does_not_parse_as_feed(client):
    with patch("main.feedparser.parse", return_value=INVALID_FEED_PARSE):
        resp = client.post("/feeds", json={"url": "https://example.com/not-a-feed", "label": None})

    assert resp.status_code == 400
    assert client.get("/feeds").json() == []


def test_create_feed_accepts_feed_with_bozo_but_detected_version(client):
    # A feed with minor XML issues (bozo=1) but a recognized version should
    # still be accepted -- only unparseable-as-any-feed content is rejected.
    lenient_parse = SimpleNamespace(bozo=1, version="atom10")
    with patch("main.feedparser.parse", return_value=lenient_parse):
        resp = client.post("/feeds", json={"url": "https://example.com/feed.xml", "label": None})

    assert resp.status_code == 201


def test_delete_feed_removes_it(client):
    with patch("main.feedparser.parse", return_value=VALID_FEED_PARSE):
        create_resp = client.post("/feeds", json={"url": "https://blog.example.com/feed.xml", "label": None})
    feed_id = create_resp.json()["id"]

    delete_resp = client.delete(f"/feeds/{feed_id}")
    assert delete_resp.status_code == 204
    assert client.get("/feeds").json() == []


def test_delete_missing_feed_returns_404(client):
    resp = client.delete("/feeds/999")
    assert resp.status_code == 404


def test_get_digest_html_renders_captured_posts(client):
    with patch("main.extract_post_data", return_value=FAKE_JOB_RESULT):
        client.post("/capture", json={"platform": "twitter", "content": "We're hiring!"})

    resp = client.get("/digest")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    assert FAKE_JOB_RESULT.summary in resp.text


def test_get_digest_html_handles_no_posts(client):
    resp = client.get("/digest")
    assert resp.status_code == 200
    assert "Nothing captured yet" in resp.text


def test_get_digest_pdf_returns_pdf_bytes_when_weasyprint_available(client):
    with patch("main.extract_post_data", return_value=FAKE_JOB_RESULT):
        client.post("/capture", json={"platform": "twitter", "content": "We're hiring!"})

    with patch("main.digest.render_digest_pdf", return_value=b"%PDF-fake-bytes"):
        resp = client.get("/digest.pdf")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.content == b"%PDF-fake-bytes"


def test_get_digest_pdf_returns_501_when_weasyprint_unavailable(client):
    with patch("main.digest.render_digest_pdf", side_effect=OSError("cannot load library 'libgobject-2.0-0'")):
        resp = client.get("/digest.pdf")

    assert resp.status_code == 501
    assert "WeasyPrint" in resp.json()["detail"]


def test_list_feeds_empty_when_none_added(client):
    resp = client.get("/feeds")
    assert resp.status_code == 200
    assert resp.json() == []
