package synth

// The analytics mode (Options.Analytics, mach-synth --analytics): a project fit for Factory
// Analytics. Hundreds of tickets over many delivery waves and weeks, each run to its end by the
// same scheduler and execution model as the Timeline history, plus what analytics needs and the
// Timeline did not: every finished cell archived with the run record exactly as the cleanup
// station writes it (skills/cleanup/scripts/cleanup.py run_record), abandoned and escalated
// tickets, security vetoes, single-seat Low-risk panels, gate overrides with their deviations,
// per-model cost and token categories per execution (and executions whose usage was never
// recorded), duplicate and late lines, and cells whose lifecycle history is partial or absent.
//
// It also writes expected.json: ground truth computed from the generator's own plan (the model
// below), never by reading the files back or asking the observer, for metric tests to compare with.
//
// Nothing here runs unless Options.Analytics is set: without it the generator's output is
// byte-identical to what it was before this file existed (compat_test.go).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"time"
)

// ExpectedFile is the ground-truth sidecar an analytics project carries.
const ExpectedFile = "expected.json"

func (o *Options) analyticsDefaults() {
	if o.Cells == 0 {
		o.Cells = 300
	}
	if o.Waves == 0 {
		o.Waves = max(1, (o.Cells+7)/8)
	}
	if o.Hours == 0 {
		o.Hours = 24 * 21
	}
	if o.End.IsZero() {
		o.End = DefaultEnd
	}
	if o.AgentsPerExecution == 0 {
		o.AgentsPerExecution = 12
	}
	if o.MaxParallel == 0 {
		o.MaxParallel = 4
	}
}

func (o Options) analyticsCheck() error {
	switch {
	case o.Out == "":
		return fmt.Errorf("an output folder is required")
	case o.Cells < 1 || o.Cells > 2000:
		return fmt.Errorf("with --analytics, cells must be between 1 and 2000")
	case o.Waves < 1 || o.Waves > o.Cells:
		return fmt.Errorf("with --analytics, waves must be between 1 and the number of cells")
	case o.Hours < 1 || o.Hours > 24*120:
		return fmt.Errorf("with --analytics, hours must be between 1 and 2880")
	case o.Events < 0:
		return fmt.Errorf("events cannot be negative")
	case o.AgentsPerExecution < 8 || o.AgentsPerExecution > 400:
		return fmt.Errorf("agents per execution must be between 8 and 400")
	case o.MaxParallel < 1 || o.MaxParallel > 32:
		return fmt.Errorf("with --analytics, max parallel must be between 1 and 32")
	}
	return nil
}

// ---- what analytics adds to the model ----

type analyticsWorld struct {
	dupIntake  int      // intake lines written twice (identically; the observer drops the copy by seq)
	partial    []string // archived cells whose lifecycle log starts late (the cell predates its telemetry)
	noLog      []string // archived cells with no lifecycle log at all
	nullSeq    int      // lifecycle records written with a null seq
	blockedEnd []string // slices that never get a cell: they wait on an abandoned ticket
}

type deviation struct{ typ, task, detail string }

type blocker struct {
	round       int
	seat, rule  string
	title, file string
}

type cellFacts struct {
	appType       string
	method        string // local | pr
	pr            int
	title         string
	abandonAt     float64 // a person abandons the ticket (cleanup --abandon); 0 if never
	abandonReason string
	closedAt      float64 // cleanup ran: the run record's closed_at; 0 if the ticket is not finished
	outcome       string  // merged | abandoned | "" (not finished)
	escalated     bool
	human         bool // a person's approval was recorded
	verifyFails   int
	verifyPasses  int
	rejections    int // decisions REJECTED or ESCALATE
	vetoes        int
	decisions     map[string]int
	redFail       int // test tasks seen failing first
	redPass       int // test tasks passing on their first run (an override)
	deviations    []deviation
	blockers      []blocker
	notes         []blocker // a note: no rule
	findings      []string  // verification failures, as verify.py words them
	partial       bool
	noLog         bool
	nullSeq       int // the n-th written record gets a null seq (0: none)
	approvedHead  string
	mergeCommit   string
	mergedAt      float64
}

type modelUse struct {
	model                    string
	cost                     float64
	input, output            int64
	cacheRead, cacheCreation int64
}

type execFacts struct {
	mainModel string
	noUsage   bool // the run ended without a result: no usage, no cost recorded
	usage     []modelUse
}

func (c *cell) appType() string {
	if c.an == nil {
		return "cli"
	}
	return c.an.appType
}

func (x *execution) mainModel() string {
	if x.an == nil || x.an.mainModel == "" {
		return "claude-opus-5-5"
	}
	return x.an.mainModel
}

// ---- profiles ----

func withAfter(p profile, name, after string) profile {
	segs := append([]segment(nil), p.segs...)
	last := segs[len(segs)-1]
	last.after = after
	segs[len(segs)-1] = last
	return profile{name, p.risk, segs}
}

