package synth

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
)

// A visit the belt makes. station: plan, audit, build, revise, resume (a build visit taken up again
// after an interruption), verify, review, merge. outcome: PASS / FAIL for verify; APPROVED,
// REJECTED, AWAITING_HUMAN, ESCALATE for review.
type vspec struct {
	station string
	outcome string
}

// A segment is what one execution does. end: "" (exits normally), "interrupted" (the process is
// stopped mid-visit; recovered), "unknown" (stopped after its work, outcome never recorded), "open"
// (still running when the history ends). after: what follows the execution: "human" (a person
// approves after a wait), "human-open" (the wait is still open at the end), "recovery".
type segment struct {
	visits     []vspec
	end        string
	after      string
	noWorkflow bool // the main loop only, records without timestamps (arrival-placed when read live)
}

type profile struct {
	name string
	risk string
	segs []segment
}

func v(station string, outcome ...string) vspec {
	if len(outcome) > 0 {
		return vspec{station, outcome[0]}
	}
	return vspec{station: station}
}

// The cell profiles. Each covers one shape of real Factory work the Timeline must draw.
var (
	pClean = profile{"clean", "Medium", []segment{
		{visits: []vspec{v("plan"), v("audit"), v("build"), v("verify", "PASS"), v("review", "APPROVED")}},
		{visits: []vspec{v("merge")}},
	}}
	pVerifyFail = profile{"verify-fail-then-revise", "Medium", []segment{
		{visits: []vspec{v("plan"), v("build"), v("verify", "FAIL"), v("revise")}},
		{visits: []vspec{v("verify", "PASS"), v("review", "APPROVED"), v("merge")}},
	}}
	pReject = profile{"review-reject-then-approve", "Medium", []segment{
		{visits: []vspec{v("plan"), v("build"), v("verify", "PASS")}},
		{visits: []vspec{v("review", "REJECTED"), v("revise"), v("verify", "PASS")}},
		{visits: []vspec{v("review", "APPROVED"), v("merge")}},
	}}
	pEscalate = profile{"three-rounds-escalated", "Medium", []segment{
		{visits: []vspec{v("plan"), v("build"), v("verify", "FAIL"), v("revise")}},
		{visits: []vspec{v("verify", "PASS"), v("review", "REJECTED"), v("revise")}},
		{visits: []vspec{v("verify", "PASS"), v("review", "ESCALATE")}},
	}}
	pHuman = profile{"human-approval", "High", []segment{
		{visits: []vspec{v("plan"), v("build"), v("verify", "PASS"), v("review", "AWAITING_HUMAN")}, after: "human"},
		{visits: []vspec{v("merge")}},
	}}
	pHumanOpen = profile{"human-approval-open-at-end", "High", []segment{
		{visits: []vspec{v("plan"), v("build"), v("verify", "FAIL"), v("revise")}},
		{visits: []vspec{v("verify", "PASS"), v("review", "AWAITING_HUMAN")}, after: "human-open"},
	}}
	pInterrupted = profile{"interrupted-recovered-resumed", "Medium", []segment{
		{visits: []vspec{v("plan"), v("build")}, end: "interrupted", after: "recovery"},
		{visits: []vspec{v("resume"), v("verify", "PASS"), v("review", "APPROVED")}},
		{visits: []vspec{v("merge")}},
	}}
	pUnknown = profile{"merge-outcome-unknown", "Medium", []segment{
		{visits: []vspec{v("plan"), v("build"), v("verify", "PASS"), v("review", "APPROVED")}},
		{visits: []vspec{v("merge")}, end: "unknown"},
	}}
	pOpen = profile{"revising-at-the-end", "Medium", []segment{
		{visits: []vspec{v("plan"), v("build"), v("verify", "PASS"), v("review", "REJECTED")}},
		{visits: []vspec{v("revise"), v("verify", "PASS")}, end: "open"},
	}}
	pArrival = profile{"merge-by-main-loop", "Low", []segment{
		{visits: []vspec{v("plan"), v("audit"), v("build"), v("verify", "PASS"), v("review", "APPROVED")}},
		{visits: []vspec{v("merge")}, noWorkflow: true},
	}}
)

