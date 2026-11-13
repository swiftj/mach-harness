package project

import (
	"sort"
	"strconv"
	"strings"

	"mach/observer/internal/feed"
)

// Marks are the instants (and intervals) of a history worth jumping to: failures, retries, gate
// decisions, review verdicts, waits for a person, recoveries, interruptions, history gaps, waves
// and merges. Like spans they are derived from the projection, never stored, and built once per
// projection position. Labels are plain sentences that name roles only, never a person.

// MarkKinds are the kinds of mark, in the order a menu lists them.
// retry is a revise visit (a judging round sent the work back); attempt is an execution of a cell
// after its first, by start order (the supervisor's recorded attempt number can repeat).
var MarkKinds = []string{"failure", "retry", "attempt", "gate", "review", "human", "recovery", "interruption", "gap", "wave", "merge"}

// Mark is one mark.
type Mark struct {
	ID        string  `json:"id"`
	MarkID    string  `json:"mark_id"` // the same as id, for clients that read mark_id
	Kind      string  `json:"kind"`
	AtMS      int64   `json:"at_ms"`
	At        string  `json:"at"`
	UntilMS   *int64  `json:"until_ms"`
	Until     *string `json:"until"`
	EventID   string  `json:"event_id"`
	Entity    *string `json:"entity"`
	Label     string  `json:"label"`
	Verdict   *string `json:"verdict"`
	Authority string  `json:"authority"`
}

// MarkFilter selects marks. FromMS/ToMS select marks overlapping the window; AfterMS (strictly
// after, ascending) and BeforeMS (strictly before, descending) give the nearest marks first.
type MarkFilter struct {
	Kinds                           map[string]bool
	FromMS, ToMS, AfterMS, BeforeMS *int64
	Offset                          int // marks of the order skipped before the page
}

type markSet struct {
	pos     uint64
	applied int64
	marks   []*Mark // ascending by (at_ms, id)
}

// stampMS is the time a mark is placed at: the recorded time, else the earliest bound, else the
// order time.
func stampMS(st *Stamp) int64 {
	if st.At != nil {
		return *st.At
	}
	if st.NotBefore != nil {
		return *st.NotBefore
	}
	return st.OrderMS
}

type markBuilder struct {
	out  []*Mark
	seen map[string]bool
}

func (b *markBuilder) add(kind string, at, until *Stamp, entity, label, verdict string) *Mark {
	if at == nil {
		return nil
	}
	id := kind + ":" + at.EventID
	if entity != "" {
		id += ":" + entity
	}
	if b.seen[id] {
		return nil
	}
	b.seen[id] = true
	m := &Mark{ID: id, MarkID: id, Kind: kind, AtMS: stampMS(at), EventID: at.EventID, Entity: strp(entity), Label: label, Verdict: strp(verdict),
		Authority: orDefault(at.Authority, "authoritative")}
	m.At = feed.FormatMS(m.AtMS)
	if until != nil {
		u := max(stampMS(until), m.AtMS)
		m.UntilMS, m.Until = &u, ptr(feed.FormatMS(u))
	}
	b.out = append(b.out, m)
	return m
}

// verdictWord normalises a recorded vote or decision for the mark's verdict.
func verdictWord(v string) string {
	switch strings.ToUpper(v) {
	case "APPROVE", "APPROVED":
		return "approved"
	case "REJECT", "REJECTED":
		return "rejected"
	case "ESCALATE", "ESCALATED":
		return "escalated"
	case "AWAITING_HUMAN":
		return "awaiting-human"
	}
	return strings.ToLower(v)
}

