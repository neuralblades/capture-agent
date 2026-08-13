"""Typed JSON contracts shared between the extension and the AI backend."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

ActionType = Literal["job_form", "cold_email", "general_link", "none"]


class CapturedPost(BaseModel):
    """A post captured by the extension's content script."""

    platform: str = Field(
        ..., description="Source platform, e.g. 'twitter', 'linkedin', or 'web_selection' for a right-click capture of highlighted text on any page"
    )
    author: Optional[str] = Field(None, description="Display name of the post author")
    content: str = Field(..., description="Raw text content of the captured post")
    url: Optional[str] = Field(None, description="URL of the captured post")
    captured_at: Optional[datetime] = Field(
        None, description="Client-side capture timestamp; defaults to server time if omitted"
    )


class Deadline(BaseModel):
    """A single deadline extracted from a post."""

    text: str = Field(..., description="The original relative-deadline phrase, e.g. 'by next Friday'")
    iso_date: Optional[str] = Field(
        None, description="Resolved absolute date in ISO 8601 (YYYY-MM-DD), or null if unresolvable"
    )
    confidence: float = Field(..., ge=0, le=1, description="Model confidence in the resolved date")


class ExtractionResult(BaseModel):
    """Structured output produced by the LLM processor for a captured post."""

    summary: str = Field(..., description="One-sentence summary of the post")
    category: str = Field(
        "General",
        description="Concise, open-ended 1-2 word category for the post (e.g. 'AI Tools', 'Research', 'Finance', 'Career')",
    )
    tags: list[str] = Field(default_factory=list, description="Topical tags for the post")
    deadlines: list[Deadline] = Field(default_factory=list, description="Deadlines mentioned in the post")
    action_required: bool = Field(..., description="Whether the post implies an action the user must take")
    external_url: Optional[str] = Field(
        None, description="Third-party application/action URL mentioned in the post (e.g. a Google Form or job portal link), distinct from the source post's own URL"
    )
    contact_email: Optional[str] = Field(
        None, description="Recruiter or founder contact email mentioned in the post, if any"
    )
    action_type: ActionType = Field(
        "none", description="How the reader is expected to act: applying via a form, emailing a contact, following a general link, or no action"
    )


class ProfileContext(BaseModel):
    """Applicant profile stored in the extension (chrome.storage.local) and sent
    along with a form-answer/field-mapping request to tailor the generated response."""

    full_name: Optional[str] = Field(None, description="Applicant's full name")
    email: Optional[str] = Field(None, description="Applicant's email address")
    phone: Optional[str] = Field(None, description="Applicant's phone number")
    linkedin_url: Optional[str] = Field(None, description="Applicant's LinkedIn profile URL")
    github_url: Optional[str] = Field(None, description="Applicant's GitHub profile URL")
    resume_text: Optional[str] = Field(None, description="Plain-text resume/CV content")
    work_authorized: Optional[bool] = Field(
        None, description="Whether the applicant is authorized to work without sponsorship"
    )
    veteran_status: Optional[str] = Field(
        None, description="Applicant's own wording for veteran-status screening questions, e.g. 'I am not a protected veteran'"
    )
    disability_status: Optional[str] = Field(
        None, description="Applicant's own wording for disability-status screening questions"
    )
    ethnicity: Optional[str] = Field(
        None, description="Applicant's own wording for race/ethnicity EEO screening questions"
    )


class FormAnswerRequest(BaseModel):
    """An open-ended form question to be answered on the applicant's behalf."""

    question: str = Field(..., description="The form question or field label text")
    profile: ProfileContext = Field(
        default_factory=ProfileContext, description="Applicant profile used to tailor the answer"
    )


class FormAnswerResponse(BaseModel):
    """A generated answer for an open-ended form question."""

    answer: str = Field(..., description="Tailored answer text to inject into the form field")


FormFieldType = Literal["text", "textarea", "select", "radio-group", "checkbox-group"]


class FormFieldOption(BaseModel):
    """A single selectable choice for a select/radio-group/checkbox-group field."""

    value: str = Field(..., description="The option's underlying value/id, to be echoed back in a mapping")
    label: str = Field(..., description="The option's human-readable text")


