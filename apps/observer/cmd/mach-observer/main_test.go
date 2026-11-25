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
	"os/exec"
	"path/filepath"
	"regexp"
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
	testkit.Append(t, filepath.Join(root, ".factory/config.json"), []byte(`{"floor":{"evidence_media":false}}`))
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
	// The project's own install of MACH's run.py, as a fake that answers the two reads and writes nothing.
	testkit.Append(t, filepath.Join(root, ".claude/skills/mach/scripts/run.py"), []byte(fakeRunPy))
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

// fakeRunPy answers `decide --json` and `factory status` as MACH would, and refuses anything else.
const fakeRunPy = `import json, sys
args = sys.argv[1:]
if args[1:3] == ["decide", "--json"]:
    print(json.dumps({"reads_only": True, "nothing_waiting": False, "order": ["T-1"], "data_fields": ["situation.title"], "data_note": "data",
                      "tickets": [{"ticket_id": "T-1", "state": "approval", "situation": {"summary": "Approve it.", "title": "A title"},
                                   "show_first": [".factory/worktrees/T-1/review/round-1/findings.md"], "decide_command": "/mach decide T-1",
                                   "options": [{"key": "approve", "label": "Approve the change", "does": "Approves.", "route": "approve T-1",
                                                "needs_reason": False, "recommended": False, "do": True, "needs": [], "confirm": True}]}]}))
elif args[1:3] == ["factory", "status"]:
    print(json.dumps({"factory": "observe", "supervisor": {"running": False}, "executions": []}))
else:
    sys.stderr.write("refused: not in this test\n")
    sys.exit(1)
`

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

