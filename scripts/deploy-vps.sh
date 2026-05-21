#!/usr/bin/env bash
#
# deploy-vps.sh — push Chatterly to a fresh Ubuntu/Debian VPS.
#
# Usage:
#   ./scripts/deploy-vps.sh root@<vps-ip>
#   ./scripts/deploy-vps.sh ubuntu@<vps-ip> --port 22 --no-secrets
#
# What it does, in order:
#   1. Verifies SSH to the host works.
#   2. Installs Docker + compose plugin via get.docker.com (idempotent).
#   3. git clones https://github.com/BlackPhoenixSlo/chatterly.git into ~/chatterly
#      (skips if already cloned; runs `git pull` instead).
#   4. Pre-creates bind-mount targets: service/proxies.json (empty registry),
#      service/chatterly.db (empty file), service/storyboard_cache/ (dir).
#   5. Unless --no-secrets is passed, scp's your local
#        service/sessions/*.json
#        service/proxies.json
#        service/chatterly.db
#      onto the host so the relay boots already authenticated.
#   6. Generates a random SHARE_TOKEN, writes it to ~/chatterly/.env on the
#      host (compose picks it up automatically), prints it locally.
#   7. `docker compose --profile tunnel up -d --build` and tails the
#      cloudflared logs until the trycloudflare.com URL appears.
#
# All work happens against the user account specified in the SSH string.
# If you ssh as root, $HOME is /root; if you ssh as ubuntu, $HOME is
# /home/ubuntu — chatterly lives under whichever it is.

set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 <ssh-target> [--port N] [--no-secrets] [--branch BRANCH]
  ssh-target    e.g. root@1.2.3.4   (must have key-based SSH set up)
  --port N      SSH port if non-default
  --no-secrets  Skip copying local sessions / db / proxies (use to set up a
                fresh deployment that captures its own session via the
                Chrome extension after boot).
  --branch B    Git branch to deploy from (default: main)
EOF
  exit 1
}

[[ $# -ge 1 ]] || usage
case "$1" in -h|--help) usage ;; esac

SSH_TARGET="$1"; shift
SSH_PORT=22
COPY_SECRETS=1
BRANCH=main

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)        SSH_PORT="$2"; shift 2 ;;
    --no-secrets)  COPY_SECRETS=0; shift ;;
    --branch)      BRANCH="$2"; shift 2 ;;
    -h|--help)     usage ;;
    *)             echo "unknown flag: $1" >&2; usage ;;
  esac
done

