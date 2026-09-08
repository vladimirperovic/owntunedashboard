#!/usr/bin/env bash
# Offline, non-root integration tests. Every output lives under TMP_ROOT and
# every network/service operation is replaced; safe even when CI uses sudo.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
cleanup() {
  local code=$?
  if [ "$code" != 0 ] && [ -f "$TMP_ROOT/output.log" ]; then cat "$TMP_ROOT/output.log" >&2; fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT
export TEST_ROOT="$TMP_ROOT"
export OWNTONE_DASHBOARD_TARGET="$TMP_ROOT/live"
export OWNTONE_DASHBOARD_STATE="$TMP_ROOT/state"
export OWNTONE_SYSTEMD_DIR="$TMP_ROOT/systemd"
export OWNTONE_NGINX_SITE="$TMP_ROOT/nginx/site"
export OWNTONE_UPDATER_BIN="$TMP_ROOT/sbin/updater"
export OWNTONE_SITE_DIR="$TMP_ROOT/site"
export OWNTONE_UPDATE_LOCK="$TMP_ROOT/update.lock"
export PYTHONDONTWRITEBYTECODE=1
export FAKE_COMMIT=abcdef0123456789abcdef0123456789abcdef01
TARGET="$OWNTONE_DASHBOARD_TARGET"
STATE_DIR="$OWNTONE_DASHBOARD_STATE"
mkdir -p "$TMP_ROOT/fake-bin" "$TMP_ROOT/python" "$TMP_ROOT/fixtures"

# Exercise the real Python download code against fixture responses. Fail closed
# for any unexpected URL; prevent accidental network use by any Python child.
cat > "$TMP_ROOT/python/sitecustomize.py" <<'PY'
import os
import socket
import urllib.request
from pathlib import Path

root = Path(os.environ["TEST_ROOT"])
def offline_urlopen(request, **kwargs):
    if os.environ.get("LOCAL_ONLY") == "1":
        raise RuntimeError("Manual installer must not contact GitHub")
    url = request.full_url
    if url == "https://api.github.com/repos/vladimirperovic/owntunedashboard/commits/main":
        return (root / "commit.json").open("rb")
    expected = "https://github.com/vladimirperovic/owntunedashboard/archive/" + os.environ["FAKE_COMMIT"] + ".tar.gz"
    if url == expected:
        return (root / "fixtures" / (os.environ["FAKE_ARCHIVE"] + ".tar.gz")).open("rb")
    raise RuntimeError("Unexpected network request: " + url)
def no_network(*args, **kwargs):
    raise RuntimeError("Network disabled in updater integration tests")
urllib.request.urlopen = offline_urlopen
socket.socket.connect = no_network
socket.create_connection = no_network
PY
export PYTHONPATH="$TMP_ROOT/python"

# Resolve real file-operation tools before adding failure-injection wrappers.
REAL_MV="$(command -v mv)"
REAL_INSTALL="$(command -v install)"
export REAL_MV REAL_INSTALL
cat > "$TMP_ROOT/fake-bin/command-stub" <<'STUB'
#!/usr/bin/env bash
set -eu
name="${0##*/}"
printf '%s %s\n' "$name" "$*" >> "$TEST_ROOT/commands.log"
case "$name" in
  systemctl)
    if [ "${FAIL_MODE:-}" = restart ] && [ "$1" = restart ] && [ ! -e "$TEST_ROOT/failed-once" ]; then
      touch "$TEST_ROOT/failed-once"
      exit 1
    fi
    if [ "${FAIL_MODE:-}" = recovery ] && [ "$1" = restart ]; then exit 1; fi
    ;;
  nginx)
    if [ "${FAIL_MODE:-}" = nginx ] && ! cmp -s "$OWNTONE_NGINX_SITE" "$TEST_ROOT/original/nginx"; then exit 1; fi
    ;;
  curl)
    case "${FAIL_MODE:-}" in
      health) exit 22 ;;
      false-health) printf '{"ok":false}\n' ;;
      empty-health) printf '{}\n' ;;
      *) printf '{"ok":true}\n' ;;
    esac
    ;;
  sleep) ;;
  mv)
    if [[ "$1" == */owntunedashboard-* ]] && [ "$2" = "$OWNTONE_DASHBOARD_TARGET" ]; then
      case "${FAIL_MODE:-}" in
        swap) exit 1 ;;
        signal) kill -TERM "$PPID"; exit 1 ;;
      esac
    fi
    exec "$REAL_MV" "$@"
    ;;
  install)
    if [ "${FAIL_MODE:-}" = install ] && [ ! -e "$TEST_ROOT/failed-once" ]; then
      touch "$TEST_ROOT/failed-once"
      exit 1
    fi
    exec "$REAL_INSTALL" "$@"
    ;;
  *) echo "Unexpected command $name" >&2; exit 1 ;;
