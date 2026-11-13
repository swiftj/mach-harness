package server

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"mach/observer/internal/artifact"
	"mach/observer/internal/feed"
	"mach/observer/internal/feedtest"
	"mach/observer/internal/project"
	"mach/observer/internal/redact"
	"mach/observer/internal/security"
	"mach/observer/internal/testkit"
	"mach/observer/internal/webui"
)

type fakeIngest struct {
	mu sync.Mutex
	st IngestState
}

func (f *fakeIngest) Ingest() IngestState { f.mu.Lock(); defer f.mu.Unlock(); return f.st }

type fakeFactory struct {
	mu sync.Mutex
	st FactoryState
}

func (f *fakeFactory) Factory(time.Time) FactoryState { f.mu.Lock(); defer f.mu.Unlock(); return f.st }

type harness struct {
	root    string
	base    string
	host    string
	cookie  *http.Cookie
	log     *feedtest.Mem
	proj    *project.Projector
	server  *Server
	guard   *security.Guard
	ingest  *fakeIngest
	factory *fakeFactory
}

type config struct {
	window       int
	heartbeat    time.Duration
	writeTimeout time.Duration
	maxStreams   int
	batch        int
	events       []map[string]any
}

func start(t *testing.T, c config) *harness {
	t.Helper()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	os.MkdirAll(filepath.Join(root, ".factory/worktrees"), 0o755)
	mem := feedtest.NewMem("", c.window)
	if c.events != nil {
		mem.Append(c.events...)
	}
	proj := project.New(project.Options{Log: mem, Interval: 5})
	l, err := security.Listen("127.0.0.1", 0)
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	guard, _ := security.NewGuard(port)
	done := make(chan struct{})
	in := &fakeIngest{st: IngestState{Ticks: 3, LastTickAt: time.Now(), IntervalMS: 150, FactoryFound: true,
		Sources: []SourceState{{Key: "i:0badc0de", Path: ".factory/intake/events.jsonl", State: "live", LastReadAt: time.Now(), Offset: 100, Size: ptr(int64(140))}}}}
	fac := &fakeFactory{st: FactoryState{Present: true, Report: map[string]any{"policy": map[string]any{"effective": "supervised"}}, Effective: "supervised",
		Enabled: true, Autonomy: "supervised", PolicyUsable: true, LeasePresent: true, LeaseLive: true, LeaseAgeSec: ptr(2.0), ReadAt: time.Now()}}
	s := New(Options{Root: root, Guard: guard, Log: mem, Projector: proj, Catalog: artifact.New(root), Ingest: in, Factory: fac, UI: webui.Handler(),
		Done: done, Heartbeat: c.heartbeat, WriteTimeout: c.writeTimeout, MaxStreams: c.maxStreams, StreamBatch: c.batch, LinkFile: ".factory/local/observer/link"})
	hs := s.HTTPServer()
	go hs.Serve(l)
	go proj.Run(done)
	t.Cleanup(func() {
		close(done)
		hs.Close()
	})
	h := &harness{root: root, base: fmt.Sprintf("http://127.0.0.1:%d", port), host: fmt.Sprintf("127.0.0.1:%d", port), log: mem, proj: proj,
		server: s, guard: guard, ingest: in, factory: fac}
	h.cookie = h.login(t)
	return h
}

func ptr[T any](v T) *T { return &v }

// login opens the current one-time link in a fresh browser (cookie jar) and returns its session.
func (h *harness) login(t *testing.T) *http.Cookie {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 10 * time.Second}
	resp, err := client.Get(h.guard.StartURL())
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	for _, ck := range jar.Cookies(resp.Request.URL) {
		if ck.Name == security.CookieName {
			return ck
		}
	}
	t.Fatal("no session after the start link")
	return nil
}

func (h *harness) do(t *testing.T, method, path string, edit func(*http.Request)) (*http.Response, Envelope, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, h.base+path, nil)
	req.AddCookie(h.cookie)
	if edit != nil {
		edit(req)
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var env Envelope
	json.Unmarshal(body, &env)
	return resp, env, body
}

func (h *harness) get(t *testing.T, path string) map[string]any {
	t.Helper()
	resp, env, body := h.do(t, "GET", path, nil)
	if resp.StatusCode != 200 || !env.OK {
		t.Fatalf("GET %s: %d %s", path, resp.StatusCode, body)
	}
	var out struct {
		Data map[string]any `json:"data"`
	}
	json.Unmarshal(body, &out)
	return out.Data
}

func checkCSP(t *testing.T, resp *http.Response) {
	t.Helper()
	if resp.Header.Get("Content-Security-Policy") != security.ContentSecurityPolicy || resp.Header.Get("X-Content-Type-Options") != "nosniff" ||
		resp.Header.Get("X-Frame-Options") != "DENY" {
		t.Fatalf("%d %s: security headers missing", resp.StatusCode, resp.Request.URL.Path)
	}
}

// Every route, with a valid example, for the checks that apply to all of them.
func routes() []string {
	return []string{"/api/v1/session", "/api/v1/health", "/api/v1/factory/status", "/api/v1/events", "/api/v1/snapshot", "/api/v1/project",
		"/api/v1/waves", "/api/v1/waves/WAVE-001", "/api/v1/slices", "/api/v1/slices/SLICE-001", "/api/v1/cells", "/api/v1/cells/T-1",
		"/api/v1/cells/T-1/visits/build%231", "/api/v1/cells/T-1/evidence", "/api/v1/runs", "/api/v1/runs/x0123456789ab",
		"/api/v1/runs/x0123456789ab/agents", "/api/v1/runs/x0123456789ab/tools", "/api/v1/spans", "/api/v1/artifacts",
		"/api/v1/analytics/metrics", "/api/v1/analytics/runs", "/api/v1/history"}
}

