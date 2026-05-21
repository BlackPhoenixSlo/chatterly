#!/usr/bin/env python3
"""
Capture every /api2/v2/* XHR fired by:

  https://onlyfans.com/my/settings/messaging
  https://onlyfans.com/my/settings/subscription/promotion-campaign

These pages drive: welcome-message templates, auto-reply settings,
promotion campaigns CRUD, trial links, mass-message defaults, etc.
We log everything (including POST/PUT/PATCH/DELETE bodies) to JSONL so
new endpoints can be wrapped in of_client.py.

Output:
  service/sessions/settings_capture/<ts>/{xhr.jsonl, summary.txt, *.png}
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from connect_incogniton import get_cdp_endpoint, PROFILE_ID  # noqa: E402

OUT_BASE = Path(__file__).resolve().parent / "sessions" / "settings_capture"

TARGETS = [
    ("messaging", "https://onlyfans.com/my/settings/messaging"),
    ("promotion-campaign", "https://onlyfans.com/my/settings/subscription/promotion-campaign"),
    # also the broader settings/subscription page often pre-loads campaign data
    ("subscription", "https://onlyfans.com/my/settings/subscription"),
    ("messaging-welcome", "https://onlyfans.com/my/settings/messaging/welcome-message"),
    ("messaging-mass", "https://onlyfans.com/my/settings/messaging/mass-messaging"),
]


def main() -> None:
    ws = get_cdp_endpoint(PROFILE_ID)
    print(f"[*] CDP: {ws}")

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = OUT_BASE / ts
    out_dir.mkdir(parents=True, exist_ok=True)
    log = (out_dir / "xhr.jsonl").open("w")
    seen: dict[tuple[str, str], int] = {}
    print(f"[*] Output → {out_dir}")

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws)
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()

        def on_request(req):
            try:
                if "onlyfans.com/api2/v2" not in req.url:
                    return
                u = urlparse(req.url)
                key = (req.method, u.path)
                seen[key] = seen.get(key, 0) + 1
                entry = {
                    "ts": time.time(),
                    "method": req.method,
                    "url": req.url,
                    "path": u.path,
                    "query": u.query,
                    "body": req.post_data,
                }
                log.write(json.dumps(entry) + "\n")
                log.flush()
                marker = "★" if req.method != "GET" else " "
                body_preview = ""
                if req.post_data and len(req.post_data) < 280:
                    body_preview = f"  body={req.post_data}"
                elif req.post_data:
                    body_preview = f"  body=<{len(req.post_data)}B>"
                print(f"{marker} {req.method:6s} {u.path}?{u.query[:80]}{body_preview}")
            except Exception as e:
                print(f"[!] capture err: {e}")

        ctx.on("request", on_request)

        page = ctx.new_page()
        for label, url in TARGETS:
            print(f"\n[*] {label}: {url}")
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=25_000)
                # Let lazy chunks + secondary XHRs settle
                page.wait_for_timeout(4500)
            except PWTimeout:
                print(f"   [!] timeout on {url}")
            except Exception as e:
                print(f"   [!] nav error: {e}")
            try:
                page.screenshot(path=str(out_dir / f"{label}.png"))
            except Exception:
                pass

        print(f"\n[*] Done. Unique (method, path) pairs: {len(seen)}")
        with (out_dir / "summary.txt").open("w") as f:
            f.write("METHOD  COUNT  PATH\n")
            for (m, p_), n in sorted(seen.items(), key=lambda kv: (-kv[1], kv[0][1])):
                f.write(f"  {m:6s} {n:4d}  {p_}\n")
        print(f"    Summary: {out_dir / 'summary.txt'}")
        log.close()


if __name__ == "__main__":
    main()
