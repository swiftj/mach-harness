package server

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mach/observer/internal/feedtest"
	"mach/observer/internal/project"
	"mach/observer/internal/redact"
	"mach/observer/internal/security"
)

// M6.6 F4: the access log is written before any check, from a path the sender chooses. A raw CR,
// LF or ESC forged log lines and drove the terminal; every path is now one quoted, cut line.
func TestAccessLogQuotesThePath(t *testing.T) {
	var buf bytes.Buffer
	guard, _ := security.NewGuard(4321)
	mem := feedtest.NewMem("", 0)
	s := New(Options{Root: t.TempDir(), Guard: guard, Log: mem, Projector: project.New(project.Options{Log: mem}), Logger: log.New(&buf, "", 0)})
	for _, p := range []string{"/api/v1/cells/SYN-003%0d%0aX-Injected:1", "/api/v1/cells/x%1b%5b31mRED", "/api/v1/cells/" + strings.Repeat("A", 10000)} {
		buf.Reset()
		req := httptest.NewRequest("GET", p, nil)
		req.Host = "127.0.0.1:4321"
		s.ServeHTTP(httptest.NewRecorder(), req)
		line := buf.String()
		if strings.Count(line, "\n") != 1 || strings.ContainsAny(strings.TrimSuffix(line, "\n"), "\r\n\x1b") || len(line) > MaxLoggedPath+80 {
			t.Fatalf("%.60q logged as %q", p, line)
		}
		if !strings.Contains(line, `"/api/v1/cells/`) {
			t.Fatalf("the path is not quoted: %q", line)
		}
	}
}

// M6.6 F5: the reply filter ran over raw JSON, so a learned "name" equal to a key ("data", from an
// e-mail's local part) renamed it in every reply. Such words are never learned, and a key is never
// rewritten even when a listed name equals it.
func TestLearnedNameNeverRewritesKeys(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	people := redact.PeopleFor(h.root)
	people.Learn("data@example.test", "events", "Stage")
	for _, w := range []string{"data", "events", "stage"} {
		if people.Is(w) {
			t.Errorf("%q, a word the replies are made of, was learned as a name", w)
		}
	}
	people.Learn("display_policy") // not a protocol word: learned, and must still not rewrite the key
	if !people.Is("display_policy") {
		t.Fatal("the key-position check below would prove nothing")
	}
	for _, path := range []string{"/api/v1/session", "/api/v1/cells", "/api/v1/snapshot", "/api/v1/events"} {
		_, env, body := h.do(t, "GET", path, nil)
		if !env.OK || env.Data == nil || !bytes.Contains(body, []byte(`"data":`)) {
			t.Fatalf("%s lost its shape: %.200s", path, body)
		}
	}
	_, _, body := h.do(t, "GET", "/api/v1/session", nil)
	if !bytes.Contains(body, []byte(`"display_policy":`)) {
		t.Fatalf("a key equal to a listed name was rewritten: %.300s", body)
	}
}

// M6.6 F7: refusals before routing (another host, another method) are not kept by a cache either.
func TestRefusalsAreNotCached(t *testing.T) {
	h := start(t, config{})
	for _, c := range []struct {
		method string
		edit   func(*http.Request)
	}{
		{"GET", func(r *http.Request) { r.Host = "evil.test" }},
		{"POST", nil},
		{"DELETE", nil},
	} {
		for _, path := range []string{"/api/v1/session", "/"} {
			resp, _, _ := h.do(t, c.method, path, c.edit)
			if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s: %d", c.method, path, resp.StatusCode)
			}
			if resp.Header.Get("Cache-Control") != "no-store" {
				t.Errorf("%s %s %d: Cache-Control %q", c.method, path, resp.StatusCode, resp.Header.Get("Cache-Control"))
			}
		}
	}
}
