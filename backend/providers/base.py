"""Base class and shared prompts for LLM providers."""
from __future__ import annotations

from abc import ABC, abstractmethod

from models import ExtractionResult, ProfileContext

SYSTEM_PROMPT = """You extract structured information from social media posts captured by a browser extension.

For each post:
- Write a one-sentence summary.
- Assign a few short topical tags.
- Find every deadline or time-sensitive commitment mentioned (e.g. "due Friday", "in 2 weeks", "by EOD tomorrow"). Resolve each relative phrase to an absolute date in ISO 8601 (YYYY-MM-DD) using the reference date below. If a phrase can't be confidently resolved, set iso_date to null and give it a low confidence.
- Set action_required to true if the post implies the reader must do something (respond, submit, register, pay, attend).

Reference date (when this post was captured; resolve all relative dates against it): {reference_date}"""

FORM_ANSWER_SYSTEM_PROMPT = """You write short, first-person answers to open-ended job/application form questions on behalf of an applicant, using their profile below. Answer only the question asked, in 2-4 sentences, in a natural human voice. Do not invent facts that aren't supported by the profile -- write generally instead of fabricating specifics. Respond with the answer text only, no preamble, no quotes, no markdown.

Applicant profile:
{profile}"""


_PROFILE_LABELS = {
    "full_name": "Name",
    "email": "Email",
    "phone": "Phone",
    "linkedin_url": "LinkedIn",
    "github_url": "GitHub",
    "resume_text": "Resume",
}


def format_profile(profile: ProfileContext) -> str:
    """Render only the populated profile fields as "Label: value" lines."""
    lines = [
        f"{label}: {value}"
        for field, label in _PROFILE_LABELS.items()
        if (value := getattr(profile, field))
    ]
    return "\n".join(lines) if lines else "(no profile information provided)"


class LLMProvider(ABC):
    """Adapter interface for a structured-extraction LLM backend."""

    @abstractmethod
    def extract(self, content: str, reference_date: str) -> ExtractionResult:
        """Extract a structured summary, tags, and deadlines from post content."""
        raise NotImplementedError

    @abstractmethod
    def generate_form_answer(self, question: str, profile: ProfileContext) -> str:
        """Generate a tailored answer to an open-ended form question."""
        raise NotImplementedError
