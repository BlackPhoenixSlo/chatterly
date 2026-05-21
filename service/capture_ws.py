#!/usr/bin/env python3
"""
Capture OF's WebSocket handshake + frame format.

Loads any logged-in OF page (chats), waits for the WS to open, logs every
sent + received frame to JSONL. Drives no clicks — we just want the keep-alive
heartbeat + any incidental events that arrive.

Output:
  service/sessions/ws_capture/<ts>/{frames.jsonl, console.log}
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from connect_incogniton import get_cdp_endpoint, PROFILE_ID  # noqa: E402

OUT = Path(__file__).resolve().parent / "sessions" / "ws_capture"


def main(idle_seconds: int = 60) -> None:
    ws_ep = get_cdp_endpoint(PROFILE_ID)
    print(f"[*] CDP: {ws_ep}")

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = OUT / ts
    out_dir.mkdir(parents=True, exist_ok=True)
    log = (out_dir / "frames.jsonl").open("w")

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws_ep)
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()

        def on_ws(ws):
            host = urlparse(ws.url).netloc
            print(f"\n[WS OPEN] {ws.url}")
            log.write(json.dumps({"event": "open", "ts": time.time(), "url": ws.url}) + "\n")
            log.flush()

            def on_framesent(payload):
                try:
                    payload_str = payload.decode("utf-8") if isinstance(payload, bytes) else str(payload)
                except Exception:
                    payload_str = repr(payload)
                log.write(json.dumps({"event": "send", "ts": time.time(),
                                       "host": host, "payload": payload_str[:2000]}) + "\n")
                log.flush()
                preview = payload_str[:200].replace("\n", " ")
                print(f"[WS →] {preview}")

            def on_framereceived(payload):
                try:
                    payload_str = payload.decode("utf-8") if isinstance(payload, bytes) else str(payload)
                except Exception:
                    payload_str = repr(payload)
                log.write(json.dumps({"event": "recv", "ts": time.time(),
                                       "host": host, "payload": payload_str[:2000]}) + "\n")
                log.flush()
                preview = payload_str[:200].replace("\n", " ")
                print(f"[WS ←] {preview}")

            def on_close():
                print(f"[WS CLOSE] {ws.url}")
                log.write(json.dumps({"event": "close", "ts": time.time(), "url": ws.url}) + "\n")
                log.flush()

            ws.on("framesent", on_framesent)
            ws.on("framereceived", on_framereceived)
            ws.on("close", on_close)

        ctx.on("websocket", on_ws)

        page = ctx.new_page()
        print(f"[*] Open /my/chats (triggers WS connect)")
        page.goto("https://onlyfans.com/my/chats/", wait_until="networkidle", timeout=30_000)

        print(f"[*] Idle {idle_seconds}s — observing heartbeats and any push events")
        page.wait_for_timeout(idle_seconds * 1000)

        log.close()
        print(f"\n[*] Done. Log: {out_dir / 'frames.jsonl'}")


if __name__ == "__main__":
    secs = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    main(secs)
