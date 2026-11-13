package project

import (
	"math"
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
	Attrs     SpanAttrs         `json:"attrs"`

	group    string
	startKey [2]int64
	endKey   int64 // -1 while open
	meta     spanMeta
	from, to int64 // the earliest and latest instant the span can touch (to: MaxInt64 while open)
}

// SpanAttrs are facts about a span that other routes already serve. A key is left out when
// nothing recorded it; a recorded zero is sent.
type SpanAttrs struct {
	Label          string   `json:"label,omitempty"`
	Model          string   `json:"model,omitempty"`
	AgentType      string   `json:"agent_type,omitempty"`
	ToolCalls      *int64   `json:"tool_calls,omitempty"`
	ToolsCountOnly bool     `json:"tools_count_only,omitempty"` // a workflow agent: only a count of its tool calls is observable
	LastTool       string   `json:"last_tool,omitempty"`
	Tokens         *int64   `json:"tokens,omitempty"`
	Action         string   `json:"action,omitempty"`
	Round          *int64   `json:"round,omitempty"`
	Attempt        *int64   `json:"attempt,omitempty"`
	State          string   `json:"state,omitempty"`
	CostUSD        *float64 `json:"cost_usd,omitempty"`
	Vote           string   `json:"vote,omitempty"`
	Reasons        []string `json:"reasons,omitempty"`
	DependsOn      []string `json:"depends_on,omitempty"`
	// A visit whose exit was recorded only after its execution ended (or after its station was
	// entered again): where the span had stopped before the exit arrived, and why.
	InterruptedAt     *int64 `json:"interrupted_at,omitempty"`
	InterruptedReason string `json:"interrupted_reason,omitempty"` // interrupted | superseded
}

// spanMeta is what the filters need to know about where a span came from.
type spanMeta struct {
	src    byte // srcCell | srcExec | srcSlice | srcWave
	ticket string
	wave   string
	execs  []string
}

const (
	srcCell byte = iota + 1
	srcExec
	srcSlice // slice waits and eligibility, capacity waits: never under an execution filter
	srcWave
)

// From and To are the span's extent in Unix milliseconds: the start's earliest bound and the
// end's latest bound. To is math.MaxInt64 while the span is open.
func (sp *Span) From() int64 { return sp.from }
func (sp *Span) To() int64   { return sp.to }

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

type spanBuilder struct {
	out []*Span
	cur spanMeta
}

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
	sp.meta = b.cur
	edge := start
	if edge == nil {
		edge = end
	}
	if lo, ok := edge.lo(); ok {
		sp.from = lo
	} else {
		sp.from = edge.OrderMS
	}
	sp.to = math.MaxInt64
	if end != nil {
		if hi, ok := end.hi(); ok {
			sp.to = hi
		} else {
			sp.to = end.OrderMS
		}
		sp.to = max(sp.to, sp.from)
	}
	b.out = append(b.out, sp)
	return sp
}

// SpanFilter selects spans. FromMS and ToMS select spans overlapping the window (an open span
// overlaps everything after its start); SpanID selects one span exactly.
type SpanFilter struct {
	Ticket, Execution, Wave, Entity, SpanID string
	Kinds                                   map[string]bool
	FromMS, ToMS                            *int64
}

func (f SpanFilter) wantTicket(t string) bool { return f.Ticket == "" || f.Ticket == t }

func (f SpanFilter) match(sp *Span) bool {
	m := sp.meta
	switch m.src {
	case srcCell:
		if !f.wantTicket(m.ticket) || (f.Wave != "" && m.wave != f.Wave) || (f.Execution != "" && !contains(m.execs, f.Execution)) {
			return false
		}
	case srcExec:
		if (f.Execution != "" && (len(m.execs) == 0 || m.execs[0] != f.Execution)) || !f.wantTicket(m.ticket) || (f.Wave != "" && m.wave != f.Wave) {
			return false
		}
	case srcSlice:
		if f.Execution != "" || !f.wantTicket(m.ticket) || (f.Wave != "" && m.wave != f.Wave) {
			return false
		}
	case srcWave:
		if f.Execution != "" || f.Ticket != "" || (f.Wave != "" && m.wave != f.Wave) {
			return false
		}
	}
	if f.SpanID != "" && sp.SpanID != f.SpanID {
		return false
	}
	if len(f.Kinds) > 0 && !f.Kinds[sp.Kind] {
		return false
	}
	if f.Entity != "" && sp.Entity != f.Entity && feedStr(sp.Parent) != f.Entity && !strings.HasPrefix(sp.Entity, f.Entity+"/") {
		return false
	}
	if f.FromMS != nil && sp.to < *f.FromMS {
		return false
	}
	return true
}

