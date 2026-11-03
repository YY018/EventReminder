import logging

from apscheduler.schedulers.blocking import BlockingScheduler

from app.config import get_settings
from app.db import create_session_factory
from app.reminder_service import dispatch_due_reminders

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


def main() -> None:
    settings = get_settings()
    settings.validate_startup()
    engine, session_factory = create_session_factory(settings.database_url)
    scheduler = BlockingScheduler(timezone="UTC")
    scheduler.add_job(
        dispatch_due_reminders,
        trigger="interval",
        minutes=1,
        args=[session_factory, settings],
        id="event-reminders",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=60,
    )
    try:
        scheduler.start()
    finally:
        scheduler.shutdown(wait=True)
        engine.dispose()


if __name__ == "__main__":
    main()
