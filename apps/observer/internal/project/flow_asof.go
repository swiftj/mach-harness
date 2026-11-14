package project

import (
	"math"
	"sort"
)

// "As of a time" (as_of_ms) for the flow, contributors and runs routes: a time filter, exact.
// Nothing whose establishing record is later than the time is counted or listed: a record is
// compared by its order time (the time the observer places it at), so the answer is the same
// whether the history arrived live or was read back from files in another order. A visit or wait
// open at that time is open as of then, with no later end or outcome; an execution that had not
// ended has no outcome; a run record, merge or review decision recorded later does not exist yet.
//
// The cut is applied to a private copy of the projection (CutAt) and the spans the routes use
// (cutSpans): it never changes the state or spans it reads, which are shared.

// later reports a record placed after t.
func later(st *Stamp, t int64) bool { return st != nil && st.OrderMS > t }

// CutAt returns the projection as of t: a copy of s holding only what was recorded at or before t.
// Entities and lists are copied where something is removed, shared where nothing is (they are
// never changed). The risk and app type of a cell are its values at the cursor.
func CutAt(s *State, t int64) *State {
	n := *s
	n.spanCache, n.markCache, n.dirty = nil, nil, nil
	n.LastMS = min(s.LastMS, t)
	n.Waves = map[string]*Wave{}
	for id, w := range s.Waves {
		if !later(w.FirstSeen, t) {
			n.Waves[id] = w
		}
	}
	n.Executions = map[string]*Execution{}
	for id, x := range s.Executions {
		if c := cutExecution(s, x, t); c != nil {
			n.Executions[id] = c
		}
	}
	n.Cells = map[string]*Cell{}
	for id, c := range s.Cells {
		if cc := cutCell(c, t, n.Executions); cc != nil {
			n.Cells[id] = cc
		}
	}
	n.Slices = map[string]*Slice{}
	for id, sl := range s.Slices {
		if c := cutSlice(sl, t); c != nil {
			n.Slices[id] = c
		}
	}
	n.Gates = map[string]*HumanGate{}
	for k, g := range s.Gates {
		if later(g.Opened, t) {
			continue
		}
		if later(g.Closed, t) {
			c := *g
			c.Closed, c.ClosedBy = nil, ""
			g = &c
		}
		n.Gates[k] = g
	}
	n.Runs = nil
	for _, r := range s.Runs {
		if r.ClosedAt != nil && !later(r.ClosedAt, t) {
			n.Runs = append(n.Runs, r)
		}
	}
	n.Gaps = nil
	for _, g := range s.Gaps {
		if !later(g.At, t) {
			n.Gaps = append(n.Gaps, g)
		}
	}
	n.Recoveries = nil
	for _, r := range s.Recoveries {
		if !later(r.At, t) {
			n.Recoveries = append(n.Recoveries, r)
		}
	}
	// Capacity waits released later are open as of t.
	n.Pending.Capacity = map[string]*Stamp{}
	for k, st := range s.Pending.Capacity {
		if !later(st, t) {
			n.Pending.Capacity[k] = st
		}
	}
	n.CapacityWaits = nil
	for _, w := range s.CapacityWaits {
		switch {
		case later(w.Opened, t):
		case later(w.Released, t):
			if cur := n.Pending.Capacity[w.TicketID]; cur == nil || cur.Pos < w.Opened.Pos {
				n.Pending.Capacity[w.TicketID] = w.Opened
			}
		default:
			n.CapacityWaits = append(n.CapacityWaits, w)
		}
	}
	n.Pending.SliceCapacity = map[string]*SliceCapacityWait{}
	for k, w := range s.Pending.SliceCapacity {
		if !later(w.Opened, t) {
			n.Pending.SliceCapacity[k] = cutSliceCapacity(w, t)
		}
	}
	n.SliceCapacityWaits = nil
	for _, w := range s.SliceCapacityWaits {
		switch {
		case later(w.Opened, t):
		case later(w.Released, t):
			if cur := n.Pending.SliceCapacity[w.SliceID]; cur == nil || cur.Opened.Pos < w.Opened.Pos {
				n.Pending.SliceCapacity[w.SliceID] = cutSliceCapacity(w, t)
			}
		default:
			n.SliceCapacityWaits = append(n.SliceCapacityWaits, w)
		}
	}
	return &n
}

func cutSliceCapacity(w *SliceCapacityWait, t int64) *SliceCapacityWait {
	if !later(w.Released, t) && !later(w.LastHeld, t) {
		return w
	}
	c := *w
	if later(c.Released, t) {
		c.Released = nil
	}
	if later(c.LastHeld, t) {
		c.LastHeld = nil
	}
	return &c
}

