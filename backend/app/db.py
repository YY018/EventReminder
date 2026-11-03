from sqlalchemy import create_engine
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    pass


def create_session_factory(database_url: str):
    options: dict[str, object] = {"pool_pre_ping": True}
    if database_url.startswith("sqlite"):
        options["connect_args"] = {"check_same_thread": False}
        if database_url.endswith(":memory:"):
            options["poolclass"] = StaticPool
    engine = create_engine(database_url, **options)
    if database_url.startswith("sqlite"):

        @sqlalchemy_event.listens_for(engine, "connect")
        def enable_sqlite_foreign_keys(connection, _record) -> None:
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine, sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
