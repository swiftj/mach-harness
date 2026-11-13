package project

import (
	"sort"
	"strings"
)

// Spans per M6_1_SHARED_CONTRACTS.md section 2: derived from the projection, never stored as
// truth. Every duration says how it is known (measured, bounded, inferred, open, unknown). A span
// read at a cursor has no end and no outcome when its end sorts after that cursor, because the
// projection at a cursor holds only what was applied up to it.

// SpanEnd is one end of a span.
type SpanEnd struct {
	EventID   string  `json:"event_id"`
	At        *string `json:"at"`
	Precision string  `json:"precision"`
	NotBefore *string `json:"not_before,omitempty"`
	NotAfter  *string `json:"not_after,omitempty"`
	Basis     string  `json:"basis"` // recorded | inferred
	Rule      string  `json:"rule,omitempty"`
	Reason    string  `json:"reason,omitempty"` // end only: completed | failed | refused | interrupted | superseded | unknown
}

// Span is one span.
type Span struct {
	SpanID    string            `json:"span_id"`
	Kind      string            `json:"kind"`
	Entity    string            `json:"entity"`
	Parent    *string           `json:"parent"`
	IDs       map[string]string `json:"ids"`
	Start     *SpanEnd          `json:"start"`
	End       *SpanEnd          `json:"end"`
	Duration  Duration          `json:"duration"`
	Outcome   *string           `json:"outcome"`
	Lane      int               `json:"lane"`
	Authority string            `json:"authority"`

	group    string
	startKey [2]int64
	endKey   int64 // -1 while open
}

