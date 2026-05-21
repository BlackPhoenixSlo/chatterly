"""
fans.py — server-side endpoints for the per-fan drawer / profile view.

Two endpoints, both keyed on (account_id, fan_id):

  GET    /admin/fans/{account_id}/{fan_id}   → full row (creates a stub if
                                               we haven't seen this fan yet)
  PATCH  /admin/fans/{account_id}/{fan_id}   → write custom_nickname, notes,
                                               tags (string list as JSON)

The OF user details (display name, avatar) are intentionally NOT mirrored
here — those go stale, and the inbox already batch-fetches /users/list to
get fresh ones. Our DB stores the human-curated overlay: nickname our team
picked, notes, tags, plus the auto-computed lifetime_spend_cents the event
transcoder will fill once Phase B.3 starts persisting transactions.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from db.engine import get_session
from db.models import Account, Fan, Transaction


async def _ensure_account_row(s: AsyncSession, account_id: str) -> None:
    """Insert a minimal accounts row if missing. The FS-based account
    registry (sessions/accounts/<id>/) is the source of truth for who's
    logged in, but the DB `accounts` table only gets populated by
    `import_legacy` or explicit calls. Without a row here, any FK→accounts
    insert (fans, transactions, etc.) raises IntegrityError. Idempotent —
    safe to call on every write path that touches account-scoped tables."""
    stmt = (
        sqlite_insert(Account)
        .values(id=account_id, is_active_default=False)
        .on_conflict_do_nothing(index_elements=["id"])
    )
    await s.execute(stmt)

log = logging.getLogger("of-relay.fans")
router = APIRouter()


def _row_to_dict(f: Fan) -> dict[str, Any]:
    return {
        "account_id": f.account_id,
        "fan_id": f.fan_id,
        "of_username": f.of_username,
        "of_display_name": f.of_display_name,
        "avatar_url": f.avatar_url,
        "custom_nickname": f.custom_nickname,
        "generated_nickname": f.generated_nickname,
        "real_name": f.real_name,
        "his_age": f.his_age,
        "home_country": f.home_country,
        "home_city": f.home_city,
        "hobbies": f.hobbies,
        "fetishes": f.fetishes,
        "self_description": f.self_description,
        "description": f.description,
        "notes": f.notes,
        "tags": _safe_load_list(f.tags),
        "lifetime_spend_cents": f.lifetime_spend_cents,
        "bought_amount": float(f.bought_amount or 0),
        "subscription_status": f.subscription_status,
        "subscribed_at": f.subscribed_at.isoformat() if f.subscribed_at else None,
        "last_message_received_at": (
            f.last_message_received_at.isoformat() if f.last_message_received_at else None
        ),
        "source": f.source,
        "is_followed": f.is_followed,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "updated_at": f.updated_at.isoformat() if f.updated_at else None,
    }


def _safe_load_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        v = json.loads(raw)
        return [str(x) for x in v] if isinstance(v, list) else []
    except (ValueError, TypeError):
        return []


class FanUpdateBody(BaseModel):
    custom_nickname: str | None = Field(None, description="Set null to clear")
    notes: str | None = None
    tags: list[str] | None = None
    real_name: str | None = None
    home_country: str | None = None
    home_city: str | None = None
    his_age: str | None = None
    hobbies: str | None = None
    fetishes: str | None = None


# NOTE: route order matters. FastAPI matches paths in declaration order
# and falls through on path-param TYPE failure — so the literal-third-
# segment routes (`by-ids`, `spend-batch`) MUST be declared BEFORE the
# int-parameter route `/{fan_id}`, otherwise "by-ids" gets matched as
# fan_id, fails int parsing, and returns 422 ("Input should be a valid
# integer"). The single-segment `/admin/fans/{account_id}` route can
# live anywhere — its shape doesn't collide.


@router.get("/admin/fans/{account_id}")
async def list_recent_fans(account_id: str, limit: int = 50) -> dict[str, Any]:
    """Recently-active fans for this account — primarily used by a future
    fan-browser screen. The inbox doesn't call this; it uses OF's chat list."""
    limit = max(1, min(int(limit or 50), 200))
    async with get_session() as s:
        q = (
            select(Fan)
            .where(Fan.account_id == account_id)
            .order_by(Fan.last_message_received_at.desc().nullslast())
            .limit(limit)
        )
        rows = (await s.execute(q)).scalars().all()
        return {"fans": [_row_to_dict(r) for r in rows]}


@router.get("/admin/fans/{account_id}/by-ids")
async def fans_by_ids(
    account_id: str,
    ids: str = Query("", description="Comma-separated fan ids (max 200)"),
) -> dict[str, Any]:
    """Bulk identity lookup against our LOCAL SQLite `fans` table.

    Returns `{fans: {fan_id_str: {id, name, username, avatar}}}` for every id
    we have a row for. Missing ids are omitted; the caller decides whether
    to back-fill from OF /users/list (paying the upstream cost) or accept
    the gap. Avatars come from the WS transcoder, which writes them
    whenever a message lands — covers anyone the model has talked to.

    Used by the chat-list enrichment to instantly paint names+avatars
    from local data instead of firing 8 parallel /users/list batches on
    every chats refetch. Cap at 200 ids per call to keep the IN-clause
    scan cheap on the (account_id, fan_id) composite primary key."""
    parsed: list[int] = []
    for chunk in ids.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            parsed.append(int(chunk))
        except ValueError:
            continue
    if not parsed:
        return {"fans": {}}
    parsed = parsed[:200]

    out: dict[str, dict[str, Any]] = {}
    async with get_session() as s:
        rows = (await s.execute(
            select(
                Fan.fan_id, Fan.of_username, Fan.of_display_name,
                Fan.avatar_url, Fan.custom_nickname,
            )
            .where(Fan.account_id == account_id, Fan.fan_id.in_(parsed))
        )).all()
        for fid, uname, dname, avatar, nickname in rows:
            out[str(fid)] = {
                "id": int(fid),
                "name": dname,
                "username": uname,
                "avatar": avatar,
                "customNickname": nickname,
            }
    return {"fans": out}


@router.get("/admin/fans/{account_id}/spend-batch")
async def fans_spend_batch(
    account_id: str,
    ids: str = Query("", description="Comma-separated fan ids"),
) -> dict[str, Any]:
    """Bulk spend lookup for ChatList row chips.

    Returns lifetime_spend_cents + last_purchase_at per fan, keyed by
    fan_id (string). Missing fans are omitted (frontend treats absence
    as $0 / no purchase). Caps at 200 ids per call so the index scan
    on (account_id, fan_id) stays cheap."""
    parsed: list[int] = []
    for chunk in ids.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            parsed.append(int(chunk))
        except ValueError:
            continue
    if not parsed:
        return {"spend": {}}
    parsed = parsed[:200]

    out: dict[str, dict[str, Any]] = {}
    async with get_session() as s:
        # Spend (denormalized on Fan).
        rows = (await s.execute(
            select(Fan.fan_id, Fan.lifetime_spend_cents)
            .where(Fan.account_id == account_id, Fan.fan_id.in_(parsed))
        )).all()
        for fid, cents in rows:
            out[str(fid)] = {"spend_cents": int(cents or 0), "last_purchase_at": None}

        # Last purchase timestamp — single grouped MAX query.
        tx_rows = (await s.execute(
            select(Transaction.fan_id, func.max(Transaction.occurred_at))
            .where(
                Transaction.account_id == account_id,
                Transaction.fan_id.in_(parsed),
                Transaction.amount_cents > 0,
            )
            .group_by(Transaction.fan_id)
        )).all()
        for fid, ts in tx_rows:
            if fid is None:
                continue
            entry = out.setdefault(str(fid), {"spend_cents": 0, "last_purchase_at": None})
            entry["last_purchase_at"] = ts.isoformat() if ts else None

    return {"spend": out}


# ── /{fan_id} routes — MUST be declared after every literal-third-segment
#    route above (see ordering note near FanUpdateBody). ────────────────

@router.get("/admin/fans/{account_id}/{fan_id}")
async def get_fan(account_id: str, fan_id: int) -> dict[str, Any]:
    """Return the fan row. Creates an empty stub on first access so the
    drawer always has a row to edit — avoids 404-then-create dance from
    the UI."""
    async with get_session() as s:
        f = await s.get(Fan, (account_id, fan_id))
        if f is None:
            await _ensure_account_row(s, account_id)
            f = Fan(account_id=account_id, fan_id=fan_id, source="onlyfans")
            s.add(f)
            await s.commit()
            await s.refresh(f)
        return _row_to_dict(f)


@router.patch("/admin/fans/{account_id}/{fan_id}")
async def update_fan(
    account_id: str, fan_id: int, body: FanUpdateBody = Body(...),
) -> dict[str, Any]:
    """Partial update. Only fields explicitly present in the body are
    written; null is a deliberate clear, omission is "leave alone"."""
    payload = body.model_dump(exclude_unset=True)
    async with get_session() as s:
        f = await s.get(Fan, (account_id, fan_id))
        if f is None:
            await _ensure_account_row(s, account_id)
            f = Fan(account_id=account_id, fan_id=fan_id, source="onlyfans")
            s.add(f)
        for k, v in payload.items():
            if k == "tags":
                f.tags = json.dumps(v or [])
            else:
                setattr(f, k, v)
        f.updated_at = datetime.utcnow()
        await s.commit()
        await s.refresh(f)
        return _row_to_dict(f)
