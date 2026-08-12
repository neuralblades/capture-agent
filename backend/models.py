"""Typed JSON contracts shared between the extension and the AI backend."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


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
    created_at: str
