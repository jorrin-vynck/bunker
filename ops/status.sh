#!/usr/bin/env bash
# Is everything running, how much room is left, what did the server say last.
set -euo pipefail
HOST="${BUNKER_HOST:?Set BUNKER_HOST to the ssh name of the server}"
ssh "$HOST" 'echo "service:  $(systemctl is-active bunker)"
echo; df -h / | tail -1; free -m | sed -n 2p
echo; echo "last messages:"; sudo journalctl -u bunker -n 8 --no-pager | cut -c1-160
echo; echo "answers: $(curl -s -o /dev/null -w "%{http_code}" localhost:8000/api/config)"'
