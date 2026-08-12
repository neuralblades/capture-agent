"""LLM-powered extraction of structured data from captured posts.

Uses the Anthropic Messages API with structured outputs to turn raw post text
into a summary, tags, and deadlines whose relative phrasing ("next Friday",
"in 2 weeks") is resolved into absolute ISO 8601 dates.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

import anthropic
from dotenv import load_dotenv

from models import ExtractionResult

load_dotenv()

MODEL = "claude-opus-5"

_client: anthropic.Anthropic | None = None


def get_client() -> anthropic.Anthropic:
    """Lazily construct the Anthropic client so import-time errors don't break tooling."""
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    return _client


SYSTEM_PROMPT = """You extract structured information from social media posts captured by a browser extension.

For each post:
- Write a one-sentence summary.
- Assign a few short topical tags.
- Find every deadline or time-sensitive commitment mentioned (e.g. "due Friday", "in 2 weeks", "by EOD tomorrow"). Resolve each relative phrase to an absolute date in ISO 8601 (YYYY-MM-DD) using the reference date below. If a phrase can't be confidently resolved, set iso_date to null and give it a low confidence.
- Set action_required to true if the post implies the reader must do something (respond, submit, register, pay, attend).

Reference date (when this post was captured; resolve all relative dates against it): {reference_date}"""


def extract_post_data(content: str, captured_at: datetime | None = None) -> ExtractionResult:
    """Call Claude to extract a structured summary, tags, and deadlines from a captured post."""
    reference_date = (captured_at or datetime.now(timezone.utc)).date().isoformat()

    response = get_client().messages.parse(
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