class FormFieldDescriptor(BaseModel):
    """One field the extension's universal autofill engine could not confidently
    fill via local heuristics, sent to the AI mapper as a fallback."""

    index: int = Field(..., description="Position in the request's fields list; echoed back in the mapping")
    type: FormFieldType
    label: str = Field("", description="Best-effort question/label text resolved for this field")
    name: Optional[str] = Field(None, description="The field's HTML name attribute, if any")
    placeholder: Optional[str] = Field(None, description="The field's placeholder text, if any")
    options: list[FormFieldOption] = Field(
        default_factory=list, description="Choices for select/radio-group/checkbox-group fields; empty for text/textarea"
    )


class MapFormFieldsRequest(BaseModel):
    """A batch of ambiguous/custom form fields to map to profile values or generated answers."""

    fields: list[FormFieldDescriptor] = Field(default_factory=list)
    profile: ProfileContext = Field(default_factory=ProfileContext, description="Applicant profile used to map/generate values")


class FieldMapping(BaseModel):
    """The value to fill into one requested field."""

    index: int = Field(..., description="Matches a FormFieldDescriptor.index from the request")
    value: str = Field(
        ..., description="For text/textarea, the generated answer text. For select/radio-group/checkbox-group, one of that field's option values."
    )


class MapFormFieldsResponse(BaseModel):
    """Field mappings for a batch of ambiguous/custom form fields."""

    mappings: list[FieldMapping] = Field(default_factory=list)


class PostRecord(BaseModel):
    """A stored post, including its LLM-derived extraction."""

    id: int
    platform: str
    author: Optional[str]
    content: str
    url: Optional[str]
    captured_at: str
    summary: str
    category: str = "General"
    tags: list[str]
    action_required: bool
    deadlines: list[Deadline]
    external_url: Optional[str] = None
    contact_email: Optional[str] = None
    action_type: ActionType = "none"
    match_score: Optional[int] = Field(
        None, ge=0, le=100, description="Resume-to-post match score last computed via /calculate-match"
    )
    created_at: str


class CalculateMatchRequest(BaseModel):
    """Request to score a captured post against an applicant's resume."""

    post_id: int = Field(..., description="Id of a previously captured post to score against")
    resume_text: str = Field(..., min_length=1, description="Applicant resume/CV text to compare against the post content")


class MatchResult(BaseModel):
    """Result of comparing a captured post against an applicant's resume."""

    match_score: int = Field(..., ge=0, le=100, description="Overall match score between the resume and the post, 0-100")
    matching_skills: list[str] = Field(
        default_factory=list, description="Skills/requirements from the post that the resume already covers"
    )
    missing_skills: list[str] = Field(
        default_factory=list, description="Skills/requirements mentioned in the post that the resume does not show"
    )


class CategoryCount(BaseModel):
    """A category and how many stored posts currently carry it."""

    name: str = Field(..., description="Category name, or 'All' for the total across every post")
    count: int = Field(..., description="Number of stored posts in this category")


class GenerateEmailRequest(BaseModel):
    """Request to draft a cold outreach email for a captured post."""

    post_id: Optional[int] = Field(None, description="Id of a previously captured post to use as context")
    content: Optional[str] = Field(None, description="Raw post content to use as context, if post_id is omitted")
    recipient_email: str = Field(..., description="Email address the draft will be addressed to")
    sender_name: Optional[str] = Field(None, description="Name the email should be signed with")
    sender_company: Optional[str] = Field(None, description="Company the sender represents, if any")

    @model_validator(mode="after")
    def _require_post_id_or_content(self) -> "GenerateEmailRequest":
        if self.post_id is None and not self.content:
            raise ValueError("Either post_id or content must be provided")
        return self


class GeneratedEmail(BaseModel):
    """A drafted cold outreach email, ready to hand off to a mail client."""

    subject: str = Field(..., description="Drafted email subject line")
    body: str = Field(..., description="Drafted email body")
