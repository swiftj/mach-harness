package server_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mach/studio/internal/engine"
	"mach/studio/internal/testkit"
)

// M16: the Shape conversation over HTTP, its refusals, and Shape's acts held while it writes.

func TestTheShapeConversationOverHTTP(t *testing.T) {
	h, claude := withClaude(t, testkit.Turn{Kind: "slow", Sleep: 60})
	h.login()
	// The idea must exist: the engine says so, and Claude is never started for one it does not know.
	status, env := h.call("POST", "/api/interview", `{"idea_id":"IDEA-001"}`, nil)
	expect(t, status, env, 422, engine.KindRefused)
	if testkit.Calls(t, claude) != nil {
		t.Fatal("Claude was started for an idea that does not exist")
	}
	h.mustOp("idea.add", `{"title":"Let members renew a loan themselves"}`)
	id := h.startInterview(`{"idea_id":"IDEA-001"}`)
	status, env = h.call("GET", "/api/interview?idea_id=IDEA-001", "", nil)
	var current struct {
		Interview struct {
			InterviewID string `json:"interview_id"`
			IdeaID      string `json:"idea_id"`
			Live        bool   `json:"live"`
		} `json:"interview"`
	}
	if status != 200 || json.Unmarshal(env.Data, &current) != nil || current.Interview.IdeaID != "IDEA-001" || current.Interview.InterviewID != id ||
		strings.Contains(string(env.Data), "slice_id") {
		t.Fatalf("current: %d %s", status, env.Data)
	}
	// While its turn runs, every Shape act on that idea waits; reads, and acts on another idea, do not.
	for name, body := range map[string]string{
		"verdict.record": `{"idea_id":"IDEA-001","decision":"no","reason":"Not for us."}`,
		"idea.stage":     `{"idea_id":"IDEA-001","stage":"exploring"}`,
		"brief.check":    `{"idea_id":"IDEA-001"}`,
		"idea.publish":   `{"idea_id":"IDEA-001"}`,
	} {
		status, env := h.call("POST", "/api/ops/"+name, body, nil)
		expect(t, status, env, 409, engine.KindConflict)
		if !strings.Contains(env.Error.Message, "writing this idea's brief or case") {
			t.Fatalf("%s: %q", name, env.Error.Message)
		}
	}
	h.mustOp("idea.show", `{"idea_id":"IDEA-001"}`)
	h.mustOp("idea.add", `{"title":"Email a reminder before a loan is due"}`)
	h.mustOp("idea.stage", `{"idea_id":"IDEA-002","stage":"exploring"}`)
	if status, env := h.call("POST", "/api/interview/"+id+"/interrupt", `{}`, nil); status != 200 || !env.OK {
		t.Fatalf("interrupt: %d %+v", status, env.Error)
	}
	h.mustOp("idea.stage", `{"idea_id":"IDEA-001","stage":"exploring"}`)
	calls := testkit.Calls(t, claude)
	if len(calls) != 1 || calls[0].Argv[len(calls[0].Argv)-1] != "/mach:studio explore IDEA-001. Explore this idea with the product manager: run idea show first, then ask open questions, one at a time." {
		t.Fatalf("calls %+v", calls)
	}
	status, env = h.call("GET", "/api/interview/history?idea_id=IDEA-001", "", nil)
	if status != 200 || !strings.Contains(string(env.Data), `"idea_id":"IDEA-001"`) {
		t.Fatalf("history: %d %s", status, env.Data)
	}
}

func TestShapeConversationRequestsTheHostRefuses(t *testing.T) {
	h, claude := withClaude(t)
	h.login()
	for _, body := range []string{`{"idea_id":"IDEA-1"}`, `{"idea_id":"../IDEA-001"}`, `{"idea_id":"SLICE-001"}`, `{"idea_id":""}`,
		`{"idea_id":"IDEA-001","slice_id":"SLICE-001"}`, `{"idea_id":"IDEA-001","idea":"words"}`, `{"idea_id":"IDEA-001","path":"x"}`} {
		status, env := h.call("POST", "/api/interview", body, nil)
		expect(t, status, env, 400, engine.KindInvalid)
	}
	for _, query := range []string{"idea_id=IDEA-1", "idea_id=SLICE-001", "idea_id=IDEA-001&slice_id=SLICE-001", "idea_id="} {
		status, env := h.call("GET", "/api/interview?"+query, "", nil)
		expect(t, status, env, 400, engine.KindInvalid)
		status, env = h.call("GET", "/api/interview/history?"+query, "", nil)
		expect(t, status, env, 400, engine.KindInvalid)
	}
	// An idea shaped into work keeps its brief: no conversation is started for it.
	ideas := filepath.Join(h.project, ".factory", "studio", "draft", "product", "ideas")
	h.mustOp("idea.add", `{"title":"Show members what they have on loan"}`)
	record := filepath.Join(ideas, "IDEA-001.json")
	raw, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	json.Unmarshal(raw, &data)
	data["stage"] = "shaped"
	data["made"] = map[string]any{"epics": []string{}, "slices": []string{"SLICE-004"}}
	changed, _ := json.Marshal(data)
	os.WriteFile(record, changed, 0o644)
	status, env := h.call("POST", "/api/interview", `{"idea_id":"IDEA-001"}`, nil)
	expect(t, status, env, 422, engine.KindRefused)
	if !strings.Contains(env.Error.Message, "shaped into work") {
		t.Fatalf("refusal %q", env.Error.Message)
	}
	if testkit.Calls(t, claude) != nil {
		t.Fatal("Claude was started for a refused conversation")
	}
}