// The first twelve cells, in ticket order, and the cycle used beyond them.
var (
	firstProfiles = []profile{pClean, pVerifyFail, pReject, pHuman, pInterrupted, pEscalate, pUnknown, pVerifyFail, pReject, pArrival, pHumanOpen, pOpen}
	moreProfiles  = []profile{pClean, pVerifyFail, pReject, pHuman, pInterrupted, pUnknown}
)

var phaseTitles = []string{"Preflight", "Groom", "Build", "Verify", "Review", "Wrap up", "Learn"}

var fillerLabels = []string{"collect the evidence", "summarise the diff", "check the contracts", "read the plan", "list the changed files", "compare the spec", "read the board", "check the suite"}

var tools = []string{"Bash", "Read", "Edit", "Grep", "Write", "Glob", "StructuredOutput"}

const workflowConcurrency = 2 // reviewers beyond this wait in the queue

// ---- building one execution ----

func (w *world) lrec(c *cell, x *execution, t float64, typ, station string, visit, round int, data map[string]any) *lifeRec {
	r := &lifeRec{t: t, wt: t, typ: typ, station: station, visit: visit, round: round, data: data}
	if x != nil {
		r.exec = x.id
	}
	c.life = append(c.life, r)
	return r
}

func (w *world) setStage(c *cell, t float64, s string) {
	c.stage = s
	c.stages = append(c.stages, stageAt{t, s})
}

func (w *world) intakeAdd(t float64, typ, source string, c *cell, s *slice, x *execution, data map[string]any) *intakeRec {
	r := &intakeRec{t: t, wt: t, typ: typ, source: source, data: data}
	if s == nil && c != nil {
		s = c.slice
	}
	if s != nil {
		r.slice, r.rev, r.wave = s.id, s.rev, s.wave.id
	}
	if c != nil {
		r.ticket = c.ticket
	}
	if x != nil {
		r.exec = x.id
	}
	w.intake = append(w.intake, r)
	return r
}

func (w *world) newAgent(x *execution, label string, phase int, agentType, model string, queued, start, end float64) *agent {
	x.nextIndex++
	a := &agent{index: x.nextIndex, label: label, phase: phase, agentType: agentType, model: model, queued: queued, start: start, end: end, status: "done"}
	a.id = "a" + w.hex(16)
	dur := math.Min(end-start, 7200)
	a.calls = int64(2 + dur/12*w.between(0.6, 1.4))
	a.tokens = int64(8000 + dur*w.between(300, 900))
	x.agents = append(x.agents, a)
	return a
}

func (w *world) clerk(x *execution, label string, phase int, t float64) float64 {
	d := w.between(5, 14)
	w.newAgent(x, label, phase, "", "claude-haiku-5-5", t, t+0.012, t+d)
	return t + d + 0.02
}

