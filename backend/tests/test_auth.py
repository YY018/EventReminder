from datetime import UTC, datetime, timedelta
from uuid import uuid4

from conftest import csrf, signup_and_verify, token_from_email
from sqlalchemy import select

from app.config import Settings
from app.models import (
    AuditLog,
    AuthSession,
    EmailToken,
    Event,
    PushSubscription,
    RefreshToken,
    Reminder,
    Upload,
    User,
)


def test_signup_verification_login_and_profile(client) -> None:
    csrf_token = signup_and_verify(client)
    raw_token = token_from_email(client)
    with client.app.state.session_factory() as db:
        user = db.scalar(select(User).where(User.email == "person@example.com"))
        assert user is not None
        assert user.email_verified is True
        assert user.password_hash != "Secure$Passphrase456"
        email_token = db.scalar(select(EmailToken))
        assert email_token is not None
        assert email_token.token_hash != raw_token

    login_response = client.post(
        "/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "person@example.com", "password": "Secure$Passphrase456"},
    )
    assert login_response.status_code == 200
    response = client.post(
        "/auth/verify-email",
        headers={"X-CSRF-Token": csrf_token},
        json={"token": raw_token},
    )
    assert response.status_code == 400
    assert "event_access" in login_response.cookies
    assert "event_refresh" in login_response.cookies
    assert "httponly" in login_response.headers["set-cookie"].lower()

    response = client.get("/me")
    assert response.status_code == 200
    assert response.json()["email"] == "person@example.com"

    response = client.patch(
        "/me",
        headers={"X-CSRF-Token": csrf_token},
        json={"name": "Updated Name", "timezone": "America/New_York"},
    )
    assert response.status_code == 200
    assert response.json()["timezone"] == "America/New_York"


def test_csrf_and_profile_validation(client) -> None:
    response = client.post(
        "/auth/signup",
        json={"email": "person@example.com", "password": "Secure$Passphrase456"},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"

    csrf_token = signup_and_verify(client)
    client.post(
        "/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "person@example.com", "password": "Secure$Passphrase456"},
    )
    response = client.patch(
        "/me",
        headers={"X-CSRF-Token": csrf_token},
        json={"timezone": "Mars/Olympus"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_refresh_rotates_and_reuse_revokes_family(client) -> None:
    csrf_token = signup_and_verify(client)
    client.post(
        "/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "person@example.com", "password": "Secure$Passphrase456"},
    )
    original = client.cookies.get("event_refresh")
    assert original

    response = client.post("/auth/refresh", headers={"X-CSRF-Token": csrf_token})
    assert response.status_code == 200
    rotated = client.cookies.get("event_refresh")
    assert rotated and rotated != original

    response = client.post(
        "/auth/refresh",
        headers={"X-CSRF-Token": csrf_token},
        cookies={"event_refresh": original},
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "refresh_reuse_detected"
    assert client.get("/me").status_code == 401

    with client.app.state.session_factory() as db:
        sessions = list(db.scalars(select(AuthSession)))
        assert len(sessions) == 1
        assert sessions[0].revoked_at is not None


def test_password_reset_revokes_existing_sessions(client) -> None:
    csrf_token = signup_and_verify(client)
    client.post(
        "/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "person@example.com", "password": "Secure$Passphrase456"},
    )
    response = client.post(
        "/auth/forgot-password",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "person@example.com"},
    )
    assert response.status_code == 202
    token = token_from_email(client)
    response = client.post(
        "/auth/reset-password",
        headers={"X-CSRF-Token": csrf_token},
        json={"token": token, "new_password": "New$SecurePassphrase789"},
    )
    assert response.status_code == 200
    assert client.get("/me").status_code == 401

    response = client.post(
        "/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "person@example.com", "password": "New$SecurePassphrase789"},
    )
    assert response.status_code == 200
    response = client.post(
        "/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "person@example.com", "password": "Secure$Passphrase456"},
    )
    assert response.status_code == 401


def test_logout_all_invalidates_active_access_session(client) -> None:
    csrf_token = signup_and_verify(client)
    client.post(
        "/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "person@example.com", "password": "Secure$Passphrase456"},
    )
    assert client.get("/me").status_code == 200
    response = client.post("/auth/logout-all", headers={"X-CSRF-Token": csrf_token})
    assert response.status_code == 200
    assert client.get("/me").status_code == 401


def test_logout_revokes_current_session(client) -> None:
    csrf_token = signup_and_verify(client)
    client.post(
        "/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "person@example.com", "password": "Secure$Passphrase456"},
    )
    response = client.post("/auth/logout", headers={"X-CSRF-Token": csrf_token})
    assert response.status_code == 200
    assert client.get("/me").status_code == 401
    with client.app.state.session_factory() as db:
        auth_session = db.scalar(select(AuthSession))
        refresh_token = db.scalar(select(RefreshToken))
        assert auth_session is not None and auth_session.revoked_at is not None
        assert refresh_token is not None and refresh_token.revoked_at is not None


def test_account_deletion_cascades_and_anonymizes_audit(client) -> None:
    csrf_token = signup_and_verify(client)
    client.post(
        "/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "person@example.com", "password": "Secure$Passphrase456"},
    )
    with client.app.state.session_factory() as db:
        user = db.scalar(select(User).where(User.email == "person@example.com"))
        assert user is not None
        event = Event(
            user_id=user.id,
            title="Private event",
            start_utc=datetime.now(UTC) + timedelta(days=1),
        )
        db.add(event)
        db.flush()
        db.add_all(
            [
                Reminder(
                    event_id=event.id,
                    user_id=user.id,
                    remind_at_utc=datetime.now(UTC),
                    channel="email",
                ),
                PushSubscription(
                    user_id=user.id,
                    endpoint="https://push.example/subscription",
                    keys={"p256dh": "key", "auth": "key"},
                ),
                Upload(
                    user_id=user.id,
                    storage_key=f"{uuid4().hex}.webp",
                    media_type="image/webp",
                ),
            ]
        )
        db.commit()

    response = client.delete("/me", headers={"X-CSRF-Token": csrf_token})
    assert response.status_code == 204
    with client.app.state.session_factory() as db:
        assert db.scalar(select(User.id)) is None
        assert db.scalar(select(Event.id)) is None
        assert db.scalar(select(Reminder.id)) is None
        assert db.scalar(select(PushSubscription.id)) is None
        assert db.scalar(select(Upload.id)) is None
        deletion_log = db.scalar(select(AuditLog).where(AuditLog.action == "account_deleted"))
        assert deletion_log is not None
        assert deletion_log.user_id is None
        assert deletion_log.ip is None


def test_login_rate_limit_is_applied(client) -> None:
    csrf_token = csrf(client)
    for attempt in range(10):
        response = client.post(
            "/auth/login",
            headers={"X-CSRF-Token": csrf_token},
            json={"email": "unknown@example.com", "password": "WrongPassword456!"},
        )
        assert response.status_code == 401, attempt
    response = client.post(
        "/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "unknown@example.com", "password": "WrongPassword456!"},
    )
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "rate_limited"


def test_startup_rejects_weak_secret() -> None:
    settings = Settings(
        app_env="test",
        database_url="sqlite:///:memory:",
        app_secret="a" * 48,
    )
    try:
        settings.validate_startup()
    except RuntimeError as error:
        assert "APP_SECRET" in str(error)
    else:
        raise AssertionError("A repeated-character secret should not pass startup checks.")
