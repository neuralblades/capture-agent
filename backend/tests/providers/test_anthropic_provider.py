from unittest.mock import MagicMock, patch

import pytest

from models import Deadline, ExtractionResult, ProfileContext
from providers.anthropic_provider import AnthropicProvider


def _fake_response(parsed_output=None, stop_reason="end_turn"):
    resp = MagicMock()
    resp.parsed_output = parsed_output
    resp.stop_reason = stop_reason
    return resp


def _fake_message_response(text=None, stop_reason="end_turn"):
    resp = MagicMock()
    resp.stop_reason = stop_reason
    if text is None:
        resp.content = []
    else:
        block = MagicMock()
        block.type = "text"
        block.text = text
        resp.content = [block]
    return resp


def test_extract_returns_parsed_output_and_passes_reference_date():
    expected = ExtractionResult(
        summary="s",
        tags=["t"],
        action_required=False,
        deadlines=[Deadline(text="tomorrow", iso_date="2026-08-13", confidence=0.8)],
    )
    fake_client = MagicMock()
    fake_client.messages.parse.return_value = _fake_response(parsed_output=expected)
    provider = AnthropicProvider()

    with patch.object(provider, "get_client", return_value=fake_client):
        result = provider.extract("some content", "2026-08-12")

    assert result == expected
    _, kwargs = fake_client.messages.parse.call_args
    assert kwargs["model"] == "claude-opus-5"
    assert "2026-08-12" in kwargs["system"]
    assert kwargs["output_format"] is ExtractionResult


def test_extract_raises_on_refusal():
    fake_client = MagicMock()
    fake_client.messages.parse.return_value = _fake_response(stop_reason="refusal")
    provider = AnthropicProvider()

    with patch.object(provider, "get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="declined"):
            provider.extract("some content", "2026-08-12")


def test_extract_raises_when_unparsed():
    fake_client = MagicMock()
    fake_client.messages.parse.return_value = _fake_response(parsed_output=None)
    provider = AnthropicProvider()

    with patch.object(provider, "get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="parseable"):
            provider.extract("some content", "2026-08-12")


def test_generate_form_answer_returns_text_and_includes_profile():
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _fake_message_response(text="I'd love to join because...")
    provider = AnthropicProvider()
    profile = ProfileContext(full_name="Jane Doe", email="jane@example.com")

    with patch.object(provider, "get_client", return_value=fake_client):
        answer = provider.generate_form_answer("Why do you want to join?", profile)

    assert answer == "I'd love to join because..."
    _, kwargs = fake_client.messages.create.call_args
    assert kwargs["model"] == "claude-opus-5"
    assert "Jane Doe" in kwargs["system"]
    assert kwargs["messages"][0]["content"] == "Why do you want to join?"


def test_generate_form_answer_raises_on_refusal():
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _fake_message_response(text="x", stop_reason="refusal")
    provider = AnthropicProvider()

    with patch.object(provider, "get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="declined"):
            provider.generate_form_answer("Why?", ProfileContext())


def test_generate_form_answer_raises_when_empty():
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _fake_message_response(text=None)
    provider = AnthropicProvider()

    with patch.object(provider, "get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="did not return"):
            provider.generate_form_answer("Why?", ProfileContext())


def test_get_client_is_lazily_constructed_and_cached(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    provider = AnthropicProvider()
    assert provider._client is None

    client = provider.get_client()

    assert provider._client is client
    assert provider.get_client() is client