// buildExecution lays out one execution of a cell starting at t0 (the claim) and returns it.
func (w *world) buildExecution(c *cell, seg segment, t0 float64) *execution {
	c.attempts++
	x := &execution{id: w.unique("x", 12), cell: c, attempt: c.attempts, seg: seg, claim: t0, workflow: !seg.noWorkflow,
		wfEnd: math.Inf(1), end: math.Inf(1), session: fmt.Sprintf("00000000-0000-4000-8000-%012x", len(w.execs)+1)}
	w.execs = append(w.execs, x)
	c.execs = append(c.execs, x)
	w.execFactsFor(x)
	w.intakeAdd(t0, "work.claimed", "supervisor", c, nil, x, map[string]any{"stage": c.stage, "next": nextAction(seg.visits[0]), "attempt": x.attempt})
	started := w.intakeAdd(t0+1, "execution.started", "supervisor", c, nil, x, map[string]any{"until": "merge", "workflow": "mach-belt",
		"limits": map[string]any{"minutes": 240, "budget_usd": 40}, "session_id": x.session})
	w.provenance(c, x, started)
	x.start = t0 + 2
	t := x.start + 1.5
	// The main loop looks before it starts the workflow: individually observable tool calls.
	for _, tool := range []string{"Bash", "Read"} {
		d := w.between(0.8, 3.5)
		x.calls = append(x.calls, w.call(tool, t, t+d, seg.noWorkflow))
		t += d + w.between(1, 4)
	}
	if seg.noWorkflow {
		t = w.mainLoopVisits(c, x, t)
	} else {
		t = w.workflowVisits(c, x, t)
	}
	if math.IsInf(t, 1) {
		return x // open at the end of the history
	}
	switch seg.end {
	case "interrupted", "unknown":
		x.end, x.ended = t+1, "interrupted"
	default:
		x.calls = append(x.calls, w.call("Bash", t+2, t+3.2, seg.noWorkflow))
		x.end, x.ended = t+6, "exited"
	}
	x.cost = math.Round(w.between(1.5, 9)*100) / 100
	w.usage(x)
	return x
}

func (w *world) call(tool string, called, ret float64, noTime bool) mainCall {
	w.toolSeq++
	return mainCall{id: fmt.Sprintf("toolu_SYN%06d", w.toolSeq), tool: tool, called: called, ret: ret, noTime: noTime}
}

func nextAction(vs vspec) string {
	switch vs.station {
	case "resume":
		return "build"
	case "plan":
		return "plan"
	}
	return vs.station
}

// workflowVisits runs the segment's visits inside a mach-belt Dynamic Workflow.
func (w *world) workflowVisits(c *cell, x *execution, t float64) float64 {
	x.taskID = fmt.Sprintf("task%04d", len(w.execs))
	x.toolUse = w.call("Workflow", t, t+0.043, false).id
	x.wfStart = t + 0.05
	t += 0.1
	for _, l := range []string{"locate the belt script", "check the project", "read the board"} {
		t = w.clerk(x, l, 1, t)
	}
	planned := 4
	for _, vs := range x.seg.visits {
		planned += 1
		if vs.station == "review" {
			planned += 5
		} else {
			planned++
		}
	}
	fill := 0
	if extra := w.o.AgentsPerExecution - planned; extra > 0 {
		fill = (extra + len(x.seg.visits) - 1) / len(x.seg.visits)
	}
	for i, vs := range x.seg.visits {
		t = w.clerk(x, c.ticket+": what next?", 1, t)
		last := i == len(x.seg.visits)-1
		var stop bool
		t, stop = w.visit(c, x, vs, t, fill, last)
		if stop || math.IsInf(t, 1) {
			return t
		}
	}
	if x.seg.end == "unknown" {
		// The next clerk starts, then the process is stopped: its end is never reported.
		a := w.newAgent(x, c.ticket+": what next?", 1, "", "claude-haiku-5-5", t, t+0.01, math.Inf(1))
		a.status = ""
		w.feature["outcome_unknown_execution"] = x.id
		return t + 6
	}
	t = w.clerk(x, c.ticket+": what next?", 1, t)
	x.wfEnd = t + 0.4
	return t + 2
}

// mainLoopVisits: an execution with no workflow; the main loop runs each station itself, and its
// records carry no timestamps.
func (w *world) mainLoopVisits(c *cell, x *execution, t float64) float64 {
	for _, vs := range x.seg.visits {
		for k := 0; k < 3; k++ {
			d := w.between(2, 9)
			x.calls = append(x.calls, w.call(tools[w.rng.IntN(3)], t, t+d, true))
			t += d + 1
		}
		t, _ = w.visitRecords(c, x, vs, t, t+w.between(90, 200))
	}
	w.feature["arrival_only_stream"] = x.id
	return t + 3
}

