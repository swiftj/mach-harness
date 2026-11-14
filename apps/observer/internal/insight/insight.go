// Package insight is Factory Analytics' Improvement Opportunities (M6_5_DESIGN.md sections 3.5
// and 6): deterministic, explainable rules over the metric engine's figures.
//
// A rule is a pure function from figures already computed by the engine (metric rows of
// internal/metrics, the flow report and contributor lists of internal/project) to zero or more
// findings. No model, no randomness, no text from the Factory's records: wording comes from fixed
// templates (templates.go) with numbers filled in. A rule that lacks its minimum sample, or cannot
// honour the filters asked, returns nothing and says why in NotEvaluated, so a rule that cannot
// run is visible, not silent. Severity is "attention" or "note" only.
package insight

import (
	"mach/observer/internal/metrics"
	"mach/observer/internal/project"
)

// Severities.
const (
	Attention = "attention"
	Note      = "note"
)

// Rule ids. Stable: a client may key on them.
const (
	RuleStationShare      = "flow.station-time-share"
	RuleWaitP90           = "flow.wait-p90"
	RuleWaitShare         = "flow.wait-share"
	RuleRemediationShare  = "quality.remediation-share"
	RuleFirstPass         = "scorecard.first-pass"
	RuleRounds            = "scorecard.rounds"
	RuleEscalation        = "scorecard.escalation"
	RuleTrendRejections   = "trend.review-rejections"
	RuleTrendVerification = "trend.verification-failures"
	RuleRecurringFailure  = "quality.recurring-failure-kind"
	RuleRecurringGate     = "quality.recurring-gate-refusal"
	RuleRecurringBlocker  = "quality.recurring-blocker-rule"
	RuleCapacityHeld      = "reliability.capacity-held"
	RuleExecShare         = "reliability.execution-share"
	RuleExecLater         = "reliability.execution-later-window"
	RuleCostLater         = "economics.cost-later-window"
	RuleUsageMissing      = "data.usage-missing"
	RuleLifecycleCoverage = "data.lifecycle-coverage"
)

// Thresholds and minimum samples. Every one is documented in M6_5_DESIGN.md section 6.
const (
	StationShareMin       = 0.35 // a station's share of measured station time
	StationMinVisits      = 20   // measured visits over every station
	StationMinOwnVisits   = 5    // measured visits of the station named
	WaitP90MinMS          = 8 * 3_600_000
	WaitMinMeasured       = 5
	WaitShareMin          = 0.25
	C3MinMeasured         = 5
	RemediationShareMin   = 0.25
	RemediationMinVisits  = 20
	RemediationMinLater   = 5
	ScorecardMinDen       = 5 // observe.py MIN_TICKETS
	ObserveHistoryDepth   = 20
	TrendMinDen           = 10
	TrendMinCoverage      = 0.9
	TrendMinRise          = 0.10 // later minus earlier, as a share
	PatternMinTickets     = 2    // observe.py MIN_TICKETS_PER_PATTERN
	PatternMinShare       = 0.15 // observe.py MIN_SHARE
	PatternMinAnalyzed    = 5    // observe.py MIN_TICKETS
	CapacityMinDays       = 3
	CapacityMinWaits      = 3
	ExecMinClaimed        = 10
	ExecLaterMinRise      = 0.05
	CostMinExecutions     = 10
	CostMinCoverage       = 0.8
	CostRatioMin          = 1.25
	UsageMissingMin       = 0.10
	UsageMinEligible      = 10
	StreamUsageMissingMin = 0.10
	LifecycleCoverageMax  = 0.8 // a finding when the share is below this
	LifecycleMinTickets   = 5
	DefaultContributorMax = 100
)

// execShareMin is each execution measure's share threshold.
var execShareMin = map[string]float64{"S1": 0.10, "S2": 0.05, "X1": 0.10, "interrupted": 0.10}

// RuleDef describes one rule for the reply and the design document.
type RuleDef struct {
	ID        string   `json:"id"`
	Severity  string   `json:"severity"`
	Condition string   `json:"condition"`
	Threshold string   `json:"threshold"`
	Minimum   string   `json:"minimum"`
	Metrics   []string `json:"metrics"`
}

