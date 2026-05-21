"""
ORM models — the full schema from ARCHITECTURE_PLAN_V2.md §4.

Convention notes (carried throughout):
  • Snake_case column names. Mirrors the SQL in the plan.
  • All UTC timestamps stored as DATETIME with default CURRENT_TIMESTAMP.
    SQLAlchemy maps to Python `datetime` (naive UTC — we never store local).
  • Money in `*_cents` integers (BIGINT for lifetime spend). Never floats.
  • Composite PKs on every per-account-and-X table (chats, messages, fans,
    vault_items, …) so unified queries are `ORDER BY` instead of UNION.
  • JSON-shaped fields (tags, custom_fields, raw_json, recent_events, etc.)
    stored as TEXT and serialized at the application layer. Drizzle/JSONB
    is a Postgres luxury we don't need yet; the relay reads JSON once on
    load and never queries inside.
  • Foreign keys use `ON DELETE CASCADE` where the child only makes sense
    in the context of its parent (sessions → account, list_members → list).
    `ON DELETE SET NULL` where the link is informational (proxies →
    account_id, actions → employee_id).

Why a mix of SQLModel and SQLAlchemy declarative: SQLModel gives Pydantic
serialization for free on simple-PK rows we expose via FastAPI. The
composite-PK + partial-index tables (most of ours) fall back to plain
SQLAlchemy because SQLModel can't express them cleanly. We define both
flavors against the same `metadata` so Alembic sees the whole schema.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    MetaData,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


# Shared metadata + base. Naming convention so Alembic-generated
# constraint names are stable (otherwise it falls back to anonymous names
# that change across DB engines and break downgrades).
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

metadata = MetaData(naming_convention=NAMING_CONVENTION)


class Base(DeclarativeBase):
    metadata = metadata


# ── Reusable defaults ─────────────────────────────────────────────────

def _now() -> datetime:
    """UTC-naive 'now' — kept in one helper so we can swap to UTC-aware
    later without hunting through column defaults."""
    return datetime.utcnow()


# A timestamp that defaults to NOW() at insert time. The `server_default`
# lets the DB fill it for raw-SQL inserts (importer, ad-hoc), while
# `default=_now` covers ORM inserts where the server clock is sometimes
# slightly off the application clock.
def _ts_now() -> Column:
    return mapped_column(
        DateTime, nullable=False, default=_now, server_default=text("CURRENT_TIMESTAMP")
    )


# ── §4.1 Identity / connections ──────────────────────────────────────

class Account(Base):
    """One OF model account. Same row as service/sessions/accounts/<id>/."""
    __tablename__ = "accounts"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    nickname: Mapped[str | None] = mapped_column(String)
    color: Mapped[str | None] = mapped_column(String)
    proxy_label: Mapped[str | None] = mapped_column(String)  # soft FK → proxies.label
    x_of_rev: Mapped[str | None] = mapped_column(String)
    static_param: Mapped[str | None] = mapped_column(String)
    user_agent: Mapped[str | None] = mapped_column(String)
    is_active_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = _ts_now()
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime)


class Proxy(Base):
    """Proxy registry — replaces service/proxies.json."""
    __tablename__ = "proxies"

    label: Mapped[str] = mapped_column(String, primary_key=True)
    scheme: Mapped[str] = mapped_column(String, nullable=False)
    host: Mapped[str] = mapped_column(String, nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    username: Mapped[str | None] = mapped_column(String)
    # Encrypted at rest later (phase D). Plaintext for now to match the
    # current proxies.json — flagged in the plan as a known limitation.
    password_encrypted: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    verified_ip: Mapped[str | None] = mapped_column(String)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime)
    assigned_account_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="SET NULL")
    )


class Session(Base):
    """Captured session blobs — replaces session_*.json files."""
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False
    )
    captured_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    cookies_json: Mapped[str] = mapped_column(Text, nullable=False)
    x_of_rev: Mapped[str] = mapped_column(String, nullable=False)
    signing_rules_json: Mapped[str] = mapped_column(Text, nullable=False)
    is_latest: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    __table_args__ = (
        # Hot path: "give me the active session for account X."
        Index("ix_sessions_account_latest", "account_id", "is_latest"),
    )


class Employee(Base):
    """Your team. No passwords — the picker reads display_name + color."""
    __tablename__ = "employees"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    color: Mapped[str | None] = mapped_column(String)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = _ts_now()


class EmployeeAccountAccess(Base):
    """Which models can each employee touch. NULL account_id = all models."""
    __tablename__ = "employee_account_access"

    employee_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("employees.id", ondelete="CASCADE"), primary_key=True
    )
    # nullable + part of PK — represents "any account." SQLite tolerates
    # this via the (employee_id, COALESCE(account_id, '*')) composite-key
    # convention; we enforce uniqueness in code on insert.
    account_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )


class Action(Base):
    """Audit log — one row per mutating request, written by middleware."""
    __tablename__ = "actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("employees.id", ondelete="SET NULL")
    )
    account_id: Mapped[str | None] = mapped_column(String)
    action: Mapped[str] = mapped_column(String, nullable=False)
    target_type: Mapped[str | None] = mapped_column(String)
    target_id: Mapped[str | None] = mapped_column(String)
    payload_json: Mapped[str | None] = mapped_column(Text)
    at: Mapped[datetime] = _ts_now()

    __table_args__ = (
        Index("ix_actions_employee_at", "employee_id", "at"),
        Index("ix_actions_account_at", "account_id", "at"),
    )


# ── §4.2 Fans (the wide AI-readable table) ───────────────────────────

class Fan(Base):
    """One row per (account, fan). Wide table by design — every field the
    automation pack reads is here so gen_info / followup / of_ai_chat all
    have a single source. Heavy columns (raw_json) get their own rows in
    sibling tables when they grow."""
    __tablename__ = "fans"

    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    fan_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)

    # ── Identity (from OF) ────────────────────────────────────
    of_username: Mapped[str | None] = mapped_column(String)
    of_display_name: Mapped[str | None] = mapped_column(String)
    avatar_url: Mapped[str | None] = mapped_column(Text)

    # ── Our labels ───────────────────────────────────────────
    custom_nickname: Mapped[str | None] = mapped_column(String)
    generated_nickname: Mapped[str | None] = mapped_column(String)
    fan_chosen_nickname: Mapped[str | None] = mapped_column(String)

    # ── AI-extracted facts (Grok fills these) ────────────────
    real_name: Mapped[str | None] = mapped_column(String)
    is_name_real: Mapped[bool] = mapped_column(Boolean, default=True)
    his_age: Mapped[str | None] = mapped_column(String)
    home_country: Mapped[str | None] = mapped_column(String)
    home_city: Mapped[str | None] = mapped_column(String)
    hobbies: Mapped[str | None] = mapped_column(Text)
    fetishes: Mapped[str | None] = mapped_column(Text)
    # JSON array of {date, event}
    recent_events: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    self_description: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    likes_boobs: Mapped[bool] = mapped_column(Boolean, default=False)
    likes_ass: Mapped[bool] = mapped_column(Boolean, default=False)
    timezone: Mapped[str | None] = mapped_column(String)

    # ── Notes (may be written back to OF via apply_profiles) ─
    notes: Mapped[str | None] = mapped_column(Text)
    applied_notes: Mapped[str | None] = mapped_column(Text)
    applied_notes_at: Mapped[datetime | None] = mapped_column(DateTime)

    # ── Tags / custom fields ─────────────────────────────────
    tags: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    custom_fields: Mapped[str] = mapped_column(Text, nullable=False, default="{}")

    # ── Behavior counters (denormalized) ─────────────────────
    lifetime_spend_cents: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    total_likes: Mapped[int | None] = mapped_column(Integer)
    is_bot: Mapped[bool] = mapped_column(Boolean, default=False)
    turn_counter: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    bought_amount: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False, default=0)

    # ── Timestamps (rebuildable from messages but cached for speed) ─
    last_message_received_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_message_sent_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_online_at: Mapped[datetime | None] = mapped_column(DateTime)
    subscribed_at: Mapped[datetime | None] = mapped_column(DateTime)
    subscription_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    subscription_status: Mapped[str | None] = mapped_column(String)
    is_followed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    joined_date: Mapped[str | None] = mapped_column(String)

    # ── deep_convo state machine (4-step engagement drill) ───
    deep_convo_state: Mapped[str] = mapped_column(String, nullable=False, default="missing")
    deep_convo_skip_level: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    deep_convo_skip_remaining: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    deep_convo_updated_at: Mapped[datetime | None] = mapped_column(DateTime)
    deep_convo_q_text: Mapped[str | None] = mapped_column(Text)
    deep_convo_tease_text: Mapped[str | None] = mapped_column(Text)

    source: Mapped[str] = mapped_column(String, nullable=False, default="onlyfans")
    raw_json: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = _ts_now()
    updated_at: Mapped[datetime] = _ts_now()

    __table_args__ = (
        Index("ix_fans_last_msg", "account_id", "last_message_received_at"),
        Index("ix_fans_spend", "account_id", "lifetime_spend_cents"),
    )


# ── §4.3 Messages (every word forever) ───────────────────────────────

class Message(Base):
    """One row per OF message. message_id is OF's native id — primary
    dedup key. temp_id is client-generated for optimistic reconcile."""
    __tablename__ = "messages"

    account_id: Mapped[str] = mapped_column(String, primary_key=True)
    fan_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    message_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    direction: Mapped[str] = mapped_column(String, nullable=False)  # 'in' | 'out' | 'system'
    sender_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    media_ids: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    media_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # NULL = no PPV at all; False = PPV not yet purchased; True = unlocked.
    is_paid: Mapped[bool | None] = mapped_column(Boolean)
    is_tip: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    purchased_at: Mapped[datetime | None] = mapped_column(DateTime)
    is_unsent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    sent_by_employee_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("employees.id", ondelete="SET NULL")
    )
    temp_id: Mapped[str | None] = mapped_column(String)

    mass_run_id: Mapped[int | None] = mapped_column(Integer)  # FK declared via table_args
    funnel_step: Mapped[int | None] = mapped_column(Integer)

    raw_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)  # OF's createdAt
    ingested_at: Mapped[datetime] = _ts_now()

    __table_args__ = (
        ForeignKeyConstraint(["mass_run_id"], ["mass_runs.id"], ondelete="SET NULL"),
        Index("ix_messages_account_fan_time", "account_id", "fan_id", "created_at"),
        # Partial index — only the rows with active temp_ids participate
        # in the reconcile lookup. Tiny on most DBs because rare.
        Index(
            "ix_messages_temp",
            "account_id",
            "temp_id",
            sqlite_where=text("temp_id IS NOT NULL"),
            postgresql_where=text("temp_id IS NOT NULL"),
        ),
        Index(
            "ix_messages_mass",
            "mass_run_id",
            sqlite_where=text("mass_run_id IS NOT NULL"),
            postgresql_where=text("mass_run_id IS NOT NULL"),
        ),
    )


class MessageFlag(Base):
    """Per-employee local flags. Never sent to OF."""
    __tablename__ = "message_flags"

    account_id: Mapped[str] = mapped_column(String, primary_key=True)
    fan_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    message_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    flagged_by_employee_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("employees.id", ondelete="CASCADE"), primary_key=True
    )
    flagged_unread: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    starred: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = _ts_now()


class ScrapeHistory(Base):
    """Last-seen-message fast-skip — ported verbatim from the automation pack."""
    __tablename__ = "scrape_history"

    account_id: Mapped[str] = mapped_column(String, primary_key=True)
    fan_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    last_message_id: Mapped[int | None] = mapped_column(BigInteger)
    last_message_text: Mapped[str | None] = mapped_column(Text)
    last_scrape_at: Mapped[datetime] = _ts_now()


# ── §4.4 Transactions (split for fast spend queries) ─────────────────

class Transaction(Base):
    """Every PPV unlock, tip, subscription, rebill, custom. Separate
    table so 'lifetime spend by fan' and 'revenue by day' are single
    index scans instead of message aggregates."""
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False
    )
    fan_id: Mapped[int | None] = mapped_column(BigInteger)  # NULL for subscription rebills
    kind: Mapped[str] = mapped_column(String, nullable=False)
    message_id: Mapped[int | None] = mapped_column(BigInteger)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(String, nullable=False, default="USD")
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    raw_json: Mapped[str | None] = mapped_column(Text)
    ingested_at: Mapped[datetime] = _ts_now()

    __table_args__ = (
        Index("ix_tx_account_time", "account_id", "occurred_at"),
        Index(
            "ix_tx_fan_time",
            "account_id",
            "fan_id",
            "occurred_at",
            sqlite_where=text("fan_id IS NOT NULL"),
            postgresql_where=text("fan_id IS NOT NULL"),
        ),
        Index("ix_tx_kind", "account_id", "kind", "occurred_at"),
    )


# ── §4.5 Vault / Posts / Chats / Lists ──────────────────────────────

class Chat(Base):
    """One row per conversation = (account, fan). Hot-read for the inbox list."""
    __tablename__ = "chats"

    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    fan_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    last_message_id: Mapped[int | None] = mapped_column(BigInteger)
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_message_preview: Mapped[str | None] = mapped_column(Text)
    unread_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_priority: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    hidden_locally: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    list_ids: Mapped[str] = mapped_column(Text, nullable=False, default="[]")

    __table_args__ = (
        # Powers the unified-inbox ORDER BY.
        Index("ix_chats_last_msg", "last_message_at"),
    )


class VaultItem(Base):
    """OF vault mirror + our metadata."""
    __tablename__ = "vault_items"

    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    media_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    kind: Mapped[str] = mapped_column(String, nullable=False)

    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    thumb_url: Mapped[str | None] = mapped_column(Text)
    full_url: Mapped[str | None] = mapped_column(Text)
    folder_id: Mapped[int | None] = mapped_column(BigInteger)

    description: Mapped[str | None] = mapped_column(Text)
    suggested_price_cents: Mapped[int | None] = mapped_column(Integer)
    default_price_cents: Mapped[int | None] = mapped_column(Integer)
    tags: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    notes: Mapped[str | None] = mapped_column(Text)
    send_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime)

    raw_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    __table_args__ = (
        Index("ix_vault_account_created", "account_id", "created_at"),
        Index("ix_vault_account_send", "account_id", "send_count"),
    )


class VaultPreset(Base):
    """Named "send image at folder X index N." Resolves per-model at send
    time so a single preset works across all your models. See plan §13.12."""
    __tablename__ = "vault_presets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    folder_name: Mapped[str] = mapped_column(String, nullable=False)
    index_in_folder: Mapped[int | None] = mapped_column(Integer)
    index_strategy: Mapped[str] = mapped_column(String, nullable=False, default="fixed")
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _ts_now()


class SavedReply(Base):
    """Local-only saved replies (a.k.a. "templates" minus the welcome slot).

    OF's API rejects creates against `/messages/templates` for everything
    except `template=reply_on_subscribe`, so we keep saved replies in our
    own DB and never round-trip them through OF. The welcome message
    stays on OF.

    `media_json` is a serialized array of vault-media references
    (`[{id, type, files?}]`) so the editor can re-render thumbs without
    a second fetch. We don't FK to vault_items because the media may
    not have been imported yet on first edit. """
    __tablename__ = "saved_replies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False,
    )
    title: Mapped[str | None] = mapped_column(String)   # short label for the picker
    text: Mapped[str] = mapped_column(Text, nullable=False)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_text: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    media_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    created_at: Mapped[datetime] = _ts_now()
    updated_at: Mapped[datetime] = _ts_now()

    __table_args__ = (
        Index("ix_saved_replies_account", "account_id", "updated_at"),
    )


class VaultSend(Base):
    """Per-fan send history. Powers 'remember new price' + analytics."""
    __tablename__ = "vault_sends"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[str] = mapped_column(String, nullable=False)
    fan_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    media_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    message_id: Mapped[int | None] = mapped_column(BigInteger)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sent_at: Mapped[datetime] = _ts_now()
    was_purchased: Mapped[bool | None] = mapped_column(Boolean)

    __table_args__ = (
        Index("ix_vault_sends_fan", "account_id", "fan_id", "sent_at"),
        Index("ix_vault_sends_media", "account_id", "media_id", "sent_at"),
    )


class Post(Base):
    """Draft / scheduled / posted / failed — the post timeline."""
    __tablename__ = "posts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False
    )
    of_post_id: Mapped[int | None] = mapped_column(BigInteger)
    temp_id: Mapped[str | None] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, nullable=False)
    text: Mapped[str | None] = mapped_column(Text)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    media_ids: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    label_ids: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime)
    posted_at: Mapped[datetime | None] = mapped_column(DateTime)
    failed_reason: Mapped[str | None] = mapped_column(Text)
    excluded_list_ids: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    created_by_employee_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("employees.id", ondelete="SET NULL")
    )
    raw_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _ts_now()
    updated_at: Mapped[datetime] = _ts_now()

    __table_args__ = (
        Index("ix_posts_account_status", "account_id", "status", "scheduled_for"),
    )


class List(Base):
    """OF list / our local list. kind drives behavior:
       regular     — mirrors an OF list
       exclude     — automatic skip in mass DM
       hidden      — drop from default inbox
       post_label  — labels on profile posts
       smart       — saved query (query_json)"""
    __tablename__ = "lists"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False
    )
    of_list_id: Mapped[int | None] = mapped_column(BigInteger)
    name: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    query_json: Mapped[str | None] = mapped_column(Text)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = _ts_now()


class ListMember(Base):
    __tablename__ = "list_members"

    list_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("lists.id", ondelete="CASCADE"), primary_key=True
    )
    fan_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    added_at: Mapped[datetime] = _ts_now()
    added_by_employee_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("employees.id", ondelete="SET NULL")
    )


# ── §4.6 AI / automation tables ─────────────────────────────────────

class FanProfile(Base):
    """Grok-generated profile. Linked back to the grok_calls row that produced it."""
    __tablename__ = "fan_profiles"

    account_id: Mapped[str] = mapped_column(String, primary_key=True)
    fan_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    original_name: Mapped[str | None] = mapped_column(String)
    message_count_at_gen: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_spend_at_gen_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    nickname: Mapped[str | None] = mapped_column(String)
    short_bio: Mapped[str | None] = mapped_column(Text)
    bullet_points: Mapped[str | None] = mapped_column(Text)
    q1: Mapped[str | None] = mapped_column(Text)
    q2: Mapped[str | None] = mapped_column(Text)
    q3: Mapped[str | None] = mapped_column(Text)
    tease1: Mapped[str | None] = mapped_column(Text)
    tease2: Mapped[str | None] = mapped_column(Text)
    tease3: Mapped[str | None] = mapped_column(Text)
    applied_notes: Mapped[str | None] = mapped_column(Text)
    notes_applied_successfully: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_applied_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_applied_nickname: Mapped[str | None] = mapped_column(String)
    last_applied_notes: Mapped[str | None] = mapped_column(Text)
    last_generated_at: Mapped[datetime] = _ts_now()
    # Cross-reference to the prompt that generated this profile + the call audit row.
    generated_by_grok_call_id: Mapped[int | None] = mapped_column(Integer)


class FollowupState(Base):
    """Drip state machine — 26h → 64h → 256h thresholds (automation pack §07)."""
    __tablename__ = "followup_state"

    account_id: Mapped[str] = mapped_column(String, primary_key=True)
    fan_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    phase: Mapped[str] = mapped_column(String, nullable=False, default="tracking")
    cycle: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    silence_started_at: Mapped[datetime | None] = mapped_column(DateTime)
    fan_last_reply_at: Mapped[datetime | None] = mapped_column(DateTime)
    cooldown_until: Mapped[datetime | None] = mapped_column(DateTime)
    messages_sent: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    completed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    stopped_at: Mapped[datetime | None] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = _ts_now()


class WelcomeSent(Base):
    """Dedup welcome-message sends per fan."""
    __tablename__ = "welcome_sent"

    account_id: Mapped[str] = mapped_column(String, primary_key=True)
    fan_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    fan_username: Mapped[str | None] = mapped_column(String)
    sent_at: Mapped[datetime] = _ts_now()


class SkipList(Base):
    """Per-account 'don't auto-reply' list."""
    __tablename__ = "skip_list"

    account_id: Mapped[str] = mapped_column(String, primary_key=True)
    fan_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    reason: Mapped[str | None] = mapped_column(String)
    added_at: Mapped[datetime] = _ts_now()


