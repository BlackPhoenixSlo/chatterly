#!/usr/bin/env bash
# Boot uvicorn (bound to localhost only) + a Cloudflare quick tunnel, then
# print a shareable URL with an embedded one-time token.
#
# Anyone with the printed link gets full access to YOUR OF account through
# this relay. Treat it like a password.
#
# Requires: cloudflared (brew install cloudflared), ./venv with project deps.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

PORT="${PORT:-8787}"
# Default token is stable so the share URL doesn't churn across restarts.
# Override with SHARE_TOKEN=... ./service/run_public.sh to rotate.
TOKEN="${SHARE_TOKEN:-kE5uOG47-gNIxmYzn7rSRCsINYUu0g-h}"
LOG_DIR="$REPO_ROOT/.run_public"
mkdir -p "$LOG_DIR"
TUNNEL_LOG="$LOG_DIR/cloudflared.log"
UVICORN_LOG="$LOG_DIR/uvicorn.log"
: > "$TUNNEL_LOG"
: > "$UVICORN_LOG"

cleanup() {
  echo
  echo "Shutting down…"
  [[ -n "${UVICORN_PID:-}" ]] && kill "$UVICORN_PID" 2>/dev/null || true
  [[ -n "${TUNNEL_PID:-}"  ]] && kill "$TUNNEL_PID"  2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting uvicorn on 127.0.0.1:$PORT (logs: $UVICORN_LOG)…"
SHARE_TOKEN="$TOKEN" ./venv/bin/uvicorn service.server:app \
  --host 127.0.0.1 --port "$PORT" >>"$UVICORN_LOG" 2>&1 &
UVICORN_PID=$!

echo "Starting cloudflared quick tunnel (logs: $TUNNEL_LOG)…"
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" \
  >>"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Quick tunnels print a line like:  https://<random>.trycloudflare.com
PUBLIC_URL=""
for _ in $(seq 1 60); do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "cloudflared exited early. Last log lines:"
    tail -n 30 "$TUNNEL_LOG"
    exit 1
  fi
  PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n1 || true)"
  [[ -n "$PUBLIC_URL" ]] && break
  sleep 1
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "Timed out waiting for cloudflared URL. Last log lines:"
  tail -n 30 "$TUNNEL_LOG"
  exit 1
fi

SHARE_URL="$PUBLIC_URL/ui/?t=$TOKEN"

cat <<EOF

────────────────────────────────────────────────────────────────
  Share this link with your friend (full UI access):

    $SHARE_URL

  Bare tunnel URL (no auth): $PUBLIC_URL
  Token: $TOKEN

  Press Ctrl-C to stop. Tunnel + token are ephemeral — closing
  this script kills both. Re-run for a new link.
────────────────────────────────────────────────────────────────

EOF

wait
