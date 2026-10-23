// easystream-webui — est:// client: WebCodecs video (zoom/pan), pointer +
// touch input, and a floating virtual keyboard. est-only (no a11y queries).

const T = { HELLO: 0x01, VIDEO: 0x02, AUTH_OK: 0x04, AUDIO: 0x05,
  CONFIG_SET: 0x08, CONFIG_ACK: 0x09,
  MOVE: 0x10, BUTTON: 0x11, SCROLL: 0x12, KEY: 0x13, TEXT: 0x14,
  AUDIO_REQ: 0x06, AUDIO_OFF: 0x07, CLIP_GET: 0x30, CLIP_DATA: 0x31, CLIP_SET: 0x32 };

// Quality presets. The wire protocol carries explicit numbers, never a preset
// name (see EST.md): these are expanded locally by qualityBody() so that every
// platform's daemon receives the same request for the same label.
//   longest side 1280 / 1920 / unchanged, 30 fps, 3 / 8 / 20 Mbps.
const QUALITY = [
  { id: 0, label: '标清', side: 1280, fps: 30, bitrate: 3_000_000 },
  { id: 1, label: '高清', side: 1920, fps: 30, bitrate: 8_000_000 },
  { id: 2, label: '原画', side: 0,    fps: 30, bitrate: 20_000_000 },
];

const $ = (id) => document.getElementById(id);
const cv = $('screen');
const ctx = cv.getContext('2d');
const kbd = $('kbd');
const panel = $('panel');
// avc1.42E033 = H.264 Baseline, Level 5.1 — the level must cover 1080p (the
// macOS encoder emits Level 4.0 = 0x28; a Level-3.1 string made the browser
// reject 1920x1080 with EncodingError). Level 5.1 is a safe superset.
const S = { ws: null, dec: null, codec: 'avc1.42E033', w: 0, h: 0, gotKey: false,
  frames: 0, fps: 0, t0: performance.now(), userScale: 1, panX: 0, panY: 0, viewOnly: false, adec: null, actx: null, again: null, wantControl: !!accessToken(), wantAudio: true, openKbdAfterControl: false, muted: false, anext: 0, aDecoded: 0,
  // video configuration, from Hello's video block (offsets 15+). capW/capH is
  // the size the capture source produces; w/h is what the encoder is emitting.
  enc: 0, vflags: 0, vbitrate: 0, capW: 0, capH: 0, quality: -1, wantQuality: -1 };

// token comes from the URL (?token=… or #token=…): a viewer link can carry it.
function accessToken() {
  const q = new URLSearchParams(location.search);
  let t = q.get('token');
  if (!t && location.hash.startsWith('#token=')) t = decodeURIComponent(location.hash.slice(7));
  return t || '';
}
// panDrag = an active view pan (a normal drag, a middle-button drag, or 2+ fingers).
let panDrag = null;

// offscreen holds the latest frame at native size so zoom/pan repaint instantly.
const off = document.createElement('canvas');
const offCtx = off.getContext('2d');

