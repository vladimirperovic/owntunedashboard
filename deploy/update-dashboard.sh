#!/usr/bin/env bash
# Common installer for GitHub updates and manual deployment archives.
# Both transports use this lock, validation, activation and recovery path.
set -Eeuo pipefail

TARGET="${OWNTONE_DASHBOARD_TARGET:-/opt/owntone-dashboard}"
STATE_DIR="${OWNTONE_DASHBOARD_STATE:-/var/lib/owntone-dashboard}"
REQUEST_FILE="$STATE_DIR/update.request"
RUNNING_FILE="$STATE_DIR/update-running.json"
RESULT_FILE="$STATE_DIR/update-result.json"
BACKUP_DIR="${TARGET}.rollback"
SITE_DIR="${OWNTONE_SITE_DIR:-/etc/owntone-dashboard}"
ARCHIVE=""
COMMIT=""
if [ "$#" != 0 ]; then
  if [ "$#" != 3 ] || [ "$1" != --archive ] || [[ ! "$3" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'Usage: update-dashboard.sh [--archive /absolute/release.tar.gz FULL_SHA]' >&2
    exit 1
  fi
  ARCHIVE="$2"
  COMMIT="$3"
  [[ "$ARCHIVE" = /* && -f "$ARCHIVE" ]] || { echo 'Archive must be an absolute file path' >&2; exit 1; }
fi
REPO_API="https://api.github.com/repos/vladimirperovic/owntunedashboard"
REPO_ARCHIVE="https://github.com/vladimirperovic/owntunedashboard/archive"
# Overrides also let the integration harness isolate every privileged output.
SYSTEMD_DIR="${OWNTONE_SYSTEMD_DIR:-/etc/systemd/system}"
NGINX_SITE="${OWNTONE_NGINX_SITE:-/etc/nginx/sites-available/owntone-dashboard}"
UPDATER_BIN="${OWNTONE_UPDATER_BIN:-/usr/local/sbin/owntone-dashboard-update}"
LOCK_FILE="${OWNTONE_UPDATE_LOCK:-/run/owntone-dashboard-update.lock}"

# Never rename a symlink or a filesystem root; require a canonical live tree.
python3 - "$TARGET" "$STATE_DIR" "$SITE_DIR" <<'CHECK'
import re
import sys
from pathlib import Path
p = Path(sys.argv[1])
if not p.is_absolute() or p == Path('/') or str(p.resolve()) != sys.argv[1] or (p.exists() and not p.is_dir()):
    raise SystemExit("TARGET must be a canonical directory, not a symlink")
for raw in sys.argv[1:]:
    path = Path(raw)
    if not re.fullmatch(r"/[A-Za-z0-9/._-]+", raw) or str(path.resolve()) != raw:
        raise SystemExit("Installer paths must be canonical absolute paths without whitespace")
for raw in sys.argv[2:]:
    path = Path(raw)
    for release in (p, Path(str(p) + ".rollback")):
        if path == release or release in path.parents or path in release.parents:
            raise SystemExit("State and site storage must be separate from live and rollback trees")
CHECK
# The lock lives outside the www-data-writable state directory. flock(2) is
# retained by this shell's inherited open file description after Python exits.
exec 9>"$LOCK_FILE"
python3 - <<'LOCK'
import fcntl
try:
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit("Another dashboard update is active")
LOCK

# Stage next to TARGET so both renames stay on one filesystem.
mkdir -p "$(dirname "$TARGET")"
TMP="$(mktemp -d "$(dirname "$TARGET")/.dashboard-update.XXXXXX")"
BACKED_UP=0
CONFIG_CHANGED=0
FINISHED=0
ACTIVATED=0
ENABLED_UNITS=()

cleanup() {
  rm -rf "$TMP"
}

write_json() {
  local path="$1" status="$2" message="$3" commit="${4:-}"
  python3 - "$path" "$status" "$message" "$commit" <<'PY'
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

path, status, message, commit = sys.argv[1:5]
payload = {
    "status": status,
    "message": message,
    "commit": commit,
    "at": datetime.now(timezone.utc).astimezone().isoformat(),
}
fd, tmp = tempfile.mkstemp(prefix=".update-", dir=os.path.dirname(path))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
        handle.write("\n")
        os.fchmod(handle.fileno(), 0o644)
    os.replace(tmp, path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PY
}

PRESERVED_CONFIG=()
should_preserve() {
  local path
  for path in "${PRESERVED_CONFIG[@]-}"; do
    if [ "$path" = "$1" ]; then return 0; fi
  done
  return 1
}

install_units_from() {
  local root="$1" unit dest
  for unit in owntone-dashboard-scheduler.service owntone-dashboard-update-api.service \
      owntone-dashboard-updater.service owntone-dashboard-updater.path; do
    dest="$SYSTEMD_DIR/$unit"
    if ! should_preserve "$dest"; then
      install -m 0644 "$root/deploy/$unit" "$dest"
    fi
  done
}

CONFIG_PATHS=(
  "$SYSTEMD_DIR/owntone-dashboard-scheduler.service"
  "$SYSTEMD_DIR/owntone-dashboard-update-api.service"
  "$SYSTEMD_DIR/owntone-dashboard-updater.service"
  "$SYSTEMD_DIR/owntone-dashboard-updater.path"
  "$NGINX_SITE"
  "$UPDATER_BIN"
)

snapshot_config() {
  local i baseline
  mkdir "$TMP/config"
  for i in "${!CONFIG_PATHS[@]}"; do
    if [ -e "${CONFIG_PATHS[$i]}" ] || [ -L "${CONFIG_PATHS[$i]}" ]; then
      cp -a "${CONFIG_PATHS[$i]}" "$TMP/config/$i"
      if [ "${CONFIG_PATHS[$i]}" != "$UPDATER_BIN" ]; then
        baseline="$TARGET/deploy/${CONFIG_PATHS[$i]##*/}"
        if [ "${CONFIG_PATHS[$i]}" = "$NGINX_SITE" ]; then baseline="$TARGET/deploy/nginx.conf"; fi
        # Compare with the previous release, not the incoming defaults. Keep
        # local service settings and nginx routing across successful updates.
        if [ -L "${CONFIG_PATHS[$i]}" ] || ! cmp -s "${CONFIG_PATHS[$i]}" "$baseline"; then
          PRESERVED_CONFIG+=("${CONFIG_PATHS[$i]}")
          echo "Preserving local configuration: ${CONFIG_PATHS[$i]}" >&2
        fi
      fi
    fi
  done
}

rollback() {
  local i unit failed=0
  if [ "$BACKED_UP" = 1 ]; then
    rm -rf "$TARGET" || return 1
    mv "$BACKUP_DIR" "$TARGET" || return 1
  elif [ "$ACTIVATED" = 1 ]; then
    rm -rf "$TARGET" || return 1
  fi
  for unit in "${ENABLED_UNITS[@]-}"; do
    [ -z "$unit" ] || systemctl disable "$unit" || failed=1
  done
  if [ "$CONFIG_CHANGED" = 1 ]; then
    for i in "${!CONFIG_PATHS[@]}"; do
      rm -f "${CONFIG_PATHS[$i]}" || failed=1
      if [ -e "$TMP/config/$i" ] || [ -L "$TMP/config/$i" ]; then
        cp -a "$TMP/config/$i" "${CONFIG_PATHS[$i]}" || failed=1
      fi
    done
    systemctl daemon-reload || failed=1
    if nginx -t; then
      systemctl reload nginx || failed=1
    else
      failed=1
    fi
    if [ "$BACKED_UP" = 1 ]; then
      systemctl restart owntone-dashboard-scheduler.service || failed=1
      systemctl restart owntone-dashboard-update-api.service || failed=1
      systemctl restart owntone-dashboard-updater.path || failed=1
    else
      systemctl stop owntone-dashboard-scheduler.service || failed=1
      systemctl stop owntone-dashboard-update-api.service || failed=1
      systemctl stop owntone-dashboard-updater.path || failed=1
    fi
  fi
  return "$failed"
}

on_exit() {
  local code=$? message="Update failed before activation; previous release unchanged"
  trap - EXIT HUP INT TERM
  if [ "$code" != 0 ] && [ "$FINISHED" != 1 ]; then
    if rollback; then
      if [ "$BACKED_UP" = 1 ]; then
        message="Update failed; previous release and installed configuration restored"
      fi
    else
      message="Update failed; rollback incomplete, manual recovery required"
    fi
    write_json "$RESULT_FILE" "error" "$message" "$COMMIT" || true
    rm -f "$RUNNING_FILE" "$REQUEST_FILE"
  fi
  cleanup
  exit "$code"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$STATE_DIR"
# StateDirectory= handles the standard path; explicitly provision custom paths.
if [ "$(id -u)" = 0 ]; then
  chown www-data:www-data "$STATE_DIR"
  chmod 0755 "$STATE_DIR"
fi
write_json "$RUNNING_FILE" "running" "Preparing dashboard release" "$COMMIT"
rm -f "$REQUEST_FILE"

if [ -z "$ARCHIVE" ]; then
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
import re
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
commit = payload.get("sha") if isinstance(payload, dict) else None
if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
    raise SystemExit("GitHub returned an invalid commit SHA")
print(commit)
PY
)"

fi

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

if [ -z "$ARCHIVE" ] && [[ "$CURRENT" =~ ^[0-9a-f]{7,40}$ ]] && [[ "$COMMIT" == "$CURRENT"* ]]; then
  write_json "$RESULT_FILE" "success" "Already on latest main" "$COMMIT"
  rm -f "$RUNNING_FILE"
  exit 0
fi

if [ -z "$ARCHIVE" ]; then
python3 - "$REPO_ARCHIVE/$COMMIT.tar.gz" "$TMP/main.tar.gz" <<'PY'
import sys
from urllib.request import Request, urlopen

url, target = sys.argv[1:3]
request = Request(url, headers={"User-Agent": "OwnToneDashboardUpdater/1.0"})
with urlopen(request, timeout=45) as response, open(target, "wb") as handle:
    total = 0
    while True:
        chunk = response.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > 128 * 1024 * 1024:
            raise SystemExit("Release download exceeds 128 MiB")
        handle.write(chunk)
PY

else
  [ "$(wc -c < "$ARCHIVE")" -le 134217728 ] || { echo 'Release archive exceeds 128 MiB' >&2; exit 1; }
  cp "$ARCHIVE" "$TMP/main.tar.gz"
fi

# Validate the complete member list before extracting anything as root. Git
# archives need only regular files and directories, never links or devices.
SOURCE="$TMP/owntunedashboard-$COMMIT"
python3 - "$TMP/main.tar.gz" "$TMP" "owntunedashboard-$COMMIT" <<'ARCHIVE'
import sys
import tarfile
from pathlib import PurePosixPath
archive, target, expected = sys.argv[1:]
with tarfile.open(archive, "r:gz") as tar:
    members = []
    total = 0
    seen = set()
    for member in tar:
        path = PurePosixPath(member.name)
        total += member.size
        if (path.is_absolute() or ".." in path.parts or not path.parts
                or path.parts[0] != expected or not (member.isfile() or member.isdir())
                or path in seen or total > 512 * 1024 * 1024 or len(members) >= 20000):
            raise SystemExit(f"Unsafe or oversized archive member: {member.name}")
        seen.add(path)
        members.append(member)
    tar.extractall(target, members=members)
ARCHIVE

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
  deploy/site_config.py \
  site-config.json \
  deploy/update-dashboard.sh; do
  [ -f "$SOURCE/$required" ] || { echo "Missing $required" >&2; exit 1; }
done

python3 - "$SOURCE/scheduler/scheduler_server.py" "$SOURCE/deploy/update_server.py" <<'COMPILE'
import sys
from pathlib import Path
for filename in sys.argv[1:]:
    compile(Path(filename).read_bytes(), filename, "exec")
COMPILE

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
printf '{"commit":"%s","deployed_at":"%s"}\n' "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SOURCE/version.json"

# Migration occurs under the same installer lock. Operator data lives outside
# TARGET and survives release replacement; new release links expose only public
# JSON and artwork, never service environment files.
python3 "$SOURCE/deploy/site_config.py" "$SOURCE" "$TARGET" "$SITE_DIR"

# Render shipped service paths for custom installations. Local overrides stay
# outside the release in optional EnvironmentFiles or systemd drop-ins.
python3 - "$SOURCE/deploy" "$TARGET" "$STATE_DIR" "$SITE_DIR" "$UPDATER_BIN" <<'RENDER'
import sys
from pathlib import Path
root, target, state, site, updater = sys.argv[1:]
for path in Path(root).iterdir():
    if path.suffix in {".service", ".path"} or path.name == "nginx.conf":
        text = path.read_text().replace("/opt/owntone-dashboard", target)
        text = text.replace("/var/lib/owntone-dashboard", state)
        text = text.replace("/etc/owntone-dashboard", site)
        text = text.replace("/usr/local/sbin/owntone-dashboard-update", updater)
        if path.name == "owntone-dashboard-updater.service":
            settings = {"OWNTONE_DASHBOARD_TARGET": target, "OWNTONE_DASHBOARD_STATE": state,
                        "OWNTONE_SITE_DIR": site}
            lines = "".join(f"Environment={key}={value}\n" for key, value in settings.items())
            text = text.replace("EnvironmentFile=", lines + "EnvironmentFile=", 1)
        path.write_text(text)
RENDER
mkdir -p "$SYSTEMD_DIR" "$(dirname "$NGINX_SITE")" "$(dirname "$UPDATER_BIN")"
snapshot_config
rm -rf "$BACKUP_DIR"
if [ -d "$TARGET" ]; then
  mv "$TARGET" "$BACKUP_DIR"
  BACKED_UP=1
fi
mv "$SOURCE" "$TARGET"
ACTIVATED=1
CONFIG_CHANGED=1

# Do not follow pre-existing configuration symlinks when installing new files.
for path in "${CONFIG_PATHS[@]}"; do
  if [ -L "$path" ] && ! should_preserve "$path"; then rm -f "$path"; fi
done
# Unlink before replacing the helper, which may be this running shell script.
rm -f "$UPDATER_BIN"
install -m 0755 "$TARGET/deploy/update-dashboard.sh" "$UPDATER_BIN"
install_units_from "$TARGET"

if ! should_preserve "$NGINX_SITE" && ! cmp -s "$TARGET/deploy/nginx.conf" "$NGINX_SITE"; then
  cp "$TARGET/deploy/nginx.conf" "$NGINX_SITE"
  nginx -t
  systemctl reload nginx
fi

systemctl daemon-reload
systemctl restart owntone-dashboard-scheduler.service
systemctl restart owntone-dashboard-update-api.service
systemctl restart owntone-dashboard-updater.path

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fsS -m4 http://127.0.0.1:3691/health \
      | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") is True else 1)' \
    && curl -fsS -m4 http://127.0.0.1:3692/health \
      | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") is True else 1)'; then
    break
  fi
  if [ "$attempt" = 10 ]; then
    echo "Dashboard services health check failed after update" >&2
    # Exit handling restores the release and installed configuration.
    false
  fi
done

for unit in owntone-dashboard-scheduler.service owntone-dashboard-update-api.service owntone-dashboard-updater.path; do
  if ! systemctl is-enabled "$unit" >/dev/null 2>&1; then
    ENABLED_UNITS+=("$unit")
    systemctl enable "$unit"
  fi
done
MESSAGE="Dashboard updated from GitHub main"
if [ -n "$ARCHIVE" ]; then MESSAGE="Dashboard updated from supplied release archive"; fi
if [ "${#PRESERVED_CONFIG[@]}" != 0 ]; then
  MESSAGE="$MESSAGE; local service/nginx configuration preserved (review new defaults manually)"
fi
write_json "$RESULT_FILE" "success" "$MESSAGE" "$COMMIT"
rm -f "$RUNNING_FILE" "$REQUEST_FILE"
FINISHED=1