// ---- security ----

func TestEveryOtherMethodIsRefused(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	paths := append(routes(), "/api/v1/stream", "/api/v1/artifacts/a000000000000000000000000/content", "/api/v1/nope", "/", "/?t=x")
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "PROPFIND"} {
		for _, path := range paths {
			resp, _, _ := h.do(t, method, path, nil)
			checkCSP(t, resp)
			if resp.StatusCode != http.StatusMethodNotAllowed || resp.Header.Get("Allow") != "GET" {
				t.Fatalf("%s %s: %d", method, path, resp.StatusCode)
			}
		}
	}
}

func TestEveryRouteNeedsTheSession(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	for _, path := range append(routes(), "/api/v1/stream", "/api/v1/artifacts/a000000000000000000000000/content") {
		for name, cookie := range map[string]*http.Cookie{"none": nil, "forged": {Name: security.CookieName, Value: "forged"}} {
			req, _ := http.NewRequest("GET", h.base+path, nil)
			if cookie != nil {
				req.AddCookie(cookie)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			checkCSP(t, resp)
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("%s with %s cookie: %d", path, name, resp.StatusCode)
			}
		}
	}
}

func TestBadHostOriginAndFetchSite(t *testing.T) {
	h := start(t, config{})
	for _, edit := range []func(*http.Request){
		func(r *http.Request) { r.Host = "evil.example:" + strings.Split(h.host, ":")[1] },
		func(r *http.Request) { r.Header.Set("Origin", "http://evil.example") },
		func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
	} {
		resp, _, _ := h.do(t, "GET", "/api/v1/health", edit)
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%d", resp.StatusCode)
		}
	}
}

func TestUncleanRoutesAndSchema(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	for _, path := range []string{"/api/v1/../v1/health", "/api/v1/cells/%2e%2e/evidence", "/api/v1//health", "/api/v1/cells/T-1%2fx",
		"/api/v1/cells/T%00-1", "/api/v1/cells/a%5cb", "/api/v1/artifacts/..%2f..%2fetc%2fpasswd/content"} {
		resp, _, body := h.do(t, "GET", path, nil)
		if resp.StatusCode != http.StatusBadRequest && resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: %d %s", path, resp.StatusCode, body)
		}
	}
	if resp, env, _ := h.do(t, "GET", "/api/v1/nope", nil); resp.StatusCode != 404 || env.Error.Kind != KindNotFound {
		t.Fatalf("%d", resp.StatusCode)
	}
	for _, edit := range []func(*http.Request){
		func(r *http.Request) { r.URL.RawQuery = "schema=2" },
		func(r *http.Request) { r.Header.Set("X-MACH-Event-Schema", "4") },
	} {
		resp, env, _ := h.do(t, "GET", "/api/v1/events", edit)
		if resp.StatusCode != 400 || env.Error.Kind != KindInvalid || len(env.Error.Supported) != 1 || env.Error.Supported[0] != 3 {
			t.Fatalf("an unknown schema: %d %+v", resp.StatusCode, env.Error)
		}
	}
	h.get(t, "/api/v1/events?schema=3")
}

// A second browser opens the next one-time link and gets its own session; both work.
func TestSecondBrowser(t *testing.T) {
	h := start(t, config{})
	second := h.login(t)
	if second.Value == h.cookie.Value {
		t.Fatal("the second browser shares the first one's session")
	}
	for _, c := range []*http.Cookie{h.cookie, second} {
		resp, _, _ := h.do(t, "GET", "/api/v1/health", func(r *http.Request) { r.Header.Del("Cookie"); r.AddCookie(c) })
		if resp.StatusCode != 200 {
			t.Fatal("a session stopped working")
		}
	}
	if s := h.get(t, "/api/v1/session"); s["sessions"].(map[string]any)["count"].(float64) != 2 || s["new_link"] == nil {
		t.Fatalf("%v", s)
	}
}

// ---- shapes ----

