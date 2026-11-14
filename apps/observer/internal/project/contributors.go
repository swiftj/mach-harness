package project

import (
	"math"
	"sort"
	"strings"
)

// Contributors (M6_5_DESIGN.md section 3.3): the entities behind a figure, as entity refs in the
// grammar /spans and /marks use (visit:<visit_id>, gate:<ticket>/verify#<round>,
// gate:<ticket>/review#<round>, gate:<ticket>/<key>, slice:<id>, cell:<ticket>,
// execution:<id>), with the span's exact id where a span stands behind it. Identifiers, codes and
// numbers only: no title, reason, finding or other prose is ever carried.

// Contributor is one entity behind a figure.
type Contributor struct {
	Ref       string   `json:"ref"`
	SpanID    *string  `json:"span_id"`
	Ticket    *string  `json:"ticket"`
	Cell      *string  `json:"cell"`
	Execution *string  `json:"execution"`
	Value     *float64 `json:"value"` // null when not measured (bounds beside it) or not recorded
	MinMS     *int64   `json:"min_ms,omitempty"`
	MaxMS     *int64   `json:"max_ms,omitempty"`
	Unit      string   `json:"unit"`
	Basis     string   `json:"basis"` // measured | bounded | inferred | open | unknown | recorded | not-recorded
	AtMS      int64    `json:"at_ms"` // where it is placed in a window: its start, or the record's time
	FromMS    *int64   `json:"from_ms"`
	ToMS      *int64   `json:"to_ms"`
	Risk      *string  `json:"risk"`
	AppType   *string  `json:"app_type"`
	Wave      *string  `json:"wave"`
	// Group holds the item's codes for the figure's dimensions (station, round, kind, state, model,
	// gate, reason_code, status, target_kind, outcome, action, basis, source).
	Group map[string]string `json:"group"`

	runEvent string // the run record's event (run figures), for last_runs
}

// ContributorFigure describes one figure contributors can be asked for.
type ContributorFigure struct {
	ID         string   `json:"id"`
	Catalog    bool     `json:"catalog"` // a catalog metric ID; else a flow figure of this API
	Entities   string   `json:"entities"`
	Unit       string   `json:"unit"`
	Dimensions []string `json:"dimensions"`
}

// ContributorFigures are the figures supported, by id.
var ContributorFigures = map[string]ContributorFigure{
	"C1":    {"C1", true, "station visits (every basis; C1 counts the measured ones)", "ms", []string{"station", "round", "action", "basis"}},
	"waits": {"waits", false, "waits of every kind", "ms", []string{"kind", "station", "basis"}},
	"W1":    {"W1", true, "dependency waits", "ms", []string{"kind", "station", "basis"}},
	"W2":    {"W2", true, "queue waits (eligible to dispatched)", "ms", []string{"kind", "station", "basis"}},
	"W2b":   {"W2b", true, "execution-capacity waits", "ms", []string{"kind", "station", "basis"}},
	"W3":    {"W3", true, "waits for a person's approval", "ms", []string{"kind", "station", "basis"}},
	"S4":    {"S4", true, "tickets parked for a person (person waits)", "ms", []string{"kind", "station", "basis"}},
	"Q1":    {"Q1", true, "round-1 verifications that did not pass", "verifications", []string{"round", "status", "station"}},
	"verification_failures": {"verification_failures", false, "verifications that did not pass, every round", "verifications",
		[]string{"round", "status", "station"}},
	"Q4":         {"Q4", true, "failed verification checks", "checks", []string{"target_kind", "round", "station"}},
	"R1":         {"R1", true, "review rounds rejected or escalated (value: blockers recorded)", "blockers", []string{"outcome", "round"}},
	"R5":         {"R5", true, "finished tickets escalated to a person (run records)", "tickets", []string{"outcome"}},
	"X2":         {"X2", true, "gate refusals", "evaluations", []string{"gate", "station", "reason_code", "round"}},
	"X3":         {"X3", true, "gate overrides", "evaluations", []string{"gate", "station", "reason_code", "round"}},
	"executions": {"executions", false, "executions by state", "executions", []string{"state", "recovered"}},
	"X1":         {"X1", true, "executions with an execution.failed record (X1's numerator; state says how they ended, e.g. interrupted)", "executions", []string{"state", "recovered"}},
	"S1":         {"S1", true, "recoveries by kind", "recoveries", []string{"kind"}},
	"S2":         {"S2", true, "executions whose outcome is unknown", "executions", []string{"state", "recovered"}},
	"K1":         {"K1", true, "executions by the cost the supervisor recorded", "usd", []string{"state", "source"}},
	"C3":         {"C3", true, "merged product tickets, dispatch (work.scheduled) to merge (placed at the merge)", "ms", []string{"basis"}},
	"C4":         {"C4", true, "integrated slices, eligible to integrated (placed at the integration)", "ms", []string{"basis"}},
	"K4":         {"K4", true, "tickets by the sum of the cost the supervisor recorded for their executions (placed at the latest)", "usd", []string{"basis"}},
	"K2":         {"K2", true, "executions by the cost recorded per model", "usd", []string{"model", "state"}},
	"Q2":         {"Q2", true, "merged tickets' run records (value 1 when first_pass, else 0)", "tickets", []string{"first_pass", "outcome"}},
	"Q3": {"Q3", true, "merged tickets' run records (value: judging rounds; not-recorded when the record has none)", "rounds",
		[]string{"rounds_recorded", "outcome"}},
	"R2":            {"R2", true, "blocker findings by the rule code they name (never the finding's text)", "blockers", []string{"rule", "seat", "round"}},
	"K1-missing":    {"K1-missing", false, "completed executions with no cost recorded by the supervisor", "executions", []string{"state", "usage"}},
	"usage-missing": {"usage-missing", false, "executions with no usage record from the stream", "executions", []string{"state", "recovered"}},
	"lifecycle-missing": {"lifecycle-missing", false, "cells with no lifecycle log (no station visits can be known)", "cells",
		[]string{"stage", "archived"}},
}

