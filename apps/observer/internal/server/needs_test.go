package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"mach/observer/internal/act"
	"mach/observer/internal/feedtest"
	"mach/observer/internal/security"
)

// fakeActor stands in for MACH's run.py: it records each request and answers what it is told.
type fakeActor struct {
	mu        sync.Mutex
	calls     []string
	decisions []act.Decision
	needs     string
	status    string
	decided   act.Reply
	stopped   act.Reply
}

func (f *fakeActor) note(what string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, what)
}

func (f *fakeActor) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeActor) Needs(context.Context) act.Reply {
	f.note("needs")
	if f.needs == "" {
		return act.Reply{Data: json.RawMessage(`{"tickets": [], "order": [], "nothing_waiting": true}`)}
	}
	return act.Reply{Data: json.RawMessage(f.needs)}
}

func (f *fakeActor) Status(context.Context) act.Reply {
	f.note("status")
	if f.status == "" {
		return act.Reply{Data: json.RawMessage(`{"supervisor": {"running": false}, "executions": []}`)}
	}
	return act.Reply{Data: json.RawMessage(f.status)}
}

func (f *fakeActor) Stop(context.Context) act.Reply {
	f.note("stop")
	if f.stopped.Kind == "" && f.stopped.Data == nil {
		return act.Reply{Data: json.RawMessage(`{"stopped": [{"execution_id": "x1"}], "supervisor_stopped": true}`)}
	}
	return f.stopped
}

func (f *fakeActor) Decide(_ context.Context, d act.Decision, allowed func(string, string) bool) act.Reply {
	if err := d.Check(allowed); err != nil {
		return act.Reply{Kind: act.KindInvalid, Message: err.Error()}
	}
	f.note("decide " + d.Ticket + " " + d.Option)
	f.mu.Lock()
	f.decisions = append(f.decisions, d)
	f.mu.Unlock()
	if f.decided.Kind == "" && f.decided.Data == nil {
		return act.Reply{Data: json.RawMessage(`{"ticket_id": "` + d.Ticket + `", "option": "` + d.Option + `", "done": true, "now": "Done."}`)}
	}
	return f.decided
}

// csrf reads this harness's session's CSRF token, as the page does.
func (h *harness) csrf(t *testing.T) string {
	t.Helper()
	token, _ := h.get(t, "/api/v1/session")["csrf_token"].(string)
	if token == "" {
		t.Fatal("no CSRF token")
	}
	return token
}

// write sends a write as the page does: the cookie, this host's Origin, the CSRF token and a JSON
// body; edit may take any of them away.
func (h *harness) write(t *testing.T, path, body string, edit func(*http.Request)) (*http.Response, Envelope, []byte) {
	t.Helper()
	token := h.csrf(t)
	return h.do(t, "POST", path, func(r *http.Request) {
		r.Body = ioNop(body)
		r.ContentLength = int64(len(body))
		r.Header.Set("Origin", "http://"+h.host)
		r.Header.Set(security.CSRFHeader, token)
		r.Header.Set("Content-Type", "application/json")
		if edit != nil {
			edit(r)
		}
	})
}

