#!/usr/bin/env python3
"""
Capture OF media-upload XHR chain.

Strategy:
  1. Connect to Incogniton, open chat 3266586 (an active fan we already verified).
  2. Enumerate every clickable icon in the chat compose area + their attributes.
  3. Set up an `expect_file_chooser` watcher for the WHOLE page (so whichever
     button creates the <input type=file> dynamically, we catch it).
  4. Click each candidate compose icon (excluding GIF / Schedule / emoji we
     already know) until the file chooser opens OR we've tried them all.
  5. Once the chooser fires: set_input_files(incogniton_fingerprint_test.png).
  6. Stream every /api2/v2/* AND every onlyfans.com/upload* AND every external
     PUT/POST to S3 / cloudflare upload domains. Dump the full body of the
     first 2-3 upload-init / upload-complete responses (those carry presigned
     URLs we'll need to replicate).
  7. Optionally hit Send so OF finalizes the media-id into a chat message.

Output:
  service/sessions/upload_capture/<ts>/xhr.jsonl
  service/sessions/upload_capture/<ts>/responses/<i>.json
  service/sessions/upload_capture/<ts>/*.png
  service/sessions/upload_capture/<ts>/dom_compose.html

Run:
  ./venv/bin/python service/capture_upload.py
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
# Use the resized image — OF rejects originals taller than 10000px.
TEST_IMAGE = Path("/tmp/upload_test.png")
if not TEST_IMAGE.exists():
    # Resize once on first run
    from PIL import Image as _Image
    src = ROOT / "incogniton_fingerprint_test.png"
    if src.exists():
        img = _Image.open(src)
        img.thumbnail((1080, 1920))
        img.save(TEST_IMAGE, "PNG", optimize=True)

# URLs of interest: OF API + any subdomain that might host the upload itself.
# OF historically uses cdn3.onlyfans.com or a presigned AWS S3 link.
HOSTS_OF_INTEREST = (
    "onlyfans.com/api2",
    "onlyfans.com/upload",
    "onlyfans.com/files",
    "amazonaws.com",        # S3 presigned URLs
    "cdn2.onlyfans.com",
    "cdn3.onlyfans.com",
    "of2cdn.com",
)


def main() -> None:
    if not TEST_IMAGE.exists():
        print(f"[!] Missing test image: {TEST_IMAGE}")
        sys.exit(1)

    ws = get_cdp_endpoint(PROFILE_ID)
    print(f"[*] CDP: {ws}")

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = OUT_BASE / ts
    (out_dir / "responses").mkdir(parents=True, exist_ok=True)
    xhr_path = out_dir / "xhr.jsonl"
    xhr = xhr_path.open("w")
    print(f"[*] Output dir: {out_dir}")

    counter = {"n": 0, "saved_bodies": 0}

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws)
        context = browser.contexts[0] if browser.contexts else browser.new_context()

        def on_request(req):
            try:
                if not any(h in req.url for h in HOSTS_OF_INTEREST):
                    return
                u = urlparse(req.url)
                method = req.method
                entry = {
                    "phase": "request",
                    "ts": time.time(),
                    "method": method,
                    "url": req.url,
                    "host": u.netloc,
                    "path": u.path,
                    "query": u.query,
                    "headers": dict(req.headers),
                    "body": req.post_data,
                    "body_len": len(req.post_data or ""),
                }
                xhr.write(json.dumps(entry) + "\n")
                xhr.flush()
                counter["n"] += 1
                interesting = method in ("POST", "PUT", "DELETE") or "upload" in u.path.lower()
                marker = "★" if interesting else " "
                body_preview = ""
                if req.post_data:
                    p_ = req.post_data
                    if len(p_) > 300:
                        body_preview = f"  body=<{len(p_)} bytes>"
                    else:
                        body_preview = f"  body={p_}"
                print(f"{marker} {method:6s} {u.netloc}{u.path}{body_preview}")
            except Exception as e:
                print(f"[!] req capture err: {e}")

        def on_response(resp):
            try:
                if not any(h in resp.url for h in HOSTS_OF_INTEREST):
                    return
                u = urlparse(resp.url)
                # We only care about response bodies for uploads / signed URL handouts.
                # Skip mass GETs unless they're upload-related.
                path = u.path.lower()
                is_upload_related = any(k in path for k in ("upload", "media", "vault"))
                if not is_upload_related and resp.request.method == "GET":
                    return
                try:
                    body = resp.body()
                    text = body.decode("utf-8", errors="replace")
                except Exception:
                    text = "<binary>"
                # Save the first ~20 interesting bodies for later inspection.
                if counter["saved_bodies"] < 30:
                    fname = f"{counter['saved_bodies']:02d}_{resp.request.method}_{path.strip('/').replace('/', '_')[:80]}.json"
                    body_path = out_dir / "responses" / fname
                    body_path.write_text(json.dumps({
                        "url": resp.url,
                        "status": resp.status,
                        "headers": dict(resp.headers),
                        "request_body": resp.request.post_data,
                        "response_body_preview": text[:5000],
                    }, indent=2))
                    counter["saved_bodies"] += 1
                xhr.write(json.dumps({
                    "phase": "response",
                    "ts": time.time(),
                    "status": resp.status,
                    "method": resp.request.method,
                    "url": resp.url,
                    "path": u.path,
                    "body_preview": text[:1500],
                }) + "\n")
                xhr.flush()
                print(f"  ← {resp.status} {u.netloc}{u.path}  body={text[:120]!r}")
            except Exception as e:
                print(f"[!] resp capture err: {e}")

        context.on("request", on_request)
        context.on("response", on_response)

        page = context.new_page()

        chat_url = f"https://onlyfans.com/my/chats/chat/{TARGET_CHAT}/"
        print(f"[*] Going to {chat_url}")
        page.goto(chat_url, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_timeout(4000)
        page.screenshot(path=str(out_dir / "01_chat_loaded.png"))

        # Dump compose-area DOM so we can post-mortem if the right icon isn't clicked.
        try:
            compose_html = page.locator(".b-chat__btn-submit").locator("xpath=ancestor::*[contains(@class,'b-chat')][1]").inner_html(timeout=5000)
            (out_dir / "dom_compose.html").write_text(compose_html)
            print("[*] Saved compose-area DOM")
        except Exception as e:
            print(f"[!] DOM dump failed: {e}")

        # ── Strategy A: any element exposing aria-label that hints upload ──
        candidate_selectors = [
            # OF used "Add files" / "Add media" / "Attach" / "Upload" labels.
            'button[aria-label*="Add files" i]',
            'button[aria-label*="Add media" i]',
            'button[aria-label*="Attach" i]',
            'button[aria-label*="Upload" i]',
            'button[aria-label*="Photo" i]',
            'button[aria-label*="Image" i]',
            'button[aria-label*="Vault" i]',
            'button[aria-label*="Files" i]',
            'label[for*="upload" i]',
            'input[type="file"]',                # direct file input fallback
            # Iconography (data-name patterns used in OF's Vue):
            '[data-name="vault_btn" i]',
            '[data-name*="upload" i]',
        ]

        upload_done = False
        for sel in candidate_selectors:
            els = page.locator(sel)
            n = els.count()
            if n == 0:
                continue
            print(f"\n[*] Trying selector: {sel}  ({n} matches)")
            for i in range(n):
                el = els.nth(i)
                try:
                    label = el.get_attribute("aria-label") or el.get_attribute("title") or el.get_attribute("data-name") or "?"
                    bbox = el.bounding_box()
                    print(f"   #{i} aria='{label}' bbox={bbox}")
                except Exception:
                    label = "?"

                # If we found a direct file input, just set files on it
                if sel == 'input[type="file"]':
                    try:
                        el.set_input_files(str(TEST_IMAGE))
                        print("   ✓ direct set_input_files() succeeded")
                        page.wait_for_timeout(5000)
                        upload_done = True
                        break
                    except Exception as e:
                        print(f"   set_input_files failed: {e}")
                        continue

                # Otherwise click and watch for file chooser
                try:
                    with page.expect_file_chooser(timeout=4000) as fc_info:
                        try:
                            el.click(timeout=2500)
                        except Exception as e:
                            print(f"   click failed: {e}")
                            raise
                    chooser = fc_info.value
                    chooser.set_files(str(TEST_IMAGE))
                    print(f"   ✓ file_chooser captured + file set ({TEST_IMAGE.name})")
                    page.wait_for_timeout(6000)
                    upload_done = True
                    break
                except Exception as e:
                    msg = str(e).splitlines()[0][:120]
                    print(f"   no file chooser: {msg}")
                    # Some clicks open a sub-menu (vault picker, etc) — try to back out
                    try:
                        page.keyboard.press("Escape")
                    except Exception:
                        pass
                    page.wait_for_timeout(500)
                    continue
            if upload_done:
                break

        if not upload_done:
            # Strategy B: enumerate every button in compose area + try each
            print("\n[*] Strategy B: brute-force every visible compose-area button")
            try:
                compose = page.locator(".b-chat__btn-submit").locator("xpath=ancestor::*[contains(@class,'b-chat__panel')][1]")
                btns = compose.locator("button, label, [role='button']")
                for i in range(min(btns.count(), 20)):
                    el = btns.nth(i)
                    try:
                        label = el.get_attribute("aria-label") or el.text_content() or "?"
                    except Exception:
                        label = "?"
                    if any(s in (label or "").lower() for s in ("gif", "send", "schedule", "emoji", "sticker", "audio")):
                        continue
                    print(f"  brute click #{i} '{label[:50]}'")
                    try:
                        with page.expect_file_chooser(timeout=2500) as fc_info:
                            el.click(timeout=2000)
                        chooser = fc_info.value
                        chooser.set_files(str(TEST_IMAGE))
                        print(f"  ✓ BRUTE: file_chooser captured on '{label}'")
                        page.wait_for_timeout(6000)
                        upload_done = True
                        break
                    except Exception as e:
                        try:
                            page.keyboard.press("Escape")
                        except Exception:
                            pass
                        continue
            except Exception as e:
                print(f"[!] brute force failed: {e}")

        page.screenshot(path=str(out_dir / "02_after_upload_attempt.png"))

        if upload_done:
            print("\n[*] Upload attempted — waiting 8s for OF to finish processing then capturing more")
            page.wait_for_timeout(8000)
            page.screenshot(path=str(out_dir / "03_attached.png"))
        else:
            print("\n[!] No file-chooser ever fired. Inspect dom_compose.html + screenshots.")

        print(f"\n[*] Done. {counter['n']} captured XHRs, {counter['saved_bodies']} response bodies saved.")
        print(f"    Log: {xhr_path}")
        xhr.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[!] Interrupted")
        sys.exit(130)
