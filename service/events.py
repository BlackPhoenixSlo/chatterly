"""
SSE broadcaster + event_inbox writer.

This module sits BETWEEN the existing `_broadcast_event` in server.py and
the new browser app. Two responsibilities:

  1. Every event that flows through the OF-WS pump → write a row to
     `event_inbox` (idempotent on `provider_event_id` when present). This
     gives us a durable, queryable record of every OF event for replay,
     debugging, and the phase B canonical-table writer.

  2. Maintain a pool of SSE-style asyncio queues keyed by `scope`. When a
     subscriber connects to `GET /events?scope=...`, they get a queue;
     when an event arrives, it's pushed to every matching queue. Scopes:
       • "all"               — every event from every account
       • "model:<account_id>" — only that account's events

The original `_broadcast_event` already handles browser WebSocket
delivery via `_event_subscribers`. We add SSE in parallel because:
  • SSE is one-way + native to fetch — simpler client code.
  • SSE survives proxies/CDNs that mangle WebSocket upgrades.
  • EventSource + Last-Event-ID gives reliable replay-on-reconnect that
    we'd otherwise hand-roll on top of WS.

Both transports stay live during the migration; phase B picks one to keep.

API:
    register_with(server_broadcast_fn):
        Wire this module's `handle_event` into the relay's existing
        broadcast pipeline. Called once at startup.

    subscribe(scope) -> Queue:
        Get an asyncio.Queue that yields every matching event.
        Caller MUST also call `unsubscribe(scope, queue)` on disconnect.

    sse_stream(request, scope) -> AsyncIterator[bytes]:
        Convenience generator for FastAPI's StreamingResponse. Handles
        the queue lifecycle, heartbeats, and graceful shutdown.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import AsyncIterator, Awaitable, Callable

from fastapi import Request

from db.repo import insert_event

log = logging.getLogger("of-relay.events")

# Maximum queued events per subscriber. Tuned for "bursty inbound + slow
# browser" — at 256, a 100 events/sec spike rides through without drops,
# but a wedged tab (laptop sleeping) gets evicted within seconds rather
# than ballooning memory.
_QUEUE_MAX = 256

# Heartbeat interval. SSE clients reconnect on TCP idle ≥ ~60 s on most
# proxies; we send a comment line every 25 s to keep the pipe warm.
_HEARTBEAT_S = 25

# Subscriber registry: scope → set of queues.
_subs: dict[str, set[asyncio.Queue]] = {}
_subs_lock = asyncio.Lock()


# ── Subscriber lifecycle ─────────────────────────────────────────────

async def subscribe(scope: str) -> asyncio.Queue:
    """Return a fresh queue subscribed to `scope`. Caller MUST unsubscribe.

    Scope grammar:
      • "all"               — every event
      • "model:<account_id>" — events tagged with that __account_id

    Unknown scopes are accepted (registered but never matched), so the
    browser doesn't 500 on a typo — it just sees no traffic and reconnects.
    """
    q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)
    async with _subs_lock:
        _subs.setdefault(scope, set()).add(q)
    return q


async def unsubscribe(scope: str, q: asyncio.Queue) -> None:
    async with _subs_lock:
        bucket = _subs.get(scope)
        if bucket:
            bucket.discard(q)
            if not bucket:
                _subs.pop(scope, None)


def subscriber_count(scope: str | None = None) -> int:
    """For health / debug. Not async — reads are safe without the lock."""
    if scope is None:
        return sum(len(qs) for qs in _subs.values())
    return len(_subs.get(scope, set()))


# ── Event ingest ────────────────────────────────────────────────────

async def handle_event(event: dict) -> None:
    """Called by server.py's `_broadcast_event` for every OF event.

    Responsibilities:
      1. Persist to event_inbox (async fire-and-forget — never blocks the
         WS pump on a slow SQL write).
      2. Push to every matching subscriber queue.

    The event dict carries the relay's `__account_id` / `__account_name`
    /  `__account_color` sentinel keys plus the OF-native top-level event
    name(s). We strip `__`-prefixed keys before persisting (they're our
    metadata, not OF's), but they stay in the SSE payload so the browser
    knows which model an event belongs to.
    """
    account_id = event.get("__account_id") if isinstance(event, dict) else None
    # Pick the first non-sentinel key as the event_type (OF puts the type
    # at the top level — e.g. `{"newMessage": {...}}`).
    event_type = _first_real_key(event)

    # Strip sentinels for the persisted payload — it's already inferable
    # from `account_id`, no need to duplicate.
    persistable = {k: v for k, v in event.items() if not k.startswith("__")} if isinstance(event, dict) else {}

    # Persist async — never await on this path so a slow DB can't stall
    # the WS pump. The task is awaitable internally; we just don't.
    asyncio.create_task(_persist_event_safe(
        account_id=account_id,
        event_type=event_type or "unknown",
        payload=persistable,
    ))

    # Transcode to canonical tables (messages / fans / chats / transactions)
    # for recognized event types. Also fire-and-forget — transcoder failures
    # never block the inbox write or subscriber fan-out.
    from event_transcoder import transcode as _transcode  # local import to avoid cycles
    asyncio.create_task(_transcode(event))

    # Fan out to subscribers — scope "all" + scope-by-account.
    targets: list[asyncio.Queue] = []
    async with _subs_lock:
        targets.extend(_subs.get("all", set()))
        if account_id:
            targets.extend(_subs.get(f"model:{account_id}", set()))

    for q in targets:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            # Drop oldest, push new — slow tab loses history, not freshness.
            with _suppress_queue_empty(q):
                q.get_nowait()
            try:
                q.put_nowait(event)
            except Exception:
                # Truly dead — let the SSE generator notice on its next get().
                pass


async def _persist_event_safe(
    *, account_id: str | None, event_type: str, payload: dict,
) -> None:
    """Wraps insert_event so a bad payload can't take down the broadcaster."""
    try:
        # OF events sometimes carry an `id` field at top level — use it as
        # the dedup key when present so re-deliveries (reconnect replays)
        # don't double-write.
        provider_id = None
        if isinstance(payload, dict):
            for k in ("id", "messageId", "eventId"):
                v = payload.get(k)
                if v is not None:
                    provider_id = f"{event_type}:{v}"
                    break
        await insert_event(
            account_id=account_id,
            source="of_ws",
            event_type=event_type,
            payload=payload,
            provider_event_id=provider_id,
        )
    except Exception:
        log.exception("persist_event_safe failed (type=%s)", event_type)


def _first_real_key(event: dict | object) -> str | None:
    """Pick the first top-level key that isn't a `__`-prefixed sentinel."""
    if not isinstance(event, dict):
        return None
    for k in event:
        if not k.startswith("__"):
            return k
    return None


class _suppress_queue_empty:
    """Context manager: swallow asyncio.QueueEmpty. Tiny helper to keep
    the producer side branch-free."""
    def __init__(self, q: asyncio.Queue):
        self.q = q
    def __enter__(self): return self
    def __exit__(self, exc_type, exc, tb):
        return exc_type is asyncio.QueueEmpty


# ── SSE generator (FastAPI StreamingResponse body) ──────────────────

async def sse_stream(request: Request, scope: str) -> AsyncIterator[bytes]:
    """Yield SSE-formatted bytes for one subscriber. Handles:
      • Initial `: connected` comment so the browser's onopen fires.
      • Heartbeat comments every _HEARTBEAT_S seconds.
      • JSON-encoded events with `event:` line set to the OF event type.
      • Last-Event-ID resumption: if the client sends that header, we
        push event_inbox rows that came after that id before live ones
        (phase B; phase A skips this branch and starts from "now").
      • Graceful unsubscribe when the client disconnects.

    SSE wire format (one frame):
        id: <event_inbox.id>\\n
        event: <event_type>\\n
        data: <json>\\n
        \\n
    """
    q = await subscribe(scope)
    try:
        yield b": connected\n\n"
        last_beat = time.monotonic()
        while True:
            if await request.is_disconnected():
                return
            try:
                event = await asyncio.wait_for(q.get(), timeout=1.0)
            except asyncio.TimeoutError:
                if time.monotonic() - last_beat >= _HEARTBEAT_S:
                    yield b": ping\n\n"
                    last_beat = time.monotonic()
                continue

            event_type = _first_real_key(event) or "event"
            # SSE spec: each line is "key: value\n"; frame ends with "\n\n".
            # We never use the `id:` line yet — that's wired in phase B
            # alongside Last-Event-ID replay.
            try:
                data = json.dumps(event, default=str)
            except Exception:
                data = json.dumps({"error": "serialize_failed", "type": event_type})
            yield f"event: {event_type}\ndata: {data}\n\n".encode("utf-8")
            last_beat = time.monotonic()
    finally:
        await unsubscribe(scope, q)


# ── Hook installation ───────────────────────────────────────────────

def register_with(
    install: Callable[[Callable[[dict], Awaitable[None]]], None],
) -> None:
    """Called once at startup. Hands `handle_event` to the caller's
    install hook so the relay's existing `_broadcast_event` can fan
    events into us in addition to the legacy WS subscribers.

    Decoupled like this so this module has zero imports from server.py
    — server.py wires the connection at startup.
    """
    install(handle_event)
