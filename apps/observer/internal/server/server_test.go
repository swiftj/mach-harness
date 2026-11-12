package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/ingest"
	"mach/observer/internal/security"
	"mach/observer/internal/store"
	"mach/observer/internal/testkit"
	"mach/observer/internal/webui"
)

type harness struct {
	root   string
	base   string
	host   string
	client *http.Client
	cookie *http.Cookie
	store  *store.Store
	server *Server
}

type config struct {
	memory       int
	heartbeat    time.Duration
	writeTimeout time.Duration
	maxStreams   int
	noIngest     bool
}

func start(t *testing.T, c config) *harness {
	t.Helper()
	if c.memory == 0 {
		c.memory = 1000
	}
	root := testkit.Project(t)
	st, err := store.Open(filepath.Join(root, ".factory/local/observer/index"), c.memory)
	if err != nil {
		t.Fatal(err)
	}
	loop := ingest.New(ingest.Options{Root: root, Store: st, PollMin: 10 * time.Millisecond, PollMax: 20 * time.Millisecond})
	l, err := security.Listen("127.0.0.1", 0)
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	guard, _ := security.NewGuard(port)
	done := make(chan struct{})
	s := New(Options{Root: root, Guard: guard, Store: st, Ingest: loop, UI: webui.Handler(), Done: done,
		Heartbeat: c.heartbeat, WriteTimeout: c.writeTimeout, MaxStreams: c.maxStreams})
	hs := s.HTTPServer()
	go hs.Serve(l)
	if !c.noIngest {
		go loop.Run(done)
	}
	t.Cleanup(func() {
		close(done)
		hs.Close()
		st.Close()
	})
	jar, _ := cookiejar.New(nil)
	h := &harness{root: root, base: fmt.Sprintf("http://127.0.0.1:%d", port), host: fmt.Sprintf("127.0.0.1:%d", port),
		client: &http.Client{Jar: jar, Timeout: 10 * time.Second}, store: st, server: s}
	resp, err := h.client.Get(guard.StartURL())
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	u := resp.Request.URL
	for _, ck := range jar.Cookies(u) {
		if ck.Name == security.CookieName {
			h.cookie = ck
		}
	}
	if h.cookie == nil {
		t.Fatal("no session after the start link")
	}
	return h
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

func (h *harness) waitHead(t *testing.T, want uint64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, head := h.store.Bounds(); head >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	_, head := h.store.Bounds()
	t.Fatalf("head %d, want %d", head, want)
}

func checkCSP(t *testing.T, resp *http.Response) {
	t.Helper()
	if resp.Header.Get("Content-Security-Policy") != security.ContentSecurityPolicy || resp.Header.Get("X-Content-Type-Options") != "nosniff" ||
		resp.Header.Get("X-Frame-Options") != "DENY" {
		t.Fatalf("%d %s: security headers missing", resp.StatusCode, resp.Request.URL.Path)
	}
}

// ---- security ----

func TestEveryOtherMethodIsRefused(t *testing.T) {
	h := start(t, config{})
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "PROPFIND"} {
		for _, path := range []string{"/api/v1/health", "/api/v1/stream", "/api/v1/nope", "/", "/?t=x"} {
			resp, _, _ := h.do(t, method, path, nil)
			checkCSP(t, resp)
			if resp.StatusCode != http.StatusMethodNotAllowed || resp.Header.Get("Allow") != "GET" {
				t.Errorf("%s %s: %d", method, path, resp.StatusCode)
			}
		}
	}
}

func TestBadHostIsRefused(t *testing.T) {
	h := start(t, config{})
	for _, host := range []string{"evil.example", "evil.example:" + strings.Split(h.host, ":")[1], "127.0.0.1:1", "[::1]:80"} {
		resp, env, _ := h.do(t, "GET", "/api/v1/health", func(r *http.Request) { r.Host = host })
		checkCSP(t, resp)
		if resp.StatusCode != http.StatusForbidden || env.OK {
			t.Errorf("host %q: %d", host, resp.StatusCode)
		}
		resp, _, _ = h.do(t, "GET", "/", func(r *http.Request) { r.Host = host })
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("host %q on the page: %d", host, resp.StatusCode)
		}
	}
}

