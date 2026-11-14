package normalize

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
	"mach/observer/internal/testkit"
)

func TestClassifyToolKeepsClassesNotContent(t *testing.T) {
	root := "/work/p"
	cases := []struct {
		name   string
		input  map[string]any
		class  string
		script any
		path   any
	}{
		{"Read", map[string]any{"file_path": "/work/p/src/a.go"}, "repo-file", nil, "src/a.go"},
		{"Edit", map[string]any{"file_path": "/work/p/.factory/worktrees/T-1/plan.md"}, "cell-file", nil, ".factory/worktrees/T-1/plan.md"},
		{"Read", map[string]any{"file_path": "/work/p/.env"}, "repo-file", nil, nil},
		{"Read", map[string]any{"file_path": "/etc/passwd"}, "outside-project", nil, nil},
		{"Read", map[string]any{"file_path": "../../x"}, "outside-project", nil, nil},
		{"Bash", map[string]any{"command": "TOKEN=x python3 /work/p/skills/build/scripts/build.py green T-1"}, "station-script", "build.py green", nil},
		{"Bash", map[string]any{"command": "git push origin main"}, "git", nil, nil},
		{"Bash", map[string]any{"command": "go test ./..."}, "test-run", nil, nil},
		{"Bash", map[string]any{"command": "curl -H 'Authorization: Bearer x' https://e"}, "other", nil, nil},
		{"Workflow", nil, "workflow", nil, nil},
		{"Agent", nil, "agent", nil, nil},
		{"Grep", map[string]any{"pattern": "secret"}, "search", nil, nil},
	}
	for _, c := range cases {
		class, script, path := classifyTool(c.name, c.input, root)
		if class != c.class || script != c.script || path != c.path {
			t.Errorf("%s %v: %s %v %v", c.name, c.input, class, script, path)
		}
	}
}

func TestLabelsAreReadInTheKnownFormsOnly(t *testing.T) {
	cases := map[string][3]string{
		"LOCAL-001: build":             {"LOCAL-001", "build", ""},
		"LOCAL-001: revise":            {"LOCAL-001", "build", ""},
		"LOCAL-001: security reviewer": {"LOCAL-001", "review", "security"},
		"LOCAL-001: what next?":        {"LOCAL-001", "", ""},
		"locate the belt script":       {"", "", ""},
		"LOCAL-001: rm -rf /":          {"", "", ""},
	}
	for label, want := range cases {
		a, b, c := parseLabel(label)
		if [3]string{a, b, c} != want {
			t.Errorf("%q: %v", label, [3]string{a, b, c})
		}
	}
}

func TestSequencerKeepsEachSourceMonotonic(t *testing.T) {
	s := NewSequencer()
	a := &event.Event{Origin: event.Origin{Stream: event.StreamLifecycle, Key: "c:T:g", Seq: 1}, Time: event.Time{OccurredAt: "2026-11-12T10:00:02.000Z"}}
	b := &event.Event{Origin: event.Origin{Stream: event.StreamLifecycle, Key: "c:T:g", Seq: 2}, Time: event.Time{OccurredAt: "2026-11-12T10:00:01.000Z"}}
	o := &event.Event{Origin: event.Origin{Stream: event.StreamObserver, Key: "o"}, OrderBasis: b}
	s.Place(a)
	s.Place(b)
	s.Place(o)
	if b.Time.OrderMS != a.Time.OrderMS || !(a.Order < b.Order && b.Order < o.Order) {
		t.Fatalf("%s %s %s", a.Order, b.Order, o.Order)
	}
	if o.Order[16] != '6' {
		t.Fatal("observer rank")
	}
}

// Every record of every kept fixture (2.1.322 and 2.1.323) matches the known shapes: a shape rule
// that refused a real record would hide a real run.
func TestEveryFixtureRecordHasAKnownShape(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(testkit.RepoRoot(), "tests", "fixtures", "execution-streams", "*.jsonl"))
	if len(files) < 7 {
		t.Fatalf("%d fixtures", len(files))
	}
	checked := 0
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
			var rec map[string]any
			if json.Unmarshal([]byte(line), &rec) != nil {
				continue
			}
			if ok, at := ShapeOK(Classify(rec), rec); !ok {
				t.Errorf("%s line %d (%s): %s", filepath.Base(f), i+1, Classify(rec), at)
			}
			checked++
		}
	}
	t.Logf("%d records of %d fixtures checked", checked, len(files))
}

