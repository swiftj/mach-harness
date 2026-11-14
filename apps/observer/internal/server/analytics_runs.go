package server

import (
	"net/http"
	"sort"

	"mach/observer/internal/project"
)

// analyticsRun is one run record (run.recorded, as before) with the ticket's wave and its
// executions' usage and provenance. Every field the listing served before is kept.
type analyticsRun struct {
	*project.RunRecord
	Wave       *string              `json:"wave"`
	Executions []analyticsExecution `json:"executions"`
}

// analyticsExecution is one execution's usage and provenance.
type analyticsExecution struct {
	ExecutionID string             `json:"execution_id"`
	TicketID    string             `json:"ticket_id,omitempty"`
	State       string             `json:"state"`
	Attempt     *int64             `json:"attempt"`
	StartedMS   *int64             `json:"started_ms"` // the claim, else the start: where it is placed in a window
	Risk        *string            `json:"risk"`
	AppType     *string            `json:"app_type"`
	Wave        *string            `json:"wave"`
	Usage       project.UsageFacts `json:"usage"`
	// Provenance is the snapshot the supervisor recorded when it started the execution (section 5),
	// passed through from /runs as recorded; null with provenance_recorded false and a reason
	// (not-recorded, capture-failed, not-understood) when there is none. Never inferred.
	Provenance         map[string]any `json:"provenance"`
	ProvenanceRecorded bool           `json:"provenance_recorded"`
	ProvenanceReason   string         `json:"provenance_reason,omitempty"`
	SourceCommit       *string        `json:"source_commit"`
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func execItem(st *project.State, x *project.Execution) analyticsExecution {
	rv := project.Run(st, x)
	e := analyticsExecution{ExecutionID: x.ExecutionID, TicketID: x.TicketID, State: rv.State, Attempt: x.Attempt, Usage: project.UsageOf(rv, x)}
	if ms, ok := project.ExecStartMS(x); ok {
		e.StartedMS = &ms
	}
	if c := st.Cells[x.TicketID]; c != nil {
		e.Risk, e.AppType, e.Wave = nilIfEmpty(c.Risk), nilIfEmpty(c.AppType), nilIfEmpty(c.WaveID)
	}
	e.Provenance, e.ProvenanceRecorded, e.ProvenanceReason, e.SourceCommit = rv.Provenance, rv.ProvenanceRecorded, rv.ProvenanceReason, rv.SourceCommit
	return e
}

// wantProvenance: the provenance filter is a config_id (equal configuration), or "not-recorded"
// for executions with no snapshot (whatever the reason). Read from the execution as recorded, as
// Run serves it (provenance_recorded is a snapshot being present).
func wantProvenance(filter string, x *project.Execution) bool {
	switch filter {
	case "":
		return true
	case "not-recorded":
		return x.Provenance == nil
	}
	id, _ := x.Provenance["config_id"].(string)
	return x.Provenance != nil && id == filter
}

func usesModel(x *project.Execution, model string) bool {
	if model == "" {
		return true
	}
	if x.Usage == nil {
		return false
	}
	_, ok := x.Usage.Models[model]
	return ok
}

// analyticsRuns: GET /api/v1/analytics/runs (M6_5_DESIGN.md 3.4). of=runs (the default): the run
// records, as before, with window (closed_at), filters (risk, app_type, outcome, wave) and
// last_runs (the last N by closed_at, the observe station's population), each with its ticket's
// executions. of=executions: the executions, placed by their claim, filtered by risk, app_type,
// wave and model (any model with recorded usage). Paged by limit and offset.
func (s *Server) analyticsRuns(w http.ResponseWriter, r *http.Request) {
	p, status, bad := s.parseAnalytics(r, map[string]bool{"limit": true, "offset": true, "of": true})
	if bad != nil {
		writeJSON(w, status, *bad)
		return
	}
	p.Exact = true // as_of_ms cuts records, spans and executions exactly
	limit, bad := pageLimit(r, DefaultPage)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	off, bad := offset(r)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	of := r.URL.Query().Get("of")
	switch of {
	case "", "runs":
		of = "runs"
		bad = unsupported(p, "risk", "app_type", "outcome", "wave", "last_runs", "provenance")
	case "executions":
		bad = unsupported(p, "risk", "app_type", "wave", "model", "provenance")
	default:
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "of must be runs or executions."))
		return
	}
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	reply := func(st *project.State) (int, Envelope) {
		env := s.analyticsEnvelope(st, p)
		excluded := map[string]int{}
		var items any
		var total int
		start := 0
		// Filters are decided on recorded fields; only the page's items are built.
		if of == "runs" {
			list, byTicket := runItems(st, p, excluded)
			total = len(list)
			start = min(off, total)
			page := []analyticsRun{}
			for _, rr := range list[start:min(start+limit, total)] {
				item := analyticsRun{RunRecord: rr.rec, Wave: nilIfEmpty(rr.wave), Executions: []analyticsExecution{}}
				for _, x := range byTicket[rr.rec.TicketID] {
					item.Executions = append(item.Executions, execItem(st, x))
				}
				page = append(page, item)
			}
			items = page
		} else {
			list := execItems(st, p, excluded)
			total = len(list)
			start = min(off, total)
			page := []analyticsExecution{}
			for _, x := range list[start:min(start+limit, total)] {
				page = append(page, execItem(st, x))
			}
			items = page
		}
		env["of"], env["items"], env["total"], env["offset"], env["more"] = of, items, total, start, start+limit < total
		ex := []map[string]any{}
		for _, k := range sortedKeys(excluded) {
			ex = append(ex, map[string]any{"reason": k, "count": excluded[k]})
		}
		env["excluded"] = ex
		env["rules"] = []string{
			"recorded cost only: nothing is estimated, apportioned or priced",
			"usage.complete is null when nothing was recorded; false when the record may be lower than what was spent",
			"provenance is null and provenance_recorded false (with provenance_reason) when no snapshot was recorded at the start; it is never inferred",
			"provenance=<config_id> keeps executions recorded with that configuration (of=runs: run records with at least one such execution, every execution listed); provenance=not-recorded keeps those without one",
		}
		return http.StatusOK, ok(env)
	}
	if p.AsOfMS == nil {
		s.analyticsAt(w, p, reply)
		return
	}
	// As of a time: the projection cut at it (the flow index's private copy), outside the lock.
	ix, status, bad := s.flowIndex(p)
	if bad != nil {
		writeJSON(w, status, *bad)
		return
	}
	status, env := reply(ix.State())
	data, enc := encode(env)
	if enc != 0 {
		status = enc
	}
	writeBytes(w, status, data)
}