class Blacklist(Base):
    """Global ban — applies across every model."""
    __tablename__ = "blacklist"

    fan_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    reason: Mapped[str | None] = mapped_column(String)
    added_at: Mapped[datetime] = _ts_now()


class AccountAiConfig(Base):
    """Per-model AI voice + caps. Persona + time_activities used by welcome/followup."""
    __tablename__ = "account_ai_config"

    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    persona: Mapped[str | None] = mapped_column(Text)
    welcome_rules: Mapped[str | None] = mapped_column(Text)
    utc_offset: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    location: Mapped[str | None] = mapped_column(String)
    # JSON dict {morning_1, morning_2, afternoon_1, afternoon_2, evening, night}
    time_activities_json: Mapped[str | None] = mapped_column(Text)
    daily_cost_cap_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    updated_at: Mapped[datetime] = _ts_now()


class MassMessageFunnel(Base):
    """Funnel definitions — port of the JSON funnels (automation pack §15) into DB."""
    __tablename__ = "mass_message_funnels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    description: Mapped[str | None] = mapped_column(Text)
    opening_message: Mapped[str] = mapped_column(Text, nullable=False)
    vault_folder: Mapped[str | None] = mapped_column(String)
    media_indices: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    opening_vault_folder: Mapped[str | None] = mapped_column(String)
    opening_media_indices: Mapped[str | None] = mapped_column(Text)
    steps_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = _ts_now()
    updated_at: Mapped[datetime] = _ts_now()