func TestEveryEndpointShape(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	want := map[string][]string{
		"/api/v1/session":                    {"versions", "display_policy", "capabilities", "limits", "generation"},
		"/api/v1/health":                     {"status", "observer_time", "index", "projection", "ingest", "freshness", "streams"},
		"/api/v1/factory/status":             {"factory_present", "report", "summary", "supervisor", "recorded_mode", "freshness"},
		"/api/v1/events":                     {"events", "next", "head", "floor", "more", "scanned"},
		"/api/v1/history":                    {"events", "next_from_order", "more", "complete", "head", "watermark_ms", "limits"},
		"/api/v1/snapshot":                   {"cursor", "generation", "reconstructed", "state"},
		"/api/v1/project":                    {"counts_by_state", "factory", "active_cells", "human_gates_open", "cursor"},
		"/api/v1/waves":                      {"items", "cursor"},
		"/api/v1/waves/WAVE-001":             {"wave_id", "slices", "state_counts"},
		"/api/v1/slices":                     {"items", "total", "more"},
		"/api/v1/slices/SLICE-002":           {"state", "waiting", "history", "dependencies"},
		"/api/v1/cells":                      {"items", "total"},
		"/api/v1/cells/T-1":                  {"visits", "gates", "tasks", "checks", "reviews", "approvals", "merge", "cleanup", "rounds"},
		"/api/v1/cells/T-1/visits/build%231": {"visit", "events"},
		"/api/v1/cells/T-1/evidence":         {"artifacts", "checks", "settings"},
		"/api/v1/runs":                       {"items", "total"},
		"/api/v1/runs/x0123456789ab":         {"run", "workflows", "usage", "observations"},
		"/api/v1/runs/x0123456789ab/agents":  {"items", "note"},
		"/api/v1/runs/x0123456789ab/tools":   {"items", "refused"},
		"/api/v1/spans":                      {"items", "basis_vocabulary"},
		"/api/v1/artifacts":                  {"items", "settings"},
		"/api/v1/analytics/metrics":          {"metrics", "definitions_version"},
		"/api/v1/analytics/runs":             {"items", "total"},
	}
	for path, keys := range want {
		d := h.get(t, path)
		for _, k := range keys {
			if _, ok := d[k]; !ok {
				t.Errorf("%s: no %q in %v", path, k, mapKeys(d))
			}
		}
	}
	for _, path := range []string{"/api/v1/waves/WAVE-404", "/api/v1/slices/S-404", "/api/v1/cells/T-404", "/api/v1/cells/T-1/visits/build%239",
		"/api/v1/runs/x404", "/api/v1/runs/x404/agents"} {
		if resp, env, _ := h.do(t, "GET", path, nil); resp.StatusCode != 404 || env.Error.Kind != KindNotFound {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
	}
	// specific facts
	run := h.get(t, "/api/v1/runs/x0123456789ab")["run"].(map[string]any)
	if run["state"] != "finished" || run["cost"].(map[string]any)["usd"].(float64) != 4.5 || run["time_basis"] != "process" {
		t.Fatalf("run %v", run)
	}
	runs := h.get(t, "/api/v1/runs?state=unknown")["items"].([]any)
	if len(runs) != 1 || runs[0].(map[string]any)["cost_may_be_under_reported"] != true {
		t.Fatalf("unknown runs %v", runs)
	}
	agents, _ := json.Marshal(h.get(t, "/api/v1/runs/x0123456789ab/agents")["items"])
	if strings.Contains(string(agents), "cost") {
		t.Fatalf("an agent has a cost: %s", agents)
	}
	sl := h.get(t, "/api/v1/slices/SLICE-002")
	if sl["state"] != "ready" || sl["waiting"].(map[string]any)["kind"] != "capacity" {
		t.Fatalf("slice %v", sl)
	}
	sess := h.get(t, "/api/v1/session")
	if sess["capabilities"].(map[string]any)["stream_observations"].(map[string]any)["ok"] != true ||
		len(sess["versions"].(map[string]any)["event"].(map[string]any)["kinds"].([]any)) != 54 {
		t.Fatalf("session %v", sess)
	}
	m := h.get(t, "/api/v1/analytics/metrics?ids=Q2,K5&group_by=risk")["metrics"].([]any)
	if len(m) != 2 || m[1].(map[string]any)["value"] != nil || m[1].(map[string]any)["null_reason"] == "" {
		t.Fatalf("metrics %v", m)
	}
	for _, path := range []string{"/api/v1/analytics/metrics?ids=NOPE", "/api/v1/analytics/metrics?group_by=evil", "/api/v1/runs?state=x",
		"/api/v1/runs?limit=0", "/api/v1/runs?limit=1001", "/api/v1/runs?offset=-1", "/api/v1/spans?kinds=bogus", "/api/v1/slices?state=x",
		"/api/v1/cells?archived=maybe", "/api/v1/events?authority=sure", "/api/v1/events?ticket=..%2Fx", "/api/v1/runs?ticket=a%20b"} {
		if resp, env, _ := h.do(t, "GET", path, nil); resp.StatusCode != 400 || env.Error.Kind != KindInvalid {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
	}
}

func mapKeys(m map[string]any) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestFreshnessFacts(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	st := h.get(t, "/api/v1/factory/status")
	if st["supervisor"].(map[string]any)["heartbeat_fresh"] != true || st["summary"].(map[string]any)["mode"] != "supervised" {
		t.Fatalf("%v", st)
	}
	src := st["freshness"].(map[string]any)["sources"].([]any)[0].(map[string]any)
	if src["lag_bytes"].(float64) != 40 || src["last_read_at"] == nil {
		t.Fatalf("%v", src)
	}
	if h.get(t, "/api/v1/health")["status"] != "ok" {
		t.Fatal("health")
	}
	// The supervisor's lease expires and ingest stops ticking: both are visible.
	h.factory.mu.Lock()
	h.factory.st.LeaseExpired, h.factory.st.LeaseLive = true, false
	h.factory.mu.Unlock()
	h.ingest.mu.Lock()
	h.ingest.st.LastTickAt = time.Now().Add(-time.Minute)
	h.ingest.mu.Unlock()
	h.server.statusMu.Lock()
	h.server.statusAt = time.Time{}
	h.server.statusMu.Unlock()
	st = h.get(t, "/api/v1/factory/status")
	if st["supervisor"].(map[string]any)["heartbeat_fresh"] != false || st["freshness"].(map[string]any)["ingest"].(map[string]any)["stale"] != true {
		t.Fatalf("%v", st)
	}
	if h.get(t, "/api/v1/health")["status"] != "degraded" {
		t.Fatal("a stale ingest must read as degraded")
	}
}

// ---- events ----

func TestEventsPagingFiltersAndCursorErrors(t *testing.T) {
	evs := feedtest.Scenario()
	h := start(t, config{events: evs, window: 40})
	floor, head := h.log.Bounds()
	if floor == 0 {
		t.Fatal("the test needs an evicted beginning")
	}
	page := h.get(t, "/api/v1/events?limit=10")
	if len(page["events"].([]any)) != 10 || page["more"] != true {
		t.Fatalf("%v", page)
	}
	next := page["next"].(string)
	all := len(page["events"].([]any))
	for page["more"] == true {
		page = h.get(t, "/api/v1/events?limit=7&after="+page["next"].(string))
		all += len(page["events"].([]any))
	}
	if all != int(head-floor) {
		t.Fatalf("paged %d, want %d", all, head-floor)
	}
	if _, err := feed.ParseCursor(next); err != nil {
		t.Fatal(err)
	}
	for q, check := range map[string]func(*feed.Event) bool{
		"ticket=T-1":                        func(e *feed.Event) bool { return e.Ticket() == "T-1" },
		"execution=x0fedcba98765":           func(e *feed.Event) bool { return e.Execution() == "x0fedcba98765" },
		"type=station.":                     func(e *feed.Event) bool { return strings.HasPrefix(e.Type, "station.") },
		"entity=visit:T-1/merge%231":        func(e *feed.Event) bool { return e.HasEntity("visit:T-1/merge#1") },
		"authority=observed":                func(e *feed.Event) bool { return e.Authority == "observed" },
		"station=merge&type=station.exited": func(e *feed.Event) bool { return feed.Str(e.IDs.Station) == "merge" && e.Type == "station.exited" },
	} {
		events := h.get(t, "/api/v1/events?limit=1000&"+q)["events"].([]any)
		if len(events) == 0 {
			t.Fatalf("%s matched nothing", q)
		}
		for _, raw := range events {
			b, _ := json.Marshal(raw)
			ev, err := feed.Decode(feed.Record{Pos: 1, Raw: b})
			if err != nil || !check(ev) {
				t.Fatalf("%s: %s", q, b)
			}
		}
	}
	gen := h.log.Epoch()
	for after, want := range map[string]struct {
		status int
		kind   string
	}{
		"fedcba9876543210.1":               {409, KindCursorReset},
		gen + ".99999":                     {409, KindCursorReset},
		fmt.Sprintf("%s.%d", gen, floor-1): {410, KindCursorExpired},
		"nonsense":                         {400, KindInvalid},
	} {
		resp, env, _ := h.do(t, "GET", "/api/v1/events?after="+after, nil)
		if resp.StatusCode != want.status || env.Error.Kind != want.kind {
			t.Fatalf("%s: %d %+v", after, resp.StatusCode, env.Error)
		}
	}
}

// A selective filter over a long log examines at most ScanCap events per request, and says how
// far it got so the client can page on.
func TestEventsScanCap(t *testing.T) {
	h := start(t, config{})
	var batch []map[string]any
	for i := 0; i < ScanCap+500; i++ {
		batch = append(batch, feedtest.New("intake-log", "intake.validated", int64(i)).Data(map[string]any{"digest": "d"}).Build())
	}
	h.log.Append(batch...)
	h.log.Append(feedtest.New("intake-log", "work.claimed", 1).Ticket("T-9").Exec("x9").Data(map[string]any{"stage": "planned", "next": "build", "attempt": 1}).Build())
	page := h.get(t, "/api/v1/events?ticket=T-9")
	if len(page["events"].([]any)) != 0 || page["scanned"].(float64) != ScanCap || page["more"] != true {
		t.Fatalf("%v", page["scanned"])
	}
	page = h.get(t, "/api/v1/events?ticket=T-9&after="+page["next"].(string))
	if len(page["events"].([]any)) != 1 {
		t.Fatalf("the second page missed the match: %v", page["scanned"])
	}
}

// ---- snapshot ----

func TestSnapshotThenStreamHasNoGapAndNoRepeat(t *testing.T) {
	evs := feedtest.Scenario()
	h := start(t, config{events: evs[:20]})
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { // appends while the snapshot is taken
		defer wg.Done()
		for _, e := range evs[20:] {
			h.log.Append(e)
			time.Sleep(time.Millisecond)
		}
		close(stop)
	}()
	snap := h.get(t, "/api/v1/snapshot")
	cur := snap["cursor"].(string)
	c, _ := feed.ParseCursor(cur)
	wg.Wait()
	_, head := h.log.Bounds()
	got := readStream(t, h, "/api/v1/stream", map[string]string{"Last-Event-ID": cur}, int(head-c.Pos))
	for i, id := range got {
		if want := h.server.cursor(c.Pos + uint64(i) + 1); id != want {
			t.Fatalf("event %d: %s, want %s", i, id, want)
		}
	}
	// A reconstructed snapshot at an earlier cursor.
	early := h.get(t, "/api/v1/snapshot?at="+h.server.cursor(10))
	if early["reconstructed"] != true || early["pos"].(float64) != 10 {
		t.Fatalf("%v", early["reconstructed"])
	}
	for at, want := range map[string]int{h.server.cursor(head + 5): 409, "fedcba9876543210.3": 409, "junk": 400} {
		if resp, _, _ := h.do(t, "GET", "/api/v1/snapshot?at="+at, nil); resp.StatusCode != want {
			t.Fatalf("%s: %d", at, resp.StatusCode)
		}
	}
}

func TestSnapshotOfEvictedHistoryIsRefused(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario(), window: 10})
	resp, env, _ := h.do(t, "GET", "/api/v1/snapshot?at="+h.server.cursor(2), nil)
	if resp.StatusCode != 410 || env.Error.Kind != KindCursorExpired {
		t.Fatalf("%d %+v", resp.StatusCode, env.Error)
	}
}