func TestOtherOriginIsRefused(t *testing.T) {
	h := start(t, config{})
	cases := []map[string]string{{"Origin": "http://evil.example"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}}
	for _, headers := range cases {
		for _, path := range []string{"/api/v1/health", "/api/v1/stream", "/api/v1/events"} {
			resp, env, _ := h.do(t, "GET", path, func(r *http.Request) {
				for k, v := range headers {
					r.Header.Set(k, v)
				}
			})
			checkCSP(t, resp)
			if resp.StatusCode != http.StatusForbidden || env.Error == nil || env.Error.Kind != KindUnauthorized {
				t.Errorf("%v %s: %d", headers, path, resp.StatusCode)
			}
		}
	}
	resp, _, _ := h.do(t, "GET", "/api/v1/health", func(r *http.Request) {
		r.Header.Set("Origin", h.base)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("same origin: %d", resp.StatusCode)
	}
}

func TestSessionRequired(t *testing.T) {
	h := start(t, config{})
	for _, path := range []string{"/api/v1/health", "/api/v1/factory/status", "/api/v1/events", "/api/v1/stream", "/api/v1/session"} {
		req, _ := http.NewRequest("GET", h.base+path, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		checkCSP(t, resp)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("no cookie %s: %d", path, resp.StatusCode)
		}
		req.AddCookie(&http.Cookie{Name: security.CookieName, Value: "forged"})
		resp, _ = http.DefaultClient.Do(req)
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("forged cookie %s: %d", path, resp.StatusCode)
		}
	}
	// The start link works once.
	resp, err := http.Get(h.base + "/?t=" + "anything")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("a wrong start token: %d", resp.StatusCode)
	}
}

func TestUnknownAndUncleanRoutes(t *testing.T) {
	h := start(t, config{})
	for path, want := range map[string]int{"/api/v1/nope": 404, "/api/v2/health": 404, "/api/v1/../v1/health": 400, "/api/v1//health": 400,
		"/api/v1/factory%2fstatus": 400} {
		req, _ := http.NewRequest("GET", h.base+"/", nil)
		req.URL.Opaque = path // send the path as written, without client-side cleaning
		req.AddCookie(h.cookie)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		checkCSP(t, resp)
		if resp.StatusCode != want {
			t.Errorf("%s: %d, want %d", path, resp.StatusCode, want)
		}
	}
	resp, _, body := h.do(t, "GET", "/", nil)
	checkCSP(t, resp)
	if resp.StatusCode != 200 || !strings.Contains(string(body), "Control Tower") {
		t.Fatalf("page: %d", resp.StatusCode)
	}
}

// ---- status ----

