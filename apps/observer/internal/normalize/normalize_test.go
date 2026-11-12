package normalize

import (
	"testing"

	"mach/observer/internal/event"
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
