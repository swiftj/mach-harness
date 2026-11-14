package analyticscheck

import (
	"fmt"
	"strings"
	"testing"

	"mach/observer/internal/metrics"
)

// Checks every scenario runs: the rules of M6_5_DESIGN.md section 2 that hold whatever the history.

// allIDs is every catalog metric.
func allIDs() string {
	var ids []string
	for _, d := range metrics.Catalog {
		ids = append(ids, d.ID)
	}
	return strings.Join(ids, ",")
}

// additive metrics: their value (or numerator and denominator) over groups sums to the total when
// every member falls in exactly one group. Distinct-ticket denominators (C2, K4) are not additive:
// one ticket may sit in two groups. Split metrics (X3, S1, K3) by a split dimension are not
// additive in the denominator by design.
var additiveByRisk = map[string]bool{"T1": true, "T2": true, "C1": true, "C3": true, "C4": true, "W1": true, "W2": true, "W2b": true, "W3": true,
	"W4": true, "W5": true, "Q1": true, "Q2": true, "Q3": true, "Q4": true, "R1": true, "R2": true, "R3": true, "R5": true, "R6": true, "X1": true,
	"X2": true, "X3": true, "S1": true, "S2": true, "S3": true, "S4": true, "S5": true, "S6": true, "K1": true, "K2": true, "K3": true, "K7": true,
	"K8": true, "K9": true, "K10": true, "G1": true, "G2": true, "G3": true}

// common runs the scenario-independent checks over the observer's current state.
func common(t *testing.T, o *obs) {
	t.Helper()
	all := o.metrics(allIDs(), "")
	for _, m := range arr(all["metrics"]) {
		row := obj(m)
		id := row["id"].(string)
		kind := row["kind"].(string)
		// Missing is not zero: a rate or mean with an empty or absent denominator has no value.
		if kind == "rate" || kind == "mean" {
			if d := num(row["denominator_value"]); (d == nil || *d == 0) && row["value"] != nil {
				t.Errorf("%s: value %v with denominator %v", id, row["value"], row["denominator_value"])
			}
		}
		// Not-recorded and deferred metrics never carry a number.
		if st := row["status"]; (st == "not-recorded" || st == "deferred") && (row["value"] != nil || row["numerator_value"] != nil) {
			t.Errorf("%s (%s): value %v numerator %v", id, st, row["value"], row["numerator_value"])
		}
		// Durations: the statistic stands on measured members only.
		if kind == "duration" && row["value"] != nil {
			if b := basis(row); b["measured"] != row["denominator_value"] {
				t.Errorf("%s: measured %v but denominator %v", id, b["measured"], row["denominator_value"])
			}
		}
		// Coverage reconciles: eligible = counted + every exclusion.
		cov := obj(row["coverage"])
		if el, co := num(cov["eligible"]), num(cov["counted"]); el != nil && co != nil {
			sum := *co
			for _, e := range arr(cov["excluded"]) {
				sum += obj(e)["count"].(float64)
			}
			if sum != *el {
				t.Errorf("%s: coverage eligible %v != counted %v + excluded %v", id, *el, *co, show(cov["excluded"]))
			}
		}
		if row["value"] != nil && row["sample_count"] == nil {
			t.Errorf("%s: a value with no sample count", id)
		}
	}
	// A window that holds none of the data gives no numbers (2020 is before every scenario).
	far := o.metrics(allIDs(), "&from_ms=1577836800000&to_ms=1577923200000")
	for _, m := range arr(far["metrics"]) {
		row := obj(m)
		if row["value"] != nil || row["numerator_value"] != nil {
			t.Errorf("%s in a window with no data: value %v numerator %v", row["id"], row["value"], row["numerator_value"])
		}
	}
	// Group sums reconcile with the total where the metric is additive.
	byRisk := o.metrics(allIDs(), "&group_by=risk")
	for _, m := range arr(byRisk["metrics"]) {
		row := obj(m)
		id := row["id"].(string)
		if !additiveByRisk[id] || row["groups_reason"] != nil {
			continue
		}
		reconcile(t, id+" by risk", row)
	}
	// Contributors carry no free text and match the figure they explain.
	for _, id := range []string{"C1", "waits", "W1", "W2", "W2b", "W3", "S4", "Q1", "verification_failures", "Q4", "R1", "R5", "X2", "X3",
		"executions", "X1", "S1", "S2", "K1", "K2"} {
		noFreeText(t, o.contributors(id, ""))
	}
	// /flow: a transition count is a count of consecutive visits.
	flow := o.get("/api/v1/analytics/flow")
	var visits, trans float64
	for _, s := range arr(flow["stations"]) {
		visits += obj(s)["visits"].(float64)
	}
	for _, x := range arr(flow["transitions"]) {
		trans += obj(x)["count"].(float64)
	}
	// Every visit is followed by exactly one transition (to the next visit, or terminal) unless it
	// is still open or is the last recorded one without a terminal outcome.
	if trans > visits {
		t.Errorf("flow: %v transitions from %v visits", trans, visits)
	}
}