// visit runs one station visit inside the workflow: its agents and its lifecycle records. stop is
// true when the process is interrupted inside it.
func (w *world) visit(c *cell, x *execution, vs vspec, t float64, fill int, last bool) (float64, bool) {
	ticket := c.ticket
	model := "claude-sonnet-5-5"
	var worker *agent
	switch vs.station {
	case "plan":
		d := w.dur(300, 600, 0.35)
		worker = w.newAgent(x, "contract engineer", 2, "mach-contract-engineer", "claude-opus-5-5", t, t+0.02, t+d)
	case "audit":
		d := w.dur(60, 120, 0.3)
		worker = w.newAgent(x, "audit the repository", 1, "", "claude-sonnet-5-5", t, t+0.02, t+d)
	case "build", "resume", "revise":
		d := w.dur(1200, 2400, 0.65)
		label := ticket + ": build"
		if vs.station == "revise" {
			d = w.dur(600, 1500, 0.6)
			label = ticket + ": revise"
		}
		if x.seg.end == "open" {
			d = 1e7 // never ends inside the history
		}
		worker = w.newAgent(x, label, 3, "mach-builder", c.buildModel(), t, t+0.02, t+d)
	case "verify":
		worker = w.newAgent(x, ticket+": verify", 4, "mach-verifier", model, t, t+0.02, t+w.dur(500, 1000, 0.4))
	case "merge":
		worker = w.newAgent(x, ticket+": merge", 6, "", "claude-haiku-5-5", t, t+0.02, t+w.dur(90, 200, 0.3))
	case "review":
		return w.review(c, x, vs, t, fill)
	}
	if worker.end-worker.start > 1e6 {
		worker.end = math.Inf(1)
		worker.status = ""
	}
	w.fillers(x, worker, fill)
	end := worker.end
	if math.IsInf(end, 1) {
		end = worker.start + 1e7
	}
	interrupted := x.seg.end == "interrupted" && last
	if interrupted {
		end = worker.start + (end-worker.start)*0.45
	}
	stopAt, stopped := w.visitRecords(c, x, vs, worker.start+w.between(2, 5), end-w.between(2, 5))
	if interrupted {
		// The process stops here: every agent still running is never reported ended.
		cut := stopAt + 3
		for _, a := range x.agents {
			if a.end > cut {
				a.end, a.status = math.Inf(1), ""
				if a.start > cut {
					a.start = cut - 1
				}
			}
		}
		w.feature["interrupted_execution"] = x.id
		return cut, true
	}
	_ = stopped
	if math.IsInf(worker.end, 1) {
		return math.Inf(1), true
	}
	return worker.end + 0.02, false
}

// fillers add the helper agents that run beside a worker, some of them waiting in the queue.
func (w *world) fillers(x *execution, worker *agent, n int) {
	span := worker.end - worker.start
	if math.IsInf(span, 1) {
		span = 3600
	}
	for i := 0; i < n; i++ {
		start := worker.start + w.between(0.05, 0.9)*span
		queued := start - 0.01
		if w.rng.IntN(3) == 0 {
			queued = start - w.between(2, 40) // waited for a place in the workflow
		}
		if x.an != nil && queued < x.wfStart+0.05 {
			queued = x.wfStart + 0.05 // never queued before the workflow started (analytics mode only, so older outputs keep their bytes)
		}
		end := math.Min(start+w.between(15, 140), worker.end-0.5)
		if end <= start+1 {
			continue
		}
		w.newAgent(x, fillerLabels[w.rng.IntN(len(fillerLabels))], worker.phase, "", "claude-haiku-5-5", queued, start, end)
	}
}

