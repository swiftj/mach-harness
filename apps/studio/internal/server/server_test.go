package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"mach/studio/internal/engine"
	"mach/studio/internal/interview"
	"mach/studio/internal/security"
	"mach/studio/internal/server"
	"mach/studio/internal/testkit"
	"mach/studio/internal/webui"
)

type host struct {
	t       *testing.T
	project string
	base    string // http://127.0.0.1:<port>
	port    int
	guard   *security.Guard
	logs    *syncBuffer
	cookie  *http.Cookie
	csrf    string
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// start runs the real server on a loopback port against a real project and the real engine.
func start(t *testing.T) *host { return startWith(t, nil) }

// startWith runs the server with a bridge made for the project (nil: interviews unavailable).
func startWith(t *testing.T, bridge func(project string) interview.Bridge) *host {
	t.Helper()
	project := testkit.NewProject(t)
	var b interview.Bridge = interview.Unavailable{}
	if bridge != nil {
		b = bridge(project)
	}
	listener, err := server.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	guard, err := security.NewGuard(port)
	if err != nil {
		t.Fatal(err)
	}
	logs := &syncBuffer{}
	srv := server.New(server.Options{
		Engine: testkit.NewEngine(t, project), Guard: guard, Bridge: b, UI: webui.Handler(),
		Logger: log.New(logs, "", 0), EngineInstall: "explicit",
	}).HTTPServer()
	go srv.Serve(listener)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		b.Shutdown(ctx)
		srv.Shutdown(ctx)
	})
	return &host{t: t, project: project, base: "http://127.0.0.1:" + strconv.Itoa(port), port: port, guard: guard, logs: logs}
}

var noRedirect = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Timeout: 120 * time.Second}

// login exchanges the start token and reads the CSRF token, like the app does.
func (h *host) login() {
	h.t.Helper()
	resp, err := noRedirect.Get(h.guard.StartURL())
	if err != nil {
		h.t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/" {
		h.t.Fatalf("exchange: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	for _, c := range resp.Cookies() {
		if c.Name == security.CookieName {
			h.cookie = c
		}
	}
	if h.cookie == nil {
		h.t.Fatal("no session cookie")
	}
	status, env := h.call("GET", "/api/session", "", nil)
	if status != 200 || !env.OK {
		h.t.Fatalf("session: %d %+v", status, env.Error)
	}
	var data struct {
		CSRF string `json:"csrf_token"`
	}
	json.Unmarshal(env.Data, &data)
	h.csrf = data.CSRF
}

// call sends a request as the logged-in app would; adjust can break any part of it.
func (h *host) call(method, path, body string, adjust func(*http.Request)) (int, engine.Envelope) {
	h.t.Helper()
	req, _ := http.NewRequest(method, h.base+path, strings.NewReader(body))
	if h.cookie != nil {
		req.AddCookie(h.cookie)
	}
	if method != "GET" {
		req.Header.Set("Origin", h.base)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(security.CSRFHeader, h.csrf)
	}
	if adjust != nil {
		adjust(req)
	}
	resp, err := noRedirect.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var env engine.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		h.t.Fatalf("%s %s: not an envelope (%d): %s", method, path, resp.StatusCode, raw)
	}
	if !env.OK && env.Error == nil {
		h.t.Fatalf("%s %s: failure without an error", method, path)
	}
	return resp.StatusCode, env
}

func (h *host) op(name, body string) engine.Envelope {
	h.t.Helper()
	_, env := h.call("POST", "/api/ops/"+name, body, nil)
	return env
}

func (h *host) mustOp(name, body string) json.RawMessage {
	h.t.Helper()
	env := h.op(name, body)
	if !env.OK {
		h.t.Fatalf("%s: %+v", name, env.Error)
	}
	return env.Data
}

func expect(t *testing.T, status int, env engine.Envelope, wantStatus int, kind string) {
	t.Helper()
	if status != wantStatus || env.OK || env.Error.Kind != kind {
		t.Fatalf("want %d %s, got %d %+v", wantStatus, kind, status, env.Error)
	}
}

