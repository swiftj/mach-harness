// Package metrics holds Factory Analytics' source data: the metric catalog of
// M6_1_SHARED_CONTRACTS.md section 4.2 and mergeable aggregate cells (counts, sums, minimum,
// maximum and a fixed log-scale histogram) that the projection updates as events arrive.
//
// Rules kept here (shared contracts 4.1): recorded values only; every metric states its numerator,
// denominator, grouping, source and limitations; an empty denominator is null with a reason,
// never 0; nothing is estimated or apportioned. Where the observe station defines a metric, the
// same formula is used (observe.py scorecard).
package metrics

import (
	"math"
	"sort"
	"strconv"
	"strings"
)

// DefinitionsVersion changes whenever a definition or a fold rule changes; aggregates built under
// another version are rebuilt by replaying the log.
const DefinitionsVersion = 1

// Buckets is the histogram size: bucket 0 is under one second; bucket i (1..63) holds durations
// in [2^((i-1)/3), 2^(i/3)) seconds, so bucket 63 reaches about 30 days.
const Buckets = 64

// MaxGroups bounds the groups one metric keeps, so hostile identifiers cannot grow memory without
// limit; further groups are counted in Overflow.
const MaxGroups = 2000

// Agg is one aggregate cell. Every field merges by addition (min and max by comparison).
type Agg struct {
	Num     float64  `json:"num"`
	Den     float64  `json:"den"`
	Count   int64    `json:"count"`
	Sum     float64  `json:"sum"`
	Min     *float64 `json:"min,omitempty"`
	Max     *float64 `json:"max,omitempty"`
	Hist    []int64  `json:"hist,omitempty"`
	Covered float64  `json:"covered"`
	Of      float64  `json:"of"`
}

// Dim is one dimension value.
type Dim struct{ Key, Value string }

// Table is every aggregate, by metric and group ("" for the total, "station=build", "day=2026-11-12").
type Table struct {
	Version  int                        `json:"definitions_version"`
	Cells    map[string]map[string]*Agg `json:"cells"`
	Overflow int64                      `json:"overflow"`
}

// NewTable makes an empty table.
func NewTable() *Table {
	return &Table{Version: DefinitionsVersion, Cells: map[string]map[string]*Agg{}}
}

func groups(dims []Dim, day string) []string {
	out := []string{""}
	for _, d := range dims {
		if d.Value != "" {
			out = append(out, d.Key+"="+d.Value)
		}
	}
	if day != "" {
		out = append(out, "day="+day)
	}
	return out
}

func (t *Table) each(id string, dims []Dim, day string, f func(*Agg)) {
	m := t.Cells[id]
	if m == nil {
		m = map[string]*Agg{}
		t.Cells[id] = m
	}
	for _, g := range groups(dims, day) {
		a := m[g]
		if a == nil {
			if len(m) >= MaxGroups {
				t.Overflow++
				continue
			}
			a = &Agg{}
			m[g] = a
		}
		f(a)
	}
}

// Rate adds to a ratio: num over den.
func (t *Table) Rate(id string, dims []Dim, day string, num, den float64) {
	t.each(id, dims, day, func(a *Agg) { a.Num += num; a.Den += den })
}

// Count adds n occurrences.
func (t *Table) Count(id string, dims []Dim, day string, n float64) {
	t.each(id, dims, day, func(a *Agg) { a.Num += n })
}

// Cover records whether the source existed for one member of the denominator.
func (t *Table) Cover(id string, dims []Dim, day string, covered bool) {
	t.each(id, dims, day, func(a *Agg) {
		a.Of++
		if covered {
			a.Covered++
		}
	})
}

// Duration adds one measured duration in milliseconds.
func (t *Table) Duration(id string, dims []Dim, day string, ms int64) {
	v := float64(ms)
	b := bucket(ms)
	t.each(id, dims, day, func(a *Agg) {
		a.Count++
		a.Sum += v
		if a.Min == nil || v < *a.Min {
			a.Min = ptr(v)
		}
		if a.Max == nil || v > *a.Max {
			a.Max = ptr(v)
		}
		if a.Hist == nil {
			a.Hist = make([]int64, Buckets)
		}
		a.Hist[b]++
	})
}