var (
	aCleanLow = profile{"clean-low-single-seat", "Low", pClean.segs}
	aTwoFails = profile{"verify-fails-twice-then-merged", "Medium", []segment{
		{visits: []vspec{v("plan"), v("build"), v("verify", "FAIL"), v("revise")}},
		{visits: []vspec{v("verify", "FAIL"), v("revise")}},
		{visits: []vspec{v("verify", "PASS"), v("review", "APPROVED"), v("merge")}},
	}}
	aVeto = profile{"security-veto-then-approved", "Medium", []segment{
		{visits: []vspec{v("plan"), v("build"), v("verify", "PASS")}},
		{visits: []vspec{v("review", "VETO"), v("revise"), v("verify", "PASS")}},
		{visits: []vspec{v("review", "APPROVED"), v("merge")}},
	}}
	aEscalateAbandon = withAfter(pEscalate, "escalated-then-abandoned", "abandon")
	aAbandon         = profile{"abandoned-by-a-person", "Medium", []segment{
		{visits: []vspec{v("plan"), v("build"), v("verify", "FAIL")}, after: "abandon"},
	}}
	aHighClean = profile{"high-risk-human-approval", "High", pHuman.segs}
)

// The analytics mix, by weight. Open-at-the-end shapes are placed by hand (setupAnalytics).
var analyticsMix = []struct {
	p      profile
	weight int
}{
	{pClean, 26}, {aCleanLow, 10}, {pVerifyFail, 12}, {aTwoFails, 4}, {pReject, 8}, {aVeto, 5}, {aEscalateAbandon, 4},
	{aHighClean, 9}, {pInterrupted, 5}, {pUnknown, 3}, {aAbandon, 3}, {pArrival, 3},
}

func merges(p profile) bool {
	switch p.name {
	case aEscalateAbandon.name, aAbandon.name, pEscalate.name, pOpen.name, pHumanOpen.name:
		return false
	}
	return true
}

var appTypes = []struct {
	name   string
	weight int
}{{"cli", 30}, {"web", 25}, {"api", 18}, {"library", 10}, {"grpc", 6}, {"desktop", 6}, {"mobile", 5}}

var blockerRules = []string{"FR-01", "FR-02", "FR-03", "INV-01", "INV-02", "AC-02", "R1", "R3"}
var blockerTitles = []string{"error message differs from the spec", "input not validated at the boundary", "a rule of the decision matrix is not covered",
	"files changed outside the plan", "failure path leaves partial state", "secret read from the environment is logged"}
var noteTitles = []string{"naming could be clearer", "a helper duplicates an existing one", "test names do not say the rule", "comment is out of date"}

func (w *world) pickProfile() profile {
	total := 0
	for _, m := range analyticsMix {
		total += m.weight
	}
	n := w.rng.IntN(total)
	for _, m := range analyticsMix {
		if n < m.weight {
			return m.p
		}
		n -= m.weight
	}
	return pClean
}

func (w *world) pickAppType() string {
	total := 0
	for _, a := range appTypes {
		total += a.weight
	}
	n := w.rng.IntN(total)
	for _, a := range appTypes {
		if n < a.weight {
			return a.name
		}
		n -= a.weight
	}
	return "cli"
}

// setupAnalytics lays out the waves, slices, cells and dependencies.
func (w *world) setupAnalytics() {
	o := w.o
	n := o.Cells
	w.an = &analyticsWorld{}
	// Waves arrive spread over the work the line can do: about 4,600 model seconds of execution
	// per ticket, max_parallel at a time.
	span := float64(n) * 4600 / float64(o.MaxParallel)
	for i := 0; i < o.Waves; i++ {
		w.waves = append(w.waves, &wave{id: fmt.Sprintf("WAVE-%03d", i+1), at: 300 + span*0.85*float64(i)/float64(o.Waves)})
	}
	profiles := make([]profile, n)
	for i := range profiles {
		if n <= 2 {
			profiles[i] = []profile{pClean, pVerifyFail}[i]
			continue
		}
		profiles[i] = w.pickProfile()
	}
	if n >= 20 {
		// Work still open when the history ends: a revision in progress, a person's approval not
		// yet given, a ticket escalated and not yet decided. Among the last tickets dispatched.
		profiles[n-2], profiles[n-5], profiles[n-8] = pOpen, pHumanOpen, pEscalate
	}
	for i := 0; i < n; i++ {
		wv := w.waves[i*o.Waves/n]
		s := &slice{id: fmt.Sprintf("SLICE-%03d", i+1), n: i, wave: wv, ticket: fmt.Sprintf("SYN-%03d", i+1), rev: 1}
		prof := profiles[i]
		c := &cell{n: i, ticket: s.ticket, slice: s, prof: prof, risk: prof.risk, round: 1, visits: map[string]int{}, heldSince: -1,
			files: map[string][]byte{}}
		c.an = &cellFacts{appType: w.pickAppType(), method: "local", title: "Synthetic slice " + fmt.Sprint(i+1), decisions: map[string]int{}}
		if w.rng.IntN(100) < 35 {
			c.an.method, c.an.pr = "pr", 100+i
		}
		s.cell = c
		wv.slices = append(wv.slices, s)
		w.slices = append(w.slices, s)
		w.cells = append(w.cells, c)
	}
	// Dependencies: on an earlier slice whose ticket will be integrated, in the same or an earlier
	// wave. A few slices are blocked twice: a new revision adds a second dependency (superseded).
	for i := 1; i < n; i++ {
		if w.rng.IntN(100) >= 25 {
			continue
		}
		var pool []*cell
		for j := 0; j < i; j++ {
			if merges(w.cells[j].prof) {
				pool = append(pool, w.cells[j])
			}
		}
		if len(pool) == 0 {
			continue
		}
		s := w.slices[i]
		s.phases = append(s.phases, []*cell{pool[w.rng.IntN(len(pool))]})
		if w.rng.IntN(100) < 16 && len(pool) > 1 {
			next := pool[w.rng.IntN(len(pool))]
			if next != s.phases[0][0] {
				s.phases = append(s.phases, []*cell{next})
			}
		}
	}
	// Facts about the files: partial and absent lifecycle logs, a null seq.
	partialDue := true // at least one partial log, on the first merging cell from a third of the way in
	for i, c := range w.cells {
		if !merges(c.prof) || n < 10 {
			continue
		}
		switch {
		case i >= n/2 && n >= 40 && !w.anyNoLog():
			c.an.noLog = true
		case i >= n/3 && partialDue:
			c.an.partial, partialDue = true, false
		case w.rng.IntN(100) < 3:
			c.an.partial = true
		}
		if w.rng.IntN(60) == 0 {
			c.an.nullSeq = 3
		}
	}
	// A slice that never gets a cell: it waits for an abandoned ticket for the whole history.
	if n >= 20 {
		for _, c := range w.cells {
			if c.prof.name == aEscalateAbandon.name || c.prof.name == aAbandon.name {
				last := w.waves[len(w.waves)-1]
				extra := &slice{id: fmt.Sprintf("SLICE-%03d", n+1), n: n, wave: last, ticket: fmt.Sprintf("SYN-%03d", n+1), rev: 1}
				extra.phases = [][]*cell{{c}}
				last.slices = append(last.slices, extra)
				w.slices = append(w.slices, extra)
				w.an.blockedEnd = append(w.an.blockedEnd, extra.id)
				break
			}
		}
	}
}

