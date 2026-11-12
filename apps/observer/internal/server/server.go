// Package server is the observer's HTTP surface. Every route reads; none writes, starts, or
// changes anything. The request checks follow M5's host (apps/studio/internal/server), narrowed
// to GET: any other method is refused before routing, so there is no route to which a write
// could later be attached by accident.
//
// The server knows the ingest side only through feed.Log (the merged log), and IngestSource and
// FactorySource below; cmd/mach-observer adapts the store, the ingest loop and the factory reader
// to them in one file. The routes, their limits and their errors are listed in README.md.
package server

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"mach/observer/internal/artifact"
	"mach/observer/internal/feed"
	"mach/observer/internal/project"
	"mach/observer/internal/security"
)

// Version is the observer's version.
const Version = "0.6.2-m6.1"

// APIVersion is the version in every route's path: /api/v1/...
const APIVersion = 1

// Limits, documented in README.md and served by /api/v1/session.
const (
	DefaultPage      = 200
	MaxPage          = 1000  // events, runs, cells, slices, spans, artifacts per page
	ScanCap          = 10000 // events examined per filtered /events request
	MaxSpans         = 5000
	MaxContentReads  = 4 // artifact content reads at once
	IngestStaleAfter = 5 * time.Second
	statusTTL        = time.Second
)

// IngestState is what the ingest loop reports, as the server needs it.
type IngestState struct {
	Ticks        int64
	LastTickAt   time.Time // zero before the first tick
	LastTickMS   float64
	IntervalMS   int64
	Errors       int64
	LastError    string
	FactoryFound bool
	Sources      []SourceState
	// WatermarkMS is the order_ms up to which ingest asserts history is complete (contract 6.6);
	// nil when ingest does not publish one.
	WatermarkMS *int64
}

// SourceState is one tailed source.
type SourceState struct {
	Key        string    `json:"key"`
	Path       string    `json:"path"`
	State      string    `json:"state"` // live | idle | stale | ended | gone | blocked | unreadable | unknown
	LastReadAt time.Time `json:"-"`
	Offset     int64     `json:"offset"`
	Size       *int64    `json:"size"`
	Lines      int64     `json:"lines"`
	Refused    int64     `json:"refused"`
	Duplicates int64     `json:"duplicates"`
	Oversized  int64     `json:"oversized"`
	Resets     int64     `json:"resets"`
}

// IngestSource reports the ingest loop's state.
type IngestSource interface{ Ingest() IngestState }

// FactoryState is the Factory's status read from its files (never its secrets).
type FactoryState struct {
	Present bool
	// Report is the reader's whole secret-free report (policy summary, lease, counts), passed through.
	Report any
	// The few facts the server derives freshness from.
	Effective     string // disabled | observe | supervised | paused
	Enabled       bool
	Paused        bool
	Autonomy      string
	PolicyUsable  bool
	LeasePresent  bool
	LeaseLive     bool
	LeaseExpired  bool
	LeaseAgeSec   *float64
	LeaseInterval float64 // seconds a heartbeat may be old and still fresh (0: use the lease's own expiry)
	ReadAt        time.Time
}

// FactorySource reads the Factory's status.
type FactorySource interface {
	Factory(now time.Time) FactoryState
}

// Options are what the server needs, resolved at start-up.
type Options struct {
	Root         string
	Guard        *security.Guard
	Log          feed.Log
	Projector    *project.Projector
	Catalog      *artifact.Catalog
	Ingest       IngestSource
	Factory      FactorySource
	UI           http.Handler
	Logger       *log.Logger
	Started      time.Time
	LinkFile     string        // where the next one-time link is kept, project-relative ("" when memory-only)
	Heartbeat    time.Duration // between heartbeat events on a stream (default 15 s)
	WriteTimeout time.Duration // for one write to a stream client (default 10 s)
	MaxStreams   int           // concurrent event streams (default 16)
	StreamBatch  int           // events per write to a stream (default 256)
	Now          func() time.Time
	Done         <-chan struct{}
}

// Server is the HTTP handler for one project.
type Server struct {
	opts    Options
	api     *http.ServeMux
	streams atomic.Int64
	reads   chan struct{}

	statusMu   sync.Mutex
	statusAt   time.Time
	statusData FactoryState
}

