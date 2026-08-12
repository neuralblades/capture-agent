"""Anthropic Claude adapter for structured post extraction."""
from __future__ import annotations

import os

import anthropic

from models import ExtractionResult, ProfileContext
from providers.base import FORM_ANSWER_SYSTEM_PROMPT, SYSTEM_PROMPT, format_profile, LLMProvider

MODEL = "claude-opus-5"


class AnthropicProvider(LLMProvider):
    """Extracts structured post data using Claude's structured-output API."""

    def __init__(self) -> None:
        self._client: anthropic.Anthropic | None = None

    def get_client(self) -> anthropic.Anthropic:
        """Lazily construct the client so import-time errors don't break tooling."""
        if self._client is None:
            self._client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
        return self._client

    def extract(self, content: str, reference_date: str) -> ExtractionResult:
        response = self.get_client().messages.parse(
            model=MODEL,
            max_tokens=2048,
            system=SYSTEM_PROMPT.format(reference_date=reference_date),
            messages=[{"role": "user", "content": content}],
            output_format=ExtractionResult,
        )

        if response.stop_reason == "refusal":
            raise ValueError("Claude declined to process this post")
        if response.parsed_output is None:
            raise ValueError("Claude did not return a parseable extraction result")

        return response.parsed_output

    def generate_form_answer(self, question: str, profile: ProfileContext) -> str:
        response = self.get_client().messages.create(
            model=MODEL,
            max_tokens=512,
            system=FORM_ANSWER_SYSTEM_PROMPT.format(profile=format_profile(profile)),
            messages=[{"role": "user", "content": question}],
        )

        if response.stop_reason == "refusal":
            raise ValueError("Claude declined to answer this question")

        answer = "".join(block.text for block in response.content if block.type == "text").strip()
        if not answer:
            raise ValueError("Claude did not return an answer")

        return answer
