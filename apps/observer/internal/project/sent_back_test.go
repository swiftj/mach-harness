package project

import (
	"strings"
	"testing"

	"mach/observer/internal/feedtest"
)

// M9: a person at the approval gate either approves or sends the change back to the build
// station. A send-back closes the gate and its wait (W3) as an approval does, because the person
// answered, but it is not an approval anywhere approvals are counted or shown.
func sentBackRun(decision any, withDecision bool) []map[string]any {
	const x1 = "xeb8b948e8cf9"
	i := func(typ string, ms int64) *feedtest.Ev {
		return feedtest.New("intake-log", typ, ms).ID("project_id", "textkit").ID("wave_id", "WAVE-001")
	}
	c := func(typ string, ms int64, visit string, round int) *feedtest.Ev {
		return feedtest.New("cell-lifecycle", typ, ms).Ticket("LOCAL-001").ID("slice_id", "SLICE-001").ID("wave_id", "WAVE-001").Visit("LOCAL-001", visit, round)
	}
	var out []map[string]any
	add := func(e *feedtest.Ev) { out = append(out, e.Build()) }
	add(i("work.claimed", 1_000).Ticket("LOCAL-001").Exec(x1).ID("slice_id", "SLICE-001").Data(map[string]any{"stage": "verified", "next": "review", "attempt": 1}))
	add(c("review.decided", 10_000, "review#1", 1).Exec(x1).Data(map[string]any{"outcome": "AWAITING_HUMAN", "approvals": 3, "approvals_needed": 3,
		"votes": map[string]any{"architecture": "APPROVE", "security": "APPROVE", "product": "APPROVE"}, "blockers": 0, "security_veto": false, "human_approval_required": true}))
	add(c("station.exited", 10_001, "review#1", 1).Exec(x1).Data(map[string]any{"station": "review", "outcome": "AWAITING_HUMAN", "stage": "awaiting-human", "duration_ms": 4100, "closed_by": nil, "head": nil, "counts": map[string]any{}}))
	add(i("human.required", 11_000).ID("slice_id", "SLICE-001").Ticket("LOCAL-001").Data(map[string]any{"reason": "waiting for human-approval"}))
	add(c("station.entered", 12_000, "human-approval#1", 1).Data(map[string]any{"station": "human-approval", "stage": "awaiting-human", "action": nil, "resumed": false, "unclosed_visit": nil, "head": nil, "counts": map[string]any{}}))
	data := map[string]any{"by_role": "person", "note_given": true}
	if withDecision {
		data["decision"] = decision
	}
	add(c("human.approval_recorded", 40_000, "human-approval#1", 1).Data(data))
	outcome, stage := "approved", "approved"
	if s, _ := decision.(string); strings.EqualFold(s, "SENT_BACK") {
		outcome, stage = "sent-back", "built"
	}
	add(c("station.exited", 40_001, "human-approval#1", 1).Data(map[string]any{"station": "human-approval", "outcome": outcome, "stage": stage, "duration_ms": 28001, "closed_by": nil, "head": nil, "counts": map[string]any{}}))
	return out
}

func TestHumanDecisionReads(t *testing.T) {
	for in, want := range map[any]string{"APPROVED": DecisionApproved, "approve": DecisionApproved, "SENT_BACK": DecisionSentBack, "sent_back": DecisionSentBack,
		" Sent_Back ": DecisionSentBack, "maybe": DecisionApproved, "": DecisionApproved, nil: DecisionApproved, 3: DecisionApproved} {
		if got := HumanDecision(in); got != want {
			t.Errorf("HumanDecision(%#v) = %q, want %q", in, got, want)
		}
	}
}

func TestSentBackClosesTheGateButIsNotAnApproval(t *testing.T) {
	cases := []struct {
		name     string
		decision any
		with     bool
		want     string
	}{
		{"approved", "APPROVED", true, DecisionApproved},
		{"sent back", "SENT_BACK", true, DecisionSentBack},
		{"sent back, lower case", "sent_back", true, DecisionSentBack},
		{"no decision (an older record)", nil, false, DecisionApproved},
		{"an unknown value", "maybe", true, DecisionApproved},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := m66State(t, sentBackRun(tc.decision, tc.with))
			sentBack := tc.want == DecisionSentBack
			c := s.Cells["LOCAL-001"]
			if c == nil || len(c.Approvals) != 1 {
				t.Fatalf("cell approvals %+v", c)
			}
			a := c.Approvals[0]
			if a.Decision != tc.want || a.Approved() == sentBack || !a.NoteGiven || a.ByRole != "person" {
				t.Fatalf("approval %+v, want decision %s", a, tc.want)
			}
			wantBy := "human.approval_recorded"
			if sentBack {
				wantBy = ClosedSentBack
			}
			// Both the review's approval gate and the supervisor's "a person is needed" end on
			// the person's answer.
			kinds := map[string]bool{}
			for _, g := range s.Gates {
				if g.TicketID != "LOCAL-001" {
					continue
				}
				kinds[g.Kind] = true
				if g.Closed == nil || g.Closed.At == nil || *g.Closed.At != feedtest.At(40_000) || g.ClosedBy != wantBy {
					t.Errorf("gate %s closed %+v by %q, want by %q at the answer", g.Key, g.Closed, g.ClosedBy, wantBy)
				}
			}
			if !kinds["approval"] || !kinds["required"] {
				t.Fatalf("gates %v", kinds)
			}
			// W3 measures the wait for the person's answer either way: 30,000 ms, none open.
			w3 := s.Metrics.Rows([]string{"W3"}, "")[0]
			if w3.Value == nil || *w3.Value != 30000 || w3.Denominator == nil || *w3.Denominator != 1 {
				t.Errorf("W3 %+v", w3)
			}
			// The wait span's outcome says how it ended.
			var gateWait *Span
			for _, sp := range Spans(s, SpanFilter{Ticket: "LOCAL-001", Kinds: map[string]bool{"gate-wait": true}}) {
				gateWait = sp
			}
			if gateWait == nil || gateWait.Outcome == nil || *gateWait.Outcome != wantBy || gateWait.End == nil {
				t.Fatalf("gate-wait %+v", gateWait)
			}
			// The person's mark: an approval reads approved; a send-back never does.
			marks, _ := Marks(s, MarkFilter{Kinds: map[string]bool{"human": true}}, 100)
			var answer *Mark
			for _, m := range marks {
				if m.UntilMS == nil && m.AtMS == feedtest.At(40_000) {
					answer = m
				}
			}
			if answer == nil || answer.Verdict == nil {
				t.Fatalf("no mark for the person's answer in %+v", marks)
			}
			if sentBack {
				if *answer.Verdict != "sent-back" || strings.Contains(strings.ToLower(answer.Label), "approv") || !strings.Contains(answer.Label, "sent the change back") {
					t.Errorf("send-back mark %q / %q", *answer.Verdict, answer.Label)
				}
			} else if *answer.Verdict != "approved" || answer.Label != "A person recorded an approval." {
				t.Errorf("approval mark %q / %q", *answer.Verdict, answer.Label)
			}
			// The cell's view carries the decision with each entry.
			v := CellDetail(s, c)
			list, _ := v["approvals"].([]*Approval)
			if len(list) != 1 || list[0].Decision != tc.want {
				t.Errorf("cell view approvals %+v", v["approvals"])
			}
		})
	}
}
