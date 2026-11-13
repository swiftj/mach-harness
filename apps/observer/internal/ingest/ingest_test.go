package ingest

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mach/observer/internal/event"
	"mach/observer/internal/testkit"
)

const x1 = "x0123456789ab"

func TestProbeWorkflowStream(t *testing.T) {
	root := testkit.Project(t)
	execution(t, root, x1, "probe-workflow.jsonl", true)
	h := newHarness(t, root, "", false)
	h.drain()
	n := h.validate()
	evs := h.events()
	k := kinds(evs)
	want := map[string]int{"session.initialized": 1, "workflow.started": 1, "workflow.phases_declared": 1, "agent.queued": 4,
		"agent.started": 4, "agent.finished": 4, "tool.called": 1, "tool.returned": 1, "tool.refused": 1, "workflow.finished": 1,
		"execution.usage": 1, "execution.process_started": 1, "execution.process_ended": 1}
	for kind, c := range want {
		if k[kind] != c {
			t.Errorf("%s: %d, want %d (all: %v)", kind, k[kind], c, k)
		}
	}
	if n != len(evs) {
		t.Fatal("count")
	}
	wf := ofType(evs, "workflow.finished")[0]
	if wf.Data["status"] != "completed" || wf.Data["stop_reason"] != nil || wf.Cause == nil || wf.Cause.Basis != "identity" {
		t.Fatalf("workflow.finished: %+v", wf.Data)
	}
	if wf.ID != "s:"+x1+":26.0" {
		t.Fatalf("workflow.finished is anchored to the notification line: %s", wf.ID)
	}
	ref := ofType(evs, "tool.refused")[0]
	if ref.IDs.AgentID != x1+"/a0000000000000001" || ref.IDs.ToolCallID != "" || ref.Data["tool"] != "Bash" {
		t.Fatalf("refusal linked to its agent: %+v %+v", ref.IDs, ref.Data)
	}
	for _, e := range ofType(evs, "agent.finished") {
		if e.Data["status"] != "done" || e.Time.Precision != "ms" || e.Data["duration_ms"] == nil {
			t.Fatalf("agent.finished: %+v %+v", e.Data, e.Time)
		}
		if e.Cause == nil || !strings.HasPrefix(e.Cause.EventID, "s:"+x1+":") {
			t.Fatalf("agent.finished cause: %+v", e.Cause)
		}
	}
	for _, e := range ofType(evs, "agent.progressed") {
		if _, ok := e.Data["cost_usd"]; ok {
			t.Fatal("a per-agent cost")
		}
	}
	use := ofType(evs, "execution.usage")[0]
	if use.Data["budget_exhausted"] != false || use.Data["subtype"] != "success" {
		t.Fatalf("usage: %+v", use.Data)
	}
	models := use.Data["models"].(map[string]any)
	if len(models) == 0 {
		t.Fatal("no per-model usage")
	}
	for _, e := range ofType(evs, "tool.called") {
		if e.Data["tool"] != "Workflow" || e.Data["target_class"] != "workflow" || e.IDs.AgentID != x1+"/main" {
			t.Fatalf("main-loop call: %+v", e)
		}
	}
	// Heartbeats are not events: 17 task_progress records, 7 of them snapshots.
	if len(ofType(evs, "agent.progressed")) > 7 {
		t.Fatalf("progress emitted from heartbeats: %d", len(ofType(evs, "agent.progressed")))
	}
}

