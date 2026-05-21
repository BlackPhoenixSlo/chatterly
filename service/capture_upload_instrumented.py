#!/usr/bin/env python3
"""
Capture upload with full JS instrumentation.

Previous captures used playwright's network events (context.on('request')/
'response') which sometimes miss requests issued from Web Workers OR from
'no-cors' fetch calls. This script ALSO injects an init-script that
monkey-patches window.fetch + XMLHttpRequest + Worker.postMessage at the page
level — so we see EVERY outbound request including those.

It also patches Math.random + crypto.subtle.encrypt to log inputs/outputs,
since processId / extra are suspected client-generated.

Output:
  service/sessions/upload_capture/<ts>_instrumented/{xhr.jsonl, console.log, *.png}
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from connect_incogniton import get_cdp_endpoint, PROFILE_ID  # noqa: E402

TEST_IMAGE = Path("/tmp/upload_test_new.png")
if not TEST_IMAGE.exists():
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (640, 480), (60, 80, 120))
    d = ImageDraw.Draw(img)
    d.rectangle((50, 50, 590, 430), outline=(255, 255, 255), width=4)
    d.text((100, 200), f"upload test {datetime.now()}", fill=(255, 255, 255))
    img.save(TEST_IMAGE, "PNG")

OUT = Path(__file__).resolve().parent / "sessions" / "upload_capture"
TARGET_CHAT = "3266586"


INIT_SCRIPT = r"""
(() => {
  const log = (kind, payload) => {
    try {
      console.log("__OF_TRACE__ " + kind + " " + JSON.stringify(payload));
    } catch (e) {
      console.log("__OF_TRACE__ " + kind + " (unstringifiable)");
    }
  };

  // ─── monkey-patch fetch ───────────────────────────────
  const orig_fetch = window.fetch;
  window.fetch = function (input, init = {}) {
    const url = typeof input === "string" ? input : input.url;
    let bodySummary = null;
    if (init && init.body) {
      if (typeof init.body === "string") bodySummary = init.body.length < 400 ? init.body : "<" + init.body.length + " bytes>";
      else if (init.body instanceof FormData) {
        const e = []; for (const [k, v] of init.body.entries()) e.push(k + "=" + (typeof v === "string" ? v.slice(0, 60) : "<" + (v.size || "?") + "B file>"));
        bodySummary = "FormData{" + e.join(",") + "}";
      } else bodySummary = "<" + (init.body.constructor && init.body.constructor.name || typeof init.body) + ">";
    }
    log("fetch.req", { url, method: (init && init.method) || "GET", body: bodySummary });
    return orig_fetch.call(this, input, init).then(async (resp) => {
      let txt = null;
      try {
        const ct = resp.headers.get("content-type") || "";
        if (ct.includes("json") || ct.includes("text")) {
          const cl = resp.clone();
          txt = await cl.text();
          if (txt.length > 800) txt = txt.slice(0, 800) + "…";
        }
      } catch (e) {}
      log("fetch.res", { url, status: resp.status, body: txt });
      return resp;
    });
  };

  // ─── XHR ──────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, async, user, pw) {
    this.__url = url; this.__method = method;
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    let summary = null;
    if (body) {
      if (typeof body === "string") summary = body.length < 400 ? body : "<" + body.length + " bytes>";
      else if (body instanceof FormData) {
        const e = []; for (const [k, v] of body.entries()) e.push(k + "=" + (typeof v === "string" ? v.slice(0, 60) : "<" + (v.size || "?") + "B file>"));
        summary = "FormData{" + e.join(",") + "}";
      } else summary = "<" + (body.constructor && body.constructor.name || typeof body) + ">";
    }
    log("xhr.req", { url: this.__url, method: this.__method, body: summary });
    this.addEventListener("loadend", () => {
      let txt = null;
      try { txt = this.responseText && this.responseText.length < 800 ? this.responseText : (this.responseText && this.responseText.slice(0, 800) + "…"); } catch (e) {}
      log("xhr.res", { url: this.__url, status: this.status, body: txt });
    });
    return _send.apply(this, arguments);
  };

  // ─── crypto.subtle hooks ──────────────────────────────
  if (window.crypto && window.crypto.subtle) {
    const _enc = window.crypto.subtle.encrypt.bind(window.crypto.subtle);
    window.crypto.subtle.encrypt = function (alg, key, data) {
      log("crypto.encrypt", { alg, dataLen: data && data.byteLength });
      return _enc(alg, key, data);
    };
    const _derive = window.crypto.subtle.deriveKey?.bind(window.crypto.subtle);
    if (_derive) {
      window.crypto.subtle.deriveKey = function (...args) {
        log("crypto.deriveKey", { algo: args[0] });
        return _derive(...args);
      };
    }
  }

  // ─── Worker.postMessage ──────────────────────────────
  const OrigWorker = window.Worker;
  window.Worker = new Proxy(OrigWorker, {
    construct(target, args) {
      const w = new target(...args);
      log("Worker.new", { url: String(args[0]) });
      const _post = w.postMessage.bind(w);
      w.postMessage = function (msg, ...rest) {
        try { log("Worker.post", { url: String(args[0]), msg: JSON.stringify(msg).slice(0, 400) }); } catch (e) {}
        return _post(msg, ...rest);
      };
      w.addEventListener("message", (ev) => {
        try { log("Worker.recv", { url: String(args[0]), data: JSON.stringify(ev.data).slice(0, 400) }); } catch (e) {}
      });
      return w;
    }
  });
})();
"""


def main():
    ws_ep = get_cdp_endpoint(PROFILE_ID)
    print(f"[*] CDP: {ws_ep}")

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = OUT / f"{ts}_instrumented"
    out_dir.mkdir(parents=True, exist_ok=True)
    console_log = (out_dir / "console.log").open("w")
    xhr_log = (out_dir / "xhr.jsonl").open("w")

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws_ep)
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()

        # Add the init-script so it runs on every new page
        ctx.add_init_script(script=INIT_SCRIPT)

        # Console messages
        def on_console(msg):
            try:
                text = msg.text
                if "__OF_TRACE__" in text:
                    console_log.write(text + "\n")
                    console_log.flush()
                    # Surface critical events to stdout
                    if any(k in text for k in ("convert", "processId", "extra", "encrypt", "Worker.new", "Worker.post", "/upload/", "fetch.res")):
                        print(f"[trace] {text[:300]}")
            except Exception:
                pass

        ctx.on("console", on_console)

        # Also keep network capture as a sanity check
        def on_request(req):
            try:
                if "onlyfans" in req.url or "amazonaws" in req.url:
                    xhr_log.write(json.dumps({"ts": time.time(), "method": req.method, "url": req.url, "post_data_len": len(req.post_data or "")}) + "\n")
                    xhr_log.flush()
            except Exception:
                pass
        ctx.on("request", on_request)

        page = ctx.new_page()
        page.goto(f"https://onlyfans.com/my/chats/chat/{TARGET_CHAT}/",
                  wait_until="networkidle", timeout=45_000)
        try:
            page.wait_for_selector('button[aria-label*="Add media" i]', timeout=20_000)
        except Exception:
            pass
        page.wait_for_timeout(2000)
        page.screenshot(path=str(out_dir / "01_loaded.png"))

        print(f"\n[*] Pick {TEST_IMAGE} via 'Add media'")
        try:
            with page.expect_file_chooser(timeout=8000) as fc:
                page.locator('button[aria-label*="Add media" i]').first.click(timeout=5000)
            fc.value.set_files(str(TEST_IMAGE))
        except Exception as e:
            print(f"[!] file chooser failed: {e}")
            console_log.close(); xhr_log.close()
            return

        print("[*] Wait 6s for upload pipeline")
        page.wait_for_timeout(6000)
        page.screenshot(path=str(out_dir / "02_uploaded.png"))

        print("[*] Click Send")
        try:
            page.locator('button.b-chat__btn-submit').first.click(timeout=5000)
        except Exception as e:
            print(f"[!] send click failed: {e}")
        page.wait_for_timeout(8000)
        page.screenshot(path=str(out_dir / "03_sent.png"))

        console_log.close(); xhr_log.close()
        print(f"\n[*] Done → {out_dir}")


if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt:
        sys.exit(130)
