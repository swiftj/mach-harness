package normalize

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
	"mach/observer/internal/testkit"
)

const provRoot = "/work/project"

func provDigest(c string) string { return strings.Repeat(c, 64) }

// provSnapshot is what skills/run/scripts/provenance.py writes (schema 1).
func provSnapshot() map[string]any {
	return map[string]any{
		"schema": 1,
		"mach":   map[string]any{"version": "0.12.0", "install": "plugin", "commit": "b37c036aa0b37c036aa0b37c036aa0b37c036aa0"},
		"line": map[string]any{"digest": provDigest("a"), "count": 3,
			"files": map[string]any{"skill:build": provDigest("b"), "agent:builder": provDigest("c"), "workflow:belt": provDigest("d")}},
		"config": map[string]any{"recorded": true, "digest": provDigest("3"), "max_parallel": 3,
			"models": map[string]any{"planning": "fable", "contracts": "sha256:" + provDigest("4"), "build": "sonnet", "utility": "haiku"},
			"review": map[string]any{"max_loops": 3, "security_veto": true,
				"tiers": map[string]any{"high": map[string]any{"approvals": 3, "reviewers": 3, "human_approval": true}}}},
		"policy": map[string]any{"autonomy": "supervised", "max_risk": "High", "allow_merge": false, "max_parallel": 2,
			"allowed_tools_digest": provDigest("e"), "allowed_tools_count": 9},
		"ticket":    map[string]any{"risk": "Medium", "app_type": "cli"},
		"source":    map[string]any{"commit": "0123456789abcdef0123456789abcdef01234567", "slice_revision": 2, "slice_digest": provDigest("f"), "spec_sha256": provDigest("1")},
		"config_id": provDigest("2"),
	}
}

// provStarted runs one execution.started line through what ingest does before storing: normalise,
// enforce the allowlist, scrub. It returns the event as served (JSON).
func provStarted(t *testing.T, data map[string]any, sourceCommit any) (*event.Event, map[string]any) {
	t.Helper()
	data["until"], data["workflow"], data["limits"], data["session_id"] = "merge", "mach:belt", map[string]any{"minutes": 60, "budget_usd": 25}, "9f1c"
	line, _ := json.Marshal(map[string]any{"schema_version": 2, "seq": 1, "at": "2026-11-14T12:00:00Z", "type": "execution.started", "project_id": "P-1",
		"source_commit": sourceCommit, "wave_id": nil, "slice_id": "SLICE-001", "revision": 1, "ticket_id": "LOCAL-001", "runner_id": "R-1",
		"execution_id": "x0123456789ab", "source": "supervisor", "cause": nil, "refs": nil, "data": data})
	l := NewLedger("0badc0de", provRoot, NewIdentity())
	evs := l.Line(line, Read{Line: 1, At: time.Date(2026, 11, 14, 12, 0, 1, 0, time.UTC)})
	if len(evs) != 1 || evs[0].Type != "execution.started" {
		t.Fatalf("got %d events: %+v", len(evs), evs)
	}
	ev := evs[0]
	ev.Pos, ev.Order = 1, "001794657600999~1~i:0badc0de~000000000001~0000" // placed by ingest's sequencer
	if !redact.Enforce(ev, nil) || redact.MissingID(ev) != "" {
		t.Fatalf("not kept: %+v", ev)
	}
	redact.ScrubEvent(ev, provRoot, nil)
	ev.Tidy()
	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	schema, err := testkit.EventSchema()
	if err != nil {
		t.Fatal(err)
	}
	if errs := schema.ValidateJSON(b); len(errs) > 0 {
		t.Fatalf("not valid against the version 3 schema: %v\n%s", errs, b)
	}
	var served map[string]any
	_ = json.Unmarshal(b, &served)
	return ev, served["data"].(map[string]any)
}

func TestProvenancePassesThroughUnchanged(t *testing.T) {
	ev, d := provStarted(t, map[string]any{"provenance": provSnapshot()}, "0123456789abcdef0123456789abcdef01234567")
	if ev.Withheld != 0 {
		t.Fatalf("withheld %d of a clean snapshot", ev.Withheld)
	}
	want, _ := json.Marshal(provSnapshot())
	var expect map[string]any
	_ = json.Unmarshal(want, &expect)
	// Everything is as recorded, commits included: the provenance record's commits are served in
	// full (M6.6 N4), so the page can shorten them for display with the whole value available.
	got, _ := json.Marshal(d["provenance"])
	exp, _ := json.Marshal(expect)
	if string(got) != string(exp) {
		t.Fatalf("provenance changed in passing:\n got %s\nwant %s", got, exp)
	}
	if d["provenance_reason"] != nil || d["source_commit"] != "0123456789abcdef0123456789abcdef01234567" {
		t.Fatalf("reason %v, source_commit %v", d["provenance_reason"], d["source_commit"])
	}
}