func allMarks(s *State) []*Mark {
	if c := s.markCache; c != nil && c.pos == s.Pos && c.applied == s.Applied {
		return c.marks
	}
	b := &markBuilder{seen: map[string]bool{}}
	for _, t := range sortedKeys(s.Cells) {
		cellMarks(b, s, s.Cells[t])
	}
	recovered := map[string]*Stamp{} // execution -> its outcome-unknown recovery
	for i := range s.Recoveries {
		r := &s.Recoveries[i]
		entity := ""
		switch {
		case r.ExecutionID != "":
			entity = "execution:" + r.ExecutionID
		case r.TicketID != "":
			entity = "cell:" + r.TicketID
		}
		b.add("recovery", r.At, nil, entity, "The supervisor started a recovery ("+orDefault(r.Kind, "kind not recorded")+").", r.Kind)
		if r.Kind == "outcome-unknown" && r.ExecutionID != "" && recovered[r.ExecutionID] == nil {
			recovered[r.ExecutionID] = r.At
		}
	}
	for _, id := range sortedKeys(s.Executions) {
		execMarks(b, s.Executions[id], recovered[id])
	}
	attemptMarks(b, s)
	for _, g := range s.Gaps {
		label := "History is missing here: " + strings.ReplaceAll(orDefault(g.Reason, "no reason recorded"), "-", " ") + "."
		if !g.Lost {
			label = "History arrived out of order or was repaired here (" + orDefault(g.Reason, "no reason recorded") + ")."
		}
		b.add("gap", g.At, nil, "", label, g.Class)
	}
	for _, id := range sortedKeys(s.Waves) {
		w := s.Waves[id]
		b.add("wave", w.FirstSeen, nil, "wave:"+id, "Delivery wave "+id+" was taken in.", "discovered")
		b.add("wave", waveDone(s, w), nil, "wave:"+id, "Every slice of delivery wave "+id+" was integrated or superseded.", "completed")
	}
	sort.Slice(b.out, func(i, j int) bool {
		if b.out[i].AtMS != b.out[j].AtMS {
			return b.out[i].AtMS < b.out[j].AtMS
		}
		return b.out[i].ID < b.out[j].ID
	})
	s.markCache = &markSet{pos: s.Pos, applied: s.Applied, marks: b.out}
	return b.out
}

func cellMarks(b *markBuilder, s *State, c *Cell) {
	t := c.TicketID
	for i, v := range c.Visits {
		if v.Action == "revise" {
			b.add("retry", v.Entered, v.Exited, "visit:"+v.VisitID, "The "+orDefault(v.Station, "build")+" station took the ticket up again to revise it.", "revise")
		}
		// A visit that ended without an exit record: where its span was closed (spans.go visitEnd).
		if bound, rule, why := visitEnd(s, c, i); bound != nil {
			station := orDefault(v.Station, "unnamed")
			label := "A visit to the " + station + " station ended without an exit record when its execution ended."
			switch rule {
			case "unclosed-visit":
				label = "A visit to the " + station + " station ended without an exit record when the station was entered again."
			case "execution-outcome-unknown":
				label = "A visit to the " + station + " station has no exit record; its execution's outcome is unknown."
			case "closed-by-cleanup":
				label = "A visit to the " + station + " station had no exit record until cleanup closed it."
			}
			if m := b.add("interruption", bound, nil, "visit:"+v.VisitID, label, why); m != nil {
				m.Authority = "reconstructed"
			}
		}
	}
	for _, g := range c.Gates {
		entity := "cell:" + t
		if g.VisitID != "" {
			entity = "visit:" + g.VisitID
		}
		label := "Gate " + orDefault(g.Gate, "(not named)") + " " + orDefault(g.Verdict, "was evaluated")
		if g.ReasonCode != "" {
			label += " (" + g.ReasonCode + ")"
		}
		b.add("gate", g.At, nil, entity, label+".", g.Verdict)
		if g.Gate == "verify.verdict" && g.Status != "" && g.Status != "PASS" {
			b.add("failure", g.At, nil, entity, "Verification ended "+g.Status+".", strings.ToLower(g.Status))
		}
	}
	for _, rv := range c.Reviews {
		gate := "gate:" + t + "/review#" + itoa(rv.Round)
		for _, vd := range rv.Verdicts {
			b.add("review", vd.At, nil, "seat:"+t+"/review#"+itoa(rv.Round)+"/"+vd.Seat,
				"The "+orDefault(vd.Seat, "unnamed")+" reviewer voted "+strings.ToLower(orDefault(vd.Vote, "without a recorded vote"))+".", verdictWord(vd.Vote))
		}
		if rv.Decided != nil {
			b.add("review", rv.Decided, nil, gate, "Review round "+orDefault(itoa(rv.Round), "?")+" decided "+orDefault(rv.Outcome, "without a recorded outcome")+".", verdictWord(rv.Outcome))
			if rv.Outcome == "REJECTED" || rv.Outcome == "ESCALATE" {
				b.add("failure", rv.Decided, nil, gate, "The review panel "+map[string]string{"REJECTED": "rejected the change", "ESCALATE": "escalated the ticket to a person"}[rv.Outcome]+".", verdictWord(rv.Outcome))
			}
		}
	}
	for _, a := range c.Approvals {
		b.add("human", a.At, nil, "cell:"+t, "A "+orDefault(a.ByRole, "person")+" recorded an approval.", "approved")
	}
	if c.Merge != nil {
		b.add("merge", c.Merge.At, nil, "cell:"+t, "The ticket's branch was merged.", "merged")
	}
	for _, k := range sortedKeys(s.Gates) {
		g := s.Gates[k]
		if g.TicketID != t {
			continue
		}
		label := "The review asked for a person's approval."
		if g.Kind == "required" {
			label = "The supervisor stopped for a person."
		}
		b.add("human", g.Opened, g.Closed, "gate:"+t+"/"+g.Key, label, "required")
	}
}