func (w *world) review(c *cell, x *execution, vs vspec, t float64, fill int) (float64, bool) {
	ticket := c.ticket
	model := "claude-sonnet-5-5"
	if c.risk == "High" {
		model = "claude-opus-5-5"
	}
	t = w.clerk(x, ticket+": seat the panel", 5, t)
	entered := t - 2
	seats := w.reviewSeats(c)
	var reviewers []*agent
	free := []float64{}
	for i, seat := range seats {
		d := w.dur(400, 900, 0.4)
		start := t + 0.02
		if i >= workflowConcurrency {
			start = free[0] + 0.05 // queued until a reviewer finishes
		}
		a := w.newAgent(x, ticket+": "+seat+" reviewer", 5, "mach-reviewer", model, t, start, start+d)
		reviewers = append(reviewers, a)
		free = append(free, a.end)
		if len(free) > 1 && free[1] < free[0] {
			free[0], free[1] = free[1], free[0]
		}
	}
	done := 0.0
	for _, a := range reviewers {
		done = math.Max(done, a.end)
	}
	w.fillers(x, &agent{start: t, end: done, phase: 5}, fill)
	tally := w.clerk(x, ticket+": tally", 5, done+0.05)
	if c.an != nil {
		w.reviewRecordsA(c, x, vs, entered, reviewers, seats, tally-1)
		return tally, false
	}
	w.reviewRecords(c, x, vs, entered, reviewers, tally-1)
	return tally, false
}

// ---- lifecycle records per visit ----

func (w *world) nextVisit(c *cell, station string) int {
	c.visits[station]++
	return c.visits[station]
}