func cutExecution(s *State, x *Execution, t int64) *Execution {
	if first := execStart(x); first == nil || later(first, t) {
		return nil
	}
	c := *x
	if later(c.Started, t) {
		c.Started, c.Provenance, c.ProvenanceReason, c.SourceCommit, c.Workflow, c.Until, c.Limits = nil, nil, "", "", "", "", nil
	}
	if later(c.ProcessStarted, t) {
		c.ProcessStarted, c.Session = nil, nil
	}
	if later(c.ProcessEnded, t) {
		c.ProcessEnded, c.Ended, c.ExitCode, c.Seconds = nil, "", nil, nil
	}
	if later(c.Completed, t) {
		c.Completed, c.CostUSD, c.StageAtEnd, c.Next, c.WaitingFor, c.RefusedFinal, c.RefusedTools = nil, nil, "", "", "", false, nil
	}
	if later(c.Failed, t) {
		c.Failed, c.ClaudeError = nil, ""
	}
	if c.Completed == nil && c.Failed == nil {
		c.How = "" // recorded by execution.completed or execution.failed only
	}
	if c.Usage != nil && later(c.Usage.At, t) {
		c.Usage = nil
	}
	if later(c.UnknownAt, t) {
		c.UnknownAt = nil
	}
	c.Recovery = nil
	for _, r := range s.Recoveries {
		if r.ExecutionID == x.ExecutionID && !later(r.At, t) {
			c.Recovery = append(c.Recovery, r.Kind)
		}
	}
	return &c
}

func cutCell(c *Cell, t int64, execs map[string]*Execution) *Cell {
	n := *c
	n.Visits = nil
	for _, v := range c.Visits {
		if v.Entered != nil && later(v.Entered, t) || v.Entered == nil && (v.Exited == nil || later(v.Exited, t)) {
			continue
		}
		if later(v.Exited, t) {
			cv := *v
			cv.Exited, cv.Outcome, cv.StageOut, cv.DurationMS, cv.ClosedBy = nil, "", "", nil, ""
			v = &cv
		}
		n.Visits = append(n.Visits, v)
	}
	n.Gates = nil
	for _, g := range c.Gates {
		if !later(g.At, t) {
			n.Gates = append(n.Gates, g)
		}
	}
	n.Tasks = nil
	for _, k := range c.Tasks {
		if !later(k.At, t) {
			n.Tasks = append(n.Tasks, k)
		}
	}
	n.Checks = nil
	for _, k := range c.Checks {
		if !later(k.At, t) {
			n.Checks = append(n.Checks, k)
		}
	}
	n.Reviews = nil
	decided := map[string]bool{}
	for _, rv := range c.Reviews {
		if later(rv.Started, t) || rv.Started == nil && (rv.Decided == nil || later(rv.Decided, t)) {
			continue
		}
		cr := *rv
		cr.Verdicts = nil
		for _, vd := range rv.Verdicts {
			if !later(vd.At, t) {
				cr.Verdicts = append(cr.Verdicts, vd)
			}
		}
		if later(cr.Decided, t) {
			cr.Decided, cr.Outcome, cr.Approvals, cr.Votes, cr.Blockers, cr.SecurityVeto = nil, "", nil, nil, nil, false
		}
		if cr.Decided != nil {
			decided[itoa(cr.Round)] = true
		}
		n.Reviews = append(n.Reviews, &cr)
	}
	// A finding records no time of its own: it is kept when its round's decision is.
	n.Findings = nil
	for _, f := range c.Findings {
		if decided[itoa(f.Round)] {
			n.Findings = append(n.Findings, f)
		}
	}
	n.Approvals = nil
	for _, a := range c.Approvals {
		if !later(a.At, t) {
			n.Approvals = append(n.Approvals, a)
		}
	}
	if c.Merge != nil && later(c.Merge.At, t) {
		n.Merge = nil
	}
	if c.Cleanup != nil && later(c.Cleanup.At, t) {
		n.Cleanup, n.Archived = nil, false
	}
	n.Executions = nil
	for _, id := range c.Executions {
		if execs[id] != nil {
			n.Executions = append(n.Executions, id)
		}
	}
	if later(c.FirstSeen, t) && len(n.Visits) == 0 && len(n.Gates) == 0 && len(n.Reviews) == 0 && len(n.Executions) == 0 && n.Merge == nil {
		// Known only from records later than t (FirstSeen is the first record delivered, which in a
		// history read back from files need not be the earliest).
		return nil
	}
	n.Lifecycle = c.Lifecycle && (len(n.Visits) > 0 || len(n.Gates) > 0 || len(n.Tasks) > 0 || len(n.Checks) > 0 || len(n.Reviews) > 0 ||
		len(n.Approvals) > 0 || n.Merge != nil || n.Cleanup != nil)
	if later(c.Updated, t) {
		// The stage as of t: the last kept visit's, by what it recorded.
		n.Updated, n.Stage, n.StageSource, n.CurrentVisit = nil, "", "", ""
		for _, v := range n.Visits {
			switch {
			case v.StageOut != "":
				n.Stage = v.StageOut
			case v.StageIn != "":
				n.Stage = v.StageIn
			}
			if v.Exited == nil {
				n.CurrentVisit = v.VisitID
			}
		}
	}
	// The risk as of t: the latest review round started by then that recorded one (a time-ordered
	// source). A cell with a review round recorded only later has no known risk as of t: its own
	// value is whichever record was applied last, which depends on delivery order when sources
	// disagree (an intake's risk and a review's). A cell never reviewed keeps its value.
	reviewed := false
	for _, rv := range c.Reviews {
		reviewed = reviewed || rv.Risk != ""
	}
	if reviewed {
		n.Risk = ""
		var riskAt *Stamp
		for _, rv := range n.Reviews {
			if rv.Risk != "" && rv.Started != nil && (riskAt == nil || rv.Started.OrderMS >= riskAt.OrderMS) {
				n.Risk, riskAt = rv.Risk, rv.Started
			}
		}
	}
	if c.AppTypeSource != "" {
		// The app type is recorded on the plan's exit: unknown before it.
		seen := false
		for _, v := range n.Visits {
			seen = seen || v.Exited != nil && v.Exited.EventID == c.AppTypeSource
		}
		if !seen {
			n.AppType, n.AppTypeSource, n.Contracts, n.TasksPlanned = "", "", nil, nil
		}
	}
	return &n
}

