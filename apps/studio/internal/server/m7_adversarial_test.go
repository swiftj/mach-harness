package server_test

// M7 adversarial checks on the Product Studio host, added to the existing boundary tests in server_test.go
// (whose helpers start, login, call and expect are reused). Each runs the real server on a loopback port
// against a throwaway project from testkit. A test passes when the host refuses.

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"mach/studio/internal/engine"
	"mach/studio/internal/security"
	"mach/studio/internal/server"
	"mach/studio/internal/testkit"
)

func TestM7HostSpoofingIsRefused(t *testing.T) {
	h := start(t)
	h.login()
	port := strconv.Itoa(h.port)
	for _, bad := range []string{
		"LOCALHOST:" + port, "127.0.0.1.:" + port, "localhost.:" + port, "[::1]:" + port, "0.0.0.0:" + port,
		"127.1:" + port, "2130706433:" + port, "127.0.0.1:" + port + "@evil.example", "rebind.evil.example:" + port,
	} {
		status, env := h.call("GET", "/api/session", "", func(r *http.Request) { r.Host = bad })
		if status != 403 || env.OK || env.Error.Kind != engine.KindUnauthorized {
			t.Errorf("Host %q: %d %+v", bad, status, env.Error)
		}
	}
}

func TestM7CrossSiteOriginsAreRefused(t *testing.T) {
	h := start(t)
	h.login()
	port := strconv.Itoa(h.port)
	for _, origin := range []string{
		"null", "https://127.0.0.1:" + port, "http://localhost:" + port, // the other loopback name is another origin
		"http://127.0.0.1:" + port + "/", "http://127.0.0.1:" + port + ".evil.example", "http://evil.example",
		"file://", "chrome-extension://abcdef",
	} {
		status, env := h.call("POST", "/api/ops/project.init", `{"id":"team-space","name":"n","vision":"v","outcome":["o"]}`,
			func(r *http.Request) { r.Header.Set("Origin", origin) })
		if status != 403 || env.Error.Kind != engine.KindUnauthorized {
			t.Errorf("Origin %q: %d %+v", origin, status, env.Error)
		}
	}
	if _, err := os.Stat(testkit.Draft(h.project, "product", "project.json")); err == nil {
		t.Fatal("a cross-site request changed the project")
	}
}

func TestM7NoCSRFTokenWithoutTheSession(t *testing.T) {
	h := start(t)
	req, _ := http.NewRequest("GET", h.base+"/api/session", nil)
	resp, err := noRedirect.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	if resp.StatusCode != 401 || strings.Contains(string(buf[:n]), h.guard.CSRF()) {
		t.Fatalf("the CSRF token was served without a session: %d", resp.StatusCode)
	}
	// A request with the cookie but a token copied from nowhere, or sent as a query or a cookie, is refused.
	h.login()
	for name, adjust := range map[string]func(*http.Request){
		"token in query": func(r *http.Request) { r.Header.Del(security.CSRFHeader); r.URL.RawQuery = "csrf=" + h.csrf },
		"token in cookie": func(r *http.Request) {
			r.Header.Del(security.CSRFHeader)
			r.AddCookie(&http.Cookie{Name: security.CSRFHeader, Value: h.csrf})
		},
		"empty token": func(r *http.Request) { r.Header.Set(security.CSRFHeader, "") },
	} {
		status, env := h.call("POST", "/api/ops/epic.add", `{"title":"x","criterion":["y"]}`, adjust)
		if status != 403 || env.Error.Kind != engine.KindUnauthorized {
			t.Errorf("%s: %d %+v", name, status, env.Error)
		}
	}
}