// ---- stream ----

// readStream reads ids from a stream until n events arrived.
func readStream(t *testing.T, h *harness, path string, headers map[string]string, n int) []string {
	t.Helper()
	req, _ := http.NewRequest("GET", h.base+path, nil)
	req.AddCookie(h.cookie)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var ids []string
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for len(ids) < n && sc.Scan() {
		if id, found := strings.CutPrefix(sc.Text(), "id: "); found {
			ids = append(ids, id)
		}
	}
	if len(ids) < n {
		t.Fatalf("got %d events, want %d", len(ids), n)
	}
	return ids
}

func TestStreamReconnectAfterTheBrowserClosed(t *testing.T) {
	evs := feedtest.Scenario()
	h := start(t, config{events: evs[:10]})
	first := readStream(t, h, "/api/v1/stream?after="+h.server.cursor(0), nil, 6) // the browser closes after 6
	h.log.Append(evs[10:]...)
	rest := readStream(t, h, "/api/v1/stream", map[string]string{"Last-Event-ID": first[len(first)-1]}, len(evs)-6)
	all := append(first, rest...)
	for i, id := range all {
		if id != h.server.cursor(uint64(i+1)) {
			t.Fatalf("position %d is %s: a gap or a repeat", i+1, id)
		}
	}
}

