package project

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"mach/observer/internal/feed"
	"mach/observer/internal/metrics"
)

// freePlaceSentence is the supervisor's fixed sentence for a ready slice a pass did not dispatch
// because every place was taken when it planned (supervisor.py waiting_for_a_place):
// "it is ready and waits for a free place: <in use> of <max_parallel> in use". The count in use is
// as the plan saw it, which may lag the place just taken; the limit is the recorded max_parallel.
var freePlaceSentence = regexp.MustCompile(`^it is ready and waits for a free place: ([0-9]{1,4}) of ([0-9]{1,4}) in use$`)

// ticketPlaceSentence is the supervisor's fixed sentence for a runnable ticket held because every
// place is in use (supervisor.py schedule); normalize reconstructs its capacity.wait_changed.
var ticketPlaceSentence = regexp.MustCompile(`^all [0-9]{1,4} place\(s\) are in use$`)

// bounded is a reconstructed moment known only to lie between lo (when given) and the decision
// st that sampled it: at is the decision's time, the bounds say where the moment itself may lie.
func bounded(st, lo *Stamp) *Stamp {
	out := &Stamp{EventID: st.EventID, Pos: st.Pos, At: st.At, Precision: "bounded", OrderMS: st.OrderMS, Authority: "reconstructed"}
	if hi, ok := st.hi(); ok {
		out.NotAfter = ptr(hi)
	}
	if l, ok := lo.lo(); ok && (out.NotAfter == nil || l <= *out.NotAfter) {
		out.NotBefore = ptr(l)
	}
	return out
}

// sliceCapacity applies one scheduling decision to the slices waiting for a free place: a slice
// held with freePlaceSentence opens a wait at this decision (not before the previous decision, or
// the activation when there was none) and stays waiting while decisions keep holding it for that
// reason; one no longer held for it is released here. A slice whose own ticket is held for
// capacity (ticketPlaceSentence, or a per-ticket wait already open) is not counted twice: its
// per-ticket wait is the one that stands. Silence is never read as waiting (D16).
func (s *State) sliceCapacity(st, prev *Stamp, held []Held) {
	ticketHeld := map[string]bool{}
	for _, h := range held {
		if h.TicketID != "" && ticketPlaceSentence.MatchString(h.Why) {
			ticketHeld[h.TicketID] = true
		}
	}
	now := map[string]Held{}
	limits := map[string]int64{}
	for _, h := range held {
		if h.SliceID == "" || h.TicketID != "" {
			continue
		}
		m := freePlaceSentence.FindStringSubmatch(h.Why)
		if m == nil {
			continue
		}
		if sl := s.Slices[h.SliceID]; sl != nil && sl.TicketID != "" && (ticketHeld[sl.TicketID] || s.Pending.Capacity[sl.TicketID] != nil) {
			continue
		}
		n, _ := strconv.ParseInt(m[2], 10, 64)
		now[h.SliceID], limits[h.SliceID] = h, n
	}
	for _, id := range sortedKeys(s.Pending.SliceCapacity) {
		if _, still := now[id]; !still {
			s.releaseSliceCapacity(id, st)
		}
	}
	lo := prev
	if lo == nil {
		lo = s.Factory.Since
	}
	for _, id := range sortedKeys(now) {
		w := s.Pending.SliceCapacity[id]
		if w == nil {
			wave := ""
			if sl := s.Slices[id]; sl != nil {
				wave = sl.WaveID
			}
			w = &SliceCapacityWait{SliceID: id, WaveID: wave, Opened: bounded(st, lo)}
			s.Pending.SliceCapacity[id] = w
		}
		w.Limit, w.Why, w.LastHeld = limits[id], now[id].Why, st
	}
}

// releaseSliceCapacity ends a slice's open wait for a free place at st: after the last decision
// that held it, by st at the latest.
func (s *State) releaseSliceCapacity(id string, st *Stamp) {
	w := s.Pending.SliceCapacity[id]
	if w == nil {
		return
	}
	delete(s.Pending.SliceCapacity, id)
	w.Released = bounded(st, w.LastHeld)
	s.SliceCapacityWaits = append(s.SliceCapacityWaits, w)
	if n := len(s.SliceCapacityWaits); n > maxCapacityWaits {
		s.SliceCapacityWaitsDropped += int64(n - maxCapacityWaits)
		s.SliceCapacityWaits = append([]*SliceCapacityWait(nil), s.SliceCapacityWaits[n-maxCapacityWaits:]...)
	}
}

// capacitySentence is the supervisor's fixed sentence for an execution-capacity hold
// (supervisor.py schedule): "all <n> place(s) are in use". Only this recorded sentence makes a
// capacity wait; silence never does (contract D16).
var capacitySentence = regexp.MustCompile(`(?i)\ball \d+ places? (is|are) in use\b`)

// Apply folds one event. Events must arrive in position order; Apply is deterministic.
func (s *State) Apply(e *feed.Event) {
	s.Pos = e.Pos
	s.Applied++
	s.Kinds[e.Type]++
	st := stampOf(e)
	if st.OrderMS > s.LastMS {
		s.LastMS = st.OrderMS
	}
	defer s.syncVisits(e)
	switch e.Origin.Stream {
	case "intake-log":
		s.applyIntake(e, st)
	case "cell-lifecycle":
		s.applyLifecycle(e, st)
	case "execution-record":
		s.applyRecord(e, st)
	case "run-record":
		s.applyRun(e, st)
	case "execution-stream":
		s.applyStream(e, st)
	case "observer":
		s.applyObserver(e, st)
	}
	if pid := feed.Str(e.IDs.ProjectID); pid != "" && s.Project.ProjectID == "" {
		s.Project.ProjectID = pid
	}
}

// day is the UTC date a stamp falls on, for period grouping.
func day(st *Stamp) string {
	ms := st.OrderMS
	if st.At != nil {
		ms = *st.At
	}
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02")
}