class MassRun(Base):
    """One broadcast = one mass_runs row. funnel_state links per-fan state to this."""
    __tablename__ = "mass_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id"), nullable=False
    )
    funnel_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("mass_message_funnels.id")
    )
    started_by_employee_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("employees.id")
    )
    audience_filter: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    recipient_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    started_at: Mapped[datetime] = _ts_now()
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String, nullable=False, default="running")


class FunnelState(Base):
    """Per-(mass_run, fan) state machine for reply_mass_funnel."""
    __tablename__ = "funnel_state"

    mass_run_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("mass_runs.id", ondelete="CASCADE"), primary_key=True
    )
    fan_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    current_step: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_check_at: Mapped[datetime | None] = mapped_column(DateTime)
    check_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")
    last_error: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = _ts_now()


class AutomationRule(Base):
    """Declarative automation. Produces scheduled_jobs at runtime."""
    __tablename__ = "automation_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    trigger_json: Mapped[str] = mapped_column(Text, nullable=False)
    steps_json: Mapped[str] = mapped_column(Text, nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    quiet_hours_json: Mapped[str | None] = mapped_column(Text)
    frequency_caps_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _ts_now()


class ScheduledJob(Base):
    """Worker queue. The single async worker reads from this."""
    __tablename__ = "scheduled_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String, nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    run_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    rule_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("automation_rules.id", ondelete="SET NULL")
    )
    created_by_employee_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("employees.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = _ts_now()

    __table_args__ = (
        Index("ix_jobs_due", "run_at", "status"),
    )


class AutomationRun(Base):
    """Periodic-run audit log. So you can see 'gen_info_sweep last ran 8 min ago.'"""
    __tablename__ = "automation_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[str | None] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    started_at: Mapped[datetime] = _ts_now()
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String, nullable=False, default="running")
    stats_json: Mapped[str | None] = mapped_column(Text)
    error_text: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        Index("ix_runs_kind_started", "kind", "started_at"),
    )


