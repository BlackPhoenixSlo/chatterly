import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

# Errors we treat as "Incogniton API didn't respond cleanly" — used in
# multiple retry loops below. Caught broadly because we only talk to localhost
# and want to recover from any of: connection refused, timeout, 5xx, OS error.
_NET_ERRORS = (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError)

load_dotenv(Path(__file__).resolve().parent / ".env")

INCOGNITON_API = "http://localhost:35000"
PROFILE_ID = os.environ.get(
    "INCOGNITON_PROFILE_ID",
    "2a4924fb-29c7-4cb9-bd65-21735fed419b",
)

_CACHE_DIR = Path.home() / ".incogniton_cdp"

# CDP readiness polling — cold-start can be slow + port may shift mid-wait
CDP_WAIT_TIMEOUT = 120       # total seconds to wait for CDP to come up
CDP_POLL_INTERVAL = 2        # seconds between readiness probes
CDP_REBIND_EVERY = 6         # every N polls, re-query Incogniton for current port

# Launch retry (if Incogniton API returns transient error)
LAUNCH_MAX_ATTEMPTS = 3
LAUNCH_BACKOFF = 4           # seconds between launch retries


def _http_get_json(url: str, timeout: int = 30):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        text = resp.read().decode("utf-8", errors="replace")
        if not (200 <= resp.status < 300):
            raise urllib.error.HTTPError(url, resp.status, resp.reason, resp.headers, None)
    try:
        return json.loads(text)
    except ValueError:
        print(f"[!] Non-JSON response from {url}: {text[:200]}")
        return None


def _extract_ws(data: dict) -> str | None:
    if not isinstance(data, dict):
        return None
    return (
        data.get("puppeteerUrl")
        or data.get("url")
        or data.get("webSocketDebuggerUrl")
        or data.get("wsEndpoint")
    )


def _get_active_ws(profile_id: str) -> str | None:
    """If profile already launched, return its existing WS endpoint. Don't re-launch."""
    for ep in (
        f"{INCOGNITON_API}/automation/active",
        f"{INCOGNITON_API}/profile/active",
        f"{INCOGNITON_API}/profile/status/{profile_id}",
    ):
        try:
            data = _http_get_json(ep, timeout=5)
        except _NET_ERRORS:
            continue
        if not data:
            continue
        # Payload shape varies across Incogniton versions — handle list + dict.
        items = data if isinstance(data, list) else data.get("profiles") or data.get("data") or [data]
        for item in items:
            if not isinstance(item, dict):
                continue
            pid = item.get("profileID") or item.get("id") or item.get("profile_id")
            if pid != profile_id:
                continue
            ws = _extract_ws(item)
            if ws:
                print(f"[*] Profile {profile_id} already active — reusing CDP: {ws}")
                return ws
    return None


def _launch(profile_id: str) -> str | None:
    launch_url = f"{INCOGNITON_API}/automation/launch/puppeteer/{profile_id}"
    for attempt in range(1, LAUNCH_MAX_ATTEMPTS + 1):
        print(f"[*] Launch attempt {attempt}/{LAUNCH_MAX_ATTEMPTS} → {launch_url}")
        try:
            data = _http_get_json(launch_url, timeout=60)
        except _NET_ERRORS as e:
            print(f"[!] Launch request failed: {e}")
            if attempt < LAUNCH_MAX_ATTEMPTS:
                time.sleep(LAUNCH_BACKOFF)
            continue

        if not data:
            if attempt < LAUNCH_MAX_ATTEMPTS:
                time.sleep(LAUNCH_BACKOFF)
            continue

        err = data.get("error") or data.get("message")
        ws = _extract_ws(data)

        # Already running is not an error — try to discover existing endpoint
        if err and "already" in str(err).lower():
            print(f"[*] Incogniton says: {err} — checking active sessions")
            ws = _get_active_ws(profile_id) or ws
            if ws:
                return ws

        if ws:
            return ws

        if err:
            print(f"[!] Incogniton error: {err}")
        if attempt < LAUNCH_MAX_ATTEMPTS:
            time.sleep(LAUNCH_BACKOFF)
    return None


def _cache_file(profile_id: str) -> Path:
    return _CACHE_DIR / f"{profile_id}.json"


def _save_cached_ws(profile_id: str, ws: str) -> None:
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _cache_file(profile_id).write_text(json.dumps({"ws": ws, "ts": time.time()}))
    except Exception as e:
        print(f"[!] cache save failed: {e}")


