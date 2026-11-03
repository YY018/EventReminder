from datetime import UTC, datetime, timedelta

from conftest import signup_and_verify
from sqlalchemy import select

from app.models import Event, Reminder, User, utc_now
from app.reminder_service import ReminderDeliveryError, dispatch_due_reminders


def create_user(client) -> User:
    signup_and_verify(client, "reminder-owner@example.com")
    with client.app.state.session_factory() as db:
        user = db.scalar(select(User).where(User.email == "reminder-owner@example.com"))
        assert user is not None
        return user


def test_due_reminders_are_claimed_and_sent_once(client) -> None:
    user = create_user(client)
    now = datetime.now(UTC).replace(microsecond=0)
    with client.app.state.session_factory() as db:
        event = Event(
            user_id=user.id,
            title="Soon",
            start_utc=now + timedelta(minutes=10),
            status="upcoming",
        )
        db.add(event)
        db.flush()
        db.add(
            Reminder(
                event_id=event.id,
                user_id=user.id,
                remind_at_utc=now - timedelta(minutes=1),
                channel="in_app",
                lead_minutes=15,
            )
        )
        db.commit()

    delivered: list[str] = []

    def deliver(_db, reminder, _user, _event, _settings) -> None:
        delivered.append(str(reminder.id))

    settings = client.app.state.settings
    assert (
        dispatch_due_reminders(client.app.state.session_factory, settings, now=now, deliver=deliver)
        == 1
    )
    assert (
        dispatch_due_reminders(client.app.state.session_factory, settings, now=now, deliver=deliver)
        == 0
    )
    assert len(delivered) == 1
    with client.app.state.session_factory() as db:
        reminder = db.scalar(select(Reminder))
        assert reminder is not None
        assert reminder.sent_at is not None
        assert reminder.attempts == 1


def test_reminder_delivery_failure_retries_after_backoff(client) -> None:
    user = create_user(client)
    now = utc_now().replace(microsecond=0)
    with client.app.state.session_factory() as db:
        event = Event(
            user_id=user.id,
            title="Retry me",
            start_utc=now + timedelta(hours=1),
            status="upcoming",
        )
        db.add(event)
        db.flush()
        db.add(
            Reminder(
                event_id=event.id,
                user_id=user.id,
                remind_at_utc=now - timedelta(seconds=1),
                channel="in_app",
                lead_minutes=15,
            )
        )
        db.commit()

    def fail(_db, _reminder, _user, _event, _settings) -> None:
        raise ReminderDeliveryError("temporary_failure")

    settings = client.app.state.settings
    assert (
        dispatch_due_reminders(client.app.state.session_factory, settings, now=now, deliver=fail)
        == 0
    )
    with client.app.state.session_factory() as db:
        reminder = db.scalar(select(Reminder))
        assert reminder is not None
        assert reminder.sent_at is None
        assert reminder.claim_at is not None
        assert reminder.last_error_code == "temporary_failure"
        assert reminder.attempts == 1

    assert (
        dispatch_due_reminders(
            client.app.state.session_factory,
            settings,
            now=now + timedelta(seconds=61),
            deliver=lambda *_args: None,
        )
        == 1
    )
    with client.app.state.session_factory() as db:
        reminder = db.scalar(select(Reminder))
        assert reminder is not None
        assert reminder.sent_at is not None
        assert reminder.attempts == 2