// ── est framing ─────────────────────────────────────────────────────────────
function frame(type, body) {
  const b = body || new Uint8Array(0);
  const out = new Uint8Array(6 + b.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(2, b.length, false);
  out.set(b, 6);
  return out;
}
// In view-only mode the browser must not even SEND a mutation frame (the
// daemon drops them anyway, but not sending avoids pointless traffic).
const MUTATION = new Set([0x10, 0x11, 0x12, 0x13, 0x14, 0x26, 0x32]);
function send(bytes) {
  if (S.viewOnly && bytes.length && MUTATION.has(bytes[0])) return;
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(bytes);
}
// Coalesce pointer moves to ONE per animation frame. Without this, every
// pointermove during a press floods the guest with MOVE events, so a plain
// click becomes "down + many drags + up" — which macOS treats as a long press.
let _pendingMove = null, _moveRaf = 0;
function flushMove() {
  if (_moveRaf) { cancelAnimationFrame(_moveRaf); _moveRaf = 0; }
  const m = _pendingMove; _pendingMove = null;
  if (!m) return;
  const b = new Uint8Array(4); const d = new DataView(b.buffer);
  d.setUint16(0, m[0], false); d.setUint16(2, m[1], false); send(frame(T.MOVE, b));
}
function sendMove(x, y) {
  _pendingMove = [x, y];
  if (_moveRaf) return;
  _moveRaf = requestAnimationFrame(() => {
    _moveRaf = 0;
    const m = _pendingMove; _pendingMove = null;
    if (!m) return;
    const b = new Uint8Array(4); const d = new DataView(b.buffer);
    d.setUint16(0, m[0], false); d.setUint16(2, m[1], false); send(frame(T.MOVE, b));
  });
}
// The button event must follow the pointer position it applies to, so flush any
// queued MOVE first (otherwise a click lands at the previous location).
function sendButton(btn, down) { flushMove(); send(frame(T.BUTTON, new Uint8Array([btn, down ? 1 : 0]))); }
// Key: nameLen, name, u32 char, u8 down (matches the daemons; EST.md omits char)
function sendKey(name, ch, down) {
  const nb = new TextEncoder().encode(name || '');
  const b = new Uint8Array(1 + nb.length + 4 + 1);
  b[0] = nb.length; b.set(nb, 1);
  new DataView(b.buffer).setUint32(1 + nb.length, ch >>> 0, true);
  b[1 + nb.length + 4] = down ? 1 : 0;
  send(frame(T.KEY, b));
}
function sendText(s) { send(frame(T.TEXT, new TextEncoder().encode(s))); }

// ── quality ─────────────────────────────────────────────────────────────────
// qualityBody expands a preset into an explicit ConfigSet. The protocol never
// carries a preset name, so every platform receives identical numbers.
//
// Geometry is sent as the TARGET encoder size, not a scale factor: the daemon
// does not know the client's idea of "longest side", and sending the resolved
// width/height keeps the two ends in agreement about what 高清 means.
function qualityBody(preset) {
  const q = QUALITY[preset];
  if (!q) return null;
  let w = 0, h = 0;
  if (q.side && S.capW && S.capH) {
    const long = Math.max(S.capW, S.capH);
    const k = Math.min(1, q.side / long);           // never upscale
    // H.264 4:2:0 needs even dimensions.
    w = Math.max(2, Math.round(S.capW * k / 2) * 2);
    h = Math.max(2, Math.round(S.capH * k / 2) * 2);
  }
  // Layout per EST.md 0x08, 14 bytes in this order:
  //   [0]    hasWidth      [1..2]  u16 width
  //   [3]    hasHeight     [4..5]  u16 height
  //   [6]    hasFps        [7]     u8  fps
  //   [8]    hasBitrate    [9..12] u32 bitrate
  //   [13]   hasEncoder
  // An earlier version sized this at 12 bytes and wrote the u32 at offset 9,
  // which runs to byte 12 - one past the end - and threw "Offset is outside the
  // bounds of the DataView" the moment a preset was clicked.
  const b = new Uint8Array(14);
  b[0] = w ? 1 : 0; if (w) { b[1] = w >> 8; b[2] = w & 255; }
  b[3] = h ? 1 : 0; if (h) { b[4] = h >> 8; b[5] = h & 255; }
  b[6] = 1; b[7] = q.fps;
  b[8] = 1;
  new DataView(b.buffer).setUint32(9, q.bitrate, false);
  b[13] = 0;   // hasEncoder = 0: let the daemon keep its choice
  return b;
}

function setQuality(preset) {
  if (S.viewOnly) { setState('err', 'view only'); return; }
  if (!S.hasVideoCfg || !(S.vflags & 1)) return;   // daemon cannot reconfigure
  const body = qualityBody(preset);
  if (!body) return;
  S.wantQuality = preset;
  send(frame(T.CONFIG_SET, body));
}

// syncQualityUI reflects what the daemon last told us, not what we asked for:
// a refused ConfigSet must not leave the UI claiming the new preset.
function syncQualityUI() {
  const row = $('qualityRow');
  if (!row) return;
  const can = S.hasVideoCfg && (S.vflags & 1) && !S.viewOnly;
  row.hidden = !S.hasVideoCfg;
  const er = $('encRow'); if (er) er.hidden = !S.hasVideoCfg;
  for (const b of row.querySelectorAll('button')) {
    b.disabled = !can;
    b.classList.toggle('on', Number(b.dataset.q) === S.quality);
  }
  const enc = $('encName');
  if (enc) enc.textContent = encoderName(S.enc) + (S.vbitrate ? ' · ' + Math.round(S.vbitrate / 1e6) + ' Mbps' : '');
}

// Wire the preset buttons once: they only ASK the daemon, they never assume the
// change took effect (syncQualityUI reflects the daemon's next Hello).
for (const b of document.querySelectorAll('#qualityRow button')) {
  b.addEventListener('click', () => setQuality(Number(b.dataset.q)));
}

function encoderName(e) {
  return ({ 1: 'x264', 2: 'VAAPI', 3: 'MediaFoundation', 4: 'VideoToolbox', 5: 'MediaCodec' })[e] || '—';
}

// ── clipboard ───────────────────────────────────────────────────────────────
// The browser clipboard is the LOCAL one (navigator.clipboard); the guest's is
// the remote one. We bridge them on demand and on Ctrl+C / Ctrl+V.
let clipId = 1;
// est spec: 0x30 ClipGet = u32 id ; 0x32 ClipSet = u32 id, u32 len, text.
function clipSetRemote(text) {
  const t = new TextEncoder().encode(text);
  const b = new Uint8Array(4 + 4 + t.length);
  const d = new DataView(b.buffer);
  d.setUint32(0, clipId++, false);
  d.setUint32(4, t.length, false);
  b.set(t, 8);
  send(frame(T.CLIP_SET, b));
}
function clipGetRemote() {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, clipId++, false);
  send(frame(T.CLIP_GET, b));
}
async function localClipRead() {
  try { return await navigator.clipboard.readText(); } catch { return ''; }
}
async function localClipWrite(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { return false; }
}
// Push+Paste: put the LOCAL clipboard on the guest AND press Ctrl+V there, so
// it lands in whatever field the guest has focused (one tap on a phone).
async function pushAndPaste() {
  const t = await localClipRead();
  if (!t) { toast('Local clipboard is empty'); return; }
  lastSynced = t;
  clipSetRemote(t);
  setTimeout(() => {
    sendKey('Control', 0, true);
    sendKey('v', 'v'.codePointAt(0), true);
    sendKey('v', 'v'.codePointAt(0), false);
    sendKey('Control', 0, false);
  }, 120);
  toast('Sent to guest and pasted');
}
// Copy+Pull: press Ctrl+C in the guest (copy its selection), then pull the
// guest clipboard into the LOCAL one.
function copyAndPull() {
  sendKey('Control', 0, true);
  sendKey('c', 'c'.codePointAt(0), true);
  sendKey('c', 'c'.codePointAt(0), false);
  sendKey('Control', 0, false);
  setTimeout(() => clipRemoteToLocal(), 250);   // let the guest set its clipboard
  toast('Copied in guest, pulling to local');
}
// Copy: LOCAL selection -> guest clipboard.
async function clipLocalToRemote() {
  const t = await localClipRead();
  if (t) { lastSynced = t; clipSetRemote(t); }
}
// Paste: guest clipboard -> LOCAL clipboard.
function clipRemoteToLocal() { clipGetRemote(); }

// ── bidirectional clipboard sync (opt-in) ───────────────────────────────────
// The browser has no clipboard-change event (verified: 'clipboardchange' is not
// supported), so we POLL. `lastSynced` remembers the last value we propagated
// in EITHER direction, so a value travels exactly once and cannot bounce
// back and forth.
let syncOn = false;
let syncTimer = null;
let lastSynced = '';
const SYNC_MS = 1500;

function setSync(on) {
  syncOn = on;
  if ($('syncToggle')) { $('syncToggle').textContent = on ? 'On' : 'Off'; $('syncToggle').classList.toggle('on', on); }
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  if (on) {
    toast('Clipboard sync ON — it overwrites the clipboard on both sides');
    syncTick();
    syncTimer = setInterval(syncTick, SYNC_MS);
  }
}
async function syncTick() {
  if (!syncOn || S.ws?.readyState !== WebSocket.OPEN) return;
  // 1) LOCAL -> guest. readText() needs a focused, visible document.
  if (!document.hidden && document.hasFocus()) {
    const t = await localClipRead();
    if (t && t !== lastSynced) { lastSynced = t; clipSetRemote(t); return; }
  }
  // 2) guest -> LOCAL (the answer arrives as ClipData).
  clipGetRemote();
}
// Called when a ClipData frame arrives (from either a manual pull or the sync).
function onClipData(text) {
  if (syncOn) {
    if (text && text !== lastSynced) { lastSynced = text; localClipWrite(text); }
  } else {
    localClipWrite(text);
  }
}
// Re-sync the moment the page regains focus (the clipboard may have changed
// while we were away, which the poll could not see).
addEventListener('focus', () => { if (syncOn) syncTick(); });
document.addEventListener('visibilitychange', () => { if (syncOn && !document.hidden) syncTick(); });


