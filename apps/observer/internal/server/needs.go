package server

// "Needs you" and the Factory's stop (design M23 3 and 4.1): the observer's only routes that run
// anything, and its only two that change anything. Each runs MACH's own run.py through
// internal/act, the one package that starts a process, with a fixed argument vector:
//
//	GET  /api/v1/needs                    decide --json (reads only), cached briefly
//	POST /api/v1/needs/{ticket}/{option}  decide do <ticket> <option> ... --via=floor --json
//	POST /api/v1/factory/stop             factory stop
//	(GET /api/v1/factory/status adds `running`, from factory status, cached briefly)
//
// A write passes every check a read does, then CheckStateChange (Origin and the session's CSRF
// token), a JSON content type and a capped body (ServeHTTP and readBody). The person's name sent
// with a decision goes to run.py and is never sent back; run.py's sentences come back with it taken
// out (act.ParseDecided).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"sync"
	"time"

	"mach/observer/internal/act"
	"mach/observer/internal/redact"
)

// Actor runs MACH's run.py for the Floor (*act.Runner).
type Actor interface {
	Needs(ctx context.Context) act.Reply
	Status(ctx context.Context) act.Reply
	Stop(ctx context.Context) act.Reply
	Decide(ctx context.Context, d act.Decision, allowed func(ticket, option string) bool) act.Reply
}

// How long a read of run.py is used again: a new record in the index reads "Needs you" again at
// once; with none, it is read again after needsTTL. The Factory's running state is read again
// after runningTTL (in the background once one is known).
const (
	needsTTL   = 20 * time.Second
	runningTTL = 10 * time.Second
)

// Error kinds of the write routes.
const (
	KindConflict = "conflict" // another decision or stop for this project is still running: the page asks again, and says it waits
)

// writeRoute: the only paths a POST may reach. Everything else answers GET only.
var writeRoute = regexp.MustCompile(`^/api/v1/(needs/[^/]+/[^/]+|factory/stop)$`)

// unavailableWords: what the page is told when run.py was not found.
const unavailableWords = "MACH was not found beside the observer or in this project, so the Factory Floor cannot record decisions here. The commands to run in Claude Code are shown instead."

// needsCache is the last "Needs you" read and the decisions it offered.
type needsCache struct {
	mu      sync.Mutex
	data    map[string]any
	head    uint64
	at      time.Time
	offered map[string]map[string]bool // ticket -> option keys offered with do: true
}

// runningCache is the last `factory status` read.
type runningCache struct {
	mu      sync.Mutex
	data    *act.Running
	at      time.Time
	reading bool
}

func (s *Server) unavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, fail(KindUnavailable, unavailableWords))
}

// replyError maps a run of run.py that gave no JSON object to the envelope.
func replyError(w http.ResponseWriter, reply act.Reply) {
	switch reply.Kind {
	case act.KindRefused:
		writeJSON(w, http.StatusConflict, fail(KindRefused, reply.Message))
	case act.KindConflict:
		writeJSON(w, http.StatusConflict, fail(KindConflict, reply.Message))
	case act.KindInvalid:
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, reply.Message))
	default:
		writeJSON(w, http.StatusBadGateway, fail(KindUnavailable, reply.Message))
	}
}

// needs: GET /api/v1/needs.
func (s *Server) needs(w http.ResponseWriter, r *http.Request) {
	if s.opts.Act == nil {
		s.unavailable(w)
		return
	}
	data, reply := s.readNeeds(r.Context())
	if data == nil {
		replyError(w, reply)
		return
	}
	writeJSON(w, http.StatusOK, ok(data))
}

// readNeeds returns the cached list while no new record has arrived and it is young, else reads it.
func (s *Server) readNeeds(ctx context.Context) (map[string]any, act.Reply) {
	c := &s.needsCache
	c.mu.Lock()
	defer c.mu.Unlock()
	_, head := s.opts.Log.Bounds()
	now := s.opts.Now()
	if c.data != nil && c.head == head && now.Sub(c.at) < needsTTL {
		return c.data, act.Reply{}
	}
	reply := s.opts.Act.Needs(ctx)
	if !reply.OK() {
		return nil, reply
	}
	data, offered := shapeNeeds(reply.Data, s.opts.Root)
	data["read_at"] = now.UTC().Format(time.RFC3339Nano)
	c.data, c.head, c.at, c.offered = data, head, now, offered
	return data, act.Reply{}
}

