"""Base class and shared prompts for LLM providers."""
from __future__ import annotations

import json
from abc import ABC, abstractmethod

from models import ExtractionResult, FieldMapping, FormFieldDescriptor, MatchResult, ProfileContext

SYSTEM_PROMPT = """You extract structured information from social media posts captured by a browser extension.

For each post:
- Write a one-sentence summary.
- Assign a single, concise category that best captures what the post is about, as an open-ended 1-2 word phrase (e.g. "AI Tools", "Research", "Finance", "Career", "Deadlines"). Do not restrict yourself to a fixed list -- pick whatever category name most naturally fits the post's topic, using Title Case.
- Assign a few short topical tags.
- Find every deadline or time-sensitive commitment mentioned (e.g. "due Friday", "in 2 weeks", "by EOD tomorrow"). Resolve each relative phrase to an absolute date in ISO 8601 (YYYY-MM-DD) using the reference date below. If a phrase can't be confidently resolved, set iso_date to null and give it a low confidence.
- Set action_required to true if the post implies the reader must do something (respond, submit, register, pay, attend).
- Find any third-party application or action URL mentioned in the text itself (e.g. a Google Form, Lever, Greenhouse, Workable, or Typeform link). This is distinct from the source post's own URL, which is supplied separately by the caller and never appears in the post text — do not invent one. Put it in external_url, or null if none is mentioned.
- Find any recruiter or founder contact email address mentioned in the text (e.g. "email me at jane@acme.com"). Put it in contact_email, or null if none is mentioned.
- Classify action_type based on what you found: "job_form" if external_url points to a job application form/portal, "cold_email" if a contact_email is given and there's no application form link, "general_link" if there's a third-party link that isn't a job application (e.g. an event page or registration form), or "none" if neither an external_url nor a contact_email was found.
- Set is_opportunity to true only if the post represents something the user could apply/respond to with a clear next action -- a job posting, hackathon, scholarship, or freelance gig. Set it to false for books, articles, general commentary, and anything else without a concrete apply/respond action.

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

MAP_FORM_FIELDS_SYSTEM_PROMPT = """You fill out a job application form on behalf of an applicant, using their profile below. You are given a JSON list of form fields the caller could not confidently fill with simple heuristics -- some are ambiguous EEO/screening questions (work authorization, veteran status, disability status, race/ethnicity), some are custom text questions, some are ATS-specific fields with unclear labels.

For each field:
- "text"/"textarea": write a short, first-person answer using the profile. Don't invent facts the profile doesn't support -- answer generally instead of fabricating specifics.
- "select"/"radio-group"/"checkbox-group": pick the single option whose label text best matches the applicant's profile, and respond with that option's "value" field verbatim (never invent a new value; never return the label text). If nothing in the profile is relevant to a screening question (e.g. no veteran_status given), prefer an option whose label reads like "prefer not to answer" / "decline to state" if one exists, otherwise skip the field entirely.
- If a field can't be confidently mapped at all (no relevant profile data and no safe default option), omit it from your response rather than guessing.

Respond with ONLY a single JSON object (no surrounding text or markdown) of this shape:
{{"mappings": [{{"index": number, "value": string}}, ...]}}

Applicant profile:
{profile}

Form fields:
{fields}"""


_PROFILE_LABELS = {
    "full_name": "Name",
    "email": "Email",
    "phone": "Phone",
    "linkedin_url": "LinkedIn",
    "github_url": "GitHub",
    "resume_text": "Resume",
    "work_authorized": "Authorized to work without sponsorship",
    "veteran_status": "Veteran status",
    "disability_status": "Disability status",
    "ethnicity": "Race/ethnicity",
}


def format_profile(profile: ProfileContext) -> str:
    """Render only the populated profile fields as "Label: value" lines."""
    lines = []
    for field, label in _PROFILE_LABELS.items():
        value = getattr(profile, field)
        # work_authorized is a bool: explicit False is populated information
        # ("not authorized"), unlike the string fields where "" means unset.
        if value is None or value == "":
            continue
        lines.append(f"{label}: {value}")
    return "\n".join(lines) if lines else "(no profile information provided)"


def format_form_fields(fields: list[FormFieldDescriptor]) -> str:
    """Render field descriptors as JSON for inclusion in the field-mapping prompt."""
    return json.dumps([field.model_dump() for field in fields])


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

    @abstractmethod
    def map_form_fields(
        self, fields: list[FormFieldDescriptor], profile: ProfileContext
    ) -> list[FieldMapping]:
        """Map ambiguous/custom form fields to profile values or generated answers."""
        raise NotImplementedError
