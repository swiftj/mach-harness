package act

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeRunPy is a tiny run.py: it records its arguments, environment and working folder to a file
// outside the project, prints what its mode file says, and exits with the code it says. It never
// touches the project.
const fakeRunPy = `import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
record = os.environ.get("FAKE_RECORD") or os.path.join(here, "calls.jsonl")
answers = None
for a in sys.argv[1:]:
    if a.startswith("--answers-file="):
        with open(a.split("=", 1)[1]) as f:
            answers = json.load(f)
with open(record, "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "git": [k for k in os.environ if k.startswith("GIT_")],
                        "exec": "MACH_EXECUTION_ID" in os.environ, "answers": answers}) + "\n")
mode = json.load(open(os.path.join(here, "mode.json")))
if mode.get("sleep"):
    time.sleep(mode["sleep"])
if mode.get("flood"):
    sys.stdout.write("x" * mode["flood"])
sys.stdout.write(mode.get("stdout", "{}"))
sys.stderr.write(mode.get("stderr", ""))
sys.exit(mode.get("code", 0))
`

type fake struct {
	dir, script, project, scratch string
}

func newFake(t *testing.T) (*fake, *Runner) {
	t.Helper()
	python, err := LocatePython("")
	if err != nil {
		t.Skip("python3 is not on PATH")
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	f := &fake{dir: dir, script: filepath.Join(dir, "mach", "run.py"), project: filepath.Join(dir, "project")}
	f.scratch = filepath.Join(f.project, ".factory", "local", "observer")
	os.MkdirAll(filepath.Dir(f.script), 0o755)
	os.MkdirAll(f.scratch, 0o700)
	os.WriteFile(f.script, []byte(fakeRunPy), 0o644)
	f.mode(t, map[string]any{"stdout": `{"ok": 1}`})
	r, err := New(Config{Python: python, Script: f.script, Project: f.project, Scratch: f.scratch})
	if err != nil {
		t.Fatal(err)
	}
	return f, r
}

func (f *fake) mode(t *testing.T, m map[string]any) {
	t.Helper()
	b, _ := json.Marshal(m)
	os.WriteFile(filepath.Join(filepath.Dir(f.script), "mode.json"), b, 0o644)
}

type call struct {
	Argv    []string `json:"argv"`
	Cwd     string   `json:"cwd"`
	Git     []string `json:"git"`
	Exec    bool     `json:"exec"`
	Answers any      `json:"answers"`
}

func (f *fake) calls(t *testing.T) []call {
	t.Helper()
	b, _ := os.ReadFile(filepath.Join(filepath.Dir(f.script), "calls.jsonl"))
	var out []call
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if line == "" {
			continue
		}
		var c call
		json.Unmarshal([]byte(line), &c)
		out = append(out, c)
	}
	return out
}

func str(s string) *string { return &s }

// The four requests run exactly these vectors, with values as --name=value, in the project, without
// Git's variables or the execution's ID.
func TestFixedVectors(t *testing.T) {
	f, r := newFake(t)
	t.Setenv("GIT_DIR", "/elsewhere")
	t.Setenv("GIT_SSH_COMMAND", "ssh")
	t.Setenv("MACH_EXECUTION_ID", "x0123456789ab")
	ctx := context.Background()
	for _, reply := range []Reply{r.Needs(ctx), r.Status(ctx), r.Stop(ctx),
		r.Decide(ctx, Decision{Ticket: "T-1", Option: "send-back", Body: Body{By: str("-rf A"), Reason: str("--json because\nit is wrong")}}, nil),
		r.Decide(ctx, Decision{Ticket: "T-2", Option: "accept", Body: Body{ADRs: []string{"ADR-0007", "ADR-0008"}}}, nil),
		r.Decide(ctx, Decision{Ticket: "T-3", Option: "set-test-command", Body: Body{TestCmd: str("make test"), Reason: str("the old one is gone")}}, nil),
		r.Decide(ctx, Decision{Ticket: "6", Option: "carry-on", Body: Body{Guidance: str("--json; rm -rf / `x` $(y)\nKeep the date in UTC.")}}, nil),
		r.Decide(ctx, Decision{Ticket: "6", Option: "carry-on"}, nil),
	} {
		if !reply.OK() || string(reply.Data) != `{"ok": 1}` {
			t.Fatalf("%+v", reply)
		}
	}
	head := []string{"-I", "-B", f.script, "--project=" + f.project}
	want := [][]string{
		{"decide", "--json"},
		{"factory", "status"},
		{"factory", "stop"},
		{"decide", "do", "T-1", "send-back", "--by=-rf A", "--reason=--json because\nit is wrong", "--via=floor", "--json"},
		{"decide", "do", "T-2", "accept", "--adr=ADR-0007", "--adr=ADR-0008", "--via=floor", "--json"},
		{"decide", "do", "T-3", "set-test-command", "--reason=the old one is gone", "--test-cmd=make test", "--via=floor", "--json"},
		// The guidance is one argument, as written: never a shell string, never read as another option.
		{"decide", "do", "6", "carry-on", "--guidance=--json; rm -rf / `x` $(y)\nKeep the date in UTC.", "--via=floor", "--json"},
		{"decide", "do", "6", "carry-on", "--via=floor", "--json"},
	}
	calls := f.calls(t)
	if len(calls) != len(want) {
		t.Fatalf("%d calls", len(calls))
	}
	for i, c := range calls {
		if strings.Join(c.Argv, "\x00") != strings.Join(append([]string{"--project=" + f.project}, want[i]...), "\x00") {
			t.Errorf("call %d: %q", i, c.Argv)
		}
		if c.Cwd != f.project || len(c.Git) != 0 || c.Exec {
			t.Errorf("call %d ran in %s with Git variables %v, execution %v", i, c.Cwd, c.Git, c.Exec)
		}
	}
	if got := r.Argv([]string{"decide", "--json"}); strings.Join(got[:4], " ") != strings.Join(head, " ") {
		t.Fatalf("%q", got)
	}
}

