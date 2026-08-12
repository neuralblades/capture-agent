"""FastAPI backend for Capture Agent.

Receives posts captured by the extension's content script, runs them through
llm_processor for structured extraction (summary, tags, deadlines resolved to
ISO dates), and persists the result to SQLite.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import database
from contact_extractor import find_contact_email
from email_generator import generate_cold_email
from llm_processor import extract_post_data, generate_form_answer
from models import (
    CapturedPost,
    FormAnswerRequest,
    FormAnswerResponse,
    GenerateEmailRequest,
    GeneratedEmail,
    PostRecord,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    yield


app = FastAPI(title="Capture Agent Backend", version="0.1.0", lifespan=lifespan)

# The extension runs from a chrome-extension:// origin whose ID varies per
# install/machine, so a single fixed origin can't be pinned here. Restrict by
# scheme instead of opening CORS to "*" — POST /capture is cost-incurring
# (it triggers a paid Claude API call) and unauthenticated, so a wildcard
# would let any website a user visits trigger it cross-origin. Override via
# CORS_ORIGIN_REGEX for local development against a non-extension client.
CORS_ORIGIN_REGEX = os.environ.get("CORS_ORIGIN_REGEX", r"^chrome-extension://.*$")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=CORS_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/capture", response_model=PostRecord)
def capture_post(post: CapturedPost) -> PostRecord:
    captured_at = post.captured_at or datetime.now(timezone.utc)

    try:
        extraction = extract_post_data(post.content, captured_at)
    except Exception as exc:  # noqa: BLE001 - surface LLM/API failures as a 502, not a 500
        raise HTTPException(status_code=502, detail=f"Extraction failed: {exc}") from exc

    post_id = database.insert_post(
        platform=post.platform,
        author=post.author,
        content=post.content,
        url=post.url,
        captured_at=captured_at.isoformat(),
        summary=extraction.summary,
        tags=extraction.tags,
        action_required=extraction.action_required,
        deadlines=[d.model_dump() for d in extraction.deadlines],
        contact_email=find_contact_email(post.content),
    )

    record = database.get_post(post_id)
    if record is None:
        raise HTTPException(status_code=500, detail="Post was saved but could not be re-read")
    return PostRecord(**record)


@app.post("/generate-form-answer", response_model=FormAnswerResponse)
def generate_form_answer_route(request: FormAnswerRequest) -> FormAnswerResponse:
    try:
        answer = generate_form_answer(request.question, request.profile)
    except Exception as exc:  # noqa: BLE001 - surface LLM/API failures as a 502, not a 500
        raise HTTPException(status_code=502, detail=f"Answer generation failed: {exc}") from exc

    return FormAnswerResponse(answer=answer)


@app.get("/posts", response_model=list[PostRecord])
def get_posts(limit: int = 50, offset: int = 0) -> list[PostRecord]:
    return [PostRecord(**row) for row in database.list_posts(limit=limit, offset=offset)]


@app.get("/posts/{post_id}", response_model=PostRecord)
def get_post(post_id: int) -> PostRecord:
    record = database.get_post(post_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Post not found")
    return PostRecord(**record)


@app.post("/generate-email", response_model=GeneratedEmail)
def generate_email(request: GenerateEmailRequest) -> GeneratedEmail:
    if request.post_id is not None:
        record = database.get_post(request.post_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Post not found")
        content = record["content"]
    else:
        content = request.content

    try:
        return generate_cold_email(
            content=content,
            recipient_email=request.recipient_email,
            sender_name=request.sender_name,
            sender_company=request.sender_company,
        )
    except Exception as exc:  # noqa: BLE001 - surface LLM/API failures as a 502, not a 500
        raise HTTPException(status_code=502, detail=f"Email generation failed: {exc}") from exc
