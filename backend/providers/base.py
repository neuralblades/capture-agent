"""Base class and shared prompts for LLM providers."""
from __future__ import annotations

from abc import ABC, abstractmethod

from models import ExtractionResult, MatchResult, ProfileContext

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

FORM_ANSWER_SYSTEM_PROMPT = """You write short, first-person answers to open-ended job/application form questions on behalf of an applicant, using their profile below. Answer only the question asked, in 2-4 sentences, in a natural human voice. Do not invent facts that aren't supported by the profile -- write generally instead of fabricating specifics. Respond with the answer text only, no preamble, no quotes, no markdown.

Applicant profile:
{profile}"""

MATCH_SYSTEM_PROMPT = """You compare a captured job post against an applicant's resume and score how well they match.

Read the job post and the resume below, then:
- Compute an overall match_score from 0 to 100 reflecting how well the resume's skills and experience align with what the post is asking for. 100 means the resume is a near-perfect fit; 0 means there's no meaningful overlap.
- List the specific skills/requirements mentioned in the post that the resume already demonstrates in matching_skills.
- List the specific skills/requirements mentioned in the post that the resume does not show evidence of in missing_skills.
If the post doesn't describe a job or role with identifiable requirements, still do your best to score general topical overlap.

Resume:
{resume_text}"""


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

    @abstractmethod
    def calculate_match(self, content: str, resume_text: str) -> MatchResult:
        """Score how well an applicant's resume matches a captured post's content."""
        raise NotImplementedError
