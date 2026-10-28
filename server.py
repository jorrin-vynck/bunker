#!/usr/bin/env python3
"""BUNKER: anonymous boards + end-to-end encrypted groups. Python stdlib + pywebpush."""
import base64
import contextlib
import hashlib
import html
import hmac
import json
import mimetypes
import os
import queue
import re
import secrets
import select
import socket
import sys
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    from py_vapid import Vapid
    from pywebpush import WebPushException, webpush
    PUSH = True
except Exception as e:  # push is optional
    print("push disabled (pywebpush not usable):", repr(e))
    PUSH = False

os.umask(0o077)  # everything the server writes (database, keys, media) is for its own user only
ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA = Path(os.environ.get("BUNKER_DATA", ROOT / "data"))
DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
TRUST_PROXY = os.environ.get("TRUST_PROXY", "")  # e.g. CF-Connecting-IP
VAPID_SUB = os.environ.get("VAPID_SUB", "mailto:admin@example.com")
APP_NAME = os.environ.get("APP_NAME", "bunker")  # the name of the app, shown in the tab, under the icon and in notifications
NOTICE = os.environ.get("NOTICE", "")  # a red line at the top of every page, for example on a test server
NOTICE_MORE = [t.strip() for t in os.environ.get("NOTICE_MORE", "").split("|") if t.strip()][:12]  # what the line links to; "|" starts a new paragraph
LABEL = os.environ.get("LABEL", "")  # a word shown next to the version, e.g. "test": marks a test server without renaming the app
VERSION = "1.0"  # shown on the home page; raise it by hand when you roll out a new version

BOARDS = [
    ("actua", "News and what is going on"),
    ("uitgaan", "Going out: parties, bars, who is where"),
    ("unief", "University: courses, profs, exams, kot life"),
    ("random", "Random. Anything goes, within the rules"),
    ("haat", "Rants. Hate THINGS, never people"),
]
BOARD_IDS = {b for b, _ in BOARDS}
MAX_THREADS = 60
MAX_REPLIES = 300
GROUP_KEEP = 50  # messages a group remembers; the oldest one goes when a new one arrives
GROUP_TTLS = {"1h": 3600, "24h": 86400, "7d": 604800, "off": 0}
RESERVED = {"anon", "anonymous", "admin", "mod", "moderator", "system", "bunker"}
MEDIA = DATA / "media"
MEDIA.mkdir(exist_ok=True, mode=0o700)
IMG_MAX = 8 * 1024 * 1024
VID_MAX = 200 * 1024 * 1024
MEDIA_QUOTA = int(os.environ.get("MEDIA_QUOTA_MB", "3000")) * 1024 * 1024
MAX_GROUPS = 1000  # chats on the whole server; a new one is refused until old ones expire or are deleted
MAX_NAMES = 5000  # claimed pseudonyms on the whole server
MAX_PUSH_TOTAL = 5000  # notification subscriptions on the whole server
MAX_PUSH_PER_DEVICE = 40
MEDIA_PENDING_PER_DEVICE = 400 * 1024 * 1024  # uploaded but not yet posted, per device
SOURCE_URL = os.environ.get("SOURCE_URL", "")  # AGPL: where users of this server can get the source

# ---------------------------------------------------------------- storage

db = sqlite3.connect(DATA / "bunker.db", check_same_thread=False, isolation_level=None)
db.row_factory = sqlite3.Row
db.execute("PRAGMA journal_mode=WAL")
dblock = threading.RLock()

db.executescript("""
CREATE TABLE IF NOT EXISTS names(lname TEXT PRIMARY KEY, name TEXT, did TEXT UNIQUE, ts INTEGER, code_hash TEXT, code_salt TEXT);
CREATE TABLE IF NOT EXISTS threads(id INTEGER PRIMARY KEY, board TEXT, subject TEXT, bump INTEGER, created INTEGER, replies INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS threads_board ON threads(board, bump);
CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER, board TEXT, is_op INTEGER, sender TEXT, kind TEXT, did TEXT, body TEXT, ts INTEGER, media_id TEXT, edited INTEGER, cid TEXT);
CREATE INDEX IF NOT EXISTS posts_thread ON posts(thread_id);
CREATE TABLE IF NOT EXISTS likes(kind TEXT, target INTEGER, did TEXT, PRIMARY KEY(kind, target, did));
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, did TEXT, ts INTEGER, UNIQUE(post_id, did));
CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, name TEXT, lname TEXT, vhash TEXT, ttl INTEGER, created INTEGER, last_act INTEGER, hidden INTEGER DEFAULT 0, num INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS groups_name_num ON groups(lname, num);
CREATE UNIQUE INDEX IF NOT EXISTS groups_one_open ON groups(lname) WHERE COALESCE(hidden,0)=0;
CREATE TABLE IF NOT EXISTS gmsgs(id INTEGER PRIMARY KEY AUTOINCREMENT, gid TEXT, sender TEXT, kind TEXT, ct TEXT, iv TEXT, ts INTEGER, media_id TEXT, did TEXT, edited INTEGER, cid TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS gmsgs_cid ON gmsgs(gid, cid);
CREATE INDEX IF NOT EXISTS gmsgs_gid ON gmsgs(gid, id);
CREATE TABLE IF NOT EXISTS push_subs(id INTEGER PRIMARY KEY AUTOINCREMENT, did TEXT, target TEXT, endpoint TEXT, sub TEXT, ts INTEGER, UNIQUE(target, endpoint));
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS secret(id INTEGER PRIMARY KEY CHECK(id=1), text TEXT, media_id TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, did TEXT, kind TEXT, gid TEXT, mime TEXT, size INTEGER, ts INTEGER, linked INTEGER DEFAULT 0);
""")


def q(sql, *args):
    with dblock:
        return db.execute(sql, args).fetchall()


def q1(sql, *args):
    with dblock:
        return db.execute(sql, args).fetchone()


def x(sql, *args):
    with dblock:
        return db.execute(sql, args)


@contextlib.contextmanager
def tx():
    with dblock:
        db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            db.execute("ROLLBACK")
            raise
        else:
            db.execute("COMMIT")


def load_secret():
    p = DATA / "secret.key"
    if not p.exists():
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(secrets.token_bytes(32))
    return p.read_bytes()


SECRET = load_secret()

# ---------------------------------------------------------------- helpers


class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


class Limiter:
    def __init__(self):
        self.h = {}
        self.lock = threading.Lock()

    def hit(self, key, limit, window):
        now = time.time()
        with self.lock:
            arr = [t for t in self.h.get(key, []) if now - t < window]
            if len(arr) >= limit:
                self.h[key] = arr
                return False
            arr.append(now)
            self.h[key] = arr
            return True

    def count(self, key, window):
        now = time.time()
        with self.lock:
            return sum(1 for t in self.h.get(key, []) if now - t < window)

    def add(self, key):
        with self.lock:
            self.h.setdefault(key, []).append(time.time())

    def sweep(self, maxage=90000):
        now = time.time()
        with self.lock:
            for k in list(self.h):
                self.h[k] = [t for t in self.h[k] if now - t < maxage]
                if not self.h[k]:
                    del self.h[k]


limiter = Limiter()


class Hub:
    """Pub/sub for live updates. Presence counts distinct devices, so several tabs or a dead
    connection that has not timed out yet never inflate the 'online' number."""

    def __init__(self):
        self.subs = {}  # topic -> {queue: device id or None}
        self.lock = threading.Lock()

    def sub(self, topic, did=None):
        qu = queue.Queue(maxsize=200)
        with self.lock:
            self.subs.setdefault(topic, {})[qu] = did
        return qu

    def unsub(self, topic, qu):
        with self.lock:
            s = self.subs.get(topic)
            if s:
                s.pop(qu, None)
                if not s:
                    del self.subs[topic]

    def count(self, topic):
        with self.lock:
            return len({d if d else id(q) for q, d in self.subs.get(topic, {}).items()})

    def pub(self, topic, obj):
        with self.lock:
            targets = list(self.subs.get(topic, {}))
        for qu in targets:
            try:
                qu.put_nowait(obj)
            except queue.Full:
                pass


hub = Hub()

feed_subs = {}  # queue -> chats this phone asked about; the feed only says THAT something happened, never what
feed_lock = threading.Lock()


def feed_sub(gids):
    qu = queue.Queue(maxsize=50)
    with feed_lock:
        feed_subs[qu] = set(gids)
    return qu


def feed_unsub(qu):
    with feed_lock:
        feed_subs.pop(qu, None)


def feed_pub(gid=None):
    """Tell phones that look at the activity markers to look again: gid=None for a board, a chat id for a chat."""
    with feed_lock:
        targets = [qu for qu, gids in feed_subs.items() if gid is None or gid in gids]
    for qu in targets:
        try:
            qu.put_nowait({"type": "look"})
        except queue.Full:
            pass

CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{2,20}$")
GROUP_RE = re.compile(r"^[A-Za-z0-9 _.-]{2,32}$")
B64_32 = re.compile(r"^[A-Za-z0-9+/]{43}=$")
ALPHA = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


# Admin-controlled settings, stored in the database. Every chat reads them when it opens.
SETTING_OPTIONS = {
    "voice_auto": ["1", "0"],  # 1: everyone hears whoever is connected; 0: only after pressing Connect
    "group_keep": ["10", "25", "50", "100", "200"],  # messages a group remembers
    "board_threads": ["20", "40", "60", "100"],  # threads a board remembers; older ones are deleted with their replies and media
    "idle_days": ["7", "30", "90", "0"],  # a group nobody touched for this long is deleted (0 = never)
}
SETTING_DEFAULTS = {"voice_auto": "1", "group_keep": str(GROUP_KEEP), "board_threads": str(MAX_THREADS), "idle_days": "30"}


