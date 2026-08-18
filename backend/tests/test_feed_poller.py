import asyncio
import time
from types import SimpleNamespace
from unittest.mock import patch

import database
import feed_poller
from models import CapturedPost, PostRecord


def _entry(guid, *, title="Entry", summary="Entry content", link=None, author=None, published_parsed=None):
    entry = {"id": guid, "title": title, "summary": summary}
    if link is not None:
        entry["link"] = link
    if author is not None:
        entry["author"] = author
    if published_parsed is not None:
        entry["published_parsed"] = published_parsed
    return entry


def _fake_parse(entries):
    return SimpleNamespace(entries=entries)


class RecordingCapture:
    """Stand-in for main.capture_post that records what it was called with."""

    def __init__(self):
        self.calls: list[CapturedPost] = []

    def __call__(self, post: CapturedPost) -> PostRecord:
        self.calls.append(post)
        return PostRecord(
            id=len(self.calls),
            platform=post.platform,
            author=post.author,
            content=post.content,
            url=post.url,
            captured_at="2026-08-15T00:00:00+00:00",
            summary="summary",
            category="General",
            tags=[],
            action_required=False,
            deadlines=[],
            posted_at=post.posted_at.isoformat() if post.posted_at else None,
            created_at="2026-08-15T00:00:00+00:00",
        )


def test_poll_feed_captures_all_entries_on_first_poll_oldest_first(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")
    feed = database.get_feed(feed_id)

    # feedparser convention: newest entry first.
    entries = [_entry("guid-2", title="Newest"), _entry("guid-1", title="Oldest")]
    capture = RecordingCapture()

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse(entries)):
        asyncio.run(feed_poller.poll_feed(feed, capture))

    assert len(capture.calls) == 2
    assert [c.author for c in capture.calls] == ["Example Blog", "Example Blog"]

    updated = database.get_feed(feed_id)
    assert updated["last_seen_guid"] == "guid-2"
    assert updated["last_checked_at"] is not None


def test_poll_feed_only_captures_entries_newer_than_last_seen_guid(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")
    database.update_feed_poll_state(feed_id, last_seen_guid="guid-1")
    feed = database.get_feed(feed_id)

    entries = [_entry("guid-3", title="Third"), _entry("guid-2", title="Second"), _entry("guid-1", title="First")]
    capture = RecordingCapture()

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse(entries)):
        asyncio.run(feed_poller.poll_feed(feed, capture))

    assert len(capture.calls) == 2
    assert database.get_feed(feed_id)["last_seen_guid"] == "guid-3"


def test_poll_feed_does_not_recapture_when_no_new_entries(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")
    database.update_feed_poll_state(feed_id, last_seen_guid="guid-1")
    feed = database.get_feed(feed_id)

    entries = [_entry("guid-1", title="Only")]
    capture = RecordingCapture()

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse(entries)):
        asyncio.run(feed_poller.poll_feed(feed, capture))

    assert capture.calls == []
    assert database.get_feed(feed_id)["last_seen_guid"] == "guid-1"


def test_poll_feed_skips_when_last_seen_guid_no_longer_in_feed(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")
    database.update_feed_poll_state(feed_id, last_seen_guid="guid-rotated-out")
    feed = database.get_feed(feed_id)

    entries = [_entry("guid-5", title="Current")]
    capture = RecordingCapture()

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse(entries)):
        asyncio.run(feed_poller.poll_feed(feed, capture))

    # Can't tell what's new when the bookmark fell out of the feed window, so
    # nothing is (re-)imported, but the bookmark still advances to current.
    assert capture.calls == []
    assert database.get_feed(feed_id)["last_seen_guid"] == "guid-5"


def test_poll_feed_handles_empty_feed(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")
    feed = database.get_feed(feed_id)
    capture = RecordingCapture()

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse([])):
        asyncio.run(feed_poller.poll_feed(feed, capture))

    assert capture.calls == []
    # No entries to derive a newest guid from, so polling state is untouched.
    assert database.get_feed(feed_id)["last_seen_guid"] is None


def test_poll_feed_skips_entries_with_no_content(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")
    feed = database.get_feed(feed_id)

    entries = [{"id": "guid-1", "title": "", "summary": ""}]
    capture = RecordingCapture()

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse(entries)):
        asyncio.run(feed_poller.poll_feed(feed, capture))

    assert capture.calls == []
    assert database.get_feed(feed_id)["last_seen_guid"] == "guid-1"


def test_poll_feed_uses_entry_author_when_feed_has_no_label(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label=None)
    feed = database.get_feed(feed_id)

    entries = [_entry("guid-1", author="Jane Writer")]
    capture = RecordingCapture()

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse(entries)):
        asyncio.run(feed_poller.poll_feed(feed, capture))

    assert capture.calls[0].author == "Jane Writer"


def test_poll_feed_sets_rss_platform_and_link_url(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")
    feed = database.get_feed(feed_id)

    entries = [_entry("guid-1", link="https://blog.example.com/posts/1")]
    capture = RecordingCapture()

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse(entries)):
        asyncio.run(feed_poller.poll_feed(feed, capture))

    captured = capture.calls[0]
    assert captured.platform == "rss"
    assert captured.url == "https://blog.example.com/posts/1"