func TestHealthAndFactoryStatus(t *testing.T) {
	h := start(t, config{})
	host, _ := os.Hostname()
	policy := map[string]any{"schema_version": 2, "enabled": true, "paused": false, "autonomy": "supervised", "allow_merge": false,
		"persistent": false, "max_risk": "Medium", "limits": map[string]any{}, "allowed_tools": []string{"Bash(git status)"},
		"excluded_slices": []string{}, "source_branch": "main", "claude": map[string]any{"path": "/Users/someone/bin/claude"},
		"runner_id": "R-1", "machine": host, "project_root": h.root, "enabled_by": "Ada Lovelace", "enabled_at": "2026-11-12T09:00:00Z"}
	data, _ := json.Marshal(policy)
	os.WriteFile(filepath.Join(h.root, ".factory/local/runner.json"), data, 0o600)
	lease, _ := json.Marshal(map[string]any{"instance": "abc", "runner_id": "R-1", "pid": os.Getpid(), "host": host,
		"started_at": time.Now().UTC().Format(time.RFC3339), "heartbeat_at": time.Now().UTC().Format(time.RFC3339),
		"expires_at": time.Now().Add(time.Minute).UTC().Format(time.RFC3339)})
	os.WriteFile(filepath.Join(h.root, ".factory/local/supervisor.json"), lease, 0o600)
	os.MkdirAll(filepath.Join(h.root, ".factory/local/executions/x0123456789ab"), 0o700)
	testkit.Append(t, testkit.CellLog(h.root, "T-1"), testkit.LifecycleLine("T-1", 1, "station.entered", "build", nil))
	os.MkdirAll(filepath.Join(h.root, ".factory/worktrees/T-2"), 0o755)

	resp, env, body := h.do(t, "GET", "/api/v1/factory/status", nil)
	if resp.StatusCode != 200 || !env.OK {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	for _, private := range []string{"Ada Lovelace", "git status", "/Users/someone", "abc"} {
		if strings.Contains(string(body), private) {
			t.Fatalf("%q reached the status: %s", private, body)
		}
	}
	var view struct {
		Data struct {
			FactoryPresent bool `json:"factory_present"`
			Policy         struct {
				Usable    bool   `json:"usable"`
				Effective string `json:"effective"`
			} `json:"policy"`
			Lease struct {
				Live     bool `json:"live"`
				SameHost bool `json:"same_host"`
			} `json:"lease"`
			Counts struct {
				Cells, CellsWithLifecycle, Executions int
			} `json:"counts"`
			Index struct {
				Generation string `json:"generation"`
			} `json:"index"`
		} `json:"data"`
	}
	json.Unmarshal(body, &view)
	d := view.Data
	if !d.FactoryPresent || !d.Policy.Usable || d.Policy.Effective != "supervised" || !d.Lease.Live || !d.Lease.SameHost {
		t.Fatalf("%s", body)
	}
	var counts map[string]any
	json.Unmarshal(mustField(t, body, "counts"), &counts)
	if counts["cells"] != 2.0 || counts["cells_with_lifecycle"] != 1.0 || counts["executions"] != 1.0 || !event.ValidGeneration(d.Index.Generation) {
		t.Fatalf("counts %v", counts)
	}
	// A policy others can read reads as unusable.
	os.Chmod(filepath.Join(h.root, ".factory/local/runner.json"), 0o644)
	time.Sleep(1100 * time.Millisecond) // the status is cached for a second
	_, _, body = h.do(t, "GET", "/api/v1/factory/status", nil)
	if !strings.Contains(string(body), `"reason":"shared-permissions"`) || !strings.Contains(string(body), `"effective":"disabled"`) {
		t.Fatalf("%s", body)
	}

	resp, env, body = h.do(t, "GET", "/api/v1/health", nil)
	if resp.StatusCode != 200 || !env.OK || !strings.Contains(string(body), `"status":"ok"`) {
		t.Fatalf("%s", body)
	}
}

func mustField(t *testing.T, body []byte, name string) json.RawMessage {
	var env struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatal(err)
	}
	return env.Data[name]
}

// ---- events ----

func appendLedger(t *testing.T, root string, from, to int) {
	var buf []byte
	for i := from; i <= to; i++ {
		ticket := "T-1"
		if i%2 == 0 {
			ticket = "T-2"
		}
		buf = append(buf, testkit.LedgerLine(i, "work.claimed", ticket, nil)...)
	}
	testkit.Append(t, testkit.LedgerPath(root), buf)
}

func TestEventsPagingFiltersAndCursorErrors(t *testing.T) {
	h := start(t, config{memory: 20})
	appendLedger(t, h.root, 1, 10)
	h.waitHead(t, 10)
	gen := h.store.Generation()
	var page struct {
		Data struct {
			Events []event.Event `json:"events"`
			Next   string        `json:"next"`
			More   bool          `json:"more"`
		} `json:"data"`
	}
	_, _, body := h.do(t, "GET", "/api/v1/events?limit=4", nil)
	json.Unmarshal(body, &page)
	if len(page.Data.Events) != 4 || page.Data.Next != gen+".4" || !page.Data.More {
		t.Fatalf("%s", body)
	}
	_, _, body = h.do(t, "GET", "/api/v1/events?after="+page.Data.Next+"&ticket=T-2", nil)
	json.Unmarshal(body, &page)
	if len(page.Data.Events) != 3 || page.Data.Events[0].Subject.TicketID != "T-2" || page.Data.Events[0].Cursor != gen+".6" {
		t.Fatalf("%s", body)
	}
	for q, want := range map[string]struct {
		status int
		kind   string
	}{
		"after=0123456789abcdef.3": {409, KindCursorReset},
		"after=" + gen + ".99":     {409, KindCursorReset},
		"after=garbage":            {400, KindInvalid},
		"limit=0":                  {400, KindInvalid},
	} {
		resp, env, body := h.do(t, "GET", "/api/v1/events?"+q, nil)
		if resp.StatusCode != want.status || env.Error == nil || env.Error.Kind != want.kind {
			t.Errorf("%s: %d %s", q, resp.StatusCode, body)
		}
	}
	appendLedger(t, h.root, 11, 40)
	h.waitHead(t, 40)
	resp, env, _ := h.do(t, "GET", "/api/v1/events?after="+gen+".2", nil)
	if resp.StatusCode != http.StatusGone || env.Error.Kind != KindCursorExpired || env.Error.Cursor.Floor != gen+".20" {
		t.Fatalf("expired cursor: %d %+v", resp.StatusCode, env.Error)
	}
}