// spanSet is every span of one projection position, sorted by start, with lanes assigned over
// the whole set (so a filtered reply keeps the lanes of the full picture).
type spanSet struct {
	pos     uint64
	applied int64
	spans   []*Span
}

// allSpans returns the spans of the state's current position, building them once per position.
// The spans are shared by every caller: they must not be changed.
func allSpans(s *State) []*Span {
	if c := s.spanCache; c != nil && c.pos == s.Pos && c.applied == s.Applied {
		return c.spans
	}
	spans := buildSpans(s)
	s.spanCache = &spanSet{pos: s.Pos, applied: s.Applied, spans: spans}
	return spans
}

// Spans returns the spans that match f, sorted by start (earliest bound first).
func Spans(s *State, f SpanFilter) []*Span { return spansOf(allSpans(s), f) }

// buildSpans builds every span the projection supports.
func buildSpans(s *State) []*Span {
	b := &spanBuilder{}
	for _, t := range sortedKeys(s.Cells) {
		c := s.Cells[t]
		b.cur = spanMeta{src: srcCell, ticket: t, wave: c.WaveID, execs: c.Executions}
		cellSpans(b, s, c)
	}
	for _, id := range sortedKeys(s.Executions) {
		x := s.Executions[id]
		wave := ""
		if c := s.Cells[x.TicketID]; c != nil {
			wave = c.WaveID
		}
		b.cur = spanMeta{src: srcExec, ticket: x.TicketID, wave: wave, execs: []string{id}}
		execSpans(b, s, x)
	}
	for _, id := range sortedKeys(s.Slices) {
		sl := s.Slices[id]
		b.cur = spanMeta{src: srcSlice, ticket: sl.TicketID, wave: sl.WaveID}
		ids := map[string]string{"slice_id": sl.SliceID}
		for k, v := range map[string]string{"wave_id": sl.WaveID, "ticket_id": sl.TicketID} {
			if v != "" {
				ids[k] = v
			}
		}
		ref := "slice:" + sl.SliceID
		// Every dependency wait, oldest first: the first keeps the plain id, later ones "#n"
		// (n counts the waits no longer kept, so an id never moves to another wait).
		for i, w := range sl.Waits {
			n := sl.WaitsDropped + int64(i) + 1
			var end *Stamp
			reason := "completed"
			if w.Resolved != nil {
				end = w.Resolved
			} else if w.Superseded != nil {
				end, reason = w.Superseded, "superseded"
			}
			sp := b.add("slice-wait", ref, ref, ref, ids, w.Blocked, end, "", reason, false, "")
			if sp != nil {
				if n > 1 {
					sp.SpanID += "#" + itoa(&n)
				}
				sp.Attrs.Reasons, sp.Attrs.DependsOn = nonEmpty(w.Reasons), nonEmpty(w.DependsOn)
			}
		}
		if el := sl.eligible(); el != nil {
			reason := "completed"
			end := sl.Scheduled
			if end == nil && sl.Superseded != nil {
				end, reason = sl.Superseded, "superseded"
			}
			sp := b.add("slice-eligible", ref, ref, ref, ids, el, end, "", reason, false, "")
			if sp != nil {
				sp.Attrs.DependsOn = nonEmpty(sl.DependsOn)
			}
		}
	}
	// Execution-capacity waits, closed then open, keyed by the event that opened them.
	capacity := func(t string, opened, released *Stamp) {
		wave := ""
		if c := s.Cells[t]; c != nil {
			wave = c.WaveID
		}
		b.cur = spanMeta{src: srcSlice, ticket: t, wave: wave}
		ref := "cell:" + t
		if sp := b.add("capacity-wait", ref, ref, ref, map[string]string{"ticket_id": t}, opened, released, "", "completed", false, ""); sp != nil {
			sp.SpanID += "@" + opened.EventID
		}
	}
	for _, w := range s.CapacityWaits {
		capacity(w.TicketID, w.Opened, w.Released)
	}
	for _, t := range sortedKeys(s.Pending.Capacity) {
		capacity(t, s.Pending.Capacity[t], nil)
	}
	for _, id := range sortedKeys(s.Waves) {
		w := s.Waves[id]
		b.cur = spanMeta{src: srcWave, wave: id}
		b.add("wave", "wave:"+id, "", "wave:"+id, map[string]string{"wave_id": id}, w.FirstSeen, waveDone(s, w), "", "completed", false, "")
	}
	assignLanes(b.out)
	sort.SliceStable(b.out, func(i, j int) bool {
		x, y := b.out[i], b.out[j]
		if x.from != y.from {
			return x.from < y.from
		}
		if x.startKey != y.startKey {
			return x.startKey[1] < y.startKey[1]
		}
		return x.SpanID < y.SpanID
	})
	return b.out
}

