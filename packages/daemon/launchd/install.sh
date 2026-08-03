#!/usr/bin/env bash
# Install devdock as an immutable, always-on launchd agent (spec §11).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${DEVDOCK_REPO_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
NODE_BIN="$(realpath "${DEVDOCK_NODE_BIN:-$(command -v node)}")"
PNPM_BIN="${DEVDOCK_PNPM_BIN:-$(command -v pnpm)}"
LAUNCHCTL_BIN="${DEVDOCK_LAUNCHCTL_BIN:-$(command -v launchctl)}"
CURL_BIN="${DEVDOCK_CURL_BIN:-$(command -v curl)}"
ROOTS="${DEVDOCK_ROOTS:-$HOME/Code}"
PORT="${DEVDOCK_PORT:-7717}"
LABEL="com.devdock.daemon"
DOMAIN="${DEVDOCK_LAUNCHD_DOMAIN:-gui/$(id -u)}"
SERVICE_TARGET="$DOMAIN/$LABEL"
INSTALL_ROOT="${DEVDOCK_INSTALL_ROOT:-$HOME/.local/share/devdock}"
RELEASES="$INSTALL_ROOT/releases"
PLIST_DEST="${DEVDOCK_PLIST_DEST:-$HOME/Library/LaunchAgents/$LABEL.plist}"

mkdir -p "$HOME/.devdock" "$RELEASES" "$(dirname "$PLIST_DEST")"

STAGING="$(mktemp -d "$INSTALL_ROOT/.staging.XXXXXX")"
PLIST_TMP="$(mktemp "$(dirname "$PLIST_DEST")/.devdock.plist.XXXXXX")"
PLIST_BACKUP=""

cleanup() {
  if [[ -n "$STAGING" && -d "$STAGING" ]]; then rm -rf "$STAGING"; fi
  if [[ -f "$PLIST_TMP" ]]; then rm -f "$PLIST_TMP"; fi
  if [[ -n "$PLIST_BACKUP" && -f "$PLIST_BACKUP" ]]; then rm -f "$PLIST_BACKUP"; fi
}
trap cleanup EXIT

# Force-emit the runtime packages. TypeScript's incremental cache can outlive
# ignored dist/ directories, so a plain `tsc -p` may otherwise report success
# while leaving the daemon unrunnable.
(
  cd "$REPO_ROOT"
  "$PNPM_BIN" --filter @devdock/core exec tsc -b tsconfig.json --force
  "$PNPM_BIN" --filter @devdock/daemon exec tsc -b tsconfig.json --force
  "$PNPM_BIN" --filter @devdock/web build

  mkdir -p "$STAGING/packages"
  "$PNPM_BIN" --filter @devdock/daemon deploy --prod --legacy "$STAGING/packages/daemon"
  mkdir -p "$STAGING/packages/web"
  cp -R "$REPO_ROOT/packages/web/dist" "$STAGING/packages/web/dist"
)

STAGED_DAEMON="$STAGING/packages/daemon/dist/index.js"
STAGED_CORE="$STAGING/packages/daemon/node_modules/@devdock/core/dist/index.js"
STAGED_ROUTES="$STAGING/packages/daemon/dist/routes.js"
for required in "$STAGED_DAEMON" "$STAGED_CORE" "$STAGED_ROUTES"; do
  if [[ ! -f "$required" ]]; then
    echo "error: portable release is missing $required" >&2
    exit 1
  fi
done

# Import both the workspace core and daemon routes from the portable tree. This
# catches missing/broken production dependencies before touching the live job.
"$NODE_BIN" --input-type=module --eval 'await import(process.argv[1])' "$STAGED_CORE"
"$NODE_BIN" --input-type=module --eval 'await import(process.argv[1])' "$STAGED_ROUTES"

REVISION="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'local')"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$REVISION-$$"
RELEASE="$RELEASES/$RELEASE_ID"
mv "$STAGING" "$RELEASE"
STAGING=""
DAEMON_JS="$RELEASE/packages/daemon/dist/index.js"

sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__DAEMON__|$DAEMON_JS|g" \
    -e "s|__ROOTS__|$ROOTS|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__HOME__|$HOME|g" \
    "$SCRIPT_DIR/com.devdock.daemon.plist" > "$PLIST_TMP"
plutil -lint "$PLIST_TMP" >/dev/null

if [[ -f "$PLIST_DEST" ]]; then
  PLIST_BACKUP="$(mktemp "$(dirname "$PLIST_DEST")/.devdock.backup.XXXXXX")"
  cp "$PLIST_DEST" "$PLIST_BACKUP"
fi

stop_service() {
  "$LAUNCHCTL_BIN" bootout "$SERVICE_TARGET" 2>/dev/null || true
  for ((attempt = 0; attempt < 50; attempt++)); do
    if ! "$LAUNCHCTL_BIN" print "$SERVICE_TARGET" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  return 1
}

restore_previous() {
  stop_service || true
  if [[ -n "$PLIST_BACKUP" && -f "$PLIST_BACKUP" ]]; then
    cp "$PLIST_BACKUP" "$PLIST_DEST"
    "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$PLIST_DEST" >/dev/null 2>&1 || true
  else
    rm -f "$PLIST_DEST"
  fi
}

# The portable tree is complete before the brief handover. If bootstrap or the
# health check fails, put the previous plist back and restart it.
if ! stop_service; then
  echo "error: $LABEL did not finish stopping; left the previous launch agent in place" >&2
  exit 1
fi
mv "$PLIST_TMP" "$PLIST_DEST"
if ! "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$PLIST_DEST"; then
  restore_previous
  echo "error: could not bootstrap $LABEL; restored the previous launch agent" >&2
  exit 1
fi

HEALTHY=false
for ((attempt = 0; attempt < 50; attempt++)); do
  if "$LAUNCHCTL_BIN" print "$SERVICE_TARGET" 2>/dev/null | grep -q 'state = running' \
    && "$CURL_BIN" -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null; then
    HEALTHY=true
    break
  fi
  sleep 0.2
done

if [[ "$HEALTHY" != true ]]; then
  restore_previous
  echo "error: $LABEL did not become healthy; restored the previous launch agent" >&2
  exit 1
fi

echo "devdock daemon installed -> $DAEMON_JS"
echo "health: http://127.0.0.1:$PORT/health"
echo "logs: ~/.devdock/daemon.{out,err}.log | roots: $ROOTS"