func (w *world) visitRecords(c *cell, x *execution, vs vspec, from, to float64) (float64, bool) {
	station := vs.station
	data := map[string]any{"stage": c.stage}
	switch vs.station {
	case "revise":
		station = "build"
		c.round++
		data["revision"] = c.round
		data["findings_copied"] = true
	case "resume":
		station = "build"
		data["resumed"] = true
		data["unclosed_visit"] = fmt.Sprintf("build#%d", c.visits["build"])
		w.feature["resumed_visit"] = c.ticket + "/build#" + fmt.Sprint(c.visits["build"]+1)
	}
	round := c.round
	if station == "plan" || station == "audit" || station == "merge" {
		round = 0
	}
	n := w.nextVisit(c, station)
	interrupted := x != nil && x.seg.end == "interrupted" && (vs.station == "build")
	span := to - from
	open := span > 1e6
	if open {
		span = 5000 // an open visit: its records are spread as if it took this long
	}
	at := func(f float64) float64 { return from + f*span }
	late := func(f float64) float64 {
		if open {
			return to - 3 // after the end of the history: never written
		}
		return at(f)
	}
	rec := func(t float64, typ string, d map[string]any) *lifeRec {
		return w.lrec(c, x, t, typ, station, n, round, d)
	}
	switch station {
	case "plan":
		rec(from, "station.entered", data)
		rec(at(0.9), "gate.evaluated", map[string]any{"gate": "plan.check", "outcome": "pass", "reason_code": nil})
		rec(to, "station.exited", map[string]any{"outcome": "planned", "stage": "planned", "app_type": c.appType(), "risk": c.risk, "contracts": 1, "tasks": 4})
		w.setStage(c, to, "planned")
	case "audit":
		rec(from, "station.entered", data)
		rec(at(0.8), "gate.evaluated", map[string]any{"gate": "audit.readiness", "outcome": "pass", "audit_tier": "Gold", "reason_code": nil})
		rec(to, "station.exited", map[string]any{"outcome": "Gold", "stage": c.stage})
	case "build":
		tasks := 2 + w.rng.IntN(2)
		if vs.station == "revise" {
			tasks = 1 + w.rng.IntN(2)
		}
		data["tasks"] = tasks * 2
		data["head"] = c.head
		w.setStage(c, from, "building")
		data["stage"] = "building"
		rec(from, "station.entered", data)
		rec(at(0.02), "gate.evaluated", map[string]any{"gate": "build.start", "outcome": "pass", "reason_code": nil, "audit_tier": "Gold"})
		prefix := ""
		if vs.station == "revise" {
			prefix = fmt.Sprintf("R%d-", c.round)
		}
		steps := tasks * 2
		for k := 0; k < steps; k++ {
			ft := at(0.05 + 0.9*float64(k+1)/float64(steps+1))
			if interrupted && k >= 1 {
				return ft, true
			}
			task := fmt.Sprintf("%sT%d", prefix, k+1)
			if k%2 == 0 {
				if w.oneIn(4, 30) {
					rec(ft-20, "gate.evaluated", map[string]any{"gate": "build.red", "outcome": "refuse", "reason_code": "suite-green", "task": task})
				}
				c.head = w.commit()
				fr := w.buildStep(c, rec, ft, task, true)
				rec(ft, "build.task_completed", map[string]any{"task": task, "kind": "test", "step": "red", "first_run": fr, "suite": "red", "commit": c.head})
			} else {
				if w.oneIn(3, 25) {
					g1 := rec(ft-40, "gate.evaluated", map[string]any{"gate": "build.green", "outcome": "refuse", "reason_code": "suite-failing", "task": task})
					g2 := rec(ft-25, "gate.evaluated", map[string]any{"gate": "build.green", "outcome": "refuse", "reason_code": "suite-failing", "task": task})
					if _, done := w.feature["late_lifecycle_batch"]; !done && x != nil && x.seg.end == "" {
						// A late, out-of-order batch: written after the task that followed them.
						g1.wt, g2.wt = ft+30, ft+30.001
						w.feature["late_lifecycle_batch"] = c.ticket + "/build#" + fmt.Sprint(n)
					}
				}
				c.head = w.commit()
				rec(ft, "build.task_completed", map[string]any{"task": task, "kind": "impl", "step": "green", "first_run": "pass", "suite": "green", "commit": c.head})
				w.buildStep(c, rec, ft, task, false)
			}
		}
		rec(late(0.97), "gate.evaluated", map[string]any{"gate": "build.finish", "outcome": "pass", "reason_code": nil})
		rec(to, "station.exited", map[string]any{"outcome": "built", "stage": "built", "head": c.head, "tasks_done": steps})
		w.setStage(c, to, "built")
	case "verify":
		items := []string{"AC-01", "AC-02", "AC-03", "R1", "R2"}[:3+w.rng.IntN(3)]
		rec(from, "station.entered", map[string]any{"stage": c.stage, "head": c.head, "items": len(items), "suite_passed": true, "contracts_valid": true})
		rec(at(0.03), "gate.evaluated", map[string]any{"gate": "verify.start", "outcome": "pass", "reason_code": nil})
		fail := vs.outcome == "FAIL"
		for k, item := range items {
			result := "pass"
			if fail && k == len(items)-1 {
				result = "fail"
			}
			kind := "scenario"
			if item[0] == 'R' {
				kind = "matrix rule"
			}
			file := fmt.Sprintf("evidence/%s-r%d.txt", item, round)
			body := []byte(fmt.Sprintf("synthetic evidence: %s %s round %d (%s)\n", c.ticket, item, round, result))
			sum := sha256.Sum256(body)
			c.files[file] = body
			if result == "fail" {
				w.verifyFact(c, item, kind, true)
			}
			rec(at(0.1+0.8*float64(k)/float64(len(items))), "verify.check_recorded", map[string]any{"item": item, "kind": kind, "result": result,
				"evidence": []any{map[string]any{"path": file, "sha256": hex.EncodeToString(sum[:])}}})
		}
		verdict, stage := "PASS", "verified"
		if !fail {
			w.verifyFact(c, "", "", false)
		}
		if fail {
			verdict, stage = "FAIL_WITH_EVIDENCE", "built"
		}
		rec(at(0.95), "gate.evaluated", map[string]any{"gate": "verify.verdict", "outcome": "pass", "reason_code": verdict})
		rec(to, "station.exited", map[string]any{"outcome": verdict, "stage": stage})
		w.setStage(c, to, stage)
	case "merge":
		method, pr := "local", any(nil)
		if c.an != nil && c.an.method == "pr" {
			method, pr = "pr", c.an.pr
		}
		rec(from, "station.entered", map[string]any{"stage": c.stage, "method": method, "behind_main": false})
		rec(at(0.3), "gate.evaluated", map[string]any{"gate": "merge.run", "outcome": "pass", "reason_code": nil})
		mc := w.commit()
		rec(at(0.8), "merge.completed", map[string]any{"method": method, "approved_commit": c.head, "landed_commit": c.head, "merge_commit": mc, "revalidated": false, "pull_request": pr})
		if c.an != nil {
			c.an.mergeCommit, c.an.mergedAt = mc, at(0.8)
		}
		rec(to, "station.exited", map[string]any{"outcome": "merged", "stage": "merged"})
		w.setStage(c, to, "merged")
		c.merged = to
		c.head = mc
	}
	if x != nil {
		x.stations = append(x.stations, station)
	}
	return to, false
}

