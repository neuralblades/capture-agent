"""LLM-powered extraction of structured data from captured posts.

Delegates to the LLM provider selected by LLM_PROVIDER (see providers/) to turn
raw post text into a summary, tags, and deadlines whose relative phrasing
("next Friday", "in 2 weeks") is resolved into absolute ISO 8601 dates.
"""
from __future__ import annotations

from datetime import datetime, timezone

import database
from models import ExtractionResult, FieldMapping, FormFieldDescriptor, MatchResult, ProfileContext
from providers import get_provider
from providers.base import normalize_category


def extract_post_data(content: str, captured_at: datetime | None = None) -> ExtractionResult:
    """Run captured post content through the configured LLM provider.

    Passes the distinct categories already in the database as reuse-context
    (see providers.base.SYSTEM_PROMPT's category instruction), and runs the
    result's category through normalize_category() as a deterministic
    safety net -- this is the one call site every extraction goes through
    regardless of provider, so it's the right place for both.
    """
    reference_date = (captured_at or datetime.now(timezone.utc)).date().isoformat()
    existing_categories = [row["name"] for row in database.category_counts() if row["name"] != "All"]

    result = get_provider().extract(content, reference_date, existing_categories)
    result.category = normalize_category(result.category)
    return result


def generate_form_answer(question: str, profile: ProfileContext) -> str:
    """Generate a tailored answer to an open-ended form question via the configured LLM provider."""
    return get_provider().generate_form_answer(question, profile)


def calculate_match_score(content: str, resume_text: str) -> MatchResult:
    """Score how well an applicant's resume matches a captured post via the configured LLM provider."""
    return get_provider().calculate_match(content, resume_text)


def map_form_fields(fields: list[FormFieldDescriptor], profile: ProfileContext) -> list[FieldMapping]:
    """Map ambiguous/custom form fields to profile values or generated answers via the configured LLM provider."""
    return get_provider().map_form_fields(fields, profile)
