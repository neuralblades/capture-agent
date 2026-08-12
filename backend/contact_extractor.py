"""Lightweight regex-based contact email detection for captured posts.

Deliberately independent of the LLM providers: finding an email address in
raw text is deterministic and doesn't need a model call, so keeping it out of
the extraction prompt avoids touching two provider implementations for it.
"""
from __future__ import annotations

import re
from typing import Optional

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def find_contact_email(content: str) -> Optional[str]:
    """Return the first email address found in ``content``, or ``None``."""
    match = EMAIL_RE.search(content)
    return match.group(0) if match else None