func TestStreamFilters(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	ids := readStream(t, h, "/api/v1/stream?execution=x0fedcba98765&after="+h.server.cursor(0), nil, 6)
	for _, id := range ids {
		c, _ := feed.ParseCursor(id)
		recs, _ := h.log.After(c.Pos-1, 1)
		ev, _ := feed.Decode(recs[0])
		if ev.Execution() != "x0fedcba98765" {
			t.Fatalf("%s is not the execution's", id)
		}
	}
}

func controlEvents(t *testing.T, h *harness, path string, headers map[string]string, want string) string {
	t.Helper()
	req, _ := http.NewRequest("GET", h.base+path, nil)
	req.AddCookie(h.cookie)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		if sc.Text() == "event: "+want {
			sc.Scan()
			return sc.Text()
		}
	}
	t.Fatalf("no %s event", want)
	return ""
}

// /history serves a window in history order (contract 14), filtered and paged, for replay of
// histories longer than one page; /events stays the delivery-order feed.
func TestHistoryWindowInOrder(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	type page struct {
		Events []struct {
			ID       string   `json:"id"`
			Order    string   `json:"order"`
			Type     string   `json:"type"`
			Entities []string `json:"entities"`
		} `json:"events"`
		Next     *string `json:"next_from_order"`
		More     bool    `json:"more"`
		Complete bool    `json:"complete"`
	}
	read := func(path string) page {
		t.Helper()
		var p page
		b, _ := json.Marshal(h.get(t, path))
		json.Unmarshal(b, &p)
		return p
	}
	all := read("/api/v1/history?limit=5000")
	if len(all.Events) != len(feedtest.Scenario()) || all.More || !all.Complete {
		t.Fatalf("%d events, more %v, complete %v", len(all.Events), all.More, all.Complete)
	}
	for i := 1; i < len(all.Events); i++ {
		if all.Events[i].Order < all.Events[i-1].Order {
			t.Fatalf("not in history order at %d", i)
		}
	}
	// Paged: every event exactly once, in the same order.
	var paged []string
	next := ""
	for k := 0; k < 100; k++ {
		p := read("/api/v1/history?limit=7" + next)
		for _, e := range p.Events {
			paged = append(paged, e.ID)
		}
		if !p.More {
			break
		}
		next = "&from_order=" + *p.Next
	}
	if len(paged) != len(all.Events) || paged[0] != all.Events[0].ID || paged[len(paged)-1] != all.Events[len(all.Events)-1].ID {
		t.Fatalf("paged %d of %d", len(paged), len(all.Events))
	}
	// Filters: one cell's events, one kind, a time window.
	for _, e := range read("/api/v1/history?entities=cell:T-1&type=station.").Events {
		if !strings.HasPrefix(e.Type, "station.") || !slicesContains(e.Entities, "cell:T-1") {
			t.Fatalf("filter let through %+v", e)
		}
	}
	mid := all.Events[len(all.Events)/2].Order[:15]
	for _, e := range read("/api/v1/history?to_order=" + mid).Events {
		if e.Order >= mid {
			t.Fatalf("to_order is exclusive: %s >= %s", e.Order, mid)
		}
	}
	for _, bad := range []string{"from_order=yesterday", "from_ms=-1", "from_ms=5&from_order=000000000000005", "limit=0", "limit=5001",
		"to_order=000000000000001&from_order=000000000000002", "entities=a,,b", "ticket=../x"} {
		if resp, env, _ := h.do(t, "GET", "/api/v1/history?"+bad, nil); resp.StatusCode != 400 || env.Error.Kind != KindInvalid {
			t.Fatalf("%s: %d", bad, resp.StatusCode)
		}
	}
}

