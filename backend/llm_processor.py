"""LLM-powered extraction of structured data from captured posts.

Delegates to the LLM provider selected by LLM_PROVIDER (see providers/) to turn
raw post text into a summary, tags, and deadlines whose relative phrasing
("next Friday", "in 2 weeks") is resolved into absolute ISO 8601 dates.
"""
from __future__ import annotations

from datetime import datetime, timezone

from models import ExtractionResult
from providers import get_provider


def extract_post_data(content: str, captured_at: datetime | None = None) -> ExtractionResult:
    """Run captured post content through the configured LLM provider."""
    reference_date = (captured_at or datetime.now(timezone.utc)).date().isoformat()
    return get_provider().extract(content, reference_date)
