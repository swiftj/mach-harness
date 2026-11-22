package engine_test

import (
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"mach/studio/internal/engine"
	"mach/studio/internal/testkit"
)

// M18: a small change. Starting one is slice.new or request.pick with `small`; leaving the light path
// on the product manager's word is slice.widen. TestEveryOperationsArgumentVector runs these with the others.
var smallArgvCases = []struct {
	op, body string
	want     []string
}{
	{"slice.new", `{"epic":"EPIC-001","title":"Clearer expired message","small":{"change":"adjustment"}}`,
		[]string{"slice", "new", "--epic=EPIC-001", "--title=Clearer expired message", "--small", "--change=adjustment"}},
	{"slice.new", `{"epic":"EPIC-001","title":"Reject a space","small":{"change":"fix","rule":"SLICE-001/FR-03"}}`,
		[]string{"slice", "new", "--epic=EPIC-001", "--title=Reject a space", "--small", "--change=fix", "--rule=SLICE-001/FR-03"}},
	{"slice.new", `{"epic":"EPIC-001","title":"--small looks like an option","small":{"change":"fix","rule":"SLICE-012/INV-04"}}`,
		[]string{"slice", "new", "--epic=EPIC-001", "--title=--small looks like an option", "--small", "--change=fix", "--rule=SLICE-012/INV-04"}},
	{"slice.new", `{"epic":"EPIC-001","title":"T","small":{"change":"fix","rule":"SLICE-001/R2"}}`,
		[]string{"slice", "new", "--epic=EPIC-001", "--title=T", "--small", "--change=fix", "--rule=SLICE-001/R2"}},
	{"request.pick", `{"number":42,"epic":"EPIC-001","title":"Export","small":{"change":"adjustment"}}`,
		[]string{"request", "pick", "42", "--epic=EPIC-001", "--title=Export", "--small", "--change=adjustment"}},
	{"request.pick", `{"number":42,"epic":"EPIC-001","title":"Export","also":true,"small":{"change":"fix","rule":"SLICE-003/FR-02"}}`,
		[]string{"request", "pick", "42", "--epic=EPIC-001", "--title=Export", "--also", "--small", "--change=fix", "--rule=SLICE-003/FR-02"}},
	{"slice.widen", `{"slice_id":"SLICE-005","why":"It should also change the reminder email."}`,
		[]string{"slice", "widen", "SLICE-005", "--why=It should also change the reminder email."}},
	{"slice.widen", `{"slice_id":"SLICE-005","why":"--by-rule=actor is not my reason"}`,
		[]string{"slice", "widen", "SLICE-005", "--why=--by-rule=actor is not my reason"}},
}

