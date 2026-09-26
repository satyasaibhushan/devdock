#!/usr/bin/env bash
# Install devdock as an immutable systemd user service on Linux, the
# counterpart of launchd/install.sh. The daemon listens on a private Unix
# socket; reach it from another machine through a linked instance (SSH).
#
# Machine-specific settings come from the environment:
#   DEVDOCK_ROOTS         checkout roots (default ~/Code)
#   DEVDOCK_HTTPS_PROXY   proxy for the daemon's own HTTPS (default: $HTTPS_PROXY)
#   DEVDOCK_NO_PROXY      hosts reached directly (default: $NO_PROXY, else localhost)
#   DEVDOCK_DOCKER_HOST   Docker socket, e.g. rootless (default: $DOCKER_HOST)
#   DEVDOCK_PATH_PREFIX   extra PATH entries ahead of the defaults
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${DEVDOCK_REPO_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
NODE_BIN="$(realpath "${DEVDOCK_NODE_BIN:-$(command -v node)}")"
PNPM_BIN="${DEVDOCK_PNPM_BIN:-$(command -v pnpm)}"
SYSTEMCTL_BIN="${DEVDOCK_SYSTEMCTL_BIN:-$(command -v systemctl)}"
CURL_BIN="${DEVDOCK_CURL_BIN:-$(command -v curl)}"
ROOTS="${DEVDOCK_ROOTS:-$HOME/Code}"
PROXY="${DEVDOCK_HTTPS_PROXY-${HTTPS_PROXY:-}}"
NO_PROXY_HOSTS="${DEVDOCK_NO_PROXY:-${NO_PROXY:-localhost,127.0.0.1}}"
DOCKER="${DEVDOCK_DOCKER_HOST-${DOCKER_HOST:-}}"
PATH_PREFIX="${DEVDOCK_PATH_PREFIX:-}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
SOCKET="$RUNTIME_DIR/devdock/control.sock"
INSTALL_ROOT="${DEVDOCK_INSTALL_ROOT:-$HOME/.local/share/devdock}"
RELEASES="$INSTALL_ROOT/releases"
UNIT_DEST="${DEVDOCK_UNIT_DEST:-$HOME/.config/systemd/user/devdock.service}"
MCP_LINK="${DEVDOCK_MCP_LINK:-$HOME/.local/bin/devdock-mcp}"

mkdir -p "$HOME/.devdock" "$RELEASES" "$INSTALL_ROOT/bin" "$(dirname "$UNIT_DEST")"

STAGING="$(mktemp -d "$INSTALL_ROOT/.staging.XXXXXX")"
UNIT_TMP="$(mktemp "$(dirname "$UNIT_DEST")/.devdock.service.XXXXXX")"
UNIT_BACKUP=""

cleanup() {
  if [[ -n "$STAGING" && -d "$STAGING" ]]; then rm -rf "$STAGING"; fi
  if [[ -f "$UNIT_TMP" ]]; then rm -f "$UNIT_TMP"; fi
  if [[ -n "$UNIT_BACKUP" && -f "$UNIT_BACKUP" ]]; then rm -f "$UNIT_BACKUP"; fi
}
trap cleanup EXIT

# Same portable build as launchd/install.sh: force-emit, deploy production
# dependencies into the staging tree, then import it before the handover.
(
  cd "$REPO_ROOT"
  # pnpm 12's `deploy --prod` records the checkout as production-only, and the
  # next `pnpm exec` prunes the dev tools the build needs. Install first, and
  # restore the dev dependencies after deploying so the checkout stays usable.
  "$PNPM_BIN" install --frozen-lockfile
  "$PNPM_BIN" --filter @devdock/core exec tsc -b tsconfig.json --force
  "$PNPM_BIN" --filter @devdock/daemon exec tsc -b tsconfig.json --force
  "$PNPM_BIN" --filter @devdock/mcp exec tsc -b tsconfig.json --force
  "$PNPM_BIN" --filter @devdock/web build

  mkdir -p "$STAGING/packages"
  "$PNPM_BIN" --filter @devdock/daemon deploy --prod --legacy "$STAGING/packages/daemon"
  "$PNPM_BIN" --filter @devdock/mcp deploy --prod --legacy "$STAGING/packages/mcp"
  mkdir -p "$STAGING/packages/web"
  cp -R "$REPO_ROOT/packages/web/dist" "$STAGING/packages/web/dist"
  "$PNPM_BIN" install --frozen-lockfile --offline
)

STAGED_CORE="$STAGING/packages/daemon/node_modules/@devdock/core/dist/index.js"
STAGED_ROUTES="$STAGING/packages/daemon/dist/routes.js"
STAGED_DAEMON_MCP="$STAGING/packages/daemon/dist/mcp.js"
STAGED_MCP_SERVER="$STAGING/packages/mcp/dist/server.js"
for required in "$STAGING/packages/daemon/dist/index.js" "$STAGED_CORE" "$STAGED_ROUTES" \
  "$STAGED_DAEMON_MCP" "$STAGING/packages/mcp/dist/index.js" "$STAGED_MCP_SERVER" \
  "$STAGING/packages/mcp/node_modules/@modelcontextprotocol/server/package.json"; do
  if [[ ! -f "$required" ]]; then
    echo "error: portable release is missing $required" >&2
    exit 1
  fi
done
for module in "$STAGED_CORE" "$STAGED_ROUTES" "$STAGED_DAEMON_MCP" "$STAGED_MCP_SERVER"; do
  "$NODE_BIN" --input-type=module --eval 'await import(process.argv[1])' "$module"
done

REVISION="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'local')"
RELEASE="$RELEASES/$(date -u +%Y%m%dT%H%M%SZ)-$REVISION-$$"
mv "$STAGING" "$RELEASE"
STAGING=""
mkdir -p "$RELEASE/bin"
printf '#!/usr/bin/env bash\nexport DEVDOCK_SOCKET="${DEVDOCK_SOCKET:-%s}"\nexec %q %q "$@"\n' \
  "$SOCKET" "$INSTALL_ROOT/node" "$RELEASE/packages/mcp/dist/index.js" > "$RELEASE/bin/devdock-mcp"
chmod 755 "$RELEASE/bin/devdock-mcp"

# The unit and child processes run Node through these links, so a Node upgrade
# is one reinstall rather than a unit edit.
ln -sfn "$NODE_BIN" "$INSTALL_ROOT/node"
ln -sfn "$NODE_BIN" "$INSTALL_ROOT/bin/node"

# Node reads HTTPS_PROXY only with --use-env-proxy. kubectl and devspace read it
# unconditionally, so a cluster reachable only through the proxy belongs in the
# kubeconfig's cluster `proxy-url`, with NO_PROXY keeping AWS endpoints direct.
NODE_FLAGS=""
if [[ -n "$PROXY" ]]; then
  if ! "$NODE_BIN" --use-env-proxy --eval '' 2>/dev/null; then
    echo "error: $NODE_BIN does not support --use-env-proxy, which HTTPS_PROXY needs" >&2
    exit 1
  fi
  NODE_FLAGS="--use-env-proxy "
fi

{
  printf '[Unit]\nDescription=DevDock control daemon\nAfter=network.target docker.service\n\n'
  printf '[Service]\nType=simple\n'
  printf 'ExecStart=%s %s%s\n' "$INSTALL_ROOT/node" "$NODE_FLAGS" "$INSTALL_ROOT/current/packages/daemon/dist/index.js"
  printf 'WorkingDirectory=%s\n' "$INSTALL_ROOT/current"
  printf 'Environment=PATH=%s%%h/.local/bin:%s:/usr/local/bin:/usr/bin:/bin\n' \
    "${PATH_PREFIX:+$PATH_PREFIX:}" "$INSTALL_ROOT/bin"
  printf 'Environment=SHELL=/bin/bash\n'
  printf 'Environment=DEVDOCK_ROOTS=%s\n' "$ROOTS"
  printf 'Environment=DEVDOCK_SOCKET=%%t/devdock/control.sock\n'
  if [[ -S "$RUNTIME_DIR/bus" ]]; then printf 'Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=%%t/bus\n'; fi
  if [[ -n "$DOCKER" ]]; then printf 'Environment=DOCKER_HOST=%s\n' "$DOCKER"; fi
  if [[ -n "$PROXY" ]]; then
    printf 'Environment=HTTPS_PROXY=%s\n' "$PROXY"
    printf 'Environment=NO_PROXY=%s\n' "$NO_PROXY_HOSTS"
  fi
  printf 'Environment=AWS_PAGER=\n'
  printf 'RuntimeDirectory=devdock\nRuntimeDirectoryMode=0700\nUMask=0077\n'
  # The daemon starts the tmux server that holds every dev session. Stop only
  # the daemon, as launchd does, so a restart or reinstall keeps the sessions.
  printf 'KillMode=process\n'
  printf 'Restart=on-failure\nRestartSec=5\n\n'
  printf '[Install]\nWantedBy=default.target\n'
} > "$UNIT_TMP"

PREVIOUS_RELEASE=""
if [[ -L "$INSTALL_ROOT/current" ]]; then PREVIOUS_RELEASE="$(readlink "$INSTALL_ROOT/current")"; fi
if [[ -f "$UNIT_DEST" ]]; then
  UNIT_BACKUP="$(mktemp "$(dirname "$UNIT_DEST")/.devdock.backup.XXXXXX")"
  cp "$UNIT_DEST" "$UNIT_BACKUP"
fi

healthy() {
  for ((attempt = 0; attempt < 50; attempt++)); do
    if "$SYSTEMCTL_BIN" --user is-active --quiet devdock \
      && "$CURL_BIN" -fs --max-time 1 --unix-socket "$SOCKET" http://localhost/health >/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# The release is complete before the brief handover. If the new daemon does
# not become healthy, put the previous release and unit back.
ln -sfn "$RELEASE" "$INSTALL_ROOT/current"
mv "$UNIT_TMP" "$UNIT_DEST"
"$SYSTEMCTL_BIN" --user daemon-reload
"$SYSTEMCTL_BIN" --user enable devdock >/dev/null 2>&1
if ! "$SYSTEMCTL_BIN" --user restart devdock || ! healthy; then
  if [[ -n "$PREVIOUS_RELEASE" && -n "$UNIT_BACKUP" ]]; then
    ln -sfn "$PREVIOUS_RELEASE" "$INSTALL_ROOT/current"
    cp "$UNIT_BACKUP" "$UNIT_DEST"
    "$SYSTEMCTL_BIN" --user daemon-reload
    "$SYSTEMCTL_BIN" --user restart devdock || true
  else
    "$SYSTEMCTL_BIN" --user disable --now devdock >/dev/null 2>&1 || true
    rm -f "$UNIT_DEST"
    "$SYSTEMCTL_BIN" --user daemon-reload
  fi
  echo "error: devdock did not become healthy; restored the previous release" >&2
  exit 1
fi

mkdir -p "$(dirname "$MCP_LINK")"
ln -sfn "$RELEASE/bin/devdock-mcp" "$MCP_LINK"

echo "devdock daemon installed -> $RELEASE"
echo "devdock MCP installed -> $MCP_LINK"
echo "health: curl --unix-socket $SOCKET http://localhost/health"
echo "logs: journalctl --user -u devdock | roots: $ROOTS | proxy: ${PROXY:-none}"
