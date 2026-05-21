"""
Step 4: HTTP relay over the signed OF client.

A thin FastAPI wrapper around OFClient. Endpoints mirror OF's URL structure so
the frontend can speak OF's shape directly — we just sign + forward + return.

  GET  /health                           — does the captured session still work?
  GET  /api/of/v2/users/me
  GET  /api/of/v2/chats?limit=10&offset=0&order=recent
  GET  /api/of/v2/chats/{chat_id}/messages?limit=10&before_id=...

Run from the repo root with whichever venv has curl_cffi + fastapi + uvicorn:
  ./venv/bin/uvicorn service.server:app --reload --port 8787
"""
from __future__ import annotations

import hashlib
import logging
import os
import sys
import threading
from pathlib import Path
from typing import Any

import json

import asyncio
import contextlib
from contextvars import ContextVar
from datetime import datetime, timedelta
from fastapi import Body, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import accounts as account_registry  # noqa: E402
import proxies as proxy_registry  # noqa: E402
import live_rev  # noqa: E402
from of_client import OFClient, OFAPIError  # noqa: E402
from curl_cffi import requests as curl_requests  # noqa: E402  # proxy/network error types

# Phase A — SQL persistence + SSE broadcaster. Both are additive: the
# legacy WS subscribers in `_event_subscribers` keep working alongside.
from db import init_db as db_init  # noqa: E402
from db.repo import sync_from_disk as _sync_db_from_disk  # noqa: E402
from events import handle_event as _sse_handle_event, sse_stream  # noqa: E402
from employees import router as _employees_router, audit_middleware as _audit_middleware  # noqa: E402
from fans import router as _fans_router  # noqa: E402


def _kick_db_sync(reason: str) -> None:
    """Fire-and-forget re-import of JSON files into SQL. Called after every
    mutating admin endpoint so the SQL mirror catches up within a few hundred
    ms of any change to accounts.py / proxies.py / session_bootstrap state.

    Wrapped in try/except + logged because a sync failure must NEVER bubble
    out of an admin response — the user's actual mutation already succeeded
    against the JSON write path."""
    import asyncio as _aio
    try:
        loop = _aio.get_running_loop()
    except RuntimeError:
        # Sync FastAPI handlers run in the threadpool; trampoline to the
        # main loop captured at startup.
        if _main_loop is None:
            return
        _main_loop.call_soon_threadsafe(
            lambda: _aio.create_task(_sync_db_from_disk(), name=f"db-sync-{reason}")
        )
        return
    loop.create_task(_sync_db_from_disk(), name=f"db-sync-{reason}")


def _redact(s: str) -> str:
    """Mask user:password in a connection URL before logging.
    Turns 'postgresql://user:pass@host/db' into 'postgresql://***@host/db'.
    No-op for SQLite paths and any URL without credentials."""
    import re as _re
    return _re.sub(r"://[^/@]+@", "://***@", s)

log = logging.getLogger("of-relay")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# Run the one-shot legacy-layout migration before any client load — moves
# pre-multi-account sessions into accounts/<user_id>/. Idempotent.
account_registry.migrate_legacy()

# Promote any pre-existing proxy → session-file bindings to proxy → account_id
# bindings, so the new UI sees them and so re-captures don't silently lose
# the proxy. Idempotent — only fires for proxies that haven't been upgraded.
def _migrate_proxy_bindings_to_accounts() -> None:
    # Build a filename → account_id map by scanning each account dir.
    mapping: dict[str, str] = {}
    base = HERE / "sessions" / "accounts"
    if base.is_dir():
        for adir in base.iterdir():
            if not adir.is_dir():
                continue
            for sp in adir.glob("session_*.json"):
                mapping[sp.name] = adir.name
    if mapping:
        n = proxy_registry.migrate_legacy_assignments(mapping)
        if n:
            log.info("migrated %d legacy proxy assignment(s) → account_id", n)


_migrate_proxy_bindings_to_accounts()

app = FastAPI(title="OF Relay", version="0.1.0")

# Phase A: employees CRUD + audit log routes (read-only browse + admin).
# Middleware registered below so every mutating call gets logged.
app.include_router(_employees_router)
app.include_router(_fans_router)

# Audit middleware. Registered AFTER the share-token gate (below) on purpose
# — middlewares run in *reverse* registration order in starlette, so the
# share-token gate fires first, blocks unauthed requests, and only authed
# ones reach the audit writer. The decorator-registered middlewares below
# are added before this line, so we add this one via the imperative API to
# control ordering explicitly.
app.middleware("http")(_audit_middleware)

# ── Share-link gate ────────────────────────────────────────────
# Only requests carrying the token via ?t=... or the share_token cookie get
# through. Set SHARE_TOKEN to any random string before launching the relay,
# e.g. `export SHARE_TOKEN=$(openssl rand -hex 24)`. To disable the gate
# entirely (truly local dev, no exposure), launch with SHARE_TOKEN= (empty
# string). /health is always open so cloudflared / load balancers can probe it.
SHARE_TOKEN = os.environ.get("SHARE_TOKEN", "").strip()
_SHARE_COOKIE = "share_token"


# Stash the current Request so deep helpers (_get_client) can pick up the
# X-Account-Id header without us having to add `request: Request` to every
# one of the ~60 endpoint signatures. Set by the middleware below.
_request_ctx: ContextVar[Request | None] = ContextVar("of_relay_request", default=None)


@app.middleware("http")
async def _account_context(request: Request, call_next):
    """Make the current Request available to non-endpoint code paths
    (notably _get_client → _resolve_account_id) via a ContextVar. The token
    is reset in `finally` so the contextvar doesn't leak between requests."""
    token = _request_ctx.set(request)
    try:
        return await call_next(request)
    finally:
        _request_ctx.reset(token)


@app.middleware("http")
async def _share_token_gate(request: Request, call_next):
    if not SHARE_TOKEN:
        return await call_next(request)
    if request.url.path == "/health" or request.url.path == "/livez":
        return await call_next(request)
    if request.cookies.get(_SHARE_COOKIE) == SHARE_TOKEN:
        return await call_next(request)
    if request.query_params.get("t") == SHARE_TOKEN:
        resp = await call_next(request)
        # Persist the token so subsequent fetch() calls (which won't carry ?t=)
        # still authenticate. 7-day TTL is plenty for an ad-hoc share session.
        resp.set_cookie(
            _SHARE_COOKIE, SHARE_TOKEN,
            max_age=7 * 24 * 3600, httponly=True, samesite="lax",
        )
        return resp
    return Response("unauthorized — link missing or expired", status_code=401)


# ── /tmp/of-api.log — dedicated single-file access log ─────────────
# Every HTTP request that makes it past the share-token gate gets one
# line here. Pure text (no binary bytes from upstream stream bodies
# the way uvicorn's mixed log can have), append-only, so the user can
# `tail -f /tmp/of-api.log` and see live API traffic without needing
# grep -a flags. The access timing is measured around `call_next` so
# it includes all our middleware + the handler + StreamingResponse
# generator startup.
_API_LOG_PATH = "/tmp/of-api.log"
import time as _time_mod


@app.middleware("http")
async def _api_access_log(request: Request, call_next):
    started = _time_mod.monotonic()
    response = None
    status = 0
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    except HTTPException as exc:
        status = exc.status_code
        raise
    except Exception:
        status = 500
        raise
    finally:
        ms = int((_time_mod.monotonic() - started) * 1000)
        # Strip the share token from the logged URL — even though the file
        # is local-only, no need to mirror it on every line.
        url = str(request.url)
        if "?t=" in url:
            url = url.split("?t=", 1)[0] + (
                "?" + url.split("?", 1)[1].split("&", 1)[1]
                if "&" in url.split("?", 1)[1] else ""
            )
        elif "&t=" in url:
            head, tail = url.split("&t=", 1)
            rest = tail.split("&", 1)[1] if "&" in tail else ""
            url = head + (("&" + rest) if rest else "")
        ts = datetime.utcnow().isoformat(timespec="milliseconds") + "Z"
        line = f"{ts} {request.method:6s} {status} {ms:5d}ms {url}\n"
        try:
            # Append synchronously — open+write+close is a single syscall
            # per line at this volume. Avoids the lock contention an
            # async aiofiles handle would buy us.
            with open(_API_LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write(line)
        except Exception:
            pass


@app.middleware("http")
async def _persist_unhandled_errors(request: Request, call_next):
    """Catch unhandled server-side exceptions, persist a row in app_errors
    (so /admin/errors surfaces them), then re-raise so FastAPI's default
    500 response still fires. HTTPException is intentionally NOT caught —
    those are deliberate, structured replies, not bugs."""
    try:
        return await call_next(request)
    except HTTPException:
        raise
    except Exception as exc:
        import traceback as _tb
        try:
            from db.engine import get_session
            from db.models import AppError as _AE
            stack = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))[:16384]
            account_id = request.headers.get("x-account-id")
            emp_hdr = request.headers.get("x-employee-id")
            try:
                employee_id = int(emp_hdr) if emp_hdr else None
            except ValueError:
                employee_id = None
            async with get_session() as s:
                s.add(_AE(
                    source="server",
                    kind=type(exc).__name__[:64],
                    message=str(exc)[:4096],
                    stack=stack,
                    url=str(request.url)[:1024],
                    account_id=account_id[:64] if account_id else None,
                    employee_id=employee_id,
                    user_agent=(request.headers.get("user-agent") or "")[:512] or None,
                ))
                await s.commit()
        except Exception:
            # Don't let the logger crash the response path on top of the
            # original error — just log and move on.
            log.exception("failed to persist server-side error to app_errors")
        raise


# Lazy client pool — one OFClient per account_id. First request for an
# account loads its session; subsequent requests reuse the pooled client.
# Hot-reload via /admin/reload-session?account_id=... or by re-bootstrapping.
_clients: dict[str, OFClient] = {}

# ── Realtime event bus ─────────────────────────────────────────
# We connect ONCE to OF's WebSocket (wss://ws2.onlyfans.com/ws3/N) at startup
# and fan every event out to (a) browser clients on /ws/events, (b) configured
# webhook URLs, (c) any local subscribers (CLI tailer, future plugins).
# Subscribers are asyncio.Queue instances; if a queue is full, we drop the
# oldest message rather than block the producer.

_event_subscribers: set[asyncio.Queue] = set()
_event_stats: dict[str, Any] = {
    "received": 0,
    "by_type": {},
    "by_account": {},
    "started_at": None,
    "last_event_ts": None,
    "subscribers": 0,
}

# Webhooks: per-event-type URL list. Loaded from sessions/webhooks.json so
# config survives restarts. Each call POSTs the event JSON to every URL
# subscribed to that event type (or "*" wildcard).
_WEBHOOKS_FILE = HERE / "sessions" / "webhooks.json"


def _load_webhooks() -> dict[str, list[str]]:
    if not _WEBHOOKS_FILE.exists():
        return {}
    try:
        return json.loads(_WEBHOOKS_FILE.read_text())
    except Exception:
        return {}


def _save_webhooks(cfg: dict) -> None:
    _WEBHOOKS_FILE.parent.mkdir(exist_ok=True)
    _WEBHOOKS_FILE.write_text(json.dumps(cfg, indent=2))


async def _broadcast_event(event: dict) -> None:
    """Push an event to every subscriber queue + fire webhooks."""
    _event_stats["received"] += 1
    _event_stats["last_event_ts"] = __import__("time").time()
    if isinstance(event, dict):
        for k in event:
            if k.startswith("__"):  # don't tally our own meta-keys
                continue
            _event_stats["by_type"][k] = _event_stats["by_type"].get(k, 0) + 1
        aid = event.get("__account_id")
        if aid:
            _event_stats["by_account"][aid] = _event_stats["by_account"].get(aid, 0) + 1
    _event_stats["subscribers"] = len(_event_subscribers)

    dead: list[asyncio.Queue] = []
    for q in _event_subscribers:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            # Drop oldest, push new — better than blocking the OF pump
            with contextlib.suppress(asyncio.QueueEmpty):
                q.get_nowait()
            try:
                q.put_nowait(event)
            except Exception:
                dead.append(q)
    for q in dead:
        _event_subscribers.discard(q)

    # Phase A: also fan into the SSE module + persist to event_inbox. Wrapped
    # in try/except because we never want a SQL hiccup to break the legacy
    # WS broadcast — those subscribers were already served above.
    try:
        await _sse_handle_event(event)
    except Exception:
        log.exception("SSE handle_event failed")

    # Webhooks — fire-and-forget HTTP POST, don't await
    cfg = _load_webhooks()
    if cfg:
        urls: set[str] = set()
        for kind in list(event.keys()) if isinstance(event, dict) else []:
            urls.update(cfg.get(kind, []))
        urls.update(cfg.get("*", []))
        for url in urls:
            asyncio.create_task(_post_webhook(url, event))


async def _post_webhook(url: str, event: dict) -> None:
    """Fire-and-forget POST. Errors logged but don't propagate."""
    try:
        # Use stdlib (no extra deps) via thread executor — keeps signed-client
        # curl_cffi clean. Short 5s timeout per request.
        import urllib.request, urllib.error
        body = json.dumps(event).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/json", "User-Agent": "of-relay/1.0"},
        )
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None, lambda: urllib.request.urlopen(req, timeout=5).read()
        )
    except Exception as e:
        log.warning("webhook POST %s failed: %s", url, e)


# One WebSocket pump per account. Events are tagged with `__account_id` +
# `__account_name` before broadcast so subscribers (UI + webhooks) can route
# or filter by account. The pumps dict is mutated only by the helpers below.
_account_pumps: dict[str, asyncio.Task] = {}
_supervisor_task: asyncio.Task | None = None
# The asyncio loop the app is running on. Captured at startup so sync FastAPI
# endpoints (which run in the threadpool, with NO running loop in the worker
# thread) can schedule pump start/stop via `call_soon_threadsafe`.
_main_loop: asyncio.AbstractEventLoop | None = None


async def _ws_pump_for_account(account_id: str) -> None:
    """Run the OF WS pump for one account until cancelled. OFWebSocket has
    its own reconnect-with-backoff loop, so this task is only torn down when
    the account is removed or the server is shutting down."""
    from of_ws import OFWebSocket
    while True:
        try:
            client = _load_client(account_id)
            meta = account_registry.get_account(account_id) or {}
            nickname = meta.get("nickname") or account_id
            color = meta.get("color")
            ws = OFWebSocket(client)
            log.info("ws-pump[%s]: connecting to OF", nickname)
            async for event in ws.events():
                # Tag every event so multi-account subscribers can route.
                # Use sentinel `__` keys so we never collide with real OF event names.
                if isinstance(event, dict):
                    event = {
                        "__account_id": account_id,
                        "__account_name": nickname,
                        "__account_color": color,
                        **event,
                    }
                await _broadcast_event(event)
        except HTTPException as e:
            log.warning("ws-pump[%s]: %s — retry in 30s", account_id, e.detail)
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("ws-pump[%s] unexpected: %s — retry in 10s", account_id, e)
            await asyncio.sleep(10)


def _start_account_pump(account_id: str) -> None:
    """Spawn a pump for an account if one isn't already running.

    Safe to call from BOTH the event loop and from a worker thread (FastAPI
    sync endpoints run in the threadpool, where `asyncio.create_task` raises
    `RuntimeError: no running event loop`). From a thread we trampoline back
    to the main loop via `call_soon_threadsafe`.
    """
    try:
        asyncio.get_running_loop()
        _do_start_account_pump(account_id)
    except RuntimeError:
        if _main_loop is None:
            # Startup hasn't run yet; the supervisor / startup hook will
            # eventually spawn this pump. Drop silently rather than crash.
            return
        _main_loop.call_soon_threadsafe(_do_start_account_pump, account_id)


def _do_start_account_pump(account_id: str) -> None:
    """Inner: must be called from inside the event loop."""
    task = _account_pumps.get(account_id)
    if task and not task.done():
        return
    _account_pumps[account_id] = asyncio.create_task(
        _ws_pump_for_account(account_id), name=f"ws-pump-{account_id}",
    )


def _stop_account_pump(account_id: str) -> None:
    """Cancel an account's pump. `.cancel()` is documented to be safe from
    any thread, but the dict pop and the task reference both want the loop;
    we trampoline for symmetry with _start_account_pump."""
    try:
        asyncio.get_running_loop()
        _do_stop_account_pump(account_id)
    except RuntimeError:
        if _main_loop is None:
            return
        _main_loop.call_soon_threadsafe(_do_stop_account_pump, account_id)


def _do_stop_account_pump(account_id: str) -> None:
    task = _account_pumps.pop(account_id, None)
    if task and not task.done():
        task.cancel()


def _restart_account_pump(account_id: str) -> None:
    _stop_account_pump(account_id)
    _start_account_pump(account_id)


async def _pump_supervisor() -> None:
    """Reconcile the set of running pumps against the set of accounts every
    15s. Picks up newly-bootstrapped accounts without needing an explicit
    'start pump' call from the bootstrap endpoint, and reaps pumps for
    deleted accounts. Also restarts any pump that crashed unexpectedly."""
    while True:
        try:
            current_ids = {a["id"] for a in account_registry.list_accounts()
                           if a.get("has_session")}
            # Start missing
            for aid in current_ids:
                _start_account_pump(aid)
            # Stop pumps whose account vanished
            for aid in list(_account_pumps.keys()):
                if aid not in current_ids:
                    _stop_account_pump(aid)
                    continue
                task = _account_pumps[aid]
                if task.done() and not task.cancelled():
                    log.warning("ws-pump[%s] task exited — restarting", aid)
                    _restart_account_pump(aid)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("supervisor pass failed")
        await asyncio.sleep(15)


@app.on_event("startup")
async def _start_event_pumps() -> None:
    global _supervisor_task, _main_loop
    _main_loop = asyncio.get_running_loop()
    _event_stats["started_at"] = __import__("time").time()

    # Bump the anyio thread pool. `/img` is a sync streaming endpoint —
    # each in-flight video / avatar fetch holds one thread for as long as
    # the browser keeps the stream open. With hover-preview, scrub seeks,
    # the chat-list avatars, vault thumbnails and notification polls all
    # sharing the default ~40-thread pool, the relay would exhaust threads
    # and start dropping requests (ECONNRESET storms on the Next side).
    # 200 gives plenty of headroom; each thread is cheap and idle when no
    # stream is active.
    try:
        import anyio
        anyio.to_thread.current_default_thread_limiter().total_tokens = 200
        log.info("anyio thread pool bumped to 200")
    except Exception:
        log.exception("could not bump anyio thread pool — sticking with default")

    # Phase A — bring up SQLite. Idempotent: creates tables on first boot,
    # no-ops on subsequent. Must precede pump spawn because the SSE writer
    # below tries to insert event_inbox rows from the first event onward.
    try:
        await db_init()
        log.info("db ready (DATABASE_URL=%s)", _redact(os.environ.get("DATABASE_URL", "(default)")))
    except Exception:
        log.exception("db_init failed — relay will run but SSE/inbox writes will error")

    # Spawn pumps for every existing account with a session
    for meta in account_registry.list_accounts():
        if meta.get("has_session"):
            _start_account_pump(meta["id"])
    _supervisor_task = asyncio.create_task(_pump_supervisor(), name="pump-supervisor")
    log.info("event pumps started for %d account(s)", len(_account_pumps))

    # Probe the live OF build hash so the drift detector has a value ready
    # by the time the UI loads /admin/rev/drift. Network — run off-thread so
    # a slow CF response doesn't block FastAPI startup.
    asyncio.get_running_loop().run_in_executor(None, live_rev.refresh)

    # Periodic GC of `_storyboard_locks` — the prune cron clears the on-disk
    # storyboard dirs but the in-memory lock entries would otherwise leak
    # ~200 bytes per unique video ever hovered. Eviction is conservative:
    # only drops locks whose dir is gone AND whose `acquire(blocking=False)`
    # succeeds, so it never races with an active build.
    asyncio.create_task(_storyboard_evictor_loop(), name="storyboard-evictor")

    # Periodic TTL sweep of the on-disk /img cache. Keys are host+path
    # so entries are shared across all accounts/users — the sweep just
    # drops anything older than _IMG_CACHE_TTL_S by mtime.
    asyncio.create_task(_img_cache_evictor_loop(), name="img-cache-evictor")


