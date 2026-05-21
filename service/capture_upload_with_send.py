#!/usr/bin/env python3
"""
Same as capture_upload.py BUT clicks Send after attaching to capture the
finalize/claim XHR + WebSocket frames OF uses to bind a fresh upload to a
chat message.

Theory: somewhere between PUT-to-S3 and a successful send-with-mediaFiles
there is a (a) server-side claim XHR, (b) a "media ready" WebSocket message
that carries the real vault id, or (c) state OF tracks via a cookie/CSRF.

This script records:
  * Every /api2/v2/* and S3 XHR (request + response with body)
  * Every WebSocket frame (incoming + outgoing) on wss://ws*.onlyfans.com
  * Console logs (Vue warnings would tip us off)

Run:
  ./venv/bin/python service/capture_upload_with_send.py
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

OUT_BASE = Path(__file__).resolve().parent / "sessions" / "upload_capture"
TARGET_CHAT = "3266586"
TEST_IMAGE = Path("/tmp/upload_test.png")

if not TEST_IMAGE.exists():
    from PIL import Image
    src = ROOT / "incogniton_fingerprint_test.png"
    Image.open(src).reduce(8).save(TEST_IMAGE, "PNG", optimize=True)

# WIDENED: previously we only matched onlyfans.com/api2 + a few subdomains
# and silently dropped convert*.onlyfans.com, which IS the host the Send body
# names. Now match any onlyfans.com URL — covers convert.*, convert3.*, etc.
HOSTS_OF_INTEREST = (
    "onlyfans.com",   # any subdomain or path
    "amazonaws.com",
    "of2cdn.com",
    "of2transcoder",
)


def main() -> None:
    ws_ep = get_cdp_endpoint(PROFILE_ID)
    print(f"[*] CDP: {ws_ep}")

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = OUT_BASE / f"{ts}_send"
    (out_dir / "responses").mkdir(parents=True, exist_ok=True)
    xhr_path = out_dir / "xhr.jsonl"
    ws_path = out_dir / "websocket.jsonl"
    xhr = xhr_path.open("w")
    ws_log = ws_path.open("w")
    counter = {"n": 0, "saved_bodies": 0, "ws_frames": 0}

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws_ep)
        context = browser.contexts[0] if browser.contexts else browser.new_context()

        def on_request(req):
            try:
                if not any(h in req.url for h in HOSTS_OF_INTEREST):
                    return
                u = urlparse(req.url)
                # Skip static asset chatter so the log focuses on dynamic XHRs
                if u.netloc.startswith("static") or u.netloc.startswith("thumbs") or \
                   any(u.path.endswith(ext) for ext in (".js", ".css", ".woff", ".woff2", ".png", ".jpg", ".webp", ".svg", ".ico", ".mjs")):
                    if "/api2" not in u.path and "/upload" not in u.path and "/file/upload" not in u.path:
                        return
                entry = {"phase": "request", "ts": time.time(),
                         "method": req.method, "url": req.url,
                         "host": u.netloc, "path": u.path, "query": u.query,
                         "headers": dict(req.headers), "body": req.post_data,
                         "body_len": len(req.post_data or "")}
                xhr.write(json.dumps(entry) + "\n")
                xhr.flush()
                counter["n"] += 1
                interesting = req.method in ("POST", "PUT", "DELETE") or any(
                    k in u.path.lower() for k in ("upload", "vault", "messages"))
                bp = ""
                if req.post_data:
                    bp = f"  body=<{len(req.post_data)}B>" if len(req.post_data) > 200 else f"  body={req.post_data}"
                marker = "★" if interesting else " "
                print(f"{marker} {req.method:6s} {u.netloc}{u.path}{bp}")
            except Exception as e:
                print(f"[!] req err: {e}")

        def on_response(resp):
            try:
                if not any(h in resp.url for h in HOSTS_OF_INTEREST):
                    return
                u = urlparse(resp.url)
                path_l = u.path.lower()
                if resp.request.method == "GET" and not any(k in path_l for k in ("upload", "media", "vault")):
                    return
                try:
                    body = resp.body()
                    text = body.decode("utf-8", errors="replace")
                except Exception:
                    text = "<binary>"
                if counter["saved_bodies"] < 50:
                    fname = f"{counter['saved_bodies']:02d}_{resp.request.method}_{path_l.strip('/').replace('/', '_')[:80]}.json"
                    (out_dir / "responses" / fname).write_text(json.dumps({
                        "url": resp.url, "status": resp.status,
                        "headers": dict(resp.headers),
                        "request_body": resp.request.post_data,
                        "response_body_preview": text[:8000],
                    }, indent=2))
                    counter["saved_bodies"] += 1
                xhr.write(json.dumps({"phase": "response", "ts": time.time(),
                                       "status": resp.status, "method": resp.request.method,
                                       "url": resp.url, "path": u.path,
                                       "body_preview": text[:1500]}) + "\n")
                xhr.flush()
                print(f"  ← {resp.status} {u.netloc}{u.path}  body={text[:100]!r}")
            except Exception as e:
                print(f"[!] resp err: {e}")

        def on_websocket(ws):
            host = urlparse(ws.url).netloc
            print(f"\n[WS OPEN] {ws.url}")
            ws_log.write(json.dumps({"event": "open", "ts": time.time(), "url": ws.url}) + "\n")
            ws_log.flush()

            def on_frame_sent(payload):
                counter["ws_frames"] += 1
                ws_log.write(json.dumps({"event": "send", "ts": time.time(),
                                          "host": host, "payload": str(payload)[:500]}) + "\n")
                ws_log.flush()
                if len(str(payload)) < 200:
                    print(f"[WS →] {host}: {payload}")

            def on_frame_received(payload):
                counter["ws_frames"] += 1
                ws_log.write(json.dumps({"event": "recv", "ts": time.time(),
                                          "host": host, "payload": str(payload)[:1500]}) + "\n")
                ws_log.flush()
                p_str = str(payload)
                # Highlight if it looks like upload/media-related
                if any(k in p_str.lower() for k in ("media", "upload", "ready", "file")):
                    print(f"[WS ←★] {host}: {p_str[:300]}")
                elif len(p_str) < 200:
                    print(f"[WS ←] {host}: {p_str[:200]}")

            ws.on("framesent", on_frame_sent)
            ws.on("framereceived", on_frame_received)

        context.on("request", on_request)
        context.on("response", on_response)
        context.on("websocket", on_websocket)

        page = context.new_page()

        print(f"\n[*] Open chat {TARGET_CHAT}")
        page.goto(f"https://onlyfans.com/my/chats/chat/{TARGET_CHAT}/",
                  wait_until="networkidle", timeout=45_000)
        # Wait for the compose toolbar specifically
        try:
            page.wait_for_selector('button[aria-label*="Add media" i]', timeout=20_000)
        except Exception as e:
            print(f"[!] compose not ready: {e}")
        page.wait_for_timeout(2000)
        page.screenshot(path=str(out_dir / "01_chat_loaded.png"))

        print(f"\n[*] Click compose 'Add media' and upload {TEST_IMAGE.name}")
        try:
            with page.expect_file_chooser(timeout=8000) as fc_info:
                page.locator('button[aria-label*="Add media" i]').first.click(timeout=5000)
            chooser = fc_info.value
            chooser.set_files(str(TEST_IMAGE))
        except Exception as e:
            print(f"[!] file chooser failed: {e}")
            xhr.close(); ws_log.close()
            return

        print("\n[*] Wait 4s for upload to complete")
        page.wait_for_timeout(4000)
        page.screenshot(path=str(out_dir / "02_after_upload.png"))

        # Now find + click Send. The send button has a paper-airplane icon.
        # Try several selectors.
        print("\n[*] Click Send")
        send_clicked = False
        for sel in [
            'button[aria-label*="Send" i]',
            'button[title*="Send" i]',
            'button.b-chat__btn-submit',
            '.b-chat__btn-submit button',
            '.b-chat__btn-submit',
        ]:
            try:
                btn = page.locator(sel).first
                if btn.count() == 0: continue
                # Make sure it's not disabled
                disabled = btn.get_attribute("disabled")
                print(f"   trying {sel} (disabled={disabled})")
                btn.click(timeout=2500)
                send_clicked = True
                print(f"   ✓ clicked {sel}")
                break
            except Exception as e:
                print(f"   {sel}: {str(e).splitlines()[0][:100]}")

        if send_clicked:
            print("\n[*] Wait 8s after Send for OF processing + responses")
            page.wait_for_timeout(8000)
            page.screenshot(path=str(out_dir / "03_after_send.png"))
        else:
            print("[!] couldn't click Send — capture stops here.")

        print(f"\n[*] {counter['n']} XHRs, {counter['saved_bodies']} bodies, {counter['ws_frames']} WS frames")
        print(f"    {xhr_path}")
        print(f"    {ws_path}")
        xhr.close()
        ws_log.close()


if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt:
        print("\n[!] Interrupted")
        sys.exit(130)