// Answers go through a private file in the observer's folder, removed afterwards.
func TestAnswersFile(t *testing.T) {
	f, r := newFake(t)
	reply := r.Decide(context.Background(), Decision{Ticket: "T-1", Option: "answers", Body: Body{Answers: []Answer{{N: 1, Answer: str("Yes, weekly.")}, {N: 2, LeaveOpen: true}}}}, nil)
	if !reply.OK() {
		t.Fatalf("%+v", reply)
	}
	c := f.calls(t)[0]
	file := ""
	for _, a := range c.Argv {
		if v, ok := strings.CutPrefix(a, "--answers-file="); ok {
			file = v
		}
	}
	if filepath.Dir(file) != f.scratch {
		t.Fatalf("answers file %q", file)
	}
	if b, _ := json.Marshal(c.Answers); string(b) != `[{"answer":"Yes, weekly.","n":1},{"leave_open":true,"n":2}]` {
		t.Fatalf("answers %s", b)
	}
	if _, err := os.Lstat(file); err == nil {
		t.Fatal("the answers file outlived the run")
	}
	entries, _ := os.ReadDir(f.scratch)
	if len(entries) != 0 {
		t.Fatalf("left behind: %v", entries)
	}
}

func TestResultsMapped(t *testing.T) {
	f, r := newFake(t)
	ctx := context.Background()
	f.mode(t, map[string]any{"code": 1, "stderr": "refused: \"merge\" is not on offer for T-1 now, so nothing was recorded.\n"})
	if got := r.Needs(ctx); got.Kind != KindRefused || !strings.HasPrefix(got.Message, `"merge" is not on offer`) {
		t.Fatalf("%+v", got)
	}
	f.mode(t, map[string]any{"code": 2, "stderr": "usage: run.py\nrun.py: error: argument --via: invalid choice\n"})
	if got := r.Needs(ctx); got.Kind != KindInvalid || !strings.Contains(got.Message, "argument --via") {
		t.Fatalf("%+v", got)
	}
	f.mode(t, map[string]any{"stdout": "not json"})
	if got := r.Needs(ctx); got.Kind != KindFailed {
		t.Fatalf("%+v", got)
	}
	f.mode(t, map[string]any{"code": 3, "stdout": "{}"})
	if got := r.Needs(ctx); got.Kind != KindFailed || !strings.Contains(got.Message, "exit code 3") {
		t.Fatalf("%+v", got)
	}
	f.mode(t, map[string]any{"flood": 5 << 20})
	if got := r.Needs(ctx); got.Kind != KindFailed || !strings.Contains(got.Message, "larger") {
		t.Fatalf("%+v", got)
	}
}