# ── §4.7 Prompts (editable templates, versioned) ────────────────────

class Prompt(Base):
    """Editable Grok prompt template. Per-account override via NULL fallback.
    Variables substituted at call time via simple {{var}} replacement."""
    __tablename__ = "prompts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    purpose: Mapped[str] = mapped_column(String, nullable=False)
    account_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE")
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    variables_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = _ts_now()
    created_by_employee_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("employees.id", ondelete="SET NULL")
    )

    __table_args__ = (
        # (name, account_id, version) is unique. SQLite treats NULL as
        # distinct in UNIQUE, so all-NULL account_id rows coexist by name.
        UniqueConstraint("name", "account_id", "version", name="uq_prompts_name_account_version"),
        # Active lookup: (name, account_id) → highest active version.
        Index(
            "ix_prompts_active",
            "name",
            "account_id",
            "version",
            sqlite_where=text("is_active = 1"),
            postgresql_where=text("is_active = TRUE"),
        ),
    )


# ── §4.8 Grok call log ──────────────────────────────────────────────

class GrokCall(Base):
    """Every Grok API call. Logged BEFORE the request so failures don't lose audit."""
    __tablename__ = "grok_calls"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    purpose: Mapped[str] = mapped_column(String, nullable=False)
    account_id: Mapped[str | None] = mapped_column(String)
    fan_id: Mapped[int | None] = mapped_column(BigInteger)
    model: Mapped[str] = mapped_column(String, nullable=False)
    endpoint: Mapped[str] = mapped_column(String, nullable=False)
    temperature: Mapped[float | None] = mapped_column(Numeric(4, 2))
    prompt_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("prompts.id", ondelete="SET NULL")
    )
    prompt_json: Mapped[str] = mapped_column(Text, nullable=False)
    response_json: Mapped[str | None] = mapped_column(Text)
    response_text: Mapped[str | None] = mapped_column(Text)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    tokens_in: Mapped[int | None] = mapped_column(Integer)
    tokens_out: Mapped[int | None] = mapped_column(Integer)
    cost_cents: Mapped[int | None] = mapped_column(Integer)
    was_dry_run: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    error_text: Mapped[str | None] = mapped_column(Text)
    called_at: Mapped[datetime] = _ts_now()

    __table_args__ = (
        Index("ix_grok_purpose_time", "purpose", "called_at"),
        Index(
            "ix_grok_fan",
            "account_id",
            "fan_id",
            "called_at",
            sqlite_where=text("fan_id IS NOT NULL"),
            postgresql_where=text("fan_id IS NOT NULL"),
        ),
        Index("ix_grok_prompt", "prompt_id", "called_at"),
    )


