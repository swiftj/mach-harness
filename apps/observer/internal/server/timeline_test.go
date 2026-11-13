package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/feedtest"
	"mach/observer/internal/normalize"
	"mach/observer/internal/testkit"
)

var timelineRoutes = []string{"/api/v1/spans", "/api/v1/spans?span=cell:cell:T-1", "/api/v1/concurrency", "/api/v1/marks", "/api/v1/marks?after_ms=0&limit=1"}

func TestTimelineRoutesAreGetOnlyAndNeedTheSession(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	for _, path := range timelineRoutes {
		h.get(t, path)
		for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} {
			if resp, _, _ := h.do(t, method, path, nil); resp.StatusCode != http.StatusMethodNotAllowed || resp.Header.Get("Allow") != "GET" {
				t.Fatalf("%s %s: %d", method, path, resp.StatusCode)
			}
		}
		resp, err := http.Get(h.base + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s without a session: %d", path, resp.StatusCode)
		}
	}
	lim := h.get(t, "/api/v1/session")["limits"].(map[string]any)
	if lim["marks_max"] != float64(MaxMarks) || lim["concurrency_buckets_max"] != float64(MaxSeriesBuckets) || lim["spans_max"] != float64(MaxSpans) {
		t.Fatalf("session limits %v", lim)
	}
}

func TestTimelineParametersAreChecked(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	for _, path := range []string{
		"/api/v1/spans?from_ms=x", "/api/v1/spans?from_ms=10&to_ms=5", "/api/v1/spans?sort=end", "/api/v1/spans?kinds=nope",
		"/api/v1/spans?span=" + strings.Repeat("a", 401),
		"/api/v1/concurrency?bucket_ms=1500", "/api/v1/concurrency?from_ms=0&to_ms=100000000&bucket_ms=1000", "/api/v1/concurrency?kinds=nope",
		"/api/v1/concurrency?from_ms=10&to_ms=10",
		"/api/v1/marks?after_ms=1&before_ms=2", "/api/v1/marks?limit=0", "/api/v1/marks?limit=1001", "/api/v1/marks?kinds=nope",
	} {
		if resp, env, body := h.do(t, "GET", path, nil); resp.StatusCode != http.StatusBadRequest || env.OK {
			t.Errorf("%s: %d %s", path, resp.StatusCode, body)
		}
	}
}

func TestSpansReplyWindowExactAndTruncation(t *testing.T) {
	var evs []map[string]any
	for v := 1; v <= 90; v++ { // 60 cells of 90 visits, each cell with a cell and a round span: 5,520
		for c := 1; c <= 60; c++ {
			ticket := fmt.Sprintf("T-%d", c)
			visit := fmt.Sprintf("build#%d", v)
			evs = append(evs,
				feedtest.New("cell-lifecycle", "station.entered", int64(v)*1000).Ticket(ticket).Visit(ticket, visit, 1).Build(),
				feedtest.New("cell-lifecycle", "station.exited", int64(v)*1000+500).Ticket(ticket).Visit(ticket, visit, 1).Build())
		}
	}
	h := start(t, config{events: evs})
	h.proj.Sync() // fold the history before asking (slow under the race detector, beyond the client's timeout)
	d := h.get(t, "/api/v1/spans?limit=10")
	if d["truncated"] != true || d["total_uncapped"] != float64(5520) || d["total"] != float64(MaxSpans) || d["sort"] != "start" {
		t.Fatalf("a cut is said: %v %v %v", d["truncated"], d["total_uncapped"], d["total"])
	}
	items := d["items"].([]any)
	prev := ""
	for _, it := range items {
		at := it.(map[string]any)["start"].(map[string]any)["at"].(string)
		if at < prev {
			t.Fatalf("not sorted by start: %s after %s", at, prev)
		}
		prev = at
	}
	from, to := feedtest.At(10_000), feedtest.At(19_999)
	d = h.get(t, fmt.Sprintf("/api/v1/spans?kinds=visit&ticket=T-1&from_ms=%d&to_ms=%d", from, to))
	if d["truncated"] != false || d["total_uncapped"] != float64(10) || len(d["items"].([]any)) != 10 {
		t.Fatalf("window: %v %v", d["total_uncapped"], len(d["items"].([]any)))
	}
	d = h.get(t, "/api/v1/spans?span="+strings.ReplaceAll("visit:visit:T-2/build#7", "#", "%23"))
	if items := d["items"].([]any); len(items) != 1 || items[0].(map[string]any)["span_id"] != "visit:visit:T-2/build#7" {
		t.Fatalf("exact: %v", d["items"])
	}
	if items := h.get(t, "/api/v1/spans?span=visit:nope")["items"].([]any); len(items) != 0 {
		t.Fatal("unknown span id")
	}
}