// New wires the routes.
func New(opts Options) *Server {
	if opts.Logger == nil {
		opts.Logger = log.New(io.Discard, "", 0)
	}
	if opts.Heartbeat <= 0 {
		opts.Heartbeat = 15 * time.Second
	}
	if opts.WriteTimeout <= 0 {
		opts.WriteTimeout = 10 * time.Second
	}
	if opts.MaxStreams <= 0 {
		opts.MaxStreams = 16
	}
	if opts.StreamBatch <= 0 {
		opts.StreamBatch = 256
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Started.IsZero() {
		opts.Started = opts.Now()
	}
	if opts.Catalog == nil {
		opts.Catalog = artifact.New(opts.Root)
	}
	s := &Server{opts: opts, api: http.NewServeMux(), reads: make(chan struct{}, MaxContentReads)}
	for route, h := range map[string]http.HandlerFunc{
		"session":                       s.session,
		"health":                        s.health,
		"factory/status":                s.factoryStatus,
		"events":                        s.events,
		"stream":                        s.stream,
		"snapshot":                      s.snapshot,
		"project":                       s.project,
		"waves":                         s.waves,
		"waves/{wave}":                  s.wave,
		"slices":                        s.slices,
		"slices/{slice}":                s.slice,
		"cells":                         s.cells,
		"cells/{ticket}":                s.cell,
		"cells/{ticket}/visits/{visit}": s.visit,
		"cells/{ticket}/evidence":       s.evidence,
		"runs":                          s.runs,
		"runs/{execution}":              s.run,
		"runs/{execution}/agents":       s.agents,
		"runs/{execution}/tools":        s.tools,
		"spans":                         s.spans,
		"artifacts":                     s.artifacts,
		"artifacts/{id}":                s.artifact,
		"artifacts/{id}/content":        s.content,
		"analytics/metrics":             s.metrics,
		"analytics/runs":                s.analyticsRuns,
	} {
		s.api.HandleFunc("GET /api/v1/"+route, h)
	}
	s.api.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, fail(KindNotFound, "There is no such route."))
	})
	return s
}

// HTTPServer returns a configured http.Server. No WriteTimeout or ReadTimeout: either would end a
// long-lived event stream. Headers are bounded by ReadHeaderTimeout and MaxHeaderBytes; no handler
// reads a body; each stream write has its own deadline.
func (s *Server) HTTPServer() *http.Server {
	return &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    32 << 10,
		ErrorLog:          s.opts.Logger,
	}
}

// ServeHTTP applies the checks every request passes, in order: headers, method, Host; then for
// the API: no caching, same-site, session, a plain path, the event schema.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	rec := &recorder{ResponseWriter: w, status: http.StatusOK}
	defer func() {
		// Never the query (the start token travels there), never a header.
		s.opts.Logger.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(started).Round(time.Millisecond))
	}()
	security.Headers(rec.Header())
	isAPI := r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.EscapedPath(), "/api/")
	if r.Method != http.MethodGet {
		rec.Header().Set("Allow", "GET")
		rec.Header().Set("Connection", "close")
		if isAPI {
			writeJSON(rec, http.StatusMethodNotAllowed, fail(KindInvalid, "The observer is read-only and answers GET only."))
		} else {
			http.Error(rec, "The observer is read-only and answers GET only.", http.StatusMethodNotAllowed)
		}
		return
	}
	if !s.opts.Guard.HostAllowed(r.Host) {
		msg := "This address is not allowed. Open the Control Tower at 127.0.0.1 or localhost."
		if isAPI {
			writeJSON(rec, http.StatusForbidden, fail(KindUnauthorized, msg))
		} else {
			http.Error(rec, msg, http.StatusForbidden)
		}
		return
	}
	if !isAPI {
		if r.URL.Path == "/" && r.URL.Query().Has("t") {
			s.exchange(rec, r)
			return
		}
		s.opts.UI.ServeHTTP(rec, r)
		return
	}
	rec.Header().Set("Cache-Control", "no-store")
	if err := s.opts.Guard.SameSite(r); err != nil {
		writeJSON(rec, http.StatusForbidden, fail(KindUnauthorized, err.Error()))
		return
	}
	if !s.opts.Guard.Authenticated(r) {
		writeJSON(rec, http.StatusUnauthorized, fail(KindUnauthorized, "Open the Control Tower from the link the observer printed when it started."))
		return
	}
	escaped := r.URL.EscapedPath()
	lower := strings.ToLower(escaped)
	if r.URL.Path != path.Clean(r.URL.Path) || escaped != path.Clean(escaped) || strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c") ||
		strings.Contains(lower, "%2e") || strings.Contains(lower, "%00") || strings.Contains(escaped, "//") || strings.ContainsAny(r.URL.Path, "\x00\\") {
		writeJSON(rec, http.StatusBadRequest, fail(KindInvalid, "The address is not a plain API route."))
		return
	}
	if env, ok := checkSchema(r); !ok {
		writeJSON(rec, http.StatusBadRequest, env)
		return
	}
	s.api.ServeHTTP(rec, r)
}