class GrokDailyCost(Base):
    """Daily Grok spend rollup. Source of truth for the soft cap enforcement."""
    __tablename__ = "grok_daily_cost"

    day: Mapped[str] = mapped_column(String, primary_key=True)  # 'YYYY-MM-DD' UTC
    cost_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    call_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_capped: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = _ts_now()


# ── §4.9 Realtime / event inbox ─────────────────────────────────────

class EventInbox(Base):
    """Every WS event lands here first. Idempotent via (source, provider_event_id)."""
    __tablename__ = "event_inbox"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE")
    )
    source: Mapped[str] = mapped_column(String, nullable=False)
    provider_event_id: Mapped[str | None] = mapped_column(String)
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    received_at: Mapped[datetime] = _ts_now()
    processed_at: Mapped[datetime | None] = mapped_column(DateTime)
    processed_status: Mapped[str | None] = mapped_column(String)
    processed_error: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        # Partial unique — only enforced when provider_event_id is present.
        Index(
            "uq_event_dedupe",
            "source",
            "provider_event_id",
            unique=True,
            sqlite_where=text("provider_event_id IS NOT NULL"),
            postgresql_where=text("provider_event_id IS NOT NULL"),
        ),
        Index(
            "ix_event_unprocessed",
            "processed_at",
            sqlite_where=text("processed_at IS NULL"),
            postgresql_where=text("processed_at IS NULL"),
        ),
    )