@app.on_event("shutdown")
async def _stop_event_pumps() -> None:
    # CancelledError is not an "Exception" in 3.8+ (it's BaseException) so we
    # have to suppress it explicitly — otherwise FastAPI logs a noisy traceback
    # at every clean shutdown.
    if _supervisor_task and not _supervisor_task.done():
        _supervisor_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await _supervisor_task
    for task in list(_account_pumps.values()):
        if not task.done():
            task.cancel()
    for task in list(_account_pumps.values()):
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
    _account_pumps.clear()


def _load_client(account_id: str) -> OFClient:
    """Return the OFClient for `account_id`, loading it the first time.
    Raises a structured 503 if the account has no usable session yet."""
    cached = _clients.get(account_id)
    if cached is not None:
        return cached
    log.info("Loading account %s into OFClient", account_id)
    try:
        client = OFClient.from_account(account_id)
    except FileNotFoundError as e:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "no_session",
                "account_id": account_id,
                "message": str(e),
                "remedy": ["POST /admin/session/bootstrap", "or ./venv/bin/python service/capture_session.py"],
            },
        ) from None
    except ValueError as e:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "incomplete_signing_rules",
                "account_id": account_id,
                "message": str(e),
                "remedy": ["./venv/bin/python service/extract_rules.py"],
            },
        ) from None
    _clients[account_id] = client
    log.info("OFClient ready (account=%s user_id=%s rev=%s)",
             account_id, client.user_id, client.x_of_rev)
    return client


def _resolve_account_id(request: Request | None) -> str:
    """Pick the account_id for this request, in priority order:
       1. `X-Account-Id` request header (UI sends this)
       2. `?account_id=...` query param (curl-friendly)
       3. the currently active account (fallback for un-aware callers)
    Raises 404 if the explicit id doesn't exist, 503 if no active account."""
    explicit: str | None = None
    if request is not None:
        explicit = request.headers.get("x-account-id") or request.query_params.get("account_id")
    if explicit:
        if account_registry.get_account(explicit) is None:
            raise HTTPException(status_code=404, detail=f"Unknown account_id {explicit!r}")
        return explicit
    aid = account_registry.get_active_account_id()
    if not aid:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "no_active_account",
                "message": "No account has a captured session yet.",
                "remedy": ["POST /admin/session/bootstrap"],
            },
        )
    return aid


def _get_client(request: Request | None = None) -> OFClient:
    """Resolve the account for `request` (or — if not passed — the request
    captured by the middleware contextvar, falling back to the active
    account) and return its OFClient."""
    if request is None:
        request = _request_ctx.get()
    return _load_client(_resolve_account_id(request))


def _invalidate_client(account_id: str) -> None:
    """Drop a pooled OFClient so the next request reloads from disk.
    Used after re-bootstrap or proxy reassignment."""
    _clients.pop(account_id, None)


def _proxy(call):
    """Translate OFAPIError + curl_cffi proxy/network errors into a structured
    502 so the frontend can react, and log a one-liner instead of a 200-line
    traceback for transient proxy failures (cf-tunnel 403s, timeouts, DNS)."""
    try:
        return call()
    except OFAPIError as e:
        r = e.response
        status = r.status_code if r is not None else 500
        body = r.text[:2000] if r is not None else str(e)
        log.warning("upstream error: %s %s", status, body[:200])
        # 502 = bad gateway: we tried, OF didn't like it.
        raise HTTPException(
            status_code=502,
            detail={"upstream_status": status, "upstream_body": body},
        )
    except curl_requests.exceptions.ProxyError as e:
        # of_client._http_call already logged the structured details
        # (account, proxy label, endpoint). Surface a clean 502 to the UI.
        log.warning("proxy_unreachable: %s", str(e)[:200])
        raise HTTPException(
            status_code=502,
            detail={"upstream_status": "proxy_unreachable", "upstream_body": str(e)[:500]},
        )
    except curl_requests.exceptions.Timeout as e:
        log.warning("upstream_timeout: %s", str(e)[:200])
        raise HTTPException(
            status_code=504,
            detail={"upstream_status": "timeout", "upstream_body": str(e)[:500]},
        )
    except curl_requests.exceptions.RequestException as e:
        log.warning("upstream_network_error: %s %s", type(e).__name__, str(e)[:200])
        raise HTTPException(
            status_code=502,
            detail={"upstream_status": "network", "upstream_body": str(e)[:500]},
        )


# ── Endpoints ──────────────────────────────────────────────────

@app.get("/livez")
def livez():
    """Process liveness probe. Returns 200 as long as FastAPI is running.

    Distinct from /health which reports session/account readiness and can
    return 503 when no OF account is loaded yet. The Docker HEALTHCHECK
    directive aims this endpoint so a relay with zero captured sessions
    (i.e. a brand-new install before paste-cURL bootstrap) is still
    marked healthy — otherwise app.depends_on.relay:service_healthy
    deadlocks fresh deploys, since the UI that creates the first session
    lives behind that very dependency. Always cheap, no side effects, no
    auth required (same exemption as /health from the share-token gate)."""
    return {"ok": True}


@app.get("/health")
def health(request: Request, all_accounts: bool = Query(False, description="Probe every account, not just the requested one")):
    """Never raises 500. Always returns a JSON body the frontend can act on.

    By default reports the health of the account resolved from
    `X-Account-Id` / `?account_id=` / active. Pass `?all_accounts=1` to get
    the full per-account snapshot, which the UI uses to flag any expired
    sessions in the switcher dropdown."""
    if all_accounts:
        rows: list[dict[str, Any]] = []
        for meta in account_registry.list_accounts():
            aid = meta["id"]
            row: dict[str, Any] = {
                "account_id": aid, "nickname": meta.get("nickname"),
                "color": meta.get("color"),
                "has_session": meta.get("has_session", False),
            }
            if not meta.get("has_session"):
                row["ok"] = False
                row["error"] = "no_session"
                rows.append(row)
                continue
            try:
                c = _load_client(aid)
                me = c.me()
                row.update({"ok": True, "user_id": me.get("id"), "name": me.get("name"),
                            "proxy": {"label": c.proxy_label, "url": c.proxy_url}})
            except OFAPIError as e:
                r = e.response
                row.update({"ok": False, "error": "upstream",
                            "upstream_status": r.status_code if r else None,
                            "upstream_body": (r.text[:300] if r else str(e))})
            except HTTPException as e:
                row.update({"ok": False,
                            "error": (e.detail.get("error") if isinstance(e.detail, dict) else "error"),
                            "detail": e.detail})
            except Exception as e:
                row.update({"ok": False, "error": f"{type(e).__name__}: {e}"})
            rows.append(row)
        return {"ok": all(r.get("ok") for r in rows) if rows else False,
                "accounts": rows}

    try:
        client = _get_client(request)
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"ok": False, **(e.detail if isinstance(e.detail, dict) else {"detail": e.detail})})
    try:
        me = client.me()
    except OFAPIError as e:
        r = e.response
        return JSONResponse(status_code=502, content={
            "ok": False,
            "error": "upstream",
            "upstream_status": r.status_code if r else None,
            "upstream_body": (r.text[:500] if r else str(e)),
            "proxy": {"label": client.proxy_label, "url": client.proxy_url},
        })
    return {
        "ok": True,
        "account_id": client.account_id,
        "user_id": me.get("id"),
        "name": me.get("name"),
        "proxy": {
            "label": client.proxy_label,
            "url": client.proxy_url,
            "egress_ip": client.egress_ip(),
        },
    }


@app.get("/api/of/v2/users/me")
def users_me() -> dict[str, Any]:
    return _proxy(lambda: _get_client().me())


# ── Image proxy ────────────────────────────────────────────────
# OF's CDN signs URLs with `AWS:SourceIp=<egress IP>/32` — the IP of the
# proxy that fetched the API response. The user's browser doesn't share
# that IP, so the image fetch fails on any account whose session uses a
# different egress than the user's home IP. We tunnel the fetch back
# through the account's HTTP client so the source IP matches.
#
# Restricted to known OF CDN hosts to keep this from becoming an SSRF
# foot-gun. Caches at the browser via Cache-Control passthrough.

_ALLOWED_CDN_SUFFIXES = (
    ".onlyfans.com",
    ".ofcdn.com",
    ".mycdn.dev",  # OF's media subdomains
)

# In-flight /img stream counters. Each active proxy_image generator
# increments _img_active on first chunk and decrements in its finally
# block. Read via /admin/streams so the user can see whether hover-
# preview is actually blowing the budget or it's something else (e.g.,
# a stalled upstream holding a thread). Pure counters, no lock — Python
# int += is atomic enough for monotonic stats.
_img_active: int = 0
_img_high_water: int = 0
_img_total_started: int = 0
_img_total_aborted: int = 0

# Video-stream concurrency cap. /img Range requests (= browser video
# streaming) get a dedicated semaphore so a user hovering through
# many video tiles can't drain uvicorn's threadpool and lock up the
# whole relay. Sized for "watching 1 vid + 1 preload sibling + a
# little headroom for the brief overlap when switching tiles". JPEG
# thumbnail loads bypass this cap entirely (no Range header).
# Past the cap, late arrivals wait up to _VIDEO_STREAM_WAIT_S for a
# slot, then 503 — the browser <video> element retries Range requests
# naturally so a transient 503 just costs a few hundred ms.
_VIDEO_STREAM_CAP = 6
_VIDEO_STREAM_WAIT_S = 2.0
_video_stream_sem = threading.BoundedSemaphore(_VIDEO_STREAM_CAP)
_video_stream_503s: int = 0

# Stable handle for /img assets. OF CDN URLs include a signed Policy +
# Signature + Key-Pair-Id that rotate per upstream fetch — the SAME
# physical image looks like a different URL each time we re-list a chat.
# Browser HTTP cache keys by full URL, so signature rotation gives a
# 0% hit rate across re-fetches of the same chat.
#
# Fix: hash the stable identity of the asset (host + path, scoped by
# account), keep an in-memory hash → most-recent-signed-URL map, and
# expose /img/by-hash/<h> that the frontend can use as a stable cache
# key once it's seen the hash via /admin/img-cache/stats or via the
# response header X-Img-Hash from /img?u=...
#
# TTL on entries matches OF's signed-URL lifetime (~1h). After expiry,
# /img/by-hash/<h> returns 410 and the frontend falls back to /img?u=
# with a fresh URL from the next /messages payload.
_IMG_HASH_TTL_S = 60 * 60
_IMG_HASH_CAP = 50_000
_img_hash_lock = threading.Lock()
_img_hash_map: dict[str, tuple[str, float]] = {}   # hash -> (signed_url, ts_seen)


def _img_stable_hash(account_id: str, u: str) -> str:
    """SHA-1 (truncated to 20 hex chars) over the stable identity of an
    OF CDN asset. Drops the query string (Policy/Signature/Key-Pair-Id),
    lowercases the host, scopes by account so two accounts can't collide
    on a shared asset that might be re-signed differently."""
    from urllib.parse import urlparse as _urlparse
    parsed = _urlparse(u)
    base = (parsed.hostname or "").lower() + (parsed.path or "")
    return hashlib.sha1(f"{account_id}\0{base}".encode("utf-8")).hexdigest()[:20]