func TestBudgetKilledWorkflowThatReportsSuccess(t *testing.T) {
	root := testkit.Project(t)
	execution(t, root, x1, "budget-stops-workflow.jsonl", true)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	wf := ofType(evs, "workflow.finished")
	if len(wf) != 1 || wf[0].Data["status"] != "killed" || wf[0].Data["stop_reason"] != "unknown" || wf[0].Data["notification_status"] != "stopped" {
		t.Fatalf("a success result must never read as a completed workflow: %+v", wf)
	}
	use := ofType(evs, "execution.usage")[0]
	if use.Data["subtype"] != "success" || use.Data["budget_exhausted"] != false {
		t.Fatalf("%+v", use.Data)
	}
	// The agents were killed with requests in flight: the reported spend may be low (proof 3.5).
	if use.Data["cost_complete"] != false || fmt.Sprint(use.Data["cost_incomplete_reasons"]) != "[agents-killed-in-flight]" {
		t.Fatalf("cost completeness %+v", use.Data)
	}
	for _, a := range ofType(evs, "agent.finished") {
		if a.Data["status"] != "error" {
			t.Fatalf("killed agents report error: %+v", a.Data)
		}
	}

	// With stderr's budget line the stop is attributed, marked as read from stderr.
	root2 := testkit.Project(t)
	execution(t, root2, x1, "budget-stops-workflow.jsonl", true)
	testkit.WriteFile(t, filepath.Join(testkit.ExecDir(root2, x1), "stderr.log"),
		[]byte("Budget limit reached ($0.17 of $0.15); stopping background agents.\n/Users/someone/secret path\n"))
	h2 := newHarness(t, root2, "", false)
	h2.drain()
	wf2 := ofType(h2.events(), "workflow.finished")[0]
	if wf2.Data["stop_reason"] != "budget" || wf2.Inferred["data.stop_reason"] != "stderr-line" {
		t.Fatalf("%+v %+v", wf2.Data, wf2.Inferred)
	}
	use2 := ofType(h2.events(), "execution.usage")[0]
	if use2.Data["cost_complete"] != false || fmt.Sprint(use2.Data["cost_incomplete_reasons"]) != "[budget-stop agents-killed-in-flight]" {
		t.Fatalf("a budget-killed workflow's cost is flagged as possibly under-reported: %+v", use2.Data)
	}
	for _, raw := range h2.raws() {
		if strings.Contains(string(raw), "secret path") {
			t.Fatal("stderr content was forwarded")
		}
	}
}

func TestBudgetExceededResult(t *testing.T) {
	root := testkit.Project(t)
	execution(t, root, x1, "budget-exceeded.jsonl", true)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	use := ofType(evs, "execution.usage")[0]
	if use.Data["budget_exhausted"] != true || use.Data["terminal_reason"] != "budget_exhausted" || use.Data["cost_complete"] != false {
		t.Fatalf("%+v", use.Data)
	}
	wf := ofType(evs, "workflow.finished")
	if len(wf) != 1 || wf[0].Data["status"] != "killed" || wf[0].Data["stop_reason"] != "budget" {
		t.Fatalf("%+v", wf)
	}
}

func TestAgentToolSubAgentsAreStreamedPerCall(t *testing.T) {
	root := testkit.Project(t)
	execution(t, root, x1, "agent-tool-contrast.jsonl", true)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	calls := ofType(evs, "tool.called")
	if len(calls) != 4 {
		t.Fatalf("calls: %d", len(calls))
	}
	sub := 0
	for _, c := range calls {
		if c.IDs.AgentID != x1+"/main" {
			sub++
			if c.IDs.ParentAgentID != x1+"/main" || c.Parent != "agent:"+c.IDs.AgentID {
				t.Fatalf("sub-agent call: %+v", c.IDs)
			}
		}
	}
	if sub != 2 {
		t.Fatalf("sub-agent calls %d", sub)
	}
	for _, r := range ofType(evs, "tool.returned") {
		if r.Cause == nil || r.Data["duration_ms"] == nil {
			t.Fatalf("returned: %+v", r)
		}
	}
	if len(ofType(evs, "workflow.started")) != 0 || len(ofType(evs, "agent.started")) != 0 {
		t.Fatal("Agent-tool tasks are not workflows")
	}
}