esac
STUB
chmod 0755 "$TMP_ROOT/fake-bin/command-stub"
for command in systemctl nginx curl sleep mv install; do
  ln -s command-stub "$TMP_ROOT/fake-bin/$command"
done
export PATH="$TMP_ROOT/fake-bin:$PATH"

python3 - "$ROOT" <<'PY'
import io
import os
import tarfile
from pathlib import Path
root = Path(os.environ["TEST_ROOT"])
repo = Path(__import__('sys').argv[1])
prefix = "owntunedashboard-" + os.environ["FAKE_COMMIT"]
files = {"index.html": b"new dashboard", "config.js": b"window.OWNTONE_DASHBOARD = {manualVolume:50, radioArtwork:{}}; const assets = ['feature.js'];",
         "site-config.json": b"{}",
         "feature.js": b"// feature", "app.js": b"// app", "shared.js": b"// shared",
         "scheduler/scheduler_server.py": b"# scheduler"}
for path in (repo / "deploy").iterdir():
    if path.name in {"nginx.conf", "update_server.py", "update-dashboard.sh", "site_config.py"} or path.suffix in {".service", ".path"}:
        files["deploy/" + path.name] = path.read_bytes()
for variant in ("good", "missing", "syntax", "asset", "traversal", "symlink", "hardlink", "fifo"):
    data = dict(files)
    if variant == "missing": del data["index.html"]
    if variant == "syntax": data["deploy/update_server.py"] = b"invalid python !"
    if variant == "asset": del data["feature.js"]
    with tarfile.open(root / "fixtures" / (variant + ".tar.gz"), "w:gz") as tar:
        for name, content in data.items():
            member = tarfile.TarInfo(prefix + "/" + name)
            member.size = len(content)
            tar.addfile(member, io.BytesIO(content))
        if variant in {"traversal", "symlink", "hardlink", "fifo"}:
            member = tarfile.TarInfo(prefix + "/unsafe")
            if variant == "traversal": member.name = prefix + "/../../escaped"
            if variant == "symlink": member.type = tarfile.SYMTYPE; member.linkname = str(root / "victim")
            if variant == "hardlink": member.type = tarfile.LNKTYPE; member.linkname = str(root / "victim")
            if variant == "fifo": member.type = tarfile.FIFOTYPE
            tar.addfile(member)
PY

seed_old_release() {
  rm -rf "$TARGET" "${TARGET}.rollback" "$STATE_DIR" "$TMP_ROOT/systemd" "$TMP_ROOT/original" "$TMP_ROOT/nginx" "$TMP_ROOT/sbin" "$OWNTONE_SITE_DIR"
  rm -f "$TMP_ROOT/failed-once" "$TMP_ROOT/commands.log"
  mkdir -p "$TARGET" "$STATE_DIR" "$TMP_ROOT/systemd" "$TMP_ROOT/nginx" "$TMP_ROOT/sbin" "$TMP_ROOT/original"
  printf '{"commit":"1111111111111111111111111111111111111111"}\n' > "$TARGET/version.json"
  printf 'known-good\n' > "$TARGET/known-good.txt"
  for unit in owntone-dashboard-scheduler.service owntone-dashboard-update-api.service owntone-dashboard-updater.service owntone-dashboard-updater.path; do
    printf 'locally configured %s\n' "$unit" > "$TMP_ROOT/systemd/$unit"
  done
  printf 'original nginx config\n' > "$OWNTONE_NGINX_SITE"
  printf 'original installed updater\n' > "$OWNTONE_UPDATER_BIN"
  chmod 0755 "$OWNTONE_UPDATER_BIN"
  cp -a "$TMP_ROOT/systemd" "$TMP_ROOT/original/systemd"
  cp -p "$OWNTONE_NGINX_SITE" "$TMP_ROOT/original/nginx"
  cp -p "$OWNTONE_UPDATER_BIN" "$TMP_ROOT/original/updater"
  mkdir -p "$TARGET/deploy"
  cp "$TMP_ROOT/systemd/"* "$TARGET/deploy/"
  cp "$OWNTONE_NGINX_SITE" "$TARGET/deploy/nginx.conf"
  printf 'window.OWNTONE_DASHBOARD = {manualVolume:7, radioArtwork:{}};\n' > "$TARGET/config.js"
  printf '{"sha":"%s"}\n' "$FAKE_COMMIT" > "$TMP_ROOT/commit.json"
  printf 'do not overwrite\n' > "$TMP_ROOT/victim"
  ln -s "$TMP_ROOT/victim" "$STATE_DIR/update-running.json.tmp"
  ln -s "$TMP_ROOT/victim" "$STATE_DIR/update-result.json.tmp"
  ln -s "$TMP_ROOT/victim" "$STATE_DIR/update-running.json"
  ln -s "$TMP_ROOT/victim" "$STATE_DIR/update-result.json"
  printf '{}\n' > "$STATE_DIR/update.request"
  export FAIL_MODE="" FAKE_ARCHIVE=good LOCAL_ONLY=0
}

run_update() {
  if [ "${LOCAL_ONLY:-0}" = 1 ]; then
    bash "$ROOT/deploy/update-dashboard.sh" --archive "$TMP_ROOT/fixtures/$FAKE_ARCHIVE.tar.gz" "$FAKE_COMMIT" > "$TMP_ROOT/output.log" 2>&1
  else
    bash "$ROOT/deploy/update-dashboard.sh" > "$TMP_ROOT/output.log" 2>&1
  fi
}

assert_result() {
  python3 - "$1" "$2" <<'PY'
import json
import os
import sys
from pathlib import Path
root = Path(os.environ["TEST_ROOT"])
state = root / "state"
result = json.loads((state / "update-result.json").read_text())
assert result["status"] == sys.argv[1], result
assert sys.argv[2] in result["message"], result
assert not (state / "update-running.json").exists()
assert not (state / "update.request").exists()
assert (root / "victim").read_text() == "do not overwrite\n"
assert not (root / "escaped").exists()
assert not list(root.glob(".dashboard-update.*"))
PY
}

assert_old_release() {
  test -f "$TARGET/known-good.txt"
  test "$(cat "$TARGET/config.js")" = 'window.OWNTONE_DASHBOARD = {manualVolume:7, radioArtwork:{}};'
  diff -r "$TMP_ROOT/original/systemd" "$TMP_ROOT/systemd"
  cmp "$OWNTONE_NGINX_SITE" "$TMP_ROOT/original/nginx"
  cmp "$OWNTONE_UPDATER_BIN" "$TMP_ROOT/original/updater"
  test -x "$OWNTONE_UPDATER_BIN"
}

printf 'Updater integration: install and no-op...\n'
seed_old_release
if ! run_update; then cat "$TMP_ROOT/output.log"; exit 1; fi
assert_result success 'updated'
test -f "$TARGET/index.html"
test -f "${TARGET}.rollback/known-good.txt"
cmp "$TARGET/deploy/update-dashboard.sh" "$OWNTONE_UPDATER_BIN"
run_update
assert_result success 'Already'
for length in 7 8; do
  printf '{"commit":"%s"}\n' "${FAKE_COMMIT:0:$length}" > "$TARGET/version.json"
  run_update
  assert_result success 'Already'
done

printf 'Updater integration: preserve locally customized units and nginx...\n'
seed_old_release
printf 'custom unit with nondefault environment\n' > "$OWNTONE_SYSTEMD_DIR/owntone-dashboard-scheduler.service"
printf 'custom nginx root and port\n' > "$OWNTONE_NGINX_SITE"
cp "$OWNTONE_NGINX_SITE" "$TMP_ROOT/custom-nginx"
cp "$OWNTONE_SYSTEMD_DIR/owntone-dashboard-scheduler.service" "$TMP_ROOT/custom-unit"
run_update
assert_result success 'local service/nginx configuration preserved'
cmp "$OWNTONE_NGINX_SITE" "$TMP_ROOT/custom-nginx"
cmp "$OWNTONE_SYSTEMD_DIR/owntone-dashboard-scheduler.service" "$TMP_ROOT/custom-unit"

for failure in health false-health empty-health swap signal install nginx restart recovery; do
  printf 'Updater integration: failure %s...\n' "$failure"
  seed_old_release
  export FAIL_MODE="$failure"
  if run_update; then echo "Expected failure: $failure" >&2; exit 1; fi
  assert_old_release
  if [ "$failure" = recovery ]; then
    assert_result error 'rollback incomplete'
  else
    assert_result error 'restored'
  fi
done

for archive in missing syntax asset traversal symlink hardlink fifo; do
  printf 'Updater integration: reject archive %s...\n' "$archive"
  seed_old_release
  export FAKE_ARCHIVE="$archive"
  if run_update; then echo "Expected rejection: $archive" >&2; exit 1; fi
  assert_old_release
  assert_result error 'unchanged'
  test ! -e "$TMP_ROOT/commands.log"
done

printf 'Updater integration: reject invalid SHA...\n'
seed_old_release
printf '{"sha":"../../invalid"}\n' > "$TMP_ROOT/commit.json"
if run_update; then echo 'Expected invalid SHA rejection' >&2; exit 1; fi
assert_old_release
assert_result error 'unchanged'

