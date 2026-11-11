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
		"epic.add", "epic.approve", "epic.renumber", "epic.set", "feedback", "project.init", "project.set",
		"reconcile", "refresh", "send", "send.preview", "slice.approve", "slice.check", "slice.new", "slice.pause",
		"slice.renumber", "slice.reopen", "slice.resume", "slice.set", "slice.show", "status", "validate",
		"wave.add", "wave.approve", "wave.new", "wave.remove", "wave.renumber", "where",
	}
	if got := engine.Names(); !reflect.DeepEqual(got, want) {
		t.Fatalf("allowlist\n got %v\nwant %v", got, want)
	}
	for _, name := range []string{"slice.show", "where"} {
		if op, _ := engine.Lookup(name); !op.ReadOnly {
			t.Errorf("%s should be read-only", name)
		}
	}
	for _, name := range []string{"slice.check", "validate"} {
		if op, _ := engine.Lookup(name); !op.JSONOnFailure {
			t.Errorf("%s reports problems as JSON with exit code 1", name)
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
		{"slice.approve", `{"slice_id":"SLICE-001"}`, []string{"slice", "approve", "SLICE-001"}},
		{"slice.reopen", `{"slice_id":"SLICE-001"}`, []string{"slice", "reopen", "SLICE-001"}},
		{"slice.renumber", `{"identifier":"SLICE-002"}`, []string{"slice", "renumber", "SLICE-002"}},
		{"wave.new", `{"slice":["SLICE-001","SLICE-002"]}`, []string{"wave", "new", "--slice=SLICE-001", "--slice=SLICE-002"}},
		{"wave.add", `{"wave_id":"WAVE-001","slice_ids":["SLICE-002"]}`, []string{"wave", "add", "WAVE-001", "SLICE-002"}},
		{"wave.remove", `{"wave_id":"WAVE-001","slice_ids":["SLICE-002","SLICE-003"]}`, []string{"wave", "remove", "WAVE-001", "SLICE-002", "SLICE-003"}},
		{"wave.approve", `{"wave_id":"WAVE-001"}`, []string{"wave", "approve", "WAVE-001"}},
		{"wave.approve", `{"wave_id":"WAVE-001","actor":"Pat PM"}`, []string{"wave", "approve", "WAVE-001", "--actor=Pat PM"}},
		{"wave.renumber", `{"identifier":"WAVE-002"}`, []string{"wave", "renumber", "WAVE-002"}},
		{"reconcile", `{"artifact":"product/epics/EPIC-001.json","take":"theirs","field":"acceptance_criteria"}`,
			[]string{"reconcile", "product/epics/EPIC-001.json", "--take=theirs", "--field=acceptance_criteria"}},
		{"reconcile", `{"artifact":"SLICE-001","take":"mine"}`, []string{"reconcile", "SLICE-001", "--take=mine"}},
		{"send.preview", `{"wave_id":"WAVE-001"}`, []string{"send", "WAVE-001", "--dry-run"}},
		{"send", `{"wave_id":"WAVE-001"}`, []string{"send", "WAVE-001"}},
		{"feedback", `{}`, []string{"feedback"}},
		{"feedback", `{"wave_id":"WAVE-001"}`, []string{"feedback", "WAVE-001"}},
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

func TestRequestsTheHostRejects(t *testing.T) {
	long := strings.Repeat("x", 301)
	cases := []struct{ op, body, says string }{
		{"epic.approve", `{"epic_id":"../../etc"}`, "EPIC-001"},
		{"epic.approve", `{"epic_id":"EPIC-1"}`, "EPIC-001"},
		{"epic.approve", `{}`, "required"},
		{"slice.show", `{"slice_id":"SLICE-001/../x"}`, "SLICE-001"},
		{"slice.show", `{"slice_id":"slice-001"}`, "SLICE-001"},
		{"slice.show", `{"slice_id":"SLICE-0000000000000000000000000001"}`, "SLICE-001"},
		{"wave.approve", `{"wave_id":"WAVE-001; rm -rf /"}`, "WAVE-001"},
		{"project.init", `{"id":"Team Space","name":"n","vision":"v"}`, "campaign-platform"},
		{"project.init", `{"id":"team","name":"","vision":"v"}`, "name is required"},
		{"project.init", `{"id":"team","name":"n","vision":"v","outcome":[""]}`, "required"},
		{"epic.add", `{"title":"` + long + `"}`, "longer than"},
		{"epic.add", `{"title":"a\u0000b"}`, "control character"},
		{"epic.add", `{"title":"bell\u0007"}`, "control character"},
		{"slice.new", `{"epic":"EPIC-001","title":"t","depends_on":["SLICE-1"]}`, "SLICE-001"},
		{"wave.add", `{"wave_id":"WAVE-001","slice_ids":[]}`, "at least 1"},
		{"reconcile", `{"artifact":"../outside","take":"mine"}`, "needs_reconciling"},
		{"reconcile", `{"artifact":"--take=theirs","take":"mine"}`, "needs_reconciling"},
		{"reconcile", `{"artifact":"SLICE-001","take":"both"}`, "mine"},
		{"reconcile", `{"artifact":"SLICE-001","take":"mine","field":"Bad Field"}`, "field"},
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
