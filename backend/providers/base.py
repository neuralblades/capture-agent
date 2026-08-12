"""Base class and shared prompt for LLM providers."""
from __future__ import annotations

from abc import ABC, abstractmethod

from models import ExtractionResult

SYSTEM_PROMPT = """You extract structured information from social media posts captured by a browser extension.

For each post:
- Write a one-sentence summary.
- Assign a few short topical tags.
- Find every deadline or time-sensitive commitment mentioned (e.g. "due Friday", "in 2 weeks", "by EOD tomorrow"). Resolve each relative phrase to an absolute date in ISO 8601 (YYYY-MM-DD) using the reference date below. If a phrase can't be confidently resolved, set iso_date to null and give it a low confidence.
- Set action_required to true if the post implies the reader must do something (respond, submit, register, pay, attend).

Reference date (when this post was captured; resolve all relative dates against it): {reference_date}"""


class LLMProvider(ABC):
    """Adapter interface for a structured-extraction LLM backend."""

    @abstractmethod
    def extract(self, content: str, reference_date: str) -> ExtractionResult:
        """Extract a structured summary, tags, and deadlines from post content."""
        raise NotImplementedError
