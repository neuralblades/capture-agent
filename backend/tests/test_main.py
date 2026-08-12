from datetime import datetime
from unittest.mock import patch

from models import Deadline, ExtractionResult

FAKE_RESULT = ExtractionResult(
    summary="Team asks for feedback on the new design by Friday.",
    tags=["design", "feedback"],
    action_required=True,
    deadlines=[Deadline(text="by Friday", iso_date="2026-08-14", confidence=0.9)],
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
