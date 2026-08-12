"""JARVIS action: email_drafter.

Drafts a cold email via the Claude API. Communicates with the rest of the
Capture Agent pipeline through a typed JSON contract on stdin/stdout, so it
can be invoked as a subprocess (e.g. from a native-messaging host) without a
shared Python import.

Usage:
    python email_drafter.py < request.json
    python email_drafter.py --input request.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

try:
    import anthropic
except ImportError:  # pragma: no cover - exercised via EmailDraftResult.error path
    anthropic = None

DEFAULT_MODEL = "claude-sonnet-5"
REQUIRED_FIELDS = ("recipient_name", "recipient_company", "sender_name", "purpose")


@dataclass
class EmailDraftRequest:
    recipient_name: str
    recipient_company: str
    sender_name: str
    purpose: str
    recipient_role: Optional[str] = None
    sender_company: Optional[str] = None
    key_points: list[str] = field(default_factory=list)
    tone: str = "professional"
    max_words: int = 150

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "EmailDraftRequest":
        known = {f for f in EmailDraftRequest.__dataclass_fields__}
        missing = [f for f in REQUIRED_FIELDS if not data.get(f)]
        if missing:
            raise ValueError(f"Missing required fields: {', '.join(missing)}")
        filtered = {k: v for k, v in data.items() if k in known}
        return EmailDraftRequest(**filtered)


@dataclass
class EmailDraftResult:
    success: bool
    subject: str = ""
    body: str = ""
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def build_prompt(request: EmailDraftRequest) -> str:
    points = "\n".join(f"- {p}" for p in request.key_points) or "- (none specified)"
    recipient = request.recipient_name
    if request.recipient_role:
        recipient += f" ({request.recipient_role})"
    sender = request.sender_name
    if request.sender_company:
        sender += f" at {request.sender_company}"

    return (
        f"Draft a {request.tone} cold email.\n\n"
        f"Sender: {sender}\n"
        f"Recipient: {recipient} at {request.recipient_company}\n"
        f"Purpose: {request.purpose}\n"
        f"Key points to include:\n{points}\n\n"
        "Constraints:\n"
        f"- Keep the body under {request.max_words} words.\n"
        '- Respond with ONLY a JSON object of the form {"subject": "...", "body": "..."}. '
        "No markdown, no commentary."
    )


def draft_email(
    request: EmailDraftRequest,
    *,
    api_key: Optional[str] = None,
    model: str = DEFAULT_MODEL,
) -> EmailDraftResult:
    if anthropic is None:
        return EmailDraftResult(success=False, error="anthropic package is not installed")

    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return EmailDraftResult(success=False, error="ANTHROPIC_API_KEY is not set")

    client = anthropic.Anthropic(api_key=key)
    try:
        response = client.messages.create(
            model=model,
            max_tokens=1024,
            messages=[{"role": "user", "content": build_prompt(request)}],
        )
    except Exception as exc:  # noqa: BLE001 - surface any API failure as a typed error
        return EmailDraftResult(success=False, error=str(exc))

    raw_text = "".join(
        block.text for block in response.content if getattr(block, "type", None) == "text"
    )

    try:
        parsed = json.loads(raw_text)
        subject = parsed["subject"]
        body = parsed["body"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        return EmailDraftResult(success=False, error=f"Could not parse model response as JSON: {exc}")

    return EmailDraftResult(success=True, subject=subject, body=body)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Draft a cold email via Claude.")
    parser.add_argument("--input", "-i", help="Path to a JSON request file; defaults to stdin.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Claude model id to use.")
    args = parser.parse_args(argv)

    if args.input:
        with open(args.input, "r", encoding="utf-8") as fh:
            raw = fh.read()
    else:
        raw = sys.stdin.read()

    try:
        payload = json.loads(raw)
        request = EmailDraftRequest.from_dict(payload)
    except (json.JSONDecodeError, ValueError) as exc:
        print(json.dumps(EmailDraftResult(success=False, error=str(exc)).to_dict()))
        return 1

    result = draft_email(request, model=args.model)
    print(json.dumps(result.to_dict()))
    return 0 if result.success else 1


if __name__ == "__main__":
    sys.exit(main())