# ── §4.9b Application error log ─────────────────────────────────────

class AppError(Base):
    """Bug-hunter table: every unhandled exception (server or browser)
    lands here so we can review them without scraping log files.

    `source`  = "server" (FastAPI middleware) | "browser" (POSTed from
                the useErrorReporter hook).
    `kind`    = short tag — "unhandledrejection", "react-render",
                "fetch-error", "HTTPException", etc. Free-form; we just
                use it for filtering in /admin/errors.
    `message` = e.message or whatever short label the source provides.
    `stack`   = full stack trace if available.
    `url`     = window.location.href (browser) / request.url (server).
    `context` = JSON blob with anything else worth keeping (account_id,
                employee_id, user agent, query params, …).
    """
    __tablename__ = "app_errors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    occurred_at: Mapped[datetime] = _ts_now()
    source: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False, default="error")
    message: Mapped[str] = mapped_column(Text, nullable=False)
    stack: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    account_id: Mapped[str | None] = mapped_column(String)
    employee_id: Mapped[int | None] = mapped_column(Integer)
    user_agent: Mapped[str | None] = mapped_column(Text)
    context_json: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        Index("ix_app_errors_occurred", "occurred_at"),
        Index("ix_app_errors_source_kind", "source", "kind"),
    )


# ── §4.10 Speeds ─────────────────────────────────────────────────────

