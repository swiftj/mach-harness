// Package analyticscheck is an independent scenario suite for the M6.5 analytics (phase 10,
// metric correctness). Each scenario writes a small, hand-constructed Factory history as the MACH
// sources would (intake log, lifecycle logs, execution records, run records, execution streams),
// runs it through the observer's real ingest, projection and HTTP handlers, and asserts the exact
// numbers the API returns against values calculated by hand in the test. It holds tests and small
// builders only.
package analyticscheck

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/artifact"
	"mach/observer/internal/feed"
	"mach/observer/internal/ingest"
	"mach/observer/internal/project"
	"mach/observer/internal/security"
	"mach/observer/internal/server"
	"mach/observer/internal/store"
	"mach/observer/internal/testkit"
	"mach/observer/internal/webui"
)

// ---- time ----

// T0 is a Monday, 09:00 UTC. Every scenario places its facts relative to it.
var T0 = time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)

// at is T0 plus d.
func at(d time.Duration) time.Time { return T0.Add(d) }

func ms(t time.Time) int64 { return t.UnixMilli() }

const (
	sec  = time.Second
	min_ = time.Minute
	hour = time.Hour
	day_ = 24 * time.Hour
)

// ---- the Factory tree ----

// fx is a project folder being written as MACH's sources would write it.
type fx struct {
	t       testing.TB
	root    string
	seq     int                       // the intake log's last seq
	life    map[string]int            // each cell's lifecycle seq
	execs   map[string]map[string]any // ledger supervisor.executions
	slices  map[string]map[string]any // ledger slices
	runLine int
}

func newFx(t testing.TB) *fx {
	t.Helper()
	f := &fx{t: t, root: testkit.Project(t), life: map[string]int{}, execs: map[string]map[string]any{}, slices: map[string]map[string]any{}}
	f.ledger()
	return f
}

// L is one intake log line (schema version 2).
type L struct {
	At      time.Time
	Type    string
	Ticket  string
	Exec    string
	Slice   string
	Wave    string
	Rev     int64
	Source  string
	Seq     int // 0: the next seq
	Data    map[string]any
	Commit  string // source_commit
	Project string
}

func (l L) line(seq int) []byte {
	var ticket, x, slice, wave, rev, commit any
	if l.Ticket != "" {
		ticket = l.Ticket
	}
	if l.Exec != "" {
		x = l.Exec
	}
	if l.Slice != "" {
		slice = l.Slice
		rev = l.Rev
		if l.Rev == 0 {
			rev = 1
		}
	}
	if l.Wave != "" {
		wave = l.Wave
	}
	if l.Commit != "" {
		commit = l.Commit
	}
	src := l.Source
	if src == "" {
		src = "supervisor"
	}
	data := l.Data
	if data == nil {
		data = map[string]any{}
	}
	p := l.Project
	if p == "" {
		p = "P-CHECK"
	}
	b, _ := json.Marshal(map[string]any{"schema_version": 2, "seq": seq, "at": l.At.UTC().Format("2006-01-02T15:04:05Z"), "type": l.Type,
		"project_id": p, "source_commit": commit, "wave_id": wave, "slice_id": slice, "revision": rev, "ticket_id": ticket,
		"runner_id": nil, "execution_id": x, "source": src, "cause": nil, "refs": nil, "data": data})
	return append(b, '\n')
}

// intake appends lines to the intake log, numbering them.
func (f *fx) intake(lines ...L) {
	f.t.Helper()
	var buf []byte
	for _, l := range lines {
		seq := l.Seq
		if seq == 0 {
			f.seq++
			seq = f.seq
		} else if seq > f.seq {
			f.seq = seq
		}
		buf = append(buf, l.line(seq)...)
	}
	testkit.Append(f.t, testkit.LedgerPath(f.root), buf)
}

// raw appends bytes to the intake log as they are (duplicates, rewrites).
func (f *fx) rawIntake(b []byte) { testkit.Append(f.t, testkit.LedgerPath(f.root), b) }