// The observer offers no Factory capability: it says so, it reports the event revision it serves,
// and its session lists nothing that starts, stops or changes work.
func TestSessionOffersNoFactoryCapability(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	s := h.get(t, "/api/v1/session")
	caps := s["capabilities"].(map[string]any)
	ev := s["versions"].(map[string]any)["event"].(map[string]any)
	if s["read_only"] != true || caps["execution"] != false || ev["revision"].(float64) != feed.SchemaRevision || ev["schema"].(float64) != 3 {
		t.Fatalf("session %v", s)
	}
	for k := range caps {
		for _, verb := range []string{"dispatch", "enable", "start", "stop", "pause", "approve", "merge", "write"} {
			if strings.Contains(k, verb) {
				t.Fatalf("a capability named %q", k)
			}
		}
	}
}

func slicesContains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestStreamHeartbeatGapAndReset(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario(), window: 10, heartbeat: 50 * time.Millisecond})
	if hb := controlEvents(t, h, "/api/v1/stream", nil, "heartbeat"); !strings.Contains(hb, `"scanned"`) || !strings.Contains(hb, `"head"`) {
		t.Fatalf("heartbeat %s", hb)
	}
	if gap := controlEvents(t, h, "/api/v1/stream", map[string]string{"Last-Event-ID": h.server.cursor(1)}, "gap"); !strings.Contains(gap, `"expired"`) {
		t.Fatalf("gap %s", gap)
	}
	if reset := controlEvents(t, h, "/api/v1/stream", map[string]string{"Last-Event-ID": "fedcba9876543210.4"}, "reset"); !strings.Contains(reset, "generation") {
		t.Fatalf("reset %s", reset)
	}
	if reset := controlEvents(t, h, "/api/v1/stream?after="+h.server.cursor(9999), nil, "reset"); !strings.Contains(reset, "ahead") {
		t.Fatalf("reset %s", reset)
	}
}

// Sixteen clients at once, one of which never reads: the fifteen readers get every event in
// order, the stalled one is dropped at its write deadline, appending never waits, and a
// seventeenth is turned away.
func TestSixteenClientsOneStalled(t *testing.T) {
	h := start(t, config{maxStreams: 16, writeTimeout: 2 * time.Second, batch: 256})
	// the stalled client: connects, reads nothing
	stalled, err := net.Dial("tcp", h.host)
	if err != nil {
		t.Fatal(err)
	}
	defer stalled.Close()
	fmt.Fprintf(stalled, "GET /api/v1/stream?after=%s HTTP/1.1\r\nHost: %s\r\nCookie: %s=%s\r\n\r\n", h.server.cursor(0), h.host, security.CookieName, h.cookie.Value)
	const total = 20000
	var wg sync.WaitGroup
	results := make([][]string, 15)
	ready := make(chan struct{}, 15)
	for i := 0; i < 15; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req, _ := http.NewRequest("GET", h.base+"/api/v1/stream?after="+h.server.cursor(0), nil)
			req.AddCookie(h.cookie)
			resp, err := (&http.Client{Timeout: testkit.Slow(30 * time.Second)}).Do(req)
			if err != nil {
				t.Error(err)
				ready <- struct{}{}
				return
			}
			defer resp.Body.Close()
			ready <- struct{}{}
			sc := bufio.NewScanner(resp.Body)
			sc.Buffer(make([]byte, 1<<20), 1<<20)
			for len(results[i]) < total && sc.Scan() {
				if id, found := strings.CutPrefix(sc.Text(), "id: "); found {
					results[i] = append(results[i], id)
				}
			}
		}(i)
	}
	for i := 0; i < 15; i++ {
		<-ready
	}
	deadline := time.Now().Add(testkit.Slow(5 * time.Second))
	for h.server.streams.Load() < 16 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if resp, _, _ := h.do(t, "GET", "/api/v1/stream", nil); resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("a seventeenth stream: %d", resp.StatusCode)
	}
	var batches [][]map[string]any // built before the clock starts: only appending is timed
	for k := 0; k < total; k += 1000 {
		var batch []map[string]any
		for j := k; j < k+1000; j++ {
			batch = append(batch, feedtest.New("intake-log", "intake.validated", int64(j)).Data(map[string]any{"digest": "d"}).Build())
		}
		batches = append(batches, batch)
	}
	began := time.Now()
	for _, batch := range batches {
		h.log.Append(batch...)
	}
	// The stalled client never drains: an append that waited for it would never finish. 3 s
	// (scaled under -race, where encoding 20,000 events is itself slow) is far above the time
	// appending takes.
	took := time.Since(began)
	t.Logf("appending %d events with one stalled and fifteen reading clients took %s (race detector: %v)", total, took.Round(time.Millisecond), testkit.Race)
	if took > testkit.Slow(3*time.Second) {
		t.Fatalf("appending waited for clients: %s", took)
	}
	wg.Wait()
	for i, ids := range results {
		if len(ids) != total || ids[0] != h.server.cursor(1) || ids[total-1] != h.server.cursor(total) {
			t.Fatalf("client %d got %d events", i, len(ids))
		}
	}
	deadline = time.Now().Add(testkit.Slow(5 * time.Second))
	for h.server.streams.Load() > 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := h.server.streams.Load(); n != 0 {
		t.Fatalf("%d streams still open: the stalled client was not dropped", n)
	}
}

