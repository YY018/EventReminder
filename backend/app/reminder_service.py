import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

import requests
from pywebpush import WebPushException, webpush
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings
from app.mailer import EmailDeliveryError, send_email
from app.models import Event, PushSubscription, Reminder, User, utc_now

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 5
CLAIM_LEASE = timedelta(minutes=5)


class ReminderDeliveryError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class DeliveryContext:
    reminder_id: UUID
    channel: str
    user_email: str
    event_title: str
    event_location: str | None
    event_start_utc: datetime
    event_id: UUID


def send_push_notifications(
    db: Session,
    user_id: UUID,
    context: DeliveryContext,
    settings: Settings,
) -> None:
    if settings.vapid_private_key is None:
        raise ReminderDeliveryError("push_not_configured")
    subscriptions = list(
        db.scalars(select(PushSubscription).where(PushSubscription.user_id == user_id))
    )
    if not subscriptions:
        raise ReminderDeliveryError("no_push_subscription")
    payload = json.dumps(
        {
            "title": "Event reminder",
            "body": context.event_title,
            "event_id": str(context.event_id),
            "start_utc": context.event_start_utc.isoformat(),
            "location": context.event_location,
        }
    )
    delivered = False
    for subscription in subscriptions:
        try:
            webpush(
                subscription_info={
                    "endpoint": subscription.endpoint,
                    "keys": subscription.keys,
                },
                data=payload,
                vapid_private_key=settings.vapid_private_key.get_secret_value(),
                vapid_claims={"sub": settings.vapid_claim_email},
            )
            delivered = True
        except WebPushException as error:
            response = getattr(error, "response", None)
            if response is not None and response.status_code in {404, 410}:
                db.delete(subscription)
                continue
            raise ReminderDeliveryError("push_delivery_failed") from None
        except requests.RequestException:
            raise ReminderDeliveryError("push_network_error") from None
    if not delivered:
        raise ReminderDeliveryError("no_active_push_subscription")


def deliver_reminder(
    db: Session,
    reminder: Reminder,
    user: User,
    event: Event,
    settings: Settings,
) -> None:
    if reminder.channel == "in_app":
        return
    context = DeliveryContext(
        reminder_id=reminder.id,
        channel=reminder.channel,
        user_email=user.email,
        event_title=event.title,
        event_location=event.location,
        event_start_utc=event.start_utc,
        event_id=event.id,
    )
    if reminder.channel == "email":
        body = f"{event.title} starts at {event.start_utc.isoformat()}."
        if event.location:
            body += f"\nLocation: {event.location}"
        try:
            send_email(settings, user.email, "Event Reminder", body)
        except EmailDeliveryError:
            raise ReminderDeliveryError("email_delivery_failed") from None
        return
    if reminder.channel == "push":
        send_push_notifications(db, user.id, context, settings)
        return
    raise ReminderDeliveryError("unsupported_reminder_channel")


def dispatch_due_reminders(
    session_factory: sessionmaker[Session],
    settings: Settings,
    now: datetime | None = None,
    deliver: Callable[[Session, Reminder, User, Event, Settings], None] = deliver_reminder,
) -> int:
    current_time = now or utc_now()
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=UTC)
    claim_deadline = current_time + CLAIM_LEASE
    with session_factory() as db:
        due = list(
            db.scalars(
                select(Reminder)
                .where(
                    Reminder.sent_at.is_(None),
                    Reminder.remind_at_utc <= current_time,
                    Reminder.attempts < MAX_ATTEMPTS,
                    or_(
                        Reminder.claim_at.is_(None),
                        Reminder.claim_at <= current_time,
                    ),
                )
                .order_by(Reminder.remind_at_utc)
                .limit(100)
                .with_for_update(skip_locked=True)
            )
        )
        ids = [reminder.id for reminder in due]
        for reminder in due:
            reminder.claim_at = claim_deadline
            reminder.attempts += 1
        db.commit()

    delivered = 0
    for reminder_id in ids:
        with session_factory() as db:
            reminder = db.scalar(
                select(Reminder).where(
                    Reminder.id == reminder_id,
                    Reminder.sent_at.is_(None),
                    Reminder.claim_at == claim_deadline,
                )
            )
            if reminder is None:
                continue
            event = db.get(Event, reminder.event_id)
            user = db.get(User, reminder.user_id)
            if event is None or user is None or event.status != "upcoming":
                reminder.sent_at = current_time
                reminder.claim_at = None
                reminder.last_error_code = "event_or_user_unavailable"
                db.commit()
                continue
            try:
                deliver(db, reminder, user, event, settings)
            except ReminderDeliveryError as error:
                reminder.last_error_code = error.code
                if reminder.attempts < MAX_ATTEMPTS:
                    retry_seconds = min(30 * (2**reminder.attempts), 1800)
                    reminder.claim_at = current_time + timedelta(seconds=retry_seconds)
                else:
                    reminder.claim_at = None
                logger.warning(
                    "reminder_delivery_failed",
                    extra={"channel": reminder.channel, "error_code": error.code},
                )
                db.commit()
                continue
            reminder.sent_at = current_time
            reminder.claim_at = None
            reminder.last_error_code = None
            db.commit()
            delivered += 1
    return delivered
