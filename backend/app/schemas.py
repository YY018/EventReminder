from datetime import date as DateType
from datetime import datetime
from datetime import time as TimeType
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SignupRequest(InputModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    name: str = Field(default="", max_length=120)

    @field_validator("password")
    @classmethod
    def reject_common_passwords(cls, value: str) -> str:
        normalized = value.casefold()
        common = {
            "12345678901",
            "password123",
            "password1!",
            "1234567890",
            "qwertyuiop",
            "qwerty12345",
            "welcome123",
            "welcome1!",
            "letmein123",
            "iloveyou123",
            "admin12345",
            "abc1234567",
            "football123",
            "monkey12345",
            "changeme123",
            "1111111111",
            "0000000000",
            "qazwsxedcr",
            "asdfghjkl1",
            "trustno1234",
        }
        if normalized in common:
            raise ValueError("Choose a less common password.")
        return value


class LoginRequest(InputModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class TokenRequest(InputModel):
    token: str = Field(min_length=32, max_length=256)


class ForgotPasswordRequest(InputModel):
    email: EmailStr


class ResetPasswordRequest(TokenRequest):
    new_password: str = Field(min_length=10, max_length=128)

    @field_validator("new_password")
    @classmethod
    def reject_common_passwords(cls, value: str) -> str:
        return SignupRequest.reject_common_passwords(value)


class ChangePasswordRequest(InputModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=10, max_length=128)

    @field_validator("new_password")
    @classmethod
    def reject_common_passwords(cls, value: str) -> str:
        return SignupRequest.reject_common_passwords(value)


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")

    id: UUID
    email: EmailStr
    name: str
    email_verified: bool
    timezone: str
    default_reminder_leads: list[int]
    notification_channels: list[str]


class UserPatch(InputModel):
    name: str | None = Field(default=None, max_length=120)
    timezone: str | None = Field(default=None, max_length=64)
    default_reminder_leads: list[int] | None = Field(default=None, max_length=10)
    notification_channels: list[Literal["in_app", "email", "push"]] | None = Field(
        default=None, max_length=3
    )

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                ZoneInfo(value)
            except ZoneInfoNotFoundError as error:
                raise ValueError("Unknown timezone.") from error
        return value

    @field_validator("default_reminder_leads")
    @classmethod
    def validate_leads(cls, value: list[int] | None) -> list[int] | None:
        if value is not None and any(minutes < 1 or minutes > 10080 for minutes in value):
            raise ValueError("Reminder lead times must be from 1 to 10080 minutes.")
        if value is not None and len(set(value)) != len(value):
            raise ValueError("Reminder lead times must be unique.")
        return value


class EventCreate(InputModel):
    title: str = Field(min_length=1, max_length=200)
    start_at: datetime
    end_at: datetime | None = None
    location: str | None = Field(default=None, max_length=1000)
    notes: str | None = Field(default=None, max_length=10000)
    source: Literal["manual", "screenshot"] = "manual"
    reminder_lead_minutes: list[int] | None = Field(default=None, max_length=10)
    reminder_channels: list[Literal["in_app", "email", "push"]] | None = Field(
        default=None, max_length=3
    )

    @field_validator("title")
    @classmethod
    def trim_title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Title cannot be empty.")
        return value

    @field_validator("start_at", "end_at")
    @classmethod
    def require_aware_datetimes(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.utcoffset() is None:
            raise ValueError("Date/time values must include a timezone offset.")
        return value

    @field_validator("reminder_lead_minutes")
    @classmethod
    def validate_event_leads(cls, value: list[int] | None) -> list[int] | None:
        if value is not None and any(minutes < 1 or minutes > 10080 for minutes in value):
            raise ValueError("Reminder lead times must be from 1 to 10080 minutes.")
        if value is not None and len(set(value)) != len(value):
            raise ValueError("Reminder lead times must be unique.")
        return value

    @model_validator(mode="after")
    def end_after_start(self):
        if self.end_at is not None and self.end_at <= self.start_at:
            raise ValueError("Event end must be after its start.")
        return self


class EventPatch(InputModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    start_at: datetime | None = None
    end_at: datetime | None = None
    location: str | None = Field(default=None, max_length=1000)
    notes: str | None = Field(default=None, max_length=10000)
    status: Literal["upcoming", "done", "cancelled"] | None = None
    reminder_lead_minutes: list[int] | None = Field(default=None, max_length=10)
    reminder_channels: list[Literal["in_app", "email", "push"]] | None = Field(
        default=None, max_length=3
    )

    @field_validator("title")
    @classmethod
    def trim_optional_title(cls, value: str | None) -> str | None:
        if value is not None:
            value = value.strip()
            if not value:
                raise ValueError("Title cannot be empty.")
        return value

    @field_validator("start_at", "end_at")
    @classmethod
    def require_aware_update_datetimes(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.utcoffset() is None:
            raise ValueError("Date/time values must include a timezone offset.")
        return value

    @field_validator("reminder_lead_minutes")
    @classmethod
    def validate_updated_leads(cls, value: list[int] | None) -> list[int] | None:
        return EventCreate.validate_event_leads(value)

    @model_validator(mode="after")
    def reject_null_required_updates(self):
        for field in ("title", "start_at", "status"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null.")
        return self

    @model_validator(mode="after")
    def validate_update_end(self):
        if self.start_at is not None and self.end_at is not None and self.end_at <= self.start_at:
            raise ValueError("Event end must be after its start.")
        return self


class EventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    start_utc: datetime
    end_utc: datetime | None
    location: str | None
    notes: str | None
    source: str
    status: str
    reminder_lead_minutes: list[int] | None
    reminder_channels: list[str] | None
    created_at: datetime
    updated_at: datetime


class EventBatchCreate(InputModel):
    events: list[EventCreate] = Field(min_length=1, max_length=50)
    confirm_duplicates: bool = False


class ExtractedEvent(InputModel):
    title: str = Field(min_length=1, max_length=200)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    time: str = Field(pattern=r"^\d{2}:\d{2}$")
    end_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    location: str | None = Field(default=None, max_length=1000)
    confidence: float = Field(ge=0, le=1)
    notes: str | None = Field(default=None, max_length=10000)

    @field_validator("date")
    @classmethod
    def parse_date(cls, value: str) -> str:
        DateType.fromisoformat(value)
        return value

    @field_validator("time", "end_time")
    @classmethod
    def parse_time(cls, value: str | None) -> str | None:
        if value is not None:
            TimeType.fromisoformat(value)
        return value


class ExtractionResponse(InputModel):
    events: list[ExtractedEvent] = Field(max_length=50)
    manual_entry_suggested: bool = False
    message: str | None = None
    retained_upload_id: UUID | None = None


class PushKeys(InputModel):
    p256dh: str = Field(min_length=8, max_length=256)
    auth: str = Field(min_length=8, max_length=256)


class PushSubscriptionRequest(InputModel):
    endpoint: str = Field(min_length=20, max_length=2048)
    keys: PushKeys

    @field_validator("endpoint")
    @classmethod
    def validate_push_endpoint(cls, value: str) -> str:
        from urllib.parse import urlsplit

        parsed = urlsplit(value)
        hostname = (parsed.hostname or "").lower()
        allowed = (
            hostname == "fcm.googleapis.com"
            or hostname.endswith(".googleapis.com")
            or hostname.endswith(".mozilla.com")
            or hostname.endswith(".windows.com")
            or hostname.endswith(".apple.com")
        )
        if (
            parsed.scheme != "https"
            or not allowed
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
        ):
            raise ValueError("Push endpoint is not an allowed HTTPS provider.")
        return value


class PushSubscriptionDelete(InputModel):
    endpoint: str = Field(min_length=20, max_length=2048)


class ReminderResponse(BaseModel):
    id: UUID
    event_id: UUID
    title: str
    start_utc: datetime
    location: str | None
    remind_at_utc: datetime
    channel: str
    sent_at: datetime | None