func TestAnExecutionWithoutProvenanceReadsAsNotRecorded(t *testing.T) {
	_, d := provStarted(t, map[string]any{}, nil)
	if d["provenance"] != nil || d["provenance_reason"] != ProvenanceNotRecorded || d["source_commit"] != nil {
		t.Fatalf("old execution: %v", d)
	}
	if lim := d["limits"].(map[string]any); lim["minutes"] != float64(60) || d["workflow"] != "mach:belt" || d["until"] != "merge" {
		t.Fatalf("what was kept before is no longer kept: %v", d)
	}
	_, d = provStarted(t, map[string]any{"provenance": nil, "provenance_reason": "capture-failed"}, "abcdef1")
	if d["provenance"] != nil || d["provenance_reason"] != ProvenanceCaptureFailed || d["source_commit"] != "abcdef1" {
		t.Fatalf("failed capture: %v", d)
	}
	// A null snapshot with a reason this observer does not know, or with none, is not understood, not "not recorded".
	for _, reason := range []any{"disk-on-fire", nil} {
		_, d = provStarted(t, map[string]any{"provenance": nil, "provenance_reason": reason}, nil)
		if d["provenance"] != nil || d["provenance_reason"] != ProvenanceNotUnderstood {
			t.Fatalf("null with reason %v: %v", reason, d)
		}
	}
	for _, other := range []any{map[string]any{"schema": 2}, "a string", map[string]any{"schema": 1}} {
		_, d = provStarted(t, map[string]any{"provenance": other}, nil)
		if d["provenance"] != nil || d["provenance_reason"] != ProvenanceNotUnderstood {
			t.Fatalf("%v: %v", other, d)
		}
	}
}

// A path, a credential or free text put where provenance holds an identifier is dropped by the
// normaliser's filters, and the scrubber would replace it if one got past them.
func TestPathsAndSecretsInsideProvenanceAreStillRedacted(t *testing.T) {
	bad := []string{"/Users/someone/projects/mach", "~/.claude/plugins/mach", "sk-ant-api03-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123",
		"someone@example.com", "TOKEN=abcdef123456", "Run the workflow named mach:belt"}
	for _, s := range bad {
		snap := provSnapshot()
		snap["mach"].(map[string]any)["version"] = s
		snap["mach"].(map[string]any)["commit"] = s
		snap["ticket"].(map[string]any)["app_type"] = s
		snap["config"].(map[string]any)["models"].(map[string]any)["build"] = s
		snap["line"].(map[string]any)["files"].(map[string]any)[s] = provDigest("9")
		snap["line"].(map[string]any)["files"].(map[string]any)["skill:"+s] = provDigest("9")
		snap["config"].(map[string]any)["review"].(map[string]any)["tiers"].(map[string]any)[s] = map[string]any{"approvals": 1}
		snap["policy"].(map[string]any)["allowed_tools_digest"] = s
		snap["extra"] = s // a key the snapshot does not have
		_, d := provStarted(t, map[string]any{"provenance": snap, "provenance_reason": s}, s)
		served, _ := json.Marshal(d)
		for _, part := range []string{"someone", "sk-ant", "ghp_", "example.com", "TOKEN", "Run the workflow", ".claude"} {
			if strings.Contains(string(served), part) {
				t.Fatalf("%q survived: %s", s, served)
			}
		}
		p := d["provenance"].(map[string]any)
		if p["config_id"] != provDigest("2") || len(p["line"].(map[string]any)["files"].(map[string]any)) != 3 {
			t.Fatalf("the rest of the snapshot was lost: %s", served)
		}
	}
	// Defence in depth: past the normaliser, the scrubber replaces a path or a secret anywhere in
	// the payload, provenance included.
	for _, s := range []string{"/Users/someone/projects/mach", "sk-ant-api03-abcdefghijklmnop"} {
		ev := &event.Event{Type: "execution.started", Data: map[string]any{"provenance": map[string]any{"mach": map[string]any{"version": s}}}}
		redact.ScrubEvent(ev, provRoot, nil)
		got := ev.Data["provenance"].(map[string]any)["mach"].(map[string]any)["version"].(string)
		if strings.Contains(got, "someone") || strings.Contains(got, "sk-ant") || ev.Withheld == 0 {
			t.Fatalf("scrubber kept %q as %q", s, got)
		}
	}
	// And a digest, which is what provenance holds, is never mistaken for a secret.
	ev := &event.Event{Type: "execution.started", Data: map[string]any{"provenance": provSnapshot()}}
	redact.ScrubEvent(ev, provRoot, nil)
	if ev.Withheld != 0 {
		t.Fatalf("the scrubber replaced %d values of a clean snapshot", ev.Withheld)
	}
}