// ---- stream ----

type sse struct {
	name, id, data string
}

type streamConn struct {
	resp   *http.Response
	events chan sse
}

func (h *harness) open(t *testing.T, lastID, after string) *streamConn {
	t.Helper()
	path := "/api/v1/stream"
	if after != "" {
		path += "?after=" + after
	}
	req, _ := http.NewRequest("GET", h.base+path, nil)
	req.AddCookie(h.cookie)
	if lastID != "" {
		req.Header.Set("Last-Event-ID", lastID)
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	checkCSP(t, resp)
	c := &streamConn{resp: resp, events: make(chan sse, 100000)}
	t.Cleanup(func() { resp.Body.Close() })
	go func() {
		defer close(c.events)
		r := bufio.NewReader(resp.Body)
		var cur sse
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\n")
			switch {
			case line == "":
				if cur.data != "" {
					if cur.name == "" {
						cur.name = "message"
					}
					c.events <- cur
				}
				cur = sse{}
			case strings.HasPrefix(line, "event: "):
				cur.name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "id: "):
				cur.id = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "data: "):
				cur.data = strings.TrimPrefix(line, "data: ")
			}
		}
	}()
	return c
}

func (c *streamConn) next(t *testing.T, skipHeartbeats bool) sse {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case e, ok := <-c.events:
			if !ok {
				t.Fatal("the stream ended")
			}
			if skipHeartbeats && e.name == "heartbeat" {
				continue
			}
			return e
		case <-timeout:
			t.Fatal("no event within 5s")
		}
	}
}

