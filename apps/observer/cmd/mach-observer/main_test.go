package main

import (
	"bufio"
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/testkit"
)

// fixture writes a Factory tree with every kind of file the observer reads or must leave alone.
func fixture(t *testing.T) string {
	root := testkit.Project(t)
	host, _ := os.Hostname()
	var ledger []byte
	for i := 1; i <= 5; i++ {
		ledger = append(ledger, testkit.LedgerLine(i, "work.claimed", "T-1", map[string]any{"stage": "planned"})...)
	}
	ledger = append(ledger, []byte(`{"schema_version":2,"seq":6,"at`)...) // a torn last line
	testkit.Append(t, testkit.LedgerPath(root), ledger)
	testkit.Append(t, filepath.Join(root, ".factory/intake/ledger.json"), []byte(`{"next_seq":7}`))
	testkit.Append(t, testkit.CellLog(root, "T-1"), append(testkit.LifecycleLine("T-1", 1, "station.entered", "build", nil),
		testkit.LifecycleLine("T-1", 2, "gate.decided", "build", map[string]any{"gate": "red", "verdict": "passed"})...))
	testkit.Append(t, filepath.Join(root, ".factory/worktrees/T-1/cell.json"), []byte(`{"stage":"building"}`))
	testkit.Append(t, filepath.Join(root, ".factory/worktrees/T-1/evidence/summary.json"), []byte(`{"status":"PASS"}`))
	testkit.Append(t, filepath.Join(root, ".factory/worktrees/T-1/evidence/AC-01.txt"), []byte("ran it\n"))
	testkit.Append(t, filepath.Join(root, ".factory/worktrees/T-1/evidence/results.json"),
		[]byte(`{"head":"abcdef1","review_loop":0,"records":{"AC-01":{"kind":"scenario","result":"pass","evidence":[{"file":"AC-01.txt","sha256":"x"}]}}}`))
	testkit.Append(t, filepath.Join(root, ".factory/worktrees/T-1/review/round-1/findings.md"), []byte("# none\n"))
	testkit.Append(t, filepath.Join(root, ".factory/config.json"), []byte(`{"tower":{"evidence_media":false}}`))
	testkit.Append(t, filepath.Join(root, ".factory/local/executions/x0123456789ab/stream.jsonl"), []byte(`{"type":"system","subtype":"init"}`+"\n"))
	testkit.Append(t, filepath.Join(root, ".factory/archive/runs.jsonl"), []byte(`{"record_version":2}`+"\n"))
	testkit.Append(t, filepath.Join(root, ".factory/archive/T-0.tar.gz"), []byte("not really a tarball"))
	testkit.Append(t, filepath.Join(root, ".factory/observations/metrics.json"), []byte(`{}`))
	policy, _ := json.Marshal(map[string]any{"schema_version": 2, "enabled": true, "paused": false, "autonomy": "observe",
		"machine": host, "project_root": root, "enabled_by": "someone", "enabled_at": "2026-11-12T09:00:00Z"})
	os.WriteFile(filepath.Join(root, ".factory/local/runner.json"), policy, 0o600)
	lease, _ := json.Marshal(map[string]any{"pid": 1, "host": "elsewhere", "heartbeat_at": "2026-11-12T09:00:00Z", "expires_at": "2026-11-12T09:01:00Z"})
	os.WriteFile(filepath.Join(root, ".factory/local/supervisor.json"), lease, 0o600)
	os.WriteFile(filepath.Join(root, ".factory/intake/lock"), nil, 0o600) // MACH's own lock file
	// A point in the past for every timestamp, so a touch by the observer would show.
	past := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil {
			os.Chtimes(p, past, past)
		}
		return nil
	})
	return root
}

type running struct {
	link   string
	base   string
	client *http.Client
	cancel context.CancelFunc
	done   chan error
}

func launch(t *testing.T, root string) *running {
	t.Helper()
	return launchWith(t, root, nil, true)
}

// launchWith starts the observer (stderr to errs when given) and, when exchange is set, opens the
// printed link with a fresh cookie jar; otherwise the client has no cookie and link is kept.
func launchWith(t *testing.T, root string, errs io.Writer, exchange bool) *running {
	t.Helper()
	if errs == nil {
		errs = io.Discard
	}
	ctx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"--project", root}, pw, errs)
		pw.Close()
	}()
	link := ""
	scanner := bufio.NewScanner(pr)
	for scanner.Scan() {
		if after, ok := strings.CutPrefix(scanner.Text(), "Open: "); ok {
			link = after
			break
		}
	}
	go io.Copy(io.Discard, pr)
	if link == "" {
		cancel()
		t.Fatalf("no link was printed: %v", <-done)
	}
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	r := &running{base: strings.SplitN(link, "/?", 2)[0], client: client, cancel: cancel, done: done, link: link}
	if exchange {
		resp, err := client.Get(link)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	return r
}

