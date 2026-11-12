// Package server is the observer's HTTP surface. Every route reads; none writes, starts, or
// changes anything. The request checks follow M5's host (apps/studio/internal/server), narrowed
// to GET: any other method is refused before routing, so there is no route to which a write
// could later be attached by accident.
package server

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/factory"
	"mach/observer/internal/ingest"
	"mach/observer/internal/security"
	"mach/observer/internal/store"
)

// Version is the observer's version.
const Version = "0.6.1-m6.1-skeleton"

// APIVersion is the version in every route's path: /api/v1/...
const APIVersion = 1

// StatsSource is the ingest loop, as the server sees it.
type StatsSource interface{ Stats() ingest.Stats }

// Options are what the server needs, resolved at start-up.
type Options struct {
	Root         string
	Guard        *security.Guard
	Store        *store.Store
	Ingest       StatsSource
	UI           http.Handler
	Logger       *log.Logger
	Started      time.Time
	Heartbeat    time.Duration // between heartbeat events on a stream (default 15 s)
	WriteTimeout time.Duration // for one write to a stream client (default 10 s)
	MaxStreams   int           // concurrent event streams (default 16)
	StreamBatch  int           // events per write to a stream (default 256)
	Done         <-chan struct{}
}

// Server is the HTTP handler for one project.
type Server struct {
	opts    Options
	api     *http.ServeMux
	streams atomic.Int64

	statusMu   sync.Mutex
	statusAt   time.Time
	statusData factory.Report
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
	if opts.Started.IsZero() {
		opts.Started = time.Now()
	}
	s := &Server{opts: opts, api: http.NewServeMux()}
	s.api.HandleFunc("GET /api/v1/session", s.session)
	s.api.HandleFunc("GET /api/v1/health", s.health)
	s.api.HandleFunc("GET /api/v1/factory/status", s.factoryStatus)
	s.api.HandleFunc("GET /api/v1/events", s.events)
	s.api.HandleFunc("GET /api/v1/stream", s.stream)
	s.api.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, fail(KindNotFound, "There is no such route."))
	})
	return s
}

// HTTPServer returns a configured http.Server. No WriteTimeout or ReadTimeout: either would end a
// long-lived event stream (a read deadline cancels the request's context when the background
// read times out). Headers are bounded by ReadHeaderTimeout and MaxHeaderBytes; no handler reads
// a body; each stream write has its own deadline.
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
// the API: no caching, same-site, session, a plain path.
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
		// Read-only: no route takes any other method. Close the connection after answering, so an
		// unframed body is never read as the next request.
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
	if r.URL.Path != path.Clean(r.URL.Path) || escaped != path.Clean(escaped) || strings.Contains(strings.ToLower(escaped), "%2f") ||
		strings.Contains(escaped, "//") {
		writeJSON(rec, http.StatusBadRequest, fail(KindInvalid, "The address is not a plain API route."))
		return
	}
	s.api.ServeHTTP(rec, r)
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
	http.Error(w, "This link has already been used or is not valid. Ask the observer for a new link by restarting it.", http.StatusUnauthorized)
}

// ---- envelope ----

// Error kinds.
const (
	KindInvalid       = "invalid"
	KindUnauthorized  = "unauthorized"
	KindNotFound      = "not_found"
	KindCursorReset   = "cursor_reset"   // another generation, or ahead of the log: take a new snapshot
	KindCursorExpired = "cursor_expired" // older than what is held: take a new snapshot
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
	Kind    string       `json:"kind"`
	Message string       `json:"message"`
	Cursor  *CursorState `json:"cursor,omitempty"`
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

func writeJSON(w http.ResponseWriter, status int, env Envelope) {
	data, err := json.Marshal(env)
	if err != nil {
		status = http.StatusInternalServerError
		data = []byte(`{"ok":false,"error":{"kind":"internal","message":"The observer could not encode its reply."}}`)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(append(data, '\n'))
}

// ---- routes ----

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, ok(map[string]any{
		"project":      map[string]any{"folder": filepath.Base(s.opts.Root)},
		"versions":     map[string]any{"observer": Version, "api": APIVersion, "event": event.Version},
		"generation":   s.opts.Store.Generation(),
		"read_only":    true,
		"capabilities": map[string]any{"execution": false, "artifacts": false, "snapshot": false},
	}))
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	info := s.opts.Store.Info()
	stats := s.opts.Ingest.Stats()
	status := "ok"
	if stats.LastError != "" || (stats.FactoryFound && !info.Persisted) {
		status = "degraded"
	}
	writeJSON(w, http.StatusOK, ok(map[string]any{
		"status":         status,
		"observer":       Version,
		"api":            APIVersion,
		"uptime_seconds": int64(time.Since(s.opts.Started).Seconds()),
		"index":          s.indexView(info),
		"ingest": map[string]any{
			"ticks": stats.Ticks, "last_tick_at": stats.LastTickAt, "last_tick_ms": stats.LastTickMS,
			"interval_ms": stats.IntervalMS, "errors": stats.Errors, "last_error": stats.LastError,
		},
		"streams": map[string]any{"active": s.streams.Load(), "max": s.opts.MaxStreams},
	}))
}

