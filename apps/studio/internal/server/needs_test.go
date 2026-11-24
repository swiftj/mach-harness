package server_test

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"mach/studio/internal/engine"
	"mach/studio/internal/testkit"
)

// M17: the needs conversation over HTTP, its refusals, and the acts on the needs and designs held
// while it writes.

func TestTheNeedsConversationOverHTTP(t *testing.T) {
	h, claude := withClaude(t, testkit.Turn{Kind: "slow", Sleep: 60})
	h.login()
	// Technical needs belong to a project: Claude is never started without one.
	status, env := h.call("POST", "/api/interview", `{"needs":true}`, nil)
	expect(t, status, env, 422, engine.KindRefused)
	if testkit.Calls(t, claude) != nil {
		t.Fatal("Claude was started without a project")
	}
	h.mustOp("project.init", `{"id":"team-space","name":"Team Space","vision":"Teams work together.","outcome":["Teams can work together"]}`)
	h.mustOp("need.add", `{"kind":"people","statement":"Up to 300 people use it at once on the first working day of the month.","why":"Payroll closes then."}`)
	doc := base64.StdEncoding.EncodeToString([]byte("# Design\n\nOne store for everything.\n"))
	h.mustOp("design.import", `{"file":{"name":"design.md","content_base64":"`+doc+`"}}`)
	id := h.startInterview(`{"needs":true}`)
	status, env = h.call("GET", "/api/interview?needs=true", "", nil)
	var current struct {
		Interview struct {
			InterviewID string `json:"interview_id"`
			Needs       bool   `json:"needs"`
			Live        bool   `json:"live"`
		} `json:"interview"`
	}
	if status != 200 || json.Unmarshal(env.Data, &current) != nil || !current.Interview.Needs || current.Interview.InterviewID != id ||
		strings.Contains(string(env.Data), "slice_id") || strings.Contains(string(env.Data), "idea_id") {
		t.Fatalf("current: %d %s", status, env.Data)
	}
	status, env = h.call("POST", "/api/interview", `{"needs":true}`, nil)
	expect(t, status, env, 409, engine.KindConflict)
	// While its turn runs, every act on the needs or a design waits; reads, and other acts, do not.
	for name, body := range map[string]string{
		"need.add":        `{"kind":"data","statement":"Kept for a year.","why":"Law."}`,
		"need.set":        `{"need_id":"TN-01","why":"Payroll."}`,
		"need.retire":     `{"need_id":"TN-01"}`,
		"need.none":       `{"kind":"connections"}`,
		"need.publish":    `{}`,
		"reconcile.needs": `{"take":"mine"}`,
		"design.import":   `{"file":{"name":"other.md","content_base64":"` + doc + `"}}`,
		"design.settle":   `{"design_id":"DES-01","conflict":1,"as":"stands","reason":"It stands."}`,
		"design.publish":  `{"design_id":"DES-01"}`,
	} {
		status, env := h.call("POST", "/api/ops/"+name, body, nil)
		expect(t, status, env, 409, engine.KindConflict)
		if !strings.Contains(env.Error.Message, "writing the technical needs") {
			t.Fatalf("%s: %q", name, env.Error.Message)
		}
	}
	h.mustOp("need.list", `{}`)
	h.mustOp("design.list", `{}`)
	h.mustOp("design.show", `{"design_id":"DES-01"}`)
	h.mustOp("idea.add", `{"title":"Let members renew a loan themselves"}`)
	if status, env := h.call("POST", "/api/interview/"+id+"/interrupt", `{}`, nil); status != 200 || !env.OK {
		t.Fatalf("interrupt: %d %+v", status, env.Error)
	}
	h.mustOp("need.none", `{"kind":"connections"}`)
	calls := testkit.Calls(t, claude)
	if len(calls) != 1 || calls[0].Argv[len(calls[0].Argv)-1] != "/mach:studio needs. Talk through the product's technical needs with the product manager: "+
		"run need list first, then ask about the unanswered kinds, one open question at a time." {
		t.Fatalf("calls %+v", calls)
	}
	// The first turn may map the design that was brought in, from its one input file; nothing else.
	argv := strings.Join(calls[0].Argv, "\x00")
	if !strings.Contains(argv, " design map DES-01 --from ") || strings.Contains(argv, " design map DES-02") {
		t.Fatalf("the turn's rules: %q", calls[0].Argv)
	}
	status, env = h.call("GET", "/api/interview/history?needs=true", "", nil)
	if status != 200 || !strings.Contains(string(env.Data), `"needs":true`) {
		t.Fatalf("history: %d %s", status, env.Data)
	}
}

func TestNeedsConversationRequestsTheHostRefuses(t *testing.T) {
	h, claude := withClaude(t)
	h.login()
	for _, body := range []string{`{"needs":false}`, `{"needs":"true"}`, `{"needs":true,"slice_id":"SLICE-001"}`, `{"needs":true,"idea_id":"IDEA-001"}`,
		`{"needs":true,"idea":"words"}`, `{"needs":true,"kind":"people"}`} {
		status, env := h.call("POST", "/api/interview", body, nil)
		expect(t, status, env, 400, engine.KindInvalid)
	}
	for _, query := range []string{"needs=1", "needs=", "needs=true&idea_id=IDEA-001", "needs=true&slice_id=SLICE-001"} {
		status, env := h.call("GET", "/api/interview?"+query, "", nil)
		expect(t, status, env, 400, engine.KindInvalid)
		status, env = h.call("GET", "/api/interview/history?"+query, "", nil)
		expect(t, status, env, 400, engine.KindInvalid)
	}
	if testkit.Calls(t, claude) != nil {
		t.Fatal("Claude was started for a refused conversation")
	}
}
