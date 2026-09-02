#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
TARGET="$TMP_ROOT/live"
STATE_DIR="$TMP_ROOT/state"
FAKE_BIN="$TMP_ROOT/fake-bin"
SYSTEMD_FILES=(
  /etc/systemd/system/owntone-dashboard-scheduler.service
  /etc/systemd/system/owntone-dashboard-update-api.service
  /etc/systemd/system/owntone-dashboard-updater.service
  /etc/systemd/system/owntone-dashboard-updater.path
)

cleanup() {
  rm -rf "$TMP_ROOT"
  rm -f "${SYSTEMD_FILES[@]}" /usr/local/sbin/owntone-dashboard-update
  rm -f /etc/nginx/sites-available/owntone-dashboard
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN" /etc/nginx/sites-available

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$FAKE_BIN/nginx" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$FAKE_BIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
if [ "${FAKE_HEALTH:-success}" = "success" ]; then
  printf '{}\n'
  exit 0
fi
exit 22
EOF

chmod 0755 "$FAKE_BIN/systemctl" "$FAKE_BIN/nginx" "$FAKE_BIN/sleep" "$FAKE_BIN/curl"

seed_old_release() {
  rm -rf "$TARGET" "${TARGET}.rollback" "$STATE_DIR"
  mkdir -p "$TARGET" "$STATE_DIR"
  printf '{"commit":"old-release"}\n' > "$TARGET/version.json"
  printf 'known-good\n' > "$TARGET/known-good.txt"
}

run_update() {
  local health="$1"
  env \
    OWNTONE_DASHBOARD_TARGET="$TARGET" \
    OWNTONE_DASHBOARD_STATE="$STATE_DIR" \
    FAKE_HEALTH="$health" \
    PATH="$FAKE_BIN:$PATH" \
    bash "$ROOT/deploy/update-dashboard.sh"
}

assert_successful_update() {
  python3 - "$TARGET/version.json" "$STATE_DIR/update-result.json" <<'PY'
import json
import sys

version_path, result_path = sys.argv[1:3]
with open(version_path, encoding="utf-8") as handle:
    version = json.load(handle)
with open(result_path, encoding="utf-8") as handle:
    result = json.load(handle)

commit = str(version.get("commit", ""))
assert commit and commit != "old-release", version
assert result.get("status") == "success", result
assert result.get("commit") == commit, (result, version)
PY
  test -f "$TARGET/index.html"
  test -f "$TARGET/dashboard-update.js"
  test -f "${TARGET}.rollback/known-good.txt"
  test ! -e "$STATE_DIR/update-running.json"
  test ! -e "$STATE_DIR/update.request"
}

assert_rollback() {
  test -f "$TARGET/known-good.txt"
  grep -q 'old-release' "$TARGET/version.json"
  python3 - "$STATE_DIR/update-result.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    result = json.load(handle)
assert result.get("status") == "error", result
assert "restored" in str(result.get("message", "")).lower(), result
PY
  test ! -e "$STATE_DIR/update-running.json"
  test ! -e "$STATE_DIR/update.request"
}

printf 'Updater integration: successful GitHub-main install...\n'
seed_old_release
run_update success
assert_successful_update

printf 'Updater integration: failed health check rolls back...\n'
seed_old_release
if run_update fail; then
  printf 'Expected updater failure did not occur\n' >&2
  exit 1
fi
assert_rollback

printf 'Updater integration: PASS\n'
