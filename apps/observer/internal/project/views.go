package project

import (
	"sort"
	"strings"

	"mach/observer/internal/feed"
)

// TimeView is how a stamp is served: a time in RFC 3339 (or null), its precision and bounds, and
// the event that recorded it.
type TimeView struct {
	At        *string `json:"at"`
	Precision string  `json:"precision"`
	NotBefore *string `json:"not_before,omitempty"`
	NotAfter  *string `json:"not_after,omitempty"`
	EventID   string  `json:"event_id"`
	Pos       uint64  `json:"pos"`
	Authority string  `json:"authority"`
}

// TV renders a stamp; nil stays nil.
func TV(st *Stamp) *TimeView {
	if st == nil {
		return nil
	}
	f := func(p *int64) *string {
		if p == nil {
			return nil
		}
		return ptr(feed.FormatMS(*p))
	}
	return &TimeView{At: f(st.At), Precision: st.Precision, NotBefore: f(st.NotBefore), NotAfter: f(st.NotAfter), EventID: st.EventID, Pos: st.Pos, Authority: st.Authority}
}

// ---- executions ----

var terminalExec = map[string]bool{"finished": true, "failed": true, "interrupted": true, "timed-out": true, "could-not-start": true}

// stoppedHow is how an execution's process was stopped before it could run to its end
// (interrupted, timed-out, could-not-start), from its own record (result.json `ended`) or, when
// that is missing, the supervisor's execution.failed `how` (which copies it). "" for a process
// that ran to its end, or one not known to have stopped.
func stoppedHow(x *Execution) string {
	stopped := map[string]bool{"interrupted": true, "timed-out": true, "could-not-start": true}
	switch {
	case stopped[x.Ended]:
		return x.Ended
	case x.Ended == "" && x.Failed != nil && stopped[x.How]:
		return x.How
	}
	return ""
}

// ExecState is an execution's state from its own records, strongest fact first: an interruption
// (the process record says how the process was stopped; execution.failed then says only that it
// did not finish), a recorded unknown outcome (the supervisor's outcome-unknown recovery, which the
// event contract uses only when there is no process result), a failure (it ran to its end and
// reported one), completion, a process that ended (the supervisor has not recorded it yet), a
// running process, a claim. The same order as the Factory Floor's executionActivity
// (selectors.ts). Views use ExecStateIn, which adds what only the whole projection knows.
func ExecState(x *Execution) string {
	unknown := false
	for _, k := range x.Recovery {
		unknown = unknown || k == "outcome-unknown"
	}
	switch {
	case stoppedHow(x) != "":
		return stoppedHow(x)
	case unknown && x.Completed == nil && x.Failed == nil:
		return "unknown"
	case x.Failed != nil:
		return "failed"
	case x.Completed != nil:
		return "finished"
	case x.ProcessEnded != nil:
		return "ended"
	case x.ProcessStarted != nil || x.Started != nil:
		return "running"
	case x.Claimed != nil:
		return "claimed"
	}
	return "unknown"
}

// StateClass groups execution states for the runs filter: active, finished, unknown.
func StateClass(state string) string {
	switch {
	case state == "unknown":
		return "unknown"
	case terminalExec[state]:
		return "finished"
	}
	return "active"
}

