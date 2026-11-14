package project

import "sort"

// Per-execution usage and provenance for /api/v1/analytics/runs (M6_5_DESIGN.md sections 3.4, 5).
// Recorded cost only: nothing is estimated, apportioned or priced.

// UsageFacts says what was recorded about an execution's spend.
type UsageFacts struct {
	// Recorded: some cost or token record exists for the execution.
	Recorded bool `json:"recorded"`
	// Complete: the record covers everything spent (false when the stream said its spend may be
	// low, a budget stop or a killed workflow may have hidden spend, or the process was stopped or
	// its outcome is unknown); null when nothing was recorded.
	Complete *bool `json:"complete"`
	// IncompleteReasons are codes, never prose.
	IncompleteReasons []string `json:"incomplete_reasons"`
	// Sources: execution.usage (the stream's result, observed) and execution.completed (the
	// supervisor's record, authoritative), whichever exist.
	Sources []string `json:"sources"`
	// CostUSD is the cost /runs serves (the stream's, else the supervisor's), with its source.
	CostUSD    *float64 `json:"cost_usd"`
	CostSource string   `json:"cost_source,omitempty"`
	// SupervisorCostUSD is execution.completed's cost (what K1 counts); null when not recorded.
	SupervisorCostUSD *float64 `json:"supervisor_cost_usd"`
	TokensTotal       *int64   `json:"tokens_total"`
	Models            []string `json:"models"`
}

// ExecutionUsage is an execution's usage facts at the state's position.
func ExecutionUsage(s *State, x *Execution) UsageFacts { return UsageOf(Run(s, x), x) }

// UsageOf is ExecutionUsage from the execution's view, already built.
func UsageOf(rv RunView, x *Execution) UsageFacts {
	u := UsageFacts{IncompleteReasons: []string{}, Sources: []string{}, Models: []string{}, CostUSD: rv.Cost.USD, CostSource: rv.Cost.Source,
		SupervisorCostUSD: x.CostUSD, TokensTotal: rv.Tokens}
	if x.Usage != nil {
		u.Sources = append(u.Sources, "execution.usage")
		for m := range x.Usage.Models {
			u.Models = append(u.Models, m)
		}
		sort.Strings(u.Models)
	}
	if x.CostUSD != nil {
		u.Sources = append(u.Sources, "execution.completed")
	}
	u.Recorded = len(u.Sources) > 0
	switch {
	case x.Usage != nil && x.Usage.CostComplete != nil:
		u.IncompleteReasons = append(u.IncompleteReasons, x.Usage.CostIncompleteReasons...)
		if !*x.Usage.CostComplete && len(x.Usage.CostIncompleteReasons) == 0 {
			u.IncompleteReasons = append(u.IncompleteReasons, "stream-incomplete")
		}
	default:
		if x.Usage != nil && x.Usage.BudgetExhausted {
			u.IncompleteReasons = append(u.IncompleteReasons, "budget-stop")
		}
		for _, ref := range sortedKeys(x.Workflows) {
			if x.Workflows[ref].Status == "killed" {
				u.IncompleteReasons = append(u.IncompleteReasons, "agents-killed-in-flight")
				break
			}
		}
	}
	switch rv.State {
	case "interrupted", "timed-out":
		u.IncompleteReasons = append(u.IncompleteReasons, "process-"+rv.State)
	case "unknown":
		u.IncompleteReasons = append(u.IncompleteReasons, "outcome-unknown")
	}
	if u.Recorded {
		u.Complete = ptr(len(u.IncompleteReasons) == 0)
	}
	return u
}

// ExecStartMS is where an execution is placed in a window: its claim, else its start; ok false
// when nothing recorded either.
func ExecStartMS(x *Execution) (int64, bool) {
	if st := execStart(x); st != nil {
		return stampMS(st), true
	}
	return 0, false
}
