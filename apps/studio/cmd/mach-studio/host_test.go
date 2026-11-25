package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"mach/studio/internal/hostdir"
	"mach/studio/internal/testkit"
)

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

var printedLink = regexp.MustCompile(`(?m)^Open: (http://127\.0\.0\.1:\d+/\?t=[A-Za-z0-9_-]+)$`)

type running struct {
	out    *lockedBuffer
	errs   *lockedBuffer
	done   chan error
	cancel context.CancelFunc
}

// startHost runs the host as main does, with --no-open, until the test stops it.
func startHost(t *testing.T, project string) *running {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	r := &running{out: &lockedBuffer{}, errs: &lockedBuffer{}, done: make(chan error, 1), cancel: cancel}
	go func() {
		r.done <- run(ctx, []string{"--project", project, "--engine", testkit.Script(t), "--python", testkit.Python(t), "--claude", "/nonexistent/claude", "--no-open"}, r.out, r.errs)
	}()
	t.Cleanup(func() { r.stop(t) })
	return r
}

func (r *running) link(t *testing.T) string {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if m := printedLink.FindStringSubmatch(r.out.String()); m != nil {
			return m[1]
		}
		select {
		case err := <-r.done:
			r.done <- err
			t.Fatalf("the host stopped: %v\n%s", err, r.errs.String())
		case <-time.After(50 * time.Millisecond):
		}
	}
	t.Fatalf("no link was printed:\n%s\n%s", r.out.String(), r.errs.String())
	return ""
}

func (r *running) stop(t *testing.T) error {
	r.cancel()
	select {
	case err := <-r.done:
		r.done <- err
		return err
	case <-time.After(30 * time.Second):
		t.Fatal("the host did not stop")
		return nil
	}
}

func readLinkFile(t *testing.T, project string) string {
	t.Helper()
	path := filepath.Join(project, filepath.FromSlash(hostdir.Rel), hostdir.LinkName)
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("no link file: %v", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("link file mode %v", info.Mode())
	}
	data, _ := os.ReadFile(path)
	return strings.TrimSuffix(string(data), "\n")
}

var noRedirects = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Timeout: 30 * time.Second}

// The host keeps the next unused link in its private file, replaces it each time a link is used,
// refuses a second start for the same project, and removes the file when it stops. After it stops
// the next start works and writes a new link.
func TestTheHostKeepsOneLinkAndRunsOncePerProject(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the host is built for macOS and Linux")
	}
	project := testkit.NewProject(t)
	os.MkdirAll(filepath.Join(project, ".factory"), 0o755)
	h := startHost(t, project)
	printed := h.link(t)
	if kept := readLinkFile(t, project); kept != printed {
		t.Fatalf("the kept link %q is not the printed one %q", kept, printed)
	}
	if !strings.Contains(h.out.String(), "A fresh link for another browser is kept in "+hostdir.Rel+"/link.") {
		t.Fatalf("start-up does not say where the next link is kept:\n%s", h.out.String())
	}
	ignore, _ := os.ReadFile(filepath.Join(project, filepath.FromSlash(hostdir.Rel), ".gitignore"))
	if !strings.Contains(string(ignore), "*") {
		t.Fatal("the host folder is not git-ignored")
	}

	// A second start for the same project stops at once with one plain line, and leaves the
	// running host's link alone.
	var out, errs strings.Builder
	err := run(context.Background(), []string{"--project", project, "--engine", testkit.Script(t), "--python", testkit.Python(t), "--no-open"}, &out, &errs)
	if !errors.Is(err, hostdir.ErrHeld) || err.Error() != "another Product Studio is already running for this project" {
		t.Fatalf("a second host for the project: %v", err)
	}
	if strings.Contains(out.String(), "Open:") {
		t.Fatalf("the second start printed a link: %s", out.String())
	}
	if kept := readLinkFile(t, project); kept != printed {
		t.Fatal("the second start changed the running host's link")
	}

	// Using the printed link replaces the kept one with a fresh link.
	resp, err := noRedirects.Get(printed)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("the printed link: %d", resp.StatusCode)
	}
	next := readLinkFile(t, project)
	if next == printed || !printedLink.MatchString("Open: "+next) {
		t.Fatalf("the kept link was not replaced: %q", next)
	}
	resp, err = noRedirects.Get(next)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("the kept link: %d", resp.StatusCode)
	}

	if err := h.stop(t); err != nil {
		t.Fatalf("stopping: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(project, filepath.FromSlash(hostdir.Rel), hostdir.LinkName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the link file outlived the host")
	}

	again := startHost(t, project)
	if fresh := again.link(t); readLinkFile(t, project) != fresh || fresh == next {
		t.Fatal("a later start did not keep its own link")
	}
}

// The running host says which release and process it is beside its link, and removes that as it
// stops, so MACH can tell an older host from the one now installed and stop only this one.
func TestTheHostSaysWhichReleaseIsRunning(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the host is built for macOS and Linux")
	}
	previous := version
	version = "9.8.7"
	t.Cleanup(func() { version = previous })
	project := testkit.NewProject(t)
	os.MkdirAll(filepath.Join(project, ".factory"), 0o755)
	h := startHost(t, project)
	link := h.link(t)
	path := filepath.Join(project, filepath.FromSlash(hostdir.Rel), hostdir.HostName)
	info, err := os.Lstat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("host file: %v %v", info, err)
	}
	var host hostdir.Host
	data, _ := os.ReadFile(path)
	if err := json.Unmarshal(data, &host); err != nil {
		t.Fatal(err)
	}
	if host.Program != "mach-studio" || host.Version != "9.8.7" || host.PID != os.Getpid() || host.Project != project ||
		!strings.HasPrefix(link, "http://127.0.0.1:"+strconv.Itoa(host.Port)+"/") {
		t.Fatalf("host file %+v for link %s", host, link)
	}
	if err := h.stop(t); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the host file outlived the host")
	}
}

// A project with no tool folder: the host runs and prints its link, and keeps no file.
func TestNoToolFolderNoLinkFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the host is built for macOS and Linux")
	}
	project := testkit.NewProject(t)
	h := startHost(t, project)
	h.link(t)
	if !strings.Contains(h.out.String(), "The link works once. Press Ctrl+C to stop.") {
		t.Fatalf("start-up:\n%s", h.out.String())
	}
	if _, err := os.Lstat(filepath.Join(project, ".factory")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a host folder was made in a project with no tool folder")
	}
}