printf 'Updater integration: concurrent invocation leaves active state alone...\n'
seed_old_release
python3 - "$ROOT/deploy/update-dashboard.sh" <<'PY'
import fcntl
import os
import subprocess
import sys
from pathlib import Path
with open(os.environ["OWNTONE_UPDATE_LOCK"], "w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    result = subprocess.run(["bash", sys.argv[1]], capture_output=True, text=True)
    assert result.returncode != 0, result
    assert "Another dashboard update is active" in result.stderr, result.stderr
    assert Path(os.environ["OWNTONE_DASHBOARD_STATE"], "update.request").exists()
PY
assert_old_release
printf 'Common installer: manual archive, migration, and rollback...\n'
for failure in '' health restart swap; do
  seed_old_release
  export LOCAL_ONLY=1 FAIL_MODE="$failure"
  mkdir -p "$TARGET/station-logos"
  printf 'local logo' > "$TARGET/station-logos/local.svg"
  printf 'window.OWNTONE_DASHBOARD = {manualVolume:7, radioArtwork:{Local:"station-logos/local.svg"}};\n' > "$TARGET/config.js"
  cp "$TARGET/config.js" "$TMP_ROOT/legacy-config"
  if [ -z "$failure" ]; then
    run_update
    assert_result success 'supplied release archive'
    test -L "$TARGET/site-config.json"
    test "$(cat "$TARGET/site-assets/local.svg")" = 'local logo'
    python3 -c 'import json,os; d=json.load(open(os.environ["OWNTONE_SITE_DIR"]+"/config.json")); assert d["manualVolume"]==7; assert d["radioArtwork"]["Local"]=="/site-assets/local.svg"'
    printf '{"manualVolume":3}\n' > "$OWNTONE_SITE_DIR/config.json"
    run_update
    assert_result success 'supplied release archive'
    test "$(cat "$TARGET/site-config.json")" = '{"manualVolume":3}'
  else
    if run_update; then echo 'Expected manual recovery' >&2; exit 1; fi
    assert_result error restored
    cmp "$TARGET/config.js" "$TMP_ROOT/legacy-config"
    test -f "$TARGET/known-good.txt"
    cmp "$OWNTONE_UPDATER_BIN" "$TMP_ROOT/original/updater"
  fi
done
printf 'Common installer: first install and failed first install...\n'
for failure in '' health; do
  seed_old_release
  rm -rf "$TARGET"
  export LOCAL_ONLY=1 FAIL_MODE="$failure"
  if [ -z "$failure" ]; then
    run_update
    assert_result success 'supplied release archive'
    test -L "$TARGET/site-config.json"
  else
    if run_update; then echo 'Expected first-install failure' >&2; exit 1; fi
    test ! -e "$TARGET"
    cmp "$OWNTONE_UPDATER_BIN" "$TMP_ROOT/original/updater"
  fi
done
printf 'Common installer: invalid site configuration refuses activation...\n'
seed_old_release
export LOCAL_ONLY=1
mkdir -p "$OWNTONE_SITE_DIR"
printf '{"manualVolume":101}\n' > "$OWNTONE_SITE_DIR/config.json"
if run_update; then echo 'Expected invalid site config rejection' >&2; exit 1; fi
assert_old_release
assert_result error unchanged
printf 'Deployment validation: unsafe paths/IDs fail before git or SSH...\n'
python3 - "$ROOT/deploy/deploy.sh" <<'VALIDATION'
import os
import subprocess
import sys
from pathlib import Path
root = Path(os.environ["TEST_ROOT"]) / "manual"
(root / "deploy").mkdir(parents=True)
(root / "bin").mkdir()
script = root / "deploy" / "deploy.sh"
script.write_text(Path(sys.argv[1]).read_text())
for name in ("git", "ssh", "scp"):
    stub = root / "bin" / name
    stub.write_text("#!/bin/sh\nexit 99\n")
    stub.chmod(0o755)
env = dict(os.environ, PATH=str(root / "bin") + ":" + os.environ["PATH"])
invalid_paths = ["/", "/opt", "/opt/..", "/opt/../etc", "/srv/a/../../etc", "/opt/./app",
                 "/opt//app", "/opt/app/", "/opt/app;id"]
cases = [(path, "123", 1) for path in invalid_paths]
cases += [("/opt/app", value, 1) for value in ("123;id", "-1")]
cases += [(path, "123", 99) for path in ("/opt/app", "/srv/app", "/usr/local/share/app")]
for target, container, expected in cases:
    (root / "deploy" / "deploy.local.conf").write_text(
        f"PROXMOX_TARGET='unused-host'\nLXC_ID='{container}'\nTARGET_DIR='{target}'\n")
    result = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True)
    assert result.returncode == expected, (target, container, result.returncode, result.stdout, result.stderr)
print(f"Deployment validation: {len(cases)} cases passed")
VALIDATION
printf 'Updater integration: PASS (GitHub and manual archive scenarios + 14 deployment argument cases)\n'
