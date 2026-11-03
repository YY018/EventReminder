import base64
import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import audit, get_db
from app.config import Settings
from app.events import as_utc
from app.image_uploads import uploads_for_user
from app.models import AuditLog, AuthSession, Event, PushSubscription, Reminder, Upload
from app.security import authenticate_access

router = APIRouter(tags=["exports", "uploads"])


def private_upload_path(settings: Settings, storage_key: str) -> Path:
    root = Path(settings.upload_dir).resolve()
    path = (root / storage_key).resolve()
    if path.parent != root:
        raise RuntimeError("Upload storage path escaped its private directory.")
    return path


def ical_escape(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
        .replace(",", "\\,")
        .replace(";", "\\;")
    )


def fold_ical_line(line: str) -> list[str]:
    remaining = line.encode("utf-8")
    result: list[str] = []
    first = True
    while len(remaining) > (75 if first else 74):
        limit = 75 if first else 74
        cut = limit
        while cut > 0 and cut < len(remaining) and remaining[cut] & 0xC0 == 0x80:
            cut -= 1
        result.append(remaining[:cut].decode("utf-8"))
        remaining = remaining[cut:]
        first = False
    if not first:
        result.append(" " + remaining.decode("utf-8"))
    else:
        result.append(remaining.decode("utf-8"))
    return result


def ical_event(event: Event) -> list[str]:
    lines = [
        "BEGIN:VEVENT",
        f"UID:{event.id}@event-reminder",
        f"DTSTAMP:{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}",
        f"DTSTART:{as_utc(event.start_utc).strftime('%Y%m%dT%H%M%SZ')}",
        f"SUMMARY:{ical_escape(event.title)}",
        f"STATUS:{'CANCELLED' if event.status == 'cancelled' else 'CONFIRMED'}",
    ]
    if event.end_utc:
        lines.append(f"DTEND:{as_utc(event.end_utc).strftime('%Y%m%dT%H%M%SZ')}")
    if event.location:
        lines.append(f"LOCATION:{ical_escape(event.location)}")
    if event.notes:
        lines.append(f"DESCRIPTION:{ical_escape(event.notes)}")
    lines.append("END:VEVENT")
    return lines


@router.get("/export/ics")
def export_ics(request: Request, db: Session = Depends(get_db)) -> StreamingResponse:
    user = authenticate_access(request, db)
    events = list(
        db.scalars(select(Event).where(Event.user_id == user.id).order_by(Event.start_utc))
    )
    audit(request, db, "export_ics", user.id)
    db.commit()
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Event Reminder//EN", "CALSCALE:GREGORIAN"]
    for event in events:
        lines.extend(ical_event(event))
    lines.append("END:VCALENDAR")
    body = "\r\n".join(folded for line in lines for folded in fold_ical_line(line)) + "\r\n"
    return StreamingResponse(
        iter([body]),
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="event-reminder.ics"'},
    )


