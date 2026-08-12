import pytest

from providers import get_provider
from providers.anthropic_provider import AnthropicProvider
from providers.groq_provider import GroqProvider


def test_get_provider_defaults_to_anthropic(monkeypatch):
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    assert isinstance(get_provider(), AnthropicProvider)


def test_get_provider_returns_anthropic_provider(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    assert isinstance(get_provider(), AnthropicProvider)


def test_get_provider_returns_groq_provider(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    assert isinstance(get_provider(), GroqProvider)


def test_get_provider_is_case_insensitive(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "GROQ")
    assert isinstance(get_provider(), GroqProvider)


def test_get_provider_raises_on_unknown_provider(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    with pytest.raises(ValueError, match="Unsupported LLM_PROVIDER"):
        get_provider()