// One refused request is one refusal: MACH records it twice (the stream's bare notice and the
// result's denial with its command, "Bash" and "Bash: git"), as a real run did (M6.6 N1). A bare
// name with no detailed twin, and distinct details, are kept.
func TestOneRefusalPerToolWithItsDetail(t *testing.T) {
	for _, c := range []struct{ in, want []any }{
		{[]any{"Bash", "Bash: git"}, []any{"Bash: git"}},
		{[]any{"Bash", "Bash: git", "Bash: gh pr", "WebFetch"}, []any{"Bash: git", "Bash: gh pr", "WebFetch"}},
		{[]any{"Bash"}, []any{"Bash"}},
		{[]any{}, []any{}},
	} {
		line, _ := json.Marshal(map[string]any{"schema_version": 2, "seq": 1, "at": "2026-11-14T15:17:50Z", "type": "execution.completed", "project_id": "P-1",
			"source_commit": nil, "wave_id": nil, "slice_id": "SLICE-001", "revision": nil, "ticket_id": "LOCAL-001", "runner_id": "R-1",
			"execution_id": "x0123456789ab", "source": "supervisor", "cause": nil, "refs": nil,
			"data": map[string]any{"cost_usd": 1.1, "how": "exited", "next": "stop", "refused_tools": c.in, "seen_to_end": true, "stage": "awaiting-human", "waiting_for": "human-approval"}})
		evs := NewLedger("0badc0de", "/work/p", NewIdentity()).Line(line, Read{Line: 1, At: time.Date(2026, 11, 14, 15, 17, 51, 0, time.UTC)})
		if len(evs) != 1 {
			t.Fatalf("got %d events", len(evs))
		}
		got, _ := json.Marshal(evs[0].Data["refused_tools"])
		want, _ := json.Marshal(c.want)
		if string(got) != string(want) {
			t.Errorf("%v: got %s, want %s", c.in, got, want)
		}
	}
}

// D6: the intake log records no slice title; the intake ledger does, and slice.materialized
// carries it for the revision the ledger names (never another revision's title), scrubbed.
func TestSliceTitleComesFromTheLedgerForItsRevision(t *testing.T) {
	id := NewIdentity()
	id.ReadLedger([]byte(`{"project_id":"textkit","slices":{"SLICE-003":{"ticket_id":"LOCAL-003","wave_id":"WAVE-001","revision":2,"title":"Unique link name"},
		"SLICE-004":{"ticket_id":"LOCAL-004","revision":1,"title":"Mail ops@example.com when it fails"}}}`))
	line := func(slice, ticket string, rev int) []byte {
		b, _ := json.Marshal(map[string]any{"schema_version": 2, "seq": 1, "at": "2026-11-14T15:10:37Z", "type": "slice.materialized", "project_id": "textkit",
			"source_commit": nil, "wave_id": "WAVE-001", "slice_id": slice, "revision": rev, "ticket_id": ticket, "runner_id": nil,
			"execution_id": nil, "source": "intake", "cause": nil, "refs": nil, "data": map[string]any{"adopted": false, "dependencies": []string{}, "digest": strings.Repeat("c", 64)}})
		return b
	}
	for _, c := range []struct {
		slice, ticket string
		rev           int
		want          any
	}{
		{"SLICE-003", "LOCAL-003", 2, "Unique link name"},
		{"SLICE-003", "LOCAL-003", 1, nil}, // an earlier revision: the ledger's title is not its title
		{"SLICE-004", "LOCAL-004", 1, "Mail [email] when it fails"},
		{"SLICE-009", "LOCAL-009", 1, nil},
	} {
		evs := NewLedger("0badc0de", "/work/p", id).Line(line(c.slice, c.ticket, c.rev), Read{Line: 1, At: time.Date(2026, 11, 14, 15, 10, 38, 0, time.UTC)})
		if len(evs) != 1 {
			t.Fatalf("got %d events", len(evs))
		}
		if !redact.Enforce(evs[0], nil) {
			t.Fatalf("not kept: %+v", evs[0])
		}
		redact.ScrubEvent(evs[0], "/work/p", nil)
		if got := evs[0].Data["title"]; got != c.want {
			t.Errorf("%s r%d: title %v, want %v", c.slice, c.rev, got, c.want)
		}
	}
}
