"""FastAPI backend for Capture Agent.

Receives posts captured by the extension's content script, runs them through
llm_processor for structured extraction (summary, tags, deadlines resolved to
ISO dates), and persists the result to SQLite.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import database
from llm_processor import extract_post_data
from models import CapturedPost, PostRecord


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    yield


app = FastAPI(title="Capture Agent Backend", version="0.1.0", lifespan=lifespan)

# The extension runs from a chrome-extension:// origin with no fixed hostname
# across installs, so origins can't be pinned to a single value here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
    )

    record = database.get_post(post_id)
    if record is None:
        raise HTTPException(status_code=500, detail="Post was saved but could not be re-read")
    return PostRecord(**record)


@app.get("/posts", response_model=list[PostRecord])
def get_posts(limit: int = 50, offset: int = 0) -> list[PostRecord]:
    return [PostRecord(**row) for row in database.list_posts(limit=limit, offset=offset)]


@app.get("/posts/{post_id}", response_model=PostRecord)
def get_post(post_id: int) -> PostRecord:
    record = database.get_post(post_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Post not found")
    return PostRecord(**record)
