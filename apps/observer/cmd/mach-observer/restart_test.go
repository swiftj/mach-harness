package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"mach/observer/internal/testkit"
)

// sessionCookie is the session cookie a client holds for base.
func sessionCookie(t *testing.T, r *running) *http.Cookie {
	t.Helper()
	u, _ := url.Parse(r.base)
	for _, c := range r.client.Jar.Cookies(u) {
		if c.Name == "mach_observer_session" {
			return c
		}
	}
	t.Fatal("no session cookie")
	return nil
}

func status(t *testing.T, base string, c *http.Cookie, path string) int {
	t.Helper()
	req, _ := http.NewRequest("GET", base+path, nil)
	req.AddCookie(c)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// A Control Tower page left open across a restart of the observer keeps working: the observer
// binds the same port, the browser's cookie is still a session, and its event stream resumes from
// its cursor with nothing repeated and nothing missed. No write endpoint is involved.
func TestRestartKeepsTheBrowserSessionAndStream(t *testing.T) {
	root := fixture(t)
	first := launch(t, root)
	waitEvents(t, first, 7)
	var snap struct {
		Data struct {
			Cursor string `json:"cursor"`
		} `json:"data"`
	}
	json.Unmarshal(first.get(t, "/api/v1/snapshot"), &snap)
	cookie := sessionCookie(t, first)
	first.stop(t)
	for _, name := range []string{SecretName, SessionsName, PortName} {
		info, err := os.Lstat(filepath.Join(root, IndexDir, name))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v %v", name, err, info)
		}
	}
	kept, _ := os.ReadFile(filepath.Join(root, IndexDir, SessionsName))
	if bytes.Contains(kept, []byte(cookie.Value)) {
		t.Fatal("a session token was written to disk")
	}
	// Written while the observer was down.
	testkit.Append(t, testkit.LedgerPath(root), []byte("\n"))
	testkit.Append(t, testkit.LedgerPath(root), testkit.LedgerLine(7, "work.claimed", "T-1", map[string]any{"stage": "planned"}))

	second := launchWith(t, root, nil, false)
	defer second.stop(t)
	if second.base != first.base {
		t.Fatalf("the port changed across a restart: %s then %s", first.base, second.base)
	}
	if code := status(t, second.base, cookie, "/api/v1/health"); code != 200 {
		t.Fatalf("the old cookie after a restart: %d", code)
	}
	req, _ := http.NewRequest("GET", second.base+"/api/v1/stream", nil)
	req.AddCookie(cookie)
	req.Header.Set("Last-Event-ID", snap.Data.Cursor)
	resp, err := (&http.Client{Timeout: testkit.Slow(10 * time.Second)}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	var ids []string
	for sc.Scan() && len(ids) < 1 {
		line := sc.Text()
		if line == "event: reset" || line == "event: gap" {
			t.Fatalf("the stream did not resume: %s", line)
		}
		if id, ok := strings.CutPrefix(line, "id: "); ok {
			ids = append(ids, id)
		}
	}
	gen, pos, _ := strings.Cut(snap.Data.Cursor, ".")
	before, _ := strconv.Atoi(pos)
	if len(ids) != 1 || !strings.HasPrefix(ids[0], gen+".") {
		t.Fatalf("resumed at %v after %s", ids, snap.Data.Cursor)
	}
	if next, _ := strconv.Atoi(strings.TrimPrefix(ids[0], gen+".")); next != before+1 {
		t.Fatalf("resumed at %s after %s: not the next position", ids[0], snap.Data.Cursor)
	}
}

// Kept sessions are not trusted when they could have been read or changed by someone else, and
// do not carry over to another project folder (a copied folder included).
func TestKeptSessionsRefusedFromAnotherProjectOrWhenExposed(t *testing.T) {
	a := fixture(t)
	ra := launch(t, a)
	cookie := sessionCookie(t, ra)
	ra.stop(t)

	// The folder copied to another project: the record and its secret come along, the session does not.
	b := fixture(t)
	os.MkdirAll(filepath.Join(b, IndexDir), 0o700)
	for _, name := range []string{SecretName, SessionsName} {
		data, _ := os.ReadFile(filepath.Join(a, IndexDir, name))
		os.WriteFile(filepath.Join(b, IndexDir, name), data, 0o600)
	}
	errs := &lockedBuffer{}
	rb := launchWith(t, b, errs, false)
	if code := status(t, rb.base, cookie, "/api/v1/health"); code != 401 {
		t.Fatalf("a session from another project folder: %d", code)
	}
	rb.stop(t)
	if !strings.Contains(errs.String(), "another project folder") {
		t.Fatalf("stderr: %q", errs.String())
	}

	// Too open: discarded and rebuilt, with a line on stderr.
	os.Chmod(filepath.Join(a, IndexDir, SessionsName), 0o644)
	errs = &lockedBuffer{}
	ra2 := launchWith(t, a, errs, false)
	defer ra2.stop(t)
	if code := status(t, ra2.base, cookie, "/api/v1/health"); code != 401 {
		t.Fatalf("a session kept in a file others could read: %d", code)
	}
	if !strings.Contains(errs.String(), "readable by others") {
		t.Fatalf("stderr: %q", errs.String())
	}
	if info, err := os.Lstat(filepath.Join(a, IndexDir, SecretName)); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the secret was not made again privately: %v %v", err, info)
	}
	// A fresh link still works after the rebuild.
	resp, err := ra2.client.Get(ra2.link)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("a new link after the rebuild: %v", err)
	}
	resp.Body.Close()
}

// lockedBuffer collects the observer's stderr while it runs (its logger writes from other goroutines).
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuffer) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }
