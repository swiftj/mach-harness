package normalize

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"mach/observer/internal/testkit"
)

// M18: revision 8. The groom station's exit says when a ticket is a small change: kind, widened and
// the rule's code, each checked again; an exit that names no kind is served exactly as before.

func groomExit(t *testing.T, extra map[string]any) map[string]any {
	t.Helper()
	l := NewLifecycle("T-1", "0a1b2c3d", provRoot, NewIdentity())
	m15Lifecycle(t, l, 1, "station.entered", "groom", "groom#1", 1, map[string]any{"stage": "interview", "mode": "interactive"})
	data := map[string]any{"outcome": "spec-ready", "stage": "spec-ready", "slice_id": "SLICE-001", "risk": "Low", "scenarios": 2}
	for k, v := range extra {
		data[k] = v
	}
	return m15Served(t, m15Lifecycle(t, l, 2, "station.exited", "groom", "groom#1", 1, data))
}

func TestAGroomExitOfAFullSliceIsServedAsBefore(t *testing.T) {
	d := groomExit(t, nil)
	for _, k := range []string{"kind", "widened", "widened_rule"} {
		if _, ok := d[k]; ok {
			t.Errorf("%s served for a ticket that is not small: %v", k, d)
		}
	}
	if c := d["counts"].(map[string]any); !reflect.DeepEqual(c, map[string]any{"scenarios": float64(2)}) {
		t.Errorf("counts %v", c)
	}
}

func TestAGroomExitSaysASmallChange(t *testing.T) {
	d := groomExit(t, map[string]any{"kind": "small", "widened": false})
	if d["kind"] != "small" || d["widened"] != false || d["widened_rule"] != nil {
		t.Fatalf("small: %v", d)
	}
	if _, ok := d["counts"].(map[string]any)["widened"]; ok {
		t.Error("widened is its own field, not a count")
	}
	d = groomExit(t, map[string]any{"kind": "small", "widened": true, "widened_rule": "high-risk-file"})
	if d["widened"] != true || d["widened_rule"] != "high-risk-file" {
		t.Fatalf("widened: %v", d)
	}
	// A code this observer does not know, or words, are never passed on.
	for _, rule := range []any{"a-rule-from-later", "It also changes the reminder email.", 3} {
		if d := groomExit(t, map[string]any{"kind": "small", "widened": true, "widened_rule": rule}); d["widened_rule"] != nil || d["widened"] != true {
			t.Errorf("%v: %v", rule, d)
		}
	}
	if d := groomExit(t, map[string]any{"kind": "medium"}); d["kind"] != nil {
		t.Errorf("an unknown kind: %v", d)
	}
}

func TestTheKindIsReadOnTheGroomExitOnly(t *testing.T) {
	l := NewLifecycle("T-1", "0a1b2c3d", provRoot, NewIdentity())
	m15Lifecycle(t, l, 1, "station.entered", "plan", "plan#1", 1, map[string]any{"stage": "spec-ready"})
	d := m15Served(t, m15Lifecycle(t, l, 2, "station.exited", "plan", "plan#1", 1, map[string]any{"outcome": "planned", "stage": "planned", "kind": "small", "widened": true}))
	if _, ok := d["kind"]; ok {
		t.Errorf("a plan exit's kind: %v", d)
	}
}

// The codes the observer accepts are the intent station's own (small.py RULES), in its order.
func TestSmallRulesAreTheIntentStationsCodes(t *testing.T) {
	src, err := os.ReadFile(filepath.Join(testkit.RepoRoot(), "skills", "intent", "scripts", "small.py"))
	if err != nil {
		t.Fatal(err)
	}
	var codes []string
	for _, name := range []string{"SPEC_RULES", "PLAN_RULES"} {
		m := regexp.MustCompile(`(?s)\n` + name + ` = \((.*?)\)\n`).FindSubmatch(src)
		if m == nil {
			t.Fatalf("no %s in small.py", name)
		}
		for _, q := range regexp.MustCompile(`"([a-z-]+)"`).FindAllSubmatch(m[1], -1) {
			codes = append(codes, string(q[1]))
		}
		if name == "SPEC_RULES" {
			codes = append(codes, "questions") // RULES = SPEC_RULES + ("questions",) + PLAN_RULES
		}
	}
	if !strings.Contains(string(src), `RULES = SPEC_RULES + ("questions",) + PLAN_RULES`) || !reflect.DeepEqual(codes, SmallRules) {
		t.Fatalf("small.py %v, observer %v", codes, SmallRules)
	}
}
