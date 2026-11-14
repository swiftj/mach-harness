package metrics

// ---- the catalog ----

// Def is one catalog entry. The JSON fields before M6.5 keep their names and meaning; the rest
// are added (M6_5_DESIGN.md section 3.1).
type Def struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Kind        string   `json:"kind"` // rate | mean | count | duration
	Unit        string   `json:"unit"`
	Numerator   string   `json:"numerator"`
	Denominator string   `json:"denominator"`
	Dimensions  []string `json:"dimensions"`
	Source      string   `json:"source"`
	Authority   string   `json:"authority"`
	Limitations string   `json:"limitations"`
	Avail       string   `json:"availability"` // M6.1 availability: yes | lifecycle | stream | no
	// Unavailable, when set, is why this observer returns no value at all.
	Unavailable string `json:"-"`
	// Deferred marks an Unavailable metric that has a source and is not computed yet.
	Deferred bool   `json:"-"`
	Target   string `json:"target,omitempty"` // observe parity: "< 1.3"
	Parity   string `json:"parity_with,omitempty"`

	// Partial, when set, is how this observer's value falls short of the catalog's definition.
	Partial string `json:"-"`
	// Split are dimensions written on numerator cells only: the denominator is the population
	// those cells divide (recoveries of one kind per execution claimed, tokens of one kind per
	// execution that used the model). A group by a split dimension takes its numerator from its
	// own cells and its denominator from the whole population matching the other keys.
	Split []string `json:"-"`
	// Distinct, when set, makes the denominator the number of distinct values of that dimension
	// among the counted cells (tickets), so a window or group counts each ticket once.
	Distinct string `json:"-"`
	// Stream is the source whose refused records are counted in this metric's coverage:
	// run | lifecycle | intake | record | stream | observer.
	Stream string `json:"-"`
	// Runs marks the observe station's scorecard metrics, computed from run records and so
	// answerable for the last N runs (last_runs).
	Runs bool `json:"-"`
	// Open marks duration metrics whose open members (started, not yet ended) are counted.
	Open bool `json:"-"`
	// CoverUnit, when set, is the population the coverage counts when it differs from the
	// denominator's (K2, K3: completed executions, while the denominator is execution-model pairs).
	CoverUnit string `json:"-"`
	// OtherUnit names exclusion reasons counted in another unit than the coverage's (reported, not
	// added to the eligible count).
	OtherUnit map[string]string `json:"-"`
}

const (
	notRecorded = "not recorded: no source in MACH or Claude Code's stream holds this fact"
	deferred    = "not computed by this observer yet (deferred); the source events are served by /api/v1/events"
)

// Dimensions every cell-attached metric carries where the cell is known: its risk and app type at
// the time of the event (empty is reported as the group "unknown"). Wave is kept only where the
// catalog lists it (T1, T2, C3, C4, W1, W2): on every metric it multiplied the cells by the number
// of waves.
var cellDims = []string{"risk", "app_type"}

func with(dims ...string) []string { return append(dims, cellDims...) }

var runDims = []string{"risk", "app_type", "outcome"}

