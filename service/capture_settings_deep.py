#!/usr/bin/env python3
"""
Deep capture of write endpoints across OF's settings pages.

User explicitly OK'd modifying bio + nickname to surface those PUTs.
Now that the account is in PAID mode (per user), promo campaign + tracking
links + trial links should ALSO fire their CRUD.

For each page we:
  1. Visit and let GETs land
  2. Try the obvious interactive widget (Edit / Create / +) — wait, capture
  3. If a form opens, type a small benign change + Save — capture the PUT
  4. Screenshot each step
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

OUT = Path(__file__).resolve().parent / "sessions" / "settings_capture"


# (label, url, list of (selector, kind)) where kind=visit|click|type
PAGES = [
    ("profile", "https://onlyfans.com/my/settings/profile", [
        # We'll do the bio toggle separately below to avoid clobbering everything
    ]),
    ("fans", "https://onlyfans.com/my/settings/fans", [
        ('button:has-text("Edit"), label[for*="checkbox" i]', "click"),
    ]),
    ("messaging", "https://onlyfans.com/my/settings/messaging", []),
    ("messaging-welcome", "https://onlyfans.com/my/settings/messaging/welcome-message", [
        ('button:has-text("Edit")', "click"),
        ('button:has-text("Save")', "click"),
    ]),
    ("tracking-links", "https://onlyfans.com/my/settings/subscription/tracking-links", [
        ('button:has-text("Create")', "click"),
        ('button:has-text("Cancel")', "click"),  # back out — we just want the GET for the modal
    ]),
    ("trial-links", "https://onlyfans.com/my/settings/subscription/trial-links", [
        ('button:has-text("Create")', "click"),
        ('button:has-text("Cancel")', "click"),
    ]),
    ("promotion-campaign", "https://onlyfans.com/my/settings/subscription/promotion-campaign", [
        ('button:has-text("Start"), button:has-text("Create"), button:has-text("New")', "click"),
        ('button:has-text("Cancel"), button:has-text("Close")', "click"),
    ]),
]


def main():
    ws_ep = get_cdp_endpoint(PROFILE_ID)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = OUT / f"{ts}_deep"
    out_dir.mkdir(parents=True, exist_ok=True)
    log = (out_dir / "xhr.jsonl").open("w")
    bodies_dir = out_dir / "bodies"
    bodies_dir.mkdir(exist_ok=True)
    seen: dict = {}
    body_n = [0]

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws_ep)
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()

        def on_req(req):
            if "onlyfans.com/api2/v2" not in req.url:
                return
            u = urlparse(req.url)
            seen.setdefault((req.method, u.path), 0)
            seen[(req.method, u.path)] += 1
            entry = {"phase": "req", "ts": time.time(), "method": req.method,
                     "url": req.url, "path": u.path, "query": u.query,
                     "body": req.post_data}
            log.write(json.dumps(entry) + "\n"); log.flush()
            mark = "★" if req.method != "GET" else " "
            body = ""
            if req.post_data:
                body = f"  body={req.post_data[:280]}" if len(req.post_data) < 320 else f"  body=<{len(req.post_data)}B>"
            print(f"{mark} {req.method:6s} {u.path}{body}")

        def on_res(resp):
            if "onlyfans.com/api2/v2" not in resp.url:
                return
            u = urlparse(resp.url)
            # Save the response body for writes + any new GET we haven't seen
            try:
                if resp.request.method != "GET" or seen.get((resp.request.method, u.path), 0) <= 2:
                    body = resp.body().decode("utf-8", errors="replace")
                    if body and body_n[0] < 60:
                        fn = bodies_dir / f"{body_n[0]:03d}_{resp.request.method}_{u.path.strip('/').replace('/', '_')[:80]}.json"
                        fn.write_text(json.dumps({
                            "url": resp.url, "status": resp.status,
                            "request_body": resp.request.post_data,
                            "response_body": body[:5000],
                        }, indent=2))
                        body_n[0] += 1
            except Exception:
                pass

        ctx.on("request", on_req)
        ctx.on("response", on_res)

        page = ctx.new_page()

        # ── PROFILE: explicit bio + nickname round-trip ──
        # User OK'd modifying bio/nickname so we can see the actual PUTs.
        print("\n[*] profile :: https://onlyfans.com/my/settings/profile")
        try:
            page.goto("https://onlyfans.com/my/settings/profile",
                      wait_until="domcontentloaded", timeout=25_000)
            page.wait_for_timeout(4500)
            page.screenshot(path=str(out_dir / "profile_loaded.png"))

            # Find a bio textarea or input. OF uses contenteditable in many places.
            for selector_kind in [
                ('textarea[name="about"]', "textarea"),
                ('textarea[placeholder*="bio" i]', "textarea"),
                ('input[name="name"]', "input"),
                ('input[placeholder*="name" i]', "input"),
            ]:
                sel, kind = selector_kind
                try:
                    el = page.locator(sel).first
                    if not el.count(): continue
                    cur = el.input_value() if kind == "input" else el.input_value()
                    # Append a sentinel + immediately remove (round-trip)
                    sentinel = " [api-probe]"
                    new = (cur or "") + sentinel
                    el.fill(new)
                    page.wait_for_timeout(800)
                    # Tab away to trigger any auto-save / validate
                    el.press("Tab")
                    page.wait_for_timeout(1500)
                    # Now revert
                    el.fill(cur or "")
                    el.press("Tab")
                    page.wait_for_timeout(1500)
                    # Look for a Save button
                    save = page.locator('button:has-text("Save")').first
                    if save.count():
                        save.click(timeout=2500)
                        page.wait_for_timeout(2000)
                    page.screenshot(path=str(out_dir / f"profile_{kind}_saved.png"))
                    print(f"  [probed] {sel}")
                except Exception as e:
                    print(f"  [skip] {sel}: {str(e).splitlines()[0][:80]}")
        except Exception as e:
            print(f"  [!] {e}")

        # ── REMAINING PAGES ──
        for label, url, actions in PAGES:
            if label == "profile": continue   # already done above
            print(f"\n[*] {label} :: {url}")
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=25_000)
                page.wait_for_timeout(3500)
                page.screenshot(path=str(out_dir / f"{label}_loaded.png"))
            except Exception as e:
                print(f"  [!] nav: {e}")
                continue

            for sel, _kind in actions:
                try:
                    el = page.locator(sel).first
                    if not el.count(): continue
                    txt = (el.text_content() or "").strip()[:30]
                    print(f"  clicking {sel} '{txt}'")
                    el.click(timeout=2500)
                    page.wait_for_timeout(2500)
                except Exception as e:
                    print(f"  [skip] {sel}: {str(e).splitlines()[0][:80]}")

        # Summary
        with (out_dir / "summary.txt").open("w") as f:
            f.write("METHOD  COUNT  PATH\n")
            for (m, p_), n in sorted(seen.items(), key=lambda kv: (-kv[1], kv[0][1])):
                f.write(f"  {m:6s} {n:4d}  {p_}\n")
        print(f"\n[*] {len(seen)} unique pairs → {out_dir / 'summary.txt'}")
        # Print writes specifically
        writes = [(m, p_, n) for (m, p_), n in seen.items() if m != "GET"]
        if writes:
            print("[*] WRITES captured:")
            for m, p_, n in writes:
                print(f"    {m:6s} {n:3d}  {p_}")
        log.close()


if __name__ == "__main__":
    main()
