// Package webui serves the built React app from the binary itself: no file is read from disk and
// nothing is fetched from another origin at run time.
package webui

import (
	"bytes"
	"embed"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

// dist is the frontend's build output, copied in before `go build` (see README.md).
//
//go:embed all:dist
var dist embed.FS

// Explicit types for what a Vite build emits, so serving does not depend on the machine's
// MIME tables.
var contentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json",
	".map":         "application/json",
	".webmanifest": "application/manifest+json",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".jpg":         "image/jpeg",
	".jpeg":        "image/jpeg",
	".gif":         "image/gif",
	".webp":        "image/webp",
	".avif":        "image/avif",
	".ico":         "image/x-icon",
	".woff":        "font/woff",
	".woff2":       "font/woff2",
	".ttf":         "font/ttf",
	".otf":         "font/otf",
	".txt":         "text/plain; charset=utf-8",
	".wasm":        "application/wasm",
}

// Handler serves dist/. A path with a file extension that is not in the build is a 404; any
// other path is an application route and gets index.html (the single-page app's fallback).
func Handler() http.Handler {
	root, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // the embed directive guarantees dist exists
	}
	return handler{root: root}
}

type handler struct{ root fs.FS }

func (h handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed.", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if h.serve(w, r, name) {
		return
	}
	if path.Ext(name) != "" {
		http.NotFound(w, r)
		return
	}
	h.serve(w, r, "index.html")
}

func (h handler) serve(w http.ResponseWriter, r *http.Request, name string) bool {
	info, err := fs.Stat(h.root, name)
	if err != nil || info.IsDir() {
		return false
	}
	file, err := h.root.Open(name)
	if err != nil {
		return false
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		return false
	}
	kind, ok := contentTypes[strings.ToLower(path.Ext(name))]
	if !ok {
		kind = "application/octet-stream"
	}
	w.Header().Set("Content-Type", kind)
	if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable") // Vite names these by content hash
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
	return true
}
