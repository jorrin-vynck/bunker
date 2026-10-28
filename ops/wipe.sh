#!/usr/bin/env bash
# Delete ALL data on the server: database, uploads and keys. The app starts empty.
set -euo pipefail
HOST="${BUNKER_HOST:?Set BUNKER_HOST to the ssh name of the server}"
read -r -p "This deletes all data on the server. Type WIPE to continue: " ANS
[ "$ANS" = "WIPE" ] || { echo "Stopped."; exit 1; }
ssh "$HOST" 'sudo systemctl stop bunker && sudo rm -rf /var/lib/bunker/bunker.db* /var/lib/bunker/media /var/lib/bunker/secret.key /var/lib/bunker/vapid_private.pem && sudo systemctl start bunker && sleep 2 && systemctl is-active bunker'
echo "Done. The server is empty."
