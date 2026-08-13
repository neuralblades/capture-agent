from datetime import datetime
from unittest.mock import patch

from models import Deadline, ExtractionResult, FieldMapping, GeneratedEmail, MatchResult

FAKE_RESULT = ExtractionResult(
    summary="Team asks for feedback on the new design by Friday.",
    tags=["design", "feedback"],
    action_required=True,
    deadlines=[Deadline(text="by Friday", iso_date="2026-08-14", confidence=0.9)],
)

FAKE_JOB_RESULT = ExtractionResult(
    summary="Startup is hiring a founding engineer; apply via the linked form.",
    tags=["hiring"],
    action_required=True,
    deadlines=[],
    external_url="https://forms.gle/abc123",
    contact_email="jane@acme.com",
    action_type="job_form",
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

    get_resp = client.get(f"/posts/{body['id']}")
    assert get_resp.status_code == 200
    stored = get_resp.json()
    assert stored["external_url"] == "https://forms.gle/abc123"
    assert stored["contact_email"] == "jane@acme.com"
    assert stored["action_type"] == "job_form"


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
    with patch("main.extract_post_data", return_value=FAKE_RESULT):
        create_resp = client.post("/capture", json={"platform": "twitter", "content": "content"})
    post_id = create_resp.json()["id"]

    with patch("main.calculate_match_score", side_effect=RuntimeError("groq down")):
        resp = client.post("/calculate-match", json={"post_id": post_id, "resume_text": "resume"})

    assert resp.status_code == 502
    assert "groq down" in resp.json()["detail"]


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
