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
- Find any third-party application or action URL mentioned in the text itself (e.g. a Google Form, Lever, Greenhouse, Workable, or Typeform link). This is distinct from the source post's own URL, which is supplied separately by the caller and never appears in the post text — do not invent one. Put it in external_url, or null if none is mentioned.
- Find any recruiter or founder contact email address mentioned in the text (e.g. "email me at jane@acme.com"). Put it in contact_email, or null if none is mentioned.
- Classify action_type based on what you found: "job_form" if external_url points to a job application form/portal, "cold_email" if a contact_email is given and there's no application form link, "general_link" if there's a third-party link that isn't a job application (e.g. an event page or registration form), or "none" if neither an external_url nor a contact_email was found.

Reference date (when this post was captured; resolve all relative dates against it): {reference_date}"""


class LLMProvider(ABC):
    """Adapter interface for a structured-extraction LLM backend."""

    @abstractmethod
    def extract(self, content: str, reference_date: str) -> ExtractionResult:
        """Extract a structured summary, tags, and deadlines from post content."""
        raise NotImplementedError
