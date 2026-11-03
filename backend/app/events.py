from datetime import UTC, date, datetime, time, timedelta
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.auth import get_db
from app.models import Event, Reminder, User, utc_now
from app.schemas import EventBatchCreate, EventCreate, EventPatch, EventResponse
from app.security import authenticate_access, require_csrf

router = APIRouter(prefix="/events", tags=["events"])


def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def local_day_utc_bounds(day: date, timezone: ZoneInfo) -> tuple[datetime, datetime]:
    local_start = datetime.combine(day, time.min, tzinfo=timezone)
    local_end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=timezone)
    return local_start.astimezone(UTC), local_end.astimezone(UTC)


def event_response(event: Event) -> EventResponse:
    return EventResponse(
        id=event.id,
        title=event.title,
        start_utc=as_utc(event.start_utc),
        end_utc=as_utc(event.end_utc) if event.end_utc else None,
        location=event.location,
        notes=event.notes,
        source=event.source,
        status=event.status,
        reminder_lead_minutes=event.reminder_lead_minutes,
        reminder_channels=event.reminder_channels,
        created_at=as_utc(event.created_at),
        updated_at=as_utc(event.updated_at),
    )


def duplicate_event(
    db: Session,
    user_id: UUID,
    title: str,
    start_utc: datetime,
    exclude_id: UUID | None = None,
) -> Event | None:
    query = select(Event).where(
        Event.user_id == user_id,
        func.lower(Event.title) == title.casefold(),
        Event.start_utc == start_utc,
        Event.status != "cancelled",
    )
    if exclude_id is not None:
        query = query.where(Event.id != exclude_id)
    return db.scalar(query.limit(1))


def schedule_reminders(db: Session, user: User, event: Event) -> None:
    if event.status != "upcoming":
        return
    leads = (
        event.reminder_lead_minutes
        if event.reminder_lead_minutes is not None
        else user.default_reminder_leads
    )
    channels = (
        event.reminder_channels
        if event.reminder_channels is not None
        else user.notification_channels
    )
    now = utc_now()
    for lead in sorted(set(leads), reverse=True):
        remind_at = as_utc(event.start_utc) - timedelta(minutes=lead)
        if remind_at <= now:
            continue
        for channel in sorted(set(channels)):
            db.add(
                Reminder(
                    event_id=event.id,
                    user_id=user.id,
                    remind_at_utc=remind_at,
                    channel=channel,
                    lead_minutes=lead,
                )
            )


def create_event(db: Session, user: User, payload: EventCreate) -> Event:
    event = Event(
        user_id=user.id,
        title=payload.title,
        start_utc=as_utc(payload.start_at),
        end_utc=as_utc(payload.end_at) if payload.end_at else None,
        location=payload.location,
        notes=payload.notes,
        source=payload.source,
        status="upcoming",
        reminder_lead_minutes=payload.reminder_lead_minutes,
        reminder_channels=payload.reminder_channels,
    )
    db.add(event)
    db.flush()
    schedule_reminders(db, user, event)
    return event


def find_duplicates(
    db: Session, user_id: UUID, payloads: list[EventCreate]
) -> list[dict[str, str]]:
    duplicates: list[dict[str, str]] = []
    seen: set[tuple[str, datetime]] = set()
    for payload in payloads:
        start_utc = as_utc(payload.start_at)
        key = (payload.title.casefold(), start_utc)
        existing = duplicate_event(db, user_id, payload.title, start_utc)
        if existing is not None:
            duplicates.append({"event_id": str(existing.id), "title": existing.title})
        elif key in seen:
            duplicates.append({"event_id": "", "title": payload.title})
        seen.add(key)
    return duplicates


@router.post("", response_model=list[EventResponse], status_code=status.HTTP_201_CREATED)
def create_events(
    payload: EventBatchCreate, request: Request, db: Session = Depends(get_db)
) -> list[EventResponse]:
    require_csrf(request)
    user = authenticate_access(request, db)
    duplicates = find_duplicates(db, user.id, payload.events)
    if duplicates and not payload.confirm_duplicates:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "duplicate_events",
                "message": "Possible duplicate events were found. Confirm to save them anyway.",
                "duplicates": duplicates,
            },
        )
    events = [create_event(db, user, item) for item in payload.events]
    db.commit()
    return [event_response(event) for event in events]


