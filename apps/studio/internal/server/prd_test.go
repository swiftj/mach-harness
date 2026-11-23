package server_test

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"mach/studio/internal/engine"
	"mach/studio/internal/testkit"
)

// M19: the PRD conversation over HTTP, before any project exists, its refusals, and the acts on a
// PRD held while it records that PRD's map.

const prdText = "# Lending\n\nA library app.\n\n## Loans\n\nMembers borrow books.\n\n## Fines\n\nOverdue fines.\n"

const prdMap = `{"epics":[{"key":"E1","title":"Lending","criteria":["Members can borrow"]}],` +
	`"slices":[{"key":"M1","title":"Borrow a book","scope":"A member borrows one book.","epic":"E1","depends_on":[],"cites":["5-8"]}]}`

func importPRD(h *host, name, text string) {
	doc := base64.StdEncoding.EncodeToString([]byte(text))
	h.mustOp("prd.import", `{"file":{"name":"`+name+`","content_base64":"`+doc+`"}}`)
}

func TestThePrdConversationOverHTTPBeforeAnyProject(t *testing.T) {
	h, claude := withClaude(t, testkit.Turn{Kind: "slow", Sleep: 60})
	h.login()
	// A PRD that was never imported: Claude is never started.
	status, env := h.call("POST", "/api/interview", `{"prd_id":"PRD-01"}`, nil)
	if status == 200 || env.OK {
		t.Fatalf("started for a PRD that does not exist: %d", status)
	}
	if testkit.Calls(t, claude) != nil {
		t.Fatal("Claude was started for a PRD that does not exist")
	}
	// No project yet: a PRD is imported and its conversation starts all the same.
	importPRD(h, "lending.md", prdText)
	importPRD(h, "other.md", "# Other\n\nSomething else.\n")
	id := h.startInterview(`{"prd_id":"PRD-01"}`)
	status, env = h.call("GET", "/api/interview?prd_id=PRD-01", "", nil)
	var current struct {
		Interview struct {
			InterviewID string `json:"interview_id"`
			PrdID       string `json:"prd_id"`
		} `json:"interview"`
	}
	if status != 200 || json.Unmarshal(env.Data, &current) != nil || current.Interview.PrdID != "PRD-01" || current.Interview.InterviewID != id ||
		strings.Contains(string(env.Data), "slice_id") || strings.Contains(string(env.Data), "idea_id") {
		t.Fatalf("current: %d %s", status, env.Data)
	}
	status, env = h.call("POST", "/api/interview", `{"prd_id":"PRD-01"}`, nil)
	expect(t, status, env, 409, engine.KindConflict)
	// While its turn runs, every act on this PRD's map waits; reads, and acts on another PRD, do not.
	for name, body := range map[string]string{
		"prd.map":    `{"prd_id":"PRD-01","map":` + prdMap + `}`,
		"prd.settle": `{"prd_id":"PRD-01","section":1,"as":"later"}`,
		"prd.apply":  `{"prd_id":"PRD-01"}`,
	} {
		status, env := h.call("POST", "/api/ops/"+name, body, nil)
		expect(t, status, env, 409, engine.KindConflict)
		if !strings.Contains(env.Error.Message, "recording this PRD's map") {
			t.Fatalf("%s: %q", name, env.Error.Message)
		}
	}
	h.mustOp("prd.status", `{"prd_id":"PRD-01"}`)
	h.mustOp("prd.show", `{"prd_id":"PRD-01"}`)
	h.mustOp("prd.list", `{}`)
	h.mustOp("prd.map", `{"prd_id":"PRD-02","map":{"epics":[{"key":"E1","title":"Other","criteria":["Done"]}],`+
		`"slices":[{"key":"M1","title":"Do it","scope":"One person does it.","epic":"E1","depends_on":[],"cites":["1-3"]}]}}`)
	if status, env := h.call("POST", "/api/interview/"+id+"/interrupt", `{}`, nil); status != 200 || !env.OK {
		t.Fatalf("interrupt: %d %+v", status, env.Error)
	}
	h.mustOp("prd.map", `{"prd_id":"PRD-01","map":`+prdMap+`}`)
	calls := testkit.Calls(t, claude)
	if len(calls) != 1 || calls[0].Argv[len(calls[0].Argv)-1] != "/mach:product-studio start from PRD-01. Propose a map of this PRD with the product "+
		"manager: run status and prd show first, then propose the map in one message and ask whether to record it." {
		t.Fatalf("calls %+v", calls)
	}
	argv := strings.Join(calls[0].Argv, "\x00")
	if !strings.Contains(argv, " prd map PRD-01 --from ") || strings.Contains(argv, " prd map PRD-02") || strings.Contains(argv, "project init") {
		t.Fatalf("the turn's rules: %q", calls[0].Argv)
	}
	status, env = h.call("GET", "/api/interview/history?prd_id=PRD-01", "", nil)
	if status != 200 || !strings.Contains(string(env.Data), `"prd_id":"PRD-01"`) {
		t.Fatalf("history: %d %s", status, env.Data)
	}
	// Once the drafts are made, the map stays as it was: the conversation does not start again.
	h.mustOp("prd.settle", `{"prd_id":"PRD-01","section":1,"as":"out-of-scope","reason":"The title."}`)
	h.mustOp("prd.settle", `{"prd_id":"PRD-01","section":3,"as":"later","reason":"Next quarter."}`)
	status, env = h.call("POST", "/api/ops/prd.apply", `{"prd_id":"PRD-01"}`, nil)
	expect(t, status, env, 422, engine.KindRefused)
	h.mustOp("project.init", `{"id":"lending","name":"Lending","vision":"Members borrow books easily.","outcome":["Members can borrow"]}`)
	h.mustOp("prd.apply", `{"prd_id":"PRD-01"}`)
	status, env = h.call("POST", "/api/interview", `{"prd_id":"PRD-01"}`, nil)
	expect(t, status, env, 422, engine.KindRefused)
	if !strings.Contains(env.Error.Message, "drafts were made") {
		t.Fatalf("refusal: %q", env.Error.Message)
	}
}

func TestPrdConversationRequestsTheHostRefuses(t *testing.T) {
	h, claude := withClaude(t)
	h.login()
	for _, body := range []string{`{"prd_id":"PRD-1"}`, `{"prd_id":"prd-01"}`, `{"prd_id":""}`, `{"prd_id":"PRD-01","slice_id":"SLICE-001"}`,
		`{"prd_id":"PRD-01","idea_id":"IDEA-001"}`, `{"prd_id":"PRD-01","needs":true}`, `{"prd_id":"PRD-01","idea":"words"}`} {
		status, env := h.call("POST", "/api/interview", body, nil)
		expect(t, status, env, 400, engine.KindInvalid)
	}
	for _, query := range []string{"prd_id=PRD-1", "prd_id=", "prd_id=PRD-01&idea_id=IDEA-001", "prd_id=PRD-01&needs=true"} {
		status, env := h.call("GET", "/api/interview?"+query, "", nil)
		expect(t, status, env, 400, engine.KindInvalid)
		status, env = h.call("GET", "/api/interview/history?"+query, "", nil)
		expect(t, status, env, 400, engine.KindInvalid)
	}
	if testkit.Calls(t, claude) != nil {
		t.Fatal("Claude was started for a refused conversation")
	}
}
