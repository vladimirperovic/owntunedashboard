#!/usr/bin/env bash
# Deploy the dashboard from this machine to the Plex/OwnTone LXC via the Proxmox host.
# Real hosts/IDs live in deploy/deploy.local.conf (gitignored) — nothing sensitive is committed.
set -euo pipefail
cd "$(dirname "$0")/.."

CONF="deploy/deploy.local.conf"
if [ ! -f "$CONF" ]; then
  echo "Missing $CONF"
  echo "Copy deploy/deploy.local.conf.example to deploy/deploy.local.conf and fill it in."
  exit 1
fi
# shellcheck disable=SC1090
source "$CONF"

: "${PROXMOX_TARGET:?Set PROXMOX_TARGET in $CONF (e.g. user@proxmox-host)}"
: "${LXC_ID:?Set LXC_ID in $CONF}"
TARGET_DIR="${TARGET_DIR:-/opt/owntunedashboard}"

BRANCH="$(git branch --show-current)"
COMMIT="$(git rev-parse --short HEAD)"
[ "$BRANCH" = "main" ] || echo "WARNING: deploying branch '$BRANCH', not main"

echo "==> Packaging HEAD ($BRANCH @ $COMMIT)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar czf "$STAGE/dashboard.tar.gz" \
  --exclude='.git' --exclude='.DS_Store' --exclude='test-results' \
  --exclude='node_modules' --exclude='playwright-report' .

echo "==> Uploading via $PROXMOX_TARGET to LXC $LXC_ID"
scp -q "$STAGE/dashboard.tar.gz" "$PROXMOX_TARGET:/tmp/dashboard-deploy.tar.gz"
ssh "$PROXMOX_TARGET" "pct push $LXC_ID /tmp/dashboard-deploy.tar.gz /tmp/dashboard-deploy.tar.gz >/dev/null"

echo "==> Installing on LXC $LXC_ID"
ssh "$PROXMOX_TARGET" "pct exec $LXC_ID -- /bin/bash -s" "$COMMIT" "$TARGET_DIR" <<'REMOTE'
set -euo pipefail
COMMIT="$1"; TARGET="$2"

rm -rf "$TARGET"
mkdir -p "$TARGET"
tar xzf /tmp/dashboard-deploy.tar.gz -C "$TARGET"
find "$TARGET" -type d -exec chmod 0755 {} +
find "$TARGET" -type f -exec chmod 0644 {} +
chmod 0755 "$TARGET/scheduler" "$TARGET"/scheduler/*.py 2>/dev/null || true
printf '{"commit":"%s","deployed_at":"%s"}\n' "$COMMIT" "$(date -Is)" > "$TARGET/version.json"
rm -f /tmp/dashboard-deploy.tar.gz

install -m 0644 "$TARGET/deploy/owntone-dashboard-scheduler.service" /etc/systemd/system/owntone-dashboard-scheduler.service
systemctl daemon-reload
systemctl enable owntone-dashboard-scheduler.service >/dev/null 2>&1 || true
systemctl restart owntone-dashboard-scheduler.service

if ! cmp -s "$TARGET/deploy/nginx.conf" /etc/nginx/sites-available/owntunedashboard; then
  cp /etc/nginx/sites-available/owntunedashboard /etc/nginx/sites-available/owntunedashboard.bak
  cp "$TARGET/deploy/nginx.conf" /etc/nginx/sites-available/owntunedashboard
  if ! nginx -t; then
    cp /etc/nginx/sites-available/owntunedashboard.bak /etc/nginx/sites-available/owntunedashboard
    echo "nginx -t failed; restored previous site config" >&2
    exit 1
  fi
  systemctl reload nginx
fi

systemctl is-active --quiet owntone-dashboard-scheduler.service
# give scheduler a moment to bind (restart is async) — retry health endpoint
for i in 1 2 3 4 5; do
  sleep 1
  if curl -fsS -m5 http://127.0.0.1:3690/scheduler/health | grep -q '"ok": true'; then break; fi
  [ "$i" = 5 ] && { echo "scheduler health check failed" >&2; exit 1; }
done
curl -fsS -m5 -o /dev/null http://127.0.0.1:3690/
echo "BUILD: $(grep -o "BUILD = '[^']*'" "$TARGET/config.js" || echo '?')  commit: $COMMIT"
REMOTE

echo "==> Deploy done ($COMMIT)"
