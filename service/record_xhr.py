#!/usr/bin/env python3
"""
Connect to Incogniton, navigate selected OF pages, log every XHR.

Use to discover real OF API paths for actions whose paths we don't know
(e.g. fan note, custom name). Run, look at the captured log, find the
matching call, copy its URL/method into of_client.py.

Run:
  ./venv/bin/python service/record_xhr.py

Output: service/sessions/xhr_<ts>.log (one request per line, JSON).
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from connect_incogniton import get_cdp_endpoint, PROFILE_ID  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent / "sessions"


def main() -> None:
    ws = get_cdp_endpoint(PROFILE_ID)
    print(f"[*] CDP: {ws}")

    OUT_DIR.mkdir(exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log_path = OUT_DIR / f"xhr_{ts}.jsonl"
    log = log_path.open("w")
    print(f"[*] Writing to {log_path}")

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws)
        context = browser.contexts[0] if browser.contexts else browser.new_context()

        # Log every request matching the OF API host
        def on_request(req):
            try:
                if "onlyfans.com/api2/v2" not in req.url:
                    return
                entry = {
                    "ts": time.time(),
                    "method": req.method,
                    "url": req.url,
                    "headers": {k: v for k, v in req.headers.items() if k.lower() not in ("cookie", "sign", "x-bc", "x-hash", "user-id")},
                    "body": req.post_data,
                }
                line = json.dumps(entry)
                log.write(line + "\n")
                log.flush()
                # Highlight interesting ones to stdout
                interesting = any(k in req.url.lower() for k in ["note", "notic", "custom", "name", "nick", "label"])
                if req.method in ("POST", "PUT", "PATCH", "DELETE") or interesting:
                    marker = "★" if interesting else " "
                    print(f"{marker} {req.method:6s} {req.url}")
            except Exception as e:
                print(f"[!] capture err: {e}")

        context.on("request", on_request)

        page = context.new_page()

        # Target pages — adjust here to capture different action paths
        targets = [
            "https://onlyfans.com/my/chats/",
            "https://onlyfans.com/my/chats/chat/117183/",
            "https://onlyfans.com/my/fans/active",
            "https://onlyfans.com/my/fans/expired",
            "https://onlyfans.com/my/lists",
            "https://onlyfans.com/my/vault",
            "https://onlyfans.com/my/statements",
            "https://onlyfans.com/my/promotions",
            "https://onlyfans.com/my/queue",
        ]

        for url in targets:
            print(f"\n[*] Visiting {url}")
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=20_000)
                # Hang around a bit so SPA tabs fire their secondary XHRs
                page.wait_for_timeout(2500)
            except PWTimeout:
                print(f"[!] timed out on {url}")
            except Exception as e:
                print(f"[!] nav error on {url}: {e}")

        print(f"\n[*] Done. Captured XHRs: {log_path}")
        log.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[!] Interrupted")
        sys.exit(130)
