#!/usr/bin/env python3
"""
Step 1: Capture an OnlyFans session via Incogniton.

  1. Connect to Incogniton over CDP (reuses connect_incogniton.get_cdp_endpoint)
  2. Inject interceptor.js as a Playwright init script (hooks webpack + XHR
     BEFORE OF's own JS loads in a fresh tab)
  3. Open onlyfans.com — if not logged in, wait for auth_id cookie to appear
  4. Navigate to /my/chats to trigger signed API calls so the hooks capture
     user-id, x-bc, x-of-rev, static_param, sign start/end, and sample pairs
  5. Pull the OF chunk 2313.js (contains the obfuscated checksum expression)
  6. Dump everything to service/sessions/session_<timestamp>.json
     (and update sessions/latest.json pointer)

Run:
  python3 service/capture_session.py
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# Allow `python3 service/capture_session.py` from repo root
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from connect_incogniton import get_cdp_endpoint, PROFILE_ID  # noqa: E402

HERE = Path(__file__).resolve().parent
INTERCEPTOR_JS = (HERE / "interceptor.js").read_text(encoding="utf-8")
SESSIONS_DIR = HERE / "sessions"

OF_HOME = "https://onlyfans.com/"
OF_CHATS = "https://onlyfans.com/my/chats/"

LOGIN_POLL_INTERVAL_S = 2
LOGIN_TIMEOUT_S = 600          # 10 min — generous for 2FA / captcha
HOOK_WAIT_S = 8                # let webpack hooks accumulate samples after chats load
NETWORKIDLE_TIMEOUT_MS = 30_000


def _logged_in(context) -> tuple[bool, str | None]:
    """auth_id cookie is the canonical OF login signal (httpOnly, set on login)."""
    for c in context.cookies(["https://onlyfans.com"]):
        if c["name"] == "auth_id" and c["value"]:
            return True, c["value"]
    return False, None


def _wait_for_login(context, timeout_s: int = LOGIN_TIMEOUT_S) -> str:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        ok, uid = _logged_in(context)
        if ok:
            return uid  # type: ignore[return-value]
        time.sleep(LOGIN_POLL_INTERVAL_S)
    raise TimeoutError(f"auth_id cookie did not appear within {timeout_s}s")


def _fetch_signing_chunk(page, x_of_rev: str | None) -> tuple[str | None, str | None]:
    """Fetch chunk 2313.js (the signing module) from the page context so it
    inherits cookies/origin. Returns (url, code) or (url, None) on failure."""
    if not x_of_rev:
        return None, None
    url = f"https://static2.onlyfans.com/static/prod/f/{x_of_rev}/2313.js"
    try:
        code = page.evaluate(
            """async (u) => {
                const r = await fetch(u);
                if (!r.ok) return null;
                return await r.text();
            }""",
            url,
        )
        return url, code
    except Exception as e:
        print(f"[!] Could not fetch 2313.js: {e}")
        return url, None


def capture() -> Path:
    print(f"[*] Using profile {PROFILE_ID}")
    ws = get_cdp_endpoint(PROFILE_ID)
    print(f"[*] CDP ready: {ws}")

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws)
        context = browser.contexts[0] if browser.contexts else browser.new_context()

        # Register hooks for any subsequent new page in this context.
        # Existing tabs are untouched — we always open a fresh one below.
        context.add_init_script(INTERCEPTOR_JS)

        page = context.new_page()
        print(f"[*] Opening {OF_HOME}")
        page.goto(OF_HOME, wait_until="domcontentloaded")

        ok, uid = _logged_in(context)
        if not ok:
            print(f"[*] Not logged in. Log in (incl. 2FA) in the open Incogniton window.")
            print(f"    Polling cookies every {LOGIN_POLL_INTERVAL_S}s, up to {LOGIN_TIMEOUT_S}s.")
            uid = _wait_for_login(context)
        print(f"[*] Logged in — auth_id={uid}")

        # Hit /my/chats — many signed API calls fire here, enough samples for the hooks
        print(f"[*] Navigating to {OF_CHATS} to fire signed XHRs")
        try:
            page.goto(OF_CHATS, wait_until="networkidle", timeout=NETWORKIDLE_TIMEOUT_MS)
        except PWTimeout:
            print("[!] networkidle timed out — continuing, hooks likely already fired")

        print(f"[*] Waiting {HOOK_WAIT_S}s for webpack hooks to accumulate samples...")
        time.sleep(HOOK_WAIT_S)

        captured: dict[str, Any] = page.evaluate(
            """() => ({
                userId: window.__ofe_userId || null,
                xBc: window.__ofe_xBc || null,
                xOfRev: window.__ofe_xOfRev || null,
                lastSign: window.__ofe_lastSign || null,
                lastTime: window.__ofe_lastTime || null,
                rules: window.__ofe_extractedRules || null,
                samples: window.__ofe_signSamples || [],
                userAgent: navigator.userAgent,
                href: location.href,
            })"""
        )

        cookies = context.cookies([
            "https://onlyfans.com",
            "https://cdn2.onlyfans.com",
            "https://static2.onlyfans.com",
        ])
        local_storage = page.evaluate(
            "() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))"
        )

        chunk_url, chunk_code = _fetch_signing_chunk(page, captured.get("xOfRev"))
        if chunk_code:
            print(f"[*] Fetched 2313.js ({len(chunk_code)} bytes)")

        SESSIONS_DIR.mkdir(exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        dump = {
            "captured_at": ts,
            "profile_id": PROFILE_ID,
            "page_url": captured.get("href"),
            "headers": {
                "user_id": captured.get("userId"),
                "x_bc": captured.get("xBc"),
                "x_of_rev": captured.get("xOfRev"),
                "user_agent": captured.get("userAgent"),
            },
            "signing": {
                "rules": captured.get("rules"),
                "samples": captured.get("samples"),
                "last_sign_seen": captured.get("lastSign"),
                "last_time_seen": captured.get("lastTime"),
                "chunk_2313_url": chunk_url,
                "chunk_2313_file": f"chunk_2313_{ts}.js" if chunk_code else None,
            },
            "cookies": cookies,
            "local_storage": local_storage,
        }

        session_path = SESSIONS_DIR / f"session_{ts}.json"
        session_path.write_text(json.dumps(dump, indent=2))
        print(f"[*] Saved session -> {session_path.relative_to(ROOT)}")

        if chunk_code:
            chunk_path = SESSIONS_DIR / f"chunk_2313_{ts}.js"
            chunk_path.write_text(chunk_code)
            print(f"[*] Saved 2313.js -> {chunk_path.relative_to(ROOT)}")

        (SESSIONS_DIR / "latest.json").write_text(
            json.dumps({"session": session_path.name, "ts": ts}, indent=2)
        )

        _print_summary(dump, has_chunk=bool(chunk_code))
        # Leave the Incogniton browser open — don't browser.close() the context.
        return session_path


def _print_summary(dump: dict, *, has_chunk: bool) -> None:
    rules = dump["signing"]["rules"] or {}
    h = dump["headers"]
    print()
    print("─" * 60)
    print("CAPTURE SUMMARY")
    print("─" * 60)
    print(f"  user_id:           {h['user_id']}")
    print(f"  x_bc:              {h['x_bc']}")
    print(f"  x_of_rev:          {h['x_of_rev']}")
    print(f"  static_param:      {rules.get('static_param')}")
    print(f"  sign start/end:    {rules.get('start')} / {rules.get('end')}")
    indexes = rules.get("checksum_indexes")
    print(f"  checksum_indexes:  {'OK' if indexes else 'pending (step 2 — deobfuscate 2313.js)'}")
    print(f"  samples:           {len(dump['signing']['samples'])}")
    print(f"  cookies:           {len(dump['cookies'])}")
    print(f"  2313.js fetched:   {'yes' if has_chunk else 'no'}")
    print("─" * 60)


if __name__ == "__main__":
    try:
        capture()
    except KeyboardInterrupt:
        print("\n[!] Interrupted by user")
        sys.exit(130)
