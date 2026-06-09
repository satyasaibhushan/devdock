#!/usr/bin/env bash
# Install the devdock daemon as an always-on launchd agent (spec §11).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_JS="$(cd "$SCRIPT_DIR/.." && pwd)/dist/index.js"
NODE_BIN="$(command -v node)"
ROOTS="${DEVDOCK_ROOTS:-$HOME/Code}"
LABEL="com.devdock.daemon"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ ! -f "$DAEMON_JS" ]]; then
  echo "error: $DAEMON_JS not found — run 'pnpm -r build' first." >&2
  exit 1
fi

mkdir -p "$HOME/.devdock" "$HOME/Library/LaunchAgents"

sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__DAEMON__|$DAEMON_JS|g" \
    -e "s|__ROOTS__|$ROOTS|g" \
    -e "s|__HOME__|$HOME|g" \
    "$SCRIPT_DIR/com.devdock.daemon.plist" > "$PLIST_DEST"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"
echo "devdock daemon installed → $PLIST_DEST"
echo "logs: ~/.devdock/daemon.{out,err}.log · port 7717 · roots $ROOTS"
