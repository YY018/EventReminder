import smtplib
from email.message import EmailMessage

from app.config import Settings


class EmailDeliveryError(RuntimeError):
    pass


def send_email(settings: Settings, recipient: str, subject: str, body: str) -> None:
    if not settings.smtp_host:
        raise EmailDeliveryError("SMTP is not configured.")
    message = EmailMessage()
    message["From"] = settings.smtp_from
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(body)
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
            smtp.starttls()
            if settings.smtp_username and settings.smtp_password:
                smtp.login(
                    settings.smtp_username,
                    settings.smtp_password.get_secret_value(),
                )
            smtp.send_message(message)
    except (OSError, smtplib.SMTPException) as error:
        raise EmailDeliveryError("Email could not be delivered.") from error
