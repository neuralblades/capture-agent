import os

import pytest

os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

import database  # noqa: E402
import main  # noqa: E402


@pytest.fixture()
def isolated_db(tmp_path, monkeypatch):
    """Point database.DB_PATH at a fresh, per-test SQLite file."""
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(database, "DB_PATH", db_path)
    database.init_db()
    yield db_path


@pytest.fixture()
def client(isolated_db):
    """A TestClient wired to the isolated test database."""
    from fastapi.testclient import TestClient

    with TestClient(main.app) as test_client:
        yield test_client