// R is one lifecycle record.
type R struct {
	At      time.Time
	Type    string
	Station string
	Visit   int
	Round   int
	Exec    string
	Data    map[string]any
}

// lifecycle appends records to a cell's lifecycle log (and writes its cell.json once).
func (f *fx) lifecycle(ticket string, recs ...R) {
	f.t.Helper()
	if _, err := os.Stat(filepath.Join(testkit.CellDir(f.root, ticket), "cell.json")); err != nil {
		f.cellJSON(ticket, "", nil)
	}
	var buf []byte
	for _, r := range recs {
		f.life[ticket]++
		buf = append(buf, testkit.Record{Seq: f.life[ticket], At: r.At.UTC().Format("2006-01-02T15:04:05.000Z"), Ticket: ticket, Type: r.Type,
			Station: r.Station, Visit: r.Visit, Round: r.Round, Execution: r.Exec, Data: r.Data}.Line()...)
	}
	testkit.Append(f.t, testkit.CellLog(f.root, ticket), buf)
}

// cellJSON writes a cell.json, dated in the past so it never reads as newer than the log.
func (f *fx) cellJSON(ticket, stage string, product map[string]any) {
	f.t.Helper()
	m := map[string]any{"ticket_id": ticket, "created_at": T0.Format("2006-01-02T15:04:05Z"), "round": 1, "mode": "headless"}
	if stage != "" {
		m["stage"] = stage
	}
	if product != nil {
		m["product"] = product
	}
	b, _ := json.Marshal(m)
	p := filepath.Join(testkit.CellDir(f.root, ticket), "cell.json")
	testkit.WriteFile(f.t, p, b)
	old := time.Now().Add(-48 * time.Hour)
	os.Chtimes(p, old, old)
}

// exec writes an execution's records: started.json always, result.json when end is not zero.
// ended is the wrapper's word (exited, interrupted, timed-out, could-not-start).
func (f *fx) exec(x, ticket string, start, end time.Time, ended string, exitCode any) {
	f.t.Helper()
	f.execs[x] = map[string]any{"ticket_id": ticket, "state": "finished", "attempt": 1}
	f.ledger()
	dir := testkit.ExecDir(f.root, x)
	b, _ := json.Marshal(map[string]any{"execution_id": x, "wrapper_pid": 4100, "child_pid": 4200, "started_at": start.UTC().Format("2006-01-02T15:04:05Z")})
	testkit.WriteFile(f.t, filepath.Join(dir, "started.json"), append(b, '\n'))
	if !end.IsZero() {
		b, _ := json.Marshal(map[string]any{"execution_id": x, "ended": ended, "exit_code": exitCode, "ended_at": end.UTC().Format("2006-01-02T15:04:05Z"),
			"seconds": int64(end.Sub(start) / time.Second)})
		testkit.WriteFile(f.t, filepath.Join(dir, "result.json"), append(b, '\n'))
	}
}

// claimOnly registers an execution with the ledger without any execution record (a claim that
// never started a process).
func (f *fx) claimOnly(x, ticket string) {
	f.execs[x] = map[string]any{"ticket_id": ticket, "state": "claimed", "attempt": 1}
	f.ledger()
}

// U is one model's usage in a result record.
type U struct {
	Model                                   string
	Cost                                    any // float64, or nil to leave the cost out
	Input, Output, CacheRead, CacheCreation int64
}

// usage writes an execution's stream: an init and one result with the given model usage. A nil
// total leaves total_cost_usd out.
func (f *fx) usage(x string, at time.Time, total any, models ...U) {
	f.t.Helper()
	mu := map[string]any{}
	for _, u := range models {
		m := map[string]any{"inputTokens": u.Input, "outputTokens": u.Output, "cacheReadInputTokens": u.CacheRead, "cacheCreationInputTokens": u.CacheCreation}
		if u.Cost != nil {
			m["costUSD"] = u.Cost
		}
		mu[u.Model] = m
	}
	init, _ := json.Marshal(map[string]any{"type": "system", "subtype": "init", "session_id": "s-" + x, "claude_code_version": "2.1.322",
		"model": "claude-sonnet-5-5", "permissionMode": "dontAsk", "tools": []string{"Bash", "Workflow"}, "agents": []string{}})
	res := map[string]any{"type": "result", "subtype": "success", "is_error": false, "terminal_reason": "completed", "result_index": 0,
		"modelUsage": mu, "session_id": "s-" + x, "result": "done"}
	if total != nil {
		res["total_cost_usd"] = total
	}
	rb, _ := json.Marshal(res)
	testkit.Append(f.t, filepath.Join(testkit.ExecDir(f.root, x), "stream.jsonl"), append(append(append(init, '\n'), rb...), '\n'))
}