// Rules are every rule in evaluation (and listing) order.
var Rules = []RuleDef{
	{RuleStationShare, Note, "one station holds a large share of the total measured station visit time (volume-weighted: total, not mean)", "share >= 35%", "20 measured visits over all stations, 2 stations measured, 5 measured visits at the station", []string{"C1 (flow stations)"}},
	{RuleWaitP90, Note, "a wait kind's 90th percentile of measured waits is long", "p90 >= 8 h", "5 measured waits of the kind", []string{"W1", "W2", "W2b", "W3", "S4 (flow waits)"}},
	{RuleWaitShare, Note, "a wait kind inside dispatch-to-merge (execution capacity, human approval, parked for a person) totals a large share of measured dispatch-to-merge time", "wait total / C3 total >= 25%", "5 measured waits of the kind and 5 measured C3", []string{"W2b", "W3", "S4", "C3"}},
	{RuleRemediationShare, Note, "station visits in judging round 2 or later hold a large share of measured station time", "share >= 25%", "20 measured visits with a recorded round, 5 of them in round 2 or later", []string{"C1 by round"}},
	{RuleFirstPass, Attention, "first-pass rate is below the observe station's target", "Q2 not above 0.85 (target_check.met false, unrounded)", "5 merged tickets in the population", []string{"Q2"}},
	{RuleRounds, Attention, "average judging rounds is above the observe station's target", "Q3 not below 1.3 (met false)", "5 merged tickets with recorded rounds", []string{"Q3"}},
	{RuleEscalation, Attention, "escalation rate is above the observe station's target", "R5 not below 0.05 (met false)", "5 finished tickets", []string{"R5"}},
	{RuleTrendRejections, Attention, "review rejection rate is higher in the later of two consecutive equal windows", "later - earlier >= 10 points", "a bounded window; 10 decided rounds and 90% coverage in each window; no suspect window", []string{"R1"}},
	{RuleTrendVerification, Attention, "failed verification rate (refusals of the verify.verdict gate) is higher in the later of two consecutive equal windows", "later - earlier >= 10 points", "a bounded window; 10 verdicts and 90% coverage in each window; no suspect window", []string{"X2 (gate verify.verdict)"}},
	{RuleRecurringFailure, Note, "failed verification checks of one kind recur across tickets (observe.py pattern rule)", ">= 2 tickets and >= 15% of tickets that visited verification", "5 tickets analyzed", []string{"Q4 (contributors)", "verify visits (flow)"}},
	{RuleRecurringGate, Note, "refusals of one gate recur across tickets (observe.py pattern rule)", ">= 2 tickets and >= 15% of tickets with a lifecycle log", "5 tickets analyzed", []string{"X2 (contributors)", "flow coverage"}},
	{RuleRecurringBlocker, Note, "review blockers citing one rule code recur across tickets (observe.py pattern rule; blockers with no rule or a rule in prose are not a category)", ">= 2 tickets and >= 15% of tickets that visited review", "5 tickets analyzed", []string{"R2 (contributors)", "review visits (flow)"}},
	{RuleCapacityHeld, Note, "the scheduler recorded work held for a free place (its recorded limit on executions at once in use) on several days", ">= 3 day buckets with a recorded capacity wait beginning, >= 3 waits", "a recorded limit on executions at once", []string{"W2b", "capacity-slice waits", "factory limits"}},
	{RuleExecShare, Note, "recoveries, failed, interrupted or unknown-outcome executions above a share of executions (unknown outcome: attention)", "S1 >= 10%, S2 >= 5%, X1 >= 10%, interrupted >= 10%", "10 executions", []string{"S1", "S2", "X1", "executions (contributors)"}},
	{RuleExecLater, Note, "the same execution measures are higher in the later of two consecutive equal windows", "later - earlier >= 5 points", "a bounded window; 10 executions in each window", []string{"S1", "S2", "X1", "executions (contributors)"}},
	{RuleCostLater, Note, "recorded cost is higher in the later window while integrated slices are not higher", "later cost >= 1.25 x earlier cost and T2 later <= T2 earlier", "a bounded window; 10 executions with a recorded cost and 80% cost coverage in each window", []string{"K1", "T2"}},
	{RuleUsageMissing, Note, "executions without recorded usage (data quality): subject cost, executions expected to record a cost (not failed ones) with no cost recorded by the supervisor; subject stream, executions with no usage record from the stream", "missing >= 10%", "10 executions", []string{"K1 coverage", "usage-missing (contributors)"}},
	{RuleLifecycleCoverage, Note, "tickets without a lifecycle log (data quality)", "share with a log < 80%", "5 tickets", []string{"flow coverage"}},
}

// Coverage is a figure's coverage, as the engine gave it.
type Coverage struct {
	Eligible *float64 `json:"eligible"`
	Counted  *float64 `json:"counted"`
	Share    *float64 `json:"share"`
}

// Measurement is one supporting figure.
type Measurement struct {
	Metric      string    `json:"metric"`
	Label       string    `json:"label"`
	Value       *float64  `json:"value"`
	Unit        string    `json:"unit"`
	Numerator   *float64  `json:"numerator"`
	Denominator *float64  `json:"denominator"`
	SampleCount *float64  `json:"sample_count"`
	Coverage    *Coverage `json:"coverage"`
	Window      string    `json:"window"` // selection | later | earlier
}