func (s *Server) forgetNeeds() {
	s.needsCache.mu.Lock()
	s.needsCache.data = nil
	s.needsCache.mu.Unlock()
}

// offeredNow: whether the last list offered this option for this ticket with do: true.
func (s *Server) offeredNow(ticket, option string) bool {
	s.needsCache.mu.Lock()
	defer s.needsCache.mu.Unlock()
	return s.needsCache.offered[ticket][option]
}

// shapeNeeds keeps decide's list and its declarations, and scrubs every text in it as a document
// (secrets, paths, addresses; known people are replaced by the reply filter). Text written by
// others stays data: the page shows the fields data_fields names as quoted text, never markup.
func shapeNeeds(raw []byte, root string) (map[string]any, map[string]map[string]bool) {
	var top map[string]any
	json.Unmarshal(raw, &top)
	tickets, _ := top["tickets"].([]any)
	offered := map[string]map[string]bool{}
	var safe []string
	for _, t := range tickets {
		item, _ := t.(map[string]any)
		id, _ := item["ticket_id"].(string)
		if paths, ok := item["show_first"].([]any); ok {
			for _, p := range paths {
				if p, ok := p.(string); ok {
					safe = append(safe, p)
				}
			}
		}
		opts, _ := item["options"].([]any)
		for _, o := range opts {
			opt, _ := o.(map[string]any)
			key, _ := opt["key"].(string)
			if id != "" && key != "" && opt["do"] == true {
				if offered[id] == nil {
					offered[id] = map[string]bool{}
				}
				offered[id][key] = true
			}
		}
	}
	scrub := func(s string) string {
		out, _ := redact.ScrubDocument(s, root, redact.DocOptions{SafeNames: safe})
		return out
	}
	if tickets == nil {
		tickets = []any{}
	}
	out := map[string]any{
		"tickets":         scrubAll(tickets, scrub, 0),
		"order":           scrubAll(orEmpty(top["order"]), scrub, 0),
		"nothing_waiting": len(tickets) == 0,
		"data_fields":     orEmpty(top["data_fields"]),
		"data_note":       top["data_note"],
		"by":              "MACH's own list of what waits for a person, read now; reading it changes nothing",
	}
	return out, offered
}

func orEmpty(v any) any {
	if v == nil {
		return []any{}
	}
	return v
}

func scrubAll(v any, scrub func(string) string, depth int) any {
	if depth > 16 {
		return nil
	}
	switch x := v.(type) {
	case string:
		return scrub(x)
	case []any:
		for i := range x {
			x[i] = scrubAll(x[i], scrub, depth+1)
		}
		return x
	case map[string]any:
		for k := range x {
			x[k] = scrubAll(x[k], scrub, depth+1)
		}
		return x
	}
	return v
}

// readBody reads a write's JSON body: application/json only, at most act.MaxBodyBytes, read within
// 30 seconds.
func readBody(w http.ResponseWriter, r *http.Request) ([]byte, *Envelope, int) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		env := fail(KindInvalid, "A decision is sent as JSON (Content-Type: application/json).")
		return nil, &env, http.StatusUnsupportedMediaType
	}
	http.NewResponseController(w).SetReadDeadline(time.Now().Add(30 * time.Second))
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, act.MaxBodyBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			env := fail(KindInvalid, "The request body is too large.")
			return nil, &env, http.StatusRequestEntityTooLarge
		}
		env := fail(KindInvalid, "The request body could not be read.")
		return nil, &env, http.StatusBadRequest
	}
	return body, nil, 0
}

// decide: POST /api/v1/needs/{ticket}/{option}.
func (s *Server) decide(w http.ResponseWriter, r *http.Request) {
	if s.opts.Act == nil {
		s.unavailable(w)
		return
	}
	ticket, option := r.PathValue("ticket"), r.PathValue("option")
	if err := act.CheckTicket(ticket); err != nil {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, err.Error()))
		return
	}
	if err := act.CheckOption(option); err != nil {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, err.Error()))
		return
	}
	raw, bad, status := readBody(w, r)
	if bad != nil {
		writeJSON(w, status, *bad)
		return
	}
	body, err := act.DecodeBody(raw)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, err.Error()))
		return
	}
	// Not the request's context: a decision that has started is carried to its end even if the
	// browser goes away, so a station is never stopped halfway because a tab was closed.
	reply := s.opts.Act.Decide(context.WithoutCancel(r.Context()), act.Decision{Ticket: ticket, Option: option, Body: body}, s.offeredNow)
	s.forgetNeeds()
	s.forgetRunning()
	if !reply.OK() {
		replyError(w, reply)
		return
	}
	writeJSON(w, http.StatusOK, ok(act.ParseDecided(reply.Data)))
}