func (r *running) get(t *testing.T, path string) []byte {
	t.Helper()
	resp, err := r.client.Get(r.base + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("%s: %d %s", path, resp.StatusCode, body)
	}
	return body
}

func (r *running) stop(t *testing.T) {
	t.Helper()
	r.cancel()
	select {
	case err := <-r.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the observer did not stop")
	}
}

func waitEvents(t *testing.T, r *running, want int) []byte {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		body := r.get(t, "/api/v1/events?limit=1000")
		var page struct {
			Data struct {
				Events []json.RawMessage `json:"events"`
			} `json:"data"`
		}
		json.Unmarshal(body, &page)
		if len(page.Data.Events) >= want {
			return body
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d events, want %d: %s", len(page.Data.Events), want, body)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// The observer writes nothing outside .factory/local/observer/: no file created, removed, written,
// chmod-ed or touched, across a full run (ingest, every endpoint, a stream) and a restart.
func TestReadOnlyOverAFactoryTree(t *testing.T) {
	root := fixture(t)
	before := testkit.HashTree(t, root, IndexDir)

	r := launch(t, root)
	waitEvents(t, r, 7) // five ledger lines and two lifecycle lines
	touchEveryEndpoint(t, r)
	checkFreshness(t, r)
	r.stop(t)

	again := launch(t, root) // a restart reads its own index, still writes nothing else
	waitEvents(t, again, 7)
	touchEveryEndpoint(t, again)
	again.stop(t)

	if diffs := testkit.DiffTrees(before, testkit.HashTree(t, root, IndexDir)); len(diffs) > 0 {
		t.Fatalf("the observer changed MACH's files: %v", diffs)
	}
	// Everything in the observer's own folder is private to the user.
	filepath.Walk(filepath.Join(root, IndexDir), func(p string, info os.FileInfo, err error) error {
		if err == nil && info.Mode().Perm()&0o077 != 0 {
			t.Errorf("%s is mode %v", p, info.Mode().Perm())
		}
		return nil
	})
	for _, name := range []string{".gitignore", "lock", "projection/projection.json"} {
		if _, err := os.Lstat(filepath.Join(root, IndexDir, name)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := os.Lstat(filepath.Join(root, IndexDir, LinkName)); err == nil {
		t.Fatal("the one-time link file outlived the observer")
	}
}

// checkFreshness: /health reports each tailed source's real size, lag and read time, and the
// history read on start as backfill (nothing late), through the real ingest loop.
func checkFreshness(t *testing.T, r *running) {
	t.Helper()
	var health struct {
		Data struct {
			Ingest struct {
				Late       int64 `json:"late"`
				Backfill   int64 `json:"backfill"`
				CatchingUp bool  `json:"catching_up"`
			} `json:"ingest"`
			Freshness struct {
				Sources []struct {
					Path       string  `json:"path"`
					Size       *int64  `json:"size"`
					Lag        *int64  `json:"lag_bytes"`
					LastReadAt *string `json:"last_read_at"`
				} `json:"sources"`
			} `json:"freshness"`
		} `json:"data"`
	}
	deadline := time.Now().Add(testkit.Slow(5 * time.Second))
	for {
		json.Unmarshal(r.get(t, "/api/v1/health"), &health)
		if !health.Data.Ingest.CatchingUp || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if health.Data.Ingest.CatchingUp || health.Data.Ingest.Late != 0 || health.Data.Ingest.Backfill < 7 {
		t.Fatalf("ingest %+v", health.Data.Ingest)
	}
	found := false
	for _, src := range health.Data.Freshness.Sources {
		if src.Path != ".factory/intake/events.jsonl" {
			continue
		}
		found = true
		// The torn last line is not read yet: the lag is exactly its bytes.
		if src.Size == nil || src.Lag == nil || *src.Lag != int64(len(`{"schema_version":2,"seq":6,"at`)) || src.LastReadAt == nil {
			t.Fatalf("ledger freshness: size %v lag %v read %v", src.Size, src.Lag, src.LastReadAt)
		}
	}
	if !found {
		t.Fatalf("no ledger in %+v", health.Data.Freshness.Sources)
	}
}

// touchEveryEndpoint reads every route, an artifact's content, a snapshot at a cursor, and a stream.
func touchEveryEndpoint(t *testing.T, r *running) {
	t.Helper()
	for _, path := range []string{"/api/v1/health", "/api/v1/factory/status", "/api/v1/session", "/api/v1/events?limit=1000",
		"/api/v1/snapshot", "/api/v1/project", "/api/v1/waves", "/api/v1/slices", "/api/v1/cells", "/api/v1/runs", "/api/v1/spans", "/api/v1/history",
		"/api/v1/series", "/api/v1/concurrency", "/api/v1/marks", "/api/v1/artifacts", "/api/v1/cells/T-1/evidence", "/api/v1/analytics/metrics?group_by=day", "/api/v1/analytics/runs", "/", "/some/app/route"} {
		r.get(t, path)
	}
	var snap struct {
		Data struct {
			Cursor string `json:"cursor"`
		} `json:"data"`
	}
	json.Unmarshal(r.get(t, "/api/v1/snapshot"), &snap)
	r.get(t, "/api/v1/snapshot?at="+snap.Data.Cursor)
	var cat struct {
		Data struct {
			Items []struct {
				ID            string `json:"id"`
				ContentAccess string `json:"content_access"`
			} `json:"items"`
		} `json:"data"`
	}
	json.Unmarshal(r.get(t, "/api/v1/artifacts"), &cat)
	served := 0
	for _, it := range cat.Data.Items {
		if it.ContentAccess == "text" {
			r.get(t, "/api/v1/artifacts/"+it.ID+"/content")
			served++
		}
	}
	if served == 0 {
		t.Fatal("no artifact content was read")
	}
	streamResp, err := r.client.Get(r.base + "/api/v1/stream?after=")
	if err == nil {
		buf := make([]byte, 256)
		streamResp.Body.Read(buf)
		streamResp.Body.Close()
	}
}

func TestNoFactoryMeansNoWrites(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	os.Mkdir(filepath.Join(root, ".git"), 0o755)
	before := testkit.HashTree(t, root, "")
	r := launch(t, root)
	body := r.get(t, "/api/v1/factory/status")
	if !strings.Contains(string(body), `"factory_present":false`) {
		t.Fatalf("%s", body)
	}
	r.stop(t)
	if diffs := testkit.DiffTrees(before, testkit.HashTree(t, root, "")); len(diffs) > 0 {
		t.Fatalf("an observer of a project without a Factory wrote: %v", diffs)
	}
}

func TestOneObserverPerProject(t *testing.T) {
	root := fixture(t)
	r := launch(t, root)
	defer r.stop(t)
	err := run(context.Background(), []string{"--project", root}, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("a second observer: %v", err)
	}
}

// Source boundary: no package starts a process, signals one, dials out (directly or through an
// HTTP client or a resolver), locks anything but its own lock file, or loads code; and only the
// index, the lock and start-up may call a function that writes to the file system.
func TestSourceBoundary(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	module := filepath.Join(filepath.Dir(here), "..", "..")
	forbiddenImports := map[string]bool{"os/exec": true, "plugin": true, "unsafe": true, "net/http/httputil": true, "net/rpc": true, "net/smtp": true}
	writers := map[string]bool{"WriteFile": true, "Create": true, "CreateTemp": true, "OpenFile": true, "Remove": true, "RemoveAll": true,
		"Rename": true, "Mkdir": true, "MkdirAll": true, "MkdirTemp": true, "Truncate": true, "Chmod": true, "Chtimes": true, "Chown": true,
		"Symlink": true, "Link": true}
	// Calls that would start or signal a process, or reach another machine, whatever the file.
	forbidden := map[string]bool{"os.StartProcess": true, "os.FindProcess": true, "http.Get": true, "http.Post": true, "http.PostForm": true,
		"http.Head": true, "http.DefaultClient": true, "http.DefaultTransport": true, "http.Client": true, "http.Transport": true,
		"http.NewRequest": true, "http.NewRequestWithContext": true, "net.Dialer": true, "net.Resolver": true, "net.LookupHost": true,
		"net.LookupIP": true, "net.LookupAddr": true, "tls.Dial": true, "syscall.ForkExec": true, "syscall.Exec": true}
	allowedWriters := map[string]bool{"internal/store/store.go": true, "internal/lock/lock_unix.go": true, "cmd/mach-observer/main.go": true,
		"internal/project/persist.go":  true,                                                                                // the saved projection, in the observer's own folder
		"internal/tail/fileid_unix.go": true, "internal/factory/pid_unix.go": true, "internal/normalize/open_unix.go": true} // these open read-only (checked below)
	readOnlyOpeners := map[string]bool{"internal/tail/fileid_unix.go": true, "internal/factory/pid_unix.go": true, "internal/normalize/open_unix.go": true,
		"internal/artifact/safe.go": true}
	files := 0
	filepath.Walk(module, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") || strings.Contains(path, "/testkit/") {
			return nil
		}
		rel, _ := filepath.Rel(module, path)
		rel = filepath.ToSlash(rel)
		files++
		fset := token.NewFileSet()
		f, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			t.Fatal(perr)
		}
		for _, imp := range f.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			if forbiddenImports[p] {
				t.Errorf("%s imports %s", rel, p)
			}
		}
		ast.Inspect(f, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			pkg, ok := sel.X.(*ast.Ident)
			if !ok {
				return true
			}
			if forbidden[pkg.Name+"."+sel.Sel.Name] {
				t.Errorf("%s: %s.%s: the observer starts no process and connects to nothing", rel, pkg.Name, sel.Sel.Name)
			}
			switch {
			case pkg.Name == "syscall" && sel.Sel.Name == "Flock" && rel != "internal/lock/lock_unix.go":
				t.Errorf("%s: syscall.Flock: only the observer's own lock (internal/lock) may lock a file", rel)
			case pkg.Name == "os" && writers[sel.Sel.Name] && !allowedWriters[rel]:
				t.Errorf("%s: os.%s outside the files allowed to write", rel, sel.Sel.Name)
			case pkg.Name == "os" && sel.Sel.Name == "OpenFile" && readOnlyOpeners[rel]:
				// allowed: these open with O_RDONLY only (checked by the source text below)
			case pkg.Name == "net" && strings.HasPrefix(sel.Sel.Name, "Dial"):
				t.Errorf("%s: net.%s: the observer never connects out", rel, sel.Sel.Name)
			case pkg.Name == "syscall" && (sel.Sel.Name == "Exec" || sel.Sel.Name == "ForkExec"):
				t.Errorf("%s: syscall.%s", rel, sel.Sel.Name)
			}
			return true
		})
		// syscall.Kill only as kill(pid, 0), which delivers nothing (a liveness check).
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
				if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == "syscall" && sel.Sel.Name == "Kill" {
					if lit, ok := call.Args[1].(*ast.BasicLit); !ok || lit.Value != "0" {
						t.Errorf("%s: syscall.Kill with a signal: the observer signals no process", rel)
					}
				}
			}
			return true
		})
		if readOnlyOpeners[rel] {
			src, _ := os.ReadFile(path)
			if strings.Contains(string(src), "O_WRONLY") || strings.Contains(string(src), "O_RDWR") || strings.Contains(string(src), "O_CREATE") {
				t.Errorf("%s must open read-only", rel)
			}
		}
		return nil
	})
	if files < 10 {
		t.Fatalf("only %d source files scanned", files)
	}
}

