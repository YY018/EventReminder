import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
from fastapi import HTTPException, Request, Response, status
from pwdlib import PasswordHash
from sqlalchemy import case, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import AuthSession, RateLimitBucket, User, utc_now

password_hasher = PasswordHash.recommended()
DUMMY_PASSWORD_HASH = password_hasher.hash("not-a-real-user-password")
ACCESS_COOKIE = "event_access"
REFRESH_COOKIE = "event_refresh"
CSRF_COOKIE = "event_csrf"
CSRF_HEADER = "x-csrf-token"


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def make_opaque_token() -> str:
    return secrets.token_urlsafe(48)


def set_csrf_cookie(response: Response, settings: Settings) -> str:
    token = secrets.token_urlsafe(32)
    response.set_cookie(
        CSRF_COOKIE,
        token,
        httponly=False,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
        max_age=86400,
    )
    return token


def require_csrf(request: Request) -> None:
    cookie = request.cookies.get(CSRF_COOKIE, "")
    header = request.headers.get(CSRF_HEADER, "")
    if not cookie or not header or not hmac.compare_digest(cookie, header):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "csrf_failed", "message": "CSRF validation failed."},
        )
    origin = request.headers.get("origin")
    expected_origin = str(request.app.state.settings.frontend_origin).rstrip("/")
    if origin and origin.rstrip("/") != expected_origin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "origin_failed", "message": "Request origin is not allowed."},
        )


def issue_access_token(user: User, session_id: UUID, settings: Settings) -> str:
    issued_at = datetime.now(UTC)
    claims = {
        "sub": str(user.id),
        "sid": str(session_id),
        "ver": user.auth_version,
        "iat": issued_at,
        "exp": issued_at + timedelta(minutes=settings.access_token_minutes),
        "iss": "event-reminder",
        "aud": "event-reminder-api",
    }
    return jwt.encode(claims, settings.app_secret.get_secret_value(), algorithm="HS256")


def set_auth_cookies(
    response: Response,
    user: User,
    session: AuthSession,
    refresh_token: str,
    settings: Settings,
) -> None:
    response.set_cookie(
        ACCESS_COOKIE,
        issue_access_token(user, session.id, settings),
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
        max_age=settings.access_token_minutes * 60,
    )
    response.set_cookie(
        REFRESH_COOKIE,
        refresh_token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/auth",
        max_age=settings.refresh_token_days * 86400,
    )


def clear_auth_cookies(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        ACCESS_COOKIE, path="/", secure=settings.cookie_secure, httponly=True, samesite="lax"
    )
    response.delete_cookie(
        REFRESH_COOKIE, path="/auth", secure=settings.cookie_secure, httponly=True, samesite="lax"
    )


def authenticate_access(request: Request, db: Session) -> User:
    token = request.cookies.get(ACCESS_COOKIE)
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": "not_authenticated", "message": "Authentication required."},
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not token:
        raise unauthorized
    settings: Settings = request.app.state.settings
    try:
        claims = jwt.decode(
            token,
            settings.app_secret.get_secret_value(),
            algorithms=["HS256"],
            audience="event-reminder-api",
            issuer="event-reminder",
            options={"require": ["sub", "sid", "ver", "exp", "iat"]},
        )
        user_id, session_id = UUID(claims["sub"]), UUID(claims["sid"])
        auth_session = db.scalar(
            select(AuthSession).where(
                AuthSession.id == session_id,
                AuthSession.user_id == user_id,
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > utc_now(),
            )
        )
        user = db.get(User, user_id)
        if (
            auth_session is None
            or user is None
            or user.deleted_at is not None
            or claims["ver"] != user.auth_version
        ):
            raise unauthorized
        return user
    except (jwt.PyJWTError, ValueError, TypeError):
        raise unauthorized from None


def enforce_rate_limit(
    db: Session,
    request: Request,
    settings: Settings,
    action: str,
    limit: int,
    window_seconds: int,
    identity: str = "",
) -> None:
    remote_ip = request.client.host if request.client else "unknown"
    digest = hmac.new(
        settings.app_secret.get_secret_value().encode(),
        f"{action}:{remote_ip}:{identity.casefold()}".encode(),
        hashlib.sha256,
    ).hexdigest()
    now = utc_now()
    reset_at = now + timedelta(seconds=window_seconds)
    dialect = db.get_bind().dialect.name
    insert = pg_insert if dialect == "postgresql" else sqlite_insert
    statement = insert(RateLimitBucket).values(key=digest, count=1, reset_at=reset_at)
    statement = statement.on_conflict_do_update(
        index_elements=[RateLimitBucket.key],
        set_={
            "count": case(
                (RateLimitBucket.reset_at <= now, 1),
                else_=RateLimitBucket.count + 1,
            ),
            "reset_at": case(
                (RateLimitBucket.reset_at <= now, reset_at),
                else_=RateLimitBucket.reset_at,
            ),
        },
    )
    db.execute(statement)
    db.flush()
    count = db.scalar(select(RateLimitBucket.count).where(RateLimitBucket.key == digest))
    if count is not None and count > limit:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "rate_limited", "message": "Too many requests. Try again later."},
            headers={"Retry-After": str(window_seconds)},
        )
    db.commit()