// RunView is one execution as /runs serves it.
type RunView struct {
	ExecutionID string    `json:"execution_id"`
	TicketID    string    `json:"ticket_id,omitempty"`
	SliceID     string    `json:"slice_id,omitempty"`
	Workflow    string    `json:"workflow,omitempty"`
	State       string    `json:"state"`
	Attempt     *int64    `json:"attempt"`
	Claimed     *TimeView `json:"claimed_at"`
	// StartedAt and EndedAt are the process's own times (execution-record) when recorded, else
	// the supervisor's (intake log), which are stamped late; TimeBasis says which.
	StartedAt     *TimeView              `json:"started_at"`
	EndedAt       *TimeView              `json:"ended_at"`
	TimeBasis     string                 `json:"time_basis"`
	Duration      Duration               `json:"duration"`
	Ended         string                 `json:"ended,omitempty"`
	ExitCode      *int64                 `json:"exit_code"`
	How           string                 `json:"how,omitempty"`
	StageAtStart  string                 `json:"stage_at_start,omitempty"`
	StageAtEnd    string                 `json:"stage_at_end,omitempty"`
	Moved         *bool                  `json:"moved"`
	Cost          Cost                   `json:"cost"`
	Tokens        *int64                 `json:"tokens_total"`
	Models        map[string]*ModelUsage `json:"models"`
	UnderReported bool                   `json:"cost_may_be_under_reported"`
	UnderReasons  []string               `json:"under_reported_reasons"`
	RefusedTools  []string               `json:"refused_tools"`
	RefusedFrom   string                 `json:"refused_tools_authority,omitempty"` // observed (stream) until execution.completed, then authoritative; see refusedTools
	Recovery      []string               `json:"recovery"`
	Agents        int                    `json:"agents"`
	Visits        []string               `json:"visits"`
	// Provenance: the snapshot taken at start, or null with a reason (not-recorded for every
	// execution before M6.5, capture-failed, not-understood). Never inferred after the fact.
	Provenance         map[string]any `json:"provenance"`
	ProvenanceRecorded bool           `json:"provenance_recorded"`
	ProvenanceReason   string         `json:"provenance_reason,omitempty"`
	SourceCommit       *string        `json:"source_commit"`
}

// Cost is a recorded cost with its source; null with a reason when nothing recorded it.
type Cost struct {
	USD        *float64 `json:"usd"`
	Source     string   `json:"source,omitempty"` // execution.usage (stream) | execution.completed (supervisor)
	Authority  string   `json:"authority,omitempty"`
	NullReason string   `json:"null_reason,omitempty"`
}

// refusedTools is what a run summary says was refused. The supervisor's record (execution.completed)
// is the authority once it exists, even when it lists nothing; before it, the refusals the stream has
// shown (tool.refused) are reported at once, as observed: each tool name once, sorted, as the
// supervisor sorts its own list. execution.failed records no list, so the observed one stands.
func refusedTools(x *Execution) ([]string, string) {
	if x.RefusedFinal {
		return nonNilS(x.RefusedTools), "authoritative"
	}
	seen := map[string]bool{}
	out := []string{}
	for _, r := range x.Refused {
		if r.Tool != "" && !seen[r.Tool] {
			seen[r.Tool] = true
			out = append(out, r.Tool)
		}
	}
	if len(out) == 0 {
		return out, ""
	}
	sort.Strings(out)
	return out, "observed"
}

