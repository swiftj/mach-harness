package artifact

import (
	"path/filepath"
	"strings"
	"testing"

	"mach/observer/internal/redact"
)

// M7 (0fcbb1b): after the merge station voids an approval, the re-review opens review/round-N.k
// and the voided round's decision.json is kept, marked void with its reason (merge.py's shape).
// The catalogue lists the repeat as judging round N (repeat k), and the voided decision as voided,
// never as the standing approval.
func TestRepeatedReviewFolders(t *testing.T) {
	f := project(t, nil)
	write(t, filepath.Join(f.cell, "review/round-2/findings.md"), []byte("# Findings\n"))
	write(t, filepath.Join(f.cell, "review/round-2/decision.json"), []byte(`{"ticket_id":"T-1","round":2,"outcome":"VOID","head":"fc3ca1f70388",
"void":{"reason":"The branch changed after it was approved.","voided_at":"2026-11-14T22:50:01+00:00","approved_commit":"fc3ca1f70388","branch_commit":"0a1b2c3d4e5f","by":"merge station"},
"outcome_before_void":"APPROVED"}`))
	write(t, filepath.Join(f.cell, "review/round-2.1/findings.md"), []byte("# Findings\n"))
	write(t, filepath.Join(f.cell, "review/round-2.1/decision.json"), []byte(`{"ticket_id":"T-1","round":2,"outcome":"APPROVED","head":"0a1b2c3d4e5f"}`))
	write(t, filepath.Join(f.cell, "review/round-2.x/decision.json"), []byte(`{}`))
	write(t, filepath.Join(f.cell, "review/round-2.01/decision.json"), []byte(`{}`))
	got := byPath(New(f.root))
	voided, repeat := got["cell:review/round-2/decision.json"], got["cell:review/round-2.1/decision.json"]
	if voided.Round == nil || *voided.Round != 2 || voided.Repeat != nil || voided.Voided == nil ||
		*voided.Voided != (Voided{ReasonCode: "branch-changed-after-approval", OutcomeBefore: "APPROVED", ApprovedCommit: "fc3ca1f70388", BranchCommit: "0a1b2c3d4e5f"}) {
		t.Fatalf("voided round-2 decision = %+v (voided %+v)", voided, voided.Voided)
	}
	if repeat.Round == nil || *repeat.Round != 2 || repeat.Repeat == nil || *repeat.Repeat != 1 || repeat.Voided != nil {
		t.Fatalf("round-2.1 decision = %+v, want judging round 2, repeat 1, standing", repeat)
	}
	if f := got["cell:review/round-2.1/findings.md"]; f.Repeat == nil || *f.Repeat != 1 || f.Voided != nil {
		t.Fatalf("round-2.1 findings = %+v", f)
	}
	for k := range got {
		if strings.Contains(k, "round-2.x") || strings.Contains(k, "round-2.01") {
			t.Fatalf("catalogued a folder that is not round-N or round-N.k: %s", k)
		}
	}
	// The voided decision's record is served with its void record (codes, commits, the reason).
	text, _, err := redact.ScrubRecord([]byte(`{"outcome":"VOID","void":{"reason":"The branch changed after it was approved.","approved_commit":"fc3ca1f70388","branch_commit":"0a1b2c3d4e5f","by":"merge station"},"outcome_before_void":"APPROVED"}`),
		redact.KindDecision, f.root, redact.RecordOptions{HashKeys: []string{"approved_commit", "branch_commit"}})
	if err != nil || !strings.Contains(text, `"outcome_before_void": "APPROVED"`) || !strings.Contains(text, "fc3ca1f70388") || !strings.Contains(text, "The branch changed after it was approved.") {
		t.Fatalf("served voided decision:\n%s (%v)", text, err)
	}
}
