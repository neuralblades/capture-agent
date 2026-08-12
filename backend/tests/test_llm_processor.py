from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

import llm_processor
from models import Deadline, ExtractionResult


def _fake_response(parsed_output=None, stop_reason="end_turn"):
    resp = MagicMock()
    resp.parsed_output = parsed_output
    resp.stop_reason = stop_reason
    return resp


def test_extract_post_data_returns_parsed_output_and_resolves_reference_date():
    expected = ExtractionResult(
        summary="s",
        tags=["t"],
        action_required=False,
        deadlines=[Deadline(text="tomorrow", iso_date="2026-08-13", confidence=0.8)],
    )
    fake_client = MagicMock()
    fake_client.messages.parse.return_value = _fake_response(parsed_output=expected)

    with patch("llm_processor.get_client", return_value=fake_client):
        result = llm_processor.extract_post_data(
            "some content", datetime(2026, 8, 12, tzinfo=timezone.utc)
        )

    assert result == expected
    _, kwargs = fake_client.messages.parse.call_args
    assert kwargs["model"] == "claude-opus-5"
    assert "2026-08-12" in kwargs["system"]
    assert kwargs["output_format"] is ExtractionResult


def test_extract_post_data_raises_on_refusal():
    fake_client = MagicMock()
    fake_client.messages.parse.return_value = _fake_response(stop_reason="refusal")

    with patch("llm_processor.get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="declined"):
            llm_processor.extract_post_data("some content")


def test_extract_post_data_raises_when_unparsed():
    fake_client = MagicMock()
    fake_client.messages.parse.return_value = _fake_response(parsed_output=None)

    with patch("llm_processor.get_client", return_value=fake_client):
        with pytest.raises(ValueError, match="parseable"):
            llm_processor.extract_post_data("some content")
