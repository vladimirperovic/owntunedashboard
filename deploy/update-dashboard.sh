#!/usr/bin/env bash
# Root-only helper used by owntone-dashboard-updater.service.
# It installs the latest public GitHub main branch, verifies the dashboard
# services come back, and restores the previous release if anything fails.
set -Eeuo pipefail

TARGET="${OWNTONE_DASHBOARD_TARGET:-/opt/owntone-dashboard}"
STATE_DIR="${OWNTONE_DASHBOARD_STATE:-/var/lib/owntone-dashboard}"
REQUEST_FILE="$STATE_DIR/update.request"
RUNNING_FILE="$STATE_DIR/update-running.json"
RESULT_FILE="$STATE_DIR/update-result.json"
BACKUP_DIR="${TARGET}.rollback"
REPO_API="https://api.github.com/repos/vladimirperovic/owntunedashboard"
REPO_ARCHIVE="https://github.com/vladimirperovic/owntunedashboard/archive"
TMP="$(mktemp -d)"
SWAPPED=0
COMMIT=""

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

write_json() {
  local path="$1" status="$2" message="$3" commit="${4:-}"
  python3 - "$path" "$status" "$message" "$commit" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, status, message, commit = sys.argv[1:5]
payload = {
    "status": status,
    "message": message,
    "commit": commit,
    "at": datetime.now(timezone.utc).astimezone().isoformat(),
}
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False)
    handle.write("\n")
os.replace(tmp, path)
os.chmod(path, 0o644)
PY
}

install_units_from() {
  local root="$1"
  install -m 0644 "$root/deploy/owntone-dashboard-scheduler.service" \
    /etc/systemd/system/owntone-dashboard-scheduler.service
  install -m 0644 "$root/deploy/owntone-dashboard-update-api.service" \
    /etc/systemd/system/owntone-dashboard-update-api.service
  install -m 0644 "$root/deploy/owntone-dashboard-updater.service" \
    /etc/systemd/system/owntone-dashboard-updater.service
  install -m 0644 "$root/deploy/owntone-dashboard-updater.path" \
    /etc/systemd/system/owntone-dashboard-updater.path
}

rollback() {
  if [ "$SWAPPED" != 1 ] || [ ! -d "$BACKUP_DIR" ]; then
    return
  fi
  rm -rf "$TARGET"
  mv "$BACKUP_DIR" "$TARGET"
  install_units_from "$TARGET" || true
  if [ -f "$TARGET/deploy/nginx.conf" ]; then
    cp "$TARGET/deploy/nginx.conf" /etc/nginx/sites-available/owntone-dashboard
  fi
  systemctl daemon-reload || true
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx || true
  fi
  systemctl restart owntone-dashboard-scheduler.service || true
  systemctl restart owntone-dashboard-update-api.service || true
}

on_error() {
  local code=$?
  local line="${BASH_LINENO[0]:-?}"
  trap - ERR
  rollback
  write_json "$RESULT_FILE" "error" "Update failed near line $line; previous release restored" "$COMMIT" || true
  rm -f "$RUNNING_FILE" "$REQUEST_FILE"
  exit "$code"
}
trap on_error ERR

mkdir -p "$STATE_DIR"
rm -f "$REQUEST_FILE"
write_json "$RUNNING_FILE" "running" "Downloading latest main" ""

python3 - "$REPO_API/commits/main" "$TMP/commit.json" <<'PY'
import sys
from urllib.request import Request, urlopen

url, target = sys.argv[1:3]
request = Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "OwnToneDashboardUpdater/1.0"})
with urlopen(request, timeout=20) as response, open(target, "wb") as handle:
    handle.write(response.read())
PY
COMMIT="$(python3 - "$TMP/commit.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle)["sha"])
PY
)"

CURRENT=""
if [ -f "$TARGET/version.json" ]; then
  CURRENT="$(python3 - "$TARGET/version.json" <<'PY' || true
import json
import sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        print(json.load(handle).get("commit", ""))
except Exception:
    pass
