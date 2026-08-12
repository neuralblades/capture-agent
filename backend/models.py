"""Typed JSON contracts shared between the extension and the AI backend."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

ActionType = Literal["job_form", "cold_email", "general_link", "none"]


class CapturedPost(BaseModel):
    """A post captured by the extension's content script."""

    platform: str = Field(..., description="Source platform, e.g. 'linkedin', 'twitter'")
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


class PostRecord(BaseModel):
    """A stored post, including its LLM-derived extraction."""

    id: int
    platform: str
    author: Optional[str]
    content: str
    url: Optional[str]
    captured_at: str
    summary: str
    tags: list[str]
    action_required: bool
    deadlines: list[Deadline]
    external_url: Optional[str] = None
    contact_email: Optional[str] = None
    action_type: ActionType = "none"
    created_at: str


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