func (w *world) anyNoLog() bool {
	for _, c := range w.cells {
		if c.an.noLog {
			return true
		}
	}
	return false
}

// loopCap bounds the simulation in model seconds.
func (w *world) loopCap() float64 {
	if w.an != nil {
		return 2e7
	}
	return 2e6
}

// execFactsFor draws the main loop's model when an execution is created.
func (w *world) execFactsFor(x *execution) {
	if w.an == nil {
		return
	}
	x.an = &execFacts{mainModel: "claude-opus-5-5"}
	if w.rng.IntN(100) < 15 {
		x.an.mainModel = "claude-fable-5-2"
	}
}

var modelWeight = map[string]float64{"claude-fable-5-2": 2.2, "claude-opus-5-5": 1.6, "claude-sonnet-5-5": 1.0, "claude-haiku-5-5": 0.15}

// usage draws what Claude Code reports for a finished execution: one entry per model that ran,
// the cost in dollars and the four token categories. The execution's recorded cost is their sum.
func (w *world) usage(x *execution) {
	if x.an == nil {
		return
	}
	set := map[string]bool{x.an.mainModel: true}
	for _, a := range x.agents {
		set[a.model] = true
	}
	models := make([]string, 0, len(set))
	for m := range set {
		models = append(models, m)
	}
	sort.Strings(models)
	total := 0.0
	x.an.usage = nil
	for _, m := range models {
		u := modelUse{model: m, cost: math.Round(w.between(0.2, 3.5)*modelWeight[m]*1e4) / 1e4,
			input: int64(w.between(400, 4000)), output: int64(w.between(5000, 60000)),
			cacheRead: int64(w.between(1e5, 2e6)), cacheCreation: int64(w.between(1e4, 2e5))}
		total += u.cost
		x.an.usage = append(x.an.usage, u)
	}
	x.cost = math.Round(total*1e4) / 1e4
	if x.seg.end == "" && w.rng.IntN(20) == 0 {
		x.an.noUsage = true // the stream lost its result: no usage, and execution.completed carries no cost
	}
}

// ---- lifecycle facts recorded while visiting ----

func (w *world) buildStep(c *cell, rec func(float64, string, map[string]any) *lifeRec, ft float64, task string, red bool) (firstRun string) {
	if c.an == nil {
		if red {
			return "fail"
		}
		return "pass"
	}
	if red {
		if w.rng.IntN(16) == 0 {
			c.an.redPass++
			c.an.deviations = append(c.an.deviations, deviation{"test-passed-first-run", task, "the behaviour was already covered by an earlier task"})
			rec(ft+1, "gate.evaluated", map[string]any{"gate": "red-before-green", "outcome": "override", "reason_code": "test-passed-first-run",
				"overridden_by_reason": true, "task": task})
			return "pass"
		}
		c.an.redFail++
		return "fail"
	}
	if w.rng.IntN(25) == 0 {
		c.an.deviations = append(c.an.deviations, deviation{"files-outside-plan", task, "a shared fixture needed one more field"})
		rec(ft+1, "gate.evaluated", map[string]any{"gate": "scope", "outcome": "override", "reason_code": "files-outside-plan",
			"overridden_by_reason": true, "task": task})
	}
	return "pass"
}

func (w *world) verifyFact(c *cell, item, kind string, fail bool) {
	if c.an == nil {
		return
	}
	if fail {
		c.an.verifyFails++
		c.an.findings = append(c.an.findings, fmt.Sprintf("%s (%s): the observed outcome differs from the expected one", item, kind))
	} else {
		c.an.verifyPasses++
	}
}

// reviewSeats are the panel's seats for a cell.
func (w *world) reviewSeats(c *cell) []string {
	if c.an != nil && c.risk == "Low" {
		return []string{"general"}
	}
	return []string{"architecture", "security", "product"}
}