def settings():
    got = {r["k"]: r["v"] for r in q("SELECT k, v FROM settings")}
    out = {k: (got[k] if got.get(k) in SETTING_OPTIONS[k] else SETTING_DEFAULTS[k]) for k in SETTING_OPTIONS}
    return {"voice_auto": out["voice_auto"] == "1", "group_keep": int(out["group_keep"]), "board_threads": int(out["board_threads"]),
            "idle_days": int(out["idle_days"])}


def keep():
    return settings()["group_keep"]


def clean(s, maxlen):
    s = CTRL.sub("", str(s or "")).replace("\r\n", "\n").replace("\r", "\n").strip()
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s[:maxlen]


def anon_label(did, ctx):
    d = hmac.new(SECRET, f"{did}|{ctx}".encode(), hashlib.sha256).digest()
    return "Anon #" + "".join(ALPHA[b % 32] for b in d[:4])


HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX32 = re.compile(r"^[0-9a-f]{32}$")


def proof_hash(c, header):
    """Ownership and likes are proved with tokens the phone works out from a key that never leaves it. The server stores only
    a hash of such a token, so a copy of the database cannot tie two posts to one phone."""
    t = c.h.headers.get(header, "")
    if not HEX64.match(t):
        raise ApiError(400, "Missing proof")
    return hashlib.sha256(t.encode()).hexdigest()


def new_cid(j):
    cid = j.get("cid")
    if not isinstance(cid, str) or not HEX32.match(cid):
        raise ApiError(400, "Bad message id")
    return cid


def pseudo_of(did):
    r = q1("SELECT name FROM names WHERE did=?", did)
    return r["name"] if r else None


def resolve_sender(did, mode, ctx):
    if mode == "pseudo":
        name = pseudo_of(did)
        if not name:
            raise ApiError(400, "Claim a pseudonym first (Me page)")
        return name, "p"
    return anon_label(did, ctx), "a"


def vhash(verifier):
    return hashlib.sha256(verifier.encode()).hexdigest()


# ---------------------------------------------------------------- push

VAPID_PUBLIC = None
VAPID_PEM = DATA / "vapid_private.pem"
if PUSH:
    try:
        if not VAPID_PEM.exists():
            v = Vapid()
            v.generate_keys()
            v.save_key(str(VAPID_PEM))
        v = Vapid.from_file(str(VAPID_PEM))
        raw = v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        VAPID_PUBLIC = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    except Exception as e:  # pragma: no cover
        print("push disabled:", e)
        PUSH = False


def push_notify(target, body, url, exclude_did=None):
    """Generic payloads only: never message content."""
    if not PUSH:
        return

    def run():
        payload = json.dumps({"title": APP_NAME, "body": body, "url": url})
        for r in q("SELECT id, did, sub FROM push_subs WHERE target=?", target):
            if r["did"] == exclude_did:
                continue
            try:
                webpush(json.loads(r["sub"]), payload, vapid_private_key=str(VAPID_PEM),
                        vapid_claims={"sub": VAPID_SUB}, ttl=3600)
            except WebPushException as e:
                if e.response is not None and e.response.status_code in (404, 410):
                    x("DELETE FROM push_subs WHERE id=?", r["id"])
            except Exception:
                pass

    threading.Thread(target=run, daemon=True).start()


# ---------------------------------------------------------------- request context


def check_group(gid, v, ip, did):
    g = q1("SELECT * FROM groups WHERE id=?", gid)
    if not g:
        raise ApiError(404, "No such group")
    keys = [f"bad:ip:{ip}:{gid}"] + ([f"bad:did:{did}:{gid}"] if did else [])
    if any(limiter.count(k, 900) >= 30 for k in keys):  # 60-bit codes: online guessing is hopeless, this only slows floods
        raise ApiError(429, "Too many wrong codes. Try again later.")
    if not isinstance(v, str) or not B64_32.match(v) or not hmac.compare_digest(vhash(v), g["vhash"]):
        for k in keys:
            limiter.add(k)
        raise ApiError(403, "Wrong code")
    return g


def content_length(handler):
    raw = handler.headers.get("Content-Length") or "0"
    if not raw.isdigit() or len(raw) > 12:
        raise ApiError(400, "Bad Content-Length")
    return int(raw)


class Ctx:
    def __init__(self, handler):
        self.h = handler
        self.ip = handler.client_ip()
        key = handler.headers.get("X-Key", "")
        self.did = hashlib.sha256(key.encode()).hexdigest() if re.fullmatch(r"[0-9a-f]{64}", key) else None
        tok = handler.headers.get("X-Admin", "")
        self.is_admin = bool(ADMIN_TOKEN) and bool(tok) and hmac.compare_digest(tok, ADMIN_TOKEN)
        if tok and not self.is_admin:  # a wrong admin token counts: after 8 misses the door stays shut for 15 minutes
            if limiter.count(f"adm:{self.ip}", 900) >= 8:
                raise ApiError(429, "Too many wrong admin tokens. Try again later.")
            limiter.add(f"adm:{self.ip}")
        self.query = parse_qs(urlparse(handler.path).query)
        self._body = None

    def need_did(self):
        if not self.did:
            raise ApiError(401, "Missing device key")
        return self.did

    def json(self):
        if self._body is None:
            n = content_length(self.h)
            if n > 65536:
                raise ApiError(413, "Too large")
            raw = self.h.rfile.read(n) if n else b""
            try:
                self._body = json.loads(raw or b"{}")
            except ValueError:
                raise ApiError(400, "Bad JSON")
            if not isinstance(self._body, dict):
                raise ApiError(400, "Bad JSON")
        return self._body

    def throttle(self, name, per_ip, per_did, window):
        if not limiter.hit(f"{name}:ip:{self.ip}", per_ip, window):
            raise ApiError(429, "Slow down")
        if not limiter.hit(f"{name}:all", per_ip * 10, window):  # a device id costs nothing to invent: this is the backstop
            raise ApiError(429, "Busy. Try again in a moment.")
        if self.did and not limiter.hit(f"{name}:did:{self.did}", per_did, window):
            raise ApiError(429, "Slow down")

    def group(self, gid):
        """Authenticate a group request with the verifier header."""
        return check_group(gid, self.h.headers.get("X-Verifier", ""), self.ip, self.did)


# ---------------------------------------------------------------- API: identity


def build_id():
    """Changes whenever a file in public/ changes, so open apps can notice that a new version is live."""
    h = hashlib.sha1()
    for f in sorted(PUBLIC.iterdir()):
        if f.is_file():
            st = f.stat()
            h.update(f"{f.name}:{st.st_mtime_ns}:{st.st_size}".encode())
    return h.hexdigest()[:12]


def api_config(c):
    return 200, {"app": APP_NAME, "label": LABEL[:12], "notice": NOTICE[:200], "notice_more": [t[:600] for t in NOTICE_MORE], "boards": [{"id": b, "title": t} for b, t in BOARDS],
                 "ttls": list(GROUP_TTLS), "push": bool(PUSH), "admin": c.is_admin,
                 "limits": {"img": IMG_MAX, "vid": VID_MAX}, "source": SOURCE_URL, "keep": keep(), "settings": settings(), "version": VERSION, "build": build_id()}


def api_activity(c):
    """When something last happened on each board and in the groups the phone asks about: only times, never content.
    The phone compares them with what it last saw, to show an asterisk."""
    boards = {r["board"]: r["t"] for r in q("SELECT board, MAX(bump) t FROM threads GROUP BY board")}
    ids = [i for i in c.query.get("groups", [""])[0].split(",") if re.fullmatch(r"[0-9a-f]{16}", i)][:50]
    groups, voice = {}, {}
    for i in ids:
        r = q1("SELECT last_act FROM groups WHERE id=?", i)
        if r:
            groups[i] = r["last_act"]
            with voice_lock:
                n = sum(1 for c in voice_rooms.get(i, ()) if c.speaker)  # people listening do not count: with auto-connect every open chat would
            if n:
                voice[i] = n  # how many are speaking right now, never who
    return 200, {"boards": boards, "groups": groups, "voice": voice}


def api_me(c):
    did = c.need_did()
    r = q1("SELECT name, code_hash FROM names WHERE did=?", did)
    return 200, {"pseudo": r["name"] if r else None, "has_code": bool(r and r["code_hash"])}


def api_claim(c):
    did = c.need_did()
    c.throttle("claim", 10, 5, 3600)
    name = clean(c.json().get("name"), 20)
    if not NAME_RE.match(name):
        raise ApiError(400, "2-20 chars: letters, digits, _ . -")
    low = name.lower()
    if low in RESERVED or low.startswith("anon"):
        raise ApiError(400, "That name is reserved")
    with tx():
        if pseudo_of(did):
            raise ApiError(409, "Release your current pseudonym first")
        if q1("SELECT COUNT(*) n FROM names")["n"] >= MAX_NAMES:
            raise ApiError(507, "This server has no room for more names")
        if q1("SELECT 1 FROM names WHERE lname=?", low):
            raise ApiError(409, "Name already taken")
        x("INSERT INTO names(lname,name,did,ts) VALUES(?,?,?,?)", low, name, did, int(time.time()))
    return 200, {"pseudo": name}


def code_hash(code, salt):
    return hashlib.pbkdf2_hmac("sha256", code.encode(), salt, 200_000).hex()


WEAK_CODES = {"123123", "112233", "121212", "696969", "159753", "147258", "258369", "123321", "654321", "123456", "234567", "345678", "456789"}


def weak_code(code):
    """Online guessing is rate-limited, but do not allow the obvious ones."""
    if len(set(code)) == 1 or code in WEAK_CODES:
        return True
    if code in "01234567890123456789" or code in "98765432109876543210":
        return True
    return code[:2] * 3 == code or code[:3] * 2 == code


