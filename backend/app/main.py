import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app import models  # noqa: F401
from app.auth import router as auth_router
from app.config import Settings, get_settings
from app.db import create_session_factory
from app.events import router as events_router
from app.exports import router as exports_router
from app.extraction import router as extraction_router
from app.mailer import send_email
from app.reminders import router as reminders_router

logger = logging.getLogger("event_reminder")


def create_app(settings: Settings | None = None, email_sender=send_email) -> FastAPI:
    config = settings or get_settings()
    engine, session_factory = create_session_factory(config.database_url)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        config.validate_startup()
        yield
        engine.dispose()

    application = FastAPI(
        title="Event Reminder API",
        version="0.1.0",
        description="Private event reminders and account management.",
        lifespan=lifespan,
    )
    application.state.settings = config
    application.state.engine = engine
    application.state.session_factory = session_factory
    application.state.email_sender = email_sender
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[config.frontend_origin],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-CSRF-Token"],
    )

    @application.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; base-uri 'self'; object-src 'none'; "
            "frame-ancestors 'none'; form-action 'self'"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if config.app_env == "production":
            response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        return response

    @application.exception_handler(RequestValidationError)
    async def validation_error(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "validation_error",
                    "message": "The request contains invalid or missing fields.",
                }
            },
        )

    @application.exception_handler(Exception)
    async def unexpected_error(_: Request, error: Exception) -> JSONResponse:
        logger.error("unhandled_api_error", extra={"error_type": type(error).__name__})
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "internal_error",
                    "message": "An unexpected error occurred.",
                }
            },
        )

    @application.exception_handler(HTTPException)
    async def http_error(_: Request, error: HTTPException) -> JSONResponse:
        detail = error.detail
        if isinstance(detail, dict) and "code" in detail and "message" in detail:
            body = {"error": detail}
        else:
            body = {"error": {"code": "request_failed", "message": str(detail)}}
        return JSONResponse(status_code=error.status_code, content=body, headers=error.headers)

    @application.get("/healthz", tags=["system"])
    def healthcheck() -> dict[str, str]:
        with session_factory() as db:
            db.execute(text("SELECT 1"))
        return {"status": "ok"}

    application.include_router(auth_router)
    application.include_router(events_router)
    application.include_router(extraction_router)
    application.include_router(reminders_router)
    application.include_router(exports_router)
    return application


app = create_app()