// waveDone is when a wave's last slice was integrated, once every slice is integrated or
// superseded; nil before.
func waveDone(s *State, w *Wave) *Stamp {
	var last *Stamp
	if len(w.Slices) == 0 {
		return nil
	}
	for _, sid := range w.Slices {
		sl := s.Slices[sid]
		if sl == nil || (sl.Integrated == nil && sl.Superseded == nil) {
			return nil
		}
		if sl.Integrated != nil && (last == nil || sl.Integrated.Pos > last.Pos) {
			last = sl.Integrated
		}
	}
	return last
}

func nonEmpty(list []string) []string {
	if len(list) == 0 {
		return nil
	}
	return append([]string(nil), list...)
}

func feedStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func cellSpans(b *spanBuilder, s *State, c *Cell) {
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
		if sp := b.add("round", "gate:"+t+"/round#"+itoa(&n), cellRef, cellRef, with("round", itoa(&n)), r.start, r.end, r.outcome, reason, false, ""); sp != nil {
			sp.Attrs.Round = ptr(n)
		}
	}

	// visits, and the build tasks inside them (start inferred: the previous completion).
	for i, v := range c.Visits {
		parent := ""
		if v.ExecutionID != "" {
			parent = "execution:" + v.ExecutionID
		}
		bound, rule, why := visitEnd(s, c, i)
		end := v.Exited
		if bound != nil {
			end = bound
		}
		if sp := b.add("visit", "visit:"+v.VisitID, parent, cellRef, with("visit_id", v.VisitID, "station", v.Station, "round", itoa(v.Round), "execution_id", v.ExecutionID),
			v.Entered, end, v.Outcome, "completed", false, ""); sp != nil {
			sp.Attrs.Action, sp.Attrs.Round = v.Action, v.Round
			switch {
			case bound != nil:
				// Ended without an exit record (or closed only by cleanup): closed at the bound, no
				// outcome, reconstructed, its length at most until the bound; never "took".
				sp.closeInferred(v.Entered, bound, rule, why)
			case v.Exited != nil:
				if late, _, lateWhy := visitBound(s, c, i); late != nil && laterThan(v.Exited, late) {
					// The recorded exit wins; say where the span had stopped before it arrived.
					sp.Attrs.InterruptedAt, sp.Attrs.InterruptedReason = ptr(stampMS(late)), lateWhy
				}
			}
		}
		prev := v.Entered
		for _, task := range c.Tasks {
			if task.VisitID != v.VisitID {
				continue
			}
			if sp := b.add("task", "visit:"+v.VisitID+"/task:"+task.TaskID+"#"+task.Step, "visit:"+v.VisitID, "visit:"+v.VisitID,
				with("visit_id", v.VisitID, "task_id", task.TaskID, "round", itoa(task.Round)), prev, task.At, task.Step, "completed", true, "previous-completion"); sp != nil {
				sp.Attrs.Round = task.Round
			}
			prev = task.At
		}
	}

	// review seats: from the round's start to the seat's verdict, from the lifecycle alone.
	for _, rv := range c.Reviews {
		gate := "gate:" + t + "/review#" + itoa(rv.Round)
		for _, seat := range rv.Panel {
			var end *Stamp
			vote, model := "", seat.Model
			for _, vd := range rv.Verdicts {
				if vd.Seat == seat.Seat {
					end, vote = vd.At, vd.Vote
					if vd.Model != "" {
						model = vd.Model
					}
				}
			}
			if sp := b.add("seat", "seat:"+t+"/review#"+itoa(rv.Round)+"/"+seat.Seat, gate, gate, with("round", itoa(rv.Round), "seat", seat.Seat),
				rv.Started, end, vote, "completed", false, ""); sp != nil {
				sp.Attrs.Model, sp.Attrs.Vote, sp.Attrs.Round = model, vote, rv.Round
			}
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
		if sp := b.add(kind, "gate:"+t+"/"+g.Key, cellRef, cellRef, with("round", itoa(g.Round)), g.Opened, g.Closed, g.ClosedBy, "completed", false, ""); sp != nil {
			sp.Attrs.Round = g.Round
			if g.Reason != "" {
				sp.Attrs.Reasons = []string{g.Reason}
			}
		}
	}
}