@router.get("/today", response_model=list[EventResponse])
def get_today(request: Request, db: Session = Depends(get_db)) -> list[EventResponse]:
    user = authenticate_access(request, db)
    timezone = ZoneInfo(user.timezone)
    today = datetime.now(timezone).date()
    start_utc, end_utc = local_day_utc_bounds(today, timezone)
    events = db.scalars(
        select(Event)
        .where(
            Event.user_id == user.id,
            Event.start_utc >= start_utc,
            Event.start_utc < end_utc,
        )
        .order_by(Event.start_utc)
    )
    return [event_response(event) for event in events]


@router.get("", response_model=list[EventResponse])
def list_events(
    request: Request,
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None, alias="to"),
    q: str | None = Query(default=None, max_length=200),
    event_status: Literal["upcoming", "done", "cancelled"] | None = Query(
        default=None, alias="status"
    ),
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=10000),
    db: Session = Depends(get_db),
) -> list[EventResponse]:
    user = authenticate_access(request, db)
    if from_ is not None and from_.utcoffset() is None:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_datetime",
                "message": "The from value must include a timezone.",
            },
        )
    if to is not None and to.utcoffset() is None:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_datetime", "message": "The to value must include a timezone."},
        )
    query = select(Event).where(Event.user_id == user.id)
    if from_ is not None:
        query = query.where(Event.start_utc >= as_utc(from_))
    if to is not None:
        query = query.where(Event.start_utc <= as_utc(to))
    if q:
        query = query.where(
            func.lower(Event.title).contains(q.casefold())
            | func.lower(func.coalesce(Event.location, "")).contains(q.casefold())
            | func.lower(func.coalesce(Event.notes, "")).contains(q.casefold())
        )
    if event_status:
        query = query.where(Event.status == event_status)
    events = db.scalars(query.order_by(Event.start_utc).limit(limit).offset(offset))
    return [event_response(event) for event in events]


@router.get("/{event_id}", response_model=EventResponse)
def get_event(event_id: UUID, request: Request, db: Session = Depends(get_db)) -> EventResponse:
    user = authenticate_access(request, db)
    event = db.scalar(select(Event).where(Event.id == event_id, Event.user_id == user.id))
    if event is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "event_not_found", "message": "Event not found."},
        )
    return event_response(event)


@router.patch("/{event_id}", response_model=EventResponse)
def update_event(
    event_id: UUID,
    payload: EventPatch,
    request: Request,
    db: Session = Depends(get_db),
) -> EventResponse:
    require_csrf(request)
    user = authenticate_access(request, db)
    event = db.scalar(select(Event).where(Event.id == event_id, Event.user_id == user.id))
    if event is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "event_not_found", "message": "Event not found."},
        )
    changes = payload.model_dump(exclude_unset=True)
    start_utc = as_utc(changes.get("start_at") or event.start_utc)
    end_value = changes.get("end_at", event.end_utc)
    end_utc = as_utc(end_value) if end_value else None
    if end_utc is not None and end_utc <= start_utc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_event_time", "message": "Event end must be after its start."},
        )
    title = changes.get("title", event.title)
    if ("title" in changes or "start_at" in changes) and duplicate_event(
        db, user.id, title, start_utc, exclude_id=event.id
    ):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_event",
                "message": "A matching event already exists for this account.",
            },
        )
    for field in (
        "title",
        "location",
        "notes",
        "status",
        "reminder_lead_minutes",
        "reminder_channels",
    ):
        if field in changes:
            setattr(event, field, changes[field])
    event.start_utc = start_utc
    event.end_utc = end_utc
    event.updated_at = utc_now()
    db.execute(delete(Reminder).where(Reminder.event_id == event.id))
    schedule_reminders(db, user, event)
    db.commit()
    db.refresh(event)
    return event_response(event)


@router.delete("/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_event(event_id: UUID, request: Request, db: Session = Depends(get_db)) -> None:
    require_csrf(request)
    user = authenticate_access(request, db)
    event = db.scalar(select(Event).where(Event.id == event_id, Event.user_id == user.id))
    if event is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "event_not_found", "message": "Event not found."},
        )
    db.delete(event)
    db.commit()
