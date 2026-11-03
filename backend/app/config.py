from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file="../.env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: str = "development"
    database_url: str = (
        "postgresql+psycopg://eventreminder:change-this@localhost:5432/eventreminder"
    )
    app_secret: SecretStr = SecretStr("")
    frontend_origin: str = "http://localhost:5173"
    cookie_secure: bool = False
    access_token_minutes: int = Field(default=15, ge=5, le=30)
    refresh_token_days: int = Field(default=30, ge=1, le=90)
    smtp_host: str | None = None
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_from: str = "events@example.com"
    anthropic_api_key: SecretStr | None = None
    anthropic_model: str = "claude-3-7-sonnet-latest"
    upload_dir: str = "../private-uploads"
    vapid_private_key: SecretStr | None = None
    vapid_claim_email: str = "mailto:admin@example.com"

    def validate_startup(self) -> None:
        secret = self.app_secret.get_secret_value()
        lowered_secret = secret.lower()
        if (
            len(secret.encode("utf-8")) < 32
            or len(set(secret)) < 16
            or any(
                word in lowered_secret for word in ("change-me", "replace-", "example", "password")
            )
        ):
            raise RuntimeError("APP_SECRET must contain at least 32 non-placeholder bytes.")
        if self.app_env == "production":
            if not self.database_url.startswith("postgresql+psycopg://"):
                raise RuntimeError("Production requires a PostgreSQL DATABASE_URL.")
            database_password = make_url(self.database_url).password
            if not database_password or database_password.lower() in {
                "change-this",
                "password",
                "example",
            }:
                raise RuntimeError("Production DATABASE_URL must use a non-placeholder password.")
            if not self.cookie_secure:
                raise RuntimeError("COOKIE_SECURE must be enabled in production.")
            if not self.frontend_origin.startswith("https://"):
                raise RuntimeError("Production FRONTEND_ORIGIN must use HTTPS.")
            if not self.smtp_host:
                raise RuntimeError("Production requires SMTP_HOST for account email delivery.")
            if self.anthropic_api_key is None:
                raise RuntimeError("Production requires ANTHROPIC_API_KEY for image extraction.")
            if self.vapid_private_key is None:
                raise RuntimeError("Production requires VAPID_PRIVATE_KEY for web push.")


@lru_cache
def get_settings() -> Settings:
    return Settings()