// reviewRecordsA is reviewRecords for the analytics mode: the panel the risk tier asks for, votes
// that follow from findings, the security veto, and the findings themselves for the run record.
func (w *world) reviewRecordsA(c *cell, x *execution, vs vspec, from float64, reviewers []*agent, seats []string, to float64) {
	n := w.nextVisit(c, "review")
	round := c.round
	rec := func(t float64, typ string, d map[string]any) *lifeRec {
		return w.lrec(c, x, t, typ, "review", n, round, d)
	}
	models := map[string]any{}
	for i, s := range seats {
		models[s] = reviewers[i].model
	}
	needed, human := 2, false
	switch c.risk {
	case "High":
		needed, human = 3, true
	case "Low":
		needed = 1
	}
	rec(from, "station.entered", map[string]any{"stage": c.stage, "head": c.head, "round": round})
	rec(from+1, "review.round_started", map[string]any{"round": round, "max_rounds": 3, "risk": c.risk, "tuning": false, "seats": anyList(seats),
		"models": models, "approvals_needed": needed, "human_approval_required": human, "delta": round > 1})
	rejecting := map[string]bool{}
	switch vs.outcome {
	case "REJECTED":
		rejecting["architecture"], rejecting["product"], rejecting["general"] = true, true, true
	case "VETO":
		rejecting["security"] = true
	case "ESCALATE":
		rejecting["architecture"], rejecting["security"], rejecting["general"] = true, true, true
	}
	votes := map[string]any{}
	approvals, blockers := 0, 0
	for i, seat := range seats {
		vote, k := "APPROVE", 0
		rules := []any{}
		if rejecting[seat] {
			vote, k = "REJECT", 1+w.rng.IntN(2)
			for j := 0; j < k; j++ {
				rule := blockerRules[w.rng.IntN(len(blockerRules))]
				rules = append(rules, rule)
				c.an.blockers = append(c.an.blockers, blocker{round: round, seat: seat, rule: rule, title: blockerTitles[w.rng.IntN(len(blockerTitles))],
					file: fmt.Sprintf("src/synthetic/module_%d.py", 1+w.rng.IntN(9))})
			}
		} else {
			approvals++
		}
		notes := w.rng.IntN(3)
		for j := 0; j < notes; j++ {
			c.an.notes = append(c.an.notes, blocker{round: round, seat: seat, title: noteTitles[w.rng.IntN(len(noteTitles))],
				file: fmt.Sprintf("src/synthetic/module_%d.py", 1+w.rng.IntN(9))})
		}
		blockers += k
		votes[seat] = vote
		rec(reviewers[i].end-1, "review.verdict_submitted", map[string]any{"round": round, "seat": seat, "vote": vote, "blockers": k, "notes": notes, "rules": rules})
	}
	decision := vs.outcome
	if decision == "VETO" {
		decision = "REJECTED"
	}
	veto := rejecting["security"] && contains(seats, "security")
	stage := map[string]string{"APPROVED": "approved", "AWAITING_HUMAN": "awaiting-human", "REJECTED": "built", "ESCALATE": "blocked"}[decision]
	rec(to-1, "review.decided", map[string]any{"round": round, "decision": decision, "approvals": approvals, "needed": needed, "votes": votes,
		"blockers": blockers, "security_veto": veto, "human_approval_required": human})
	rec(to, "station.exited", map[string]any{"outcome": decision, "stage": stage})
	w.setStage(c, to, stage)
	x.stations = append(x.stations, "review")
	c.an.decisions[decision]++
	if decision == "REJECTED" || decision == "ESCALATE" {
		c.an.rejections++
	}
	if veto {
		c.an.vetoes++
	}
	if decision == "ESCALATE" {
		c.an.escalated = true
	}
	if decision == "APPROVED" || decision == "AWAITING_HUMAN" {
		c.an.approvedHead = c.head
	}
	if decision == "AWAITING_HUMAN" || decision == "ESCALATE" {
		reason := "a person must approve a High-risk change"
		if decision == "ESCALATE" {
			reason = "three judging rounds used: escalated to a person"
			w.feature["escalated_ticket"] = c.ticket
		}
		w.intakeAdd(to+2, "human.required", "supervisor", c, nil, nil, map[string]any{"reason": reason})
	}
}

func anyList(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}

func contains(s []string, v string) bool {
	for _, e := range s {
		if e == v {
			return true
		}
	}
	return false
}

// humanApproved records the rest of a person's approval as review.py approve-human does.
func (w *world) humanApproved(c *cell, ta float64, visit int) {
	if c.an == nil {
		return
	}
	c.an.human = true
	w.lrec(c, nil, ta+0.5, "station.exited", "human-approval", visit, c.round, map[string]any{"outcome": "approved", "stage": "approved"})
}

// ---- the end of a ticket ----

// abandon: a person gives the ticket up some time after its last execution.
func (w *world) abandon(c *cell, x *execution) {
	c.an.abandonAt = x.end + w.between(1800, 7200)
	c.an.abandonReason = "a person stopped this slice: the approach needs a new design"
	if c.stage == "blocked" {
		c.an.abandonReason = "escalated after three judging rounds; a person decided to drop it"
	}
	c.done = true
}