class Shortcut(Base):
    """Per-employee shortcuts: emoji bar, text replacements, hotkeys, scripts, chat jumps."""
    __tablename__ = "shortcuts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("employees.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String, nullable=False)
    trigger: Mapped[str | None] = mapped_column(String)
    body: Mapped[str | None] = mapped_column(Text)
    media_ids: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    price_cents: Mapped[int | None] = mapped_column(Integer)
    hotkey: Mapped[str | None] = mapped_column(String)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


# ── §4.11 Wall-media scan (incremental "posted on wall" tracking) ────

class WallMedia(Base):
    """Vault media IDs we've ever observed in this model's wall posts.
    Drives the blue "posted on wall" ring in the VaultPicker.

    Populated incrementally by /admin/vault/wall-media — each call walks
    OF's /posts feed forward (or backwards during backfill) and upserts
    rows here. Lookups read the union of every row for the account, so
    the ring is eventually-correct for prolific creators with >250
    lifetime posts (the old in-memory cap silently mis-flagged those)."""
    __tablename__ = "wall_media"

    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    media_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    post_id: Mapped[int | None] = mapped_column(BigInteger)
    # Wall-post publishedAt — used during backfill to walk older history
    # via OF's before_publish_time cursor.
    post_published_at: Mapped[datetime | None] = mapped_column(DateTime)
    first_seen_at: Mapped[datetime] = _ts_now()

    # Redundant w/ the composite PK's leading column on SQLite, but kept
    # so `create_all()` and the Alembic migration produce identical
    # schemas across fresh-install / migrate paths.
    __table_args__ = (
        Index("ix_wall_media_account_id", "account_id"),
    )


