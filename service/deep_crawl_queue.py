#!/usr/bin/env python3
"""
Deep XHR crawl across every OF "Queue / Post / Schedule" page + UI interaction.

Run while logged in to OF in Incogniton. Output JSONL of every captured
/api2/v2/* request (POST/PUT/PATCH/DELETE highlighted), plus a screenshot
per page so we can correlate the click → network call.

What it walks:
  * /my/queue (today)  +  per-day around today (counters drive the calendar)
  * /my/queue/{date} for the next 14 days
  * /my/posts (drafts, scheduled, archived, all)
  * /my/streams (reminder / past streams)
  * /my/schedules (creator-side schedules)
  * /my/stats/posts, /my/stats/earnings, /my/stats/reach, /my/stats/fans
  * /my/chats/scheduled  +  /my/chats/sent
  * dialog interactions: open compose, pick datetime picker, etc.

Run:
  ./venv/bin/python service/deep_crawl_queue.py

Output:
  service/sessions/crawl/queue/<ts>/xhr.jsonl
  service/sessions/crawl/queue/<ts>/<step>.png
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from connect_incogniton import get_cdp_endpoint, PROFILE_ID  # noqa: E402

OUT_BASE = Path(__file__).resolve().parent / "sessions" / "crawl" / "queue"

# Per-URL highlight rules: if the URL matches one of these substrings, the
# console line is starred and we also stash the body for later replay/probing.
INTERESTING = (
    "schedule", "queue", "later", "counters",
    "stream", "post", "promo", "trial", "tip",
    "stats-collect", "clicks-stats",  # telemetry, but harmless to see
    "media/upload", "media/files", "vault/media",
    "tracking", "links", "voting", "poll", "story", "campaign",
    "settings", "track-event", "events",
)


def main() -> None:
    ws = get_cdp_endpoint(PROFILE_ID)
    print(f"[*] CDP: {ws}")

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = OUT_BASE / ts
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / "xhr.jsonl"
    log = log_path.open("w")
    print(f"[*] Writing → {log_path}")

    seen_paths: set[tuple[str, str]] = set()   # (method, path) — dedupe console
    counter = {"n": 0, "interesting": 0, "writes": 0}

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws)
        context = browser.contexts[0] if browser.contexts else browser.new_context()

        def on_request(req):
            try:
                if "onlyfans.com/api2/v2" not in req.url:
                    return
                method = req.method
                u = urlparse(req.url)
                path = u.path
                entry = {
                    "ts": time.time(),
                    "method": method,
                    "url": req.url,
                    "path": path,
                    "query": u.query,
                    "body": req.post_data,
                }
                log.write(json.dumps(entry) + "\n")
                log.flush()
                counter["n"] += 1
                hit_writes = method in ("POST", "PUT", "PATCH", "DELETE")
                hit_interesting = any(k in path.lower() for k in INTERESTING)
                if hit_writes:
                    counter["writes"] += 1
                if hit_interesting:
                    counter["interesting"] += 1
                # Console: dedupe (method, path) so the log stays readable;
                # but always show writes (each can have different body).
                key = (method, path)
                if hit_writes or key not in seen_paths:
                    seen_paths.add(key)
                    marker = "★" if hit_interesting else (" " if not hit_writes else "·")
                    body_preview = ""
                    if req.post_data and len(req.post_data) < 200:
                        body_preview = f"  body={req.post_data}"
                    print(f"{marker} {method:6s} {path}?{u.query[:100]}{body_preview}")
            except Exception as e:
                print(f"[!] capture err: {e}")

        context.on("request", on_request)

        page = context.new_page()

        # Build the target list: each entry = (label, url, post_actions_callable)
        today = datetime.now().date()
        next_14_days = [today + timedelta(days=i) for i in range(15)]

        def visit(url: str, label: str, *, wait_ms: int = 3000, retries: int = 2) -> None:
            print(f"\n[*] {label}: {url}")
            last_err = None
            for attempt in range(retries + 1):
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=25_000)
                    page.wait_for_timeout(wait_ms)
                    last_err = None
                    break
                except PWTimeout as e:
                    last_err = f"timeout: {e}"
                except Exception as e:
                    last_err = f"nav error: {e}"
                # Brief pause before retry (network blip / CDP reconnect)
                page.wait_for_timeout(2000)
                if attempt < retries:
                    print(f"  [retry {attempt+1}/{retries}] {last_err.splitlines()[0][:120]}")
            if last_err:
                print(f"[!] giving up on {url}: {last_err.splitlines()[0][:120]}")
                return
            try:
                fname = label.replace("/", "_").replace(" ", "_") + ".png"
                page.screenshot(path=str(out_dir / fname))
            except Exception:
                pass

        # === Queue / Scheduling pages ===
        visit("https://onlyfans.com/my/queue", "queue_today")
        for d in next_14_days[1:]:
            visit(f"https://onlyfans.com/my/queue/{d.isoformat()}", f"queue_{d.isoformat()}", wait_ms=1500)

        # === Streams ===
        visit("https://onlyfans.com/my/streams", "streams")
        visit("https://onlyfans.com/my/streams/reminder", "streams_reminder")

        # === Posts (all sub-tabs) ===
        for sub in ["", "archived", "tagged", "free", "scheduled", "drafts"]:
            visit(f"https://onlyfans.com/my{('/' + sub) if sub else ''}", f"posts_{sub or 'feed'}", wait_ms=2500)

        # === Statistics tabs (every Chart endpoint) ===
        for sub in ["earnings", "posts", "fans", "reach", "engagement", "subscriptions", "chargebacks"]:
            visit(f"https://onlyfans.com/my/stats/{sub}", f"stats_{sub}", wait_ms=2500)

        # === Chats (compose drawer for scheduling) ===
        visit("https://onlyfans.com/my/chats", "chats_inbox")
        visit("https://onlyfans.com/my/chats/chat/3266586/", "chats_chat_3266586", wait_ms=2500)

        # Click around the compose area to trigger the schedule picker XHRs
        try:
            # Many compose toolbars carry icons with aria-label = "Schedule"
            for sel in [
                'button[aria-label*="Schedule" i]',
                'button[aria-label*="time" i]',
                'button[title*="Schedule" i]',
                'button:has-text("Schedule")',
            ]:
                btn = page.locator(sel).first
                if btn.count():
                    print(f"[*] clicking compose schedule: {sel}")
                    try:
                        btn.click(timeout=2000)
                        page.wait_for_timeout(1500)
                        page.screenshot(path=str(out_dir / "compose_schedule_modal.png"))
                        # Try to dismiss
                        for kbd in ["Escape"]:
                            page.keyboard.press(kbd)
                        break
                    except Exception as e:
                        print(f"  click failed: {e}")
        except Exception as e:
            print(f"[!] compose click attempt failed: {e}")

        # === Promotions / trials writes (the GET side; write XHRs come when user clicks "create") ===
        visit("https://onlyfans.com/my/promotions", "promotions")
        visit("https://onlyfans.com/my/promotions/trial", "promotions_trial")
        visit("https://onlyfans.com/my/promotions/campaigns", "promotions_campaigns")

        # === Notifications / settings (write subscription pings) ===
        visit("https://onlyfans.com/my/notifications", "notifications")
        visit("https://onlyfans.com/my/settings/notifications", "settings_notifications", wait_ms=4000)

        # === Vault sub-tabs ===
        for sub in ["", "lists", "media/photos", "media/videos", "media/audios", "media/gifs"]:
            visit(f"https://onlyfans.com/my/vault{('/' + sub) if sub else ''}", f"vault_{sub or 'all'}", wait_ms=2000)

        # === Statements (financial) ===
        for sub in ["", "all", "payouts", "payout-requests", "earning-statistics"]:
            visit(f"https://onlyfans.com/my/statements{('/' + sub) if sub else ''}", f"stmts_{sub or 'all'}", wait_ms=2500)

        # === Fans / Lists pages ===
        for sub in ["active", "expired", "all", "muted", "attention", "recent"]:
            visit(f"https://onlyfans.com/my/fans/{sub}", f"fans_{sub}", wait_ms=2000)
        visit("https://onlyfans.com/my/lists", "lists", wait_ms=2000)

        # === Wrap up ===
        print(f"\n[*] Done. {counter['n']} total XHRs, {counter['writes']} writes, {counter['interesting']} interesting.")
        print(f"    Log: {log_path}")

        # Quick summary: unique (method, path) pairs sorted alphabetically
        summary_path = out_dir / "summary.txt"
        with summary_path.open("w") as f:
            f.write(f"Crawl @ {ts}\n")
            f.write(f"Total XHRs: {counter['n']}  writes: {counter['writes']}  interesting: {counter['interesting']}\n\n")
            f.write("Unique (method, path) pairs:\n")
            for m, p_ in sorted(seen_paths):
                f.write(f"  {m:6s} {p_}\n")
        print(f"    Summary: {summary_path}")

        log.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[!] Interrupted")
        sys.exit(130)
