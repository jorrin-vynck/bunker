#!/usr/bin/env bash
# Make a new admin token and put it on the server. It is shown once and kept nowhere else.
# Other lines in /etc/bunker.env (such as APP_NAME) stay.
set -euo pipefail
HOST="${BUNKER_HOST:?Set BUNKER_HOST to the ssh name of the server}"
NEW="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
printf '%s' "$NEW" | ssh "$HOST" 'T=$(cat); sudo touch /etc/bunker.env; sudo sed -i "/^ADMIN_TOKEN=/d" /etc/bunker.env; echo "ADMIN_TOKEN=$T" | sudo tee -a /etc/bunker.env >/dev/null; sudo chmod 600 /etc/bunker.env; sudo systemctl restart bunker'
echo "New admin token (copy it now, it is kept nowhere else):"
echo "$NEW"
