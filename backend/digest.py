"""Ranked, newspaper-styled digest generation (issue #73).

Turns stored posts into a periodic "front page" + "inside pages" digest,
manually triggered via GET /digest and GET /digest.pdf in main.py. Ranking is
an explicit, tunable formula (see hotness_score()) -- not an LLM judgment
call -- consistent with how resurfacing (issue #66) was scoped rule-based
rather than "AI decides".
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from jinja2 import Environment, FileSystemLoader, select_autoescape

TEMPLATES_DIR = Path(__file__).parent / "templates"

_env = Environment(
    loader=FileSystemLoader(TEMPLATES_DIR),
    autoescape=select_autoescape(["html", "jinja2"]),
)

# --- Hotness score, v1 ---------------------------------------------------
#
#   hotness = RECENCY_WEIGHT  * recency_component(post)
#           + MATCH_WEIGHT    * match_component(post)
#           + DEADLINE_WEIGHT * deadline_component(post)
#
# Each component is independently normalized to [0, 1], so a weight below is
# directly the max contribution its signal can make to the total (weights
# sum to 1, so hotness itself is always in [0, 1]). Tune ranking behavior by
# editing the constants in this section -- no ML, no hidden heuristics.
RECENCY_WEIGHT = 0.5
MATCH_WEIGHT = 0.3
DEADLINE_WEIGHT = 0.2

# Recency component: exponential decay by this half-life. A post exactly
# this many hours old scores 0.5; twice as old scores 0.25; and so on.
RECENCY_HALF_LIFE_HOURS = 48.0

# Deadline component: proximity ramps linearly from 1.0 (deadline is right
# now) down to 0.0 at this many days out. A deadline further away than this,
# or already passed, contributes nothing.
DEADLINE_HORIZON_DAYS = 14.0

# How many top-ranked items lead the front page, and how many inside-page
# entries share one printed/scrolled "page" section. Overridable per call.
DEFAULT_FRONT_PAGE_SIZE = 5
ITEMS_PER_INSIDE_PAGE = 10

# Mirrors extension/sidepanel/sidepanel.js's PLATFORM_LABELS -- kept as a
# separate copy since the two run in different languages/processes and
# nothing currently shares contracts.js-style definitions across that
# boundary; if platform values change, both need updating.
PLATFORM_LABELS = {
    "twitter": "X",
    "linkedin": "LinkedIn",
    "web_selection": "Web",
    "rss": "RSS",
    "github": "GitHub",
}


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _recency_component(post: dict[str, Any], now: datetime) -> float:
    """Newer wins. Anchored to posted_at (when the source content itself went
    live) falling back to captured_at (when the user grabbed it) when
    posted_at is unknown -- both answer "how old is this", just from
    different signals depending on what the source exposed."""
    anchor = _parse_iso(post.get("posted_at")) or _parse_iso(post.get("captured_at"))
    if anchor is None:
        return 0.0
    age_hours = max(0.0, (now - anchor).total_seconds() / 3600)
    return 0.5 ** (age_hours / RECENCY_HALF_LIFE_HOURS)


def _match_component(post: dict[str, Any]) -> float:
    """Resume-match score, only meaningful for opportunity posts already
    scored via POST /calculate-match. Zero -- not "unknown" -- for anything
    else, so an un-scored or non-opportunity post simply gets no boost here
    rather than skewing the average."""
    if not post.get("is_opportunity"):
        return 0.0
    score = post.get("match_score")
    if score is None:
        return 0.0
    return max(0.0, min(100.0, float(score))) / 100


def _earliest_deadline(post: dict[str, Any]) -> Optional[dict[str, Any]]:
    """The soonest deadline with a resolved iso_date, if any. Deadlines with
    no resolved date (confidence too low to pin an absolute day) can't be
    compared by proximity, so they're skipped here."""
    earliest: Optional[dict[str, Any]] = None
    earliest_dt: Optional[datetime] = None
    for deadline in post.get("deadlines") or []:
        if not isinstance(deadline, dict):
            continue
        parsed = _parse_iso(deadline.get("iso_date"))
        if parsed is None:
            continue
        if earliest_dt is None or parsed < earliest_dt:
            earliest_dt = parsed
            earliest = deadline
    return earliest


def _deadline_component(post: dict[str, Any], now: datetime) -> float:
    """Closer deadlines are hotter. Already-passed deadlines, or ones further
    out than DEADLINE_HORIZON_DAYS, contribute nothing; in between, the
    contribution ramps up linearly as the deadline approaches."""
    deadline = _earliest_deadline(post)
    if deadline is None:
        return 0.0
    deadline_dt = _parse_iso(deadline.get("iso_date"))
    if deadline_dt is None:
        return 0.0
    days_until = (deadline_dt - now).total_seconds() / 86400
    if days_until < 0 or days_until > DEADLINE_HORIZON_DAYS:
        return 0.0
    return 1 - (days_until / DEADLINE_HORIZON_DAYS)