func endOf(st *Stamp, basis, rule, reason string) *SpanEnd {
	if st == nil {
		return nil
	}
	tv := TV(st)
	return &SpanEnd{EventID: st.EventID, At: tv.At, Precision: st.Precision, NotBefore: tv.NotBefore, NotAfter: tv.NotAfter, Basis: basis, Rule: rule, Reason: reason}
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

type spanBuilder struct{ out []*Span }

func (b *spanBuilder) add(kind, entity, parent, group string, ids map[string]string, start, end *Stamp, outcome, reason string, inferredStart bool, rule string) *Span {
	if start == nil && end == nil {
		return nil
	}
	sp := &Span{SpanID: kind + ":" + entity, Kind: kind, Entity: entity, Parent: strp(parent), IDs: ids, group: group}
	startBasis := "recorded"
	if inferredStart {
		startBasis = "inferred"
	}
	sp.Start = endOf(start, startBasis, rule, "")
	if end != nil {
		sp.End = endOf(end, "recorded", "", orDefault(reason, "completed"))
		sp.Outcome = strp(outcome)
	}
	sp.Duration = between(start, end, inferredStart)
	sp.Authority = "authoritative"
	if start != nil {
		sp.Authority = start.Authority
		sp.startKey = [2]int64{start.OrderMS, int64(start.Pos)}
	} else {
		sp.startKey = [2]int64{end.OrderMS, int64(end.Pos)}
	}
	sp.endKey = -1
	if end != nil {
		sp.Authority = weaker(sp.Authority, end.Authority)
		sp.endKey = end.OrderMS
	}
	if inferredStart && sp.Authority == "authoritative" {
		sp.Authority = "reconstructed"
	}
	b.out = append(b.out, sp)
	return sp
}

// SpanFilter selects spans.
type SpanFilter struct {
	Ticket, Execution, Wave, Entity string
	Kinds                           map[string]bool
}

func (f SpanFilter) wantTicket(t string) bool { return f.Ticket == "" || f.Ticket == t }

// Spans builds every span the projection supports, filtered, with lanes assigned.
func Spans(s *State, f SpanFilter) []*Span {
	b := &spanBuilder{}
	for _, t := range sortedKeys(s.Cells) {
		c := s.Cells[t]
		if !f.wantTicket(t) || (f.Wave != "" && c.WaveID != f.Wave) || (f.Execution != "" && !contains(c.Executions, f.Execution)) {
			continue
		}
		cellSpans(b, s, c, f)
	}
	for _, id := range sortedKeys(s.Executions) {
		x := s.Executions[id]
		if (f.Execution != "" && f.Execution != id) || !f.wantTicket(x.TicketID) || (f.Wave != "" && !waveHas(s, f.Wave, x.TicketID)) {
			continue
		}
		execSpans(b, x)
	}
	if f.Execution == "" {
		for _, id := range sortedKeys(s.Slices) {
			sl := s.Slices[id]
			if (f.Wave != "" && sl.WaveID != f.Wave) || !f.wantTicket(sl.TicketID) {
				continue
			}
			ids := map[string]string{"slice_id": sl.SliceID, "wave_id": sl.WaveID, "ticket_id": sl.TicketID}
			ref := "slice:" + sl.SliceID
			if sl.Blocked != nil {
				var end *Stamp
				if sl.Resolved != nil && sl.Resolved.Pos > sl.Blocked.Pos {
					end = sl.Resolved
				}
				b.add("slice-wait", ref, ref, ref, ids, sl.Blocked, end, "", "completed", false, "")
			}
			if el := sl.eligible(); el != nil {
				reason := "completed"
				end := sl.Scheduled
				if end == nil && sl.Superseded != nil {
					end, reason = sl.Superseded, "superseded"
				}
				b.add("slice-eligible", ref, ref, ref, ids, el, end, "", reason, false, "")
			}
		}
		if f.Ticket == "" {
			for _, id := range sortedKeys(s.Waves) {
				w := s.Waves[id]
				if f.Wave != "" && f.Wave != id {
					continue
				}
				var last *Stamp
				done := len(w.Slices) > 0
				for _, sid := range w.Slices {
					sl := s.Slices[sid]
					if sl == nil || (sl.Integrated == nil && sl.Superseded == nil) {
						done = false
						break
					}
					if sl.Integrated != nil && (last == nil || sl.Integrated.Pos > last.Pos) {
						last = sl.Integrated
					}
				}
				if !done {
					last = nil
				}
				b.add("wave", "wave:"+id, "", "wave:"+id, map[string]string{"wave_id": id}, w.FirstSeen, last, "", "completed", false, "")
			}
		}
	}
	var out []*Span
	for _, sp := range b.out {
		if len(f.Kinds) > 0 && !f.Kinds[sp.Kind] {
			continue
		}
		if f.Entity != "" && sp.Entity != f.Entity && feedStr(sp.Parent) != f.Entity && !strings.HasPrefix(sp.Entity, f.Entity+"/") {
			continue
		}
		out = append(out, sp)
	}
	assignLanes(out)
	return out
}

func feedStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func waveHas(s *State, wave, ticket string) bool {
	c := s.Cells[ticket]
	return c != nil && c.WaveID == wave
}

func cellSpans(b *spanBuilder, s *State, c *Cell, f SpanFilter) {
	t := c.TicketID
	cellRef := "cell:" + t
	base := map[string]string{"ticket_id": t, "cell_instance": c.CellInstance, "slice_id": c.SliceID}
	with := func(kv ...string) map[string]string {
		m := map[string]string{}
		for k, v := range base {
			if v != "" {
				m[k] = v
			}
		}
		for i := 0; i+1 < len(kv); i += 2 {
			if kv[i+1] != "" {
				m[kv[i]] = kv[i+1]
			}
		}
		return m
	}
	// cell: from dispatch, else the first lifecycle fact, else the history's start.
	var start *Stamp
	if sl := s.Slices[c.SliceID]; sl != nil && sl.TicketID == t && sl.Scheduled != nil {
		start = sl.Scheduled
	}
	if start == nil && len(c.Visits) > 0 && c.Visits[0].Entered != nil {
		start = c.Visits[0].Entered
	}
	if start == nil && c.Began != nil {
		start = c.Began.At
	}
	if start == nil {
		start = c.FirstSeen
	}
	var end *Stamp
	outcome, reason := "", "completed"
	switch {
	case c.Merge != nil:
		end, outcome = c.Merge.At, "merged"
	case c.Cleanup != nil:
		end, outcome = c.Cleanup.At, c.Cleanup.Outcome
		if outcome == "abandoned" {
			reason = "superseded"
		}
	}
	b.add("cell", cellRef, "", cellRef, with(), start, end, outcome, reason, false, "")

	// rounds: the visits of one judging round, ended by the verdict that ends it.
	type roundInfo struct {
		start, end *Stamp
		outcome    string
	}
	rounds := map[int64]*roundInfo{}
	var order []int64
	for _, v := range c.Visits {
		if v.Round == nil || v.Entered == nil {
			continue
		}
		r := rounds[*v.Round]
		if r == nil {
			r = &roundInfo{start: v.Entered}
			rounds[*v.Round] = r
			order = append(order, *v.Round)
		}
	}
	for _, g := range c.Gates {
		if g.Round != nil && g.Gate == "verify.verdict" && g.Status != "" && g.Status != "PASS" {
			if r := rounds[*g.Round]; r != nil && r.end == nil {
				r.end, r.outcome = g.At, g.Status
			}
		}
	}
	for _, rv := range c.Reviews {
		if rv.Round != nil && rv.Decided != nil {
			if r := rounds[*rv.Round]; r != nil && r.end == nil {
				r.end, r.outcome = rv.Decided, rv.Outcome
			}
		}
	}
	for _, n := range order {
		r := rounds[n]
		reason := "completed"
		if r.outcome != "" && r.outcome != "APPROVED" && r.outcome != "AWAITING_HUMAN" {
			reason = "failed"
		}
		b.add("round", "gate:"+t+"/round#"+itoa(&n), cellRef, cellRef, with("round", itoa(&n)), r.start, r.end, r.outcome, reason, false, "")
	}

	// visits, and the build tasks inside them (start inferred: the previous completion).
	for _, v := range c.Visits {
		parent := ""
		if v.ExecutionID != "" {
			parent = "execution:" + v.ExecutionID
		}
		reason := "completed"
		if v.ClosedBy == "cleanup" {
			reason = "unknown"
		}
		b.add("visit", "visit:"+v.VisitID, parent, cellRef, with("visit_id", v.VisitID, "station", v.Station, "round", itoa(v.Round), "execution_id", v.ExecutionID),
			v.Entered, v.Exited, v.Outcome, reason, false, "")
		prev := v.Entered
		for _, task := range c.Tasks {
			if task.VisitID != v.VisitID {
				continue
			}
			b.add("task", "visit:"+v.VisitID+"/task:"+task.TaskID+"#"+task.Step, "visit:"+v.VisitID, "visit:"+v.VisitID,
				with("visit_id", v.VisitID, "task_id", task.TaskID, "round", itoa(task.Round)), prev, task.At, task.Step, "completed", true, "previous-completion")
			prev = task.At
		}
	}

	// review seats: from the round's start to the seat's verdict, from the lifecycle alone.
	for _, rv := range c.Reviews {
		gate := "gate:" + t + "/review#" + itoa(rv.Round)
		for _, seat := range rv.Panel {
			var end *Stamp
			vote := ""
			for _, vd := range rv.Verdicts {
				if vd.Seat == seat.Seat {
					end, vote = vd.At, vd.Vote
				}
			}
			b.add("seat", "seat:"+t+"/review#"+itoa(rv.Round)+"/"+seat.Seat, gate, gate, with("round", itoa(rv.Round), "seat", seat.Seat),
				rv.Started, end, vote, "completed", false, "")
		}
	}

	// waits for a person.
	for _, k := range sortedKeys(s.Gates) {
		g := s.Gates[k]
		if g.TicketID != t {
			continue
		}
		kind := "gate-wait"
		if g.Kind == "required" {
			kind = "person-wait"
		}
		b.add(kind, "gate:"+t+"/"+g.Key, cellRef, cellRef, with("round", itoa(g.Round)), g.Opened, g.Closed, g.ClosedBy, "completed", false, "")
	}
	_ = f
}

func execSpans(b *spanBuilder, x *Execution) {
	ref := "execution:" + x.ExecutionID
	ids := map[string]string{"execution_id": x.ExecutionID}
	if x.TicketID != "" {
		ids["ticket_id"] = x.TicketID
	}
	if x.Attempt != nil {
		ids["attempt"] = itoa(x.Attempt)
	}
	cellParent := ""
	if x.TicketID != "" {
		cellParent = "cell:" + x.TicketID
	}
	group := orDefault(cellParent, ref)
	if x.Claimed != nil {
		end := x.ProcessStarted
		if end == nil {
			end = x.Started
		}
		b.add("claim", ref, cellParent, group, ids, x.Claimed, end, "", "completed", false, "")
	}
	state := ExecState(x)
	reason := map[string]string{"failed": "failed", "interrupted": "interrupted", "timed-out": "interrupted", "could-not-start": "failed", "unknown": "unknown"}[state]
	if x.ProcessStarted != nil {
		b.add("execution", ref, cellParent, group, ids, x.ProcessStarted, x.ProcessEnded, state, orDefault(reason, "completed"), false, "")
	} else if x.Started != nil {
		end := x.Completed
		if end == nil {
			end = x.Failed
		}
		sp := b.add("execution", ref, cellParent, group, ids, x.Started, end, state, orDefault(reason, "completed"), false, "")
		if sp != nil && sp.Duration.Basis == "measured" {
			sp.Duration.Basis = "bounded" // the supervisor's own stamps, up to a poll late
		}
	}
	for _, wref := range sortedKeys(x.Workflows) {
		w := x.Workflows[wref]
		reason := "completed"
		if w.Status == "killed" {
			reason = "interrupted"
		} else if w.Status == "unknown" {
			reason = "unknown"
		}
		b.add("workflow", wref, ref, ref, ids, w.Started, w.Finished, w.Status, reason, false, "")
	}
	for _, a := range Agents(x) {
		aref := "agent:" + a.AgentID
		if a.AgentID == "" {
			aref = "agent:" + a.Workflow + "#" + itoa(a.Index)
		}
		aids := map[string]string{"execution_id": x.ExecutionID}
		for k, v := range map[string]string{"agent_id": a.AgentID, "ticket_id": a.TicketID, "station": a.Station, "seat": a.Seat} {
			if v != "" {
				aids[k] = v
			}
		}
		parent := orDefault(a.Workflow, ref)
		if a.Queued != nil {
			b.add("agent-queue", aref, parent, parent, aids, a.Queued, a.Started, "", "completed", false, "")
		}
		if a.Started != nil {
			reason := map[string]string{"error": "failed", "unknown": "unknown"}[a.Status]
			sp := b.add("agent", aref, parent, parent, aids, a.Started, a.Finished, a.Status, orDefault(reason, "completed"), false, "")
			if sp != nil && a.Finished != nil && a.DurationMS != nil && a.Started.Precision == "ms" {
				sp.Duration = Duration{MS: a.DurationMS, MinMS: a.DurationMS, MaxMS: a.DurationMS, Basis: "measured"}
			}
		}
	}
	for _, tv := range Tools(x) {
		t := tv.Tool
		parent := ref
		if t.AgentID != "" {
			parent = "agent:" + t.AgentID
		}
		tids := map[string]string{"execution_id": x.ExecutionID, "tool_call_id": t.ToolCallID}
		reason := map[string]string{"error": "failed", "unknown": "unknown"}[t.Status]
		b.add("tool", "tool:"+t.ToolCallID, parent, parent, tids, t.Called, t.Returned, t.Status, orDefault(reason, "completed"), false, "")
	}
}

// assignLanes: within each group, the lowest lane free at the span's start, ties by start order.
// Deterministic, so the same projection always draws the same picture.
func assignLanes(spans []*Span) {
	sort.SliceStable(spans, func(i, j int) bool {
		a, b := spans[i], spans[j]
		if a.group != b.group {
			return a.group < b.group
		}
		if a.startKey != b.startKey {
			return a.startKey[0] < b.startKey[0] || (a.startKey[0] == b.startKey[0] && a.startKey[1] < b.startKey[1])
		}
		return a.SpanID < b.SpanID
	})
	var lanes []int64 // per lane: the end of its last span (-1: open forever)
	group := "\x00"
	for _, sp := range spans {
		if sp.group != group {
			group, lanes = sp.group, nil
		}
		lane := -1
		for i, end := range lanes {
			if end >= 0 && end <= sp.startKey[0] {
				lane = i
				break
			}
		}
		if lane < 0 {
			lanes = append(lanes, 0)
			lane = len(lanes) - 1
		}
		lanes[lane] = sp.endKey
		sp.Lane = lane
	}
}