// Run builds an execution's view. Its state is ExecStateIn, the one the execution's span carries
// (attrs.state), so /runs, /runs/{id}, /spans and /marks never disagree; an execution bounded by
// later records ends at that bound here too (ended_at not_after, duration inferred, max only).
func Run(s *State, x *Execution) RunView {
	v := RunView{ExecutionID: x.ExecutionID, TicketID: x.TicketID, SliceID: x.SliceID, Workflow: x.Workflow, State: ExecStateIn(s, x), Attempt: x.Attempt,
		Claimed: TV(x.Claimed), Ended: x.Ended, ExitCode: x.ExitCode, How: x.How, StageAtStart: x.StageAtStart, StageAtEnd: x.StageAtEnd,
		Recovery: nonNilS(x.Recovery), Agents: len(x.Agents) + len(x.Queued), Visits: nonNilS(x.Visits),
		Models: map[string]*ModelUsage{}, UnderReasons: []string{}}
	v.RefusedTools, v.RefusedFrom = refusedTools(x)
	v.Provenance, v.ProvenanceRecorded, v.ProvenanceReason = x.Provenance, x.Provenance != nil, x.ProvenanceReason
	if x.Provenance == nil && v.ProvenanceReason == "" {
		v.ProvenanceReason = "not-recorded"
	}
	if x.SourceCommit != "" {
		v.SourceCommit = &x.SourceCommit
	}
	start, end := x.ProcessStarted, x.ProcessEnded
	v.TimeBasis = "process"
	if start == nil {
		start, v.TimeBasis = x.Started, "supervisor"
	}
	if end == nil {
		if x.Completed != nil {
			end = x.Completed
		} else {
			end = x.Failed
		}
		if end != nil {
			v.TimeBasis = "supervisor"
		}
	}
	v.StartedAt, v.EndedAt = TV(start), TV(end)
	v.Duration = between(start, end, false)
	if end == nil {
		if u := unknownEnd(s, x); u != nil {
			v.EndedAt = TV(u)
			v.Duration = Duration{MaxMS: between(start, u, true).MaxMS, Basis: "inferred"}
		}
	}
	if v.TimeBasis == "supervisor" && v.Duration.Basis == "measured" {
		v.Duration.Basis = "bounded" // the supervisor stamps executions up to a poll late
	}
	if stoppedHow(x) != "" && v.Duration.Basis == "measured" {
		v.Duration.Basis = "bounded" // stopped from outside: it never "took" that long, it ran until stopped
	}
	if x.Completed != nil || x.Failed != nil {
		v.Moved = ptr(x.Completed != nil)
	}
	v.Cost = costOf(x)
	if x.Usage != nil {
		var total int64
		seen := false
		for m, u := range x.Usage.Models {
			v.Models[m] = u
			for _, n := range []*int64{u.InputTokens, u.OutputTokens, u.CacheReadTokens, u.CacheCreationTokens} {
				if n != nil {
					total += *n
					seen = true
				}
			}
		}
		if seen {
			v.Tokens = &total
		}
	}
	// The stream's own verdict on its usage (execution.usage.cost_complete) decides; before
	// revision 1, or with no usage at all, the workflow's recorded end stands in for it.
	switch {
	case x.Usage != nil && x.Usage.CostComplete != nil:
		for _, r := range x.Usage.CostIncompleteReasons {
			v.UnderReasons = append(v.UnderReasons, costReason(r))
		}
		if !*x.Usage.CostComplete && len(x.Usage.CostIncompleteReasons) == 0 {
			v.UnderReasons = append(v.UnderReasons, "the stream reported its cost as incomplete")
		}
	default:
		if x.Usage != nil && x.Usage.BudgetExhausted {
			v.UnderReasons = append(v.UnderReasons, costReason("budget-stop"))
		}
		for _, ref := range sortedKeys(x.Workflows) {
			if w := x.Workflows[ref]; w.Status == "killed" {
				v.UnderReasons = append(v.UnderReasons, costReason("agents-killed-in-flight"))
				break
			}
		}
	}
	switch v.State {
	case "interrupted", "timed-out":
		v.UnderReasons = append(v.UnderReasons, "the process was "+v.State+" before reporting its final usage")
	case "unknown":
		v.UnderReasons = append(v.UnderReasons, "the execution's outcome is unknown")
	}
	v.UnderReported = len(v.UnderReasons) > 0
	return v
}

// costOf is an execution's recorded cost: the stream's usage, else the supervisor's record.
func costOf(x *Execution) Cost {
	switch {
	case x.Usage != nil && x.Usage.TotalCostUSD != nil:
		return Cost{USD: x.Usage.TotalCostUSD, Source: "execution.usage", Authority: "observed"}
	case x.CostUSD != nil:
		return Cost{USD: x.CostUSD, Source: "execution.completed", Authority: "authoritative"}
	}
	return Cost{NullReason: "no cost was recorded for this execution (no result was read)"}
}

