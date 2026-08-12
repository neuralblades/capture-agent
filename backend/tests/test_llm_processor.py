from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

import llm_processor
from models import Deadline, ExtractionResult


def test_extract_post_data_delegates_to_configured_provider_with_resolved_reference_date():
    expected = ExtractionResult(
        summary="s",
        tags=["t"],
        action_required=False,
        deadlines=[Deadline(text="tomorrow", iso_date="2026-08-13", confidence=0.8)],
    )
    fake_provider = MagicMock()
    fake_provider.extract.return_value = expected

    with patch("llm_processor.get_provider", return_value=fake_provider) as get_provider:
        result = llm_processor.extract_post_data(
            "some content", datetime(2026, 8, 12, tzinfo=timezone.utc)
        )

    assert result == expected
    get_provider.assert_called_once_with()
    fake_provider.extract.assert_called_once_with("some content", "2026-08-12")


def test_extract_post_data_defaults_reference_date_to_now_when_captured_at_omitted():
    fake_provider = MagicMock()
    fake_provider.extract.return_value = MagicMock()

    with patch("llm_processor.get_provider", return_value=fake_provider):
        llm_processor.extract_post_data("some content")

    _, reference_date = fake_provider.extract.call_args[0]
    assert reference_date == datetime.now(timezone.utc).date().isoformat()


def test_extract_post_data_propagates_provider_errors():
    fake_provider = MagicMock()
    fake_provider.extract.side_effect = ValueError("declined")

    with patch("llm_processor.get_provider", return_value=fake_provider):
        with pytest.raises(ValueError, match="declined"):
            llm_processor.extract_post_data("some content")