PY
)"
fi

if [ -n "$CURRENT" ] && { [ "$CURRENT" = "$COMMIT" ] || [ "$CURRENT" = "${COMMIT:0:7}" ]; }; then
  write_json "$RESULT_FILE" "success" "Already on latest main" "$COMMIT"
  rm -f "$RUNNING_FILE"
  exit 0
fi

python3 - "$REPO_ARCHIVE/$COMMIT.tar.gz" "$TMP/main.tar.gz" <<'PY'
import sys
from urllib.request import Request, urlopen

url, target = sys.argv[1:3]
request = Request(url, headers={"User-Agent": "OwnToneDashboardUpdater/1.0"})
with urlopen(request, timeout=45) as response, open(target, "wb") as handle:
    while True:
        chunk = response.read(1024 * 1024)
        if not chunk:
            break
        handle.write(chunk)
PY

tar xzf "$TMP/main.tar.gz" -C "$TMP"
SOURCE="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d -name 'owntunedashboard-*' -print -quit)"
[ -n "$SOURCE" ]

for required in \
  index.html \
  config.js \
  app.js \
  shared.js \
  scheduler/scheduler_server.py \
  deploy/nginx.conf \
  deploy/owntone-dashboard-scheduler.service \
  deploy/owntone-dashboard-update-api.service \
  deploy/owntone-dashboard-updater.service \
  deploy/owntone-dashboard-updater.path \
  deploy/update_server.py \
  deploy/update-dashboard.sh; do
  [ -f "$SOURCE/$required" ] || { echo "Missing $required" >&2; exit 1; }
done

python3 -m py_compile "$SOURCE/scheduler/scheduler_server.py" "$SOURCE/deploy/update_server.py"

# Validate every dynamically loaded local asset before touching the live tree.
python3 - "$SOURCE" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
text = (root / "config.js").read_text(encoding="utf-8")
for name in re.findall(r"['\"]([A-Za-z0-9_.-]+\.(?:css|js))['\"]", text):
    if not (root / name).is_file():
        raise SystemExit(f"config.js references missing asset: {name}")
PY

find "$SOURCE" -type d -exec chmod 0755 {} +
find "$SOURCE" -type f -exec chmod 0644 {} +
chmod 0755 "$SOURCE/deploy/update-dashboard.sh"
printf '{"commit":"%s","deployed_at":"%s"}\n' "$COMMIT" "$(date -Is)" > "$SOURCE/version.json"

rm -rf "$BACKUP_DIR"
mv "$TARGET" "$BACKUP_DIR"
mv "$SOURCE" "$TARGET"
SWAPPED=1

install -m 0755 "$TARGET/deploy/update-dashboard.sh" /usr/local/sbin/owntone-dashboard-update
install_units_from "$TARGET"

NGINX_SITE="/etc/nginx/sites-available/owntone-dashboard"
if ! cmp -s "$TARGET/deploy/nginx.conf" "$NGINX_SITE"; then
  cp "$TARGET/deploy/nginx.conf" "$NGINX_SITE"
  nginx -t
  systemctl reload nginx
fi

systemctl daemon-reload
systemctl enable owntone-dashboard-updater.path >/dev/null 2>&1 || true
systemctl enable owntone-dashboard-update-api.service >/dev/null 2>&1 || true
systemctl restart owntone-dashboard-scheduler.service
systemctl restart owntone-dashboard-update-api.service

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fsS -m4 http://127.0.0.1:3691/health >/dev/null \
    && curl -fsS -m4 http://127.0.0.1:3692/health >/dev/null; then
    break
  fi
  if [ "$attempt" = 10 ]; then
    echo "Dashboard services health check failed after update" >&2
    # Trigger ERR so the installed tree is atomically rolled back.
    false
  fi
done

write_json "$RESULT_FILE" "success" "Dashboard updated from GitHub main" "$COMMIT"
rm -f "$RUNNING_FILE" "$REQUEST_FILE"
SWAPPED=0
