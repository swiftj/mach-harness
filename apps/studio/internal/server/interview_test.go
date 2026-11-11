package server_test

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"mach/studio/internal/engine"
	"mach/studio/internal/interview"
	"mach/studio/internal/security"
	"mach/studio/internal/testkit"
)

type sse struct {
	ID   int64
	Name string
	Data map[string]any
}

func withClaude(t *testing.T, turns ...testkit.Turn) (*host, string) {
	t.Helper()
	claude := testkit.FakeClaude(t, turns...)
	h := startWith(t, func(project string) interview.Bridge {
		b, err := interview.New(interview.Config{Project: project, Python: testkit.Python(t), Script: testkit.Script(t),
			Claude: claude, TurnTimeout: 30 * time.Second, KillGrace: time.Second, HostEnv: os.Environ()})
		if err != nil {
			t.Fatal(err)
		}
		return b
	})
	return h, claude
}

// stream reads the interview's event stream until a state event with the wanted state.
func (h *host) stream(id string, lastID int64, state string) []sse {
	h.t.Helper()
	req, _ := http.NewRequest("GET", h.base+"/api/interview/"+id+"/events", nil)
	req.AddCookie(h.cookie)
	if lastID > 0 {
		req.Header.Set("Last-Event-ID", strconv.FormatInt(lastID, 10))
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		h.t.Fatalf("events: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	var got []sse
	var cur sse
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "id: "):
			cur.ID, _ = strconv.ParseInt(line[4:], 10, 64)
		case strings.HasPrefix(line, "event: "):
			cur.Name = line[7:]
		case strings.HasPrefix(line, "data: "):
			if err := json.Unmarshal([]byte(line[6:]), &cur.Data); err != nil {
				h.t.Fatalf("data is not JSON: %s", line)
			}
		case line == "":
			if cur.Name != "" {
				got = append(got, cur)
				if cur.Name == "state" && cur.Data["state"] == state {
					return got
				}
				if cur.Name == "ended" && state != "ended" {
					h.t.Fatalf("ended early: %v", got)
				}
			}
			cur = sse{}
		}
	}
	h.t.Fatalf("the stream closed before %s: %v", state, got)
	return nil
}

func sseNames(evs []sse) string {
	var out []string
	for _, e := range evs {
		out = append(out, e.Name)
	}
	return strings.Join(out, " ")
}

func (h *host) startInterview(body string) string {
	h.t.Helper()
	status, env := h.call("POST", "/api/interview", body, nil)
	if status != 200 || !env.OK {
		h.t.Fatalf("start: %d %+v", status, env.Error)
	}
	var started interview.Started
	json.Unmarshal(env.Data, &started)
	return started.InterviewID
}