def _load_cached_ws(profile_id: str) -> str | None:
    path = _cache_file(profile_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        return data.get("ws") or None
    except Exception:
        return None


def _clear_cached_ws(profile_id: str) -> None:
    try:
        _cache_file(profile_id).unlink(missing_ok=True)
    except Exception:
        pass


def _probe_cdp(host: str, port: int) -> bool:
    """HTTP probe /json/version — real CDP readiness signal, not just TCP listen."""
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/json/version", timeout=2) as r:
            return r.status == 200
    except _NET_ERRORS:
        return False


def _wait_for_cdp(ws_endpoint: str, profile_id: str,
                  timeout: int = CDP_WAIT_TIMEOUT) -> str | None:
    """Probe CDP readiness. Every CDP_REBIND_EVERY polls, re-query Incogniton
    in case the port changed. Returns a working endpoint or None on timeout."""
    current = ws_endpoint
    deadline = time.time() + timeout
    poll = 0
    print(f"[*] Waiting up to {timeout}s for CDP at {current}...")
    while time.time() < deadline:
        parsed = urlparse(current)
        host = parsed.hostname or "localhost"
        port = parsed.port
        if port and _probe_cdp(host, port):
            print(f"[*] CDP live at {host}:{port}")
            return current
        poll += 1
        if poll % CDP_REBIND_EVERY == 0:
            latest = _get_active_ws(profile_id)
            if latest and latest != current:
                print(f"[*] Port shifted: {current} → {latest}")
                current = latest
        time.sleep(CDP_POLL_INTERVAL)
    print(f"[!] Timed out waiting for CDP at {current}")
    return None


def get_cdp_endpoint(profile_id: str = PROFILE_ID, *, timeout: int = CDP_WAIT_TIMEOUT) -> str:
    """Return a live CDP WebSocket endpoint for the Incogniton profile.

    Order: cached endpoint -> active session query -> fresh launch.
    Probes /json/version and handles Incogniton's mid-wait port shifts.
    Raises RuntimeError if no live endpoint can be obtained within `timeout`."""
    ws_endpoint = None
    cached = _load_cached_ws(profile_id)
    if cached:
        parsed = urlparse(cached)
        if parsed.hostname and parsed.port and _probe_cdp(parsed.hostname, parsed.port):
            print(f"[*] Reusing cached live CDP: {cached}")
            ws_endpoint = cached
        else:
            print(f"[*] Cached endpoint {cached} is dead — clearing")
            _clear_cached_ws(profile_id)

    if not ws_endpoint:
        ws_endpoint = _get_active_ws(profile_id)

    if not ws_endpoint:
        ws_endpoint = _launch(profile_id)

    if not ws_endpoint:
        raise RuntimeError("Could not obtain CDP WebSocket endpoint from Incogniton")

    print(f"[*] CDP endpoint: {ws_endpoint}")

    ws_endpoint = _wait_for_cdp(ws_endpoint, profile_id, timeout=timeout)
    if not ws_endpoint:
        raise RuntimeError(f"CDP did not become ready within {timeout}s")

    _save_cached_ws(profile_id, ws_endpoint)
    return ws_endpoint


def connect_to_incogniton():
    """Demo: connect Playwright to Incogniton, navigate to a fingerprint test,
    save a screenshot. Smoke-test for the CDP plumbing in get_cdp_endpoint()."""
    try:
        ws_endpoint = get_cdp_endpoint(PROFILE_ID)
    except RuntimeError as e:
        print(f"[!] {e}")
        sys.exit(1)

    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(ws_endpoint)
            print("[*] Playwright connected over CDP")

            context = browser.contexts[0] if browser.contexts else browser.new_context()
            page = context.new_page()

            target_url = "https://bot.sannysoft.com/"
            print(f"[*] Navigating to {target_url}")
            page.goto(target_url, wait_until="networkidle")

            screenshot_path = "incogniton_fingerprint_test.png"
            page.screenshot(path=screenshot_path, full_page=True)
            print(f"[*] Screenshot saved: {screenshot_path}")

            page.close()
            # sync API: use close() — disconnects CDP client, Incogniton browser stays open
            browser.close()
            print("[*] Playwright disconnected. Incogniton browser left open.")
        except Exception as e:
            print(f"[!] CDP session error: {e}")
            sys.exit(1)


if __name__ == "__main__":
    connect_to_incogniton()