func TestBeltParallelAgentsAndLabels(t *testing.T) {
	root := testkit.Project(t)
	execution(t, root, x1, "belt-build-verify-review.jsonl", true)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	if use := ofType(evs, "execution.usage"); len(use) != 1 || use[0].Data["cost_complete"] != true || fmt.Sprint(use[0].Data["cost_incomplete_reasons"]) != "[]" {
		t.Fatalf("a completed belt reports its cost complete: %+v", use)
	}
	seats := map[string]string{}
	for _, e := range ofType(evs, "agent.started") {
		label := e.Data["label"].(string)
		if strings.HasSuffix(label, "reviewer") {
			if e.IDs.Station != "review" || e.Inferred["ids.seat"] != "label" || e.IDs.TicketID != "TICKET-1" {
				t.Fatalf("reviewer: %+v %+v", e.IDs, e.Inferred)
			}
			if prev, dup := seats[e.IDs.AgentID]; dup {
				t.Fatalf("two reviewers share an agent id: %s %s", prev, e.IDs.Seat)
			}
			seats[e.IDs.AgentID] = e.IDs.Seat
		}
		if strings.HasSuffix(label, "what next?") && (e.IDs.Station != "" || e.IDs.TicketID != "TICKET-1") {
			t.Fatalf("clerk: %+v", e.IDs)
		}
	}
	got := map[string]bool{}
	for _, s := range seats {
		got[s] = true
	}
	if !got["architecture"] || !got["security"] || !got["product"] {
		t.Fatalf("parallel reviewers not distinguished: %v", seats)
	}
	// The fixture's {"_omitted_records": n} lines are not Claude records: counted, never read.
	gaps := ofType(evs, "history.gap")
	found := false
	for _, g := range gaps {
		if g.Data["reason"] == "unknown-type" && strings.Contains(g.ID, "type-untyped") {
			found = true
		}
	}
	if !found {
		t.Fatalf("untyped lines not reported: %d gaps", len(gaps))
	}
	if h.o.Stats().Unrecognised["untyped"] != 2 {
		t.Fatalf("unrecognised: %v", h.o.Stats().Unrecognised)
	}
}

func TestWorkflowToolRefusedAndUnknownRecordType(t *testing.T) {
	root := testkit.Project(t)
	execution(t, root, x1, "workflow-tool-refused.jsonl", true)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	if len(ofType(evs, "workflow.started")) != 0 || len(ofType(evs, "workflow.finished")) != 0 {
		t.Fatal("no workflow ran")
	}
	found := false
	for _, g := range ofType(evs, "history.gap") {
		if strings.Contains(g.ID, "type-system%2Fthinking_tokens") {
			found = true
		}
	}
	if !found {
		t.Fatal("an unrecognised record type is reported by name only")
	}
}

// A version the fixtures do not come from is read record by record (M6_1_STREAM_COMPATIBILITY.md
// section 8): when every record has a known shape, everything is forwarded and the runtime is
// flagged compatible-unproven, on the source and on each event.
func TestUnprovenVersionWithKnownShapesIsAccepted(t *testing.T) {
	root := testkit.Project(t)
	execution(t, root, x1, "probe-workflow.jsonl", true)
	p := filepath.Join(testkit.ExecDir(root, x1), "stream.jsonl")
	b, _ := os.ReadFile(p)
	os.WriteFile(p, []byte(strings.ReplaceAll(string(b), `"2.1.322"`, `"9.9.9"`)), 0o644)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	k := kinds(evs)
	if k["agent.started"] == 0 || k["workflow.started"] != 1 || k["workflow.finished"] != 1 || k["session.initialized"] != 1 || k["history.gap"] != 0 {
		t.Fatalf("an unproven version with known shapes: %v", k)
	}
	for _, e := range evs {
		if e.Origin.Stream == event.StreamClaude && e.Origin.RuntimeState != "compatible-unproven" {
			t.Fatalf("%s carries runtime_state %q", e.ID, e.Origin.RuntimeState)
		}
	}
	st := h.o.Stats()
	for _, s := range st.Sources {
		if s.Key == "stream/"+x1 && (s.StreamKnown == nil || !*s.StreamKnown || s.ClaudeVersion != "9.9.9" || s.Runtime == nil ||
			s.Runtime.State != "compatible-unproven" || s.Runtime.RecordsRefused != 0 || s.Runtime.RecordsAccepted == 0) {
			t.Fatalf("%+v %+v", s, s.Runtime)
		}
	}
	if st.Runtime.State != "compatible-unproven" || len(st.Runtime.Versions) != 1 || st.Runtime.Versions[0].Version != "9.9.9" {
		t.Fatalf("runtime summary %+v", st.Runtime)
	}
}