// ---- artifacts over HTTP ----

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestArtifactAPI(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	cell := filepath.Join(h.root, ".factory/worktrees/T-1")
	text := []byte("output\nkey: sk-ant-abcdefghijklmnopqrstu\n")
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 32)...)
	html := []byte("<html><script>alert(1)</script>")
	writeFile(t, filepath.Join(cell, "evidence/AC-01.txt"), text)
	writeFile(t, filepath.Join(cell, "evidence/shot.png"), png)
	writeFile(t, filepath.Join(cell, "evidence/fake.png"), html)
	writeFile(t, filepath.Join(cell, "evidence/big.png"), png)
	os.Truncate(filepath.Join(cell, "evidence/big.png"), artifact.MaxImage+10)
	big, _ := os.ReadFile(filepath.Join(cell, "evidence/big.png"))
	writeFile(t, filepath.Join(cell, "repo/secret.go"), []byte("package secret"))
	res, _ := json.Marshal(map[string]any{"head": "abcdef1", "review_loop": 0, "records": map[string]any{"AC-01": map[string]any{"kind": "scenario", "result": "pass",
		"evidence": []map[string]string{{"file": "AC-01.txt", "sha256": sha(text)}, {"file": "shot.png", "sha256": sha(png)}, {"file": "fake.png", "sha256": sha(html)},
			{"file": "big.png", "sha256": sha(big)}, {"file": "../repo/secret.go", "sha256": "x"}}}}})
	writeFile(t, filepath.Join(cell, "evidence/results.json"), res)

	items := h.get(t, "/api/v1/artifacts?ticket=T-1")["items"].([]any)
	ids := map[string]string{}
	for _, it := range items {
		m := it.(map[string]any)
		ids[m["path_rel"].(string)] = m["id"].(string)
		if strings.Contains(m["path_rel"].(string), "repo") {
			t.Fatal("repo/ was catalogued")
		}
	}
	if ids["evidence/AC-01.txt"] == "" {
		t.Fatalf("%v", ids)
	}
	if v := h.get(t, "/api/v1/artifacts/"+ids["evidence/AC-01.txt"]); v["visit_id"] != "T-1/verify#1" || v["verified_evidence"] != true {
		t.Fatalf("%v", v)
	}
	ev := h.get(t, "/api/v1/cells/T-1/evidence")
	if len(ev["checks"].([]any)) != 2 {
		t.Fatalf("%v", ev["checks"])
	}

	// text: scrubbed, plain, sandboxed, marked
	resp, _, body := h.do(t, "GET", "/api/v1/artifacts/"+ids["evidence/AC-01.txt"]+"/content", nil)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/plain; charset=utf-8" || resp.Header.Get("Content-Security-Policy") != ArtifactCSP ||
		resp.Header.Get("X-MACH-Redacted") == "0" || resp.Header.Get("X-Content-Type-Options") != "nosniff" || strings.Contains(string(body), "sk-ant-") ||
		!strings.HasPrefix(resp.Header.Get("Content-Disposition"), "inline") {
		t.Fatalf("%d %v %q", resp.StatusCode, resp.Header, body)
	}
	if resp, _, _ := h.do(t, "GET", "/api/v1/artifacts/"+ids["evidence/AC-01.txt"]+"/content?download=1", nil); !strings.HasPrefix(resp.Header.Get("Content-Disposition"), "attachment") {
		t.Fatal("download is not an attachment")
	}
	// images: refused until the project opts in
	if resp, env, _ := h.do(t, "GET", "/api/v1/artifacts/"+ids["evidence/shot.png"]+"/content", nil); resp.StatusCode != 403 || env.Error.Reason != "media-disabled" {
		t.Fatalf("%d %+v", resp.StatusCode, env.Error)
	}
	writeFile(t, filepath.Join(h.root, ".factory/config.json"), []byte(`{"tower":{"evidence_media":true}}`))
	time.Sleep(2100 * time.Millisecond) // the catalog's cache
	resp, _, body = h.do(t, "GET", "/api/v1/artifacts/"+ids["evidence/shot.png"]+"/content", nil)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/png" || string(body) != string(png) || resp.Header.Get("X-MACH-Evidence-Match") != "match" {
		t.Fatalf("%d %v", resp.StatusCode, resp.Header)
	}
	if resp, _, _ := h.do(t, "GET", "/api/v1/artifacts/"+ids["evidence/shot.png"]+"/content", func(r *http.Request) { r.Header.Set("Range", "bytes=0-3") }); resp.StatusCode != 206 {
		t.Fatalf("range: %d", resp.StatusCode)
	}
	// wrong type, oversized
	if resp, env, _ := h.do(t, "GET", "/api/v1/artifacts/"+ids["evidence/fake.png"]+"/content", nil); resp.StatusCode != 415 || env.Error.Kind != KindRefused {
		t.Fatalf("fake png: %d", resp.StatusCode)
	}
	if resp, env, _ := h.do(t, "GET", "/api/v1/artifacts/"+ids["evidence/big.png"]+"/content", nil); resp.StatusCode != 413 || env.Error.Reason != "too-large" {
		t.Fatalf("big png: %d %+v", resp.StatusCode, env.Error)
	}
	// changed after cataloguing (within the cache window, so the catalog still holds the old hash)
	writeFile(t, filepath.Join(cell, "evidence/AC-01.txt"), []byte("other\n"))
	if resp, env, _ := h.do(t, "GET", "/api/v1/artifacts/"+ids["evidence/AC-01.txt"]+"/content", nil); resp.StatusCode != 409 && resp.StatusCode != 404 {
		t.Fatalf("changed: %d %+v", resp.StatusCode, env.Error)
	}
	// ids that are paths, or someone else's
	for _, id := range []string{"..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd", "a%00", "evidence%2FAC-01.txt", "abc", "a" + strings.Repeat("0", 24), "A" + strings.Repeat("0", 24)} {
		resp, _, _ := h.do(t, "GET", "/api/v1/artifacts/"+id+"/content", nil)
		if resp.StatusCode != 400 && resp.StatusCode != 404 {
			t.Fatalf("%s: %d", id, resp.StatusCode)
		}
	}
	// a catalog id from another project with the very same file
	otherRoot, _ := filepath.EvalSymlinks(t.TempDir())
	writeFile(t, filepath.Join(otherRoot, ".factory/worktrees/T-1/evidence/AC-01.txt"), text)
	writeFile(t, filepath.Join(otherRoot, ".factory/worktrees/T-1/evidence/results.json"), res)
	others, _ := artifact.New(otherRoot).Snapshot()
	for _, e := range others {
		if resp, _, _ := h.do(t, "GET", "/api/v1/artifacts/"+e.ID+"/content", nil); resp.StatusCode != 404 {
			t.Fatalf("another project's id %s: %d", e.Path, resp.StatusCode)
		}
	}
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// GET /api/v1/series: counts per bucket by kind and authority, every event once, bounded buckets.
func TestSeries(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	all := h.get(t, "/api/v1/series")
	total := int(all["total"].(float64))
	head := len(feedtest.Scenario())
	if total != head || all["bucket_ms"].(float64) < 1000 || len(all["buckets"].([]any)) == 0 {
		t.Fatalf("series %v (want %d events)", all, head)
	}
	sum := 0
	for _, b := range all["buckets"].([]any) {
		m := b.(map[string]any)
		n := 0
		for _, k := range m["kinds"].(map[string]any) {
			n += int(k.(float64))
		}
		if n != int(m["count"].(float64)) {
			t.Fatalf("kinds do not add up to the count: %v", m)
		}
		sum += n
	}
	if sum != total {
		t.Fatalf("buckets %d, total %d", sum, total)
	}
	one := h.get(t, "/api/v1/series?ticket=T-1&bucket_ms=1000")
	if one["total"].(float64) == 0 || one["total"].(float64) >= float64(total) {
		t.Fatalf("filtered %v", one["total"])
	}
	for _, bad := range []string{"bucket_ms=500", "bucket_ms=1500", "from_ms=10&to_ms=5", "from_ms=0&to_ms=999999999999&bucket_ms=1000", "ticket=..%2f"} {
		resp, _, _ := h.do(t, "GET", "/api/v1/series?"+bad, nil)
		if resp.StatusCode != 400 {
			t.Fatalf("%s: %d", bad, resp.StatusCode)
		}
	}
}