func (h *host) startSlice() {
	h.mustOp("project.init", `{"id":"team-space","name":"Team Space","vision":"Teams work together.","outcome":["Teams can work together"]}`)
	h.mustOp("epic.add", `{"title":"Team membership","criterion":["Only invited people can join"]}`)
	h.mustOp("slice.new", `{"epic":"EPIC-001","title":"Invite a teammate"}`)
}

func specBody(t *testing.T, name string) string {
	body := map[string]any{"markdown": string(testkit.Fixture(t))}
	if name != "" {
		body["name"] = name
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

// ---- authentication ----

func TestTheStartTokenIsNeededAndWorksOnce(t *testing.T) {
	h := start(t)
	status, env := h.call("GET", "/api/session", "", nil)
	expect(t, status, env, 401, engine.KindUnauthorized)
	status, env = h.call("POST", "/api/ops/status", "{}", nil)
	expect(t, status, env, 401, engine.KindUnauthorized)

	wrong, _ := noRedirect.Get(h.base + "/?t=not-the-token")
	wrong.Body.Close()
	if wrong.StatusCode != 401 || len(wrong.Cookies()) != 0 {
		t.Fatalf("a wrong token: %d %v", wrong.StatusCode, wrong.Cookies())
	}
	h.login()
	again, _ := noRedirect.Get(h.guard.StartURL()) // a second browser, or someone who copied the link
	again.Body.Close()
	if again.StatusCode != 401 || len(again.Cookies()) != 0 {
		t.Fatalf("a reused token: %d %v", again.StatusCode, again.Cookies())
	}
	forged := *h
	forged.cookie = &http.Cookie{Name: security.CookieName, Value: h.cookie.Value[:len(h.cookie.Value)-1] + "A"}
	status, env = forged.call("GET", "/api/session", "", nil)
	expect(t, status, env, 401, engine.KindUnauthorized)

	_, env = h.call("GET", "/api/session", "", nil)
	var session struct {
		Project      map[string]any `json:"project"`
		CSRF         string         `json:"csrf_token"`
		Capabilities struct {
			Interview bool    `json:"interview"`
			Reason    *string `json:"interview_reason"`
		} `json:"capabilities"`
		Versions map[string]any `json:"versions"`
	}
	json.Unmarshal(env.Data, &session)
	if session.CSRF == "" || session.Capabilities.Interview || session.Capabilities.Reason == nil || session.Project["folder"] != "project" {
		t.Fatalf("session: %+v", session)
	}
	if session.Versions["api"] != float64(1) {
		t.Fatalf("versions: %v", session.Versions)
	}
	h.startSlice()
	_, env = h.call("GET", "/api/session", "", nil)
	json.Unmarshal(env.Data, &session)
	if session.Project["name"] != "Team Space" || session.Project["project_id"] != "team-space" {
		t.Fatalf("session project: %v", session.Project)
	}
}

func TestTheHostHeaderMustBeExact(t *testing.T) {
	h := start(t)
	h.login()
	for _, bad := range []string{"evil.example:" + strconv.Itoa(h.port), "127.0.0.1:1", "127.0.0.1", "localhost.evil.example:" + strconv.Itoa(h.port)} {
		status, env := h.call("GET", "/api/session", "", func(r *http.Request) { r.Host = bad })
		expect(t, status, env, 403, engine.KindUnauthorized)
		req, _ := http.NewRequest("GET", h.base+"/", nil)
		req.Host = bad
		resp, _ := noRedirect.Do(req)
		resp.Body.Close()
		if resp.StatusCode != 403 {
			t.Fatalf("page with host %q: %d", bad, resp.StatusCode)
		}
	}
	status, env := h.call("GET", "/api/session", "", func(r *http.Request) { r.Host = "localhost:" + strconv.Itoa(h.port) })
	if status != 200 || !env.OK {
		t.Fatalf("localhost: %d %+v", status, env.Error)
	}
}

func TestStateChangesNeedOriginCSRFAndJSON(t *testing.T) {
	h := start(t)
	h.login()
	cases := map[string]func(*http.Request){
		"no origin":      func(r *http.Request) { r.Header.Del("Origin") },
		"foreign origin": func(r *http.Request) { r.Header.Set("Origin", "http://evil.example") },
		"other port":     func(r *http.Request) { r.Header.Set("Origin", "http://127.0.0.1:1") },
		"no csrf":        func(r *http.Request) { r.Header.Del(security.CSRFHeader) },
		"wrong csrf":     func(r *http.Request) { r.Header.Set(security.CSRFHeader, "guess") },
	}
	for name, adjust := range cases {
		status, env := h.call("POST", "/api/ops/project.init", `{"id":"team-space","name":"n","vision":"v","outcome":["o"]}`, adjust)
		if status != 403 || env.Error.Kind != engine.KindUnauthorized {
			t.Errorf("%s: %d %+v", name, status, env.Error)
		}
		status, env = h.call("PUT", "/api/drafts/spec/SLICE-001", specBody(t, "x"), adjust)
		if status != 403 {
			t.Errorf("%s (draft write): %d %+v", name, status, env.Error)
		}
	}
	status, env := h.call("POST", "/api/ops/status", "{}", func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") })
	expect(t, status, env, 415, engine.KindInvalid)
	if _, err := os.Stat(testkit.Draft(h.project, "product", "project.json")); err == nil {
		t.Fatal("a refused request changed the project")
	}
}

// ---- request shapes ----

func TestMalformedAndUnknownRequests(t *testing.T) {
	h := start(t)
	h.login()
	status, env := h.call("POST", "/api/ops/project.init", `{"id":`, nil)
	expect(t, status, env, 400, engine.KindInvalid)
	status, env = h.call("POST", "/api/ops/run", `{}`, nil)
	expect(t, status, env, 404, engine.KindInvalid)
	status, env = h.call("POST", "/api/ops/slice.show", `{"slice_id":"SLICE-001","path":"/etc/passwd"}`, nil)
	expect(t, status, env, 400, engine.KindInvalid)
	status, env = h.call("POST", "/api/ops/epic.add", `{"title":"`+strings.Repeat("x", engine.MaxBodyBytes)+`"}`, nil)
	expect(t, status, env, 413, engine.KindInvalid)
	status, env = h.call("PUT", "/api/drafts/spec/SLICE-001", `{"markdown":"`+strings.Repeat("x", server.MaxDraftBytes+70<<10)+`"}`, nil)
	expect(t, status, env, 413, engine.KindInvalid)
	status, env = h.call("GET", "/api/ops/status", "", nil)
	expect(t, status, env, 404, engine.KindInvalid)
	status, env = h.call("GET", "/api/nothing", "", nil)
	expect(t, status, env, 404, engine.KindInvalid)
	status, env = h.call("DELETE", "/api/drafts/spec/SLICE-001", "", nil)
	expect(t, status, env, 404, engine.KindInvalid)
}

// ---- operations ----

func TestOperationsReturnTheEnginesWords(t *testing.T) {
	h := start(t)
	h.login()
	h.startSlice()
	status, env := h.call("POST", "/api/ops/slice.approve", `{"slice_id":"SLICE-001"}`, nil)
	expect(t, status, env, 422, engine.KindRefused)
	if !strings.Contains(env.Error.Message, "SLICE-001 cannot be approved yet") {
		t.Fatalf("the refusal is the engine's: %q", env.Error.Message)
	}
	status, env = h.call("POST", "/api/ops/slice.check", `{"slice_id":"SLICE-001"}`, nil)
	if status != 200 || !env.OK {
		t.Fatalf("slice.check with errors is still ok: %d %+v", status, env.Error)
	}
	var check struct {
		Ready  bool     `json:"ready"`
		Errors []string `json:"errors"`
	}
	json.Unmarshal(env.Data, &check)
	if check.Ready || len(check.Errors) == 0 {
		t.Fatalf("check: %+v", check)
	}
}

// ---- drafts ----

func TestDraftWritesAreCheckedAndConfined(t *testing.T) {
	h := start(t)
	h.login()
	h.startSlice()

	_, env := h.call("GET", "/api/drafts/spec/SLICE-001", "", nil)
	var got map[string]any
	json.Unmarshal(env.Data, &got)
	if got["exists"] != false || got["markdown"] != nil || got["editable"] != true {
		t.Fatalf("empty spec: %v", got)
	}
	status, env := h.call("PUT", "/api/drafts/spec/SLICE-001", specBody(t, ""), nil)
	expect(t, status, env, 400, engine.KindInvalid) // no spec yet, so a name is needed
	for _, name := range []string{"../../x", "a/b", "Invite", "invite_teammate", "-x", ""} {
		status, env = h.call("PUT", "/api/drafts/spec/SLICE-001", `{"markdown":"x","name":`+strconv.Quote(name)+`}`, nil)
		expect(t, status, env, 400, engine.KindInvalid)
	}
	for _, id := range []string{"..%2F..%2Fetc", "SLICE-1", "slice-001", "SLICE-001.md"} {
		status, env = h.call("PUT", "/api/drafts/spec/"+id, specBody(t, "invite-teammate"), nil)
		expect(t, status, env, 400, engine.KindInvalid)
	}
	status, env = h.call("PUT", "/api/drafts/spec/SLICE-001", `{"markdown":"x","extra":1}`, nil)
	expect(t, status, env, 400, engine.KindInvalid)

	status, env = h.call("PUT", "/api/drafts/spec/SLICE-001", specBody(t, "invite-teammate"), nil)
	if status != 200 || !env.OK {
		t.Fatalf("write: %d %+v", status, env.Error)
	}
	var written struct {
		Path  string `json:"path"`
		Check struct {
			Counts        map[string]int `json:"counts"`
			IntentProblem []string       `json:"intent_problems"`
			Status        string         `json:"status"`
		} `json:"check"`
	}
	json.Unmarshal(env.Data, &written)
	if written.Path != "specs/slices/"+testkit.SpecName || written.Check.Counts["scenarios"] != 3 || len(written.Check.IntentProblem) == 0 {
		t.Fatalf("written: %+v", written)
	}
	if data, _ := os.ReadFile(testkit.Draft(h.project, "specs", "slices", testkit.SpecName)); !bytes.Equal(data, testkit.Fixture(t)) {
		t.Fatal("the spec on disk differs from what was sent")
	}
	status, env = h.call("PUT", "/api/drafts/spec/SLICE-001", specBody(t, "another-name"), nil)
	expect(t, status, env, 400, engine.KindInvalid) // a spec keeps its file name
	status, env = h.call("PUT", "/api/drafts/intent/SLICE-001", `{"markdown":`+strconv.Quote(testkit.IntentText)+`,"name":"x"}`, nil)
	expect(t, status, env, 400, engine.KindInvalid)
	status, env = h.call("PUT", "/api/drafts/intent/SLICE-001", `{"markdown":`+strconv.Quote(testkit.IntentText)+`}`, nil)
	if status != 200 || !env.OK || !strings.Contains(string(env.Data), `"ready_for_approval"`) {
		t.Fatalf("intent: %d %+v %s", status, env.Error, env.Data)
	}
	_, env = h.call("GET", "/api/drafts/intent/SLICE-001", "", nil)
	json.Unmarshal(env.Data, &got)
	if got["markdown"] != testkit.IntentText || got["path"] != "product/intents/SLICE-001.md" {
		t.Fatalf("read the why: %v", got)
	}

	h.mustOp("epic.approve", `{"epic_id":"EPIC-001"}`)
	h.mustOp("slice.approve", `{"slice_id":"SLICE-001"}`)
	status, env = h.call("PUT", "/api/drafts/spec/SLICE-001", specBody(t, ""), nil)
	expect(t, status, env, 422, engine.KindRefused)
	if !strings.Contains(env.Error.Message, "reopen it first") {
		t.Fatalf("the refusal is the engine's: %q", env.Error.Message)
	}
	if data, _ := os.ReadFile(testkit.Draft(h.project, "specs", "slices", testkit.SpecName)); !bytes.Equal(data, testkit.Fixture(t)) {
		t.Fatal("an approved spec was changed")
	}
	status, env = h.call("PUT", "/api/drafts/spec/SLICE-009", specBody(t, "x"), nil)
	expect(t, status, env, 422, engine.KindRefused) // no such slice: the engine says so
}

func TestSymlinkAttacksOnDraftWrites(t *testing.T) {
	cases := map[string]struct {
		route, body string
		attack      func(project, outside string)
	}{
		"specs folder": {"/api/drafts/spec/SLICE-001", "spec", func(project, outside string) {
			slices := testkit.Draft(project, "specs", "slices")
			os.RemoveAll(slices)
			os.Symlink(outside, slices)
		}},
		"spec file": {"/api/drafts/spec/SLICE-001", "spec", func(project, outside string) {
			os.WriteFile(filepath.Join(outside, "victim.md"), []byte("keep"), 0o644)
			os.Symlink(filepath.Join(outside, "victim.md"), testkit.Draft(project, "specs", "slices", testkit.SpecName))
		}},
		"intents folder": {"/api/drafts/intent/SLICE-001", "intent", func(project, outside string) {
			intents := testkit.Draft(project, "product", "intents")
			os.RemoveAll(intents)
			os.Symlink(outside, intents)
		}},
		"why file": {"/api/drafts/intent/SLICE-001", "intent", func(project, outside string) {
			os.WriteFile(filepath.Join(outside, "victim.md"), []byte("keep"), 0o644)
			os.Symlink(filepath.Join(outside, "victim.md"), testkit.Draft(project, "product", "intents", "SLICE-001.md"))
		}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			h := start(t)
			h.login()
			h.startSlice()
			outside, _ := filepath.EvalSymlinks(t.TempDir())
			c.attack(h.project, outside)
			body := specBody(t, "invite-teammate")
			if c.body == "intent" {
				body = `{"markdown":` + strconv.Quote(testkit.IntentText) + `}`
			}
			status, env := h.call("PUT", c.route, body, nil)
			if status == 200 || env.OK {
				t.Fatalf("a write through a link was accepted")
			}
			t.Logf("refused with %d %s: %s", status, env.Error.Kind, env.Error.Message)
			entries, _ := os.ReadDir(outside)
			for _, e := range entries {
				data, _ := os.ReadFile(filepath.Join(outside, e.Name()))
				if e.Name() != "victim.md" || string(data) != "keep" {
					t.Fatalf("written through the link: %s", e.Name())
				}
			}
			if strings.Contains(h.logs.String(), "Invite a teammate by email") {
				t.Fatal("file contents reached the log")
			}
		})
	}
}

// Two writes to the same slice at once: both are served in turn, both answers are whole.
func TestConcurrentWritesToOneSliceAreSerialised(t *testing.T) {
	h := start(t)
	h.login()
	h.startSlice()
	h.call("PUT", "/api/drafts/spec/SLICE-001", specBody(t, "invite-teammate"), nil)
	fixture := string(testkit.Fixture(t))
	versions := []string{fixture, strings.Replace(fixture, "Invite a teammate by email", "Invite one teammate by email", 1)}
	var wg sync.WaitGroup
	results := make([]engine.Envelope, 4)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i < 2 {
				_, results[i] = h.call("PUT", "/api/drafts/spec/SLICE-001", `{"markdown":`+strconv.Quote(versions[i])+`}`, nil)
			} else {
				_, results[i] = h.call("POST", "/api/ops/slice.set", `{"slice_id":"SLICE-001","title":"Title `+strconv.Itoa(i)+`"}`, nil)
			}
		}(i)
	}
	wg.Wait()
	for i, env := range results {
		if !env.OK || !json.Valid(env.Data) {
			t.Fatalf("request %d: %+v", i, env.Error)
		}
	}
	data, _ := os.ReadFile(testkit.Draft(h.project, "specs", "slices", testkit.SpecName))
	if string(data) != versions[0] && string(data) != versions[1] {
		t.Fatal("the spec is a mixture of two writes")
	}
	raw, _ := os.ReadFile(testkit.Draft(h.project, "product", "slices", "SLICE-001.json"))
	var work map[string]any
	if err := json.Unmarshal(raw, &work); err != nil || work["revision"] != float64(3) {
		t.Fatalf("work order after two changes: %v %v", work["revision"], err)
	}
}

