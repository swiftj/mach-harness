package server

import (
	"net/http"

	"mach/observer/internal/insight"
	"mach/observer/internal/project"
)

// analyticsInsights: GET /api/v1/analytics/insights (M6_5_DESIGN.md sections 3.5 and 6). Improvement
// Opportunities: deterministic rules over the engine's figures at one cursor, with every rule that
// could not run listed in not_evaluated with its reason. Takes the common parameters only; a filter
// a rule cannot honour makes that rule not evaluated, never silently unfiltered.
func (s *Server) analyticsInsights(w http.ResponseWriter, r *http.Request) {
	p, status, bad := s.parseAnalytics(r, nil)
	if bad != nil {
		writeJSON(w, status, *bad)
		return
	}
	ix, status, bad := s.flowIndex(p)
	if bad != nil {
		writeJSON(w, status, *bad)
		return
	}
	// Metric cells are per UTC day, so with as_of_ms the window ends at the start of the as_of day
	// (EffectiveWindow); the flow index is cut exactly at as_of_ms. The envelope says so (as_of.exact).
	ip := insight.Params{LastRuns: p.LastRuns, Filters: p.Filters(), AsOfMS: p.AsOfMS}
	if from, to, ok := p.EffectiveWindow(); ok {
		if p.FromMS != nil || p.EmptyWindow() {
			ip.FromMS = &from
		}
		if p.ToMS != nil || p.AsOfMS != nil {
			ip.ToMS = &to
		}
	}
	// Metric cells at the index's position: the live head when it is there (a timeline's state
	// carries no metric cells), the index's own state when it was rebuilt at a cursor, else a state
	// rebuilt at that position.
	var in insight.Input
	got := false
	s.opts.Projector.View(func(st *project.State) {
		if st.Epoch == ix.Epoch && st.Pos == ix.Pos {
			in, got = insight.GatherMetrics(st, ip), true
		}
	})
	if !got {
		mst := ix.State()
		if mst.Metrics == nil || mst.Metrics.Cells == nil {
			var err error
			mst, _, err = s.opts.Projector.At(ix.Pos)
			if e := s.atError(err); e != nil {
				writeJSON(w, cursorStatus(e), Envelope{Error: e})
				return
			}
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, fail(KindInternal, "The figures at that cursor could not be built."))
				return
			}
		}
		in = insight.GatherMetrics(mst, ip)
	}
	insight.GatherFlow(ix, &in, ip)
	env := analyticsEnvelopeAt(s, ix.Epoch, ix.Pos, ix.State(), p)
	// Two-window rules need the earlier window inside the recorded history.
	if h, ok := env["history"].(map[string]any); ok {
		if v, ok := h["from_ms"].(int64); ok {
			in.HistoryFromMS = &v
		}
	}
	rep := insight.Evaluate(in)
	env["insights"], env["not_evaluated"], env["rules"], env["notice"] = rep.Findings, rep.NotEvaluated, insight.Rules, insight.Notice
	env["investigation_label"] = insight.InvestigationLabel
	writeJSON(w, http.StatusOK, ok(env))
}
