# Run your own bunker

You need a small Linux server (Ubuntu 24.04 is fine), Python 3.10 or newer, and a way to serve it over HTTPS. Camera,
microphone and notifications only work over HTTPS (or on `localhost`).

## 1. Install

```bash
sudo apt install -y python3-venv rsync
sudo useradd --system --home /opt/bunker --shell /usr/sbin/nologin bunker
sudo mkdir -p /opt/bunker && sudo chown bunker:bunker /opt/bunker
sudo -u bunker python3 -m venv /opt/bunker/.venv
sudo -u bunker /opt/bunker/.venv/bin/pip install 'pywebpush>=2,<3'
```

Copy `server.py` and `public/` to `/opt/bunker/` (for example with `ops/promote.sh`, see below).

The scripts in `ops/` have to be made executable once, on the computer you run them from: `chmod +x ops/*.sh`.

## 2. Configure

Settings are environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `8000` | where it listens (keep it local, put HTTPS in front) |
| `BUNKER_DATA` | `./data` | database, uploads and keys |
| `ADMIN_TOKEN` | empty | the admin page is off without it |
| `APP_NAME` | `bunker` | name in the tab, under the icon and in notifications |
| `NOTICE` | empty | a red line at the top of every page, for example to say that this is a test server |
| `NOTICE_MORE` | empty | the text behind that line; a `\|` starts a new paragraph |
| `LABEL` | empty | a word next to the version, for example `test`, to tell a test server apart |
| `MEDIA_QUOTA_MB` | `3000` | total space for photos and video |
| `VAPID_SUB` | `mailto:admin@example.com` | contact address for the push service (use your own) |
| `SOURCE_URL` | empty | address of your source code; shown on the changes page (the AGPL asks for it when you run a modified copy) |
| `TRUST_PROXY` | empty | header with the real client address behind a proxy, for example `X-Forwarded-For` |

Make a token and keep it in a root-only file:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
echo "ADMIN_TOKEN=<the token>" | sudo tee /etc/bunker.env >/dev/null && sudo chmod 600 /etc/bunker.env
```

## 3. Start it

```bash
sudo cp deploy/bunker.service /etc/systemd/system/      # set VAPID_SUB in it
sudo systemctl daemon-reload && sudo systemctl enable --now bunker
curl -s localhost:8000/api/config
```

The unit runs it as its own user with a read-only system and a private data folder.

## 4. HTTPS

Pick one:

- **Tailscale Funnel** (no domain, no open ports): `deploy/tailscaled-bunker.service` runs a Tailscale node just for
  bunker. Then `tailscale --socket=/run/tailscale-bunker/tailscaled.sock funnel --bg 8000`.
- **Caddy** with your own domain: see `deploy/Caddyfile`.

Set `TRUST_PROXY=X-Forwarded-For` when a proxy sits in front.

## 5. The admin page

Open `https://your-address/#/admin` and type the token. It is never saved: you type it again after a reload.
You can see storage, delete threads, chats and pseudonyms, change the limits, and wipe the data. It cannot read chats.

## 6. Updating

Change `VERSION` in `server.py` and note the changes in `public/changes.json`, then roll out. `ops/promote.sh` compares
the new code with what runs on the server, flags suspicious lines, and only deploys after you type `PROMOTE`.
Run it from a computer you trust.

```bash
PROD_HOST=my-server ./ops/promote.sh
BUNKER_HOST=my-server ./ops/status.sh
```

## 7. Notes

- No back-ups are made. If the server dies, the bunker starts empty. That is on purpose.
- The boards are listed in `server.py` (`BOARDS`). Change them to suit your group.
- Keep the server updated: `sudo apt update && sudo apt upgrade` now and then.