func (s *Server) indexView(info store.Info) map[string]any {
	return map[string]any{
		"generation": info.Generation,
		"head":       event.Cursor{Generation: info.Generation, Position: info.Head}.String(),
		"floor":      event.Cursor{Generation: info.Generation, Position: info.Floor}.String(),
		"in_memory":  info.InMemory, "persisted": info.Persisted, "rebuilt": info.Rebuilt, "duplicates_dropped": info.Duplicates,
	}
}

// factoryStatus reads the Factory's files at most once a second, however many clients ask.
func (s *Server) factoryStatus(w http.ResponseWriter, r *http.Request) {
	s.statusMu.Lock()
	if time.Since(s.statusAt) > time.Second {
		s.statusData = factory.Read(s.opts.Root, time.Now())
		s.statusAt = time.Now()
	}
	report := s.statusData
	s.statusMu.Unlock()
	stats := s.opts.Ingest.Stats()
	writeJSON(w, http.StatusOK, ok(map[string]any{
		"project":         report.Project,
		"factory_present": report.FactoryPresent,
		"policy":          report.Policy,
		"lease":           report.Lease,
		"counts":          report.Counts,
		"read_at":         report.ReadAt,
		"index":           s.indexView(s.opts.Store.Info()),
		"sources":         stats.Sources,
	}))
}

// resolve turns a cursor parameter into a position. "" means fallback.
func (s *Server) resolve(raw string, fallback uint64) (uint64, *Error) {
	c, err := event.ParseCursor(raw)
	if err != nil {
		return 0, &Error{Kind: KindInvalid, Message: err.Error()}
	}
	gen := s.opts.Store.Generation()
	floor, head := s.opts.Store.Bounds()
	state := &CursorState{Generation: gen, Floor: event.Cursor{Generation: gen, Position: floor}.String(),
		Head: event.Cursor{Generation: gen, Position: head}.String()}
	if raw == "" {
		return fallback, nil
	}
	switch {
	case c.Generation != gen:
		state.Reason = "generation"
		return 0, &Error{Kind: KindCursorReset, Message: "The observer's index was rebuilt; take a new snapshot.", Cursor: state}
	case c.Position > head:
		state.Reason = "ahead"
		return 0, &Error{Kind: KindCursorReset, Message: "The cursor is ahead of the observer's log; take a new snapshot.", Cursor: state}
	case c.Position < floor:
		state.Reason = "expired"
		return 0, &Error{Kind: KindCursorExpired, Message: "Events after this cursor are no longer held; take a new snapshot.", Cursor: state}
	}
	return c.Position, nil
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

// events: GET /api/v1/events?after=<cursor>&limit=<1..1000>&ticket=<id>&type=<prefix>
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 200
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000 {
			writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "limit must be between 1 and 1000."))
			return
		}
		limit = n
	}
	ticket, typePrefix := q.Get("ticket"), q.Get("type")
	if len(ticket) > 128 || len(typePrefix) > 64 {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "A filter is too long."))
		return
	}
	floor, _ := s.opts.Store.Bounds()
	pos, cerr := s.resolve(q.Get("after"), floor)
	if cerr != nil {
		writeJSON(w, cursorStatus(cerr), Envelope{Error: cerr})
		return
	}
	gen := s.opts.Store.Generation()
	out := []json.RawMessage{}
	scanned := pos
	const scanCap = 10000
	for scannedCount := 0; len(out) < limit && scannedCount < scanCap; {
		entries, err := s.opts.Store.After(scanned, min(limit*4, 1000))
		if errors.Is(err, store.ErrExpired) {
			_, cerr := s.resolve(event.Cursor{Generation: gen, Position: scanned}.String(), 0)
			if cerr == nil {
				cerr = &Error{Kind: KindCursorExpired, Message: "Events were dropped while reading; take a new snapshot."}
			}
			writeJSON(w, cursorStatus(cerr), Envelope{Error: cerr})
			return
		}
		if err != nil || len(entries) == 0 {
			break
		}
		for _, e := range entries {
			scanned = e.Event.Position
			scannedCount++
			if (ticket == "" || e.Event.Subject.TicketID == ticket) && (typePrefix == "" || strings.HasPrefix(e.Event.Type, typePrefix)) {
				out = append(out, e.Raw)
				if len(out) >= limit {
					break
				}
			}
		}
	}
	floor, head := s.opts.Store.Bounds()
	writeJSON(w, http.StatusOK, ok(map[string]any{
		"generation": gen,
		"events":     out,
		"next":       event.Cursor{Generation: gen, Position: scanned}.String(),
		"head":       event.Cursor{Generation: gen, Position: head}.String(),
		"floor":      event.Cursor{Generation: gen, Position: floor}.String(),
		"more":       scanned < head,
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