func TestM7OnlyListedOperationsExist(t *testing.T) {
	forbidden := []string{"fac" + "tory", "dis" + "patch", "merge", "enable", "supervis", "intake", "run", "shell", "exec", "push", "human", "review", "build", "verify"}
	for _, name := range engine.Names() {
		for _, word := range forbidden {
			if segments := strings.FieldsFunc(name, func(r rune) bool { return r == '.' || r == '-' }); containsPrefix(segments, word) {
				t.Errorf("operation %q looks like engineering-line execution (%q)", name, word)
			}
		}
	}
	h := start(t)
	h.login()
	// The engine's leftovers (docs/mach-next/M11_STUDIO_ISSUES.md) are not routes either.
	leftovers := []string{"slice.approve", "wave.new", "wave.add", "wave.remove", "wave.approve", "wave.renumber", "send", "send.preview",
		"feedback", "acceptance.record", "acceptance.show"}
	for _, op := range append([]string{"fac" + "tory.enable", "dis" + "patch", "merge", "run", "approve-human", "exec", "SEND", "send ", "status;id", "..", "status%00"}, leftovers...) {
		status, env := h.call("POST", "/api/ops/"+op, `{}`, nil)
		if env.OK || (status != 404 && status != 400) {
			t.Errorf("op %q: %d %+v", op, status, env.Error)
		}
	}
	for _, path := range []string{"/api/ops/status/../send", "/api/ops/..%2fsend", "/api/ops//send", "/api/./ops/send", "/api/ops/%2e%2e/send"} {
		status, env := h.call("POST", path, `{}`, nil)
		if env.OK || (status != 400 && status != 404) {
			t.Errorf("path %q: %d %+v", path, status, env.Error)
		}
	}
}

func TestM7ArgumentsCannotBecomeOptionsOrPaths(t *testing.T) {
	h := start(t)
	h.login()
	h.startSlice()
	for _, slice := range []string{"--help", "-h", "SLICE-001 --ready", "SLICE-001;id", "../SLICE-001", "SLICE-001/../../x", "/etc/passwd", "SLICE-1"} {
		body := `{"slice_id":` + strconv.Quote(slice) + `}`
		status, env := h.call("POST", "/api/ops/slice.show", body, nil)
		if status != 400 || env.Error.Kind != engine.KindInvalid {
			t.Errorf("slice_id %q: %d %+v", slice, status, env.Error)
		}
	}
	for _, body := range []string{`{"slice_id":"SLICE-001","path":"/etc/passwd"}`, `{"slice_id":"SLICE-001","argv":["--x"]}`, `["status"]`, `"x"`} {
		status, env := h.call("POST", "/api/ops/slice.show", body, nil)
		if status != 400 || env.Error.Kind != engine.KindInvalid {
			t.Errorf("body %s: %d %+v", body, status, env.Error)
		}
	}
}

func TestM7DraftsOutsideTheWorkspaceAreRefused(t *testing.T) {
	h := start(t)
	h.login()
	h.startSlice()
	outside := filepath.Join(filepath.Dir(h.project), "outside.md")
	for _, slice := range []string{"..%2f..%2foutside", "%2e%2e", "SLICE-001%2f..%2f..%2fx", "..", "SLICE-001%00", "SLICE-001.md", "slice-001"} {
		for _, kind := range []string{"spec", "intent"} {
			status, env := h.call("GET", "/api/drafts/"+kind+"/"+slice, "", nil)
			if env.OK || status == 200 {
				t.Errorf("GET %s/%s: %d", kind, slice, status)
			}
			status, env = h.call("PUT", "/api/drafts/"+kind+"/"+slice, specBody(t, "x"), nil)
			if env.OK || status == 200 {
				t.Errorf("PUT %s/%s: %d", kind, slice, status)
			}
		}
	}
	if _, err := os.Stat(outside); err == nil {
		t.Fatal("a draft was written outside the workspace")
	}
}

func TestM7TheHostBindsLoopbackOnly(t *testing.T) {
	listener, err := server.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	addr := listener.Addr().(*net.TCPAddr)
	if !addr.IP.Equal(net.IPv4(127, 0, 0, 1)) {
		t.Fatalf("bound %s", addr)
	}
	// There is no way to ask for another address: Listen takes a port only, and a bad port is refused.
	for _, port := range []int{-1, 65536, 1 << 20} {
		if l, err := server.Listen(port); err == nil {
			l.Close()
			t.Errorf("port %d accepted", port)
		}
	}
	// Nothing answers on a non-loopback address of this machine at that port.
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok || ipnet.IP.IsLoopback() || ipnet.IP.To4() == nil {
			continue
		}
		conn, err := net.Dial("tcp4", net.JoinHostPort(ipnet.IP.String(), strconv.Itoa(addr.Port)))
		if err == nil {
			conn.Close()
			t.Errorf("reachable on %s", ipnet.IP)
		}
	}
}

// containsPrefix reports whether any dot- or dash-separated segment of an operation name starts with word.
func containsPrefix(segments []string, word string) bool {
	for _, segment := range segments {
		if strings.HasPrefix(segment, word) {
			return true
		}
	}
	return false
}
