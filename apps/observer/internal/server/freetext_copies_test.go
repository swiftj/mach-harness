package server

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"mach/observer/internal/feedtest"
	"mach/observer/internal/redact"
)

// M6.6 F6: prose from the declared event fields is copied by the projection into other replies.
// Every place a reply holds such prose must be declared in display_policy.free_text, so a client
// can label it from the policy. Each declared event field is filled with a marker, every
// non-event route is read, and every string holding the marker must sit at a declared path.
func TestSessionDeclaresProjectionFreeText(t *testing.T) {
	const mark = "QQPROSEMARK"
	const x1, x2 = "x0123456789ab", "x0fedcba98765"
	wf := "workflow:" + x1 + "/task0001"
	events := feedtest.Scenario()
	for _, e := range events {
		if e["type"] == "slice.materialized" {
			e["data"].(map[string]any)["title"] = mark + " slice title"
		}
	}
	i := func(typ string, ms int64) *feedtest.Ev {
		return feedtest.New("intake-log", typ, ms).ID("project_id", "P-1").ID("wave_id", "WAVE-001")
	}
	add := func(e *feedtest.Ev) { events = append(events, e.Build()) }
	add(feedtest.New("observer", "review.finding", 25000).Ticket("T-1").Visit("T-1", "review#1", 2).ID("seat", "security").
		Data(map[string]any{"seat": "security", "n": 1, "severity": "blocker", "rule": "FR-01", "file_rel": "src/a.go", "title": mark + " finding"}))
	add(feedtest.New("execution-stream", "workflow.phases_declared", 6450).Exec(x1).Entity(wf).Data(map[string]any{"phases": []map[string]any{{"index": 1, "title": mark + " phase title"}}}))
	agent := func(typ string, ms int64) *feedtest.Ev {
		return feedtest.New("execution-stream", typ, ms).Exec(x1).ID("agent_id", x1+"/a0000000000000002").Entity("agent:" + x1 + "/a0000000000000002").Parent(wf).Entity(wf)
	}
	add(agent("agent.queued", 6600).ID("agent_id", nil).Data(map[string]any{"index": 1, "label": mark + " label", "phase": mark + " phase", "phase_index": 1, "model": "sonnet"}))
	add(agent("agent.started", 7050).Data(map[string]any{"index": 1, "label": mark + " label", "phase": mark + " phase", "phase_index": 1, "agent_type": "x", "model": "claude-sonnet-5-5", "agent_try": 1}))
	add(agent("agent.finished", 9050).Data(map[string]any{"status": "done", "duration_ms": 2000, "tokens": 10, "tool_calls": 1}))
	add(i("intake.refused", 31000).Data(map[string]any{"problems": []string{mark + " problem"}}))
	add(i("dependency.blocked", 31100).ID("slice_id", "SLICE-002").ID("revision", 1).Entity("slice:SLICE-002").Data(map[string]any{"reasons": []string{mark + " blocked"}}))
	add(i("human.required", 31200).Ticket("T-1").Data(map[string]any{"reason": mark + " human"}))
	add(i("scheduling.decided", 31300).Data(map[string]any{"state": "supervised", "dispatched": []string{}, "started": []string{},
		"held": []map[string]any{{"slice_id": "SLICE-002", "ticket_id": "T-2", "why": mark + " held"}}}))
	add(i("work.scheduled", 31400).ID("slice_id", "SLICE-002").ID("revision", 1).Entity("slice:SLICE-002").Ticket("T-2").
		Data(map[string]any{"stage": "spec-ready", "risk": "Medium", "branch": "feature/T-2", "by_role": "supervisor", "authorization": mark + " authorization"}))
	add(i("revision.superseded", 31500).ID("slice_id", "SLICE-002").ID("revision", 2).Entity("slice:SLICE-002").Data(map[string]any{"from_revision": 1, "effect": mark + " effect"}))
	add(i("execution.completed", 47000).Ticket("T-1").Exec(x2).Data(map[string]any{"stage": "approved", "next": "merge", "waiting_for": mark + " waiting",
		"how": "exited", "seen_to_end": true, "cost_usd": 1.0, "refused_tools": []string{mark + " refused"}}))
	add(feedtest.New("execution-stream", "workflow.finished", 26550).Exec(x1).Entity(wf).Data(map[string]any{"status": "completed", "notification_status": "completed",
		"total_tokens": 1, "tool_uses": 1, "duration_ms": 1, "stop_reason": nil, "workflow_json": true,
		"tickets": []map[string]any{{"ticket": "T-1", "outcome": "stopped", "stage": "built", "waiting_for": mark + " wf waiting", "stations": []string{}}}}))
	add(i("factory.paused", 60000).Data(map[string]any{"by_role": "engineer", "reason": mark + " paused"}))

	h := start(t, config{events: events})
	// The declaration, as served.
	ft := h.get(t, "/api/v1/session")["display_policy"].(map[string]any)["free_text"].(map[string]any)
	declared, _ := ft["projection_fields"].([]any)
	if len(declared) != len(redact.ProjectionFields) || len(declared) == 0 {
		t.Fatalf("projection_fields: %v", ft["projection_fields"])
	}
	evFields, _ := ft["event_fields"].([]any)
	refused := false
	for _, f := range evFields {
		m := f.(map[string]any)
		refused = refused || (m["kind"] == "execution.completed" && m["path"] == "data.refused_tools[]")
	}
	if !refused {
		t.Error("execution.completed data.refused_tools[] is prose and is not declared")
	}

	routes := map[string]string{
		"/api/v1/project": "/api/v1/project", "/api/v1/factory/status": "/api/v1/factory/status", "/api/v1/snapshot": "/api/v1/snapshot",
		"/api/v1/waves": "/api/v1/waves", "/api/v1/waves/WAVE-001": "/api/v1/waves/{wave}", "/api/v1/slices": "/api/v1/slices",
		"/api/v1/slices/SLICE-002": "/api/v1/slices/{slice}", "/api/v1/slices/SLICE-001": "/api/v1/slices/{slice}",
		"/api/v1/cells": "/api/v1/cells", "/api/v1/cells/T-1": "/api/v1/cells/{ticket}", "/api/v1/cells/T-2": "/api/v1/cells/{ticket}",
		"/api/v1/cells/T-1/evidence": "/api/v1/cells/{ticket}/evidence",
		"/api/v1/runs":               "/api/v1/runs", "/api/v1/runs/" + x1: "/api/v1/runs/{execution}", "/api/v1/runs/" + x2: "/api/v1/runs/{execution}",
		"/api/v1/runs/" + x1 + "/agents": "/api/v1/runs/{execution}/agents", "/api/v1/runs/" + x1 + "/tools": "/api/v1/runs/{execution}/tools",
		"/api/v1/spans?limit=1000": "/api/v1/spans", "/api/v1/marks": "/api/v1/marks",
		"/api/v1/analytics/metrics": "/api/v1/analytics/metrics", "/api/v1/analytics/metrics?group_by=phase": "/api/v1/analytics/metrics",
		"/api/v1/analytics/runs": "/api/v1/analytics/runs", "/api/v1/analytics/flow": "/api/v1/analytics/flow", "/api/v1/analytics/insights": "/api/v1/analytics/insights",
	}
	found := map[string]bool{}
	var undeclared []string
	for path, route := range routes {
		_, env, body := h.do(t, "GET", path, nil)
		if !env.OK {
			t.Fatalf("%s: %.200s", path, body)
		}
		var v any
		json.Unmarshal(body, &v)
		walkStrings(v.(map[string]any)["data"], nil, func(segs []string, s string) {
			if !strings.Contains(s, mark) || (len(segs) > 0 && segs[0] == "events") {
				return // events[] in a reply are events: event_fields apply
			}
			if f, ok := matchProjection(route, segs); ok {
				found[f.Route+" "+f.Path] = true
				return
			}
			undeclared = append(undeclared, route+" "+strings.Join(segs, "."))
		})
	}
	sort.Strings(undeclared)
	if len(undeclared) > 0 {
		t.Errorf("prose served at undeclared paths (add them to redact.ProjectionFields):\n%s", strings.Join(dedupe(undeclared), "\n"))
	}
	for _, f := range redact.ProjectionFields {
		if !found[f.Route+" "+f.Path] && !f.Unexercised {
			t.Errorf("declared but not seen with prose in this scenario: %s %s", f.Route, f.Path)
		}
	}
}

