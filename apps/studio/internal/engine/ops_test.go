package engine_test

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"mach/studio/internal/engine"
)

// The contract's section 3, plus slice.show. Nothing else may be reachable.
func TestAllowlistIsExactlyTheContract(t *testing.T) {
	want := []string{
		"epic.add", "epic.approve", "epic.renumber", "epic.set", "project.init", "project.set",
		"reconcile", "refresh", "request.link", "request.list", "request.met", "request.pick", "request.show",
		"slice.check", "slice.new", "slice.pause", "slice.ready",
		"slice.renumber", "slice.reopen", "slice.resume", "slice.set", "slice.show", "status", "validate", "where",
	}
	if got := engine.Names(); !reflect.DeepEqual(got, want) {
		t.Fatalf("allowlist\n got %v\nwant %v", got, want)
	}
	for _, name := range []string{"request.list", "request.show", "slice.show", "where"} {
		if op, _ := engine.Lookup(name); !op.ReadOnly {
			t.Errorf("%s should be read-only", name)
		}
	}
	for _, name := range []string{"slice.check", "validate"} {
		if op, _ := engine.Lookup(name); !op.JSONOnFailure {
			t.Errorf("%s reports problems as JSON with exit code 1", name)
		}
	}
	// Reaching GitHub: marking ready, reopening, taking a version, picking up a request (a live
	// re-read) and marking it as met (closing the issue).
	for _, name := range []string{"slice.ready", "slice.reopen", "reconcile", "request.pick", "request.met"} {
		if op, _ := engine.Lookup(name); !op.Network || op.ReadOnly {
			t.Errorf("%s reaches GitHub and changes the workspace", name)
		}
	}
	if op, _ := engine.Lookup("request.link"); op.Network || op.ReadOnly {
		t.Errorf("request.link changes only the draft and never reaches GitHub")
	}
}

// The engine still has commands kept only for another team's tests (docs/mach-next/M11_STUDIO_ISSUES.md,
// "Leftovers"): slice approve, waves, send, feedback and acceptance. None is reachable by name,
// and no operation's argument vector starts with one, whatever its arguments.
func TestTheEnginesLeftoverCommandsAreUnreachable(t *testing.T) {
	for _, name := range []string{"slice.approve", "wave.new", "wave.add", "wave.remove", "wave.approve", "wave.renumber",
		"send", "send.preview", "feedback", "acceptance.record", "acceptance.show", "acceptance"} {
		if _, ok := engine.Lookup(name); ok {
			t.Errorf("%s is reachable", name)
		}
	}
	leftover := func(argv []string) bool {
		if len(argv) == 0 {
			return false
		}
		switch argv[0] {
		case "wave", "send", "feedback", "acceptance":
			return true
		}
		return len(argv) > 1 && argv[0] == "slice" && argv[1] == "approve"
	}
	bodies := []string{`{}`, `{"slice_id":"SLICE-001"}`, `{"slice_id":"SLICE-001","take":"mine"}`, `{"identifier":"SLICE-001"}`,
		`{"identifier":"EPIC-001"}`, `{"epic_id":"EPIC-001"}`, `{"number":42}`, `{"number":42,"slice_id":"SLICE-001"}`}
	for _, name := range engine.Names() {
		for _, body := range bodies {
			got, err := argv(t, name, body)
			if err == nil && leftover(got) {
				t.Errorf("%s %s reaches a leftover command: %q", name, body, got)
			}
		}
	}
	// The slice form of reconcile: a slice ID, never a path, a wave or a field.
	for _, body := range []string{`{"artifact":"product/project.json","take":"mine"}`, `{"slice_id":"WAVE-001","take":"mine"}`,
		`{"slice_id":"SLICE-001","take":"mine","field":"title"}`} {
		if _, err := argv(t, "reconcile", body); err == nil {
			t.Errorf("reconcile %s was accepted", body)
		}
	}
}

func argv(t *testing.T, name, body string) ([]string, error) {
	t.Helper()
	op, ok := engine.Lookup(name)
	if !ok {
		t.Fatalf("no operation %s", name)
	}
	args := op.New()
	if err := engine.Decode([]byte(body), args); err != nil {
		return nil, err
	}
	return args.Argv()
}