func ptr[T any](v T) *T { return &v }

func bucket(ms int64) int {
	if ms < 1000 {
		return 0
	}
	b := int(math.Floor(3*math.Log2(float64(ms)/1000))) + 1
	return min(max(b, 1), Buckets-1)
}

// upper is a bucket's upper bound in milliseconds.
func upper(b int) float64 {
	if b == 0 {
		return 1000
	}
	return 1000 * math.Pow(2, float64(b)/3)
}

func quantile(h []int64, count int64, q float64) *float64 {
	if count == 0 || len(h) == 0 {
		return nil
	}
	target := int64(math.Ceil(q * float64(count)))
	var seen int64
	for i, n := range h {
		seen += n
		if seen >= target {
			return ptr(math.Round(upper(i)))
		}
	}
	return nil
}

// ---- the catalog ----

// Def is one catalog entry.
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
	Avail       string   `json:"availability"` // yes | lifecycle | stream | no
	// Unavailable, when set, is why this observer returns no value at all.
	Unavailable string `json:"-"`
	Target      string `json:"target,omitempty"` // observe parity: "< 1.3"
	Parity      string `json:"parity_with,omitempty"`
}

const (
	notRecorded = "not recorded: no source in MACH or Claude Code's stream holds this fact"
	deferred    = "not computed by this observer yet (deferred); the source events are served by /api/v1/events"
)

