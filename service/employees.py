"""
Employee CRUD + audit middleware.

The "employee picker" is auth-lite: no passwords, no sessions. The user
clicks who they are on first page load; the browser stores the chosen id
in localStorage and sends it as `X-Employee-Id` on every subsequent call.
The relay treats that header as the actor for audit purposes and refuses
to mutate state without it (in phase D — phase A only logs).

This module owns:
  • `GET    /admin/employees`           — list active + inactive
  • `POST   /admin/employees`           — create
  • `PATCH  /admin/employees/{id}`      — rename / recolor / disable
  • `DELETE /admin/employees/{id}`      — soft-delete (sets is_active=false)
  • `GET    /admin/audit`               — paginated audit log
  • `audit_middleware`                  — FastAPI middleware that writes
    a row to `actions` for every mutating request that succeeded.

Why a separate file and not inline in server.py: server.py is already
~2200 lines. Each new concern that fits cleanly into its own module
saves us a refactor pain later. Imported once from server.py at startup.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import desc, select

from db.engine import get_session
from db.models import Action, Employee

log = logging.getLogger("of-relay.employees")

router = APIRouter()

# Default colors cycled when an employee is created without one specified.
# Picked to be distinguishable on the dark UI + colorblind-safe enough.
_DEFAULT_COLORS = [
    "#8b5cf6",  # violet
    "#22d3ee",  # cyan
    "#f59e0b",  # amber
    "#ef4444",  # red
    "#10b981",  # emerald
    "#ec4899",  # pink
    "#84cc16",  # lime
    "#06b6d4",  # sky
]


# ── CRUD endpoints ────────────────────────────────────────────────────

class _EmployeeCreateBody(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=64)
    color: str | None = Field(None, description="Hex color; defaults to a cycled palette entry")
    is_active: bool = True


class _EmployeeUpdateBody(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=64)
    color: str | None = None
    is_active: bool | None = None


@router.get("/admin/employees")
async def list_employees(include_disabled: bool = Query(True)) -> dict[str, Any]:
    """Every employee row. The browser picker reads this on first load.

    Default returns all rows so the Settings → Employees table can show
    both active and disabled (with a strikethrough). Pass
    `?include_disabled=false` for the inline picker dropdown.
    """
    async with get_session() as s:
        stmt = select(Employee).order_by(Employee.created_at)
        if not include_disabled:
            stmt = stmt.where(Employee.is_active == True)  # noqa: E712
        rows = (await s.execute(stmt)).scalars().all()
        return {
            "employees": [
                {
                    "id": e.id,
                    "display_name": e.display_name,
                    "color": e.color,
                    "is_active": e.is_active,
                    "created_at": e.created_at.isoformat() if e.created_at else None,
                }
                for e in rows
            ]
        }


@router.post("/admin/employees")
async def create_employee(body: _EmployeeCreateBody = Body(...)) -> dict[str, Any]:
    """Create one. No de-dupe on display_name — Tim and Tim coexist if you
    want them to. The picker disambiguates by id."""
    async with get_session() as s:
        # Cycle colors when caller didn't pick one. We use COUNT(*) so the
        # palette index stays stable across deletions; a name-hash would
        # be prettier but invites collisions.
        if not body.color:
            count = (await s.execute(select(Employee).order_by(Employee.id))).scalars().all()
            body_color = _DEFAULT_COLORS[len(count) % len(_DEFAULT_COLORS)]
        else:
            body_color = _normalize_color(body.color)

        e = Employee(
            display_name=body.display_name.strip(),
            color=body_color,
            is_active=body.is_active,
        )
        s.add(e)
        await s.flush()
        return {
            "id": e.id,
            "display_name": e.display_name,
            "color": e.color,
            "is_active": e.is_active,
        }


@router.patch("/admin/employees/{employee_id}")
async def update_employee(
    employee_id: int, body: _EmployeeUpdateBody = Body(...)
) -> dict[str, Any]:
    """Rename, recolor, or toggle active. Empty body = no-op."""
    async with get_session() as s:
        e = await s.get(Employee, employee_id)
        if not e:
            raise HTTPException(status_code=404, detail=f"no employee with id {employee_id}")
        if body.display_name is not None:
            e.display_name = body.display_name.strip()
        if body.color is not None:
            e.color = _normalize_color(body.color)
        if body.is_active is not None:
            e.is_active = body.is_active
        return {
            "id": e.id,
            "display_name": e.display_name,
            "color": e.color,
            "is_active": e.is_active,
        }


@router.delete("/admin/employees/{employee_id}")
async def delete_employee(employee_id: int) -> dict[str, Any]:
    """SOFT delete — sets `is_active=false`. We never hard-delete because
    `actions.employee_id` keeps pointing at this row and we want the audit
    history readable. To truly remove, edit the SQL by hand."""
    async with get_session() as s:
        e = await s.get(Employee, employee_id)
        if not e:
            raise HTTPException(status_code=404, detail=f"no employee with id {employee_id}")
        e.is_active = False
        return {"ok": True, "id": employee_id, "is_active": False}


# ── Audit log read endpoint ─────────────────────────────────────────

@router.get("/admin/audit")
async def list_audit(
    employee_id: int | None = Query(None),
    account_id: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """Paginated `actions` rows, filterable by employee + account.

    Filters and pagination are server-side because the table grows
    unbounded; even at 100 actions/day it's <2 MB/year, so we don't
    bother with archival in phase A. Phase D adds a retention cron.
    """
    async with get_session() as s:
        stmt = select(Action).order_by(desc(Action.at)).limit(limit).offset(offset)
        if employee_id is not None:
            stmt = stmt.where(Action.employee_id == employee_id)
        if account_id is not None:
            stmt = stmt.where(Action.account_id == account_id)
        rows = (await s.execute(stmt)).scalars().all()
        return {
            "actions": [
                {
                    "id": a.id,
                    "employee_id": a.employee_id,
                    "account_id": a.account_id,
                    "action": a.action,
                    "target_type": a.target_type,
                    "target_id": a.target_id,
                    "payload": _safe_loads(a.payload_json),
                    "at": a.at.isoformat() if a.at else None,
                }
                for a in rows
            ],
            "limit": limit,
            "offset": offset,
        }


# ── Audit middleware ────────────────────────────────────────────────

# Endpoints we DON'T audit even when they're "POST/PATCH/DELETE." Adding
# a row for every health probe / SSE retry would drown the real signal.
_AUDIT_SKIP_PREFIXES = (
    "/health",
    "/events",
    "/ws/",
    "/admin/audit",     # don't audit reads of the audit log itself
    "/admin/rev/",       # drift probe — read-only
    "/docs",
    "/openapi.json",
    "/ui/", "/app/",     # static UI
)
# Note: do NOT include "/" here — every absolute path starts with "/", so
# `startswith("/")` would silently skip every endpoint. The root path is
# handled by the static-UI mount which only serves GET anyway.


async def audit_middleware(request: Request, call_next):
    """FastAPI HTTP middleware. Wraps every request so:
      • if method is mutating (POST / PATCH / PUT / DELETE) and the
        response is 2xx, we log a row to `actions`.
      • employee_id comes from the `X-Employee-Id` header (NULL if absent).
      • payload_json captures a truncated snapshot of the body for replay.

    Failure isolation: every step is try/except + log. A bad audit write
    never affects the actual response the user sees.
    """
    # Snapshot enough to log BEFORE call_next so a failed downstream still
    # gets recorded (with status_code set in the post-block).
    method = request.method
    path = request.url.path
    should_audit = (
        method in ("POST", "PATCH", "PUT", "DELETE")
        and not any(path.startswith(p) for p in _AUDIT_SKIP_PREFIXES)
    )

    # Reading the body consumes it; we have to re-inject for the handler.
    body_bytes = b""
    if should_audit:
        try:
            body_bytes = await request.body()
        except Exception:
            body_bytes = b""

        # Reinject so downstream handlers (Pydantic body parsers) can still
        # read it. FastAPI's request._body cache makes this stick.
        async def _receive() -> dict:
            return {"type": "http.request", "body": body_bytes, "more_body": False}
        request._receive = _receive  # type: ignore[attr-defined]

    response = await call_next(request)

    if should_audit and 200 <= response.status_code < 300:
        try:
            emp_id_raw = request.headers.get("x-employee-id")
            emp_id: int | None = None
            if emp_id_raw and emp_id_raw.isdigit():
                emp_id = int(emp_id_raw)
            account_id = (
                request.headers.get("x-account-id")
                or request.query_params.get("account_id")
            )
            await _write_action(
                employee_id=emp_id,
                account_id=account_id,
                action=f"{method} {path}",
                payload_json=_safe_snapshot(body_bytes),
                target_type=None,
                target_id=_extract_target_id(path),
            )
        except Exception:
            log.exception("audit write failed (path=%s)", path)

    return response


async def _write_action(
    *, employee_id: int | None, account_id: str | None,
    action: str, payload_json: str | None,
    target_type: str | None, target_id: str | None,
) -> None:
    async with get_session() as s:
        s.add(Action(
            employee_id=employee_id,
            account_id=account_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            payload_json=payload_json,
            at=datetime.utcnow(),
        ))


def _safe_snapshot(body_bytes: bytes) -> str | None:
    """Best-effort string snapshot of the request body for the audit log.
    JSON: pretty-print up to 4 KB. Binary: skip. Empty: NULL."""
    if not body_bytes:
        return None
    try:
        text = body_bytes.decode("utf-8", errors="replace")[:4096]
        # If it looks like JSON, normalize so the audit-log view is readable.
        try:
            parsed = json.loads(text)
            # Redact obvious secrets so audit isn't a vector for leaks.
            if isinstance(parsed, dict):
                for k in list(parsed.keys()):
                    if any(s in k.lower() for s in ("password", "token", "secret", "api_key")):
                        parsed[k] = "***"
            return json.dumps(parsed)[:4096]
        except Exception:
            return text
    except Exception:
        return None


def _extract_target_id(path: str) -> str | None:
    """Heuristic: the last path segment is the target id if it's not a
    static verb. Catches `/admin/accounts/12345678`, `/admin/proxies/hu-1`.
    Returns None for fixed-shape paths like `/admin/session/bootstrap`."""
    parts = [p for p in path.split("/") if p]
    if not parts:
        return None
    last = parts[-1]
    # Don't treat known-action segments as ids.
    if last in {"active", "bootstrap", "assign", "test", "reload-session",
                "status", "events", "audit", "employees", "accounts",
                "proxies", "sessions"}:
        return None
    return last


def _safe_loads(s: str | None) -> Any:
    if not s:
        return None
    try:
        return json.loads(s)
    except Exception:
        return s


def _normalize_color(c: str) -> str:
    """Accept '#ABC', '#AABBCC', or 'abc' / 'aabbcc'; return '#aabbcc'."""
    c = c.strip().lower().lstrip("#")
    if re.fullmatch(r"[0-9a-f]{3}", c):
        c = "".join(ch * 2 for ch in c)
    if not re.fullmatch(r"[0-9a-f]{6}", c):
        raise HTTPException(status_code=400, detail=f"invalid color {c!r}, expected #RRGGBB")
    return "#" + c


# ── Optional: response header that tells the UI who the relay thinks
# the current employee is. Useful for sanity-checking the picker.

def install_response_header(request: Request, response: Response) -> None:
    """Echo back the X-Employee-Id we saw, so the client knows the relay
    actually parsed it. Called from a FastAPI dependency in phase B."""
    eid = request.headers.get("x-employee-id")
    if eid:
        response.headers["X-Employee-Id-Seen"] = eid
