from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

import llm_processor
from models import Deadline, ExtractionResult, MatchResult


def test_extract_post_data_delegates_to_configured_provider_with_resolved_reference_date(isolated_db):
    expected = ExtractionResult(
        summary="s",
        category="Research",
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
    fake_provider.extract.assert_called_once_with("some content", "2026-08-12", [])


def test_extract_post_data_passes_existing_categories_from_the_database(isolated_db):
    import database

    database.insert_post(platform="twitter", author=None, content="c1", url=None, captured_at="2026-08-01T00:00:00+00:00", summary="s1", tags=[], action_required=False, deadlines=[], category="Research")
    database.insert_post(platform="twitter", author=None, content="c2", url=None, captured_at="2026-08-02T00:00:00+00:00", summary="s2", tags=[], action_required=False, deadlines=[], category="Career")

    fake_provider = MagicMock()
    fake_provider.extract.return_value = ExtractionResult(summary="s", category="Research", action_required=False)

    with patch("llm_processor.get_provider", return_value=fake_provider):
        llm_processor.extract_post_data("some content", datetime(2026, 8, 12, tzinfo=timezone.utc))

    _, _, existing_categories = fake_provider.extract.call_args[0]
    assert set(existing_categories) == {"Research", "Career"}
    assert "All" not in existing_categories


def test_extract_post_data_normalizes_the_returned_category(isolated_db):
    fake_provider = MagicMock()
    fake_provider.extract.return_value = ExtractionResult(summary="s", category="Ai Tools", action_required=False)

    with patch("llm_processor.get_provider", return_value=fake_provider):
        result = llm_processor.extract_post_data("some content")

    assert result.category == "AI Tools"


def test_extract_post_data_defaults_reference_date_to_now_when_captured_at_omitted(isolated_db):
    fake_provider = MagicMock()
    fake_provider.extract.return_value = ExtractionResult(summary="s", action_required=False)

    with patch("llm_processor.get_provider", return_value=fake_provider):
        llm_processor.extract_post_data("some content")

    _, reference_date, _ = fake_provider.extract.call_args[0]
    assert reference_date == datetime.now(timezone.utc).date().isoformat()


def test_extract_post_data_propagates_provider_errors(isolated_db):
    fake_provider = MagicMock()
    fake_provider.extract.side_effect = ValueError("declined")

    with patch("llm_processor.get_provider", return_value=fake_provider):
        with pytest.raises(ValueError, match="declined"):
            llm_processor.extract_post_data("some content")


def test_calculate_match_score_delegates_to_configured_provider():
    expected = MatchResult(match_score=85, matching_skills=["Python"], missing_skills=["Docker"])
    fake_provider = MagicMock()
    fake_provider.calculate_match.return_value = expected

    with patch("llm_processor.get_provider", return_value=fake_provider) as get_provider:
        result = llm_processor.calculate_match_score("job content", "resume text")

    assert result == expected
    get_provider.assert_called_once_with()
    fake_provider.calculate_match.assert_called_once_with("job content", "resume text")


def test_calculate_match_score_propagates_provider_errors():
    fake_provider = MagicMock()
    fake_provider.calculate_match.side_effect = ValueError("declined")

    with patch("llm_processor.get_provider", return_value=fake_provider):
        with pytest.raises(ValueError, match="declined"):
            llm_processor.calculate_match_score("job content", "resume text")
