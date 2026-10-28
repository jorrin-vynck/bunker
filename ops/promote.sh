#!/usr/bin/env bash
# Roll this code out to a server, after looking at what changes.
#
#   PROD_HOST=my-server ./ops/promote.sh
#
# It fetches what runs on the server right now (not from your folder), shows what changes, flags lines that deserve a
# second look, and only deploys after you type PROMOTE. The first time there is nothing on the server, so everything is new.
# Run it from a computer you trust, and read this file once: it is short on purpose.
set -euo pipefail
PROD="${PROD_HOST:-}"
[ -n "$PROD" ] || { echo "Set PROD_HOST to the ssh name of the server."; exit 1; }
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/running/public"

echo "Fetching what runs on the server..."
rsync -a "$PROD":/opt/bunker/server.py "$PROD":/opt/bunker/public "$TMP/running/" 2>/dev/null || echo "(nothing found: this is the first roll-out)"
[ -f "$TMP/running/server.py" ] || : > "$TMP/running/server.py"

VERSION="$(sed -n 's/^VERSION = "\([^"]*\)".*/\1/p' server.py | head -1)"
RUNNING="$(sed -n 's/^VERSION = "\([^"]*\)".*/\1/p' "$TMP/running/server.py" | head -1)"
echo "On the server: ${RUNNING:-nothing}.  New: ${VERSION}."

{
  diff -u "$TMP/running/server.py" server.py || true
  diff -ruN -x '*.png' -x '*.zip' "$TMP/running/public" public || true
} > "$TMP/changes.diff"
BIN="$(diff -rq "$TMP/running/public" public | grep -E '\.(png|zip)' || true)"

echo
echo "Changes: $(grep -c '^[+-][^+-]' "$TMP/changes.diff" || true) lines of code."
[ -z "$BIN" ] || { echo "Other files that differ (images and so on):"; echo "$BIN"; }
echo
echo "Lines worth a second look (a helper, not a guarantee):"
FLAG='importlib|pickle|marshal|ctypes|os\.popen|getattr|setattr|compile\(|innerHTML|fetch\(|WebSocket|serviceWorker|subprocess|os\.system|eval\(|exec\(|__import__|base64|authorized_keys|/etc/|ADMIN_TOKEN|secret\.key|curl|wget|sendBeacon|XMLHttpRequest|new Image|import (socket|urllib|requests|http)|https?://[a-zA-Z0-9.-]+|<script'
grep -n -E "^\+[^+]" "$TMP/changes.diff" | grep -E "$FLAG" | grep -v 'localhost' | cut -c1-200 || echo "  none"
echo
read -r -p "Read the whole difference? (y/n) " READ
if [ "$READ" = "y" ]; then ${PAGER:-less} "$TMP/changes.diff"; fi
read -r -p "Type PROMOTE to send version ${VERSION} to the server: " ANS
[ "$ANS" = "PROMOTE" ] || { echo "Stopped. Nothing was rolled out."; exit 1; }

UP="$(ssh "$PROD" 'mktemp -d')"   # a fresh private folder on the server, not a guessable path in /tmp
rsync -a --delete server.py public "$PROD":"$UP"/
ssh "$PROD" "set -e; UP='$UP'; sudo mkdir -p /opt/bunker && sudo rsync -a --delete \"\$UP/public/\" /opt/bunker/public/ && sudo install -o bunker -g bunker -m 644 \"\$UP/server.py\" /opt/bunker/server.py && sudo chown -R bunker:bunker /opt/bunker/public && rm -rf \"\$UP\" && sudo systemctl restart bunker && sleep 2 && systemctl is-active bunker"
echo "Done. Version ${VERSION} is running."