// Sample is the finding's sample size and coverage.
type Sample struct {
	Count         float64  `json:"count"`
	Unit          string   `json:"unit"`
	CoverageShare *float64 `json:"coverage_share"`
	Population    string   `json:"population"`
}

// Span is a time window, in effective milliseconds (null: open side).
type Span struct {
	FromMS *int64 `json:"from_ms"`
	ToMS   *int64 `json:"to_ms"`
}

// FindingWindow is the window a finding describes.
type FindingWindow struct {
	FromMS   *int64 `json:"from_ms"`
	ToMS     *int64 `json:"to_ms"`
	LastRuns *int   `json:"last_runs"`
	// Comparison is the earlier window of a two-window rule.
	Comparison *Span `json:"comparison"`
}

// Investigation is the labelled possible investigation.
type Investigation struct {
	Label string `json:"label"`
	Text  string `json:"text"`
}

// Contributors is the link to the records behind a finding: the parameters of
// /api/v1/analytics/contributors, and the path built from them.
type Contributors struct {
	Metric string            `json:"metric"`
	Group  map[string]string `json:"group"`
	Order  string            `json:"order"`
	Limit  int               `json:"limit"`
	Path   string            `json:"path"`
	// Relation: exact (the records behind the figure) or related (the closest list the route serves).
	Relation string `json:"relation"`
	Note     string `json:"note,omitempty"`
}

// Finding is one insight.
type Finding struct {
	ID            string            `json:"id"`
	Rule          string            `json:"rule"`
	Subject       *string           `json:"subject"`
	Severity      string            `json:"severity"`
	Title         string            `json:"title"`
	Condition     string            `json:"condition"`
	Threshold     string            `json:"threshold"`
	Measurements  []Measurement     `json:"measurements"`
	Sample        Sample            `json:"sample"`
	Window        FindingWindow     `json:"window"`
	Filters       map[string]string `json:"filters"`
	Why           string            `json:"why"`
	Investigation Investigation     `json:"investigation"`
	Contributors  Contributors      `json:"contributors"`
}

// NotEvaluated is a rule (or one of its subjects) that did not run, and why.
type NotEvaluated struct {
	Rule    string  `json:"rule"`
	Subject *string `json:"subject"`
	Reason  string  `json:"reason"`
}

// Report is the result of Evaluate.
type Report struct {
	Findings     []Finding      `json:"insights"`
	NotEvaluated []NotEvaluated `json:"not_evaluated"`
}

// Recurring is one source of recurring categories: per category, the distinct tickets and count.
type Recurring struct {
	Reason     string // non-empty: not computable, and why
	Analyzed   int64
	Population string
	Groups     []RecurringGroup // sorted by key
}

// RecurringGroup is one category.
type RecurringGroup struct {
	Key     string
	Tickets int64
	Count   int64
}

// ExecFacts are execution counts by end state (from the engine's execution contributors).
type ExecFacts struct {
	Reason      string
	Total       int64
	Interrupted int64
}

// StreamUsageFacts count executions without an execution.usage record (the usage-missing list).
type StreamUsageFacts struct {
	Reason              string
	Executions, Missing int64
}

// CapacityFacts are the scheduler's recorded waits for a free place.
type CapacityFacts struct {
	Reason string
	Days   int64    // day buckets in which a capacity wait began
	Waits  int64    // waits
	Items  int64    // distinct tickets or slices
	Limit  *float64 // the latest recorded max_parallel
	Kind   string   // the wait kind with more waits (for the contributors link)
}

// Input is every figure the rules read, already computed by the engine.
type Input struct {
	Window   Span
	Prev     *Span  // the comparison window (the same length, just before); nil: none
	PrevWhy  string // why there is no comparison window
	LastRuns int
	Filters  map[string]string
	// AsOfMS is the as_of_ms asked (contributor links carry it).
	AsOfMS *int64
	// HistoryFromMS is when the recorded history begins (the envelope's history.from_ms); nil when
	// it is not known. A two-window rule runs only when its earlier window starts at or after it.
	HistoryFromMS *int64

	// Cur and PrevRows are metric rows by key: C1/round, C3, R1, X2/verify, S1, S2, X1, K1, T2.
	Cur, PrevRows map[string]metrics.Row
	// Score are Q2, Q3, R5 over the scorecard population.
	Score           map[string]metrics.Row
	ScorePopulation string
	// ScoreLastRuns is N when the scorecard population is the last N runs (0: a window).
	ScoreLastRuns int

	Flow       *project.FlowReport
	FlowReason string

	FailureKinds, GateRefusals, BlockerRules Recurring
	Exec, PrevExec                           ExecFacts
	// StreamUsage: executions in the selection and those with no usage record from the stream.
	StreamUsage StreamUsageFacts
	Capacity    CapacityFacts
}