// Started in a folder with no Git repository and no Factory: the folder given is the project,
// exactly (a repository above it is never taken instead), nothing is written, and a Factory that
// appears later is observed from memory, still without writing anything.
func TestNoGitRepositoryAndAFactoryThatAppearsLater(t *testing.T) {
	outer, _ := filepath.EvalSymlinks(t.TempDir())
	os.Mkdir(filepath.Join(outer, ".git"), 0o755) // a repository above the project folder
	root := filepath.Join(outer, "plain folder")
	os.Mkdir(root, 0o755)
	if got, err := findProject(root); err != nil || got != root {
		t.Fatalf("--project %s resolved to %s (%v)", root, got, err)
	}
	r := launch(t, root)
	var session struct {
		Data struct {
			Project struct {
				Folder string `json:"folder"`
			} `json:"project"`
		} `json:"data"`
	}
	json.Unmarshal(r.get(t, "/api/v1/session"), &session)
	if session.Data.Project.Folder != "plain folder" {
		t.Fatalf("observing %q", session.Data.Project.Folder)
	}
	if body := r.get(t, "/api/v1/factory/status"); !strings.Contains(string(body), `"factory_present":false`) {
		t.Fatalf("%s", body)
	}
	// The Factory appears while the observer runs.
	testkit.Append(t, testkit.LedgerPath(root), append(testkit.LedgerLine(1, "work.claimed", "T-1", map[string]any{"stage": "planned"}),
		testkit.LedgerLine(2, "work.claimed", "T-1", map[string]any{"stage": "planned"})...))
	before := testkit.HashTree(t, root, "")
	waitEvents(t, r, 2)
	for _, path := range []string{"/api/v1/health", "/api/v1/factory/status", "/api/v1/snapshot", "/api/v1/history", "/api/v1/cells",
		"/api/v1/runs", "/api/v1/spans", "/api/v1/artifacts", "/api/v1/analytics/metrics"} {
		r.get(t, path)
	}
	r.stop(t)
	if diffs := testkit.DiffTrees(before, testkit.HashTree(t, root, "")); len(diffs) > 0 {
		t.Fatalf("an observer started without a Factory wrote into the one that appeared: %v", diffs)
	}
	if _, err := os.Lstat(filepath.Join(root, IndexDir)); err == nil {
		t.Fatal("the observer made its folder in a Factory it did not find at start")
	}
}
