"""Database engine and session. SQLite locally; any SQLAlchemy URL (Postgres) works unchanged."""
from __future__ import annotations

import datetime as dt
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import JSON, DateTime, MetaData, create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator

from .config import settings

NAMING = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)
    type_annotation_map = {dict: JSON, list: JSON}


class UTCDateTime(TypeDecorator):
    """Timezone-aware UTC datetimes on every backend (SQLite drops tzinfo)."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is not None:
            value = value.astimezone(dt.UTC).replace(tzinfo=None)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=dt.UTC)
        return value


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


_engine: Engine | None = None
_Session: sessionmaker[Session] | None = None


def engine() -> Engine:
    global _engine, _Session
    if _engine is None:
        url = settings().db_url
        kw: dict = {"pool_pre_ping": True}
        if url.startswith("sqlite"):
            settings().data_dir.mkdir(parents=True, exist_ok=True)
            kw["connect_args"] = {"check_same_thread": False, "timeout": 30}
        _engine = create_engine(url, **kw)
        if url.startswith("sqlite"):
            @event.listens_for(_engine, "connect")
            def _sqlite_pragmas(conn, _):  # noqa: ANN001
                cur = conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")       # API, worker and exporter share the file
                cur.execute("PRAGMA foreign_keys=ON")
                cur.execute("PRAGMA busy_timeout=30000")
                cur.close()
        _Session = sessionmaker(_engine, expire_on_commit=False)
    return _engine


def reset_engine() -> None:
    """Tests: drop the cached engine after changing settings."""
    global _engine, _Session
    if _engine is not None:
        _engine.dispose()
    _engine, _Session = None, None


def SessionLocal() -> Session:  # noqa: N802
    engine()
    assert _Session is not None
    return _Session()


def write_lock(db: Session) -> None:
    """Takes the database's write lock now, before reading rows the session will rewrite.
    pysqlite only starts a transaction at the first INSERT/UPDATE, so a plain read-modify-write
    lets another writer commit in between and its change is silently overwritten. Already in a
    transaction (after a write), the lock is held. Other databases: read with FOR UPDATE."""
    conn = db.connection()
    if conn.dialect.name == "sqlite" and not conn.connection.dbapi_connection.in_transaction:  # type: ignore[union-attr]
        conn.exec_driver_sql("BEGIN IMMEDIATE")


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
