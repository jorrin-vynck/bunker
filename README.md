# bunker

A small anonymous message board and end-to-end encrypted group chat for friends. Phone first, text and ASCII only,
no accounts, no logs, no back-ups. One Python file for the server and plain JavaScript for the app. No build step.

**Who is this for?** Friends who know each other and want to be left alone. It is not meant for people who are in real danger
(journalists, activists): use Signal, SimpleX or Briar, which are independently audited and have no operator who can change the
code. With bunker you trust whoever runs the server, and you can check what a server serves with `ops/verify-live.sh`.

```
 ____  _   _ _   _ _  _______ ____
| __ )| | | | \ | | |/ / ____|  _ \
|  _ \| | | |  \| | ' /|  _| | |_) |
| |_) | |_| | |\  | . \| |___|  _ <
|____/ \___/|_| \_|_|\_\_____|_| \_\
```

## What it does

- **Boards.** Public boards with threads, replies, photos, video and `<3` likes. You can edit and delete your own posts.
- **Chats.** Open chats (anyone can join, the key is public) and closed chats (a random code, end-to-end encrypted).
  Text, photos, video and voice are encrypted on the phone with a key the server never sees.
- **Voice.** Connect your microphone and everyone in the chat hears you. The audio is encrypted with the chat key,
  the server only relays it.
- **Anonymous by default.** You are `Anon #XXXX`. A pseudonym with a 6-digit code is optional.
- **Everything expires.** A chat keeps a limited number of messages, a board a limited number of threads, and a
  chat nobody uses disappears. There are no back-ups.
- **Installable** on a phone (PWA), with push notifications that never say who wrote.
- **An admin page** to clean up and to set the limits. The admin can delete, not read.

## Principles

1. End-to-end encrypted. 2. No accounts. 3. No logs. 4. No back-ups. 5. Everything expires.
*Defend your right to free and secure internet communications.*

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install 'pywebpush>=2,<3'     # pywebpush is only needed for notifications
BUNKER_DATA=/tmp/bunker-test ADMIN_TOKEN=test123 .venv/bin/python server.py
# open http://localhost:8000
```

To run it for real, with HTTPS (needed for camera, microphone and notifications), see [DEPLOY.md](DEPLOY.md).
How to operate it, and how to keep helpers away from the real server: [OPERATIONS.md](OPERATIONS.md). The principles: [MANIFESTO.md](MANIFESTO.md).
Every group of friends can run its own bunker. They do not talk to each other, on purpose.

## What the server knows

It stores: board posts (readable, they are public), pseudonyms with a hash of the device key, encrypted chat messages
with a time and a sender label, uploaded files (encrypted in closed chats), and push subscriptions.
It does not store: an access log, IP addresses, analytics, or the contents of closed chats.

## Limits, honestly

- A website cannot prove the owner did not change the code. Run your own, or read what is served.
- Boards and open chats are public. They say so.
- Whoever runs the server can see who is connected and when, and can delete everything.
- The group key comes from a code. Anyone with the code can read the chat. Share it carefully.

## License

[GNU AGPL-3.0-or-later](LICENSE). If you run a modified version as a service for other people, you must offer them
the source of your version.

Copyright 2026 the bunker contributors.