// RunFigures are the figures whose population is run records: they honour last_runs (the
// observe station's population: the last N by closed_at).
var RunFigures = map[string]bool{"Q2": true, "Q3": true, "R5": true}

// ContributorQuery selects and orders contributors.
type ContributorQuery struct {
	// LastRuns: keep the run records among the last N by closed_at (run figures), or the items of
	// those runs' tickets (every other figure).
	LastRuns            int
	Window              bool
	From, To            int64
	Risk, AppType, Wave string
	Group               map[string]string // dimension -> code; every one must match
	Order               string            // impact | recent
	Limit               int
}

// ContributorPage is the contributors reply's data.
type ContributorPage struct {
	Figure    ContributorFigure `json:"figure"`
	Items     []Contributor     `json:"items"`
	Total     int               `json:"total"`
	Truncated bool              `json:"truncated"`
	ByBasis   map[string]int    `json:"by_basis"` // over every matching item, not only the page
	Order     string            `json:"order"`
	Limit     int               `json:"limit"`
}

// Contributors lists the entities behind figure id (one of ContributorFigures). The figure's list
// is built and sorted once per index and order; a request only scans it.
func (ix *FlowIndex) Contributors(id string, q ContributorQuery) ContributorPage {
	if q.Order != "recent" {
		q.Order = "impact"
	}
	all := ix.contributorList(id, q.Order)
	page := ContributorPage{Figure: ContributorFigures[id], Items: []Contributor{}, ByBasis: map[string]int{}, Order: q.Order, Limit: q.Limit}
	// last_runs: run figures keep the run records among the last N by closed_at; every other figure
	// keeps the items of those runs' tickets (the population an observe-scorecard figure reads).
	var keepRuns, keepTickets map[string]bool
	if q.LastRuns > 0 {
		keepRuns, keepTickets = lastRunEvents(ix.st, q.LastRuns)
	}
	for i := range all {
		c := &all[i]
		if keepRuns != nil {
			if RunFigures[id] && !keepRuns[c.runEvent] || !RunFigures[id] && (c.Ticket == nil || !keepTickets[*c.Ticket]) {
				continue
			}
		}
		if q.Window && (c.AtMS < q.From || c.AtMS >= q.To) {
			continue
		}
		if !want(q.Risk, deref(c.Risk)) || !want(q.AppType, deref(c.AppType)) || !want(q.Wave, deref(c.Wave)) {
			continue
		}
		match := true
		for k, v := range q.Group {
			if c.Group[k] != v {
				match = false
				break
			}
		}
		if !match {
			continue
		}
		page.Total++
		page.ByBasis[c.Basis]++
		if len(page.Items) < q.Limit {
			page.Items = append(page.Items, *c)
		}
	}
	page.Truncated = page.Total > len(page.Items)
	return page
}

