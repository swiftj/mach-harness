package main

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"mach/observer/internal/project"
	"mach/observer/internal/testkit/synth"
)

// M6.3 round 5, over the synthetic history through the real observer: nothing stays open under
// an execution that ended or whose outcome is unknown, and an interrupted execution is never
// "failed". The size and seed are the browser suite's (e2e/synthetic.e2e.mjs).
func TestNothingStaysOpenUnderAnEndedExecution(t *testing.T) {
	root := t.TempDir()
	sum, err := synth.Generate(synth.Options{Out: root, Events: 12000, Seed: 7, Cells: 12, Hours: 6})
	if err != nil {
		t.Fatal(err)
	}
	r := launch(t, root)
	defer r.stop(t)
	r.client.Timeout = 2 * time.Minute
	waitSettled(t, r, 5*time.Minute, uint64(sum.Events)*98/100)

	var spans []project.Span
	for off := 0; ; off += 1000 {
		var reply struct {
			Data struct {
				Items []project.Span `json:"items"`
				Total int            `json:"total"`
			} `json:"data"`
		}
		if err := json.Unmarshal(r.get(t, fmt.Sprintf("/api/v1/spans?limit=1000&offset=%d", off)), &reply); err != nil {
			t.Fatal(err)
		}
		spans = append(spans, reply.Data.Items...)
		if off+len(reply.Data.Items) >= reply.Data.Total || len(reply.Data.Items) == 0 {
			break
		}
	}
	ended := map[string]string{} // execution -> its state, for executions that ended or whose outcome is unknown
	for _, sp := range spans {
		if sp.Kind != "execution" {
			continue
		}
		x := sp.IDs["execution_id"]
		if sp.Attrs.State == "" {
			t.Errorf("%s carries no attrs.state", sp.SpanID)
		}
		if sp.End != nil || sp.Attrs.State == "unknown" {
			ended[x] = sp.Attrs.State
		}
		stopped := sp.Attrs.State == "interrupted" || sp.Attrs.State == "timed-out" || sp.Attrs.State == "could-not-start"
		if stopped && (sp.End == nil || sp.End.Reason != "interrupted" || sp.Duration.Basis == "measured") {
			t.Errorf("%s (%s): end %+v duration %+v", sp.SpanID, sp.Attrs.State, sp.End, sp.Duration)
		}
		if sp.Attrs.State == "unknown" && (sp.End == nil || sp.End.Reason != "unknown") {
			t.Errorf("%s: unknown outcome, end %+v", sp.SpanID, sp.End)
		}
	}
	for _, k := range []string{"interrupted_execution", "outcome_unknown_execution"} {
		x, _ := sum.Features[k].(string)
		if _, ok := ended[x]; x == "" || !ok {
			t.Fatalf("the generator's %s %q did not end in /spans", k, x)
		}
	}
	if s := ended[sum.Features["interrupted_execution"].(string)]; s != "interrupted" {
		t.Errorf("the interrupted execution reads %q", s)
	}
	children := map[string]bool{"claim": true, "workflow": true, "agent-queue": true, "agent": true, "tool": true}
	closed := 0
	for _, sp := range spans {
		x := sp.IDs["execution_id"]
		if _, ok := ended[x]; !ok || !children[sp.Kind] {
			continue
		}
		if sp.End == nil {
			t.Errorf("under %s (%s), %s is still open", x, ended[x], sp.SpanID)
			continue
		}
		if sp.End.Rule == "execution-ended" {
			closed++
			if sp.Outcome != nil || sp.End.Basis != "inferred" || (sp.End.Reason != "interrupted" && sp.End.Reason != "unknown") {
				t.Errorf("%s: closed at its execution's end with %+v outcome %v", sp.SpanID, sp.End, sp.Outcome)
			}
		}
	}
	if closed == 0 {
		t.Errorf("no span was closed at its execution's end: the synthetic history has open spans under its interrupted execution")
	}
	t.Logf("%d spans, %d ended executions, %d children closed at their execution's end", len(spans), len(ended), closed)
}
