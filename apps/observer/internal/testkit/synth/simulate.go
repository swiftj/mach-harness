package synth

import (
	"fmt"
	"math"
	"sort"
)

const (
	maxParallel = 3
	passEvery   = 60.0 // the supervisor's pass, model seconds
)

// depsFor are the first twelve cells' dependencies, by cell index: one phase each, except cell 7,
// whose slice is blocked three times (two new revisions each add a dependency).
var depsFor = map[int][][]int{1: {{0}}, 4: {{2}}, 7: {{1}, {4}, {6}}, 8: {{3}}, 11: {{9}}}

// archivedCells are cleaned up after their merge: their folder exists only as an archive.
var archivedCells = map[int]bool{0: true, 1: true}

func (w *world) setup() {
	if w.o.Analytics {
		w.setupAnalytics()
		return
	}
	n := w.o.Cells
	waveAt := []float64{300, 5400, 12600}
	for i := 0; i < 3; i++ {
		w.waves = append(w.waves, &wave{id: fmt.Sprintf("WAVE-%03d", i+1), at: waveAt[i]})
	}
	third := (n + 2) / 3
	for i := 0; i < n; i++ {
		wv := w.waves[min(i/third, 2)]
		if n == 12 {
			wv = w.waves[i/4]
		}
		s := &slice{id: fmt.Sprintf("SLICE-%03d", i+1), n: i, wave: wv, ticket: fmt.Sprintf("SYN-%03d", i+1), rev: 1}
		prof := firstProfiles[min(i, len(firstProfiles)-1)]
		if i >= len(firstProfiles) {
			prof = moreProfiles[(i-len(firstProfiles))%len(moreProfiles)]
		}
		c := &cell{n: i, ticket: s.ticket, slice: s, prof: prof, risk: prof.risk, round: 1, visits: map[string]int{}, heldSince: -1,
			files: map[string][]byte{}, archived: archivedCells[i]}
		s.cell = c
		wv.slices = append(wv.slices, s)
		w.slices = append(w.slices, s)
		w.cells = append(w.cells, c)
	}
	// A slice that never gets a cell: it waits on the escalated cell for the whole history.
	extra := &slice{id: fmt.Sprintf("SLICE-%03d", n+1), n: n, wave: w.waves[2], ticket: fmt.Sprintf("SYN-%03d", n+1), rev: 1}
	extra.phases = [][]*cell{{w.cells[5]}}
	w.waves[2].slices = append(w.waves[2].slices, extra)
	w.slices = append(w.slices, extra)
	w.feature["blocked_at_end_slice"] = extra.id
	for i, phases := range depsFor {
		if i >= n {
			continue
		}
		for _, ph := range phases {
			var list []*cell
			for _, d := range ph {
				list = append(list, w.cells[d])
			}
			w.slices[i].phases = append(w.slices[i].phases, list)
		}
	}
	w.feature["blocked_several_times_slice"] = w.slices[7].id
}

func (w *world) depReasons(s *slice) []any {
	var out []any
	for _, c := range s.phases[s.phase] {
		if c.integrated == 0 {
			out = append(out, c.slice.id+" is not integrated yet")
		}
	}
	return out
}

func depIDs(list []*cell) []any {
	out := []any{}
	for _, c := range list {
		out = append(out, c.slice.id)
	}
	return out
}

func (w *world) allIntegrated(list []*cell, t float64) bool {
	for _, c := range list {
		if c.integrated == 0 || c.integrated > t {
			return false
		}
	}
	return true
}

