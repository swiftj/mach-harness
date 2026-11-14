package server

import (
	"net/url"
	"testing"

	"mach/observer/internal/feedtest"
)

func metricRow(t *testing.T, d map[string]any, id string) map[string]any {
	t.Helper()
	for _, m := range d["metrics"].([]any) {
		if row := m.(map[string]any); row["id"] == id {
			return row
		}
	}
	t.Fatalf("no %s in %v", id, d["metrics"])
	return nil
}

// M6.5 section 3.1: the envelope, two group dimensions, a window, trend buckets, the distribution,
// last_runs and the cursor; 400 for what the route cannot answer. An old client (ids and one
// group_by) keeps every field it read.
func TestAnalyticsMetricsQuery(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	d := h.get(t, "/api/v1/analytics/metrics?ids=C1,K3,Q2&group_by=station,risk&bucket=week&distribution=1&from_ms=0")
	for _, k := range []string{"cursor", "projection", "generated_ms", "window", "filters", "history", "metrics", "definitions_version", "group_overflow", "rules"} {
		if _, ok := d[k]; !ok {
			t.Fatalf("no %q", k)
		}
	}
	if d["window"].(map[string]any)["effective_from_ms"].(float64) != 0 {
		t.Fatalf("window %v", d["window"])
	}
	c1 := metricRow(t, d, "C1")
	for _, k := range []string{"value", "numerator_value", "denominator_value", "basis", "coverage", "groups", "status", "sample_count", "basis_counts", "buckets", "distribution", "population", "formula", "family"} {
		if _, ok := c1[k]; !ok {
			t.Fatalf("C1 has no %q: %v", k, c1)
		}
	}
	g := c1["groups"].([]any)[0].(map[string]any)
	if len(g["keys"].(map[string]any)) != 2 {
		t.Fatalf("groups %v", c1["groups"])
	}
	if cov := c1["coverage"].(map[string]any); cov["eligible"] == nil || cov["excluded"] == nil {
		t.Fatalf("coverage %v", cov)
	}
	if k3 := metricRow(t, d, "K3"); k3["groups_reason"] == nil || len(k3["groups"].([]any)) != 0 { // K3 is not recorded by station
		t.Fatalf("K3 %v", k3["groups_reason"])
	}
	// Old client: ids and group_by only.
	old := metricRow(t, h.get(t, "/api/v1/analytics/metrics?ids=K3&group_by=token_kind"), "K3")
	for _, g := range old["groups"].([]any) {
		if g.(map[string]any)["value"] == nil || g.(map[string]any)["key"] == "" {
			t.Fatalf("K3 by token_kind %v", old["groups"])
		}
	}
	// last_runs: the observe station's population; the rest is unavailable.
	lr := h.get(t, "/api/v1/analytics/metrics?ids=Q2,C1&last_runs=20")
	if metricRow(t, lr, "Q2")["value"] == nil || metricRow(t, lr, "C1")["status"] != "unavailable" || lr["window"].(map[string]any)["last_runs"].(float64) != 20 {
		t.Fatalf("last_runs %v", lr)
	}
	// The same cursor answers the same figures.
	cur := d["cursor"].(string)
	at := h.get(t, "/api/v1/analytics/metrics?ids=C1&at="+url.QueryEscape(cur))
	if at["cursor"] != cur || metricRow(t, at, "C1")["value"] != c1["value"] {
		t.Fatalf("at %v", at["cursor"])
	}
	for _, path := range []string{"?from=1", "?ids=C1&group_by=station,risk,round", "?group_by=station,station", "?bucket=month", "?distribution=yes",
		"?last_runs=5&from_ms=0", "?risk=high", "?ids=C1&ids=C2"} {
		if resp, env, _ := h.do(t, "GET", "/api/v1/analytics/metrics"+path, nil); resp.StatusCode != 400 || env.Error.Kind != KindInvalid {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
	}
}