// sortContributors orders a list: impact (value, then the upper bound, then the newest) or recent
// (the newest); ties by ref, span and model, so the order is deterministic.
func sortContributors(list []Contributor, order string) {
	sort.SliceStable(list, func(i, j int) bool {
		a, b := &list[i], &list[j]
		if order == "impact" {
			if (a.Value == nil) != (b.Value == nil) {
				return a.Value != nil
			}
			if a.Value != nil && *a.Value != *b.Value {
				return *a.Value > *b.Value
			}
			am, bm := derefI(a.MaxMS), derefI(b.MaxMS)
			if am != bm {
				return am > bm
			}
		}
		if a.AtMS != b.AtMS {
			return a.AtMS > b.AtMS
		}
		if a.Ref != b.Ref {
			return a.Ref < b.Ref
		}
		if sa, sb := deref(a.SpanID), deref(b.SpanID); sa != sb {
			return sa < sb
		}
		return a.Group["model"] < b.Group["model"]
	})
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func derefI(p *int64) int64 {
	if p == nil {
		return -1
	}
	return *p
}

// contributorList builds (once per index and order) every contributor of a figure, unfiltered and
// sorted. The list is shared: it must not be changed.
func (ix *FlowIndex) contributorList(id, order string) []Contributor {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if ix.contrib == nil {
		ix.contrib = map[string][]Contributor{}
	}
	key := id + "|" + order
	if l, ok := ix.contrib[key]; ok {
		return l
	}
	l := ix.buildContributors(id)
	sortContributors(l, order)
	ix.contrib[key] = l
	return l
}

func (ix *FlowIndex) cellFacts(c *Contributor, ticket string) {
	if ticket == "" {
		return
	}
	c.Ticket = strp(ticket)
	cell := ix.st.Cells[ticket]
	if cell == nil {
		return
	}
	c.Cell = strp("cell:" + ticket)
	// The same join the metric engine makes (TicketDims), so a figure's groups and its contributors agree.
	d := TicketDims(ix.st, ticket)
	c.Risk, c.AppType, c.Wave = strp(d["risk"]), strp(d["app_type"]), strp(d["wave"])
}

func f64(v int64) *float64 {
	f := float64(v)
	return &f
}

// spanContributor is one span as a contributor: its measured length as the value, else its bounds.
func (ix *FlowIndex) spanContributor(sp *Span, ticket string) Contributor {
	c := Contributor{Ref: sp.Entity, SpanID: strp(sp.SpanID), Unit: "ms", Basis: sp.Duration.Basis, AtMS: sp.from, FromMS: ptr(sp.from), Group: map[string]string{}}
	if sp.End != nil {
		c.ToMS = ptr(sp.to)
	}
	if sp.Duration.Basis == "measured" && sp.Duration.MS != nil {
		c.Value = f64(*sp.Duration.MS)
	} else {
		c.MinMS, c.MaxMS = sp.Duration.MinMS, sp.Duration.MaxMS
	}
	c.Group["basis"] = sp.Duration.Basis
	if x := sp.IDs["execution_id"]; x != "" {
		c.Execution = strp(x)
	}
	ix.cellFacts(&c, ticket)
	return c
}

func (ix *FlowIndex) buildContributors(id string) []Contributor {
	s := ix.st
	out := []Contributor{}
	switch id {
	case "C1":
		for _, sp := range ix.spans {
			if sp.Kind != "visit" {
				continue
			}
			c := ix.spanContributor(sp, sp.meta.ticket)
			c.Group["station"] = orDefault(sp.IDs["station"], "unknown")
			if r := sp.IDs["round"]; r != "" {
				c.Group["round"] = r
			}
			if sp.Attrs.Action != "" {
				c.Group["action"] = sp.Attrs.Action
			}
			out = append(out, c)
		}
	case "waits", "W1", "W2", "W2b", "W3", "S4":
		only := map[string]string{"W1": WaitDependency, "W2": WaitQueue, "W2b": WaitCapacity, "W3": WaitHuman, "S4": WaitPerson}[id]
		next := ix.nextStations()
		for _, sp := range ix.spans {
			kind := waitKindOf(sp)
			if kind == "" || only != "" && kind != only {
				continue
			}
			c := ix.spanContributor(sp, sp.meta.ticket)
			c.Group["kind"] = kind
			if n := next(sp.meta.ticket, sp.from); n != "" {
				c.Group["station"] = n
			}
			out = append(out, c)
		}
	case "Q1", "verification_failures", "X2", "X3":
		for _, t := range sortedKeys(s.Cells) {
			cell := s.Cells[t]
			stationOf := map[string]string{}
			for _, v := range cell.Visits {
				stationOf[v.VisitID] = v.Station
			}
			for _, g := range cell.Gates {
				if g.At == nil {
					continue
				}
				switch id {
				case "Q1", "verification_failures":
					if g.Gate != "verify.verdict" || g.Status == "" || g.Status == "PASS" || id == "Q1" && (g.Round == nil || *g.Round != 1) {
						continue
					}
				case "X2":
					if g.Verdict != "refused" {
						continue
					}
				case "X3":
					if g.Verdict != "overridden" {
						continue
					}
				}
				station := stationOf[g.VisitID]
				if station == "" {
					station, _, _ = strings.Cut(g.Gate, ".")
				}
				ref := "gate:" + t + "/" + orDefault(station, "unknown")
				if (station == "verify" || station == "review") && g.Round != nil {
					ref += "#" + itoa(g.Round)
				}
				at := stampMS(g.At)
				c := Contributor{Ref: ref, Value: f64(1), Unit: ContributorFigures[id].Unit, Basis: "recorded", AtMS: at, FromMS: ptr(at), ToMS: ptr(at),
					Group: map[string]string{"station": orDefault(station, "unknown"), "gate": g.Gate}}
				if g.Round != nil {
					c.Group["round"] = itoa(g.Round)
				}
				if g.Status != "" {
					c.Group["status"] = g.Status
				}
				if g.ReasonCode != "" {
					c.Group["reason_code"] = g.ReasonCode
				}
				ix.cellFacts(&c, t)
				ix.visitExecution(&c, cell, g.VisitID)
				out = append(out, c)
			}
		}
	case "Q4":
		for _, t := range sortedKeys(s.Cells) {
			cell := s.Cells[t]
			stationOf := map[string]string{}
			for _, v := range cell.Visits {
				stationOf[v.VisitID] = v.Station
			}
			for _, ch := range cell.Checks {
				if ch.Result != "fail" || ch.At == nil {
					continue
				}
				ref := "cell:" + t
				if ch.VisitID != "" {
					ref = "visit:" + ch.VisitID
				}
				at := stampMS(ch.At)
				c := Contributor{Ref: ref, Value: f64(1), Unit: "checks", Basis: "recorded", AtMS: at, FromMS: ptr(at), ToMS: ptr(at),
					Group: map[string]string{"target_kind": orDefault(ch.TargetKind, "unknown"), "station": orDefault(stationOf[ch.VisitID], "verify")}}
				if ch.Round != nil {
					c.Group["round"] = itoa(ch.Round)
				}
				ix.cellFacts(&c, t)
				ix.visitExecution(&c, cell, ch.VisitID)
				out = append(out, c)
			}
		}
	case "R1":
		for _, t := range sortedKeys(s.Cells) {
			cell := s.Cells[t]
			for _, rv := range cell.Reviews {
				if rv.Decided == nil || rv.Outcome != "REJECTED" && rv.Outcome != "ESCALATE" {
					continue
				}
				at := stampMS(rv.Decided)
				c := Contributor{Ref: "gate:" + t + "/review#" + itoa(rv.Round), Unit: "blockers", Basis: "recorded", AtMS: at, ToMS: ptr(at),
					Group: map[string]string{"outcome": rv.Outcome}}
				if rv.Started != nil {
					c.FromMS = ptr(stampMS(rv.Started))
				}
				if rv.Blockers != nil {
					c.Value = f64(*rv.Blockers)
				} else {
					c.Basis = "not-recorded"
				}
				if rv.Round != nil {
					c.Group["round"] = itoa(rv.Round)
				}
				ix.cellFacts(&c, t)
				ix.visitExecution(&c, cell, rv.VisitID)
				out = append(out, c)
			}
		}
	case "R5", "Q2", "Q3":
		for _, r := range s.Runs {
			if r.ClosedAt == nil {
				continue // not placed in time: not listed (run records always carry closed_at)
			}
			f := RunFactsOf(r)
			outcome := orDefault(f.Outcome, "unknown")
			c := Contributor{Ref: "cell:" + r.TicketID, Unit: ContributorFigures[id].Unit, Basis: "recorded", AtMS: f.ClosedMS, ToMS: ptr(f.ClosedMS),
				Group: map[string]string{"outcome": outcome}, runEvent: r.EventID}
			switch id {
			case "R5":
				if !r.Escalated {
					continue
				}
				c.Value = f64(1)
			case "Q2":
				if f.Outcome != "merged" {
					continue
				}
				c.Value = f64(0)
				c.Group["first_pass"] = boolWord(r.FirstPass)
				if r.FirstPass {
					c.Value = f64(1)
				}
			case "Q3":
				if f.Outcome != "merged" {
					continue
				}
				c.Group["rounds_recorded"] = boolWord(r.Rounds != nil)
				if r.Rounds != nil {
					c.Value = r.Rounds
				} else {
					c.Basis = "not-recorded"
				}
			}
			ix.cellFacts(&c, r.TicketID)
			if c.Risk == nil || *c.Risk == "" {
				c.Risk = strp(r.Risk)
			}
			if c.AppType == nil || *c.AppType == "" {
				c.AppType = strp(r.AppType)
			}
			out = append(out, c)
		}
	case "R2":
		for _, t := range sortedKeys(s.Cells) {
			cell := s.Cells[t]
			for _, f := range cell.Findings {
				if f.Severity != "blocker" {
					continue
				}
				// The time of the round's decision (else its start): a finding records none of its own.
				var at *Stamp
				if rv := cell.review(f.Round); rv != nil {
					at = rv.Decided
					if at == nil {
						at = rv.Started
					}
				}
				if at == nil {
					continue
				}
				ms := stampMS(at)
				rule := "none"
				if f.Rule != "" {
					rule = "not-a-code"
					if ruleCode(f.Rule) {
						rule = f.Rule
					}
				}
				c := Contributor{Ref: "finding:" + t + "/r" + itoa(f.Round) + "/" + orDefault(f.Seat, "unknown") + "/" + itoa(&f.N), Value: f64(1), Unit: "blockers",
					Basis: "recorded", AtMS: ms, FromMS: ptr(ms), ToMS: ptr(ms), Group: map[string]string{"rule": rule, "seat": orDefault(f.Seat, "unknown")}}
				if f.Round != nil {
					c.Group["round"] = itoa(f.Round)
				}
				ix.cellFacts(&c, t)
				out = append(out, c)
			}
		}
	case "lifecycle-missing":
		for _, t := range sortedKeys(s.Cells) {
			cell := s.Cells[t]
			if cell.Lifecycle || cell.FirstSeen == nil {
				continue
			}
			ms := stampMS(cell.FirstSeen)
			c := Contributor{Ref: "cell:" + t, Value: f64(1), Unit: "cells", Basis: "not-recorded", AtMS: ms, FromMS: ptr(ms),
				Group: map[string]string{"stage": orDefault(cell.Stage, "unknown"), "archived": boolWord(cell.Archived)}}
			ix.cellFacts(&c, t)
			out = append(out, c)
		}
	case "executions", "X1", "S2", "K1", "K2", "K1-missing", "usage-missing":
		for _, xid := range sortedKeys(s.Executions) {
			x := s.Executions[xid]
			state := ExecStateIn(s, x)
			if id == "X1" && x.Failed == nil || id == "S2" && state != "unknown" || id == "K1" && x.CostUSD == nil ||
				id == "K1-missing" && (x.Completed == nil || x.CostUSD != nil) || id == "usage-missing" && x.Usage != nil {
				continue
			}
			start := execStart(x)
			if start == nil {
				start = x.Claimed
			}
			if start == nil {
				continue
			}
			at := stampMS(start)
			base := Contributor{Ref: "execution:" + xid, Execution: strp(xid), Basis: "recorded", AtMS: at, FromMS: ptr(at),
				Group: map[string]string{"state": state, "recovered": boolWord(len(x.Recovery) > 0)}}
			if end, _ := execEnd(s, x); end != nil {
				hi, ok := end.hi()
				if !ok {
					hi = end.OrderMS
				}
				base.ToMS = ptr(hi)
			}
			ix.cellFacts(&base, x.TicketID)
			switch id {
			case "K1-missing":
				base.Value, base.Unit, base.Basis = f64(1), "executions", "not-recorded"
				base.Group = map[string]string{"state": state, "usage": boolWord(x.Usage != nil)}
				out = append(out, base)
			case "usage-missing":
				base.Value, base.Unit, base.Basis = f64(1), "executions", "not-recorded"
				out = append(out, base)
			case "executions", "X1", "S2":
				base.Value, base.Unit = f64(1), "executions"
				if d := Run(s, x).Duration; d.MS != nil {
					base.MinMS, base.MaxMS = d.MS, d.MS
				} else {
					base.MinMS, base.MaxMS = d.MinMS, d.MaxMS
				}
				out = append(out, base)
			case "K1":
				base.Value, base.Unit, base.Group["source"] = x.CostUSD, "usd", "execution.completed"
				out = append(out, base)
			case "K2":
				if x.Usage == nil {
					continue
				}
				for _, m := range sortedKeys(x.Usage.Models) {
					u := x.Usage.Models[m]
					c := base
					c.Group = map[string]string{"state": state, "recovered": base.Group["recovered"], "model": m}
					c.Unit, c.Value = "usd", u.CostUSD
					if u.CostUSD == nil {
						c.Basis = "not-recorded"
					}
					out = append(out, c)
				}
			}
		}
	case "C3":
		// The engine's C3: a merged product ticket whose slice was dispatched to it (reduce.go
		// merge.completed: work.scheduled of the cell's slice, same ticket, to the merge).
		for _, t := range sortedKeys(s.Cells) {
			c := s.Cells[t]
			sl := s.Slices[c.SliceID]
			if c.Merge == nil || c.Merge.At == nil || sl == nil || sl.Scheduled == nil || sl.TicketID != t {
				continue
			}
			out = append(out, ix.durationContributor("cell:"+t, t, sl.Scheduled, c.Merge.At))
		}
	case "C4":
		// The engine's C4: an integrated slice, from when it became eligible (dependency.resolved,
		// else its first materialization when it has no dependencies) to slice.integrated.
		for _, id := range sortedKeys(s.Slices) {
			sl := s.Slices[id]
			if sl.Integrated == nil {
				continue
			}
			c := ix.durationContributor("slice:"+id, sl.TicketID, sl.eligible(), sl.Integrated)
			if c.Wave == nil || *c.Wave == "" {
				c.Wave = strp(sl.WaveID)
			}
			out = append(out, c)
		}
	case "K4":
		// The engine's K4: per ticket, the sum of execution.completed.cost_usd over its executions.
		sum, last := map[string]float64{}, map[string]*Stamp{}
		for _, xid := range sortedKeys(s.Executions) {
			x := s.Executions[xid]
			if x.TicketID == "" || x.CostUSD == nil || x.Completed == nil {
				continue
			}
			sum[x.TicketID] += *x.CostUSD
			if l := last[x.TicketID]; l == nil || x.Completed.OrderMS > l.OrderMS {
				last[x.TicketID] = x.Completed
			}
		}
		for _, t := range sortedKeys(sum) {
			v, at := sum[t], stampMS(last[t])
			c := Contributor{Ref: "cell:" + t, Value: &v, Unit: "usd", Basis: "recorded", AtMS: at, ToMS: ptr(at), Group: map[string]string{"basis": "recorded"}}
			ix.cellFacts(&c, t)
			out = append(out, c)
		}
	case "S1":
		for _, r := range s.Recoveries {
			if r.At == nil {
				continue
			}
			at := stampMS(r.At)
			ref := "cell:" + r.TicketID
			if r.ExecutionID != "" {
				ref = "execution:" + r.ExecutionID
			}
			c := Contributor{Ref: ref, Value: f64(1), Unit: "recoveries", Basis: "recorded", AtMS: at, FromMS: ptr(at), ToMS: ptr(at),
				Group: map[string]string{"kind": orDefault(r.Kind, "unknown")}}
			if r.ExecutionID != "" {
				c.Execution = strp(r.ExecutionID)
			}
			ix.cellFacts(&c, r.TicketID)
			out = append(out, c)
		}
	}
	return out
}

func boolWord(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// visitExecution names the execution a visit ran under, when recorded.
func (ix *FlowIndex) visitExecution(c *Contributor, cell *Cell, visitID string) {
	if visitID == "" {
		return
	}
	for _, v := range cell.Visits {
		if v.VisitID == visitID && v.ExecutionID != "" {
			c.Execution = strp(v.ExecutionID)
			return
		}
	}
}

// nextStations returns a lookup of the station a ticket entered next at or after an instant.
func (ix *FlowIndex) nextStations() func(ticket string, from int64) string {
	type entry struct {
		from    int64
		station string
	}
	byTicket := map[string][]entry{}
	for _, sp := range ix.spans {
		if sp.Kind == "visit" {
			byTicket[sp.meta.ticket] = append(byTicket[sp.meta.ticket], entry{sp.from, orDefault(sp.IDs["station"], "unknown")})
		}
	}
	for _, l := range byTicket {
		sort.SliceStable(l, func(i, j int) bool { return l[i].from < l[j].from })
	}
	return func(t string, from int64) string {
		for _, e := range byTicket[t] {
			if e.from >= from {
				return e.station
			}
		}
		return ""
	}
}

// ruleCode reports a rule reference that is a code (letters, digits, . _ : # -; at most 64), never prose.
func ruleCode(v string) bool {
	if v == "" || len(v) > 64 {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == ':' || c == '#' || c == '-') {
			return false
		}
	}
	return true
}

// lastRunEvents are the run records among the last n by closed_at, as the observe station selects
// them (metrics.LastRuns: stable by the earliest instant closed_at allows, unreadable first), and
// their tickets.
func lastRunEvents(s *State, n int) (events, tickets map[string]bool) {
	runs := append([]*RunRecord(nil), s.Runs...)
	at := func(r *RunRecord) int64 {
		if f := RunFactsOf(r); f.ClosedOK {
			return f.ClosedMS
		}
		return math.MinInt64
	}
	sort.SliceStable(runs, func(i, j int) bool { return at(runs[i]) < at(runs[j]) })
	if n < len(runs) {
		runs = runs[len(runs)-n:]
	}
	events, tickets = make(map[string]bool, len(runs)), make(map[string]bool, len(runs))
	for _, r := range runs {
		events[r.EventID], tickets[r.TicketID] = true, true
	}
	return events, tickets
}

// durationContributor is an end-to-end interval: its value when measured, else its bounds; placed
// at its end (the record that closed it, as the metric engine places it).
func (ix *FlowIndex) durationContributor(ref, ticket string, start, end *Stamp) Contributor {
	d := between(start, end, false)
	at := stampMS(end)
	c := Contributor{Ref: ref, Unit: "ms", Basis: d.Basis, AtMS: at, ToMS: ptr(at), Group: map[string]string{"basis": d.Basis}}
	if start != nil {
		c.FromMS = ptr(stampMS(start))
	}
	if d.Basis == "measured" && d.MS != nil {
		c.Value = f64(*d.MS)
	} else {
		c.MinMS, c.MaxMS = d.MinMS, d.MaxMS
	}
	ix.cellFacts(&c, ticket)
	return c
}

// GroupCodes are the codes dimension dim takes among figure id's contributors (at the head, for an
// index cut at a time): with the fixed enumerations, the codes a group may name. Every code the
// metric engine emits for the figure's records is among them, so a group read from
// /analytics/metrics can be asked here.
func (ix *FlowIndex) GroupCodes(id, dim string) map[string]bool {
	src := ix
	if ix.base != nil {
		src = ix.base
	}
	out := map[string]bool{}
	for _, v := range fixedCodes[dim] {
		out[v] = true
	}
	for _, c := range src.contributorList(id, "impact") {
		if v, ok := c.Group[dim]; ok {
			out[v] = true
		}
	}
	return out
}

// fixedCodes are the enumerations a dimension can take whatever was recorded.
var fixedCodes = map[string][]string{
	"basis":           {"measured", "bounded", "inferred", "open", "unknown", "recorded", "not-recorded"},
	"kind":            append(append([]string{}, WaitKinds...), "outcome-unknown", "interrupted", "orphan-claim", "unknown"),
	"state":           {"claimed", "running", "ended", "finished", "failed", "interrupted", "timed-out", "could-not-start", "unknown"},
	"recovered":       {"true", "false"},
	"first_pass":      {"true", "false"},
	"rounds_recorded": {"true", "false"},
	"archived":        {"true", "false"},
	"usage":           {"true", "false"},
	"outcome":         {"merged", "abandoned", "unknown", "REJECTED", "ESCALATE"},
	"station":         {"groom", "intent", "plan", "audit", "build", "verify", "review", "human-approval", "merge", "cleanup", "unknown"},
	"rule":            {"none", "not-a-code"},
	"source":          {"execution.completed"},
}