// simulate plays the Factory forward pass by pass and returns the model time by which every piece
// of closed work has ended.
func (w *world) simulate() float64 {
	w.setup()
	w.intakeAdd(0, "factory.activated", "engineer", nil, nil, nil, map[string]any{"autonomy": "supervised",
		"limits": map[string]any{"max_parallel": w.maxPar(), "minutes": 240, "budget_usd": 40}, "allow_merge": true, "persistent": false,
		"backlog": nil, "excluded_slices": []any{}})
	held := map[string]bool{}
	observed := map[string]string{}
	var settled float64 // all closed work has ended by here
	stopAt := math.Inf(1)
	pass := 0
	for t := passEvery; t <= stopAt && t < w.loopCap(); t += passEvery {
		pass++
		// Waves arrive.
		for _, wv := range w.waves {
			if wv.at > t-passEvery && wv.at <= t {
				ids := []any{}
				for _, s := range wv.slices {
					ids = append(ids, s.id)
				}
				w.intakeAdd(wv.at, "intake.validated", "intake", nil, nil, nil, map[string]any{"digest": w.hex(64)}).wave = wv.id
				w.intakeAdd(wv.at+1, "wave.discovered", "intake", nil, nil, nil, map[string]any{"slices": ids,
					"approval": map[string]any{"approved_at": mt(wv.at - 3600)}}).wave = wv.id
				for _, s := range wv.slices {
					w.materialize(s, wv.at+2)
					if len(s.phases) == 0 {
						s.ready, s.resolvedAt = true, wv.at+2
					} else {
						s.blocked, s.blockedAt = true, wv.at+3
						w.intakeAdd(wv.at+3, "dependency.blocked", "intake", nil, s, nil, map[string]any{"reasons": w.depReasons(s)})
					}
				}
			}
		}
		// Merges land on the integration branch.
		for _, c := range w.cells {
			if c.merged > 0 && c.integrated == 0 && c.merged+90 <= t {
				c.integrated = c.merged + 90
				w.intakeAdd(c.integrated, "slice.integrated", "intake", nil, c.slice, nil, map[string]any{"commit": c.head}).ticket = c.ticket
				if w.an != nil {
					w.cleanupA(c, c.integrated+500, "merged")
				} else if c.archived {
					w.cleanup(c, c.integrated+500)
				}
			}
		}
		if w.an != nil {
			w.analyticsPass(t)
		}
		// Dependencies resolve; new revisions add more.
		for _, s := range w.slices {
			if s.supersede > 0 && s.supersede <= t {
				w.intakeAdd(s.supersede, "revision.superseded", "intake", nil, s, nil, map[string]any{"from_revision": s.rev,
					"effect": "the waiting ticket takes the new revision; it now also waits for " + s.phases[s.phase+1][0].slice.id})
				s.rev++
				s.phase++
				w.materialize(s, s.supersede+1)
				s.supersede, s.ready, s.blocked, s.blockedAt = 0, false, true, s.supersede+2
				w.intakeAdd(s.blockedAt, "dependency.blocked", "intake", nil, s, nil, map[string]any{"reasons": w.depReasons(s)})
				continue
			}
			if s.blocked && w.allIntegrated(s.phases[s.phase], t) {
				s.blocked, s.resolvedAt = false, t
				w.intakeAdd(t, "dependency.resolved", "intake", nil, s, nil, map[string]any{"depends_on": depIDs(s.phases[s.phase])})
				if s.phase+1 < len(s.phases) {
					s.supersede = t + 900
				} else {
					s.ready = true
				}
			}
		}
		// Dispatch: the slice gets its cell, groomed headless, stopped at spec-ready.
		var dispatched, started []any
		for _, s := range w.slices {
			if s.ready && !s.dispatched && s.cell != nil {
				s.dispatched = true
				w.dispatch(s.cell, t+1)
				dispatched = append(dispatched, s.id)
			}
		}
		// Claims against max_parallel.
		running := 0
		for _, x := range w.execs {
			if x.claim <= t && t < x.end {
				running++
			}
		}
		var candidates []*cell
		for _, c := range w.cells {
			if c.running && len(c.execs) > 0 && c.execs[len(c.execs)-1].end <= t {
				c.running = false
			}
			if c.created > 0 && !c.done && !c.running && c.seg < len(c.prof.segs) && c.readyAt <= t {
				candidates = append(candidates, c)
			}
		}
		nowHeld := map[string]bool{}
		var heldList []any
		if !w.awake(t) {
			candidates = nil // outside the working week no new work is claimed (realistic profile only)
		}
		for _, c := range candidates {
			if running < w.maxPar() {
				running++
				w.startSegment(c, t+3)
				started = append(started, c.ticket)
				c.heldSince = -1
				continue
			}
			nowHeld[c.ticket] = true
			if c.heldSince < 0 {
				c.heldSince = t
				w.capacityWaits++
			}
			heldList = append(heldList, map[string]any{"slice_id": c.slice.id, "ticket_id": c.ticket, "why": fmt.Sprintf("all %d place(s) are in use", w.maxPar())})
		}
		for _, s := range w.slices {
			if s.blocked {
				heldList = append(heldList, map[string]any{"slice_id": s.id, "ticket_id": s.ticket, "why": "waiting for its dependencies to be integrated"})
			}
		}
		changed := len(dispatched) > 0 || len(started) > 0 || len(nowHeld) != len(held)
		for k := range nowHeld {
			if !held[k] {
				changed = true
				w.feature["capacity_waits"] = true
			}
		}
		held = nowHeld
		if changed || pass%10 == 0 {
			if heldList == nil {
				heldList = []any{}
			}
			w.intakeAdd(t, "scheduling.decided", "supervisor", nil, nil, nil, map[string]any{"state": "supervised", "dispatched": orEmpty(dispatched),
				"started": orEmpty(started), "held": heldList})
		}
		// The supervisor samples each cell's stage.
		for _, c := range w.cells {
			if c.created == 0 {
				continue
			}
			s := stageAtTime(c, t)
			if s != "" && observed[c.ticket] != s {
				if observed[c.ticket] != "" {
					w.intakeAdd(t+0.5, "station.observed", "supervisor", c, nil, nil, map[string]any{"from_stage": observed[c.ticket], "stage": s})
				}
				observed[c.ticket] = s
			}
		}
		// Settled: every cell finished its closed work (an open execution or an open wait may remain).
		if math.IsInf(stopAt, 1) {
			all := true
			for _, c := range w.cells {
				if !c.done {
					all = false
				}
				if c.merged > 0 && (c.integrated == 0 || c.archived && c.integrated+500 > t) {
					all = false
				}
			}
			if w.an != nil && !w.analyticsSettled(t) {
				all = false
			}
			if all {
				settled = w.lastClosed()
				stopAt = settled / 0.93
			}
		}
	}
	return settled
}

