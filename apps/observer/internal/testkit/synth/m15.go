package synth

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"

	"mach/observer/internal/testkit"
)

// M15: the Factory changes of M13 and M14 the Factory Floor shows, in the default profile's test
// data (the analytics profiles keep their own expected figures and are not changed):
//
//   - a ticket stopped on a conflict with main (build.start refused main-conflict, and the
//     supervisor's human.required "waiting for main-conflict");
//   - a ticket whose spec is held only by a policy concern (groom.finalize refused open-questions with
//     no open question, and "waiting for policy-owner");
//   - a ticket the merge-time recheck sent back (merge.landed_overlap refused, merge exit
//     landed-overlap, verified again and reviewed in the repeat round-1.1, then merged with a change
//     record), whose verification compared a binding design mock (MOCK-1 in results.json);
//   - a slice issue held at intake for its design mocks (intake.refused, intake's sentence);
//   - Jira keys on some slices (the ledger and the run record) and a change record on run records.
//
// Every record is one a station or intake writes, in its own shape.

const (
	m15Conflict = "SYN-M15A"
	m15Policy   = "SYN-M15B"
	m15Recheck  = "SYN-M15C"
	m15Waiting  = "SLICE-090"
)

func (w *world) m15On() bool { return w.o.M15 && w.an == nil }

// jiraOf is a slice's synthetic Jira key, for every third slice.
func jiraOf(i int) string {
	if i%3 != 0 {
		return ""
	}
	return fmt.Sprintf("SYNJ-%d", 100+i)
}

// m15Intake adds the intake log's M15 records near the end of the history.
func (w *world) m15Intake() {
	if !w.m15On() {
		return
	}
	at := func(f float64) float64 { return w.endT * f }
	mock := sha256.Sum256(m15MockPicture)
	w.intake = append(w.intake,
		&intakeRec{t: at(0.94), wt: at(0.94), typ: "human.required", source: "supervisor", ticket: m15Conflict, data: map[string]any{"reason": "waiting for main-conflict"}},
		&intakeRec{t: at(0.95), wt: at(0.95), typ: "human.required", source: "supervisor", ticket: m15Policy, data: map[string]any{"reason": "waiting for policy-owner"}},
		&intakeRec{t: at(0.96), wt: at(0.96), typ: "intake.refused", source: "intake", slice: m15Waiting, rev: 1, data: map[string]any{"problems": []any{
			"Waiting for its design mocks: the approved pictures must be committed to the integration branch at product/ready/" + m15Waiting + "/mocks/. " +
				"product/ready/" + m15Waiting + "/mocks/" + hex.EncodeToString(mock[:]) + ".png: it is not there."}}},
	)
	w.feature["main_conflict_ticket"] = m15Conflict
	w.feature["policy_owner_ticket"] = m15Policy
	w.feature["merge_recheck_ticket"] = m15Recheck
	w.feature["waiting_for_mocks_slice"] = m15Waiting
}

// m15MockPicture and m15Capture are tiny pictures the generator writes (PNG signatures, as verify.py
// judges a picture by its first bytes).
var (
	m15MockPicture = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0x15}, 48)...)
	m15Capture     = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0x51}, 48)...)
)

type m15Rec struct {
	f       float64 // fraction of the history
	typ     string
	station string
	visit   int
	round   int
	data    map[string]any
}