func TestMarksAndConcurrencyReplies(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	all := h.get(t, "/api/v1/marks?limit=1000")
	items := all["items"].([]any)
	if all["order"] != "ascending" || all["truncated"] != false || len(items) == 0 {
		t.Fatalf("marks %v", all)
	}
	mid := items[len(items)/2].(map[string]any)
	at := int64(mid["at_ms"].(float64))
	next := h.get(t, fmt.Sprintf("/api/v1/marks?after_ms=%d&limit=1", at))["items"].([]any)
	prev := h.get(t, fmt.Sprintf("/api/v1/marks?before_ms=%d&limit=2", at))
	if len(next) != 1 || next[0].(map[string]any)["at_ms"].(float64) <= float64(at) {
		t.Fatalf("next %v", next)
	}
	pi := prev["items"].([]any)
	if prev["order"] != "descending" || len(pi) != 2 || pi[0].(map[string]any)["at_ms"].(float64) < pi[1].(map[string]any)["at_ms"].(float64) ||
		pi[0].(map[string]any)["at_ms"].(float64) >= float64(at) || prev["truncated"] != true {
		t.Fatalf("previous %v", prev)
	}
	for _, it := range items {
		m := it.(map[string]any)
		for _, k := range []string{"id", "kind", "at_ms", "at", "until_ms", "event_id", "entity", "label", "verdict", "authority"} {
			if _, has := m[k]; !has {
				t.Fatalf("mark without %s: %v", k, m)
			}
		}
	}
	c := h.get(t, "/api/v1/concurrency?kinds=visit,agent")
	b := c["buckets"].([]any)
	if len(b) == 0 || len(b) > DefaultSeriesBuckets || c["complete"] != false { // the scenario records a lost-history gap
		t.Fatalf("concurrency %d buckets complete=%v", len(b), c["complete"])
	}
	limits := c["limits"].([]any)
	if len(limits) != 1 || limits[0].(map[string]any)["name"] != "max_parallel" || limits[0].(map[string]any)["value"] != float64(2) {
		t.Fatalf("limits %v", limits)
	}
	seen := false
	for _, x := range b {
		for kind := range x.(map[string]any)["active"].(map[string]any) {
			if kind != "visit" && kind != "agent" {
				t.Fatalf("kind %s was not asked for", kind)
			}
			seen = true
		}
	}
	if !seen {
		t.Fatal("nothing active")
	}
}

// Text reaches the projection only through normalisation, which redacts it; the timeline
// replies carry nothing else. A secret in a supervisor's recorded reasons never comes back.
func TestTimelineRepliesStayRedacted(t *testing.T) {
	root := testkit.Project(t)
	led := normalize.NewLedger("0badc0de", root, normalize.NewIdentity())
	secret := "sk-ant-api03-MARKERaaaaaaaaaaaaaaaaaaaaaaaaaaaaa at /Users/MARKERalice/.ssh/id_rsa"
	var evs []map[string]any
	for n, line := range [][]byte{
		testkit.LedgerLine(1, "slice.materialized", "T-1", map[string]any{"digest": "abc", "dependencies": []any{"SLICE-000"}}),
		testkit.LedgerLine(2, "dependency.blocked", "", map[string]any{"reasons": []any{"waiting: " + secret}}),
		testkit.LedgerLine(3, "human.required", "T-1", map[string]any{"reason": "ask Ada: " + secret}),
	} {
		for _, ev := range led.Line(line, normalize.Read{Line: int64(n + 1), At: time.Now()}) {
			raw, _ := json.Marshal(ev)
			var m map[string]any
			json.Unmarshal(raw, &m)
			evs = append(evs, m)
		}
	}
	if len(evs) < 3 {
		t.Fatalf("normalised %d events", len(evs))
	}
	h := start(t, config{events: evs})
	waits := 0
	for _, path := range []string{"/api/v1/spans", "/api/v1/marks", "/api/v1/concurrency"} {
		_, _, body := h.do(t, "GET", path, nil)
		if strings.Contains(string(body), "MARKER") {
			t.Fatalf("%s leaks: %s", path, body)
		}
		if path == "/api/v1/spans" {
			waits = strings.Count(string(body), `"kind":"slice-wait"`)
		}
	}
	if waits != 1 {
		t.Fatalf("the redacted wait is still served as a span (%d)", waits)
	}
}