// Catalog is the metric catalog, in the shared contract's order.
var Catalog = []Def{
	{ID: "T1", Name: "Tickets merged", Kind: "count", Unit: "tickets", Numerator: "merge.completed", Denominator: "per period",
		Dimensions: []string{"risk", "app_type", "wave", "writer"}, Source: "cell lifecycle", Authority: "authoritative", Limitations: "merged is not accepted (T2)", Avail: "lifecycle", Stream: "lifecycle"},
	{ID: "T2", Name: "Accepted delivery", Kind: "count", Unit: "slices", Numerator: "slice.integrated", Denominator: "per period",
		Dimensions: []string{"wave", "risk", "app_type"}, Source: "intake log", Authority: "authoritative", Limitations: "stamped when the plan noticed; non-product tickets have no slice; risk and app type are the ticket's when the slice was integrated", Avail: "yes", Stream: "intake"},
	{ID: "T3", Name: "Waves delivered", Kind: "count", Numerator: "waves whose every current slice is integrated", Denominator: "per period", Source: "intake log", Authority: "authoritative", Avail: "yes", Unavailable: deferred, Deferred: true},
	{ID: "C1", Name: "Station cycle time", Kind: "duration", Unit: "ms", Numerator: "sum of measured visit durations", Denominator: "visits with a measured duration",
		Dimensions: with("station", "round"), Source: "cell lifecycle (station.entered to station.exited)", Authority: "authoritative", Limitations: "cells without a lifecycle log are excluded; bounded, unknown and open visits are counted apart, not averaged", Avail: "lifecycle", Stream: "lifecycle", Open: true},
	{ID: "C2", Name: "Station visits per ticket", Kind: "mean", Unit: "visits", Numerator: "visits", Denominator: "tickets with a lifecycle log",
		Dimensions: with("station", "ticket"), Source: "cell lifecycle", Authority: "authoritative", Limitations: "a ticket counts in the denominator when it recorded a visit in the window; by station, the denominator is the tickets that visited that station", Avail: "lifecycle", Stream: "lifecycle", Distinct: "ticket"},
	{ID: "C3", Name: "End-to-end cycle time, dispatch to merge", Kind: "duration", Unit: "ms", Numerator: "work.scheduled to merge.completed", Denominator: "merged product tickets",
		Dimensions: []string{"risk", "app_type", "wave"}, Source: "intake log and cell lifecycle", Authority: "authoritative", Limitations: "product tickets only; whole-second start", Avail: "lifecycle", Stream: "lifecycle"},
	{ID: "C4", Name: "End-to-end, eligible to integrated", Kind: "duration", Unit: "ms", Numerator: "dependency.resolved (or slice.materialized) to slice.integrated", Denominator: "integrated slices",
		Dimensions: []string{"wave", "risk", "app_type"}, Source: "intake log", Authority: "authoritative", Limitations: "includes queue wait", Avail: "yes", Stream: "intake"},
	{ID: "C5", Name: "Wave lead time", Kind: "duration", Numerator: "wave.discovered to last slice.integrated", Denominator: "delivered waves", Source: "intake log", Authority: "authoritative", Avail: "yes", Unavailable: deferred, Deferred: true},
	{ID: "W1", Name: "Dependency wait", Kind: "duration", Unit: "ms", Numerator: "dependency.blocked to dependency.resolved", Denominator: "slices ever blocked",
		Dimensions: []string{"wave", "risk", "app_type"}, Source: "intake log", Authority: "authoritative", Avail: "yes", Stream: "intake", Open: true,
		Partial: "the denominator is closed waits, not slices: a slice blocked twice counts twice"},
	{ID: "W2", Name: "Queue wait (eligible, not dispatched)", Kind: "duration", Unit: "ms", Numerator: "slice eligible to work.scheduled", Denominator: "dispatched slices",
		Dimensions: []string{"wave", "risk", "app_type"}, Source: "intake log", Authority: "authoritative", Limitations: "cell-capacity and engineer waits are not separable (a slice waiting for a free cell is not recorded); writer is not known when a slice is dispatched", Avail: "yes", Stream: "intake"},
	{ID: "W2b", Name: "Execution-capacity wait", Kind: "duration", Unit: "ms", Numerator: "capacity.wait_changed waiting to released", Denominator: "tickets ever held for capacity",
		Dimensions: cellDims, Source: "reconstructed from scheduling.decided.held[] (rule held-sentence)", Authority: "reconstructed", Limitations: "supervised mode only; never inferred from silence; slice-level capacity waits are not counted", Avail: "yes", Stream: "observer", Open: true,
		Partial: "the denominator is closed waits, not tickets: a ticket held twice counts twice"},
	{ID: "W3", Name: "Human approval wait", Kind: "duration", Unit: "ms", Numerator: "review.decided AWAITING_HUMAN to human.approval_recorded", Denominator: "rounds awaiting a person",
		Dimensions: cellDims, Source: "cell lifecycle", Authority: "authoritative", Avail: "lifecycle", Stream: "lifecycle", Open: true},
	{ID: "W4", Name: "Supervisor start latency", Kind: "duration", Unit: "ms", Numerator: "work.claimed to execution.process_started", Denominator: "executions started",
		Dimensions: with("stage"), Source: "intake log and execution records", Authority: "authoritative", Avail: "yes", Stream: "record", Open: true},
	{ID: "W5", Name: "Observation lag", Kind: "duration", Unit: "ms", Numerator: "execution.process_ended to execution.completed", Denominator: "completed executions",
		Dimensions: with("stage"), Source: "execution records and intake log", Authority: "authoritative", Limitations: "measures the supervisor's poll, not work", Avail: "yes", Stream: "record"},
	{ID: "Q1", Name: "First-pass verification", Kind: "rate", Numerator: "tickets whose round-1 verify.verdict gate is PASS", Denominator: "tickets with a round-1 verification",
		Dimensions: cellDims, Source: "cell lifecycle", Authority: "authoritative", Avail: "lifecycle", Stream: "lifecycle",
		Partial: "the denominator is round-1 verification verdicts, not tickets: a verdict recorded twice in round 1 counts twice"},
	{ID: "Q2", Name: "First-pass rate (observe)", Kind: "rate", Numerator: "merged tickets with first_pass", Denominator: "merged tickets",
		Dimensions: runDims, Source: "run.recorded", Authority: "authoritative", Avail: "yes", Target: "> 0.85", Parity: "observe.py scorecard first_pass_rate", Stream: "run", Runs: true},
	{ID: "Q3", Name: "Average judging rounds (observe)", Kind: "mean", Unit: "rounds", Numerator: "sum of rounds", Denominator: "merged tickets with recorded rounds",
		Dimensions: runDims, Source: "run.recorded", Authority: "authoritative", Avail: "yes", Target: "< 1.3", Parity: "observe.py scorecard average_rounds", Stream: "run", Runs: true},
	{ID: "Q4", Name: "Verification failures by kind", Kind: "count", Unit: "checks", Numerator: "failed checks", Denominator: "per period",
		Dimensions: with("target_kind"), Source: "cell lifecycle (verify.check_recorded)", Authority: "authoritative", Avail: "lifecycle", Stream: "lifecycle",
		Partial: "a count only: the catalog's denominator (failed verifications) and observe's finding_kind grouping are not computed"},
	{ID: "R1", Name: "Review rejection rate", Kind: "rate", Numerator: "review.decided REJECTED or ESCALATE", Denominator: "decided rounds",
		Dimensions: with("round"), Source: "cell lifecycle", Authority: "authoritative", Limitations: "not split by seat: a decision belongs to the round, not to one seat's vote", Avail: "lifecycle", Stream: "lifecycle"},
	{ID: "R2", Name: "Blockers by rule", Kind: "count", Unit: "findings", Numerator: "blocker findings", Denominator: "per period",
		Dimensions: with("rule", "seat"), Source: "reconstructed review.finding", Authority: "reconstructed", Avail: "yes", Stream: "observer",
		Partial: "a count only: the catalog's denominator (rounds) is not computed; run.recorded blockers are reduced to a count by the observer"},
	{ID: "R3", Name: "Security veto rate", Kind: "rate", Numerator: "review.decided with security_veto", Denominator: "decided rounds with a security seat",
		Dimensions: cellDims, Source: "cell lifecycle", Authority: "authoritative", Avail: "lifecycle", Stream: "lifecycle"},
	{ID: "R4", Name: "Remediation time", Kind: "duration", Numerator: "rejection or failed verification to the next PASS", Denominator: "remediated rounds", Source: "cell lifecycle", Authority: "authoritative", Avail: "lifecycle", Unavailable: deferred, Deferred: true},
	{ID: "R5", Name: "Escalation rate (observe)", Kind: "rate", Numerator: "tickets escalated", Denominator: "finished tickets",
		Dimensions: runDims, Source: "run.recorded", Authority: "authoritative", Avail: "yes", Target: "< 0.05", Parity: "observe.py scorecard escalation_rate", Stream: "run", Runs: true},
	{ID: "R6", Name: "Abandonment rate (observe)", Kind: "rate", Numerator: "outcome abandoned", Denominator: "finished tickets",
		Dimensions: runDims, Source: "run.recorded", Authority: "authoritative", Avail: "yes", Parity: "observe.py scorecard abandonment_rate", Stream: "run", Runs: true},
	{ID: "X1", Name: "Execution retries", Kind: "rate", Numerator: "execution.failed", Denominator: "executions claimed",
		Dimensions: with("stage", "ticket"), Source: "intake log", Authority: "authoritative", Avail: "yes", Stream: "intake"},
	{ID: "X2", Name: "Gate refusals", Kind: "rate", Numerator: "gate.evaluated refused", Denominator: "gate evaluations",
		Dimensions: with("gate", "station", "reason_code"), Source: "cell lifecycle", Authority: "authoritative", Limitations: "a refused command that crashed before its station's error handler is not recorded; a failed verification verdict is recorded as a refusal of the verify.verdict gate", Avail: "lifecycle", Stream: "lifecycle"},
	{ID: "X3", Name: "Overrides", Kind: "rate", Numerator: "gate.evaluated overridden", Denominator: "build tasks completed",
		Dimensions: with("gate", "reason_code"), Source: "cell lifecycle", Authority: "authoritative", Limitations: "the override's reason text stays in build-report.json; by gate, the denominator is every build task completed", Avail: "lifecycle", Stream: "lifecycle", Split: []string{"gate", "reason_code"}},
	{ID: "S1", Name: "Recovery events", Kind: "rate", Numerator: "recovery.started", Denominator: "executions claimed",
		Dimensions: with("kind"), Source: "intake log", Authority: "authoritative", Limitations: "supervisor ticks are not events; the denominator is executions; by kind, it is every execution claimed", Avail: "yes", Stream: "intake", Split: []string{"kind"}},
	{ID: "S2", Name: "Outcome-unknown rate", Kind: "rate", Numerator: "executions whose outcome is unknown (recovery.started outcome-unknown)", Denominator: "executions claimed",
		Dimensions: cellDims, Source: "intake log", Authority: "authoritative", Avail: "yes", Stream: "intake"},
	{ID: "S3", Name: "Executions that moved the ticket", Kind: "rate", Numerator: "execution.completed", Denominator: "execution.completed plus execution.failed",
		Dimensions: with("stage"), Source: "intake log", Authority: "authoritative", Avail: "yes", Stream: "intake"},
	{ID: "S4", Name: "Tickets parked for a person", Kind: "count", Unit: "events", Numerator: "human.required", Denominator: "per period",
		Dimensions: cellDims, Source: "intake log", Authority: "authoritative", Avail: "yes", Stream: "intake",
		Partial: "a count of events only: the catalog's denominator (tickets executed) and its grouping by reason are not computed"},
	{ID: "S5", Name: "Refused tools", Kind: "count", Unit: "refusals", Numerator: "tool.refused", Denominator: "per period",
		Dimensions: with("tool"), Source: "execution stream", Authority: "observed", Limitations: "program names only", Avail: "yes", Stream: "stream",
		Partial: "a count only: the catalog's denominator (executions) is not computed"},
	{ID: "S6", Name: "Workflows killed", Kind: "rate", Numerator: "workflow.finished killed", Denominator: "workflows finished",
		Dimensions: with("stop_reason"), Source: "execution stream", Authority: "observed", Limitations: "a killed run's reported cost may be low", Avail: "stream", Stream: "stream",
		Partial: "the denominator is workflows finished, not workflows started: a workflow with no recorded finish is not counted"},
	{ID: "K1", Name: "Recorded cost per execution", Kind: "mean", Unit: "usd", Numerator: "execution.completed.cost_usd", Denominator: "executions with a recorded cost",
		Dimensions: with("stage", "ticket"), Source: "intake log (Claude-reported, recorded by MACH)", Authority: "authoritative", Limitations: "null when the run had no result; coverage says how many executions had one; execution.failed carries no cost", Avail: "yes", Stream: "intake"},
	{ID: "K2", Name: "Recorded cost per model", Kind: "mean", Unit: "usd", Numerator: "execution.usage.models[m].cost_usd", Denominator: "executions that used the model",
		Dimensions: with("model"), Source: "execution stream", Authority: "observed", Limitations: "per execution, never per agent; the coverage counts completed executions with a usage record, the denominator execution-model pairs with a cost", Avail: "yes", Stream: "stream", CoverUnit: "completed executions",
		OtherUnit: map[string]string{ExPairNoCost: "execution-model pairs"}},
	{ID: "K3", Name: "Tokens per model", Kind: "mean", Unit: "tokens", Numerator: "input + output + cache tokens from execution.usage.models[m]", Denominator: "executions that used the model",
		Dimensions: with("model", "token_kind"), Source: "execution stream", Authority: "observed", Limitations: "as K2; by token kind, the denominator is every execution that used the model", Avail: "yes", Stream: "stream", Split: []string{"token_kind"}, CoverUnit: "completed executions"},
	{ID: "K4", Name: "Recorded cost per ticket", Kind: "mean", Unit: "usd", Numerator: "sum of K1 over the ticket's executions", Denominator: "tickets with a recorded cost",
		Dimensions: with("ticket"), Source: "intake log", Authority: "authoritative", Limitations: "excludes hand-driven work (no execution); includes other tickets' work run inside the execution (the belt's tuning ticket); in a window, a ticket counts once and only its cost recorded in the window", Avail: "yes", Stream: "intake", Distinct: "ticket"},
	{ID: "K5", Name: "Cost per station or per agent", Kind: "mean", Source: "none", Avail: "no", Unavailable: "not available: the stream gives no per-agent cost, and no price table is applied to tokens", Limitations: "never estimated"},
	{ID: "K6", Name: "Turns and duration per execution", Kind: "mean", Source: "execution stream", Avail: "no", Unavailable: "not recorded: the version 3 event contract does not forward result.num_turns or result.duration_ms (they describe the last turn only, not the execution); an execution's wall time is served by /api/v1/runs, not as K6"},
	{ID: "K7", Name: "Tokens per agent", Kind: "mean", Unit: "tokens", Numerator: "agent.finished.tokens", Denominator: "finished agents with a token total",
		Dimensions: with("station", "seat", "model", "phase"), Source: "execution stream", Authority: "observed", Limitations: "one total per agent: no input, output or cache split; station and seat are read from the agent's label", Avail: "stream", Stream: "stream"},
	{ID: "K8", Name: "Agent time", Kind: "duration", Unit: "ms", Numerator: "agent.started to agent.finished", Denominator: "finished agents",
		Dimensions: with("station", "seat", "model"), Source: "execution stream", Authority: "observed", Limitations: "clerks carry no station; agents closed by the observer at process end are counted as bounded", Avail: "stream", Stream: "stream", Open: true},
	{ID: "K9", Name: "Agent queue time", Kind: "duration", Unit: "ms", Numerator: "agent.queued to agent.started", Denominator: "started agents",
		Dimensions: with("phase"), Source: "execution stream", Authority: "observed", Avail: "stream", Stream: "stream", Open: true},
	{ID: "K10", Name: "Tool calls per agent", Kind: "mean", Unit: "calls", Numerator: "agent.finished.tool_calls", Denominator: "finished agents with a count",
		Dimensions: with("station", "model"), Source: "execution stream", Authority: "observed", Limitations: "a count only; which tools and how long each took are not recorded", Avail: "stream", Stream: "stream"},
	{ID: "G1", Name: "Tests seen failing first (observe)", Kind: "rate", Numerator: "tests_seen_failing_first", Denominator: "tests_seen_failing_first plus tests_passing_on_first_run",
		Dimensions: runDims, Source: "run.recorded", Authority: "authoritative", Avail: "yes", Target: "> 0.9", Parity: "observe.py scorecard tests_failing_first_share", Stream: "run", Runs: true},
	{ID: "G2", Name: "Deviations per ticket (observe)", Kind: "mean", Unit: "deviations", Numerator: "deviations", Denominator: "finished tickets",
		Dimensions: runDims, Source: "run.recorded", Authority: "authoritative", Limitations: "not split by deviation type: the observer keeps a count per run", Avail: "yes", Parity: "observe.py scorecard deviations_per_ticket", Stream: "run", Runs: true},
	{ID: "G3", Name: "Evidence integrity", Kind: "rate", Numerator: "artifact.recorded evidence with integrity match", Denominator: "catalogued evidence",
		Dimensions: cellDims, Source: "observer (reconstructed)", Authority: "reconstructed", Avail: "yes", Stream: "observer"},
	{ID: "G4", Name: "Post-merge faults", Kind: "rate", Source: "none", Avail: "no", Unavailable: "not available: no recorded link from a telemetry ticket to the change that caused it"},
}

