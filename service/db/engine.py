"""
Async SQLAlchemy engine + session factory.

DATABASE_URL comes from service/.env (loaded via python-dotenv). Defaults
to SQLite for the single-machine deployment described in the plan.

Two ergonomics knobs on the SQLite path:
  • `check_same_thread=False` — required because we hand sessions to
    background tasks (the WS pump applies events from one task while
    HTTP handlers serve another).
  • PRAGMA journal_mode=WAL — readers don't block writers. Critical for
    "one tab reads while another tab + the WS pump writes."

For Postgres, none of these knobs apply — drop in the asyncpg URL and the
engine constructs the right pool with sane defaults.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from dotenv import load_dotenv
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

HERE = Path(__file__).resolve().parent
# Load service/.env (gitignored). Falls back to env-vars already in process.
load_dotenv(HERE.parent / ".env", override=False)

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    f"sqlite+aiosqlite:///{HERE.parent / 'chatterly.db'}",
)

_is_sqlite = DATABASE_URL.startswith("sqlite")

# `connect_args` is SQLite-specific; passing it to a Postgres URL is harmless
# but we keep it gated so the engine logs don't show misleading flags.
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

# `echo=False` because the relay logs are noisy enough already. Flip to
# True via env var when debugging a slow query.
engine: AsyncEngine = create_async_engine(
    DATABASE_URL,
    echo=os.environ.get("DB_ECHO") == "1",
    connect_args=_connect_args,
    future=True,
)

async_session_factory = async_sessionmaker(
    engine,
    expire_on_commit=False,   # rows stay usable after .commit() — fewer .refresh() calls
    class_=AsyncSession,
)


@asynccontextmanager
async def get_session() -> AsyncIterator[AsyncSession]:
    """Context-managed AsyncSession. Auto-commits on success, rolls back on
    exception. Use this from FastAPI route handlers + background tasks.

    Example:
        async with get_session() as s:
            s.add(Account(id="...", nickname="..."))
    """
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def init_db() -> None:
    """Apply migrations + set SQLite pragmas. Called from the FastAPI
    startup hook. Idempotent.

    Strategy:
      1. SQLite PRAGMAs are wired before any connect (WAL, foreign_keys, etc.).
      2. If `alembic_version` table doesn't exist yet (fresh box), call
         `Base.metadata.create_all()` directly and stamp Alembic to the
         initial revision. We skip `alembic upgrade head` here because
         Alembic+SQLAlchemy 2.0.35+Python 3.13 hits a recursion bug on
         this schema's first run. The diffs in subsequent migrations are
         small enough that the bug doesn't trip.
      3. If `alembic_version` already exists, run the normal
         `alembic upgrade head` to apply pending migrations.

    On Postgres the same flow works; the recursion bug is Python-version
    sensitive and we keep the same code path for symmetry.
    """
    if _is_sqlite:
        from sqlalchemy import event

        @event.listens_for(engine.sync_engine, "connect")
        def _set_sqlite_pragmas(dbapi_conn, _connection_record):
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA cache_size=-64000")   # 64 MiB
            cur.execute("PRAGMA busy_timeout=30000")  # 30 s — concurrent writers
            cur.close()

    # Detect whether the DB has ever been initialized + create-if-missing.
    # We intentionally do NOT run `alembic upgrade head` here — Alembic in
    # 1.13.3 has a behavioral quirk with our env.py on Python 3.13 where
    # re-entering the upgrade flow on an already-current DB loops in the
    # migration-context logger. Since phase A has exactly one migration
    # (the initial schema), there's nothing to upgrade once the DB exists.
    # When we add a second migration in phase D, this function gets a
    # version-comparison branch that calls `command.upgrade(...)` only
    # when the on-disk revision != head.
    from sqlalchemy import create_engine, inspect, text

    sync_url = DATABASE_URL.replace("+aiosqlite", "").replace("+asyncpg", "")
    sync_engine = create_engine(sync_url)
    try:
        # PRAGMAs the async engine sets per-connection (above) need to also
        # land on the sync_engine we use here for create_all() / stamp, so
        # the DB file gets WAL mode set at creation time (persistent on disk).
        if _is_sqlite:
            with sync_engine.connect() as conn:
                conn.exec_driver_sql("PRAGMA journal_mode=WAL")
                conn.exec_driver_sql("PRAGMA synchronous=NORMAL")
                conn.exec_driver_sql("PRAGMA foreign_keys=ON")
                conn.commit()

        inspector = inspect(sync_engine)
        has_alembic = "alembic_version" in inspector.get_table_names()

        if not has_alembic:
            from .models import Base
            Base.metadata.create_all(bind=sync_engine)
            with sync_engine.begin() as conn:
                conn.execute(text(
                    "CREATE TABLE IF NOT EXISTS alembic_version "
                    "(version_num VARCHAR(32) PRIMARY KEY)"
                ))
                conn.execute(text("DELETE FROM alembic_version"))
                conn.execute(text(
                    "INSERT INTO alembic_version (version_num) VALUES ('0001_initial')"
                ))
        else:
            # Cheap idempotent catch-up for additive schema changes: any new
            # tables defined in models.py that aren't in the DB yet get
            # created. Full Alembic upgrade lands in phase D — until then
            # this covers the saved_replies / future additive cases without
            # making the user wipe their DB.
            from .models import Base
            Base.metadata.create_all(bind=sync_engine)
    finally:
        sync_engine.dispose()
