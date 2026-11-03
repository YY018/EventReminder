import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings
from app.image_uploads import remove_private_upload, uploads_for_user
from app.mailer import EmailDeliveryError
from app.models import AuditLog, AuthSession, EmailToken, RefreshToken, User, utc_now
from app.schemas import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    ResetPasswordRequest,
    SignupRequest,
    TokenRequest,
    UserPatch,
    UserResponse,
)
from app.security import (
    ACCESS_COOKIE,
    CSRF_COOKIE,
    DUMMY_PASSWORD_HASH,
    REFRESH_COOKIE,
    authenticate_access,
    clear_auth_cookies,
    enforce_rate_limit,
    hash_secret,
    make_opaque_token,
    password_hasher,
    require_csrf,
    set_auth_cookies,
    set_csrf_cookie,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def is_expired(value: datetime, now: datetime) -> bool:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value <= now


def get_db(request: Request) -> Session:
    with request.app.state.session_factory() as db:
        yield db


def settings_for(request: Request) -> Settings:
    return request.app.state.settings


def audit(request: Request, db: Session, action: str, user_id: UUID | None) -> None:
    db.add(
        AuditLog(
            user_id=user_id,
            action=action,
            ip=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent", "")[:255] or None,
        )
    )


def create_email_token(db: Session, user: User, purpose: str, lifetime: timedelta) -> str:
    raw_token = make_opaque_token()
    db.add(
        EmailToken(
            user_id=user.id,
            token_hash=hash_secret(raw_token),
            purpose=purpose,
            expires_at=utc_now() + lifetime,
        )
    )
    return raw_token


def deliver_token_email(request: Request, recipient: str, purpose: str, token: str) -> None:
    settings = settings_for(request)
    endpoint = "verify-email" if purpose == "verify_email" else "reset-password"
    link = f"{settings.frontend_origin.rstrip('/')}/{endpoint}?token={token}"
    subject = (
        "Verify your Event Reminder email" if purpose == "verify_email" else "Reset your password"
    )
    try:
        request.app.state.email_sender(
            settings, recipient, subject, f"Use this one-time link:\n{link}\n"
        )
    except EmailDeliveryError:
        logger.warning("transactional_email_delivery_failed", extra={"purpose": purpose})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "email_unavailable",
                "message": "Email delivery is temporarily unavailable.",
            },
        ) from None


def deliver_token_email_in_background(
    request: Request, recipient: str, purpose: str, token: str
) -> None:
    try:
        deliver_token_email(request, recipient, purpose, token)
    except HTTPException:
        return


def schedule_token_email(
    background_tasks: BackgroundTasks,
    request: Request,
    recipient: str,
    purpose: str,
    token: str,
) -> None:
    background_tasks.add_task(
        deliver_token_email_in_background,
        request,
        recipient,
        purpose,
        token,
    )


def rate_limit(
    request: Request,
    db: Session,
    action: str,
    limit: int,
    window_seconds: int,
    identity: str = "",
) -> None:
    enforce_rate_limit(db, request, settings_for(request), action, limit, window_seconds, identity)


@router.get("/auth/csrf", status_code=status.HTTP_200_OK)
def csrf_token(response: Response, request: Request) -> dict[str, str]:
    token = set_csrf_cookie(response, settings_for(request))
    return {"csrf_token": token}


@router.post("/auth/signup", status_code=status.HTTP_202_ACCEPTED)
def signup(
    payload: SignupRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict[str, str]:
    require_csrf(request)
    rate_limit(request, db, "signup_ip", 20, 3600)
    rate_limit(request, db, "signup_email", 5, 3600, payload.email)
    existing = db.scalar(select(User.id).where(User.email == payload.email.lower()))
    if existing is not None:
        return {"message": "If signup is available, a verification email will be sent."}
    user = User(
        email=payload.email.lower(),
        name=payload.name.strip(),
        password_hash=password_hasher.hash(payload.password),
    )
    db.add(user)
    try:
        db.flush()
        token = create_email_token(db, user, "verify_email", timedelta(hours=24))
        db.commit()
    except IntegrityError:
        db.rollback()
        return {"message": "If signup is available, a verification email will be sent."}
    schedule_token_email(background_tasks, request, user.email, "verify_email", token)
    return {"message": "If signup is available, a verification email will be sent."}


@router.post("/auth/login")
def login(
    payload: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)
) -> dict[str, object]:
    require_csrf(request)
    rate_limit(request, db, "login_ip", 30, 300)
    rate_limit(request, db, "login_email", 10, 300, payload.email)
    email = payload.email.lower()
    user = db.scalar(select(User).where(User.email == email, User.deleted_at.is_(None)))
    password_hash = user.password_hash if user is not None else DUMMY_PASSWORD_HASH
    verified = password_hasher.verify(payload.password, password_hash)
    if user is None or not verified or not user.email_verified:
        audit(request, db, "login_failed", user.id if user else None)
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_credentials", "message": "Email or password is incorrect."},
        )
    now = utc_now()
    auth_session = AuthSession(
        user_id=user.id,
        device_info=request.headers.get("user-agent", "")[:255] or None,
        expires_at=now + timedelta(days=settings_for(request).refresh_token_days),
    )
    refresh_token = make_opaque_token()
    db.add(auth_session)
    db.flush()
    db.add(
        RefreshToken(
            session_id=auth_session.id,
            token_hash=hash_secret(refresh_token),
            expires_at=auth_session.expires_at,
        )
    )
    audit(request, db, "login", user.id)
    db.commit()
    set_auth_cookies(response, user, auth_session, refresh_token, settings_for(request))
    return {"user": UserResponse.model_validate(user).model_dump(mode="json")}


