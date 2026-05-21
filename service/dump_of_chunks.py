#!/usr/bin/env python3
"""
Dump every JS chunk OF loads on startup, plus an index that maps each chunk to
keywords of interest (processId, convert3, mediaFiles, extra, encrypt, AES,
upload, etc).

Goal: find the chunk that contains the upload encryption algorithm so we can
port it to Python and become Incogniton-free at runtime.

Run:
  ./venv/bin/python service/dump_of_chunks.py

Output:
  service/sessions/chunks/<ts>/<chunk_id>_<hash>.js   — the chunk source
  service/sessions/chunks/<ts>/index.csv              — chunk_id, url, size,
                                                         hits per keyword
  service/sessions/chunks/<ts>/keyword_hits.txt       — summary
"""
from __future__ import annotations

import csv
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from connect_incogniton import get_cdp_endpoint, PROFILE_ID  # noqa: E402

OUT_BASE = Path(__file__).resolve().parent / "sessions" / "chunks"

# Keywords we care about. Hit-counts per chunk are written to index.csv.
KEYWORDS = [
    "processId", "convert3.onlyfans.com", "mediaFiles", "convert", "transcoder",
    "/upload/signed/create", "vault/media/hash", "secure:!1", "secure:false",
    "CryptoJS", "AES", "encrypt", "Cipher", "WordArray", "createHmac", "subtle.encrypt",
    "checksum_indexes", "checksum_constant", "static_param",   # known signing constants
    "btoa", "atob", "Base64",
    "putUrl", "getUrl",
]


def main() -> None:
    ws_ep = get_cdp_endpoint(PROFILE_ID)
    print(f"[*] CDP: {ws_ep}")

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = OUT_BASE / ts
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[*] Output → {out_dir}")

    chunks: dict[str, dict] = {}   # url → {bytes, headers}

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws_ep)
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()

        def on_response(resp):
            try:
                if "onlyfans.com" not in resp.url:
                    return
                u = urlparse(resp.url)
                if not (u.path.endswith(".js") or u.path.endswith(".mjs")):
                    return
                if resp.url in chunks:
                    return
                body = resp.body()
                chunks[resp.url] = {
                    "url": resp.url,
                    "path": u.path,
                    "size": len(body),
                    "body": body.decode("utf-8", errors="replace"),
                }
            except Exception as e:
                print(f"[!] capture err: {e}")

        context.on("response", on_response)

        # Hitting /my/chats triggers most webpack chunks (app shell + chat ui).
        # Also visit a few pages to force lazy chunks to load (vault, queue).
        targets = [
            "https://onlyfans.com/",
            "https://onlyfans.com/my/chats",
            "https://onlyfans.com/my/chats/chat/3266586/",
            "https://onlyfans.com/my/vault",
            "https://onlyfans.com/my/queue",
        ]
        for url in targets:
            print(f"[*] {url}")
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=30_000)
                page.wait_for_timeout(2500)
            except Exception as e:
                print(f"   [!] {e}")
            time.sleep(0.5)

        print(f"\n[*] Captured {len(chunks)} JS chunks")

        # Save chunks + score keywords
        rows = []
        keyword_summary: dict[str, list[tuple[int, str]]] = {k: [] for k in KEYWORDS}
        for i, (url, info) in enumerate(sorted(chunks.items(), key=lambda kv: -kv[1]["size"])):
            stem = url.split("/")[-1][:80].replace("?", "_")
            chunk_path = out_dir / f"{i:03d}_{stem}"
            if not chunk_path.suffix:
                chunk_path = chunk_path.with_suffix(".js")
            chunk_path.write_text(info["body"])
            hits = {}
            for kw in KEYWORDS:
                count = info["body"].count(kw)
                hits[kw] = count
                if count:
                    keyword_summary[kw].append((count, str(chunk_path.name)))
            rows.append({
                "i": i, "size": info["size"], "url": url, **{f"kw:{k}": v for k, v in hits.items()},
            })

        # index.csv
        with (out_dir / "index.csv").open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["i", "size", "url"] + [f"kw:{k}" for k in KEYWORDS])
            w.writeheader()
            for r in rows:
                w.writerow(r)

        # keyword_hits.txt — concise per-keyword summary
        with (out_dir / "keyword_hits.txt").open("w") as f:
            for kw, hits in keyword_summary.items():
                if not hits: continue
                f.write(f"\n=== {kw} ===\n")
                for count, fn in sorted(hits, reverse=True):
                    f.write(f"  {count:4d}  {fn}\n")

        # Console: print top 10 hits per most-relevant keywords
        for kw in ("processId", "convert3.onlyfans.com", "mediaFiles", "putUrl", "/upload/signed/create"):
            hits = keyword_summary[kw]
            if hits:
                print(f"\n=== {kw} ({len(hits)} files have it) ===")
                for count, fn in sorted(hits, reverse=True)[:5]:
                    print(f"  {count:4d}  {fn}")
            else:
                print(f"\n=== {kw}: NO HITS in any chunk ===")


if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt:
        print("\n[!] Interrupted")
        sys.exit(130)