type runRow struct {
	rec  *project.RunRecord
	wave string
}

func runItems(st *project.State, p analyticsParams, excluded map[string]int) ([]runRow, map[string][]*project.Execution) {
	byTicket := map[string][]*project.Execution{}
	for _, id := range sortedKeys(st.Executions) {
		x := st.Executions[id]
		byTicket[x.TicketID] = append(byTicket[x.TicketID], x)
	}
	_, _, windowed := p.EffectiveWindow()
	var runs []*project.RunRecord
	for _, rr := range st.Runs {
		if (windowed || p.LastRuns > 0) && rr.ClosedAt == nil {
			excluded["no closed_at recorded"]++
			continue
		}
		if windowed && !p.InWindow(project.StampMS(rr.ClosedAt)) {
			continue
		}
		runs = append(runs, rr)
	}
	if p.LastRuns > 0 {
		sort.SliceStable(runs, func(i, j int) bool { return project.StampMS(runs[i].ClosedAt) < project.StampMS(runs[j].ClosedAt) })
		if len(runs) > p.LastRuns {
			runs = runs[len(runs)-p.LastRuns:]
		}
	}
	out := []runRow{}
	for _, rr := range runs {
		risk, app, wave := rr.Risk, rr.AppType, ""
		if c := st.Cells[rr.TicketID]; c != nil {
			wave = c.WaveID
			if risk == "" {
				risk = c.Risk
			}
			if app == "" {
				app = c.AppType
			}
		}
		outcome := rr.Outcome
		if outcome != "merged" && outcome != "abandoned" {
			outcome = "unknown"
		}
		if !matchFilter(p.Risk, risk) || !matchFilter(p.AppType, app) || !matchFilter(p.Wave, wave) || !matchFilter(p.Outcome, outcome) {
			continue
		}
		matched := p.Provenance == ""
		for _, x := range byTicket[rr.TicketID] {
			matched = matched || wantProvenance(p.Provenance, x)
		}
		if matched {
			out = append(out, runRow{rr, wave})
		}
	}
	return out, byTicket
}

func execItems(st *project.State, p analyticsParams, excluded map[string]int) []*project.Execution {
	_, _, windowed := p.EffectiveWindow()
	type keyed struct {
		at int64
		x  *project.Execution
	}
	var list []keyed
	for _, id := range sortedKeys(st.Executions) {
		x := st.Executions[id]
		at, has := project.ExecStartMS(x)
		if windowed && !has {
			excluded["no start recorded"]++
			continue
		}
		if windowed && !p.InWindow(at) {
			continue
		}
		risk, app, wave := "", "", ""
		if c := st.Cells[x.TicketID]; c != nil {
			risk, app, wave = c.Risk, c.AppType, c.WaveID
		}
		if !matchFilter(p.Risk, risk) || !matchFilter(p.AppType, app) || !matchFilter(p.Wave, wave) || !wantProvenance(p.Provenance, x) || !usesModel(x, p.Model) {
			continue
		}
		list = append(list, keyed{at, x})
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].at < list[j].at })
	out := make([]*project.Execution, 0, len(list))
	for _, k := range list {
		out = append(out, k.x)
	}
	return out
}

// matchFilter: "" asks nothing; "unknown" matches what recorded no value.
func matchFilter(filter, v string) bool {
	switch filter {
	case "":
		return true
	case "unknown":
		return v == "" || v == "unknown"
	}
	return filter == v
}
