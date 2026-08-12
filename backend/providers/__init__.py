"""Provider factory: selects an LLMProvider implementation via LLM_PROVIDER."""
from __future__ import annotations

import os

from providers.base import LLMProvider

_PROVIDERS = ("anthropic", "groq")


def get_provider() -> LLMProvider:
    """Instantiate the LLM provider named by the LLM_PROVIDER env var (default: anthropic)."""
    name = os.environ.get("LLM_PROVIDER", "anthropic").strip().lower()

    if name == "anthropic":
        from providers.anthropic_provider import AnthropicProvider

        return AnthropicProvider()
    if name == "groq":
        from providers.groq_provider import GroqProvider

        return GroqProvider()

    raise ValueError(f"Unsupported LLM_PROVIDER {name!r}; expected one of {_PROVIDERS}")