def _img_hash_remember(account_id: str, u: str) -> str:
    """Record (or refresh) the hash → signed-URL mapping. Returns the hash.
    Naive size-cap: when over _IMG_HASH_CAP, drop oldest 10% by ts."""
    h = _img_stable_hash(account_id, u)
    now = _time_mod.monotonic()
    with _img_hash_lock:
        _img_hash_map[h] = (u, now)
        if len(_img_hash_map) > _IMG_HASH_CAP:
            # Sort once, drop the bottom 10% in one pass — cheaper than
            # per-eviction in steady state. Triggered rarely (only at cap).
            ordered = sorted(_img_hash_map.items(), key=lambda kv: kv[1][1])
            for k, _ in ordered[: len(ordered) // 10]:
                _img_hash_map.pop(k, None)
    return h


# ── On-disk image cache ───────────────────────────────────────────────
#
# Persistent cache for /img bytes, keyed by hostname+path (signature
# stripped) so it's shared across all accounts/users. Motivation:
#
#   - OF CDN URLs carry a Policy/Signature query string that rotates
#     every ~hours. The browser HTTP cache keys on the full URL, so
#     the moment OF hands us a freshly-signed URL for the same physical
#     asset (chat refetch, vault re-list, signature expiry) the browser
#     cache misses even within the same session.
#   - This cache keys on host+path → those re-signed URLs become disk
#     hits. Same physical image, served from disk, no upstream call.
#   - User A and user B viewing the same chat/profile both hit the same
#     bytes — cross-session sharing without a CDN round-trip each.
#
# Only stores SMALL FULL responses. Range requests (browser <video>) and
# 206 partials are never cached — partials would poison the cache, and
# videos are huge. _IMG_CACHE_MAX_BYTES caps per-file size as a safety
# net even when Content-Length isn't trustworthy.
_IMG_CACHE_DIR = Path(os.environ.get("IMG_CACHE_DIR", "/tmp/of-relay-img-cache"))
_IMG_CACHE_MAX_BYTES = int(os.environ.get("IMG_CACHE_MAX_BYTES", str(2 * 1024 * 1024)))
_IMG_CACHE_TTL_S = int(os.environ.get("IMG_CACHE_TTL_S", str(7 * 24 * 60 * 60)))
_IMG_CACHE_EVICT_INTERVAL_S = 30 * 60
_img_cache_hits: int = 0
_img_cache_misses: int = 0
_img_cache_writes: int = 0
_img_cache_skipped_partial: int = 0
_img_cache_skipped_too_big: int = 0
_img_cache_write_errors: int = 0


def _img_cache_key(u: str) -> str:
    """Account-agnostic SHA-1 over host+path. Same physical asset → same
    key, regardless of which account fetched it or how OF signed the URL."""
    from urllib.parse import urlparse as _urlparse
    parsed = _urlparse(u)
    base = (parsed.hostname or "").lower() + (parsed.path or "")
    return hashlib.sha1(base.encode("utf-8")).hexdigest()


def _img_cache_paths(h: str) -> tuple[Path, Path]:
    """Returns (bytes_path, content_type_path). Sharded into 2-char dirs
    so any one dir doesn't grow unbounded (matters for ext4/some FS)."""
    sub = _IMG_CACHE_DIR / h[:2]
    return sub / f"{h}.bin", sub / f"{h}.ct"


def _img_cache_lookup(u: str) -> tuple[Path, str] | None:
    """Returns (bytes_path, content_type) if a complete cache entry exists,
    else None. A complete entry has BOTH .bin and .ct present — half-written
    state is invisible (writers use unique .tmp paths and atomic rename)."""
    h = _img_cache_key(u)
    bin_p, ct_p = _img_cache_paths(h)
    if not bin_p.is_file() or not ct_p.is_file():
        return None
    try:
        ct = ct_p.read_text(encoding="utf-8", errors="replace").strip() or "application/octet-stream"
    except OSError:
        return None
    return bin_p, ct


def _img_cache_write(u: str, content_type: str, data: bytes) -> bool:
    """Atomically write `data` for `u` to the cache. Unique .tmp filename
    + rename means concurrent writers for the same hash don't corrupt
    each other (last writer wins, identical bytes either way). Returns
    True on success."""
    global _img_cache_writes, _img_cache_write_errors
    h = _img_cache_key(u)
    bin_p, ct_p = _img_cache_paths(h)
    try:
        bin_p.parent.mkdir(parents=True, exist_ok=True)
        suffix = f".tmp.{os.getpid()}.{threading.get_ident()}"
        tmp_bin = bin_p.with_suffix(bin_p.suffix + suffix)
        tmp_ct = ct_p.with_suffix(ct_p.suffix + suffix)
        tmp_bin.write_bytes(data)
        tmp_ct.write_text(content_type, encoding="utf-8")
        os.replace(tmp_bin, bin_p)
        os.replace(tmp_ct, ct_p)
        _img_cache_writes += 1
        return True
    except OSError:
        _img_cache_write_errors += 1
        # Best-effort cleanup of leftover .tmp files; ignore errors.
        for p in (tmp_bin, tmp_ct):  # type: ignore[possibly-unbound]
            try: p.unlink()
            except (OSError, NameError): pass
        return False


def _img_cache_evict_once() -> int:
    """Walk the cache dir and delete entries older than _IMG_CACHE_TTL_S
    (by mtime). Returns the number of (bin, ct) pairs removed. Cheap on
    a few-tens-of-thousands of files; if the cache grows past that we'd
    want a smarter index, but this is fine for current expected size."""
    if not _IMG_CACHE_DIR.exists():
        return 0
    import time as _t
    cutoff = _t.time() - _IMG_CACHE_TTL_S
    removed = 0
    try:
        for sub in _IMG_CACHE_DIR.iterdir():
            if not sub.is_dir():
                continue
            for f in sub.iterdir():
                try:
                    if f.stat().st_mtime < cutoff:
                        f.unlink()
                        if f.suffix == ".bin":
                            removed += 1
                except OSError:
                    continue
    except OSError:
        return removed
    return removed


async def _img_cache_evictor_loop() -> None:
    """Periodic TTL sweep. Same shape as _storyboard_evictor_loop."""
    while True:
        try:
            await asyncio.sleep(_IMG_CACHE_EVICT_INTERVAL_S)
            removed = await asyncio.to_thread(_img_cache_evict_once)
            if removed:
                log.info("img cache evicted: %d entries (TTL=%ds)", removed, _IMG_CACHE_TTL_S)
        except asyncio.CancelledError:
            return
        except Exception:
            log.warning("img cache evictor cycle failed", exc_info=True)


@app.get("/admin/streams")
def admin_streams() -> dict:
    """Live view of the /img stream budget. `active` = currently streaming
    right now; `high_water` = peak since startup. If active sits near the
    thread-pool limit while you scroll, that's the bottleneck. If it stays
    low but you still see ECONNRESETs, look elsewhere (Next dev proxy,
    upstream OF, network)."""
    return {
        "active": _img_active,
        "high_water": _img_high_water,
        "total_started": _img_total_started,
        "total_aborted": _img_total_aborted,
        "video_stream_cap": _VIDEO_STREAM_CAP,
        "video_stream_503s": _video_stream_503s,
    }


# ── /admin/errors ───────────────────────────────────────────────────
# Persisted error log. The frontend POSTs unhandled errors here via
# useErrorReporter; the server's exception middleware writes 500s
# here too. GET returns recent rows for the badge + admin viewer.

class _AppErrorBody(BaseModel):
    source: str = "browser"             # "browser" | "server" (clients should send "browser")
    kind: str = "error"                 # short category — "unhandledrejection", "react-render", …
    message: str
    stack: str | None = None
    url: str | None = None
    account_id: str | None = None
    employee_id: int | None = None
    user_agent: str | None = None
    # Free-form bag of extra fields the client wants persisted. Stored
    # as a JSON blob; we don't enforce a schema.
    context: dict[str, Any] | None = None


@app.post("/admin/errors")
async def admin_errors_create(body: _AppErrorBody = Body(...)) -> dict[str, Any]:
    """Persist a single error report. Never raises — if we can't write
    we still 200 so the reporter loop doesn't error-on-error."""
    from db.engine import get_session
    from db.models import AppError
    try:
        async with get_session() as s:
            row = AppError(
                source=(body.source or "browser")[:32],
                kind=(body.kind or "error")[:64],
                message=(body.message or "")[:4096],
                stack=body.stack[:16384] if body.stack else None,
                url=body.url[:1024] if body.url else None,
                account_id=body.account_id[:64] if body.account_id else None,
                employee_id=body.employee_id,
                user_agent=body.user_agent[:512] if body.user_agent else None,
                context_json=json.dumps(body.context)[:16384] if body.context else None,
            )
            s.add(row)
            await s.commit()
            return {"ok": True, "id": row.id}
    except Exception:
        log.exception("failed to persist app_error")
        return {"ok": False}


@app.get("/admin/errors")
async def admin_errors_list(
    limit: int = Query(50, ge=1, le=500),
    since_hours: int = Query(24, ge=1, le=720),
    source: str | None = Query(None, description="Filter by 'browser' or 'server'"),
) -> dict[str, Any]:
    """Recent errors, newest first. `since_hours` defaults to 24h so the
    TopNav badge can count today's errors cheaply."""
    from db.engine import get_session
    from db.models import AppError
    from sqlalchemy import select, and_
    cutoff = datetime.utcnow() - timedelta(hours=since_hours)
    async with get_session() as s:
        stmt = select(AppError).where(AppError.occurred_at >= cutoff)
        if source:
            stmt = stmt.where(AppError.source == source)
        stmt = stmt.order_by(AppError.occurred_at.desc()).limit(limit)
        rows = (await s.execute(stmt)).scalars().all()
        return {
            "count": len(rows),
            "since_hours": since_hours,
            "list": [
                {
                    "id": r.id,
                    "occurred_at": r.occurred_at.isoformat() + "Z",
                    "source": r.source,
                    "kind": r.kind,
                    "message": r.message,
                    "stack": r.stack,
                    "url": r.url,
                    "account_id": r.account_id,
                    "employee_id": r.employee_id,
                    "user_agent": r.user_agent,
                    "context": json.loads(r.context_json) if r.context_json else None,
                }
                for r in rows
            ],
        }


# ── /admin/chats/recent — instant-load seed for the inbox ──────────
# Returns the most recent rows from the LOCAL `chats` table (populated
# by the WS transcoder) joined to `fans` for display names + avatars.
# Sub-50ms because everything is indexed in SQLite — no OF call.
# Used by the frontend to render an instant 10-25 row chat list while
# the live OF `/chats` fetch is still in flight, so users can click a
# conversation immediately instead of waiting for the cold OF round-trip.

@app.get("/admin/chats/recent")
async def admin_chats_recent(
    limit: int = Query(25, ge=1, le=100),
    account_id: str | None = Query(None, description="Filter to one account; omit for all"),
) -> dict[str, Any]:
    from db.engine import get_session
    from db.models import Chat as _Chat, Fan as _Fan
    from sqlalchemy import select
    async with get_session() as s:
        stmt = (
            select(_Chat, _Fan)
            .join(_Fan, (_Fan.account_id == _Chat.account_id) & (_Fan.fan_id == _Chat.fan_id), isouter=True)
            .where(_Chat.hidden_locally == False)  # noqa: E712
            .order_by(_Chat.last_message_at.desc().nullslast())
            .limit(limit)
        )
        if account_id:
            stmt = stmt.where(_Chat.account_id == account_id)
        rows = (await s.execute(stmt)).all()
        out: list[dict[str, Any]] = []
        for chat, fan in rows:
            out.append({
                "__accountId": chat.account_id,
                "withUser": {
                    "id": chat.fan_id,
                    "name": fan.of_display_name if fan else None,
                    "username": fan.of_username if fan else None,
                    "avatar": fan.avatar_url if fan else None,
                },
                "lastMessage": {
                    "id": chat.last_message_id,
                    "text": chat.last_message_preview or "",
                    "createdAt": chat.last_message_at.isoformat() + "Z" if chat.last_message_at else None,
                } if chat.last_message_id else None,
                "hasUnread": (chat.unread_count or 0) > 0,
                "unreadMessagesCount": chat.unread_count or 0,
            })
        return {"list": out, "source": "local-db"}


@app.get("/img")
def proxy_image(request: Request, u: str = Query(..., description="Absolute OF CDN URL")):
    """Fetch `u` via the requesting account's OF client (so the source IP
    matches the URL's signed Policy) and stream the bytes back."""
    from urllib.parse import urlparse
    parsed = urlparse(u)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="bad scheme")
    host = (parsed.hostname or "").lower()
    if not any(host.endswith(s) for s in _ALLOWED_CDN_SUFFIXES):
        raise HTTPException(status_code=400, detail="host not allowed")

    range_hdr = request.headers.get("range") or request.headers.get("Range")

    # Disk-cache fast path: only safe when the client wants the WHOLE
    # asset (no Range). Cached bytes are account-agnostic — once we have
    # them, the upstream signature is irrelevant for serving them again.
    # Skipped on Range because we don't store partials.
    if not range_hdr:
        global _img_cache_hits, _img_cache_misses
        hit = _img_cache_lookup(u)
        if hit is not None:
            _img_cache_hits += 1
            bin_p, ct_cached = hit
            cache_control = "public, max-age=172800, stale-while-revalidate=86400, immutable"
            return FileResponse(
                str(bin_p),
                media_type=ct_cached,
                headers={"Cache-Control": cache_control, "X-Img-Cache": "HIT"},
            )
        _img_cache_misses += 1

    client = _get_client(request)

    # Forward the browser's Range header so video <video> tags can seek.
    # Without this, the upstream always returns 200 with the whole file and
    # the browser can't jump past whatever's buffered — long videos can't
    # be scrubbed, and `currentTime` writes stall.
    upstream_headers: dict[str, str] = {}
    sem_held = False
    if range_hdr:
        upstream_headers["Range"] = range_hdr
        # Video streaming lane — bounded by _VIDEO_STREAM_CAP. JPEG
        # thumbnails (no Range header) bypass entirely so the grid stays
        # snappy even when the cap is saturated.
        if not _video_stream_sem.acquire(timeout=_VIDEO_STREAM_WAIT_S):
            global _video_stream_503s
            _video_stream_503s += 1
            raise HTTPException(
                status_code=503,
                detail="too many video streams in flight; retry shortly",
            )
        sem_held = True

    try:
        r = client.http.get(
            u, timeout=client.timeout_s, stream=True, headers=upstream_headers or None,
        )
    except Exception as e:
        if sem_held:
            try: _video_stream_sem.release()
            except ValueError: pass
        raise HTTPException(status_code=502, detail=f"upstream fetch failed: {e}")
    # 206 (Partial Content) is the normal Range response — treat it as ok.
    if r.status_code not in (200, 206):
        if sem_held:
            try: _video_stream_sem.release()
            except ValueError: pass
        raise HTTPException(status_code=r.status_code, detail="upstream non-2xx")

    ct = r.headers.get("Content-Type", "application/octet-stream")
    # OF's CDN sends short Cache-Control because the signed Policy expires,
    # but the IMAGE BYTES themselves don't expire. We override upstream's
    # header to keep the browser HTTP cache (and a future Service Worker)
    # holding the asset for 2 days — once we've fetched the bytes, the
    # upstream signature is irrelevant for serving them again.
    # SWR window of 1 day lets the SW serve a stale copy instantly while
    # silently refreshing in the background.
    cache_control = "public, max-age=172800, stale-while-revalidate=86400, immutable"
    out_headers = {"Cache-Control": cache_control}
    # Stable hash exposed back to the browser so the frontend can pivot
    # to /img/by-hash/<h> on subsequent renders — same image, same key,
    # even after OF rotates the upstream signature.
    account_id_hdr = request.headers.get("x-account-id") or ""
    if account_id_hdr:
        try:
            h_stable = _img_hash_remember(account_id_hdr, u)
            out_headers["X-Img-Hash"] = h_stable
        except Exception:
            # Hashing should never fail (urlparse + sha1), but if it does
            # we just skip the header — the proxy still works.
            pass
    # Pass through the bits the <video> element relies on to seek. Without
    # Accept-Ranges Chrome won't even attempt a Range request; without
    # Content-Range it can't tell what slice it got back.
    for h in ("Content-Range", "Accept-Ranges", "Content-Length", "ETag", "Last-Modified"):
        v = r.headers.get(h)
        if v:
            out_headers[h] = v
    if "Accept-Ranges" not in out_headers:
        # If upstream didn't advertise but we got 206/200, hint that we
        # support ranges so the browser will try one next time.
        out_headers["Accept-Ranges"] = "bytes"

    # Wrap iter_content so a browser-side abort (the common case — user
    # hovers a new tile, the old <video> unmounts, the TCP socket dies)
    # cleanly closes the upstream connection instead of bubbling up as
    # an unhandled ChunkedEncodingError / ConnectionResetError that the
    # worker would otherwise log as a 500 and tear down the thread.
    # Also enforces a hard max-stream-age so a `/img` stream can't pin a
    # worker thread for the full lifetime of an mp4 — uvicorn's graceful
    # shutdown was taking 2+ minutes because in-flight streams blocked on
    # iter_content() and never noticed the shutdown signal. After
    # _MAX_STREAM_SEC we bail; the browser will reissue a Range request
    # for the rest, which is what `<video>` elements do natively anyway.
    _MAX_STREAM_SEC = 60
    import time as _time
    started_mono = _time.monotonic()

    # Tee bytes to the disk cache only when the upstream response is a
    # complete 200 (not 206), the request had no Range, and Content-Length
    # is either unknown or under the cap. We additionally enforce the cap
    # while streaming — past it, we drop the buffer rather than allocate
    # unbounded memory for a video that slipped past the host filter.
    out_headers["X-Img-Cache"] = "MISS" if not range_hdr else "BYPASS"
    cache_buffer: bytearray | None = None
    if not range_hdr and r.status_code == 200:
        try:
            advertised = int(r.headers.get("Content-Length") or 0)
        except ValueError:
            advertised = 0
        if 0 < advertised <= _IMG_CACHE_MAX_BYTES or advertised == 0:
            cache_buffer = bytearray()
        else:
            global _img_cache_skipped_too_big
            _img_cache_skipped_too_big += 1
    elif r.status_code == 206:
        global _img_cache_skipped_partial
        _img_cache_skipped_partial += 1

    def _safe_iter():
        global _img_active, _img_high_water, _img_total_started, _img_total_aborted
        global _img_cache_skipped_too_big
        _img_active += 1
        _img_total_started += 1
        if _img_active > _img_high_water:
            _img_high_water = _img_active
        aborted = False
        completed = False
        local_buf = cache_buffer
        try:
            for chunk in r.iter_content(chunk_size=64 * 1024):
                if _time.monotonic() - started_mono > _MAX_STREAM_SEC:
                    # Hit our cap — close upstream so the worker thread
                    # is reusable. The browser will Range-request the
                    # tail if it still wants more bytes.
                    break
                if chunk:
                    if local_buf is not None:
                        if len(local_buf) + len(chunk) > _IMG_CACHE_MAX_BYTES:
                            # Asset grew past the cap mid-stream — drop
                            # the buffer (don't cache), keep streaming.
                            _img_cache_skipped_too_big += 1
                            local_buf = None
                        else:
                            local_buf.extend(chunk)
                    yield chunk
            else:
                completed = True
        except (ConnectionResetError, BrokenPipeError, GeneratorExit):
            # Client went away — silent, this is normal browser behavior
            # for unmounting video elements.
            aborted = True
        except Exception:
            aborted = True
            log.warning("upstream stream error mid-flight (u=%s)", u[:120], exc_info=True)
        finally:
            if aborted:
                _img_total_aborted += 1
            _img_active = max(0, _img_active - 1)
            if sem_held:
                try: _video_stream_sem.release()
                except ValueError: pass
            try:
                r.close()
            except Exception:
                pass
            # Only persist when the full upstream body landed cleanly.
            # Aborted/truncated bodies must never enter the cache.
            if completed and not aborted and local_buf is not None and len(local_buf) > 0:
                try:
                    _img_cache_write(u, ct, bytes(local_buf))
                except Exception:
                    log.warning("img cache write failed (u=%s)", u[:120], exc_info=True)

    return StreamingResponse(
        _safe_iter(),
        media_type=ct,
        status_code=r.status_code,
        headers=out_headers,
    )


@app.get("/img/by-hash/{h}")
def proxy_image_by_hash(request: Request, h: str):
    """Stable-URL alias for /img. Resolves the hash to the most recent
    signed URL we've seen for it, then delegates to proxy_image. Returns
    410 if the signed URL has aged past _IMG_HASH_TTL_S — at that point
    the upstream signature is likely expired and the frontend should
    fetch a fresh URL from /messages (or whatever surface produced this
    asset originally) and call /img?u=... directly.

    The browser's Cache-Control window (2 days) is much longer than the
    upstream signature window (~1h), so most hits never reach the server
    at all — only first-sight requests touch us here."""
    with _img_hash_lock:
        entry = _img_hash_map.get(h)
    if not entry:
        raise HTTPException(
            status_code=404,
            detail="unknown img hash; refetch the producing endpoint for a fresh signed URL",
        )
    u, ts = entry
    if _time_mod.monotonic() - ts > _IMG_HASH_TTL_S:
        # Drop the stale entry while we're here.
        with _img_hash_lock:
            _img_hash_map.pop(h, None)
        raise HTTPException(
            status_code=410,
            detail="signed URL expired; refetch the producing endpoint for a fresh one",
        )
    return proxy_image(request, u=u)


@app.get("/admin/img-cache/disk")
def admin_img_cache_disk() -> dict:
    """Disk cache stats. `hit_rate` is the headline number — if it stays
    near zero, the cache isn't paying for itself; if it climbs past ~0.4
    we're saving meaningful upstream calls. `bytes` is a `du`-equivalent
    of the cache root so we can see growth over time."""
    total_bytes = 0
    entry_count = 0
    try:
        if _IMG_CACHE_DIR.exists():
            for sub in _IMG_CACHE_DIR.iterdir():
                if not sub.is_dir():
                    continue
                for f in sub.iterdir():
                    try:
                        st = f.stat()
                        total_bytes += st.st_size
                        if f.suffix == ".bin":
                            entry_count += 1
                    except OSError:
                        continue
    except OSError:
        pass
    total = _img_cache_hits + _img_cache_misses
    hit_rate = (_img_cache_hits / total) if total else 0.0
    return {
        "dir": str(_IMG_CACHE_DIR),
        "entries": entry_count,
        "bytes": total_bytes,
        "hits": _img_cache_hits,
        "misses": _img_cache_misses,
        "writes": _img_cache_writes,
        "hit_rate": round(hit_rate, 3),
        "skipped_partial": _img_cache_skipped_partial,
        "skipped_too_big": _img_cache_skipped_too_big,
        "write_errors": _img_cache_write_errors,
        "max_bytes_per_entry": _IMG_CACHE_MAX_BYTES,
        "ttl_seconds": _IMG_CACHE_TTL_S,
    }


@app.get("/admin/img-cache/stats")
def admin_img_cache_stats() -> dict:
    """Live view of the hash → signed-URL map. `entries` counts distinct
    images we've ever proxied since boot; `freshest_age_s` shows how
    recently we saw activity. Used to gauge whether /img/by-hash is
    actually doing work (entries climbing == hits expected to follow)."""
    now = _time_mod.monotonic()
    with _img_hash_lock:
        n = len(_img_hash_map)
        if n:
            ages = [now - ts for _, ts in _img_hash_map.values()]
            oldest_age = int(max(ages))
            freshest_age = int(min(ages))
        else:
            oldest_age = 0
            freshest_age = 0
    return {
        "entries": n,
        "cap": _IMG_HASH_CAP,
        "ttl_seconds": _IMG_HASH_TTL_S,
        "oldest_age_s": oldest_age,
        "freshest_age_s": freshest_age,
    }


# ── Video scrub storyboard ────────────────────────────────────────────
#
# /img/scrub?u=<signed-video-url>&i=<0..11>
#
# Replaces the streaming hover-preview pipeline (two <video> elements
# pulling Range bytes through /img) with 12 pre-extracted JPGs at evenly
# spaced timestamps (every 8.33%). First request for a video triggers
# a one-time ffmpeg extraction: download the mp4, extract 12 frames,
# write to disk, drop the mp4. Subsequent requests serve directly from
# disk and are immutable cacheable.
#
# Motivation: streaming videos through /img pinned uvicorn threadpool
# slots for up to 60s each. Five users hovering through video tiles
# could deadlock the relay. Storyboard frames are ~20KB JPGs served
# from disk — never blocks the upstream pool past the one-time build.

# Configurable cache root. /tmp is fine on macOS (cleared at boot, so
# eviction handles itself). In Docker /tmp is per-container and goes
# away on restart — point STORYBOARD_DIR at a mounted volume in prod
# so storyboards survive across container restarts.
_STORYBOARD_DIR = Path(os.environ.get("STORYBOARD_DIR", "/tmp/of-relay-storyboard"))
_STORYBOARD_FRAMES = 12
_STORYBOARD_WIDTH = 400
# Drop from 90s → 30s. Past 30s Next dev's HTTP proxy and most browsers
# have already given up; holding the uvicorn worker thread any longer
# just leaks the slot for nothing. The client retries naturally on the
# next hover cycle so failing fast is cheaper than queueing zombies.
_STORYBOARD_BUILD_TIMEOUT_S = 30
_storyboard_locks: dict[str, threading.Lock] = {}
_storyboard_locks_lock = threading.Lock()
_storyboard_total_built: int = 0
_storyboard_total_served: int = 0
_storyboard_build_failures: int = 0
# Per-hover-session cancel signal. Set by POST /img/scrub/cancel when the
# user moves off a video before its download finishes. The download loop
# polls this every chunk and bails IF it hasn't already crossed the
# "almost done" threshold below — past that point we let the bytes
# finish landing so the next hover gets a warm cache.
#
# Keyed by `session_id` (client-generated UUID per hover) rather than by
# video hash on purpose: a previous fix used hash-keyed events, which let
# a late cancel POST from a prior hover abort a brand-new build for the
# same video (re-hover within ~100-300ms). With session-keyed events,
# the new hover gets a new id → fresh event → the stale cancel POST
# finds no entry and is a no-op.
_storyboard_cancel_events: dict[str, threading.Event] = {}
_storyboard_cancel_events_lock = threading.Lock()
# If the cancel arrives after this fraction of the bytes has landed,
# we finish the download anyway — the remaining bandwidth is cheap and
# the cached storyboard will be there next time the user hovers this
# video. Lower = more cache built (more wasted bytes on truly-abandoned
# videos); higher = less wasted bandwidth (more re-download next time).
# 0.80 was the user's call after measuring the tradeoff.
_STORYBOARD_CANCEL_KEEP_THRESHOLD = 0.80
_storyboard_total_cancelled: int = 0
_storyboard_total_cancel_ignored: int = 0


def _storyboard_register_session(session_id: str) -> threading.Event:
    """Reserve a cancel event for an active build's session. Called once
    at the start of a download; the event is dropped at end of build."""
    with _storyboard_cancel_events_lock:
        ev = threading.Event()
        _storyboard_cancel_events[session_id] = ev
        return ev


def _storyboard_release_session(session_id: str) -> None:
    """Drop the session's cancel event after the build finishes (success
    or failure). Late cancel POSTs that arrive after this find no entry
    and become a no-op, which is the desired behaviour."""
    with _storyboard_cancel_events_lock:
        _storyboard_cancel_events.pop(session_id, None)


def _storyboard_signal_cancel(session_id: str) -> bool:
    """Set the cancel event for `session_id` if a build is active. Returns
    True when a live session was found, False otherwise (stale cancel)."""
    with _storyboard_cancel_events_lock:
        ev = _storyboard_cancel_events.get(session_id)
    if ev is None:
        return False
    ev.set()
    return True