func cutSlice(sl *Slice, t int64) *Slice {
	n := *sl
	for _, p := range []**Stamp{&n.Materialized, &n.FirstMaterialized, &n.Blocked, &n.Resolved, &n.Scheduled, &n.Integrated, &n.Superseded} {
		if later(*p, t) {
			*p = nil
		}
	}
	n.Waits = nil
	for _, w := range sl.Waits {
		if later(w.Blocked, t) {
			continue
		}
		if later(w.Resolved, t) || later(w.Superseded, t) {
			cw := *w
			if later(cw.Resolved, t) {
				cw.Resolved = nil
			}
			if later(cw.Superseded, t) {
				cw.Superseded = nil
			}
			w = &cw
		}
		n.Waits = append(n.Waits, w)
	}
	n.History = nil
	for _, h := range sl.History {
		if h.At == nil || *h.At <= t {
			n.History = append(n.History, h)
		}
	}
	n.State = "unknown"
	if k := len(n.History); k > 0 {
		n.State = n.History[k-1].State
	}
	if n.Materialized == nil && n.FirstMaterialized == nil && len(n.Waits) == 0 && n.Scheduled == nil && n.Integrated == nil {
		return nil
	}
	return &n
}

// cutSpans returns the visit and wait spans as of t (the only kinds the flow and contributors
// read): a span started later is gone; one whose end was recorded later is open, unless its
// recorded exit came after a bound that applies by t (attrs interrupted_at), where it ends,
// inferred, as it did before the exit arrived.
func cutSpans(spans []*Span, t int64) []*Span {
	out := make([]*Span, 0, len(spans)/2)
	for _, sp := range spans {
		switch sp.Kind {
		case "visit", "slice-wait", "slice-eligible", "capacity-wait", "gate-wait", "person-wait":
		default:
			continue
		}
		if sp.startKey[0] > t {
			continue
		}
		if sp.endKey >= 0 && sp.endKey <= t {
			out = append(out, sp)
			continue
		}
		c := *sp
		if sp.Start == nil {
			continue // known only by its end, which is later
		}
		if at := sp.Attrs.InterruptedAt; at != nil && *at <= t {
			end := &Stamp{EventID: "", Precision: "ms", At: at, OrderMS: *at, Authority: "reconstructed"}
			c.End = endOf(end, "inferred", "execution-ended", sp.Attrs.InterruptedReason)
			c.Duration = Duration{MaxMS: ptr(max(0, *at-sp.from)), Basis: "inferred"}
			c.Outcome, c.Authority, c.to, c.endKey = nil, "reconstructed", *at, *at
			c.Attrs.InterruptedAt, c.Attrs.InterruptedReason = nil, ""
			out = append(out, &c)
			continue
		}
		c.End, c.Outcome, c.endKey, c.to = nil, nil, -1, math.MaxInt64
		c.Duration = Duration{Basis: "open"}
		c.Attrs.InterruptedAt, c.Attrs.InterruptedReason = nil, ""
		out = append(out, &c)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].from < out[j].from })
	return out
}

// AsOf returns the flow index as of t, built from this index's state and spans, and kept (a few
// per index) while the same time is asked again.
func (ix *FlowIndex) AsOf(t int64) *FlowIndex {
	ix.mu.Lock()
	if a := ix.asOf[t]; a != nil {
		ix.mu.Unlock()
		return a
	}
	ix.mu.Unlock()
	a := BuildFlow(CutAt(ix.st, t), cutSpans(ix.spans, t))
	a.Pos, a.Epoch = ix.Pos, ix.Epoch
	ix.mu.Lock()
	if ix.asOf == nil || len(ix.asOf) >= 8 {
		ix.asOf = map[int64]*FlowIndex{}
	}
	ix.asOf[t] = a
	ix.mu.Unlock()
	return a
}
