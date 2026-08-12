from datetime import datetime
from unittest.mock import patch

from models import Deadline, ExtractionResult, GeneratedEmail

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
