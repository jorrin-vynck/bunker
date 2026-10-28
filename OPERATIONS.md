# Operating a bunker

How to keep a bunker running, and how to keep the people who help you from becoming a weak spot.

## What runs where

```
phone --https--> your front door (Tailscale Funnel or Caddy) --> 127.0.0.1:8000 --> server.py --> database + media
```

| Part | Where (default) |
|---|---|
| Code | `/opt/bunker/` (`server.py`, `public/`, `.venv/`) |
| Data | `/var/lib/bunker/` (`bunker.db`, `media/`, `secret.key`, `vapid_private.pem`) |
| Secrets | `/etc/bunker.env` (the admin token), readable by root only |
| Service | `bunker.service`, runs as its own user with a read-only system |

## Day to day

```bash
BUNKER_HOST=my-server ./ops/status.sh             # running? disk? last messages?
PROD_HOST=my-server    ./ops/promote.sh           # roll out new code, after reading what changes
BUNKER_HOST=my-server ./ops/rotate-admin-token.sh # new admin token, shown once
BUNKER_HOST=my-server ./ops/wipe.sh               # delete everything, start empty
```

On the server: `sudo systemctl status bunker`, `sudo systemctl restart bunker`, `sudo journalctl -u bunker -n 50`
(the log holds no traffic and no addresses).

## No back-ups

bunker makes none, and neither should you: what is deleted is meant to be gone, and a copy of `/var/lib/bunker/` holds
readable board posts and pseudonyms. If the server dies, the bunker starts empty. Do not enable automatic disk
snapshots of the machine either.

## Two bunkers: a real one and a test one

If you work on the code with other people, or with an AI assistant, run two bunkers:

| | real bunker | test bunker |
|---|---|---|
| used by | your friends | you and your helpers |
| data | real | test data only |
| helpers have access | **never** | yes |
| code gets there by | `ops/promote.sh`, run by you | `ops/deploy.sh` |
| `LABEL` | empty | `test` (so nobody mixes them up) |

Set `LABEL=test` on the test server (in `/etc/bunker.env`). The label next to the version (`test v1.0`) then says it is the test one.
The app keeps the name `bunker` everywhere else, so it looks the same on a phone.

What your helpers must never get: the ssh key to the real server, access to its Tailscale account or cloud console, the
admin token, `/etc/bunker.env`. Anything on a computer or in a session your helper runs on is within their reach, so manage
the real server from another computer or your phone, or with a key that asks for your touch every time.

### How a roll-out is checked

`ops/promote.sh` fetches what actually runs on the real server, compares it with the new code, counts the changed lines and
prints the lines that deserve a second look (new network calls, running commands, touching keys, new addresses). You can read
the whole difference. Only after you type `PROMOTE` does it deploy.

This does not make bad code impossible. Someone still writes the code you deploy. Keep changes small, ask a second person to
review big ones, and keep the code public so others can read it. Keep `promote.sh` on your own computer, read it once, and
change it only after reading: if it lives where your helper can write, it can be changed to hide things.

## Who can see what

- **The admin page** (token): delete threads, chats and pseudonyms, change the limits, wipe. It cannot read closed chats.
- **Whoever has shell access to the server** can read board posts and pseudonyms, see who is connected, delete everything
  and change the code. Give that access to nobody you do not trust.
- **Closed chats** are readable only by people who have the chat code: the server holds only encrypted blobs.
- **Open chats and boards** are public by design.

## If something breaks

| Problem | Do this |
|---|---|
| Site unreachable | `status.sh`. If `bunker` is down: `sudo systemctl restart bunker`. If your front door is down, restart that |
| Disk full | admin page, DANGER, delete all photos and videos, or lower the limits |
| Database broken | `wipe.sh` and start again (there are no back-ups) |
| Lost the admin token | `rotate-admin-token.sh` |
| Wrong admin token locked you out | wait 15 minutes or restart the service |
| Notifications blocked on a phone | the person has to allow them in the phone settings; a site cannot ask twice |

Keep the machine updated: `sudo apt update && sudo apt upgrade` once a month.
