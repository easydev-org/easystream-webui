// Command estbridge is a transparent WebSocket <-> TCP byte pipe for the
// easystream (est://) protocol. Browsers cannot open a raw TCP socket, so the
// page speaks est framing over a WebSocket and this bridge relays the bytes to
// the daemon unchanged.
//
// It deliberately does NOT parse est: one WebSocket maps to one TCP connection,
// bytes are copied both ways. That keeps it correct as EST.md evolves.
package main

import (
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1 << 16,
	WriteBufferSize: 1 << 16,
	// Same-origin is not required: the page is served by this same server.
	CheckOrigin: func(r *http.Request) bool { return true },
}

func main() {
	listen := flag.String("listen", ":8099", "HTTP listen address")
	est := flag.String("est", "127.0.0.1:48079", "est daemon address")
	web := flag.String("web", "webui", "directory of the static UI")
	cert := flag.String("tls-cert", "", "TLS certificate (enables HTTPS; needed for WebCodecs)")
	key := flag.String("tls-key", "", "TLS private key")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/est/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWS(w, r, *est)
	})
	mux.Handle("/", http.FileServer(http.Dir(*web)))

	log.Printf("estbridge: http %s, est %s, web %s", *listen, *est, *web)
	if *cert != "" && *key != "" {
		// WebCodecs (VideoDecoder) only exists in a secure context, and a
		// plain-HTTP origin other than localhost is not one — so browsers
		// disable it. Serving over TLS makes the page a secure context.
		log.Printf("estbridge: TLS enabled (WebCodecs available)")
		log.Fatal(http.ListenAndServeTLS(*listen, *cert, *key, mux))
	}
	log.Fatal(http.ListenAndServe(*listen, mux))
}

func serveWS(w http.ResponseWriter, r *http.Request, estAddr string) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}
	defer ws.Close()

	tcp, err := net.DialTimeout("tcp", estAddr, 5*time.Second)
	if err != nil {
		ws.WriteMessage(websocket.TextMessage, []byte("estbridge: dial "+estAddr+": "+err.Error()))
		return
	}
	defer tcp.Close()

	done := make(chan struct{}, 2)

	// est -> browser
	go func() {
		defer func() { done <- struct{}{} }()
		buf := make([]byte, 1<<16)
		for {
			n, err := tcp.Read(buf)
			if n > 0 {
				if werr := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// browser -> est
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			typ, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if typ != websocket.BinaryMessage {
				continue
			}
			if _, werr := tcp.Write(data); werr != nil {
				return
			}
		}
	}()

	<-done
	_ = io.Discard // keep io import for future framing helpers
}