func walkStrings(v any, segs []string, fn func([]string, string)) {
	switch x := v.(type) {
	case map[string]any:
		for k, c := range x {
			walkStrings(c, append(append([]string(nil), segs...), k), fn)
		}
	case []any:
		for _, c := range x {
			if len(segs) == 0 {
				walkStrings(c, []string{"[]"}, fn)
				continue
			}
			s := append([]string(nil), segs...)
			s[len(s)-1] += "[]"
			walkStrings(c, s, fn)
		}
	case string:
		fn(segs, x)
	}
}

// matchProjection finds the declared field at segs ("*" in a declared path matches any one key).
func matchProjection(route string, segs []string) (redact.ProjectionField, bool) {
	for _, f := range redact.ProjectionFields {
		if f.Route != route {
			continue
		}
		want := strings.Split(f.Path, ".")
		if len(want) != len(segs) {
			continue
		}
		ok := true
		for i := range want {
			w := want[i]
			if w == segs[i] {
				continue
			}
			if w == "*" && !strings.HasSuffix(segs[i], "[]") || w == "*[]" && strings.HasSuffix(segs[i], "[]") {
				continue
			}
			ok = false
			break
		}
		if ok {
			return f, true
		}
	}
	return redact.ProjectionField{}, false
}

func dedupe(list []string) []string {
	var out []string
	for i, s := range list {
		if i == 0 || s != list[i-1] {
			out = append(out, s)
		}
	}
	return out
}