// stop: POST /api/v1/factory/stop.
func (s *Server) stop(w http.ResponseWriter, r *http.Request) {
	if s.opts.Act == nil {
		s.unavailable(w)
		return
	}
	raw, bad, status := readBody(w, r)
	if bad != nil {
		writeJSON(w, status, *bad)
		return
	}
	if trimmed := bytes.TrimSpace(raw); len(trimmed) > 0 {
		var empty struct{}
		dec := json.NewDecoder(bytes.NewReader(trimmed))
		dec.DisallowUnknownFields()
		if dec.Decode(&empty) != nil || dec.More() {
			writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "Stopping the Factory takes no inputs: send {}."))
			return
		}
	}
	reply := s.opts.Act.Stop(context.WithoutCancel(r.Context()))
	s.forgetRunning()
	s.forgetNeeds()
	if !reply.OK() {
		replyError(w, reply)
		return
	}
	writeJSON(w, http.StatusOK, ok(act.ParseStop(reply.Data)))
}

// running is `factory status`'s answer on whether a supervisor runs, for /factory/status. The first
// read waits for run.py; after that a stale answer is served while it is read again in the
// background. Nil when run.py is not there or has not answered.
func (s *Server) running(ctx context.Context) *act.Running {
	if s.opts.Act == nil {
		return nil
	}
	c := &s.runningCache
	c.mu.Lock()
	now := s.opts.Now()
	fresh := c.data != nil && now.Sub(c.at) < runningTTL
	if fresh || c.reading {
		data := c.data
		c.mu.Unlock()
		return data
	}
	c.reading = true
	first := c.data == nil
	c.mu.Unlock()
	read := func(ctx context.Context) *act.Running {
		reply := s.opts.Act.Status(ctx)
		c.mu.Lock()
		defer c.mu.Unlock()
		c.reading = false
		c.at = s.opts.Now()
		if !reply.OK() {
			return c.data
		}
		got := act.ParseStatus(reply.Data, c.at)
		c.data = &got
		return c.data
	}
	if first {
		return read(ctx)
	}
	go read(context.Background())
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.data
}

func (s *Server) forgetRunning() {
	s.runningCache.mu.Lock()
	if !s.runningCache.reading {
		s.runningCache.data = nil // the next read waits for run.py: what the page shows next is after the act
	}
	s.runningCache.at = time.Time{}
	s.runningCache.mu.Unlock()
}

// needsFreeText declares the paths in /api/v1/needs that hold text written by others (decide.py's
// DATA_FIELDS, made inert and cut short there): shown as quoted text, never markup or a label.
var needsFreeText = []map[string]any{
	{"route": "/api/v1/needs", "path": "tickets[].situation.title", "from": "cell.json title", "max": 120},
	{"route": "/api/v1/needs", "path": "tickets[].situation.reason", "from": "the line's reason for the stop, quoting station records", "max": 300},
	{"route": "/api/v1/needs", "path": "tickets[].situation.causes[]", "from": "reviewers, the verifier and test runs (explain.py)", "max": 300},
	{"route": "/api/v1/needs", "path": "tickets[].situation.parked.reason", "from": "the supervisor's record", "max": 300},
	{"route": "/api/v1/needs", "path": "tickets[].situation.approval_reasons[]", "from": "review decision.json", "max": 200},
	{"route": "/api/v1/needs", "path": "tickets[].situation.adr", "from": "the ADR and the planner's conflict record", "max": 300},
	{"route": "/api/v1/needs", "path": "tickets[].situation.proposed[].title", "from": "cell.json adrs.proposed", "max": 200},
	{"route": "/api/v1/needs", "path": "tickets[].situation.concerns[]", "from": "the spec's policy concerns", "max": 300},
	{"route": "/api/v1/needs", "path": "tickets[].questions[].text", "from": "the spec's Open questions", "max": 300},
	{"route": "/api/v1/needs", "path": "tickets[].questions[].follow_up", "from": "the spec's Open questions", "max": 300},
	{"route": "/api/v1/needs", "path": "tickets[] (every path the reply's data_fields lists)", "from": "decide.py DATA_FIELDS", "max": 300},
}