// Every operation's JSON arguments become one fixed vector, options always in --name=value form.
func TestEveryOperationsArgumentVector(t *testing.T) {
	cases := []struct {
		op, body string
		want     []string
	}{
		{"where", ``, []string{"where"}},
		{"status", `{}`, []string{"status"}},
		{"validate", `{}`, []string{"validate"}},
		{"refresh", `{}`, []string{"refresh"}},
		{"project.init", `{"id":"team-space","name":"Team Space","vision":"Teams work.","outcome":["One","Two"]}`,
			[]string{"project", "init", "--id=team-space", "--name=Team Space", "--vision=Teams work.", "--outcome=One", "--outcome=Two"}},
		{"project.set", `{}`, []string{"project", "set"}},
		{"project.set", `{"name":"N","vision":"V","outcome":["O"],"status":"active"}`,
			[]string{"project", "set", "--name=N", "--vision=V", "--outcome=O", "--status=active"}},
		{"epic.add", `{"title":"Team membership","criterion":["Only invited people can join"]}`,
			[]string{"epic", "add", "--title=Team membership", "--criterion=Only invited people can join"}},
		{"epic.set", `{"epic_id":"EPIC-001","title":"T","criterion":["a","b"],"status":"deferred"}`,
			[]string{"epic", "set", "EPIC-001", "--title=T", "--criterion=a", "--criterion=b", "--status=deferred"}},
		{"epic.approve", `{"epic_id":"EPIC-001"}`, []string{"epic", "approve", "EPIC-001"}},
		{"epic.renumber", `{"identifier":"EPIC-002"}`, []string{"epic", "renumber", "EPIC-002"}},
		{"slice.new", `{"epic":"EPIC-001","title":"Invite","depends_on":["SLICE-001"],"id":"SLICE-004"}`,
			[]string{"slice", "new", "--epic=EPIC-001", "--title=Invite", "--depends-on=SLICE-001", "--id=SLICE-004"}},
		{"slice.new", `{"epic":"EPIC-001","title":"-rf looks like an option"}`,
			[]string{"slice", "new", "--epic=EPIC-001", "--title=-rf looks like an option"}},
		{"slice.set", `{"slice_id":"SLICE-001","title":"T","epic":"EPIC-002","depends_on":["SLICE-002","SLICE-003"]}`,
			[]string{"slice", "set", "SLICE-001", "--title=T", "--epic=EPIC-002", "--depends-on=SLICE-002", "--depends-on=SLICE-003"}},
		{"slice.set", `{"slice_id":"SLICE-001","depends_on":[]}`, []string{"slice", "set", "SLICE-001", "--depends-on=none"}},
		{"slice.set", `{"slice_id":"SLICE-001"}`, []string{"slice", "set", "SLICE-001"}},
		{"slice.resume", `{}`, []string{"slice", "resume"}},
		{"slice.resume", `{"slice_id":"SLICE-001"}`, []string{"slice", "resume", "SLICE-001"}},
		{"slice.pause", `{"slice_id":"SLICE-001","note":"Next: expiry?"}`, []string{"slice", "pause", "SLICE-001", "--note=Next: expiry?"}},
		{"slice.check", `{"slice_id":"SLICE-001"}`, []string{"slice", "check", "SLICE-001"}},
		{"slice.check", `{"slice_id":"SLICE-001","ready":true}`, []string{"slice", "check", "SLICE-001", "--ready"}},
		{"slice.show", `{"slice_id":"SLICE-001"}`, []string{"slice", "show", "SLICE-001"}},
		{"slice.ready", `{"slice_id":"SLICE-001"}`, []string{"slice", "ready", "SLICE-001"}},
		{"slice.reopen", `{"slice_id":"SLICE-001"}`, []string{"slice", "reopen", "SLICE-001"}},
		{"slice.renumber", `{"identifier":"SLICE-002"}`, []string{"slice", "renumber", "SLICE-002"}},
		{"reconcile", `{"slice_id":"SLICE-001","take":"mine"}`, []string{"reconcile", "SLICE-001", "--take=mine"}},
		{"reconcile", `{"slice_id":"SLICE-002","take":"theirs"}`, []string{"reconcile", "SLICE-002", "--take=theirs"}},
		{"request.list", `{}`, []string{"request", "list"}},
		{"request.show", `{"number":42}`, []string{"request", "show", "42"}},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":"Export a report"}`,
			[]string{"request", "pick", "42", "--epic=EPIC-001", "--title=Export a report"}},
		{"request.link", `{"number":42,"slice_id":"SLICE-003"}`, []string{"request", "link", "42", "SLICE-003"}},
		{"request.met", `{"number":42}`, []string{"request", "met", "42"}},
	}
	covered := map[string]bool{}
	for _, c := range cases {
		got, err := argv(t, c.op, c.body)
		if err != nil {
			t.Errorf("%s %s: %v", c.op, c.body, err)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s %s\n got %q\nwant %q", c.op, c.body, got, c.want)
		}
		covered[c.op] = true
	}
	for _, name := range engine.Names() {
		if !covered[name] {
			t.Errorf("no argument-vector case for %s", name)
		}
	}
}