// visitBound is where a visit stopped when its exit was not recorded by then, by the rules the
// Control Tower's scene uses (reduce-v3.ts closeVisits): the first applied after its entry (and,
// when it exited, before its exit) of its execution's end ("execution-ended", reason
// interrupted; never for the human-approval station: a wait on a person is not an execution's
// work) and the next entry of the same station ("unclosed-visit", reason superseded: the station
// helper names the earlier visit in that entry as unclosed_visit). nil when neither applies.
// An execution whose outcome is unknown and that recorded no end bounds its visits too, at the
// supervisor's outcome-unknown recovery ("execution-outcome-unknown", reason unknown).
func visitBound(s *State, c *Cell, i int) (bound *Stamp, rule, reason string) {
	v := c.Visits[i]
	if v.Entered == nil {
		return nil, "", ""
	}
	limit := uint64(math.MaxUint64)
	if v.Exited != nil {
		limit = v.Exited.Pos
	}
	consider := func(st *Stamp, ru, re string) {
		if st == nil || st.Pos <= v.Entered.Pos || st.Pos >= limit {
			return
		}
		if bound == nil || st.Pos < bound.Pos {
			bound, rule, reason = st, ru, re
		}
	}
	if x := s.Executions[v.ExecutionID]; v.ExecutionID != "" && x != nil && v.Station != "human-approval" {
		for _, st := range []*Stamp{x.Completed, x.Failed, x.ProcessEnded} {
			consider(st, "execution-ended", "interrupted")
		}
		consider(unknownEnd(s, x), "execution-outcome-unknown", "unknown")
	}
	for _, w := range c.Visits[i+1:] {
		if w.Station == v.Station && w.Entered != nil {
			consider(w.Entered, "unclosed-visit", "superseded")
			break
		}
	}
	return bound, rule, reason
}

// visitEnd is where a visit's span ends when its end is not a recorded exit: the bound when it has
// no exit (visitBound), and, when its only exit was written by cleanup (closed_by cleanup, at
// cleanup time, long after the work), the bound before that exit, else the cleanup itself
// ("closed-by-cleanup", reason unknown). nil when the visit's exit is recorded or it has neither.
func visitEnd(s *State, c *Cell, i int) (end *Stamp, rule, reason string) {
	v := c.Visits[i]
	bound, rule, reason := visitBound(s, c, i)
	switch {
	case v.Exited == nil:
		return bound, rule, reason
	case v.ClosedBy != "cleanup":
		return nil, "", ""
	case bound != nil:
		return bound, rule, reason
	}
	return v.Exited, "closed-by-cleanup", "unknown"
}

// closeInferred makes an end that no record states: basis inferred with its rule and reason, no
// outcome, authority reconstructed, and the length only as a most (until the end's latest bound).
func (sp *Span) closeInferred(start, end *Stamp, rule, reason string) {
	sp.End = endOf(end, "inferred", rule, reason)
	sp.Outcome = nil
	d := between(start, end, true)
	sp.Duration = Duration{MaxMS: d.MaxMS, Basis: "inferred"}
	sp.Authority = "reconstructed"
}

// unknownEnd is where an execution whose outcome is unknown and that recorded no end is closed: no
// later than the supervisor's outcome-unknown recovery (a bounded end: not_after, no at). nil for
// any other execution.
func unknownEnd(s *State, x *Execution) *Stamp {
	if x == nil || x.ProcessEnded != nil || x.Completed != nil || x.Failed != nil || ExecState(x) != "unknown" {
		return nil
	}
	at := x.UnknownAt
	if at == nil { // a projection saved before UnknownAt was kept
		for i := range s.Recoveries {
			if r := &s.Recoveries[i]; r.Kind == "outcome-unknown" && r.ExecutionID == x.ExecutionID {
				at = r.At
				break
			}
		}
	}
	if at == nil {
		return nil
	}
	hi, ok := at.hi()
	if !ok {
		hi = at.OrderMS
	}
	return &Stamp{EventID: at.EventID, Pos: at.Pos, Precision: "bounded", NotAfter: &hi, OrderMS: at.OrderMS, Authority: "reconstructed"}
}