// costReason words a cost_incomplete_reasons code for a person.
func costReason(code string) string {
	switch code {
	case "budget-stop":
		return "a budget stop ended the run: requests in flight may not have reported their spend"
	case "agents-killed-in-flight":
		return "a workflow was killed with agents still running: their last requests may not be counted"
	}
	return "the stream reported its cost as incomplete (" + code + ")"
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Runs lists executions, newest claim first (by position), filtered by state class and ticket.
func Runs(s *State, class, ticket string) []RunView {
	xs := make([]*Execution, 0, len(s.Executions))
	for _, x := range s.Executions {
		if ticket != "" && x.TicketID != ticket {
			continue
		}
		if class != "" && StateClass(ExecStateIn(s, x)) != class {
			continue
		}
		xs = append(xs, x)
	}
	sort.Slice(xs, func(i, j int) bool {
		pi, pj := firstPos(xs[i]), firstPos(xs[j])
		if pi != pj {
			return pi > pj
		}
		return xs[i].ExecutionID < xs[j].ExecutionID
	})
	out := make([]RunView, 0, len(xs))
	for _, x := range xs {
		out = append(out, Run(s, x))
	}
	return out
}

func firstPos(x *Execution) uint64 {
	for _, st := range []*Stamp{x.Claimed, x.Started, x.ProcessStarted, x.Session0()} {
		if st != nil {
			return st.Pos
		}
	}
	return 0
}

// Session0 is the stamp of the earliest stream fact, when nothing else is recorded.
func (x *Execution) Session0() *Stamp {
	var first *Stamp
	for _, a := range x.Agents {
		for _, st := range []*Stamp{a.Queued, a.Started} {
			if st != nil && (first == nil || st.Pos < first.Pos) {
				first = st
			}
		}
	}
	return first
}

// AgentView is one agent: identity, label, phase, model, state, times, a token total and a
// tool-call count. Never a cost; never a per-call record (contract 8.1).
type AgentView struct {
	*Agent
	QueuedAt   *TimeView `json:"queued_at"`
	StartedAt  *TimeView `json:"started_at"`
	FinishedAt *TimeView `json:"finished_at"`
	Queue      Duration  `json:"queue_wait"`
	Run        Duration  `json:"run"`
}

// Agents lists an execution's agents (started ones, then those still queued), in start order.
func Agents(x *Execution) []AgentView {
	var list []*Agent
	for _, a := range x.Agents {
		list = append(list, a)
	}
	for _, a := range x.Queued {
		list = append(list, a)
	}
	sort.Slice(list, func(i, j int) bool {
		pi, pj := agentPos(list[i]), agentPos(list[j])
		if pi != pj {
			return pi < pj
		}
		return list[i].AgentID+itoa(list[i].Index) < list[j].AgentID+itoa(list[j].Index)
	})
	out := make([]AgentView, 0, len(list))
	for _, a := range list {
		v := AgentView{Agent: a, QueuedAt: TV(a.Queued), StartedAt: TV(a.Started), FinishedAt: TV(a.Finished)}
		v.Queue = between(a.Queued, a.Started, false)
		if a.Started != nil && a.DurationMS != nil {
			v.Run = Duration{MS: a.DurationMS, MinMS: a.DurationMS, MaxMS: a.DurationMS, Basis: "measured"}
		} else {
			v.Run = between(a.Started, a.Finished, false)
		}
		out = append(out, v)
	}
	return out
}

func agentPos(a *Agent) uint64 {
	for _, st := range []*Stamp{a.Queued, a.Started} {
		if st != nil {
			return st.Pos
		}
	}
	return 0
}

// ToolView is one main-loop (or Agent-tool sub-agent) tool call.
type ToolView struct {
	*Tool
	CalledAt   *TimeView `json:"called_at"`
	ReturnedAt *TimeView `json:"returned_at"`
	Span       Duration  `json:"span"`
}

// Tools lists an execution's main-loop tool calls in call order.
func Tools(x *Execution) []ToolView {
	list := make([]*Tool, 0, len(x.Tools))
	for _, t := range x.Tools {
		list = append(list, t)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Called.Pos != list[j].Called.Pos {
			return list[i].Called.Pos < list[j].Called.Pos
		}
		return list[i].ToolCallID < list[j].ToolCallID
	})
	out := make([]ToolView, 0, len(list))
	for _, t := range list {
		out = append(out, ToolView{Tool: t, CalledAt: TV(t.Called), ReturnedAt: TV(t.Returned), Span: between(t.Called, t.Returned, false)})
	}
	return out
}