class PerfEventRow(Base):
    """Client-side perfLog events, batch-ingested from the frontend so we
    can ask things like "across all chatters, what's the p95 from
    `vault.media requested` → `delivered`?" or "are popout windows on
    LAN-tunnel hosts slower than direct same-host opens?".

    Append-only. Pruned by `_perf_events_evict_once()` on a background
    timer (default 7 days; tune via env). No FK to accounts — the
    employee/account identity is best-effort `meta` payload, since the
    frontend may not know either at the moment a tab.open fires."""
    __tablename__ = "perf_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tab_id: Mapped[str] = mapped_column(String, nullable=False)
    parent_tab_id: Mapped[str | None] = mapped_column(String)
    op_id: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    phase: Mapped[str] = mapped_column(String, nullable=False)
    # Client epoch ms — store as BigInteger because raw ms is more useful
    # than a parsed datetime when reconstructing intra-second sequences
    # (multiple events can land in the same millisecond).
    client_ts_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    received_at: Mapped[datetime] = _ts_now()
    # Soft identity hints — present when the client knew them at log time.
    employee_id: Mapped[int | None] = mapped_column(Integer)
    account_id: Mapped[str | None] = mapped_column(String)
    # JSON-encoded free-form meta. Capped at INGEST_META_MAX_BYTES
    # server-side so a runaway logger can't blow the row size.
    meta_json: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        Index("ix_perf_events_received_at", "received_at"),
        Index("ix_perf_events_tab_kind", "tab_id", "kind"),
        Index("ix_perf_events_op", "op_id"),
    )


class WallScanState(Base):
    """Per-account scan watermark for the wall-media walker. One row per
    account.

    Two phases:
      • Backfill (fully_backfilled=False): we haven't seen the bottom of
        the post feed yet. Subsequent calls walk backward from
        oldest_post_published_at.
      • Refresh (fully_backfilled=True): we've reached the bottom. Each
        call walks forward and stops as soon as it hits a post with
        publishedAt <= newest_post_published_at."""
    __tablename__ = "wall_scan_state"

    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    newest_post_published_at: Mapped[datetime | None] = mapped_column(DateTime)
    oldest_post_published_at: Mapped[datetime | None] = mapped_column(DateTime)
    fully_backfilled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_scan_at: Mapped[datetime | None] = mapped_column(DateTime)
    scanned_posts_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
