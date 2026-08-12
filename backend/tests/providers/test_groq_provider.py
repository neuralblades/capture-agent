import json
from unittest.mock import MagicMock, patch

import pytest

from models import ExtractionResult, ProfileContext
from providers.groq_provider import GroqProvider


def _fake_response(content=None, finish_reason="stop"):
    message = MagicMock()
    message.content = content
    choice = MagicMock()
    choice.message = message
    choice.finish_reason = finish_reason
    resp = MagicMock()
    resp.choices = [choice]
    return resp


def test_extract_parses_json_content_into_extraction_result():
    payload = {
        "summary": "s",
        "tags": ["t"],
        "action_required": False,
        "deadlines": [{"text": "tomorrow", "iso_date": "2026-08-13", "confidence": 0.8}],
    }
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_response(content=json.dumps(payload))
    provider = GroqProvider()

    with patch.object(provider, "get_client", return_value=fake_client):
        result = provider.extract("some content", "2026-08-12")

    assert result == ExtractionResult(**payload)
    _, kwargs = fake_client.chat.completions.create.call_args
    assert kwargs["model"] == "llama-3.3-70b-versatile"
    assert kwargs["response_format"] == {"type": "json_object"}
    assert "2026-08-12" in kwargs["messages"][0]["content"]
    assert kwargs["messages"][1]["content"] == "some content"


def test_extract_raises_on_content_filter():
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_response(finish_reason="content_filter")
    provider = GroqProvider()

    with patch.object(provider, "get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="declined"):
            provider.extract("some content", "2026-08-12")


def test_extract_raises_when_content_missing():
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_response(content=None)
    provider = GroqProvider()

    with patch.object(provider, "get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="parseable"):
            provider.extract("some content", "2026-08-12")


def test_extract_raises_on_invalid_json():
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_response(content="not json")
    provider = GroqProvider()

    with patch.object(provider, "get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="parseable"):
            provider.extract("some content", "2026-08-12")


def test_extract_raises_when_json_does_not_match_schema():
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_response(content=json.dumps({"foo": "bar"}))
    provider = GroqProvider()

    with patch.object(provider, "get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="parseable"):
            provider.extract("some content", "2026-08-12")


def test_generate_form_answer_returns_text_and_includes_profile():
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_response(content="I'd love to join because...")
    provider = GroqProvider()
    profile = ProfileContext(full_name="Jane Doe", email="jane@example.com")

    with patch.object(provider, "get_client", return_value=fake_client):
        answer = provider.generate_form_answer("Why do you want to join?", profile)

    assert answer == "I'd love to join because..."
    _, kwargs = fake_client.chat.completions.create.call_args
    assert kwargs["model"] == "llama-3.3-70b-versatile"
    assert "Jane Doe" in kwargs["messages"][0]["content"]
    assert kwargs["messages"][1]["content"] == "Why do you want to join?"


def test_generate_form_answer_raises_on_content_filter():
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_response(finish_reason="content_filter")
    provider = GroqProvider()

    with patch.object(provider, "get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="declined"):
            provider.generate_form_answer("Why?", ProfileContext())


def test_generate_form_answer_raises_when_content_missing():
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_response(content=None)
    provider = GroqProvider()

    with patch.object(provider, "get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="did not return"):
            provider.generate_form_answer("Why?", ProfileContext())


def test_get_client_is_lazily_constructed_and_cached(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    provider = GroqProvider()
    assert provider._client is None

    client = provider.get_client()

    assert provider._client is client
    assert provider.get_client() is client