// ---- waits ----

// Wait is why a slice or ticket is waiting, only as recorded.
type Wait struct {
	Kind    string    `json:"kind"`  // dependency | capacity | person | unknown
	Basis   string    `json:"basis"` // recorded | recorded-sentence | unknown
	Reasons []string  `json:"reasons"`
	Since   *TimeView `json:"since"`
	Rule    string    `json:"rule,omitempty"`
}

// SliceWait says why a slice that is not yet active is waiting. Nil when it is not waiting.
func SliceWait(s *State, sl *Slice) *Wait {
	if sl.State == "blocked" {
		return &Wait{Kind: "dependency", Basis: "recorded", Reasons: nonNilS(sl.Reasons), Since: TV(sl.Blocked)}
	}
	if w := ticketWait(s, sl.TicketID, sl.SliceID); w != nil {
		return w
	}
	if sl.State == "ready" {
		return &Wait{Kind: "unknown", Basis: "unknown", Reasons: []string{"eligible and not dispatched; no reason is recorded"}, Since: TV(sl.eligible())}
	}
	return nil
}

// ticketWait: a person (an open human gate, or a cell awaiting a person), then capacity (a
// recorded capacity wait, or the scheduler's fixed capacity sentence), then another recorded hold.
func ticketWait(s *State, ticket, slice string) *Wait {
	for _, k := range sortedKeys(s.Gates) {
		g := s.Gates[k]
		if g.Closed == nil && ((ticket != "" && g.TicketID == ticket) || (slice != "" && g.SliceID == slice)) {
			reasons := []string{}
			if g.Reason != "" {
				reasons = append(reasons, g.Reason)
			} else if g.Kind == "approval" {
				reasons = append(reasons, "the review asked for a person's approval")
			}
			return &Wait{Kind: "person", Basis: "recorded", Reasons: reasons, Since: TV(g.Opened)}
		}
	}
	if c := s.Cells[ticket]; ticket != "" && c != nil && c.Stage == "awaiting-human" {
		return &Wait{Kind: "person", Basis: "recorded", Reasons: []string{"the cell is awaiting a person"}, Since: TV(c.Updated)}
	}
	if st := s.Pending.Capacity[ticket]; ticket != "" && st != nil {
		return &Wait{Kind: "capacity", Basis: "recorded", Reasons: []string{}, Since: TV(st), Rule: "capacity.wait_changed"}
	}
	for _, h := range s.Factory.Held {
		if (ticket != "" && h.TicketID == ticket) || (slice != "" && h.SliceID == slice) {
			if capacitySentence.MatchString(h.Why) {
				return &Wait{Kind: "capacity", Basis: "recorded-sentence", Reasons: []string{h.Why}, Since: TV(s.Factory.LastDecision), Rule: "held-sentence"}
			}
			// Held for a reason the scheduler recorded only in words: shown, never classified (M6.6 D2).
			return &Wait{Kind: "unknown", Basis: "recorded", Reasons: []string{h.Why}, Since: TV(s.Factory.LastDecision), Rule: "held"}
		}
	}
	return nil
}

// ---- project, waves, slices, cells ----

// OpenGates lists open human gates.
func OpenGates(s *State) []*HumanGate {
	var out []*HumanGate
	for _, k := range sortedKeys(s.Gates) {
		if g := s.Gates[k]; g.Closed == nil {
			out = append(out, g)
		}
	}
	if out == nil {
		out = []*HumanGate{}
	}
	return out
}