def test_poll_feed_resolves_posted_at_from_published_parsed(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")
    feed = database.get_feed(feed_id)

    published = time.struct_time((2026, 8, 10, 9, 0, 0, 0, 0, 0))
    entries = [_entry("guid-1", published_parsed=published)]
    capture = RecordingCapture()

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse(entries)):
        asyncio.run(feed_poller.poll_feed(feed, capture))

    posted_at = capture.calls[0].posted_at
    assert posted_at is not None
    assert (posted_at.year, posted_at.month, posted_at.day) == (2026, 8, 10)


def test_entry_content_combines_title_and_summary():
    entry = {"title": "Real Headline", "summary": "Extra detail"}
    assert feed_poller._entry_content(entry) == "Real Headline\n\nExtra detail"


def test_entry_content_title_only():
    entry = {"title": "Real Headline", "summary": ""}
    assert feed_poller._entry_content(entry) == "Real Headline"


def test_entry_content_summary_only():
    entry = {"title": "", "summary": "Extra detail"}
    assert feed_poller._entry_content(entry) == "Extra detail"


def test_entry_content_both_empty():
    entry = {"title": "", "summary": ""}
    assert feed_poller._entry_content(entry) == ""


def test_entry_content_strips_html_from_summary():
    entry = {"title": "Real Headline", "summary": "<p>Extra <b>detail</b> &amp; more</p>"}
    assert feed_poller._entry_content(entry) == "Real Headline\n\nExtra  detail  & more"


def test_poll_feed_uses_title_when_summary_is_boilerplate(isolated_db):
    feed_id = database.add_feed(url="https://news.example.com/feed.xml", label="HN")
    feed = database.get_feed(feed_id)

    entries = [_entry("guid-1", title="Real Headline About Something", summary="Comments")]
    capture = RecordingCapture()

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse(entries)):
        asyncio.run(feed_poller.poll_feed(feed, capture))

    assert capture.calls[0].content == "Real Headline About Something\n\nComments"


def test_entry_image_returns_none_when_no_media_present():
    entry = {"title": "Plain entry", "summary": "no media here"}
    assert feed_poller._entry_image(entry) is None


def test_entry_image_prefers_media_thumbnail():
    entry = {
        "media_thumbnail": [{"url": "https://example.com/thumb.jpg"}],
        "media_content": [{"url": "https://example.com/content.jpg", "medium": "image"}],
    }
    assert feed_poller._entry_image(entry) == "https://example.com/thumb.jpg"


def test_entry_image_falls_back_to_media_content_typed_as_image():
    entry = {"media_content": [{"url": "https://example.com/content.jpg", "medium": "image"}]}
    assert feed_poller._entry_image(entry) == "https://example.com/content.jpg"


def test_entry_image_ignores_non_image_media_content():
    entry = {"media_content": [{"url": "https://example.com/clip.mp4", "medium": "video"}]}
    assert feed_poller._entry_image(entry) is None


def test_entry_image_falls_back_to_image_enclosure():
    entry = {"enclosures": [{"href": "https://example.com/photo.png", "type": "image/png"}]}
    assert feed_poller._entry_image(entry) == "https://example.com/photo.png"


def test_entry_image_ignores_non_image_enclosure():
    entry = {"enclosures": [{"href": "https://example.com/episode.mp3", "type": "audio/mpeg"}]}
    assert feed_poller._entry_image(entry) is None


def test_poll_feed_captures_entry_image_url(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")
    feed = database.get_feed(feed_id)

    entry = _entry("guid-1")
    entry["media_thumbnail"] = [{"url": "https://example.com/thumb.jpg"}]
    capture = RecordingCapture()

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse([entry])):
        asyncio.run(feed_poller.poll_feed(feed, capture))

    assert capture.calls[0].image_url == "https://example.com/thumb.jpg"


def test_poll_all_feeds_polls_every_subscribed_feed(isolated_db):
    database.add_feed(url="https://a.example.com/feed.xml", label="A")
    database.add_feed(url="https://b.example.com/feed.xml", label="B")

    entries = [_entry("guid-1")]
    capture = RecordingCapture()

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse(entries)):
        asyncio.run(feed_poller.poll_all_feeds(capture))

    assert len(capture.calls) == 2
    assert {c.author for c in capture.calls} == {"A", "B"}


def test_poll_all_feeds_continues_after_one_feed_fails(isolated_db):
    database.add_feed(url="https://broken.example.com/feed.xml", label="Broken")
    database.add_feed(url="https://ok.example.com/feed.xml", label="OK")

    entries = [_entry("guid-1")]
    capture = RecordingCapture()

    def fake_parse(url):
        if "broken" in url:
            raise RuntimeError("network error")
        return _fake_parse(entries)

    with patch("feed_poller.feedparser.parse", side_effect=fake_parse):
        asyncio.run(feed_poller.poll_all_feeds(capture))

    assert len(capture.calls) == 1
    assert capture.calls[0].author == "OK"


def test_poll_feed_continues_after_capture_fn_raises_and_still_advances_bookmark(isolated_db):
    feed_id = database.add_feed(url="https://blog.example.com/feed.xml", label="Example Blog")
    feed = database.get_feed(feed_id)

    entries = [_entry("guid-2", title="Newest"), _entry("guid-1", title="Oldest")]
    calls = []

    def always_fails(post):
        calls.append(post)
        raise RuntimeError("boom")

    with patch("feed_poller.feedparser.parse", return_value=_fake_parse(entries)):
        asyncio.run(feed_poller.poll_feed(feed, always_fails))

    # Both entries attempted despite each raising; poll state still advances.
    assert len(calls) == 2
    assert database.get_feed(feed_id)["last_seen_guid"] == "guid-2"