// ── inbound ─────────────────────────────────────────────────────────────────
let rx = new Uint8Array(0);
function onBytes(chunk) {
  if (rx.length) { const m = new Uint8Array(rx.length + chunk.length); m.set(rx); m.set(chunk, rx.length); rx = m; }
  else rx = chunk;
  for (;;) {
    if (rx.length < 6) return;
    const type = rx[0];
    const len = new DataView(rx.buffer, rx.byteOffset).getUint32(2, false);
    if (rx.length < 6 + len) return;
    const body = rx.slice(6, 6 + len);
    rx = rx.slice(6 + len);
    if (type === T.AUDIO) {
      if (S.adec && S.adec.state === 'configured') {
        try { S.adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: performance.now() * 1000, data: body })); } catch {}
      }
    } else if (type === T.CLIP_DATA) {
      // u32 id, u32 len, text[len]
      const len = new DataView(body.buffer, body.byteOffset).getUint32(4, false);
      const txt = new TextDecoder().decode(body.slice(8, 8 + len));
      onClipData(txt);
    } else if (type === T.CONFIG_ACK) {
      // ok=0 means the daemon refused (unsupported encoder, geometry its capture
      // source cannot produce, ...). Drop the pending choice so the UI keeps
      // showing the preset that is actually running.
      if (body[0] === 1) {
        S.quality = S.wantQuality;
      } else {
        const msg = body.length > 2 ? new TextDecoder().decode(body.slice(2, 2 + body[1])) : 'refused';
        S.wantQuality = S.quality;
        setState('err', 'quality: ' + msg);
      }
      syncQualityUI();
    } else if (type === 0x04) { // AuthOk: body[0] = 0 view / 1 control / 0xFF fail
      if (body[0] === 0xFF) { setState('err', 'auth failed'); return; }
      applyMode(body[0] === 0);
    } else if (type === T.HELLO) {
      if (body[1] === 1) S.codec = 'avc1.42E033';
      const prevW = S.w, prevH = S.h, prevEnc = S.enc, prevBitrate = S.vbitrate;
      S.w = (body[2] << 8) | body[3]; S.h = (body[4] << 8) | body[5];
      off.width = S.w || 1; off.height = S.h || 1;
      // Video block, appended at offset 15 by servers that support run-time
      // quality changes. Absent means the daemon is older than this client: the
      // geometry above is then the whole truth and the quality row stays hidden.
      if (body.length >= 23 && body[15] === 1) {
        S.enc = body[16];
        S.vflags = body[17];
        S.vbitrate = ((body[18] << 24) | (body[19] << 16) | (body[20] << 8) | body[21]) >>> 0;
        S.hasVideoCfg = true;
        // bit2: offsets 2..6 are the INPUT size (device pixels), not the decoded
        // size. Android needs this - its input path takes device pixels, and a
        // downscaled stream would otherwise put every tap in the wrong place.
        if (S.vflags & 4) {
          // The encoded size follows at offset 23.
          if (body.length >= 27) {
            S.inW = S.w; S.inH = S.h;
            S.w = (body[23] << 8) | body[24];
            S.h = (body[25] << 8) | body[26];
          }
        }
        // The daemon reports the size it is ENCODING; without a separate capture
        // size we treat that as the native one, which keeps 原画 honest.
        if (!S.capW) { S.capW = S.w; S.capH = S.h; }
        syncQualityUI();
      }
      // A reconfigure (we asked, or the daemon changed something) arrives as a
      // second Hello. VideoDecoder.configure() is bound to a geometry, and a
      // decoder left on the old size throws on the new frames, so it is rebuilt
      // here. gotKey goes back to false because the daemon forces an IDR for us:
      // decoding must not resume until that keyframe arrives.
      if (prevW && (prevW !== S.w || prevH !== S.h)) {
        if (S.dec) { try { S.dec.close(); } catch {} S.dec = null; }
        S.gotKey = false;
        startDecoder();
      }
      // Audio block (v1 extension): present@7, codec@8, rate@9..13, ch@13, ms@14.
      if (body.length >= 15 && body[7] === 1 && S.wantAudio) {
        S.aRate = ((body[9] << 24) | (body[10] << 16) | (body[11] << 8) | body[12]) >>> 0;
        S.aCh = body[13]; S.aMs = body[14];
        startAudio();
      }
      startDecoder(); resize();
    } else if (type === T.VIDEO) {
      decodeVideo(body);
    }
  }
}

// ── video ───────────────────────────────────────────────────────────────────
function startDecoder() {
  if (S.dec) return;
  if (typeof VideoDecoder === 'undefined') { setState('err', 'no WebCodecs (need HTTPS)'); return; }
  S.dec = new VideoDecoder({
    output: (f) => {
      if (off.width !== f.displayWidth || off.height !== f.displayHeight) {
        off.width = f.displayWidth; off.height = f.displayHeight;
        S.w = f.displayWidth; S.h = f.displayHeight; resize();
      }
      offCtx.drawImage(f, 0, 0); f.close(); paint();
      S.frames++;
      const now = performance.now();
      if (now - S.t0 >= 1000) {
        S.fps = S.frames; S.frames = 0; S.t0 = now;
        $('stats').textContent = `${S.w}×${S.h} · ${S.fps} fps`;
      }
    },
    error: (e) => setState('err', String(e)),
  });
  S.dec.configure({ codec: S.codec, optimizeForLatency: true });
  setState('live');
}
// startAudio brings up an AudioDecoder (Opus) + an AudioContext. WebCodecs
// audio needs a secure context just like video.
function startAudio() {
  if (S.adec) return;
  if (typeof AudioDecoder === 'undefined') return; // no WebCodecs audio; silent
  try {
    S.actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: S.aRate || 48000 });
  } catch { return; }
  S.adec = new AudioDecoder({
    output: (frame) => playAudioFrame(frame),
    error: () => {},
  });
  S.adec.configure({ codec: 'opus', sampleRate: S.aRate || 48000, numberOfChannels: S.aCh || 2 });
}
// playAudioFrame schedules one decoded PCM buffer on the AudioContext. We keep a
// small play cursor so frames play back-to-back without gaps or overlap.
function playAudioFrame(frame) {
  if (!S.actx) return;
  const ch = frame.numberOfChannels, n = frame.numberOfFrames;
  const buf = S.actx.createBuffer(ch, n, frame.sampleRate);
  for (let c = 0; c < ch; c++) {
    const dst = buf.getChannelData(c);
    frame.copyTo(dst, { planeIndex: c, format: 'f32-planar' });
  }
  frame.close();
  const src = S.actx.createBufferSource();
  src.buffer = buf; if (!S.gain) { S.gain = S.actx.createGain(); S.gain.connect(S.actx.destination); } src.connect(S.gain);
  const now = S.actx.currentTime;
  const at = Math.max(now + 0.02, S.anext || 0);
  src.start(at);
  S.anext = at + buf.duration;
}
function hasIDR(b) {
  let i = 0;
  while (i + 3 < b.length) {
    if (b[i] === 0 && b[i + 1] === 0 && (b[i + 2] === 1 || (b[i + 2] === 0 && b[i + 3] === 1))) {
      const o = b[i + 2] === 1 ? i + 3 : i + 4;
      if (o < b.length && (b[o] & 0x1f) === 5) return true;
      i = o; continue;
    }
    i++;
  }
  return false;
}
function decodeVideo(b) {
  if (!S.dec || S.dec.state !== 'configured') return;
  const key = hasIDR(b);
  if (!key && !S.gotKey) return;
  if (key) S.gotKey = true;
  // A STRICTLY increasing timestamp is required: frames can arrive several per
  // millisecond, so performance.now()*1000 is not guaranteed monotonic and
  // WebCodecs then rejects the chunk with "Decoding error".
  S.ts = (S.ts || 0) + 1000;
  try { S.dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta',
    timestamp: S.ts, data: b })); } catch {}
}