// laterThan reports whether a happened after b by their recorded times (a's earliest bound after
// b's latest). An exit delivered after the bound but stamped before it was not interrupted: the
// sources are read separately, so delivery order is not the order things happened.
func laterThan(a, b *Stamp) bool {
	lo, ok := a.lo()
	hi, ok2 := b.hi()
	return ok && ok2 && lo > hi
}

func execSpans(b *spanBuilder, s *State, x *Execution) {
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
		if sp := b.add("claim", ref, cellParent, group, ids, x.Claimed, end, "", "completed", false, ""); sp != nil {
			sp.Attrs.Attempt = x.Attempt
		}
	}
	state := ExecState(x)
	execAttrs := SpanAttrs{Attempt: x.Attempt, State: state, CostUSD: costOf(x).USD}
	reason := map[string]string{"failed": "failed", "interrupted": "interrupted", "timed-out": "interrupted", "could-not-start": "failed", "unknown": "unknown"}[state]
	// An execution whose outcome is unknown and that recorded no end ended no later than the
	// recovery that found it so: never "running" after it. Its open children close there too.
	unknown := unknownEnd(s, x)
	start, end := x.ProcessStarted, x.ProcessEnded
	if start == nil {
		start, end = x.Started, x.Completed
		if end == nil {
			end = x.Failed
		}
	}
	if start != nil {
		inferred := end == nil && unknown != nil
		if inferred {
			end = unknown
		}
		if sp := b.add("execution", ref, cellParent, group, ids, start, end, state, orDefault(reason, "completed"), false, ""); sp != nil {
			sp.Attrs = execAttrs
			switch {
			case inferred:
				sp.closeInferred(start, end, "execution-outcome-unknown", "unknown")
			case x.ProcessStarted == nil && sp.Duration.Basis == "measured":
				sp.Duration.Basis = "bounded" // the supervisor's own stamps, up to a poll late
			}
		}
	}
	// closeOpen ends a child span of an unknown execution, left open, at the same bound.
	closeOpen := func(sp *Span, from *Stamp) {
		if sp != nil && unknown != nil && sp.End == nil && from != nil && from.Pos < unknown.Pos {
			to := unknown.NotAfter
			sp.to, sp.endKey = max(*to, sp.from), unknown.OrderMS
			sp.closeInferred(from, unknown, "execution-outcome-unknown", "unknown")
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
		closeOpen(b.add("workflow", wref, ref, ref, ids, w.Started, w.Finished, w.Status, reason, false, ""), w.Started)
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
			if sp := b.add("agent-queue", aref, parent, parent, aids, a.Queued, a.Started, "", "completed", false, ""); sp != nil {
				sp.Attrs = SpanAttrs{Label: a.Label, Model: a.Model, AgentType: a.AgentType}
				closeOpen(sp, a.Queued)
			}
		}
		if a.Started != nil {
			reason := map[string]string{"error": "failed", "unknown": "unknown"}[a.Status]
			sp := b.add("agent", aref, parent, parent, aids, a.Started, a.Finished, a.Status, orDefault(reason, "completed"), false, "")
			if sp != nil && a.Finished != nil && a.DurationMS != nil && a.Started.Precision == "ms" {
				sp.Duration = Duration{MS: a.DurationMS, MinMS: a.DurationMS, MaxMS: a.DurationMS, Basis: "measured"}
			}
			if sp != nil {
				// A workflow agent's calls are seen only as a count; an Agent-tool sub-agent's one by one.
				sp.Attrs = SpanAttrs{Label: a.Label, Model: a.Model, AgentType: a.AgentType, ToolCalls: a.ToolCalls, ToolsCountOnly: a.Workflow != "",
					LastTool: a.LastTool, Tokens: a.Tokens}
				closeOpen(sp, a.Started)
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
		closeOpen(b.add("tool", "tool:"+t.ToolCallID, parent, parent, tids, t.Called, t.Returned, t.Status, orDefault(reason, "completed"), false, ""), t.Called)
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
