package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/testkit"
)

// The people a project's files name, and where each is planted. None may reach the browser by
// any route, nor the observer's index on disk (D2 of the M6.2 acceptance).
var planted = map[string]string{
	"Ada Lovelace":          "decision.json human_approval.by, and named in findings.md, results.json and a vote",
	"Grace Hopper":          "decision.json human_approval.recorded_by",
	"Rita Reviewer":         "a vote's reviewer, named again in findings.md",
	"Linus Committer":       "build-report.json tasks[].author",
	"linus@example.org":     "build-report.json tasks[].committer_email",
	"Margaret Hamilton":     "the intake log's factory.activated by",
	"Katherine Johnson":     "the intake log's wave approval actor, named again in a human.required reason",
	"Dorothy Vaughan":       "runner.json enabled_by",
	"Barbara Liskov":        "the git reflog's committer, named in a vote finding's title and a ledger reason",
	"barbara@example.net":   "the git reflog's e-mail",
	"Edsger Dijkstra":       "the [user] of .git/config, named in an evidence file",
	"edsger@example.com":    "the [user] e-mail of .git/config",
	"Frances Allen":         "an approval object's approver_name in a run record",
	"frances.allen@corp.io": "an approval object's email in a run record",
}

func peopleFixture(t *testing.T) string {
	root := testkit.Project(t)
	cell := filepath.Join(root, ".factory/worktrees/T-1")
	write := func(rel string, b []byte) { testkit.WriteFile(t, filepath.Join(root, rel), b) }
	j := func(v any) []byte { b, _ := json.MarshalIndent(v, "", "  "); return b }

	write(".git/config", []byte("[core]\n\tbare = false\n[user]\n\tname = Edsger Dijkstra\n\temail = edsger@example.com\n"))
	write(".git/logs/HEAD", []byte("0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 Barbara Liskov <barbara@example.net> 1794520000 +0000\tcommit (initial): start\n"))
	policy, _ := json.Marshal(map[string]any{"schema_version": 2, "enabled": true, "autonomy": "observe", "enabled_by": "Dorothy Vaughan",
		"enabled_at": "2026-11-12T09:00:00Z"})
	os.WriteFile(filepath.Join(root, ".factory/local/runner.json"), policy, 0o600)

	var ledger []byte
	ledger = append(ledger, testkit.LedgerLine(1, "factory.activated", "", map[string]any{"autonomy": "observe", "by": "Margaret Hamilton",
		"allow_merge": false, "persistent": false, "limits": map[string]any{}})...)
	ledger = append(ledger, testkit.LedgerLine(2, "wave.discovered", "", map[string]any{"slices": []any{"SLICE-001"},
		"approval": map[string]any{"actor": "Katherine Johnson", "approved_at": "2026-11-12T09:00:00Z"}})...)
	ledger = append(ledger, testkit.LedgerLine(3, "human.required", "T-1", map[string]any{"reason": "waiting for Katherine Johnson and Barbara Liskov"})...)
	testkit.Append(t, testkit.LedgerPath(root), ledger)

	testkit.Append(t, testkit.CellLog(root, "T-1"), append(append(
		testkit.LifecycleLine("T-1", 1, "station.entered", "review", nil),
		testkit.LifecycleLine("T-1", 2, "review.verdict_submitted", "review", map[string]any{"seat": "security", "vote": "REJECT", "blockers": 1, "notes": 0})...),
		testkit.LifecycleLine("T-1", 3, "review.decided", "review", map[string]any{"decision": "APPROVED", "approvals": 3, "needed": 2})...))
	write(".factory/worktrees/T-1/cell.json", j(map[string]any{"stage": "approved", "ticket_id": "T-1", "app_type": "library", "risk": "High"}))
	write(".factory/worktrees/T-1/build-report.json", j(map[string]any{"ticket_id": "T-1", "tasks": []any{map[string]any{"id": "T1", "commit": "abcdef1",
		"author": "Linus Committer", "committer_email": "linus@example.org", "note": "pairing with Linus Committer"}}}))
	write(".factory/worktrees/T-1/review/round-1/votes/security.json", j(map[string]any{"reviewer": "Rita Reviewer", "vote": "REJECT",
		"summary": "Ada Lovelace asked for this", "findings": []any{map[string]any{"severity": "blocker", "rule": "FR-01", "file": "app/x.py",
			"title": "Barbara Liskov's substitution is broken"}}}))
	write(".factory/worktrees/T-1/review/round-1/decision.json", j(map[string]any{"ticket_id": "T-1", "round": 1, "outcome": "APPROVED",
		"human_approval": map[string]any{"by": "Ada Lovelace", "note": nil, "recorded_at": "2026-11-12T22:57:15+00:00", "recorded_by": "Grace Hopper"},
		"head":           "b68db4be71fe56e6e4264e79472987a639dc8773",
		"findings":       cell + "/review/round-1/findings.md", "decided_at": "2026-11-12T22:57:12+00:00"}))
	write(".factory/worktrees/T-1/review/round-1/findings.md", []byte("# Findings\n\nApproved by Ada Lovelace after Rita Reviewer's second look.\n"+
		"See `review/round-1/findings.md` and "+cell+"/evidence/consumer-run.log.\n"))
	log := []byte("consumer run by Edsger Dijkstra\nok\n")
	write(".factory/worktrees/T-1/evidence/consumer-run.log", log)
	write(".factory/worktrees/T-1/evidence/results.json", j(map[string]any{"head": "abcdef1", "review_loop": 0, "ticket_id": "T-1",
		"suite": map[string]any{"command": "/usr/bin/python3 -m unittest", "log": cell + "/evidence/test-suite.log"},
		"records": map[string]any{"AC-01": map[string]any{"kind": "scenario", "result": "pass", "note": "checked by ada lovelace in " + cell,
			"evidence": []any{map[string]any{"file": "consumer-run.log", "sha256": sha256Hex(log)}}}}}))
	testkit.Append(t, filepath.Join(root, ".factory/archive/runs.jsonl"), append(j2(map[string]any{"record_version": 2, "ticket_id": "T-0",
		"outcome": "merged", "closed_at": "2026-11-12T12:00:00+00:00", "human_approval": map[string]any{"approver_name": "Frances Allen",
			"email": "frances.allen@corp.io"}}), '\n'))
	return root
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func j2(v any) []byte { b, _ := json.Marshal(v); return b }

func TestPeopleNeverReachTheBrowser(t *testing.T) {
	root := peopleFixture(t)
	r := launch(t, root)
	stopped := false
	defer func() {
		if !stopped {
			r.stop(t)
		}
	}()
	waitEvents(t, r, 6)
	time.Sleep(testkit.Slow(2500 * time.Millisecond)) // the catalog refreshes every 2 s

	var bodies [][]byte
	get := func(path string) []byte {
		b := r.get(t, path)
		bodies = append(bodies, b)
		return b
	}
	for _, p := range []string{"/api/v1/health", "/api/v1/factory/status", "/api/v1/session", "/api/v1/events?limit=1000",
		"/api/v1/history?limit=5000", "/api/v1/snapshot", "/api/v1/project", "/api/v1/waves", "/api/v1/slices", "/api/v1/cells",
		"/api/v1/cells/T-1", "/api/v1/cells/T-1/evidence", "/api/v1/runs", "/api/v1/spans", "/api/v1/analytics/runs",
		"/api/v1/analytics/metrics?group_by=day", "/api/v1/series"} {
		get(p)
	}
	var cat struct {
		Data struct {
			Items []struct {
				ID            string `json:"id"`
				Path          string `json:"path_rel"`
				ContentAccess string `json:"content_access"`
			} `json:"items"`
		} `json:"data"`
	}
	json.Unmarshal(get("/api/v1/artifacts"), &cat)
	served := map[string]string{}
	for _, it := range cat.Data.Items {
		if it.ContentAccess == "text" {
			served[it.Path] = string(get("/api/v1/artifacts/" + url.PathEscape(it.ID) + "/content"))
		}
	}
	for _, want := range []string{"review/round-1/decision.json", "review/round-1/findings.md", "evidence/results.json", "evidence/consumer-run.log"} {
		if _, ok := served[want]; !ok {
			t.Fatalf("%s was not served: %v", want, cat.Data.Items)
		}
	}
	// The approval is shown by role; the relative name of the findings is kept (D25).
	var decision map[string]any
	if err := json.Unmarshal([]byte(served["review/round-1/decision.json"]), &decision); err != nil {
		t.Fatal(err)
	}
	approval, _ := decision["human_approval"].(map[string]any)
	if approval["by"] != "a person" || approval["recorded_by"] != "a person" || decision["findings"] != ".factory/worktrees/T-1/review/round-1/findings.md" {
		t.Fatalf("decision.json served as %s", served["review/round-1/decision.json"])
	}
	if !strings.Contains(served["review/round-1/findings.md"], "`review/round-1/findings.md`") {
		t.Fatalf("a relative name was scrubbed: %s", served["review/round-1/findings.md"])
	}
	stream, err := r.client.Get(r.base + "/api/v1/stream?after=")
	if err == nil {
		buf := make([]byte, 1<<20)
		n, _ := stream.Body.Read(buf)
		bodies = append(bodies, buf[:n])
		stream.Body.Close()
	}
	r.stop(t)
	stopped = true

	var disk [][]byte
	filepath.WalkDir(filepath.Join(root, IndexDir), func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := os.ReadFile(p)
			disk = append(disk, b)
		}
		return nil
	})
	leaks := 0
	for name, where := range planted {
		needle := []byte(strings.ToLower(name))
		for _, b := range bodies {
			if bytes.Contains(bytes.ToLower(b), needle) {
				leaks++
				t.Errorf("%q (%s) reached the browser: %.400s", name, where, b)
			}
		}
		for _, b := range disk {
			if bytes.Contains(bytes.ToLower(b), needle) {
				leaks++
				t.Errorf("%q (%s) is in the index on disk", name, where)
			}
		}
	}
	t.Logf("people: %d names planted in %d places, %d replies and %d index files scanned, leaks = %d", len(planted), len(planted), len(bodies), len(disk), leaks)
}
