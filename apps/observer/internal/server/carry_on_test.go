package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"mach/observer/internal/act"
	"mach/observer/internal/security"
)

// A carry-on from the Floor: the guidance goes to run.py as written, as one value; it is refused on an
// option that takes none, when it is too long or holds control characters, and unless the request
// passes the same session, Origin and CSRF checks as every other decision.
func TestCarryOnWithGuidance(t *testing.T) {
	actor := &fakeActor{needs: `{"tickets": [{"ticket_id": "6", "state": "escalated", "situation": {"summary": "The ticket failed its last judging round.",
		"stopped": {"station": "verify", "round": {"used": 3, "max": 3}, "failed": [{"id": "AC-03", "text": "Overdue invoices are listed", "note": "Lists one due today"}], "findings_file": ".factory/worktrees/6/verification-findings-3.md"}},
		"options": [{"key": "carry-on", "label": "Carry on with a fix", "does": "Gives it one more round.", "recommended": true, "do": true, "confirm": false, "needs": [], "takes": ["guidance"]},
		{"key": "revise", "label": "Revise", "does": "x", "do": true, "needs": [], "takes": ["guidance"]},
		{"key": "abandon", "label": "Abandon", "does": "Deletes the work for good.", "do": true, "confirm": true, "needs_reason": true, "needs": []}]}], "order": ["6"]}`}
	h := start(t, config{act: actor})
	// The list keeps MACH's facts of the stop and the option's takes as they came.
	listed := h.get(t, "/api/v1/needs")
	b, _ := json.Marshal(listed)
	if !strings.Contains(string(b), `"takes":["guidance"]`) || !strings.Contains(string(b), `"AC-03"`) || !strings.Contains(string(b), "verification-findings-3.md") {
		t.Fatalf("%s", b)
	}
	guidance := "Treat \"due today\" as not overdue.\n--json $(rm -rf /)"
	resp, env, body := h.write(t, "/api/v1/needs/6/carry-on", `{"guidance": `+quoteJSON(guidance)+`}`, nil)
	if resp.StatusCode != 200 || !env.OK {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	d := actor.decisions[len(actor.decisions)-1]
	if d.Ticket != "6" || d.Option != "carry-on" || d.Guidance == nil || *d.Guidance != guidance {
		t.Fatalf("%+v", d)
	}
	if argv := d.Argv(""); argv[len(argv)-3] != "--guidance="+guidance {
		t.Fatalf("%q", argv)
	}
	// Without guidance it is recorded too: the box is optional.
	if resp, _, body := h.write(t, "/api/v1/needs/6/carry-on", `{}`, nil); resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	// Another option the list offered with takes: ["guidance"] may carry it; one without may not.
	if resp, _, body := h.write(t, "/api/v1/needs/6/revise", `{"guidance": "smaller steps"}`, nil); resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	n := len(actor.decisions)
	for name, c := range map[string]struct{ path, body string }{
		"guidance on abandon": {"/api/v1/needs/6/abandon", `{"reason": "x", "guidance": "y"}`},
		"guidance with ESC":   {"/api/v1/needs/6/carry-on", `{"guidance": "a\u001b[2Jb"}`},
		"guidance too long":   {"/api/v1/needs/6/carry-on", `{"guidance": "` + strings.Repeat("g", act.MaxGuidance+1) + `"}`},
		"guidance not text":   {"/api/v1/needs/6/carry-on", `{"guidance": ["a"]}`},
	} {
		if resp, env, body := h.write(t, c.path, c.body, nil); resp.StatusCode != 400 || env.Error.Kind != KindInvalid {
			t.Errorf("%s: %d %s", name, resp.StatusCode, body)
		}
	}
	// No CSRF token: nothing runs.
	if resp, _, _ := h.write(t, "/api/v1/needs/6/carry-on", `{"guidance": "x"}`, func(r *http.Request) { r.Header.Del(security.CSRFHeader) }); resp.StatusCode == 200 {
		t.Fatalf("a carry-on without the CSRF token was accepted")
	}
	if len(actor.decisions) != n {
		t.Fatalf("%d refused decisions reached run.py", len(actor.decisions)-n)
	}
}