// With no decision made, the observer writes nothing outside .factory/local/observer/: no file
// created, removed, written, chmod-ed or touched, across a full run (ingest, every endpoint, "Needs
// you" and the running Factory read through the project's run.py, a stream) and a restart.
func TestNothingChangesOverAFactoryTreeWithNoDecision(t *testing.T) {
	root := fixture(t)
	before := testkit.HashTree(t, root, IndexDir)

	r := launch(t, root)
	var session struct {
		Data struct {
			Capabilities map[string]any `json:"capabilities"`
		} `json:"data"`
	}
	json.Unmarshal(r.get(t, "/api/v1/session"), &session)
	if _, err := exec.LookPath("python3"); err == nil && session.Data.Capabilities["decisions"] != true {
		t.Fatalf("the project's run.py was not found: %v", session.Data.Capabilities)
	}
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
		"/api/v1/snapshot", "/api/v1/project", "/api/v1/slices", "/api/v1/cells", "/api/v1/runs", "/api/v1/spans", "/api/v1/history",
		"/api/v1/series", "/api/v1/concurrency", "/api/v1/marks", "/api/v1/artifacts", "/api/v1/cells/T-1/evidence", "/api/v1/analytics/metrics?group_by=day", "/api/v1/analytics/runs", "/", "/some/app/route"} {
		r.get(t, path)
	}
	// "Needs you" runs the project's run.py (decide --json) when it is there; a write needs more than a cookie.
	if resp, err := r.client.Get(r.base + "/api/v1/needs"); err == nil {
		resp.Body.Close()
		if resp.StatusCode != 200 && resp.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("/api/v1/needs: %d", resp.StatusCode)
		}
	}
	for _, path := range []string{"/api/v1/needs/T-1/approve", "/api/v1/factory/stop"} {
		resp, err := r.client.Post(r.base+path, "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("POST %s without Origin and CSRF: %d", path, resp.StatusCode)
		}
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

// Source boundary (M23: the Floor may run MACH's run.py, and nothing else). Only internal/act
// imports os/exec, and only its exec_unix.go signals a process (its own process group, on a time
// limit); no package dials out (directly or through an HTTP client or a resolver), locks anything
// but its own lock file, or loads code; only the index, the lock, start-up and the answers file in
// the observer's own folder may call a function that writes to the file system. In internal/act the
// only script named is run.py, and every argument vector is built from the fixed words below; no
// file in the observer names `factory enable`, `factory start`, `--persistent`, `dispatch` or `pull`.
func TestSourceBoundary(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	module := filepath.Join(filepath.Dir(here), "..", "..")
	forbiddenImports := map[string]bool{"os/exec": true, "plugin": true, "unsafe": true, "net/http/httputil": true, "net/rpc": true, "net/smtp": true}
	execAllowed := map[string]bool{"internal/act/act.go": true, "internal/act/exec_unix.go": true, "internal/act/exec_other.go": true, "internal/act/locate.go": true}
	writers := map[string]bool{"WriteFile": true, "Create": true, "CreateTemp": true, "OpenFile": true, "Remove": true, "RemoveAll": true,
		"Rename": true, "Mkdir": true, "MkdirAll": true, "MkdirTemp": true, "Truncate": true, "Chmod": true, "Chtimes": true, "Chown": true,
		"Symlink": true, "Link": true}
	// Calls that would start or signal a process, or reach another machine, whatever the file.
	forbidden := map[string]bool{"os.StartProcess": true, "os.FindProcess": true, "http.Get": true, "http.Post": true, "http.PostForm": true,
		"http.Head": true, "http.DefaultClient": true, "http.DefaultTransport": true, "http.Client": true, "http.Transport": true,
		"http.NewRequest": true, "http.NewRequestWithContext": true, "net.Dialer": true, "net.Resolver": true, "net.LookupHost": true,
		"net.LookupIP": true, "net.LookupAddr": true, "tls.Dial": true, "syscall.ForkExec": true, "syscall.Exec": true}
	allowedWriters := map[string]bool{"internal/store/store.go": true, "internal/lock/lock_unix.go": true, "cmd/mach-observer/main.go": true,
		"internal/project/persist.go": true, // the saved projection, in the observer's own folder
		"internal/act/answers.go":     true, // a person's answers for run.py, a private file in the observer's own folder, removed after
		"internal/tail/fileid_unix.go": true, "internal/factory/pid_unix.go": true, "internal/normalize/open_unix.go": true} // these open read-only (checked below)
	readOnlyOpeners := map[string]bool{"internal/tail/fileid_unix.go": true, "internal/factory/pid_unix.go": true, "internal/normalize/open_unix.go": true,
		"internal/artifact/safe.go": true}
	// Every word an argument vector in internal/act is built from; any other string in a []string
	// literal there fails. Values a person gives are only ever appended as --name=value (args.go).
	argvWords := map[string]bool{"-I": true, "-B": true, "decide": true, "--json": true, "do": true, "factory": true, "status": true, "stop": true,
		"--via=floor": true, "skills": true, "run": true, "scripts": true, "run.py": true, ".claude": true, "mach": true}
	// Anywhere: these never appear in a string. In internal/act, which alone runs anything: no word
	// that would enable, start, resume, pause or dispatch the Factory.
	neverNamed := []string{"factory enable", "factory start", "--persistent"}
	neverInAct := regexp.MustCompile(`\b(dispatch|pull|enable|start|resume|pause|serve|tick|wake)\b`)
	vectorFiles := map[string]bool{"internal/act/act.go": true, "internal/act/args.go": true}
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
			if forbiddenImports[p] && !(p == "os/exec" && execAllowed[rel]) {
				t.Errorf("%s imports %s", rel, p)
			}
		}
		inAct := strings.HasPrefix(rel, "internal/act/")
		ast.Inspect(f, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.BasicLit:
				if x.Kind != token.STRING {
					return true
				}
				v, _ := strconv.Unquote(x.Value)
				for _, word := range neverNamed {
					if strings.Contains(v, word) {
						t.Errorf("%s names %q: the observer never enables or starts the Factory", rel, word)
					}
				}
				if inAct && neverInAct.MatchString(v) {
					t.Errorf("%s: %q: internal/act never names a command that enables, starts, resumes or dispatches work", rel, v)
				}
				if inAct && !strings.Contains(v, " ") && strings.HasSuffix(v, ".py") && v != "run.py" {
					t.Errorf("%s names the script %q: only run.py is run", rel, v)
				}
			case *ast.CompositeLit:
				if arr, ok := x.Type.(*ast.ArrayType); ok && vectorFiles[rel] {
					if id, ok := arr.Elt.(*ast.Ident); ok && id.Name == "string" {
						for _, el := range x.Elts {
							if lit, ok := el.(*ast.BasicLit); ok {
								v, _ := strconv.Unquote(lit.Value)
								if !argvWords[v] {
									t.Errorf("%s builds an argument vector with %q", rel, v)
								}
							}
						}
					}
				}
			}
			return true
		})
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
				if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == "syscall" && sel.Sel.Name == "Kill" && rel != "internal/act/exec_unix.go" {
					if lit, ok := call.Args[1].(*ast.BasicLit); !ok || lit.Value != "0" {
						t.Errorf("%s: syscall.Kill with a signal: only internal/act stops the process group it started", rel)
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
