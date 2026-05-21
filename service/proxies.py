"""
Proxy registry — persistent store of per-account proxies.

Each session JSON in service/sessions/ can be paired with a proxy in this
registry by label. OFClient consults `get_proxy_for_session(filename)` on
load and routes all curl_cffi traffic through it.

Single source of truth lives in service/proxies.json. Schema:

  {
    "proxies": [
      {
        "label":              "hu-1",
        "scheme":             "http",      // http | https | socks5
        "host":               "188.244.113.72",
        "port":               12323,
        "username":           "...",       // optional
        "password":           "...",       // optional — plain text, see notes
        "notes":              "Budapest, HU AS211439 LOCOTORPI",
        "assigned_session":   "session_20260517T192858Z.json",  // or null
        "verified_ip":        "188.244.113.72",
        "verified_at":        "2026-05-17T22:14:03Z",
        "verified_geo":       "Budapest, Budapest, HU"
      }
    ]
  }

Phase-1 (testing) stores credentials in plain text. Phase-2 should move
secrets into the OS keychain — see TODO section O.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REGISTRY_PATH = HERE / "proxies.json"

_lock = threading.Lock()


def _empty() -> dict[str, Any]:
    return {"proxies": []}


def load() -> dict[str, Any]:
    if not REGISTRY_PATH.exists():
        return _empty()
    try:
        data = json.loads(REGISTRY_PATH.read_text())
    except json.JSONDecodeError:
        return _empty()
    if not isinstance(data, dict) or "proxies" not in data:
        return _empty()
    return data


def save(data: dict[str, Any]) -> None:
    REGISTRY_PATH.write_text(json.dumps(data, indent=2, sort_keys=False))


def list_proxies() -> list[dict[str, Any]]:
    return load().get("proxies", [])


def get_by_label(label: str) -> dict[str, Any] | None:
    for p in list_proxies():
        if p.get("label") == label:
            return p
    return None


def get_for_session(session_filename: str) -> dict[str, Any] | None:
    """Return the proxy currently assigned to `session_filename`, or None.
    Legacy: pre-multi-account installs bound proxies to a specific session
    file. New installs bind to account_id (see `get_for_account`)."""
    for p in list_proxies():
        if p.get("assigned_session") == session_filename:
            return p
    return None


def get_for_account(account_id: str) -> dict[str, Any] | None:
    """Return the proxy assigned to this OF account (preferred — survives
    re-captures because each new session is bucketed under the same id)."""
    if not account_id:
        return None
    for p in list_proxies():
        if p.get("assigned_account_id") == str(account_id):
            return p
    return None


def proxy_url(p: dict[str, Any]) -> str:
    """Render a proxy entry to the URL form curl_cffi/requests expects."""
    scheme = p.get("scheme", "http")
    host, port = p["host"], p["port"]
    user, pw = p.get("username"), p.get("password")
    if user and pw:
        return f"{scheme}://{user}:{pw}@{host}:{port}"
    return f"{scheme}://{host}:{port}"


def proxies_dict_for_requests(p: dict[str, Any]) -> dict[str, str]:
    """Shape curl_cffi.requests.Session.proxies wants."""
    u = proxy_url(p)
    return {"http": u, "https": u}


def upsert(entry: dict[str, Any]) -> dict[str, Any]:
    """Add or replace by label. Returns the stored entry."""
    label = entry.get("label")
    if not label:
        raise ValueError("proxy entry needs a 'label'")
    for required in ("host", "port"):
        if not entry.get(required):
            raise ValueError(f"proxy entry missing '{required}'")
    entry.setdefault("scheme", "http")
    entry.setdefault("notes", "")
    entry.setdefault("assigned_session", None)     # legacy per-file binding
    entry.setdefault("assigned_account_id", None)  # preferred: per-account binding
    entry.setdefault("verified_ip", None)
    entry.setdefault("verified_at", None)
    entry.setdefault("verified_geo", None)

    with _lock:
        data = load()
        for i, p in enumerate(data["proxies"]):
            if p.get("label") == label:
                # Preserve any fields the caller didn't supply.
                merged = {**p, **{k: v for k, v in entry.items() if v is not None or k == "assigned_session"}}
                data["proxies"][i] = merged
                save(data)
                return merged
        data["proxies"].append(entry)
        save(data)
        return entry


def remove(label: str) -> bool:
    with _lock:
        data = load()
        before = len(data["proxies"])
        data["proxies"] = [p for p in data["proxies"] if p.get("label") != label]
        if len(data["proxies"]) == before:
            return False
        save(data)
        return True


def assign(label: str, session_filename: str | None) -> dict[str, Any]:
    """Bind a proxy to a session file (LEGACY). Prefer `assign_account`.
    Enforces 1:1 — if another proxy already owns that session, it is unassigned."""
    with _lock:
        data = load()
        target = None
        for p in data["proxies"]:
            if p.get("label") == label:
                target = p
            elif session_filename and p.get("assigned_session") == session_filename:
                p["assigned_session"] = None
        if target is None:
            raise KeyError(f"no proxy with label {label!r}")
        target["assigned_session"] = session_filename
        save(data)
        return target


def assign_account(label: str, account_id: str | None) -> dict[str, Any]:
    """Bind a proxy to an OF account. Pass None to unassign.

    Enforces 1:1 — if another proxy already owns that account, it is unassigned
    first. This is the preferred binding: account_id survives re-captures, where
    `assigned_session` (filename-bound) would silently break."""
    with _lock:
        data = load()
        target = None
        aid = str(account_id) if account_id is not None else None
        for p in data["proxies"]:
            if p.get("label") == label:
                target = p
            elif aid and p.get("assigned_account_id") == aid:
                p["assigned_account_id"] = None
        if target is None:
            raise KeyError(f"no proxy with label {label!r}")
        target["assigned_account_id"] = aid
        # Clear the legacy filename binding so the two don't fight each other.
        target["assigned_session"] = None
        save(data)
        return target


def migrate_legacy_assignments(filename_to_account: dict[str, str]) -> int:
    """Promote `assigned_session` (filename) bindings to `assigned_account_id`
    using a {session_filename: account_id} map (built from the account dirs).
    Idempotent. Returns how many proxies were rebound."""
    rebound = 0
    with _lock:
        data = load()
        for p in data["proxies"]:
            if p.get("assigned_account_id"):
                continue  # already on the new scheme
            sf = p.get("assigned_session")
            if sf and sf in filename_to_account:
                p["assigned_account_id"] = filename_to_account[sf]
                # Don't clear assigned_session immediately — keep it as an audit
                # crumb so an admin can still see which capture originally
                # introduced this binding.
                rebound += 1
        if rebound:
            save(data)
    return rebound


def record_verification(label: str, *, ip: str | None, geo: str | None,
                        ok: bool) -> None:
    """Persist the last egress-IP probe result for a proxy."""
    with _lock:
        data = load()
        for p in data["proxies"]:
            if p.get("label") == label:
                if ok:
                    p["verified_ip"] = ip
                    p["verified_geo"] = geo
                    p["verified_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                else:
                    p["verified_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                    p["verified_ip"] = None
                save(data)
                return


def probe(p: dict[str, Any], timeout_s: int = 15) -> dict[str, Any]:
    """Fetch the egress IP through the proxy + a coarse geo lookup.
    Returns {ok, ip, geo, error?}. Safe to call from a request handler."""
    import urllib.request
    import urllib.error
    import socket

    url = proxy_url(p)
    ip = None
    geo = None
    err = None
    try:
        # Build an opener so we can target the proxy precisely.
        proxy_handler = urllib.request.ProxyHandler({"http": url, "https": url})
        opener = urllib.request.build_opener(proxy_handler)
        with opener.open("https://api.ipify.org", timeout=timeout_s) as r:
            ip = r.read().decode().strip()
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        err = f"proxy_probe_failed: {e}"

    if ip:
        try:
            with urllib.request.urlopen(f"https://ipinfo.io/{ip}/json", timeout=timeout_s) as r:
                info = json.loads(r.read().decode())
                parts = [info.get("city"), info.get("region"), info.get("country")]
                geo = ", ".join(p for p in parts if p)
        except Exception:
            geo = None

    return {"ok": ip is not None, "ip": ip, "geo": geo, "error": err}
