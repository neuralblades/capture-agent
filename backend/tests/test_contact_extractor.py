from contact_extractor import find_contact_email


def test_finds_email_in_content():
    assert find_contact_email("Reach me at jane.doe@example.com for details") == "jane.doe@example.com"


def test_returns_none_when_no_email_present():
    assert find_contact_email("No contact info here.") is None


def test_finds_first_of_multiple_emails():
    content = "Ping alice@example.com or bob@example.org"
    assert find_contact_email(content) == "alice@example.com"