// The same future version whose task_progress records changed shape (a time became a string):
// each such record is refused on its own, counted, and nothing of it is forwarded: no agent
// events, one unexpected-shape gap that does not mark history as lost. The other records are
// still read; the source says incompatible.
func TestChangedShapeIsRefusedPerRecord(t *testing.T) {
	root := testkit.Project(t)
	execution(t, root, x1, "probe-workflow.jsonl", true)
	p := filepath.Join(testkit.ExecDir(root, x1), "stream.jsonl")
	b, _ := os.ReadFile(p)
	var out []string
	progress := 0
	for _, line := range strings.Split(strings.TrimRight(strings.ReplaceAll(string(b), `"2.1.322"`, `"9.9.10"`), "\n"), "\n") {
		var rec map[string]any
		if json.Unmarshal([]byte(line), &rec) == nil && rec["subtype"] == "task_progress" {
			changed := false
			if items, ok := rec["workflow_progress"].([]any); ok {
				for _, it := range items {
					if m, ok := it.(map[string]any); ok && m["type"] == "workflow_agent" {
						m["startedAt"] = "2026-11-12T10:00:00Z"
						changed = true
					}
				}
			}
			if changed {
				progress++ // a heartbeat with no agent list keeps its shape
			}
			nb, _ := json.Marshal(rec)
			line = string(nb)
		}
		out = append(out, line)
	}
	os.WriteFile(p, []byte(strings.Join(out, "\n")+"\n"), 0o644)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	k := kinds(evs)
	if k["agent.queued"]+k["agent.started"]+k["agent.progressed"]+k["agent.finished"] != 0 || k["workflow.phases_declared"] != 0 ||
		k["workflow.started"] != 1 || k["session.initialized"] != 1 || k["execution.usage"] != 1 {
		t.Fatalf("changed shape: %v", k)
	}
	gaps := ofType(evs, "history.gap")
	if len(gaps) != 1 || gaps[0].Data["reason"] != "unexpected-shape" || gaps[0].Data["class"] != "unknown-type" || gaps[0].Data["history_lost"] != false {
		t.Fatalf("gaps %+v", gaps)
	}
	for _, s := range h.o.Stats().Sources {
		if s.Key == "stream/"+x1 {
			if s.Runtime == nil || s.Runtime.State != "incompatible" || s.Runtime.RecordsRefused != int64(progress) ||
				s.Runtime.RefusedByClass["system/task_progress"] != int64(progress) || s.StreamKnown == nil || *s.StreamKnown {
				t.Fatalf("%+v %+v (progress records %d)", s, s.Runtime, progress)
			}
		}
	}
}

func TestOpenSpansClosedAtProcessEnd(t *testing.T) {
	root := testkit.Project(t)
	execution(t, root, x1, "probe-workflow.jsonl", true)
	p := filepath.Join(testkit.ExecDir(root, x1), "stream.jsonl")
	b, _ := os.ReadFile(p)
	lines := strings.SplitAfter(string(b), "\n")
	os.WriteFile(p, []byte(strings.Join(lines[:10], "")), 0o644) // killed after the second snapshot
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	closed := 0
	for _, e := range ofType(evs, "agent.finished") {
		if e.Authority == event.Reconstructed {
			closed++
			if e.Data["status"] != "unknown" || e.Time.Precision != "bounded" || !strings.HasPrefix(e.ID, "o:close:agent:") {
				t.Fatalf("%+v", e)
			}
		}
	}
	if closed != 3 {
		t.Fatalf("closed %d open agents", closed)
	}
	if len(ofType(evs, "workflow.finished")) != 0 {
		t.Fatal("a workflow without task_updated is not reported finished")
	}
}

