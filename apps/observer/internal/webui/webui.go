// Package webui serves the built Control Tower app from the binary itself: nothing is read from
// disk and nothing is fetched from another origin at run time. Adapted from
// apps/studio/internal/webui (MACH Next M5). The committed dist/ is a placeholder; a build
// script (not part of this wave) copies web/apps/control-tower's build over it before go build.
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

//go:embed all:dist
var dist embed.FS

var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json",
	".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
	".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
}

// Handler serves dist/. A path with an extension that is not in the build is a 404; any other
// path is an application route and gets index.html.
func Handler() http.Handler {
	root, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return handler{root: root}
}

type handler struct{ root fs.FS }

func (h handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
	return true
}
