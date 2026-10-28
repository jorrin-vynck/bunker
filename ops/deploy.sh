#!/usr/bin/env bash
# Copy the code to a TEST server and restart. No questions asked, so do not point this at a server people rely on:
# use ops/promote.sh for that.
#   BUNKER_HOST=my-test-server ./ops/deploy.sh
set -euo pipefail
HOST="${BUNKER_HOST:?Set BUNKER_HOST to the ssh name of the server}"
cd "$(dirname "$0")/.."
UP="$(ssh "$HOST" 'mktemp -d')"   # a fresh private folder on the server, not a guessable path in /tmp
rsync -a --delete server.py public "$HOST":"$UP"/
ssh "$HOST" "set -e; UP='$UP'; sudo mkdir -p /opt/bunker && sudo rsync -a --delete \"\$UP/public/\" /opt/bunker/public/ && sudo install -o bunker -g bunker -m 644 \"\$UP/server.py\" /opt/bunker/server.py && sudo chown -R bunker:bunker /opt/bunker/public && rm -rf \"\$UP\" && sudo systemctl restart bunker && sleep 2 && systemctl is-active bunker"