// ProjectView is the project's execution state.
func ProjectView(s *State) map[string]any {
	counts := map[string]int{"completed": 0, "active": 0, "ready": 0, "blocked": 0, "superseded": 0, "unknown": 0}
	for _, sl := range s.Slices {
		counts[sl.State]++
	}
	active := []string{}
	for _, t := range sortedKeys(s.Cells) {
		c := s.Cells[t]
		if !c.Archived && c.Merge == nil && c.Stage != "merged" && cellOpened(c) {
			active = append(active, t)
		}
	}
	running := 0
	for _, x := range s.Executions {
		if StateClass(ExecStateIn(s, x)) == "active" {
			running++
		}
	}
	return map[string]any{
		"project_id":        s.Project.ProjectID,
		"integration":       map[string]any{"commit_seen": s.Project.CommitSeen, "at": TV(s.Project.CommitAt)},
		"factory":           FactoryView(s),
		"counts_by_state":   counts,
		"active_cells":      active,
		"executions_active": running,
		"human_gates_open":  OpenGates(s),
		"intake":            map[string]any{"last_validated": TV(s.Project.LastValidated), "refused": s.Project.IntakeRefused},
		"waves":             len(s.Waves),
		"slices":            len(s.Slices),
		"cells":             len(s.Cells),
		"history":           HistoryFacts(s),
	}
}

// cellOpened: something records the ticket's cell itself (a stage, a lifecycle log, a cell
// instance, an execution or a station visit). A ticket the intake log filed is known before its
// cell is opened at dispatch; until then it is not an active cell (M6.6 N6), has no cell span and
// is not a cell in the flow's coverage (D10).
func cellOpened(c *Cell) bool {
	return c.Stage != "" || c.Lifecycle || c.CellInstance != "" || len(c.Executions) > 0 || len(c.Visits) > 0 ||
		c.Archived || c.Merge != nil || c.Cleanup != nil
}

// FactoryView is the Factory's recorded mode (from the intake log: what MACH recorded, not a
// reading of the machine-local policy).
func FactoryView(s *State) map[string]any {
	f := s.Factory
	state := f.State
	if state == "" {
		state = "unknown"
	}
	return map[string]any{"state": state, "autonomy": f.Autonomy, "allow_merge": f.AllowMerge, "persistent": f.Persistent, "limits": f.Limits,
		"paused_reason": f.PausedReason, "since": TV(f.Since), "scheduler_state": f.SchedulerState, "last_decision": TV(f.LastDecision),
		"held": nonNil(f.Held), "dispatched": nonNilS(f.Dispatched), "started": nonNilS(f.Started)}
}

// WaveView summarises a wave.
func WaveView(s *State, w *Wave) map[string]any {
	counts := map[string]int{}
	for _, id := range w.Slices {
		if sl := s.Slices[id]; sl != nil {
			counts[sl.State]++
		} else {
			counts["not-materialized"]++
		}
	}
	return map[string]any{"wave_id": w.WaveID, "revision": w.Revision, "slices": nonNilS(w.Slices), "approved": w.Approved, "approved_at": w.ApprovedAt,
		"first_seen_at": TV(w.FirstSeen), "state_counts": counts}
}

// Waves lists waves by id.
func Waves(s *State) []map[string]any {
	out := []map[string]any{}
	for _, id := range sortedKeys(s.Waves) {
		out = append(out, WaveView(s, s.Waves[id]))
	}
	return out
}

// SliceView is one slice with its scheduler state and recorded wait.
func SliceView(s *State, sl *Slice) map[string]any {
	revs := sl.Revisions
	if revs == nil {
		revs = []SliceRevision{}
	}
	hist := sl.History
	if hist == nil {
		hist = []StateChange{}
	}
	var title any
	if sl.Title != "" {
		title = sl.Title
	}
	return map[string]any{"slice_id": sl.SliceID, "title": title, "wave_id": sl.WaveID, "revision": sl.Revision, "ticket_id": sl.TicketID, "state": sl.State,
		"dependencies": nonNilS(sl.Dependencies), "depends_on": nonNilS(sl.DependsOn), "last_reasons": nonNilS(sl.Reasons), "waiting": SliceWait(s, sl),
		"commit": sl.Commit, "materialized_at": TV(sl.Materialized), "blocked_at": TV(sl.Blocked), "resolved_at": TV(sl.Resolved),
		"dispatched_at": TV(sl.Scheduled), "integrated_at": TV(sl.Integrated), "superseded_at": TV(sl.Superseded),
		"earlier_revisions": revs, "history": hist}
}

