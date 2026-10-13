# easystream-webui

A single-page browser UI for the **easystream (`est://`)** protocol: live H.264
screen, pointer/keyboard input, and a11y queries, all over one page.

`est://` is a raw-TCP binary protocol (see `abc-agent/worker-native/EST.md`), so
a browser cannot open it directly. This repo ships two pieces:

```
browser  ──WebSocket──▶  estbridge  ──TCP──▶  easystream daemon (est://48079)
 (index.html)            (Go, byte pipe)
```

- **`webui/index.html`** — the UI. It speaks the est framing over a WebSocket:
  decodes the H.264 access units with **WebCodecs `VideoDecoder`** and paints a
  canvas, sends pointer/keyboard frames, and shows `/apps`, `/tree`, `/find`.
  No build step, no framework — one HTML file.
- **`bridge/main.go`** — `estbridge`: a transparent WebSocket↔TCP byte pipe.
  It opens one est connection per WebSocket and forwards bytes both ways, so
  the page sees the exact est byte stream.

## Why a bridge

Browsers have no raw-socket API. The bridge is deliberately dumb (no est
parsing): it just relays bytes, so it stays correct as EST.md evolves. Run it
next to the daemon.

## Run

```sh
# the daemon (worker-native) must be listening on 127.0.0.1:48079
go run ./bridge -listen :8099 -est 127.0.0.1:48079 -web webui
# open http://localhost:8099/
```

### WebCodecs needs a secure context

`VideoDecoder` (WebCodecs) is only available in a **secure context** — HTTPS, or
`http://localhost`. A page served from a plain-HTTP origin (e.g.
`http://192.168.1.5:8099`) is NOT secure, so the browser hides WebCodecs and the
screen stays black. Two options:

- open the page via `http://localhost:8099/` (same machine), or
- serve over TLS:

  ```sh
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout key.pem -out cert.pem -subj "/CN=easystream"
  go run ./bridge -listen :8099 -est 127.0.0.1:48079 -web webui \
    -tls-cert cert.pem -tls-key key.pem
  # open https://<host>:8099/  (accept the self-signed certificate)
  ```

## Layout

```
bridge/main.go     estbridge: WS <-> est TCP
webui/index.html   the UI (video + input + a11y)
```