// The request operations: typed arguments to a fixed vector; the number is a positive whole number.
func TestRequestOpsArgv(t *testing.T) {
	good := []struct {
		op, body string
		want     []string
	}{
		{"request.list", ``, []string{"request", "list"}},
		{"request.show", `{"number":1}`, []string{"request", "show", "1"}},
		{"request.met", `{"number":999999999}`, []string{"request", "met", "999999999"}},
		{"request.pick", `{"number":7,"epic":"EPIC-002","title":"--also","also":false}`,
			[]string{"request", "pick", "7", "--epic=EPIC-002", "--title=--also"}},
		{"request.pick", `{"number":7,"epic":"EPIC-002","title":"Export","also":true}`,
			[]string{"request", "pick", "7", "--epic=EPIC-002", "--title=Export", "--also"}},
		{"request.link", `{"number":12,"slice_id":"SLICE-010"}`, []string{"request", "link", "12", "SLICE-010"}},
	}
	for _, c := range good {
		got, err := argv(t, c.op, c.body)
		if err != nil {
			t.Errorf("%s %s: %v", c.op, c.body, err)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s %s\n got %q\nwant %q", c.op, c.body, got, c.want)
		}
	}
	bad := []struct{ op, body, says string }{
		{"request.show", `{}`, "request number"},
		{"request.show", `{"number":0}`, "request number"},
		{"request.show", `{"number":-3}`, "request number"},
		{"request.met", `{"number":1000000000}`, "request number"},
		{"request.met", `{"number":"42"}`, "wrong type"},
		{"request.met", `{"number":"42; rm -rf /"}`, "wrong type"},
		{"request.met", `{"number":4.5}`, "wrong type"},
		{"request.met", `{"number":1e3}`, "wrong type"},
		{"request.met", `{"number":null}`, "request number"},
		{"request.show", `{"number":42,"verb":"met"}`, "Unknown field"},
		{"request.list", `{"number":42}`, "Unknown field"},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":"T","id":"SLICE-004"}`, "Unknown field"},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":"T","repo":"other/repo"}`, "Unknown field"},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":"T","also":"yes"}`, "wrong type"},
		{"request.pick", `{"number":42,"epic":"EPIC-1","title":"T"}`, "EPIC-001"},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":""}`, "title is required"},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":"a\u0000b"}`, "control character"},
		{"request.pick", `{"epic":"EPIC-001","title":"T"}`, "request number"},
		{"request.link", `{"number":42,"slice_id":"SLICE-001/../x"}`, "SLICE-001"},
		{"request.link", `{"number":42}`, "slice_id is required"},
		{"request.link", `{"number":-1,"slice_id":"SLICE-001"}`, "request number"},
		{"request.link", `{"number":42,"slice_id":"SLICE-001","also":true}`, "Unknown field"},
	}
	for _, c := range bad {
		_, err := argv(t, c.op, c.body)
		var refused *engine.InvalidError
		if !errors.As(err, &refused) {
			t.Errorf("%s %s: want an invalid request, got %v", c.op, c.body, err)
			continue
		}
		if !strings.Contains(refused.Message, c.says) {
			t.Errorf("%s %s: message %q should mention %q", c.op, c.body, refused.Message, c.says)
		}
	}
}

func TestRequestsTheHostRejects(t *testing.T) {
	long := strings.Repeat("x", 301)
	cases := []struct{ op, body, says string }{
		{"epic.approve", `{"epic_id":"../../etc"}`, "EPIC-001"},
		{"epic.approve", `{"epic_id":"EPIC-1"}`, "EPIC-001"},
		{"epic.approve", `{}`, "required"},
		{"slice.show", `{"slice_id":"SLICE-001/../x"}`, "SLICE-001"},
		{"slice.show", `{"slice_id":"slice-001"}`, "SLICE-001"},
		{"slice.show", `{"slice_id":"SLICE-0000000000000000000000000001"}`, "SLICE-001"},
		{"slice.ready", `{"slice_id":"SLICE-001; rm -rf /"}`, "SLICE-001"},
		{"project.init", `{"id":"Team Space","name":"n","vision":"v"}`, "campaign-platform"},
		{"project.init", `{"id":"team","name":"","vision":"v"}`, "name is required"},
		{"project.init", `{"id":"team","name":"n","vision":"v","outcome":[""]}`, "required"},
		{"epic.add", `{"title":"` + long + `"}`, "longer than"},
		{"epic.add", `{"title":"a\u0000b"}`, "control character"},
		{"epic.add", `{"title":"bell\u0007"}`, "control character"},
		{"slice.new", `{"epic":"EPIC-001","title":"t","depends_on":["SLICE-1"]}`, "SLICE-001"},
		{"reconcile", `{"slice_id":"../outside","take":"mine"}`, "SLICE-001"},
		{"reconcile", `{"slice_id":"--take=theirs","take":"mine"}`, "SLICE-001"},
		{"reconcile", `{"slice_id":"SLICE-001","take":"both"}`, "mine"},
		{"reconcile", `{"slice_id":"SLICE-001","take":"mine","field":"title"}`, "Unknown field"},
		// shape errors from Decode
		{"epic.approve", `{"epic_id":"EPIC-001","force":true}`, "Unknown field"},
		{"epic.approve", `{"epic_id":1}`, "wrong type"},
		{"epic.approve", `["EPIC-001"]`, "JSON object"},
		{"epic.approve", `{"epic_id":"EPIC-001"} {}`, "exactly one"},
		{"epic.approve", `{"epic_id":`, "not valid JSON"},
		{"slice.check", `{"slice_id":"SLICE-001","ready":"yes"}`, "wrong type"},
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
}