func orEmpty(v []any) []any {
	if v == nil {
		return []any{}
	}
	return v
}

func stageAtTime(c *cell, t float64) string {
	i := sort.Search(len(c.stages), func(i int) bool { return c.stages[i].t > t })
	if i == 0 {
		return ""
	}
	return c.stages[i-1].stage
}

func (w *world) materialize(s *slice, t float64) {
	deps := []any{}
	for _, ph := range s.phases[:min(len(s.phases), s.phase+1)] {
		deps = append(deps, depIDs(ph)...)
	}
	s.digest = w.hex(64)
	r := w.intakeAdd(t, "slice.materialized", "intake", nil, s, nil, map[string]any{"digest": s.digest, "adopted": false, "dependencies": deps, "reissued": s.rev > 1})
	r.ticket = s.ticket
}

func (w *world) dispatch(c *cell, t float64) {
	w.intakeAdd(t, "work.scheduled", "supervisor", c, nil, nil, map[string]any{"stage": "spec-ready", "risk": c.risk, "branch": "feature/" + c.ticket,
		"authorization": "machine-local authorization, supervised mode"})
	c.created = t + 1
	w.setStage(c, t+2, "interview")
	n := w.nextVisit(c, "groom")
	d := w.between(20, 45)
	w.lrec(c, nil, t+2, "station.entered", "groom", n, 0, map[string]any{"stage": "interview", "mode": "headless", "resumed": false})
	w.lrec(c, nil, t+2+d*0.8, "gate.evaluated", "groom", n, 0, map[string]any{"gate": "groom.finalize", "outcome": "pass", "reason_code": nil})
	w.lrec(c, nil, t+2+d, "station.exited", "groom", n, 0, map[string]any{"outcome": "spec-ready", "stage": "spec-ready"})
	w.setStage(c, t+2+d, "spec-ready")
	c.readyAt = t + 2 + d + 5
	c.files["intent.md"] = []byte("# Intent (synthetic)\n\nWhy " + c.slice.id + " exists, in roles only.\n")
	c.files["spec.md"] = []byte("# " + c.slice.id + " (synthetic)\n\nFR-01, FR-02; AC-01..AC-03; R1, R2.\n")
	c.files["spec.json"] = []byte(`{"slice_id":"` + c.slice.id + `","scenarios":[{"id":"AC-01"},{"id":"AC-02"},{"id":"AC-03"}],"decision_matrix":{"rules":[{"id":"R1"},{"id":"R2"}]}}` + "\n")
}