LOCAL_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_REPO_URL="https://github.com/BlackPhoenixSlo/chatterly.git"
REMOTE_DIR="chatterly"   # relative to the SSH user's $HOME
SSH=(ssh -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$SSH_TARGET")
SCP=(scp -P "$SSH_PORT" -o StrictHostKeyChecking=accept-new)

say() { printf '\n\033[36m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 1. SSH reachability ----------
say "checking SSH to $SSH_TARGET on port $SSH_PORT"
"${SSH[@]}" -o ConnectTimeout=10 true || die "cannot SSH to $SSH_TARGET — check IP, port, and your public key on the host"

# ---------- 2. Docker install ----------
say "installing Docker on the host (idempotent — skipped if already present)"
"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "✗ docker compose plugin missing — install manually" >&2
  exit 1
fi
docker --version
docker compose version
REMOTE

# ---------- 3. Clone / pull ----------
say "cloning chatterly into ~/$REMOTE_DIR (branch: $BRANCH)"
"${SSH[@]}" bash -s <<REMOTE
set -euo pipefail
if [ -d "\$HOME/$REMOTE_DIR/.git" ]; then
  cd "\$HOME/$REMOTE_DIR"
  git fetch origin
  git checkout "$BRANCH"
  git pull --ff-only
else
  git clone --branch "$BRANCH" "$REMOTE_REPO_URL" "\$HOME/$REMOTE_DIR"
fi
REMOTE

# ---------- 4. Pre-create bind-mount targets ----------
say "creating bind-mount targets (proxies.json, chatterly.db, storyboard_cache/)"
"${SSH[@]}" bash -s <<REMOTE
set -euo pipefail
cd "\$HOME/$REMOTE_DIR"
[ -f service/proxies.json ] || echo '{"proxies":[]}' > service/proxies.json
[ -f service/chatterly.db ] || touch service/chatterly.db
mkdir -p service/sessions service/storyboard_cache
REMOTE

# ---------- 5. Secrets transfer ----------
if [[ $COPY_SECRETS -eq 1 ]]; then
  say "copying sessions, proxies.json, chatterly.db from your laptop"
  LOCAL_SESSIONS="$LOCAL_REPO_ROOT/service/sessions"
  LOCAL_PROXIES="$LOCAL_REPO_ROOT/service/proxies.json"
  LOCAL_DB="$LOCAL_REPO_ROOT/service/chatterly.db"

  [ -d "$LOCAL_SESSIONS" ] || die "no local sessions dir at $LOCAL_SESSIONS"
  [ -f "$LOCAL_PROXIES" ]  || die "no local proxies.json at $LOCAL_PROXIES"
  [ -f "$LOCAL_DB" ]       || die "no local chatterly.db at $LOCAL_DB"

  # Push sessions (only the json/jsonl files — skip nothing-useful subdirs).
  "${SCP[@]}" "$LOCAL_SESSIONS"/*.json "$SSH_TARGET:~/$REMOTE_DIR/service/sessions/" || \
    echo "  (no session json files to copy)"
  if compgen -G "$LOCAL_SESSIONS/active.json" > /dev/null; then
    "${SCP[@]}" "$LOCAL_SESSIONS/active.json" "$SSH_TARGET:~/$REMOTE_DIR/service/sessions/" || true
  fi
  "${SCP[@]}" "$LOCAL_PROXIES" "$SSH_TARGET:~/$REMOTE_DIR/service/proxies.json"
  "${SCP[@]}" "$LOCAL_DB"      "$SSH_TARGET:~/$REMOTE_DIR/service/chatterly.db"
else
  say "skipping secrets transfer (--no-secrets). You'll capture a fresh session via the Chrome extension after boot."
fi

# ---------- 6. SHARE_TOKEN ----------
say "generating SHARE_TOKEN and writing ~/$REMOTE_DIR/.env on the host"
SHARE_TOKEN=$(openssl rand -hex 24)
"${SSH[@]}" bash -s <<REMOTE
set -euo pipefail
cd "\$HOME/$REMOTE_DIR"
# Compose reads .env automatically. Use single-quotes inside printf so no
# shell expansion happens on the host.
printf 'SHARE_TOKEN=%s\n' '$SHARE_TOKEN' > .env
chmod 600 .env
REMOTE

# ---------- 7. compose up + wait for tunnel URL ----------
say "docker compose --profile tunnel up -d --build (first build can take a few minutes)"
"${SSH[@]}" bash -s <<REMOTE
set -euo pipefail
cd "\$HOME/$REMOTE_DIR"
docker compose --profile tunnel up -d --build
REMOTE

say "waiting for cloudflared to advertise a public URL"
TUNNEL_URL=""
for attempt in $(seq 1 30); do
  TUNNEL_URL=$("${SSH[@]}" "docker logs chatterly-tunnel 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n 1" || true)
  if [[ -n "$TUNNEL_URL" ]]; then break; fi
  printf '.'
  sleep 4
done
echo

if [[ -z "$TUNNEL_URL" ]]; then
  echo
  echo "⚠ Tunnel URL didn't appear in 2 minutes. Tail the logs manually:"
  echo "    ssh -p $SSH_PORT $SSH_TARGET docker compose -f ~/$REMOTE_DIR/docker-compose.yml logs -f tunnel"
  exit 1
fi

cat <<DONE

────────────────────────────────────────────────────────────
✓ Chatterly is live.

  URL:           ${TUNNEL_URL}/?t=${SHARE_TOKEN}
  SHARE_TOKEN:   ${SHARE_TOKEN}
  Host:          ${SSH_TARGET}

Open the URL above in any browser to log in. The trycloudflare subdomain
changes every restart — grab a new one with:

  ssh -p ${SSH_PORT} ${SSH_TARGET} 'docker logs chatterly-tunnel | grep trycloudflare | tail -1'

To redeploy after pulling new code:

  ${0} ${SSH_TARGET}        # re-runs everything; idempotent

To take the public URL down without stopping the rest of the stack:

  ssh -p ${SSH_PORT} ${SSH_TARGET} 'cd ~/${REMOTE_DIR} && docker compose --profile tunnel stop tunnel'
────────────────────────────────────────────────────────────
DONE
