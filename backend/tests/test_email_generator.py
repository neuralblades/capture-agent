import json
from unittest.mock import MagicMock, patch

import pytest

import email_generator
from email_generator import generate_cold_email
from models import GeneratedEmail


def _fake_response(content=None, finish_reason="stop"):
    message = MagicMock()
    message.content = content
    choice = MagicMock()
    choice.message = message
    choice.finish_reason = finish_reason
    resp = MagicMock()
    resp.choices = [choice]
    return resp


def test_generate_cold_email_parses_response_into_generated_email():
    payload = {"subject": "Loved your post", "body": "Hi there..."}
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_response(content=json.dumps(payload))

    with patch("email_generator.get_client", return_value=fake_client):
        result = generate_cold_email(
            content="Just shipped a new feature!",
            recipient_email="jane@example.com",
            sender_name="Alex",
            sender_company="Acme",
        )

    assert result == GeneratedEmail(**payload)
    _, kwargs = fake_client.chat.completions.create.call_args
    assert kwargs["model"] == "llama-3.3-70b-versatile"
    assert kwargs["response_format"] == {"type": "json_object"}
    assert "jane@example.com" in kwargs["messages"][1]["content"]
    assert "Alex at Acme" in kwargs["messages"][1]["content"]


def test_generate_cold_email_raises_on_content_filter():
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_response(finish_reason="content_filter")

    with patch("email_generator.get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="declined"):
            generate_cold_email(content="post", recipient_email="jane@example.com")


def test_generate_cold_email_raises_when_content_missing():
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_response(content=None)

    with patch("email_generator.get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="parseable"):
            generate_cold_email(content="post", recipient_email="jane@example.com")


def test_generate_cold_email_raises_on_invalid_json():
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _fake_response(content="not json")

    with patch("email_generator.get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="parseable"):
            generate_cold_email(content="post", recipient_email="jane@example.com")


def test_get_client_raises_clear_error_when_groq_api_key_missing(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setattr(email_generator, "_client", None)

    with pytest.raises(ValueError, match="GROQ_API_KEY is not set"):
        email_generator.get_client()


def test_get_client_succeeds_when_groq_api_key_present(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setattr(email_generator, "_client", None)

    client = email_generator.get_client()

    assert client is not None
    assert email_generator.get_client() is client