@router.get("/export/json")
def export_json(request: Request, db: Session = Depends(get_db)) -> StreamingResponse:
    user = authenticate_access(request, db)
    audit(request, db, "export_json", user.id)
    db.commit()
    events = list(
        db.scalars(select(Event).where(Event.user_id == user.id).order_by(Event.start_utc))
    )
    reminders = list(
        db.scalars(
            select(Reminder).where(Reminder.user_id == user.id).order_by(Reminder.remind_at_utc)
        )
    )
    sessions = list(
        db.scalars(
            select(AuthSession)
            .where(AuthSession.user_id == user.id)
            .order_by(AuthSession.created_at)
        )
    )
    subscriptions = list(
        db.scalars(select(PushSubscription).where(PushSubscription.user_id == user.id))
    )
    audit_records = list(
        db.scalars(select(AuditLog).where(AuditLog.user_id == user.id).order_by(AuditLog.timestamp))
    )
    uploads = uploads_for_user(db, user.id)
    for upload in uploads:
        if not private_upload_path(request.app.state.settings, upload.storage_key).is_file():
            raise HTTPException(
                status_code=410,
                detail={
                    "code": "upload_unavailable",
                    "message": "A retained upload is missing; retry after restoring it.",
                },
            )
    profile = {
        "id": str(user.id),
        "email": user.email,
        "name": user.name,
        "email_verified": user.email_verified,
        "timezone": user.timezone,
        "default_reminder_leads": user.default_reminder_leads,
        "notification_channels": user.notification_channels,
        "created_at": as_utc(user.created_at).isoformat(),
    }
    event_data = [
        {
            "id": str(event.id),
            "title": event.title,
            "start_utc": as_utc(event.start_utc).isoformat(),
            "end_utc": as_utc(event.end_utc).isoformat() if event.end_utc else None,
            "location": event.location,
            "notes": event.notes,
            "source": event.source,
            "status": event.status,
            "reminder_lead_minutes": event.reminder_lead_minutes,
            "reminder_channels": event.reminder_channels,
            "created_at": as_utc(event.created_at).isoformat(),
            "updated_at": as_utc(event.updated_at).isoformat(),
        }
        for event in events
    ]
    reminder_data = [
        {
            "id": str(reminder.id),
            "event_id": str(reminder.event_id),
            "remind_at_utc": as_utc(reminder.remind_at_utc).isoformat(),
            "channel": reminder.channel,
            "lead_minutes": reminder.lead_minutes,
            "sent_at": as_utc(reminder.sent_at).isoformat() if reminder.sent_at else None,
            "attempts": reminder.attempts,
            "last_error_code": reminder.last_error_code,
        }
        for reminder in reminders
    ]
    session_data = [
        {
            "id": str(session.id),
            "device_info": session.device_info,
            "created_at": as_utc(session.created_at).isoformat(),
            "expires_at": as_utc(session.expires_at).isoformat(),
            "revoked_at": as_utc(session.revoked_at).isoformat() if session.revoked_at else None,
        }
        for session in sessions
    ]
    push_data = [
        {
            "endpoint": subscription.endpoint,
            "keys": subscription.keys,
            "user_agent": subscription.user_agent,
        }
        for subscription in subscriptions
    ]
    audit_data = [
        {
            "action": record.action,
            "ip": record.ip,
            "user_agent": record.user_agent,
            "timestamp": as_utc(record.timestamp).isoformat(),
        }
        for record in audit_records
    ]
    settings: Settings = request.app.state.settings

    def generate():
        yield '{"profile":'
        yield json.dumps(profile, ensure_ascii=False)
        yield ',"events":'
        yield json.dumps(event_data, ensure_ascii=False)
        yield ',"reminders":'
        yield json.dumps(reminder_data, ensure_ascii=False)
        yield ',"sessions":'
        yield json.dumps(session_data, ensure_ascii=False)
        yield ',"push_subscriptions":'
        yield json.dumps(push_data, ensure_ascii=False)
        yield ',"audit_log":'
        yield json.dumps(audit_data, ensure_ascii=False)
        yield ',"uploads":['
        for index, upload in enumerate(uploads):
            if index:
                yield ","
            path = private_upload_path(settings, upload.storage_key)
            yield json.dumps(
                {
                    "id": str(upload.id),
                    "media_type": upload.media_type,
                    "created_at": as_utc(upload.created_at).isoformat(),
                    "content_base64": base64.b64encode(path.read_bytes()).decode("ascii"),
                },
                ensure_ascii=False,
            )
        yield "]}"

    return StreamingResponse(
        generate(),
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="event-reminder-data.json"'},
    )


@router.get("/uploads/{upload_id}")
def download_upload(
    upload_id: UUID, request: Request, db: Session = Depends(get_db)
) -> FileResponse:
    user = authenticate_access(request, db)
    upload = db.scalar(select(Upload).where(Upload.id == upload_id, Upload.user_id == user.id))
    if upload is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "upload_not_found", "message": "Upload not found."},
        )
    path = private_upload_path(request.app.state.settings, upload.storage_key)
    if not path.is_file():
        raise HTTPException(
            status_code=410,
            detail={
                "code": "upload_unavailable",
                "message": "This private upload is no longer available.",
            },
        )
    return FileResponse(path, media_type=upload.media_type, filename=f"{upload.id}{path.suffix}")