// workflow writes an execution's stream holding one belt workflow call: started at start, its
// task_updated status (completed or killed) at end, then a result with no usage. Nothing else.
func (f *fx) workflow(x string, start, end time.Time, status string) {
	f.t.Helper()
	iso := func(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
	tu, task := "toolu_"+x, "task"+x[len(x)-4:]
	lines := []M{
		{"type": "system", "subtype": "init", "session_id": "s-" + x, "claude_code_version": "2.1.322", "model": "claude-sonnet-5-5",
			"permissionMode": "dontAsk", "tools": []string{"Bash", "Workflow"}, "agents": []string{}},
		{"type": "assistant", "timestamp": iso(start), "session_id": "s-" + x, "parent_tool_use_id": nil, "message": M{"model": "claude-sonnet-5-5",
			"role": "assistant", "type": "message", "content": []any{M{"type": "tool_use", "id": tu, "name": "Workflow", "input": M{"name": "mach-belt"}}}}},
		{"type": "system", "subtype": "task_started", "task_id": task, "tool_use_id": tu, "description": "mach-belt", "task_type": "local_workflow",
			"workflow_name": "mach-belt", "prompt": "-", "session_id": "s-" + x},
		{"type": "user", "timestamp": iso(start.Add(50 * time.Millisecond)), "session_id": "s-" + x, "parent_tool_use_id": nil,
			"message": M{"role": "user", "content": []any{M{"type": "tool_result", "tool_use_id": tu, "content": "-", "is_error": false}}},
			"tool_use_result": M{"status": "async_launched", "taskId": task, "taskType": "local_workflow", "workflowName": "mach-belt"}},
		{"type": "system", "subtype": "task_updated", "task_id": task, "patch": M{"status": status, "end_time": end.UnixMilli()}, "session_id": "s-" + x},
		{"type": "system", "subtype": "task_notification", "task_id": task, "tool_use_id": tu, "status": status,
			"usage": M{"total_tokens": 100, "tool_uses": 3, "duration_ms": end.Sub(start).Milliseconds()}, "session_id": "s-" + x},
	}
	var buf []byte
	for _, l := range lines {
		b, _ := json.Marshal(l)
		buf = append(append(buf, b...), '\n')
	}
	testkit.Append(f.t, filepath.Join(testkit.ExecDir(f.root, x), "stream.jsonl"), buf)
}

// run appends a run record (record_version 2) for a finished ticket. fields override the defaults.
func (f *fx) run(ticket string, closed time.Time, fields map[string]any) {
	f.t.Helper()
	m := map[string]any{"record_version": 2, "ticket_id": ticket, "closed_at": closed.UTC().Format("2006-01-02T15:04:05Z"), "outcome": "merged",
		"rounds": 1, "first_pass": true, "verify_failures": 0, "review_rejections": 0, "escalated": false, "human_approval": false,
		"deviations": []any{}, "blockers": []any{}, "risk": "Medium", "app_type": "cli", "tests_seen_failing_first": 2, "tests_passing_on_first_run": 0,
		"integration": map[string]any{"method": "local", "merge_commit": "0123456789abcdef0123"}}
	for k, v := range fields {
		if v == nil {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	b, _ := json.Marshal(m)
	f.runLine++
	testkit.Append(f.t, filepath.Join(f.root, ".factory", "archive", "runs.jsonl"), append(b, '\n'))
}

func (f *fx) slice(id, ticket, wave string, rev int64) {
	f.slices[id] = map[string]any{"ticket_id": ticket, "wave_id": wave, "revision": rev, "state": "dispatched"}
	f.ledger()
}

func (f *fx) ledger() {
	b, _ := json.MarshalIndent(map[string]any{"version": 1, "project_id": "P-CHECK", "slices": f.slices,
		"supervisor": map[string]any{"executions": f.execs, "attempts": map[string]any{}, "parked": map[string]any{}, "observed": map[string]any{}}}, "", "  ")
	testkit.WriteFile(f.t, filepath.Join(f.root, ".factory", "intake", "ledger.json"), append(b, '\n'))
}

// ---- the observer, in process ----

// storeLog is the store as a feed.Log (as cmd/mach-observer/adapt.go adapts it).
type storeLog struct{ s *store.Store }

func (l storeLog) Epoch() string            { return l.s.Generation() }
func (l storeLog) Bounds() (uint64, uint64) { return l.s.Bounds() }
func (l storeLog) Changed() <-chan struct{} { return l.s.Changed() }
func (l storeLog) After(pos uint64, limit int) ([]feed.Record, error) {
	entries, err := l.s.After(pos, limit)
	switch {
	case errors.Is(err, store.ErrExpired):
		return nil, feed.ErrExpired
	case errors.Is(err, store.ErrFuture):
		return nil, feed.ErrFuture
	case err != nil:
		return nil, err
	}
	out := make([]feed.Record, len(entries))
	for i, e := range entries {
		out[i] = feed.Record{Pos: e.Event.Pos, Raw: e.Raw}
	}
	return out, nil
}

// obs is the observer's real stack over one project: store, ingest loop, projection, HTTP server.
type obs struct {
	t      testing.TB
	root   string
	index  string
	st     *store.Store
	in     *ingest.Observer
	proj   *project.Projector
	hs     *http.Server
	base   string
	cookie *http.Cookie
	done   chan struct{}
	clock  time.Time
	closed bool
}

// open starts the observer over root, with its index in index (a folder that survives a restart).
func open(t testing.TB, root, index string) *obs {
	t.Helper()
	st, err := store.Open(filepath.Join(index, "index"), store.DefaultMaxMemory)
	if err != nil {
		t.Fatal(err)
	}
	o := &obs{t: t, root: root, index: index, st: st, done: make(chan struct{}), clock: time.Now()}
	o.in = ingest.New(ingest.Options{Root: root, Store: st, NoSettle: true, Now: func() time.Time { return o.clock }})
	o.proj = project.New(project.Options{Log: storeLog{st}, Interval: 5, PersistDir: filepath.Join(index, "projection"), PersistMinInterval: -1,
		// Every read at a new position builds the flow index anew (production serves a built one for
		// up to a second while events arrive, under its own older cursor).
		TimelineMaxAge: -1})
	l, err := security.Listen("127.0.0.1", 0)
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	guard, err := security.NewGuard(port)
	if err != nil {
		t.Fatal(err)
	}
	srv := server.New(server.Options{Root: root, Guard: guard, Log: storeLog{st}, Projector: o.proj, Catalog: artifact.New(root), UI: webui.Handler(), Done: o.done})
	o.hs = srv.HTTPServer()
	go o.hs.Serve(l)
	go o.proj.Run(o.done)
	o.base = fmt.Sprintf("http://127.0.0.1:%d", port)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 10 * time.Second}
	resp, err := client.Get(guard.StartURL())
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	for _, ck := range jar.Cookies(resp.Request.URL) {
		if ck.Name == security.CookieName {
			o.cookie = ck
		}
	}
	if o.cookie == nil {
		t.Fatal("no session")
	}
	t.Cleanup(o.close)
	o.sync()
	return o
}

// observe opens an observer over the fixture with a fresh index.
func observe(f *fx) *obs { return open(f.t, f.root, f.t.(interface{ TempDir() string }).TempDir()) }

// sync reads every source until three ticks read nothing, then waits for the projection to apply
// everything committed.
func (o *obs) sync() {
	o.t.Helper()
	for idle := 0; idle < 3; {
		o.clock = o.clock.Add(2 * time.Second)
		n, err := o.in.Tick()
		if err != nil {
			o.t.Fatal(err)
		}
		if n == 0 {
			idle++
		} else {
			idle = 0
		}
	}
	_, head := o.st.Bounds()
	deadline := time.Now().Add(testkit.Slow(10 * time.Second))
	for o.proj.Status().Pos < head {
		if time.Now().After(deadline) {
			o.t.Fatalf("projection at %d, log at %d", o.proj.Status().Pos, head)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (o *obs) close() {
	if o.closed {
		return
	}
	o.closed = true
	close(o.done)
	o.hs.Close()
	o.proj.Close()
	o.st.Close()
}

// raw is the reply's status and body.
func (o *obs) raw(path string) (int, []byte) {
	o.t.Helper()
	req, _ := http.NewRequest("GET", o.base+path, nil)
	req.AddCookie(o.cookie)
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		o.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

// get returns the reply's data, failing the test unless it is a 200.
func (o *obs) get(path string) M {
	o.t.Helper()
	code, b := o.raw(path)
	if code != 200 {
		o.t.Fatalf("GET %s: %d %s", path, code, b)
	}
	var out struct {
		OK   bool `json:"ok"`
		Data M    `json:"data"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		o.t.Fatalf("GET %s: %v", path, err)
	}
	return out.Data
}

// ---- reading replies ----

// M is a JSON object.
type M = map[string]any

func obj(v any) M {
	m, _ := v.(M)
	return m
}

func arr(v any) []any {
	a, _ := v.([]any)
	return a
}

// metric is one metric row of a /analytics/metrics reply.
func metric(t testing.TB, d M, id string) M {
	t.Helper()
	for _, m := range arr(d["metrics"]) {
		if row := obj(m); row["id"] == id {
			return row
		}
	}
	t.Fatalf("no metric %s in the reply", id)
	return nil
}

// metrics fetches one or more metrics with extra parameters ("&group_by=..." etc.).
func (o *obs) metrics(ids string, extra string) M {
	return o.get("/api/v1/analytics/metrics?ids=" + ids + extra)
}

// num reads a number (nil when null or absent).
func num(v any) *float64 {
	f, ok := v.(float64)
	if !ok {
		return nil
	}
	return &f
}

func show(v any) string {
	b, _ := json.Marshal(v)
	s := string(b)
	if len(s) > 1500 {
		s = s[:1500] + "…"
	}
	return s
}

// eqNum asserts a field holds exactly want (a float within 1e-9), or null when want is nil.
func eqNum(t testing.TB, what string, got any, want *float64) {
	t.Helper()
	g := num(got)
	switch {
	case want == nil && got != nil:
		t.Errorf("%s: want null, got %s", what, show(got))
	case want != nil && g == nil:
		t.Errorf("%s: want %v, got %s", what, *want, show(got))
	case want != nil && (*g-*want > 1e-9 || *want-*g > 1e-9):
		t.Errorf("%s: want %v, got %v", what, *want, *g)
	}
}

func f64(v float64) *float64 { return &v }

// none is "null" in an expectation.
var none *float64

// fig asserts a metric row's (or group's) value, numerator, denominator and sample count. A nil
// expectation means null.
func fig(t testing.TB, what string, row M, value, numerator, denominator, sample *float64) {
	t.Helper()
	vk, nk, dk := "value", "numerator", "denominator"
	if _, isRow := row["numerator_value"]; isRow {
		nk, dk = "numerator_value", "denominator_value"
	}
	eqNum(t, what+" value", row[vk], value)
	eqNum(t, what+" numerator", row[nk], numerator)
	eqNum(t, what+" denominator", row[dk], denominator)
	if sample != nil || row["sample_count"] != nil {
		eqNum(t, what+" sample_count", row["sample_count"], sample)
	}
}

// group finds the group whose keys are exactly keys ("dim=value,dim=value").
func group(t testing.TB, row M, keys string) M {
	t.Helper()
	want := map[string]string{}
	for _, kv := range strings.Split(keys, ",") {
		k, v, _ := strings.Cut(kv, "=")
		want[k] = v
	}
	for _, g := range arr(row["groups"]) {
		gm := obj(g)
		ks := obj(gm["keys"])
		if len(ks) != len(want) {
			continue
		}
		match := true
		for k, v := range want {
			if ks[k] != v {
				match = false
			}
		}
		if match {
			return gm
		}
	}
	t.Fatalf("%s: no group %s in %s", row["id"], keys, show(row["groups"]))
	return nil
}

func groupKeys(row M) []string {
	var out []string
	for _, g := range arr(row["groups"]) {
		out = append(out, obj(g)["key"].(string))
	}
	sort.Strings(out)
	return out
}

// basis reads basis_counts.
func basis(row M) M { return obj(row["basis_counts"]) }

// excluded is the coverage's excluded reasons as reason-prefix -> count.
func excluded(row M) map[string]float64 {
	out := map[string]float64{}
	for _, e := range arr(obj(row["coverage"])["excluded"]) {
		em := obj(e)
		reason, _ := em["reason"].(string)
		key, _, _ := strings.Cut(reason, ":")
		out[key] += em["count"].(float64)
	}
	return out
}

// station is one station of a /analytics/flow reply.
func station(t testing.TB, flow M, name string) M {
	t.Helper()
	for _, s := range arr(flow["stations"]) {
		if obj(s)["station"] == name {
			return obj(s)
		}
	}
	t.Fatalf("no station %s in %s", name, show(flow["stations"]))
	return nil
}

// transitions is from->to => count.
func transitions(flow M) map[string]float64 {
	out := map[string]float64{}
	for _, x := range arr(flow["transitions"]) {
		m := obj(x)
		to, _ := m["to"].(string)
		if m["terminal"] == true {
			to = "(end)"
		}
		out[fmt.Sprint(m["from"])+"->"+to] += m["count"].(float64)
	}
	return out
}

// contributors fetches a contributors page (every item: limit 500).
func (o *obs) contributors(metricID, extra string) M {
	return o.get("/api/v1/analytics/contributors?limit=500&metric=" + metricID + extra)
}

func refs(page M) []string {
	var out []string
	for _, it := range arr(page["items"]) {
		out = append(out, obj(it)["ref"].(string))
	}
	sort.Strings(out)
	return out
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	x := append([]string(nil), a...)
	y := append([]string(nil), b...)
	sort.Strings(x)
	sort.Strings(y)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

// noFreeText asserts a contributors page carries identifiers, codes and numbers only: every
// string is short, has no spaces and no sentence punctuation.
func noFreeText(t testing.TB, page M) {
	t.Helper()
	var walk func(path string, v any)
	walk = func(path string, v any) {
		switch x := v.(type) {
		case string:
			if strings.ContainsAny(x, " \n\t") || len(x) > 120 {
				t.Errorf("contributors %s: free text %q", path, x)
			}
		case M:
			for k, y := range x {
				walk(path+"."+k, y)
			}
		case []any:
			for i, y := range x {
				walk(fmt.Sprintf("%s[%d]", path, i), y)
			}
		}
	}
	for i, it := range arr(page["items"]) {
		walk(fmt.Sprintf("items[%d]", i), it)
	}
}

// stripGenerated removes generated_ms from a reply body, for byte comparisons.
func stripGenerated(b []byte) string { return stripKeys(b, "generated_ms") }

// stripKeys removes the named keys at every depth of a reply body.
func stripKeys(b []byte, keys ...string) string {
	var v any
	json.Unmarshal(b, &v)
	var strip func(v any)
	strip = func(v any) {
		switch x := v.(type) {
		case M:
			for _, k := range keys {
				delete(x, k)
			}
			for _, y := range x {
				strip(y)
			}
		case []any:
			for _, y := range x {
				strip(y)
			}
		}
	}
	strip(v)
	out, _ := json.Marshal(v)
	return string(out)
}
