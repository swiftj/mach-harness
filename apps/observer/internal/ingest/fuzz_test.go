package ingest

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/normalize"
	"mach/observer/internal/redact"
	"mach/observer/internal/store"
	"mach/observer/internal/tail"
	"mach/observer/internal/testkit"
)

// Fuzzing the three line parsers (lifecycle, intake, stream). For any input line the parser must
// not panic; whatever it yields must pass the same gate ingest uses (allowlist, identities,
// scrubber) and then validate against the version 3 schema with no planted secret in it; and the
// parser must still read the next good line afterwards (a hostile line cannot wedge it).
//
//	go test ./internal/ingest -run '^$' -fuzz FuzzLifecycleLine -fuzztime 20s   (and the other two)
//
// Without -fuzz, `go test` runs the seed corpus below as ordinary tests.

// hostile lines every target is seeded with: broken JSON, wrong types, deep nesting, huge
// numbers, control and bidi characters, planted secrets and paths, prototype-ish keys.
var hostile = []string{
	``, `{`, `}`, `null`, `[]`, `"x"`, `1e309`, `{"v":1}`, `{"type":null}`, `{"type":{"a":1}}`, `{"type":["station.entered"]}`,
	`{"v":1,"seq":-1,"at":"not a time","ticket_id":"T-1","type":"station.entered"}`,
	`{"v":1,"seq":1e308,"at":"2026-11-12T10:00:00.000Z","ticket_id":"T-1","type":"gate.evaluated","station":"build","visit":"build#999999999","data":{"gate":"build.start","outcome":"pass"}}`,
	`{"v":1,"seq":1,"at":"2026-11-12T10:00:00.000Z","ticket_id":"../../etc","type":"station.entered","station":"build","visit":"build#1"}`,
	`{"v":1,"seq":1,"at":"2026-11-12T10:00:00.000Z","ticket_id":"T-1","type":"station.entered","station":"build","visit":"build#1","data":{"stage":"sk-ant-api03-MARKERaaaaaaaaaaaaaaaaaaaa","note":"/Users/MARKER/.ssh/id_rsa","__proto__":{"x":1}}}`,
	`{"schema_version":2,"seq":1,"at":"2026-11-12T10:00:00Z","type":"human.required","ticket_id":"T-1","data":{"reason":"export TOKEN=MARKERsecret ‮ /home/MARKER/x"}}`,
	`{"schema_version":2,"seq":"1","at":1,"type":"work.claimed","ticket_id":5,"execution_id":[],"data":"x"}`,
	`{"type":"assistant","timestamp":"2026-11-12T10:00:01.000Z","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"curl -H 'Authorization: Bearer MARKERtok'"}}]}}`,
	`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"MARKER file contents"}]},"tool_use_result":{"originalFile":"MARKER"}}`,
	`{"type":"system","subtype":"task_progress","task_id":"t1","workflow_progress":[{"index":"0","agentId":{},"state":"done","durationMs":-5}]}`,
	`{"type":"system","subtype":"init","claude_code_version":"2.1.322","cwd":"/Users/MARKER/p","tools":["Bash",{"x":1}],"model":"\u0000"}`,
	`{"type":"result","subtype":"error_max_budget_usd","total_cost_usd":"lots","modelUsage":{"m":{"costUSD":1e400}}}`,
	strings.Repeat(`{"a":`, 2000) + strings.Repeat(`}`, 2000),
	strings.Repeat("x", 70000),
	"\xff\xfe\xfd not utf-8 \x00",
}

type lineParser interface {
	Line([]byte, normalize.Read) []*event.Event
}

// gate runs a parser's output through ingest's emit (the one gate before the store) and checks
// what would be stored.
func gate(t *testing.T, o *Observer, evs []*event.Event, schema *testkit.Schema) int {
	t.Helper()
	tc := &tickCtx{now: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC), cps: map[string]tail.Checkpoint{}}
	o.emit(tc, evs, false)
	for _, ev := range tc.out {
		ev.Pos = 1
		raw, err := json.Marshal(ev)
		if err != nil {
			t.Fatalf("an event that cannot be encoded: %v", err)
		}
		if errs := schema.ValidateJSON(raw); len(errs) > 0 {
			t.Fatalf("schema violation:\n%s\n%s", raw, strings.Join(errs, "\n"))
		}
		for _, bad := range []string{"MARKER", "sk-ant-", "/Users/", "/home/", "‮", "\x00"} {
			if bytes.Contains(raw, []byte(bad)) {
				t.Fatalf("%q forwarded: %s", bad, raw)
			}
		}
		var walk func(any)
		walk = func(v any) {
			switch x := v.(type) {
			case string:
				if len(x) > redact.MaxString {
					t.Fatalf("a %d-byte string was stored", len(x))
				}
			case map[string]any:
				for k, c := range x {
					walk(k)
					walk(c)
				}
			case []any:
				for _, c := range x {
					walk(c)
				}
			}
		}
		var m any
		json.Unmarshal(raw, &m)
		walk(m)
	}
	return len(tc.out)
}

