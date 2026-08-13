"""Anthropic Claude adapter for structured post extraction."""
from __future__ import annotations

import os

import anthropic
from pydantic import BaseModel

from models import ExtractionResult, FieldMapping, FormFieldDescriptor, MatchResult, ProfileContext
from providers.base import (
    FORM_ANSWER_SYSTEM_PROMPT,
    MAP_FORM_FIELDS_SYSTEM_PROMPT,
    MATCH_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    format_form_fields,
    format_profile,
    LLMProvider,
)

MODEL = "claude-opus-5"


class _FieldMappingBatch(BaseModel):
    """Wrapper so Claude's structured output can return a list of mappings."""

    mappings: list[FieldMapping]


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

    def calculate_match(self, content: str, resume_text: str) -> MatchResult:
        response = self.get_client().messages.parse(
            model=MODEL,
            max_tokens=1024,
            system=MATCH_SYSTEM_PROMPT.format(resume_text=resume_text),
            messages=[{"role": "user", "content": content}],
            output_format=MatchResult,
        )

        if response.stop_reason == "refusal":
            raise ValueError("Claude declined to score this match")
        if response.parsed_output is None:
            raise ValueError("Claude did not return a parseable match result")

        return response.parsed_output

    def map_form_fields(
        self, fields: list[FormFieldDescriptor], profile: ProfileContext
    ) -> list[FieldMapping]:
        if not fields:
            return []

        response = self.get_client().messages.parse(
            model=MODEL,
            max_tokens=2048,
            system=MAP_FORM_FIELDS_SYSTEM_PROMPT.format(
                profile=format_profile(profile), fields=format_form_fields(fields)
            ),
            messages=[{"role": "user", "content": "Map the fields above."}],
            output_format=_FieldMappingBatch,
        )

        if response.stop_reason == "refusal":
            raise ValueError("Claude declined to map these fields")
        if response.parsed_output is None:
            raise ValueError("Claude did not return a parseable field mapping result")

        valid_indices = {field.index for field in fields}
        return [mapping for mapping in response.parsed_output.mappings if mapping.index in valid_indices]