// cleanupA closes a finished cell as the cleanup station does: its records go only into the
// archived copy of the log, and the run record is written (write.go appendRunA).
func (w *world) cleanupA(c *cell, t float64, outcome string) {
	n := w.nextVisit(c, "cleanup")
	archive := ".factory/archive/" + c.ticket + ".tar.gz"
	for _, r := range []*lifeRec{
		{t: t, typ: "gate.evaluated", data: map[string]any{"gate": "cleanup.run", "outcome": "pass", "reason_code": nil, "overridden_by_reason": false}},
		{t: t + 1, typ: "station.entered", data: map[string]any{"stage": c.stage}},
		{t: t + 4, typ: "cleanup.completed", data: map[string]any{"outcome": outcome, "archive": archive, "bundle": outcome == "abandoned", "uncommitted_saved": false}},
		{t: t + 5, typ: "station.exited", data: map[string]any{"outcome": outcome}},
	} {
		r.wt, r.station, r.visit, r.archive = r.t, "cleanup", n, true
		c.life = append(c.life, r)
	}
	c.archived = true
	c.an.closedAt = t + 6
	c.an.outcome = outcome
}

// analyticsPass runs the abandonments that are due.
func (w *world) analyticsPass(t float64) {
	for _, c := range w.cells {
		if c.an.abandonAt > 0 && c.an.closedAt == 0 && c.an.abandonAt <= t {
			w.cleanupA(c, c.an.abandonAt, "abandoned")
		}
	}
}

// analyticsSettled: no abandonment is still to come.
func (w *world) analyticsSettled(t float64) bool {
	for _, c := range w.cells {
		if c.an.abandonAt > 0 && (c.an.closedAt == 0 || c.an.closedAt > t) {
			return false
		}
	}
	return true
}

// ---- the run record, exactly as cleanup.py writes it ----

// kv is an ordered JSON object, written the way Python's json.dumps writes a dict.
type kv struct {
	k string
	v any
}

type obj []kv

func pyJSON(buf *bytes.Buffer, v any) {
	switch x := v.(type) {
	case nil:
		buf.WriteString("null")
	case obj:
		buf.WriteByte('{')
		for i, e := range x {
			if i > 0 {
				buf.WriteString(", ")
			}
			pyJSON(buf, e.k)
			buf.WriteString(": ")
			pyJSON(buf, e.v)
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				buf.WriteString(", ")
			}
			pyJSON(buf, e)
		}
		buf.WriteByte(']')
	case string:
		var b bytes.Buffer
		enc := json.NewEncoder(&b)
		enc.SetEscapeHTML(false)
		enc.Encode(x)
		buf.Write(bytes.TrimRight(b.Bytes(), "\n"))
	case bool:
		if x {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case int:
		fmt.Fprint(buf, x)
	default:
		panic(fmt.Sprintf("pyJSON: %T", v))
	}
}