// Catalog is the metric catalog, in the shared contract's order.
var Catalog = []Def{
	{ID: "T1", Name: "Tickets merged", Kind: "count", Unit: "tickets", Numerator: "merge.completed", Denominator: "per period",
		Dimensions: []string{"risk", "app_type", "writer", "day"}, Source: "cell lifecycle", Authority: "authoritative", Limitations: "merged is not accepted (T2)", Avail: "lifecycle"},
	{ID: "T2", Name: "Accepted delivery", Kind: "count", Unit: "slices", Numerator: "slice.integrated", Denominator: "per period",
		Dimensions: []string{"wave", "day"}, Source: "intake log", Authority: "authoritative", Limitations: "stamped when the plan noticed; non-product tickets have no slice", Avail: "yes"},
	{ID: "T3", Name: "Waves delivered", Kind: "count", Numerator: "waves whose every current slice is integrated", Denominator: "per period", Source: "intake log", Authority: "authoritative", Avail: "yes", Unavailable: deferred},
	{ID: "C1", Name: "Station cycle time", Kind: "duration", Unit: "ms", Numerator: "sum of measured visit durations", Denominator: "visits with a measured duration",
		Dimensions: []string{"station", "round", "risk", "day"}, Source: "cell lifecycle (station.entered to station.exited)", Authority: "authoritative", Limitations: "cells without a lifecycle log are excluded", Avail: "lifecycle"},
	{ID: "C2", Name: "Station visits per ticket", Kind: "mean", Unit: "visits", Numerator: "visits", Denominator: "tickets with a lifecycle log",
		Dimensions: []string{"station"}, Source: "cell lifecycle", Authority: "authoritative", Avail: "lifecycle"},
	{ID: "C3", Name: "End-to-end cycle time, dispatch to merge", Kind: "duration", Unit: "ms", Numerator: "work.scheduled to merge.completed", Denominator: "merged product tickets",
		Dimensions: []string{"risk"}, Source: "intake log and cell lifecycle", Authority: "authoritative", Limitations: "product tickets only; whole-second start", Avail: "lifecycle"},
	{ID: "C4", Name: "End-to-end, eligible to integrated", Kind: "duration", Unit: "ms", Numerator: "dependency.resolved (or slice.materialized) to slice.integrated", Denominator: "integrated slices",
		Dimensions: []string{"wave"}, Source: "intake log", Authority: "authoritative", Limitations: "includes queue wait", Avail: "yes"},
	{ID: "C5", Name: "Wave lead time", Kind: "duration", Numerator: "wave.discovered to last slice.integrated", Denominator: "delivered waves", Source: "intake log", Authority: "authoritative", Avail: "yes", Unavailable: deferred},
	{ID: "W1", Name: "Dependency wait", Kind: "duration", Unit: "ms", Numerator: "dependency.blocked to dependency.resolved", Denominator: "slices ever blocked",
		Dimensions: []string{"wave"}, Source: "intake log", Authority: "authoritative", Avail: "yes"},
	{ID: "W2", Name: "Queue wait (eligible, not dispatched)", Kind: "duration", Unit: "ms", Numerator: "slice eligible to work.scheduled", Denominator: "dispatched slices",
		Dimensions: []string{"wave"}, Source: "intake log", Authority: "authoritative", Limitations: "cell-capacity and engineer waits are not separable (a slice waiting for a free cell is not recorded)", Avail: "yes"},
	{ID: "W2b", Name: "Execution-capacity wait", Kind: "duration", Unit: "ms", Numerator: "capacity.wait_changed waiting to released", Denominator: "tickets ever held for capacity",
		Source: "reconstructed from scheduling.decided.held[] (rule held-sentence)", Authority: "reconstructed", Limitations: "supervised mode only; never inferred from silence", Avail: "yes"},
	{ID: "W3", Name: "Human approval wait", Kind: "duration", Unit: "ms", Numerator: "review.decided AWAITING_HUMAN to human.approval_recorded", Denominator: "rounds awaiting a person",
		Dimensions: []string{"risk"}, Source: "cell lifecycle", Authority: "authoritative", Avail: "lifecycle"},
	{ID: "W4", Name: "Supervisor start latency", Kind: "duration", Unit: "ms", Numerator: "work.claimed to execution.process_started", Denominator: "executions started",
		Source: "intake log and execution records", Authority: "authoritative", Avail: "yes"},
	{ID: "W5", Name: "Observation lag", Kind: "duration", Unit: "ms", Numerator: "execution.process_ended to execution.completed", Denominator: "completed executions",
		Source: "execution records and intake log", Authority: "authoritative", Limitations: "measures the supervisor's poll, not work", Avail: "yes"},
	{ID: "Q1", Name: "First-pass verification", Kind: "rate", Numerator: "tickets whose round-1 verify.verdict gate is PASS", Denominator: "tickets with a round-1 verification",
		Dimensions: []string{"risk"}, Source: "cell lifecycle", Authority: "authoritative", Avail: "lifecycle"},
	{ID: "Q2", Name: "First-pass rate (observe)", Kind: "rate", Numerator: "merged tickets with first_pass", Denominator: "merged tickets",
		Dimensions: []string{"risk", "app_type"}, Source: "run.recorded", Authority: "authoritative", Avail: "yes", Target: "> 0.85", Parity: "observe.py scorecard first_pass_rate"},
	{ID: "Q3", Name: "Average judging rounds (observe)", Kind: "mean", Unit: "rounds", Numerator: "sum of rounds", Denominator: "merged tickets with recorded rounds",
		Dimensions: []string{"risk", "app_type"}, Source: "run.recorded", Authority: "authoritative", Avail: "yes", Target: "< 1.3", Parity: "observe.py scorecard average_rounds"},
	{ID: "Q4", Name: "Verification failures by kind", Kind: "count", Unit: "checks", Numerator: "failed checks", Denominator: "per period",
		Dimensions: []string{"target_kind"}, Source: "cell lifecycle (verify.check_recorded)", Authority: "authoritative", Avail: "lifecycle"},
	{ID: "R1", Name: "Review rejection rate", Kind: "rate", Numerator: "review.decided REJECTED or ESCALATE", Denominator: "decided rounds",
		Dimensions: []string{"risk", "round"}, Source: "cell lifecycle", Authority: "authoritative", Avail: "lifecycle"},
	{ID: "R2", Name: "Blockers by rule", Kind: "count", Unit: "findings", Numerator: "blocker findings", Denominator: "per period",
		Dimensions: []string{"rule", "seat"}, Source: "reconstructed review.finding", Authority: "reconstructed", Avail: "yes"},
	{ID: "R3", Name: "Security veto rate", Kind: "rate", Numerator: "review.decided with security_veto", Denominator: "decided rounds with a security seat",
		Dimensions: []string{"risk"}, Source: "cell lifecycle", Authority: "authoritative", Avail: "lifecycle"},
	{ID: "R4", Name: "Remediation time", Kind: "duration", Numerator: "rejection or failed verification to the next PASS", Denominator: "remediated rounds", Source: "cell lifecycle", Authority: "authoritative", Avail: "lifecycle", Unavailable: deferred},
	{ID: "R5", Name: "Escalation rate (observe)", Kind: "rate", Numerator: "tickets escalated", Denominator: "finished tickets",
		Dimensions: []string{"risk"}, Source: "run.recorded", Authority: "authoritative", Avail: "yes", Target: "< 0.05", Parity: "observe.py scorecard escalation_rate"},
	{ID: "R6", Name: "Abandonment rate (observe)", Kind: "rate", Numerator: "outcome abandoned", Denominator: "finished tickets",
		Source: "run.recorded", Authority: "authoritative", Avail: "yes", Parity: "observe.py scorecard abandonment_rate"},
	{ID: "X1", Name: "Execution retries", Kind: "rate", Numerator: "execution.failed", Denominator: "executions claimed",
		Dimensions: []string{"stage"}, Source: "intake log", Authority: "authoritative", Avail: "yes"},
	{ID: "X2", Name: "Gate refusals", Kind: "rate", Numerator: "gate.evaluated refused", Denominator: "gate evaluations",
		Dimensions: []string{"gate", "station", "reason_code"}, Source: "cell lifecycle", Authority: "authoritative", Limitations: "a refused command that crashed before its station's error handler is not recorded", Avail: "lifecycle"},
	{ID: "X3", Name: "Overrides", Kind: "rate", Numerator: "gate.evaluated overridden", Denominator: "build tasks completed",
		Dimensions: []string{"gate"}, Source: "cell lifecycle", Authority: "authoritative", Limitations: "the override's reason text stays in build-report.json", Avail: "lifecycle"},
	{ID: "S1", Name: "Recovery events", Kind: "rate", Numerator: "recovery.started", Denominator: "executions claimed",
		Dimensions: []string{"kind"}, Source: "intake log", Authority: "authoritative", Limitations: "supervisor ticks are not events; the denominator is executions", Avail: "yes"},
	{ID: "S2", Name: "Outcome-unknown rate", Kind: "rate", Numerator: "executions whose outcome is unknown (recovery.started outcome-unknown)", Denominator: "executions claimed",
		Source: "intake log", Authority: "authoritative", Avail: "yes"},
	{ID: "S3", Name: "Executions that moved the ticket", Kind: "rate", Numerator: "execution.completed", Denominator: "execution.completed plus execution.failed",
		Dimensions: []string{"stage"}, Source: "intake log", Authority: "authoritative", Avail: "yes"},
	{ID: "S4", Name: "Tickets parked for a person", Kind: "count", Unit: "events", Numerator: "human.required", Denominator: "per period", Source: "intake log", Authority: "authoritative", Avail: "yes"},
	{ID: "S5", Name: "Refused tools", Kind: "count", Unit: "refusals", Numerator: "tool.refused", Denominator: "per period",
		Dimensions: []string{"tool"}, Source: "execution stream", Authority: "observed", Limitations: "program names only", Avail: "yes"},
	{ID: "S6", Name: "Workflows killed", Kind: "rate", Numerator: "workflow.finished killed", Denominator: "workflows finished",
		Dimensions: []string{"stop_reason"}, Source: "execution stream", Authority: "observed", Limitations: "a killed run's reported cost may be low", Avail: "stream"},
	{ID: "K1", Name: "Recorded cost per execution", Kind: "mean", Unit: "usd", Numerator: "execution.completed.cost_usd", Denominator: "executions with a recorded cost",
		Dimensions: []string{"stage"}, Source: "intake log (Claude-reported, recorded by MACH)", Authority: "authoritative", Limitations: "null when the run had no result; coverage says how many executions had one", Avail: "yes"},
	{ID: "K2", Name: "Recorded cost per model", Kind: "mean", Unit: "usd", Numerator: "execution.usage.models[m].cost_usd", Denominator: "executions that used the model",
		Dimensions: []string{"model"}, Source: "execution stream", Authority: "observed", Limitations: "per execution, never per agent", Avail: "yes"},
	{ID: "K3", Name: "Tokens per model", Kind: "mean", Unit: "tokens", Numerator: "input + output + cache tokens from execution.usage.models[m]", Denominator: "executions that used the model",
		Dimensions: []string{"model", "token_kind"}, Source: "execution stream", Authority: "observed", Limitations: "as K2", Avail: "yes"},
	{ID: "K4", Name: "Recorded cost per ticket", Kind: "mean", Unit: "usd", Numerator: "sum of K1 over the ticket's executions", Denominator: "tickets with a recorded cost",
		Dimensions: []string{"ticket"}, Source: "intake log", Authority: "authoritative", Limitations: "excludes hand-driven work (no execution); includes other tickets' work run inside the execution (the belt's tuning ticket)", Avail: "yes"},
	{ID: "K5", Name: "Cost per station or per agent", Kind: "mean", Source: "none", Avail: "no", Unavailable: "not available: the stream gives no per-agent cost, and no price table is applied to tokens", Limitations: "never estimated"},
	{ID: "K6", Name: "Turns and duration per execution", Kind: "mean", Source: "execution stream", Avail: "no", Unavailable: "not available: the version 3 contract does not forward result.num_turns or duration_ms (they describe the last turn only)"},
	{ID: "K7", Name: "Tokens per agent", Kind: "mean", Unit: "tokens", Numerator: "agent.finished.tokens", Denominator: "finished agents with a token total",
		Dimensions: []string{"station", "seat", "model", "phase"}, Source: "execution stream", Authority: "observed", Limitations: "one total per agent: no input, output or cache split; station and seat are read from the agent's label", Avail: "stream"},
	{ID: "K8", Name: "Agent time", Kind: "duration", Unit: "ms", Numerator: "agent.started to agent.finished", Denominator: "finished agents",
		Dimensions: []string{"station", "seat", "model"}, Source: "execution stream", Authority: "observed", Limitations: "clerks carry no station", Avail: "stream"},
	{ID: "K9", Name: "Agent queue time", Kind: "duration", Unit: "ms", Numerator: "agent.queued to agent.started", Denominator: "started agents",
		Dimensions: []string{"phase"}, Source: "execution stream", Authority: "observed", Avail: "stream"},
	{ID: "K10", Name: "Tool calls per agent", Kind: "mean", Unit: "calls", Numerator: "agent.finished.tool_calls", Denominator: "finished agents with a count",
		Dimensions: []string{"station", "model"}, Source: "execution stream", Authority: "observed", Limitations: "a count only; which tools and how long each took are not recorded", Avail: "stream"},
	{ID: "G1", Name: "Tests seen failing first (observe)", Kind: "rate", Numerator: "tests_seen_failing_first", Denominator: "tests_seen_failing_first plus tests_passing_on_first_run",
		Dimensions: []string{"risk"}, Source: "run.recorded", Authority: "authoritative", Avail: "yes", Target: "> 0.9", Parity: "observe.py scorecard tests_failing_first_share"},
	{ID: "G2", Name: "Deviations per ticket (observe)", Kind: "mean", Unit: "deviations", Numerator: "deviations", Denominator: "finished tickets",
		Source: "run.recorded", Authority: "authoritative", Avail: "yes", Parity: "observe.py scorecard deviations_per_ticket"},
	{ID: "G3", Name: "Evidence integrity", Kind: "rate", Numerator: "artifact.recorded evidence with integrity match", Denominator: "catalogued evidence",
		Source: "observer (reconstructed)", Authority: "reconstructed", Avail: "yes"},
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

// Group is one row of a grouped metric.
type Group struct {
	Key         string   `json:"key"`
	Value       *float64 `json:"value"`
	Numerator   *float64 `json:"numerator"`
	Denominator *float64 `json:"denominator"`
	P50         *float64 `json:"p50_ms,omitempty"`
	P90         *float64 `json:"p90_ms,omitempty"`
	Min         *float64 `json:"min_ms,omitempty"`
	Max         *float64 `json:"max_ms,omitempty"`
	NullReason  string   `json:"null_reason,omitempty"`
}

// Coverage is the share of the denominator for which the source existed.
type Coverage struct {
	Covered *float64 `json:"covered"`
	Of      *float64 `json:"of"`
	Share   *float64 `json:"share"`
	Reason  string   `json:"reason,omitempty"`
}

// Row is one metric as the API returns it.
type Row struct {
	Def
	Value       *float64 `json:"value"`
	Numerator   *float64 `json:"numerator_value"`
	Denominator *float64 `json:"denominator_value"`
	P50         *float64 `json:"p50_ms,omitempty"`
	P90         *float64 `json:"p90_ms,omitempty"`
	Min         *float64 `json:"min_ms,omitempty"`
	Max         *float64 `json:"max_ms,omitempty"`
	Met         *bool    `json:"met,omitempty"`
	Basis       string   `json:"basis"`
	NullReason  string   `json:"null_reason,omitempty"`
	Coverage    Coverage `json:"coverage"`
	GroupBy     string   `json:"group_by,omitempty"`
	Groups      []Group  `json:"groups,omitempty"`
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

// value turns one cell into a value, with the reason it is null.
func value(d Def, a *Agg) (g Group) {
	if a == nil {
		g.NullReason = "no events of this kind have been observed"
		return
	}
	switch d.Kind {
	case "count":
		g.Value, g.Numerator = ptr(a.Num), ptr(a.Num)
	case "rate", "mean":
		g.Numerator, g.Denominator = ptr(round3(a.Num)), ptr(a.Den)
		if a.Den == 0 {
			g.NullReason = "the denominator is empty"
		} else {
			g.Value = ptr(round3(a.Num / a.Den))
		}
	case "duration":
		g.Numerator, g.Denominator = ptr(a.Sum), ptr(float64(a.Count))
		if a.Count == 0 {
			g.NullReason = "no measured durations"
		} else {
			g.Value = ptr(math.Round(a.Sum / float64(a.Count)))
			g.P50, g.P90 = quantile(a.Hist, a.Count, 0.5), quantile(a.Hist, a.Count, 0.9)
			g.Min, g.Max = a.Min, a.Max
		}
	}
	return
}

// Rows evaluates the given metrics (all when ids is empty), grouped by one dimension when groupBy
// is set ("day" for periods).
func (t *Table) Rows(ids []string, groupBy string) []Row {
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	var out []Row
	for _, d := range Catalog {
		if len(want) > 0 && !want[d.ID] {
			continue
		}
		row := Row{Def: d, GroupBy: groupBy}
		if d.Unavailable != "" {
			row.Basis, row.NullReason = "not-recorded", d.Unavailable
			if d.Avail != "no" {
				row.Basis = "unknown"
			}
			row.Coverage.Reason = "no value"
			out = append(out, row)
			continue
		}
		cells := t.Cells[d.ID]
		total := value(d, cells[""])
		row.Value, row.Numerator, row.Denominator, row.NullReason = total.Value, total.Numerator, total.Denominator, total.NullReason
		row.P50, row.P90, row.Min, row.Max = total.P50, total.P90, total.Min, total.Max
		row.Basis = "measured"
		if d.Authority == "reconstructed" {
			row.Basis = "inferred"
		}
		if a := cells[""]; a != nil && a.Of > 0 {
			row.Coverage = Coverage{Covered: ptr(a.Covered), Of: ptr(a.Of), Share: ptr(round3(a.Covered / a.Of))}
		} else {
			row.Coverage.Reason = "coverage is not tracked for this metric"
		}
		if row.Value != nil && d.Target != "" {
			op, lim, _ := strings.Cut(d.Target, " ")
			limit := parseFloat(lim)
			met := (op == "<" && *row.Value < limit) || (op == ">" && *row.Value > limit)
			row.Met = &met
		}
		if groupBy != "" {
			prefix := groupBy + "="
			var keys []string
			for k := range cells {
				if strings.HasPrefix(k, prefix) {
					keys = append(keys, k)
				}
			}
			sort.Strings(keys)
			for _, k := range keys {
				g := value(d, cells[k])
				g.Key = strings.TrimPrefix(k, prefix)
				row.Groups = append(row.Groups, g)
			}
			if row.Groups == nil {
				row.Groups = []Group{}
			}
		}
		out = append(out, row)
	}
	return out
}

func parseFloat(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}