def api_code_set(c):
    """Create (or replace) a random 6-digit login code for the pseudonym. Shown once."""
    did = c.need_did()
    c.throttle("code", 30, 10, 3600)
    if not pseudo_of(did):
        raise ApiError(400, "Claim a pseudonym first")
    chosen = str(c.json().get("code", "")).strip()
    if chosen:
        if not re.fullmatch(r"\d{6}", chosen):
            raise ApiError(400, "Use exactly 6 digits")
        if weak_code(chosen):
            raise ApiError(400, "Too easy to guess. Pick something less obvious.")
        code = chosen
    else:  # nothing typed: make a random one
        code = "%06d" % secrets.randbelow(1000000)
        while weak_code(code):
            code = "%06d" % secrets.randbelow(1000000)
    salt = secrets.token_bytes(16)
    x("UPDATE names SET code_hash=?, code_salt=? WHERE did=?", code_hash(code, salt), salt.hex(), did)
    return 200, {"code": code} if not chosen else {"saved": True}


def api_code_clear(c):
    did = c.need_did()
    x("UPDATE names SET code_hash=NULL, code_salt=NULL WHERE did=?", did)
    return 200, {"ok": True}


def api_login(c):
    """Move a pseudonym to this device with name + 6-digit code. Only possible if the owner created a code."""
    did = c.need_did()
    j = c.json()
    low = clean(j.get("name"), 20).lower()
    code = str(j.get("code", "")).strip()
    keys = [(f"login:name:{low}", 30), (f"login:ip:{c.ip}", 15), (f"login:did:{did}", 15)]  # per 24h, failures only
    if any(limiter.count(k, 86400) >= cap for k, cap in keys):
        raise ApiError(429, "Too many attempts. Try again tomorrow.")
    row = q1("SELECT * FROM names WHERE lname=?", low)
    ok = False
    if row and row["code_hash"] and re.fullmatch(r"\d{6}", code):
        ok = hmac.compare_digest(code_hash(code, bytes.fromhex(row["code_salt"])), row["code_hash"])
    else:
        code_hash("000000", b"\0" * 16)  # similar timing either way
    if not ok:
        for k, _ in keys:
            limiter.add(k)
        raise ApiError(403, "Wrong name or code")
    with tx():
        if row["did"] != did:
            if pseudo_of(did):
                raise ApiError(409, "Release your current pseudonym first")
            x("UPDATE names SET did=? WHERE lname=?", did, low)  # posts stay editable only from the phone that wrote them
    return 200, {"pseudo": row["name"]}


def release_name(lname, did):
    """Give a name back. Its old board posts turn anonymous again, and its closed-chat messages are removed (their sender is
    part of what is locked, so they cannot be relabelled). Whoever claims the name next does not inherit any of it."""
    gone = {}
    with tx():
        for r in q("SELECT id, thread_id FROM posts WHERE kind='p' AND lower(sender)=?", lname):
            x("UPDATE posts SET sender=?, kind='a' WHERE id=?", anon_label(did, f"t{r['thread_id']}"), r["id"])
        for r in q("SELECT id, gid FROM gmsgs WHERE kind='p' AND lower(sender)=?", lname):
            gone.setdefault(r["gid"], []).append(r["id"])
        x("DELETE FROM names WHERE lname=?", lname)
    for gid, ids in gone.items():
        delete_msgs(gid, ids)


def api_release(c):
    did = c.need_did()
    r = q1("SELECT lname FROM names WHERE did=?", did)
    if r:
        release_name(r["lname"], did)
    return 200, {"pseudo": None}


# ---------------------------------------------------------------- API: boards


