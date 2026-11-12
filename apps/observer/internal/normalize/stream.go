package normalize

import (
	"encoding/json"
	"path"
	"regexp"
	"sort"
	"strings"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
)

// Stream normalises one execution's stream.jsonl, Claude Code's stream-json output
// (contract 10.5; M6_1_STREAM_COMPATIBILITY.md). Deny by default: a record is classified by its
// type and subtype, only the classifications below are read, and only the fields named here are
// read from them. Whatever else a record holds (prompts, the workflow script, tool inputs and
// results, previews, summaries, commands, paths, account data) is never copied anywhere.
//
// Workflow agents are seen only through task_progress snapshots, which restate every agent; the
// normaliser diffs each against the last one for the workflow (by index) and emits only changes.
type Stream struct {
	Execution string
	Root      string
	Identity  *Identity
	// StartedMS and EndedMS are the process's start and end from started.json and result.json
	// (0 when not known), for the bounds of records that carry no time of their own.
	StartedMS int64
	EndedMS   int64
	// StderrBudget reports whether stderr.log holds Claude Code's "Budget limit reached" line. It
	// is read for that line only and never forwarded. nil: not known.
	StderrBudget func() bool

	key        string
	version    string
	restricted bool
	initSeen   bool
	lastOwnMS  int64
	calls      map[string]*call
	callArgs   map[string]workflowArgs
	subagents  map[string]string // Agent-tool sub-agent id -> the spawning call
	tasks      map[string]*workflow
	taskOrder  []string
	results    []result
	parts      map[int64]int
	seenOdd    map[string]bool
	finished   bool

	// Unrecognised counts records by classification that no rule reads, and Malformed lines
	// that are not JSON objects. Names only, never content.
	Unrecognised map[string]int64
	Malformed    int64
}

type call struct {
	agent, parentAgent, eventID, name string
	calledMS                          int64
	open                              bool
}

type workflowArgs struct {
	tickets []any
	until   any
}

type workflow struct {
	taskID, toolUse, name, startedID string
	args                             workflowArgs
	phases                           bool
	agents                           map[int64]*agentState
	updated                          bool
	status                           string
	endMS                            int64
	updatedLine, notifLine           int64
	notifStatus                      any
	usage                            map[string]any
	done                             bool
}

type agentState struct {
	index                      int64
	agentID, queuedID, startID string
	started, finished          bool
	toolCalls, tokens          any
	lastTool                   any
	lastProgressMS             int64
	ticket, station, seat      string
	labelled                   bool
}

type result struct {
	line              int64
	subtype, terminal any
	isError           any
	index             int64
	cost              any
	models            map[string]any
	workflowJSON      bool
	tickets           []any
	budget            bool
}

// NewStream makes the normaliser for one execution's stream.
func NewStream(execution, root string, identity *Identity) *Stream {
	return &Stream{Execution: execution, Root: root, Identity: identity, key: event.StreamKey(execution),
		calls: map[string]*call{}, callArgs: map[string]workflowArgs{}, subagents: map[string]string{}, tasks: map[string]*workflow{},
		parts: map[int64]int{}, seenOdd: map[string]bool{}, Unrecognised: map[string]int64{}}
}

// Key is the partition key.
func (s *Stream) Key() string { return s.key }

// Version is the Claude Code version from the first init, and whether the parser knows it.
func (s *Stream) Version() (string, bool) { return s.version, s.version == "" || !s.restricted }

// CostMayBeUnderReported: a workflow was killed by a budget stop, so requests in flight may be
// missing from the reported spend (stream proof 3.5; contract open question 5). The schema has
// no field for it on execution.usage, so it is reported with the source's state.
func (s *Stream) CostMayBeUnderReported() bool {
	for _, taskID := range s.taskOrder {
		if wf := s.tasks[taskID]; wf.status == "killed" {
			budget, _ := s.budgetStop()
			return budget
		}
	}
	return false
}

// Finished reports whether Finish has run.
func (s *Stream) Finished() bool { return s.finished }

func (s *Stream) main() string { return s.Execution + "/main" }

// Classify gives a record's classification: "type" or "type/subtype", "" when it has none.
func Classify(record map[string]any) string {
	typ, ok := record["type"].(string)
	if !ok || !classRe.MatchString(typ) {
		return ""
	}
	if sub, ok := record["subtype"].(string); ok && classRe.MatchString(sub) {
		return typ + "/" + sub
	}
	return typ
}

var classRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,40}$`)

// known are the classifications the parser reads (and those it reads and turns into nothing,
// by design: contract 10.5 "Not turned into events").
var known = map[string]bool{
	"system/init": true, "assistant": true, "user": true, "system/task_started": true, "system/task_progress": true,
	"system/task_updated": true, "system/task_notification": true, "system/permission_denied": true,
	"system/background_tasks_changed": true, "rate_limit_event": true,
}

// restrictedKnown: what is read for a Claude Code version the parser is not pinned to.
var restrictedKnown = map[string]bool{"system/init": true, "system/permission_denied": true}

func (s *Stream) base(typ string, r Read) *event.Event {
	ev := newEvent(typ, event.StreamClaude, s.key, r.Line, "claude", event.Observed)
	p := s.parts[r.Line]
	s.parts[r.Line] = p + 1
	ev.Origin.Part = &p
	ev.ID = event.Part(s.key, r.Line, p)
	if s.version != "" {
		ev.Origin.SourceVersion = "claude-code " + s.version
	}
	ev.IDs.ExecutionID = s.Execution
	ev.Ref(event.RefExecution(s.Execution))
	if s.Identity != nil {
		ev.IDs.ProjectID = s.Identity.ProjectID
		if t := s.Identity.TicketOf(s.Execution); t != "" {
			s.setTicket(ev, t, false)
		}
	}
	ev.Time.ObservedAt = Stamp(r.At)
	return ev
}

func (s *Stream) setTicket(ev *event.Event, t string, fromLabel bool) {
	ev.IDs.TicketID = t
	k := 1
	if s.Identity != nil {
		p := s.Identity.ProductOf(t)
		ev.IDs.SliceID, ev.IDs.WaveID, ev.IDs.Revision = p.SliceID, p.WaveID, p.Revision
		k = s.Identity.Current(t)
	}
	ev.Ref(event.CellRef(t, k))
	if fromLabel {
		ev.Infer("ids.ticket_id", "label")
	}
}

// ownTime places a record that carries its own time.
func (s *Stream) ownTime(ev *event.Event, ms int64) {
	ev.Time.OccurredAt, ev.Time.Precision = stampMS(ms), event.PrecisionMS
	if ms > s.lastOwnMS {
		s.lastOwnMS = ms
	}
}

// noOwnTime places a record that carries no time (contract 6.1): the poll that read it when read
// live; when read afterwards, bounded by the nearest earlier own time (or the process start) and
// the process end.
func (s *Stream) noOwnTime(ev *event.Event, r Read) {
	if r.Live {
		ev.Time.Precision = event.PrecisionArrival
		ev.Time.OccurredAt = Stamp(r.At)
		prev := r.Prev
		if prev.IsZero() || prev.After(r.At) {
			prev = r.At
		}
		ev.Time.NotBefore, ev.Time.NotAfter = Stamp(prev), Stamp(r.At)
		return
	}
	lo := s.lastOwnMS
	if lo == 0 {
		lo = s.StartedMS
	}
	if lo == 0 && s.EndedMS == 0 {
		ev.Time.Precision = event.PrecisionUnknown
		ev.AddUnknown("time.occurred_at")
		return
	}
	ev.Time.Precision = event.PrecisionBounded
	if lo > 0 {
		ev.Time.NotBefore = stampMS(lo)
	}
	if s.EndedMS > 0 && s.EndedMS >= lo {
		ev.Time.NotAfter = stampMS(s.EndedMS)
	}
}

func (s *Stream) unknownType(class string, r Read) []*event.Event {
	if class == "" {
		class = "untyped"
	}
	s.Unrecognised[class]++
	if s.seenOdd[class] {
		return nil
	}
	s.seenOdd[class] = true
	g := gapEvent(event.ObserverID("gap", s.key+":type-"+event.Enc(class)), s.key, "unknown-type", r.Line, r.Line, 1, nil, r)
	g.AnchorKey, g.AnchorSeq = s.key, r.Line
	g.IDs.ExecutionID = s.Execution
	g.Ref(event.RefExecution(s.Execution))
	return []*event.Event{g}
}

// Line normalises one physical line of the stream.
func (s *Stream) Line(line []byte, r Read) []*event.Event {
	var rec map[string]any
	if err := json.Unmarshal(line, &rec); err != nil || rec == nil {
		s.Malformed++
		g := gapEvent(event.ObserverID("gap", s.key+":line-"+itoa(r.Line)), s.key, "unparsable-line", r.Line, r.Line, 1, nil, r)
		g.AnchorKey, g.AnchorSeq = s.key, r.Line
		g.IDs.ExecutionID = s.Execution
		return []*event.Event{g}
	}
	class := Classify(rec)
	if strings.HasPrefix(class, "result") {
		return s.result(rec, r)
	}
	if !known[class] || s.restricted && !restrictedKnown[class] {
		return s.unknownType(class, r)
	}
	switch class {
	case "system/init":
		return s.init(rec, r)
	case "assistant":
		return s.assistant(rec, r)
	case "user":
		return s.user(rec, r)
	case "system/task_started":
		return s.taskStarted(rec, r)
	case "system/task_progress":
		return s.progress(rec, r)
	case "system/task_updated":
		s.taskUpdated(rec, r)
	case "system/task_notification":
		s.notification(rec, r)
	case "system/permission_denied":
		return s.refused(rec, r)
	}
	return nil
}

func names(v any, max int) []any {
	out := []any{}
	for _, item := range arr(v) {
		if n, ok := redact.Name(item); ok && len(out) < max {
			out = append(out, n)
		}
	}
	return out
}

func (s *Stream) init(rec map[string]any, r Read) []*event.Event {
	if s.initSeen {
		return nil // the second turn's init is not a new session
	}
	s.initSeen = true
	v, _ := rec["claude_code_version"].(string)
	if !regexp.MustCompile(`^[0-9]+(\.[0-9]+){1,3}$`).MatchString(v) {
		v = ""
	}
	s.version = v
	s.restricted = v != ClaudeVersion
	ev := s.base("session.initialized", r)
	s.noOwnTime(ev, r)
	var version any
	if v != "" {
		version = v
	}
	ev.Data = map[string]any{"claude_code_version": version, "model": nullStr(redact.Name(rec["model"])),
		"permission_mode": nullStr(redact.Name(rec["permissionMode"])), "tools": names(rec["tools"], 300), "agents": names(rec["agents"], 100)}
	ev.Withheld = len(rec) - 5
	ev.Ref(event.RefAgent(s.main()))
	return []*event.Event{ev}
}

func timestamp(rec map[string]any) (int64, bool) {
	ms, _, ok := parseTime(rec["timestamp"])
	return ms, ok
}

// agentOf is the agent a message belongs to: the main loop, or an Agent-tool sub-agent.
func (s *Stream) agentOf(rec map[string]any) (agent, parent string) {
	if id, ok := redact.ID(rec["agent_id"]); ok && rec["parent_tool_use_id"] != nil {
		parent = s.main()
		if spawner, ok := s.calls[strOf(rec["parent_tool_use_id"])]; ok {
			parent = spawner.agent
		}
		return s.Execution + "/" + id, parent
	}
	return s.main(), ""
}

func (s *Stream) assistant(rec map[string]any, r Read) []*event.Event {
	msg := obj(rec["message"])
	var out []*event.Event
	agent, parent := s.agentOf(rec)
	ms, hasTime := timestamp(rec)
	for _, block := range arr(msg["content"]) {
		b := obj(block)
		if b["type"] != "tool_use" {
			continue
		}
		toolu, ok := redact.ID(b["id"])
		name, okName := redact.Name(b["name"])
		if !ok || !okName {
			continue
		}
		input := obj(b["input"])
		ev := s.base("tool.called", r)
		if hasTime {
			s.ownTime(ev, ms)
		} else {
			s.noOwnTime(ev, r)
		}
		ev.IDs.AgentID, ev.IDs.ParentAgentID = agent, parent
		ev.IDs.ToolCallID = s.Execution + "/" + toolu
		class, script, rel := classifyTool(name, input, s.Root)
		ev.Data = map[string]any{"tool": name, "target_class": class, "script": script, "path_rel": rel}
		ev.Withheld = len(b) - 3
		ev.Parent = event.RefAgent(agent)
		ev.Ref(event.RefAgent(agent), event.RefTool(ev.IDs.ToolCallID))
		s.calls[toolu] = &call{agent: agent, parentAgent: parent, eventID: ev.ID, name: name, calledMS: ms, open: true}
		if name == "Workflow" {
			args := obj(input["args"])
			wa := workflowArgs{tickets: []any{}}
			for _, t := range arr(args["tickets"]) {
				if id, ok := Ticket(t); ok && len(wa.tickets) < 64 {
					wa.tickets = append(wa.tickets, id)
				}
			}
			wa.until = tokOrNil(args["until"])
			s.callArgs[toolu] = wa
		}
		out = append(out, ev)
	}
	return out
}

func (s *Stream) user(rec map[string]any, r Read) []*event.Event {
	msg := obj(rec["message"])
	var out []*event.Event
	ms, hasTime := timestamp(rec)
	for _, block := range arr(msg["content"]) {
		b := obj(block)
		if b["type"] != "tool_result" {
			continue
		}
		toolu, ok := redact.ID(b["tool_use_id"])
		if !ok {
			continue
		}
		c := s.calls[toolu]
		agent, parent := s.agentOf(rec)
		if c != nil {
			agent, parent = c.agent, c.parentAgent
		}
		ev := s.base("tool.returned", r)
		if hasTime {
			s.ownTime(ev, ms)
		} else {
			s.noOwnTime(ev, r)
		}
		ev.IDs.AgentID, ev.IDs.ParentAgentID = agent, parent
		ev.IDs.ToolCallID = s.Execution + "/" + toolu
		status := "ok"
		if b["is_error"] == true {
			status = "error"
		}
		var duration any
		if c != nil && hasTime && c.calledMS > 0 && ms >= c.calledMS {
			duration = ms - c.calledMS
		}
		if duration == nil {
			ev.AddUnknown("data.duration_ms")
		}
		ev.Data = map[string]any{"status": status, "duration_ms": duration}
		ev.Withheld = len(b) - 2 // the result's content never leaves the observer
		if c != nil {
			ev.Cause = &event.Cause{EventID: c.eventID, Basis: "identity"}
			c.open = false
		}
		ev.Parent = event.RefAgent(agent)
		ev.Ref(event.RefAgent(agent), event.RefTool(ev.IDs.ToolCallID))
		out = append(out, ev)
	}
	return out
}

func (s *Stream) taskStarted(rec map[string]any, r Read) []*event.Event {
	taskID, ok := redact.ID(rec["task_id"])
	if !ok {
		return nil
	}
	toolu, _ := redact.ID(rec["tool_use_id"])
	switch rec["task_type"] {
	case "local_agent":
		s.subagents[taskID] = toolu
		return nil
	case "local_workflow":
	default:
		return s.unknownType("system/task_started:"+tokenOr(rec["task_type"]), r)
	}
	if _, seen := s.tasks[taskID]; seen {
		return nil
	}
	wf := &workflow{taskID: taskID, toolUse: toolu, agents: map[int64]*agentState{}, args: s.callArgs[toolu]}
	if wf.args.tickets == nil {
		wf.args.tickets = []any{}
	}
	wf.name, _ = redact.Name(rec["workflow_name"])
	s.tasks[taskID] = wf
	s.taskOrder = append(s.taskOrder, taskID)
	ev := s.base("workflow.started", r)
	s.noOwnTime(ev, r)
	ev.Data = map[string]any{}
	require(ev, ev.Data, "workflow", nullStr(wf.name, wf.name != ""), "")
	ev.Data["tickets"] = wf.args.tickets
	ev.Data["until"] = wf.args.until
	ev.Withheld = len(rec) - 4 // the prompt (the whole workflow script) and the rest stay here
	ev.IDs.AgentID = s.main()
	ev.Parent = event.RefAgent(s.main())
	ev.Ref(event.RefWorkflow(s.Execution, taskID), event.RefAgent(s.main()))
	for _, t := range wf.args.tickets {
		k := 1
		if s.Identity != nil {
			k = s.Identity.Current(t.(string))
		}
		ev.Ref(event.CellRef(t.(string), k))
	}
	wf.startedID = ev.ID
	return []*event.Event{ev}
}

func tokenOr(v any) string {
	if t, ok := redact.Token(v); ok {
		return t
	}
	return "other"
}

// Worker labels written by belt.js [A3]: "<ticket>: <worker>". Only these forms are read.
var labelRe = regexp.MustCompile(`^([A-Za-z0-9][A-Za-z0-9_.-]{0,79}): (build|revise|verify|merge|cleanup|what next\?|tally|seat the panel|(architecture|security|product|general) reviewer)$`)

func parseLabel(label string) (ticket, station, seat string) {
	m := labelRe.FindStringSubmatch(label)
	if m == nil {
		return "", "", ""
	}
	if _, ok := Ticket(m[1]); !ok {
		return "", "", ""
	}
	switch {
	case m[3] != "":
		return m[1], "review", m[3]
	case m[2] == "build" || m[2] == "revise":
		return m[1], "build", ""
	case m[2] == "verify" || m[2] == "merge" || m[2] == "cleanup":
		return m[1], m[2], ""
	}
	return m[1], "", "" // a clerk: its ticket, no station
}

func intField(m map[string]any, k string) (int64, bool) { return redact.Int(m[k]) }

func (s *Stream) progress(rec map[string]any, r Read) []*event.Event {
	taskID, _ := redact.ID(rec["task_id"])
	wf := s.tasks[taskID]
	snapshot := arr(rec["workflow_progress"])
	if wf == nil || snapshot == nil {
		return nil // a heartbeat, or an Agent-tool sub-agent's progress: no event (contract 8.1)
	}
	var out []*event.Event
	var phases []any
	var agents []map[string]any
	for _, item := range snapshot {
		m := obj(item)
		switch m["type"] {
		case "workflow_phase":
			idx, ok := intField(m, "index")
			title, _ := redact.Text(m["title"], s.Root, 60)
			if ok && len(phases) < 64 {
				phases = append(phases, map[string]any{"index": idx, "title": title})
			}
		case "workflow_agent":
			if _, ok := intField(m, "index"); ok {
				agents = append(agents, m)
			}
		}
	}
	if !wf.phases && len(phases) > 0 {
		wf.phases = true
		ev := s.base("workflow.phases_declared", r)
		s.noOwnTime(ev, r)
		ev.Data = map[string]any{"phases": phases}
		s.workflowRefs(ev, wf)
		out = append(out, ev)
	}
	sort.SliceStable(agents, func(i, j int) bool {
		a, _ := intField(agents[i], "index")
		b, _ := intField(agents[j], "index")
		return a < b
	})
	for _, m := range agents {
		out = append(out, s.agent(wf, m, r)...)
	}
	return out
}

func (s *Stream) workflowRefs(ev *event.Event, wf *workflow) {
	ref := event.RefWorkflow(s.Execution, wf.taskID)
	ev.Parent = ref
	ev.Ref(ref)
}

func (s *Stream) agentEvent(typ string, wf *workflow, st *agentState, m map[string]any, r Read) *event.Event {
	ev := s.base(typ, r)
	s.workflowRefs(ev, wf)
	if st.labelled {
		s.setTicket(ev, st.ticket, true)
		if st.station != "" {
			ev.IDs.Station = st.station
			ev.Infer("ids.station", "label")
		}
		if st.seat != "" {
			ev.IDs.Seat = st.seat
			ev.Infer("ids.seat", "label")
		}
	}
	if st.agentID != "" {
		ev.IDs.AgentID = st.agentID
		ev.Ref(event.RefAgent(st.agentID))
	}
	if st.queuedID != "" && typ != "agent.queued" {
		ev.Cause = &event.Cause{EventID: st.queuedID, Basis: "identity"}
	}
	return ev
}

func msField(m map[string]any, k string) (int64, bool) {
	n, ok := redact.Int(m[k])
	return n, ok && n > 0
}

func (s *Stream) agent(wf *workflow, m map[string]any, r Read) []*event.Event {
	idx, _ := intField(m, "index")
	st := wf.agents[idx]
	var out []*event.Event
	label, _ := redact.Text(m["label"], s.Root, 120)
	phase, okPhase := redact.Text(m["phaseTitle"], s.Root, 60)
	var phaseIndex any
	if n, ok := intField(m, "phaseIndex"); ok {
		phaseIndex = n
	}
	if st == nil {
		if len(wf.agents) >= 2000 {
			return nil
		}
		st = &agentState{index: idx}
		if t, station, seat := parseLabel(label); t != "" {
			st.ticket, st.station, st.seat, st.labelled = t, station, seat, true
		}
		wf.agents[idx] = st
		ev := s.agentEvent("agent.queued", wf, st, m, r)
		if q, ok := msField(m, "queuedAt"); ok {
			s.ownTime(ev, q)
		} else {
			s.noOwnTime(ev, r)
		}
		ev.Data = map[string]any{"index": idx, "label": label, "phase": nullStr(phase, okPhase), "phase_index": phaseIndex,
			"model": nullStr(redact.Name(m["model"]))}
		if st.ticket == "" && ev.IDs.TicketID == "" {
			ev.AddUnknown("ids.ticket_id")
		}
		st.queuedID = ev.ID
		out = append(out, ev)
	}
	agentID, okID := redact.ID(m["agentId"])
	startedAt, okStart := msField(m, "startedAt")
	if !st.started && okID && okStart {
		st.started = true
		st.agentID = s.Execution + "/" + agentID
		ev := s.agentEvent("agent.started", wf, st, m, r)
		s.ownTime(ev, startedAt)
		var try any
		if n, ok := intField(m, "attempt"); ok {
			try = n
		}
		ev.Data = map[string]any{"index": idx, "label": label, "phase": nullStr(phase, okPhase), "phase_index": phaseIndex,
			"agent_type": nullStr(redact.Name(m["agentType"])), "model": nullStr(redact.Name(m["model"])), "agent_try": try}
		if ev.Data["agent_type"] == nil {
			ev.AddUnknown("data.agent_type")
		}
		st.startID = ev.ID
		st.toolCalls, st.tokens, st.lastTool = intOrNil(m["toolCalls"]), intOrNil(m["tokens"]), nullStr(redact.Name(m["lastToolName"]))
		st.lastProgressMS = startedAt
		out = append(out, ev)
	}
	if !st.started || st.finished {
		return out
	}
	calls, tokens, last := intOrNil(m["toolCalls"]), intOrNil(m["tokens"]), nullStr(redact.Name(m["lastToolName"]))
	if lp, ok := msField(m, "lastProgressAt"); ok {
		st.lastProgressMS = max(st.lastProgressMS, lp)
	}
	switch state := m["state"]; state {
	case "done", "error":
		st.finished = true
		ev := s.agentEvent("agent.finished", wf, st, m, r)
		var duration any
		if d, ok := intField(m, "durationMs"); ok && d >= 0 {
			duration = d
			s.ownTime(ev, startedAt+d)
		} else {
			ev.AddUnknown("data.duration_ms")
			ev.Time.Precision = event.PrecisionBounded
			ev.Time.NotBefore = stampMS(st.lastProgressMS)
			if wf.endMS > 0 {
				ev.Time.NotAfter = stampMS(wf.endMS)
			}
		}
		ev.Data = map[string]any{"status": state, "duration_ms": duration, "tokens": tokens, "tool_calls": calls}
		out = append(out, ev)
	default:
		if !equal(calls, st.toolCalls) || !equal(tokens, st.tokens) || !equal(last, st.lastTool) {
			ev := s.agentEvent("agent.progressed", wf, st, m, r)
			s.ownTime(ev, st.lastProgressMS)
			ev.Data = map[string]any{"tool_calls": calls, "tokens": tokens, "last_tool": last}
			out = append(out, ev)
		}
	}
	st.toolCalls, st.tokens, st.lastTool = calls, tokens, last
	return out
}

func equal(a, b any) bool { return a == b }

func (s *Stream) taskUpdated(rec map[string]any, r Read) {
	taskID, _ := redact.ID(rec["task_id"])
	wf := s.tasks[taskID]
	patch := obj(rec["patch"])
	if wf == nil || patch == nil {
		return
	}
	if st := enum(patch["status"], "completed", "killed"); st != nil {
		wf.status = st.(string)
		wf.updated = true
		wf.updatedLine = r.Line
	} else if patch["status"] != nil {
		wf.status, wf.updated, wf.updatedLine = "unknown", true, r.Line
	}
	if end, ok := msField(patch, "end_time"); ok {
		wf.endMS = end
		if end > s.lastOwnMS {
			s.lastOwnMS = end
		}
	}
}

func (s *Stream) notification(rec map[string]any, r Read) {
	taskID, _ := redact.ID(rec["task_id"])
	wf := s.tasks[taskID]
	if wf == nil {
		return
	}
	wf.notifLine = r.Line
	if st, ok := rec["status"].(string); ok && len(st) <= 30 && classRe.MatchString(st) {
		wf.notifStatus = st
	}
	wf.usage = obj(rec["usage"])
}

// toolSummary is executor.tool_summary for a refused request whose input is not known: the tool
// name only (the input arrives later, in the final result, and is never forwarded).
func toolSummary(name string) string { return clip(name, 60) }

func (s *Stream) refused(rec map[string]any, r Read) []*event.Event {
	name, ok := redact.Name(rec["tool_name"])
	if !ok {
		name = "unknown"
	}
	ev := s.base("tool.refused", r)
	s.noOwnTime(ev, r)
	agent := s.main()
	if id, ok := redact.ID(rec["agent_id"]); ok {
		agent = s.Execution + "/" + id
		for _, taskID := range s.taskOrder {
			for _, st := range s.tasks[taskID].agents {
				if st.agentID == agent && st.labelled {
					s.setTicket(ev, st.ticket, true)
					ev.IDs.Station, ev.IDs.Seat = st.station, st.seat
					if st.station != "" {
						ev.Infer("ids.station", "label")
					}
					if st.seat != "" {
						ev.Infer("ids.seat", "label")
					}
				}
			}
		}
	}
	ev.IDs.AgentID = agent
	if toolu, ok := redact.ID(rec["tool_use_id"]); ok {
		if c, ok := s.calls[toolu]; ok && c.agent == agent {
			ev.IDs.ToolCallID = s.Execution + "/" + toolu
			ev.Ref(event.RefTool(ev.IDs.ToolCallID))
		}
	}
	ev.Data = map[string]any{"tool": name, "summary": toolSummary(name)}
	ev.Withheld = len(rec) - 3 // the reason, the message and the raw ids stay here
	ev.Parent = event.RefAgent(agent)
	ev.Ref(event.RefAgent(agent))
	return []*event.Event{ev}
}

var jsonObjectRe = regexp.MustCompile(`(?s)\{.*\}`)

// workflowJSON reads the workflow's JSON from the second turn's result text: whether it is
// there, and its tickets[] (ids, outcome, stage, waiting_for, stations). Nothing else is kept.
func (s *Stream) workflowJSON(text string) (bool, []any) {
	if len(text) > 4<<20 {
		return false, nil
	}
	var v map[string]any
	if json.Unmarshal([]byte(text), &v) != nil {
		m := jsonObjectRe.FindString(text)
		if m == "" || json.Unmarshal([]byte(m), &v) != nil {
			return false, nil
		}
	}
	tickets := []any{}
	for _, item := range arr(v["tickets"]) {
		t := obj(item)
		id, ok := Ticket(t["ticket"])
		if !ok || len(tickets) >= 64 {
			continue
		}
		stations := []any{}
		for _, st := range arr(t["stations"]) {
			if tok, ok := redact.Token(st); ok && len(stations) < 64 {
				stations = append(stations, tok)
			}
		}
		outcome, okO := redact.Label(t["outcome"])
		stg, okS := redact.Label(t["stage"])
		tickets = append(tickets, map[string]any{"ticket": id, "outcome": nullStr(outcome, okO), "stage": nullStr(stg, okS),
			"waiting_for": textOrNil(t["waiting_for"], s.Root, 200), "stations": stations})
	}
	return v != nil, tickets
}

func (s *Stream) result(rec map[string]any, r Read) []*event.Event {
	res := result{line: r.Line, subtype: nullStr(redact.Name(rec["subtype"])), terminal: nullStr(redact.Name(rec["terminal_reason"])),
		isError: boolOrNil(rec["is_error"]), cost: numOrNil(rec["total_cost_usd"]), models: map[string]any{}}
	if res.subtype != nil && len(res.subtype.(string)) > 40 {
		res.subtype = nil
	}
	if res.terminal != nil && len(res.terminal.(string)) > 40 {
		res.terminal = nil
	}
	res.index, _ = intField(rec, "result_index")
	res.budget = rec["subtype"] == "error_max_budget_usd"
	for model, u := range obj(rec["modelUsage"]) {
		name, ok := redact.Name(model)
		usage := obj(u)
		if !ok || usage == nil || len(res.models) >= 32 {
			continue
		}
		res.models[name] = map[string]any{"cost_usd": numOrNil(usage["costUSD"]), "input_tokens": intOrNil(usage["inputTokens"]),
			"output_tokens": intOrNil(usage["outputTokens"]), "cache_read_tokens": intOrNil(usage["cacheReadInputTokens"]),
			"cache_creation_tokens": intOrNil(usage["cacheCreationInputTokens"])}
	}
	if res.index == 1 {
		if text, ok := rec["result"].(string); ok {
			res.workflowJSON, res.tickets = s.workflowJSON(text)
		}
	}
	s.results = append(s.results, res)
	if s.restricted {
		return nil
	}
	var out []*event.Event
	if res.index == 1 || res.budget {
		for _, taskID := range s.taskOrder {
			if wf := s.tasks[taskID]; wf.updated && !wf.done {
				out = append(out, s.workflowFinished(wf, r))
			}
		}
	}
	return out
}

func (s *Stream) budgetStop() (bool, bool) {
	for _, res := range s.results {
		if res.budget {
			return true, false
		}
	}
	if s.StderrBudget != nil && s.StderrBudget() {
		return true, true
	}
	return false, false
}

// workflowFinished is emitted once the workflow's end is known together with what the stream
// says after it (the second turn's result, or the process's end). Its id is anchored to the
// notification (or the update) line, so it is the same however the file is read.
func (s *Stream) workflowFinished(wf *workflow, r Read) *event.Event {
	wf.done = true
	line := wf.notifLine
	if line == 0 {
		line = wf.updatedLine
	}
	anchor := Read{Line: line, At: r.At, Prev: r.Prev, Live: r.Live}
	ev := s.base("workflow.finished", anchor)
	if wf.endMS > 0 {
		s.ownTime(ev, wf.endMS)
	} else {
		s.noOwnTime(ev, r)
	}
	usage := wf.usage
	d := map[string]any{"status": wf.status, "notification_status": wf.notifStatus, "total_tokens": intOrNil(usage["total_tokens"]),
		"tool_uses": intOrNil(usage["tool_uses"]), "duration_ms": intOrNil(usage["duration_ms"]), "stop_reason": nil,
		"workflow_json": false, "tickets": []any{}}
	if usage == nil {
		ev.AddUnknown("data.total_tokens", "data.tool_uses", "data.duration_ms")
	}
	for _, res := range s.results {
		if res.index == 1 {
			d["workflow_json"] = res.workflowJSON
			if res.tickets != nil {
				d["tickets"] = res.tickets
			}
		}
	}
	if wf.status != "completed" {
		budget, fromStderr := s.budgetStop()
		switch {
		case budget && fromStderr:
			d["stop_reason"] = "budget"
			ev.Infer("data.stop_reason", "stderr-line")
		case budget:
			d["stop_reason"] = "budget"
		default:
			d["stop_reason"] = "unknown"
		}
	}
	ev.Data = d
	if wf.startedID != "" {
		ev.Cause = &event.Cause{EventID: wf.startedID, Basis: "identity"}
	}
	ev.IDs.AgentID = s.main()
	s.workflowRefs(ev, wf)
	for _, t := range wf.args.tickets {
		ev.Ref(event.CellRef(t.(string), 1))
	}
	return ev
}

// Finish closes the stream once the process has ended (result.json exists) and the file has
// been read to its end: the workflow ends not yet reported, the execution's usage from the last
// result, and the closing of every span still open (contract 8: reconstructed, status unknown,
// bounded by the process end). It runs once.
func (s *Stream) Finish(r Read) []*event.Event {
	if s.finished {
		return nil
	}
	s.finished = true
	var out []*event.Event
	if !s.restricted {
		for _, taskID := range s.taskOrder {
			if wf := s.tasks[taskID]; wf.updated && !wf.done {
				out = append(out, s.workflowFinished(wf, r))
			}
		}
	}
	if n := len(s.results); n > 0 {
		last := s.results[n-1]
		ev := s.base("execution.usage", Read{Line: last.line, At: r.At, Prev: r.Prev, Live: r.Live})
		s.noOwnTime(ev, Read{Line: last.line, At: r.At, Prev: r.Prev, Live: false})
		budget := false
		for _, res := range s.results {
			budget = budget || res.budget
		}
		ev.Data = map[string]any{"total_cost_usd": last.cost, "subtype": last.subtype, "is_error": last.isError,
			"terminal_reason": last.terminal, "budget_exhausted": last.budget, "models": last.models}
		out = append(out, ev)
	}
	// Spans still open when the process ended.
	end := s.EndedMS
	var taskIDs []string
	taskIDs = append(taskIDs, s.taskOrder...)
	for _, taskID := range taskIDs {
		wf := s.tasks[taskID]
		var idx []int64
		for i := range wf.agents {
			idx = append(idx, i)
		}
		sort.Slice(idx, func(a, b int) bool { return idx[a] < idx[b] })
		for _, i := range idx {
			st := wf.agents[i]
			if !st.started || st.finished {
				continue
			}
			ev := s.closing("agent.finished", event.ObserverID("close", "agent:"+st.agentID), st.startID, st.lastProgressMS, end, r)
			ev.IDs.AgentID = st.agentID
			if st.labelled {
				s.setTicket(ev, st.ticket, true)
				ev.IDs.Station, ev.IDs.Seat = st.station, st.seat
			}
			ev.Data = map[string]any{"status": "unknown", "duration_ms": nil, "tokens": st.tokens, "tool_calls": st.toolCalls}
			ev.Parent = event.RefWorkflow(s.Execution, wf.taskID)
			ev.Ref(event.RefAgent(st.agentID), ev.Parent)
			out = append(out, ev)
		}
	}
	var open []string
	for toolu, c := range s.calls {
		if c.open {
			open = append(open, toolu)
		}
	}
	sort.Strings(open)
	for _, toolu := range open {
		c := s.calls[toolu]
		id := s.Execution + "/" + toolu
		ev := s.closing("tool.returned", event.ObserverID("close", "tool:"+id), c.eventID, c.calledMS, end, r)
		ev.IDs.AgentID, ev.IDs.ParentAgentID, ev.IDs.ToolCallID = c.agent, c.parentAgent, id
		ev.Data = map[string]any{"status": "unknown", "duration_ms": nil}
		ev.Parent = event.RefAgent(c.agent)
		ev.Ref(event.RefAgent(c.agent), event.RefTool(id))
		out = append(out, ev)
	}
	return out
}

func (s *Stream) closing(typ, id, basis string, fromMS, endMS int64, r Read) *event.Event {
	ev := observerEvent(typ, id, "open-at-process-end", []string{basis}, []string{"stream.jsonl", "result.json"})
	ev.Time.ObservedAt = Stamp(r.At)
	ev.Time.Precision = event.PrecisionBounded
	if fromMS > 0 {
		ev.Time.NotBefore = stampMS(fromMS)
	}
	if endMS > 0 {
		ev.Time.NotAfter = stampMS(endMS)
	}
	ev.AnchorKey, ev.AnchorSeq = s.key, 0
	ev.IDs.ExecutionID = s.Execution
	ev.IDs.ProjectID = ""
	if s.Identity != nil {
		ev.IDs.ProjectID = s.Identity.ProjectID
	}
	ev.Ref(event.RefExecution(s.Execution))
	ev.AddUnknown("data.duration_ms")
	return ev
}

// ---- tool targets (server-side: the input is read here and never forwarded) ----

var (
	stationScriptRe = regexp.MustCompile(`^[a-z][a-z-]{1,20}$`)
	envAssignRe     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	testPrograms    = map[string]bool{"pytest": true, "jest": true, "vitest": true, "mocha": true, "rspec": true, "phpunit": true, "ctest": true}
	searchPrograms  = map[string]bool{"grep": true, "rg": true, "find": true, "ls": true, "fd": true, "ag": true, "tree": true}
)

// classifyTool reduces a tool call to its class, a MACH script name with its subcommand, and a
// project-relative path. Arguments, commands, contents and absolute paths are never returned.
func classifyTool(name string, input map[string]any, root string) (string, any, any) {
	switch name {
	case "Workflow":
		return "workflow", nil, nil
	case "Agent", "Task":
		return "agent", nil, nil
	case "Skill":
		return "skill", nil, nil
	case "Grep", "Glob", "LS", "ToolSearch":
		return "search", nil, nil
	case "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead":
		for _, k := range []string{"file_path", "notebook_path", "path"} {
			if p, ok := input[k].(string); ok {
				return classifyPath(p, root)
			}
		}
		return "other", nil, nil
	case "Bash":
		cmd, _ := input["command"].(string)
		return classifyCommand(cmd)
	}
	return "other", nil, nil
}

func classifyPath(p, root string) (string, any, any) {
	if len(p) > 4096 {
		return "other", nil, nil
	}
	rel := p
	if strings.HasPrefix(p, "/") || strings.HasPrefix(p, "~") {
		r := strings.TrimRight(root, "/")
		if root == "" || !strings.HasPrefix(p, r+"/") {
			return "outside-project", nil, nil
		}
		rel = strings.TrimPrefix(p, r+"/")
	}
	rel = path.Clean(rel)
	if strings.HasPrefix(rel, "../") || rel == ".." {
		return "outside-project", nil, nil
	}
	class := "repo-file"
	if strings.HasPrefix(rel, ".factory/worktrees/") && !strings.Contains(rel, "/repo/") {
		class = "cell-file"
	}
	if keep, ok := redact.RelPath(rel); ok {
		return class, nil, keep
	}
	return class, nil, nil
}

func classifyCommand(cmd string) (string, any, any) {
	words := strings.Fields(cmd)
	for len(words) > 0 && envAssignRe.MatchString(words[0]) {
		words = words[1:]
	}
	if len(words) == 0 {
		return "other", nil, nil
	}
	program := path.Base(words[0])
	rest := words[1:]
	if program == "uv" && len(rest) > 0 && rest[0] == "run" {
		rest = rest[1:]
		if len(rest) > 0 {
			program, rest = path.Base(rest[0]), rest[1:]
		}
	}
	if strings.HasPrefix(program, "python") {
		for len(rest) > 0 && strings.HasPrefix(rest[0], "-") {
			rest = rest[1:]
		}
		if len(rest) > 0 {
			program, rest = path.Base(rest[0]), rest[1:]
		}
	}
	if redact.Scripts[program] {
		script := program
		if len(rest) > 0 && stationScriptRe.MatchString(rest[0]) {
			script += " " + rest[0]
		}
		return "station-script", script, nil
	}
	switch {
	case program == "git":
		return "git", nil, nil
	case testPrograms[program], program == "go" && len(rest) > 0 && rest[0] == "test",
		(program == "npm" || program == "pnpm" || program == "yarn" || program == "make") && len(rest) > 0 && rest[0] == "test":
		return "test-run", nil, nil
	case searchPrograms[program]:
		return "search", nil, nil
	}
	return "other", nil, nil
}