func TestAnInterviewOverHTTP(t *testing.T) {
	h, claude := withClaude(t, testkit.Turn{Text: testkit.QuestionText(1, "Who invites")}, testkit.Turn{Text: testkit.QuestionText(2, "Seats")})
	h.login()
	_, env := h.call("GET", "/api/session", "", nil)
	var session struct {
		Capabilities map[string]any `json:"capabilities"`
	}
	json.Unmarshal(env.Data, &session)
	if session.Capabilities["interview"] != true || session.Capabilities["continue_command"] != "/mach:product-studio continue" {
		t.Fatalf("capabilities %v", session.Capabilities)
	}
	h.startSlice()
	id := h.startInterview(`{"slice_id":"SLICE-001","idea":"let an admin invite a teammate"}`)
	status, env := h.call("POST", "/api/interview", `{"slice_id":"SLICE-001"}`, nil)
	expect(t, status, env, 409, engine.KindConflict)

	first := h.stream(id, 0, "waiting_for_reply")
	if !strings.Contains(sseNames(first), "message question turn state") {
		t.Fatalf("events %s", sseNames(first))
	}
	for i := 1; i < len(first); i++ {
		if first[i].ID != first[i-1].ID+1 {
			t.Fatal("ids are not consecutive")
		}
	}
	var question map[string]any
	for _, e := range first {
		if e.Name == "question" {
			question = e.Data
		}
	}
	if question["number"] != float64(1) || question["title"] != "Who invites" || question["message_id"] == "" {
		t.Fatalf("question %v", question)
	}
	// A reload replays the turn; a reconnect with Last-Event-ID replays nothing twice.
	if again := h.stream(id, 0, "waiting_for_reply"); sseNames(again) != sseNames(first) {
		t.Fatalf("replay %s", sseNames(again))
	}
	_, env = h.call("GET", "/api/interview?slice_id=SLICE-001", "", nil)
	var current struct {
		Interview interview.Current `json:"interview"`
	}
	json.Unmarshal(env.Data, &current)
	if current.Interview.InterviewID == nil || *current.Interview.InterviewID != id || !current.Interview.Live ||
		current.Interview.LastMessage == nil || current.Interview.State != "waiting_for_reply" ||
		current.Interview.LastMessage.Question == nil || current.Interview.LastMessage.Question.Number != 1 ||
		current.Interview.LastMessage.Question.MessageID != current.Interview.LastMessage.MessageID {
		t.Fatalf("current %+v", current.Interview)
	}

	long := strings.Repeat("x", 8001)
	for _, bad := range []string{`{}`, `{"text":"  "}`, `{"text":"` + long + `"}`, `{"text":"a\u0000"}`, `{"text":"yes","extra":1}`} {
		status, env := h.call("POST", "/api/interview/"+id+"/reply", bad, nil)
		expect(t, status, env, 400, engine.KindInvalid)
	}
	if status, env := h.call("POST", "/api/interview/"+id+"/reply", `{"text":"--resume other; yes"}`, nil); status != 200 || !env.OK {
		t.Fatalf("reply: %d %+v", status, env.Error)
	}
	second := h.stream(id, first[len(first)-1].ID, "waiting_for_reply")
	if second[0].ID != first[len(first)-1].ID+1 || !strings.Contains(sseNames(second), "question") {
		t.Fatalf("after the reply: %s", sseNames(second))
	}
	calls := testkit.Calls(t, claude)
	if argv := calls[1].Argv; argv[len(argv)-1] != "--resume other; yes" || argv[len(argv)-2] != "--" {
		t.Fatalf("the reply is not the message: %q", argv[len(argv)-3:])
	}
	if status, env := h.call("POST", "/api/interview/"+id+"/interrupt", `{}`, nil); status != 409 || env.Error.Kind != engine.KindConflict {
		t.Fatalf("interrupt with no turn: %d %+v", status, env.Error)
	}
	if status, env := h.call("POST", "/api/interview/"+id+"/stop", `{}`, nil); status != 200 || !env.OK {
		t.Fatalf("stop: %d %+v", status, env.Error)
	}
	if second[0].Name != "reply" || second[0].Data["text"] != "--resume other; yes" {
		t.Fatalf("the reply opens the turn's events: %v", second[0])
	}
	ended := h.stream(id, second[len(second)-1].ID, "ended")
	if sseNames(ended) != "ended state" || ended[0].Data["reason"] != "stopped" {
		t.Fatalf("ended %v", ended)
	}
	_, env = h.call("GET", "/api/interview/history?slice_id=SLICE-001", "", nil)
	var history struct {
		SliceID   string                   `json:"slice_id"`
		Events    []interview.HistoryEvent `json:"events"`
		Truncated bool                     `json:"truncated"`
	}
	json.Unmarshal(env.Data, &history)
	if !env.OK || history.SliceID != "SLICE-001" || history.Truncated || len(history.Events) < 10 ||
		history.Events[len(history.Events)-1].Name != "state" || history.Events[0].Name != "state" {
		t.Fatalf("history: %+v", history)
	}
	status, env = h.call("GET", "/api/interview/history?slice_id=../x", "", nil)
	expect(t, status, env, 400, engine.KindInvalid)
	status, env = h.call("POST", "/api/interview/"+strings.Repeat("b", 32)+"/reply", `{"text":"yes"}`, nil)
	expect(t, status, env, 404, engine.KindInvalid)
}