// R1 (product-owner decision: label, do not withhold): an artifact whose served text holds prose
// the observer cannot check for unknown names says so, on its catalog entry (free_text,
// free_text_note) and on its content (X-MACH-Free-Text); a record of identifiers only does not.
// Known names are still replaced.
func TestFreeTextArtifactsAreLabelled(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	cell := filepath.Join(h.root, ".factory/worktrees/T-1")
	redact.PeopleFor(h.root).Learn("Ada Lovelace")
	writeFile(t, filepath.Join(cell, "review/round-1/findings.md"), []byte("# Findings\nZed Quill and Ada Lovelace looked at the parser.\n"))
	writeFile(t, filepath.Join(cell, "review/round-1/decision.json"), []byte(`{"ticket_id":"T-1","round":1,"outcome":"APPROVED","approvals":3,"head":"abcdef1",`+
		`"human_approval":{"by":"Ada Lovelace","recorded_by":"an agent, on the person's instruction in conversation","note":null}}`))
	text := []byte("verifier transcript\n")
	writeFile(t, filepath.Join(cell, "evidence/AC-01.txt"), text)
	res, _ := json.Marshal(map[string]any{"head": "abcdef1", "review_loop": 0, "records": map[string]any{"AC-01": map[string]any{"kind": "scenario", "result": "pass",
		"note": "checked with Zed Quill's account", "evidence": []map[string]string{{"file": "AC-01.txt", "sha256": sha(text)}}}}})
	writeFile(t, filepath.Join(cell, "evidence/results.json"), res)

	byPath := map[string]map[string]any{}
	for _, it := range h.get(t, "/api/v1/artifacts?ticket=T-1")["items"].([]any) {
		m := it.(map[string]any)
		byPath[m["path_rel"].(string)] = m
	}
	want := map[string]bool{"review/round-1/findings.md": true, "evidence/results.json": true, "evidence/AC-01.txt": true, "review/round-1/decision.json": false}
	for p, free := range want {
		m := byPath[p]
		if m == nil {
			t.Fatalf("%s not catalogued: %v", p, byPath)
		}
		if m["free_text"] != free || free && m["free_text_note"] != redact.FreeTextNote || !free && m["free_text_note"] != nil {
			t.Errorf("%s: free_text %v note %v, want %v", p, m["free_text"], m["free_text_note"], free)
		}
		resp, _, body := h.do(t, "GET", "/api/v1/artifacts/"+m["id"].(string)+"/content", nil)
		if got := resp.Header.Get(redact.FreeTextHeader); resp.StatusCode != 200 || free && got != redact.FreeTextValue || !free && got != "" {
			t.Errorf("%s: %d %s=%q", p, resp.StatusCode, redact.FreeTextHeader, got)
		}
		if strings.Contains(string(body), "Lovelace") {
			t.Errorf("%s: a known name was served: %s", p, body)
		}
		if p == "review/round-1/decision.json" && !strings.Contains(string(body), "an agent, on the person's instruction in conversation") {
			t.Errorf("the agent's act was credited to a person: %s", body)
		}
	}
}
