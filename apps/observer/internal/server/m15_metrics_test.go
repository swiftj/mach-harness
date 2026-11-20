package server

import (
	"testing"

	"mach/observer/internal/feedtest"
)

// M15: the merge-time recheck (M13) voids an approval and sends the ticket back to be verified and
// reviewed again in the same judging round (review/round-1.1). Nothing it records may count as a
// second judging round, a second first pass or a rejection: Q1 counts the first round-1 verdict
// only, R1 and R3 keep one decision per judging round (the repeat's), and the refusal is a gate
// refusal (X2) like any other.
func TestARecheckedTicketCountsOnceInTheCatalogue(t *testing.T) {
	c := func(typ string, ms int64, visit string, round int) *feedtest.Ev {
		return feedtest.New("cell-lifecycle", typ, ms).Ticket("T-5").Visit("T-5", visit, round)
	}
	start := map[string]any{"risk": "Medium", "max_rounds": 3, "tuning": false, "approvals_needed": 2, "human_approval_required": false,
		"panel": []map[string]any{{"seat": "architecture", "model": nil}, {"seat": "security", "model": nil}, {"seat": "product", "model": nil}}, "delta": false, "restarted": false}
	verdict := func(ms int64, visit, status string) map[string]any {
		return c("gate.evaluated", ms, visit, 1).Data(map[string]any{"gate": "verify.verdict", "verdict": map[bool]string{true: "passed", false: "refused"}[status == "PASS"],
			"reason_code": status, "subject": nil, "status": status, "audit_tier": nil, "counts": map[string]any{}}).Build()
	}
	decided := func(ms int64, visit string, veto bool, outcome string) map[string]any {
		return c("review.decided", ms, visit, 1).Data(map[string]any{"outcome": outcome, "approvals": 3, "approvals_needed": 2,
			"votes": map[string]any{"architecture": "APPROVE", "security": "APPROVE", "product": "APPROVE"}, "blockers": 0, "security_veto": veto, "human_approval_required": false}).Build()
	}
	events := []map[string]any{
		verdict(1000, "verify#1", "PASS"),
		c("review.round_started", 2000, "review#1", 1).Data(start).Build(),
		decided(3000, "review#1", true, "REJECTED"),
		c("gate.evaluated", 4000, "merge#1", 1).Data(map[string]any{"gate": "merge.landed_overlap", "verdict": "refused", "reason_code": "landed-overlap",
			"subject": nil, "status": nil, "audit_tier": nil, "counts": map[string]any{"landed_commits": 2, "files": 1, "problems": 0}}).Build(),
		// verified again in round 1 (the review loop did not move), and reviewed in the repeat round-1.1
		verdict(5000, "verify#2", "FAIL_WITH_EVIDENCE"),
		c("review.round_started", 6000, "review#2", 1).Data(map[string]any{"risk": "Medium", "max_rounds": 3, "tuning": false, "approvals_needed": 2,
			"human_approval_required": false, "panel": start["panel"], "delta": false, "restarted": true, "repeat": 1}).Build(),
		decided(7000, "review#2", false, "APPROVED"),
	}
	h := start2(t, events)
	d := h.get(t, "/api/v1/analytics/metrics?ids=Q1,R1,R3,X2&from_ms=0")
	if q1 := metricRow(t, d, "Q1"); q1["numerator_value"] != 1.0 || q1["denominator_value"] != 1.0 {
		t.Errorf("Q1 counts the re-verification as another first pass: %v / %v", q1["numerator_value"], q1["denominator_value"])
	}
	if r1 := metricRow(t, d, "R1"); r1["numerator_value"] != 0.0 || r1["denominator_value"] != 1.0 {
		t.Errorf("R1: %v / %v", r1["numerator_value"], r1["denominator_value"])
	}
	if r3 := metricRow(t, d, "R3"); r3["numerator_value"] != 0.0 || r3["denominator_value"] != 1.0 {
		t.Errorf("R3 keeps the voided decision's veto: %v / %v", r3["numerator_value"], r3["denominator_value"])
	}
	if x2 := metricRow(t, d, "X2"); x2["numerator_value"] != 2.0 || x2["denominator_value"] != 3.0 {
		t.Errorf("X2: %v / %v", x2["numerator_value"], x2["denominator_value"])
	}
}

func start2(t *testing.T, events []map[string]any) *harness {
	t.Helper()
	return start(t, config{events: events})
}
