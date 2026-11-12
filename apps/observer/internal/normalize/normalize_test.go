package normalize

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

const secret = "sk-ant-api03-SECRETSECRETSECRET"

var forbidden = []string{secret, "hunter2", "/Users/someone", "Ada Lovelace", "rm -rf", "BEGIN RSA PRIVATE KEY"}

func ctx() Context {
	return Context{ProjectRoot: "/work/project", Epoch: "abcd1234", Offset: 0, Line: 1, ObservedAt: time.Unix(0, 0), Live: true, Ticket: "T-1"}
}

func mustNotLeak(t *testing.T, v any) string {
	t.Helper()
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range forbidden {
		if strings.Contains(string(out), f) {
			t.Fatalf("%q reached the output: %s", f, out)
		}
	}
	return string(out)
}

func TestLedgerAllowlistDropsUnknownAndPrivateFields(t *testing.T) {
	line := `{"schema_version":2,"seq":7,"at":"2026-11-12T10:00:00Z","type":"factory.activated","project_id":"P-1",
	 "source_commit":null,"wave_id":null,"slice_id":null,"revision":null,"ticket_id":null,"runner_id":"R-1",
	 "execution_id":null,"source":"engineer","cause":null,"refs":{"cell":"/Users/someone/p/.factory"},
	 "data":{"autonomy":"supervised","by":"Ada Lovelace","limits":{"places":2,"token":"` + secret + `"},"allow_merge":false,
	 "persistent":true,"backlog":"include","excluded_slices":["SLICE-002","../../etc"],"extra":"hunter2"}}`
	res := Ledger([]byte(line), ctx())
	if res.Event == nil || res.Seq != 7 {
		t.Fatalf("refused: %s", res.Problem)
	}
	ev := res.Event
	out := mustNotLeak(t, ev)
	if ev.Type != "factory.activated" || ev.Data["autonomy"] != "supervised" || ev.Subject.RunnerID != "R-1" || ev.Subject.Actor != "engineer" {
		t.Fatalf("kept fields: %s", out)
	}
	if _, ok := ev.Data["by"]; ok {
		t.Fatal("a person's name was kept")
	}
	if ev.Withheld < 2 {
		t.Fatalf("withheld %d, want the dropped fields counted", ev.Withheld)
	}
	if ids := ev.Data["excluded_slices"].([]any); len(ids) != 1 {
		t.Fatalf("an identifier with a path in it was kept: %v", ids)
	}
	if ev.Precision != "second" || ev.OccurredAt != "2026-11-12T10:00:00.000Z" {
		t.Fatalf("time %s %s", ev.OccurredAt, ev.Precision)
	}
}

func TestLedgerProseIsScrubbed(t *testing.T) {
	line := `{"schema_version":2,"seq":1,"at":"2026-11-12T10:00:00Z","type":"human.required","data":{"reason":"Blocked: TOKEN=` + secret +
		` at /Users/someone/x/y and /work/project/specs/a.md‮"}}`
	ev := Ledger([]byte(line), ctx()).Event
	out := mustNotLeak(t, ev)
	reason := ev.Data["reason"].(string)
	if !strings.Contains(reason, "specs/a.md") || strings.ContainsRune(reason, '‮') {
		t.Fatalf("reason %q (%s)", reason, out)
	}
}

func TestLedgerUnknownTypeKeepsNoData(t *testing.T) {
	line := `{"schema_version":2,"seq":3,"at":"2026-11-12T10:00:00Z","type":"future.kind","ticket_id":"T-9","data":{"note":"hunter2"}}`
	ev := Ledger([]byte(line), ctx()).Event
	mustNotLeak(t, ev)
	if ev.Type != LedgerUnknownType || ev.Subject.TicketID != "T-9" || ev.Withheld != 1 || len(ev.Data) != 1 {
		t.Fatalf("%+v", ev)
	}
}

