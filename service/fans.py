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

from db.engine import get_session
from db.models import Fan, Transaction

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


@router.get("/admin/fans/{account_id}/{fan_id}")
async def get_fan(account_id: str, fan_id: int) -> dict[str, Any]:
    """Return the fan row. Creates an empty stub on first access so the
    drawer always has a row to edit — avoids 404-then-create dance from
    the UI."""
    async with get_session() as s:
        f = await s.get(Fan, (account_id, fan_id))
        if f is None:
            f = Fan(account_id=account_id, fan_id=fan_id, source="onlyfans")
            s.add(f)
            await s.commit()
            await s.refresh(f)
        return _row_to_dict(f)


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
