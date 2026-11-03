import re
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.db import Base
from app.main import create_app


@pytest.fixture
def client(tmp_path) -> Iterator[TestClient]:
    sent_emails: list[tuple[str, str, str]] = []

    def email_sender(_settings: Settings, recipient: str, subject: str, body: str) -> None:
        sent_emails.append((recipient, subject, body))

    settings = Settings(
        app_env="test",
        database_url="sqlite:///:memory:",
        app_secret=SecretStr("J3p!0OklYdgPq1wXc9ZtHVrF8AbEsu2LmN4Qw6Ty"),
        frontend_origin="http://testserver",
        upload_dir=str(tmp_path / "private-uploads"),
    )
    application = create_app(settings=settings, email_sender=email_sender)
    application.state.sent_emails = sent_emails
    Base.metadata.create_all(application.state.engine)
    with TestClient(application) as test_client:
        yield test_client
    Base.metadata.drop_all(application.state.engine)
    application.state.engine.dispose()


def csrf(client: TestClient) -> str:
    response = client.get("/auth/csrf")
    assert response.status_code == 200
    return response.json()["csrf_token"]


def token_from_email(client: TestClient, email_index: int = -1) -> str:
    body = client.app.state.sent_emails[email_index][2]
    match = re.search(r"token=([\w-]+)", body)
    assert match is not None
    return match.group(1)


def signup_and_verify(client: TestClient, email: str = "person@example.com") -> str:
    csrf_token = csrf(client)
    response = client.post(
        "/auth/signup",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": email, "password": "Secure$Passphrase456", "name": "Event Person"},
    )
    assert response.status_code == 202
    token = token_from_email(client)
    response = client.post(
        "/auth/verify-email",
        headers={"X-CSRF-Token": csrf_token},
        json={"token": token},
    )
    assert response.status_code == 200
    return csrf_token