func TestLedgerRefusals(t *testing.T) {
	for line, want := range map[string]string{
		`not json`:                        ProblemMalformed,
		`{"schema_version":3,"seq":1}`:    ProblemVersion,
		`{"schema_version":2,"type":"x"}`: ProblemEnvelope,
	} {
		if res := Ledger([]byte(line), ctx()); res.Event != nil || res.Problem != want {
			t.Errorf("%s: %+v", line, res)
		}
	}
}

func TestDeterministicIDs(t *testing.T) {
	line := []byte(`{"schema_version":2,"seq":5,"at":"2026-11-12T10:00:00Z","type":"work.claimed","data":{}}`)
	a, b := Ledger(line, ctx()).Event, Ledger(line, ctx()).Event
	if a.ID != b.ID || a.ID != "i:abcd1234:5" {
		t.Fatalf("the same line must have the same ID: %s", a.ID)
	}
	other := ctx()
	other.Epoch = "ffff0000"
	if Ledger(line, other).Event.ID == a.ID {
		t.Fatal("another epoch must give another ID")
	}
}

func TestLifecycleAllowlistAndTicketBinding(t *testing.T) {
	line := `{"v":1,"seq":2,"at":"2026-11-12T10:00:01.250Z","ticket_id":"T-1","type":"gate.evaluated","station":"build","visit":"build#1",
	 "round":1,"execution_id":"x0123456789ab","data":{"gate":"build.red","outcome":"pass","reason_code":"FAIL_WITH_EVIDENCE",
	 "failure_tail":"password=hunter2","task":"T3","tests":4,"overridden_by_reason":"Ada Lovelace said so","nested":{"a":1}}}`
	c := ctx()
	c.Line = 7
	res := Lifecycle([]byte(line), c)
	if res.Event == nil {
		t.Fatalf("refused: %s", res.Problem)
	}
	ev := res.Event
	out := mustNotLeak(t, ev)
	if ev.ID != "c:T-1:abcd1234:7" || ev.Data["gate"] != "build.red" || ev.Data["reason_code"] != "FAIL_WITH_EVIDENCE" ||
		ev.Subject.Visit != "build#1" || *ev.Subject.Round != 1 || ev.Precision != "ms" || res.Seq != 2 {
		t.Fatalf("%s", out)
	}
	if ev.Data["override_reason_given"] != true || ev.Data["counts"].(map[string]any)["tests"] != int64(4) {
		t.Fatalf("%s", out)
	}
	if _, ok := ev.Data["failure_tail"]; ok || ev.Withheld != 2 {
		t.Fatalf("test output or an object was kept (withheld %d): %s", ev.Withheld, out)
	}
	wrong := ctx()
	wrong.Ticket = "T-2"
	if res := Lifecycle([]byte(line), wrong); res.Event != nil || res.Problem != ProblemWrongTicket {
		t.Fatal("a line naming another cell must be refused")
	}
}

func TestLifecycleNullSeqEvidenceAndUnknownType(t *testing.T) {
	line := `{"v":1,"seq":null,"at":"2026-11-12T10:00:01.250Z","ticket_id":"T-1","type":"verify.check_recorded","station":"verify",
	 "visit":"verify#2","round":2,"execution_id":null,"data":{"item":"AC-01","kind":"web","result":"pass",
	 "evidence":[{"path":"evidence/a.png","sha256":"` + strings.Repeat("a", 64) + `"},{"path":"/Users/someone/b.png","sha256":"` + strings.Repeat("b", 64) + `"}]}}`
	res := Lifecycle([]byte(line), ctx())
	if res.Event == nil || res.Seq != 0 {
		t.Fatalf("a null seq is allowed: %+v", res)
	}
	mustNotLeak(t, res.Event)
	evidence := res.Event.Data["evidence"].([]any)
	if len(evidence) != 1 || evidence[0].(map[string]any)["file"] != "evidence/a.png" {
		t.Fatalf("evidence %v", evidence)
	}
	future := `{"v":1,"seq":3,"at":"2026-11-12T10:00:01.250Z","ticket_id":"T-1","type":"station.teleported","station":"build","visit":"build#1","round":1,"execution_id":null,"data":{"x":"hunter2"}}`
	ev := Lifecycle([]byte(future), ctx()).Event
	mustNotLeak(t, ev)
	if ev == nil || ev.Type != "station.teleported" || ev.Data != nil || ev.Withheld != 1 {
		t.Fatalf("%+v", ev)
	}
}