// ── view: fit × userScale + pan, letterboxed ────────────────────────────────
function vp() { return { vw: cv.clientWidth || innerWidth, vh: cv.clientHeight || innerHeight }; }
function drawRect() {
  const { vw, vh } = vp();
  const sw = S.w || off.width || 1, sh = S.h || off.height || 1;
  const fit = Math.min(vw / sw, vh / sh);
  const scale = fit * S.userScale;
  const w = sw * scale, h = sh * scale;
  return { left: (vw - w) / 2 + S.panX, top: (vh - h) / 2 + S.panY, width: w, height: h, fit };
}
function clampPan() {
  const { vw, vh } = vp(); const r = drawRect();
  // The view may be positioned ANYWHERE inside the viewport:
  //   * image LARGER than the viewport  -> scroll to any edge (see the overflow)
  //   * image SMALLER than the viewport -> still movable, so it can be pushed
  //     flush to the top/bottom/left/right instead of being locked centred.
  const maxX = Math.abs(vw - r.width) / 2, maxY = Math.abs(vh - r.height) / 2;
  S.panX = Math.max(-maxX, Math.min(maxX, S.panX));
  S.panY = Math.max(-maxY, Math.min(maxY, S.panY));
}
function resize() {
  const { vw, vh } = vp();
  if (cv.width !== vw || cv.height !== vh) { cv.width = vw; cv.height = vh; }
  clampPan(); paint();
}
function paint() {
  if (!off.width) return;
  const { vw, vh } = vp();
  if (cv.width !== vw || cv.height !== vh) { cv.width = vw; cv.height = vh; }
  // The letterbox area is GREY, so the screen's bounds are obvious against a
  // black guest desktop (noVNC does the same). The screen itself gets a thin
  // border and a drop shadow to read as a distinct surface.
  ctx.fillStyle = '#4a4a4a'; ctx.fillRect(0, 0, vw, vh);
  const r = drawRect();
  ctx.imageSmoothingEnabled = true;
  ctx.save();
  ctx.shadowColor = '#000000aa'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 2;
  ctx.fillStyle = '#000';
  ctx.fillRect(r.left, r.top, r.width, r.height);
  ctx.restore();
  ctx.drawImage(off, r.left, r.top, r.width, r.height);
  ctx.strokeStyle = '#00000088'; ctx.lineWidth = 1;
  ctx.strokeRect(r.left + 0.5, r.top + 0.5, r.width - 1, r.height - 1);
  $('zoomLabel').textContent = Math.round(S.userScale * 100) + '%';
}
function zoomTo(scale, cx, cy) {
  const { vw, vh } = vp();
  const px = cx ?? vw / 2, py = cy ?? vh / 2;
  const before = drawRect();
  const sx = (px - before.left) / before.width, sy = (py - before.top) / before.height;
  S.userScale = Math.max(0.25, Math.min(8, scale));
  const after = drawRect();
  S.panX += px - (after.left + sx * after.width);
  S.panY += py - (after.top + sy * after.height);
  clampPan(); paint();
}

// setView anchors the view so the normalized SOURCE point (u,v) — 0..1 within
// the guest screen — lands exactly on pixel (px,py). This is what makes pinch
// and drag follow the finger instead of re-centring the screen.
function setView(scale, u, v, px, py) {
  const { vw, vh } = vp();
  const sw = S.w || off.width || 1, sh = S.h || off.height || 1;
  const fit = Math.min(vw / sw, vh / sh);
  S.userScale = Math.max(0.25, Math.min(8, scale));
  const w = sw * fit * S.userScale, h = sh * fit * S.userScale;
  S.panX = px - (vw - w) / 2 - u * w;
  S.panY = py - (vh - h) / 2 - v * h;
  clampPan(); paint();
}
// srcUV maps a client point to the normalized source point under it.
function srcUV(clientX, clientY) {
  const el = cv.getBoundingClientRect();
  const r = drawRect();
  return [ (clientX - el.left - r.left) / r.width, (clientY - el.top - r.top) / r.height ];
}
function zoomBy(f, cx, cy) { zoomTo(S.userScale * f, cx, cy); }
function fitView() { S.userScale = 1; S.panX = 0; S.panY = 0; clampPan(); paint(); }
$('zIn').onclick = () => zoomBy(1.25);
$('zOut').onclick = () => zoomBy(0.8);
$('zFit').onclick = fitView;

// ── input ───────────────────────────────────────────────────────────────────
// toSource maps a view coordinate onto the INPUT coordinate space.
//
// That is S.w/S.h (offsets 2-6) on every platform whose backend takes stream
// coordinates. Android sets flags bit2 because its input path takes DEVICE
// pixels: there the decoded size and the input size differ, and the rounding
// has to happen in the input space or every tap lands at the wrong point.
function toSource(clientX, clientY) {
  const el = cv.getBoundingClientRect();
  const r = drawRect();
  const iw = S.inW || S.w || 1, ih = S.inH || S.h || 1;
  const x = Math.round(((clientX - el.left - r.left) / r.width) * iw);
  const y = Math.round(((clientY - el.top - r.top) / r.height) * ih);
  return [Math.max(0, Math.min(iw, x)), Math.max(0, Math.min(ih, y))];
}
const cur = document.createElement('div');
cur.style.cssText = 'position:fixed;z-index:5;pointer-events:none;width:16px;height:16px;display:none';
cur.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="#fff" stroke="#000" d="M1 1l6 14 2-6 6-2z"/></svg>';
document.body.appendChild(cur);
function showCursor(x, y) { cur.style.display = ''; cur.style.left = (x - 2) + 'px'; cur.style.top = (y - 2) + 'px'; }