def _storyboard_lock_for(h: str) -> threading.Lock:
    with _storyboard_locks_lock:
        lk = _storyboard_locks.get(h)
        if lk is None:
            lk = threading.Lock()
            _storyboard_locks[h] = lk
        return lk


def _storyboard_evict_locks_once() -> int:
    """Drop `_storyboard_locks` entries for hashes whose on-disk
    storyboard dir is gone — the prune-storyboards cron deletes those
    dirs on TTL, but the in-memory lock dict would otherwise grow
    without bound (≈200 bytes per unique video ever hovered).

    Safety: we only evict a lock when (a) the dir is missing AND (b)
    `lock.acquire(blocking=False)` succeeds, meaning no thread is
    currently building. We then re-check the dir under the lock and
    only pop from the dict if the same lock instance is still mapped.
    Returns the number of entries evicted (for the periodic logger)."""
    existing: set[str] = set()
    try:
        if _STORYBOARD_DIR.exists():
            existing = {p.name for p in _STORYBOARD_DIR.iterdir() if p.is_dir()}
    except OSError:
        return 0
    with _storyboard_locks_lock:
        candidates = [h for h in _storyboard_locks.keys() if h not in existing]
    evicted = 0
    for h in candidates:
        with _storyboard_locks_lock:
            lk = _storyboard_locks.get(h)
        if lk is None:
            continue
        if not lk.acquire(blocking=False):
            continue  # active build → leave it alone
        try:
            if (_STORYBOARD_DIR / h).is_dir():
                continue  # someone resurrected it between our snapshot and now
            with _storyboard_locks_lock:
                if _storyboard_locks.get(h) is lk:
                    _storyboard_locks.pop(h, None)
                    evicted += 1
        finally:
            lk.release()
    return evicted


async def _storyboard_evictor_loop() -> None:
    """Background task spawned at startup. Runs the lock evictor every
    30 minutes — matches the cadence of the prune-storyboards cron so
    the in-memory dict catches up shortly after the disk cleanup."""
    while True:
        try:
            await asyncio.sleep(30 * 60)
            evicted = await asyncio.to_thread(_storyboard_evict_locks_once)
            if evicted:
                log.info("storyboard locks evicted: %d", evicted)
        except asyncio.CancelledError:
            return
        except Exception:
            log.warning("storyboard evictor cycle failed", exc_info=True)


def _video_path_hash(u: str) -> str:
    """SHA-1 of host+path (signature stripped, account-agnostic). Same
    physical video → same hash → same on-disk frames, regardless of
    which account fetched it or how OF signed the URL today."""
    from urllib.parse import urlparse as _urlparse
    parsed = _urlparse(u)
    base = (parsed.hostname or "").lower() + (parsed.path or "")
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:20]


_ALL_FRAME_INDICES = tuple(range(_STORYBOARD_FRAMES))


def _storyboard_frame_path(h: str, i: int) -> Path:
    return _STORYBOARD_DIR / h / f"{i}.jpg"


def _storyboard_all_frames_present(h: str) -> bool:
    return all(_storyboard_frame_path(h, i).is_file() for i in _ALL_FRAME_INDICES)


def _storyboard_download(
    request: Request, u: str, src_path: Path, session_id: str | None,
) -> bool:
    """Pull the mp4 into src_path via the right account's HTTP client (so
    the URL's source-IP signature matches). Returns False on failure or
    when the client cancelled before 90% of the bytes had landed.

    The cancel hook lets us bail mid-download when the user moves on to
    another video. Past `_STORYBOARD_CANCEL_KEEP_THRESHOLD` we ignore
    the cancel and finish the bytes anyway — the next hover gets a
    warm cache and the bandwidth we already burned isn't wasted.

    `session_id` scopes the cancel to one hover session. If empty/None
    (old client, no sid supplied), the build runs without cancellation
    support — a missed cancel is strictly better than the alternative,
    which was aborting unrelated builds."""
    global _storyboard_build_failures, _storyboard_total_cancelled, _storyboard_total_cancel_ignored
    # Fresh, session-scoped event. Drop it on exit (finally) so a late
    # cancel POST arriving after the build wraps up is a no-op — not a
    # poison flag for the next session that happens to reuse this id.
    cancel_event = _storyboard_register_session(session_id) if session_id else None
    try:
        client = _get_client(request)
        r = client.http.get(u, timeout=client.timeout_s, stream=True)
        if r.status_code not in (200, 206):
            log.warning("storyboard download non-2xx %d for %s", r.status_code, u[:120])
            _storyboard_build_failures += 1
            return False
        total_bytes = 0
        try:
            total_bytes = int(r.headers.get("content-length") or 0)
        except (TypeError, ValueError):
            total_bytes = 0
        bytes_done = 0
        with src_path.open("wb") as f:
            for chunk in r.iter_content(chunk_size=256 * 1024):
                if cancel_event is not None and cancel_event.is_set():
                    # Past the keep threshold? Honour the bytes we already
                    # paid for and finish the file — bumping the ignored
                    # counter so we can see the cap is working.
                    fraction = (bytes_done / total_bytes) if total_bytes > 0 else 0.0
                    if total_bytes > 0 and fraction >= _STORYBOARD_CANCEL_KEEP_THRESHOLD:
                        _storyboard_total_cancel_ignored += 1
                        cancel_event.clear()  # treat the rest of the dl as committed
                    else:
                        # Truly abort — drop the partial mp4, signal failure.
                        _storyboard_total_cancelled += 1
                        try: r.close()
                        except Exception: pass
                        return False
                if chunk:
                    f.write(chunk)
                    bytes_done += len(chunk)
        try: r.close()
        except Exception: pass
        return True
    except Exception:
        log.warning("storyboard download failed for %s", u[:120], exc_info=True)
        _storyboard_build_failures += 1
        try: src_path.unlink(missing_ok=True)
        except Exception: pass
        return False
    finally:
        if session_id:
            _storyboard_release_session(session_id)


def _storyboard_probe_duration(src_path: Path) -> float:
    """ffprobe → duration in seconds, 0 on failure."""
    import subprocess
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error",
             "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1",
             str(src_path)],
            capture_output=True, text=True, timeout=10, check=True,
        )
        return float(probe.stdout.strip())
    except Exception:
        return 0.0


def _storyboard_extract_batch(
    src_path: Path, dest: Path, indices: tuple[int, ...], dur: float,
) -> bool:
    """Extract all `indices` frames in a SINGLE ffmpeg invocation, using
    repeated `-ss TIME -i SRC -frames:v 1 OUT` blocks. ffmpeg reopens the
    file per `-i` (keyframe seek is fast on local disk) but the process
    spawn happens only once per batch — cuts pass-1 latency by ~4x for a
    4-frame batch vs. one subprocess per frame. Frames write directly to
    their final 0-based name.

    Tolerates partial success: short clips with rounded-up duration
    metadata will fail the last seek at/past EOF; we keep whatever did
    land and backfill the rest from the nearest neighbour so the
    storyboard is always complete-shaped. Returns False only if zero
    frames came out — that's the case where the source mp4 is unreadable
    or the timeout fired."""
    import subprocess
    # Stay at least 100ms before the encoded EOF — ffmpeg can't seek past
    # the last decodable frame, and short clips whose container metadata
    # rounds the duration up (e.g. "4.0s" for a 3.93s file) would otherwise
    # blow up on the last index.
    safe_dur = max(0.1, dur - 0.1)
    args: list[str] = ["ffmpeg", "-y", "-nostdin", "-loglevel", "error"]
    for pos, i in enumerate(indices):
        # Mid-segment seek (i + 0.5) lands away from cut boundaries where
        # an I-frame might be black or a hard transition.
        ts = (i + 0.5) * dur / _STORYBOARD_FRAMES
        ts = min(ts, safe_dur)
        out_path = dest / f"{i}.jpg"
        args += [
            "-ss", f"{ts:.4f}", "-i", str(src_path),
            "-map", f"{pos}:v:0",
            "-frames:v", "1",
            "-vf", f"scale={_STORYBOARD_WIDTH}:-2",
            "-q:v", "5",
            str(out_path),
        ]
    rc = -1
    try:
        proc = subprocess.run(
            args, check=False, capture_output=True,
            timeout=_STORYBOARD_BUILD_TIMEOUT_S,
        )
        rc = proc.returncode
    except Exception:
        log.warning(
            "storyboard batch extract crashed for %s indices=%s",
            dest.name, indices, exc_info=True,
        )

    landed = [i for i in indices if (dest / f"{i}.jpg").is_file()]
    if not landed:
        log.warning(
            "storyboard batch extract produced no frames for %s "
            "(rc=%s indices=%s dur=%.3f)",
            dest.name, rc, indices, dur,
        )
        return False
    if len(landed) < len(indices):
        # Backfill missing indices by copying the nearest neighbour so the
        # storyboard is always complete-shaped after a build. Without this
        # any missing frame would trigger a fresh download+extract on the
        # next request and fail the same way — an infinite loop.
        import shutil
        for i in indices:
            if (dest / f"{i}.jpg").is_file():
                continue
            nearest = min(landed, key=lambda j: abs(j - i))
            try:
                shutil.copyfile(dest / f"{nearest}.jpg", dest / f"{i}.jpg")
            except Exception:
                log.warning(
                    "storyboard backfill copy %s→%s failed for %s",
                    nearest, i, dest.name, exc_info=True,
                )
        log.info(
            "storyboard partial extract for %s: %d/%d frames (rc=%s dur=%.3f, backfilled rest)",
            dest.name, len(landed), len(indices), rc, dur,
        )
    return True


def _ensure_storyboard_frame(
    request: Request, u: str, h: str, i: int,
    *, hint_duration: float | None = None,
    session_id: str | None = None,
) -> bool:
    """Make sure frame `i` is on disk. Returns True if it is now.

    Single-pass build: any caller that finds the storyboard missing
    downloads the source mp4 and extracts all 12 frames in one batched
    ffmpeg invocation. We tried a two-phase (4-then-8) split but the
    measured breakdown showed ffmpeg is ~230ms total vs ~3-7s for the
    download — splitting saved nothing meaningful and added background-
    thread coordination.

    `hint_duration` (seconds) lets the caller skip ffprobe entirely —
    VaultMedia carries duration in the vault listing so the client
    passes it through. The worst case if it's wrong is mis-spaced
    scrub frames; we sanity-check it's positive."""
    global _storyboard_total_built, _storyboard_build_failures
    dest = _STORYBOARD_DIR / h
    frame_path = _storyboard_frame_path(h, i)

    if frame_path.is_file():
        return True

    lock = _storyboard_lock_for(h)
    if not lock.acquire(timeout=_STORYBOARD_BUILD_TIMEOUT_S):
        return False
    try:
        # Another concurrent caller may have produced our frame while we
        # waited on the lock.
        if frame_path.is_file():
            return True

        dest.mkdir(parents=True, exist_ok=True)
        src_path = dest / "source.tmp"

        # Download mp4 (skipped if a prior failed build left it around).
        if not src_path.is_file():
            if not _storyboard_download(request, u, src_path, session_id):
                # On cancel/error, drop the partial bytes — incomplete
                # mp4s aren't useful for extraction.
                try: src_path.unlink(missing_ok=True)
                except Exception: pass
                return False

        if hint_duration and hint_duration > 0:
            dur = hint_duration
        else:
            dur = _storyboard_probe_duration(src_path)
        if dur <= 0:
            _storyboard_build_failures += 1
            try: src_path.unlink(missing_ok=True)
            except Exception: pass
            return False

        if not _storyboard_extract_batch(src_path, dest, _ALL_FRAME_INDICES, dur):
            _storyboard_build_failures += 1
            # Drop the source mp4 on extract failure. The previous code
            # kept it around so a follow-up call could skip the download
            # and re-attempt extraction, but if the file is the cause of
            # the failure (corrupt download, codec ffmpeg can't decode)
            # leaving it on disk pins us into an infinite-retry loop on
            # this video — every subsequent hover hits the same broken
            # mp4 and fails the same way. Re-downloading is cheap
            # relative to a permanently-broken cache entry.
            try: src_path.unlink(missing_ok=True)
            except Exception: pass
            return False

        try: src_path.unlink(missing_ok=True)
        except Exception: pass
        _storyboard_total_built += 1
        return frame_path.is_file()
    finally:
        lock.release()


@app.get("/img/scrub")
def proxy_image_scrub(
    request: Request,
    u: str = Query(..., description="Signed OF video URL (.mp4)"),
    i: int = Query(..., ge=0, lt=_STORYBOARD_FRAMES, description="Frame index 0..11"),
    dur: float | None = Query(None, gt=0, description="Video duration in seconds (from VaultMedia.duration). When supplied, the relay skips its own ffprobe."),
    sid: str | None = Query(None, description="Per-hover session id. The matching /img/scrub/cancel POST carries the same value; the server scopes cancellation to this session so a stale cancel from a previous hover can't abort a fresh build."),
):
    """Returns the i-th frame of the 12-frame storyboard for video `u`.
    First call builds; subsequent calls serve from disk."""
    from urllib.parse import urlparse as _urlparse
    parsed = _urlparse(u)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="bad scheme")
    host = (parsed.hostname or "").lower()
    if not any(host.endswith(s) for s in _ALLOWED_CDN_SUFFIXES):
        raise HTTPException(status_code=400, detail="host not allowed")

    h = _video_path_hash(u)
    ok = _ensure_storyboard_frame(request, u, h, i, hint_duration=dur, session_id=sid)
    if not ok:
        raise HTTPException(status_code=502, detail="storyboard build failed")
    frame_path = _storyboard_frame_path(h, i)
    if not frame_path.is_file():
        raise HTTPException(status_code=404, detail=f"frame {i} not extracted")

    # Bump the dir's mtime so the prune script's find -mtime treats this
    # as "last used now". Cheap (one syscall) — does NOT touch each frame
    # file, just the parent dir, which is all the prune script looks at.
    try:
        os.utime(_STORYBOARD_DIR / h, None)
    except OSError:
        pass

    global _storyboard_total_served
    _storyboard_total_served += 1
    return FileResponse(
        frame_path,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "public, max-age=172800, immutable",
            "X-Img-Hash": h,
        },
    )


@app.post("/img/scrub/cancel")
def cancel_storyboard_build(
    u: str = Query(..., description="Signed OF video URL whose in-flight storyboard build should be cancelled"),
    sid: str | None = Query(None, description="Per-hover session id from the matching /img/scrub request. Cancellation is scoped to this session — a missing or unknown sid is a no-op (intentional: stale cancels from a previous hover must not abort fresh builds for the same video)."),
):
    """Signal the in-flight download for hover session `sid` to abort,
    unless it's already past `_STORYBOARD_CANCEL_KEEP_THRESHOLD` (in
    which case we let it finish so the bytes aren't wasted). Idempotent —
    calling with a sid that has no in-flight build is a no-op.

    `u` is still validated for hygiene but isn't used to route the cancel
    anymore — that would re-introduce the hash-keyed race where a late
    POST from a stale hover aborted a fresh hover of the same video.

    Browser fires this on hover end (useEffect cleanup in VaultPicker).
    Fire-and-forget; the browser doesn't wait for or read the response."""
    from urllib.parse import urlparse as _urlparse
    parsed = _urlparse(u)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="bad scheme")
    host = (parsed.hostname or "").lower()
    if not any(host.endswith(s) for s in _ALLOWED_CDN_SUFFIXES):
        raise HTTPException(status_code=400, detail="host not allowed")
    if not sid:
        return {"ok": True, "ignored": "no-sid"}
    found = _storyboard_signal_cancel(sid)
    return {"ok": True, "found": found}


@app.get("/admin/storyboard/stats")
def admin_storyboard_stats() -> dict:
    """How the scrub-frame storyboard cache is doing."""
    try:
        n_videos = sum(1 for p in _STORYBOARD_DIR.iterdir() if p.is_dir()) if _STORYBOARD_DIR.exists() else 0
    except Exception:
        n_videos = 0
    return {
        "cached_videos": n_videos,
        "frames_per_video": _STORYBOARD_FRAMES,
        "total_built": _storyboard_total_built,
        "total_served": _storyboard_total_served,
        "build_failures": _storyboard_build_failures,
        "total_cancelled": _storyboard_total_cancelled,
        "total_cancel_ignored": _storyboard_total_cancel_ignored,
        "cancel_keep_threshold": _STORYBOARD_CANCEL_KEEP_THRESHOLD,
    }


@app.get("/api/of/v2/chats")
def list_chats(
    limit: int = Query(10, ge=1, le=50),
    offset: int = Query(0, ge=0),
    order: str = Query("recent"),
    filter: str | None = Query(None, description="OF chat filter: 'unread'|'pinned'|'priority'"),
    list_id: str | None = Query(None, description="Show only chats whose fan is in this custom list (folder)"),
    query: str | None = Query(None, description="Free-text search by fan name/username (OF param: ?query=)"),
    # Legacy alias from the first cut of the chat-search UI — the real OF param
    # is `query=`. We accept both so any deep-linked URLs from earlier builds
    # don't silently 400.
    search: str | None = Query(None, description="Alias for `query` (back-compat)"),
) -> dict[str, Any]:
    return _proxy(lambda: _get_client().list_chats(
        limit=limit, offset=offset, order=order, filter=filter,
        list_id=list_id, query=query or search,
    ))