// A time limit kills the whole process group, children included.
func TestTimeoutKillsTheGroup(t *testing.T) {
	f, r := newFake(t)
	r.cfg.ReadTimeout = 500 * time.Millisecond
	child := filepath.Join(f.dir, "child.pid")
	os.WriteFile(f.script, []byte("import subprocess, sys, time\np = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\nopen("+quote(child)+", 'w').write(str(p.pid))\ntime.sleep(30)\n"), 0o644)
	started := time.Now()
	got := r.Needs(context.Background())
	if got.Kind != KindFailed || !strings.Contains(got.Message, "did not finish") || time.Since(started) > 10*time.Second {
		t.Fatalf("%+v after %s", got, time.Since(started))
	}
	b, err := os.ReadFile(child)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if out, _ := exec.Command("ps", "-p", strings.TrimSpace(string(b)), "-o", "stat=").Output(); strings.TrimSpace(string(out)) == "" || strings.HasPrefix(strings.TrimSpace(string(out)), "Z") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the child outlived the time limit")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func quote(s string) string { b, _ := json.Marshal(s); return string(b) }

// One decision at a time: a second waits its turn for BusyWait, then is a conflict that says it is
// recorded after the first (never "nothing was recorded"), and nothing of it runs.
func TestOneDecisionAtATime(t *testing.T) {
	f, r := newFake(t)
	r.cfg.BusyWait = 200 * time.Millisecond
	f.mode(t, map[string]any{"sleep": 1.5, "stdout": "{}"})
	done := make(chan Reply)
	go func() { done <- r.Decide(context.Background(), Decision{Ticket: "T-1", Option: "retry"}, nil) }()
	time.Sleep(400 * time.Millisecond)
	if got := r.Decide(context.Background(), Decision{Ticket: "T-2", Option: "retry"}, nil); got.Kind != KindConflict || got.Message != BusyMessage {
		t.Fatalf("%+v", got)
	}
	if got := r.Stop(context.Background()); got.Kind != KindConflict || strings.Contains(got.Message, "again") {
		t.Fatalf("stop while deciding: %+v", got)
	}
	if got := <-done; !got.OK() {
		t.Fatalf("%+v", got)
	}
	if n := len(f.calls(t)); n != 1 {
		t.Fatalf("%d runs", n)
	}
}

// A second decision that comes while the first is nearly done waits for it and is then run.
func TestASecondDecisionWaitsItsTurn(t *testing.T) {
	f, r := newFake(t)
	r.cfg.BusyWait = 5 * time.Second
	f.mode(t, map[string]any{"sleep": 0.6, "stdout": "{}"})
	done := make(chan Reply)
	go func() { done <- r.Decide(context.Background(), Decision{Ticket: "T-1", Option: "retry"}, nil) }()
	time.Sleep(200 * time.Millisecond)
	if got := r.Decide(context.Background(), Decision{Ticket: "T-2", Option: "retry"}, nil); !got.OK() {
		t.Fatalf("the second decision: %+v", got)
	}
	if got := <-done; !got.OK() {
		t.Fatalf("%+v", got)
	}
	if n := len(f.calls(t)); n != 2 {
		t.Fatalf("%d runs", n)
	}
}

// run.py waited for a decision made elsewhere (a terminal's) and recorded nothing yet: a conflict,
// with the same sentence, so the page asks again.
func TestRunPyBusyIsAConflict(t *testing.T) {
	f, r := newFake(t)
	f.mode(t, map[string]any{"stdout": `{"ticket_id": "T-1", "option": "approve", "done": false, "busy": true, "now": "Recording after another decision finishes."}`})
	if got := r.Decide(context.Background(), Decision{Ticket: "T-1", Option: "approve"}, nil); got.Kind != KindConflict || got.Message != BusyMessage {
		t.Fatalf("%+v", got)
	}
}

// What a decision on a ticket another worker holds, a take-over and a decision another person made
// moot give the page.
func TestDecidedWarningsTakeOverAndAlreadyDecided(t *testing.T) {
	d := ParseDecided([]byte(`{"ticket_id": "T-1", "option": "approve", "done": true, "by": "Ann Lee",
		"warnings": ["Another worker was handed this ticket's review step at 02:47 UTC and may still be at work."],
		"now": "Ann Lee's approval of T-1 is recorded."}`))
	if !d.Done || len(d.Warnings) != 1 || !strings.HasPrefix(d.Warnings[0], "Another worker was handed") || d.AlreadyDecided {
		t.Fatalf("%+v", d)
	}
	d = ParseDecided([]byte(`{"ticket_id": "T-1", "option": "take-over", "done": true, "by": "Ann Lee", "took_over": {"taken": true, "step": "build"},
		"now": "Ann Lee took over T-1's build step. The other worker is stopped at its next step."}`))
	if !d.TookOver || d.Now == nil || !strings.HasPrefix(*d.Now, "You took over T-1's build step.") {
		t.Fatalf("%+v %v", d, *d.Now)
	}
	d = ParseDecided([]byte(`{"ticket_id": "T-1", "option": "approve", "done": false, "already_decided": true, "by": "Bo Ek",
		"decided": {"option": "approve", "at": "2026-11-25T14:02:00Z", "via": "floor"},
		"now": "Approved by Dana at 14:02 UTC. It is now waiting for the merge."}`))
	if !d.AlreadyDecided || d.Done || d.DecidedAt == nil || *d.DecidedAt != "2026-11-25T14:02:00Z" || *d.Now != "Approved by Dana at 14:02 UTC. It is now waiting for the merge." {
		t.Fatalf("%+v", d)
	}
	if d = ParseDecided([]byte(`{"done": false, "already_decided": true, "decided": {"at": "<script>"}}`)); d.DecidedAt != nil || d.Warnings == nil {
		t.Fatalf("%+v", d)
	}
}

// What is refused before run.py sees it.
func TestDecisionChecks(t *testing.T) {
	_, r := newFake(t)
	long := strings.Repeat("x", MaxReason+1)
	for name, d := range map[string]Decision{
		"ticket with a dash first": {Ticket: "-T", Option: "retry"},
		"ticket with a slash":      {Ticket: "T/1", Option: "retry"},
		"ticket with dots":         {Ticket: "T..1", Option: "retry"},
		"unknown option":           {Ticket: "T-1", Option: "audit"},
		"option shape":             {Ticket: "T-1", Option: "--json"},
		"interview":                {Ticket: "T-1", Option: "interview"},
		"name with a newline":      {Ticket: "T-1", Option: "retry", Body: Body{By: str("A\nB")}},
		"empty name":               {Ticket: "T-1", Option: "retry", Body: Body{By: str("  ")}},
		"reason with NUL":          {Ticket: "T-1", Option: "send-back", Body: Body{Reason: str("a\x00b")}},
		"reason with ESC":          {Ticket: "T-1", Option: "send-back", Body: Body{Reason: str("a\x1b[2Jb")}},
		"reason too long":          {Ticket: "T-1", Option: "send-back", Body: Body{Reason: &long}},
		"bad ADR":                  {Ticket: "T-1", Option: "accept", Body: Body{ADRs: []string{"ADR-7"}}},
		"test command with a line": {Ticket: "T-1", Option: "set-test-command", Body: Body{TestCmd: str("make\nrm -rf /")}},
		"answers elsewhere":        {Ticket: "T-1", Option: "retry", Body: Body{Answers: []Answer{{N: 1, LeaveOpen: true}}}},
		"no answers":               {Ticket: "T-1", Option: "answers"},
		"answer twice":             {Ticket: "T-1", Option: "answers", Body: Body{Answers: []Answer{{N: 1, LeaveOpen: true}, {N: 1, Answer: str("a")}}}},
		"answer and open":          {Ticket: "T-1", Option: "answers", Body: Body{Answers: []Answer{{N: 1, LeaveOpen: true, Answer: str("a")}}}},
		"guidance elsewhere":       {Ticket: "T-1", Option: "retry", Body: Body{Guidance: str("do it better")}},
		"guidance with ESC":        {Ticket: "T-1", Option: "carry-on", Body: Body{Guidance: str("a\x1b[2Jb")}},
		"guidance blank":           {Ticket: "T-1", Option: "carry-on", Body: Body{Guidance: str("  \n ")}},
		"guidance too long":        {Ticket: "T-1", Option: "carry-on", Body: Body{Guidance: str(strings.Repeat("y", MaxGuidance+1))}},
	} {
		if got := r.Decide(context.Background(), d, nil); got.Kind != KindInvalid {
			t.Errorf("%s: %+v", name, got)
		}
	}
	// "wait" only when the list offers it now with do: true.
	if got := r.Decide(context.Background(), Decision{Ticket: "T-1", Option: "wait"}, func(t, o string) bool { return t == "T-1" && o == "wait" }); !got.OK() {
		t.Fatalf("%+v", got)
	}
	if got := r.Decide(context.Background(), Decision{Ticket: "T-1", Option: "wait"}, nil); got.Kind != KindInvalid {
		t.Fatalf("%+v", got)
	}
	// Guidance on another option only when the list offered it with takes: ["guidance"].
	takes := func(t, o string) bool { return t == "T-1" && (o == "revise" || o == TakesKey("revise", "guidance")) }
	if got := r.Decide(context.Background(), Decision{Ticket: "T-1", Option: "revise", Body: Body{Guidance: str("smaller steps")}}, takes); !got.OK() {
		t.Fatalf("%+v", got)
	}
}

func TestDecodeBody(t *testing.T) {
	for _, bad := range []string{`[]`, `{"by": 1}`, `{"who": "a"}`, `{} {}`, `{"by": "a"`} {
		if _, err := DecodeBody([]byte(bad)); err == nil {
			t.Errorf("%s was accepted", bad)
		}
	}
	b, err := DecodeBody([]byte(`{"by": "Ann", "answers": [{"n": 1, "answer": "x"}, {"n": 2, "leave_open": true}]}`))
	if err != nil || *b.By != "Ann" || len(b.Answers) != 2 {
		t.Fatalf("%+v %v", b, err)
	}
}

func TestParseDecidedTakesTheNameOut(t *testing.T) {
	d := ParseDecided([]byte(`{"ticket_id": "T-1", "option": "approve", "done": true, "by": "Ann  Lee", "via": "floor",
		"now": "Ann Lee's approval of T-1 is recorded. The Factory carries it on in the background: it merges or waits.",
		"station": {"answer": {"by": "Ann Lee"}}, "supervisor": "woken", "unparked": false, "pid": 4242}`))
	b, _ := json.Marshal(d)
	if strings.Contains(string(b), "Ann") || strings.Contains(string(b), "4242") || d.Now == nil || !strings.HasPrefix(*d.Now, "Your approval of T-1") || *d.Supervisor != "woken" {
		t.Fatalf("%s", b)
	}
	c := ParseDecided([]byte(`{"ticket_id": "T-1", "option": "exception", "done": false, "in_conversation": true, "command": "/mach decide T-1", "why": "A security exception is read with an agent."}`))
	if !c.InConversation || *c.Command != "/mach decide T-1" || c.Why == nil {
		t.Fatalf("%+v", c)
	}
}

func TestParseStatusIsDefensive(t *testing.T) {
	now := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	got := ParseStatus([]byte(`{"factory": "supervised", "supervisor": {"running": true, "pid": 9, "since": "2026-11-24T09:00:00Z", "lifetime": "session"}, "executions": [{}, {}]}`), now)
	if !got.Known || !*got.Running || *got.Lifetime != "session" || *got.Executions != 2 || *got.Since != "2026-11-24T09:00:00Z" || *got.Mode != "supervised" {
		t.Fatalf("%+v", got)
	}
	odd := ParseStatus([]byte(`{"supervisor": {"running": "yes", "lifetime": "forever", "since": "<script>"}}`), now)
	if odd.Known || odd.Running != nil || odd.Lifetime != nil || odd.Since != nil || odd.Executions != nil {
		t.Fatalf("%+v", odd)
	}
	if s := ParseStop([]byte(`{"stopped": [{"execution_id": "x"}], "supervisor_stopped": true, "note": "Stopped."}`)); *s.Stopped != 1 || !*s.SupervisorStopped || *s.Note != "Stopped." {
		t.Fatalf("%+v", s)
	}
}

func TestLocate(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	repo := filepath.Join(dir, "mach")
	bin := filepath.Join(repo, "apps", "observer", "bin", "mach-observer")
	os.MkdirAll(filepath.Dir(bin), 0o755)
	os.WriteFile(bin, nil, 0o755)
	project := filepath.Join(dir, "project")
	installed := filepath.Join(project, ".claude", "skills", "mach", "scripts", "run.py")
	os.MkdirAll(filepath.Dir(installed), 0o755)
	os.WriteFile(installed, nil, 0o644)
	if got, err := LocateScript("", bin, project); err != nil || got.Script != installed || got.Install != "project" {
		t.Fatalf("project install: %+v %v", got, err)
	}
	own := filepath.Join(repo, "skills", "run", "scripts", "run.py")
	os.MkdirAll(filepath.Dir(own), 0o755)
	os.WriteFile(own, nil, 0o644)
	if got, err := LocateScript("", bin, project); err != nil || got.Script != own || got.Install != "mach" {
		t.Fatalf("beside the binary: %+v %v", got, err)
	}
	projBin := filepath.Join(project, ".factory", "bin", "mach-observer")
	os.MkdirAll(filepath.Dir(projBin), 0o755)
	os.WriteFile(projBin, nil, 0o755)
	if got, err := LocateScript("", projBin, ""); err != nil || got.Script != installed {
		t.Fatalf("a project's own binary: %+v %v", got, err)
	}
	if _, err := LocateScript(filepath.Join(dir, "other.py"), bin, project); err == nil {
		t.Fatal("a script that is not run.py was accepted")
	}
	if _, err := LocateScript("", filepath.Join(dir, "nowhere", "bin"), filepath.Join(dir, "none")); err == nil {
		t.Fatal("found where nothing is")
	}
}