const pts = new Map();
let gest = null;   // multi-finger gesture (2 or 3 fingers): scale + pan
let touch = null;  // single-finger mouse emulation

function pDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function pMid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
// Centroid of ALL active touch points (2 or 3 fingers). Using the centroid (not
// just the midpoint of the first two) makes a 3-finger drag pan naturally and
// keeps the anchor stable as fingers are added/removed.
function pCentroid() {
  let x = 0, y = 0, n = 0;
  for (const p of pts.values()) { x += p.x; y += p.y; n++; }
  return n ? { x: x / n, y: y / n } : { x: 0, y: 0 };
}
// Mean distance from the centroid — a rotation-invariant "spread" for scale.
function pSpread(c) {
  let d = 0, n = 0;
  for (const p of pts.values()) { d += Math.hypot(p.x - c.x, p.y - c.y); n++; }
  return n ? d / n : 1;
}
// beginGest snapshots the view so moves can be expressed relative to it. The
// anchor (u,v) is the source point under the centroid at gesture start: it must
// stay under the (moving) centroid, which is what "follow the finger" means.
function beginGest() {
  if (pts.size < 2) { gest = null; return; }
  const c = pCentroid();
  const [u, v] = srcUV(c.x, c.y);
  gest = { spread0: Math.max(1, pSpread(c)), scale0: S.userScale, u, v };
  if (touch) { if (touch.down) sendButton(1, false); touch = null; }
}

// ── pointer: DEFAULT DRAG GOES TO THE GUEST ─────────────────────────────────
// A press that never moves is a CLICK; once it moves it becomes a DRAG INSIDE
// THE GUEST, and Shift makes it pan the view instead. Nothing is sent to the
// guest on pointerdown, so a press can still be decided after the fact.
//
// It used to be the other way round (drag = pan), which made every attempt to
// move a window or select text inside the guest slide the whole picture. Dragging
// in the guest is the common case; moving the viewport is not.
//   mouse : drag = drag in guest ; Shift+drag = pan view ; click = click
//           middle-drag = pan view ; right click = right click in guest
//   touch : 1-finger drag = drag in guest ; tap = click ; long-press = right click
//   2/3 fingers : pinch zoom + pan (unchanged)
let press = null;   // { x, y, t0, pointerId, type, shift, guest }

cv.addEventListener('pointerdown', (e) => {
  try { cv.setPointerCapture(e.pointerId); } catch {}
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  cv.focus({ preventScroll: true });

  if (e.pointerType === 'mouse') {
    if (e.button === 1) {              // middle button: always pan
      panDrag = { x: e.clientX, y: e.clientY, panX: S.panX, panY: S.panY };
      cv.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (e.button === 2) {              // right button: click in the guest
      const [x, y] = toSource(e.clientX, e.clientY);
      sendMove(x, y); sendButton(3, true); sendButton(3, false);
      return;
    }
    press = { x: e.clientX, y: e.clientY, t0: Date.now(), pointerId: e.pointerId,
              type: 'mouse', shift: e.shiftKey, guest: false };
    return;
  }

  // touch: ONE finger drives the GUEST (tap = click, drag = swipe/scroll in the
  // guest). Only TWO or more fingers move the VIEW (pinch zoom + pan).
  if (pts.size === 1) {
    const [x, y] = toSource(e.clientX, e.clientY);
    sendMove(x, y);
    touch = { startX: e.clientX, startY: e.clientY, moved: false, down: false, t0: Date.now() };
  } else {
    // a 2nd finger arrives: cancel the single-finger guest touch, start a view
    // gesture instead.
    if (touch) { if (touch.down) sendButton(1, false); touch = null; }
    press = null;
    beginGest();
  }
});

cv.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId)) {         // hover (no button): keep the guest cursor
    if (e.pointerType === 'mouse') { showCursor(e.clientX, e.clientY);
      const [x, y] = toSource(e.clientX, e.clientY); sendMove(x, y); }
    return;
  }
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

  if (panDrag) {                       // an active view pan
    S.panX = panDrag.panX + (e.clientX - panDrag.x);
    S.panY = panDrag.panY + (e.clientY - panDrag.y);
    clampPan(); paint();
    return;
  }

  if (pts.size >= 2) {                 // 2+ fingers: zoom + pan
    if (!gest) beginGest();
    const c = pCentroid();
    const spread = Math.max(1, pSpread(c));
    const scale = gest.scale0 * (spread / gest.spread0);
    setView(scale, gest.u, gest.v, c.x, c.y);
    return;
  }

  // Single FINGER: drive the guest (drag = swipe/scroll), never the view.
  if (e.pointerType !== 'mouse' && touch) {
    const dx = e.clientX - touch.startX, dy = e.clientY - touch.startY;
    if (!touch.moved && Math.hypot(dx, dy) > 6) { touch.moved = true; sendButton(1, true); touch.down = true; }
    if (touch.moved) { const [x, y] = toSource(e.clientX, e.clientY); sendMove(x, y); }
    return;
  }

  // A pending single MOUSE press: decide what it becomes once it moves.
  if (press && press.pointerId === e.pointerId) {
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    const th = e.pointerType === 'mouse' ? 4 : 8;
    if (!press.guest && Math.hypot(dx, dy) > th) {
      // DEFAULT IS DRAG IN THE GUEST. Dragging inside the desktop is what people
      // mean by "drag" (move a window, select text, drag a slider); panning the
      // view is the occasional action, so it moves behind a modifier. The
      // previous mapping had this backwards and every attempt to drag something
      // in the guest slid the whole picture instead.
      //
      // Shift+drag (and middle-button drag, handled on pointerdown) pans the view.
      if (press.shift) {               // Shift: pan the VIEW
        panDrag = { x: e.clientX, y: e.clientY, panX: S.panX, panY: S.panY };
        cv.style.cursor = 'grabbing';
        press = null;
        return;
      } else {                         // otherwise: drag INSIDE the guest
        const [sx, sy] = toSource(press.x, press.y);
        sendMove(sx, sy); sendButton(1, true);
        press.guest = true;
      }
    }
    if (press && press.guest) {
      const [x, y] = toSource(e.clientX, e.clientY); sendMove(x, y);
    } else if (e.pointerType === 'mouse' && !press) {
      showCursor(e.clientX, e.clientY);
    }
    return;
  }

  if (e.pointerType === 'mouse') { showCursor(e.clientX, e.clientY); }
});