func dims(kv ...string) []metrics.Dim {
	var out []metrics.Dim
	for i := 0; i+1 < len(kv); i += 2 {
		out = append(out, metrics.Dim{Key: kv[i], Value: kv[i+1]})
	}
	return out
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func itoa(p *int64) string {
	if p == nil {
		return ""
	}
	return strconv.FormatInt(*p, 10)
}

// span folds one closed duration into a metric by how it is known: a measured duration into the
// statistic; a bounded or unknown one counted apart, with its bounds (M6_5_DESIGN.md rule 3).
func (s *State) span(id string, d []metrics.Dim, dd string, start, end *Stamp) {
	du := between(start, end, false)
	if du.Basis == "measured" && du.MS != nil {
		s.Metrics.Duration(id, d, dd, *du.MS)
		return
	}
	s.Metrics.Basis(id, d, dd, du.Basis, du.MinMS, du.MaxMS)
}

// cdims are a metric's dimensions plus the ticket the member belongs to. The ticket's risk, app
// type and wave are not written into the cell: a read joins them from the projection at its
// cursor (TicketDims), so a ticket's figures do not split by when its classification became known
// and do not depend on the order events arrived in (M6.5 D8).
func (s *State) cdims(ticket string, kv ...string) []metrics.Dim {
	d := dims(kv...)
	for _, x := range d {
		if x.Key == "ticket" {
			return d
		}
	}
	return append(d, metrics.Dim{Key: "ticket", Value: ticket})
}

// TicketDims is a ticket's risk, app type and wave as the projection knows them now: what a
// metric read joins to the ticket-keyed cells.
func TicketDims(s *State, ticket string) map[string]string {
	c := s.Cells[ticket]
	if c == nil {
		return nil
	}
	return map[string]string{"risk": c.Risk, "app_type": c.AppType, "wave": s.waveOf(c)}
}

// MetricQuery evaluates metrics with the ticket dimensions joined from this state.
func (s *State) MetricQuery(q metrics.Query) []metrics.Row {
	q.Resolve = func(t string) map[string]string { return TicketDims(s, t) }
	return s.Metrics.Query(q)
}

// waveOf is a cell's wave, from the cell or its slice.
func (s *State) waveOf(c *Cell) string {
	if c.WaveID != "" {
		return c.WaveID
	}
	if sl := s.Slices[c.SliceID]; sl != nil {
		return sl.WaveID
	}
	return ""
}

// exK1NoResult: a claimed execution with no execution.completed (failed, running, or of unknown
// outcome) has no recorded cost.
const exK1NoResult = "no result recorded: the execution failed, is still running, or its outcome is unknown"

// exT1NoMerge: a ticket merged by its run record whose lifecycle log has no merge.
const exT1NoMerge = "no merge in the lifecycle log"

// streamOf names the source stream of a partition key, for refused records.
func streamOf(key string) string {
	switch {
	case strings.HasPrefix(key, "r:"):
		return "run"
	case strings.HasPrefix(key, "c:"):
		return "lifecycle"
	case strings.HasPrefix(key, "i:"):
		return "intake"
	case strings.HasPrefix(key, "x:"):
		return "record"
	case strings.HasPrefix(key, "s:"):
		return "stream"
	}
	return "observer"
}

func (s *State) cell(e *feed.Event, st *Stamp) *Cell {
	t := e.Ticket()
	if t == "" {
		return nil
	}
	c := s.Cells[t]
	if c == nil {
		c = &Cell{TicketID: t, FirstSeen: st}
		s.Cells[t] = c
	}
	s.touch(entCell, t)
	c.Updated = st
	if v := feed.Str(e.IDs.CellInstance); v != "" {
		c.CellInstance = v
	}
	if v := feed.Str(e.IDs.SliceID); v != "" {
		c.SliceID = v
	}
	if v := feed.Str(e.IDs.WaveID); v != "" {
		c.WaveID = v
	}
	if e.IDs.Revision != nil {
		c.Revision = e.IDs.Revision
	}
	if x := e.Execution(); x != "" && !contains(c.Executions, x) {
		c.Executions = append(c.Executions, x)
	}
	return c
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func (s *State) slice(e *feed.Event) *Slice {
	id := feed.Str(e.IDs.SliceID)
	if id == "" {
		return nil
	}
	sl := s.Slices[id]
	if sl == nil {
		sl = &Slice{SliceID: id, State: "unknown", Dependencies: []string{}, DependsOn: []string{}, Reasons: []string{}}
		s.Slices[id] = sl
	}
	s.touch(entSlice, id)
	if v := feed.Str(e.IDs.WaveID); v != "" {
		sl.WaveID = v
	}
	return sl
}

func (s *State) execution(e *feed.Event) *Execution {
	id := e.Execution()
	if id == "" {
		return nil
	}
	x := s.Executions[id]
	if x == nil {
		x = &Execution{ExecutionID: id, Workflows: map[string]*Workflow{}, Agents: map[string]*Agent{}, Queued: map[string]*Agent{},
			Tools: map[string]*Tool{}, RefusedTools: []string{}, Recovery: []string{}, Refused: []Refusal{}, Visits: []string{}}
		s.Executions[id] = x
	}
	s.touch(entExecution, id)
	if t := e.Ticket(); t != "" && x.TicketID == "" && e.Origin.Stream != "execution-stream" {
		x.TicketID = t // a stream event's ticket may be a workflow agent's own (from its label)
	}
	if v := feed.Str(e.IDs.SliceID); v != "" && x.SliceID == "" {
		x.SliceID = v
	}
	if v := feed.Str(e.IDs.RunnerID); v != "" {
		x.RunnerID = v
	}
	return x
}

// setSliceState records a scheduler state change.
func (sl *Slice) setState(state string, st *Stamp) {
	if sl.State == state {
		return
	}
	sl.State = state
	sl.History = append(sl.History, StateChange{State: state, EventID: st.EventID, Pos: st.Pos, At: st.At})
}

// recompute derives the scheduler state from the recorded facts (M3's five states).
func (sl *Slice) recompute(st *Stamp) {
	switch {
	case sl.Superseded != nil:
		sl.setState("superseded", st)
	case sl.Integrated != nil:
		sl.setState("completed", st)
	case sl.Scheduled != nil:
		sl.setState("active", st)
	case sl.Blocked != nil && (sl.Resolved == nil || sl.Resolved.Pos < sl.Blocked.Pos):
		sl.setState("blocked", st)
	case sl.Materialized != nil:
		sl.setState("ready", st)
	}
}

// openWait is the slice's dependency wait with no recorded end, if any (only the last can be).
func (sl *Slice) openWait() *DependencyWait {
	if n := len(sl.Waits); n > 0 && sl.Waits[n-1].open() {
		return sl.Waits[n-1]
	}
	return nil
}

// endSliceWait closes a slice's open dependency wait because the slice was replaced: no longer
// open for W1, and counted as left out (it never resolved).
func (s *State) endSliceWait(sl *Slice, st *Stamp) {
	if w := sl.openWait(); w != nil {
		if w.Blocked != nil {
			s.Metrics.OpenAdd("W1", day(w.Blocked), -1)
		}
		s.Metrics.Exclude("W1", s.cdims(sl.TicketID, "wave", sl.WaveID), day(st), "the wait ended because the slice was replaced, not resolved", 1)
	}
	sl.endWait(st)
}

// endWait closes an open dependency wait because the slice it belonged to was replaced.
func (sl *Slice) endWait(st *Stamp) {
	if w := sl.openWait(); w != nil {
		w.Superseded = st
	}
}

// closeLimits ends every recorded limit that still applies.
func (s *State) closeLimits(st *Stamp) {
	for i := range s.Factory.LimitHistory {
		if s.Factory.LimitHistory[i].To == nil {
			s.Factory.LimitHistory[i].To = st
		}
	}
}

// eligible is when the slice became ready: its dependencies resolved, or materialized with none.
func (sl *Slice) eligible() *Stamp {
	if sl.Resolved != nil {
		return sl.Resolved
	}
	if len(sl.Dependencies) == 0 {
		if sl.FirstMaterialized != nil {
			return sl.FirstMaterialized
		}
		return sl.Materialized
	}
	return nil
}

func (s *State) closeRequired(ticket, slice string, st *Stamp, by string) {
	for _, g := range s.Gates {
		if g.Kind == "required" && g.Closed == nil && ((ticket != "" && g.TicketID == ticket) || (slice != "" && g.SliceID == slice)) {
			g.Closed, g.ClosedBy = st, by
		}
	}
}

// ---- the intake log (v2 kinds) ----

func (s *State) applyIntake(e *feed.Event, st *Stamp) {
	m := s.Metrics
	switch e.Type {
	case "wave.discovered":
		id := feed.Str(e.IDs.WaveID)
		if id == "" {
			return
		}
		var d struct {
			Slices   []string `json:"slices"`
			Approval *struct {
				ApprovedAt *string `json:"approved_at"`
			} `json:"approval"`
		}
		e.DataAs(&d)
		w := s.Waves[id]
		if w == nil {
			w = &Wave{WaveID: id, FirstSeen: st}
			s.Waves[id] = w
		}
		s.touch(entWave, id)
		w.Revision = e.IDs.Revision
		if d.Slices != nil {
			w.Slices = d.Slices
		}
		if d.Approval != nil && d.Approval.ApprovedAt != nil {
			w.Approved, w.ApprovedAt = true, *d.Approval.ApprovedAt
		}
	case "intake.validated":
		s.Project.LastValidated = st
	case "intake.refused":
		s.Project.IntakeRefused++
	case "slice.materialized":
		sl := s.slice(e)
		if sl == nil {
			return
		}
		var d struct {
			Dependencies []string `json:"dependencies"`
		}
		e.DataAs(&d)
		if sl.Materialized != nil && !sameRev(sl.Revision, e.IDs.Revision) {
			sl.Revisions = append(sl.Revisions, SliceRevision{Revision: sl.Revision, TicketID: sl.TicketID, State: sl.State, At: sl.Materialized})
			s.endSliceWait(sl, st) // a new revision replaced the slice while it waited
			sl.Blocked, sl.Resolved, sl.Scheduled, sl.Integrated, sl.Superseded = nil, nil, nil, nil, nil
			sl.Reasons, sl.DependsOn, sl.Commit = []string{}, []string{}, ""
		}
		if sl.FirstMaterialized == nil || sl.Materialized == nil || !sameRev(sl.Revision, e.IDs.Revision) {
			sl.FirstMaterialized = st
		}
		sl.Revision, sl.Materialized = e.IDs.Revision, st
		sl.TicketID = e.Ticket()
		if d.Dependencies != nil {
			sl.Dependencies = d.Dependencies
		}
		sl.recompute(st)
		s.cell(e, st)
	case "slice.integrated":
		sl := s.slice(e)
		if sl == nil {
			return
		}
		var d struct {
			Commit string `json:"commit"`
		}
		e.DataAs(&d)
		sl.Integrated, sl.Commit = st, d.Commit
		sl.recompute(st)
		m.Count("T2", s.cdims(sl.TicketID, "wave", sl.WaveID), day(st), 1)
		s.span("C4", s.cdims(sl.TicketID, "wave", sl.WaveID), day(st), sl.eligible(), st)
		s.closeRequired(sl.TicketID, sl.SliceID, st, e.Type)
	case "dependency.resolved":
		sl := s.slice(e)
		if sl == nil {
			return
		}
		var d struct {
			DependsOn []string `json:"depends_on"`
		}
		e.DataAs(&d)
		if sl.Blocked != nil && (sl.Resolved == nil || sl.Resolved.Pos < sl.Blocked.Pos) {
			s.span("W1", s.cdims(sl.TicketID, "wave", sl.WaveID), day(st), sl.Blocked, st)
		}
		if w := sl.openWait(); w != nil {
			w.Resolved, w.DependsOn = st, nonNilS(d.DependsOn)
			if w.Blocked != nil {
				m.OpenAdd("W1", day(w.Blocked), -1)
			}
		}
		sl.Resolved = st
		if d.DependsOn != nil {
			sl.DependsOn = d.DependsOn
		}
		sl.Reasons = []string{}
		sl.recompute(st)
	case "dependency.blocked":
		sl := s.slice(e)
		if sl == nil {
			return
		}
		var d struct {
			Reasons []string `json:"reasons"`
		}
		e.DataAs(&d)
		open := sl.Blocked != nil && (sl.Resolved == nil || sl.Resolved.Pos < sl.Blocked.Pos)
		if !open {
			sl.Blocked = st
		}
		if d.Reasons != nil {
			sl.Reasons = d.Reasons
		}
		if w := sl.openWait(); w != nil {
			if d.Reasons != nil {
				w.Reasons = d.Reasons
			}
		} else {
			sl.Waits = append(sl.Waits, &DependencyWait{Revision: sl.Revision, Blocked: st, Reasons: nonNilS(d.Reasons)})
			m.OpenAdd("W1", day(st), 1)
			if len(sl.Waits) > maxWaitsPerSlice {
				sl.WaitsDropped += int64(len(sl.Waits) - maxWaitsPerSlice)
				sl.Waits = append([]*DependencyWait(nil), sl.Waits[len(sl.Waits)-maxWaitsPerSlice:]...)
			}
		}
		sl.recompute(st)
	case "work.scheduled":
		sl := s.slice(e)
		var d struct {
			Stage string `json:"stage"`
			Risk  string `json:"risk"`
		}
		e.DataAs(&d)
		if sl != nil {
			if sl.Scheduled == nil {
				t := sl.TicketID
				if t == "" {
					t = e.Ticket()
				}
				s.span("W2", s.cdims(t, "wave", sl.WaveID), day(st), sl.eligible(), st)
			}
			sl.Scheduled = st
			s.releaseSliceCapacity(sl.SliceID, st)
			if t := e.Ticket(); t != "" {
				sl.TicketID = t
			}
			sl.recompute(st)
		}
		if c := s.cell(e, st); c != nil {
			if d.Stage != "" && !c.Lifecycle {
				c.Stage, c.StageSource = d.Stage, e.Type
			}
			if d.Risk != "" {
				c.Risk = d.Risk
			}
		}
		s.closeRequired(e.Ticket(), "", st, e.Type)
	case "revision.superseded":
		if sl := s.slice(e); sl != nil {
			sl.Superseded = st
			s.endSliceWait(sl, st)
			sl.recompute(st)
		}
	case "human.required":
		var d struct {
			Reason string `json:"reason"`
		}
		e.DataAs(&d)
		key := "required:" + e.ID
		s.Gates[key] = &HumanGate{Key: key, Kind: "required", TicketID: e.Ticket(), SliceID: feed.Str(e.IDs.SliceID), Reason: d.Reason, Opened: st}
		m.Count("S4", s.cdims(e.Ticket()), day(st), 1)
	case "factory.activated":
		var d struct {
			Autonomy   string             `json:"autonomy"`
			Limits     map[string]float64 `json:"limits"`
			AllowMerge *bool              `json:"allow_merge"`
			Persistent *bool              `json:"persistent"`
		}
		e.DataAs(&d)
		s.Factory.State, s.Factory.Autonomy, s.Factory.Limits = orUnknown(d.Autonomy), d.Autonomy, d.Limits
		s.closeLimits(st)
		for _, name := range sortedKeys(d.Limits) {
			s.Factory.LimitHistory = append(s.Factory.LimitHistory, LimitSpan{Name: name, Value: d.Limits[name], From: st})
		}
		if n := len(s.Factory.LimitHistory); n > maxLimitHistory {
			s.Factory.LimitHistory = append([]LimitSpan(nil), s.Factory.LimitHistory[n-maxLimitHistory:]...)
		}
		s.Factory.AllowMerge, s.Factory.Persistent, s.Factory.Since, s.Factory.PausedReason = d.AllowMerge, d.Persistent, st, ""
	case "factory.disabled":
		s.Factory.State, s.Factory.Since = "disabled", st
		// No scheduler decides while the Factory is off: nothing waits for one of its places.
		for _, id := range sortedKeys(s.Pending.SliceCapacity) {
			s.releaseSliceCapacity(id, st)
		}
		s.closeLimits(st)
	case "factory.paused":
		var d struct {
			Reason *string `json:"reason"`
		}
		e.DataAs(&d)
		s.Factory.State, s.Factory.Since, s.Factory.PausedReason = "paused", st, feed.Str(d.Reason)
	case "factory.resumed":
		s.Factory.State, s.Factory.Since, s.Factory.PausedReason = orUnknown(s.Factory.Autonomy), st, ""
	case "revision.discovered":
		var d struct {
			Commit string `json:"commit"`
		}
		e.DataAs(&d)
		s.Project.CommitSeen, s.Project.CommitAt = d.Commit, st
	case "scheduling.decided":
		var d struct {
			State      string   `json:"state"`
			Dispatched []string `json:"dispatched"`
			Started    []string `json:"started"`
			Held       []Held   `json:"held"`
		}
		e.DataAs(&d)
		s.sliceCapacity(st, s.Factory.LastDecision, nonNil(d.Held))
		s.Factory.SchedulerState, s.Factory.LastDecision = d.State, st
		s.Factory.Held, s.Factory.Dispatched, s.Factory.Started = nonNil(d.Held), nonNilS(d.Dispatched), nonNilS(d.Started)
	case "work.claimed":
		x := s.execution(e)
		if x == nil {
			return
		}
		var d struct {
			Stage   string `json:"stage"`
			Next    string `json:"next"`
			Attempt *int64 `json:"attempt"`
		}
		e.DataAs(&d)
		first := x.Claimed == nil
		if x.Claimed == nil && x.ProcessStarted == nil {
			m.OpenAdd("W4", day(st), 1)
		}
		x.Claimed, x.StageAtStart, x.Next = st, d.Stage, d.Next
		x.Attempt = firstNonNil(d.Attempt, e.IDs.Attempt)
		s.cell(e, st)
		m.Rate("X1", s.cdims(e.Ticket(), "stage", d.Stage, "ticket", e.Ticket()), day(st), 0, 1)
		if first {
			m.Exclude("K1", s.cdims(x.TicketID, "stage", d.Stage, "ticket", x.TicketID), day(st), exK1NoResult, 1)
		}
		m.Rate("S1", s.cdims(e.Ticket()), day(st), 0, 1)
		m.Rate("S2", s.cdims(e.Ticket()), day(st), 0, 1)
		s.closeRequired(e.Ticket(), "", st, e.Type)
	case "execution.started":
		x := s.execution(e)
		if x == nil {
			return
		}
		var d struct {
			Until            *string            `json:"until"`
			Workflow         string             `json:"workflow"`
			Limits           map[string]float64 `json:"limits"`
			Provenance       map[string]any     `json:"provenance"`        // revision 3
			ProvenanceReason *string            `json:"provenance_reason"` // revision 3
			SourceCommit     *string            `json:"source_commit"`     // revision 3
		}
		e.DataAs(&d)
		x.Started, x.Workflow, x.Until, x.Limits = st, d.Workflow, feed.Str(d.Until), d.Limits
		x.Provenance, x.ProvenanceReason, x.SourceCommit = d.Provenance, feed.Str(d.ProvenanceReason), feed.Str(d.SourceCommit)
		s.cell(e, st)
	case "station.observed":
		var d struct {
			Stage string `json:"stage"`
		}
		e.DataAs(&d)
		// A sample of cell.json: it sets the stage only where no lifecycle log speaks for the cell
		// (recorded gate results outrank sampled state).
		if c := s.cell(e, st); c != nil && !c.Lifecycle && d.Stage != "" {
			c.Stage, c.StageSource = d.Stage, e.Type
		}
	case "recovery.started":
		var d struct {
			Kind string `json:"kind"`
		}
		e.DataAs(&d)
		if x := s.execution(e); x != nil {
			x.Recovery = append(x.Recovery, d.Kind)
			if d.Kind == "outcome-unknown" && x.UnknownAt == nil {
				x.UnknownAt = st
			}
		}
		s.Recoveries = append(s.Recoveries, Recovery{Kind: d.Kind, ExecutionID: e.Execution(), TicketID: e.Ticket(), At: st})
		if n := len(s.Recoveries); n > maxRecoveries {
			s.RecoveriesDropped += int64(n - maxRecoveries)
			s.Recoveries = append([]Recovery(nil), s.Recoveries[n-maxRecoveries:]...)
		}
		m.Rate("S1", s.cdims(e.Ticket(), "kind", d.Kind), day(st), 1, 0)
		// S2 counts executions, not recovery events: syncExecutions.
	case "execution.completed":
		x := s.execution(e)
		if x == nil {
			return
		}
		var d struct {
			Stage        string   `json:"stage"`
			Next         string   `json:"next"`
			WaitingFor   *string  `json:"waiting_for"`
			How          *string  `json:"how"`
			CostUSD      *float64 `json:"cost_usd"`
			RefusedTools []string `json:"refused_tools"`
		}
		e.DataAs(&d)
		first := x.Completed == nil
		x.Completed, x.StageAtEnd, x.Next, x.WaitingFor, x.How = st, d.Stage, d.Next, feed.Str(d.WaitingFor), feed.Str(d.How)
		x.CostUSD, x.RefusedTools, x.RefusedFinal = d.CostUSD, nonNilS(d.RefusedTools), true
		kd := s.cdims(x.TicketID, "stage", x.StageAtStart, "ticket", x.TicketID)
		if first && x.Claimed != nil {
			// Every claimed execution is in K1's population from its claim; a result now moves it.
			m.Exclude("K1", kd, day(x.Claimed), exK1NoResult, -1)
		}
		if d.CostUSD == nil {
			m.Exclude("K1", kd, day(st), "completed with no recorded cost", 1)
		}
		if d.CostUSD != nil {
			m.Rate("K1", kd, day(st), *d.CostUSD, 1)
			if x.TicketID != "" {
				// The denominator is the distinct tickets among the cells read (Def.Distinct).
				m.Rate("K4", s.cdims(x.TicketID, "ticket", x.TicketID), day(st), *d.CostUSD, 1)
			} else {
				m.Exclude("K4", nil, day(st), "a recorded cost with no ticket", 1)
			}
		}
		m.Rate("S3", s.cdims(x.TicketID, "stage", x.StageAtStart), day(st), 1, 1)
		if x.ProcessEnded != nil && first {
			s.span("W5", s.cdims(x.TicketID, "stage", x.StageAtStart), day(st), x.ProcessEnded, st)
		}
	case "execution.failed":
		x := s.execution(e)
		if x == nil {
			return
		}
		var d struct {
			Stage       string  `json:"stage"`
			Next        string  `json:"next"`
			How         *string `json:"how"`
			ClaudeError *string `json:"claude_error"`
			ExitCode    *int64  `json:"exit_code"`
			Attempt     *int64  `json:"attempt"`
		}
		e.DataAs(&d)
		x.Failed, x.StageAtEnd, x.Next, x.How, x.ClaudeError = st, d.Stage, d.Next, feed.Str(d.How), feed.Str(d.ClaudeError)
		if d.ExitCode != nil {
			x.ExitCode = d.ExitCode
		}
		if d.Attempt != nil {
			x.Attempt = d.Attempt
		}
		m.Rate("S3", s.cdims(x.TicketID, "stage", x.StageAtStart), day(st), 0, 1)
		m.Rate("X1", s.cdims(x.TicketID, "stage", x.StageAtStart, "ticket", x.TicketID), day(st), 1, 0)
	}
}

func sameRev(a, b *int64) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}

func nonNil(h []Held) []Held {
	if h == nil {
		return []Held{}
	}
	return h
}

func nonNilS(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func firstNonNil(a, b *int64) *int64 {
	if a != nil {
		return a
	}
	return b
}

// ---- cell lifecycle ----

func (c *Cell) visit(id string) *Visit {
	for i := len(c.Visits) - 1; i >= 0; i-- {
		if c.Visits[i].VisitID == id {
			return c.Visits[i]
		}
	}
	return nil
}

func (c *Cell) review(round *int64) *ReviewRound {
	for i := len(c.Reviews) - 1; i >= 0; i-- {
		if sameRev(c.Reviews[i].Round, round) {
			return c.Reviews[i]
		}
	}
	return nil
}

func (s *State) applyLifecycle(e *feed.Event, st *Stamp) {
	c := s.cell(e, st)
	if c == nil {
		return
	}
	m := s.Metrics
	if !c.Lifecycle {
		c.Lifecycle = true
	}
	visitID := feed.Str(e.IDs.VisitID)
	station := feed.Str(e.IDs.Station)
	round := e.IDs.Round
	if round != nil {
		c.Round = round
	}
	switch e.Type {
	case "station.entered":
		var d struct {
			Station string `json:"station"`
			Stage   string `json:"stage"`
			Action  string `json:"action"`
			Resumed bool   `json:"resumed"`
			Head    string `json:"head"`
		}
		e.DataAs(&d)
		if station == "" {
			station = d.Station
		}
		if v := c.visit(visitID); v != nil && visitID != "" {
			v.Restarts++ // the same visit entered again (a station restarted it)
		} else if len(c.Visits) < maxListPerCell {
			c.Visits = append(c.Visits, &Visit{VisitID: visitID, Station: station, Round: round, Entered: st, StageIn: d.Stage,
				Action: d.Action, Resumed: d.Resumed, Head: d.Head, ExecutionID: e.Execution()})
			m.Rate("C2", s.cdims(c.TicketID, "station", station, "ticket", c.TicketID), day(st), 1, 0)
			s.syncVisit(c, len(c.Visits)-1)
		} else {
			c.Dropped++
		}
		c.CurrentVisit = visitID
		if d.Stage != "" {
			c.Stage, c.StageSource = d.Stage, e.Type
		}
		if x := s.Executions[e.Execution()]; x != nil && visitID != "" && !contains(x.Visits, visitID) {
			s.touch(entExecution, e.Execution())
			x.Visits = append(x.Visits, visitID)
		}
	case "station.exited":
		var d struct {
			Station    string         `json:"station"`
			Outcome    string         `json:"outcome"`
			Stage      string         `json:"stage"`
			DurationMS *int64         `json:"duration_ms"`
			ClosedBy   string         `json:"closed_by"`
			Head       string         `json:"head"`
			AppType    *string        `json:"app_type"`
			Risk       *string        `json:"risk"`
			Counts     map[string]any `json:"counts"`
		}
		e.DataAs(&d)
		if station == "" {
			station = d.Station
		}
		// The facts the plan fixed (D11): recorded on the plan station's exit.
		if v := feed.Str(d.AppType); v != "" {
			c.AppType, c.AppTypeSource = v, e.ID
		}
		if v := feed.Str(d.Risk); v != "" {
			c.Risk = v
		}
		if station == "plan" {
			if n, ok := d.Counts["contracts"].(float64); ok {
				k := int64(n)
				c.Contracts = &k
			}
			if n, ok := d.Counts["tasks"].(float64); ok {
				k := int64(n)
				c.TasksPlanned = &k
			}
		}
		v := c.visit(visitID)
		if v == nil && len(c.Visits) < maxListPerCell {
			// The exit arrived without its entry (history began part-way): keep the exit. It is a
			// recorded visit (C2), of unknown length (C1).
			v = &Visit{VisitID: visitID, Station: station, Round: round}
			c.Visits = append(c.Visits, v)
			m.Rate("C2", s.cdims(c.TicketID, "station", station, "ticket", c.TicketID), day(st), 1, 0)
		}
		if v != nil {
			v.Exited, v.Outcome, v.StageOut, v.DurationMS, v.ClosedBy = st, d.Outcome, d.Stage, d.DurationMS, d.ClosedBy
			if d.Head != "" {
				v.Head = d.Head
			}
			for i := range c.Visits {
				if c.Visits[i] == v {
					s.syncVisit(c, i)
				}
			}
		}
		if c.CurrentVisit == visitID {
			c.CurrentVisit = ""
		}
		if d.Stage != "" {
			c.Stage, c.StageSource = d.Stage, e.Type
		}
	case "gate.evaluated":
		var d struct {
			Gate       string  `json:"gate"`
			Verdict    string  `json:"verdict"`
			ReasonCode *string `json:"reason_code"`
			Subject    *string `json:"subject"`
			Status     *string `json:"status"`
			AuditTier  *string `json:"audit_tier"`
		}
		e.DataAs(&d)
		if len(c.Gates) < maxGatesPerCell {
			c.Gates = append(c.Gates, &Gate{Gate: d.Gate, Verdict: d.Verdict, ReasonCode: feed.Str(d.ReasonCode), Subject: feed.Str(d.Subject),
				Status: feed.Str(d.Status), AuditTier: feed.Str(d.AuditTier), VisitID: visitID, Round: round, At: st})
		} else {
			c.GatesDropped++
		}
		m.Rate("X2", s.cdims(c.TicketID, "gate", d.Gate, "station", station, "reason_code", feed.Str(d.ReasonCode)), day(st), b2f(d.Verdict == "refused"), 1)
		if d.Verdict == "overridden" {
			// A numerator cell carries the gate; the denominator (build tasks) does not (Def.Split).
			m.Rate("X3", s.cdims(c.TicketID, "gate", d.Gate, "reason_code", feed.Str(d.ReasonCode)), day(st), 1, 0)
		}
		if d.Gate == "verify.verdict" && round != nil && *round == 1 {
			if d.Status != nil {
				m.Rate("Q1", s.cdims(c.TicketID), day(st), b2f(*d.Status == "PASS"), 1)
			} else {
				m.Exclude("Q1", s.cdims(c.TicketID), day(st), "a round-1 verification verdict with no status recorded", 1)
			}
		}
	case "build.task_completed":
		var d struct {
			TaskID   string  `json:"task_id"`
			Kind     string  `json:"kind"`
			Step     string  `json:"step"`
			FirstRun *string `json:"first_run"`
			Suite    *string `json:"suite"`
			Commit   *string `json:"commit"`
		}
		e.DataAs(&d)
		if len(c.Tasks) < maxListPerCell {
			c.Tasks = append(c.Tasks, &Task{TaskID: d.TaskID, Kind: d.Kind, Step: d.Step, FirstRun: feed.Str(d.FirstRun), Suite: feed.Str(d.Suite),
				Commit: feed.Str(d.Commit), VisitID: visitID, Round: round, At: st})
		} else {
			c.Dropped++
		}
		m.Rate("X3", s.cdims(c.TicketID), day(st), 0, 1)
	case "verify.check_recorded":
		var d struct {
			TargetID   string     `json:"target_id"`
			TargetKind string     `json:"target_kind"`
			Result     string     `json:"result"`
			Evidence   []Evidence `json:"evidence"`
			Rerecorded bool       `json:"rerecorded"`
		}
		e.DataAs(&d)
		if d.Evidence == nil {
			d.Evidence = []Evidence{}
		}
		if len(c.Checks) < maxListPerCell {
			c.Checks = append(c.Checks, &Check{TargetID: d.TargetID, TargetKind: d.TargetKind, Result: d.Result, Evidence: d.Evidence,
				Rerecorded: d.Rerecorded, VisitID: visitID, Round: round, At: st})
		} else {
			c.Dropped++
		}
		if d.Result == "fail" {
			m.Count("Q4", s.cdims(c.TicketID, "target_kind", d.TargetKind), day(st), 1)
		}
	case "review.round_started":
		var d struct {
			Risk                  string `json:"risk"`
			MaxRounds             *int64 `json:"max_rounds"`
			Tuning                bool   `json:"tuning"`
			ApprovalsNeeded       *int64 `json:"approvals_needed"`
			HumanApprovalRequired bool   `json:"human_approval_required"`
			Panel                 []Seat `json:"panel"`
			Delta                 bool   `json:"delta"`
		}
		e.DataAs(&d)
		r := c.review(round)
		if r == nil {
			if len(c.Reviews) >= maxListPerCell {
				c.Dropped++
				return
			}
			r = &ReviewRound{Round: round, Verdicts: []Verdict{}}
			c.Reviews = append(c.Reviews, r)
		} else {
			r.Restarted++
		}
		r.VisitID, r.Risk, r.MaxRounds, r.Tuning, r.ApprovalsNeeded = visitID, d.Risk, d.MaxRounds, d.Tuning, d.ApprovalsNeeded
		r.HumanApprovalRequired, r.Panel, r.Delta, r.Started = d.HumanApprovalRequired, d.Panel, d.Delta, st
		if r.Panel == nil {
			r.Panel = []Seat{}
		}
		if d.Risk != "" {
			c.Risk = d.Risk
		}
	case "review.verdict_submitted":
		var d struct {
			Seat     string   `json:"seat"`
			Vote     string   `json:"vote"`
			Blockers int64    `json:"blockers"`
			Notes    int64    `json:"notes"`
			Rules    []string `json:"rules"`
			Model    *string  `json:"model"`
		}
		e.DataAs(&d)
		r := c.review(round)
		if r == nil {
			r = &ReviewRound{Round: round, Verdicts: []Verdict{}, Panel: []Seat{}}
			c.Reviews = append(c.Reviews, r)
		}
		r.Verdicts = append(r.Verdicts, Verdict{Seat: d.Seat, Vote: d.Vote, Blockers: d.Blockers, Notes: d.Notes, Rules: nonNilS(d.Rules), Model: feed.Str(d.Model), At: st})
	case "review.decided":
		var d struct {
			Outcome      string            `json:"outcome"`
			Approvals    *int64            `json:"approvals"`
			Votes        map[string]string `json:"votes"`
			Blockers     *int64            `json:"blockers"`
			SecurityVeto bool              `json:"security_veto"`
		}
		e.DataAs(&d)
		r := c.review(round)
		if r == nil {
			r = &ReviewRound{Round: round, Verdicts: []Verdict{}, Panel: []Seat{}}
			c.Reviews = append(c.Reviews, r)
		}
		r.Outcome, r.Approvals, r.Votes, r.Blockers, r.SecurityVeto, r.Decided = d.Outcome, d.Approvals, d.Votes, d.Blockers, d.SecurityVeto, st
		m.Rate("R1", s.cdims(c.TicketID, "round", itoa(round)), day(st), b2f(d.Outcome == "REJECTED" || d.Outcome == "ESCALATE"), 1)
		hasSecurity := false
		for _, seat := range r.Panel {
			hasSecurity = hasSecurity || seat.Seat == "security"
		}
		if _, ok := d.Votes["security"]; ok {
			hasSecurity = true
		}
		if hasSecurity {
			m.Rate("R3", s.cdims(c.TicketID), day(st), b2f(d.SecurityVeto), 1)
		}
		if d.Outcome == "AWAITING_HUMAN" {
			key := "approval:" + c.TicketID + "#" + itoa(round)
			if g := s.Gates[key]; g == nil || g.Closed != nil {
				s.Gates[key] = &HumanGate{Key: key, Kind: "approval", TicketID: c.TicketID, SliceID: c.SliceID, Round: round, Opened: st}
				m.OpenAdd("W3", day(st), 1)
			}
		}
	case "human.approval_recorded":
		var d struct {
			ByRole    string `json:"by_role"`
			NoteGiven bool   `json:"note_given"`
		}
		e.DataAs(&d)
		c.Approvals = append(c.Approvals, &Approval{Round: round, ByRole: orDefault(d.ByRole, "person"), NoteGiven: d.NoteGiven, At: st})
		for _, g := range s.Gates {
			if g.Kind == "approval" && g.Closed == nil && g.TicketID == c.TicketID && (round == nil || sameRev(g.Round, round)) {
				g.Closed, g.ClosedBy = st, e.Type
				if g.Opened != nil {
					m.OpenAdd("W3", day(g.Opened), -1)
				}
				s.span("W3", s.cdims(c.TicketID), day(st), g.Opened, st)
			}
		}
	case "merge.completed":
		var d struct {
			Method         string  `json:"method"`
			MergeCommit    *string `json:"merge_commit"`
			ApprovedCommit *string `json:"approved_commit"`
			LandedCommit   *string `json:"landed_commit"`
			Revalidated    bool    `json:"revalidated"`
			PullRequest    *int64  `json:"pull_request"`
		}
		e.DataAs(&d)
		c.Merge = &Merge{Method: d.Method, MergeCommit: feed.Str(d.MergeCommit), ApprovedCommit: feed.Str(d.ApprovedCommit),
			LandedCommit: feed.Str(d.LandedCommit), Revalidated: d.Revalidated, PullRequest: d.PullRequest, At: st}
		writer := "hand-driven"
		if len(c.Executions) > 0 || e.Execution() != "" {
			writer = "supervisor"
		}
		m.Count("T1", s.cdims(c.TicketID, "writer", writer), day(st), 1)
		if c.MT1Day != "" {
			m.Exclude("T1", s.cdims(c.TicketID), dayKey(c.MT1Day), exT1NoMerge, -1)
			c.MT1Day = ""
		}
		if sl := s.Slices[c.SliceID]; sl != nil && sl.Scheduled != nil && sl.TicketID == c.TicketID {
			s.span("C3", s.cdims(c.TicketID), day(st), sl.Scheduled, st)
		}
	case "cleanup.completed":
		var d struct {
			Outcome string  `json:"outcome"`
			Archive *string `json:"archive"`
			Bundle  bool    `json:"bundle"`
		}
		e.DataAs(&d)
		c.Cleanup = &Cleanup{Outcome: d.Outcome, Archive: feed.Str(d.Archive), Bundle: d.Bundle, At: st}
		c.Archived = true
	}
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

// ---- execution records and run records ----

func (s *State) applyRecord(e *feed.Event, st *Stamp) {
	x := s.execution(e)
	if x == nil {
		return
	}
	switch e.Type {
	case "execution.process_started":
		if x.ProcessStarted == nil {
			if x.Claimed != nil {
				s.Metrics.OpenAdd("W4", day(x.Claimed), -1)
			}
			s.span("W4", s.cdims(x.TicketID, "stage", x.StageAtStart), day(st), x.Claimed, st)
		}
		x.ProcessStarted = st
	case "execution.process_ended":
		var d struct {
			Ended    string `json:"ended"`
			ExitCode *int64 `json:"exit_code"`
			Seconds  *int64 `json:"seconds"`
		}
		e.DataAs(&d)
		first := x.ProcessEnded == nil
		x.ProcessEnded, x.Ended, x.ExitCode, x.Seconds = st, d.Ended, d.ExitCode, d.Seconds
		if x.Completed != nil && first {
			s.span("W5", s.cdims(x.TicketID, "stage", x.StageAtStart), day(st), st, x.Completed)
		}
	}
}

func (s *State) applyRun(e *feed.Event, st *Stamp) {
	if e.Type != "run.recorded" {
		return
	}
	var d struct {
		RecordVersion          *int64   `json:"record_version"`
		Outcome                string   `json:"outcome"`
		Rounds                 *float64 `json:"rounds"`
		FirstPass              bool     `json:"first_pass"`
		VerifyFailures         int64    `json:"verify_failures"`
		ReviewRejections       int64    `json:"review_rejections"`
		Escalated              bool     `json:"escalated"`
		HumanApproval          bool     `json:"human_approval"`
		Deviations             int64    `json:"deviations"`
		Blockers               int64    `json:"blockers"`
		TestsSeenFailingFirst  float64  `json:"tests_seen_failing_first"`
		TestsPassingOnFirstRun float64  `json:"tests_passing_on_first_run"`
		Risk                   string   `json:"risk"`
		AppType                string   `json:"app_type"`
		MergeMethod            string   `json:"merge_method"`
		MergeCommit            string   `json:"merge_commit"`
	}
	e.DataAs(&d)
	// The normaliser fills a missing or unknown outcome with "merged" and lists it as unknown; the
	// observe station counts such a run as neither merged nor abandoned, and so does the observer.
	if contains(e.Unknown, "data.outcome") {
		d.Outcome = "unknown"
	}
	r := &RunRecord{TicketID: e.Ticket(), SliceID: feed.Str(e.IDs.SliceID), RecordVersion: d.RecordVersion, Outcome: d.Outcome, Rounds: d.Rounds,
		FirstPass: d.FirstPass, VerifyFailures: d.VerifyFailures, ReviewRejections: d.ReviewRejections, Escalated: d.Escalated,
		HumanApproval: d.HumanApproval, Deviations: d.Deviations, Blockers: d.Blockers, TestsSeenFailingFirst: d.TestsSeenFailingFirst,
		TestsPassingOnFirstRun: d.TestsPassingOnFirstRun, Risk: d.Risk, AppType: d.AppType, MergeMethod: d.MergeMethod, MergeCommit: d.MergeCommit,
		ClosedAt: st, EventID: e.ID}
	s.Runs = append(s.Runs, r)
	if c := s.cell(e, st); c != nil {
		c.Archived = true
		if d.AppType != "" {
			c.AppType = d.AppType
		}
		if d.Risk != "" && c.Risk == "" {
			c.Risk = d.Risk
		}
	}
	// The observe station's scorecard, record by record (observe.py scorecard).
	s.Metrics.FoldRun(RunFactsOf(r), day(st))
	// T1 counts merges written in lifecycle logs; a ticket the run record says merged with no merge
	// in its log is disclosed in T1's coverage, never added to the count.
	if c := s.Cells[r.TicketID]; c != nil && d.Outcome == "merged" && c.Merge == nil && c.MT1Day == "" {
		c.MT1Day = orDefault(day(st), "-")
		s.Metrics.Exclude("T1", s.cdims(c.TicketID), dayKey(c.MT1Day), exT1NoMerge, 1)
	}
}

// ---- the execution stream ----

func refOf(e *feed.Event, kind string) string {
	if e.Parent != nil && strings.HasPrefix(*e.Parent, kind+":") {
		return *e.Parent
	}
	for _, r := range e.Entities {
		if strings.HasPrefix(r, kind+":") {
			return r
		}
	}
	return ""
}

func (x *Execution) agent(e *feed.Event) *Agent {
	id := feed.Str(e.IDs.AgentID)
	if id == "" {
		return nil
	}
	a := x.Agents[id]
	if a == nil {
		if len(x.Agents) >= maxAgentsPerExec {
			return nil
		}
		a = &Agent{AgentID: id, Status: "running"}
		x.Agents[id] = a
	}
	return a
}

func (s *State) applyStream(e *feed.Event, st *Stamp) {
	x := s.execution(e)
	if x == nil {
		return
	}
	m := s.Metrics
	switch e.Type {
	case "session.initialized":
		var d struct {
			Version        *string `json:"claude_code_version"`
			Model          *string `json:"model"`
			PermissionMode *string `json:"permission_mode"`
		}
		e.DataAs(&d)
		if x.Session == nil {
			x.Session = &Session{ClaudeCodeVersion: feed.Str(d.Version), Model: feed.Str(d.Model), PermissionMode: feed.Str(d.PermissionMode)}
			s.Stream.Sessions++
		}
		if v := feed.Str(d.Version); v != "" {
			s.Stream.ClaudeCodeVersion = v
		}
	case "workflow.started":
		ref := orDefault(refOf(e, "workflow"), e.ID)
		var d struct {
			Workflow string   `json:"workflow"`
			Tickets  []string `json:"tickets"`
		}
		e.DataAs(&d)
		w := x.Workflows[ref]
		if w == nil {
			w = &Workflow{Ref: ref, Phases: []Phase{}}
			x.Workflows[ref] = w
		}
		w.Workflow, w.Tickets, w.Started = d.Workflow, nonNilS(d.Tickets), st
	case "workflow.phases_declared":
		ref := refOf(e, "workflow")
		var d struct {
			Phases []Phase `json:"phases"`
		}
		e.DataAs(&d)
		if w := x.Workflows[ref]; w != nil && d.Phases != nil {
			w.Phases = d.Phases
		}
	case "workflow.finished":
		ref := orDefault(refOf(e, "workflow"), e.ID)
		var d struct {
			Status       string  `json:"status"`
			TotalTokens  *int64  `json:"total_tokens"`
			ToolUses     *int64  `json:"tool_uses"`
			DurationMS   *int64  `json:"duration_ms"`
			StopReason   *string `json:"stop_reason"`
			WorkflowJSON bool    `json:"workflow_json"`
		}
		e.DataAs(&d)
		w := x.Workflows[ref]
		if w == nil {
			w = &Workflow{Ref: ref, Phases: []Phase{}, Tickets: []string{}}
			x.Workflows[ref] = w
		}
		w.Finished, w.Status, w.TotalTokens, w.ToolUses, w.DurationMS = st, orDefault(d.Status, "unknown"), d.TotalTokens, d.ToolUses, d.DurationMS
		w.StopReason, w.WorkflowJSON = feed.Str(d.StopReason), d.WorkflowJSON
		m.Rate("S6", s.cdims(x.TicketID, "stop_reason", w.StopReason), day(st), b2f(w.Status == "killed"), 1)
	case "agent.queued":
		var d struct {
			Index      *int64  `json:"index"`
			Label      string  `json:"label"`
			Phase      *string `json:"phase"`
			PhaseIndex *int64  `json:"phase_index"`
			Model      *string `json:"model"`
		}
		e.DataAs(&d)
		key := refOf(e, "workflow") + "#" + itoa(d.Index)
		if len(x.Queued) < maxAgentsPerExec {
			if x.Queued[key] == nil {
				m.OpenAdd("K9", day(st), 1)
			}
			x.Queued[key] = &Agent{Workflow: refOf(e, "workflow"), Index: d.Index, Label: d.Label, Phase: feed.Str(d.Phase), PhaseIndex: d.PhaseIndex,
				Model: feed.Str(d.Model), Queued: st, Status: "queued"}
		}
	case "agent.started":
		var d struct {
			Index      *int64  `json:"index"`
			Label      string  `json:"label"`
			Phase      *string `json:"phase"`
			PhaseIndex *int64  `json:"phase_index"`
			AgentType  *string `json:"agent_type"`
			Model      *string `json:"model"`
			AgentTry   *int64  `json:"agent_try"`
		}
		e.DataAs(&d)
		a := x.agent(e)
		if a == nil {
			return
		}
		wf := refOf(e, "workflow")
		key := wf + "#" + itoa(d.Index)
		queued := false
		if q := x.Queued[key]; q != nil {
			a.Queued = q.Queued
			delete(x.Queued, key)
			queued = true
			if q.Queued != nil {
				m.OpenAdd("K9", day(q.Queued), -1)
			}
		}
		if a.Started == nil {
			m.OpenAdd("K8", day(st), 1)
		}
		a.Workflow, a.Index, a.Label, a.Phase, a.PhaseIndex = wf, d.Index, d.Label, feed.Str(d.Phase), d.PhaseIndex
		a.AgentType, a.Model, a.AgentTry, a.Started, a.Status = feed.Str(d.AgentType), feed.Str(d.Model), d.AgentTry, st, "running"
		a.TicketID, a.Station, a.Seat = e.Ticket(), feed.Str(e.IDs.Station), feed.Str(e.IDs.Seat)
		if len(e.Inferred) > 0 {
			a.Inferred = e.Inferred
		}
		if queued {
			s.span("K9", s.cdims(x.TicketID, "phase", a.Phase), day(st), a.Queued, st)
		}
	case "agent.progressed":
		var d struct {
			ToolCalls *int64  `json:"tool_calls"`
			Tokens    *int64  `json:"tokens"`
			LastTool  *string `json:"last_tool"`
		}
		e.DataAs(&d)
		if a := x.agent(e); a != nil {
			a.Progressed = st
			if d.ToolCalls != nil {
				a.ToolCalls = d.ToolCalls
			}
			if d.Tokens != nil {
				a.Tokens = d.Tokens
			}
			if d.LastTool != nil {
				a.LastTool = *d.LastTool
			}
		}
	case "agent.finished":
		var d struct {
			Status     string `json:"status"`
			DurationMS *int64 `json:"duration_ms"`
			Tokens     *int64 `json:"tokens"`
			ToolCalls  *int64 `json:"tool_calls"`
		}
		e.DataAs(&d)
		a := x.agent(e)
		if a == nil {
			return
		}
		first := a.Finished == nil
		if first && a.Started != nil {
			m.OpenAdd("K8", day(a.Started), -1)
		}
		a.Finished, a.Status, a.DurationMS = st, orDefault(d.Status, "unknown"), d.DurationMS
		if d.Tokens != nil {
			a.Tokens = d.Tokens
		}
		if d.ToolCalls != nil {
			a.ToolCalls = d.ToolCalls
		}
		if !first {
			return // an agent finished twice is counted once
		}
		t := orDefault(a.TicketID, x.TicketID)
		if a.Tokens != nil {
			m.Rate("K7", s.cdims(t, "station", a.Station, "seat", a.Seat, "model", a.Model, "phase", a.Phase), day(st), float64(*a.Tokens), 1)
		} else {
			m.Exclude("K7", s.cdims(t, "station", a.Station, "seat", a.Seat, "model", a.Model, "phase", a.Phase), day(st), "finished with no token total", 1)
		}
		kd := s.cdims(t, "station", a.Station, "seat", a.Seat, "model", a.Model)
		if a.DurationMS != nil {
			m.Duration("K8", kd, day(st), *a.DurationMS)
		} else {
			m.Basis("K8", kd, day(st), "unknown", nil, nil)
		}
		if a.ToolCalls != nil {
			m.Rate("K10", s.cdims(t, "station", a.Station, "model", a.Model), day(st), float64(*a.ToolCalls), 1)
		} else {
			m.Exclude("K10", s.cdims(t, "station", a.Station, "model", a.Model), day(st), "finished with no tool-call count", 1)
		}
	case "tool.called":
		id := feed.Str(e.IDs.ToolCallID)
		if id == "" {
			return
		}
		if len(x.Tools) >= maxToolsPerExec {
			x.ToolsDropped++
			return
		}
		var d struct {
			Tool        string  `json:"tool"`
			TargetClass string  `json:"target_class"`
			Script      *string `json:"script"`
			PathRel     *string `json:"path_rel"`
		}
		e.DataAs(&d)
		x.Tools[id] = &Tool{ToolCallID: id, AgentID: feed.Str(e.IDs.AgentID), Tool: d.Tool, TargetClass: d.TargetClass, Script: feed.Str(d.Script),
			PathRel: feed.Str(d.PathRel), Called: st, Status: "running"}
	case "tool.returned":
		var d struct {
			Status     string `json:"status"`
			DurationMS *int64 `json:"duration_ms"`
		}
		e.DataAs(&d)
		if t := x.Tools[feed.Str(e.IDs.ToolCallID)]; t != nil {
			t.Returned, t.Status, t.DurationMS = st, orDefault(d.Status, "unknown"), d.DurationMS
		}
	case "tool.refused":
		var d struct {
			Tool    string `json:"tool"`
			Summary string `json:"summary"`
		}
		e.DataAs(&d)
		agent := feed.Str(e.IDs.AgentID)
		if len(x.Refused) < maxRefusedPerExec {
			x.Refused = append(x.Refused, Refusal{Tool: d.Tool, Summary: d.Summary, AgentID: agent, At: st})
		}
		if a := x.Agents[agent]; a != nil {
			a.Refused++
		}
		m.Count("S5", s.cdims(x.TicketID, "tool", d.Tool), day(st), 1)
	case "execution.usage":
		var d struct {
			TotalCostUSD    *float64               `json:"total_cost_usd"`
			Subtype         *string                `json:"subtype"`
			IsError         *bool                  `json:"is_error"`
			TerminalReason  *string                `json:"terminal_reason"`
			BudgetExhausted bool                   `json:"budget_exhausted"`
			Models          map[string]*ModelUsage `json:"models"`
			CostComplete    *bool                  `json:"cost_complete"`
			Reasons         []string               `json:"cost_incomplete_reasons"`
		}
		e.DataAs(&d)
		if d.Models == nil {
			d.Models = map[string]*ModelUsage{}
		}
		x.Usage = &Usage{TotalCostUSD: d.TotalCostUSD, Subtype: feed.Str(d.Subtype), IsError: d.IsError, TerminalReason: feed.Str(d.TerminalReason),
			BudgetExhausted: d.BudgetExhausted, Models: d.Models, CostComplete: d.CostComplete, CostIncompleteReasons: d.Reasons, At: st}
		models := make([]string, 0, len(d.Models))
		for model := range d.Models {
			models = append(models, model)
		}
		sort.Strings(models) // a fixed order, so float sums are the same on every replay
		for _, model := range models {
			u := d.Models[model]
			if u == nil {
				continue
			}
			if u.CostUSD != nil {
				m.Rate("K2", s.cdims(x.TicketID, "model", model), day(st), *u.CostUSD, 1)
			} else {
				m.Exclude("K2", s.cdims(x.TicketID, "model", model), day(st), "the model's usage carries no cost", 1)
			}
			for _, k := range []struct {
				kind string
				n    *int64
			}{{"input", u.InputTokens}, {"output", u.OutputTokens}, {"cache_read", u.CacheReadTokens}, {"cache_creation", u.CacheCreationTokens}} {
				if k.n != nil {
					// Numerator cells carry the token kind; the denominator does not (Def.Split).
					m.Rate("K3", s.cdims(x.TicketID, "model", model, "token_kind", k.kind), day(st), float64(*k.n), 0)
				}
			}
			m.Rate("K3", s.cdims(x.TicketID, "model", model), day(st), 0, 1)
		}
	}
}

// ---- observer reconstructions ----

// applyClosing applies the observer's closing of an agent or main-loop tool call still open when
// its process ended (event contract 8: rule open-at-process-end, status unknown, bounded by the
// process end, reconstructed). It never replaces an end the stream recorded, never creates an
// agent or call the stream did not start, and records nothing else (no duration, no metric).
func (s *State) applyClosing(e *feed.Event, st *Stamp) {
	x := s.Executions[e.Execution()]
	if x == nil {
		return
	}
	switch e.Type {
	case "agent.finished":
		a := x.Agents[feed.Str(e.IDs.AgentID)]
		if a == nil || a.Finished != nil {
			return
		}
		var d struct {
			Tokens    *int64 `json:"tokens"`
			ToolCalls *int64 `json:"tool_calls"`
		}
		e.DataAs(&d)
		if a.Started != nil {
			s.Metrics.OpenAdd("K8", day(a.Started), -1)
		}
		// The agent ended no later than its process: a bounded duration, counted apart.
		s.span("K8", s.cdims(orDefault(a.TicketID, x.TicketID), "station", a.Station, "seat", a.Seat, "model", a.Model), day(st), a.Started, &Stamp{
			EventID: st.EventID, Pos: st.Pos, Precision: "bounded", NotAfter: st.At, OrderMS: st.OrderMS, Authority: st.Authority})
		a.Finished, a.Status, a.DurationMS = st, "unknown", nil
		if d.Tokens != nil {
			a.Tokens = d.Tokens
		}
		if d.ToolCalls != nil {
			a.ToolCalls = d.ToolCalls
		}
	case "tool.returned":
		t := x.Tools[feed.Str(e.IDs.ToolCallID)]
		if t == nil || t.Returned != nil {
			return
		}
		t.Returned, t.Status, t.DurationMS = st, "unknown", nil
	}
	s.touch(entExecution, x.ExecutionID)
}

func (s *State) applyObserver(e *feed.Event, st *Stamp) {
	m := s.Metrics
	switch e.Type {
	case "agent.finished", "tool.returned":
		s.applyClosing(e, st)
	case "history.gap":
		var d struct {
			SourceKey string `json:"source_key"`
			FromSeq   *int64 `json:"from_seq"`
			ToSeq     *int64 `json:"to_seq"`
			Reason    string `json:"reason"`
			Count     *int64 `json:"count"`
		}
		e.DataAs(&d)
		class, lost := feed.GapClass(d.Reason)
		switch d.Reason {
		case "conflict":
			m.MarkSuspect(day(st))
		case "unparsable-line":
			n := int64(1)
			if d.Count != nil && *d.Count > 0 {
				n = *d.Count
			}
			m.Refuse(streamOf(d.SourceKey), day(st), n)
		}
		s.GapCounts[d.Reason]++
		s.GapClasses[class]++
		s.Gaps = append(s.Gaps, Gap{SourceKey: d.SourceKey, FromSeq: d.FromSeq, ToSeq: d.ToSeq, Reason: d.Reason, Class: class, Lost: lost,
			Count: d.Count, EventID: e.ID, Pos: e.Pos, At: st})
		if len(s.Gaps) > maxGapsKept {
			s.Gaps = append([]Gap(nil), s.Gaps[len(s.Gaps)-maxGapsKept:]...)
		}
	case "history.began":
		var d struct {
			Reason   string `json:"reason"`
			Snapshot struct {
				Stage *string `json:"stage"`
			} `json:"snapshot"`
		}
		e.DataAs(&d)
		if c := s.cell(e, st); c != nil {
			c.Began = &Began{Reason: d.Reason, Stage: feed.Str(d.Snapshot.Stage), At: st}
			if c.Stage == "" && d.Snapshot.Stage != nil {
				c.Stage, c.StageSource = *d.Snapshot.Stage, e.Type
			}
		}
	case "verify.targets_listed":
		var d struct {
			Targets []Target `json:"targets"`
		}
		e.DataAs(&d)
		if c := s.cell(e, st); c != nil && d.Targets != nil {
			c.Targets = d.Targets
		}
	case "review.finding":
		var d struct {
			Seat     string  `json:"seat"`
			N        int64   `json:"n"`
			Severity string  `json:"severity"`
			Rule     *string `json:"rule"`
			FileRel  *string `json:"file_rel"`
			Title    string  `json:"title"`
		}
		e.DataAs(&d)
		if c := s.cell(e, st); c != nil && len(c.Findings) < maxListPerCell {
			c.Findings = append(c.Findings, Finding{Round: e.IDs.Round, Seat: d.Seat, N: d.N, Severity: d.Severity, Rule: feed.Str(d.Rule),
				FileRel: feed.Str(d.FileRel), Title: d.Title, Nature: "prose"})
		}
		if d.Severity == "blocker" {
			m.Count("R2", s.cdims(e.Ticket(), "rule", feed.Str(d.Rule), "seat", d.Seat), day(st), 1)
		}
	case "artifact.recorded":
		var d struct {
			Nature    string `json:"nature"`
			Integrity string `json:"integrity"`
		}
		e.DataAs(&d)
		if c := s.cell(e, st); c != nil {
			c.Artifacts.Recorded++
			if d.Nature == "evidence" {
				c.Artifacts.Evidence++
				switch d.Integrity {
				case "match":
					c.Artifacts.Verified++
				case "mismatch":
					c.Artifacts.Mismatch++
				case "missing":
					c.Artifacts.Missing++
				}
			}
		}
		if d.Nature == "evidence" {
			m.Rate("G3", s.cdims(e.Ticket()), day(st), b2f(d.Integrity == "match"), 1)
		}
	case "capacity.wait_changed":
		var d struct {
			State string `json:"state"`
		}
		e.DataAs(&d)
		t := e.Ticket()
		if t == "" {
			return
		}
		switch d.State {
		case "waiting":
			if s.Pending.Capacity[t] == nil {
				s.Pending.Capacity[t] = st
				m.OpenAdd("W2b", day(st), 1)
			}
		case "released":
			if open := s.Pending.Capacity[t]; open != nil {
				m.OpenAdd("W2b", day(open), -1)
				s.span("W2b", s.cdims(t), day(st), open, st)
				delete(s.Pending.Capacity, t)
				s.CapacityWaits = append(s.CapacityWaits, CapacityWait{TicketID: t, Opened: open, Released: st})
				if n := len(s.CapacityWaits); n > maxCapacityWaits {
					s.CapacityWaitsDropped += int64(n - maxCapacityWaits)
					s.CapacityWaits = append([]CapacityWait(nil), s.CapacityWaits[n-maxCapacityWaits:]...)
				}
			}
		}
	}
}