func (c *streamConn) ended(t *testing.T) {
	t.Helper()
	select {
	case _, ok := <-c.events:
		if ok {
			t.Fatal("an event after the stream should have ended")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the stream did not end")
	}
}

func TestStreamLiveAndReconnectWithLastEventID(t *testing.T) {
	h := start(t, config{})
	gen := h.store.Generation()
	c := h.open(t, "", "")
	if c.resp.Header.Get("Content-Type") != "text/event-stream; charset=utf-8" {
		t.Fatal(c.resp.Header.Get("Content-Type"))
	}
	if hello := c.next(t, true); hello.name != "hello" || !strings.Contains(hello.data, `"cursor":"`+gen+`.0"`) {
		t.Fatalf("%+v", hello)
	}
	appendLedger(t, h.root, 1, 3)
	var seen []string
	for range 2 {
		e := c.next(t, true)
		seen = append(seen, e.id)
	}
	c.resp.Body.Close() // the client drops after two events
	if seen[1] != gen+".2" {
		t.Fatalf("ids %v", seen)
	}
	appendLedger(t, h.root, 4, 5)
	h.waitHead(t, 5)

	again := h.open(t, seen[1], "")
	if hello := again.next(t, true); hello.name != "hello" || !strings.Contains(hello.data, `"cursor":"`+seen[1]+`"`) {
		t.Fatalf("%+v", hello)
	}
	for want := 3; want <= 5; want++ {
		e := again.next(t, true)
		var ev event.Event
		json.Unmarshal([]byte(e.data), &ev)
		if e.name != "message" || e.id != gen+"."+strconv.Itoa(want) || ev.Source.Seq != int64(want) {
			t.Fatalf("event %d: %+v", want, e)
		}
	}
	appendLedger(t, h.root, 6, 6)
	if e := again.next(t, true); e.id != gen+".6" {
		t.Fatalf("live after catch-up: %+v", e)
	}
}

func TestStreamHeartbeat(t *testing.T) {
	h := start(t, config{heartbeat: 30 * time.Millisecond})
	c := h.open(t, "", "")
	c.next(t, false) // hello
	if e := c.next(t, false); e.name != "heartbeat" || !strings.Contains(e.data, `"head"`) || e.id != "" {
		t.Fatalf("%+v", e)
	}
}

func TestStreamGapAndReset(t *testing.T) {
	h := start(t, config{memory: 5})
	appendLedger(t, h.root, 1, 20)
	h.waitHead(t, 20)
	gen := h.store.Generation()

	c := h.open(t, gen+".3", "")
	if e := c.next(t, true); e.name != "gap" || !strings.Contains(e.data, `"reason":"expired"`) || !strings.Contains(e.data, `"floor":"`+gen+`.15"`) {
		t.Fatalf("%+v", e)
	}
	c.ended(t)

	r := h.open(t, "0123456789abcdef.3", "")
	if e := r.next(t, true); e.name != "reset" || !strings.Contains(e.data, `"reason":"generation"`) || !strings.Contains(e.data, `"generation":"`+gen+`"`) {
		t.Fatalf("%+v", e)
	}
	r.ended(t)

	ok := h.open(t, gen+".15", "")
	ok.next(t, true) // hello
	if e := ok.next(t, true); e.id != gen+".16" {
		t.Fatalf("from the floor: %+v", e)
	}
}

func TestStreamLimit(t *testing.T) {
	h := start(t, config{maxStreams: 1})
	c := h.open(t, "", "")
	c.next(t, true)
	resp, env, _ := h.do(t, "GET", "/api/v1/stream", nil)
	if resp.StatusCode != http.StatusServiceUnavailable || env.Error.Kind != KindUnavailable {
		t.Fatalf("%d", resp.StatusCode)
	}
}

// A client that stops reading must not hold up ingest or other clients, and is dropped.
func TestSlowClientDoesNotBlockOthers(t *testing.T) {
	h := start(t, config{memory: 60000, writeTimeout: time.Second, noIngest: true})
	gen := h.store.Generation()

	// The slow client: a raw connection that sends its request and never reads.
	conn, err := net.Dial("tcp", h.host)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if tcp, ok := conn.(*net.TCPConn); ok {
		tcp.SetReadBuffer(4096)
	}
	fmt.Fprintf(conn, "GET /api/v1/stream?after=%s.0 HTTP/1.1\r\nHost: %s\r\nCookie: %s=%s\r\n\r\n", gen, h.host, security.CookieName, h.cookie.Value)

	fast := h.open(t, "", gen+".0")
	fast.next(t, true) // hello
	for wait := time.Now().Add(5 * time.Second); h.server.streams.Load() != 2; {
		if time.Now().After(wait) {
			t.Fatalf("the slow client never opened its stream (%d open)", h.server.streams.Load())
		}
		time.Sleep(5 * time.Millisecond)
	}

	// Ingest writes far more than the slow client's socket can hold, as fast as it can.
	payload := strings.Repeat("x", 200)
	const total = 30000
	startAppend := time.Now()
	for i := 1; i <= total; i += 500 {
		var batch []*event.Event
		for j := i; j < i+500; j++ {
			batch = append(batch, &event.Event{V: 3, ID: "e" + strconv.Itoa(j), Type: "t", Authority: "authoritative",
				Data: map[string]any{"pad": payload}})
		}
		if _, err := h.store.Append(batch, nil); err != nil {
			t.Fatal(err)
		}
	}
	if took := time.Since(startAppend); took > 3*time.Second {
		t.Fatalf("appending took %s: a reader is holding up ingest", took)
	}

	// The fast client receives everything, in order.
	deadline := time.After(20 * time.Second)
	got := 0
	for got < total {
		select {
		case e, ok := <-fast.events:
			if !ok {
				t.Fatalf("the fast stream ended after %d", got)
			}
			if e.name != "message" {
				continue
			}
			got++
			if e.id != gen+"."+strconv.Itoa(got) {
				t.Fatalf("out of order: %s at %d", e.id, got)
			}
		case <-deadline:
			t.Fatalf("the fast client got %d of %d", got, total)
		}
	}

	// The slow client is dropped once a write blocks past the deadline.
	dropDeadline := time.Now().Add(10 * time.Second)
	for h.server.streams.Load() > 1 {
		if time.Now().After(dropDeadline) {
			t.Fatalf("the slow client still holds a stream (%d open)", h.server.streams.Load())
		}
		time.Sleep(20 * time.Millisecond)
	}
}