// writeM15 writes the three M15 cells (live folders: none has been cleaned up).
func (g *gen) writeM15() error {
	w := g.w
	if !w.m15On() {
		return nil
	}
	gate := func(f float64, station string, visit, round int, name, outcome string, code any, extra map[string]any) m15Rec {
		d := map[string]any{"gate": name, "outcome": outcome, "reason_code": code, "overridden_by_reason": false}
		for k, v := range extra {
			d[k] = v
		}
		return m15Rec{f, "gate.evaluated", station, visit, round, d}
	}
	in := func(f float64, station string, visit, round int, stage string) m15Rec {
		return m15Rec{f, "station.entered", station, visit, round, map[string]any{"stage": stage}}
	}
	out := func(f float64, station string, visit, round int, outcome, stage string) m15Rec {
		return m15Rec{f, "station.exited", station, visit, round, map[string]any{"outcome": outcome, "stage": stage}}
	}
	groomed := []m15Rec{
		in(0.900, "groom", 1, 0, "interview"), gate(0.905, "groom", 1, 0, "groom.finalize", "pass", nil, nil), out(0.906, "groom", 1, 0, "spec-ready", "spec-ready"),
		in(0.907, "plan", 1, 0, "spec-ready"), gate(0.910, "plan", 1, 0, "plan.check", "pass", nil, nil),
		{0.911, "station.exited", "plan", 1, 0, map[string]any{"outcome": "planned", "stage": "planned", "app_type": "web", "risk": "Medium", "contracts": 1, "tasks": 2}},
	}
	conflict := append(append([]m15Rec{}, groomed...),
		gate(0.935, "build", 1, 1, "build.start", "refuse", "main-conflict", nil))
	policy := []m15Rec{
		in(0.930, "groom", 1, 0, "interview"),
		gate(0.940, "groom", 1, 0, "groom.finalize", "refuse", "open-questions", map[string]any{"open_questions": 0}),
		out(0.941, "groom", 1, 0, "spec-open", "spec-open"),
	}
	mockSum := sha256.Sum256(m15MockPicture)
	mockHex := hex.EncodeToString(mockSum[:])
	capSum := sha256.Sum256(m15Capture)
	capHex := hex.EncodeToString(capSum[:])
	mockFile := "mocks/" + mockHex + ".png"
	start := map[string]any{"risk": "Medium", "max_rounds": 3, "tuning": false, "approvals_needed": 2, "human_approval_required": false,
		"seats": []any{"architecture", "security", "product"}, "models": map[string]any{"architecture": "sonnet", "security": "sonnet", "product": "sonnet"}, "delta": false}
	decided := map[string]any{"decision": "APPROVED", "approvals": 3, "needed": 2, "votes": map[string]any{"architecture": "APPROVE", "security": "APPROVE", "product": "APPROVE"}, "blockers": 0}
	recheck := append(append([]m15Rec{}, groomed...),
		in(0.912, "build", 1, 1, "planned"),
		m15Rec{0.915, "build.task_completed", "build", 1, 1, map[string]any{"task": "T1", "kind": "test", "step": "red", "first_run": "fail", "suite": "red", "commit": "a15c0de"}},
		m15Rec{0.918, "build.task_completed", "build", 1, 1, map[string]any{"task": "T2", "kind": "impl", "step": "green", "first_run": "pass", "suite": "green", "commit": "a15c0df"}},
		out(0.920, "build", 1, 1, "built", "built"),
		in(0.921, "verify", 1, 1, "built"),
		m15Rec{0.922, "verify.check_recorded", "verify", 1, 1, map[string]any{"item": "AC-01", "kind": "scenario", "result": "pass",
			"evidence": []any{map[string]any{"path": "evidence/signin.png", "sha256": capHex}}}},
		gate(0.923, "verify", 1, 1, "verify.verdict", "pass", "PASS", nil),
		out(0.924, "verify", 1, 1, "PASS", "verified"),
		in(0.925, "review", 1, 1, "verified"),
		m15Rec{0.9251, "review.round_started", "review", 1, 1, start},
		m15Rec{0.926, "review.decided", "review", 1, 1, decided},
		out(0.927, "review", 1, 1, "APPROVED", "approved"),
		in(0.928, "merge", 1, 1, "approved"),
		gate(0.929, "merge", 1, 1, "merge.landed_overlap", "refuse", "landed-overlap", map[string]any{"landed_commits": 2, "files": 1, "slices": []any{"SLICE-001"}, "problems": 0}),
		gate(0.9291, "merge", 1, 1, "merge.land", "refuse", "landed-overlap", nil),
		out(0.9292, "merge", 1, 1, "landed-overlap", "built"),
		in(0.931, "verify", 2, 1, "built"),
		m15Rec{0.932, "verify.check_recorded", "verify", 2, 1, map[string]any{"item": "AC-01", "kind": "scenario", "result": "pass",
			"evidence": []any{map[string]any{"path": "evidence/signin.png", "sha256": capHex}}}},
		gate(0.933, "verify", 2, 1, "verify.verdict", "pass", "PASS", nil),
		out(0.934, "verify", 2, 1, "PASS", "verified"),
		in(0.935, "review", 2, 1, "verified"),
		m15Rec{0.9351, "review.round_started", "review", 2, 1, start},
		m15Rec{0.936, "review.decided", "review", 2, 1, decided},
		out(0.937, "review", 2, 1, "APPROVED", "approved"),
		in(0.938, "merge", 2, 1, "approved"),
		m15Rec{0.939, "merge.completed", "merge", 2, 1, map[string]any{"method": "local", "approved_commit": "a15c0e0", "landed_commit": "a15c0e0", "merge_commit": "a15c0e1", "revalidated": true, "pull_request": nil}},
		out(0.9391, "merge", 2, 1, "merged", "merged"),
	)
	results, _ := json.MarshalIndent(map[string]any{"head": "a15c0e0", "review_loop": 0, "app_type": "web",
		"mocks": map[string]any{"MOCK-1": map[string]any{"sha256": mockHex, "file": mockFile, "for": "AC-01", "binding": true, "note": "the sign-in screen"}},
		"mock_records": map[string]any{"MOCK-1": map[string]any{"result": "differs", "note": "Captured the sign-in screen at 1280 wide and set it beside the approved mock.",
			"differences": []any{"the primary button is grey; in the mock it is the accent colour"}, "capture": []any{"signin.png"}}},
		"records": map[string]any{
			"AC-01":  map[string]any{"kind": "scenario", "result": "pass", "note": "signed in", "evidence": []any{map[string]any{"file": "signin.png", "sha256": capHex}}},
			"MOCK-1": map[string]any{"kind": "design mock", "result": "fail", "note": "differs", "evidence": []any{map[string]any{"file": mockFile, "sha256": mockHex}, map[string]any{"file": "signin.png", "sha256": capHex}}},
		}}, "", "  ")
	cells := []struct {
		ticket, stage, slice, jira string
		recs                       []m15Rec
		files                      map[string][]byte
		extra                      map[string]any
	}{
		{m15Conflict, "planned", "SLICE-091", "", conflict, nil, map[string]any{"main_conflict": map[string]any{"files": []any{"src/app.py"}, "folder": ".factory/worktrees/" + m15Conflict + "/repo"}}},
		{m15Policy, "spec-open", "SLICE-092", "", policy, nil, map[string]any{"policy_concerns_open": 1}},
		{m15Recheck, "merged", "SLICE-093", "SYNJ-93", recheck, map[string][]byte{
			"evidence/results.json":          results,
			"evidence/" + mockFile:           m15MockPicture,
			"evidence/signin.png":            m15Capture,
			"mocks/manifest.json":            []byte(`{"slice_id":"SLICE-093","revision":1,"mocks":[{"sha256":"` + mockHex + `","file":"` + mockHex + `.png","for":"AC-01","binding":true}]}` + "\n"),
			"mocks/" + mockHex + ".png":      m15MockPicture,
			"review/round-1/decision.json":   []byte(`{"round":1,"outcome":"VOID","head":"a15c0de","outcome_before_void":"APPROVED","void":{"reason":"Work that landed on the main branch after approval touches the same ground as this ticket.","approved_commit":"a15c0de","branch_commit":"a15c0e0","by":"merge station"}}` + "\n"),
			"review/round-1.1/decision.json": []byte(`{"round":1,"outcome":"APPROVED","head":"a15c0e0"}` + "\n"),
		}, map[string]any{"change_record": map[string]any{"path": "docs/changes/" + m15Recheck + ".md", "sha256": digest("change record " + m15Recheck), "commit": "a15c0e0"}}},
	}
	for _, c := range cells {
		var log bytes.Buffer
		for i, r := range c.recs {
			log.Write(testkit.Record{Seq: i + 1, At: isoMS(w.ms(w.endT * r.f)), Ticket: c.ticket, Type: r.typ, Station: r.station, Visit: r.visit,
				Round: r.round, Data: r.data}.Line())
			g.cnt.add("cell-lifecycle", r.typ, 1)
		}
		product := map[string]any{"slice_id": c.slice, "epic_id": "EPIC-001", "source": "folder", "revision": 1}
		if c.jira != "" {
			product["jira"] = c.jira
		}
		info := map[string]any{"ticket_id": c.ticket, "stage": c.stage, "created_at": isoS(w.ms(w.endT * c.recs[0].f)), "round": 1, "mode": "headless",
			"risk_tier": "Medium", "app_type": "web", "slice_id": c.slice, "product": product, "synthetic": true}
		for k, v := range c.extra {
			info[k] = v
		}
		cellJSON, _ := json.MarshalIndent(info, "", "  ")
		dir := g.path(".factory", "worktrees", c.ticket)
		if err := g.put(filepath.Join(dir, "cell.json"), append(cellJSON, '\n')); err != nil {
			return err
		}
		for name, body := range c.files {
			if err := g.put(filepath.Join(dir, filepath.FromSlash(name)), body); err != nil {
				return err
			}
		}
		if err := g.put(filepath.Join(dir, "lifecycle.jsonl"), log.Bytes()); err != nil {
			return err
		}
	}
	return nil
}