// WaveDetail is a wave with its slices.
func WaveDetail(s *State, w *Wave) map[string]any {
	v := WaveView(s, w)
	slices := []map[string]any{}
	for _, id := range w.Slices {
		if sl := s.Slices[id]; sl != nil {
			slices = append(slices, SliceView(s, sl))
		} else {
			slices = append(slices, map[string]any{"slice_id": id, "state": "unknown", "waiting": nil, "note": "named by the wave; not materialized yet"})
		}
	}
	v["slices"] = slices
	return v
}

// Slices lists slices by id, optionally of one wave or one state.
func Slices(s *State, wave, state string) []map[string]any {
	out := []map[string]any{}
	for _, id := range sortedKeys(s.Slices) {
		sl := s.Slices[id]
		if (wave == "" || sl.WaveID == wave) && (state == "" || sl.State == state) {
			out = append(out, SliceView(s, sl))
		}
	}
	return out
}

// CellSummary is one cell in a list.
func CellSummary(c *Cell) map[string]any {
	last := ""
	if n := len(c.Visits); n > 0 {
		last = c.Visits[n-1].Outcome
	}
	return map[string]any{"ticket_id": c.TicketID, "cell_instance": c.CellInstance, "slice_id": c.SliceID, "wave_id": c.WaveID, "stage": c.Stage,
		"stage_source": c.StageSource, "risk": orNil(c.Risk), "app_type": orNil(c.AppType),
		"plan": map[string]any{"app_type": orNil(c.AppType), "risk": orNil(c.Risk), "contracts": c.Contracts, "tasks": c.TasksPlanned,
			"recorded_by": orNil(c.AppTypeSource)}, "created_at": TV(c.FirstSeen), "updated_at": TV(c.Updated),
		"current_visit": c.CurrentVisit, "round": c.Round, "visits": len(c.Visits), "last_outcome": last, "lifecycle": c.Lifecycle,
		"archived": c.Archived, "merged": c.Merge != nil, "executions": nonNilS(c.Executions)}
}

// Cells lists cells by ticket, optionally filtered by stage or station of the current visit.
func Cells(s *State, stage string, archived *bool) []map[string]any {
	out := []map[string]any{}
	for _, t := range sortedKeys(s.Cells) {
		c := s.Cells[t]
		if (stage == "" || c.Stage == stage) && (archived == nil || c.Archived == *archived) {
			out = append(out, CellSummary(c))
		}
	}
	return out
}

// VisitView is a visit with its measured duration and what happened inside it.
type VisitView struct {
	*Visit
	EnteredAt *TimeView `json:"entered_at"`
	ExitedAt  *TimeView `json:"exited_at"`
	Duration  Duration  `json:"duration"`
	Gates     []*Gate   `json:"gates"`
	Tasks     []*Task   `json:"tasks"`
	Checks    []*Check  `json:"checks"`
}

// Visits renders a cell's visits with their contents.
func Visits(c *Cell) []VisitView {
	out := make([]VisitView, 0, len(c.Visits))
	for _, v := range c.Visits {
		vv := VisitView{Visit: v, EnteredAt: TV(v.Entered), ExitedAt: TV(v.Exited), Duration: between(v.Entered, v.Exited, false),
			Gates: []*Gate{}, Tasks: []*Task{}, Checks: []*Check{}}
		for _, g := range c.Gates {
			if g.VisitID == v.VisitID {
				vv.Gates = append(vv.Gates, g)
			}
		}
		for _, t := range c.Tasks {
			if t.VisitID == v.VisitID {
				vv.Tasks = append(vv.Tasks, t)
			}
		}
		for _, k := range c.Checks {
			if k.VisitID == v.VisitID {
				vv.Checks = append(vv.Checks, k)
			}
		}
		out = append(out, vv)
	}
	return out
}

