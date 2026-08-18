"""Background polling of subscribed RSS/Atom feeds.

Extension service workers don't have DOMParser, so feed XML parsing has to
happen here instead of client-side -- this module is started as an asyncio
task from main.py's lifespan and calls straight into main.capture_post for
each new entry, reusing the same extraction/categorization/dedup path a
manual /capture already goes through.
"""
from __future__ import annotations

import asyncio
import html
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import feedparser

import database
from models import CapturedPost, PostRecord

logger = logging.getLogger(__name__)

CaptureFn = Callable[[CapturedPost], PostRecord]

POLL_INTERVAL_SECONDS = int(os.environ.get("FEED_POLL_INTERVAL_SECONDS", 20 * 60))

_TAG_RE = re.compile(r"<[^>]+>")


def _entry_guid(entry: dict[str, Any]) -> Optional[str]:
    return entry.get("id") or entry.get("link") or entry.get("title") or None


def _strip_html(text: str) -> str:
    """feedparser's sanitizer removes unsafe tags but leaves safe ones (e.g. <p>, <a>)
    intact, so summaries can still carry markup that shouldn't reach the LLM as content."""
    return html.unescape(_TAG_RE.sub(" ", text)).strip()


def _entry_content(entry: dict[str, Any]) -> str:
    title = (entry.get("title") or "").strip()
    summary = _strip_html(entry.get("summary") or "")
    parts = [p for p in (title, summary) if p]
    return "\n\n".join(parts)


def _entry_posted_at(entry: dict[str, Any]) -> Optional[datetime]:
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if not parsed:
        return None
    return datetime(*parsed[:6], tzinfo=timezone.utc)


def _entry_image(entry: dict[str, Any]) -> Optional[str]:
    """Best-effort representative image for a feed entry, checked in order of
    reliability: Media RSS's <media:thumbnail> (feedparser exposes it as
    media_thumbnail), then <media:content> entries explicitly typed as an
    image, then a plain <enclosure> typed as an image. Most feeds carry none
    of these, so returning None here is the common (and correct) case."""
    thumbnails = entry.get("media_thumbnail") or []
    if thumbnails and thumbnails[0].get("url"):
        return thumbnails[0]["url"]

    for media in entry.get("media_content") or []:
        url = media.get("url")
        if url and (media.get("medium") == "image" or (media.get("type") or "").startswith("image/")):
            return url

    for enclosure in entry.get("enclosures") or []:
        if enclosure.get("href") and (enclosure.get("type") or "").startswith("image/"):
            return enclosure["href"]

    return None


def _new_entries(entries: list[dict[str, Any]], last_seen_guid: Optional[str]) -> list[dict[str, Any]]:
    """Entries not yet captured, oldest first.

    feedparser preserves feed order, and RSS/Atom feeds conventionally list
    newest entries first, so "new" means "everything before the last seen
    guid". If last_seen_guid is None (feed never polled), every current entry
    counts as new. If it no longer appears (aged out of the feed's window),
    there's no reliable way to tell what's new, so nothing is re-imported --
    the caller still advances last_seen_guid to the current newest.
    """
    if last_seen_guid is None:
        return list(reversed(entries))

    index = next((i for i, entry in enumerate(entries) if _entry_guid(entry) == last_seen_guid), None)
    if index is None:
        return []
    return list(reversed(entries[:index]))


async def poll_feed(feed: dict[str, Any], capture_fn: CaptureFn) -> None:
    """Fetch one feed and capture any entries newer than its last_seen_guid."""
    parsed = await asyncio.to_thread(feedparser.parse, feed["url"])
    entries = parsed.entries

    if not entries:
        return

    for entry in _new_entries(entries, feed["last_seen_guid"]):
        content = _entry_content(entry)
        if not content:
            continue
        post = CapturedPost(
            platform="rss",
            author=feed["label"] or entry.get("author") or None,
            content=content,
            url=entry.get("link"),
            posted_at=_entry_posted_at(entry),
            image_url=_entry_image(entry),
        )
        try:
            await asyncio.to_thread(capture_fn, post)
        except Exception:
            logger.exception("Failed to capture RSS entry from feed %s", feed["url"])

    database.update_feed_poll_state(feed["id"], last_seen_guid=_entry_guid(entries[0]))


async def poll_all_feeds(capture_fn: CaptureFn) -> None:
    for feed in database.list_feeds():
        try:
            await poll_feed(feed, capture_fn)
        except Exception:
            logger.exception("Failed to poll feed %s", feed["url"])


async def run_feed_poller(capture_fn: CaptureFn, interval_seconds: int = POLL_INTERVAL_SECONDS) -> None:
    """Runs forever, polling every subscribed feed on a fixed interval.

    Intended to be wrapped in an asyncio.Task by the caller and cancelled on
    shutdown; a CancelledError during sleep is expected and left to propagate.
    """
    while True:
        await poll_all_feeds(capture_fn)
        await asyncio.sleep(interval_seconds)
