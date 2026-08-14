"""FastAPI backend for Capture Agent.

Receives posts captured by the extension's content script, runs them through
llm_processor for structured extraction (summary, tags, deadlines resolved to
ISO dates), and persists the result to SQLite.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import feedparser
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import database
import feed_poller
from contact_extractor import find_contact_email
from email_generator import generate_cold_email
from llm_processor import calculate_match_score, extract_post_data, generate_form_answer, map_form_fields
from models import (
    CalculateMatchRequest,
    CapturedPost,
    CategoryCount,
    FeedCreate,
    FeedRecord,
    FormAnswerRequest,
    FormAnswerResponse,
    GenerateEmailRequest,
    GeneratedEmail,
    MapFormFieldsRequest,
    MapFormFieldsResponse,
    MatchResult,
    PostRecord,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    poller_task = asyncio.create_task(feed_poller.run_feed_poller(capture_post))
    try:
        yield
    finally:
        poller_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await poller_task


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
    # Idempotent per (url, content): re-capturing the same source (e.g.
    # clicking Capture again, or dismiss failing to clear a card) should
    # return the existing record rather than paying for another LLM call and
    # inserting a duplicate. Content is part of the key, not just url, because
    # a web_selection capture's url is the page it was selected from -- the
    # same page can yield many distinct selections that must not collapse
    # into one post the way a tweet or LinkedIn post (one fixed url per post)
    # naturally would.
    if post.url:
        existing = database.get_post_by_url_and_content(post.url, post.content)
        if existing is not None:
            return PostRecord(**existing)

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
        external_url=extraction.external_url,
        contact_email=extraction.contact_email or find_contact_email(post.content),
        action_type=extraction.action_type,
        category=extraction.category,
        is_opportunity=extraction.is_opportunity,
        posted_at=post.posted_at.isoformat() if post.posted_at else None,
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


@app.post("/calculate-match", response_model=MatchResult)
def calculate_match(request: CalculateMatchRequest) -> MatchResult:
    record = database.get_post(request.post_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Post not found")
    if not record["is_opportunity"]:
        raise HTTPException(status_code=400, detail="Post is not an opportunity; match scoring is not applicable")

    try:
        result = calculate_match_score(record["content"], request.resume_text)
    except Exception as exc:  # noqa: BLE001 - surface LLM/API failures as a 502, not a 500
        raise HTTPException(status_code=502, detail=f"Match calculation failed: {exc}") from exc

    database.update_match_score(request.post_id, result.match_score)
    return result


@app.get("/categories", response_model=list[CategoryCount])
def get_categories() -> list[CategoryCount]:
    return [CategoryCount(**row) for row in database.category_counts()]


@app.post("/map-form-fields", response_model=MapFormFieldsResponse)
def map_form_fields_route(request: MapFormFieldsRequest) -> MapFormFieldsResponse:
    try:
        mappings = map_form_fields(request.fields, request.profile)
    except Exception as exc:  # noqa: BLE001 - surface LLM/API failures as a 502, not a 500
        raise HTTPException(status_code=502, detail=f"Field mapping failed: {exc}") from exc

    return MapFormFieldsResponse(mappings=mappings)


@app.get("/posts", response_model=list[PostRecord])
def get_posts(limit: int = 50, offset: int = 0) -> list[PostRecord]:
    return [PostRecord(**row) for row in database.list_posts(limit=limit, offset=offset)]


@app.get("/posts/{post_id}", response_model=PostRecord)
def get_post(post_id: int) -> PostRecord:
    record = database.get_post(post_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Post not found")
    return PostRecord(**record)


@app.delete("/posts/{post_id}", status_code=204)
def delete_post(post_id: int) -> None:
    if not database.delete_post(post_id):
        raise HTTPException(status_code=404, detail="Post not found")


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


@app.get("/feeds", response_model=list[FeedRecord])
def get_feeds() -> list[FeedRecord]:
    return [FeedRecord(**row) for row in database.list_feeds()]


@app.post("/feeds", response_model=FeedRecord, status_code=201)
def create_feed(feed: FeedCreate) -> FeedRecord:
    # feedparser never raises on a bad URL/unreachable host/non-feed content --
    # it sets bozo and leaves version empty instead, so that's what "does this
    # actually parse as a feed" comes down to checking.
    parsed = feedparser.parse(feed.url)
    if parsed.bozo and not parsed.version:
        raise HTTPException(status_code=400, detail="URL does not look like a valid RSS/Atom feed")

    feed_id = database.add_feed(url=feed.url, label=feed.label)
    record = database.get_feed(feed_id)
    if record is None:
        raise HTTPException(status_code=500, detail="Feed was saved but could not be re-read")
    return FeedRecord(**record)


@app.delete("/feeds/{feed_id}", status_code=204)
def delete_feed(feed_id: int) -> None:
    if not database.delete_feed(feed_id):
        raise HTTPException(status_code=404, detail="Feed not found")