func TestLifecycleHelperSample(t *testing.T) {
	root := testkit.Project(t)
	data, err := os.ReadFile(filepath.Join("..", "normalize", "testdata", "lifecycle-helper.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	testkit.WriteFile(t, filepath.Join(testkit.CellDir(root, "LOCAL-001"), "cell.json"), mustJSON(map[string]any{"stage": "merged", "created_at": "2026-11-12T20:55:40+00:00"}))
	testkit.Append(t, testkit.CellLog(root, "LOCAL-001"), data)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	life := 0
	for _, e := range evs {
		if e.Origin.Stream == event.StreamLifecycle {
			life++
			if e.Authority != event.Authoritative || e.IDs.CellInstance == "" || !strings.HasPrefix(e.IDs.VisitID, "LOCAL-001/") {
				t.Fatalf("%+v", e)
			}
		}
	}
	if life != 15 {
		t.Fatalf("lifecycle events %d", life)
	}
	v := ofType(evs, "review.verdict_submitted")[0]
	if v.Data["vote"] != "APPROVE" || v.IDs.Seat != "security" || v.Data["model"] != "sonnet" {
		t.Fatalf("%+v %+v", v.Data, v.IDs)
	}
	exit := ofType(evs, "station.exited")[0]
	if exit.Data["duration_ms"] != int64(1) && exit.Data["duration_ms"] != float64(1) || exit.Cause == nil {
		t.Fatalf("duration from the matching entry: %+v", exit.Data)
	}
	g := ofType(evs, "gate.evaluated")
	if g[1].Data["status"] != "PASS" || g[0].Data["audit_tier"] != "Gold" || g[0].Data["verdict"] != "passed" {
		t.Fatalf("%+v %+v", g[0].Data, g[1].Data)
	}
	if len(ofType(evs, "history.gap")) != 0 {
		t.Fatalf("gaps: %+v", ofType(evs, "history.gap")[0].Data)
	}
}

func TestOldLifecycleFilesNameTheRoundAttempt(t *testing.T) {
	root := testkit.Project(t)
	testkit.Append(t, testkit.CellLog(root, "T-1"), testkit.Record{Seq: 1, Ticket: "T-1", Type: "station.entered", Station: "build", Round: 2, OldRound: true, Data: map[string]any{"stage": "building"}}.Line())
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	e := ofType(h.events(), "station.entered")[0]
	if e.IDs.Round != 2 || e.IDs.Attempt != 0 {
		t.Fatalf("%+v", e.IDs)
	}
}

// The acceptance run's Claude Code, 2.1.323 (a sanitized excerpt of a real belt execution), is a
// proven version: its workflow, agents and tool calls are read, every record matches the known
// shapes, and the one record type 2.1.323 added (system/thinking_tokens) is a gap that is
// received, not interpreted, and loses no history.
func TestRealStream2_1_323IsReadWhole(t *testing.T) {
	root := testkit.Project(t)
	execution(t, root, x1, "belt-plan-build-verify-2.1.323.jsonl", true)
	h := newHarness(t, root, "", false)
	h.drain()
	h.validate()
	evs := h.events()
	k := kinds(evs)
	if k["workflow.started"] != 1 || k["agent.started"] < 5 || k["agent.queued"] < 5 || k["tool.called"] == 0 || k["tool.refused"] == 0 || k["execution.usage"] != 1 {
		t.Fatalf("2.1.323: %v", k)
	}
	for _, g := range ofType(evs, "history.gap") {
		if g.Data["reason"] != "unknown-type" || g.Data["history_lost"] != false {
			t.Fatalf("gap %+v", g.Data)
		}
	}
	for _, s := range h.o.Stats().Sources {
		if s.Key == "stream/"+x1 && (s.Runtime == nil || s.Runtime.State != "proven" || s.Runtime.RecordsRefused != 0 || s.ClaudeVersion != "2.1.323") {
			t.Fatalf("%+v %+v", s, s.Runtime)
		}
	}
	for _, e := range evs {
		if e.Origin.Stream == event.StreamClaude && e.Origin.RuntimeState != "proven" {
			t.Fatalf("%s: runtime_state %q", e.ID, e.Origin.RuntimeState)
		}
	}
}