// checkSchema: a client names the event schema it reads with X-MACH-Event-Schema or ?schema=
// (an EventSource cannot set headers). Absent means 3; anything else is refused with the list.
func checkSchema(r *http.Request) (Envelope, bool) {
	for _, v := range []string{r.Header.Get("X-MACH-Event-Schema"), r.URL.Query().Get("schema")} {
		if v != "" && v != strconv.Itoa(feed.SchemaVersion) {
			env := fail(KindInvalid, "This observer serves event schema version 3 only; version "+strconv.Quote(v)+" is not supported.")
			env.Error.Supported = []int{feed.SchemaVersion}
			return env, false
		}
	}
	return Envelope{}, true
}

func (s *Server) exchange(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if cookie, ok := s.opts.Guard.Exchange(r.URL.Query().Get("t")); ok {
		http.SetCookie(w, cookie)
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	if s.opts.Guard.Authenticated(r) {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	msg := "This link has already been used or is not valid."
	if s.opts.LinkFile != "" {
		msg += " A fresh one-time link is kept in " + s.opts.LinkFile + " (readable only by you); open that one."
	} else {
		msg += " Restart the observer for a new link."
	}
	http.Error(w, msg, http.StatusUnauthorized)
}

// ---- envelope ----

// Error kinds.
const (
	KindInvalid       = "invalid"
	KindUnauthorized  = "unauthorized"
	KindNotFound      = "not_found"
	KindCursorReset   = "cursor_reset"   // another generation, or ahead of the log: take a new snapshot
	KindCursorExpired = "cursor_expired" // older than what is held: take a new snapshot
	KindRefused       = "refused"        // an artifact the observer will not serve (type, opt-in, link, size, changed)
	KindUnavailable   = "unavailable"
	KindInternal      = "internal"
)

// CursorState tells a client where the log stands when its cursor cannot be used.
type CursorState struct {
	Generation string `json:"generation"`
	Floor      string `json:"floor"`
	Head       string `json:"head"`
	Reason     string `json:"reason"`
}

// Error is the error half of the envelope.
type Error struct {
	Kind      string       `json:"kind"`
	Message   string       `json:"message"`
	Cursor    *CursorState `json:"cursor,omitempty"`
	Supported []int        `json:"supported,omitempty"`
	Reason    string       `json:"reason,omitempty"`
}

// Envelope is the one shape every API response takes, as in M5.
type Envelope struct {
	OK    bool   `json:"ok"`
	Data  any    `json:"data,omitempty"`
	Error *Error `json:"error,omitempty"`
}

func ok(data any) Envelope { return Envelope{OK: true, Data: data} }

func fail(kind, message string) Envelope {
	return Envelope{Error: &Error{Kind: kind, Message: message}}
}

func encode(env Envelope) ([]byte, int) {
	data, err := json.Marshal(env)
	if err != nil {
		return []byte(`{"ok":false,"error":{"kind":"internal","message":"The observer could not encode its reply."}}`), http.StatusInternalServerError
	}
	return data, 0
}

func writeJSON(w http.ResponseWriter, status int, env Envelope) {
	data, bad := encode(env)
	if bad != 0 {
		status = bad
	}
	writeBytes(w, status, data)
}

func writeBytes(w http.ResponseWriter, status int, data []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(append(data, '\n'))
}

// view runs fn on the projection under its lock and encodes the reply there too, so no reply is
// ever built from a projection that is changing underneath it.
func (s *Server) view(w http.ResponseWriter, fn func(st *project.State) (int, Envelope)) {
	var data []byte
	status := http.StatusOK
	s.opts.Projector.View(func(st *project.State) {
		var env Envelope
		status, env = fn(st)
		var bad int
		data, bad = encode(env)
		if bad != 0 {
			status = bad
		}
	})
	writeBytes(w, status, data)
}

// ---- parameters ----

var idRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:#~-]{0,127}$`)

// ident reads a path or query identifier; it must look like a MACH identifier.
func ident(v string) (string, bool) {
	if v == "" || !idRe.MatchString(v) || strings.Contains(v, "..") {
		return "", false
	}
	return v, true
}

func optIdent(q map[string][]string, name string) (string, *Envelope) {
	v := ""
	if vs := q[name]; len(vs) > 0 {
		v = vs[0]
	}
	if v == "" {
		return "", nil
	}
	if _, good := ident(v); !good {
		env := fail(KindInvalid, name+" is not an identifier.")
		return "", &env
	}
	return v, nil
}

func pageLimit(r *http.Request, def int) (int, *Envelope) {
	v := r.URL.Query().Get("limit")
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > MaxPage {
		env := fail(KindInvalid, "limit must be between 1 and "+strconv.Itoa(MaxPage)+".")
		return 0, &env
	}
	return n, nil
}

func offset(r *http.Request) (int, *Envelope) {
	v := r.URL.Query().Get("offset")
	if v == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 || n > 1<<20 {
		env := fail(KindInvalid, "offset must be a whole number of at least 0.")
		return 0, &env
	}
	return n, nil
}

func (s *Server) cursor(p uint64) string {
	return feed.Cursor{Epoch: s.opts.Log.Epoch(), Pos: p}.String()
}

// resolve turns a cursor parameter into a position. "" means fallback.
func (s *Server) resolve(raw string, fallback uint64) (uint64, *Error) {
	c, err := feed.ParseCursor(raw)
	if err != nil {
		return 0, &Error{Kind: KindInvalid, Message: err.Error()}
	}
	gen := s.opts.Log.Epoch()
	floor, head := s.opts.Log.Bounds()
	state := &CursorState{Generation: gen, Floor: s.cursor(floor), Head: s.cursor(head)}
	if raw == "" {
		return fallback, nil
	}
	switch {
	case c.Epoch != gen:
		state.Reason = "generation"
		return 0, &Error{Kind: KindCursorReset, Message: "The observer's index was rebuilt; take a new snapshot.", Cursor: state}
	case c.Pos > head:
		state.Reason = "ahead"
		return 0, &Error{Kind: KindCursorReset, Message: "The cursor is ahead of the observer's log; take a new snapshot.", Cursor: state}
	case c.Pos < floor:
		state.Reason = "expired"
		return 0, &Error{Kind: KindCursorExpired, Message: "Events after this cursor are no longer held; take a new snapshot.", Cursor: state}
	}
	return c.Pos, nil
}

func cursorStatus(e *Error) int {
	switch e.Kind {
	case KindCursorReset:
		return http.StatusConflict
	case KindCursorExpired:
		return http.StatusGone
	}
	return http.StatusBadRequest
}

// filter reads the event filters shared by /events and /stream.
func filter(r *http.Request) (feed.Filter, *Envelope) {
	q := r.URL.Query()
	var f feed.Filter
	var bad *Envelope
	if f.Ticket, bad = optIdent(q, "ticket"); bad != nil {
		return f, bad
	}
	if f.Execution, bad = optIdent(q, "execution"); bad != nil {
		return f, bad
	}
	if f.Station, bad = optIdent(q, "station"); bad != nil {
		return f, bad
	}
	f.TypePref, f.Entity, f.Authority = q.Get("type"), q.Get("entity"), q.Get("authority")
	if len(f.TypePref) > 64 || len(f.Entity) > 300 || strings.ContainsAny(f.TypePref+f.Entity, "\x00\n\r") {
		env := fail(KindInvalid, "A filter is too long or not plain text.")
		return f, &env
	}
	if f.Authority != "" && f.Authority != "authoritative" && f.Authority != "observed" && f.Authority != "reconstructed" {
		env := fail(KindInvalid, "authority must be authoritative, observed or reconstructed.")
		return f, &env
	}
	return f, nil
}

// ---- events ----

// events: GET /api/v1/events?after=<cursor>&limit=<1..1000>&ticket&execution&station&type&entity&authority
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	limit, bad := pageLimit(r, DefaultPage)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	f, bad := filter(r)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	floor, _ := s.opts.Log.Bounds()
	pos, cerr := s.resolve(r.URL.Query().Get("after"), floor)
	if cerr != nil {
		writeJSON(w, cursorStatus(cerr), Envelope{Error: cerr})
		return
	}
	page, err := feed.Scan(s.opts.Log, pos, f, limit, ScanCap)
	if errors.Is(err, feed.ErrExpired) {
		_, cerr := s.resolve(s.cursor(page.Next), 0)
		if cerr == nil {
			cerr = &Error{Kind: KindCursorExpired, Message: "Events were dropped while reading; take a new snapshot."}
		}
		writeJSON(w, cursorStatus(cerr), Envelope{Error: cerr})
		return
	}
	events := make([]json.RawMessage, 0, len(page.Records))
	for _, rec := range page.Records {
		events = append(events, rec.Raw)
	}
	floor, head := s.opts.Log.Bounds()
	writeJSON(w, http.StatusOK, ok(map[string]any{
		"generation": s.opts.Log.Epoch(),
		"schema":     feed.SchemaVersion,
		"events":     events,
		"next":       s.cursor(page.Next),
		"head":       s.cursor(head),
		"floor":      s.cursor(floor),
		"more":       page.Next < head,
		"scanned":    page.Scanned,
		"limits":     map[string]int{"page_max": MaxPage, "scan_cap": ScanCap},
	}))
}

// recorder notes the status for the log line and keeps Flush and write deadlines working for
// the event stream (http.ResponseController finds the real writer through Unwrap).
type recorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (r *recorder) WriteHeader(status int) {
	if !r.wrote {
		r.status, r.wrote = status, true
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *recorder) Write(b []byte) (int, error) {
	r.wrote = true
	return r.ResponseWriter.Write(b)
}

func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func projectFolder(root string) string { return filepath.Base(root) }
