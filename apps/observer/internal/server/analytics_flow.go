package server

import (
	"net/http"

	"mach/observer/internal/project"
)

// flowRules are stated on every flow reply.
var flowRules = []string{
	"durations are kept apart by basis (measured, bounded, inferred, open, unknown); statistics are over measured durations only",
	"percentiles are exact (nearest rank) over the measured durations selected",
	"a visit, wait or transition belongs to the UTC day it began; a gate evaluation to the day it was recorded",
	"a transition counts recorded consecutive visits of one cell; it is not a ticket's trajectory",
	"a wait is placed before the station the ticket entered next; waits with no later visit are counted as next_station_unknown",
	"risk, app type and wave are the cell's recorded values at the cursor; unknown means none was recorded",
	"bottlenecks rank by total measured time, so volume counts; what was not measured is counted beside it",
	"as_of_ms: a record later than it does not exist yet (compared by order time); what was open then is open; a cell's risk is its latest review's by then, unknown when it was reviewed only later",
}

// flowIndex returns the flow index at p.At (the head's timeline when no cursor was asked), or the
// error reply.
func (s *Server) flowIndex(p analyticsParams) (*project.FlowIndex, int, *Envelope) {
	var (
		ix  *project.FlowIndex
		err error
	)
	switch {
	case p.At == 0:
		ix, err = s.opts.Projector.Flow()
	default:
		ix, err = s.opts.Projector.FlowAt(p.At)
	}
	if e := s.atError(err); e != nil {
		return nil, cursorStatus(e), &Envelope{Error: e}
	}
	if err != nil {
		env := fail(KindInternal, "The flow figures could not be built.")
		return nil, http.StatusInternalServerError, &env
	}
	if p.AsOfMS != nil {
		ix = ix.AsOf(*p.AsOfMS)
	}
	return ix, 0, nil
}

// analyticsFlow: GET /api/v1/analytics/flow (M6_5_DESIGN.md 3.2). Per station: visits, unique
// tickets, durations by basis, revise entries, gate refusals and overrides, the waits before it by
// kind, open visits; per transition: from, to, count, tickets; the bottleneck ranking.
func (s *Server) analyticsFlow(w http.ResponseWriter, r *http.Request) {
	p, status, bad := s.parseAnalytics(r, nil)
	if bad != nil {
		writeJSON(w, status, *bad)
		return
	}
	p.Exact = true // as_of_ms cuts records, spans and executions exactly
	if e := unsupported(p, "risk", "app_type", "wave", "station"); e != nil {
		writeJSON(w, http.StatusBadRequest, *e)
		return
	}
	ix, status, bad := s.flowIndex(p)
	if bad != nil {
		writeJSON(w, status, *bad)
		return
	}
	q := project.FlowQuery{Risk: p.Risk, AppType: p.AppType, Wave: p.Wave, Station: p.Station}
	q.From, q.To, q.Window = p.EffectiveWindow()
	rep := ix.Flow(q)
	env := analyticsEnvelopeAt(s, ix.Epoch, ix.Pos, ix.State(), p)
	env["stations"], env["transitions"], env["waits"], env["bottlenecks"], env["coverage"], env["unit"] = rep.Stations, rep.Transitions, rep.Waits,
		rep.Bottlenecks, rep.Coverage, rep.Unit
	env["wait_kinds"] = project.WaitKinds
	env["rules"] = flowRules
	writeJSON(w, http.StatusOK, ok(env))
}