function endPointer(e) {
  if (panDrag) { panDrag = null; cv.style.cursor = ''; }
  if (!pts.has(e.pointerId)) return;
  pts.delete(e.pointerId);

  // Single FINGER finished: tap = click, long-press = right click, drag already
  // sent button-down/moves above.
  if (touch && e.pointerType !== 'mouse') {
    if (touch.moved) {
      if (touch.down) sendButton(1, false);
    } else {
      const [x, y] = toSource(e.clientX, e.clientY);
      sendMove(x, y);
      const held = Date.now() - touch.t0;
      const btn = held >= 600 ? 3 : 1;   // long-press = right click
      sendButton(btn, true); sendButton(btn, false);
    }
    touch = null;
  }
  if (press && press.pointerId === e.pointerId) {
    if (press.guest) {
      sendButton(1, false);            // finish a Shift drag (mouse)
    } else {
      const [x, y] = toSource(e.clientX, e.clientY);
      sendMove(x, y);
      sendButton(1, true); sendButton(1, false);
    }
    press = null;
  }

  if (pts.size < 2) gest = null;
  else if (gest) beginGest();          // a finger left but >=2 remain
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') cur.style.display = 'none'; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) { zoomBy(e.deltaY < 0 ? 1.1 : 0.9, e.clientX, e.clientY); return; }
  const [x, y] = toSource(e.clientX, e.clientY);
  const b = new Uint8Array(8); const d = new DataView(b.buffer);
  d.setUint16(0, x, false); d.setUint16(2, y, false);
  d.setInt16(4, e.deltaX, false); d.setInt16(6, e.deltaY, false);
  send(frame(T.SCROLL, b));
}, { passive: false });

// physical keyboard
const NAMED = { Enter: 'Return', NumpadEnter: 'Return', Escape: 'Escape', Tab: 'Tab',
  Backspace: 'Backspace', Delete: 'Delete', Space: 'Space',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', ControlRight: 'Control',
  AltLeft: 'Alt', AltRight: 'Alt', MetaLeft: 'Meta', MetaRight: 'Meta',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8',
  F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12' };
function typingInField() { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); }
addEventListener('keydown', (e) => {
  if (typingInField()) return; // let the IME field work
  // Clipboard bridge: Cmd/Ctrl+C pushes the LOCAL selection to the guest,
  // Cmd/Ctrl+V pulls the GUEST clipboard to the local one. We still forward the
  // key itself so the guest performs its own copy/paste in the focused field.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'c' || e.key === 'C')) {
    clipLocalToRemote();
  } else if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'v' || e.key === 'V')) {
    clipRemoteToLocal();
  }
  const named = NAMED[e.code];
  if (named) { e.preventDefault(); sendKey(named, 0, true); return; }
  // A printable key with a modifier held (Ctrl+C, Alt+F, Meta+K, …) is a KEY
  // event carrying the character, NOT a Text event: the daemon presses the
  // named key while the modifier is held (the modifier keydown already fired).
  if (e.key.length === 1) {
    e.preventDefault();
    if (e.ctrlKey || e.altKey || e.metaKey) {
      sendKey(e.key, e.key.codePointAt(0), true);
      sendKey(e.key, e.key.codePointAt(0), false);
    } else {
      sendText(e.key);
    }
  }
});
addEventListener('keyup', (e) => {
  if (typingInField()) return;
  const named = NAMED[e.code];
  if (named) { e.preventDefault(); sendKey(named, 0, false); }
});

// ── virtual keyboard ────────────────────────────────────────────────────────
const mods = { Control: false, Alt: false, Shift: false, Meta: false };
function updateSticky() {
  const on = Object.entries(mods).filter(([, v]) => v).map(([k]) => k);
  $('stickyBadge').textContent = on.length ? 'latched: ' + on.join(' + ') : '';
  reflectShift();
}

// reflectShift repaints the letter and symbol keycaps for the latched Shift.
//
// Shift is a STICKY modifier here (tap it, then tap one key), so without this the
// keyboard gives no feedback at all: the user taps Shift, sees nothing change, and
// cannot tell whether the next letter will be uppercase. Every on-screen keyboard
// shows the shifted legend, so this one does too — letters go uppercase and the
// digit row swaps to its symbols, exactly like a hardware keycap.
const SHIFTED_DIGITS = { '1':'!','2':'@','3':'#','4':'$','5':'%','6':'^','7':'&','8':'*','9':'(','0':')' };
function reflectShift() {
  const up = !!mods.Shift;
  for (const el of document.querySelectorAll('#kbd .key[data-txt]')) {
    const base = el.dataset.base || el.dataset.txt;
    el.dataset.base = base;                 // remember the unshifted legend once
    if (base.length !== 1) continue;        // space etc. stay as they are
    const shifted = SHIFTED_DIGITS[base] ||
      (base !== base.toUpperCase() ? base.toUpperCase() : base);
    const want = up ? shifted : base;
    el.textContent = want;
    el.dataset.txt = want;                  // what a tap will actually type
  }
}
function toggleKbd(show) {
  // In View (read-only) mode the keyboard is disabled: instead of silently
  // doing nothing, tell the user and offer to switch to Control.
  if (S.viewOnly) {
    toast('Keyboard needs Control mode. Switch?');
    if (confirm('The keyboard injects input, which requires CONTROL mode.\nSwitch to Control now?')) {
      S.openKbdAfterControl = true;   // open it once we are in Control
      setMode(true);
    }
    return;
  }
  const on = show ?? !kbd.classList.contains('show');
  kbd.classList.toggle('show', on);
  document.body.classList.toggle('kbd-open', on);
  resize();   // the canvas grew/shrank: refit
}
// toast shows a transient message (no dependency).
let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
$('kbdToggle').onclick = () => toggleKbd();
$('kbdHide').onclick = () => toggleKbd(false);
$('btnKbd').onclick = () => toggleKbd();
// ── fullscreen + keyboard lock ──────────────────────────────────────────────
// Fullscreen is not just a bigger view: it is the only state in which a page may
// CAPTURE browser-reserved keys. navigator.keyboard.lock() (Chrome/Edge 96+,
// fullscreen only) makes Ctrl+W, Ctrl+T, Ctrl+Tab, Ctrl+N and friends arrive as
// ordinary keydown events. Without it those combinations are unfixable from
// JavaScript — they never reach the page — so a remote desktop that wants the
// guest's own shortcuts cannot work outside fullscreen.
//
// Firefox and Safari do not implement the API. There the top-row and Ctrl/Alt
// combinations we CAN intercept still work (see the keydown handler), and
// Ctrl+W/Ctrl+T simply cannot be forwarded; we say so rather than pretend.
async function enterFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement) await el.requestFullscreen?.();
  if (navigator.keyboard?.lock) {
    try {
      // No argument = lock every key the browser reserves.
      await navigator.keyboard.lock();
      toast('keyboard locked: browser shortcuts now go to the guest');
    } catch (e) {
      console.warn('keyboard.lock failed', e);
      toast('fullscreen on; keyboard lock unavailable');
    }
  } else {
    toast('fullscreen on; this browser cannot lock the keyboard');
  }
}
function exitFullscreen() {
  navigator.keyboard?.unlock?.();
  if (document.fullscreenElement) document.exitFullscreen?.();
}
function toggleFullscreen() {
  return document.fullscreenElement ? exitFullscreen() : enterFullscreen();
}
// Leaving fullscreen (by any route — F11, Esc, our button) must release the lock,
// otherwise the browser keeps swallowing shortcuts while the page looks normal.
addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) navigator.keyboard?.unlock?.();
});
$('btnFs').onclick = toggleFullscreen;
$('btnFullscreen').onclick = toggleFullscreen;
$('btnRetry').onclick = connect;