func (w *world) startSegment(c *cell, t float64) {
	seg := c.prof.segs[c.seg]
	c.seg++
	c.running = true
	x := w.buildExecution(c, seg, t)
	if seg.end == "open" {
		c.done = true
		w.feature["open_execution"] = x.id
		w.feature["open_ticket"] = c.ticket
		return
	}
	next := "stop"
	if c.seg < len(c.prof.segs) {
		next = nextAction(c.prof.segs[c.seg].visits[0])
	}
	x.stage, x.next = c.stage, next
	switch seg.end {
	case "interrupted":
		x.outcome = "failed"
		w.intakeAdd(x.end+40, "recovery.started", "supervisor", c, nil, x, map[string]any{"kind": "ended-while-unwatched"})
		w.intakeAdd(x.end+45, "execution.failed", "supervisor", c, nil, x, map[string]any{"stage": c.stage, "next": "build", "how": "interrupted",
			"claude_error": nil, "exit_code": nil, "attempt": x.attempt})
		c.readyAt = x.end + 300
	case "unknown":
		x.outcome = "unknown"
		w.intakeAdd(x.end+40, "recovery.started", "supervisor", c, nil, x, map[string]any{"kind": "outcome-unknown"})
		c.readyAt = x.end + 60
	default:
		x.outcome = "completed"
		var waiting any
		switch c.stage {
		case "awaiting-human":
			waiting = "a person's approval"
		case "blocked":
			waiting = "a person: the ticket was escalated"
		}
		x.waiting = waiting
		var cost any = x.cost
		if x.an != nil && x.an.noUsage {
			cost = nil
		}
		w.intakeAdd(x.end+2, "execution.completed", "supervisor", c, nil, x, map[string]any{"stage": c.stage, "next": next, "waiting_for": waiting,
			"how": "exited", "seen_to_end": true, "cost_usd": cost, "refused_tools": []any{}})
		c.readyAt = x.end + 30
	}
	switch seg.after {
	case "human":
		ta := x.end + w.between(3600, 5400)
		if w.real() {
			// A person approves in working hours: minutes to hours after they see it, with a long tail.
			ta = w.nextAwake(x.end+w.lognormal(1500, 1.0)) + w.lognormal(1200, 0.9)
		}
		hv := w.nextVisit(c, "human-approval")
		w.lrec(c, nil, ta, "human.approval_recorded", "human-approval", hv, c.round, map[string]any{"round": c.round, "decision": "approve", "note_given": true})
		w.humanApproved(c, ta, hv)
		w.setStage(c, ta, "approved")
		c.readyAt = ta + 30
		w.feature["human_wait_closed"] = c.ticket
	case "human-open":
		c.waitOpen = true
		w.feature["human_wait_open"] = c.ticket
	case "abandon":
		w.abandon(c, x)
	}
	if c.seg >= len(c.prof.segs) || c.stage == "blocked" || c.waitOpen {
		c.done = true
	}
}

// cleanup closes an archived cell: cleanup's records go only into the archive's copy of the log.
func (w *world) cleanup(c *cell, t float64) {
	n := w.nextVisit(c, "cleanup")
	for _, r := range []*lifeRec{
		{t: t, typ: "station.entered", data: map[string]any{"stage": "merged"}},
		{t: t + 4, typ: "cleanup.completed", data: map[string]any{"outcome": "merged", "archive": c.ticket + ".tar.gz", "bundle": false, "uncommitted_saved": false}},
		{t: t + 5, typ: "station.exited", data: map[string]any{"outcome": "archived", "stage": "merged"}},
	} {
		r.wt, r.station, r.visit, r.archive = r.t, "cleanup", n, true
		c.life = append(c.life, r)
	}
	c.files["#cleanup"] = []byte(fmt.Sprint(t))
	w.feature["archived_cells"] = append(asList(w.feature["archived_cells"]), c.ticket)
}

func asList(v any) []string {
	l, _ := v.([]string)
	return l
}

// lastClosed is when the last piece of closed work ended (the open execution excluded).
func (w *world) lastClosed() float64 {
	m := 0.0
	for _, x := range w.execs {
		if !math.IsInf(x.end, 1) {
			m = math.Max(m, x.end+60)
		} else {
			m = math.Max(m, x.claim+600) // the open execution starts well before the end
		}
	}
	for _, c := range w.cells {
		for _, r := range c.life {
			if r.t < 1e6 {
				m = math.Max(m, r.t)
			}
		}
	}
	for _, r := range w.intake {
		m = math.Max(m, r.wt)
	}
	return m
}