func execMarks(b *markBuilder, x *Execution, recovered *Stamp) {
	ref := "execution:" + x.ExecutionID
	state := ExecState(x)
	switch state {
	case "failed", "could-not-start":
		at := x.Failed
		if at == nil {
			at = x.ProcessEnded
		}
		b.add("failure", at, nil, ref, "An execution "+map[string]string{"failed": "failed", "could-not-start": "could not start"}[state]+".", state)
	case "interrupted", "timed-out":
		b.add("interruption", x.ProcessEnded, nil, ref, "An execution was "+strings.ReplaceAll(state, "-", " ")+".", state)
	case "unknown":
		at := recovered
		if at == nil {
			at = x.ProcessEnded
		}
		b.add("interruption", at, nil, ref, "An execution's outcome is unknown.", "unknown")
	}
}

// execStart is an execution's first stamp: its claim, else its start, else its process start.
func execStart(x *Execution) *Stamp {
	for _, st := range []*Stamp{x.Claimed, x.Started, x.ProcessStarted} {
		if st != nil {
			return st
		}
	}
	return nil
}

// attemptMarks marks every execution of a cell after its first, the cell's executions taken in
// start order (time, then position, then id).
func attemptMarks(b *markBuilder, s *State) {
	byTicket := map[string][]*Execution{}
	for _, id := range sortedKeys(s.Executions) {
		if x := s.Executions[id]; x.TicketID != "" && execStart(x) != nil {
			byTicket[x.TicketID] = append(byTicket[x.TicketID], x)
		}
	}
	for _, t := range sortedKeys(byTicket) {
		xs := byTicket[t]
		sort.SliceStable(xs, func(i, j int) bool {
			a, c := execStart(xs[i]), execStart(xs[j])
			if ma, mc := stampMS(a), stampMS(c); ma != mc {
				return ma < mc
			}
			if a.Pos != c.Pos {
				return a.Pos < c.Pos
			}
			return xs[i].ExecutionID < xs[j].ExecutionID
		})
		for n, x := range xs[1:] {
			label := "The supervisor ran ticket " + t + " again: run " + strconv.Itoa(n+2) + " of its executions"
			if x.Attempt != nil {
				label += " (supervisor attempt " + itoa(x.Attempt) + ")"
			}
			b.add("attempt", execStart(x), nil, "execution:"+x.ExecutionID, label+".", "attempt")
		}
	}
}

// Marks returns the marks matching f: in a window ascending, after a time ascending (nearest
// first), before a time descending (nearest first), in a stable order (time, then id). total is
// the number that matched; the page is the limit marks after the first offset of them.
func Marks(s *State, f MarkFilter, limit int) (out []*Mark, total int) {
	return marksOf(allMarks(s), f, limit)
}

func marksOf(all []*Mark, f MarkFilter, limit int) (out []*Mark, total int) {
	want := func(m *Mark) bool {
		if len(f.Kinds) > 0 && !f.Kinds[m.Kind] {
			return false
		}
		if f.ToMS != nil && m.AtMS > *f.ToMS {
			return false
		}
		if f.FromMS != nil {
			end := m.AtMS
			if m.UntilMS != nil {
				end = *m.UntilMS
			}
			if end < *f.FromMS {
				return false
			}
		}
		if f.AfterMS != nil && m.AtMS <= *f.AfterMS {
			return false
		}
		if f.BeforeMS != nil && m.AtMS >= *f.BeforeMS {
			return false
		}
		return true
	}
	out = []*Mark{}
	if f.BeforeMS != nil && f.AfterMS == nil {
		for i := len(all) - 1; i >= 0; i-- {
			if want(all[i]) {
				total++
				if total > f.Offset && len(out) < limit {
					out = append(out, all[i])
				}
			}
		}
		return out, total
	}
	start := 0
	if f.AfterMS != nil {
		a := *f.AfterMS
		start = sort.Search(len(all), func(i int) bool { return all[i].AtMS > a })
	}
	for _, m := range all[start:] {
		if f.ToMS != nil && m.AtMS > *f.ToMS {
			break
		}
		if want(m) {
			total++
			if total > f.Offset && len(out) < limit {
				out = append(out, m)
			}
		}
	}
	return out, total
}
