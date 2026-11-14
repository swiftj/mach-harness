package project

import (
	"slices"

	"mach/observer/internal/feed"
)

// C1 counts each visit by the same classification the visit's span uses (spans.go visitEnd and
// between): measured, bounded or unknown from its recorded entry and exit; inferred when no
// record ends it but a later one bounds it (its execution ended, the station was entered again,
// or only cleanup closed it); open otherwise. A visit's class can change while it is open or
// inferred, so those visits are reclassified after every record of their ticket that can bound
// them (syncVisits); measured, bounded and unknown are final.

// visitClass is how C1 counts visit i now, the day it is counted on, and its duration.
func (s *State) visitClass(c *Cell, i int) (string, string, Duration) {
	v := c.Visits[i]
	if end, _, _ := visitEnd(s, c, i); end != nil {
		return "inferred", day(end), Duration{}
	}
	if v.Exited != nil {
		d := between(v.Entered, v.Exited, false)
		return d.Basis, day(v.Exited), d
	}
	return "open", day(v.Entered), Duration{}
}

// syncVisit brings C1 in line with visit i's class: the old count undone, the new one made.
func (s *State) syncVisit(c *Cell, i int) {
	v := c.Visits[i]
	switch v.MBasis {
	case "measured", "bounded", "unknown":
		return // final
	}
	basis, dd, du := s.visitClass(c, i)
	if basis == v.MBasis && dd == v.MDay {
		return
	}
	m := s.Metrics
	dims := s.cdims(c.TicketID, "station", v.Station, "round", itoa(v.Round))
	switch v.MBasis {
	case "open":
		m.OpenAdd("C1", v.MDay, -1)
	case "inferred":
		m.BasisAdd("C1", dims, v.MDay, "inferred", -1)
	}
	switch basis {
	case "open":
		m.OpenAdd("C1", dd, 1)
	case "inferred":
		m.BasisAdd("C1", dims, dd, "inferred", 1)
	case "measured":
		m.Duration("C1", dims, dd, *du.MS)
	default:
		m.Basis("C1", dims, dd, basis, du.MinMS, du.MaxMS)
	}
	v.MBasis, v.MDay = basis, dd
	s.touch(entCell, c.TicketID)
	open := basis == "open" || basis == "inferred"
	if k := slices.Index(c.MOpen, i); k >= 0 && !open {
		c.MOpen = slices.Delete(c.MOpen, k, k+1)
	} else if k < 0 && open {
		c.MOpen = append(c.MOpen, i)
	}
}

// syncVisits reclassifies the open and inferred visits of the ticket an intake, lifecycle or
// execution record is about: those records are what can bound a visit (its execution's end or
// outcome-unknown recovery, a later claim or parking of the ticket, the next entry of the station).
func (s *State) syncVisits(e *feed.Event) {
	switch e.Origin.Stream {
	case "intake-log", "cell-lifecycle", "execution-record":
	default:
		return
	}
	t := e.Ticket()
	if t == "" {
		if x := s.Executions[e.Execution()]; x != nil {
			t = x.TicketID
		}
	}
	c := s.Cells[t]
	if c == nil {
		return
	}
	s.syncExecutions(c, e)
	if len(c.MOpen) == 0 {
		return
	}
	for _, i := range slices.Clone(c.MOpen) {
		if i < len(c.Visits) {
			s.syncVisit(c, i)
		}
	}
}

// syncExecutions brings S2 in line with whether each of the ticket's executions is of unknown
// outcome now, by the state every view serves (ExecStateIn): counted once per execution, on the
// day it became so; uncounted if a later record says how it ended.
func (s *State) syncExecutions(c *Cell, e *feed.Event) {
	ids := c.Executions
	if x := e.Execution(); x != "" && !slices.Contains(ids, x) {
		ids = append(slices.Clone(ids), x)
	}
	for _, id := range ids {
		x := s.Executions[id]
		if x == nil {
			continue
		}
		unknown := ExecStateIn(s, x) == "unknown"
		if unknown == (x.MUnknownDay != "") {
			continue
		}
		dims := s.cdims(x.TicketID)
		if unknown {
			x.MUnknownDay = day(stampOf(e))
			if x.MUnknownDay == "" {
				x.MUnknownDay = "-"
			}
			s.Metrics.Rate("S2", dims, dayKey(x.MUnknownDay), 1, 0)
		} else {
			s.Metrics.Rate("S2", dims, dayKey(x.MUnknownDay), -1, 0)
			x.MUnknownDay = ""
		}
		s.touch(entExecution, id)
	}
}

// dayKey is a stored day, "-" standing for no day.
func dayKey(d string) string {
	if d == "-" {
		return ""
	}
	return d
}