// ---- interview, web app, binding, logs ----

func TestInterviewRoutesWhenInterviewsAreUnavailable(t *testing.T) {
	h := start(t)
	h.login()
	id := strings.Repeat("a", 32)
	for _, c := range []struct{ method, path, body string }{
		{"POST", "/api/interview", `{"slice_id":"SLICE-001"}`},
		{"GET", "/api/interview/" + id + "/events", ""},
		{"POST", "/api/interview/" + id + "/reply", `{"text":"Yes"}`},
		{"POST", "/api/interview/" + id + "/interrupt", `{}`},
		{"POST", "/api/interview/" + id + "/stop", `{}`},
	} {
		status, env := h.call(c.method, c.path, c.body, nil)
		expect(t, status, env, 503, engine.KindUnavailable)
		if env.Error.Message != interview.DefaultReason {
			t.Fatalf("%s: %q", c.path, env.Error.Message)
		}
	}
	status, env := h.call("GET", "/api/interview?slice_id=SLICE-001", "", nil)
	if status != 200 || string(env.Data) != `{"interview":null}` {
		t.Fatalf("current: %d %s", status, env.Data)
	}
	status, env = h.call("POST", "/api/interview", `{"slice_id":"../x"}`, nil)
	expect(t, status, env, 400, engine.KindInvalid)
	status, env = h.call("POST", "/api/interview/abc/stop", `{}`, nil)
	expect(t, status, env, 400, engine.KindInvalid)
}

