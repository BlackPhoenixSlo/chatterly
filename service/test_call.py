#!/usr/bin/env python3
"""
Step 3: Live end-to-end verification of signed OF API calls from Python.

Uses the latest session (must be signing-complete — run extract_rules.py first)
and exercises three endpoints in order, each a stronger validation:

  1. GET /users/me         — proves Sign/Time/User-ID/X-BC/X-Hash all match
  2. GET /chats?limit=5    — proves cookie auth still works (returns user data)
  3. GET /chats/{id}/messages — the actual target endpoint

Each call's outcome is printed independently — if step 1 401s but step 2 works
that would tell us something specific. Stops on the first non-200 with details.

Run with whichever venv has curl_cffi installed, e.g.:
  ./venv/bin/python service/test_call.py
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from of_client import OFClient, OFAPIError  # noqa: E402


def _dump_http_error(label: str, exc: OFAPIError) -> None:
    r = exc.response
    print(f"[!] {label} failed: HTTP {r.status_code}")
    print(f"    URL: {r.url}")
    print(f"    Body (first 800 chars):")
    print("    " + r.text[:800].replace("\n", "\n    "))
    # curl_cffi exposes the sent headers under r.request.headers like requests does
    sent = getattr(r, "request", None)
    if sent and getattr(sent, "headers", None):
        print(f"    Request headers sent:")
        for k, v in sent.headers.items():
            if k.lower() == "cookie":
                print(f"      {k}: [{len(v)} chars]")
            else:
                print(f"      {k}: {v}")


def main() -> int:
    print("[*] Loading latest captured session...")
    client = OFClient.from_latest_session()
    print(f"    user_id={client.user_id}  x_of_rev={client.x_of_rev}")

    # ── 1. /users/me ────────────────────────────────────────────
    print()
    print("[1] GET /api2/v2/users/me")
    try:
        me = client.me()
    except OFAPIError as e:
        _dump_http_error("/users/me", e)
        return 1
    name = me.get("name") or me.get("username") or me.get("email") or "?"
    print(f"    ok — id={me.get('id')} name={name!r}")

    # ── 2. /chats ───────────────────────────────────────────────
    print()
    print("[2] GET /api2/v2/chats?limit=5&order=recent")
    try:
        chats = client.list_chats(limit=5)
    except OFAPIError as e:
        _dump_http_error("/chats", e)
        return 2
    chat_list = chats.get("list") or []
    print(f"    ok — {len(chat_list)} chats returned, hasMore={chats.get('hasMore')}")
    # In OF, the "chat id" used in /chats/{id}/messages is the *other* user's id
    # (withUser.id). There is no top-level chat id on /chats list items.
    for c in chat_list[:5]:
        with_user_id = (c.get("withUser") or {}).get("id")
        last_msg = (c.get("lastMessage") or {}).get("text") or "(no text)"
        print(f"      withUser.id={with_user_id}  unread={c.get('unreadMessagesCount')}  "
              f"last={last_msg[:70]!r}")

    if not chat_list:
        print("    (no chats to test /messages against — stop here)")
        return 0

    # ── 3. /chats/{id}/messages ─────────────────────────────────
    chat_id = chat_list[0]["withUser"]["id"]
    print()
    print(f"[3] GET /api2/v2/chats/{chat_id}/messages?limit=5&order=desc")
    try:
        msgs = client.get_messages(chat_id, limit=5)
    except OFAPIError as e:
        _dump_http_error("/messages", e)
        return 3
    msg_list = msgs.get("list") or []
    print(f"    ok — {len(msg_list)} messages, hasMore={msgs.get('hasMore')}")
    for m in msg_list:
        text = (m.get("text") or "").replace("\n", " ")
        print(f"      msg id={m.get('id')}  from={m.get('fromUser',{}).get('id','?')}  "
              f"text={text[:80]!r}")

    print()
    print("[*] All three calls succeeded — server-side signing is working.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
