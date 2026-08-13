"""Groq adapter for structured post extraction using Llama 3.3 70B."""
from __future__ import annotations

import json
import os

from groq import Groq
from pydantic import ValidationError

from models import ExtractionResult, MatchResult, ProfileContext
from providers.base import (
    FORM_ANSWER_SYSTEM_PROMPT,
    MATCH_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    format_profile,
    LLMProvider,
)

MODEL = "llama-3.3-70b-versatile"

# Groq's JSON mode (unlike Anthropic's structured `output_format`) only guarantees
# valid JSON, not a specific shape, so the schema has to be spelled out in-prompt.
JSON_INSTRUCTIONS = """

Respond with ONLY a single JSON object (no surrounding text or markdown) of this shape:
{
  "summary": string,
  "tags": [string, ...],
  "deadlines": [{"text": string, "iso_date": string | null, "confidence": number between 0 and 1}, ...],
  "action_required": boolean,
  "external_url": string | null,
  "contact_email": string | null,
  "action_type": "job_form" | "cold_email" | "general_link" | "none"
}"""

MATCH_JSON_INSTRUCTIONS = """

Respond with ONLY a single JSON object (no surrounding text or markdown) of this shape:
{
  "match_score": number between 0 and 100,
  "matching_skills": [string, ...],
  "missing_skills": [string, ...]
}"""


class GroqProvider(LLMProvider):
    """Extracts structured post data using Groq's Llama 3.3 70B model."""

    def __init__(self) -> None:
        self._client: Groq | None = None

    def get_client(self) -> Groq:
        """Lazily construct the client so import-time errors don't break tooling."""
        if self._client is None:
            self._client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
        return self._client

    def extract(self, content: str, reference_date: str) -> ExtractionResult:
        system_prompt = SYSTEM_PROMPT.format(reference_date=reference_date) + JSON_INSTRUCTIONS

        response = self.get_client().chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": content},
            ],
            response_format={"type": "json_object"},
        )

        choice = response.choices[0]
        if choice.finish_reason == "content_filter":
            raise ValueError("Groq declined to process this post")

        raw = choice.message.content
        if not raw:
            raise ValueError("Groq did not return a parseable extraction result")

        try:
            return ExtractionResult.model_validate(json.loads(raw))
        except (json.JSONDecodeError, ValidationError) as exc:
            raise ValueError("Groq did not return a parseable extraction result") from exc

    def generate_form_answer(self, question: str, profile: ProfileContext) -> str:
        system_prompt = FORM_ANSWER_SYSTEM_PROMPT.format(profile=format_profile(profile))

        response = self.get_client().chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": question},
            ],
        )

        choice = response.choices[0]
        if choice.finish_reason == "content_filter":
            raise ValueError("Groq declined to answer this question")

        answer = choice.message.content
        if not answer or not answer.strip():
            raise ValueError("Groq did not return an answer")

        return answer.strip()

    def calculate_match(self, content: str, resume_text: str) -> MatchResult:
        system_prompt = MATCH_SYSTEM_PROMPT.format(resume_text=resume_text) + MATCH_JSON_INSTRUCTIONS

        response = self.get_client().chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": content},
            ],
            response_format={"type": "json_object"},
        )

        choice = response.choices[0]
        if choice.finish_reason == "content_filter":
            raise ValueError("Groq declined to score this match")

        raw = choice.message.content
        if not raw:
            raise ValueError("Groq did not return a parseable match result")

        try:
            return MatchResult.model_validate(json.loads(raw))
        except (json.JSONDecodeError, ValidationError) as exc:
            raise ValueError("Groq did not return a parseable match result") from exc