@app.get("/api/of/v2/chats/folders")
def chat_folders(
    limit: int = Query(10, ge=1, le=50),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """Fan-lists the user has pinned (or can pin) to the chat sidebar.
    Mirrors OF's `/lists?filter=can_pin_chat&isChat=true&format=infinite`."""
    return _proxy(lambda: _get_client().chat_folders(limit=limit, offset=offset))


class _PinChatBody(BaseModel):
    pinned: bool


@app.patch("/api/of/v2/lists/{list_id}/pin-chat")
def pin_list_to_chat(list_id: int, body: _PinChatBody = Body(...)) -> dict[str, Any]:
    """Pin or unpin a fan list as a chat-sidebar folder.
    Maps to PATCH /lists/{id} with `{"isPinnedToChat": <bool>}`."""
    return _proxy(lambda: _get_client().set_list_pinned_to_chat(list_id, body.pinned))


@app.get("/api/of/v2/chats/{chat_id}/messages")
def get_messages(
    chat_id: int,
    limit: int = Query(10, ge=1, le=100),
    order: str = Query("desc"),
    before_id: int | None = Query(None, description="Paginate older: pass last message id"),
) -> dict[str, Any]:
    return _proxy(lambda: _get_client().get_messages(
        chat_id, limit=limit, order=order, before_id=before_id,
    ))


@app.get("/api/of/v2/chats/{chat_id}/messages/all")
def get_all_messages(
    chat_id: int,
    page_size: int = Query(10, ge=1, le=10),  # OF caps the page at ~10; don't go higher
    delay_ms: int = Query(300, ge=0, le=5000),
    max_pages: int | None = Query(None, ge=1, le=1000),
    from_id: int | None = Query(None, description="Resume cursor: only fetch messages older than this id"),
) -> dict[str, Any]:
    """Blocking: paginates the full chat history server-side, returns one JSON.
    Fine for small/medium chats; large chats can take minutes — prefer /stream."""
    msgs = _proxy(lambda: _get_client().get_all_messages(
        chat_id, page_size=page_size, delay_s=delay_ms / 1000, max_pages=max_pages,
        from_id=from_id,
    ))
    return {"count": len(msgs), "list": msgs}


@app.get("/api/of/v2/chats/{chat_id}/messages/stream")
def stream_all_messages(
    chat_id: int,
    page_size: int = Query(10, ge=1, le=10),  # OF caps the page at ~10; don't go higher
    delay_ms: int = Query(300, ge=0, le=5000),
    max_pages: int | None = Query(None, ge=1, le=1000),
    from_id: int | None = Query(None, description="Resume cursor: only stream messages older than this id"),
):
    """NDJSON stream: one JSON object per page, flushed as it's fetched.
    Each line: {"page": N, "count": k, "hasMore": bool, "messages": [...]}.
    Lets the frontend render as messages arrive instead of waiting for the
    whole chat. Errors come through as a final {"error": "..."} line."""
    client = _get_client()

    def gen():
        try:
            for page in client.iter_messages(
                chat_id, page_size=page_size,
                delay_s=delay_ms / 1000, max_pages=max_pages,
                from_id=from_id,
            ):
                yield json.dumps({
                    "page": page["page"],
                    "count": len(page["messages"]),
                    "hasMore": page["hasMore"],
                    "messages": page["messages"],
                }) + "\n"
        except OFAPIError as e:
            r = e.response
            yield json.dumps({
                "error": "upstream",
                "upstream_status": r.status_code if r else None,
                "upstream_body": (r.text[:1000] if r else str(e)),
            }) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


# ── Users ──────────────────────────────────────────────────────
# Order matters: the static /users/list route must be declared BEFORE the
# dynamic /users/{...} route, otherwise FastAPI would match "list" as a
# username and never reach the batch endpoint.

@app.get("/api/of/v2/users/list")
async def list_users(
    ids: list[int] = Query(..., description="One or more user ids: ?ids=1&ids=2"),
    view: str = Query("m", pattern="^[mx]$",
                      description="'m' = chat-list view (default), 'x' = extended"),
) -> dict[str, Any]:
    """Batch-fetch up to ~50 user profiles in one request. Returns OF's native
    shape: a dict keyed by user-id string, e.g. {"117183": {...}}.

    Quirk: when OF can't resolve ANY of the requested ids (deleted accounts,
    typos, etc.) it returns `[]` instead of `{}`. Normalize to dict so the
    response validator stays happy and callers don't have to type-guard.

    Augments each entry with `customNickname` from our local Fan table when
    one is set. Read-only join — never creates Fan stub rows. Lets the chat
    list / group panes / popouts all surface team-set nicknames without a
    separate fetch.

    The OF httpx call is blocking; we run it via `asyncio.to_thread` so the
    event loop stays responsive while the upstream request is in flight.
    Direct `_proxy(...)` from this `async def` would freeze SSE, webhooks,
    and concurrent requests for the duration of the upstream call."""
    resp = await asyncio.to_thread(_proxy, lambda: _get_client().list_users(ids, view=view))
    if isinstance(resp, list):
        resp = {}

    try:
        account_id = _resolve_account_id(_request_ctx.get())
    except HTTPException:
        return resp

    try:
        from db.engine import get_session
        from db.models import Fan
        from sqlalchemy import select as _select
        async with get_session() as s:
            rows = (await s.execute(
                _select(Fan.fan_id, Fan.custom_nickname)
                .where(Fan.account_id == account_id, Fan.fan_id.in_(ids))
            )).all()
            for fid, nick in rows:
                if not nick:
                    continue
                key = str(fid)
                entry = resp.get(key)
                if isinstance(entry, dict):
                    entry["customNickname"] = nick
    except Exception:
        log.exception("custom_nickname stitch failed for /users/list")

    return resp


# NOTE: /users/{user_id_or_username} is declared at the very end of the user-family
# routes (see "Catch-all single user lookup" further down) so static routes like
# /users/list, /users/search, /users/{id}/posts can match first.


# ── Send a message ─────────────────────────────────────────────

class SendMessageBody(BaseModel):
    text: str = Field(..., description="Message body. Plain text or HTML.")
    locked_text: bool = Field(False, description="Lock the text behind the PPV price.")
    price: float = Field(0, ge=0, description="PPV price; 0 = free message.")
    # Either: ints (existing vault ids) or dicts (fresh-upload claim objects
    # like {processId, host, name, extra}). OF accepts both in mediaFiles.
    media_files: list[int | dict] = Field(default_factory=list, description="Vault media ids OR fresh-upload claim objects {processId,host,name,extra}")
    is_forward: bool = False
    reply_to_message_id: int | None = Field(
        None,
        description="OF native quote-reply target id — receiver renders the quoted message above this one.",
    )


# Mass-message route MUST come before /chats/{chat_id}/messages below, otherwise
# FastAPI matches `chat_id="messages"` and 422s on int validation. See bottom of
# the file for the body model `_MassMessageBody` — referenced lazily here, which
# is fine since Python resolves it at request time, not at decoration time.

@app.post("/api/of/v2/chats/messages")
def of_send_mass(body: dict = Body(...)) -> dict[str, Any]:
    """Broadcast a message to many fans.

    Body (snake_case keys):
      text (str, required)
      user_lists       (list[int], audience by list-id)
      included_users   (list[int], explicit fan ids)
      excluded_users   (list[int])
      price            (float, default 0)
      locked_text      (bool, default false)
      media_files      (list[int], vault media ids)
      scheduled_date   (str ISO 8601, optional)"""
    return _proxy(lambda: _get_client().send_mass_message(
        text=body["text"],
        user_lists=body.get("user_lists") or [],
        included_users=body.get("included_users") or [],
        excluded_users=body.get("excluded_users") or [],
        price=body.get("price", 0),
        locked_text=body.get("locked_text", False),
        media_files=body.get("media_files") or [],
        scheduled_date=body.get("scheduled_date"),
    ))

@app.post("/api/of/v2/chats/{chat_id}/messages")
def send_message(chat_id: int, body: SendMessageBody = Body(...)) -> dict[str, Any]:
    """Send a message to a fan. `chat_id` is the fan's user id (same id used
    everywhere else in this API)."""
    return _proxy(lambda: _get_client().send_message(
        chat_id,
        text=body.text,
        locked_text=body.locked_text,
        price=body.price,
        media_files=body.media_files,
        is_forward=body.is_forward,
        reply_to_message_id=body.reply_to_message_id,
    ))


# ── Dashboard / init ───────────────────────────────────────────

@app.get("/api/of/v2/init")
def of_init() -> dict[str, Any]:
    """Bootstrap payload OF loads on every page (notification counts, configs, feature flags)."""
    return _proxy(lambda: _get_client().init())

@app.get("/api/of/v2/labels")
def of_labels() -> dict[str, Any]:
    """Fan labels (colored tags)."""
    return _proxy(lambda: _get_client().labels())

@app.get("/api/of/v2/users/notifications")
def of_notifications(
    limit: int = Query(10, ge=1, le=50),
    offset: int = Query(0, ge=0),
    type: str | None = Query(None, description="'all','tips','subscribes','comments','mentions'"),
):
    """Notifications feed. Captured-correct path is /users/notifications (not /notifications)."""
    return _proxy(lambda: _get_client().notifications(limit=limit, offset=offset, type=type))

@app.get("/api/of/v2/users/notifications/count")
def of_notifications_count():
    """Per-category badge counts (all, subscribed, purchases, tip)."""
    return _proxy(lambda: _get_client().notifications_count())

@app.get("/api/of/v2/users/notifications/settings/tabs-order")
def of_notification_tabs_order():
    """Saved order of notification tabs in OF UI."""
    return _proxy(lambda: _get_client().notification_tabs_order())

@app.get("/api/of/v2/users/me/settings")
def of_my_settings():
    """Full settings dump (account, payments, streaming keys, etc.)."""
    return _proxy(lambda: _get_client().my_settings())

@app.get("/api/of/v2/users/hints")
def of_hints():
    """UI hints (onboarding banners)."""
    return _proxy(lambda: _get_client().hints())

@app.get("/api/of/v2/stories/map")
def of_stories_map():
    """Story geo-analytics map data."""
    return _proxy(lambda: _get_client().stories_map())

@app.get("/api/of/v2/streams/feed")
def of_streams_feed():
    """Live streams feed."""
    return _proxy(lambda: _get_client().streams_feed())

@app.get("/api/of/v2/streams/reminder")
def of_streams_reminders():
    """My stream reminders."""
    return _proxy(lambda: _get_client().streams_reminders())

@app.get("/api/of/v2/payouts/requests")
def of_payout_requests(limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Payout request history (Statements > Payout requests tab)."""
    return _proxy(lambda: _get_client().payout_requests(limit=limit, offset=offset))

@app.get("/api/of/v2/subscriptions/count/all")
def of_subscription_counts_all():
    """Full subscription breakdown (active/expired/blocked/etc) + subscribers + bookmarks."""
    return _proxy(lambda: _get_client().subscription_counts_all())

@app.get("/api/of/v2/users/promotions")
def of_my_promotions():
    """My outbound promotions (alt path of /promotions)."""
    return _proxy(lambda: _get_client().my_promotions())

@app.get("/api/of/v2/vault/media/types")
def of_vault_media_types():
    """Allowed vault media MIME types."""
    return _proxy(lambda: _get_client().vault_media_types())

@app.get("/api/of/v2/vault/media/processing")
def of_vault_media_processing():
    """Uploads currently being processed."""
    return _proxy(lambda: _get_client().vault_media_processing())

@app.get("/api/of/v2/users/posts/on-this-day")
def of_posts_on_this_day():
    """Memories: my old posts from this date in past years."""
    return _proxy(lambda: _get_client().posts_on_this_day())


# ── Users / search ─────────────────────────────────────────────

@app.get("/api/of/v2/users/search")
def of_search_users(q: str = Query(..., min_length=1), limit: int = Query(10, ge=1, le=50)):
    """Search creators by name/username (OF's `/users?q=` under the hood)."""
    return _proxy(lambda: _get_client().search_users(q, limit=limit))

@app.get("/api/of/v2/users/{user_id}/posts")
def of_user_posts(user_id: str, limit: int = Query(10, ge=1, le=50),
                  type: str | None = Query(None, description="'photo'|'video'|'audio'")):
    """Posts owned by another user (creator). `user_id` accepts numeric id or 'me'.
    `type` filters by media."""
    return _proxy(lambda: _get_client().user_posts(user_id, limit=limit, type=type))

# /posts/bookmarks declared earlier above (before /posts/{post_id}) so static
# path wins over the dynamic one.

@app.get("/api/of/v2/users/{user_id}/stories")
def of_user_stories(user_id: str):
    """Active stories for a creator. `user_id` accepts numeric id or 'me'."""
    return _proxy(lambda: _get_client().user_stories(user_id))

@app.get("/api/of/v2/users/{user_id}/stories/highlights")
def of_user_highlights(user_id: str):
    """Highlights for a creator. `user_id` accepts numeric id or 'me'."""
    return _proxy(lambda: _get_client().user_highlights(user_id))

@app.get("/api/of/v2/users/{user_id}/posts/photos")
def of_user_photos(user_id: str, limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Photo posts by a creator."""
    return _proxy(lambda: _get_client().user_photos(user_id, limit=limit, offset=offset))

@app.get("/api/of/v2/users/{user_id}/posts/videos")
def of_user_videos(user_id: str, limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Video posts by a creator."""
    return _proxy(lambda: _get_client().user_videos(user_id, limit=limit, offset=offset))

@app.get("/api/of/v2/users/{user_id}/labels")
def of_user_labels_on(user_id: str):
    """Labels (creator content tags) applied to this user's posts."""
    return _proxy(lambda: _get_client().user_labels_on(user_id))

@app.get("/api/of/v2/users/{user_id}/social/buttons")
def of_user_social(user_id: str):
    """Creator's social-media link buttons."""
    return _proxy(lambda: _get_client().user_social_buttons(user_id))

@app.get("/api/of/v2/users/{user_id}/links")
def of_user_links(user_id: str):
    """Creator's outbound links list."""
    return _proxy(lambda: _get_client().user_links(user_id))


# ── Subscribers / counts ───────────────────────────────────────

@app.get("/api/of/v2/subscribers")
def of_subscribers(
    type: str = Query("active", pattern="^(active|expired|all|attention|muted|recent)$"),
    limit: int = Query(10, ge=1, le=50),
    offset: int = Query(0, ge=0),
):
    """Fans subscribed to me. `type` filters by subscription state."""
    return _proxy(lambda: _get_client().subscribers(type=type, limit=limit, offset=offset))

@app.get("/api/of/v2/subscriptions/count")
def of_subscription_counts():
    """Counts of active/expired/etc — used by the dashboard pill."""
    return _proxy(lambda: _get_client().subscription_counts())


# ── Posts ──────────────────────────────────────────────────────

@app.get("/api/of/v2/posts")
def of_list_posts(limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0)):
    """My own posts."""
    return _proxy(lambda: _get_client().list_posts(limit=limit, offset=offset))

# Static path BEFORE the dynamic /posts/{post_id} below.
@app.get("/api/of/v2/posts/bookmarks")
def of_bookmarks_top(limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Posts I've bookmarked."""
    return _proxy(lambda: _get_client().bookmarked_posts(limit=limit, offset=offset))

# Posts shortcuts — declared BEFORE /posts/{post_id: int} to avoid the int-validation
# trap on static second segments like "chart" / "top".
@app.get("/api/of/v2/posts/chart")
def of_posts_chart(start: str | None = Query(None), end: str | None = Query(None)):
    """Post-performance time-series (Statistics > Engagement chart)."""
    return _proxy(lambda: _get_client().posts_chart(start=start, end=end))

@app.get("/api/of/v2/posts/top")
def of_posts_top(
    start: str | None = Query(None),
    end: str | None = Query(None),
    by: str = Query("purchases", description="purchases|likes|comments|views"),
    limit: int = Query(10, ge=1, le=50),
):
    """Top-performing posts in a date range."""
    return _proxy(lambda: _get_client().posts_top(start=start, end=end, by=by, limit=limit))

@app.get("/api/of/v2/posts/{post_id}")
def of_get_post(post_id: int):
    """Single post detail."""
    return _proxy(lambda: _get_client().get_post(post_id))

@app.get("/api/of/v2/posts/{post_id}/comments")
def of_post_comments(post_id: int, limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Comments on a post."""
    return _proxy(lambda: _get_client().post_comments(post_id, limit=limit, offset=offset))


# ── Vault ──────────────────────────────────────────────────────

@app.get("/api/of/v2/vault/media")
def of_vault_media(
    limit: int = Query(24, ge=1, le=100),
    offset: int = Query(0, ge=0),
    type: str = Query("all", pattern="^(all|photo|video|gif|audio)$",
                      description="OF uses `type=`, not `filter=` — guessing wrong silently returns everything"),
    list_id: int | None = Query(None),
    sort: str = Query("desc"),
    field: str = Query("recent"),
):
    """My vault items. Filter by media kind via `type=`."""
    return _proxy(lambda: _get_client().vault_media(
        limit=limit, offset=offset, type=type, list_id=list_id, sort=sort, field=field,
    ))


# ── Fan lists ──────────────────────────────────────────────────

@app.get("/api/of/v2/lists")
def of_get_lists(limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0)):
    """My custom fan lists + built-in ones like 'fans', 'recent'."""
    return _proxy(lambda: _get_client().get_lists(limit=limit, offset=offset))

@app.get("/api/of/v2/lists/{list_id}")
def of_get_list(list_id: str):
    """List metadata. Built-in names like 'fans' work too."""
    return _proxy(lambda: _get_client().get_list(list_id))

@app.get("/api/of/v2/lists/{list_id}/users")
def of_list_users_in(list_id: str, limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Fans in a list."""
    return _proxy(lambda: _get_client().list_users_in(list_id, limit=limit, offset=offset))


# ── Money ──────────────────────────────────────────────────────

@app.get("/api/of/v2/vault/lists")
def of_vault_lists(view: str = Query("main"), limit: int = Query(10, ge=1, le=50),
                   offset: int = Query(0, ge=0)):
    """Vault folders. Note OF's required `view` param value is `main`."""
    return _proxy(lambda: _get_client().vault_lists(view=view, limit=limit, offset=offset))

@app.get("/api/of/v2/payouts/balances")
def of_payout_balances():
    """Current balance + breakdown."""
    return _proxy(lambda: _get_client().payout_balances())

@app.get("/api/of/v2/payouts/check-receive")
def of_payout_check_receive():
    """Eligibility for next payout (banking complete, KYC done, etc)."""
    return _proxy(lambda: _get_client().payout_check_receive())

@app.get("/api/of/v2/users/settings/chat")
def of_settings_chat():
    """Default-chat / autoresponder / welcome-message settings."""
    return _proxy(lambda: _get_client().settings_chat())

@app.get("/api/of/v2/users/settings/post")
def of_settings_post():
    """Default-post / watermark settings."""
    return _proxy(lambda: _get_client().settings_post())

@app.get("/api/of/v2/schedules/later/chat")
def of_schedules_later_chat(limit: int = Query(10, ge=1, le=50)):
    """Chats scheduled for the future (newer API than /messages/queue)."""
    return _proxy(lambda: _get_client().schedules_later_chat(limit=limit))

@app.get("/api/of/v2/schedules/later/post")
def of_schedules_later_post(limit: int = Query(10, ge=1, le=50)):
    """Posts scheduled for the future."""
    return _proxy(lambda: _get_client().schedules_later_post(limit=limit))

@app.get("/api/of/v2/schedules")
def of_schedules(
    publish_date: str | None = Query(None, description="ISO yyyy-mm-dd"),
    publish_date_end: str | None = Query(None, description="ISO yyyy-mm-dd"),
    time_zone: str = Query("Europe/Ljubljana"),
    limit: int = Query(20, ge=1, le=50),
):
    """Calendar view of scheduled chats + posts in a date range."""
    return _proxy(lambda: _get_client().schedules(
        publish_date=publish_date, publish_date_end=publish_date_end,
        time_zone=time_zone, limit=limit,
    ))

@app.get("/api/of/v2/schedules/counters")
def of_schedule_counters(
    publish_date: str = Query(..., description="ISO yyyy-mm-dd"),
    publish_date_end: str = Query(..., description="ISO yyyy-mm-dd"),
    time_zone: str = Query("Europe/Ljubljana"),
):
    """Counts of scheduled items per day in a date range."""
    return _proxy(lambda: _get_client().schedule_counters(
        publish_date=publish_date, publish_date_end=publish_date_end, time_zone=time_zone,
    ))

@app.get("/api/of/v2/payouts/transactions")
def of_transactions(
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0),
    type: str | None = Query(None),
    start: str | None = Query(None, description="ISO yyyy-mm-dd"),
    end: str | None = Query(None, description="ISO yyyy-mm-dd"),
):
    """Earning transactions (tips/subs/messages/posts)."""
    return _proxy(lambda: _get_client().transactions(
        limit=limit, offset=offset, type=type, start=start, end=end,
    ))

@app.get("/api/of/v2/payouts/stats")
def of_earning_stats(
    by: str = Query("day", pattern="^(day|week|month)$"),
    start: str | None = Query(None),
    end: str | None = Query(None),
):
    """Time-series earnings totals."""
    return _proxy(lambda: _get_client().earning_stats(by=by, start=start, end=end))


# ── Stories ────────────────────────────────────────────────────

@app.get("/api/of/v2/users/me/stories")
def of_my_stories():
    """My active stories."""
    return _proxy(lambda: _get_client().my_stories())


# ── Catch-all single user lookup ───────────────────────────────
# Declared AFTER every static /users/... route so it doesn't shadow them.

@app.get("/api/of/v2/users/{user_id_or_username}")
def get_user(user_id_or_username: str) -> dict[str, Any]:
    """Fetch a single user profile by numeric id or username."""
    return _proxy(lambda: _get_client().get_user(user_id_or_username))


# ── Promotions / Trials ────────────────────────────────────────

@app.get("/api/of/v2/promotions")
def of_promotions():
    """My subscription promotions."""
    return _proxy(lambda: _get_client().promotions())

@app.get("/api/of/v2/promotions/trial")
def of_trials():
    """Trial-link campaigns (same endpoint with `type=trial`)."""
    return _proxy(lambda: _get_client().trials())


# ── Chat extras ────────────────────────────────────────────────

@app.get("/api/of/v2/chats/{chat_id}")
def of_get_chat(chat_id: int):
    """Full chat detail. Richer than the per-item shape from /chats."""
    return _proxy(lambda: _get_client().get_chat(chat_id))

@app.get("/api/of/v2/messages/queue")
def of_scheduled_messages(limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Messages scheduled for future delivery."""
    return _proxy(lambda: _get_client().scheduled_messages(limit=limit, offset=offset))


# ── Writes (UNVERIFIED — code-only, no live test from auto run) ───
# Every endpoint below maps to a known OF API path inferred from the cracked
# extension + OnlyFansAPI/OFAuth docs. Shapes are likely correct but each one
# needs a single careful live test before you trust it in a UI.

# Pydantic bodies for FastAPI's auto-validation + Swagger forms.
class _TextBody(BaseModel):
    text: str = Field(..., min_length=1)

class _NameBody(BaseModel):
    name: str = Field(..., min_length=1)

class _ScheduleMessageBody(BaseModel):
    text: str
    scheduled_date: str = Field(..., description="ISO 8601, e.g. 2026-06-01T18:00:00+00:00")
    price: float = Field(0, ge=0)
    locked_text: bool = False
    # Same shape as immediate-send: numeric vault ids OR fresh-upload claim
    # dicts. OF accepts both in mediaFiles on the queue endpoint too.
    media_files: list[int | dict] = Field(default_factory=list)

class _MassMessageBody(BaseModel):
    text: str
    user_lists: list[int] = Field(default_factory=list)
    included_users: list[int] = Field(default_factory=list)
    excluded_users: list[int] = Field(default_factory=list)
    price: float = Field(0, ge=0)
    locked_text: bool = False
    media_files: list[int] = Field(default_factory=list)
    scheduled_date: str | None = None

class _CreatePostBody(BaseModel):
    text: str
    # int = existing vault id; dict = fresh-upload claim payload from
    # the /upload endpoint's `send_with`. OF accepts mixed.
    media_files: list[int | dict] = Field(default_factory=list)
    price: float = Field(0, ge=0)
    posted_at: str | None = None

class _EditPostBody(BaseModel):
    text: str | None = None
    price: float | None = None
    media_files: list[int | dict] | None = None

class _TipBody(BaseModel):
    user_id: int
    amount: float = Field(..., gt=0)
    message: str = ""


# Chat-message writes ---------------------------------------------
# These hit /messages/{id}/... directly on OF (no /chats/{cid} prefix). All
# four like/unlike/pin/unpin VERIFIED LIVE; unsend works but is DESTRUCTIVE.

@app.delete("/api/of/v2/messages/{message_id}")
def of_unsend_message(message_id: int):
    """Unsend (delete) a chat message. Works inside OF's edit window only."""
    return _proxy(lambda: _get_client().unsend_message(message_id))

@app.post("/api/of/v2/messages/{message_id}/like")
def of_like_message(message_id: int):
    """Like a message you received (can't like your own)."""
    return _proxy(lambda: _get_client().like_message(message_id))

@app.delete("/api/of/v2/messages/{message_id}/like")
def of_unlike_message(message_id: int):
    return _proxy(lambda: _get_client().unlike_message(message_id))

@app.post("/api/of/v2/messages/{message_id}/pin/user/{user_id}")
def of_pin_message(message_id: int, user_id: int):
    """Pin a message inside a chat. Path mirrors OF's wire shape
    (`/messages/{msg}/pin/user/{chat_partner}`) — the shorter `/pin` form
    didn't reliably pin to the chat's visible pinned list."""
    return _proxy(lambda: _get_client().pin_message(message_id, user_id))

@app.delete("/api/of/v2/messages/{message_id}/pin/user/{user_id}")
def of_unpin_message(message_id: int, user_id: int):
    return _proxy(lambda: _get_client().unpin_message(message_id, user_id))

# Chat-level actions (VERIFIED LIVE) — mark read/unread, mute, hide.
# Static path BEFORE dynamic /chats/{chat_id}/... to avoid `chat_id="mark-as-read"`
# int-validation 422.

@app.post("/api/of/v2/chats/mark-as-read")
def of_mark_all_chats_read():
    """Mark EVERY chat as read (bulk no-arg endpoint)."""
    return _proxy(lambda: _get_client().mark_all_chats_read())

@app.post("/api/of/v2/chats/{chat_id}/mark-as-read")
def of_mark_chat_read(chat_id: int):
    """Mark chat as read."""
    return _proxy(lambda: _get_client().mark_chat_read(chat_id))

@app.delete("/api/of/v2/chats/{chat_id}/mark-as-read")
def of_mark_chat_unread(chat_id: int):
    """Mark chat as unread (same path as mark-read but DELETE)."""
    return _proxy(lambda: _get_client().mark_chat_unread(chat_id))

@app.post("/api/of/v2/chats/{chat_id}/mute")
def of_mute_chat(chat_id: int):
    """Mute notifications for a chat."""
    return _proxy(lambda: _get_client().mute_chat(chat_id))

@app.delete("/api/of/v2/chats/{chat_id}/mute")
def of_unmute_chat(chat_id: int):
    return _proxy(lambda: _get_client().unmute_chat(chat_id))

@app.post("/api/of/v2/chats/{chat_id}/hide")
def of_hide_chat(chat_id: int):
    """Hide chat from inbox (chat still exists; fan can still message)."""
    return _proxy(lambda: _get_client().hide_chat(chat_id))

@app.delete("/api/of/v2/chats/{chat_id}/hide")
def of_unhide_chat(chat_id: int):
    return _proxy(lambda: _get_client().unhide_chat(chat_id))

@app.get("/api/of/v2/chats/{chat_id}/media")
def of_chat_media(chat_id: int, limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Only messages in this chat that contain media."""
    return _proxy(lambda: _get_client().chat_media(chat_id, limit=limit, offset=offset))

@app.get("/api/of/v2/chats/{chat_id}/messages/search")
def of_search_chat(chat_id: int, query: str = Query(..., min_length=1, description="Substring to match against message text.")):
    """Search the FULL history of one chat. Returns a list of matching
    message IDs (newest first) — OF's native chat-search endpoint. The
    caller is responsible for fetching previews / paging to load the
    matched message bodies if they aren't in the local cache yet.

    OF param is `query` (not `text` — that 200s with an empty list)."""
    return _proxy(lambda: _get_client().search_chat(chat_id, query))

@app.post("/api/of/v2/users/{user_id}/block")
def of_block_user(user_id: int):
    """Block a user (hides chat + prevents future messages from them)."""
    return _proxy(lambda: _get_client().block_user(user_id))

@app.delete("/api/of/v2/users/{user_id}/block")
def of_unblock_user(user_id: int):
    return _proxy(lambda: _get_client().unblock_user(user_id))

@app.post("/api/of/v2/users/{user_id}/restrict")
def of_restrict_user(user_id: int):
    """Restrict a user (their content is hidden from your feed)."""
    return _proxy(lambda: _get_client().restrict_user(user_id))

@app.delete("/api/of/v2/users/{user_id}/restrict")
def of_unrestrict_user(user_id: int):
    return _proxy(lambda: _get_client().unrestrict_user(user_id))

@app.get("/api/of/v2/stories")
def of_stories_feed():
    """Stories feed (creators I follow)."""
    return _proxy(lambda: _get_client().stories_feed())

@app.get("/api/of/v2/stories/archive")
def of_stories_archive(limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0)):
    """My own archived (expired) stories."""
    return _proxy(lambda: _get_client().my_stories_archive(limit=limit, offset=offset))

@app.get("/api/of/v2/giphy/proxy/gifs/trending")
def of_gif_trending(limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Trending GIFs via OF's Giphy proxy."""
    return _proxy(lambda: _get_client().gif_trending(limit=limit, offset=offset))

@app.get("/api/of/v2/giphy/proxy/gifs/search")
def of_gif_search(q: str = Query(..., min_length=1),
                  limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Search Giphy via OF's proxy."""
    return _proxy(lambda: _get_client().gif_search(q, limit=limit, offset=offset))

# ── Message templates (welcome + saved replies) ───────────────

class _TemplateBody(BaseModel):
    text: str
    template: str | None = Field(None, description="'reply_on_subscribe' = welcome message, otherwise a saved reply")
    media_files: list[int | dict] = Field(default_factory=list)
    price: float = Field(0, ge=0)
    locked_text: bool = False

class _TemplatePatchBody(BaseModel):
    text: str | None = None
    media_files: list[int | dict] | None = None
    price: float | None = None
    locked_text: bool | None = None
    template: str | None = None  # carried for completeness; OF preserves slot on update

@app.get("/api/of/v2/messages/templates")
def of_message_templates(template: str | None = Query(None, description="filter, e.g. 'reply_on_subscribe'")):
    """Saved replies + welcome message. `template=reply_on_subscribe` filters to the welcome message."""
    return _proxy(lambda: _get_client().message_templates(template=template))

@app.post("/api/of/v2/messages/templates")
def of_create_template(body: _TemplateBody = Body(...)):
    """Create a saved reply or set the welcome message (`template=reply_on_subscribe`)."""
    return _proxy(lambda: _get_client().create_template(
        body.text, template=body.template, media_files=body.media_files,
        price=body.price, locked_text=body.locked_text,
    ))

@app.put("/api/of/v2/messages/templates/{template_id}")
def of_update_template(template_id: str, body: _TemplatePatchBody = Body(...)):
    """Edit a template."""
    return _proxy(lambda: _get_client().update_template(
        template_id, text=body.text, media_files=body.media_files,
        price=body.price, locked_text=body.locked_text,
    ))

@app.delete("/api/of/v2/messages/templates/{template_id}")
def of_delete_template(template_id: str):
    """Delete a saved reply / welcome message."""
    return _proxy(lambda: _get_client().delete_template(template_id))

# ── Subscription bundles ──────────────────────────────────────

class _BundleBody(BaseModel):
    months: int = Field(..., ge=1, le=24)
    price: float = Field(..., ge=0)
    discount: int | None = Field(None, ge=0, le=100)

@app.get("/api/of/v2/subscriptions/bundles")
def of_subscription_bundles():
    """Multi-month bundle pricing config."""
    return _proxy(lambda: _get_client().subscription_bundles())

@app.post("/api/of/v2/subscriptions/bundles")
def of_create_bundle(body: _BundleBody = Body(...)):
    return _proxy(lambda: _get_client().create_bundle(
        months=body.months, price=body.price, discount=body.discount,
    ))

@app.delete("/api/of/v2/subscriptions/bundles/{bundle_id}")
def of_delete_bundle(bundle_id: int):
    return _proxy(lambda: _get_client().delete_bundle(bundle_id))

# ── Promotion campaigns: write side ───────────────────────────

class _PromoBody(BaseModel):
    price: float = Field(..., ge=0)
    subscribe_counts: int = Field(..., ge=1)
    subscribe_days: int = Field(0, ge=0)
    message: str = ""
    type: str = "all"

@app.post("/api/of/v2/promotions")
def of_create_promo(body: _PromoBody = Body(...)):
    """Create a promo campaign. Touches public-facing offers; double-check before exposing."""
    return _proxy(lambda: _get_client().create_promo(
        price=body.price, subscribe_counts=body.subscribe_counts,
        subscribe_days=body.subscribe_days, message=body.message, type=body.type,
    ))

@app.delete("/api/of/v2/promotions/{promo_id}")
def of_delete_promo(promo_id: int):
    return _proxy(lambda: _get_client().delete_promo(promo_id))

# ── Tracking links (/campaigns) ──────────────────────────────

class _TrackingLinkBody(BaseModel):
    name: str
    code: int | None = None

@app.get("/api/of/v2/campaigns")
def of_tracking_links():
    """Tracking link list with countSubscribers + countTransitions stats."""
    return _proxy(lambda: _get_client().tracking_links())

@app.post("/api/of/v2/campaigns")
def of_create_tracking_link(body: _TrackingLinkBody = Body(...)):
    return _proxy(lambda: _get_client().create_tracking_link(
        name=body.name, code=body.code,
    ))

@app.delete("/api/of/v2/campaigns/{campaign_id}")
def of_delete_tracking_link(campaign_id: int):
    return _proxy(lambda: _get_client().delete_tracking_link(campaign_id))

# ── Free-trial links (/trials) ───────────────────────────────

class _TrialLinkBody(BaseModel):
    name: str
    subscribe_days: int = Field(7, ge=1, le=365)
    subscribe_counts: int = Field(1, ge=1)
    expired_at: str | None = None

@app.get("/api/of/v2/trials")
def of_trial_links():
    """Free-trial link list with claim/click counts."""
    return _proxy(lambda: _get_client().trial_links())

@app.post("/api/of/v2/trials")
def of_create_trial_link(body: _TrialLinkBody = Body(...)):
    return _proxy(lambda: _get_client().create_trial_link(
        name=body.name, subscribe_days=body.subscribe_days,
        subscribe_counts=body.subscribe_counts, expired_at=body.expired_at,
    ))

@app.delete("/api/of/v2/trials/{trial_id}")
def of_delete_trial_link(trial_id: int):
    return _proxy(lambda: _get_client().delete_trial_link(trial_id))

# ── Profile writes (bio, display name, etc.) ─────────────────

@app.patch("/api/of/v2/users/me")
def of_update_profile(body: dict = Body(...)):
    """PATCH /users/me — update profile fields. Body is any JSON dict; keys
    match /users/me response shape. Confirmed working live for `about`."""
    return _proxy(lambda: _get_client().update_profile(**body))

# ── Analytics (Statistics > Earnings/Engagement/Reach tabs) ────────
# All accept startDate/endDate as ISO with space (OF spec). Default = 30d window.

@app.get("/api/of/v2/earnings/chart")
def of_earnings_chart(start: str | None = Query(None), end: str | None = Query(None)):
    """Earnings time-series for the Statistics → Earnings chart."""
    return _proxy(lambda: _get_client().earnings_chart(start=start, end=end))

# /posts/chart and /posts/top declared above /posts/{post_id} in the file
# (see "Posts shortcuts" section) so they don't get shadowed by the int-typed
# dynamic route. Routes themselves live there; nothing here.

@app.get("/api/of/v2/users/me/stats/overview")
def of_my_stats_overview(start: str | None = Query(None), end: str | None = Query(None),
                          by: str = Query("visitors")):
    """My stats overview (visitors/engagement)."""
    return _proxy(lambda: _get_client().my_stats_overview(start=start, end=end, by=by))

@app.get("/api/of/v2/users/me/stats/top/post")
def of_my_stats_top_posts(start: str | None = Query(None), end: str | None = Query(None),
                          limit: int = Query(10, ge=1, le=50)):
    """My best-performing posts across types."""
    return _proxy(lambda: _get_client().my_stats_top_posts(start=start, end=end, limit=limit))

@app.get("/api/of/v2/users/me/profile/stats")
def of_my_profile_stats(start: str | None = Query(None), end: str | None = Query(None),
                         limit: int = Query(10, ge=1, le=50)):
    """Visitor source breakdown (Statistics → Reach)."""
    return _proxy(lambda: _get_client().my_profile_stats(start=start, end=end, limit=limit))

@app.get("/api/of/v2/users/me/start-date-model")
def of_my_start_date():
    """When I became a creator — used to range-cap charts."""
    return _proxy(lambda: _get_client().my_start_date())

@app.get("/api/of/v2/payouts/chargebacks/ratio")
def of_chargebacks_ratio(start: str | None = Query(None), end: str | None = Query(None)):
    """Chargeback-rate risk metric."""
    return _proxy(lambda: _get_client().chargebacks_ratio(start=start, end=end))

# ── Bookmarks (Collections → Bookmarks tab) ────────────────────────

@app.get("/api/of/v2/posts/bookmarks/all")
def of_bookmarks_all(limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Paginated bookmarks feed (the OF UI tab)."""
    return _proxy(lambda: _get_client().bookmarks_all(limit=limit, offset=offset))

@app.get("/api/of/v2/posts/bookmarks/categories")
def of_bookmark_categories(limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Bookmark folders / category tabs."""
    return _proxy(lambda: _get_client().bookmark_categories(limit=limit, offset=offset))

# ── Referrals ──────────────────────────────────────────────────────

@app.get("/api/of/v2/payments/referrals/balance")
def of_referrals_balance():
    """Referral earnings balance."""
    return _proxy(lambda: _get_client().referrals_balance())

@app.get("/api/of/v2/payouts/requests/referral")
def of_referral_payouts(limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0)):
    """Referral payout history."""
    return _proxy(lambda: _get_client().referral_payouts(limit=limit, offset=offset))

# ── Stories with map param + notification transports ──────────────

@app.get("/api/of/v2/users/settings/notifications/transports")
def of_notification_transports():
    """Notification channel settings (push/email/SMS)."""
    return _proxy(lambda: _get_client().notification_transports())

class _StoriesItemsBody(BaseModel):
    map: dict[str, int] = Field(..., description="{user_id: story_id} mapping")

@app.post("/api/of/v2/stories/items/lookup")
def of_stories_items(body: _StoriesItemsBody = Body(...)):
    """Look up story items for multiple users. OF's underlying call is
    `GET /stories/items?map[uid]=sid&...` but the query string gets unwieldy,
    so this proxy takes a JSON body. POST with `{"map": {"117183": 116351527}}`."""
    return _proxy(lambda: _get_client().stories_items({int(k): int(v) for k, v in body.map.items()}))

# Scheduled / mass --------------------------------------------------

@app.post("/api/of/v2/chats/{chat_id}/messages/scheduled")
def of_schedule_message(chat_id: int, body: _ScheduleMessageBody = Body(...)):
    """Schedule a single message for future delivery.
    Under the hood: POST /api2/v2/messages/queue with userIds=[chat_id]."""
    return _proxy(lambda: _get_client().schedule_message(
        chat_id, text=body.text, scheduled_date=body.scheduled_date,
        price=body.price, locked_text=body.locked_text, media_files=body.media_files,
    ))


class _MassScheduleBody(BaseModel):
    text: str
    # Optional — omit for an immediate broadcast. /messages/queue is OF's
    # send-now path when no scheduledDate is in the body; with one it
    # becomes the scheduled-send path.
    scheduled_date: str | None = Field(
        None, description="ISO 8601 (e.g. 2026-06-01T18:00:00+00:00); omit to send now",
    )
    user_ids: list[int] = Field(default_factory=list)
    user_lists: list[str] = Field(default_factory=list, description="List ids or built-in names like 'fans'")
    excluded_users: list[int] = Field(default_factory=list)
    excluded_user_lists: list[str] = Field(default_factory=list, description="List ids/names to exclude from the audience")
    price: float = Field(0, ge=0)
    locked_text: bool = False
    # int = existing vault id; dict = fresh-upload claim payload from
    # the /upload endpoint's `send_with`. Same shape send_message accepts.
    media_files: list[int | dict] = Field(default_factory=list)


@app.post("/api/of/v2/messages/queue")
def of_send_or_schedule_mass(body: _MassScheduleBody = Body(...)):
    """POST /messages/queue — broadcasts a mass message to many fans.
    With `scheduled_date` it's a scheduled send; without, it's immediate.
    `user_ids` for explicit fans OR `user_lists` for list-based audience."""
    client = _get_client()
    if body.scheduled_date:
        return _proxy(lambda: client.schedule_mass_message(
            text=body.text, scheduled_date=body.scheduled_date,
            user_ids=body.user_ids, user_lists=body.user_lists,
            excluded_users=body.excluded_users,
            excluded_user_lists=body.excluded_user_lists,
            price=body.price,
            locked_text=body.locked_text, media_files=body.media_files,
        ))
    return _proxy(lambda: client.send_mass_message(
        text=body.text,
        user_lists=body.user_lists,
        included_users=body.user_ids,
        excluded_users=body.excluded_users,
        excluded_user_lists=body.excluded_user_lists,
        price=body.price,
        locked_text=body.locked_text,
        media_files=body.media_files,
    ))

@app.delete("/api/of/v2/messages/queue/{queue_id}")
def of_cancel_scheduled(queue_id: int):
    """Cancel a previously scheduled message."""
    return _proxy(lambda: _get_client().cancel_scheduled(queue_id))

# Posts writes ------------------------------------------------------

@app.post("/api/of/v2/posts")
def of_create_post(body: _CreatePostBody = Body(...)):
    return _proxy(lambda: _get_client().create_post(
        text=body.text, media_files=body.media_files,
        price=body.price, posted_at=body.posted_at,
    ))

@app.put("/api/of/v2/posts/{post_id}")
def of_edit_post(post_id: int, body: _EditPostBody = Body(...)):
    return _proxy(lambda: _get_client().edit_post(
        post_id, text=body.text, price=body.price, media_files=body.media_files,
    ))

@app.delete("/api/of/v2/posts/{post_id}")
def of_delete_post(post_id: int):
    return _proxy(lambda: _get_client().delete_post(post_id))

@app.post("/api/of/v2/posts/{post_id}/like")
def of_like_post(post_id: int):
    return _proxy(lambda: _get_client().like_post(post_id))

@app.delete("/api/of/v2/posts/{post_id}/like")
def of_unlike_post(post_id: int):
    return _proxy(lambda: _get_client().unlike_post(post_id))

@app.post("/api/of/v2/posts/{post_id}/comments")
def of_comment_post(post_id: int, body: _TextBody = Body(...)):
    return _proxy(lambda: _get_client().comment_on_post(post_id, body.text))

@app.post("/api/of/v2/posts/{post_id}/pin")
def of_pin_post(post_id: int):
    return _proxy(lambda: _get_client().pin_post(post_id))

@app.delete("/api/of/v2/posts/{post_id}/pin")
def of_unpin_post(post_id: int):
    return _proxy(lambda: _get_client().unpin_post(post_id))

# List writes -------------------------------------------------------

@app.post("/api/of/v2/lists")
def of_create_list(body: _NameBody = Body(...)):
    return _proxy(lambda: _get_client().create_list(body.name))

# list_id is typed `str` (not `int`) so built-in lists like 'fans', 'recent',
# 'bookmarks' work alongside custom numeric ids. OF's API accepts both.

@app.patch("/api/of/v2/lists/{list_id}")
def of_rename_list(list_id: str, body: _NameBody = Body(...)):
    """Rename a list. OF uses PATCH (not PUT) — verified live."""
    return _proxy(lambda: _get_client().rename_list(list_id, body.name))

@app.delete("/api/of/v2/lists/{list_id}")
def of_delete_list(list_id: str):
    return _proxy(lambda: _get_client().delete_list(list_id))

@app.post("/api/of/v2/lists/{list_id}/users/{user_id}")
def of_add_user_to_list(list_id: str, user_id: int):
    return _proxy(lambda: _get_client().add_user_to_list(list_id, user_id))

@app.delete("/api/of/v2/lists/{list_id}/users/{user_id}")
def of_remove_user_from_list(list_id: str, user_id: int):
    return _proxy(lambda: _get_client().remove_user_from_list(list_id, user_id))

# Labels writes -----------------------------------------------------

@app.post("/api/of/v2/labels/{label_id}/users/{user_id}")
def of_add_label_to_user(label_id: int, user_id: int):
    return _proxy(lambda: _get_client().add_label_to_user(label_id, user_id))

@app.delete("/api/of/v2/labels/{label_id}/users/{user_id}")
def of_remove_label_from_user(label_id: int, user_id: int):
    return _proxy(lambda: _get_client().remove_label_from_user(label_id, user_id))

# Subscriber tools — FOUND via Playwright UI capture.
# OF uses ONE endpoint PUT /subscriptions/{id} with body containing either
# `notice` (fan note) or `displayName` (custom nickname) — or both.

class _NoteBody(BaseModel):
    note: str

class _CustomNameBody(BaseModel):
    name: str = Field(..., description="Custom display name; empty string clears it")

class _SubscriptionPatchBody(BaseModel):
    notice: str | None = None
    displayName: str | None = None

@app.put("/api/of/v2/subscriptions/{user_id}/note")
def of_set_fan_note(user_id: int, body: _NoteBody = Body(...)):
    """Set the creator-side private note on a fan. Send empty string to clear."""
    return _proxy(lambda: _get_client().set_fan_note(user_id, body.note))

@app.put("/api/of/v2/subscriptions/{user_id}/custom-name")
def of_set_fan_custom_name(user_id: int, body: _CustomNameBody = Body(...)):
    """Set the custom nickname for a fan. Send empty string to clear."""
    return _proxy(lambda: _get_client().set_fan_custom_name(user_id, body.name))

@app.put("/api/of/v2/subscriptions/{user_id}")
def of_update_subscription(user_id: int, body: _SubscriptionPatchBody = Body(...)):
    """Generic update: set notice and/or displayName together in one call."""
    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    return _proxy(lambda: _get_client().update_subscription(user_id, **payload))

# Media upload -----------------------------------------------------
# Three-step flow: dedupe-hash check → POST /upload/signed/create →
# PUT bytes to presigned S3 URL → returns vault media id we can send in
# subsequent /chats/{id}/messages or /posts with mediaFiles=[id].

from fastapi import UploadFile, File

@app.post("/api/of/v2/upload")
async def of_upload_media(file: UploadFile = File(...)):
    """Upload a file to OF's vault. Multipart form field name: `file`.
    Returns {media_id, deduped, size, filename, ...}.
    The returned `media_id` is usable as mediaFiles=[id] in send/post calls
    after OF's transcoder finishes (typically 5-30s for images)."""
    import tempfile, os, shutil
    suffix = os.path.splitext(file.filename or "upload.bin")[1] or ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name
    try:
        return _proxy(lambda: _get_client().upload_media(
            tmp_path,
            content_type=file.content_type,
        ))
    finally:
        try: os.unlink(tmp_path)
        except OSError: pass


# Tips (MOVES MONEY — not auto-tested) ------------------------------

@app.post("/api/of/v2/tips")
def of_send_tip(body: _TipBody = Body(...)):
    """Send a tip. Touches real money — verify carefully before exposing in UI."""
    return _proxy(lambda: _get_client().send_tip(body.user_id, body.amount, message=body.message))


# ── Admin ──────────────────────────────────────────────────────

@app.post("/admin/reload-session")
def reload_session(account_id: str | None = Query(None)) -> dict[str, Any]:
    """Hot-swap an account's OFClient (re-read its latest session from disk).
    `account_id` defaults to the currently-active account."""
    aid = account_id or account_registry.get_active_account_id()
    if not aid:
        raise HTTPException(status_code=503, detail="no active account")
    _invalidate_client(aid)
    c = _load_client(aid)
    return {"ok": True, "account_id": aid, "user_id": c.user_id, "x_of_rev": c.x_of_rev}


@app.get("/admin/rev/live")
def admin_rev_live(refresh: bool = Query(False, description="Force a fresh probe instead of using the cached value")) -> dict[str, Any]:
    """Current OF frontend build hash (x-of-rev) as seen by an unauthenticated
    homepage fetch. Cached in-process with a 10-minute TTL; pass `?refresh=1`
    to bust the cache. UI uses this to flag sessions stuck at an old rev."""
    snap = live_rev.refresh(force=True) if refresh else live_rev.get()
    return snap


@app.get("/admin/rev/drift")
def admin_rev_drift() -> dict[str, Any]:
    """Per-account drift report. For each account with a captured session,
    compare its stored x-of-rev against the live homepage probe. The UI's
    'session stale — re-capture required' banner reads this endpoint on
    page load and after any /admin/reload-session call."""
    live_snap = live_rev.get()
    live = live_snap.get("rev")
    rows: list[dict[str, Any]] = []
    any_drift = False
    for meta in account_registry.list_accounts():
        aid = meta["id"]
        if not meta.get("has_session"):
            rows.append({
                "account_id": aid, "nickname": meta.get("nickname"),
                "has_session": False, "session_rev": None,
                "drift": False, "stale": True, "reason": "no_session",
            })
            continue
        sp = account_registry.latest_session_path(aid)
        try:
            s = json.loads(sp.read_text()) if sp else {}
        except Exception:
            s = {}
        session_rev = (s.get("headers") or {}).get("x_of_rev")
        cmp = live_rev.compare(session_rev)
        row = {
            "account_id": aid,
            "nickname": meta.get("nickname"),
            "has_session": True,
            "session_rev": session_rev,
            "live_rev": cmp.get("live_rev"),
            "live_known": cmp.get("live_known"),
            "drift": cmp.get("drift", False),
            "stale": cmp.get("drift", False),
            "captured_at": s.get("captured_at"),
        }
        if cmp.get("drift"):
            any_drift = True
        rows.append(row)
    return {
        "live_rev": live,
        "live_known": bool(live),
        "live_fetched_at": live_snap.get("fetched_at"),
        "live_error": live_snap.get("error"),
        "any_drift": any_drift,
        "accounts": rows,
    }


@app.get("/admin/session/status")
def session_status(account_id: str | None = Query(None)) -> dict[str, Any]:
    """Snapshot of an account's current session. Defaults to the active one."""
    aid = account_id or account_registry.get_active_account_id()
    if not aid:
        return {"loaded": False, "remedy": "No account yet — POST /admin/session/bootstrap"}
    sp = account_registry.latest_session_path(aid)
    if not sp:
        return {"loaded": False, "account_id": aid,
                "remedy": f"Account {aid} has no captured session yet"}
    s = json.loads(sp.read_text())
    return {
        "loaded": True,
        "account_id": aid,
        "session_file": sp.name,
        "captured_at": s.get("captured_at"),
        "user_id": s.get("headers", {}).get("user_id"),
        "x_of_rev": s.get("headers", {}).get("x_of_rev"),
        "profile_id": s.get("profile_id"),
        "cookies_count": len(s.get("cookies", [])),
    }


class _BootstrapBody(BaseModel):
    mode: str = Field(..., description="'incogniton-default' | 'incogniton-custom' | 'paste-curl' | 'playwright-proxy'")
    profile_id: str | None = Field(None, description="Required for mode=incogniton-custom")
    curl: str | None = Field(None, description="Required for mode=paste-curl — `curl …` from DevTools")
    static_param_override: str | None = Field(None, description="Optional override for an unfamiliar OF revision")
    # Multi-account additions: optional hint/nickname and whether to flip the
    # newly-captured account to active. account_id is a hint only — the real
    # account is always determined by the captured user_id (OF's identity).
    account_id: str | None = Field(None, description="Hint: re-capture for this account (uses its stored Incogniton profile / proxy)")
    nickname: str | None = Field(None, description="Friendly label persisted to the account meta")
    make_active: bool = Field(True, description="Flip the relay's active account to the newly-captured one")
    # playwright-proxy mode: which proxy (from the registry) to route the
    # capture browser through. The new account auto-inherits this binding.
    proxy_label: str | None = Field(None, description="Required for mode=playwright-proxy unless account_id already has a proxy bound")


@app.post("/admin/session/bootstrap")
def bootstrap_session(body: _BootstrapBody = Body(...)) -> dict[str, Any]:
    """Set up an OF session. Modes:

    - **incogniton-default**: capture via the default Incogniton profile id
      (env INCOGNITON_PROFILE_ID or hard-coded fallback).
    - **incogniton-custom**: capture via a profile id you pass in.
    - **paste-curl**: paste a `curl ...` command copied from DevTools
      (right-click a `/api2/v2/*` request → Copy as cURL). We extract
      cookies + signed-header sample, fetch 2313.js, derive rules.

    Each captured session is written into its account's directory
    (sessions/accounts/<user_id>/). Pass `account_id` to re-capture an
    existing one (uses the stored Incogniton profile if you don't override).
    `nickname` is the friendly label shown in the UI switcher."""
    import session_bootstrap
    try:
        if body.mode == "incogniton-default":
            path = session_bootstrap.run_incogniton(
                None, account_id=body.account_id, nickname=body.nickname,
                make_active=body.make_active,
            )
        elif body.mode == "incogniton-custom":
            if not body.profile_id:
                raise HTTPException(status_code=400, detail="profile_id required for incogniton-custom")
            path = session_bootstrap.run_incogniton(
                body.profile_id, account_id=body.account_id, nickname=body.nickname,
                make_active=body.make_active,
            )
        elif body.mode == "paste-curl":
            if not body.curl:
                raise HTTPException(status_code=400, detail="curl text required for paste-curl")
            path = session_bootstrap.from_curl(
                body.curl,
                static_param_override=body.static_param_override,
                account_id=body.account_id, nickname=body.nickname,
                make_active=body.make_active,
            )
        elif body.mode == "playwright-proxy":
            if not body.proxy_label and not body.account_id:
                raise HTTPException(
                    status_code=400,
                    detail="playwright-proxy mode requires either proxy_label or an account_id "
                           "that already has a proxy assigned",
                )
            path = session_bootstrap.run_playwright_proxy(
                body.proxy_label,
                account_id=body.account_id,
                nickname=body.nickname,
                make_active=body.make_active,
            )
        else:
            raise HTTPException(status_code=400, detail=f"unknown mode: {body.mode}")
    except session_bootstrap.CurlParseError as e:
        raise HTTPException(status_code=400, detail=f"curl parse error: {e}")
    except HTTPException:
        raise
    except Exception as e:
        log.exception("bootstrap failed")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")

    # Resolve which account dir we ended up in (path = .../accounts/<id>/session_*.json)
    actual_aid = path.parent.name
    _invalidate_client(actual_aid)
    c = _load_client(actual_aid)
    # Kick the WS pump too so the new cookies are used immediately.
    _restart_account_pump(actual_aid)
    # Phase A: mirror the new on-disk state into SQL. Fire-and-forget so a
    # slow DB doesn't delay the user's confirmation.
    _kick_db_sync(f"bootstrap-{actual_aid}")
    return {
        "ok": True,
        "session_file": path.name,
        "account_id": actual_aid,
        "user_id": c.user_id,
        "x_of_rev": c.x_of_rev,
    }


@app.post("/admin/session/wipe-fresh-browser-buckets")
def wipe_fresh_browser_buckets() -> dict[str, Any]:
    """Delete every `service/sessions/browser_profiles/fresh-*/` directory.

    Each click of "Launch browser via proxy" (no `account_id` hint) creates
    a fresh-<ts>-<uuid> bucket holding that Chromium's persistent profile
    (cookies, localStorage, captcha-solved flag). The captured session is
    already adopted into `sessions/accounts/<user_id>/` before we return —
    so the bucket itself is disposable. This endpoint frees the disk and
    guarantees no leftover logged-in state is sitting around.

    Untouched: account-id-bucketed dirs (e.g. `446300082/`) and the
    legacy `unbound/` / proxy-label dirs (`hu-1`, `hu-3`, ...). Those are
    still re-usable for warmed-up re-captures.
    """
    import shutil
    base = Path(__file__).resolve().parent / "sessions" / "browser_profiles"
    if not base.exists():
        return {"ok": True, "wiped": [], "skipped": []}
    wiped: list[str] = []
    errors: list[dict[str, str]] = []
    for entry in base.iterdir():
        if not entry.is_dir():
            continue
        if not entry.name.startswith("fresh-"):
            continue
        try:
            shutil.rmtree(entry)
            wiped.append(entry.name)
        except OSError as e:
            errors.append({"bucket": entry.name, "error": str(e)})
    return {"ok": not errors, "wiped": wiped, "errors": errors}


# ── Multi-account admin ───────────────────────────────────────

@app.get("/admin/accounts")
def admin_accounts_list() -> dict[str, Any]:
    """List every account the relay knows about + the currently-active one.
    The UI populates its switcher from this."""
    return {
        "accounts": account_registry.list_accounts(),
        "active_account_id": account_registry.get_active_account_id(),
    }


class _ActivateBody(BaseModel):
    account_id: str | None


@app.post("/admin/accounts/active")
def admin_accounts_activate(body: _ActivateBody = Body(...)) -> dict[str, Any]:
    """Flip which account is the default (no X-Account-Id header → this one)."""
    if body.account_id is not None and account_registry.get_account(body.account_id) is None:
        raise HTTPException(status_code=404, detail=f"unknown account {body.account_id!r}")
    account_registry.set_active_account_id(body.account_id)
    _kick_db_sync("accounts-active")
    return {"ok": True, "active_account_id": body.account_id}


class _AccountUpdateBody(BaseModel):
    nickname: str | None = None
    color: str | None = None
    incogniton_profile_id: str | None = None


@app.patch("/admin/accounts/{account_id}")
def admin_accounts_update(account_id: str, body: _AccountUpdateBody = Body(...)) -> dict[str, Any]:
    """Rename / recolor / re-link Incogniton profile. Doesn't touch sessions."""
    if account_registry.get_account(account_id) is None:
        raise HTTPException(status_code=404, detail=f"unknown account {account_id!r}")
    meta = account_registry.upsert_account(
        account_id,
        nickname=body.nickname,
        color=body.color,
        incogniton_profile_id=body.incogniton_profile_id,
    )
    _kick_db_sync(f"accounts-update-{account_id}")
    return {"ok": True, "account": meta}


@app.delete("/admin/accounts/{account_id}")
def admin_accounts_remove(account_id: str) -> dict[str, Any]:
    """Permanently remove an account dir (sessions + meta). Stops its WS pump
    and drops its pooled client. Cannot be undone."""
    if account_registry.get_account(account_id) is None:
        raise HTTPException(status_code=404, detail=f"unknown account {account_id!r}")
    _stop_account_pump(account_id)
    _invalidate_client(account_id)
    ok = account_registry.delete_account(account_id)
    _kick_db_sync(f"accounts-delete-{account_id}")
    return {"ok": ok}


# ── Proxy registry admin ──────────────────────────────────────
# Phase-1 (DC testing): creds are returned in plaintext on purpose so the UI
# can show host:port:user:pass. Move to keychain in Phase 2.

class _ProxyBody(BaseModel):
    label: str
    host: str
    port: int
    username: str | None = None
    password: str | None = None
    scheme: str = "http"
    notes: str = ""


class _AssignBody(BaseModel):
    label: str
    # Legacy: bind to a specific session file. Kept for back-compat.
    session_file: str | None = Field(None, description="LEGACY: session_*.json filename; prefer account_id")
    # Preferred: bind to an OF account (survives re-captures).
    account_id: str | None = Field(None, description="OF account id to bind this proxy to (null to unassign)")


@app.get("/admin/proxies")
def admin_proxies_list() -> dict[str, Any]:
    """Return proxies + the account list the UI populates its 'assign to'
    picker from. Each proxy is enriched with `assigned_account` (nickname
    + id) when bound."""
    proxies_list = proxy_registry.list_proxies()
    accounts = account_registry.list_accounts()
    by_aid = {a["id"]: a for a in accounts}
    enriched = []
    for p in proxies_list:
        out = dict(p)
        aid = p.get("assigned_account_id")
        if aid and aid in by_aid:
            out["assigned_account"] = {
                "id": aid,
                "nickname": by_aid[aid].get("nickname"),
                "color": by_aid[aid].get("color"),
            }
        else:
            out["assigned_account"] = None
        out["url"] = proxy_registry.proxy_url(p)
        enriched.append(out)
    return {
        "proxies": enriched,
        # Slim account list shaped the way the picker wants it.
        "accounts": [{
            "id": a["id"], "nickname": a.get("nickname"),
            "color": a.get("color"), "has_session": a.get("has_session", False),
        } for a in accounts],
    }


@app.post("/admin/proxies")
def admin_proxies_upsert(body: _ProxyBody = Body(...)) -> dict[str, Any]:
    try:
        entry = proxy_registry.upsert(body.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _kick_db_sync(f"proxy-upsert-{body.label}")
    return {"ok": True, "proxy": entry}


@app.delete("/admin/proxies/{label}")
def admin_proxies_remove(label: str) -> dict[str, Any]:
    ok = proxy_registry.remove(label)
    if not ok:
        raise HTTPException(status_code=404, detail=f"no proxy with label {label!r}")
    # Proxy assignment is per session-file, but a session-file is owned by
    # exactly one account → invalidating the whole pool is the simplest
    # correct option (one network round-trip on next request per account).
    _clients.clear()
    _kick_db_sync(f"proxy-delete-{label}")
    return {"ok": True}


@app.post("/admin/proxies/assign")
def admin_proxies_assign(body: _AssignBody = Body(...)) -> dict[str, Any]:
    """Bind a proxy to an account (preferred) or to a specific session file
    (legacy). Pass `account_id: null` to unassign the account binding.

    Whichever scheme is used, all pooled clients are dropped so the affected
    account picks up the new proxy on its next request."""
    try:
        # If the caller specified account_id (even as null), treat as account
        # binding — even an explicit null is a "please unassign" signal.
        if body.account_id is not None or "account_id" in body.model_fields_set:
            entry = proxy_registry.assign_account(body.label, body.account_id)
        else:
            entry = proxy_registry.assign(body.label, body.session_file)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    _clients.clear()
    _kick_db_sync(f"proxy-assign-{body.label}")
    return {"ok": True, "proxy": entry}


@app.post("/admin/proxies/{label}/test")
def admin_proxies_test(label: str) -> dict[str, Any]:
    p = proxy_registry.get_by_label(label)
    if p is None:
        raise HTTPException(status_code=404, detail=f"no proxy with label {label!r}")
    result = proxy_registry.probe(p)
    proxy_registry.record_verification(
        label, ip=result.get("ip"), geo=result.get("geo"), ok=result.get("ok", False),
    )
    return result


# ── Realtime: WS fan-out, stats, webhook config ────────────────

@app.get("/events", include_in_schema=False)
async def sse_events(request: Request, scope: str = Query("all")):
    """Server-Sent Events stream for the new browser app.

    Mirror of `/ws/events` but over SSE so the client uses native
    EventSource (one-way, auto-reconnect, plays well with corporate
    proxies). Scope grammar:
      ?scope=all                    — every event from every account
      ?scope=model:<account_id>     — only that account

    Phase B will add `Last-Event-ID` replay from event_inbox so a
    reconnecting client catches up on missed events. Phase A: starts
    from "now."
    """
    return StreamingResponse(
        sse_stream(request, scope),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # tell nginx/cloudflare to flush, not buffer
            "Connection": "keep-alive",
        },
    )


@app.websocket("/ws/events")
async def ws_events(websocket: WebSocket) -> None:
    """Browser-facing WebSocket. Every OF event that arrives over any account
    pump is forwarded as a JSON text frame.

    Optional `?account_id=...` query param filters to that account only.
    Without it, the subscriber receives events from every account (with
    the `__account_id` / `__account_name` tags intact).
    """
    await websocket.accept()
    only_account = websocket.query_params.get("account_id") or None
    q: asyncio.Queue = asyncio.Queue(maxsize=500)
    _event_subscribers.add(q)
    try:
        await websocket.send_json({
            "__ready": True,
            "subscribers": len(_event_subscribers),
            "filter_account_id": only_account,
            "accounts": [{"id": a["id"], "nickname": a["nickname"], "color": a.get("color")}
                         for a in account_registry.list_accounts()],
        })
        while True:
            event = await q.get()
            if only_account and isinstance(event, dict) \
                    and event.get("__account_id") not in (None, only_account):
                continue
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning("ws client error: %s", e)
    finally:
        _event_subscribers.discard(q)


@app.get("/admin/events/stats")
def event_stats() -> dict[str, Any]:
    """How many events the pumps have seen, broken down by type + account.
    Useful to confirm each account's WS is alive without subscribing."""
    pumps = {
        aid: {"running": not t.done(), "cancelled": t.cancelled() if t.done() else False}
        for aid, t in _account_pumps.items()
    }
    return {
        **_event_stats,
        "subscribers": len(_event_subscribers),
        "pumps": pumps,
        "pumps_running": sum(1 for p in pumps.values() if p["running"]),
        "supervisor_running": (_supervisor_task is not None and not _supervisor_task.done()),
    }


class _WebhookBody(BaseModel):
    url: str = Field(..., description="HTTP(S) URL to POST every matched event as JSON.")
    event_types: list[str] = Field(
        default_factory=lambda: ["*"],
        description="Event keys to match (e.g. ['api2_chat_message','new_message']). '*' = all events.",
    )


@app.get("/admin/webhooks")
def list_webhooks() -> dict[str, list[str]]:
    """Return the per-event-type → [url,...] config."""
    return _load_webhooks()


@app.post("/admin/webhooks")
def add_webhook(body: _WebhookBody = Body(...)) -> dict[str, Any]:
    """Register a webhook URL for one or more event types ('*' = catch-all)."""
    cfg = _load_webhooks()
    for kind in body.event_types or ["*"]:
        urls = cfg.setdefault(kind, [])
        if body.url not in urls:
            urls.append(body.url)
    _save_webhooks(cfg)
    return {"ok": True, "config": cfg}


@app.delete("/admin/webhooks")
def delete_webhook(url: str = Query(...), event_type: str = Query("*")) -> dict[str, Any]:
    """Remove a webhook URL from one event type, or '*' to scrub it from all."""
    cfg = _load_webhooks()
    if event_type == "*":
        for kind in list(cfg.keys()):
            cfg[kind] = [u for u in cfg[kind] if u != url]
            if not cfg[kind]:
                del cfg[kind]
    else:
        if event_type in cfg:
            cfg[event_type] = [u for u in cfg[event_type] if u != url]
            if not cfg[event_type]:
                del cfg[event_type]
    _save_webhooks(cfg)
    return {"ok": True, "config": cfg}


# ── Saved replies (local-only "templates" minus welcome) ──────────────
# OF's /messages/templates rejects creates for everything except the
# welcome slot. We keep regular saved replies in the local DB and let
# the UI merge them with OF's welcome at render time.

class _SavedReplyBody(BaseModel):
    title: str | None = None
    text: str
    price: float = Field(0, ge=0)
    locked_text: bool = False
    # Vault-media references, persisted as JSON so the editor can
    # re-render thumbs without a second fetch.
    media: list[dict] = Field(default_factory=list)


def _serialize_saved_reply(row: Any) -> dict[str, Any]:
    return {
        "id": row.id,
        "account_id": row.account_id,
        "title": row.title,
        "text": row.text,
        "price": (row.price_cents or 0) / 100,
        "locked_text": bool(row.locked_text),
        "media": json.loads(row.media_json or "[]"),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@app.get("/admin/saved-replies")
async def admin_saved_replies_list(account_id: str = Query(...)) -> dict[str, Any]:
    """Saved replies for one account. Sorted newest-edit first."""
    from db.engine import get_session
    from db.models import SavedReply
    from sqlalchemy import select
    async with get_session() as s:
        result = await s.execute(
            select(SavedReply)
            .where(SavedReply.account_id == account_id)
            .order_by(SavedReply.updated_at.desc()),
        )
        rows = result.scalars().all()
        return {"list": [_serialize_saved_reply(r) for r in rows]}


@app.post("/admin/saved-replies")
async def admin_saved_replies_create(
    body: _SavedReplyBody = Body(...),
    account_id: str = Query(...),
) -> dict[str, Any]:
    """Create a new saved reply for an account."""
    from db.engine import get_session
    from db.models import SavedReply
    async with get_session() as s:
        row = SavedReply(
            account_id=account_id,
            title=body.title,
            text=body.text,
            price_cents=int(round(body.price * 100)),
            locked_text=body.locked_text,
            media_json=json.dumps(body.media),
        )
        s.add(row)
        await s.commit()
        await s.refresh(row)
        return _serialize_saved_reply(row)


@app.put("/admin/saved-replies/{reply_id}")
async def admin_saved_replies_update(
    reply_id: int,
    body: _SavedReplyBody = Body(...),
) -> dict[str, Any]:
    """Replace a saved reply's contents wholesale (no PATCH semantics — UI
    submits the full draft on every save, matching the editor's mental model)."""
    from db.engine import get_session
    from db.models import SavedReply
    from datetime import datetime as _dt
    async with get_session() as s:
        row = await s.get(SavedReply, reply_id)
        if not row:
            raise HTTPException(status_code=404, detail="saved reply not found")
        row.title = body.title
        row.text = body.text
        row.price_cents = int(round(body.price * 100))
        row.locked_text = body.locked_text
        row.media_json = json.dumps(body.media)
        row.updated_at = _dt.utcnow()
        await s.commit()
        await s.refresh(row)
        return _serialize_saved_reply(row)


@app.delete("/admin/saved-replies/{reply_id}")
async def admin_saved_replies_delete(reply_id: int) -> dict[str, Any]:
    from db.engine import get_session
    from db.models import SavedReply
    async with get_session() as s:
        row = await s.get(SavedReply, reply_id)
        if not row:
            raise HTTPException(status_code=404, detail="saved reply not found")
        await s.delete(row)
        await s.commit()
        return {"ok": True}


# ── Vault sends + per-fan history ─────────────────────────────────────
# Powers the picker's "you sent this to her 2 weeks ago / she bought it"
# badges. Frontend writes here right after a successful chat-send (better
# than wrapping the OF send proxy — keeps that path a clean mirror, and
# lets us decide per-call whether to track, e.g. don't track mass-sends).

class _VaultSendBody(BaseModel):
    account_id: str
    fan_id: int
    media_ids: list[int] = Field(default_factory=list)
    message_id: int | None = None
    price_cents: int = Field(0, ge=0, description="PPV price in cents (0 = free send)")


@app.post("/admin/vault/sends")
async def admin_vault_sends_create(body: _VaultSendBody = Body(...)) -> dict[str, Any]:
    """Record one vault-send row per media id. Returns the inserted count.

    Skips negative ids (fresh-claim placeholders the optimistic bubble
    used before the real vault id was assigned) — those slip through if
    the caller doesn't filter, and we shouldn't pollute history with them."""
    from db.engine import get_session
    from db.models import VaultSend
    real_ids = [mid for mid in body.media_ids if isinstance(mid, int) and mid > 0]
    if not real_ids:
        return {"ok": True, "inserted": 0}
    async with get_session() as s:
        for mid in real_ids:
            s.add(VaultSend(
                account_id=body.account_id,
                fan_id=body.fan_id,
                media_id=mid,
                message_id=body.message_id,
                price_cents=body.price_cents,
                # was_purchased flips later when a matching transaction
                # lands (see Transaction ingest path). Default null = unknown.
            ))
        await s.commit()
    return {"ok": True, "inserted": len(real_ids)}


class _VaultBackfillItem(BaseModel):
    message_id: int
    media_ids: list[int] = Field(default_factory=list)
    price_cents: int = Field(0, ge=0)
    # OF reports `isOpened=true` on a PPV once the fan has paid; we mirror
    # that as `was_purchased`. None for free sends — leave the column null
    # so the UI can distinguish "definitely not paid" vs "wasn't paid for".
    was_purchased: bool | None = None


class _VaultBackfillBody(BaseModel):
    account_id: str
    fan_id: int
    items: list[_VaultBackfillItem] = Field(default_factory=list)


@app.post("/admin/vault/sends/backfill")
async def admin_vault_sends_backfill(body: _VaultBackfillBody = Body(...)) -> dict[str, Any]:
    """Bulk-insert vault-send rows from chat history. The frontend calls
    this whenever a chat opens — every outgoing message with media that
    DOESN'T already have a vault_send row gets one. Idempotent: existing
    rows are detected via (account_id, fan_id, media_id, message_id) and
    skipped, so it's safe to fire on every chat-open without dupes.

    This is how we cover historical sends (pre-tracking), without
    requiring a one-off backfill job."""
    from db.engine import get_session
    from db.models import VaultSend
    from sqlalchemy import select
    if not body.items:
        return {"ok": True, "inserted": 0, "skipped": 0}

    # Pull every existing (media_id, message_id) for this fan in one query
    # so the dupe check is O(rows) instead of O(items × DB roundtrip).
    seen_msg_ids = {it.message_id for it in body.items if it.message_id}
    inserted = 0
    skipped = 0
    async with get_session() as s:
        existing: set[tuple[int, int]] = set()
        if seen_msg_ids:
            res = await s.execute(
                select(VaultSend.media_id, VaultSend.message_id)
                .where(
                    VaultSend.account_id == body.account_id,
                    VaultSend.fan_id == body.fan_id,
                    VaultSend.message_id.in_(seen_msg_ids),
                ),
            )
            for mid, msg in res.all():
                if msg is not None:
                    existing.add((mid, msg))

        for item in body.items:
            real_ids = [mid for mid in item.media_ids if isinstance(mid, int) and mid > 0]
            for mid in real_ids:
                if (mid, item.message_id) in existing:
                    skipped += 1
                    continue
                s.add(VaultSend(
                    account_id=body.account_id,
                    fan_id=body.fan_id,
                    media_id=mid,
                    message_id=item.message_id,
                    price_cents=item.price_cents,
                    was_purchased=item.was_purchased,
                ))
                existing.add((mid, item.message_id))
                inserted += 1
        if inserted:
            await s.commit()
    return {"ok": True, "inserted": inserted, "skipped": skipped}


@app.get("/admin/vault/wall-media")
async def admin_vault_wall_media(
    request: Request,
    account_id: str = Query(...),
    pages: int = Query(5, ge=1, le=20, description="Max post pages to walk."),
    limit: int = Query(50, ge=1, le=50, description="Posts per page."),
) -> dict[str, Any]:
    """Aggregate every vault media id that appears in this model's wall
    posts. Walks OF's /users/{my_id}/posts feed page-by-page using the
    tailMarker cursor; capped at `pages × limit` posts so a creator with
    thousands of posts doesn't hang the request.

    Returns:
      { "media_ids": [int, ...] }   sorted ascending for stable hashing
      { "scanned_posts": int }
      { "has_more": bool }          true if we stopped at the page cap

    Frontend uses this to draw the 'posted on wall' ring around vault
    tiles. Pure read — no DB writes — we lean on the PersistQueryClient
    layer for caching at the frontend so the first paint of every chat
    is instant after one warm load."""
    client = _load_client(account_id)
    me_resp = client.me()
    my_id = me_resp.get("id")
    if not isinstance(my_id, int):
        raise HTTPException(status_code=500, detail="Could not resolve current user id from /users/me")

    media_ids: set[int] = set()
    before: str | None = None
    scanned = 0
    has_more = False
    for _ in range(pages):
        # Bail out as soon as the client disconnects (e.g. user switched
        # vault folder mid-walk and the browser aborted the fetch).
        # Without this, the loop would walk all 5 OF pages while the
        # newly-issued vault-media call queues behind it on the per-
        # account proxy, blocking the user's interaction by 10–15s.
        if await request.is_disconnected():
            raise HTTPException(status_code=499, detail="client disconnected")
        resp = client.user_posts(
            my_id,
            limit=limit,
            skip_users="all",
            format="infinite",
            before_publish_time=before,
        )
        posts = resp.get("list", []) if isinstance(resp, dict) else []
        if not posts:
            break
        scanned += len(posts)
        for post in posts:
            for m in (post.get("media") or []):
                mid = m.get("id")
                if isinstance(mid, int) and mid > 0:
                    media_ids.add(mid)
        has_more = bool(resp.get("hasMore"))
        if not has_more:
            break
        before = resp.get("tailMarker")
        if not before:
            break
    return {
        "media_ids": sorted(media_ids),
        "scanned_posts": scanned,
        "has_more": has_more,
    }


@app.get("/admin/vault/fan-history")
async def admin_vault_fan_history(
    account_id: str = Query(...),
    fan_id: int = Query(...),
) -> dict[str, Any]:
    """Per-media send history for ONE fan. Drives the vault-picker's
    'sent / purchased / unseen' badges with an O(1) lookup per tile.

    Returns:
      by_media: { "<media_id>": { send_count, last_sent_at,
                                  last_price_cents, was_purchased,
                                  last_purchase_at, total_paid_cents } }

    `was_purchased` mirrors the column on vault_sends — true once a
    transaction with the same message_id is observed.
    `last_purchase_at` / `total_paid_cents` come from joining the
    transactions table (kind in {message, ppv}) on message_id."""
    from db.engine import get_session
    from db.models import Transaction, VaultSend
    from sqlalchemy import select
    async with get_session() as s:
        # All sends to this fan, newest first.
        sends_res = await s.execute(
            select(VaultSend)
            .where(VaultSend.account_id == account_id, VaultSend.fan_id == fan_id)
            .order_by(VaultSend.sent_at.desc()),
        )
        sends = sends_res.scalars().all()
        if not sends:
            return {"by_media": {}}

        # Pull transactions referenced by any of our sends so we can mark
        # was_purchased + sum paid amounts. Filter to message-bearing txns
        # to skip subscription rebills + tips.
        msg_ids = {s.message_id for s in sends if s.message_id is not None}
        tx_by_msg: dict[int, list[Transaction]] = {}
        if msg_ids:
            tx_res = await s.execute(
                select(Transaction)
                .where(
                    Transaction.account_id == account_id,
                    Transaction.fan_id == fan_id,
                    Transaction.message_id.in_(msg_ids),
                ),
            )
            for t in tx_res.scalars().all():
                if t.message_id is None:
                    continue
                tx_by_msg.setdefault(t.message_id, []).append(t)

        by_media: dict[str, dict[str, Any]] = {}
        for snd in sends:
            entry = by_media.setdefault(str(snd.media_id), {
                "send_count": 0,
                "last_sent_at": None,
                "last_price_cents": 0,
                "was_purchased": False,
                "last_purchase_at": None,
                "total_paid_cents": 0,
            })
            entry["send_count"] += 1
            # Sends came back newest-first, so the first one we see is
            # the most recent — only fill these when they're still empty.
            if entry["last_sent_at"] is None:
                entry["last_sent_at"] = snd.sent_at.isoformat() if snd.sent_at else None
                entry["last_price_cents"] = snd.price_cents or 0
            # was_purchased: row flag OR any matching transaction.
            if snd.was_purchased:
                entry["was_purchased"] = True
            if snd.message_id and snd.message_id in tx_by_msg:
                for t in tx_by_msg[snd.message_id]:
                    entry["was_purchased"] = True
                    entry["total_paid_cents"] += t.amount_cents or 0
                    iso = t.occurred_at.isoformat() if t.occurred_at else None
                    if iso and (entry["last_purchase_at"] is None or iso > entry["last_purchase_at"]):
                        entry["last_purchase_at"] = iso
        return {"by_media": by_media}


# ── Static UI ──────────────────────────────────────────────────
# Mounted AFTER all API routes so route precedence is correct.
# StaticFiles(html=True) serves /ui/ → web/index.html automatically.

@app.get("/", include_in_schema=False)
def root_redirect():
    return RedirectResponse("/ui/")


# Belt-and-suspenders cache-bust: when the user updates web/app.js or
# index.html, we want every browser to refetch on next load. Without this
# header, browsers (especially behind Tailscale's funnel) hold onto JS for
# hours and the user sees ancient code despite hard-refreshing. Bypassing
# the cache for static assets is fine — they're tiny.
@app.middleware("http")
async def _no_cache_ui(request: Request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/ui/"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


_WEB_DIR = HERE.parent / "web"
if _WEB_DIR.is_dir():
    app.mount("/ui", StaticFiles(directory=_WEB_DIR, html=True), name="ui")
else:
    log.warning("web/ folder not found at %s — UI disabled", _WEB_DIR)
