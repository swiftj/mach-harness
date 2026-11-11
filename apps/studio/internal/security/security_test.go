package security

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStartTokenWorksOnce(t *testing.T) {
	g, err := NewGuard(4321)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(g.StartURL())
	if u.Host != "127.0.0.1:4321" {
		t.Fatalf("start URL host %s", u.Host)
	}
	token := u.Query().Get("t")
	if _, ok := g.Exchange("wrong"); ok {
		t.Fatal("a wrong token was accepted")
	}
	if _, ok := g.Exchange(""); ok {
		t.Fatal("an empty token was accepted")
	}
	cookie, ok := g.Exchange(token)
	if !ok || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" {
		t.Fatalf("cookie %+v ok=%v", cookie, ok)
	}
	if _, ok := g.Exchange(token); ok {
		t.Fatal("the start token worked twice")
	}
	r := httptest.NewRequest("GET", "/api/session", nil)
	if g.Authenticated(r) {
		t.Fatal("no cookie, yet authenticated")
	}
	r.AddCookie(&http.Cookie{Name: CookieName, Value: cookie.Value + "x"})
	if g.Authenticated(r) {
		t.Fatal("a wrong cookie was accepted")
	}
	r = httptest.NewRequest("GET", "/api/session", nil)
	r.AddCookie(cookie)
	if !g.Authenticated(r) {
		t.Fatal("the session cookie was refused")
	}
	if g.CSRF() == "" || g.CSRF() == cookie.Value || g.CSRF() == token {
		t.Fatal("the CSRF token must be its own secret")
	}
}

func TestHostMustBeExact(t *testing.T) {
	g, _ := NewGuard(4321)
	for host, want := range map[string]bool{
		"127.0.0.1:4321": true, "localhost:4321": true,
		"127.0.0.1:4322": false, "127.0.0.1": false, "localhost": false, "evil.example:4321": false,
		"localhost.evil.example:4321": false, "[::1]:4321": false, "0.0.0.0:4321": false, "": false,
	} {
		if g.HostAllowed(host) != want {
			t.Errorf("host %q: want %v", host, want)
		}
	}
}

func TestStateChangeNeedsOriginAndCSRF(t *testing.T) {
	g, _ := NewGuard(4321)
	request := func(host, origin, csrf string) *http.Request {
		r := httptest.NewRequest("POST", "/api/ops/status", nil)
		r.Host = host
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if csrf != "" {
			r.Header.Set(CSRFHeader, csrf)
		}
		return r
	}
	good := g.CSRF()
	if err := g.CheckStateChange(request("127.0.0.1:4321", "http://127.0.0.1:4321", good)); err != nil {
		t.Fatalf("a good request was refused: %v", err)
	}
	if err := g.CheckStateChange(request("localhost:4321", "http://localhost:4321", good)); err != nil {
		t.Fatalf("localhost was refused: %v", err)
	}
	for name, r := range map[string]*http.Request{
		"no origin":           request("127.0.0.1:4321", "", good),
		"foreign origin":      request("127.0.0.1:4321", "http://evil.example", good),
		"null origin":         request("127.0.0.1:4321", "null", good),
		"origin of the other": request("127.0.0.1:4321", "http://localhost:4321", good),
		"https origin":        request("127.0.0.1:4321", "https://127.0.0.1:4321", good),
		"no csrf":             request("127.0.0.1:4321", "http://127.0.0.1:4321", ""),
		"wrong csrf":          request("127.0.0.1:4321", "http://127.0.0.1:4321", good+"x"),
	} {
		if err := g.CheckStateChange(r); err == nil {
			t.Errorf("%s: accepted", name)
		} else if strings.Contains(err.Error(), good) {
			t.Errorf("%s: the error echoes the token", name)
		}
	}
}

