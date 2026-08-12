"""Cold outreach email generation via Groq's Llama 3.3 70B.

Separate from providers/ since it produces a subject/body draft rather than
the ExtractionResult shape the LLMProvider adapter interface is built around.
"""
from __future__ import annotations

import json
import os
from typing import Optional

from groq import Groq
from pydantic import ValidationError

from models import GeneratedEmail

MODEL = "llama-3.3-70b-versatile"

SYSTEM_PROMPT = """You write concise, high-converting cold outreach emails on behalf of a user, based on a social media post they captured and want to follow up on.

Guidelines:
- Reference something specific and genuine from the post so the email doesn't read as generic.
- Keep the tone professional and warm, never pushy or salesy.
- Keep the body under 150 words.
- End with a single, clear, low-friction call to action.

Respond with ONLY a single JSON object (no surrounding text or markdown) of this shape:
{"subject": string, "body": string}"""

_client: Groq | None = None


def get_client() -> Groq:
    """Lazily construct the client so import-time errors don't break tooling."""
    global _client
    if _client is None:
        _client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
    return _client


def build_user_prompt(
    *,
    content: str,
    recipient_email: str,
    sender_name: Optional[str],
    sender_company: Optional[str],
) -> str:
    sender = sender_name or "the sender"
    if sender_company:
        sender += f" at {sender_company}"

    return (
        f"Captured post:\n{content}\n\n"
        f"Recipient email: {recipient_email}\n"
        f"Sender: {sender}\n\n"
        "Draft the cold email now."
    )


def generate_cold_email(
    *,
    content: str,
    recipient_email: str,
    sender_name: Optional[str] = None,
    sender_company: Optional[str] = None,
) -> GeneratedEmail:
    response = get_client().chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": build_user_prompt(
                    content=content,
                    recipient_email=recipient_email,
                    sender_name=sender_name,
                    sender_company=sender_company,
                ),
            },
        ],
        response_format={"type": "json_object"},
    )

    choice = response.choices[0]
    if choice.finish_reason == "content_filter":
        raise ValueError("Groq declined to draft this email")

    raw = choice.message.content
    if not raw:
        raise ValueError("Groq did not return a parseable email")

    try:
        return GeneratedEmail.model_validate(json.loads(raw))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise ValueError("Groq did not return a parseable email") from exc
