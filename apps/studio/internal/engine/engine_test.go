package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"mach/studio/internal/engine"
	"mach/studio/internal/testkit"
)

func do(t *testing.T, e *engine.Engine, op, body string) engine.Envelope {
	t.Helper()
	return e.Do(context.Background(), op, []byte(body))
}

func mustOK(t *testing.T, e *engine.Engine, op, body string) map[string]any {
	t.Helper()
	env := do(t, e, op, body)
	if !env.OK {
		t.Fatalf("%s %s: %+v", op, body, env.Error)
	}
	var data map[string]any
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatalf("%s: data is not an object: %v", op, err)
	}
	return data
}

func mustFail(t *testing.T, e *engine.Engine, op, body, kind, says string) {
	t.Helper()
	env := do(t, e, op, body)
	if env.OK || env.Error.Kind != kind || !strings.Contains(env.Error.Message, says) {
		t.Fatalf("%s %s: want %s mentioning %q, got %+v %s", op, body, kind, says, env.Error, env.Data)
	}
}

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return data
}

// Every operation, run through the allowlist against the real engine in a real project.
func TestEveryOperationAgainstTheRealEngine(t *testing.T) {
	project := testkit.NewProject(t)
	e := testkit.NewEngine(t, project)

	if where := mustOK(t, e, "where", ``); where["workspace"] != testkit.Draft(project) {
		t.Fatalf("where: %v", where["workspace"])
	}
	mustOK(t, e, "status", ``)
	mustOK(t, e, "validate", `{}`)
	if refreshed := mustOK(t, e, "refresh", `{}`); refreshed["refreshed"] != false {
		t.Fatalf("refresh without a shared repository: %v", refreshed)
	}
	mustOK(t, e, "project.init", `{"id":"team-space","name":"Team Space","vision":"Teams work together.","outcome":["Teams can work together"]}`)
	mustOK(t, e, "project.set", `{"name":"Team Rooms"}`)
	if name := readJSON(t, testkit.Draft(project, "product", "project.json"))["name"]; name != "Team Rooms" {
		t.Fatalf("project.set did not reach the engine: %v", name)
	}
	epic := mustOK(t, e, "epic.add", `{"title":"Team membership","criterion":["Only invited people can join"]}`)["epic"].(map[string]any)
	if epic["epic_id"] != "EPIC-001" {
		t.Fatalf("epic.add: %v", epic)
	}
	mustOK(t, e, "epic.set", `{"epic_id":"EPIC-001","title":"Membership"}`)
	if title := readJSON(t, testkit.Draft(project, "product", "epics", "EPIC-001.json"))["title"]; title != "Membership" {
		t.Fatalf("epic.set: %v", title)
	}
	mustOK(t, e, "slice.new", `{"epic":"EPIC-001","title":"Invite a teammate"}`)
	mustOK(t, e, "slice.set", `{"slice_id":"SLICE-001","depends_on":[]}`)
	mustOK(t, e, "slice.resume", `{"slice_id":"SLICE-001"}`)
	mustOK(t, e, "slice.resume", `{}`)
	mustOK(t, e, "slice.pause", `{"slice_id":"SLICE-001","note":"Next: do invitations expire?"}`)

	// No spec yet: exit 1 with a JSON report is still a successful check.
	check := mustOK(t, e, "slice.check", `{"slice_id":"SLICE-001"}`)
	if check["ready"] != false || len(check["errors"].([]any)) == 0 {
		t.Fatalf("slice.check without a spec: %v", check)
	}
	if err := os.WriteFile(testkit.Draft(project, "specs", "slices", testkit.SpecName), testkit.Fixture(t), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(testkit.Draft(project, "product", "intents", "SLICE-001.md"), []byte(testkit.IntentText), 0o644); err != nil {
		t.Fatal(err)
	}
	if check := mustOK(t, e, "slice.check", `{"slice_id":"SLICE-001","ready":true}`); check["ready"] != true || check["status"] != "ready_for_approval" {
		t.Fatalf("slice.check of a ready slice: %v", check)
	}
	if shown := mustOK(t, e, "slice.show", `{"slice_id":"SLICE-001"}`); shown["editable"] != true {
		t.Fatalf("slice.show: %v", shown)
	}
	mustFail(t, e, "slice.approve", `{"slice_id":"SLICE-001"}`, engine.KindRefused, "epic EPIC-001 is proposed")
	if env := do(t, e, "slice.approve", `{"slice_id":"SLICE-001"}`); strings.Contains(env.Error.Message, "studio.py") ||
		string(env.Error.Hint) != `{"kind": "approve_epic", "target": "EPIC-001"}` {
		t.Fatalf("the app's refusal: %q hint %s", env.Error.Message, env.Error.Hint)
	}
	mustOK(t, e, "epic.approve", `{"epic_id":"EPIC-001"}`)
	mustOK(t, e, "slice.approve", `{"slice_id":"SLICE-001"}`)
	if shown := mustOK(t, e, "slice.show", `{"slice_id":"SLICE-001"}`); shown["editable"] != false {
		t.Fatalf("an approved slice is not editable: %v", shown["editable"])
	}
	mustFail(t, e, "slice.check", `{"slice_id":"SLICE-001"}`, engine.KindRefused, "reopen it first")

	// The fixture spec reserves SLICE-002 to SLICE-004 for deferred features, so the engine picks the next.
	second := mustOK(t, e, "slice.new", `{"epic":"EPIC-001","title":"Remove a teammate"}`)["slice"].(map[string]any)["slice_id"].(string)
	mustOK(t, e, "wave.new", `{"slice":["SLICE-001"]}`)
	mustOK(t, e, "wave.add", `{"wave_id":"WAVE-001","slice_ids":["`+second+`"]}`)
	mustOK(t, e, "wave.remove", `{"wave_id":"WAVE-001","slice_ids":["`+second+`"]}`)
	if wave := mustOK(t, e, "wave.approve", `{"wave_id":"WAVE-001","actor":"Pat PM"}`)["wave"].(map[string]any); wave["status"] != "approved_for_engineering" {
		t.Fatalf("wave.approve: %v", wave)
	}
	mustFail(t, e, "send.preview", `{"wave_id":"WAVE-001"}`, engine.KindRefused, "not connected to a shared repository")
	mustFail(t, e, "send", `{"wave_id":"WAVE-001"}`, engine.KindRefused, "not connected to a shared repository")
	mustOK(t, e, "feedback", `{}`)
	mustOK(t, e, "feedback", `{"wave_id":"WAVE-001"}`)
	mustFail(t, e, "reconcile", `{"artifact":"SLICE-001","take":"mine"}`, engine.KindRefused, "needs reconciling")
	if reopened := mustOK(t, e, "slice.reopen", `{"slice_id":"SLICE-001"}`); fmt.Sprint(reopened["waves_returned_to_draft"]) != "[WAVE-001]" {
		t.Fatalf("slice.reopen: %v", reopened)
	}
	if renumbered := mustOK(t, e, "slice.renumber", `{"identifier":"`+second+`"}`)["renumbered"].(map[string]any); renumbered["from"] != second {
		t.Fatalf("slice.renumber: %v", renumbered)
	}
	mustOK(t, e, "epic.add", `{"title":"Billing","criterion":["Invoices are correct"]}`)
	mustOK(t, e, "epic.renumber", `{"identifier":"EPIC-002"}`)
	mustOK(t, e, "wave.renumber", `{"identifier":"WAVE-001"}`)
	mustFail(t, e, "project.set", `{"status":"bogus"}`, engine.KindInvalid, "invalid choice")
	mustFail(t, e, "slice.show", `{"slice_id":"SLICE-099"}`, engine.KindRefused, "No slice SLICE-099")
	mustFail(t, e, "no.such.op", `{}`, engine.KindInvalid, "no operation")
}

// fakeEngine writes a stand-in for studio.py, to drive the envelope mapping through every case.
func fakeEngine(t *testing.T, body string, adjust ...func(*engine.Config)) *engine.Engine {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "studio.py")
	if err := os.WriteFile(script, []byte("import sys, time\n"+body+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := engine.Config{Python: testkit.Python(t), Script: script, Project: dir}
	for _, f := range adjust {
		f(&cfg)
	}
	e, err := engine.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestEnvelopeMapping(t *testing.T) {
	cases := []struct {
		name, script, op string
		ok               bool
		kind, says       string
	}{
		{"exit 0 with JSON", `print('{"a": 1}')`, "status", true, "", ""},
		{"exit 0 without JSON", `print('hello')`, "status", false, engine.KindInternal, "not JSON"},
		{"refusal", `sys.stderr.write("refused: SLICE-001 cannot be approved yet:\n  epic EPIC-001 is proposed\n"); sys.exit(1)`,
			"slice.approve", false, engine.KindRefused, "SLICE-001 cannot be approved yet:\n  epic EPIC-001 is proposed"},
		{"refusal with a hint", `sys.stderr.write('refused-hint: {"kind": "approve_epic", "target": "EPIC-001"}\nrefused: SLICE-001 cannot be approved yet\n'); sys.exit(1)`,
			"slice.approve", false, engine.KindRefused, "SLICE-001 cannot be approved yet"},
		{"check with problems", `print('{"ready": false, "errors": ["x"]}'); sys.exit(1)`, "slice.check", true, "", ""},
		{"validate with problems", `print('{"valid": false}'); sys.exit(1)`, "validate", true, "", ""},
		{"JSON with exit 1 elsewhere", `print('{"a": 1}'); sys.exit(1)`, "epic.approve", false, engine.KindInternal, "exit code 1"},
		{"usage error", `sys.stderr.write("usage: studio.py\nstudio.py: error: argument --status: invalid choice\n"); sys.exit(2)`,
			"project.set", false, engine.KindInvalid, "argument --status: invalid choice"},
		{"crash", `raise RuntimeError("SECRET-CONTENT from a file")`, "status", false, engine.KindInternal, "failed unexpectedly"},
		{"other exit", `sys.exit(3)`, "status", false, engine.KindInternal, "exit code 3"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env := fakeEngine(t, c.script).Do(context.Background(), c.op, []byte(bodyFor(c.op)))
			if env.OK != c.ok {
				t.Fatalf("ok=%v, want %v: %+v", env.OK, c.ok, env.Error)
			}
			if !c.ok && (env.Error.Kind != c.kind || !strings.Contains(env.Error.Message, c.says)) {
				t.Fatalf("got %+v, want %s mentioning %q", env.Error, c.kind, c.says)
			}
			if !c.ok && strings.Contains(env.Error.Message, "SECRET") {
				t.Fatalf("an internal error leaked engine output: %q", env.Error.Message)
			}
		})
	}
}

func bodyFor(op string) string {
	switch op {
	case "slice.approve", "slice.check":
		return `{"slice_id":"SLICE-001"}`
	case "epic.approve":
		return `{"epic_id":"EPIC-001"}`
	}
	return `{}`
}

func TestTheEngineIsRunWithAFixedVector(t *testing.T) {
	e := fakeEngine(t, `import json; print(json.dumps({"argv": sys.argv[1:], "flags": sys.flags.isolated}))`)
	env := e.Do(context.Background(), "slice.new", []byte(`{"epic":"EPIC-001","title":"$(touch pwned); --id=SLICE-009"}`))
	if !env.OK {
		t.Fatal(env.Error)
	}
	var got struct {
		Argv  []string `json:"argv"`
		Flags int      `json:"flags"`
	}
	json.Unmarshal(env.Data, &got)
	want := []string{"--project", e.Project(), "--app", "slice", "new", "--epic=EPIC-001", "--title=$(touch pwned); --id=SLICE-009"}
	if fmt.Sprint(got.Argv) != fmt.Sprint(want) || got.Flags != 1 {
		t.Fatalf("argv %q isolated=%d", got.Argv, got.Flags)
	}
	if _, err := os.Stat(filepath.Join(e.Project(), "pwned")); err == nil {
		t.Fatal("a shell ran")
	}
}

func TestTimeLimitAndOutputBound(t *testing.T) {
	slow := fakeEngine(t, `time.sleep(20)`, func(c *engine.Config) { c.Timeout = 300 * time.Millisecond })
	started := time.Now()
	env := slow.Do(context.Background(), "status", nil)
	if env.OK || env.Error.Kind != engine.KindInternal || !strings.Contains(env.Error.Message, "did not finish") {
		t.Fatalf("timeout: %+v", env.Error)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatalf("the time limit did not stop the engine (%s)", time.Since(started))
	}
	big := fakeEngine(t, `sys.stdout.write("{" + "x" * 100000)`, func(c *engine.Config) { c.MaxStdout = 1024 })
	if env := big.Do(context.Background(), "status", nil); env.OK || !strings.Contains(env.Error.Message, "larger than") {
		t.Fatalf("output bound: %+v", env.Error)
	}
	noisy := fakeEngine(t, `sys.stderr.write("e" * 100000); sys.exit(1)`, func(c *engine.Config) { c.MaxStderr = 1024 })
	if env := noisy.Do(context.Background(), "status", nil); env.OK || !strings.Contains(env.Error.Message, "larger than") {
		t.Fatalf("stderr bound: %+v", env.Error)
	}
}

// Two writes to the same slice at once: serialised, so both succeed and the artifact is whole.
func TestConcurrentMutationsAreSerialised(t *testing.T) {
	project := testkit.NewProject(t)
	e := testkit.NewEngine(t, project)
	mustOK(t, e, "project.init", `{"id":"team-space","name":"Team","vision":"V","outcome":["O"]}`)
	mustOK(t, e, "epic.add", `{"title":"Team membership","criterion":["c"]}`)
	mustOK(t, e, "slice.new", `{"epic":"EPIC-001","title":"Start"}`)

	var wg sync.WaitGroup
	results := make([]engine.Envelope, 2)
	for i, title := range []string{"First title", "Second title"} {
		wg.Add(1)
		go func(i int, title string) {
			defer wg.Done()
			results[i] = e.Do(context.Background(), "slice.set", []byte(`{"slice_id":"SLICE-001","title":"`+title+`"}`))
		}(i, title)
	}
	wg.Wait()
	for i, env := range results {
		if !env.OK || !json.Valid(env.Data) {
			t.Fatalf("request %d: %+v", i, env.Error)
		}
	}
	work := readJSON(t, testkit.Draft(project, "product", "slices", "SLICE-001.json"))
	if work["revision"] != float64(3) {
		t.Fatalf("both changes should be applied in turn (revision 3), got %v", work["revision"])
	}
	if work["title"] != "First title" && work["title"] != "Second title" {
		t.Fatalf("title %v", work["title"])
	}
}

func TestASecondRequestWaitsThenReportsAConflict(t *testing.T) {
	e := fakeEngine(t, `print("{}")`, func(c *engine.Config) { c.LockWait = 100 * time.Millisecond })
	release := make(chan struct{})
	held := make(chan struct{})
	go e.Transaction(context.Background(), func(*engine.Tx) engine.Envelope {
		close(held)
		<-release
		return engine.OKValue(nil)
	})
	<-held
	env := e.Do(context.Background(), "status", nil)
	close(release)
	if env.OK || env.Error.Kind != engine.KindConflict {
		t.Fatalf("want conflict, got %+v", env)
	}
	if env := e.Do(context.Background(), "status", nil); !env.OK {
		t.Fatalf("after the first finished: %+v", env.Error)
	}
}

func TestLocateScript(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	write := func(rel string) string {
		path := filepath.Join(dir, rel)
		os.MkdirAll(filepath.Dir(path), 0o755)
		os.WriteFile(path, []byte("# stand-in\n"), 0o644)
		return path
	}
	plugin := write("plugin/skills/product-studio/scripts/studio.py")
	binary := write("plugin/apps/studio/bin/mach-studio")
	got, err := engine.LocateScript("", binary, "")
	if err != nil || got.Script != plugin || got.Install != "plugin" {
		t.Fatalf("plugin layout: %+v %v", got, err)
	}
	installed := write("project/.claude/skills/mach-product-studio/scripts/studio.py")
	bin := write("project/.claude/bin/mach-studio")
	if got, err := engine.LocateScript("", bin, ""); err != nil || got.Script != installed || got.Install != "project" {
		t.Fatalf("project install next to the binary: %+v %v", got, err)
	}
	if got, err := engine.LocateScript("", write("elsewhere/mach-studio"), filepath.Join(dir, "project")); err != nil || got.Script != installed {
		t.Fatalf("project install found from the project: %+v %v", got, err)
	}
	if got, err := engine.LocateScript(plugin, binary, ""); err != nil || got.Install != "explicit" {
		t.Fatalf("explicit: %+v %v", got, err)
	}
	if _, err := engine.LocateScript(filepath.Join(dir, "missing.py"), "", ""); err == nil {
		t.Fatal("a missing explicit script must be an error")
	}
	if _, err := engine.LocateScript("", write("nowhere/mach-studio"), filepath.Join(dir, "nowhere")); err == nil || !strings.Contains(err.Error(), "--engine") {
		t.Fatalf("nothing found: %v", err)
	}
}

func TestFindProject(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	deep := filepath.Join(dir, "repo", "a", "b")
	os.MkdirAll(deep, 0o755)
	os.Mkdir(filepath.Join(dir, "repo", ".git"), 0o755)
	if got, _ := engine.FindProject(deep); got != filepath.Join(dir, "repo") {
		t.Fatalf("nearest .git: %s", got)
	}
	os.MkdirAll(filepath.Join(dir, "repo", "a", ".factory"), 0o755)
	if got, _ := engine.FindProject(deep); got != filepath.Join(dir, "repo", "a") {
		t.Fatalf("the tool folder wins over .git: %s", got)
	}
	cell := filepath.Join(dir, "repo", ".factory", "worktrees", "LOCAL-001", "repo", "src")
	os.MkdirAll(cell, 0o755)
	if got, _ := engine.FindProject(cell); got != filepath.Join(dir, "repo") {
		t.Fatalf("inside a cell: %s", got)
	}
}
