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

# LXC_ID is interpolated into a remote shell command, not passed as argv.
case "$LXC_ID" in
  ''|*[!0-9]*) echo "LXC_ID must contain only digits" >&2; exit 1 ;;
esac

# The remote install replaces TARGET and its rollback tree; TARGET_DIR comes from a
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
  */../*|*/./*|*/..|*/.|*//*)
    echo "TARGET_DIR must not contain dot components or repeated slashes" >&2
    exit 1
    ;;
esac
if [ "${TARGET_DIR%/}" != "$TARGET_DIR" ]; then
  echo "TARGET_DIR must not have a trailing slash" >&2
  exit 1
fi
case "$TARGET_DIR" in
  /opt/?*|/srv/?*|/usr/local/share/?*) ;;
  *)
    echo "Refusing to deploy to '$TARGET_DIR'." >&2
    echo "TARGET_DIR must be under /opt, /srv or /usr/local/share." >&2
    exit 1
    ;;
esac

BRANCH="$(git branch --show-current)"
COMMIT="$(git rev-parse HEAD)"
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
git archive --format=tar.gz --prefix="owntunedashboard-$COMMIT/" -o "$STAGE/dashboard.tar.gz" HEAD
git show HEAD:deploy/update-dashboard.sh > "$STAGE/install.sh"
if ! git cat-file -e HEAD:deploy/site_config.py; then
  echo "Commit the common installer and config migration before deploying HEAD" >&2
  exit 1
fi

echo "==> Uploading via $PROXMOX_TARGET to LXC $LXC_ID"
# Unique root-owned staging on both hosts; no fixed /tmp upload names.
REMOTE_STAGE="$(ssh "$PROXMOX_TARGET" 'mktemp -d /tmp/owntone-upload.XXXXXXXX')"
[[ "$REMOTE_STAGE" =~ ^/tmp/owntone-upload\.[A-Za-z0-9]+$ ]] || exit 1
cleanup_remote() {
  local code=$?
  trap - EXIT
  # shellcheck disable=SC2029
  ssh "$PROXMOX_TARGET" "rm -rf -- '$REMOTE_STAGE'" || true
  rm -rf "$STAGE"
  exit "$code"
}
trap cleanup_remote EXIT
scp -q "$STAGE/dashboard.tar.gz" "$STAGE/install.sh" "$PROXMOX_TARGET:$REMOTE_STAGE/"
# Only validated ID, SHA, target and mktemp output enter remote shell text.
# shellcheck disable=SC2029
ssh "$PROXMOX_TARGET" "bash -s -- '$LXC_ID' '$COMMIT' '$TARGET_DIR' '$REMOTE_STAGE'" <<'REMOTE'
set -Eeuo pipefail
LXC_ID="$1"; COMMIT="$2"; TARGET="$3"; UPLOAD="$4"
CONTAINER_STAGE="$(pct exec "$LXC_ID" -- mktemp -d /tmp/owntone-install.XXXXXXXX)"
[[ "$CONTAINER_STAGE" =~ ^/tmp/owntone-install\.[A-Za-z0-9]+$ ]] || exit 1
trap 'pct exec "$LXC_ID" -- rm -rf -- "$CONTAINER_STAGE"' EXIT
pct push "$LXC_ID" "$UPLOAD/dashboard.tar.gz" "$CONTAINER_STAGE/dashboard.tar.gz"
pct push "$LXC_ID" "$UPLOAD/install.sh" "$CONTAINER_STAGE/install.sh"
pct exec "$LXC_ID" -- env "OWNTONE_DASHBOARD_TARGET=$TARGET" \
  bash "$CONTAINER_STAGE/install.sh" --archive "$CONTAINER_STAGE/dashboard.tar.gz" "$COMMIT"
REMOTE

echo "==> Deploy done ($COMMIT)"