// No decision and no stop happens without the session, this host's Origin and that session's CSRF
// token, a JSON body, or from another site; nothing is run for any of them.
func TestWritesNeedTheSessionOriginAndCSRF(t *testing.T) {
	actor := &fakeActor{}
	h := start(t, config{act: actor})
	other := h.login(t) // a second browser: its own session and token
	otherToken := ""
	{
		_, _, body := h.do(t, "GET", "/api/v1/session", func(r *http.Request) { r.Header.Del("Cookie"); r.AddCookie(other) })
		var s struct {
			Data struct {
				CSRF string `json:"csrf_token"`
			} `json:"data"`
		}
		json.Unmarshal(body, &s)
		otherToken = s.Data.CSRF
	}
	for name, c := range map[string]struct {
		edit   func(*http.Request)
		status int
	}{
		"no cookie": {func(r *http.Request) { r.Header.Del("Cookie") }, 401},
		"forged cookie": {func(r *http.Request) {
			r.Header.Del("Cookie")
			r.AddCookie(&http.Cookie{Name: security.CookieName, Value: "x"})
		}, 401},
		"no origin":                {func(r *http.Request) { r.Header.Del("Origin") }, 403},
		"another origin":           {func(r *http.Request) { r.Header.Set("Origin", "http://evil.example") }, 403},
		"localhost origin for 127": {func(r *http.Request) { r.Header.Set("Origin", "http://localhost:"+strings.Split(h.host, ":")[1]) }, 403},
		"another site":             {func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
		"another host":             {func(r *http.Request) { r.Host = "evil.example:" + strings.Split(h.host, ":")[1] }, 403},
		"no token":                 {func(r *http.Request) { r.Header.Del(security.CSRFHeader) }, 403},
		"a guessed token":          {func(r *http.Request) { r.Header.Set(security.CSRFHeader, "guess") }, 403},
		"another session's token":  {func(r *http.Request) { r.Header.Set(security.CSRFHeader, otherToken) }, 403},
		"token in the query": {func(r *http.Request) {
			r.URL.RawQuery = "csrf=" + r.Header.Get(security.CSRFHeader)
			r.Header.Del(security.CSRFHeader)
		}, 403},
		"a form, not JSON": {func(r *http.Request) { r.Header.Set("Content-Type", "application/x-www-form-urlencoded") }, 415},
		"plain text":       {func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		"no content type":  {func(r *http.Request) { r.Header.Del("Content-Type") }, 415},
		"a body too large": {func(r *http.Request) {
			big := `{"reason": "` + strings.Repeat("x", act.MaxBodyBytes) + `"}`
			r.Body = ioNop(big)
			r.ContentLength = int64(len(big))
		}, 413},
		"an unclean path": {func(r *http.Request) { r.URL.Path = r.URL.Path + "/" }, 405},
	} {
		for _, path := range []string{"/api/v1/needs/T-1/retry", "/api/v1/factory/stop"} {
			resp, env, body := h.write(t, path, `{}`, c.edit)
			if resp.StatusCode != c.status || env.OK {
				t.Errorf("%s, %s: %d %s", name, path, resp.StatusCode, body)
			}
		}
	}
	if n := actor.count(); n != 0 {
		t.Fatalf("run.py ran %d times: %v", n, actor.calls)
	}
	// The same request with everything in place goes through, once each.
	for _, path := range []string{"/api/v1/needs/T-1/retry", "/api/v1/factory/stop"} {
		if resp, env, body := h.write(t, path, `{}`, nil); resp.StatusCode != 200 || !env.OK {
			t.Fatalf("%s: %d %s", path, resp.StatusCode, body)
		}
	}
	// The second browser, with its own token.
	if resp, _, body := h.write(t, "/api/v1/needs/T-2/retry", `{}`, func(r *http.Request) {
		r.Header.Del("Cookie")
		r.AddCookie(other)
		r.Header.Set(security.CSRFHeader, otherToken)
	}); resp.StatusCode != 200 {
		t.Fatalf("the second browser: %d %s", resp.StatusCode, body)
	}
	if got := strings.Join(actor.calls, ","); got != "decide T-1 retry,stop,decide T-2 retry" {
		t.Fatalf("%s", got)
	}
}

// A decision's body is checked before run.py sees it, and a name sent with it is never sent back.
func TestDecisionBodyAndReply(t *testing.T) {
	actor := &fakeActor{decided: act.Reply{Data: json.RawMessage(`{"ticket_id": "T-1", "option": "send-back", "done": true, "by": "Ada Quist",
		"now": "T-1 is sent back with Ada Quist's reason, which uses one of its rounds. The Factory carries it on in the background: the builder revises it.",
		"station": {"answer": {"by": "Ada Quist"}}, "supervisor": "woken", "unparked": true, "pid": 77}`)}}
	h := start(t, config{act: actor})
	resp, env, body := h.write(t, "/api/v1/needs/T-1/send-back", `{"by": "Ada Quist", "reason": "The empty list is not handled."}`, nil)
	if resp.StatusCode != 200 || !env.OK || strings.Contains(string(body), "Ada") || strings.Contains(string(body), "77") ||
		!strings.Contains(string(body), "with your reason") || !strings.Contains(string(body), `"supervisor":"woken"`) {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	d := actor.decisions[0]
	if d.Ticket != "T-1" || d.Option != "send-back" || *d.By != "Ada Quist" || *d.Reason != "The empty list is not handled." {
		t.Fatalf("%+v", d)
	}
	for name, c := range map[string]struct{ path, body string }{
		"unknown field":     {"/api/v1/needs/T-1/approve", `{"by": "a", "force": true}`},
		"not an object":     {"/api/v1/needs/T-1/approve", `["approve"]`},
		"two objects":       {"/api/v1/needs/T-1/approve", `{} {}`},
		"option not ours":   {"/api/v1/needs/T-1/take-over", `{}`},
		"option shape":      {"/api/v1/needs/T-1/--json", `{}`},
		"ticket shape":      {"/api/v1/needs/-T-1/approve", `{}`},
		"bad ADR":           {"/api/v1/needs/T-1/accept", `{"adrs": ["../x"]}`},
		"control chars":     {"/api/v1/needs/T-1/send-back", `{"reason": "a\u001b[2Jb"}`},
		"name with lines":   {"/api/v1/needs/T-1/approve", `{"by": "a\nb"}`},
		"wait not on offer": {"/api/v1/needs/T-1/wait", `{}`},
	} {
		if resp, env, body := h.write(t, c.path, c.body, nil); resp.StatusCode != 400 || env.Error.Kind != KindInvalid {
			t.Errorf("%s: %d %s", name, resp.StatusCode, body)
		}
	}
	if len(actor.decisions) != 1 {
		t.Fatalf("%d decisions reached run.py", len(actor.decisions))
	}
	// run.py's refusal comes back as it was written; a busy project is a conflict.
	actor.decided = act.Reply{Kind: act.KindRefused, Message: `"approve" is not on offer for T-1 now, so nothing was recorded.`}
	if resp, env, _ := h.write(t, "/api/v1/needs/T-1/approve", `{}`, nil); resp.StatusCode != 409 || env.Error.Kind != KindRefused || !strings.HasPrefix(env.Error.Message, `"approve" is not on offer`) {
		t.Fatalf("%d %+v", resp.StatusCode, env.Error)
	}
	actor.decided = act.Reply{Kind: act.KindConflict, Message: "Another decision for this project is still being recorded."}
	if resp, env, _ := h.write(t, "/api/v1/needs/T-1/approve", `{}`, nil); resp.StatusCode != 409 || env.Error.Kind != KindConflict {
		t.Fatalf("%d %+v", resp.StatusCode, env.Error)
	}
	// A conversation's option: why, and the command.
	actor.decided = act.Reply{Data: json.RawMessage(`{"ticket_id": "T-1", "option": "exception", "done": false, "in_conversation": true, "command": "/mach decide T-1", "why": "Read with an agent first."}`)}
	data := map[string]any{}
	_, env, body = h.write(t, "/api/v1/needs/T-1/exception", `{}`, nil)
	json.Unmarshal(body, &struct{ Data *map[string]any }{&data})
	if !env.OK || data["in_conversation"] != true || data["command"] != "/mach decide T-1" {
		t.Fatalf("%s", body)
	}
}

const needsReply = `{"reads_only": true, "nothing_waiting": false, "order": ["T-1"], "data_fields": ["situation.reason"], "data_note": "Data.",
	"tickets": [{"ticket_id": "T-1", "state": "approval", "decide_command": "/mach decide T-1",
		"situation": {"summary": "Approve it.", "reason": "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in /Users/someone/secret/file"},
		"show_first": [".factory/worktrees/T-1/review/round-1/findings.md"],
		"options": [{"key": "approve", "label": "Approve the change", "do": true, "confirm": true, "needs": [], "needs_reason": false, "recommended": false},
			{"key": "wait", "label": "Wait", "do": true, "confirm": false, "needs": [], "needs_reason": false, "recommended": false}]}]}`

// "Needs you" is MACH's own list, scrubbed, read once while nothing new is recorded, read again when
// a record arrives; an option the list offers with do: true (wait) may then be decided.
func TestNeedsReadCachedAndScrubbed(t *testing.T) {
	actor := &fakeActor{needs: needsReply}
	h := start(t, config{act: actor, events: feedtest.Scenario()})
	first := h.get(t, "/api/v1/needs")
	h.get(t, "/api/v1/needs")
	if actor.count() != 1 {
		t.Fatalf("read %d times", actor.count())
	}
	body, _ := json.Marshal(first)
	if strings.Contains(string(body), "ghp_") || strings.Contains(string(body), "/Users/someone") || !strings.Contains(string(body), ".factory/worktrees/T-1/review/round-1/findings.md") {
		t.Fatalf("%s", body)
	}
	if resp, _, body := h.write(t, "/api/v1/needs/T-1/wait", `{}`, nil); resp.StatusCode != 200 {
		t.Fatalf("wait on offer: %d %s", resp.StatusCode, body)
	}
	h.get(t, "/api/v1/needs") // the decision forgot the list
	if actor.count() != 3 {
		t.Fatalf("%v", actor.calls)
	}
	h.log.Append(feedtest.Scenario()[0])
	time.Sleep(50 * time.Millisecond)
	h.get(t, "/api/v1/needs")
	if actor.count() != 4 {
		t.Fatalf("a new record did not read the list again: %v", actor.calls)
	}
}

// Without run.py: the routes say so; the status has no running Factory to show.
func TestWithoutRunPy(t *testing.T) {
	h := start(t, config{})
	if resp, env, _ := h.do(t, "GET", "/api/v1/needs", nil); resp.StatusCode != 503 || env.Error.Kind != KindUnavailable {
		t.Fatalf("%d", resp.StatusCode)
	}
	if resp, env, _ := h.write(t, "/api/v1/factory/stop", `{}`, nil); resp.StatusCode != 503 || env.Error.Kind != KindUnavailable {
		t.Fatalf("%d", resp.StatusCode)
	}
	if s := h.get(t, "/api/v1/factory/status"); s["running"] != nil {
		t.Fatalf("%v", s["running"])
	}
}

// /factory/status says whether a Factory runs and how it was started, from `factory status`.
func TestFactoryStatusSaysWhatRuns(t *testing.T) {
	actor := &fakeActor{status: `{"factory": "supervised", "supervisor": {"running": true, "pid": 12, "since": "2026-11-24T09:00:00Z", "lifetime": "background"}, "executions": [{"ticket_id": "T-1"}]}`}
	h := start(t, config{act: actor})
	r := h.get(t, "/api/v1/factory/status")["running"].(map[string]any)
	if r["known"] != true || r["running"] != true || r["lifetime"] != "background" || r["executions"].(float64) != 1 || r["since"] != "2026-11-24T09:00:00Z" {
		t.Fatalf("%v", r)
	}
	if _, has := r["pid"]; has {
		t.Fatal("the pid was passed on")
	}
	stop := map[string]any{}
	_, env, body := h.write(t, "/api/v1/factory/stop", `{}`, nil)
	json.Unmarshal(body, &struct{ Data *map[string]any }{&stop})
	if !env.OK || stop["stopped"].(float64) != 1 || stop["supervisor_stopped"] != true {
		t.Fatalf("%s", body)
	}
	if resp, _, _ := h.write(t, "/api/v1/factory/stop", `{"all": true}`, nil); resp.StatusCode != 400 {
		t.Fatalf("stop with inputs: %d", resp.StatusCode)
	}
}

// Through a real run.py (a fake one): the answers file is in the observer's folder and gone after.
func TestAnswersThroughRunPy(t *testing.T) {
	python, err := act.LocatePython("")
	if err != nil {
		t.Skip("no python3")
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	script := filepath.Join(dir, "run.py")
	record := filepath.Join(dir, "seen.json")
	os.WriteFile(script, []byte(`import json, sys
args = sys.argv[1:]
f = [a.split("=", 1)[1] for a in args if a.startswith("--answers-file=")][0]
json.dump({"argv": args, "answers": json.load(open(f))}, open(`+quoteJSON(record)+`, "w"))
print(json.dumps({"ticket_id": "T-1", "option": "answers", "done": True, "by": "Ann", "now": "Ann's answers to 1 of 2 open questions on T-1 are recorded."}))
`), 0o644)
	project := filepath.Join(dir, "project")
	scratch := filepath.Join(project, ".factory", "local", "observer")
	os.MkdirAll(scratch, 0o700)
	runner, err := act.New(act.Config{Python: python, Script: script, Project: project, Scratch: scratch})
	if err != nil {
		t.Fatal(err)
	}
	h2 := start(t, config{act: runner})
	resp, _, body := h2.write(t, "/api/v1/needs/T-1/answers", `{"answers": [{"n": 1, "answer": "Weekly."}, {"n": 2, "leave_open": true}]}`, nil)
	if resp.StatusCode != 200 || strings.Contains(string(body), "Ann") || !strings.Contains(string(body), "Your answers") {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	var seen struct {
		Argv    []string `json:"argv"`
		Answers []map[string]any
	}
	b, _ := os.ReadFile(record)
	json.Unmarshal(b, &seen)
	if len(seen.Answers) != 2 || seen.Answers[0]["answer"] != "Weekly." || seen.Answers[1]["leave_open"] != true {
		t.Fatalf("%s", b)
	}
	if entries, _ := os.ReadDir(scratch); len(entries) != 0 {
		t.Fatalf("left in the observer's folder: %v", entries)
	}
}

func ioNop(s string) io.ReadCloser { return io.NopCloser(strings.NewReader(s)) }

func quoteJSON(s string) string { b, _ := json.Marshal(s); return string(b) }
