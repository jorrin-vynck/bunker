# Contributing

Thank you. A few ground rules keep bunker what it is:

- No analytics, no ads, no third-party scripts, no accounts, no logs. If a change needs the server to know or keep
  more, say why in the pull request.
- Keep it small. One Python file for the server, plain JavaScript for the app, no build step, no big dependencies.
- Text and ASCII. No images as decoration, no animation to keep people hooked.
- Say what changed in `public/changes.json` and, when it is a release, raise `VERSION` in `server.py`.
- Test by hand on a phone: send a message, a photo, a video, join a voice chat, delete things. There is no test suite yet.

Security problems: see [SECURITY.md](SECURITY.md).