@router.post("/auth/refresh")
def refresh(request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, str]:
    require_csrf(request)
    raw_token = request.cookies.get(REFRESH_COOKIE)
    if not raw_token:
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_refresh", "message": "Session is no longer valid."},
        )
    token = db.scalar(
        select(RefreshToken)
        .where(RefreshToken.token_hash == hash_secret(raw_token))
        .with_for_update()
    )
    if token is None:
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_refresh", "message": "Session is no longer valid."},
        )
    auth_session = db.get(AuthSession, token.session_id)
    now = utc_now()
    if token.revoked_at is not None:
        if auth_session is not None:
            auth_session.revoked_at = now
            for descendant in auth_session.refresh_tokens:
                descendant.revoked_at = descendant.revoked_at or now
        db.commit()
        raise HTTPException(
            status_code=401,
            detail={
                "code": "refresh_reuse_detected",
                "message": "Session revoked; please log in again.",
            },
        )
    if (
        auth_session is None
        or auth_session.revoked_at is not None
        or is_expired(token.expires_at, now)
        or is_expired(auth_session.expires_at, now)
    ):
        if auth_session is not None:
            auth_session.revoked_at = now
        token.revoked_at = now
        db.commit()
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_refresh", "message": "Session is no longer valid."},
        )
    user = db.get(User, auth_session.user_id)
    if user is None or user.deleted_at is not None:
        auth_session.revoked_at = now
        db.commit()
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_refresh", "message": "Session is no longer valid."},
        )
    new_raw_token = make_opaque_token()
    token.revoked_at = now
    new_token = RefreshToken(
        session_id=auth_session.id,
        token_hash=hash_secret(new_raw_token),
        rotated_from=token.id,
        expires_at=auth_session.expires_at,
    )
    db.add(new_token)
    db.commit()
    set_auth_cookies(response, user, auth_session, new_raw_token, settings_for(request))
    return {"message": "Session refreshed."}


@router.post("/auth/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, str]:
    require_csrf(request)
    raw_refresh = request.cookies.get(REFRESH_COOKIE)
    user = None
    access = request.cookies.get(ACCESS_COOKIE)
    if access:
        try:
            user = authenticate_access(request, db)
        except HTTPException:
            pass
    if raw_refresh:
        token = db.scalar(
            select(RefreshToken).where(RefreshToken.token_hash == hash_secret(raw_refresh))
        )
        if token is not None:
            auth_session = db.get(AuthSession, token.session_id)
            if auth_session is not None:
                auth_session.revoked_at = utc_now()
                for child in auth_session.refresh_tokens:
                    child.revoked_at = child.revoked_at or utc_now()
                user = user or db.get(User, auth_session.user_id)
    if user is not None:
        audit(request, db, "logout", user.id)
    db.commit()
    response.delete_cookie(
        CSRF_COOKIE,
        path="/",
        secure=settings_for(request).cookie_secure,
        httponly=False,
        samesite="lax",
    )
    clear_auth_cookies(response, settings_for(request))
    return {"message": "Logged out."}


@router.post("/auth/logout-all")
def logout_all(
    request: Request, response: Response, db: Session = Depends(get_db)
) -> dict[str, str]:
    require_csrf(request)
    user = authenticate_access(request, db)
    now = utc_now()
    sessions = list(
        db.scalars(
            select(AuthSession).where(
                AuthSession.user_id == user.id,
                AuthSession.revoked_at.is_(None),
            )
        )
    )
    for auth_session in sessions:
        auth_session.revoked_at = now
        for token in auth_session.refresh_tokens:
            token.revoked_at = token.revoked_at or now
    user.auth_version += 1
    audit(request, db, "logout_all", user.id)
    db.commit()
    clear_auth_cookies(response, settings_for(request))
    return {"message": "All sessions were logged out."}


@router.post("/auth/verify-email")
def verify_email(
    payload: TokenRequest, request: Request, db: Session = Depends(get_db)
) -> dict[str, str]:
    require_csrf(request)
    rate_limit(request, db, "verify_email", 10, 3600)
    token = db.scalar(
        select(EmailToken)
        .where(
            EmailToken.token_hash == hash_secret(payload.token),
            EmailToken.purpose == "verify_email",
            EmailToken.used_at.is_(None),
            EmailToken.expires_at > utc_now(),
        )
        .with_for_update()
    )
    if token is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_token",
                "message": "This verification link is invalid or expired.",
            },
        )
    user = db.get(User, token.user_id)
    if user is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_token",
                "message": "This verification link is invalid or expired.",
            },
        )
    token.used_at = utc_now()
    user.email_verified = True
    audit(request, db, "email_verified", user.id)
    db.commit()
    return {"message": "Email verified."}