func TestDraftWritesWaitForARunningTurn(t *testing.T) {
	h, _ := withClaude(t, testkit.Turn{Kind: "slow", Sleep: 60})
	h.login()
	h.startSlice()
	id := h.startInterview(`{"slice_id":"SLICE-001"}`)
	status, env := h.call("PUT", "/api/drafts/spec/SLICE-001", specBody(t, "invite-teammate"), nil)
	expect(t, status, env, 409, engine.KindConflict)
	if status, env := h.call("POST", "/api/interview/"+id+"/interrupt", `{}`, nil); status != 200 || !env.OK {
		t.Fatalf("interrupt: %d %+v", status, env.Error)
	}
	if status, env := h.call("PUT", "/api/drafts/spec/SLICE-001", specBody(t, "invite-teammate"), nil); status != 200 || !env.OK {
		t.Fatalf("after the interrupt: %d %+v", status, env.Error)
	}
}

func TestAnApprovedSliceIsNotInterviewed(t *testing.T) {
	h, claude := withClaude(t)
	h.login()
	h.startSlice()
	h.call("PUT", "/api/drafts/spec/SLICE-001", specBody(t, "invite-teammate"), nil)
	h.call("PUT", "/api/drafts/intent/SLICE-001", `{"markdown":`+strconv.Quote(testkit.IntentText)+`}`, nil)
	h.mustOp("epic.approve", `{"epic_id":"EPIC-001"}`)
	h.mustOp("slice.approve", `{"slice_id":"SLICE-001"}`)
	status, env := h.call("POST", "/api/interview", `{"slice_id":"SLICE-001"}`, nil)
	expect(t, status, env, 422, engine.KindRefused)
	if !strings.Contains(env.Error.Message, "reopen it first") {
		t.Fatalf("refusal %q", env.Error.Message)
	}
	status, env = h.call("POST", "/api/interview", `{"slice_id":"SLICE-009"}`, nil)
	expect(t, status, env, 422, engine.KindRefused)
	if testkit.Calls(t, claude) != nil {
		t.Fatal("Claude was started for a refused interview")
	}
}

func TestEveryInterviewRouteNeedsTheSessionOriginAndCSRF(t *testing.T) {
	h, claude := withClaude(t)
	h.login()
	id := strings.Repeat("c", 32)
	routes := []struct{ method, path, body string }{
		{"POST", "/api/interview", `{"slice_id":"SLICE-001"}`},
		{"GET", "/api/interview?slice_id=SLICE-001", ""},
		{"GET", "/api/interview/history?slice_id=SLICE-001", ""},
		{"GET", "/api/interview/" + id + "/events", ""},
		{"POST", "/api/interview/" + id + "/reply", `{"text":"yes"}`},
		{"POST", "/api/interview/" + id + "/interrupt", `{}`},
		{"POST", "/api/interview/" + id + "/stop", `{}`},
	}
	for _, r := range routes {
		anonymous := *h
		anonymous.cookie = nil
		status, env := anonymous.call(r.method, r.path, r.body, nil)
		if status != 401 || env.Error.Kind != engine.KindUnauthorized {
			t.Errorf("%s %s without a session: %d", r.method, r.path, status)
		}
		if r.method == "GET" {
			continue
		}
		for name, adjust := range map[string]func(*http.Request){
			"foreign origin": func(q *http.Request) { q.Header.Set("Origin", "http://evil.example") },
			"no origin":      func(q *http.Request) { q.Header.Del("Origin") },
			"wrong csrf":     func(q *http.Request) { q.Header.Set(security.CSRFHeader, "guess") },
			"no csrf":        func(q *http.Request) { q.Header.Del(security.CSRFHeader) },
		} {
			if status, env := h.call(r.method, r.path, r.body, adjust); status != 403 || env.Error.Kind != engine.KindUnauthorized {
				t.Errorf("%s %s with %s: %d", r.method, r.path, name, status)
			}
		}
	}
	if testkit.Calls(t, claude) != nil {
		t.Fatal("a refused request started Claude")
	}
}
