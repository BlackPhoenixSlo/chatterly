#!/usr/bin/env python3
"""
Capture the WRITE endpoints by clicking around settings pages.
The plain capture script only got GETs; the POST/PUT/DELETE paths only fire
when the user submits forms.

Strategy: visit each settings page, find buttons with obvious labels
(Edit / Save / Create / Delete) and click them. We don't fill forms — we
just want to see the network calls each interaction triggers.
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

OUT_BASE = Path(__file__).resolve().parent / "sessions" / "settings_capture"

PAGES = [
    ("messaging-welcome", "https://onlyfans.com/my/settings/messaging/welcome-message",
     ['button:has-text("Edit")', 'button:has-text("Cancel")', 'button:has-text("Save")']),
    ("promotion-campaign", "https://onlyfans.com/my/settings/subscription/promotion-campaign",
     ['button:has-text("Create")', 'button:has-text("New")', 'button:has-text("Edit")', 'button:has-text("Add")']),
    ("subscription", "https://onlyfans.com/my/settings/subscription",
     ['button:has-text("Edit")', 'button:has-text("Manage")', 'button:has-text("Promotion")']),
    ("mass-messaging", "https://onlyfans.com/my/settings/messaging/mass-messaging",
     ['button:has-text("Edit")', 'button:has-text("New")']),
]

# Pages we KNOW exist for promo CRUD — visit so the SPA loads its full chunk
EXTRA_VISITS = [
    "https://onlyfans.com/my/settings/subscription/free-trial",
    "https://onlyfans.com/my/settings/subscription/bundles",
    "https://onlyfans.com/my/settings/messaging/saved-replies",
]


def main():
    ws_ep = get_cdp_endpoint(PROFILE_ID)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = OUT_BASE / f"{ts}_clicks"
    out_dir.mkdir(parents=True, exist_ok=True)
    log = (out_dir / "xhr.jsonl").open("w")
    seen: dict = {}

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws_ep)
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()

        def on_req(req):
            if "onlyfans.com/api2/v2" not in req.url:
                return
            u = urlparse(req.url)
            seen.setdefault((req.method, u.path), 0)
            seen[(req.method, u.path)] += 1
            entry = {"ts": time.time(), "method": req.method, "url": req.url,
                     "path": u.path, "query": u.query, "body": req.post_data}
            log.write(json.dumps(entry) + "\n"); log.flush()
            mark = "★" if req.method != "GET" else " "
            body = ""
            if req.post_data:
                body = f"  body={req.post_data[:200]}" if len(req.post_data) < 300 else f"  body=<{len(req.post_data)}B>"
            print(f"{mark} {req.method:6s} {u.path}{body}")
        ctx.on("request", on_req)

        page = ctx.new_page()

        for label, url, selectors in PAGES:
            print(f"\n[*] {label} :: {url}")
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=25_000)
                page.wait_for_timeout(3500)
                page.screenshot(path=str(out_dir / f"{label}_loaded.png"))
            except Exception as e:
                print(f"  [!] nav: {e}")
                continue

            for sel in selectors:
                try:
                    el = page.locator(sel).first
                    if not el.count(): continue
                    txt = (el.text_content() or "").strip()[:30]
                    print(f"  clicking {sel} '{txt}'")
                    el.click(timeout=2000)
                    page.wait_for_timeout(2500)
                    page.screenshot(path=str(out_dir / f"{label}_{sel[20:40].replace(':','_')}.png"))
                    # Dismiss any modal that may have opened
                    try: page.keyboard.press("Escape")
                    except Exception: pass
                    page.wait_for_timeout(500)
                except Exception as e:
                    err = str(e).splitlines()[0][:80]
                    print(f"  [skip] {sel}: {err}")

        for url in EXTRA_VISITS:
            print(f"\n[*] extra visit :: {url}")
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=25_000)
                page.wait_for_timeout(3000)
            except Exception as e:
                print(f"  [!] {e}")

        with (out_dir / "summary.txt").open("w") as f:
            f.write("METHOD  COUNT  PATH\n")
            for (m, p_), n in sorted(seen.items(), key=lambda kv: (-kv[1], kv[0][1])):
                f.write(f"  {m:6s} {n:4d}  {p_}\n")
        print(f"\n[*] {len(seen)} unique (method,path) pairs → {out_dir / 'summary.txt'}")
        log.close()


if __name__ == "__main__":
    main()