@router.post("/auth/resend-verification", status_code=status.HTTP_202_ACCEPTED)
def resend_verification(
    payload: ForgotPasswordRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict[str, str]:
    require_csrf(request)
    email = payload.email.lower()
    rate_limit(request, db, "resend_verification_ip", 10, 3600)
    rate_limit(request, db, "resend_verification_email", 3, 3600, email)
    user = db.scalar(
        select(User).where(
            User.email == email,
            User.email_verified.is_(False),
            User.deleted_at.is_(None),
        )
    )
    if user is not None:
        token = create_email_token(db, user, "verify_email", timedelta(hours=24))
        db.commit()
        schedule_token_email(background_tasks, request, user.email, "verify_email", token)
    return {"message": "If verification is pending, a new email will be sent."}


@router.post("/auth/forgot-password", status_code=status.HTTP_202_ACCEPTED)
def forgot_password(
    payload: ForgotPasswordRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict[str, str]:
    require_csrf(request)
    email = payload.email.lower()
    rate_limit(request, db, "forgot_password_ip", 10, 3600)
    rate_limit(request, db, "forgot_password_email", 5, 3600, email)
    user = db.scalar(select(User).where(User.email == email.lower(), User.deleted_at.is_(None)))
    if user is not None:
        raw_token = create_email_token(db, user, "reset_password", timedelta(minutes=30))
        db.commit()
        schedule_token_email(background_tasks, request, user.email, "reset_password", raw_token)
    return {"message": "If the account exists, a password reset email will be sent."}


@router.post("/auth/reset-password")
def reset_password(
    payload: ResetPasswordRequest, request: Request, db: Session = Depends(get_db)
) -> dict[str, str]:
    require_csrf(request)
    rate_limit(request, db, "reset_password", 10, 3600)
    token = db.scalar(
        select(EmailToken)
        .where(
            EmailToken.token_hash == hash_secret(payload.token),
            EmailToken.purpose == "reset_password",
            EmailToken.used_at.is_(None),
            EmailToken.expires_at > utc_now(),
        )
        .with_for_update()
    )
    if token is None:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_token", "message": "This reset link is invalid or expired."},
        )
    user = db.get(User, token.user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_token", "message": "This reset link is invalid or expired."},
        )
    token.used_at = utc_now()
    user.password_hash = password_hasher.hash(payload.new_password)
    user.auth_version += 1
    now = utc_now()
    sessions = list(db.scalars(select(AuthSession).where(AuthSession.user_id == user.id)))
    for auth_session in sessions:
        auth_session.revoked_at = auth_session.revoked_at or now
        for refresh_token in auth_session.refresh_tokens:
            refresh_token.revoked_at = refresh_token.revoked_at or now
    audit(request, db, "password_changed", user.id)
    db.commit()
    return {"message": "Password reset. Please log in again."}


@router.post("/auth/change-password")
def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Response:
    require_csrf(request)
    user = authenticate_access(request, db)
    if not password_hasher.verify(payload.current_password, user.password_hash):
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_password", "message": "Current password is incorrect."},
        )
    user.password_hash = password_hasher.hash(payload.new_password)
    user.auth_version += 1
    now = utc_now()
    for auth_session in db.scalars(select(AuthSession).where(AuthSession.user_id == user.id)):
        auth_session.revoked_at = auth_session.revoked_at or now
        for refresh_token in auth_session.refresh_tokens:
            refresh_token.revoked_at = refresh_token.revoked_at or now
    audit(request, db, "password_changed", user.id)
    db.commit()
    response = Response(
        content='{"message":"Password changed. Please log in again."}',
        media_type="application/json",
    )
    clear_auth_cookies(response, settings_for(request))
    return response


@router.get("/me", response_model=UserResponse)
def get_me(request: Request, db: Session = Depends(get_db)) -> UserResponse:
    return UserResponse.model_validate(authenticate_access(request, db))


@router.patch("/me", response_model=UserResponse)
def patch_me(payload: UserPatch, request: Request, db: Session = Depends(get_db)) -> UserResponse:
    require_csrf(request)
    user = authenticate_access(request, db)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(user, field, value)
    db.commit()
    db.refresh(user)
    return UserResponse.model_validate(user)


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
def delete_me(request: Request, response: Response, db: Session = Depends(get_db)) -> Response:
    require_csrf(request)
    user = authenticate_access(request, db)
    for upload in uploads_for_user(db, user.id):
        remove_private_upload(settings_for(request), upload.storage_key)
    audit(request, db, "account_deleted", user.id)
    db.flush()
    db.execute(
        update(AuditLog)
        .where(AuditLog.user_id == user.id)
        .values(user_id=None, ip=None, user_agent=None)
    )
    db.delete(user)
    db.commit()
    response.status_code = status.HTTP_204_NO_CONTENT
    from app.security import clear_auth_cookies

    clear_auth_cookies(response, settings_for(request))
    return response