// pyTime is datetime.now(timezone.utc).isoformat(timespec="seconds").
func (w *world) pyTime(t float64) string {
	return time.UnixMilli(w.ms(t)).UTC().Truncate(time.Second).Format("2006-01-02T15:04:05") + "+00:00"
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (w *world) runRecord(c *cell) obj {
	f := c.an
	s := c.slice
	var integration any
	if f.outcome == "merged" {
		var pr any
		if f.method == "pr" {
			pr = fmt.Sprintf("pull/%d", f.pr)
		}
		integration = obj{{"branch", "feature/" + c.ticket}, {"into", "main"}, {"method", f.method}, {"approved_commit", nullable(f.approvedHead)},
			{"landed_commit", nullable(f.approvedHead)}, {"merge_commit", nullable(f.mergeCommit)}, {"pull_request", pr}, {"merged_at", w.pyTime(f.mergedAt)}}
	}
	devs := []any{}
	for _, d := range f.deviations {
		devs = append(devs, obj{{"type", d.typ}, {"task", nullable(d.task)}, {"detail", d.detail}})
	}
	blockers := []any{}
	for _, b := range f.blockers {
		blockers = append(blockers, obj{{"round", b.round}, {"reviewer", b.seat}, {"rule", nullable(b.rule)}, {"title", b.title}, {"file", nullable(b.file)}})
	}
	notes := []any{}
	for _, b := range f.notes {
		notes = append(notes, obj{{"round", b.round}, {"reviewer", b.seat}, {"title", b.title}, {"file", nullable(b.file)}})
	}
	findings := []any{}
	for _, s := range f.findings {
		findings = append(findings, s)
	}
	var reason any
	if f.outcome == "abandoned" {
		reason = f.abandonReason
	}
	return obj{
		{"record_version", 2},
		{"integration", integration},
		{"product", obj{{"slice_id", s.id}, {"revision", s.rev}, {"wave_id", s.wave.id}, {"digest", s.digest}, {"source_commit", nil}}},
		{"ticket_id", c.ticket}, {"slice_id", s.id}, {"title", f.title},
		{"risk", c.risk}, {"app_type", f.appType},
		{"mode", "headless"},
		{"outcome", f.outcome}, {"abandon_reason", reason},
		{"rounds", c.round}, {"first_pass", f.outcome == "merged" && c.round == 1},
		{"verify_failures", f.verifyFails},
		{"review_rejections", f.rejections},
		{"escalated", f.escalated || c.stage == "blocked"},
		{"human_approval", f.human},
		{"deviations", devs},
		{"blockers", blockers},
		{"notes", notes},
		{"verify_findings", findings},
		{"tests_seen_failing_first", f.redFail},
		{"tests_passing_on_first_run", f.redPass},
		{"created_at", w.pyTime(c.created)}, {"closed_at", w.pyTime(f.closedAt)}, {"archive", ".factory/archive/" + c.ticket + ".tar.gz"},
	}
}

// writeRuns writes runs.jsonl: one line per finished cell, in the order cleanup ran.
func (g *gen) writeRuns() error {
	w := g.w
	var done []*cell
	for _, c := range w.cells {
		if c.an.closedAt > 0 && g.in(c.an.closedAt) {
			done = append(done, c)
		}
	}
	sort.SliceStable(done, func(i, j int) bool { return done[i].an.closedAt < done[j].an.closedAt })
	var buf bytes.Buffer
	for _, c := range done {
		pyJSON(&buf, w.runRecord(c))
		buf.WriteByte('\n')
		g.cnt.add("run-record", "run.recorded", 1)
	}
	if len(done) == 0 {
		return nil
	}
	return g.put(g.path(".factory", "archive", "runs.jsonl"), buf.Bytes())
}

// cellJSON is cell.json as cell.py and the stations leave it.
func (g *gen) cellJSONA(c *cell, stage string) []byte {
	w := g.w
	m := map[string]any{"ticket_id": c.ticket, "title": c.an.title, "mode": "headless", "stage": stage, "isolation": "worktree",
		"branch": "feature/" + c.ticket, "slice_id": c.slice.id, "spec_path": "specs/slices/" + c.slice.id + "-synthetic.md", "risk": c.risk,
		"app_type": c.an.appType, "contracts": []any{}, "created_at": w.pyTime(c.created), "round": c.round, "synthetic": true,
		"product": map[string]any{"slice_id": c.slice.id, "wave_id": c.slice.wave.id, "revision": c.slice.rev, "digest": c.slice.digest}}
	if c.an.mergedAt > 0 && g.in(c.an.mergedAt) {
		m["merged"] = map[string]any{"method": c.an.method, "commit": c.an.mergeCommit, "landed_commit": c.an.approvedHead, "at": w.pyTime(c.an.mergedAt)}
		if c.an.method == "pr" {
			m["pull_request"] = fmt.Sprintf("pull/%d", c.an.pr)
		}
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	return append(b, '\n')
}

// shapeLog applies the analytics file facts to a cell's written records: a log that starts late,
// no log, a null seq. It returns the records to write and their seq numbers (0: null).
func (g *gen) shapeLog(c *cell, recs []*lifeRec) ([]*lifeRec, []int) {
	if c.an == nil {
		seqs := make([]int, len(recs))
		for i := range recs {
			seqs[i] = i + 1
		}
		return recs, seqs
	}
	if c.an.noLog {
		return nil, nil
	}
	if c.an.partial {
		for i, r := range recs {
			if r.typ == "station.entered" && r.station == "build" {
				recs = recs[i:]
				break
			}
		}
	}
	seqs := make([]int, len(recs))
	seq := 0
	for i := range recs {
		if c.an.nullSeq > 0 && i == c.an.nullSeq-1 {
			continue // the helper could not take its lock: seq null, and the next record takes the next number
		}
		seq++
		seqs[i] = seq
	}
	return recs, seqs
}

// ---- expected.json ----

// Expected is the ground truth of an analytics project, from the generator's own plan.
type Expected struct {
	Note       string                    `json:"note"`
	Generator  map[string]any            `json:"generator"`
	Tickets    map[string]any            `json:"tickets"`
	Slices     map[string]any            `json:"slices"`
	Waves      map[string]any            `json:"waves"`
	Visits     map[string]int            `json:"visits"`
	VisitsLogs map[string]int            `json:"visits_in_logs"`
	Executions map[string]any            `json:"executions"`
	Rounds     map[string]any            `json:"rounds"`
	Gates      map[string]any            `json:"gates"`
	Waits      map[string]any            `json:"waits"`
	Recoveries map[string]int            `json:"recoveries"`
	Cost       map[string]any            `json:"cost"`
	Scorecard  map[string]map[string]any `json:"observe_scorecard"`
	Quirks     map[string]any            `json:"history_quirks"`
}

func ratio(num, den float64) any {
	if den == 0 {
		return nil
	}
	return num / den
}

func round3f(v any) any {
	if f, ok := v.(float64); ok {
		return math.Round(f*1000) / 1000
	}
	return nil
}

// scorecard is observe.py scorecard over the given finished tickets (its formulas, not its code).
func (w *world) scorecard(done []*cell) map[string]any {
	var merged, first, escalated, abandoned, failing, passing, devs, rounds int
	for _, c := range done {
		f := c.an
		if f.outcome == "merged" {
			merged++
			rounds += c.round
			if c.round == 1 {
				first++
			}
		}
		if f.escalated || c.stage == "blocked" {
			escalated++
		}
		if f.outcome == "abandoned" {
			abandoned++
		}
		failing += f.redFail
		passing += f.redPass
		devs += len(f.deviations)
	}
	total := float64(len(done))
	m := func(num, den float64, basis string) map[string]any {
		v := ratio(num, den)
		return map[string]any{"value": v, "rounded": round3f(v), "numerator": num, "denominator": den, "basis": basis}
	}
	return map[string]any{
		"tickets":                   len(done),
		"average_rounds":            m(float64(rounds), float64(merged), "sum of rounds over merged tickets"),
		"first_pass_rate":           m(float64(first), float64(merged), "merged tickets with one round over merged tickets"),
		"escalation_rate":           m(float64(escalated), total, "escalated over finished tickets"),
		"abandonment_rate":          m(float64(abandoned), total, "abandoned over finished tickets"),
		"tests_failing_first_share": m(float64(failing), float64(failing+passing), "tests seen failing first over all recorded test tasks"),
		"deviations_per_ticket":     m(float64(devs), total, "deviations over finished tickets"),
	}
}

func (g *gen) writeExpected() error {
	w := g.w
	in := g.in
	e := Expected{Note: "Ground truth from the generator's own plan (its model of what happened), not from the files or the observer. " +
		"'visits' counts what happened; 'visits_in_logs' what the lifecycle logs carry (partial and absent logs lose some). Costs are recorded values only."}
	e.Generator = map[string]any{"seed": w.o.Seed, "cells": w.o.Cells, "waves": w.o.Waves, "hours": w.o.Hours, "max_parallel": w.o.MaxParallel,
		"agents_per_execution": w.o.AgentsPerExecution, "events_target": w.o.Events, "start": isoMS(w.startMS), "end": isoMS(w.ms(w.endT))}
	// Tickets.
	var done []*cell
	byOutcome := map[string]int{}
	byRisk := map[string]map[string]int{}
	byApp := map[string]map[string]int{}
	byProfile := map[string]int{}
	atEnd := map[string]int{}
	dispatched, firstPass, escAbandoned := 0, 0, 0
	for _, c := range w.cells {
		byProfile[c.prof.name]++
		if c.created == 0 || !in(c.created) {
			continue
		}
		dispatched++
		if c.an.closedAt > 0 && in(c.an.closedAt) {
			done = append(done, c)
			byOutcome[c.an.outcome]++
			if byRisk[c.risk] == nil {
				byRisk[c.risk] = map[string]int{}
			}
			if byApp[c.an.appType] == nil {
				byApp[c.an.appType] = map[string]int{}
			}
			byRisk[c.risk][c.an.outcome]++
			byApp[c.an.appType][c.an.outcome]++
			if c.an.outcome == "merged" && c.round == 1 {
				firstPass++
			}
			if c.an.outcome == "abandoned" && (c.an.escalated || c.stage == "blocked") {
				escAbandoned++
			}
			continue
		}
		atEnd[stageAtTime(c, w.endT)]++
	}
	escalated := 0
	for _, c := range done {
		if c.an.escalated || c.stage == "blocked" {
			escalated++
		}
	}
	e.Tickets = map[string]any{"total": len(w.cells), "dispatched": dispatched, "finished": len(done), "merged": byOutcome["merged"],
		"abandoned": byOutcome["abandoned"], "escalated": escalated, "escalated_then_abandoned": escAbandoned, "first_pass": firstPass,
		"unfinished_by_stage_at_end": atEnd, "finished_by_risk": byRisk, "finished_by_app_type": byApp, "by_profile": byProfile}
	// Slices and waves.
	integrated, blockedEver, never, superseded := 0, 0, 0, 0
	for _, s := range w.slices {
		if s.cell != nil && s.cell.integrated > 0 && in(s.cell.integrated) {
			integrated++
		}
		if len(s.phases) > 0 {
			blockedEver++
		}
		if s.cell == nil || s.cell.created == 0 || !in(s.cell.created) {
			never++
		}
		superseded += s.rev - 1
	}
	delivered := 0
	for _, wv := range w.waves {
		all := true
		for _, s := range wv.slices {
			if s.cell == nil || s.cell.integrated == 0 || !in(s.cell.integrated) {
				all = false
			}
		}
		if all {
			delivered++
		}
	}
	e.Slices = map[string]any{"total": len(w.slices), "integrated": integrated, "ever_dependency_blocked": blockedEver, "never_dispatched": never,
		"revisions_superseded": superseded, "blocked_at_end_without_cell": w.an.blockedEnd}
	e.Waves = map[string]any{"total": len(w.waves), "delivered": delivered}
	// Visits, gates, rounds, from the model's lifecycle records.
	e.Visits, e.VisitsLogs = map[string]int{}, map[string]int{}
	gates := map[string]int{}
	refusedBy, overBy := map[string]int{}, map[string]int{}
	decisions := map[string]int{}
	vetoes, verifyFail, verifyPass, tasks, humanClosed := 0, 0, 0, 0, 0
	for _, c := range w.cells {
		recs := g.writtenLife(c)
		inLog := map[*lifeRec]bool{}
		for _, r := range recs {
			inLog[r] = true
		}
		for _, r := range c.life {
			if !in(r.t) || !in(r.wt) {
				continue
			}
			if r.typ == "station.entered" {
				e.Visits[r.station]++
				if inLog[r] {
					e.VisitsLogs[r.station]++
				}
			}
			switch r.typ {
			case "gate.evaluated":
				gates["evaluated"]++
				switch r.data["outcome"] {
				case "refuse":
					gates["refused"]++
					refusedBy[fmt.Sprint(r.data["gate"])]++
				case "override":
					gates["overridden"]++
					overBy[fmt.Sprint(r.data["gate"])]++
				}
			case "review.decided":
				decisions[fmt.Sprint(r.data["decision"])]++
				if r.data["security_veto"] == true {
					vetoes++
				}
			case "station.exited":
				if r.station == "verify" {
					if r.data["outcome"] == "PASS" {
						verifyPass++
					} else {
						verifyFail++
					}
				}
			case "build.task_completed":
				tasks++
			case "human.approval_recorded":
				humanClosed++
			}
		}
	}
	e.Gates = map[string]any{"evaluated": gates["evaluated"], "refused": gates["refused"], "overridden": gates["overridden"],
		"refused_by_gate": refusedBy, "overridden_by_gate": overBy, "build_tasks_completed": tasks}
	roundsMerged := 0
	for _, c := range done {
		if c.an.outcome == "merged" {
			roundsMerged += c.round
		}
	}
	e.Rounds = map[string]any{"judging_rounds_of_merged_tickets": roundsMerged, "review_rounds_decided": decisions, "security_vetoes": vetoes,
		"verifications_passed": verifyPass, "verifications_failed": verifyFail}
	// Executions and cost.
	execs := map[string]int{}
	byModel := map[string]map[string]float64{}
	costTotal, costN := 0.0, 0
	costTickets := map[string]bool{}
	attemptsMax := 0
	for _, x := range w.execs {
		if !in(x.claim) {
			continue
		}
		execs["claimed"]++
		attemptsMax = max(attemptsMax, x.attempt)
		if x.workflow {
			execs["workflow"]++
		} else {
			execs["main_loop_only"]++
		}
		running := math.IsInf(x.end, 1) || !in(x.end)
		switch {
		case running:
			execs["running_at_end"]++
		case x.outcome == "completed":
			execs["completed"]++
		case x.outcome == "failed":
			execs["failed"]++
		case x.outcome == "unknown":
			execs["outcome_unknown"]++
		}
		if running || x.outcome != "completed" || x.an == nil {
			continue
		}
		if x.an.noUsage {
			execs["completed_without_usage"]++
			continue
		}
		execs["completed_with_usage"]++
		costTotal += x.cost
		costN++
		costTickets[x.cell.ticket] = true
		for _, u := range x.an.usage {
			m := byModel[u.model]
			if m == nil {
				m = map[string]float64{}
				byModel[u.model] = m
			}
			m["executions"]++
			m["cost_usd"] += u.cost
			m["input"] += float64(u.input)
			m["output"] += float64(u.output)
			m["cache_read"] += float64(u.cacheRead)
			m["cache_creation"] += float64(u.cacheCreation)
		}
	}
	for _, m := range byModel {
		m["cost_usd"] = math.Round(m["cost_usd"]*1e6) / 1e6
	}
	execs["max_attempts_per_ticket"] = attemptsMax
	e.Executions = map[string]any{}
	for k, v := range execs {
		e.Executions[k] = v
	}
	e.Cost = map[string]any{"executions_with_recorded_cost": costN, "recorded_cost_usd": math.Round(costTotal*1e6) / 1e6, "tickets_with_recorded_cost": len(costTickets),
		"executions_completed_without_cost": execs["completed_without_usage"], "by_model": byModel,
		"note": "recorded per execution and per model only; never per agent or station; nothing estimated"}
	// Waits and recoveries, from the intake plan.
	intake := map[string]int{}
	recov := map[string]int{}
	for _, r := range w.intake {
		if !in(r.t) {
			continue
		}
		intake[r.typ]++
		if r.typ == "recovery.started" {
			recov[fmt.Sprint(r.data["kind"])]++
		}
	}
	openHuman := 0
	for _, c := range w.cells {
		if c.waitOpen {
			openHuman++
		}
	}
	e.Waits = map[string]any{"dependency_blocked": intake["dependency.blocked"], "dependency_resolved": intake["dependency.resolved"],
		"capacity_waits": w.capacityWaits, "human_required": intake["human.required"], "human_approvals_recorded": humanClosed, "human_waits_open_at_end": openHuman}
	e.Recoveries = recov
	// The observe scorecard, over every finished ticket and over observe's default window (the 20
	// most recently closed).
	byClose := append([]*cell(nil), done...)
	sort.SliceStable(byClose, func(i, j int) bool { return w.ms(byClose[i].an.closedAt)/1000 < w.ms(byClose[j].an.closedAt)/1000 })
	last := byClose
	if len(last) > 20 {
		last = last[len(last)-20:]
	}
	e.Scorecard = map[string]map[string]any{"all_finished": w.scorecard(done), "observe_default_depth_20": w.scorecard(last)}
	nullSeq := 0
	for _, c := range w.cells {
		if c.an.nullSeq > 0 && len(g.writtenLife(c)) >= c.an.nullSeq {
			nullSeq++
		}
		if c.created > 0 && in(c.created) && c.an.partial {
			w.an.partial = append(w.an.partial, c.ticket)
		}
		if c.archived && in(c.an.closedAt) && c.an.noLog {
			w.an.noLog = append(w.an.noLog, c.ticket)
		}
	}
	e.Quirks = map[string]any{"intake_duplicate_lines": w.an.dupIntake, "intake_missing_seq_lines": 2, "late_intake_lines": w.feature["late_intake_batch"],
		"late_lifecycle_batch": w.feature["late_lifecycle_batch"], "partial_lifecycle_tickets": orNone(w.an.partial), "no_lifecycle_tickets": orNone(w.an.noLog),
		"null_seq_records": nullSeq}
	data, err := json.MarshalIndent(e, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(g.path(ExpectedFile), append(data, '\n'), 0o644)
}

func orNone(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// writtenLife is the records a cell's written log carries (the archived copy for an archived cell).
func (g *gen) writtenLife(c *cell) []*lifeRec {
	if c.created == 0 || !g.in(c.created) {
		return nil
	}
	recs := g.lifeInHistory(c)
	if !(c.archived && (c.an == nil || g.in(c.an.closedAt))) {
		kept := recs[:0:0]
		for _, r := range recs {
			if !r.archive {
				kept = append(kept, r)
			}
		}
		recs = kept
	}
	recs, _ = g.shapeLog(c, recs)
	return recs
}

// dupIntake says whether the i-th written intake line is written twice.
func (g *gen) dupIntake(i, n int) bool {
	if g.w.an == nil || n < 40 {
		return false
	}
	step := n / 6
	return i%step == step/2
}