// Lookup returns a catalog entry.
func Lookup(id string) (Def, bool) {
	for _, d := range Catalog {
		if d.ID == id {
			return d, true
		}
	}
	return Def{}, false
}

// Supports reports whether a metric is recorded by a dimension (period dimensions are universal).
func (d Def) Supports(dim string) bool {
	if dim == "day" || dim == "week" {
		return d.Unavailable == ""
	}
	for _, x := range d.Dimensions {
		if x == dim {
			return true
		}
	}
	return false
}

func (d Def) split(dim string) bool {
	for _, x := range d.Split {
		if x == dim {
			return true
		}
	}
	return false
}

// Status is the M6.5 availability: available | partial | deferred | not-recorded.
func (d Def) Status() (string, string) {
	switch {
	case d.Unavailable != "" && d.Deferred:
		return "deferred", d.Unavailable
	case d.Unavailable != "":
		return "not-recorded", d.Unavailable
	case d.Partial != "":
		return "partial", d.Partial
	}
	return "available", ""
}

// GroupDims is every dimension any metric can be grouped or filtered by.
func GroupDims() map[string]bool {
	out := map[string]bool{"day": true, "week": true}
	for _, d := range Catalog {
		for _, x := range d.Dimensions {
			out[x] = true
		}
	}
	return out
}