func TestStreamDeniesByDefault(t *testing.T) {
	s := NewStream(nil)
	lines := []string{
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"rm -rf / ` + secret + `"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","content":"hunter2"}]}}`,
		`{"type":"system","subtype":"init","cwd":"/Users/someone/p"}`,
		`{"type":"brand-new","payload":"Ada Lovelace"}`,
	}
	for _, l := range lines {
		if evs := s.Normalize([]byte(l), ctx(), "x0123456789ab"); len(evs) != 0 {
			t.Fatalf("an unknown record produced events: %s", mustNotLeak(t, evs))
		}
	}
	if s.Unrecognised != len(lines) {
		t.Fatalf("unrecognised %d", s.Unrecognised)
	}
	if evs := s.Normalize([]byte(`{not json `+secret), ctx(), "x"); len(evs) != 0 || s.Malformed != 1 {
		t.Fatal("a malformed line must produce nothing")
	}
}

func TestStreamHandlerOutputIsFilteredAgain(t *testing.T) {
	// A careless handler that tries to pass content through: only safe scalars survive.
	careless := func(rec map[string]any) []Observation {
		msg := rec["message"].(map[string]any)
		block := msg["content"].([]any)[0].(map[string]any)
		return []Observation{{Type: "tool.called", Data: map[string]any{
			"tool":     block["name"],
			"input":    block["input"],       // an object: dropped
			"command":  "rm -rf / " + secret, // free text: dropped
			"key":      secret,               // identifier-shaped secret: dropped
			"category": "shell", "ok": true, "duration_ms": 12.0,
		}}}
	}
	s := NewStream(map[string]StreamHandler{"assistant": careless})
	line := `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"cat /Users/someone/.ssh/id"}}]}}`
	evs := s.Normalize([]byte(line), ctx(), "x0123456789ab")
	if len(evs) != 1 {
		t.Fatalf("%d events", len(evs))
	}
	out := mustNotLeak(t, evs)
	d := evs[0].Data
	if d["tool"] != "Bash" || d["category"] != "shell" || d["ok"] != true || evs[0].Withheld != 3 || evs[0].ID != "s:x0123456789ab:1.0" || evs[0].Authority != "observed" {
		t.Fatalf("%s", out)
	}
	if strings.Contains(out, ".ssh") {
		t.Fatal("tool input leaked")
	}
}

// testdata/lifecycle-helper.jsonl was written by MACH's own helper
// (skills/intent/scripts/lifecycle.py record()), one record of every type. Every line must be
// accepted and keep its allowlisted facts with nothing withheld.
func TestLifecycleHelperOutputIsAccepted(t *testing.T) {
	data, err := os.ReadFile("testdata/lifecycle-helper.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for i, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		c := ctx()
		c.Ticket, c.Line = "LOCAL-001", int64(i+1)
		res := Lifecycle([]byte(line), c)
		if res.Event == nil {
			t.Fatalf("line %d refused (%s): %s", i+1, res.Problem, line)
		}
		if res.Event.Withheld != 0 {
			t.Errorf("line %d (%s): %d fields withheld: %s", i+1, res.Event.Type, res.Event.Withheld, line)
		}
		if len(lifecycleData[res.Event.Type].fields) == 0 {
			t.Errorf("line %d: type %s has no allowlist", i+1, res.Event.Type)
		}
		seen[res.Event.Type] = true
	}
	if len(seen) != len(lifecycleData) {
		t.Fatalf("the fixture covers %d of %d types", len(seen), len(lifecycleData))
	}
}