// ── capabilities readout ────────────────────────────────────────────────────
// The daemon publishes what this guest resolved each capability to
// (/capabilities): session type and the backend behind capture, input, a11y,
// clipboard and audio. That is the answer to "why is there no sound / why does
// input not work", so it belongs on screen instead of only in the daemon log.
//
// Best effort and out of band: the WS stream does not carry it, it is fetched
// once per connect, and any failure just leaves the row hidden — a missing
// capability panel must never break the stream itself.
async function loadCapabilities() {
  const base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
  try {
    const r = await fetch(base + 'capabilities', { cache: 'no-store' });
    if (!r.ok) return;
    const c = await r.json();
    const rows = [
      ['session', c.session],
      ['capture', c.capture],
      ['input', c.input],
      ['a11y', c.a11y],
      ['clipboard', c.clipboard],
      ['audio', c.audio],
    ].filter(([, v]) => v);
    if (!rows.length) return;
    $('caps').textContent = rows.map(([k, v]) => `${k.padEnd(9)} ${v}`).join('\n');
    $('capRow').hidden = false;
  } catch (e) {
    // Older daemons have no /capabilities; nothing to show.
  }
}

// Mode: View (no token) <-> Control (needs the control token). Switching
// reconnects with/without the token; the daemon answers with AuthOk.
//
// The token may come from the URL (?token=… / #token=…): if present we treat it
// as the CONTROL token and connect in Control straight away — no prompt. Only
// when there is no token at all do we ask for one.
let controlToken = accessToken();
function setMode(control) {
  S.wantControl = control;
  $('modeView').classList.toggle('on', !control);
  $('modeControl').classList.toggle('on', control);
  if (control && !controlToken) {
    controlToken = prompt('Control token:') || '';
    if (!controlToken) { S.wantControl = false; $('modeControl').classList.remove('on'); $('modeView').classList.add('on'); return; }
  }
  connect();
}
$('modeView').onclick = () => setMode(false);
$('modeControl').onclick = () => setMode(true);

// Audio: off by default (the viewer asks for it explicitly).
$('audioToggle').onclick = () => {
  S.wantAudio = !S.wantAudio;
  $('audioToggle').textContent = S.wantAudio ? 'On' : 'Off';
  $('audioToggle').classList.toggle('on', S.wantAudio);
  if (S.wantAudio) {
    audioResume();
    // Ask the daemon to start audio on THIS connection (no reconnect: the
    // video stream is untouched). Also bring up the local decoder NOW — Hello
    // (which carries the audio params) was already parsed at connect time.
    send(frame(T.AUDIO_REQ, new Uint8Array(0)));
    startAudio();
  } else {
    // Stop audio on this connection without dropping the video.
    send(frame(T.AUDIO_OFF, new Uint8Array(0)));
    if (S.adec) { try { S.adec.close(); } catch {} S.adec = null; }
    if (S.actx) { try { S.actx.close(); } catch {} S.actx = null; S.gain = null; }
    S.anext = 0;
  }
};
// Menu button toggles the settings panel; clicking outside closes it.
$('btnMenu').onclick = (e) => { e.stopPropagation(); panel.classList.toggle('show'); };
document.addEventListener('pointerdown', (e) => {
  if (panel.classList.contains('show') && !panel.contains(e.target) && e.target.id !== 'btnMenu') {
    panel.classList.remove('show');
  }
});

function buildRow(el, chars) {
  for (const c of chars) {
    const d = document.createElement('div');
    d.className = 'key';
    d.dataset.txt = c;
    // data-base is the UNSHIFTED legend; reflectShift() repaints from it so the
    // keycap can be toggled between its two legends without losing the original.
    d.dataset.base = c;
    d.textContent = c;
    el.appendChild(d);
  }
}
buildRow($('rowDigits'), '1234567890'.split(''));
buildRow($('row1'), 'qwertyuiop'.split(''));
buildRow($('row2'), 'asdfghjkl'.split(''));
buildRow($('row3'), 'zxcvbnm'.split(''));
// Symbol tab: four 10-key rows, ordered by how often each is typed rather than by
// ASCII. Row 1 is sentence punctuation (".", ",", "-", "'", '"', ...), row 2 the
// brackets and quotes used for code, row 3 maths/comparison, row 4 the remainder.
// The three-row version was only the US shift plane, which left out "." and ","
// — the two symbols people use most.
buildRow($('rowSym1'), ['.',',','?','!','-','\'','"',':',';','/']);
buildRow($('rowSym2'), ['(',')','[',']','{','}','<','>','|','\\']);
buildRow($('rowSym3'), ['+','=','*','%','&','^','~','_','$','#']);
buildRow($('rowSym4'), ['@','`','€','£','¥','°','§','©','®','•']);

// Keyboard tabs: swap the visible pane (no scrolling).
document.querySelectorAll('#kbdTabs .tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('#kbdTabs .tab').forEach((x) => x.classList.toggle('on', x === t));
    document.querySelectorAll('#kbd .pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === t.dataset.tab));
  };
});

