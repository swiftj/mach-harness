package webui

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPlaceholderAndAppRoutes(t *testing.T) {
	h := Handler()
	for _, path := range []string{"/", "/atlas/cell/T-1"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), `id="root"`) || w.Header().Get("Content-Type") != "text/html; charset=utf-8" {
			t.Fatalf("%s: %d %s", path, w.Code, w.Header())
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/assets/missing.js", nil))
	if w.Code != 404 {
		t.Fatalf("a missing asset: %d", w.Code)
	}
}