// reconcile asserts the groups of a grouped row sum to its total: count metrics by value, rates
// and means by numerator and denominator, durations by sum and count.
func reconcile(t *testing.T, what string, row M) {
	t.Helper()
	var sv, sn, sd float64
	var any bool
	for _, g := range arr(row["groups"]) {
		gm := obj(g)
		any = true
		if v := num(gm["value"]); v != nil && row["kind"] == "count" {
			sv += *v
		}
		if v := num(gm["numerator"]); v != nil {
			sn += *v
		}
		if v := num(gm["denominator"]); v != nil {
			sd += *v
		}
	}
	if !any {
		if row["value"] != nil && row["kind"] == "count" {
			t.Errorf("%s: total %v but no groups", what, row["value"])
		}
		return
	}
	near := func(a, b float64) bool { return a-b < 1e-9 && b-a < 1e-9 }
	if n := num(row["numerator_value"]); n != nil && !near(*n, sn) {
		t.Errorf("%s: groups' numerators sum to %v, total %v (%s)", what, sn, *n, show(row["groups"]))
	}
	if row["kind"] != "count" {
		if d := num(row["denominator_value"]); d != nil && !near(*d, sd) {
			t.Errorf("%s: groups' denominators sum to %v, total %v", what, sd, *d)
		}
	}
	if row["kind"] == "count" {
		if v := num(row["value"]); v != nil && !near(*v, sv) {
			t.Errorf("%s: groups sum to %v, total %v", what, sv, *v)
		}
	}
}

// sameAt asserts that a reply read at a cursor is the same, byte for byte apart from generated_ms,
// as the reply read when the cursor was the head.
func sameAt(t *testing.T, o *obs, path, cursor, before string) {
	t.Helper()
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	code, b := o.raw(path + sep + "at=" + cursor)
	if code != 200 {
		t.Fatalf("%s at %s: %d %s", path, cursor, code, b)
	}
	if got := stripGenerated(b); got != before {
		t.Errorf("%s at the same cursor after more events: the answer changed\nbefore %s\nafter  %s", path, clip(before), clip(got))
	}
}

func clip(s string) string {
	if len(s) > 2500 {
		return s[:2500] + "…"
	}
	return s
}

// snapshot reads paths at the head and returns the cursor and each body without generated_ms.
func snapshot(t *testing.T, o *obs, paths ...string) (string, map[string]string) {
	t.Helper()
	out := map[string]string{}
	cursor := ""
	for _, p := range paths {
		code, b := o.raw(p)
		if code != 200 {
			t.Fatalf("%s: %d %s", p, code, b)
		}
		out[p] = stripGenerated(b)
		d := struct{ Data M }{}
		_ = d
		c := cursorOf(b)
		if cursor != "" && c != cursor {
			t.Fatalf("the head moved while reading (%s, %s)", cursor, c)
		}
		cursor = c
	}
	return cursor, out
}

func cursorOf(b []byte) string {
	i := strings.Index(string(b), `"cursor":"`)
	if i < 0 {
		return ""
	}
	rest := string(b)[i+10:]
	return rest[:strings.Index(rest, `"`)]
}

// cursorStable appends more history with more(), then checks every path at the old cursor.
func cursorStable(t *testing.T, o *obs, more func(), paths ...string) {
	t.Helper()
	cursor, before := snapshot(t, o, paths...)
	more()
	o.sync()
	c2, _ := snapshot(t, o, paths[0])
	if c2 == cursor {
		t.Fatalf("more() added nothing to the log")
	}
	for _, p := range paths {
		sameAt(t, o, p, cursor, before[p])
	}
}

func pf(format string, a ...any) string { return fmt.Sprintf(format, a...) }
