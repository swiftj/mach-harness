package server

import (
	"net/http"
	"strings"

	"mach/observer/internal/metrics"
	"mach/observer/internal/project"
)

// metricsParams are the parameters /analytics/metrics reads itself, beside the common ones.
var metricsParams = map[string]bool{"ids": true, "group_by": true, "bucket": true, "distribution": true}

// metrics: GET /api/v1/analytics/metrics (M6_5_DESIGN.md section 3.1). The catalog's metrics read
// from the projection's aggregate cells at a cursor (at) or the head: a window over UTC days, the
// last N runs (the observe station's population), filters, up to two group dimensions, trend
// buckets and the distribution. A read merges stored cells; it never rescans events. The fields
// served before M6.5 (ids and one group_by) keep their names.
func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	p, status, bad := s.parseAnalytics(r, metricsParams)
	if bad != nil {
		writeJSON(w, status, *bad)
		return
	}
	invalid := func(msg string) { writeJSON(w, http.StatusBadRequest, fail(KindInvalid, msg)) }
	q := r.URL.Query()
	var mq metrics.Query
	if v := q.Get("ids"); v != "" {
		seen := map[string]bool{}
		for _, id := range strings.Split(v, ",") {
			if _, known := metrics.Lookup(id); !known {
				invalid("unknown metric " + kindQuote(id) + ".")
				return
			}
			if !seen[id] {
				mq.IDs = append(mq.IDs, id)
			}
			seen[id] = true
		}
	}
	if v := q.Get("group_by"); v != "" {
		dims := metrics.GroupDims()
		for _, g := range strings.Split(v, ",") {
			if !dims[g] {
				invalid("group_by is not a known dimension (" + kindQuote(g) + ").")
				return
			}
			for _, x := range mq.GroupBy {
				if x == g {
					invalid("group_by names " + kindQuote(g) + " twice.")
					return
				}
			}
			mq.GroupBy = append(mq.GroupBy, g)
		}
		if len(mq.GroupBy) > 2 {
			invalid("group_by takes at most two dimensions.")
			return
		}
	}
	switch v := q.Get("bucket"); v {
	case "", "day", "week":
		mq.Bucket = v
	default:
		invalid("bucket must be day or week.")
		return
	}
	switch q.Get("distribution") {
	case "", "0":
	case "1":
		mq.Distribution = true
	default:
		invalid("distribution must be 1 or 0.")
		return
	}
	if from, to, ok := p.Days(); ok {
		mq.Windowed, mq.FromDay, mq.ToDay = true, from, to
	}
	if f := p.Filters(); len(f) > 0 {
		mq.Filters = f
	}
	if p.AsOfMS != nil {
		mq.AsOf = &metrics.AsOf{MS: *p.AsOfMS, EffectiveToMS: floorDay(*p.AsOfMS),
			Rule: "metrics are kept per UTC day: every figure here ends at the midnight at or before as_of_ms (effective_to_ms); open members cannot be cut there and are not counted"}
	}
	s.analyticsAt(w, p, func(st *project.State) (int, Envelope) {
		q := mq
		if p.LastRuns > 0 {
			runs := st
			if p.AsOfMS != nil {
				// The same cut as every day-celled figure of the reply: runs closed before the as_of day.
				runs = project.CutAt(st, floorDay(*p.AsOfMS)-1)
			}
			q.Runs, q.RunsSelected = project.LastRunsTable(runs, p.LastRuns)
			q.LastRuns = p.LastRuns
		}
		env := s.analyticsEnvelope(st, p)
		env["metrics"] = st.MetricQuery(q)
		env["definitions_version"] = metrics.DefinitionsVersion
		env["group_overflow"] = st.Metrics.Overflow
		env["partial"] = st.Partial
		env["suspect_days"] = st.Metrics.SuspectDays()
		env["rules"] = "recorded values only; an empty denominator is null with a reason; nothing is estimated or apportioned; " +
			"durations are averaged over measured spans only, the others counted apart; value is unrounded, value_rounded is observe.py's round(value, 3)"
		return http.StatusOK, ok(env)
	})
}