func TestTheWebAppIsServedWithItsHeaders(t *testing.T) {
	h := start(t)
	for path, want := range map[string]int{"/": 200, "/slices/SLICE-001": 200, "/index.html": 200, "/assets/missing.js": 404} {
		resp, err := http.Get(h.base + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
		if want == 200 && (!strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") || !bytes.Contains(body, []byte("Product Studio"))) {
			t.Fatalf("%s: %s", path, resp.Header.Get("Content-Type"))
		}
		if resp.Header.Get("Content-Security-Policy") != security.ContentSecurityPolicy {
			t.Fatalf("%s: no CSP", path)
		}
	}
	resp, _ := http.Post(h.base+"/", "text/plain", nil)
	resp.Body.Close()
	if resp.StatusCode != 405 {
		t.Fatalf("POST to the app: %d", resp.StatusCode)
	}
}

func TestOnlyTheLoopbackInterfaceIsBound(t *testing.T) {
	listener, err := server.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	addr := listener.Addr().(*net.TCPAddr)
	if !addr.IP.Equal(net.IPv4(127, 0, 0, 1)) {
		t.Fatalf("bound to %s", addr.IP)
	}
	if _, err := server.Listen(70000); err == nil {
		t.Fatal("an impossible port was accepted")
	}
	// Reaching the same port on any other address of this machine must fail.
	addrs, _ := net.InterfaceAddrs()
	tried := 0
	for _, a := range addrs {
		ip, _, _ := net.ParseCIDR(a.String())
		if ip == nil || ip.IsLoopback() || ip.To4() == nil || ip.IsLinkLocalUnicast() {
			continue
		}
		tried++
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(ip.String(), strconv.Itoa(addr.Port)), time.Second)
		if err == nil {
			conn.Close()
			t.Fatalf("the host answered on %s", ip)
		}
	}
	t.Logf("checked %d non-loopback addresses", tried)
}

func TestLogsHoldNoSecretsOrContents(t *testing.T) {
	h := start(t)
	token := strings.TrimPrefix(h.guard.StartURL(), h.base+"/?t=")
	h.login()
	h.startSlice()
	h.call("PUT", "/api/drafts/spec/SLICE-001", specBody(t, "invite-teammate"), nil)
	h.op("slice.approve", `{"slice_id":"SLICE-001"}`)
	logs := h.logs.String()
	for _, secret := range []string{token, h.cookie.Value, h.csrf, "Invite a teammate by email", "Workspace admin", "?t="} {
		if strings.Contains(logs, secret) {
			t.Fatalf("the log contains %q", secret)
		}
	}
	if !strings.Contains(logs, "PUT /api/drafts/spec/SLICE-001 200") {
		t.Fatalf("requests are logged: %s", logs)
	}
}
