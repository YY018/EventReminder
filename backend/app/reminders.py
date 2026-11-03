from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import get_db
from app.events import as_utc
from app.models import Event, PushSubscription, Reminder
from app.schemas import PushSubscriptionDelete, PushSubscriptionRequest, ReminderResponse
from app.security import authenticate_access, require_csrf

router = APIRouter(tags=["reminders"])


@router.get("/reminders", response_model=list[ReminderResponse])
def list_reminders(
    request: Request,
    after: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=200),
    db: Session = Depends(get_db),
) -> list[ReminderResponse]:
    user = authenticate_access(request, db)
    query = (
        select(Reminder, Event)
        .join(Event, Reminder.event_id == Event.id)
        .where(Reminder.user_id == user.id, Event.user_id == user.id)
        .order_by(Reminder.remind_at_utc.desc())
        .limit(limit)
    )
    if after is not None:
        if after.utcoffset() is None:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "invalid_datetime",
                    "message": "The after value must include a timezone.",
                },
            )
        query = query.where(Reminder.remind_at_utc >= as_utc(after))
    rows = db.execute(query)
    return [
        ReminderResponse(
            id=reminder.id,
            event_id=event.id,
            title=event.title,
            start_utc=as_utc(event.start_utc),
            location=event.location,
            remind_at_utc=as_utc(reminder.remind_at_utc),
            channel=reminder.channel,
            sent_at=as_utc(reminder.sent_at) if reminder.sent_at else None,
        )
        for reminder, event in rows
    ]


@router.post("/push/subscribe", status_code=status.HTTP_201_CREATED)
def subscribe_push(
    payload: PushSubscriptionRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, str]:
    require_csrf(request)
    user = authenticate_access(request, db)
    subscription = db.scalar(
        select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
    )
    if subscription is not None and subscription.user_id != user.id:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "subscription_conflict",
                "message": "This push subscription is already registered.",
            },
        )
    if subscription is None:
        subscription = PushSubscription(
            user_id=user.id,
            endpoint=payload.endpoint,
            keys=payload.keys.model_dump(),
            user_agent=request.headers.get("user-agent", "")[:255] or None,
        )
        db.add(subscription)
    else:
        subscription.keys = payload.keys.model_dump()
        subscription.user_agent = request.headers.get("user-agent", "")[:255] or None
    db.commit()
    return {"message": "Push notifications are enabled."}


@router.delete("/push/subscribe", status_code=status.HTTP_204_NO_CONTENT)
def unsubscribe_push(
    payload: PushSubscriptionDelete,
    request: Request,
    db: Session = Depends(get_db),
) -> None:
    require_csrf(request)
    user = authenticate_access(request, db)
    subscription = db.scalar(
        select(PushSubscription).where(
            PushSubscription.endpoint == payload.endpoint,
            PushSubscription.user_id == user.id,
        )
    )
    if subscription is not None:
        db.delete(subscription)
        db.commit()