func fuzzObserver(t *testing.T) *Observer {
	st, err := store.Open("", 1000)
	if err != nil {
		t.Fatal(err)
	}
	o := New(Options{Root: "/work/project", Store: st, NoSettle: true})
	o.catchingUp = false
	return o
}

func read(n int64) normalize.Read {
	at := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC).Add(time.Duration(n) * time.Second)
	return normalize.Read{Line: n, At: at, Prev: at.Add(-time.Second), Live: true}
}

func seed(f *testing.F, good ...[]byte) {
	for _, h := range hostile {
		f.Add([]byte(h))
	}
	for _, g := range good {
		f.Add(g)
		f.Add(bytes.ReplaceAll(g, []byte(`"`), []byte(`'`)))
		f.Add(g[:len(g)/2])
	}
}

// fuzzParser: good line, the fuzzed line, then another good line, which must still be read.
func fuzzParser(f *testing.F, make func() lineParser, before, after []byte, wantAfter string) {
	schema := eventSchema(f)
	f.Fuzz(func(t *testing.T, line []byte) {
		o := fuzzObserver(t)
		p := make()
		gate(t, o, p.Line(before, read(1)), schema)
		gate(t, o, p.Line(line, read(2)), schema)
		got := p.Line(after, read(3))
		found := false
		for _, ev := range got {
			found = found || ev != nil && ev.Type == wantAfter
		}
		if !found {
			t.Fatalf("the parser no longer reads a good line after %q", line)
		}
		gate(t, o, got, schema)
		if s, ok := p.(*normalize.Stream); ok {
			gate(t, o, s.Finish(read(4)), schema)
		}
	})
}

func FuzzLifecycleLine(f *testing.F) {
	rec := func(seq int, typ string, data map[string]any) []byte {
		return testkit.Record{Seq: seq, At: "2026-11-12T10:00:0" + string(rune('0'+seq)) + ".000Z", Ticket: "T-1", Type: typ, Station: "build", Visit: 1, Round: 1, Data: data}.Line()
	}
	before := rec(1, "station.entered", map[string]any{"stage": "building"})
	after := rec(3, "gate.evaluated", map[string]any{"gate": "build.start", "outcome": "pass"})
	var good [][]byte
	for _, r := range cellRecords("T-1") {
		good = append(good, r.Line())
	}
	seed(f, good...)
	dir := f.TempDir()
	fuzzParser(f, func() lineParser {
		l := normalize.NewLifecycle("T-1", "0badc0de", "/work/project", normalize.NewIdentity())
		l.Files = normalize.DirFiles{Dir: dir}
		return l
	}, before, after, "gate.evaluated")
}

func FuzzIntakeLine(f *testing.F) {
	seed(f, intakeSample()...)
	before := v2(1, "intake.validated", "intake", "", "", map[string]any{"digest": "ab"})
	after := v2(999999999, "human.required", "intake", "T-1", "", map[string]any{"reason": "a person decides"})
	fuzzParser(f, func() lineParser {
		return normalize.NewLedger("0badc0de", "/work/project", normalize.NewIdentity())
	}, before, after, "human.required")
}

func FuzzStreamRecord(f *testing.F) {
	var good [][]byte
	for _, name := range []string{"belt-build-verify-review.jsonl", "agent-tool-contrast.jsonl", "workflow-tool-refused.jsonl"} {
		b, err := os.ReadFile(testkit.StreamFixture(name))
		if err != nil {
			f.Fatal(err)
		}
		sc := bufio.NewScanner(bytes.NewReader(b))
		sc.Buffer(make([]byte, 1<<20), 8<<20)
		for k := 0; sc.Scan() && k < 40; k++ {
			good = append(good, append([]byte(nil), sc.Bytes()...))
		}
	}
	seed(f, good...)
	before := []byte(`{"type":"system","subtype":"init","claude_code_version":"2.1.322","model":"claude-sonnet-5-5","permissionMode":"default","tools":["Bash"],"agents":[]}`)
	after := []byte(`{"type":"system","subtype":"permission_denied","tool_name":"Bash","agent_id":null}`)
	fuzzParser(f, func() lineParser {
		return normalize.NewStream(x1, "/work/project", normalize.NewIdentity())
	}, before, after, "tool.refused")
}