// CellDetail is a cell's full station history.
func CellDetail(s *State, c *Cell) map[string]any {
	v := CellSummary(c)
	v["visits"] = Visits(c)
	v["visit_count"] = len(c.Visits)
	v["gates"] = orEmpty(c.Gates)
	v["gates_dropped"] = c.GatesDropped
	v["tasks"] = orEmpty(c.Tasks)
	v["checks"] = orEmpty(c.Checks)
	v["targets"] = orEmpty(c.Targets)
	v["reviews"] = orEmpty(c.Reviews)
	v["findings"] = orEmpty(c.Findings)
	v["approvals"] = orEmpty(c.Approvals)
	v["merge"] = c.Merge
	v["cleanup"] = c.Cleanup
	v["history_began"] = c.Began
	v["artifacts"] = c.Artifacts
	v["dropped"] = c.Dropped
	gates := []*HumanGate{}
	for _, k := range sortedKeys(s.Gates) {
		if g := s.Gates[k]; g.TicketID == c.TicketID {
			gates = append(gates, g)
		}
	}
	v["human_gates"] = gates
	v["waiting"] = ticketWait(s, c.TicketID, c.SliceID)
	rounds := map[string]any{}
	for _, vis := range c.Visits {
		if vis.Round != nil {
			k := itoa(vis.Round)
			list, _ := rounds[k].([]string)
			rounds[k] = append(list, vis.VisitID)
		}
	}
	v["rounds"] = rounds
	return v
}

func orEmpty[T any](list []T) []T {
	if list == nil {
		return []T{}
	}
	return list
}

// SnapshotView is the projected state of the Factory, as /snapshot serves it.
func SnapshotView(s *State) map[string]any {
	cells := map[string]any{}
	for _, t := range sortedKeys(s.Cells) {
		cells[t] = CellDetail(s, s.Cells[t])
	}
	slices := map[string]any{}
	for _, id := range sortedKeys(s.Slices) {
		slices[id] = SliceView(s, s.Slices[id])
	}
	waves := map[string]any{}
	for _, id := range sortedKeys(s.Waves) {
		waves[id] = WaveView(s, s.Waves[id])
	}
	execs := map[string]any{}
	for _, id := range sortedKeys(s.Executions) {
		x := s.Executions[id]
		execs[id] = map[string]any{"run": Run(s, x), "agents": Agents(x), "tools": Tools(x), "refused": orEmpty(x.Refused), "workflows": x.Workflows, "session": x.Session}
	}
	gates := []*HumanGate{}
	for _, k := range sortedKeys(s.Gates) {
		gates = append(gates, s.Gates[k])
	}
	return map[string]any{"factory": FactoryView(s), "project": ProjectView(s), "waves": waves, "slices": slices, "cells": cells,
		"executions": execs, "gates": gates, "gaps": orEmpty(s.Gaps), "history": HistoryFacts(s)}
}

// HistoryFacts says how complete the projected history is, by gap class (contract 6.5, revision
// 2). Only the classes that lose history make it partial: not-received, unparsable-line,
// state-mismatch, evicted (the projection's own partial: history no longer held) and
// source-unreadable. unknown-type is "received, not interpreted" and conflict keeps the first
// copy: both are reported, neither marks history as missing.
func HistoryFacts(s *State) map[string]any {
	classes := map[string]int64{}
	lost := map[string]int64{}
	notInterpreted := map[string]int64{}
	for c, n := range s.GapClasses {
		classes[c] = n
	}
	if s.Partial != "" {
		classes["evicted"]++
	}
	for c, n := range classes {
		switch c {
		case "unknown-type":
			notInterpreted[c] = n
		case "conflict":
		default:
			lost[c] = n
		}
	}
	completeness := "complete"
	if len(lost) > 0 {
		completeness = "partial"
	}
	return map[string]any{"completeness": completeness, "partial": s.Partial, "lost": lost, "not_interpreted": notInterpreted,
		"classes": classes, "gaps": s.GapCounts, "not_v3": s.NotV3}
}

// HasPrefixAny reports whether v starts with any prefix.
func HasPrefixAny(v string, prefixes ...string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(v, p) {
			return true
		}
	}
	return false
}

// orNil is s, or nil when it is empty (a JSON null for "not recorded").
func orNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}