func TestSmallChangeOpsTheHostRejects(t *testing.T) {
	long := strings.Repeat("x", engine.MaxWidenReason+1)
	cases := []struct{ op, body, says string }{
		{"slice.new", `{"epic":"EPIC-001","title":"T","small":{}}`, "small.change is required"},
		{"slice.new", `{"epic":"EPIC-001","title":"T","small":{"change":"rewrite"}}`, "\"fix\" or \"adjustment\""},
		{"slice.new", `{"epic":"EPIC-001","title":"T","small":{"change":"fix"}}`, "names the shipped rule"},
		{"slice.new", `{"epic":"EPIC-001","title":"T","small":{"change":"fix","rule":"SLICE-001/AC-01"}}`, "SLICE-003/FR-02"},
		{"slice.new", `{"epic":"EPIC-001","title":"T","small":{"change":"fix","rule":"SLICE-001/FR-01 --id=SLICE-009"}}`, "SLICE-003/FR-02"},
		{"slice.new", `{"epic":"EPIC-001","title":"T","small":{"change":"fix","rule":""}}`, "small.rule is required"},
		{"slice.new", `{"epic":"EPIC-001","title":"T","small":{"change":"adjustment","rule":"SLICE-001/FR-01"}}`, "names no shipped rule"},
		{"slice.new", `{"epic":"EPIC-001","title":"T","small":{"change":"adjustment","widened":true}}`, "Unknown field"},
		{"slice.new", `{"epic":"EPIC-001","title":"T","small":true}`, "wrong type"},
		{"slice.new", `{"epic":"EPIC-001","title":"T","small":"adjustment"}`, "wrong type"},
		{"slice.new", `{"epic":"EPIC-001","title":"T","kind":"small"}`, "Unknown field"},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":"T","small":{"change":"fix"}}`, "names the shipped rule"},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":"T","small":{"change":"fix","rule":"FR-01"}}`, "SLICE-003/FR-02"},
		{"slice.widen", `{"slice_id":"SLICE-001"}`, "why is required"},
		{"slice.widen", `{"slice_id":"SLICE-001","why":"   "}`, "why is required"},
		{"slice.widen", `{"slice_id":"SLICE-001","why":"` + long + `"}`, "longer than"},
		{"slice.widen", `{"slice_id":"SLICE-001","why":"a\u0000b"}`, "control character"},
		{"slice.widen", `{"slice_id":"../SLICE-001","why":"W."}`, "SLICE-001"},
		{"slice.widen", `{"why":"W."}`, "slice_id is required"},
		{"slice.widen", `{"slice_id":"SLICE-001","by_rule":"actor"}`, "Unknown field"},
		{"slice.widen", `{"slice_id":"SLICE-001","why":"W.","by_rule":"actor"}`, "Unknown field"},
	}
	for _, c := range cases {
		_, err := argv(t, c.op, c.body)
		var bad *engine.InvalidError
		if !errors.As(err, &bad) {
			t.Errorf("%s %s: want an invalid request, got %v", c.op, c.body, err)
			continue
		}
		if !strings.Contains(bad.Message, c.says) {
			t.Errorf("%s %s: message %q should mention %q", c.op, c.body, bad.Message, c.says)
		}
	}
	// A full slice is exactly as before: no small flag in its vector.
	got, err := argv(t, "slice.new", `{"epic":"EPIC-001","title":"Invite"}`)
	if err != nil || !reflect.DeepEqual(got, []string{"slice", "new", "--epic=EPIC-001", "--title=Invite"}) {
		t.Fatalf("a full slice: %q %v", got, err)
	}
}

func TestSliceWidenStaysOnThisComputer(t *testing.T) {
	op, ok := engine.Lookup("slice.widen")
	if !ok || op.Network || op.ReadOnly || op.JSONOnFailure || op.Download || op.BodyLimit() != engine.MaxBodyBytes {
		t.Fatalf("slice.widen: %+v", op)
	}
}

// M18 engine B item 5: marking a small change ready that this same act finds is not small answers ready: false and
// widened: true with exit 0, and the host passes it through as a success, not a refusal. Nothing is approved; the next
// slice.ready marks it ready as the full slice.
func TestMarkingASmallChangeReadyCanMakeItAFullSliceInstead(t *testing.T) {
	project := testkit.NewProject(t)
	e := testkit.NewEngine(t, project)
	mustOK(t, e, "project.init", `{"id":"team-space","name":"Team Space","vision":"Teams work together.","outcome":["Teams can work together"]}`)
	mustOK(t, e, "epic.add", `{"title":"Team membership","criterion":["Only invited people can join"]}`)
	if id := mustOK(t, e, "slice.new", `{"epic":"EPIC-001","title":"Invite a teammate","small":{"change":"adjustment"}}`)["slice"].(map[string]any)["slice_id"]; id != "SLICE-001" {
		t.Fatalf("slice id %v", id)
	}
	// The fixture spec has more functional requirements than a small change has.
	if err := os.WriteFile(testkit.Draft(project, "specs", "slices", testkit.SpecName), testkit.Fixture(t), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(testkit.Draft(project, "product", "intents", "SLICE-001.md"), []byte(testkit.IntentText), 0o644); err != nil {
		t.Fatal(err)
	}
	answer := mustOK(t, e, "slice.ready", `{"slice_id":"SLICE-001"}`)
	small := answer["small_change"].(map[string]any)
	if answer["ready"] != false || answer["widened"] != true || small["widened_now"] != true || small["widened"].(map[string]any)["rule"] != "requirements" {
		t.Fatalf("slice.ready that widens: %v", answer)
	}
	if work := readJSON(t, testkit.Draft(project, "product", "slices", "SLICE-001.json")); work["status"] == "approved_for_engineering" || work["widened"] == nil {
		t.Fatalf("nothing is approved, the widening is kept: %v", work)
	}
	if _, err := os.Stat(testkit.Draft(project, "product", "ready", "SLICE-001")); !os.IsNotExist(err) {
		t.Fatalf("nothing is written to the ready folder: %v", err)
	}
	if again := mustOK(t, e, "slice.ready", `{"slice_id":"SLICE-001"}`); again["ready"] != true || again["saved_to"] != "folder" {
		t.Fatalf("the next slice.ready marks the full slice ready: %v", again)
	}
}

// Against the real engine: a small change started, reported, refused where the engine refuses, and
// widened on the product manager's word.
func TestSmallChangeAgainstTheRealEngine(t *testing.T) {
	project := testkit.NewProject(t)
	e := testkit.NewEngine(t, project)
	mustOK(t, e, "project.init", `{"id":"team-space","name":"Team Space","vision":"Teams work together.","outcome":["Teams can work together"]}`)
	mustOK(t, e, "epic.add", `{"title":"Team membership","criterion":["Only invited people can join"]}`)

	// Nothing has shipped here, so there is no rule to fix; refused before anything is written.
	mustFail(t, e, "slice.new", `{"epic":"EPIC-001","title":"Reject a space","small":{"change":"fix","rule":"SLICE-001/FR-03"}}`,
		engine.KindRefused, "is not a shipped rule in force")
	started := mustOK(t, e, "slice.new", `{"epic":"EPIC-001","title":"Clearer expired message","small":{"change":"adjustment"}}`)
	work := started["slice"].(map[string]any)
	id := work["slice_id"].(string)
	if work["kind"] != "small" || !reflect.DeepEqual(work["small"], map[string]any{"change": "adjustment", "shipped_rule": nil}) {
		t.Fatalf("slice.new small: %v", work)
	}
	row := mustOK(t, e, "status", ``)["slices"].([]any)[0].(map[string]any)
	if row["kind"] != "small" || row["small"].(map[string]any)["light_path"] != true {
		t.Fatalf("status row: %v", row)
	}
	resumed := mustOK(t, e, "slice.resume", `{"slice_id":"`+id+`"}`)["small_change"].(map[string]any)
	if resumed["light_path"] != true || !strings.HasSuffix(resumed["method"].(string), "small-change.md") {
		t.Fatalf("slice.resume small_change: %v", resumed)
	}
	full := mustOK(t, e, "slice.new", `{"epic":"EPIC-001","title":"Invite a teammate"}`)["slice"].(map[string]any)
	if _, has := full["kind"]; has {
		t.Fatalf("a full slice carries no kind: %v", full)
	}
	mustFail(t, e, "slice.widen", `{"slice_id":"`+full["slice_id"].(string)+`","why":"W."}`, engine.KindRefused, "is not a small change")

	widened := mustOK(t, e, "slice.widen", `{"slice_id":"`+id+`","why":"It should also change the reminder email."}`)
	record := widened["slice"].(map[string]any)["widened"].(map[string]any)
	if record["reason"] != "It should also change the reminder email." || record["rule"] != nil {
		t.Fatalf("slice.widen: %v", widened)
	}
	if work := readJSON(t, testkit.Draft(project, "product", "slices", id+".json")); work["widened"] == nil || work["kind"] != "small" {
		t.Fatalf("the work order: %v", work)
	}
	mustFail(t, e, "slice.widen", `{"slice_id":"`+id+`","why":"Again."}`, engine.KindRefused, "is already a full slice")
	if row := mustOK(t, e, "status", ``)["slices"].([]any)[0].(map[string]any); row["small"].(map[string]any)["light_path"] != false {
		t.Fatalf("status after widening: %v", row)
	}
}
