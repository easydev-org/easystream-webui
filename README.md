# easystream-webui

A browser UI for the **easystream (`est://`)** protocol: the live H.264 screen
fills the page, with pointer/keyboard/touch input and a floating virtual
keyboard. It talks **only** to the est stream — video out, input in; it never
calls the a11y query endpoints.

```
browser  ──WebSocket──▶  estbridge  ──TCP──▶  easystream daemon (est://48079)
 (index.html + app.js)    (Go, byte pipe)
```

## Features

- **noVNC-style display** — the video fills the viewport, letterboxed to keep
  aspect; the latest frame is held offscreen so zoom/pan repaint instantly.
- **Zoom & pan** — pinch-to-zoom and two-finger pan on touch; a `+ / − / Fit /
  1:1` control; `Ctrl`/`Cmd`+wheel zooms on desktop. Zoom keeps the point under
  the cursor/fingers fixed.
- **Responsive** — a top bar that auto-hides (hot-zone at the top edge), safe-
  area insets for notched phones, and a **bottom-sheet keyboard** on narrow
  screens (a left drawer on wide ones) so the screen stays visible above it.
- **Virtual keyboard (termux-like)** — modifiers (Ctrl/Alt/Shift/Meta, latched
  with a visible indicator), editing keys, arrows, F1–F12, a full QWERTY
  (digits/letters/symbols), and an IME/CJK text sink. Special keys are sent as
  est `Key` frames; printable keys as `Text` (or `Key(char)` when a modifier is
  latched, so combos like Ctrl+C work).
- **Touch** — tap = left click, long-press = right click, drag = drag; a
  two-finger gesture switches to pinch/pan and cancels the in-flight drag.

## Files

```
webui/index.html   the page (markup + styles)
webui/app.js       the est client (framing, WebCodecs, input, view transform)
bridge/main.go     estbridge: transparent WebSocket<->TCP byte pipe
```

## Run

```sh
# the easystream daemon must be listening on 127.0.0.1:48079
go run ./bridge -listen :8099 -est 127.0.0.1:48079 -web webui
# open http://localhost:8099/
```

### WebCodecs needs a secure context

`VideoDecoder` exists only in a **secure context** — HTTPS, or `http://localhost`.
A plain-HTTP origin (e.g. `http://192.168.1.5:8099`) is not one, so the browser
hides WebCodecs and the screen stays black. Either open the page via
`http://localhost:8099/`, or serve over TLS:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout key.pem -out cert.pem -subj "/CN=easystream"
go run ./bridge -listen :8099 -est 127.0.0.1:48079 -web webui \
  -tls-cert cert.pem -tls-key key.pem
# open https://<host>:8099/  (accept the self-signed certificate)
```

## Note on the Key frame

The daemons read a `Key` frame as `u8 nameLen, name[nameLen], u32 char, u8
down`; `EST.md` documents it without the `char` field. This client matches the
**daemons** (the extra `u32 char` is required, in little-endian).
