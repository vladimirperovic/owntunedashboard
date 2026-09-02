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
TARGET_DIR="${TARGET_DIR:-/opt/owntone-dashboard}"

# The remote install starts with `rm -rf "$TARGET"`, and TARGET_DIR comes from a
# hand-edited config file. Refuse anything that is not a deliberate install path.
# ssh joins its arguments with spaces rather than quoting them, so a path
# containing whitespace or a shell metacharacter would be re-split remotely —
# reject those here as well as the wrong prefix.
case "$TARGET_DIR" in
  *[!A-Za-z0-9/._-]*)
    echo "Refusing to deploy to '$TARGET_DIR': the path may only contain letters," >&2
    echo "digits and / . _ - characters." >&2
    exit 1
    ;;
esac
case "$TARGET_DIR" in
  /opt/?*|/srv/?*|/usr/local/share/?*) ;;
  *)
    echo "Refusing to deploy to '$TARGET_DIR'." >&2
    echo "TARGET_DIR must be under /opt, /srv or /usr/local/share." >&2
    exit 1
    ;;
esac

BRANCH="$(git branch --show-current)"
COMMIT="$(git rev-parse --short HEAD)"
[ "$BRANCH" = "main" ] || echo "WARNING: deploying branch '$BRANCH', not main"

if ! git diff --quiet HEAD --; then
  echo "WARNING: working tree has uncommitted changes; they will NOT be deployed."
fi

echo "==> Packaging HEAD ($BRANCH @ $COMMIT)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# git archive, not `tar .` — the old command packaged the working tree while the
# message claimed HEAD, so uncommitted files shipped stamped with a commit that
# did not contain them.
git archive --format=tar.gz -o "$STAGE/dashboard.tar.gz" HEAD

echo "==> Uploading via $PROXMOX_TARGET to LXC $LXC_ID"
scp -q "$STAGE/dashboard.tar.gz" "$PROXMOX_TARGET:/tmp/dashboard-deploy.tar.gz"
# LXC_ID and TARGET_DIR are deliberately expanded here, on this machine: they
# come from deploy.local.conf and the container knows nothing about them.
# shellcheck disable=SC2029
ssh "$PROXMOX_TARGET" "pct push $LXC_ID /tmp/dashboard-deploy.tar.gz /tmp/dashboard-deploy.tar.gz >/dev/null"

echo "==> Installing on LXC $LXC_ID"
# shellcheck disable=SC2029
ssh "$PROXMOX_TARGET" "pct exec $LXC_ID -- /bin/bash -s" "$COMMIT" "$TARGET_DIR" <<'REMOTE'
set -euo pipefail
COMMIT="$1"; TARGET="$2"

case "$TARGET" in
  /opt/?*|/srv/?*|/usr/local/share/?*) ;;
  *) echo "Refusing to remove '$TARGET'" >&2; exit 1 ;;
esac

rm -rf "$TARGET"
mkdir -p "$TARGET"
tar xzf /tmp/dashboard-deploy.tar.gz -C "$TARGET"
find "$TARGET" -type d -exec chmod 0755 {} +
find "$TARGET" -type f -exec chmod 0644 {} +
printf '{"commit":"%s","deployed_at":"%s"}\n' "$COMMIT" "$(date -Is)" > "$TARGET/version.json"
rm -f /tmp/dashboard-deploy.tar.gz

# Companion service plus the isolated one-click updater. The browser-facing
# update API runs as www-data and can only create a request file. A root-owned
# systemd path/service performs the actual release swap with rollback.
install -m 0644 "$TARGET/deploy/owntone-dashboard-scheduler.service" \
  /etc/systemd/system/owntone-dashboard-scheduler.service
install -m 0644 "$TARGET/deploy/owntone-dashboard-update-api.service" \
  /etc/systemd/system/owntone-dashboard-update-api.service
install -m 0644 "$TARGET/deploy/owntone-dashboard-updater.service" \
  /etc/systemd/system/owntone-dashboard-updater.service
install -m 0644 "$TARGET/deploy/owntone-dashboard-updater.path" \
  /etc/systemd/system/owntone-dashboard-updater.path
install -m 0755 "$TARGET/deploy/update-dashboard.sh" /usr/local/sbin/owntone-dashboard-update

systemctl daemon-reload
systemctl enable owntone-dashboard-scheduler.service >/dev/null 2>&1 || true
systemctl enable owntone-dashboard-update-api.service >/dev/null 2>&1 || true
systemctl enable owntone-dashboard-updater.path >/dev/null 2>&1 || true
systemctl restart owntone-dashboard-scheduler.service
systemctl restart owntone-dashboard-update-api.service
systemctl restart owntone-dashboard-updater.path

NGINX_SITE="/etc/nginx/sites-available/owntone-dashboard"
if ! cmp -s "$TARGET/deploy/nginx.conf" "$NGINX_SITE"; then
  [ -f "$NGINX_SITE" ] && cp "$NGINX_SITE" "$NGINX_SITE.bak"
  cp "$TARGET/deploy/nginx.conf" "$NGINX_SITE"
  if ! nginx -t; then
    [ -f "$NGINX_SITE.bak" ] && cp "$NGINX_SITE.bak" "$NGINX_SITE"
    echo "nginx -t failed; restored previous site config" >&2
    exit 1
  fi
  systemctl reload nginx
fi

# systemctl restart returns before sockets are bound, so poll both local APIs.
for attempt in 1 2 3 4 5 6 7 8; do
  sleep 1
  if curl -fsS -m5 http://127.0.0.1:3691/health \
      | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") else 1)' \
    && curl -fsS -m5 http://127.0.0.1:3692/health \
      | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") else 1)'; then
    break
  fi
  if [ "$attempt" = 8 ]; then
    echo "dashboard service health check failed" >&2
    systemctl status --no-pager owntone-dashboard-scheduler.service >&2 || true
    systemctl status --no-pager owntone-dashboard-update-api.service >&2 || true
    exit 1
  fi
done

curl -fsS -m5 -o /dev/null http://127.0.0.1:3690/
curl -fsS -m5 -o /dev/null http://127.0.0.1:3690/updater/status
echo "BUILD: $(grep -o "BUILD = '[^']*'" "$TARGET/config.js" || echo '?')  commit: $COMMIT"
REMOTE

echo "==> Deploy done ($COMMIT)"
