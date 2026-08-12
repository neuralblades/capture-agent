"""Provider factory: selects an LLMProvider implementation via LLM_PROVIDER."""
from __future__ import annotations

import os
from functools import lru_cache

from dotenv import load_dotenv

from providers.base import LLMProvider

# Loaded here (rather than in llm_processor.py, which no longer talks to any
# SDK directly) since this is the module every provider-selection/env-reading
# path runs through, whether the entry point is main.py or llm_processor.py.
load_dotenv()

_PROVIDERS = ("anthropic", "groq")


def get_provider() -> LLMProvider:
    """Return the LLM provider named by the LLM_PROVIDER env var (default: anthropic)."""
    name = os.environ.get("LLM_PROVIDER", "anthropic").strip().lower()
    return _get_provider(name)


@lru_cache(maxsize=None)
def _get_provider(name: str) -> LLMProvider:
    """Build and cache one provider instance per name, so its SDK/HTTP client is reused
    across requests instead of being rebuilt on every extract_post_data() call."""
    if name == "anthropic":
        from providers.anthropic_provider import AnthropicProvider

        return AnthropicProvider()
    if name == "groq":
        from providers.groq_provider import GroqProvider

        return GroqProvider()

    raise ValueError(f"Unsupported LLM_PROVIDER {name!r}; expected one of {_PROVIDERS}")