func TestHeadersAllowNoOtherOrigin(t *testing.T) {
	h := http.Header{}
	Headers(h)
	csp := h.Get("Content-Security-Policy")
	for _, part := range []string{"default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"} {
		if !strings.Contains(csp, part) {
			t.Errorf("CSP lacks %q", part)
		}
	}
	for _, banned := range []string{"http:", "https:", "*", "unsafe-inline", "unsafe-eval"} {
		if strings.Contains(csp, banned) {
			t.Errorf("CSP allows %q", banned)
		}
	}
	if h.Get("X-Content-Type-Options") != "nosniff" || h.Get("X-Frame-Options") != "DENY" {
		t.Fatal("missing headers")
	}
}

func project(t *testing.T) string {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	if err := os.MkdirAll(filepath.Join(root, DraftDir, "specs", "slices"), 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestDraftPathsStayInsideTheWorkspace(t *testing.T) {
	root := project(t)
	for _, rel := range []string{"", "/etc/passwd", "../x", "specs/../../x", "specs/slices/../../../README.md", "specs//x.md",
		"./specs/x.md", "specs\\slices\\x.md", "specs/slices/x\x00.md", "specs/slices/" + strings.Repeat("a", 256)} {
		if _, err := WriteDraft(root, rel, []byte("x")); !errors.Is(err, ErrUnsafePath) {
			t.Errorf("%q: want an unsafe path, got %v", rel, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "x")); err == nil {
		t.Fatal("something was written outside the workspace")
	}
	path, err := WriteDraft(root, "specs/slices/SLICE-001-a.md", []byte("hello"))
	if err != nil || path != filepath.Join(root, DraftDir, "specs/slices/SLICE-001-a.md") {
		t.Fatalf("%s %v", path, err)
	}
	if data, _ := os.ReadFile(path); string(data) != "hello" {
		t.Fatalf("content %q", data)
	}
	if _, err := WriteDraft(root, "product/intents/SLICE-001.md", []byte("why")); err != nil {
		t.Fatalf("missing folders are made inside the workspace: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(root, DraftDir, "specs", "slices"))
	if len(entries) != 1 {
		t.Fatalf("a temporary file was left behind: %v", entries)
	}
}

func TestSymlinksAnywhereOnTheWayAreRefused(t *testing.T) {
	cases := map[string]func(root, outside string){
		"the workspace": func(root, outside string) {
			os.RemoveAll(filepath.Join(root, DraftDir))
			os.Symlink(outside, filepath.Join(root, DraftDir))
		},
		"the tool folder": func(root, outside string) {
			os.RemoveAll(filepath.Join(root, ".factory"))
			os.Symlink(outside, filepath.Join(root, ".factory"))
		},
		"the specs folder": func(root, outside string) {
			os.RemoveAll(filepath.Join(root, DraftDir, "specs", "slices"))
			os.Symlink(outside, filepath.Join(root, DraftDir, "specs", "slices"))
		},
		"the file": func(root, outside string) {
			os.WriteFile(filepath.Join(outside, "target.md"), []byte("keep"), 0o644)
			os.Symlink(filepath.Join(outside, "target.md"), filepath.Join(root, DraftDir, "specs", "slices", "SLICE-001-a.md"))
		},
		"a folder that is a file": func(root, outside string) {
			os.RemoveAll(filepath.Join(root, DraftDir, "specs", "slices"))
			os.WriteFile(filepath.Join(root, DraftDir, "specs", "slices"), []byte("not a folder"), 0o644)
		},
	}
	for name, attack := range cases {
		t.Run(name, func(t *testing.T) {
			root := project(t)
			outside, _ := filepath.EvalSymlinks(t.TempDir())
			attack(root, outside)
			if _, err := WriteDraft(root, "specs/slices/SLICE-001-a.md", []byte("evil")); !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("want an unsafe path, got %v", err)
			}
			entries, _ := os.ReadDir(outside)
			for _, e := range entries {
				data, _ := os.ReadFile(filepath.Join(outside, e.Name()))
				if e.Name() != "target.md" || string(data) != "keep" {
					t.Fatalf("something was written through the link: %s %q", e.Name(), data)
				}
			}
		})
	}
}