def sniff(b):
    """Detect the real file type from magic bytes. Never trust the client's label."""
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    if b[4:8] == b"ftyp":
        return "video/quicktime" if b[8:12] == b"qt  " else "video/mp4"
    if b[:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm"
    return None


def drop_media(ids):
    for mid in ids:
        if not mid:
            continue
        x("DELETE FROM media WHERE id=?", mid)
        try:
            (MEDIA / mid).unlink()
        except OSError:
            pass


def claim_media(did, mid, kind, gid=None):
    if not mid:
        return None
    r = q1("SELECT * FROM media WHERE id=?", str(mid))
    if not r or r["did"] != did or r["linked"] or r["kind"] != kind or r["gid"] != gid:
        raise ApiError(400, "Bad attachment")
    return r


media_lock = threading.Lock()
media_reserved = 0  # bytes of uploads that are still arriving
media_uploads = {}  # device -> uploads in progress
media_by_ip = {}  # ip -> [(time, bytes)] of the last hour
MEDIA_PER_IP_HOUR = 1024 * 1024 * 1024


def api_media_upload(c):
    did = c.need_did()
    scope = c.query.get("scope", [""])[0]
    gid = None
    if scope == "group":
        gid = c.query.get("gid", [""])[0]
        c.group(gid)
    elif scope != "board":
        raise ApiError(400, "Bad scope")
    c.throttle("upload", 60, 30, 600)
    n = content_length(c.h)
    if n <= 0 or n > VID_MAX + 64:
        raise ApiError(413, "File too large (max %d MB)" % (VID_MAX // 1048576))
    global media_reserved
    with media_lock:  # check and reserve in one step, so parallel uploads cannot all slip under the quota
        if q1("SELECT COALESCE(SUM(size),0) s FROM media")["s"] + media_reserved + n > MEDIA_QUOTA:
            raise ApiError(507, "Server media storage is full")
        if q1("SELECT COALESCE(SUM(size),0) s FROM media WHERE did=? AND linked=0", did)["s"] + n > MEDIA_PENDING_PER_DEVICE:
            raise ApiError(429, "Post your earlier uploads first")
        if media_uploads.get(did, 0) >= 3:
            raise ApiError(429, "Three uploads at a time")
        now = time.time()
        recent = [(t, b) for t, b in media_by_ip.get(c.ip, []) if now - t < 3600]  # in memory only, like all limits
        if sum(b for _, b in recent) + n > MEDIA_PER_IP_HOUR:
            raise ApiError(429, "Too much uploaded from here in the last hour")
        media_by_ip[c.ip] = recent + [(now, n)]
        media_reserved += n
        media_uploads[did] = media_uploads.get(did, 0) + 1
    try:
        return upload_stream(c, did, scope, gid, n)
    finally:
        with media_lock:
            media_reserved -= n
            media_uploads[did] -= 1
            if media_uploads[did] <= 0:
                del media_uploads[did]


def upload_stream(c, did, scope, gid, n):
    rfile = c.h.rfile
    head = rfile.read(min(n, 16))
    mime = "application/octet-stream"  # group blobs are encrypted: the server cannot and should not know what they are
    if scope == "board":
        mime = sniff(head)
        if not mime:
            raise ApiError(415, "Only JPEG, PNG, GIF, WebP, MP4, MOV and WebM")
        if mime.startswith("image/") and n > IMG_MAX:
            raise ApiError(413, "Image too large (max %d MB)" % (IMG_MAX // 1048576))
    mid = secrets.token_hex(10)
    part = MEDIA / (mid + ".part")
    try:  # stream to disk in chunks so a big video never sits in memory
        with open(part, "wb") as f:
            f.write(head)
            left = n - len(head)
            while left > 0:
                chunk = rfile.read(min(1 << 20, left))
                if not chunk:
                    raise ApiError(400, "Upload cut off")
                f.write(chunk)
                left -= len(chunk)
        part.rename(MEDIA / mid)
    except BaseException:
        try:
            part.unlink()
        except OSError:
            pass
        raise
    x("INSERT INTO media(id,did,kind,gid,mime,size,ts,linked) VALUES(?,?,?,?,?,?,?,0)",
      mid, did, scope, gid, mime, n, int(time.time()))
    return 200, {"id": mid, "mime": mime, "size": n}


def likers(kind, target):
    return [r["did"] for r in q("SELECT did FROM likes WHERE kind=? AND target=?", kind, target)]


def api_board(c, board):
    if board not in BOARD_IDS:
        raise ApiError(404, "No such board")
    rows = q("""SELECT t.id, t.subject, t.replies, t.bump, t.created, p.sender, p.kind, p.body, p.media_id, p.edited,
                (SELECT mime FROM media WHERE id=p.media_id) mmime, (SELECT size FROM media WHERE id=p.media_id) msize,
                (SELECT COUNT(*) FROM likes l WHERE l.kind='p' AND l.target=p.id) likes
                FROM threads t JOIN posts p ON p.id=t.id WHERE t.board=? ORDER BY t.bump DESC LIMIT ?""",
             board, settings()["board_threads"])
    out = []
    for r in rows:
        d = dict(r)
        d["body"] = d["body"][:400]
        out.append(d)
    return 200, {"board": board, "title": dict(BOARDS)[board], "threads": out}


def api_thread(c, tid):
    t = q1("SELECT * FROM threads WHERE id=?", int(tid))
    if not t:
        raise ApiError(404, "Thread gone")
    rows = q("""SELECT id, sender, kind, body, ts, is_op, media_id, edited, cid, did own,
                (SELECT mime FROM media WHERE id=posts.media_id) mmime, (SELECT size FROM media WHERE id=posts.media_id) msize
                FROM posts WHERE thread_id=? ORDER BY id""", t["id"])
    posts = [dict(r) for r in rows]
    lk = {}
    for r in q("SELECT target, did FROM likes WHERE kind='p' AND target IN (SELECT id FROM posts WHERE thread_id=?)", t["id"]):
        lk.setdefault(r["target"], []).append(r["did"])
    for p in posts:  # the phone works out for itself which posts and likes are its own
        p["lk"] = lk.get(p["id"], [])
        p["likes"] = len(p["lk"])
    return 200, {"id": t["id"], "board": t["board"], "subject": t["subject"],
                 "full": t["replies"] >= MAX_REPLIES, "posts": posts}


def check_mode(j):
    mode = j.get("mode", "anon")
    return "pseudo" if mode == "pseudo" else "anon"


def api_new_thread(c, board):
    did = c.need_did()
    if board not in BOARD_IDS:
        raise ApiError(404, "No such board")
    c.throttle("post", 20, 4, 60)
    j = c.json()
    body = clean(j.get("body"), 2000)
    subject = clean(j.get("subject"), 80).replace("\n", " ")
    media = j.get("media")
    cid, own = new_cid(j), proof_hash(c, "X-Own")
    if not body and not media:
        raise ApiError(400, "Write something")
    now = int(time.time())
    with tx():
        claim_media(did, media, "board")
        pid = x("INSERT INTO posts(thread_id,board,is_op,sender,kind,did,body,ts,media_id) VALUES(0,?,1,'','a','',?,?,?)",
                board, body, now, media or None).lastrowid
        if media:
            x("UPDATE media SET linked=1, did=NULL WHERE id=?", media)
        sender, kind = resolve_sender(did, check_mode(j), f"t{pid}")
        x("UPDATE posts SET thread_id=?, sender=?, kind=?, did=?, cid=? WHERE id=?", pid, sender, kind, own, cid, pid)
        x("INSERT INTO threads(id,board,subject,bump,created,replies) VALUES(?,?,?,?,?,0)", pid, board, subject, now, now)
        prune_threads(board)
    hub.pub(f"board:{board}", {"type": "thread"})
    feed_pub()
    push_notify(f"board:{board}", f"New thread in /{board}/", f"#/b/{board}", did)
    return 200, {"id": pid}


def prune_threads(board):
    old = q("SELECT id FROM threads WHERE board=? ORDER BY bump DESC LIMIT -1 OFFSET ?", board, settings()["board_threads"])
    for r in old:
        delete_thread(r["id"])


def delete_thread(tid):
    mids = [r["media_id"] for r in q("SELECT media_id FROM posts WHERE thread_id=?", tid)]
    x("DELETE FROM likes WHERE kind='p' AND target IN (SELECT id FROM posts WHERE thread_id=?)", tid)
    x("DELETE FROM reports WHERE post_id IN (SELECT id FROM posts WHERE thread_id=?)", tid)
    x("DELETE FROM posts WHERE thread_id=?", tid)
    x("DELETE FROM threads WHERE id=?", tid)
    drop_media(mids)


def api_reply(c, tid):
    did = c.need_did()
    c.throttle("post", 20, 4, 60)
    j = c.json()
    body = clean(j.get("body"), 2000)
    media = j.get("media")
    cid, own = new_cid(j), proof_hash(c, "X-Own")
    if not body and not media:
        raise ApiError(400, "Write something")
    now = int(time.time())
    with tx():
        claim_media(did, media, "board")
        t = q1("SELECT * FROM threads WHERE id=?", int(tid))
        if not t:
            raise ApiError(404, "Thread gone")
        if t["replies"] >= MAX_REPLIES:
            raise ApiError(400, "Thread is full")
        sender, kind = resolve_sender(did, check_mode(j), f"t{t['id']}")
        pid = x("INSERT INTO posts(thread_id,board,is_op,sender,kind,did,body,ts,media_id,cid) VALUES(?,?,0,?,?,?,?,?,?,?)",
                t["id"], t["board"], sender, kind, own, body, now, media or None, cid).lastrowid
        if media:
            x("UPDATE media SET linked=1, did=NULL WHERE id=?", media)
        x("UPDATE threads SET replies=replies+1 WHERE id=?", t["id"])
        x("UPDATE threads SET bump=? WHERE id=?", now, t["id"])
    hub.pub(f"thread:{t['id']}", {"type": "post", "id": pid})
    hub.pub(f"board:{t['board']}", {"type": "reply"})
    feed_pub()
    push_notify(f"board:{t['board']}", f"New reply in /{t['board']}/", f"#/b/{t['board']}", did)
    return 200, {"id": pid}


def api_edit_post(c, pid):
    """Authors can edit their own post. Edits are always marked 'edited'."""
    did = c.need_did()
    c.throttle("edit", 30, 10, 60)
    j = c.json()
    body = clean(j.get("body"), 2000)
    now = int(time.time())
    with tx():
        p = q1("SELECT * FROM posts WHERE id=?", int(pid))
        if not p:
            raise ApiError(404, "Post gone")
        if p["did"] != proof_hash(c, "X-Own"):
            raise ApiError(403, "That is not your post")
        drop = bool(j.get("remove_media")) and bool(p["media_id"])
        if not body and (not p["media_id"] or drop):
            raise ApiError(400, "Write something")
        sender, kind = p["sender"], p["kind"]
        if j.get("link_pseudonym") and kind == "a":  # one-way: an anonymous post can be claimed by its author
            name = pseudo_of(did)
            if not name:
                raise ApiError(400, "Claim a pseudonym first (Me page)")
            sender, kind = name, "p"
        changed = body != p["body"] or (sender, kind) != (p["sender"], p["kind"]) or drop
        if drop:
            x("UPDATE posts SET media_id=NULL WHERE id=?", p["id"])
            drop_media([p["media_id"]])
        if p["is_op"] and "subject" in j:
            subj = clean(j.get("subject"), 80).replace("\n", " ")
            if subj != q1("SELECT subject FROM threads WHERE id=?", p["thread_id"])["subject"]:
                x("UPDATE threads SET subject=? WHERE id=?", subj, p["thread_id"])
                changed = True
        if changed:
            x("UPDATE posts SET body=?, sender=?, kind=?, edited=? WHERE id=?", body, sender, kind, now, p["id"])
    hub.pub(f"thread:{p['thread_id']}", {"type": "edit", "id": p["id"]})
    hub.pub(f"board:{p['board']}", {"type": "edit"})
    return 200, {"edited": now if changed else p["edited"], "sender": sender, "kind": kind}


def api_like_post(c, pid):
    did = c.need_did()
    c.throttle("like", 60, 30, 60)
    lt = proof_hash(c, "X-Tok")
    if not q1("SELECT 1 FROM posts WHERE id=?", int(pid)):
        raise ApiError(404, "Post gone")
    with tx():
        if q1("SELECT 1 FROM likes WHERE kind='p' AND target=? AND did=?", int(pid), lt):
            x("DELETE FROM likes WHERE kind='p' AND target=? AND did=?", int(pid), lt)
        else:
            x("INSERT INTO likes VALUES('p',?,?)", int(pid), lt)
    mine = bool(q1("SELECT 1 FROM likes WHERE kind='p' AND target=? AND did=?", int(pid), lt))
    n = len(likers("p", int(pid)))
    p = q1("SELECT thread_id, board FROM posts WHERE id=?", int(pid))
    hub.pub(f"thread:{p['thread_id']}", {"type": "like", "id": int(pid), "n": n})
    if mine:
        push_notify(f"board:{p['board']}", f"New like in /{p['board']}/", f"#/b/{p['board']}", did)
    return 200, {"likes": n, "liked": mine}


def api_report(c, pid):
    did = c.need_did()
    c.throttle("report", 20, 10, 3600)
    if not q1("SELECT 1 FROM posts WHERE id=?", int(pid)):
        raise ApiError(404, "Post gone")
    x("INSERT OR IGNORE INTO reports(post_id,did,ts) VALUES(?,?,?)", int(pid), proof_hash(c, "X-Tok"), int(time.time()))
    return 200, {"ok": True}


def api_admin_settings_get(c):
    if not c.is_admin:
        raise ApiError(403, "Admins only")
    return 200, {"settings": settings(), "options": SETTING_OPTIONS}


def api_admin_settings_set(c):
    if not c.is_admin:
        raise ApiError(403, "Admins only")
    j = c.json()
    k, v = str(j.get("key", "")), str(j.get("value", "")).strip()
    if k not in SETTING_OPTIONS or v not in SETTING_OPTIONS[k]:
        raise ApiError(400, "Not a valid setting")
    x("INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)", k, v)
    return 200, {"settings": settings(), "options": SETTING_OPTIONS}


def need_admin(c):
    if not c.is_admin:
        raise ApiError(403, "Admins only")


def api_admin_stats(c):
    need_admin(c)
    one = lambda sql, *a: q1(sql, *a)["n"]  # noqa: E731
    db_bytes = sum(p.stat().st_size for p in DATA.glob("bunker.db*") if p.is_file())
    boards = {b: {"threads": one("SELECT COUNT(*) n FROM threads WHERE board=?", b), "posts": one("SELECT COUNT(*) n FROM posts WHERE board=?", b)} for b, _ in BOARDS}
    return 200, {"boards": boards, "groups": one("SELECT COUNT(*) n FROM groups"), "messages": one("SELECT COUNT(*) n FROM gmsgs"),
                 "names": one("SELECT COUNT(*) n FROM names"), "push": one("SELECT COUNT(*) n FROM push_subs"), "reports": one("SELECT COUNT(DISTINCT post_id) n FROM reports"),
                 "media": one("SELECT COUNT(*) n FROM media"), "media_bytes": q1("SELECT COALESCE(SUM(size),0) n FROM media")["n"], "db_bytes": db_bytes,
                 "online": sum(len(v) for v in voice_rooms.values())}


def api_admin_threads(c):
    need_admin(c)
    board = c.query.get("board", [""])[0]
    if board not in BOARD_IDS:
        raise ApiError(400, "No such board")
    rows = q("""SELECT t.id, t.subject, t.replies, t.bump, substr(p.body,1,120) body FROM threads t JOIN posts p ON p.id=t.id
                WHERE t.board=? ORDER BY t.bump DESC""", board)
    return 200, {"threads": [dict(r) for r in rows]}


def api_admin_groups(c):
    need_admin(c)
    rows = q("""SELECT g.*, (SELECT COUNT(*) FROM gmsgs m WHERE m.gid=g.id) msgs FROM groups g ORDER BY g.last_act DESC""")
    return 200, {"groups": [{"id": r["id"], "name": r["name"], "num": r["num"], "closed": bool(r["hidden"]), "ttl": r["ttl"], "created": r["created"],
                             "last_act": r["last_act"], "msgs": r["msgs"], "online": hub.count(f"group:{r['id']}")} for r in rows]}


def api_admin_group_clear(c, gid):
    need_admin(c)
    if not q1("SELECT 1 FROM groups WHERE id=?", gid):
        raise ApiError(404, "No such group")
    delete_msgs(gid, [r["id"] for r in q("SELECT id FROM gmsgs WHERE gid=?", gid)])
    return 200, {"ok": True}


def api_admin_names(c):
    need_admin(c)
    return 200, {"names": [{"name": r["name"], "ts": r["ts"]} for r in q("SELECT name, ts FROM names ORDER BY ts DESC")]}


def api_admin_name_release(c, lname):
    need_admin(c)
    r = q1("SELECT did FROM names WHERE lname=?", lname.lower())
    if r:
        release_name(lname.lower(), r["did"])
    return 200, {"ok": True}


def api_admin_report_dismiss(c, pid):
    need_admin(c)
    x("DELETE FROM reports WHERE post_id=?", int(pid))
    return 200, {"ok": True}


def api_admin_secret_clear(c):
    need_admin(c)
    old = q1("SELECT media_id FROM secret WHERE id=1")
    x("DELETE FROM secret WHERE id=1")
    if old and old["media_id"]:
        drop_media([old["media_id"]])
    return 200, {"ok": True}


def api_admin_purge(c):
    """Big deletes. The page asks for the word WIPE first; the server wants it too."""
    need_admin(c)
    j = c.json()
    if j.get("confirm") != "WIPE":
        raise ApiError(400, "Type WIPE to confirm")
    what = j.get("what")
    if what not in ("messages", "media", "boards", "names", "push", "all"):
        raise ApiError(400, "Unknown")
    everything = what == "all"
    with tx():
        if what in ("messages", "all"):
            drop_media([r["id"] for r in q("SELECT id FROM media WHERE kind='group'")])
            x("DELETE FROM likes WHERE kind IN ('m','b')")
            x("DELETE FROM gmsgs")
        if what in ("boards", "all"):
            drop_media([r["media_id"] for r in q("SELECT media_id FROM posts WHERE media_id IS NOT NULL")])
            x("DELETE FROM likes WHERE kind='p'")
            x("DELETE FROM reports")
            x("DELETE FROM posts")
            x("DELETE FROM threads")
        if what in ("media", "all"):
            drop_media([r["id"] for r in q("SELECT id FROM media")])
            x("UPDATE posts SET media_id=NULL")
            x("UPDATE gmsgs SET media_id=NULL")
            x("UPDATE secret SET media_id=NULL")
        if what in ("names", "all"):
            x("DELETE FROM names")
        if what in ("push", "all"):
            x("DELETE FROM push_subs")
        if everything:
            x("DELETE FROM secret")
    if everything:
        for g in q("SELECT id FROM groups"):
            purge_group(g["id"])
    return 200, {"ok": True}


def api_admin_reports(c):
    if not c.is_admin:
        raise ApiError(403, "Admins only")
    rows = q("""SELECT r.post_id, COUNT(*) n, p.thread_id, p.board, substr(p.body,1,200) body
                FROM reports r JOIN posts p ON p.id=r.post_id GROUP BY r.post_id ORDER BY n DESC""")
    return 200, {"reports": [dict(r) for r in rows]}


def api_admin_del_post(c, pid):
    """Moderators can delete any post, authors their own. Deleting a thread's first post removes the thread."""
    p = q1("SELECT * FROM posts WHERE id=?", int(pid))
    if not p:
        raise ApiError(404, "Post gone")
    if not c.is_admin and not (c.did and p["did"] == proof_hash(c, "X-Own")):
        raise ApiError(403, "That is not your post")
    c.throttle("del", 60, 20, 60)
    with tx():
        if p["is_op"]:
            delete_thread(p["thread_id"])
        else:
            x("DELETE FROM likes WHERE kind='p' AND target=?", p["id"])
            x("DELETE FROM reports WHERE post_id=?", p["id"])
            x("DELETE FROM posts WHERE id=?", p["id"])
            drop_media([p["media_id"]])
            x("UPDATE threads SET replies=MAX(replies-1,0) WHERE id=?", p["thread_id"])
    hub.pub(f"thread:{p['thread_id']}", {"type": "gone" if p["is_op"] else "edit", "id": p["id"]})
    hub.pub(f"board:{p['board']}", {"type": "gone" if p["is_op"] else "edit"})
    return 200, {"ok": True}


# ---------------------------------------------------------------- API: groups


def group_public(g):
    return {"id": g["id"], "name": g["name"], "ttl": g["ttl"], "last_act": g["last_act"],
            "online": hub.count(f"group:{g['id']}"), "closed": bool(g["hidden"]), "num": g["num"]}


def group_label(g):
    return g["name"] + (f" #{g['num']:04d}" if g["num"] else "")


def api_groups(c):
    """Open groups are listed. Closed groups are hidden: they only show up for their 4-digit code."""
    term = re.sub(r"\s+", " ", clean(c.query.get("q", [""])[0], 32).lower())
    code = re.fullmatch(r"#?\s*(\d{4})", term)
    named = re.fullmatch(r"(.+?)\s*#\s*(\d{1,4})", term)
    like = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    if code:  # "4821": the code finds the closed group (and an open group whose name happens to contain it)
        c.throttle("gfind", 40, 25, 60)
        rows = q("SELECT * FROM groups WHERE num=? OR (lname LIKE ? ESCAPE '\\' AND COALESCE(hidden,0)=0) "
                 "ORDER BY COALESCE(hidden,0), last_act DESC LIMIT 20", int(code.group(1)), like)
    elif named:  # "name #4821" works too
        c.throttle("gfind", 40, 25, 60)
        rows = q("SELECT * FROM groups WHERE lname=? AND num=?", named.group(1).strip(), int(named.group(2)))
    else:
        rows = q("SELECT * FROM groups WHERE lname LIKE ? ESCAPE '\\' AND COALESCE(hidden,0)=0 "
                 "ORDER BY last_act DESC LIMIT 200", like)
    return 200, {"groups": [group_public(g) for g in rows]}


def api_group_create(c):
    c.need_did()
    c.throttle("gcreate", 6, 4, 3600)
    j = c.json()
    name = re.sub(r"\s+", " ", clean(j.get("name"), 32))
    if not GROUP_RE.match(name):
        raise ApiError(400, "2-32 chars: letters, digits, space, _ . -")
    ver = j.get("verifier", "")
    if not B64_32.match(ver):
        raise ApiError(400, "Bad verifier")
    ttl = GROUP_TTLS.get(j.get("ttl", "24h"))
    if ttl is None:
        raise ApiError(400, "Bad ttl")
    lname = name.lower()
    if q1("SELECT COUNT(*) n FROM groups")["n"] >= MAX_GROUPS:
        raise ApiError(507, "This server has no room for more chats")
    hidden = 1 if j.get("closed") else 0  # closed = needs a code; open = anyone can join
    taken = "There is already an open group with that name. Make yours closed, or pick another name."
    if hidden:  # closed groups get a random number from the creator's device (it is part of the key salt)
        num = j.get("num")
        if not isinstance(num, int) or isinstance(num, bool) or not 1000 <= num <= 9999:
            raise ApiError(400, "Bad group number")
    else:  # the one open group of a name is always #1
        num = 1
        if q1("SELECT 1 FROM groups WHERE lname=? AND COALESCE(hidden,0)=0", lname):
            raise ApiError(409, taken)
    gid = secrets.token_hex(8)
    now = int(time.time())
    try:
        x("INSERT INTO groups(id,name,lname,vhash,ttl,created,last_act,hidden,num) VALUES(?,?,?,?,?,?,?,?,?)",
          gid, name, lname, vhash(ver), ttl, now, now, hidden, num)
    except sqlite3.IntegrityError:
        raise ApiError(409, "Number already used, try again" if hidden else taken)
    return 200, {"id": gid, "name": name, "num": num}


def msg_json(r):
    lk, bk = likers("m", r["id"]), likers("b", r["id"])
    msize = None
    if r["media_id"]:
        row = q1("SELECT size FROM media WHERE id=?", r["media_id"])
        msize = row["size"] if row else None
    return {"id": r["id"], "sender": r["sender"], "kind": r["kind"], "ct": r["ct"], "iv": r["iv"], "cid": r["cid"], "own": r["did"],
            "ts": r["ts"], "likes": len(lk), "broken": len(bk), "lk": lk, "bk": bk, "media": r["media_id"], "msize": msize,
            "edited": r["edited"]}


def expire_group(g):
    if g["ttl"]:
        gone = [r["id"] for r in q("SELECT id FROM gmsgs WHERE gid=? AND ts<?", g["id"], int(time.time()) - g["ttl"])]
        if gone:
            delete_msgs(g["id"], gone)


def delete_msgs(gid, ids):
    with tx():
        for i in ids:
            drop_media([r["media_id"] for r in q("SELECT media_id FROM gmsgs WHERE id=?", i)])
            x("DELETE FROM gmsgs WHERE id=?", i)
            x("DELETE FROM likes WHERE kind IN ('m','b') AND target=?", i)
    hub.pub(f"group:{gid}", {"type": "prune", "ids": ids})


def api_group_open(c, gid):
    g = c.group(gid)
    expire_group(g)
    rows = q("SELECT * FROM (SELECT * FROM gmsgs WHERE gid=? ORDER BY id DESC LIMIT ?) ORDER BY id", gid, keep())
    me = pseudo_of(c.did) if c.did else None
    return 200, {"group": group_public(g), "you": {"anon": anon_label(c.did or "", gid), "pseudo": me},
                 "messages": [msg_json(r) for r in rows], "voice": voice_names(gid), "settings": settings()}


def api_group_send(c, gid):
    did = c.need_did()
    g = c.group(gid)
    c.throttle("gmsg", 40, 12, 20)
    j = c.json()
    ct, iv = j.get("ct", ""), j.get("iv", "")
    if not (isinstance(ct, str) and isinstance(iv, str)) or not 16 <= len(ct) <= 8192 or not 12 <= len(iv) <= 24:
        raise ApiError(400, "Bad message")
    if not re.fullmatch(r"[A-Za-z0-9+/=]+", ct) or not re.fullmatch(r"[A-Za-z0-9+/=]+", iv):
        raise ApiError(400, "Bad message")
    sender, kind = resolve_sender(did, check_mode(j), gid)
    if j.get("as") != sender:  # the sender's name is part of what the message is locked to, so the phone must have used the right one
        raise ApiError(409, "Your name changed. Close the chat and open it again.")
    cid, own = new_cid(j), proof_hash(c, "X-Own")
    now = int(time.time())
    media = j.get("media")
    try:
        with tx():
            claim_media(did, media, "group", gid)
            mid = x("INSERT INTO gmsgs(gid,sender,kind,ct,iv,ts,media_id,did,cid) VALUES(?,?,?,?,?,?,?,?,?)", gid, sender, kind, ct, iv, now, media or None, own, cid).lastrowid
            if media:
                x("UPDATE media SET linked=1, did=NULL WHERE id=?", media)
            x("UPDATE groups SET last_act=? WHERE id=?", now, gid)
            old = [r["id"] for r in q("SELECT id FROM gmsgs WHERE gid=? ORDER BY id DESC LIMIT -1 OFFSET ?", gid, keep())]
    except sqlite3.IntegrityError:
        raise ApiError(409, "That message was already sent")
    if old:
        delete_msgs(gid, old)
    m = msg_json(q1("SELECT * FROM gmsgs WHERE id=?", mid))
    hub.pub(f"group:{gid}", {"type": "msg", "m": m})
    feed_pub(gid)
    push_notify(f"group:{gid}", "You have a message" if g["hidden"] else f"New message in {group_label(g)}", f"#/g/{gid}", did)
    return 200, {"id": mid, "m": m}


def api_group_edit(c, gid, mid):
    """Authors can replace their own message. The new text arrives already encrypted, locked to the same sender and message id."""
    c.need_did()
    c.group(gid)
    c.throttle("gedit", 30, 10, 60)
    j = c.json()
    ct, iv = j.get("ct", ""), j.get("iv", "")
    if not (isinstance(ct, str) and isinstance(iv, str)) or not 16 <= len(ct) <= 8192 or not 12 <= len(iv) <= 24:
        raise ApiError(400, "Bad message")
    if not re.fullmatch(r"[A-Za-z0-9+/=]+", ct) or not re.fullmatch(r"[A-Za-z0-9+/=]+", iv):
        raise ApiError(400, "Bad message")
    own = proof_hash(c, "X-Own")
    now = int(time.time())
    with tx():
        r = q1("SELECT * FROM gmsgs WHERE id=? AND gid=?", int(mid), gid)
        if not r:
            raise ApiError(404, "Message gone")
        if r["did"] != own:
            raise ApiError(403, "That is not your message")
        x("UPDATE gmsgs SET ct=?, iv=?, edited=? WHERE id=?", ct, iv, now, r["id"])
        if j.get("remove_media") and r["media_id"]:
            x("UPDATE gmsgs SET media_id=NULL WHERE id=?", r["id"])
            drop_media([r["media_id"]])
    hub.pub(f"group:{gid}", {"type": "edit", "m": msg_json(q1("SELECT * FROM gmsgs WHERE id=?", int(mid)))})
    return 200, {"edited": now}


def api_group_delete(c, gid, mid):
    """Authors can take back their own message: it vanishes for everyone, like an expired one."""
    c.need_did()
    c.group(gid)
    c.throttle("gdel", 60, 20, 60)
    own = proof_hash(c, "X-Own")
    r = q1("SELECT did FROM gmsgs WHERE id=? AND gid=?", int(mid), gid)
    if not r:
        raise ApiError(404, "Message gone")
    if r["did"] != own:
        raise ApiError(403, "That is not your message")
    delete_msgs(gid, [int(mid)])
    return 200, {"ok": True}


def api_group_like(c, gid, mid):
    c.need_did()
    c.group(gid)
    c.throttle("like", 60, 30, 60)
    lt = proof_hash(c, "X-Tok")
    if not q1("SELECT 1 FROM gmsgs WHERE id=? AND gid=?", int(mid), gid):
        raise ApiError(404, "Message gone")
    kind = "b" if c.json().get("r") == "b" else "m"  # <3 or a broken heart; one reaction each
    other = "m" if kind == "b" else "b"
    with tx():
        if q1("SELECT 1 FROM likes WHERE kind=? AND target=? AND did=?", kind, int(mid), lt):
            x("DELETE FROM likes WHERE kind=? AND target=? AND did=?", kind, int(mid), lt)
        else:
            x("DELETE FROM likes WHERE kind=? AND target=? AND did=?", other, int(mid), lt)  # the same token serves both reactions
            x("INSERT INTO likes VALUES(?,?,?)", kind, int(mid), lt)
    lk, bk = likers("m", int(mid)), likers("b", int(mid))
    hub.pub(f"group:{gid}", {"type": "like", "id": int(mid), "n": len(lk), "b": len(bk)})
    return 200, {"likes": len(lk), "liked": lt in lk, "broken": len(bk), "bliked": lt in bk}


def api_secret_get(c):
    r = q1("SELECT s.text, s.media_id, s.ts, m.mime, m.size FROM secret s LEFT JOIN media m ON m.id=s.media_id WHERE s.id=1")
    if not r:
        return 200, {"text": "", "media": None}
    return 200, {"text": r["text"], "media": r["media_id"], "mime": r["mime"], "size": r["size"], "ts": r["ts"]}


def api_secret_put(c):
    """One photo and one message for everyone: whoever posts next replaces what was there."""
    did = c.need_did()
    c.throttle("secret", 60, 10, 60)
    j = c.json()
    text = clean(j.get("text"), 500)
    media = j.get("media") or None
    if not text and not media:
        raise ApiError(400, "Write something or add a photo")
    with tx():
        claim_media(did, media, "board")
        old = q1("SELECT media_id FROM secret WHERE id=1")
        x("INSERT OR REPLACE INTO secret(id,text,media_id,ts) VALUES(1,?,?,?)", text, media, int(time.time()))
        if media:
            x("UPDATE media SET linked=1, did=NULL WHERE id=?", media)
        if old and old["media_id"]:
            drop_media([old["media_id"]])
    return 200, {"ok": True}


def api_admin_del_group(c, gid):
    if not c.is_admin:
        raise ApiError(403, "Admins only")
    purge_group(gid)
    return 200, {"ok": True}


def purge_group(gid):
    voice_close_room(gid)
    with tx():
        x("DELETE FROM likes WHERE kind IN ('m','b') AND target IN (SELECT id FROM gmsgs WHERE gid=?)", gid)
        drop_media([r["id"] for r in q("SELECT id FROM media WHERE gid=?", gid)])
        x("DELETE FROM gmsgs WHERE gid=?", gid)
        x("DELETE FROM push_subs WHERE target=?", f"group:{gid}")
        x("DELETE FROM groups WHERE id=?", gid)
    hub.pub(f"group:{gid}", {"type": "gone"})


# ---------------------------------------------------------------- API: push


def api_push_key(c):
    if not PUSH:
        raise ApiError(501, "Push not available on this server")
    return 200, {"key": VAPID_PUBLIC}


def push_target_ok(c, target):
    if target.startswith("board:") and target[6:] in BOARD_IDS:
        return True
    if target.startswith("group:"):
        c.group(target[6:])
        return True
    return False


PUSH_HOSTS = ("fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com",
              "web.push.apple.com", "push.apple.com", "notify.windows.com")  # the browsers' own push services, nothing else


def push_endpoint_ok(url):
    """The server posts to this address later, so it must be a real push service and not any address an attacker picks."""
    try:
        u = urlparse(url)
        host = (u.hostname or "").lower()
        port = u.port
    except ValueError:
        return False
    return (u.scheme == "https" and not u.username and not u.password and port in (None, 443) and len(url) <= 600
            and any(host == h or host.endswith("." + h) for h in PUSH_HOSTS))


def api_push_sub(c):
    did = c.need_did()
    if not PUSH:
        raise ApiError(501, "Push not available on this server")
    c.throttle("push", 30, 20, 3600)
    j = c.json()
    sub, target = j.get("subscription"), str(j.get("target", ""))
    keys = sub.get("keys") if isinstance(sub, dict) else None
    if (not isinstance(keys, dict) or not push_endpoint_ok(str(sub.get("endpoint", "")))
            or not all(isinstance(keys.get(k), str) and 4 <= len(keys[k]) <= 200 for k in ("p256dh", "auth"))):
        raise ApiError(400, "Bad subscription")
    sub = {"endpoint": sub["endpoint"], "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}}
    if not push_target_ok(c, target):
        raise ApiError(400, "Bad target")
    if q1("SELECT COUNT(*) n FROM push_subs")["n"] >= MAX_PUSH_TOTAL or q1("SELECT COUNT(*) n FROM push_subs WHERE did=?", did)["n"] >= MAX_PUSH_PER_DEVICE:
        raise ApiError(507, "Too many notification subscriptions")
    x("INSERT OR REPLACE INTO push_subs(did,target,endpoint,sub,ts) VALUES(?,?,?,?,?)",
      did, target, sub["endpoint"], json.dumps(sub), int(time.time()))
    return 200, {"ok": True}


def api_push_unsub(c):
    did = c.need_did()
    target = str(c.json().get("target", ""))
    x("DELETE FROM push_subs WHERE did=? AND target=?", did, target)
    return 200, {"ok": True}


# ---------------------------------------------------------------- routing

ROUTES = [
    ("GET", r"/api/config", api_config),
    ("POST", r"/api/media", api_media_upload),
    ("GET", r"/api/secret", api_secret_get),
    ("POST", r"/api/secret", api_secret_put),
    ("GET", r"/api/me", api_me),
    ("GET", r"/api/activity", api_activity),
    ("POST", r"/api/name", api_claim),
    ("DELETE", r"/api/name", api_release),
    ("POST", r"/api/name/code", api_code_set),
    ("DELETE", r"/api/name/code", api_code_clear),
    ("POST", r"/api/login", api_login),
    ("GET", r"/api/boards/([a-z]+)", api_board),
    ("POST", r"/api/boards/([a-z]+)/threads", api_new_thread),
    ("GET", r"/api/threads/(\d+)", api_thread),
    ("POST", r"/api/threads/(\d+)/posts", api_reply),
    ("POST", r"/api/posts/(\d+)/like", api_like_post),
    ("POST", r"/api/posts/(\d+)/edit", api_edit_post),
    ("POST", r"/api/posts/(\d+)/report", api_report),
    ("DELETE", r"/api/posts/(\d+)", api_admin_del_post),
    ("GET", r"/api/reports", api_admin_reports),
    ("GET", r"/api/admin/settings", api_admin_settings_get),
    ("POST", r"/api/admin/settings", api_admin_settings_set),
    ("GET", r"/api/admin/stats", api_admin_stats),
    ("GET", r"/api/admin/threads", api_admin_threads),
    ("GET", r"/api/admin/groups", api_admin_groups),
    ("POST", r"/api/admin/groups/([0-9a-f]{16})/clear", api_admin_group_clear),
    ("GET", r"/api/admin/names", api_admin_names),
    ("DELETE", r"/api/admin/names/([A-Za-z0-9_.-]{2,20})", api_admin_name_release),
    ("POST", r"/api/admin/reports/(\d+)/dismiss", api_admin_report_dismiss),
    ("POST", r"/api/admin/secret/clear", api_admin_secret_clear),
    ("POST", r"/api/admin/purge", api_admin_purge),
    ("GET", r"/api/groups", api_groups),
    ("POST", r"/api/groups", api_group_create),
    ("DELETE", r"/api/groups/([0-9a-f]{16})", api_admin_del_group),
    ("GET", r"/api/groups/([0-9a-f]{16})/messages", api_group_open),
    ("POST", r"/api/groups/([0-9a-f]{16})/messages", api_group_send),
    ("POST", r"/api/groups/([0-9a-f]{16})/messages/(\d+)/like", api_group_like),
    ("POST", r"/api/groups/([0-9a-f]{16})/messages/(\d+)/edit", api_group_edit),
    ("DELETE", r"/api/groups/([0-9a-f]{16})/messages/(\d+)", api_group_delete),
    ("GET", r"/api/push/key", api_push_key),
    ("POST", r"/api/push/subscribe", api_push_sub),
    ("POST", r"/api/push/unsubscribe", api_push_unsub),
]
ROUTES = [(m, re.compile(p + r"$"), f) for m, p, f in ROUTES]

CSP = ("default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; "
       "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'")


# ---------------------------------------------------------------- voice
# Audio never touches the server in the clear: every frame is encrypted on the phone with the group key.
# The server only relays opaque binary frames between the people connected to the same group.

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
VOICE_MAX = 8  # people talking at once in one group
VOICE_LISTEN_MAX = 40  # people connected (listening or talking) in one group
VOICE_TOTAL = 200
VOICE_FRAME_MAX = 2048
VOICE_FPS = 60  # frames per second one person may send (a normal stream is 25)
voice_rooms = {}  # gid -> {VConn}
voice_lock = threading.Lock()


class VConn:
    def __init__(self, sock, did, vid):
        self.sock, self.did, self.vid = sock, did, vid
        self.name = None  # set when the person starts talking: listeners are not shown to anyone
        self.speaker = False
        self.muted = False
        self.last_lv = 0.0
        self.out = queue.Queue(maxsize=60)  # a slow listener loses audio, it never holds the speaker up
        self.alive = True

    def push(self, opcode, payload):
        try:
            self.out.put_nowait((opcode, payload))
        except queue.Full:
            pass  # drop: real-time audio is not worth waiting for

    def writer(self):
        try:
            while self.alive:
                try:
                    opcode, payload = self.out.get(timeout=1)
                except queue.Empty:
                    continue
                n = len(payload)
                head = bytearray([0x80 | opcode])
                if n < 126:
                    head.append(n)
                elif n < 65536:
                    head.append(126)
                    head += n.to_bytes(2, "big")
                else:
                    head.append(127)
                    head += n.to_bytes(8, "big")
                self.sock.sendall(bytes(head) + payload)
        except OSError:
            pass
        finally:
            self.alive = False


def voice_names(gid):
    with voice_lock:
        return [c.name for c in sorted(voice_rooms.get(gid, ()), key=lambda c: c.vid) if c.speaker]


def voice_roster_push(gid):
    with voice_lock:
        conns = sorted(voice_rooms.get(gid, ()), key=lambda c: c.vid)
    talkers = [c for c in conns if c.speaker]
    msg = json.dumps({"t": "roster", "list": [{"id": c.vid, "name": c.name, "muted": c.muted} for c in talkers]}).encode()
    for c in conns:
        c.push(0x1, msg)
    hub.pub(f"group:{gid}", {"type": "voice", "list": [c.name for c in talkers]})
    feed_pub(gid)


def voice_close_room(gid):
    with voice_lock:
        conns = list(voice_rooms.pop(gid, ()))
    for c in conns:
        c.alive = False
        try:
            c.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def ws_read(rfile, limit):
    """One client frame -> (opcode, payload). Clients must mask; anything odd ends the call."""
    b = rfile.read(2)
    if len(b) < 2:
        return None, None
    fin, opcode, masked, n = b[0] & 0x80, b[0] & 0x0F, b[1] & 0x80, b[1] & 0x7F
    if not masked or not fin and opcode != 0:
        return None, None
    if n == 126:
        n = int.from_bytes(rfile.read(2), "big")
    elif n == 127:
        n = int.from_bytes(rfile.read(8), "big")
    if n > limit:
        return None, None
    mask = rfile.read(4)
    data = rfile.read(n) if n else b""
    if len(mask) < 4 or len(data) < n:
        return None, None
    return opcode, bytes(x ^ mask[i & 3] for i, x in enumerate(data)) if n else b""


def peer_closed(sock):
    """True if the other side has hung up (readable and zero bytes) without blocking."""
    try:
        if select.select([sock], [], [], 0)[0]:
            return sock.recv(1, socket.MSG_PEEK) == b""
    except OSError:
        return True
    return False


STREAMS_PER_IP = 30
STREAMS_TOTAL = 1500
streams = {}  # ip -> open live-update connections
streams_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "bunker"
    timeout = 60  # a client that goes quiet mid-request (or never finishes its headers) does not hold a thread forever

    def log_message(self, *a):  # no access log: no IPs on disk
        pass

    def client_ip(self):
        if TRUST_PROXY and self.client_address[0] in ("127.0.0.1", "::1"):  # the proxy runs on this machine
            v = self.headers.get(TRUST_PROXY)
            if v:
                return v.split(",")[-1].strip()  # last hop = what our own proxy saw; earlier entries can be forged
        return self.client_address[0]

    def common_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")

    def send_json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.common_headers()
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/"):
                if method == "GET" and path == "/api/stream":
                    return self.stream()
                if method == "GET" and path == "/api/voice":
                    return self.voice()
                mm = re.fullmatch(r"/api/media/([0-9a-f]{20})", path)
                if method == "GET" and mm:
                    return self.serve_media(mm.group(1))
                for m, rx, fn in ROUTES:
                    if m == method:
                        mt = rx.match(path)
                        if mt:
                            c = Ctx(self)
                            code, obj = fn(c, *mt.groups())
                            return self.send_json(code, obj)
                raise ApiError(404, "Not found")
            if method != "GET":
                raise ApiError(405, "Method not allowed")
            self.static(path)
        except ApiError as e:
            if method == "POST":
                self.close_connection = True  # the request body may be unread: do not reuse this connection
            self.send_json(e.code, {"error": e.msg})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # pragma: no cover
            print("error:", repr(e))
            try:
                self.send_json(500, {"error": "Server error"})
            except Exception:
                pass

    def serve_media(self, mid):
        c = Ctx(self)
        r = q1("SELECT * FROM media WHERE id=?", mid)
        if not r:
            raise ApiError(404, "Gone")
        if r["kind"] == "group":
            c.group(r["gid"])
        path = MEDIA / mid
        try:
            size = path.stat().st_size
        except OSError:
            raise ApiError(404, "Gone")
        start, end, code = 0, size - 1, 200
        rng = self.headers.get("Range")
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip()) if rng else None
        if m and (m.group(1) or m.group(2)):  # Safari needs byte ranges to play video
            a, b = m.groups()
            if a:
                start = int(a)
                end = min(int(b), size - 1) if b else size - 1
            else:
                start = max(0, size - int(b))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            code = 206
        length = end - start + 1
        self.send_response(code)
        self.send_header("Content-Type", r["mime"])
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "private, max-age=31536000, immutable")  # a media id never changes
        self.send_header("Content-Security-Policy", "sandbox")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def static(self, path):
        if path == "/":
            path = "/index.html"
        elif path.endswith("/"):  # a folder address serves its index.html
            path += "index.html"
        f = (PUBLIC / path.lstrip("/")).resolve()
        if PUBLIC not in f.parents or not f.is_file():
            raise ApiError(404, "Not found")
        data = f.read_bytes()
        if f.name == "index.html":
            data = data.replace(b"__APP__", html.escape(APP_NAME).encode())
        elif f.name == "manifest.webmanifest":
            data = data.replace(b"__APP__", json.dumps(APP_NAME)[1:-1].encode())
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if f.suffix == ".webmanifest":
            ctype = "application/manifest+json"
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or "javascript" in ctype else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.common_headers()
        self.end_headers()
        self.wfile.write(data)

    def voice(self):
        key = self.headers.get("Sec-WebSocket-Key", "")
        if self.headers.get("Upgrade", "").lower() != "websocket" or not key:
            raise ApiError(400, "Not a voice connection")
        origin = self.headers.get("Origin", "")
        if origin and urlparse(origin).netloc != self.headers.get("Host", ""):  # another website must not open a voice call for you
            raise ApiError(403, "Wrong origin")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.close_connection = True
        sock = self.connection
        rfile = self.rfile
        ip = self.client_ip()

        def say(obj):
            payload = json.dumps(obj).encode()
            try:
                sock.sendall(bytes([0x81, len(payload)]) + payload if len(payload) < 126 else bytes([0x81, 126]) + len(payload).to_bytes(2, "big") + payload)
            except OSError:
                pass

        me = None
        gid = None
        try:
            sock.settimeout(5)  # the first message must come at once
            op, data = ws_read(rfile, 1024)
            if op != 0x1:
                return
            j = json.loads(data)
            gid = str(j.get("gid", ""))
            kk = str(j.get("key", ""))
            did = hashlib.sha256(kk.encode()).hexdigest() if re.fullmatch(r"[0-9a-f]{64}", kk) else None
            if not did or not limiter.hit(f"voice:ip:{ip}", 20, 60):
                say({"t": "error", "msg": "Slow down"})
                return
            check_group(gid, j.get("verifier"), ip, did)
            with voice_lock:
                room = voice_rooms.setdefault(gid, set())
                old = [c for c in room if c.did == did]  # the same device joining again replaces its old connection
                for c in old:
                    room.discard(c)
                    c.alive = False
                    try:
                        c.sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                if len(room) >= VOICE_LISTEN_MAX or sum(len(r) for r in voice_rooms.values()) >= VOICE_TOTAL:
                    room_full = True
                else:
                    room_full = False
                    used = {c.vid for c in room}
                    vid = next(i for i in range(1, 1000) if i not in used)
                    me = VConn(sock, did, vid)
                    room.add(me)
            if room_full:
                say({"t": "error", "msg": "Voice is full"})
                return
            threading.Thread(target=me.writer, daemon=True).start()
            me.push(0x1, json.dumps({"t": "hello", "me": me.vid}).encode())
            voice_roster_push(gid)
            sock.settimeout(45)  # the phone pings every 15 seconds
            budget, stamp = float(VOICE_FPS), time.time()
            while me.alive:
                op, data = ws_read(rfile, VOICE_FRAME_MAX + 64)
                if op is None or op == 0x8:
                    break
                if op == 0x9:
                    me.push(0xA, data)
                elif op == 0x1:  # {"t":"talk","mode":...} starts talking, {"t":"quiet"} goes back to listening
                    try:
                        cmd = json.loads(data)
                    except ValueError:
                        continue
                    if cmd.get("t") == "talk" and not me.speaker:
                        try:
                            with voice_lock:
                                if sum(1 for c in voice_rooms.get(gid, ()) if c.speaker) >= VOICE_MAX:
                                    raise ApiError(400, "Voice is full")
                            me.name, _ = resolve_sender(did, "pseudo" if cmd.get("mode") == "pseudo" else "anon", gid)
                            me.speaker = True
                            voice_roster_push(gid)
                        except ApiError as e:
                            me.push(0x1, json.dumps({"t": "notice", "msg": e.msg}).encode())
                    elif cmd.get("t") == "quiet" and me.speaker:
                        me.speaker = False
                        me.muted = False
                        voice_roster_push(gid)
                    elif cmd.get("t") == "lv" and me.speaker and not me.muted:  # how loud, 1-3: lets people who are not connected see who is talking
                        now = time.time()
                        if now - me.last_lv > 0.12 and cmd.get("l") in (1, 2, 3):
                            me.last_lv = now
                            hub.pub(f"group:{gid}", {"type": "talk", "name": me.name, "lv": cmd["l"]})
                    elif cmd.get("t") == "mute" and me.speaker:
                        me.muted = bool(cmd.get("m"))
                        voice_roster_push(gid)
                elif op == 0x2 and me.speaker and not me.muted and 16 < len(data) <= VOICE_FRAME_MAX:
                    now = time.time()
                    budget = min(VOICE_FPS, budget + (now - stamp) * VOICE_FPS)
                    stamp = now
                    if budget < 1:
                        continue  # too fast: drop
                    budget -= 1
                    with voice_lock:
                        others = [c for c in voice_rooms.get(gid, ()) if c is not me]
                    frame = me.vid.to_bytes(2, "big") + data
                    for c in others:
                        c.push(0x2, frame)
        except ApiError as e:
            say({"t": "error", "msg": e.msg})
        except (OSError, ValueError, StopIteration):
            pass
        finally:
            if me:
                me.alive = False
                with voice_lock:
                    room = voice_rooms.get(gid)
                    if room:
                        room.discard(me)
                        if not room:
                            voice_rooms.pop(gid, None)
                voice_roster_push(gid)

    def stream(self):
        c = Ctx(self)
        topic = c.query.get("topic", [""])[0]
        if topic == "feed":
            pass
        elif topic.startswith("group:"):
            c.group(topic[6:])
        elif not (topic.startswith("board:") and topic[6:] in BOARD_IDS or re.fullmatch(r"thread:\d+", topic)):
            raise ApiError(400, "Bad topic")
        with streams_lock:
            if streams.get(c.ip, 0) >= STREAMS_PER_IP or sum(streams.values()) >= STREAMS_TOTAL:
                raise ApiError(429, "Too many open connections")
            streams[c.ip] = streams.get(c.ip, 0) + 1
        if topic == "feed":
            qu = feed_sub([i for i in c.query.get("groups", [""])[0].split(",") if re.fullmatch(r"[0-9a-f]{16}", i)][:50])
        else:
            qu = hub.sub(topic, c.did)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.common_headers()
        self.end_headers()
        self.close_connection = True

        def online():
            if topic.startswith("group:"):
                hub.pub(topic, {"type": "online", "n": hub.count(topic)})

        try:
            self.wfile.write(b'data: {"type":"hello"}\n\n')
            self.wfile.flush()
            online()
            idle = 0
            while True:
                if peer_closed(self.connection):  # notice a gone client within a second, not at the next ping
                    break
                try:
                    ev = qu.get(timeout=1)
                    out = b"data: " + json.dumps(ev).encode() + b"\n\n"
                except queue.Empty:
                    idle += 1
                    if idle < 15:
                        continue
                    out = b": ping\n\n"
                idle = 0
                self.wfile.write(out)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            if topic == "feed":
                feed_unsub(qu)
            else:
                hub.unsub(topic, qu)
            with streams_lock:
                streams[c.ip] -= 1
                if streams[c.ip] <= 0:
                    del streams[c.ip]
            online()


# ---------------------------------------------------------------- housekeeping


def housekeeping():
    while True:
        time.sleep(60)
        try:
            idle = settings()["idle_days"] * 86400
            for g in q("SELECT * FROM groups"):
                expire_group(g)
                if idle and time.time() - g["last_act"] > idle and hub.count(f"group:{g['id']}") == 0:
                    purge_group(g["id"])
            drop_media([r["id"] for r in q("SELECT id FROM media WHERE linked=0 AND ts<?", int(time.time()) - 3600)])
            for stale in MEDIA.glob("*.part"):  # half-finished uploads
                if time.time() - stale.stat().st_mtime > 3600:
                    stale.unlink(missing_ok=True)
            limiter.sweep()
            with media_lock:
                for ip in list(media_by_ip):
                    media_by_ip[ip] = [(t, b) for t, b in media_by_ip[ip] if time.time() - t < 3600]
                    if not media_by_ip[ip]:
                        del media_by_ip[ip]
        except Exception as e:  # pragma: no cover
            print("housekeeping:", repr(e))


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # A phone that leaves mid-request is normal, not an error worth a traceback in the log.
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)

    allow_reuse_address = True
    request_queue_size = 128


if __name__ == "__main__":
    threading.Thread(target=housekeeping, daemon=True).start()
    print(f"{APP_NAME} on http://{HOST}:{PORT}  push={'on' if PUSH else 'off'}  admin={'on' if ADMIN_TOKEN else 'off'}")
    try:
        Server((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