document.querySelectorAll('#mods .key').forEach((el) => {
  el.onclick = () => { const m = el.dataset.mod; mods[m] = !mods[m]; el.classList.toggle('on', mods[m]); updateSticky(); };
});
function latchedDown() { for (const [m, on] of Object.entries(mods)) if (on) sendKey(m, 0, true); }
function latchedUp() {
  for (const [m, on] of Object.entries(mods)) if (on) { sendKey(m, 0, false); mods[m] = false; }
  document.querySelectorAll('#mods .key').forEach((x) => x.classList.remove('on'));
  updateSticky();
}
function anyLatched() { return Object.values(mods).some(Boolean); }

document.querySelectorAll('#kbd .key[data-key]').forEach((el) => {
  el.onclick = () => {
    const name = el.dataset.key;
    latchedDown(); sendKey(name, 0, true); sendKey(name, 0, false); latchedUp();
  };
});
document.querySelectorAll('#kbd .key[data-txt]').forEach((el) => {
  el.onclick = () => {
    const txt = el.dataset.txt;
    if (anyLatched()) {
      latchedDown(); sendKey('', txt.codePointAt(0), true); sendKey('', txt.codePointAt(0), false); latchedUp();
    } else { sendText(txt); }
  };
});
// IME / CJK: the est TEXT frame can only type ASCII (the daemon maps chars to
// keycodes). For anything non-ASCII we SET the guest clipboard and press
// Ctrl+V, which every toolkit honours — the only reliable way to type CJK.
function typeViaClipboard(text) {
  clipSetRemote(text);
  setTimeout(() => {
    sendKey('Control', 0, true);
    sendKey('v', 'v'.codePointAt(0), true);
    sendKey('v', 'v'.codePointAt(0), false);
    sendKey('Control', 0, false);
  }, 120);
}
// IME / CJK box: keep the text VISIBLE while typing (the old code wiped the
// field on every keystroke, so nothing ever appeared). Press Enter (or the Send
// button) to type it into the guest, then the field clears.
function sendImeText() {
  const el = $('ime');
  const v = el.value;
  if (!v) return;
  el.value = '';
  // ASCII -> direct TEXT frame; anything else -> clipboard paste.
  if (/^[\x20-\x7e\r\n\t]*$/.test(v)) sendText(v);
  else typeViaClipboard(v);
}
$('ime').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendImeText(); }
  e.stopPropagation();   // do not let the physical-keyboard handler double-type
});
$('ime').addEventListener('keyup', (e) => e.stopPropagation());
$('imeSend').onclick = sendImeText;

// ── connection ──────────────────────────────────────────────────────────────
function setState(kind, msg) {
  const el = $('state');
  el.className = 'badge ' + (kind === 'live' ? 'live' : kind === 'err' ? 'err' : 'wait');
  el.textContent = kind === 'live' ? 'live' : kind === 'err' ? (msg || 'error') : 'connecting';
}
// applyMode hides/disables the input surfaces when the daemon says we are
// read-only (the AuthOk frame carries the mode).
function applyMode(viewOnly) {
  S.viewOnly = viewOnly;
  // Reflect the daemon's answer in the mode switch.
  if ($('modeView')) $('modeView').classList.toggle('on', viewOnly);
  if ($('modeControl')) $('modeControl').classList.toggle('on', !viewOnly);
  document.body.classList.toggle('viewonly', viewOnly);
  const kb = $('btnKbd'), ime = $('ime');
  if (kb) kb.style.display = viewOnly ? 'none' : '';
  if (ime) ime.disabled = viewOnly;
  // Quality is a control-plane operation: switching to view must disable the
  // preset buttons immediately, not only when the next Hello arrives.
  syncQualityUI();
  if (viewOnly) { const k = $('kbd'); if (k) k.classList.remove('show'); }
  // The user asked for the keyboard while in View mode: open it now that we
  // are in Control.
  if (!viewOnly && S.openKbdAfterControl) {
    S.openKbdAfterControl = false;
    toggleKbd(true);
  }
}
function connect() {
  loadCapabilities();
  close();
  setState('wait');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Resolve /est/ws RELATIVE to the page, so the UI works under any mount
  // prefix (e.g. served at /easystream/ by a forwarder) — no absolute path.
  const base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
  // Control needs the token; View is the open default (no token). An explicit
  // ?token= in the URL is also honoured (and implies control if it matches).
  const urlTok = accessToken();
  const tok = S.wantControl ? (controlToken || urlTok) : '';
  // Audio is requested per-connection via a query flag the daemon reads.
  const q = (S.wantAudio ? '?audio=1' : '');
  const url = `${proto}//${location.host}${base}est/ws${q}`;
  const ws = tok ? new WebSocket(url, ['est', tok]) : new WebSocket(url, ['est']);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { if (S.wantAudio) send(frame(T.AUDIO_REQ, new Uint8Array(0))); };
  ws.onmessage = (ev) => { if (typeof ev.data === 'string') { setState('err', ev.data); return; } onBytes(new Uint8Array(ev.data)); };
  ws.onerror = () => setState('err', 'websocket error');
  ws.onclose = () => { if ($('state').textContent === 'live') setState('err', 'closed'); };
  S.ws = ws;
}
function close() {
  if (S.dec) { try { S.dec.close(); } catch {} S.dec = null; }
  if (S.adec) { try { S.adec.close(); } catch {} S.adec = null; }
  if (S.actx) { try { S.actx.close(); } catch {} S.actx = null; }
  S.anext = 0;
  if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; }
  S.gotKey = false;
}
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 150));
// Audio is ON by default: reflect it in the toggle before connecting.
if ($('audioToggle')) {
  $('audioToggle').textContent = S.wantAudio ? 'On' : 'Off';
  $('audioToggle').classList.toggle('on', S.wantAudio);
}
// Clipboard buttons (explicit, in addition to Ctrl+C/V — some browsers gate the
// async clipboard API behind a user gesture).
if ($('syncToggle')) $('syncToggle').onclick = () => setSync(!syncOn);
const bpp = $('btnPushPaste'), bcp = $('btnCopyPull');
if (bpp) bpp.onclick = () => pushAndPaste();
if (bcp) bcp.onclick = () => copyAndPull();
// Audio: browsers gate playback behind a user gesture, so resume the context on
// the first interaction and expose a mute toggle.
function audioResume() { if (S.actx && S.actx.state === 'suspended') S.actx.resume(); }
const bm = $('btnMute');
if (bm) bm.onclick = () => {
  audioResume();
  S.muted = !S.muted;                 // toggle from the (initialised) state
  if (S.gain) S.gain.gain.value = S.muted ? 0 : 1;
  bm.textContent = S.muted ? '🔇' : '🔊';
};
document.addEventListener('pointerdown', audioResume, { once: false });
resize();
connect();