def hotness_score(post: dict[str, Any], now: Optional[datetime] = None) -> float:
    """Explicit, tunable "hotness" score in [0, 1]. See the weighted formula
    and per-signal constants at the top of this module -- adjust ranking
    behavior there, not by touching this function."""
    now = now or datetime.now(timezone.utc)
    return (
        RECENCY_WEIGHT * _recency_component(post, now)
        + MATCH_WEIGHT * _match_component(post)
        + DEADLINE_WEIGHT * _deadline_component(post, now)
    )


def _safe_image_url(url: Any) -> Optional[str]:
    """Only ever render an http(s) image URL -- a null/missing image_url (the
    common case pre-issue-#72, and any source without one after it) must
    degrade to the text-only treatment rather than a broken <img>, and a
    non-http(s) scheme is rejected outright rather than trusted into an
    img src."""
    if not isinstance(url, str):
        return None
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return None


def _excerpt(content: Optional[str], max_len: int = 180) -> str:
    text = (content or "").strip()
    if len(text) <= max_len:
        return text
    return text[:max_len].rsplit(" ", 1)[0] + "…"


def _enrich(post: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Adds display-ready fields the template reads directly, so ranking
    logic and rendering logic stay decoupled -- the template never re-derives
    a kicker or excerpt itself."""
    enriched = dict(post)
    platform = post.get("platform")
    deadline = _earliest_deadline(post)
    enriched["_hotness"] = hotness_score(post, now)
    enriched["_kicker"] = (post.get("category") or PLATFORM_LABELS.get(platform, platform) or "").upper()
    enriched["_platform_label"] = PLATFORM_LABELS.get(platform, platform)
    enriched["_headline"] = post.get("summary") or _excerpt(post.get("content"), max_len=120)
    enriched["_excerpt"] = _excerpt(post.get("content"))
    enriched["_deadline_text"] = deadline.get("text") if deadline else None
    enriched["_image_url"] = _safe_image_url(post.get("image_url"))
    return enriched


def rank_posts(posts: list[dict[str, Any]], now: Optional[datetime] = None) -> list[dict[str, Any]]:
    """Posts ordered highest-hotness-first, each enriched with the `_hotness`,
    `_kicker`, etc. fields _enrich() adds. Ties are broken by id descending
    (newest capture first) for a stable, deterministic order."""
    now = now or datetime.now(timezone.utc)
    enriched = [_enrich(post, now) for post in posts]
    enriched.sort(key=lambda p: (p["_hotness"], p.get("id") or 0), reverse=True)
    return enriched


def _chunk(items: list[Any], size: int) -> list[list[Any]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def build_digest(
    posts: list[dict[str, Any]],
    *,
    now: Optional[datetime] = None,
    front_page_size: int = DEFAULT_FRONT_PAGE_SIZE,
) -> dict[str, Any]:
    """Splits ranked posts into a front page (top N, hero treatment where an
    image is available) and inside pages (the rest, chunked into a dense
    list per page)."""
    now = now or datetime.now(timezone.utc)
    ranked = rank_posts(posts, now)
    return {
        "generated_at": now,
        "front_page": ranked[:front_page_size],
        "inside_page_chunks": _chunk(ranked[front_page_size:], ITEMS_PER_INSIDE_PAGE),
    }


def render_digest_html(
    posts: list[dict[str, Any]],
    *,
    now: Optional[datetime] = None,
    front_page_size: int = DEFAULT_FRONT_PAGE_SIZE,
) -> str:
    now = now or datetime.now(timezone.utc)
    digest = build_digest(posts, now=now, front_page_size=front_page_size)
    template = _env.get_template("digest.html.jinja2")
    # %-d (no leading zero) is a glibc/BSD strftime extension, not portable
    # to Windows -- build the "day" part without a format-flag dependency.
    date_label = f"{now:%A, %B} {now.day}, {now:%Y}"
    return template.render(title="Capture Agent", date_label=date_label, **digest)


def render_digest_pdf(html: str) -> bytes:
    """Converts a rendered digest HTML string to PDF via WeasyPrint -- a pure
    Python renderer with real CSS print support (page breaks, multi-page
    flow via the @page/page-break rules in digest.html.jinja2), no
    headless-browser dependency needed. Imported lazily so importing this
    module (and rendering the HTML edition) doesn't require WeasyPrint's
    native deps (Pango/cairo/GDK-Pixbuf) to be installed."""
    from weasyprint import HTML

    return HTML(string=html).write_pdf()
