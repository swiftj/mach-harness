package server

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"mach/observer/internal/feedtest"
	"mach/observer/internal/insight"
)

// M6.5.5: /analytics/insights.
func TestAnalyticsInsightsRoute(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	_, head := h.log.Bounds()
	waitForPos(t, h, head)

	ins := h.get(t, "/api/v1/analytics/insights")
	for _, k := range append(envelopeKeys, "insights", "not_evaluated", "rules", "notice", "investigation_label") {
		if _, ok := ins[k]; !ok {
			t.Errorf("insights: no %q", k)
		}
	}
	if n := len(ins["rules"].([]any)); n != len(insight.Rules) {
		t.Fatalf("rules %d", n)
	}
	// The scenario is one ticket: every rule lacks its sample and says so; nothing is found.
	if len(ins["insights"].([]any)) != 0 {
		t.Fatalf("findings on one ticket: %v", ins["insights"])
	}
	listed := map[string]bool{}
	for _, n := range ins["not_evaluated"].([]any) {
		m := n.(map[string]any)
		listed[m["rule"].(string)] = true
		// The figures were read (the run record of T-1 is in the scorecard population).
		if m["rule"] == insight.RuleFirstPass && !strings.HasSuffix(m["reason"].(string), "; 1 recorded") {
			t.Fatalf("first-pass: %v", m)
		}
	}
	for _, d := range insight.Rules {
		if !listed[d.ID] {
			t.Errorf("rule %s neither found anything nor said why it did not run", d.ID)
		}
	}

	// The same cursor gives the same answer, byte for byte apart from generated_ms.
	cur := ins["cursor"].(string)
	strip := func(m map[string]any) string {
		delete(m, "generated_ms")
		b, _ := json.Marshal(m)
		return string(b)
	}
	a := strip(h.get(t, "/api/v1/analytics/insights?at="+cur))
	b := strip(h.get(t, "/api/v1/analytics/insights?at="+cur))
	if a != b || !strings.Contains(a, cur) {
		t.Fatal("same cursor, different reply")
	}

	// Window and filters are stated; a bounded window gives a comparison window to the two-window rules.
	w := h.get(t, "/api/v1/analytics/insights?from_ms=1000000000000&to_ms=1000000000001&risk=High")
	win := w["window"].(map[string]any)
	if win["effective_from_ms"].(float64) != 999993600000 || win["effective_to_ms"].(float64) != 1000080000000 || w["filters"].(map[string]any)["risk"] != "High" {
		t.Fatalf("window %v filters %v", win, w["filters"])
	}
	for _, n := range w["not_evaluated"].([]any) {
		m := n.(map[string]any)
		if m["rule"] == insight.RuleTrendRejections && strings.Contains(m["reason"].(string), "comparison window") {
			t.Fatalf("a bounded window has a comparison window: %v", m)
		}
	}

	// last_runs: only the scorecard rules read it.
	lr := h.get(t, "/api/v1/analytics/insights?last_runs=5")
	if lr["window"].(map[string]any)["last_runs"].(float64) != 5 {
		t.Fatal("last_runs not stated")
	}
	for _, n := range lr["not_evaluated"].([]any) {
		m := n.(map[string]any)
		if m["rule"] == insight.RuleStationShare && !strings.Contains(m["reason"].(string), "last_runs") {
			t.Fatalf("station share under last_runs: %v", m)
		}
	}

	// A filter a rule cannot honour: that rule says so, never silently unfiltered.
	md := h.get(t, "/api/v1/analytics/insights?model=claude-opus-5-5")
	found := false
	for _, n := range md["not_evaluated"].([]any) {
		m := n.(map[string]any)
		if m["rule"] == insight.RuleStationShare && strings.Contains(m["reason"].(string), "model filter") {
			found = true
		}
	}
	if !found {
		t.Fatalf("model filter: %v", md["not_evaluated"])
	}

	// as_of_ms without a window: the metric figures end at the start of the as_of day (not exact).
	ao := h.get(t, "/api/v1/analytics/insights?as_of_ms=1000000000000")
	if ao["window"].(map[string]any)["effective_to_ms"].(float64) != 999993600000 || ao["as_of"].(map[string]any)["exact"] != false {
		t.Fatalf("as_of: window %v as_of %v", ao["window"], ao["as_of"])
	}

	// Unknown parameters and bad values are refused.
	for _, q := range []string{"?bogus=1", "?risk=Huge", "?last_runs=3&from_ms=1"} {
		if resp, _, _ := h.do(t, "GET", "/api/v1/analytics/insights"+q, nil); resp.StatusCode != 400 {
			t.Errorf("%s: %d", q, resp.StatusCode)
		}
	}
}

// An outcome recorded after as_of_ms never changes a finding or a reason.
func TestAnalyticsInsightsAsOf(t *testing.T) {
	const day = int64(86_400_000)
	later := append(feedtest.Scenario(),
		feedtest.New("run-record", "run.recorded", 20*day).Ticket("T-2").Data(map[string]any{"outcome": "merged", "rounds": 3, "first_pass": false, "escalated": true}).Build())
	a := start(t, config{events: feedtest.Scenario()})
	b := start(t, config{events: later})
	for _, h := range []*harness{a, b} {
		_, head := h.log.Bounds()
		waitForPos(t, h, head)
	}
	read := func(h *harness, q string) string {
		d := h.get(t, "/api/v1/analytics/insights"+q)
		out, _ := json.Marshal([]any{d["insights"], d["not_evaluated"], d["window"]})
		return string(out)
	}
	asOf := "?as_of_ms=" + strconv.FormatInt(10*day+5, 10)
	if x, y := read(a, asOf), read(b, asOf); x != y {
		t.Fatalf("a later outcome changed the reply as of an earlier time:\n%s\n%s", x, y)
	}
	// Without as_of_ms the later run is read (the test can tell them apart).
	if read(a, "") == read(b, "") {
		t.Fatal("the later run record was not read at the head")
	}
}
