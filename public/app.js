'use strict';
(() => {
  // ------------------------------------------------------------ basics
  const appEl = document.getElementById('app');
  const wmEl = document.getElementById('wm');
  let CFG = { app: 'BUNKER', boards: [], ttls: [], push: false, admin: false, keep: 10 };
  let teardown = [];
  let BUILD = null; // which version of the app this page is running
  let routeSeq = 0; // bumps on every navigation, so a slow view can tell it is no longer the current one
  const state = { pseudo: null };

  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } },
  };

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (tag === 'textarea' || (tag === 'input' && !['file', 'radio', 'checkbox'].includes((props || {}).type))) {
      // no keyboard writing help: no autocorrect, suggestions, auto-capitals or spellcheck
      e.setAttribute('autocomplete', 'off'); e.setAttribute('autocorrect', 'off');
      e.setAttribute('autocapitalize', 'off'); e.setAttribute('spellcheck', 'false');
    }
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'value') e.value = v;
      else if (k === 'style') e.style.cssText = v; // CSSOM is allowed by the CSP, style attributes are not
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  const btn = (label, onclick, cls) => h('button', { type: 'button', class: cls || '', onclick }, label);
  const link = (label, href) => h('a', { href }, label);
  const rule = (ch) => h('div', { class: 'rule' }, (ch || '-').repeat(200));
  const gap = () => h('div', { class: 'gap' });

  // The phone keeps one secret key (bk) and never sends it. The server only gets an id made from it, plus per-message
  // proofs (ownership of a post, a like) that cannot be turned back into the key or linked to each other.
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  function masterKey() {
    let k = ls.get('bk', null);
    if (typeof k !== 'string' || !/^[0-9a-f]{64}$/.test(k)) {
      k = hex(crypto.getRandomValues(new Uint8Array(32)));
      ls.set('bk', k);
    }
    return k;
  }
  let DEVID = null;
  let HMAC_KEY = null;
  async function initDevice() {
    if (!(crypto && crypto.subtle)) throw new Error('This app needs HTTPS (or localhost)');
    const k = masterKey();
    DEVID = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bunker/id/' + k)));
    HMAC_KEY = await crypto.subtle.importKey('raw', Uint8Array.from(k.match(/../g), (x) => parseInt(x, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  function deviceKey() {
    if (!DEVID) throw new Error('Not ready');
    return DEVID;
  }
  const tok = async (label) => hex(await crypto.subtle.sign('HMAC', HMAC_KEY, new TextEncoder().encode(label)));
  const sha = async (t) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
  const newCid = () => hex(crypto.getRandomValues(new Uint8Array(16)));
  const ownHdr = async (cid) => ({ 'X-Own': await tok('own|' + cid) });
  const tokHdr = async (ctx) => ({ 'X-Tok': await tok('tok|' + ctx) });
  const isMine = async (cid, own) => !!cid && !!own && (await sha(await tok('own|' + cid))) === own;
  const didAct = async (ctx, list) => (list || []).includes(await sha(await tok('tok|' + ctx)));

  let ADM = ''; // the admin token lives in memory only: it is never saved, so it has to be typed again after every reload
  async function api(method, path, body, extra) {
    const headers = { 'X-Key': deviceKey() };
    if (ADM) headers['X-Admin'] = ADM;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    Object.assign(headers, extra || {});
    const r = await fetch('/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await r.json(); } catch (e) { /* no body */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || 'HTTP ' + r.status);
      err.status = r.status;
      throw err;
    }
    return data;
  }

  // ---- unread markers: an asterisk where something happened since you last looked. What you last saw stays on the phone.
  let ACT = { boards: {}, groups: {}, voice: {} };
  const seenGet = () => { const v = ls.get('seen', null); return v && v.b && v.g && v.t ? v : { b: {}, g: {}, t: {} }; };
  function seenSet(kind, id, ts) {
    const s = seenGet();
    if (!(ts > (s[kind][id] || 0))) return;
    s[kind][id] = ts;
    const keys = Object.keys(s.t);
    if (keys.length > 300) keys.sort((a, b) => s.t[a] - s.t[b]).slice(0, keys.length - 300).forEach((k) => { delete s.t[k]; });
    ls.set('seen', s);
  }
  const unreadB = (id) => (ACT.boards[id] || 0) > (seenGet().b[id] || 0);
  const unreadG = (id) => (ACT.groups[id] || 0) > (seenGet().g[id] || 0);
  const liveV = (id) => ((ACT.voice || {})[id] || 0) > 0; // someone is connected with sound in that chat
  function paintBadges() {
    const stars = (unread, live) => [unread ? h('span', { class: 'star' }, ' *') : null, live ? h('span', { class: 'star live' }, ' *') : null];
    document.querySelectorAll('[data-nav]').forEach((a) => {
      const k = a.dataset.nav;
      const mine = Object.keys(ls.get('groups', {}));
      const unread = k === 'Boards' ? (CFG.boards || []).some((b) => unreadB(b.id)) : k === 'Groups' ? mine.some(unreadG) : false;
      const live = k === 'Groups' && mine.some(liveV);
      a.replaceChildren('[ ' + k, ...stars(unread, live).filter(Boolean), ' ]');
    });
    document.querySelectorAll('[data-mark]').forEach((el) => {
      const [kind, id] = el.dataset.mark.split(':');
      el.replaceChildren(...stars(kind === 'b' ? unreadB(id) : unreadG(id), kind === 'g' && liveV(id)).filter(Boolean));
    });
  }
  // The server tells us the moment something happens (it never says what), so the asterisks move at once.
  let feedOff = null;
  let feedKey = null;
  function startFeed() {
    const key = Object.keys(ls.get('groups', {})).slice(0, 50).join(',');
    if (feedOff && key === feedKey) return;
    if (feedOff) feedOff();
    feedKey = key;
    let t = null;
    feedOff = stream('feed', () => { clearTimeout(t); t = setTimeout(() => refreshActivity(), 250); }, undefined, key ? '&groups=' + key : '');
  }
  let actBusy = null;
  function refreshActivity() {
    if (!actBusy) actBusy = loadActivity().finally(() => { actBusy = null; });
    return actBusy;
  }
  async function loadActivity() {
    try {
      const ids = Object.keys(ls.get('groups', {})).slice(0, 50);
      const a = await api('GET', '/activity' + (ids.length ? '?groups=' + ids.join(',') : ''));
      ACT = a;
      const s = seenGet();
      let first = false;
      for (const kind of ['b', 'g']) for (const [k, v] of Object.entries(a[kind === 'b' ? 'boards' : 'groups'])) if (s[kind][k] === undefined) { s[kind][k] = v; first = true; } // nothing is "new" the first time
      if (first) ls.set('seen', s);
      paintBadges();
    } catch (e) { /* offline: keep what we know */ }
  }

  function stream(topic, onEvent, headers, query) {
    let stop = false;
    let ctrl = null;
    let last = Date.now(); // last time any bytes (data or a ping) arrived
    (async () => {
      let delay = 1000;
      while (!stop) {
        try {
          ctrl = new AbortController();
          last = Date.now();
          const r = await fetch('/api/stream?topic=' + encodeURIComponent(topic) + (query || ''), {
            headers: Object.assign({ 'X-Key': deviceKey() }, headers || {}),
            signal: ctrl.signal,
          });
          if (!r.ok) throw new Error('stream ' + r.status);
          delay = 1000;
          const rd = r.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            last = Date.now();
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const line = chunk.split('\n').find((l) => l.startsWith('data: '));
              if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch (e) { /* bad event */ } }
            }
          }
        } catch (e) {
          if (stop) return;
        }
        if (stop) return;
        await new Promise((res) => setTimeout(res, delay));
        delay = Math.min(delay * 2, 15000);
      }
    })();
    // The server pings every 15 s. Silence for 50 s means the connection is dead (phones suspend it in the background).
    const wd = setInterval(() => { if (ctrl && Date.now() - last > 50000) ctrl.abort(); }, 10000);
    const wake = () => { if (!document.hidden && ctrl) { last = Date.now(); ctrl.abort(); } }; // reconnect fresh when the app returns
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      stop = true;
      clearInterval(wd);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      if (ctrl) ctrl.abort();
    };
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function clock(ts) {
    const d = new Date(ts * 1000);
    const t = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return d.toDateString() === new Date().toDateString() ? t : pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + t;
  }
  function ago(ts) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  const TTL_LABEL = { 3600: '1 hour', 86400: '24 hours', 604800: '7 days' };
  const keepText = () => 'only ' + (CFG.keep || 10) + ' msg remembered'; // the number comes from the server
  const expiry = (ttl) => (ttl ? 'expires: ' + (TTL_LABEL[ttl] || ttl) : keepText());

  // ------------------------------------------------------------ media (photos and videos)
  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

  // Downloads a file and reports how far it is (0..1), so a big video shows real progress instead of a silent wait.
  async function fetchProgress(url, headers, onProgress) {
    const r = await fetchOk(url, headers);
    const total = Number(r.headers.get('Content-Length')) || 0;
    if (!r.body || !r.body.getReader) return r.arrayBuffer();
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (onProgress && total) onProgress(Math.min(1, got / total));
    }
    const out = new Uint8Array(got);
    let at = 0;
    parts.forEach((part) => { out.set(part, at); at += part.length; });
    return out.buffer;
  }

  async function fetchOk(url, headers) {
    const r = await fetch(url, { headers: Object.assign({ 'X-Key': deviceKey() }, headers || {}) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  }

  async function shrinkImage(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const k = Math.min(1, 1080 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * k));
      c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.76));
      return blob || file;
    } catch (e) { return file; } // re-encoding strips EXIF/GPS; fall back to the original if the browser cannot
  }

  // Size plus a tiny blurred stand-in (about 20 px wide) that travels inside the encrypted message: the chat shows
  // the colours of a photo the moment its message arrives, long before the photo itself has downloaded.
  const SAFE_PREVIEW = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{20,6000}$/;
  async function imageInfo(blob) {
    try {
      const bm = await createImageBitmap(blob);
      const k = 20 / Math.max(bm.width, bm.height);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bm.width * k));
      c.height = Math.max(1, Math.round(bm.height * k));
      c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
      const info = { w: bm.width, h: bm.height, p: c.toDataURL('image/jpeg', 0.5) };
      if (bm.close) bm.close();
      return info;
    } catch (e) { return {}; }
  }

  async function prepMedia(file) {
    let t = file.type;
    if (!t) t = /\.(mp4|mov|m4v|webm)$/i.test(file.name || '') ? 'video/mp4' : 'image/jpeg';
    if (t.startsWith('video/')) {
      if (file.size > CFG.limits.vid) throw new Error('Video too large (max ' + fmtSize(CFG.limits.vid) + '). Record a shorter clip.');
      return { blob: file, type: t };
    }
    if (!t.startsWith('image/')) throw new Error('Only photos and videos');
    const out = t === 'image/gif' ? file : await shrinkImage(file);
    if (out.size > CFG.limits.img) throw new Error('Image too large (max ' + fmtSize(CFG.limits.img) + ')');
    return { blob: out, type: out.type || t };
  }

  function uploadMedia(scope, blob, o, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let qs = '?scope=' + scope;
      if (scope === 'group') qs += '&gid=' + o.gid;
      xhr.open('POST', '/api/media' + qs);
      xhr.setRequestHeader('X-Key', deviceKey());
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      if (scope === 'group') xhr.setRequestHeader('X-Verifier', o.verifier);
      xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let d = null;
        try { d = JSON.parse(xhr.responseText); } catch (e) { /* no body */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(d);
        else reject(new Error((d && d.error) || 'Upload failed (' + xhr.status + ')'));
      };
      xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
      xhr.send(blob);
    });
  }

  function attachWidget() {
    let file = null;
    const info = h('span', { class: 'dim' });
    function paint() {
      info.replaceChildren(...(file ? ['attached: ' + (file.name || 'capture') + ' (' + fmtSize(file.size) + ') ', btn('[ remove ]', () => { file = null; paint(); }, 'sm')] : []));
    }
    const mk = (accept, capture) => {
      const i = h('input', { type: 'file', accept, hidden: true });
      if (capture) i.setAttribute('capture', 'environment'); // opens the camera on phones
      i.addEventListener('change', () => { if (i.files[0]) { file = i.files[0]; paint(); } i.value = ''; });
      return i;
    };
    const lib = mk('image/*,video/*');
    const cam = mk('image/*,video/*', true); // only used when our own camera is not available
    const el = h('div', { class: 'row' }, btn('[ Attach ]', () => lib.click()),
      btn('[ Camera ]', () => { if (CAMERA_OK) openCamera((f) => { file = f; paint(); }); else cam.click(); }), lib, cam, info);
    return { el, file: () => file, clear: () => { file = null; paint(); } };
  }

  // A video with nothing on top of the picture: it just plays. A tap pauses or resumes it, and the first tap
  // turns the sound on if the phone had to start it silently.
  function cleanVideo(src, cls) {
    const v = h('video', { class: cls || '', src, autoplay: true, playsinline: true });
    v.addEventListener('click', (e) => {
      e.stopPropagation();
      if (v.muted && !v.paused) { v.muted = false; return; }
      if (v.paused || v.ended) { if (v.ended) v.currentTime = 0; v.play().catch(() => {}); } else v.pause();
    });
    setTimeout(() => { v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); }, 0); // sound blocked? start silent instead of not at all
    return v;
  }

  function mediaEl(kind, src) {
    return kind === 'video'
      ? h('video', { class: 'media', src, controls: true, playsinline: true, preload: 'metadata' })
      : h('img', { class: 'media', src, alt: '', loading: 'lazy' });
  }

  function boardMedia(id, mime, size, onOpen) {
    const kind = (mime || '').startsWith('video/') ? 'video' : 'image';
    if (kind === 'video') return mediaEl('video', '/api/media/' + id + '#t=0.1'); // on boards a video has its own play button and controls
    const el = mediaEl(kind, '/api/media/' + id);
    if (!onOpen) return el;
    if (kind === 'image') { el.classList.add('tap'); el.addEventListener('click', onOpen); return el; }
    const still = h('video', { class: 'media tap', src: '/api/media/' + id + '#t=0.1', preload: 'metadata', playsinline: true, muted: true });
    still.muted = true;
    still.addEventListener('click', onOpen);
    return still;
  }

  // Our own camera, no system camera screen: tap the shutter for a photo, hold it to film (let go to stop).
  // The camera can be flipped at any moment, also while filming. Needs https; otherwise callers fall back to the phone's own camera.
  const CAMERA_OK = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  let cameraCloser = null;
  const camConstraints = (f) => ({ facingMode: { ideal: f }, width: { ideal: 1280 }, height: { ideal: 720 } });
  // Opening a camera takes a moment. If this phone has used it before, we start it as soon as the [+] menu opens,
  // so it is already running when [ Camera ] is tapped. It switches itself off again after 12 seconds if unused.
  let warmCam = null; // { promise, timer, dead }
  function warmUpCamera() {
    if (!CAMERA_OK || warmCam || cameraCloser || !ls.get('camOK', false)) return;
    const w = { promise: null, timer: null, dead: false };
    warmCam = w;
    w.promise = navigator.mediaDevices.getUserMedia({ video: camConstraints('environment'), audio: false }).then((st) => {
      if (w.dead) { st.getTracks().forEach((t) => t.stop()); return null; }
      w.timer = setTimeout(coolDownCamera, 12000);
      return st;
    }).catch(() => { if (warmCam === w) warmCam = null; return null; });
  }
  function coolDownCamera() {
    const w = warmCam;
    if (!w) return;
    warmCam = null;
    w.dead = true;
    clearTimeout(w.timer);
    w.promise.then((st) => { if (st) st.getTracks().forEach((t) => t.stop()); });
  }
  function openCamera(onFile, opts) {
    const multi = !!(opts && opts.multi); // chats can take several clips from one filming
    if (cameraCloser) cameraCloser();
    let facing = 'environment';
    let stream = null;
    let audioStream = null; // the microphone is asked once, in the background, and kept so flipping never cuts the sound
    let rec = null;
    let chunks = [];
    let clips = [];
    let segmentResolve = null;
    let directRec = false; // true when this browser cannot film from a canvas: then a flip closes one clip and starts the next
    let recStart = 0;
    let ticker = null;
    let holdT = null;
    let recording = false;
    let heldRec = false;
    let switching = false;
    let locked = false; // dragged to the right while filming: hands-free
    let lockedTap = false;
    let startX = 0;
    let startToken = 0;
    let reviewUrls = [];
    let recCanvas = null;
    let recCtx = null;
    let recSource = null;
    let paintTimer = null;
    let wakeLock = null; // keeps the screen on while the camera is open: a screen that sleeps stops the filming
    let lastChunk = 0;
    let lastTime = -1;
    let stallSince = 0;
    async function keepAwake() { try { if (navigator.wakeLock && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { /* not available */ } }
    function letSleep() { try { if (wakeLock) wakeLock.release(); } catch (e) { /* already released */ } wakeLock = null; }
    const onVisible = () => {
      if (document.hidden) { if (recording) { note.textContent = 'Filming stopped: the camera went to the background.'; stopRec(); } } else if (cameraCloser) keepAwake();
    };
    document.addEventListener('visibilitychange', onVisible);
    const prevOverflow = document.body.style.overflow;
    const video = h('video', { class: 'cam-video', autoplay: true, playsinline: true, muted: true });
    video.muted = true;
    const note = h('div', { class: 'cam-note' });
    const timer = h('div', { class: 'cam-timer' });
    const shutter = h('button', { type: 'button', class: 'cam-shutter' }, '( o )');
    const arrow = h('div', { class: 'cam-arrow' }, '#'); // always there: the spot to slide to for hands-free
    const bottom = h('div', { class: 'cam-bottom' }, shutter, arrow);
    const reviewBar = h('div', { class: 'cam-review', style: 'display:none' });
    const root = h('div', { class: 'camera' }, video,
      h('div', { class: 'cam-top' }, btn('[x]', () => done(), 'cam-btn'), timer, btn('[ flip ]', () => flipCamera(), 'cam-btn')),
      note, bottom, reviewBar);
    video.addEventListener('playing', () => { if (note.textContent === 'Starting camera...') note.textContent = ''; });
    let lastTap = 0; // two quick taps on the picture turn the camera around, like [ flip ]
    root.addEventListener('touchend', (e) => {
      if (root.classList.contains('reviewing') || e.target.closest('button, .cam-top, .cam-bottom')) return;
      const now = Date.now();
      if (now - lastTap < 320) { e.preventDefault(); lastTap = 0; flipCamera(); } else lastTap = now;
    }, { passive: false });
    root.addEventListener('dblclick', (e) => {
      if (root.classList.contains('reviewing') || e.target.closest('button, .cam-top, .cam-bottom')) return;
      flipCamera();
    });

    async function start() {
      const my = ++startToken;
      stopStream();
      if (!recording) note.textContent = 'Starting camera...';
      let s = null;
      if (warmCam && facing === 'environment' && !recording) { // already running: no waiting at all
        const w = warmCam;
        warmCam = null;
        clearTimeout(w.timer);
        const warm = await w.promise;
        if (warm) s = new MediaStream(warm.getVideoTracks());
      }
      // Only the camera is asked for here. The microphone is asked for when filming starts (ensureMic): opening the camera
      // or taking a photo must stay silent, because a phone beeps when a microphone switches on.
      try {
        if (!s) s = await navigator.mediaDevices.getUserMedia({ video: camConstraints(facing) });
      } catch (e) {
        try { s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } } }); } catch (e2) {
          if (my === startToken) note.textContent = 'Camera not available. Allow camera access and try again.';
          return false;
        }
      }
      if (my !== startToken) { s.getTracks().forEach((t) => t.stop()); return false; } // a newer switch took over
      stream = s;
      ls.set('camOK', true);
      stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => { if (recording && !switching && stream === s) { note.textContent = 'The camera was interrupted. Saved what was filmed.'; stopRec(); } }));
      keepAwake();
      video.srcObject = stream; // the picture goes up first ...
      video.classList.toggle('mirror', facing === 'user'); // selfie preview is mirrored, the saved photo is not
      video.play().catch(() => {});
      return true;
    }
    let micPromise = null;
    function ensureMic() { // asked once, the first time you film; kept so flipping never cuts the sound
      if (audioStream !== null) return Promise.resolve();
      if (!micPromise) {
        micPromise = navigator.mediaDevices.getUserMedia({ audio: true }).then((a) => {
          audioStream = new MediaStream(a.getAudioTracks());
          ls.set('micOK', true);
        }).catch(() => {
          audioStream = false;
          ls.set('micOK', false); ls.set('micTs', Date.now());
          note.textContent = 'No microphone: videos will be silent.';
        });
      }
      return micPromise;
    }
    let filmPending = false;
    function film(held) { // the microphone comes on now, not before; if the finger lifted meanwhile, nothing is filmed
      filmPending = true;
      ensureMic().then(() => { if (!filmPending) return; filmPending = false; startRec(held); });
    }
    function stopStream() { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; }
    async function flipCamera() { // allowed at any moment
      if (switching) return;
      if (recording && directRec && !multi) { note.textContent = 'Stop filming to switch cameras.'; return; }
      switching = true;
      facing = facing === 'user' ? 'environment' : 'user';
      try {
        if (recording && directRec) await stopSegment(); // close this clip, the next one starts on the other camera
        await start();
        if (recording && directRec) startRec(heldRec, true);
      } finally { switching = false; }
    }

    // Film from a canvas that copies the live picture. The camera underneath can then be swapped without stopping the recording.
    function paintFrame() {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!recCtx || !vw || !vh || video.readyState < 2) return; // while the camera switches, the last picture stays
      const cw = recCanvas.width;
      const ch = recCanvas.height;
      const k = Math.max(cw / vw, ch / vh);
      recCtx.drawImage(video, (cw - vw * k) / 2, (ch - vh * k) / 2, vw * k, vh * k);
    }
    function canvasSource() {
      if (!HTMLCanvasElement.prototype.captureStream || !video.videoWidth) return null;
      const k = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
      recCanvas = document.createElement('canvas');
      recCanvas.width = Math.round(video.videoWidth * k) & ~1; // even sizes, encoders like that
      recCanvas.height = Math.round(video.videoHeight * k) & ~1;
      recCtx = recCanvas.getContext('2d');
      paintFrame();
      paintTimer = setInterval(paintFrame, 33); // a timer, not requestAnimationFrame: that one stops when the page is not in front
      const cs = recCanvas.captureStream(30);
      return new MediaStream([...cs.getVideoTracks(), ...(audioStream ? audioStream.getAudioTracks() : [])]);
    }
    function directSource() { return new MediaStream([...stream.getVideoTracks(), ...(audioStream ? audioStream.getAudioTracks() : [])]); }
    function teardownCanvas() {
      clearInterval(paintTimer);
      if (recSource) recSource.getVideoTracks().forEach((t) => t.stop());
      recSource = null;
      recCanvas = null;
      recCtx = null;
    }
    function done() {
      document.removeEventListener('visibilitychange', onVisible);
      letSleep();
      startToken++;
      clearTimeout(holdT);
      clearInterval(ticker);
      try { if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); } } catch (e) { /* already stopped */ }
      teardownCanvas();
      stopStream();
      if (audioStream) audioStream.getTracks().forEach((t) => t.stop());
      reviewUrls.forEach((u) => URL.revokeObjectURL(u));
      root.remove();
      document.body.style.overflow = prevOverflow;
      cameraCloser = null;
    }

    function review(files) { // look at it before it goes into the chat
      startToken++; // cancels a camera switch that is still on its way
      stopStream();
      const list = Array.isArray(files) ? files : [files];
      reviewUrls = list.map((f) => URL.createObjectURL(f));
      const isVid = list[0].type.startsWith('video/');
      let shown;
      if (isVid) { // several clips play one after the other
        let k = 0;
        shown = cleanVideo(reviewUrls[0], 'cam-video');
        shown.loop = list.length === 1;
        shown.addEventListener('ended', () => { k = (k + 1) % reviewUrls.length; shown.src = reviewUrls[k]; shown.play().catch(() => {}); });
      } else shown = h('img', { class: 'cam-video', src: reviewUrls[0], alt: '' });
      root.classList.add('reviewing');
      video.style.display = 'none';
      root.insertBefore(shown, root.firstChild);
      reviewBar.style.display = 'flex';
      reviewBar.replaceChildren(
        btn('[ retake ]', () => {
          shown.remove();
          reviewUrls.forEach((u) => URL.revokeObjectURL(u));
          reviewUrls = [];
          root.classList.remove('reviewing');
          video.style.display = '';
          reviewBar.style.display = 'none';
          start();
        }, 'cam-btn'),
        btn(!isVid ? '[ use photo ]' : list.length > 1 ? '[ use ' + list.length + ' clips ]' : '[ use video ]', () => { const fs = list; done(); fs.forEach((f) => onFile(f)); }, 'cam-btn on'));
    }
    function snap() {
      if (!stream || !video.videoWidth) return;
      soundShutter();
      const cv = document.createElement('canvas');
      cv.width = video.videoWidth;
      cv.height = video.videoHeight;
      cv.getContext('2d').drawImage(video, 0, 0);
      cv.toBlob((b) => { if (b) review(new File([b], 'photo-' + Date.now() + '.jpg', { type: 'image/jpeg' })); }, 'image/jpeg', 0.92);
    }
    function makeRecorder(source) { // the phone's own default first: that is the format it is sure to be able to record
      const types = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
      let lastErr = null;
      for (const opt of [{ videoBitsPerSecond: 1500000, audioBitsPerSecond: 64000 }, undefined, ...types.filter((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)).map((t) => ({ mimeType: t }))]) {
        try { return new MediaRecorder(source, opt); } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('no recorder');
    }
    function stopSegment() { // ends the current clip and waits until it is saved
      return new Promise((resolve) => {
        segmentResolve = resolve;
        if (rec && rec.state !== 'inactive') rec.stop(); else { segmentResolve = null; resolve(); }
      });
    }
    function startRec(held, cont) { // cont: carry on after a flip, same timer
      if ((recording && !cont) || !stream) return;
      let r;
      directRec = false;
      try { recSource = canvasSource(); r = makeRecorder(recSource); } catch (e1) {
        teardownCanvas(); // no canvas recording here: film straight from the camera
        try { recSource = directSource(); r = makeRecorder(recSource); directRec = true; } catch (e2) {
          note.textContent = 'Filming failed: ' + (e2.name || e2.message);
          if (cont) { stopRec(); }
          return;
        }
      }
      rec = r;
      chunks = [];
      if (!cont) heldRec = !!held;
      rec.ondataavailable = (e) => { lastChunk = Date.now(); if (e.data && e.data.size) chunks.push(e.data); };
      rec.onerror = (e) => { note.textContent = 'Filming failed: ' + ((e.error && e.error.name) || 'error'); };
      rec.onstop = () => {
        teardownCanvas();
        const t = (rec.mimeType || 'video/mp4').split(';')[0] || 'video/mp4';
        const blob = new Blob(chunks, { type: t });
        if (chunks.length && blob.size >= 1000) clips.push(new File([blob], 'video-' + Date.now() + (t.includes('webm') ? '.webm' : '.mp4'), { type: t }));
        if (segmentResolve) { const res = segmentResolve; segmentResolve = null; res(); return; }
        if (!clips.length) { note.textContent = 'Nothing was recorded. Try again.'; return; }
        review(clips.splice(0));
      };
      lastChunk = Date.now();
      try { rec.start(1000); } catch (e) { note.textContent = 'Filming failed: ' + (e.name || e.message); return; } // a chunk every second: if it stalls, what was filmed is already saved
      if (cont) return; // the timer and the red button keep going
      recording = true;
      recStart = Date.now();
      shutter.classList.add('rec');
      shutter.textContent = '(REC)';
      arrow.classList.toggle('hot', !!held); // while the finger is down, the lock symbol lights up
      timer.classList.add('rec');
      timer.textContent = 'REC 00:00';
      note.textContent = '';
      lastTime = -1;
      stallSince = 0;
      ticker = setInterval(() => {
        const sec = Math.floor((Date.now() - recStart) / 1000);
        // watchdog: if the picture or the recorder stops moving, wake it up, and if that fails keep what we have
        if (!switching) {
          if (video.paused) video.play().catch(() => {});
          if (video.currentTime === lastTime) { if (!stallSince) stallSince = Date.now(); } else { stallSince = 0; lastTime = video.currentTime; }
          const stuck = (stallSince && Date.now() - stallSince > 4000) || Date.now() - lastChunk > 6000;
          if (stuck) { note.textContent = 'The camera stalled. Saved what was filmed.'; stopRec(); return; }
        }
        timer.textContent = 'REC ' + pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60);
        if (sec >= 600) stopRec(); // ten minutes at most
      }, 250);
    }
    function lockRec() { // dragged right: keeps filming after the finger lifts, tap the button to stop
      locked = true;
      heldRec = false;
      arrow.classList.add('gone');
      shutter.style.transition = 'transform .16s cubic-bezier(.2,.8,.3,1)';
      shutter.style.transform = 'translateX(96px)'; // slides into the # spot ...
      setTimeout(() => {
        if (!locked) return;
        shutter.textContent = '( # )';
        shutter.style.transition = 'transform .34s cubic-bezier(.2,.9,.25,1.12)'; // ... and glides back to the middle with a soft settle
        shutter.style.transform = '';
      }, 170);
    }
    function stopRec() {
      clearInterval(ticker);
      recording = false;
      locked = false;
      lockedTap = false;
      shutter.style.transition = 'none';
      shutter.style.transform = '';
      arrow.style.setProperty('--p', '0');
      arrow.classList.remove('gone', 'hot');
      shutter.classList.remove('rec');
      shutter.textContent = '( o )';
      timer.classList.remove('rec');
      timer.textContent = '';
      if (rec && rec.state !== 'inactive') rec.stop();
      else if (clips.length) review(clips.splice(0)); // let go in the middle of a flip: use what was filmed so far
    }
    // One press logic for finger and mouse: tap = photo, hold = film while held, drag right while holding = keep filming hands-free.
    function press(x) {
      startX = x;
      if (locked) { lockedTap = true; return; } // a tap on the locked button stops the film
      clearTimeout(holdT);
      holdT = setTimeout(() => { holdT = null; film(true); }, 350);
    }
    function drag(x) {
      const dx = Math.max(0, x - startX);
      if (!recording && holdT && dx > 18) { clearTimeout(holdT); holdT = null; film(true); } // swiping means filming: do not wait for the hold
      if (!recording || locked || !heldRec) return;
      shutter.style.transition = 'none'; // follows the finger exactly
      shutter.style.transform = 'translateX(' + Math.min(dx, 55) + 'px)';
      arrow.style.setProperty('--p', String(Math.min(1, dx / 55))); // the # grows as you get close
      if (dx >= 55) lockRec();
    }
    function release() {
      if (lockedTap) { lockedTap = false; stopRec(); return; }
      if (holdT) { clearTimeout(holdT); holdT = null; snap(); } else if (filmPending) { filmPending = false; snap(); } else if (recording && heldRec) stopRec();
      if (!locked) { // let go too early: springs back smoothly
        shutter.style.transition = 'transform .28s cubic-bezier(.2,.9,.25,1)';
        shutter.style.transform = '';
        arrow.style.setProperty('--p', '0');
      }
    }
    function cancelPress() {
      lockedTap = false;
      filmPending = false;
      if (holdT) { clearTimeout(holdT); holdT = null; } else if (recording && heldRec) stopRec();
    }
    // Touch events for fingers (iOS cancels long pointer presses), pointer events only for the mouse.
    shutter.addEventListener('touchstart', (e) => { e.preventDefault(); press(e.touches[0].clientX); }, { passive: false });
    shutter.addEventListener('touchmove', (e) => { e.preventDefault(); drag(e.touches[0].clientX); }, { passive: false });
    shutter.addEventListener('touchend', (e) => { e.preventDefault(); release(); }, { passive: false });
    shutter.addEventListener('touchcancel', cancelPress);
    shutter.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') return; e.preventDefault(); try { shutter.setPointerCapture(e.pointerId); } catch (x) { /* not supported */ } press(e.clientX); });
    shutter.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') drag(e.clientX); });
    shutter.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') release(); });
    shutter.addEventListener('pointercancel', (e) => { if (e.pointerType !== 'touch') cancelPress(); });
    shutter.addEventListener('contextmenu', (e) => e.preventDefault());

    document.body.style.overflow = 'hidden';
    document.body.append(root);
    cameraCloser = done;
    start();
  }

  // Full-screen photo and video viewer for boards and chats: shows the one you tapped. [x] or Esc closes it.
  // An item without src (a group video) is decrypted on demand via load(), with progress.
  let viewerCloser = null;
  function openViewer(items, start) {
    const it = items[Math.max(0, Math.min(start || 0, items.length - 1))];
    if (!it) return;
    if (viewerCloser) viewerCloser();
    const prevOverflow = document.body.style.overflow;
    const stage = h('div', { class: 'vstage' });
    const root = h('div', { class: 'viewer' }, stage, btn('[x]', () => done(), 'vclose'));
    const key = (e) => { if (e.key === 'Escape') done(); };
    root.addEventListener('click', (e) => { if (e.target === root || e.target === stage) done(); });
    let open = true;
    function done() {
      open = false;
      document.removeEventListener('keydown', key);
      root.remove();
      document.body.style.overflow = prevOverflow;
      viewerCloser = null;
    }
    async function show() {
      let src = it.src;
      if (!src && it.load) {
        const msg = h('div', { class: 'vmsg' }, 'loading...');
        stage.replaceChildren(msg);
        try { src = await it.load((f) => { if (open) msg.textContent = 'loading ' + Math.round(f * 100) + '%'; }); } catch (e) { src = null; }
        if (!open) return;
        if (src) it.src = src;
      }
      stage.replaceChildren(!src ? h('div', { class: 'vmsg' }, 'Could not load this.')
        : it.kind === 'video' ? cleanVideo(src) : h('img', { src, alt: '' }));
    }
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', key);
    document.body.append(root);
    viewerCloser = done;
    show();
  }

  // ------------------------------------------------------------ crypto (groups)
  const ENC = new TextEncoder();
  const DEC = new TextDecoder();
  const b64 = (buf) => { let s = ''; new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const CODE_ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const normCode = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const normName = (s) => String(s).trim().replace(/\s+/g, ' ');
  const gl = (g) => g.name + (g.num ? ' #' + String(g.num).padStart(4, '0') : ''); // "Name #0001" (open) or "Name #4821" (closed)
  const OPEN_CODE = 'OPENOPENOPEN'; // open groups use this public code: anyone can join, nothing is private
  const genNum = () => 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000);

  // closed-group codes are 12 letters and digits shown as XXXX-XXXX-XXXX; the field puts the dashes in itself
  function fmtCode(s) {
    const d = String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    return d.slice(0, 4) + (d.length > 4 ? '-' : '') + d.slice(4, 8) + (d.length > 8 ? '-' : '') + d.slice(8);
  }
  function genCode() {
    const a = crypto.getRandomValues(new Uint8Array(12));
    return fmtCode([...a].map((b) => CODE_ALPHA[b % 32]).join(''));
  }

  // One PBKDF2 run -> 64 bytes: first half proves membership to the server, second half encrypts.
  async function deriveGroup(name, code, num) {
    if (!(crypto && crypto.subtle)) throw new Error('Encryption needs HTTPS (or localhost)');
    const base = await crypto.subtle.importKey('raw', ENC.encode(normCode(code)), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', iterations: 150000, salt: ENC.encode('bunker/v1/' + normName(name).toLowerCase() + (num ? '#' + num : '')) },
      base, 512));
    const key = await crypto.subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { verifier: b64(bits.slice(0, 32)), key };
  }
  // Turning a code into a key is heavy. Each group's key is worked out once, in the background, and kept in memory,
  // so tapping a group never waits for it.
  const groupKeys = new Map();
  const keyOf = (m) => String(m.name).toLowerCase() + '#' + (m.num || 0) + '|' + normCode(m.code);
  function groupKeysFor(m) {
    const k = keyOf(m);
    if (!groupKeys.has(k)) groupKeys.set(k, deriveGroup(m.name, m.code, m.num).catch((e) => { groupKeys.delete(k); throw e; }));
    return groupKeys.get(k);
  }
  const primeGroupKeys = (m, dk) => groupKeys.set(keyOf(m), Promise.resolve(dk));
  async function warmGroupKeys() {
    const all = myGroups();
    for (const id of Object.keys(all)) {
      try { await groupKeysFor(all[id]); } catch (e) { /* removed or unusable: ignore */ }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  // The chat's frame, on screen the moment a group is tapped. The real chat takes its place without any visible change.
  function chatShell(mine) {
    const editSpot = btn('[ edit ]', undefined, 'sm');
    editSpot.style.visibility = 'hidden';
    const box = h('textarea', { class: 'chatbox', rows: '1', disabled: true });
    return h('div', { class: 'chat-root' },
      h('div', { class: 'chead' }, h('a', { class: 'back', href: '#/g' }, '<'),
        h('div', { class: 'ttl' }, h('div', { class: 'n' }, gl(mine)), h('div', { class: 's' }, '\u00a0')), editSpot),
      h('div', { class: 'cmenu', style: 'display:none' }),
      h('div', { class: 'msgwrap' }, h('div', { class: 'msgs' })),
      h('div', { class: 'cbar' }, rule(), h('div', { class: 'crow' }, btn('[+]', undefined, 'plus'), box, btn('[>]', undefined, 'sendb'))));
  }

  // A message is locked together with who sent it and its own id, so a server cannot move it to another sender or send it twice unnoticed.
  const msgAad = (gid, kind, sender, cid) => ENC.encode(['bunker/2', gid, kind, sender, cid].join('|'));
  async function seal(g, text, extra, who) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: msgAad(g.id, who.kind, who.sender, who.cid) }, g.key, ENC.encode(JSON.stringify(Object.assign({ t: text }, extra || {}))));
    return { ct: b64(ct), iv: b64(iv) };
  }
  // Group media is encrypted on the device with the group key before upload.
  async function sealBlob(g, blob) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ENC.encode(g.id) }, g.key, await blob.arrayBuffer());
    return { data: new Blob([ct]), iv: b64(iv) };
  }
  async function openBlob(g, buf, ivB64, type) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64), additionalData: ENC.encode(g.id) }, g.key, buf);
    return new Blob([pt], { type: /^(image|video)\/[a-z0-9.+-]+$/.test(type || '') ? type : 'application/octet-stream' });
  }
  async function unseal(g, m) {
    try {
      if (!m.cid) return null;
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.iv), additionalData: msgAad(g.id, m.kind, m.sender, m.cid) }, g.key, unb64(m.ct));
      return JSON.parse(DEC.decode(pt));
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------ push
  function urlb64(s) {
    const p = '='.repeat((4 - (s.length % 4)) % 4);
    return Uint8Array.from(atob((s + p).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  }
  const pushList = () => ls.get('push', []);
  async function pushToggle(target, extra) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw new Error('Push is not available here. On iPhone: Share > Add to Home Screen first.');
    }
    const reg = await navigator.serviceWorker.ready;
    const on = pushList().includes(target);
    if (on) {
      await api('POST', '/push/unsubscribe', { target });
      ls.set('push', pushList().filter((t) => t !== target));
      return false;
    }
    if (Notification.permission === 'denied') {
      throw new Error(/iphone|ipad|ipod/i.test(navigator.userAgent)
        ? 'Blocked earlier. Turn it on in Settings > Notifications > ' + (CFG.app || 'bunker') + '.'
        : 'Blocked earlier. Allow notifications for this site in the browser settings (lock icon next to the address).');
    }
    const asked = await Notification.requestPermission();
    if (asked === 'denied') throw new Error('You chose Block. It can only be changed in the phone or browser settings.');
    if (asked !== 'granted') throw new Error('No answer. Tap again and choose Allow.');
    const { key } = await api('GET', '/push/key');
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlb64(key) }));
    await api('POST', '/push/subscribe', { subscription: sub.toJSON(), target }, extra);
    ls.set('push', [...pushList(), target]);
    return true;
  }
  function notifyButton(target, extra) {
    const b = h('button', { type: 'button' });
    const err = h('span', { class: 'err' });
    const paint = () => { b.textContent = pushList().includes(target) ? '[ Notifications: ON ]' : '[ Notify me ]'; };
    b.addEventListener('click', async () => {
      err.textContent = '';
      b.disabled = true;
      try { await pushToggle(target, extra); } catch (e) { err.textContent = ' ' + e.message; }
      b.disabled = false;
      paint();
    });
    paint();
    return h('span', {}, b, err);
  }

  // ------------------------------------------------------------ rendering helpers
  // a leading $ turns a title or message into disco: the colours cycle
  const isDisco = (s) => typeof s === 'string' && s.startsWith('$') && !s.startsWith('$$');
  const noDollar = (s) => (isDisco(s) ? s.slice(1).replace(/^\s+/, '') : (typeof s === 'string' && s.startsWith('$$') ? s.slice(1) : s)); // $$ shows one plain $

  function renderBody(text, onRef) {
    const box = h('div', { class: 'pre' + (isDisco(text) ? ' disco' : '') });
    text = noDollar(text);
    text.split('\n').forEach((line, i, arr) => {
      const isQuote = line.startsWith('>') && !line.startsWith('>>');
      const span = h('span', { class: isQuote ? 'green' : '' });
      const parts = line.split(/(>>\d+)/g);
      parts.forEach((p) => {
        const m = /^>>(\d+)$/.exec(p);
        if (m && onRef) span.append(h('span', { class: 'lnk', onclick: () => onRef(m[1]) }, p));
        else span.append(p);
      });
      box.append(span);
      if (i < arr.length - 1) box.append('\n');
    });
    return box;
  }

  function nameSpan(sender, kind) {
    return h('span', { class: kind === 'p' ? 'name' : 'anon' }, sender);
  }

  function heartBtn(count, liked, onclick) {
    return h('button', { type: 'button', class: 'heart' + (liked ? ' on' : ''), onclick }, '<3' + (count ? ' ' + count : ''));
  }

  const LOGO = (() => {
    const L = {
      B: [' ____  ', '| __ ) ', '|  _ \\ ', '| |_) |', '|____/ '],
      U: [' _   _ ', '| | | |', '| | | |', '| |_| |', ' \\___/ '],
      N: [' _   _ ', '| \\ | |', '|  \\| |', '| |\\  |', '|_| \\_|'],
      K: [' _  __', '| |/ /', "| ' / ", '| . \\ ', '|_|\\_\\'],
      E: [' _____ ', '| ____|', '|  _|  ', '| |___ ', '|_____|'],
      R: [' ____  ', '|  _ \\ ', '| |_) |', '|  _ < ', '|_| \\_\\'],
    };
    const word = 'BUNKER';
    return [0, 1, 2, 3, 4].map((i) => [...word].map((c) => L[c][i]).join('')).join('\n');
  })();

  function header() {
    const items = [['Boards', '#/b'], ['Groups', '#/g'], ['Me', '#/me']];
    const nav = h('div', {});
    items.forEach(([label, href]) => {
      const on = location.hash.startsWith(href);
      nav.append(h('a', { href, class: on ? 'acc' : '', 'data-nav': label }, '[ ' + label + ' ]'), ' ');
    });
    // the version sits at the right, just under the logo; a tap shows what changed
    const label = (CFG.label ? CFG.label + ' ' : '') + 'v' + (CFG.version || '');
    return h('div', {}, h('a', { href: '#/', onclick: logoTap }, h('div', { class: 'logo' }, LOGO)), gap(), h('div', { class: 'navrow' }, nav, h('a', { href: '#/changes', class: 'ver' }, label)), rule('='), gap());
  }

  function setView(...nodes) {
    appEl.replaceChildren(header(), ...nodes.flat(Infinity).filter((n) => n != null && n !== false));
    window.scrollTo(0, 0);
    paintBadges();
  }

  // A group of ( ) / (*) choices, in the same ASCII style as the rest. get() returns the chosen value.
  function radios(name, title, options, initial) {
    let value = initial;
    const box = h('div', {}, h('div', { class: 'dim' }, title));
    options.forEach(([val, text]) => {
      const input = h('input', { type: 'radio', name, value: val });
      input.checked = val === initial;
      input.addEventListener('change', () => { if (input.checked) value = val; });
      box.append(h('div', { class: 'row' }, h('label', {}, input, ' ', text)));
    });
    box.get = () => value;
    return box;
  }

  // Inline "are you sure?" in the same ASCII style: the button turns into a question with [ Yes ] and [ Cancel ].
  function sure(label, question, yesLabel, onYes) {
    const holder = h('span', {});
    const show = () => holder.replaceChildren(btn(label, () => {
      holder.replaceChildren(h('span', { class: 'err' }, question + ' '), btn(yesLabel, onYes), btn('[ Cancel ]', show));
    }));
    show();
    return holder;
  }

  // Text fields grow while you type, so everything you wrote stays visible (no sideways scrolling on a phone).
  const COARSE = window.matchMedia && matchMedia('(pointer: coarse)').matches; // phones: Enter makes a new line, [ Send ] sends
  function grow(el) {
    const max = Math.round(window.innerHeight * 0.45);
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, max) + 'px';
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'; // no scrollbar until the box is full
  }
  function growing(el) {
    el.addEventListener('input', () => grow(el));
    requestAnimationFrame(() => grow(el));
    return el;
  }

  // A fill-in field in the app's style: a prompt, your text, and a dashed line that lights up while you type.
  const fld = (input, prompt) => h('div', { class: 'fld' }, h('span', { class: 'pr' }, prompt || '>'), input);

  function errBox() {
    const e = h('div', { class: 'err' });
    e.show = (msg) => { e.textContent = msg ? '! ' + msg : ''; };
    return e;
  }

  // ------------------------------------------------------------ composer
  function modeRow(name) {
    const mode = state.pseudo && ls.get('mode', 'anon') === 'pseudo' ? 'pseudo' : 'anon';
    const row = h('div', { class: 'row' });
    const a = h('input', { type: 'radio', name, value: 'anon' });
    const p = h('input', { type: 'radio', name, value: 'pseudo' });
    if (!state.pseudo) p.disabled = true;
    (mode === 'pseudo' ? p : a).checked = true;
    const onch = () => ls.set('mode', p.checked ? 'pseudo' : 'anon');
    a.addEventListener('change', onch);
    p.addEventListener('change', onch);
    row.append(h('label', {}, a, ' Anonymous'),
      h('label', {}, p, ' ', state.pseudo ? state.pseudo : h('span', { class: 'dim' }, 'Pseudonym (claim one in Me)')));
    row.value = () => (p.checked && state.pseudo ? 'pseudo' : 'anon');
    return row;
  }

  // a button you cannot press yet (a required field is empty) is disabled, and shown white
  function gate(button, inputs) {
    const upd = () => { button.disabled = !inputs.every((i) => i.value.trim()); };
    inputs.forEach((i) => i.addEventListener('input', upd));
    upd();
    return upd;
  }

  function composer({ withSubject, placeholder, submitLabel, onSubmit }) {
    const err = errBox();
    const subject = withSubject ? h('input', { type: 'text', maxlength: '80', placeholder: 'Subject (optional)', autocomplete: 'off' }) : null;
    const body = growing(h('textarea', { maxlength: '2000', placeholder: placeholder || 'Say something...' }));
    const mode = modeRow('mode' + Math.random().toString(36).slice(2));
    const att = attachWidget();
    const go = btn('[ ' + submitLabel + ' ]', async () => {
      err.show('');
      go.disabled = true;
      try {
        let media = null;
        const f = att.file();
        if (f) {
          err.textContent = 'processing media...';
          const pm = await prepMedia(f);
          err.textContent = 'uploading ' + fmtSize(pm.blob.size) + '...';
          media = (await uploadMedia('board', pm.blob, undefined, (pr) => { err.textContent = 'uploading ' + Math.round(pr * 100) + '%'; })).id;
          err.textContent = '';
        }
        await onSubmit({ subject: subject ? subject.value : '', body: body.value, mode: mode.value(), media });
        body.value = '';
        grow(body);
        if (subject) subject.value = '';
        att.clear();
      } catch (e) { err.show(e.message); }
      upd();
    });
    const upd = () => { go.disabled = !(body.value.trim() || att.file()); };
    body.addEventListener('input', upd);
    att.el.addEventListener('change', () => setTimeout(upd));
    att.el.addEventListener('click', () => setTimeout(upd));
    upd();
    return h('div', {}, subject ? fld(subject) : null, fld(body), att.el, mode,
      h('div', {}, go), err);
  }

  // ------------------------------------------------------------ views
  function viewHome() {
    setView(
      h('div', { class: 'pre' }, 'Anonymous boards. Encrypted groups.'),
      gap(),
      h('div', {}, link('[ Boards ]', '#/b'), ' public threads'),
      h('div', {}, link('[ Groups ]', '#/g'), ' open and closed chats'),
      h('div', {}, link('[ Me ]', '#/me'), ' pseudonym, code, theme'),
      h('div', {}, link('[ Manifesto ]', '#/manifesto')),
    );
  }

  function viewBoards() {
    setView(CFG.boards.map((b) =>
      h('div', { class: 'thread-row boardrow' }, link('/' + b.id + '/', '#/b/' + b.id), h('span', { class: 'star', 'data-mark': 'b:' + b.id }))));
  }

  async function viewBoard(id) {
    if (!ls.get('seen', null)) await refreshActivity(); // first visit ever: nothing is new yet
    const prevSeen = seenGet().b[id] || 0; // what you had seen before this visit: threads newer than that get an asterisk
    let lastBump = 0;
    const seq = routeSeq;
    const list = h('div', {});
    const form = h('div', { style: 'display:none' });
    let formOpen = false;
    const toggle = btn('[ New thread ]', () => {
      formOpen = !formOpen;
      form.style.display = formOpen ? 'block' : 'none';
    });
    form.append(composer({
      withSubject: true, placeholder: 'Start a thread...', submitLabel: 'Post thread',
      async onSubmit(v) {
        const cid = newCid();
        const wasRead = !unreadB(id);
        const r = await api('POST', '/boards/' + id + '/threads', { subject: v.subject, body: v.body, mode: v.mode, media: v.media, cid }, await ownHdr(cid));
        if (wasRead) { await refreshActivity(); seenSet('b', id, ACT.boards[id] || 0); } // your own post is not news to you
        location.hash = '#/t/' + r.id;
      },
    }));
    const title = h('div', { class: 'acc' }, '/' + id + '/');
    setView(title, h('div', {}, toggle, notifyButton('board:' + id)), form, rule(), list);

    async function load() {
      const d = await api('GET', '/boards/' + id);
      title.textContent = '/' + id + '/';
      const vitems = d.threads.filter((t) => t.media_id).map((t) => ({ id: t.media_id, kind: (t.mmime || '').startsWith('video/') ? 'video' : 'image', src: '/api/media/' + t.media_id }));
      lastBump = d.threads.reduce((m, t) => Math.max(m, t.bump), lastBump);
      seenSet('b', id, lastBump);
      const seenT = seenGet().t;
      list.replaceChildren(...(d.threads.length ? d.threads.map((t) => {
        const fresh = t.bump > Math.max(prevSeen, seenT[t.id] || 0);
        return h('div', { class: 'thread-row' + (fresh ? ' fresh' : '') },
          t.subject ? h('div', { class: 'subj' + (isDisco(t.subject) ? ' disco' : '') }, noDollar(t.subject)) : null,
          h('div', { class: 'tmeta' }, fresh ? h('span', { class: 'star' }, '* ') : null, h('span', { class: 'dim' }, 'No.' + t.id + ' '), nameSpan(t.sender, t.kind), h('span', { class: 'dim' }, ' ' + ago(t.created) + ' ago' + (t.edited ? ' (edited)' : ''))),
          h('div', { class: 'body' }, renderBody(t.body.length >= 400 ? t.body + '...' : t.body)),
          t.media_id ? boardMedia(t.media_id, t.mmime, t.msize, () => openViewer(vitems, vitems.findIndex((x) => x.id === t.media_id))) : null,
          h('div', { class: 'acts' }, link('[ Open ]', '#/t/' + t.id), h('span', { class: 'dim' }, '  ' + t.replies + (t.replies === 1 ? ' reply' : ' replies') + '  <3 ' + t.likes)));
      }) : [h('div', { class: 'dim' }, 'No threads yet. Be the first.')]));
    }
    await load();
    if (seq !== routeSeq) return;
    let timer = null;
    const off = stream('board:' + id, () => { clearTimeout(timer); timer = setTimeout(() => load().catch(() => {}), 400); });
    teardown.push(off, () => clearTimeout(timer), () => seenSet('b', id, lastBump));
  }

  async function viewThread(tid) {
    const seq = routeSeq;
    const list = h('div', {});
    const top = h('div', {});
    const replyBox = h('div', {});
    setView(top, rule(), list, rule(), replyBox);
    let boardId = '';
    let full = false;

    function show(n) {
      const el = document.getElementById('p' + n);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('hl');
      setTimeout(() => el.classList.remove('hl'), 1500);
    }

    let editing = null; // { id, body, subject, link }: kept here so live refreshes do not lose a draft
    let stale = false;

    function editor(p, subjectNow) {
      const err = errBox();
      const ta = growing(h('textarea', { maxlength: '2000' }));
      ta.value = editing.body;
      ta.addEventListener('input', () => { editing.body = ta.value; });
      let subj = null;
      if (p.is_op) {
        subj = h('input', { type: 'text', maxlength: '80', placeholder: 'Subject (optional)', autocomplete: 'off' });
        subj.value = editing.subject;
        subj.addEventListener('input', () => { editing.subject = subj.value; });
      }
      let chk = null;
      if (p.kind === 'a' && state.pseudo) {
        chk = h('input', { type: 'checkbox' });
        chk.checked = editing.link;
        chk.addEventListener('change', () => { editing.link = chk.checked; });
      }
      const dropBox = h('div', {});
      if (p.media_id) {
        const paintDrop = () => dropBox.replaceChildren(...(editing.dropMedia
          ? [h('span', { class: 'err' }, 'Media will be removed '), btn('[ Keep ]', () => { editing.dropMedia = false; paintDrop(); }, 'sm')]
          : [btn('[ Remove media ]', () => { editing.dropMedia = true; paintDrop(); }, 'sm')]));
        paintDrop();
      }
      const save = btn('[ Save ]', async () => {
        err.show('');
        save.disabled = true;
        try {
          const body = { body: ta.value, link_pseudonym: chk ? chk.checked : false };
          if (editing.dropMedia) body.remove_media = true;
          if (subj) body.subject = subj.value;
          await api('POST', '/posts/' + p.id + '/edit', body, await ownHdr(p.cid));
          editing = null;
          await load();
        } catch (e) { err.show(e.message); save.disabled = false; }
      });
      const cancel = btn('[ Cancel ]', () => { editing = null; load().catch(() => {}); });
      return h('div', { class: 'body' }, subj ? fld(subj) : null, fld(ta), dropBox,
        chk ? h('label', { class: 'dim' }, chk, ' post as ' + state.pseudo + ' (links your pseudonym to this post)') : null,
        h('div', {}, save, cancel), err);
    }

    async function load() {
      const d = await api('GET', '/threads/' + tid);
      await Promise.all(d.posts.map(async (p) => { p.mine = await isMine(p.cid, p.own); p.liked = await didAct('p|' + p.id, p.lk); }));
      boardId = d.board;
      full = d.full;
      seenSet('t', Number(tid), d.posts.reduce((m, p) => Math.max(m, p.ts), 0));
      stale = false;
      const vitems = d.posts.filter((p) => p.media_id).map((p) => ({ id: p.media_id, kind: (p.mmime || '').startsWith('video/') ? 'video' : 'image', src: '/api/media/' + p.media_id }));
      top.replaceChildren(
        h('div', {}, link('<< /' + d.board + '/', '#/b/' + d.board)),
        d.subject ? h('div', { class: 'subj' + (isDisco(d.subject) ? ' disco' : '') }, noDollar(d.subject)) : '');
      list.replaceChildren(...d.posts.map((p) => {
        const isEditing = editing && editing.id === p.id;
        return h('div', { class: 'post', id: 'p' + p.id },
          h('div', { class: 'meta' }, nameSpan(p.sender, p.kind), ' No.' + p.id + ' ' + clock(p.ts),
            p.edited ? h('span', { class: 'dim' }, ' (edited ' + clock(p.edited) + ')') : null),
          isEditing ? editor(p, d.subject) : h('div', { class: 'body' }, renderBody(p.body, show)),
          p.media_id ? boardMedia(p.media_id, p.mmime, p.msize, () => openViewer(vitems, vitems.findIndex((x) => x.id === p.media_id))) : null,
          h('div', {},
            heartBtn(p.likes, p.liked, async () => { try { await api('POST', '/posts/' + p.id + '/like', undefined, await tokHdr('p|' + p.id)); await load(); } catch (e) { /* ignore */ } }),
            btn('[ reply ]', () => { const ta = replyBox.querySelector('textarea'); if (ta) { ta.value += '>>' + p.id + '\n'; ta.focus(); } }, 'sm'),
            p.mine && !isEditing ? btn('[ edit ]', () => {
              editing = { id: p.id, body: p.body, subject: p.is_op ? d.subject || '' : '', link: false };
              load().catch(() => {});
            }, 'sm') : null,
            p.mine && !isEditing ? sure('[ delete ]', p.is_op ? 'Delete the whole thread?' : 'Delete this post?', '[ Yes, delete ]', async () => {
              try { await api('DELETE', '/posts/' + p.id, undefined, await ownHdr(p.cid)); if (p.is_op) location.hash = boardId ? '#/b/' + boardId : '#/b'; else await load(); } catch (e) { /* ignore */ }
            }) : null,
            btn('[ report ]', async (ev) => { try { await api('POST', '/posts/' + p.id + '/report', undefined, await tokHdr('r|' + p.id)); ev.target.textContent = '[ reported ]'; } catch (e) { ev.target.textContent = '[ ' + e.message + ' ]'; } }, 'sm'),
            CFG.admin ? btn('[ delete ]', async () => { if (confirm('Delete No.' + p.id + '?')) { await api('DELETE', '/posts/' + p.id); } }, 'sm') : null));
      }));
      if (!replyBox.firstChild) { // build once so a half-typed reply survives live updates
        replyBox.append(full ? h('div', { class: 'warn' }, 'This thread is full.') : composer({
          placeholder: 'Reply...', submitLabel: 'Post reply',
          async onSubmit(v) {
            const cid = newCid();
            const wasRead = !unreadB(boardId);
            await api('POST', '/threads/' + tid + '/posts', { body: v.body, mode: v.mode, media: v.media, cid }, await ownHdr(cid));
            if (wasRead) { await refreshActivity(); seenSet('b', boardId, ACT.boards[boardId] || 0); }
            await load();
          },
        }));
      }
    }
    try { await load(); } catch (e) { top.replaceChildren(h('div', { class: 'err' }, '! ' + e.message), link('<< Boards', '#/b')); return; }
    if (seq !== routeSeq) return;
    let timer = null;
    const off = stream('thread:' + tid, (ev) => {
      if (ev.type === 'gone') { location.hash = boardId ? '#/b/' + boardId : '#/b'; return; }
      if (editing) { stale = true; return; } // do not pull the text out from under someone who is editing
      clearTimeout(timer);
      timer = setTimeout(() => load().catch(() => {}), 400);
    });
    teardown.push(off, () => clearTimeout(timer));
  }

  // ----- groups
  const myGroups = () => ls.get('groups', {});

  function viewGroups() {
    const mine = myGroups();
    const mineBox = h('div', {});
    const results = h('div', {});
    const search = h('input', { type: 'text', placeholder: 'Name or 4-digit code', autocomplete: 'off', autocapitalize: 'none' });

    const ids = Object.keys(mine);
    mineBox.append(h('div', { class: 'acc' }, 'MY GROUPS'), rule());
    if (!ids.length) mineBox.append(h('div', { class: 'dim' }, 'None yet.'));
    ids.forEach((id) => mineBox.append(h('div', { class: 'row' }, link('[ Open ]', '#/g/' + id), ' ' + gl(mine[id]), h('span', { class: 'star', 'data-mark': 'g:' + id }))));

    async function find() {
      let d;
      try { d = await api('GET', '/groups?q=' + encodeURIComponent(search.value)); } catch (e) { results.replaceChildren(h('div', { class: 'err' }, '! ' + e.message)); return; }
      const open = d.groups.filter((g) => !g.closed);
      const closed = d.groups.filter((g) => g.closed);
      results.replaceChildren(
        ...(open.length ? [h('div', { class: 'acc' }, 'OPEN GROUPS'), rule(), ...open.map(groupRow)] : []),
        ...(closed.length ? [gap(), h('div', { class: 'acc' }, 'CLOSED GROUPS'), rule(), ...closed.map(groupRow)] : []),
        ...(open.length || closed.length ? [] : [h('div', { class: 'dim' }, 'No groups found.')]));
    }
    function groupRow(g) {
      const box = h('div', { class: 'thread-row' });
      const joinForm = h('div', { style: 'display:none' });
      const code = h('input', { type: 'text', placeholder: 'XXXX-XXXX-XXXX', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
      code.addEventListener('input', () => { code.value = fmtCode(code.value); });
      const err = errBox();
      async function join(codeText, button) {
        err.show('');
        button.disabled = true;
        try {
          err.textContent = 'deriving key...';
          const dk = await groupKeysFor({ name: g.name, num: g.num, code: codeText });
          await api('GET', '/groups/' + g.id + '/messages', undefined, { 'X-Verifier': dk.verifier });
          const all = myGroups();
          all[g.id] = { name: g.name, num: g.num, code: normCode(codeText) };
          ls.set('groups', all);
          location.hash = '#/g/' + g.id;
        } catch (e) { err.show(e.message); }
        button.disabled = button === doJoin && !code.value.trim();
      }
      const doJoin = btn('[ Enter ]', () => join(code.value, doJoin));
      gate(doJoin, [code]);
      joinForm.append(fld(code), doJoin);
      const isMine = !!myGroups()[g.id];
      const joinBtn = g.closed
        ? btn('[ Join with code ]', () => { joinForm.style.display = joinForm.style.display === 'none' ? 'block' : 'none'; code.focus(); })
        : btn('[ Join ]', () => join(OPEN_CODE, joinBtn)); // open: no code needed
      box.append(
        h('div', {}, h('span', { class: 'acc' }, gl(g)), h('span', { class: 'dim' }, (g.closed ? '  [closed]' : '  [open]') + '  online: ' + g.online + '  last: ' + ago(g.last_act) + '  ' + expiry(g.ttl))),
        h('div', {}, isMine ? link('[ Open ]', '#/g/' + g.id) : joinBtn),
        joinForm, err);
      return box;
    }

    const createBox = h('div', { style: 'display:none' });
    const nm = h('input', { type: 'text', maxlength: '32', placeholder: 'Unique group name', autocomplete: 'off' });
    const TTL_TEXT = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', off: 'Only ' + (CFG.keep || 10) + ' msg remembered' };
    const ttl = radios('ttl', 'Messages vanish after:', ['off', '1h', '24h', '7d'].filter((t) => CFG.ttls.includes(t)).map((t) => [t, TTL_TEXT[t] || t]), 'off');
    const vis = radios('vis', 'Access:', [['closed', 'Closed: code needed, encrypted'], ['open', 'Open: anyone can join, public']], 'closed');
    const cerr = errBox();
    const mk = btn('[ Create group ]', async () => {
      cerr.show('');
      mk.disabled = true;
      try {
        const name = normName(nm.value);
        if (name.length < 2) throw new Error('Pick a name');
        const closed = vis.get() === 'closed';
        const code = closed ? genCode() : OPEN_CODE;
        let r = null;
        for (let attempt = 0; attempt < 4 && !r; attempt++) {
          const num = closed ? genNum() : 1;
          const dk = await deriveGroup(name, code, num);
          try {
            r = await api('POST', '/groups', { name, verifier: dk.verifier, ttl: ttl.get(), closed, num });
          } catch (e) { if (!(closed && e.status === 409 && /Number already/.test(e.message))) throw e; }
          if (r) primeGroupKeys({ name: r.name, num: r.num, code }, dk);
        }
        if (!r) throw new Error('Could not pick a free number, try again');
        const all = myGroups();
        all[r.id] = { name: r.name, num: r.num, code: normCode(code) };
        ls.set('groups', all);
        viewCreated(r, code);
      } catch (e) { cerr.show(e.message); }
      updMk();
    });
    const updMk = gate(mk, [nm]);
    createBox.append(fld(nm), gap(), ttl, gap(), vis, gap(), mk, cerr);
    const tog = btn('[ + Create group ]', () => { createBox.style.display = createBox.style.display === 'none' ? 'block' : 'none'; });

    const searchBtn = btn('[ Search ]', find);
    gate(searchBtn, [search]);
    setView(mineBox, gap(), h('div', { class: 'acc' }, 'SEARCH A GROUP'), rule(), h('div', { class: 'finder' }, h('span', { class: 'pr' }, '>'), search, searchBtn), gap(), results, gap(), rule(), tog, createBox);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && search.value.trim()) find(); });
    find();
  }

  function viewCreated(r, code) {
    const open = code === OPEN_CODE;
    setView(
      h('div', { class: 'acc' }, 'GROUP CREATED: ' + gl(r)), rule(),
      h('div', { class: 'pre' }, open ? 'Open group. Share the name:' : 'Share the name and code:'),
      h('div', { class: 'acc', style: 'font-size:20px;margin:6px 0' }, gl(r)),
      open ? null : [
        gap(), h('div', { class: 'acc', style: 'font-size:22px' }, code), gap(),
        h('div', { class: 'warn pre' }, 'Write the code down. It cannot be recovered.'),
        gap(),
        btn('[ Copy code ]', async (e) => { try { await navigator.clipboard.writeText(code); e.target.textContent = '[ Copied ]'; } catch (x) { e.target.textContent = '[ Copy failed ]'; } }),
      ],
      link('[ Open group ]', '#/g/' + r.id));
  }

  // ---- group voice: your microphone, encrypted on the phone with the group key, relayed by the server to everyone connected.
  // Audio is mono 16 kHz, squeezed to 8 bits (mu-law), in 40 ms frames. The server only ever sees encrypted frames.
  const MULAW = new Float32Array(256).map((_, i) => { const u = ~i & 0xFF; const s = (((u & 15) << 3) + 0x84) << ((u >> 4) & 7); return ((u & 0x80) ? -(s - 0x84) : (s - 0x84)) / 32768; });
  function toMulaw(v) { // v: float -1..1
    let s = Math.max(-32635, Math.min(32635, Math.round(v * 32767)));
    const sign = s < 0 ? 0x80 : 0;
    if (sign) s = -s;
    s += 0x84;
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1) { /* find the segment */ }
    return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0F)) & 0xFF;
  }
  // One audio context for the whole app, unlocked by the first tap anywhere: a phone only lets sound start after a touch,
  // so by the time a chat opens it is already running and you hear whoever is connected at once.
  // Sound goes out through a hidden media element, because the iPhone silent switch mutes plain web audio but not media playback.
  // If that element cannot start, the audio context plays it directly.
  let SHARED_CTX = null; let SHARED_OUT = null; let SHARED_EL = null; let ROUTE_CTX = null; let ROUTE_EL = null; let ctxWatch = null;
  function audioCtx() {
    if (!SHARED_CTX) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      SHARED_CTX = new AC({ latencyHint: 'interactive' });
      SHARED_OUT = SHARED_CTX.createGain();
      ROUTE_CTX = SHARED_CTX.createGain();
      ROUTE_EL = SHARED_CTX.createGain();
      ROUTE_EL.gain.value = 0;
      SHARED_OUT.connect(ROUTE_CTX); SHARED_OUT.connect(ROUTE_EL);
      ROUTE_CTX.connect(SHARED_CTX.destination);
      try {
        const dest = SHARED_CTX.createMediaStreamDestination();
        ROUTE_EL.connect(dest);
        SHARED_EL = new Audio();
        SHARED_EL.setAttribute('playsinline', '');
        SHARED_EL.srcObject = dest.stream;
        SHARED_EL.addEventListener('playing', () => { ROUTE_EL.gain.value = 1; ROUTE_CTX.gain.value = 0; });
        SHARED_EL.addEventListener('pause', () => { ROUTE_EL.gain.value = 0; ROUTE_CTX.gain.value = 1; });
      } catch (e) { SHARED_EL = null; }
      SHARED_CTX.onstatechange = () => { if (ctxWatch) ctxWatch(); };
    }
    return SHARED_CTX;
  }
  // Small sounds, made on the spot: a shutter for photos, a falling blip for muting, a rising one for unmuting.
  function blip(notes, vol) {
    try {
      const c = audioCtx();
      if (!c) return;
      if (c.state === 'suspended') c.resume().catch(() => {});
      const t0 = c.currentTime;
      for (const [f, at, d] of notes) {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.linearRampToValueAtTime(vol, t0 + at + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + d);
        o.connect(g); g.connect(SHARED_OUT);
        o.start(t0 + at); o.stop(t0 + at + d + 0.03);
      }
    } catch (e) { /* no audio */ }
  }
  const soundMute = () => blip([[520, 0, 0.07], [390, 0.07, 0.1]], 0.14);
  const soundUnmute = () => blip([[390, 0, 0.07], [520, 0.07, 0.1]], 0.14);
  function soundShutter() { // a plain camera shutter: a sharp click, then a softer, lower one as it closes. No tones, only noise.
    try {
      const c = audioCtx();
      if (!c) return;
      if (c.state === 'suspended') c.resume().catch(() => {});
      const t0 = c.currentTime;
      const click = (at, len, hz, q, vol) => {
        const n = Math.floor(c.sampleRate * len);
        const buf = c.createBuffer(1, n, c.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.5);
        const src = c.createBufferSource();
        const f = c.createBiquadFilter();
        const g = c.createGain();
        src.buffer = buf; f.type = 'bandpass'; f.frequency.value = hz; f.Q.value = q; g.gain.value = vol;
        src.connect(f); f.connect(g); g.connect(SHARED_OUT);
        src.start(t0 + at);
      };
      click(0, 0.03, 3200, 0.9, 1.2); // the shutter opens: short and bright
      click(0.07, 0.05, 1500, 0.8, 1.0); // and closes: a little lower and longer
    } catch (e) { /* no audio */ }
  }
  function unlockAudio() {
    try {
      const c = audioCtx();
      if (!c) return;
      if (c.state === 'suspended') c.resume().catch(() => {});
      if (SHARED_EL && SHARED_EL.paused) SHARED_EL.play().catch(() => {});
    } catch (e) { /* no audio */ }
  }
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach((t) => document.addEventListener(t, unlockAudio, true));
  // what stands behind a name while that person talks: 1, 2 or 3 marks by how loud, nothing at all when they are quiet
  const VOICE_SIGNS = {
    dots: { label: 'Dots', lv: ['.', '..', '...'] },
    bars: { label: 'Bars', lv: ['.', '.:', '.:|'] },
    stars: { label: 'Stars', lv: ['*', '**', '***'] },
    arrows: { label: 'Arrows', lv: ['>', '>>', '>>>'] },
    waves: { label: 'Waves', lv: [')', '))', ')))'] },
  };
  const VOICE_MUTES = { slash: 'ø', o_slash: 'o/', paren: '(/)', dash: '-o-', cross: 'x' }; // the sign for "muted": an o with a line through it
  const levelOf = (rms) => (rms < 0.02 ? 1 : rms < 0.06 ? 2 : 3);
  let voiceBusy = false; // someone is talking: the page must not refresh itself under them
  function makeVoice(g, mode, onChange, auto) {
    // auto: everyone who opens the chat hears whoever is connected; [ Connect ] only turns your own microphone on.
    // not auto: nothing is open until you press [ Connect ].
    const S = { state: 'off', link: false, muted: false, sound: true, roster: [], me: 0, talking: new Map(), error: '' };
    const AAD = ENC.encode('voice:' + g.id);
    const FRAME = 640; // 40 ms at 16 kHz
    let ws = null; let ctx = null; let outGain = null; let stream = null; let proc = null; let keep = null; let retry = null; let closed = false;
    let lastLv = 0; let acc = []; let hold = 0; let sendChain = Promise.resolve(); let backlog = 0;
    const players = new Map();
    function stopMic() {
      try { if (proc) { proc.onaudioprocess = null; proc.disconnect(); } } catch (e) { /* gone */ }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      proc = stream = null; acc = [];
      S.state = 'off'; S.muted = false;
    }
    function dropLink() {
      clearInterval(keep);
      try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) { /* gone */ }
      ws = null; S.link = false; S.roster = []; S.me = 0; players.clear();
    }
    function closeAll() {
      closed = true;
      clearTimeout(retry);
      stopMic(); dropLink();
      ctxWatch = null;
      try { if (outGain) outGain.disconnect(); } catch (e) { /* gone */ }
      ctx = outGain = null; // the shared context stays for the next chat
    }
    function fail(msg) { stopMic(); S.error = msg || ''; if (!auto) dropLink(); onChange(); }
    function play(vid, pcm) {
      if (!ctx) return;
      let p = players.get(vid);
      if (!p) { p = { next: 0, chain: Promise.resolve() }; players.set(vid, p); }
      const now = ctx.currentTime;
      if (p.next < now + 0.02) p.next = now + 0.12; // a small buffer evens out the network
      if (p.next - now > 0.7) return; // too far behind: skip, stay live
      const buf = ctx.createBuffer(1, pcm.length, 16000);
      buf.copyToChannel(pcm, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(outGain);
      src.start(p.next);
      p.next += buf.duration;
    }
    function incoming(data) {
      const v = new Uint8Array(data);
      if (v.length < 20) return;
      const vid = (v[0] << 8) | v[1];
      let p = players.get(vid);
      if (!p) { p = { next: 0, chain: Promise.resolve() }; players.set(vid, p); }
      p.chain = p.chain.then(async () => {
        try {
          const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: v.slice(2, 14), additionalData: AAD }, g.key, v.slice(14)));
          const pcm = new Float32Array(pt.length);
          for (let i = 0; i < pt.length; i++) pcm[i] = MULAW[pt[i]];
          let e2 = 0;
          for (let i = 0; i < pcm.length; i++) e2 += pcm[i] * pcm[i];
          S.talking.set(vid, { t: Date.now(), lv: levelOf(Math.sqrt(e2 / pcm.length)) });
          if (S.sound) play(vid, pcm);
        } catch (e) { /* a frame that does not decrypt is dropped */ }
      });
    }
    function sendFrame(samples, rms) {
      if (!ws || ws.readyState !== 1 || S.muted) return;
      if (rms > 0.005) hold = Date.now() + 600; // only speech goes out, with a short tail so words do not get cut
      if (Date.now() > hold) return;
      if (backlog > 6) return;
      if (!S.muted && Date.now() - lastLv > 150 && ws && ws.readyState === 1) { lastLv = Date.now(); ws.send(JSON.stringify({ t: 'lv', l: levelOf(rms) })); }
      const ulaw = new Uint8Array(FRAME);
      for (let i = 0; i < FRAME; i++) ulaw[i] = toMulaw(samples[i]);
      backlog++;
      sendChain = sendChain.then(async () => {
        try {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, g.key, ulaw));
          const out = new Uint8Array(12 + ct.length);
          out.set(iv, 0); out.set(ct, 12);
          if (ws && ws.readyState === 1) ws.send(out);
        } catch (e) { /* skip */ } finally { backlog--; }
      });
    }
    function capture() {
      const src = ctx.createMediaStreamSource(stream);
      proc = ctx.createScriptProcessor(2048, 1, 1);
      const sink = ctx.createGain();
      sink.gain.value = 0; // the processor only runs while it is wired to the output, but it must stay silent
      src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
      const ratio = ctx.sampleRate / 16000;
      proc.onaudioprocess = (e) => {
        const inp = e.inputBuffer.getChannelData(0);
        const n = Math.floor(inp.length / ratio);
        for (let k = 0; k < n; k++) {
          const a0 = Math.floor(k * ratio);
          const b0 = Math.max(a0 + 1, Math.floor((k + 1) * ratio));
          let sum = 0;
          for (let i = a0; i < b0 && i < inp.length; i++) sum += inp[i];
          acc.push(sum / (b0 - a0));
        }
        while (acc.length >= FRAME) {
          const fr = acc.splice(0, FRAME);
          let e2 = 0;
          for (let i = 0; i < FRAME; i++) e2 += fr[i] * fr[i];
          sendFrame(fr, Math.sqrt(e2 / FRAME));
        }
      };
    }
    function sendTalk() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'talk', mode: mode() })); }
    function openLink() {
      if (ws || closed) return;
      if (!ctx) {
        ctx = audioCtx();
        outGain = ctx.createGain();
        outGain.gain.value = S.sound ? 1 : 0;
        outGain.connect(SHARED_OUT);
        ctxWatch = () => onChange();
      }
      unlockAudio();
      const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/voice');
      ws = sock;
      sock.binaryType = 'arraybuffer';
      sock.onopen = () => sock.send(JSON.stringify({ gid: g.id, verifier: g.verifier, key: deviceKey() }));
      sock.onmessage = (e) => {
        if (typeof e.data !== 'string') { incoming(e.data); return; }
        let j; try { j = JSON.parse(e.data); } catch (x) { return; }
        if (j.t === 'hello') {
          S.me = j.me; S.link = true;
          keep = setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); }, 15000);
          if (stream) sendTalk();
          onChange();
        } else if (j.t === 'roster') {
          S.roster = j.list;
          if (S.state === 'connecting' && j.list.some((r) => r.id === S.me)) { S.state = 'on'; capture(); }
          onChange();
        } else if (j.t === 'notice') { fail(j.msg); }
        else if (j.t === 'error') { dropLink(); stopMic(); S.error = j.msg; onChange(); }
      };
      sock.onclose = () => {
        const wasTalking = S.state !== 'off';
        dropLink(); stopMic();
        if (wasTalking) S.error = 'Disconnected';
        onChange();
        if (auto && !closed) retry = setTimeout(openLink, 3000); // keep listening
      };
    }
    S.listen = () => { if (auto) openLink(); };
    S.connect = async () => {
      if (S.state !== 'off') return;
      S.state = 'connecting'; S.error = ''; onChange();
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) { fail(e && e.name === 'NotAllowedError' ? 'Microphone is blocked' : 'No microphone'); return; }
      openLink();
      unlockAudio();
      if (ws && S.link) sendTalk();
    };
    S.end = () => {
      if (ws && ws.readyState === 1 && S.state !== 'off') ws.send('{"t":"quiet"}');
      stopMic(); S.error = '';
      if (!auto) dropLink();
      onChange();
    };
    S.toggleMute = () => {
      S.muted = !S.muted;
      if (S.muted) soundMute(); else soundUnmute();
      if (stream) stream.getAudioTracks().forEach((t) => { t.enabled = !S.muted; });
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'mute', m: S.muted }));
      onChange();
    };
    S.toggleSound = () => { S.sound = !S.sound; if (outGain) outGain.gain.value = S.sound ? 1 : 0; onChange(); };
    S.close = closeAll;
    S.needsTap = () => !!ws && !!ctx && ctx.state !== 'running';
    return S;
  }

  async function viewChat(gid) {
    const seq = routeSeq;
    const mine = myGroups()[gid];
    if (!mine) { setView(h('div', { class: 'warn' }, 'You have not joined this group on this device.'), link('[ Back to groups ]', '#/g')); return; }
    appEl.replaceChildren(chatShell(mine)); // no loading screen: the frame is there at once
    document.body.classList.add('chatmode');
    appEl.style.height = (window.visualViewport ? window.visualViewport.height : window.innerHeight) + 'px';
    teardown.push(() => { document.body.classList.remove('chatmode', 'kb'); appEl.style.height = ''; appEl.style.transform = ''; });
    let g;
    let data;
    try {
      const dk = await groupKeysFor(mine);
      g = { id: gid, name: mine.name, num: mine.num, key: dk.key, verifier: dk.verifier };
      data = await api('GET', '/groups/' + gid + '/messages', undefined, { 'X-Verifier': g.verifier });
    } catch (e) {
      if (seq !== routeSeq) return;
      if (e.status === 403 || e.status === 404) { const all = myGroups(); delete all[gid]; ls.set('groups', all); }
      document.body.classList.remove('chatmode');
      appEl.style.height = '';
      setView(h('div', { class: 'err' }, '! ' + e.message), link('[ Back to groups ]', '#/g'));
      return;
    }
    if (seq !== routeSeq) return; // the user already went elsewhere: do not open a second stream
    const ttl = data.group.ttl;
    const isOpen = mine.code === OPEN_CODE;
    let you = data.you;
    let online = data.group.online;
    const VST = Object.assign({ voice_auto: true, group_keep: CFG.keep || 50 }, data.settings || {}); // set on the admin page
    CFG.keep = VST.group_keep;
    const msgs = new Map();
    seenSet('g', gid, data.group.last_act || 0);
    teardown.push(() => { let mx = data.group.last_act || 0; msgs.forEach((m) => { if (m.ts > mx) mx = m.ts; }); seenSet('g', gid, mx); });
    const mineIds = new Set(); // messages this device just sent (the live event cannot say who sent it)
    const loadP = new Map(); // media being decrypted
    const queue = []; // photos and videos waiting to be sent: { file, url }
    let useMode = ls.get('mode', 'anon') === 'pseudo' && you.pseudo ? 'pseudo' : 'anon';
    const currentMode = () => (useMode === 'pseudo' && you.pseudo ? 'pseudo' : 'anon');
    const label = () => (currentMode() === 'pseudo' ? you.pseudo : you.anon);
    let editing = null; // { id, text, fresh }
    let editEl = null;
    let openAct = null; // message whose action row is open
    let stick = true; // is the reader at the bottom?
    let doomedIds = new Set(); // the three oldest messages of a full chat: next in line to disappear
    let unseen = 0;
    let sending = false;

    // ---- screen: header, messages, composer
    const sub = h('div', { class: 's' });
    const menuBox = h('div', { class: 'cmenu', style: 'display:none' });
    const head = h('div', { class: 'chead' },
      h('a', { class: 'back', href: '#/g' }, '<'),
      h('div', { class: 'ttl' }, h('div', { class: 'n' }, gl(g)), sub),
      btn('[ edit ]', () => { const open = menuBox.style.display === 'none'; menuBox.style.display = open ? 'block' : 'none'; if (open) paintMenu(); }, 'sm'));
    const scroller = h('div', { class: 'msgs' });
    const pill = btn('', () => toBottom(), 'pill');
    pill.style.display = 'none';
    const wrap = h('div', { class: 'msgwrap' }, scroller, pill);
    const io = new IntersectionObserver((entries) => entries.forEach((en) => { // older photos load as they come near the screen
      if (!en.isIntersecting) return;
      io.unobserve(en.target);
      const id = Number(en.target.dataset.mid);
      if (id) loadMedia(id);
    }), { root: scroller, rootMargin: '600px 0px' });

    const statEl = h('div', { class: 'cstat dim' });
    const strip = h('div', { class: 'strip' });
    const amenu = h('div', { class: 'amenu', style: 'display:none' });
    const inp = growing(h('textarea', { class: 'chatbox', rows: '1', maxlength: '1500', enterkeyhint: COARSE ? 'enter' : 'send' }));
    const picker = (accept, capture, multiple) => {
      const i = h('input', { type: 'file', accept, hidden: true });
      if (capture) i.setAttribute('capture', 'environment'); // opens the camera on phones
      if (multiple) i.setAttribute('multiple', '');
      i.addEventListener('change', () => { addFiles([...i.files]); i.value = ''; amenu.style.display = 'none'; });
      return i;
    };
    const libIn = picker('image/*,video/*', false, true);
    const camIn = picker('image/*,video/*', true, false); // only used when our own camera is not available
    amenu.append(btn('[ Camera ]', () => { amenu.style.display = 'none'; if (CAMERA_OK) openCamera((f) => addFiles([f]), { multi: true }); else camIn.click(); }),
      btn('[ Library ]', () => { coolDownCamera(); libIn.click(); }), libIn, camIn);
    const plus = btn('[+]', () => { const open = amenu.style.display === 'none'; amenu.style.display = open ? 'block' : 'none'; if (open) warmUpCamera(); else coolDownCamera(); }, 'plus');
    const sendb = btn('[>]', () => doSend(), 'sendb');
    const cbar = h('div', { class: 'cbar' }, rule(), statEl, strip, amenu, h('div', { class: 'crow' }, plus, inp, sendb));
    let voiceNames = data.voice || [];
    const IND = VOICE_SIGNS.bars;
    const MUTED = VOICE_MUTES.slash;
    const POS = 'over';
    const vbar = h('div', { class: 'vbar' }); // bottom left: the one button
    const vlist = h('div', { class: 'vlist ' + POS }); // top right: who is connected
    const voice = makeVoice(g, currentMode, () => { voiceBusy = voice.state !== 'off'; paintVoice(); }, !!VST.voice_auto);
    let vkey = '';
    const talkSeen = new Map(); // name -> { t, lv }: who talked just now, reported by the speakers themselves so people who are not connected see it too
    function paintVoice() {
      const kids = [];
      if (voice.state === 'connecting') kids.push(h('span', { class: 'dim' }, '...'));
      else if (voice.state === 'on') kids.push(btn('[ Disconnect ]', () => voice.end(), 'sm'));
      else kids.push(btn('[ Connect ]', () => voice.connect(), 'sm'));
      if (voice.needsTap()) kids.push(btn('[ Tap for sound ]', () => unlockAudio(), 'sm'));
      if (voice.error) kids.push(h('span', { class: 'err' }, voice.error));
      vbar.replaceChildren(...kids);
      const key = voiceNames.join('\n') + '|' + (voice.state === 'on' ? voice.me : '');
      if (key !== vkey) { // the rows are rebuilt only when the names change
        vkey = key;
        const mineName = (voice.roster.find((r) => r.id === voice.me) || {}).name;
        vlist.replaceChildren(...voiceNames.map((n) => {
          const own = voice.state === 'on' && n === mineName;
          return h('div', { class: 'vrow' + (own ? ' own' : ''), 'data-n': n, onclick: own ? () => voice.toggleMute() : null },
            h('span', { class: 'vlive' }, n), h('span', { class: 'sign' }));
        }));
      }
      paintTalk();
      if (typeof stick !== 'undefined' && stick) scroller.scrollTop = scroller.scrollHeight; // names or the button changed the height: stay at the bottom
    }
    function paintTalk() {
      const now = Date.now();
      const lvl = new Map();
      const muted = new Set();
      voice.roster.forEach((r) => { if (r.muted) muted.add(r.name); });
      talkSeen.forEach((o, name) => { if (now - o.t < 450) lvl.set(name, o.lv); });
      vlist.querySelectorAll('.vrow').forEach((row) => {
        const n = row.dataset.n;
        const isMuted = row.classList.contains('own') ? voice.muted : muted.has(n);
        row.classList.toggle('muted', isMuted);
        row.querySelector('.sign').textContent = isMuted ? MUTED : (lvl.has(n) ? IND.lv[lvl.get(n) - 1] : '');
      });
    }
    paintVoice();
    voice.listen();
    cbar.prepend(vbar); // the button sits just above the composer, never over a message
    if (POS === 'over') wrap.append(vlist);
    const root = h('div', { class: 'chat-root' }, head, menuBox, ...(POS === 'over' ? [] : [vlist]), wrap, cbar);
    const talkTick = setInterval(paintTalk, 150);

    // ---- small helpers
    const stat = (text, bad) => { statEl.textContent = text; statEl.className = 'cstat ' + (bad ? 'err' : 'dim'); };
    const visible = (m) => !ttl || m.ts + ttl > Date.now() / 1000;
    const isVideo = (m) => ((m.meta && m.meta.type) || '').startsWith('video/');
    const showPill = () => { pill.textContent = '[ v ' + unseen + ' new ]'; pill.style.display = unseen ? 'block' : 'none'; };
    function toBottom() { scroller.scrollTop = scroller.scrollHeight; stick = true; unseen = 0; showPill(); }
    function paintTitle() { sub.textContent = 'online ' + online + '  ' + (ttl ? TTL_LABEL[ttl] || ttl : 'last ' + (CFG.keep || 10)) + (isOpen ? '  public' : '  E2E'); }
    function paintWm() { // one tilted tile, repeated over the whole window whatever its size
      const text = (label() + '   ' + gl(g)).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='360' height='150'><text x='180' y='75' text-anchor='middle' transform='rotate(-24 180 75)' font-family='monospace' font-size='14' fill='#808080'>" + text + '</text></svg>';
      wmEl.style.backgroundImage = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")';
    }
    function paintMenu() {
      menuBox.replaceChildren(
        h('div', { class: 'row' }, notifyButton('group:' + gid, { 'X-Verifier': g.verifier })),
        you.pseudo ? h('div', { class: 'row' }, h('span', { class: 'dim' }, 'Posting as '), h('span', { class: 'acc' }, label()), ' ',
          btn(currentMode() === 'pseudo' ? '[ use ' + you.anon + ' ]' : '[ use ' + you.pseudo + ' ]', () => {
            useMode = currentMode() === 'pseudo' ? 'anon' : 'pseudo';
            ls.set('mode', useMode);
            paintWm();
            paintMenu();
          }, 'sm')) : '',
        h('div', { class: 'row' }, sure('[ Leave group ]', 'Leave on this device? You need the code to come back.', '[ Yes, leave ]',
          () => { const all = myGroups(); delete all[gid]; ls.set('groups', all); location.hash = '#/g'; })));
    }

    // ---- photos and videos
    // A phone on a weak connection gets slower, not faster, from asking for everything at once. Three downloads at a time,
    // newest first; anything you tap jumps the queue.
    const dlQueue = [];
    let dlRunning = 0;
    function dlNext() { while (dlRunning < 3 && dlQueue.length) dlQueue.shift().run(); }
    function limited(id, task, urgent) {
      return new Promise((resolve, reject) => {
        const entry = { id, run: () => { dlRunning++; task().then(resolve, reject).finally(() => { dlRunning--; dlNext(); }); } };
        if (urgent) dlQueue.unshift(entry); else dlQueue.push(entry);
        dlNext();
      });
    }
    function boost(id) { const i = dlQueue.findIndex((e) => e.id === id); if (i > 0) dlQueue.unshift(dlQueue.splice(i, 1)[0]); }
    const progressWatchers = new Map(); // media id -> callbacks that want to hear how far the download is
    function loadMedia(id, onProgress, urgent) { // decrypts once; everyone who asks gets the same result
      if (onProgress) { if (!progressWatchers.has(id)) progressWatchers.set(id, new Set()); progressWatchers.get(id).add(onProgress); }
      if (loadP.has(id)) { if (urgent) boost(id); return loadP.get(id); }
      const m0 = msgs.get(id);
      if (!m0) return Promise.resolve(null);
      m0.loading = true;
      m0.merr = '';
      m0.pct = 0;
      const p = (async () => {
        let url = null;
        let merr = '';
        let lastPaint = 0;
        try {
          const buf = await limited(id, () => fetchProgress('/api/media/' + m0.media, { 'X-Verifier': g.verifier }, (f) => {
            const cur = msgs.get(id);
            if (cur) cur.pct = Math.round(f * 100);
            (progressWatchers.get(id) || []).forEach((cb) => cb(f));
            if (Date.now() - lastPaint > 300) { lastPaint = Date.now(); paintLog(); }
          }), urgent);
          url = URL.createObjectURL(await openBlob(g, buf, m0.meta.iv, m0.meta.type));
        } catch (e) { merr = e.message; }
        progressWatchers.delete(id);
        const cur = msgs.get(id); // the entry may have been replaced while we were waiting
        if (!cur) { if (url) URL.revokeObjectURL(url); loadP.delete(id); return null; }
        cur.loading = false;
        cur.url = url;
        cur.merr = merr;
        if (!url) loadP.delete(id); // lets "retry" work
        paintLog();
        return url;
      })();
      loadP.set(id, p);
      return p;
    }
    function autoLoadPhotos() { // the newest eight photos, newest first
      [...msgs.values()].filter((m) => m.media && m.meta && !isVideo(m)).sort((x, y) => y.id - x.id).slice(0, 8)
        .filter((m) => !m.url && !loadP.has(m.id)).forEach((m) => loadMedia(m.id));
    }
    function autoLoad() { autoLoadPhotos(); prefetchVideos(); }
    function prefetchVideos() { // the newest small videos load by themselves, so a tap on play is instant
      [...msgs.values()].filter((m) => m.media && m.meta && isVideo(m) && (m.msize || 0) <= 25 * 1048576)
        .sort((x, y) => y.id - x.id).slice(0, 3) // the three newest, whatever is already loaded
        .filter((m) => !m.url && !loadP.has(m.id)).forEach((m) => loadMedia(m.id));
    }
    function chatItems() {
      return [...msgs.values()].filter((m) => m.media && m.meta && visible(m)).sort((a, b) => a.id - b.id)
        .map((m) => ({ id: m.id, kind: isVideo(m) ? 'video' : 'image', src: m.url || null, load: (cb) => loadMedia(m.id, cb, true) }));
    }
    function openFor(m) {
      const items = chatItems();
      openViewer(items, Math.max(0, items.findIndex((x) => x.id === m.id)));
    }
    function mediaBlock(m) {
      if (isVideo(m)) {
        return h('div', {},
          btn(m.loading ? '[ loading ' + (m.pct || 0) + '% ]' : m.url ? '[ > play video ]' : '[ > video ' + fmtSize(m.msize || 0) + ' ]', (e) => { e.stopPropagation(); openFor(m); }, 'sm blue'),
          m.merr ? h('span', { class: 'err' }, ' ' + m.merr) : null);
      }
      const ar = m.meta && m.meta.w && m.meta.h ? m.meta.w / m.meta.h : 0; // known size: space is reserved before the photo arrives
      if (m.url) {
        const im = mediaEl('image', m.url);
        if (ar) im.style.aspectRatio = String(ar);
        im.classList.add('tap');
        im.addEventListener('load', () => { if (stick) scroller.scrollTop = scroller.scrollHeight; });
        im.addEventListener('click', (e) => { e.stopPropagation(); openFor(m); });
        return im;
      }
      if (m.merr) return h('div', {}, h('span', { class: 'err' }, m.merr + ' '), btn('[ retry ]', (e) => { e.stopPropagation(); m.merr = ''; loadMedia(m.id); }, 'sm'));
      const lazy = (el) => { el.dataset.mid = String(m.id); if (!m.loading) io.observe(el); return el; };
      if (ar) { // the photo's place, with its colours already in it
        const ph = h('div', { class: 'phold' });
        ph.style.setProperty('--ar', String(ar));
        if (SAFE_PREVIEW.test(m.meta.p || '')) { const pin = h('div', { class: 'phin' }); pin.style.backgroundImage = 'url("' + m.meta.p + '")'; ph.append(pin); }
        return lazy(ph);
      }
      return lazy(h('div', { class: 'dim' }, '[ loading photo... ]'));
    }

    // ---- the message list
    async function likeMsg(id, kind) {
      try {
        const r = await api('POST', '/groups/' + gid + '/messages/' + id + '/like', kind ? { r: kind } : undefined, Object.assign({ 'X-Verifier': g.verifier }, await tokHdr('g|' + gid + '|' + id)));
        const cur = msgs.get(id);
        if (cur) { cur.likes = r.likes; cur.liked = r.liked; cur.broken = r.broken; cur.bliked = r.bliked; paintLog(); }
      } catch (e) { /* ignore */ }
    }
    let tapId = null;
    let tapTimer = null;
    let taps = 0;
    let replyTo = null; // {s, t}: the message you are answering
    let pressTimer = null;
    let pressed = false;
    function quoteOf(m) { return { s: m.sender, t: m.text ? m.text.slice(0, 80) : (m.media ? '[ media ]' : '') }; }
    function startReply(m) {
      if (m.text === null) return;
      replyTo = quoteOf(m);
      paintStrip();
      inp.focus();
    }
    function pressStart(m) {
      pressed = false;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => { pressed = true; clearTimeout(tapTimer); taps = 0; tapId = null; if (navigator.vibrate) navigator.vibrate(15); startReply(m); }, 450);
    }
    function pressEnd() { clearTimeout(pressTimer); }
    function onBubbleTap(m) { // two quick taps: <3, three: a broken heart. one tap on your own message: [ edit ]
      clearTimeout(tapTimer);
      taps = tapId === m.id ? taps + 1 : 1;
      tapId = m.id;
      tapTimer = setTimeout(() => {
        const n = taps;
        taps = 0; tapId = null;
        if (n === 2) likeMsg(m.id);
        else if (n >= 3) likeMsg(m.id, 'b');
        else if (m.mine && m.text !== null) { openAct = openAct === m.id ? null : m.id; paintLog(); }
      }, 300);
    }
    function editBox(m) {
      const ed = growing(h('textarea', { class: 'chatbox', rows: '1', maxlength: '1500' }));
      ed.value = editing.text;
      ed.addEventListener('input', () => { editing.text = ed.value; });
      ed.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !COARSE) { e.preventDefault(); saveEdit(m); } else if (e.key === 'Escape') { editing = null; paintLog(); }
      });
      editEl = ed;
      const dropBtn = m.media ? btn(editing.dropMedia ? '[ Keep media ]' : '[ Remove media ]', () => { editing.dropMedia = !editing.dropMedia; paintLog(); }, 'sm') : null;
      return h('div', {}, ed, dropBtn, editing.dropMedia ? h('div', { class: 'err' }, 'Media will be removed') : null, btn('[ Save ]', () => saveEdit(m), 'sm'), btn('[ Cancel ]', () => { editing = null; paintLog(); }, 'sm'));
    }
    async function saveEdit(m) {
      const text = editing.text.trim();
      const drop = !!editing.dropMedia && !!m.media;
      if (text === (m.text || '') && !drop) { editing = null; paintLog(); return; } // nothing changed, so no "edited" label
      if (!text && (!m.media || drop)) { stat('! Write something', true); return; }
      stat('');
      try {
        const s = await seal(g, text, Object.assign({}, m.meta && !drop ? { m: m.meta } : {}, m.quote ? { q: m.quote } : {}), m);
        await api('POST', '/groups/' + gid + '/messages/' + m.id + '/edit', { ct: s.ct, iv: s.iv, remove_media: drop }, Object.assign({ 'X-Verifier': g.verifier }, await ownHdr(m.cid)));
        editing = null;
        const cur = msgs.get(m.id);
        if (cur) { cur.text = text; cur.edited = Math.floor(Date.now() / 1000); if (drop) { cur.media = null; cur.meta = null; cur.msize = null; } }
        paintLog();
      } catch (e) { stat('! ' + e.message, true); }
    }
    const DIE_MS = 350;
    const GLYPHS = '#%&@*+/=01';
    // a deleted message first scrambles letter by letter (swapped, then encrypted-looking), then fades out
    function scrambleAway(m) {
      const src = m.text || '';
      const chars = Array.from(src);
      const t0 = Date.now();
      const iv = setInterval(() => {
        const p = Math.min(1, (Date.now() - t0) / DIE_MS);
        const out = chars.map((c, i) => {
          if (c === ' ') return c;
          const r = Math.random();
          if (r < p * 0.9) return ' '; // more and more letters drop out, so the symbols thin out
          if (r < p * 0.9 + 0.35) return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
          return chars[Math.min(chars.length - 1, Math.max(0, i + (Math.random() < 0.5 ? -1 : 1)))];
        });
        const txt = m.el && m.el.querySelector('.txt');
        if (txt) txt.textContent = out.join('');
        if (p >= 1) clearInterval(iv);
      }, 30);
    }
    function bubble(m, side) {
      const isEd = editing && editing.id === m.id;
      const body = [];
      if (isEd) {
        body.push(editBox(m));
      } else {
        if (m.quote) body.push(h('div', { class: 'quote' }, h('b', {}, m.quote.s), m.quote.t));
        if (m.media && m.meta) body.push(mediaBlock(m));
        if (m.text) body.push(h('span', { class: 'txt' + (isDisco(m.text) ? ' disco' : '') }, noDollar(m.text)));
        else if (m.text === null) body.push(h('span', { class: 'dim' }, '[could not decrypt]'));
        if (m.edited) body.push(h('span', { class: 'edited' }, ' (edited)'));
        if (m.likes) body.push(h('div', { class: 'react' + (m.liked ? ' on' : ''), onclick: m.liked ? (e) => { e.stopPropagation(); likeMsg(m.id); } : null }, '<3 ' + m.likes));
        if (m.broken) body.push(h('div', { class: 'react' + (m.bliked ? ' on' : ''), onclick: m.bliked ? (e) => { e.stopPropagation(); likeMsg(m.id, 'b'); } : null }, '</3 ' + m.broken));
        if (openAct === m.id) {
          body.push(h('div', { class: 'acts', onclick: (e) => e.stopPropagation() },
            m.mine && m.text !== null ? btn('[ edit ]', () => { editing = { id: m.id, text: m.text, fresh: true }; openAct = null; paintLog(); }, 'sm') : null,
            m.mine ? sure('[ delete ]', 'Delete?', '[ Yes ]', async () => { openAct = null; try { await api('DELETE', '/groups/' + gid + '/messages/' + m.id, undefined, Object.assign({ 'X-Verifier': g.verifier }, await ownHdr(m.cid))); } catch (e) { stat('! ' + e.message, true); } }) : null));
        }
      }
      const el = h('div', { class: 'm ' + side + (doomedIds.has(m.id) || m.dying ? ' danger' : '') + (m.dying ? ' dying' : ''), onclick: isEd ? null : () => { if (pressed) { pressed = false; return; } onBubbleTap(m); }, onpointerdown: isEd ? null : () => pressStart(m), onpointerup: pressEnd, onpointerleave: pressEnd, onpointercancel: pressEnd, onpointermove: (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) pressEnd(); }, oncontextmenu: (e) => e.preventDefault() }, body);
      if (m.dying) m.el = el;
      return el;
    }
    function paintLog(forceBottom) {
      const wasStick = stick;
      const st = scroller.scrollTop;
      const hadFocus = editEl && document.activeElement === editEl;
      editEl = null;
      const list = [...msgs.values()].filter(visible).sort((a, b) => a.id - b.id);
      const keep = CFG.keep || 10;
      doomedIds = new Set(list.slice(0, Math.max(0, Math.min(3, list.length - (keep - 3)))).map((m) => m.id)); // danger zone grows with the chat: shown in red
      const sameRun = (a, b) => a.sender === b.sender && a.kind === b.kind && Math.abs(b.ts - a.ts) <= 300
        && new Date(a.ts * 1000).toDateString() === new Date(b.ts * 1000).toDateString();
      const nodes = [];
      list.forEach((m, i) => {
        const prev = list[i - 1];
        const next = list[i + 1];
        const side = m.mine ? 'me' : 'them';
        if (!m.mine && (!prev || !sameRun(prev, m))) nodes.push(h('div', { class: 'nm' + (m.kind === 'p' ? ' p' : '') + (voiceNames.includes(m.sender) ? ' live' : '') }, m.sender));
        nodes.push(bubble(m, side));
        if (!next || !sameRun(m, next)) nodes.push(h('div', { class: 'tm ' + side }, clock(m.ts)));
      });
      if (!nodes.length) nodes.push(h('div', { class: 'quiet dim' }, 'Quiet in here. Say something.'));
      scroller.replaceChildren(...nodes);
      if (wasStick || forceBottom) scroller.scrollTop = scroller.scrollHeight; else scroller.scrollTop = st;
      if (editEl && (hadFocus || (editing && editing.fresh))) {
        editEl.focus();
        editEl.setSelectionRange(editEl.value.length, editEl.value.length);
        if (editing) editing.fresh = false;
      }
    }
    async function ingest(m) {
      let pl = await unseal(g, m);
      for (const o of msgs.values()) if (o.id < m.id && o.cid === m.cid) pl = null; // the same message again: a replay, not shown
      const old = msgs.get(m.id);
      const ctx = 'g|' + gid + '|' + m.id;
      const mineNow = await isMine(m.cid, m.own);
      const likedNow = await didAct(ctx, m.lk);
      const brokenNow = await didAct(ctx, m.bk);
      msgs.set(m.id, Object.assign({}, old || {}, m, {
        text: pl ? pl.t : null,
        meta: pl ? pl.m || null : null,
        quote: pl && pl.q && typeof pl.q.t === 'string' ? { s: String(pl.q.s || ''), t: pl.q.t } : null,
        mine: mineNow || !!(old && old.mine) || mineIds.has(m.id),
        liked: m.lk ? likedNow : !!(old && old.liked),
        bliked: m.bk ? brokenNow : !!(old && old.bliked),
      }));
      const cur = msgs.get(m.id);
    }

    // ---- sending: several photos at once go as separate messages, like in a chat app
    function addFiles(list) {
      list.forEach((f) => queue.push({ file: f, url: (f.type || '').startsWith('image/') ? URL.createObjectURL(f) : null }));
      paintStrip();
    }
    function dropQueued(item) {
      const i = queue.indexOf(item);
      if (i >= 0) queue.splice(i, 1);
      if (item.url) URL.revokeObjectURL(item.url);
      paintStrip();
    }
    function paintStrip() {
      strip.replaceChildren(...(replyTo ? [h('div', { class: 'chip quote' }, h('b', {}, 'Replying to ' + replyTo.s), replyTo.t, btn('[x]', () => { replyTo = null; paintStrip(); }, 'sm'))] : []), ...queue.map((q) => h('div', { class: 'chip' },
        q.url ? h('img', { src: q.url, alt: '' }) : h('span', { class: 'dim' }, '[ video ' + fmtSize(q.file.size) + ' ]'),
        btn('[x]', () => dropQueued(q), 'sm'))));
      const ready = queue.length > 0 || !!inp.value.trim();
      sendb.classList.toggle('on', ready);
      sendb.disabled = !ready;
    }
    async function sendOne(text, file, tag) {
      let media = null;
      let extra;
      if (file) {
        stat(tag + 'processing...');
        const pm = await prepMedia(file);
        const dims = pm.type.startsWith('image/') ? await imageInfo(pm.blob) : {};
        const sb = await sealBlob(g, pm.blob);
        media = (await uploadMedia('group', sb.data, { gid, verifier: g.verifier }, (p) => stat(tag + 'encrypted, uploading ' + Math.round(p * 100) + '%'))).id;
        extra = { m: Object.assign({ type: pm.type, iv: sb.iv }, dims) };
      }
      if (replyTo) { extra = Object.assign({}, extra, { q: replyTo }); replyTo = null; paintStrip(); }
      const cid = newCid();
      const kind = currentMode() === 'pseudo' ? 'p' : 'a';
      const sender = kind === 'p' ? you.pseudo : you.anon;
      const s = await seal(g, text, extra, { kind, sender, cid });
      const sent = await api('POST', '/groups/' + gid + '/messages', { ct: s.ct, iv: s.iv, mode: currentMode(), media, cid, as: sender }, Object.assign({ 'X-Verifier': g.verifier }, await ownHdr(cid)));
      mineIds.add(sent.id);
      if (sent.m) await ingest(sent.m);
      autoLoad();
      const fresh = msgs.get(sent.id);
      if (fresh) fresh.mine = true;
      paintLog(true);
    }
    async function doSend() {
      if (sending) return;
      const text = inp.value.trim();
      const files = queue.slice();
      if (!text && !files.length) return;
      sending = true;
      stat('');
      try {
        const caption = files.length === 1 ? text : ''; // one photo + text = a photo with a caption
        for (let i = 0; i < files.length; i++) {
          await sendOne(caption, files[i].file, files.length > 1 ? (i + 1) + '/' + files.length + ' ' : '');
          dropQueued(files[i]);
        }
        if (text && !caption) await sendOne(text, null, '');
        inp.value = '';
        grow(inp);
        stat('');
      } catch (e) { stat('! ' + e.message, true); }
      sending = false;
      paintStrip();
      inp.focus();
    }
    async function reload() {
      const d = await api('GET', '/groups/' + gid + '/messages', undefined, { 'X-Verifier': g.verifier });
      you = d.you;
      const ids = new Set(d.messages.map((m) => m.id));
      for (const id of [...msgs.keys()]) if (!ids.has(id)) msgs.delete(id);
      for (const m of d.messages) await ingest(m);
      paintLog();
      autoLoad();
    }

    // ---- go
    for (const m of data.messages) await ingest(m);
    // Photos carry their size and a stand-in, so the chat can show at once. Only older photos (no stored size)
    // get a moment (at most a second), so they do not pop in and push the rest around.
    autoLoadPhotos();
    const newest = [...msgs.values()].filter((m) => m.media && m.meta && !isVideo(m)).sort((x, y) => y.id - x.id).slice(0, 6);
    if (newest.some((m) => !(m.meta.w && m.meta.h))) {
      const wanted = newest.map((m) => loadP.get(m.id)).filter(Boolean);
      if (wanted.length) await Promise.race([Promise.all(wanted), new Promise((r) => setTimeout(r, 1000))]);
    }
    if (seq !== routeSeq) return;
    appEl.replaceChildren(root);
    document.body.classList.add('chatmode', 'guard');
    const vv = window.visualViewport;
    function fit() { // keeps the composer above the phone keyboard
      appEl.style.height = (vv ? vv.height : window.innerHeight) + 'px';
      document.body.classList.toggle('kb', !!vv && vv.height < window.innerHeight * 0.85); // keyboard up: no home-bar gap under the composer
      appEl.style.transform = vv && vv.offsetTop > 0 ? 'translateY(' + vv.offsetTop + 'px)' : '';
      if (stick) scroller.scrollTop = scroller.scrollHeight;
    }
    if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
    window.addEventListener('resize', fit);
    fit();
    scroller.addEventListener('scroll', () => {
      stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
      if (stick && unseen) { unseen = 0; showPill(); }
    });
    inp.addEventListener('input', paintStrip);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !COARSE) { e.preventDefault(); doSend(); } });
    paintTitle(); paintWm(); paintStrip(); paintLog(true);
    autoLoad();
    let userScrolled = false; // until the reader scrolls, keep pinning to the bottom while photos and layout settle
    scroller.addEventListener('touchstart', () => { userScrolled = true; }, { passive: true });
    scroller.addEventListener('wheel', () => { userScrolled = true; }, { passive: true });
    const pin = () => { if (!userScrolled) toBottom(); };
    requestAnimationFrame(pin);
    [100, 350, 800, 1500].forEach((ms) => setTimeout(pin, ms));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(pin);
    wmEl.classList.add('on');

    const off = stream('group:' + gid, async (ev) => {
      if (ev.type === 'hello') { try { await reload(); } catch (e) { /* retry on next event */ } return; }
      if (ev.type === 'msg' || ev.type === 'edit') {
        const fromOthers = ev.type === 'msg' && !ev.m.mine && !mineIds.has(ev.m.id) && !msgs.has(ev.m.id);
        await ingest(ev.m);
        if (fromOthers && !stick) { unseen++; showPill(); }
        paintLog();
        autoLoad();
      } else if (ev.type === 'like') { const m = msgs.get(ev.id); if (m) { m.likes = ev.n; if (ev.b !== undefined) m.broken = ev.b; paintLog(); } }
      else if (ev.type === 'prune') { // the oldest goes: you see it fade away, then the next ones turn red
        ev.ids.forEach((i) => { const m = msgs.get(i); if (m) { m.dying = true; m.dieAt = Date.now(); } });
        paintLog();
        ev.ids.forEach((i) => { const m = msgs.get(i); if (m) scrambleAway(m); });
        setTimeout(() => { ev.ids.forEach((i) => msgs.delete(i)); paintLog(); }, DIE_MS + 100);
      }
      else if (ev.type === 'online') { online = ev.n; paintTitle(); }
      else if (ev.type === 'talk') { talkSeen.set(ev.name, { t: Date.now(), lv: ev.lv }); }
      else if (ev.type === 'voice') { voiceNames = ev.list || []; paintVoice(); paintLog(); }
      else if (ev.type === 'gone') { location.hash = '#/g'; }
    }, { 'X-Verifier': g.verifier });

    const tick = setInterval(() => paintLog(), 30000);
    const hide = () => document.body.classList.add('blur');
    const unhide = () => document.body.classList.remove('blur');
    const vis = () => (document.hidden ? hide() : unhide());
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('blur', hide);
    window.addEventListener('focus', unhide);
    teardown.push(off, () => clearInterval(tick), () => clearInterval(talkTick), () => { voice.close(); voiceBusy = false; }, () => clearTimeout(tapTimer), () => {
      msgs.forEach((m) => { if (m.url) URL.revokeObjectURL(m.url); });
      queue.forEach((q) => { if (q.url) URL.revokeObjectURL(q.url); });
      io.disconnect();
      dlQueue.length = 0;
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('blur', hide);
      window.removeEventListener('focus', unhide);
      if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
      window.removeEventListener('resize', fit);
      appEl.style.height = '';
      appEl.style.transform = '';
      wmEl.classList.remove('on');
      wmEl.style.backgroundImage = '';
      wmEl.replaceChildren();
      document.body.classList.remove('guard', 'blur', 'chatmode');
    });
  }

  // ----- me
  // ----- themes
  // Offered themes. Also defined in style.css but not offered: cream, cool, monow, monob, midnight, plum, classic.
  const THEMES = [['graphite', 'Graphite'], ['paper', 'Paper']];
  const currentTheme = () => document.documentElement.getAttribute('data-theme') || 'graphite';
  function applyTheme(id) {
    document.documentElement.setAttribute('data-theme', id);
    ls.set('theme', id);
    const m = document.querySelector('meta[name=theme-color]');
    if (m && window.__themes && window.__themes[id]) m.setAttribute('content', window.__themes[id]);
  }

  // three quick taps on the logo of the home page: the secret page
  let logoTaps = 0;
  let logoTimer = null;
  function logoTap(e) {
    if ((location.hash || '#/') !== '#/') return;
    e.preventDefault();
    clearTimeout(logoTimer);
    if (++logoTaps >= 3) { logoTaps = 0; location.hash = '#/$'; return; }
    logoTimer = setTimeout(() => { logoTaps = 0; }, 600);
  }

  async function viewSecret() {
    const seq = routeSeq;
    const cur = h('div', {});
    const err = errBox();
    const ta = growing(h('textarea', { maxlength: '500', placeholder: 'Title' }));
    const att = attachWidget();
    async function load() {
      let d;
      try { d = await api('GET', '/secret'); } catch (e) { return; }
      if (seq !== routeSeq) return;
      cur.replaceChildren(...[
        d.text ? h('div', { class: 'pre' + (isDisco(d.text) ? ' disco' : ''), style: 'margin-bottom:8px' }, noDollar(d.text)) : null,
        d.media ? boardMedia(d.media, d.mime) : null,
      ].filter(Boolean));
    }
    const go = btn('[ Save ]', async () => {
      err.show('');
      go.disabled = true;
      try {
        let media = null;
        const f = att.file();
        if (f) {
          err.textContent = 'processing media...';
          const pm = await prepMedia(f);
          media = (await uploadMedia('board', pm.blob, undefined, (pr) => { err.textContent = 'uploading ' + Math.round(pr * 100) + '%'; })).id;
          err.textContent = '';
        }
        await api('POST', '/secret', { text: ta.value, media });
        form.style.display = 'none'; open.style.display = '';
        ta.value = ''; grow(ta); att.clear();
        await load();
      } catch (e) { err.show(e.message); }
      upd();
    });
    const upd = () => { go.disabled = !(ta.value.trim() || att.file()); };
    ta.addEventListener('input', upd);
    att.el.addEventListener('change', () => setTimeout(upd));
    att.el.addEventListener('click', () => setTimeout(upd));
    upd();
    const form = h('div', { style: 'display:none' }, fld(ta), att.el, h('div', {}, go), err);
    const open = btn('[ Replace ]', () => { form.style.display = 'block'; open.style.display = 'none'; ta.focus(); });
    setView(cur, gap(), open, form);
    load();
  }

  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });

  // edge swipes for back / forward, instant (an installed app has no browser gesture of its own)
  (function edgeSwipe() {
    let sx = 0, sy = 0, side = 0;
    document.addEventListener('touchstart', (e) => {
      side = 0;
      if (e.touches.length !== 1 || document.querySelector('.cam-video')) return;
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      if (sx < 24) side = -1; else if (sx > window.innerWidth - 24) side = 1;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (!side) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dy) < 60 && dx * side * -1 > 60) { if (side < 0) history.back(); else history.forward(); }
      side = 0;
    }, { passive: true });
  })();

  // The principles, in a few words.
  function viewManifesto() {
    const rows = ['End-to-end encrypted.', 'No accounts.', 'No logs.', 'No back-ups.', 'Everything expires.'];
    setView(h('div', { class: 'acc' }, 'MANIFESTO'), rule(),
      ...rows.map((t, i) => h('div', { class: 'mrow' }, (i + 1) + '. ' + t)),
      gap(), h('div', { class: 'mrow' }, 'Defend your right to free and secure internet communications.'),
      gap(), link('[ Back ]', '#/'));
  }

  // Everything that changed, per version. The list is the file public/changes.json, kept by hand.
  async function viewChanges() {
    const seq = routeSeq;
    let d;
    try { d = await (await fetch('/changes.json', { cache: 'no-store' })).json(); } catch (e) { setView(h('div', { class: 'err' }, '! Could not load the list')); return; }
    if (seq !== routeSeq) return;
    const out = [];
    if (CFG.notice) out.push(h('div', { class: 'notice-title' }, '! ' + CFG.notice), ...(CFG.notice_more || []).map((p) => h('div', { class: 'mrow' }, p)), gap()); // the test-server warning: opens with the version label
    out.push(h('div', { class: 'acc' }, 'CHANGES'), rule());
    (d.versions || []).forEach((v) => {
      out.push(h('div', { class: 'acc' }, 'v' + v.v + '  ' + v.date));
      v.notes.forEach((t) => out.push(h('div', { class: 'mrow' }, '- ' + t)));
      out.push(gap());
    });
    if (/^https?:\/\//.test(CFG.source || '')) out.push(h('div', { class: 'dim' }, 'Source code (AGPL): ', h('a', { href: CFG.source, rel: 'noopener noreferrer' }, CFG.source)), gap());
    out.push(link('[ Back ]', '#/'));
    setView(...out);
  }

  function viewInstall() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const android = /android/i.test(navigator.userAgent);
    const link0 = location.origin + '/#/install';
    const steps = standalone ? ['Already installed. Nice.']
      : ios ? ['1. Open this page in Safari', '2. Tap the share icon [ ^ ]', '3. Tap Add to Home Screen', '4. Tap Add. Done!']
        : android ? ['1. Tap [ Install app ] below', '   or menu > Install app', '2. Done: ' + (CFG.app || 'bunker') + ' is on your phone']
          : ['Scan the code with your phone camera,', 'or send yourself the link below.'];
    const shareBtn = btn('[ Share this link ]', async () => {
      try { if (navigator.share) await navigator.share({ title: 'BUNKER', text: 'Put BUNKER on your phone', url: link0 }); else { await navigator.clipboard.writeText(link0); shareBtn.textContent = '[ Link copied ]'; } } catch (e) { /* cancelled */ }
    });
    setView(
      h('div', { class: 'acc' }, 'GET THE APP'), rule(),
      h('div', { class: 'pre' }, '+ full screen, like a real app\n+ one tap, no address bar\n+ notifications\n+ your name and chats stay put'),
      gap(), h('div', { class: 'acc' }, standalone ? 'INSTALLED' : 'HOW'), rule(),
      h('div', { class: 'pre' }, steps.join('\n')), gap(),
      standalone || ios ? null : btn('[ Install app ]', () => { if (installEvt) { installEvt.prompt(); installEvt = null; } }),
      standalone || COARSE ? null : h('img', { class: 'qr', src: '/qr.svg', alt: 'QR code', width: '198', height: '198', onerror: (e) => e.target.remove() }),
      h('div', {}, shareBtn), gap(), link('[ Open BUNKER ]', '#/'));
  }

  function viewMe() {
    const themeBox = h('div', {});
    function paintThemes() {
      themeBox.replaceChildren(...THEMES.map(([id, label]) => h('button', {
        type: 'button', class: 'theme-opt',
        onclick: () => { applyTheme(id); paintThemes(); },
      }, (currentTheme() === id ? '(*) ' : '( ) ') + label)));
    }
    paintThemes();
    const box = h('div', {});
    const perr = errBox();
    function paint() {
      box.replaceChildren();
      if (state.pseudo) {
        box.append(h('div', {}, 'Your pseudonym: ', h('span', { class: 'name acc' }, state.pseudo)),
          sure('[ Release name ]', 'Are you sure? Anyone can claim ' + state.pseudo + ' after this.', '[ Yes, release ]',
            async () => { try { await api('DELETE', '/name'); state.pseudo = null; state.hasCode = false; ls.set('mode', 'anon'); paint(); } catch (e) { perr.show(e.message); } }));
        const cin = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', placeholder: '6 digits', autocomplete: 'off' });
        const saveCode = btn(state.hasCode ? '[ Change code ]' : '[ Save code ]', async () => {
          perr.show('');
          if (state.hasCode && !confirm('This replaces your current code. Continue?')) return;
          try {
            const r = await api('POST', '/name/code', { code: cin.value.trim() });
            state.hasCode = true;
            paint();
          } catch (e) { perr.show(e.message); }
        });
        gate(saveCode, [cin]);
        box.append(gap(), h('div', { class: 'dim pre' }, state.hasCode
          ? 'Login code is set.'
          : 'Choose a 6-digit code to log in with this name on another phone.'),
        fld(cin),
        saveCode,
        ...(state.hasCode ? [btn('[ Turn off ]', async () => { try { await api('DELETE', '/name/code'); state.hasCode = false; paint(); } catch (e) { perr.show(e.message); } }) ] : []));
      } else {
        const nm = h('input', { type: 'text', maxlength: '20', placeholder: 'Pick a unique pseudonym', autocomplete: 'off', autocapitalize: 'none' });
        const claim = btn('[ Claim name ]', async () => { perr.show(''); try { const r = await api('POST', '/name', { name: nm.value }); state.pseudo = r.pseudo; state.hasCode = false; paint(); } catch (e) { perr.show(e.message); } });
        gate(claim, [nm]);
        box.append(fld(nm), claim);
        const ln = h('input', { type: 'text', maxlength: '20', placeholder: 'Your pseudonym', autocomplete: 'off', autocapitalize: 'none' });
        const lc = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', placeholder: '6-digit code', autocomplete: 'off' });
        const login = btn('[ Log in ]', async () => {
            perr.show('');
            try { const r = await api('POST', '/login', { name: ln.value, code: lc.value }); state.pseudo = r.pseudo; state.hasCode = true; ls.set('mode', 'pseudo'); paint(); } catch (e) { perr.show(e.message); }
        });
        gate(login, [ln, lc]);
        box.append(gap(), h('div', { class: 'acc' }, 'LOG IN'), rule(), fld(ln), fld(lc), login);
      }
      box.append(perr);
    }
    paint();


    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const installBox = h('div', {});
    if (!standalone) {
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
      const steps = h('div', { class: 'dim pre' });
      installBox.append(btn('[ Install app ]', async () => {
        if (installEvt) { installEvt.prompt(); installEvt = null; return; }
        steps.textContent = ios ? '1. Tap the share icon in Safari\n2. Add to Home Screen' : 'Browser menu > Install app / Add to Home screen';
      }), steps, gap());
    }
    setView(
      box, gap(),
      h('div', { class: 'acc' }, 'THEME'), rule(), themeBox, gap(),
      standalone ? null : h('div', { class: 'acc' }, 'APP'), standalone ? null : rule(), installBox);
  }

  // Not linked anywhere: the moderator opens #/admin by hand.
  function viewAdmin() {
    const adm = h('input', { type: 'password', placeholder: 'Admin token', autocomplete: 'off' });
    const err = errBox();
    async function unlock() {
      err.show('');
      ADM = adm.value;
      adm.value = '';
      try { CFG = await api('GET', '/config'); } catch (e) { ADM = ''; err.show(e.message); return; }
      if (!CFG.admin) { ADM = ''; err.show('That token is not accepted'); return; }
      viewAdmin();
    }
    function lock() { ADM = ''; CFG.admin = false; viewAdmin(); }
    if (!CFG.admin) {
      setView(h('div', { class: 'acc' }, 'ADMIN'), rule(), fld(adm), btn('[ Unlock ]', unlock), err);
      return;
    }
    const ago = (ts) => { const s = Math.max(0, Date.now() / 1000 - ts); return s < 3600 ? Math.round(s / 60) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd'; };
    // a block that loads when you open it, and reloads itself after every action
    function section(title, load) {
      const body = h('div', { style: 'display:none' });
      const toggle = btn('[ show ]', async () => {
        const open = body.style.display === 'none';
        body.style.display = open ? 'block' : 'none';
        toggle.textContent = open ? '[ hide ]' : '[ show ]';
        if (open) await refresh();
      }, 'sm');
      async function refresh() {
        try { body.replaceChildren(...(await load(refresh)).filter(Boolean)); } catch (e) { body.replaceChildren(h('div', { class: 'err' }, '! ' + e.message)); }
      }
      return h('div', {}, h('div', {}, h('span', { class: 'acc' }, title), ' ', toggle), rule(), body, gap());
    }
    const act = (refresh, fn) => async () => { try { await fn(); } catch (e) { alert(e.message); } refresh(); };

    const storage = section('STORAGE', async () => {
      const d = await api('GET', '/admin/stats');
      const rows = [
        'database ' + fmtSize(d.db_bytes) + ', media ' + fmtSize(d.media_bytes) + ' (' + d.media + ' files)',
        d.groups + ' chats, ' + d.messages + ' messages, ' + d.names + ' pseudonyms, ' + d.push + ' notification subscriptions',
        d.reports + ' reported posts, ' + d.online + ' people connected on voice',
        ...Object.entries(d.boards).map(([b, v]) => '/' + b + '/  ' + v.threads + ' threads, ' + v.posts + ' posts'),
      ];
      return rows.map((t) => h('div', { class: 'dim' }, t));
    });
    const reports = section('REPORTS', async (refresh) => {
      const d = await api('GET', '/reports');
      if (!d.reports.length) return [h('div', { class: 'dim' }, 'None.')];
      return d.reports.map((r) => h('div', { class: 'thread-row' },
        h('div', {}, 'No.' + r.post_id + ' /' + r.board + '/  reported ' + r.n + 'x'), h('div', { class: 'dim pre' }, r.body),
        h('div', {}, link('[ open ]', '#/t/' + r.thread_id),
          sure('[ delete ]', 'Delete this post?', '[ Yes ]', act(refresh, () => api('DELETE', '/posts/' + r.post_id))),
          btn('[ dismiss ]', act(refresh, () => api('POST', '/admin/reports/' + r.post_id + '/dismiss')), 'sm'))));
    });
    const boards = section('BOARDS', async (refresh) => {
      const out = [];
      for (const b of CFG.boards) {
        const d = await api('GET', '/admin/threads?board=' + b.id);
        out.push(h('div', { class: 'acc' }, '/' + b.id + '/'));
        if (!d.threads.length) out.push(h('div', { class: 'dim' }, 'Empty.'));
        d.threads.forEach((t) => out.push(h('div', { class: 'thread-row' },
          h('div', {}, 'No.' + t.id + ' ' + (t.subject ? noDollar(t.subject) + ' ' : ''), h('span', { class: 'dim' }, t.replies + ' replies, ' + ago(t.bump) + ' ago')),
          h('div', { class: 'dim pre' }, t.body),
          h('div', {}, link('[ open ]', '#/t/' + t.id), sure('[ delete ]', 'Delete the whole thread?', '[ Yes ]', act(refresh, () => api('DELETE', '/posts/' + t.id)))))));
        out.push(gap());
      }
      return out;
    });
    const groups = section('CHATS', async (refresh) => {
      const d = await api('GET', '/admin/groups');
      if (!d.groups.length) return [h('div', { class: 'dim' }, 'None.')];
      return d.groups.map((g) => h('div', { class: 'thread-row' },
        h('div', {}, gl(g) + ' ', h('span', { class: 'dim' }, (g.closed ? 'closed' : 'open') + ', ' + g.msgs + ' messages, last ' + ago(g.last_act) + ' ago, ' + g.online + ' online')),
        h('div', {}, sure('[ clear messages ]', 'Delete all messages?', '[ Yes ]', act(refresh, () => api('POST', '/admin/groups/' + g.id + '/clear'))),
          sure('[ delete chat ]', 'Delete the whole chat?', '[ Yes ]', act(refresh, () => api('DELETE', '/groups/' + g.id))))));
    });
    const names = section('PSEUDONYMS', async (refresh) => {
      const d = await api('GET', '/admin/names');
      if (!d.names.length) return [h('div', { class: 'dim' }, 'None.')];
      return d.names.map((n) => h('div', { class: 'row' }, h('span', { class: 'name' }, n.name), ' ', h('span', { class: 'dim' }, ago(n.ts) + ' ago '),
        sure('[ release ]', 'Release ' + n.name + '?', '[ Yes ]', act(refresh, () => api('DELETE', '/admin/names/' + encodeURIComponent(n.name))))));
    });
    const secretSec = section('SECRET PAGE', async (refresh) => [sure('[ clear it ]', 'Empty the secret page?', '[ Yes ]', act(refresh, () => api('POST', '/admin/secret/clear')))]);
    const settingsSec = section('SETTINGS', async (refresh) => {
      const d = await api('GET', '/admin/settings');
      const label = {
        voice_auto: ['Voice', { 1: 'Everyone hears whoever is connected', 0: 'Hear others only after Connect (Discord style)' }],
        group_keep: ['Messages a chat remembers', {}],
        board_threads: ['Threads a board remembers (older ones are deleted)', {}],
        idle_days: ['Delete a chat nobody used for', { 7: '7 days', 30: '30 days', 90: '90 days', 0: 'never' }],
      };
      const rows = Object.keys(label).map((k) => {
        const cur = String(typeof d.settings[k] === 'boolean' ? (d.settings[k] ? 1 : 0) : d.settings[k]);
        return h('div', {}, h('div', { class: 'dim' }, label[k][0]),
          ...d.options[k].map((v) => h('button', { type: 'button', class: 'theme-opt', onclick: act(refresh, () => api('POST', '/admin/settings', { key: k, value: v })) },
            (cur === v ? '(*) ' : '( ) ') + (label[k][1][v] !== undefined ? label[k][1][v] : v))), gap());
      });
      return rows;
    });
    const danger = section('DANGER', async () => {
      const word = h('input', { type: 'text', placeholder: 'Type WIPE to unlock', autocomplete: 'off', autocapitalize: 'none' });
      const buttons = [['messages', 'Delete all chat messages'], ['boards', 'Delete all board threads'], ['media', 'Delete all photos and videos'],
        ['names', 'Release all pseudonyms'], ['push', 'Delete notification subscriptions'], ['all', 'Delete EVERYTHING (chats too)']].map(([what, text]) => {
        const b = btn('[ ' + text + ' ]', async () => {
          try { await api('POST', '/admin/purge', { what, confirm: word.value }); word.value = ''; alert('Done'); } catch (e) { alert(e.message); }
          upd();
        });
        return h('div', {}, b);
      });
      const upd = () => buttons.forEach((d) => { d.firstChild.disabled = word.value !== 'WIPE'; });
      word.addEventListener('input', upd);
      upd();
      return [h('div', { class: 'err' }, 'These cannot be undone.'), fld(word), ...buttons];
    });

    setView(h('div', { class: 'acc' }, 'ADMIN'), rule(),
      h('div', { class: 'dim' }, 'Unlocked until you close or reload this page.'), btn('[ Lock ]', lock), gap(),
      storage, reports, boards, groups, names, secretSec, settingsSec, danger);
  }

  // ------------------------------------------------------------ router
  async function route() {
    routeSeq++;
    if (feedOff) startFeed(); // the list of chats may have changed
    if (viewerCloser) viewerCloser();
    if (cameraCloser) cameraCloser();
    teardown.forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
    teardown = [];
    const hash = location.hash || '#/';
    const parts = hash.slice(2).split('/');
    try {
      if (!parts[0]) viewHome();
      else if (parts[0] === 'b' && !parts[1]) viewBoards();
      else if (parts[0] === 'b') await viewBoard(parts[1]);
      else if (parts[0] === 't' && /^\d+$/.test(parts[1] || '')) await viewThread(parts[1]);
      else if (parts[0] === 'g' && !parts[1]) viewGroups();
      else if (parts[0] === 'g') await viewChat(parts[1]);
      else if (parts[0] === 'me') viewMe();
      else if (parts[0] === 'install') viewInstall();
      else if (parts[0] === 'manifesto') viewManifesto();
      else if (parts[0] === 'changes') await viewChanges();
      else if (parts[0] === '$') viewSecret();
      else if (parts[0] === 'admin') viewAdmin();
      else viewHome();
    } catch (e) {
      setView(h('div', { class: 'err' }, '! ' + e.message));
    }
  }

  async function boot() {
    try { await initDevice(); } catch (e) { appEl.textContent = e.message; return; }
    try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('portrait').catch(() => {}); } catch (e) { /* only some installed apps may lock */ }
    try { CFG = await api('GET', '/config'); } catch (e) { appEl.textContent = 'Cannot reach the server.'; return; }
    document.title = CFG.app;
    BUILD = CFG.build;
    try { const me = await api('GET', '/me'); state.pseudo = me.pseudo; state.hasCode = me.has_code; } catch (e) { /* ignore */ }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', (ev) => { if (ev.data && ev.data.url) location.hash = ev.data.url; });
    document.addEventListener('touchstart', () => {}, { passive: true }); // iOS only shows :active (the line while pressing) if something listens for touches
    // A phone can keep an old page alive for days. When the app comes back and a newer version is live, refresh (never while typing or filming).
    const checkUpdate = async () => {
      try {
        const d = await (await fetch('/api/config', { cache: 'no-store' })).json();
        const typing = [...document.querySelectorAll('textarea, input[type=text], input[type=password]')].some((el) => el.value);
        if (BUILD && d.build && d.build !== BUILD && !cameraCloser && !voiceBusy && !typing) location.reload();
      } catch (e) { /* offline: try again later */ }
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });
    window.addEventListener('pageshow', checkUpdate);
    setInterval(() => { if (!document.hidden) checkUpdate(); }, 300000);
    window.addEventListener('hashchange', route);
    refreshActivity();
    startFeed();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshActivity(); });
    setInterval(() => { if (!document.hidden) refreshActivity(); }, 60000); // safety net: the live feed does the real work
    const keepInView = () => {
      if (document.body.classList.contains('chatmode')) return;
      const a = document.activeElement;
      if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) setTimeout(() => a.scrollIntoView({ block: 'center' }), 50);
    };
    document.addEventListener('focusin', () => setTimeout(keepInView, 300)); // after the keyboard has slid up
    if (window.visualViewport) visualViewport.addEventListener('resize', keepInView);
    route();
    setTimeout(warmGroupKeys, 800);
  }
  boot();
})();