func (w *world) reviewRecords(c *cell, x *execution, vs vspec, from float64, reviewers []*agent, to float64) {
	n := w.nextVisit(c, "review")
	round := c.round
	rec := func(t float64, typ string, d map[string]any) *lifeRec {
		return w.lrec(c, x, t, typ, "review", n, round, d)
	}
	seats := []string{"architecture", "security", "product"}
	models := map[string]any{}
	for i, s := range seats {
		models[s] = reviewers[i].model
	}
	needed, human := 2, false
	if c.risk == "High" {
		needed, human = 3, true
	}
	rec(from, "station.entered", map[string]any{"stage": c.stage, "head": c.head, "round": round})
	rec(from+1, "review.round_started", map[string]any{"round": round, "max_rounds": 3, "risk": c.risk, "tuning": false, "seats": seats,
		"models": models, "approvals_needed": needed, "human_approval_required": human, "delta": round > 1})
	votes := map[string]any{}
	approvals, blockers := 0, 0
	for i, seat := range seats {
		vote, b := "APPROVE", 0
		switch vs.outcome {
		case "REJECTED", "ESCALATE":
			if seat != "product" {
				vote, b = "REJECT", 1+i
			}
		}
		if vote == "APPROVE" {
			approvals++
		}
		blockers += b
		votes[seat] = vote
		rules := []any{}
		if b > 0 {
			rules = append(rules, fmt.Sprintf("FR-%02d", 1+i), "R1")
		}
		rec(reviewers[i].end-1, "review.verdict_submitted", map[string]any{"round": round, "seat": seat, "vote": vote, "blockers": b, "notes": 1 + w.rng.IntN(3), "rules": rules})
	}
	stage := map[string]string{"APPROVED": "approved", "AWAITING_HUMAN": "awaiting-human", "REJECTED": "built", "ESCALATE": "blocked"}[vs.outcome]
	rec(to-1, "review.decided", map[string]any{"round": round, "decision": vs.outcome, "approvals": approvals, "needed": needed, "votes": votes,
		"blockers": blockers, "security_veto": vs.outcome != "APPROVED" && vs.outcome != "AWAITING_HUMAN", "human_approval_required": human})
	rec(to, "station.exited", map[string]any{"outcome": vs.outcome, "stage": stage})
	w.setStage(c, to, stage)
	x.stations = append(x.stations, "review")
	if vs.outcome == "AWAITING_HUMAN" || vs.outcome == "ESCALATE" {
		reason := "a person must approve a High-risk change"
		if vs.outcome == "ESCALATE" {
			reason = "three judging rounds used: escalated to a person"
			w.feature["escalated_ticket"] = c.ticket
		}
		w.intakeAdd(to+2, "human.required", "supervisor", c, nil, nil, map[string]any{"reason": reason})
	}
}
