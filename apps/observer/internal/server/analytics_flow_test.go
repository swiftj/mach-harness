package server

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/feedtest"
)

// M6.5.3: /analytics/flow, /analytics/contributors and the extended /analytics/runs.

var envelopeKeys = []string{"cursor", "projection", "generated_ms", "window", "filters", "history"}

func waitForPos(t *testing.T, h *harness, pos uint64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if h.proj.Status().Pos >= pos {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("projection did not reach %d", pos)
}

func TestAnalyticsFlowRoutes(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	_, head := h.log.Bounds()
	waitForPos(t, h, head)

	flow := h.get(t, "/api/v1/analytics/flow")
	for _, k := range append(envelopeKeys, "stations", "transitions", "waits", "bottlenecks", "coverage", "rules", "wait_kinds") {
		if _, ok := flow[k]; !ok {
			t.Errorf("flow: no %q", k)
		}
	}
	stations := map[string]map[string]any{}
	for _, s := range flow["stations"].([]any) {
		m := s.(map[string]any)
		stations[m["station"].(string)] = m
	}
	if v := stations["verify"]; v == nil || v["visits"].(float64) != 2 || v["tickets"].(float64) != 1 {
		t.Fatalf("verify %v", v)
	}
	if b := stations["build"]; b["revise_entries"].(float64) != 1 || b["gates"].(map[string]any)["refused"].(float64) != 1 {
		t.Fatalf("build %v", b)
	}
	if from, _ := flow["history"].(map[string]any)["from_ms"].(float64); int64(from) != feedtest.At(0)-feedtest.At(0)%60_000 {
		t.Fatalf("history.from_ms: the first event's minute, got %v", from)
	}
	if q2 := h.get(t, "/api/v1/analytics/contributors?metric=Q2&last_runs=5"); q2["total"].(float64) != 1 {
		t.Fatalf("Q2 last_runs: %v", q2)
	}
	if h := flow["history"].(map[string]any); h["complete"] != false || len(h["gaps"].([]any)) != 1 {
		t.Fatalf("history: a lost gap was recorded: %v", h)
	}
	// The same cursor gives the same answer; filters narrow it; a window with nothing has no numbers.
	cur := flow["cursor"].(string)
	again := h.get(t, "/api/v1/analytics/flow?at="+cur)
	if again["cursor"] != cur || !sameJSON(again["stations"], flow["stations"]) {
		t.Fatalf("at the same cursor: %v", again["cursor"])
	}
	if hi := h.get(t, "/api/v1/analytics/flow?risk=High"); len(hi["stations"].([]any)) == 0 {
		t.Fatal("risk=High selects T-1 (its review recorded High)")
	}
	if lo := h.get(t, "/api/v1/analytics/flow?risk=Low"); len(lo["stations"].([]any)) != 0 || len(lo["bottlenecks"].([]any)) != 0 {
		t.Fatalf("risk=Low: %v", lo["stations"])
	}
	empty := h.get(t, "/api/v1/analytics/flow?from_ms=1000000000000&to_ms=1000000000001")
	if len(empty["stations"].([]any)) != 0 || empty["window"].(map[string]any)["effective_from_ms"].(float64) != 999993600000 ||
		empty["window"].(map[string]any)["effective_to_ms"].(float64) != 1000080000000 {
		t.Fatalf("empty window: %v %v", empty["stations"], empty["window"])
	}

	// contributors
	c := h.get(t, "/api/v1/analytics/contributors?metric=C1&group=station:verify&order=recent&limit=1")
	items := c["items"].([]any)
	if c["total"].(float64) != 2 || c["truncated"] != true || len(items) != 1 || items[0].(map[string]any)["ref"] != "visit:T-1/verify#2" {
		t.Fatalf("contributors %v", c)
	}
	for _, k := range append(envelopeKeys, "items", "total", "truncated", "by_basis", "figure") {
		if _, ok := c[k]; !ok {
			t.Errorf("contributors: no %q", k)
		}
	}
	if k2 := h.get(t, "/api/v1/analytics/contributors?metric=K2&model=claude-opus-5-5"); k2["total"].(float64) != 1 {
		t.Fatalf("K2 by model: %v", k2)
	}
	// x0fedcba98765 was interrupted (its process says so) before the outcome-unknown recovery: interrupted, not unknown.
	if s2 := h.get(t, "/api/v1/analytics/contributors?metric=S2"); s2["total"].(float64) != 0 {
		t.Fatalf("S2: %v", s2)
	}
	if ex := h.get(t, "/api/v1/analytics/contributors?metric=executions&group=state:interrupted,recovered:true"); ex["total"].(float64) != 1 {
		t.Fatalf("interrupted and recovered: %v", ex)
	}

	// runs: backward compatible, with usage and provenance per execution
	runs := h.get(t, "/api/v1/analytics/runs")
	for _, k := range append(envelopeKeys, "items", "total", "offset", "more", "excluded") {
		if _, ok := runs[k]; !ok {
			t.Errorf("runs: no %q", k)
		}
	}
	run := runs["items"].([]any)[0].(map[string]any)
	if run["ticket_id"] != "T-1" || run["outcome"] != "merged" || run["rounds"].(float64) != 2 || run["wave"] != "WAVE-001" {
		t.Fatalf("run %v", run)
	}
	execs := run["executions"].([]any)
	if len(execs) != 2 {
		t.Fatalf("executions %v", execs)
	}
	for _, e := range execs {
		m := e.(map[string]any)
		if m["provenance"] != nil || m["provenance_recorded"] != false || m["provenance_reason"] != "not-recorded" {
			t.Errorf("provenance not recorded must be null: %v", m)
		}
		u := m["usage"].(map[string]any)
		switch m["execution_id"] {
		case "x0123456789ab":
			if u["recorded"] != true || u["complete"] != true || len(u["sources"].([]any)) != 2 {
				t.Errorf("usage %v", u)
			}
		case "x0fedcba98765":
			if u["recorded"] != false || u["complete"] != nil {
				t.Errorf("unknown outcome, nothing recorded: %v", u)
			}
		}
	}
	if ex := h.get(t, "/api/v1/analytics/runs?of=executions&model=claude-opus-5-5"); ex["total"].(float64) != 1 {
		t.Fatalf("executions by model %v", ex)
	}
	if lr := h.get(t, "/api/v1/analytics/runs?last_runs=1&outcome=merged"); lr["total"].(float64) != 1 || lr["window"].(map[string]any)["last_runs"].(float64) != 1 {
		t.Fatalf("last_runs %v", lr)
	}
	if pr := h.get(t, "/api/v1/analytics/runs?of=executions&provenance=not-recorded"); pr["total"].(float64) != 2 {
		t.Fatalf("provenance not recorded %v", pr)
	}
	if pr := h.get(t, "/api/v1/analytics/runs?provenance="+strings.Repeat("ab", 32)); pr["total"].(float64) != 0 {
		t.Fatalf("no execution has that configuration %v", pr)
	}
	if none := h.get(t, "/api/v1/analytics/runs?outcome=abandoned"); none["total"].(float64) != 0 || len(none["items"].([]any)) != 0 {
		t.Fatalf("abandoned %v", none)
	}
}

func sameJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func TestAnalyticsFlowParametersAreChecked(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	for _, path := range []string{
		"/api/v1/analytics/flow?nope=1",
		"/api/v1/analytics/flow?risk=high",
		"/api/v1/analytics/flow?app_type=spaceship",
		"/api/v1/analytics/flow?from_ms=10&to_ms=5",
		"/api/v1/analytics/flow?from_ms=x",
		"/api/v1/analytics/flow?model=claude-opus-5-5",
		"/api/v1/analytics/flow?last_runs=5",
		"/api/v1/analytics/flow?last_runs=5&from_ms=1",
		"/api/v1/analytics/flow?risk=High&risk=Low",
		"/api/v1/analytics/contributors",
		"/api/v1/analytics/contributors?metric=ZZ",
		"/api/v1/analytics/contributors?metric=C1&limit=501",
		"/api/v1/analytics/contributors?metric=C1&order=best",
		"/api/v1/analytics/contributors?metric=C1&group=model:x",
		"/api/v1/analytics/contributors?metric=C1&group=station",
		"/api/v1/analytics/contributors?metric=X1&station=build",
		"/api/v1/analytics/contributors?metric=C1&last_runs=5",
		"/api/v1/analytics/runs?of=agents",
		"/api/v1/analytics/runs?station=build",
		"/api/v1/analytics/runs?of=executions&outcome=merged",
		"/api/v1/analytics/runs?limit=0",
	} {
		resp, env, body := h.do(t, "GET", path, nil)
		if resp.StatusCode != http.StatusBadRequest || env.Error == nil || env.Error.Kind != KindInvalid {
			t.Errorf("%s: %d %s", path, resp.StatusCode, body)
		}
	}
	// A cursor of another generation is a 409; analytics routes are GET only.
	if resp, _, body := h.do(t, "GET", "/api/v1/analytics/flow?at=fedcba9876543210.1", nil); resp.StatusCode != http.StatusConflict {
		t.Errorf("foreign cursor: %d %s", resp.StatusCode, body)
	}
	for _, path := range []string{"/api/v1/analytics/flow", "/api/v1/analytics/contributors?metric=C1", "/api/v1/analytics/runs"} {
		if resp, _, _ := h.do(t, "POST", path, nil); resp.StatusCode == http.StatusOK {
			t.Errorf("POST %s answered", path)
		}
		req, _ := http.NewRequest("GET", h.base+path, nil)
		if resp, err := http.DefaultClient.Do(req); err == nil {
			if resp.StatusCode == http.StatusOK {
				t.Errorf("%s answered without the session", path)
			}
			resp.Body.Close()
		}
	}
}

// An empty project: every route answers, with empty lists and no numbers.
func TestAnalyticsFlowEmptyProject(t *testing.T) {
	h := start(t, config{})
	flow := h.get(t, "/api/v1/analytics/flow")
	if len(flow["stations"].([]any)) != 0 || len(flow["bottlenecks"].([]any)) != 0 || flow["history"].(map[string]any)["complete"] != true {
		t.Fatalf("flow %v", flow)
	}
	c := h.get(t, "/api/v1/analytics/contributors?metric=W3")
	if c["total"].(float64) != 0 || len(c["items"].([]any)) != 0 || c["truncated"] != false {
		t.Fatalf("contributors %v", c)
	}
	r := h.get(t, "/api/v1/analytics/runs")
	if r["total"].(float64) != 0 || len(r["items"].([]any)) != 0 {
		t.Fatalf("runs %v", r)
	}
	if !strings.HasSuffix(flow["cursor"].(string), ".0") {
		t.Fatalf("cursor %v", flow["cursor"])
	}
}

// A recorded snapshot is passed through as recorded and selects by its config_id.
func TestAnalyticsRunsProvenancePassThrough(t *testing.T) {
	id := strings.Repeat("cd", 32)
	evs := []map[string]any{
		feedtest.New("intake-log", "work.claimed", 1000).Ticket("T-1").Exec("x0123456789pp").Data(map[string]any{"stage": "planned", "next": "build", "attempt": 1}).Build(),
		feedtest.New("intake-log", "execution.started", 1000).Ticket("T-1").Exec("x0123456789pp").Data(map[string]any{"until": "merge", "workflow": "mach-belt",
			"provenance": map[string]any{"schema": 1, "config_id": id}, "source_commit": "0123456789ab"}).Build(),
		feedtest.New("intake-log", "work.claimed", 2000).Ticket("T-2").Exec("x0123456789qq").Data(map[string]any{"stage": "planned", "next": "build", "attempt": 1}).Build(),
	}
	h := start(t, config{events: evs})
	_, head := h.log.Bounds()
	waitForPos(t, h, head)
	got := h.get(t, "/api/v1/analytics/runs?of=executions&provenance="+id)
	items := got["items"].([]any)
	if got["total"].(float64) != 1 || len(items) != 1 {
		t.Fatalf("by config_id %v", got)
	}
	e := items[0].(map[string]any)
	if e["provenance_recorded"] != true || e["provenance"].(map[string]any)["config_id"] != id || e["source_commit"] == nil {
		t.Fatalf("passed through %v", e)
	}
	if other := h.get(t, "/api/v1/analytics/runs?of=executions&provenance=not-recorded"); other["total"].(float64) != 1 {
		t.Fatalf("not recorded %v", other)
	}
}

// as_of_ms is a time filter on every analytics route: exact on flow, contributors and runs (the
// scenario's merge at 44 s and run record at 52 s do not exist half a second before the merge);
// whole UTC days before the playhead on metrics and insights.
func TestAnalyticsAsOf(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	_, head := h.log.Bounds()
	waitForPos(t, h, head)
	ms := feedtest.At(43500)
	asOf := "as_of_ms=" + strconv.FormatInt(ms, 10)
	headCursor := h.get(t, "/api/v1/analytics/flow")["cursor"]
	before := func(path string, exact bool) map[string]any {
		t.Helper()
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		d := h.get(t, path+sep+asOf)
		a, _ := d["as_of"].(map[string]any)
		want := float64(ms)
		if !exact {
			want = float64(ms - ms%86_400_000)
		}
		if a == nil || a["ms"].(float64) != float64(ms) || a["exact"] != exact || a["effective_to_ms"].(float64) != want || a["rule"] == "" {
			t.Fatalf("%s: as_of %v", path, d["as_of"])
		}
		if d["cursor"] != headCursor {
			t.Fatalf("%s: as_of is a time filter at the cursor, got %v", path, d["cursor"])
		}
		return d
	}
	merged := func(flow map[string]any) bool {
		for _, tr := range flow["transitions"].([]any) {
			if tr.(map[string]any)["to"] == "merged" {
				return true
			}
		}
		return false
	}
	if !merged(h.get(t, "/api/v1/analytics/flow")) || merged(before("/api/v1/analytics/flow", true)) {
		t.Fatal("flow: the merge must appear at the head only")
	}
	// The merge visit (entered at 43 s) is open as of 43.5 s.
	for _, st := range before("/api/v1/analytics/flow", true)["stations"].([]any) {
		if m := st.(map[string]any); m["station"] == "merge" && m["open_visits"].(float64) != 1 {
			t.Fatalf("merge visit as of 43.5 s: %v", m)
		}
	}
	if h.get(t, "/api/v1/analytics/contributors?metric=Q2")["total"].(float64) != 1 || before("/api/v1/analytics/contributors?metric=Q2", true)["total"].(float64) != 0 {
		t.Fatal("contributors: the run record is later than as_of_ms")
	}
	if x := before("/api/v1/analytics/contributors?metric=executions&group=state:interrupted", true); x["total"].(float64) != 0 {
		t.Fatalf("x0fedcba98765 was still running at 43.5 s (its process ended at 45 s): %v", x)
	}
	if h.get(t, "/api/v1/analytics/runs")["total"].(float64) != 1 || before("/api/v1/analytics/runs", true)["total"].(float64) != 0 {
		t.Fatal("runs: the run record is later than as_of_ms")
	}
	ex := before("/api/v1/analytics/runs?of=executions", true)["items"].([]any)
	for _, e := range ex {
		m := e.(map[string]any)
		if m["execution_id"] == "x0fedcba98765" && m["state"] != "running" {
			t.Fatalf("as of 43.5 s the merge execution is running: %v", m["state"])
		}
	}
	t1 := func(d map[string]any) any {
		for _, m := range d["metrics"].([]any) {
			if m.(map[string]any)["id"] == "T1" {
				return m.(map[string]any)["value"]
			}
		}
		return "missing"
	}
	if v := t1(h.get(t, "/api/v1/analytics/metrics?ids=T1")); v != 1.0 {
		t.Fatalf("metrics at the head: T1 %v", v)
	}
	if v := t1(before("/api/v1/analytics/metrics?ids=T1", false)); v == 1.0 || v == "missing" {
		t.Fatalf("metrics as of the merge's own day: T1 %v (the day of the playhead is not included)", v)
	}
	nextDay := feedtest.At(0) - feedtest.At(0)%86_400_000 + 86_400_000 + 1000
	if v := t1(h.get(t, "/api/v1/analytics/metrics?ids=T1&as_of_ms="+strconv.FormatInt(nextDay, 10))); v != 1.0 {
		t.Fatalf("metrics as of the next day: T1 %v", v)
	}
	if w := before("/api/v1/analytics/metrics?ids=T1", false)["window"].(map[string]any); w["effective_to_ms"].(float64) != float64(ms-ms%86_400_000) {
		t.Fatalf("metrics window as of: %v", w)
	}
	before("/api/v1/analytics/insights", false)
	// With at: allowed, a time filter at that cursor.
	if d := h.get(t, "/api/v1/analytics/flow?"+asOf+"&at="+headCursor.(string)); merged(d) {
		t.Fatal("as_of with at")
	}
	// Before everything: nothing.
	if empty := h.get(t, "/api/v1/analytics/flow?as_of_ms=1000"); len(empty["stations"].([]any)) != 0 {
		t.Fatalf("before everything: %v", empty["stations"])
	}
}

// A history read back from files (stream by stream) gives the same as-of answers as the same
// history delivered live (in time order).
func TestAnalyticsAsOfBackfilledEqualsLive(t *testing.T) {
	live := feedtest.Scenario()
	backfill := append([]map[string]any(nil), live...)
	streamOf := func(e map[string]any) string { return e["origin"].(map[string]any)["stream"].(string) }
	rank := map[string]int{"cell-lifecycle": 0, "execution-stream": 1, "run-record": 2, "execution-record": 3, "intake-log": 4, "observer": 5}
	sort.SliceStable(backfill, func(i, j int) bool { return rank[streamOf(backfill[i])] < rank[streamOf(backfill[j])] })
	a, b := start(t, config{events: live}), start(t, config{events: backfill})
	for _, h := range []*harness{a, b} {
		_, head := h.log.Bounds()
		waitForPos(t, h, head)
	}
	strip := func(d map[string]any) string {
		delete(d, "cursor")
		delete(d, "generated_ms")
		data, _ := json.Marshal(d)
		return string(data)
	}
	for _, ms := range []int64{9000, 20000, 30000, 43500, 47000} {
		q := "as_of_ms=" + strconv.FormatInt(feedtest.At(ms), 10)
		for _, path := range []string{"/api/v1/analytics/flow?", "/api/v1/analytics/contributors?metric=C1&", "/api/v1/analytics/contributors?metric=waits&",
			"/api/v1/analytics/contributors?metric=executions&", "/api/v1/analytics/contributors?metric=X2&", "/api/v1/analytics/runs?", "/api/v1/analytics/runs?of=executions&"} {
			x, y := strip(a.get(t, path+q)), strip(b.get(t, path+q))
			if x != y {
				k := 0
				for k < len(x) && k < len(y) && x[k] == y[k] {
					k++
				}
				lo := max(0, k-200)
				t.Errorf("%s%s differs at %d:\nlive     ...%s\nbackfill ...%s", path, q, k, x[lo:min(len(x), k+200)], y[lo:min(len(y), k+200)])
			}
		}
	}
}
