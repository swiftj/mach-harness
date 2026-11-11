// Package server is the host's HTTP surface: the routes of contract section 4, behind the
// security checks of section 5. It decides no product rule; it passes typed requests to the
// engine and returns what the engine said.
package server

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"mach/studio/internal/engine"
	"mach/studio/internal/interview"
	"mach/studio/internal/security"
)

// Version is the host's version, reported by GET /api/session.
const Version = "0.5.0-m5"

// APIVersion changes when a route or envelope changes shape.
const APIVersion = 1

// Listen binds the loopback interface only: 127.0.0.1, never a wildcard. Port 0 picks a free one.
func Listen(port int) (net.Listener, error) {
	if port < 0 || port > 65535 {
		return nil, errors.New("the port must be between 0 and 65535")
	}
	return net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
}

// Options are what the server needs, all resolved at start-up.
type Options struct {
	Engine        *engine.Engine
	Guard         *security.Guard
	Bridge        interview.Bridge
	UI            http.Handler
	Logger        *log.Logger
	EngineInstall string // explicit, plugin or project
}

// Server is the HTTP handler for one project.
type Server struct {
	opts Options
	api  *http.ServeMux
}

// New wires the routes.
func New(opts Options) *Server {
	if opts.Bridge == nil {
		opts.Bridge = interview.Unavailable{}
	}
	if opts.Logger == nil {
		opts.Logger = log.New(io.Discard, "", 0)
	}
	s := &Server{opts: opts, api: http.NewServeMux()}
	s.api.HandleFunc("GET /api/session", s.session)
	s.api.HandleFunc("POST /api/ops/{op}", s.operation)
	for _, kind := range []string{"spec", "intent"} {
		s.api.HandleFunc("GET /api/drafts/"+kind+"/{slice}", s.getDraft(kind))
		s.api.HandleFunc("PUT /api/drafts/"+kind+"/{slice}", s.putDraft(kind))
	}
	s.api.HandleFunc("POST /api/interview", s.interviewStart)
	s.api.HandleFunc("GET /api/interview", s.interviewCurrent)
	s.api.HandleFunc("GET /api/interview/history", s.interviewHistory)
	s.api.HandleFunc("GET /api/interview/{id}/events", s.interviewEvents)
	s.api.HandleFunc("POST /api/interview/{id}/reply", s.interviewReply)
	s.api.HandleFunc("POST /api/interview/{id}/interrupt", s.interviewControl(false))
	s.api.HandleFunc("POST /api/interview/{id}/stop", s.interviewControl(true))
	s.api.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, http.StatusNotFound, engine.Fail(engine.KindInvalid, "There is no such route."))
	})
	return s
}

// HTTPServer returns a configured http.Server for this handler.
func (s *Server) HTTPServer() *http.Server {
	return &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		// No ReadTimeout: it would cancel a long-lived event stream. Headers are bounded by
		// ReadHeaderTimeout and every body by MaxBytesReader.
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 64 << 10,
		ErrorLog:       s.opts.Logger,
	}
}

// ServeHTTP applies the checks every request passes, in order: headers, Host, then for the API
// the session, and for anything that can change state the Origin, the CSRF token and the body type.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	rec := &recorder{ResponseWriter: w, status: http.StatusOK}
	defer func() {
		// Never the query (the start token travels there), never a header, never a body.
		s.opts.Logger.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(started).Round(time.Millisecond))
	}()
	security.Headers(rec.Header())
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut:
	default:
		// No route takes this method. Close the connection after answering: a client may have sent
		// a body without framing it (Node does this for DELETE), and those bytes must not be read
		// as the next request on the same connection.
		rec.Header().Set("Connection", "close")
	}
	isAPI := r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.EscapedPath(), "/api/")
	if !s.opts.Guard.HostAllowed(r.Host) {
		if isAPI {
			writeEnvelope(rec, http.StatusForbidden, engine.Fail(engine.KindUnauthorized, "This address is not allowed. Open Product Studio at 127.0.0.1 or localhost."))
		} else {
			http.Error(rec, "This address is not allowed. Open Product Studio at 127.0.0.1 or localhost.", http.StatusForbidden)
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
	if !s.opts.Guard.Authenticated(r) {
		writeEnvelope(rec, http.StatusUnauthorized, engine.Fail(engine.KindUnauthorized, "Open Product Studio from the link it printed when it started."))
		return
	}
	if security.IsStateChanging(r.Method) {
		if err := s.opts.Guard.CheckStateChange(r); err != nil {
			writeEnvelope(rec, http.StatusForbidden, engine.Fail(engine.KindUnauthorized, err.Error()))
			return
		}
		if media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || media != "application/json" {
			writeEnvelope(rec, http.StatusUnsupportedMediaType, engine.Fail(engine.KindInvalid, "The request body must be JSON (Content-Type: application/json)."))
			return
		}
	}
	s.routeAPI(rec, r)
}

// apiMethods are the methods any API route answers to.
var apiMethods = []string{http.MethodGet, http.MethodPost, http.MethodPut}

// routeAPI routes an API request without the router's own replies: an unclean path is refused
// (never redirected), and a method a route does not take is a 405, both as the envelope.
func (s *Server) routeAPI(w http.ResponseWriter, r *http.Request) {
	escaped := r.URL.EscapedPath()
	if r.URL.Path != path.Clean(r.URL.Path) || escaped != path.Clean(escaped) || strings.Contains(strings.ToLower(escaped), "%2f") ||
		strings.Contains(escaped, "//") {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "The address is not a plain API route."))
		return
	}
	if _, pattern := s.api.Handler(r); pattern == "/api/" || pattern == "" {
		var allowed []string
		for _, method := range apiMethods {
			if method == r.Method {
				continue
			}
			probe := r.Clone(r.Context())
			probe.Method = method
			if _, p := s.api.Handler(probe); p != "/api/" && p != "" {
				allowed = append(allowed, method)
			}
		}
		if len(allowed) > 0 {
			w.Header().Set("Allow", strings.Join(allowed, ", "))
			writeEnvelope(w, http.StatusMethodNotAllowed, engine.Fail(engine.KindInvalid, "This route does not take "+r.Method+"."))
			return
		}
		writeEnvelope(w, http.StatusNotFound, engine.Fail(engine.KindInvalid, "There is no such route."))
		return
	}
	s.api.ServeHTTP(w, r)
}

// exchange trades the one-time start token for the session cookie, then drops the token from the
// address bar.
func (s *Server) exchange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed.", http.StatusMethodNotAllowed)
		return
	}
	if cookie, ok := s.opts.Guard.Exchange(r.URL.Query().Get("t")); ok {
		http.SetCookie(w, cookie)
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	if s.opts.Guard.Authenticated(r) {
		http.Redirect(w, r, "/", http.StatusSeeOther) // this browser already has the session
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, "This link has already been used or is not valid. Restart Product Studio to get a new link.", http.StatusUnauthorized)
}

// ---- routes ----

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	root := s.opts.Engine.Project()
	project := map[string]any{"folder": filepath.Base(root), "path": root, "name": nil, "project_id": nil}
	var problem any
	status := s.opts.Engine.Transaction(r.Context(), func(tx *engine.Tx) engine.Envelope {
		return tx.Call(r.Context(), "status", engine.StatusArgs())
	})
	if status.OK {
		var view struct {
			Project *struct {
				ProjectID string `json:"project_id"`
				Name      string `json:"name"`
			} `json:"project"`
		}
		if json.Unmarshal(status.Data, &view) == nil && view.Project != nil {
			project["name"], project["project_id"] = view.Project.Name, view.Project.ProjectID
		}
	} else {
		problem = status.Error
	}
	available, reason := s.opts.Bridge.Available()
	capabilities := map[string]any{"interview": available, "interview_reason": nil, "continue_command": s.opts.Bridge.ContinueCommand()}
	if !available {
		capabilities["interview_reason"] = reason
	}
	writeEnvelope(w, http.StatusOK, engine.OKValue(map[string]any{
		"project":        project,
		"csrf_token":     s.opts.Guard.CSRF(),
		"capabilities":   capabilities,
		"versions":       map[string]any{"host": Version, "api": APIVersion, "engine_install": s.opts.EngineInstall},
		"engine_problem": problem,
	}))
}

func (s *Server) operation(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("op")
	if _, ok := engine.Lookup(name); !ok {
		writeEnvelope(w, http.StatusNotFound, engine.Fail(engine.KindInvalid, "There is no operation called "+strconv.Quote(truncate(name, 64))+"."))
		return
	}
	body, ok := readBody(w, r, engine.MaxBodyBytes)
	if !ok {
		return
	}
	env := s.opts.Engine.Do(r.Context(), name, body)
	s.logFailure(name, env)
	writeEnvelope(w, statusFor(env), env)
}

// ---- helpers ----

// readBody reads at most limit bytes; a larger body is refused whole.
func readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeEnvelope(w, http.StatusRequestEntityTooLarge, engine.Fail(engine.KindInvalid, "The request body is too large."))
		} else {
			writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "The request body could not be read."))
		}
		return nil, false
	}
	return body, true
}

// statusFor gives each error kind one HTTP status. Clients should read the envelope, not this.
func statusFor(env engine.Envelope) int {
	if env.OK {
		return http.StatusOK
	}
	switch env.Error.Kind {
	case engine.KindRefused:
		return http.StatusUnprocessableEntity
	case engine.KindInvalid:
		return http.StatusBadRequest
	case engine.KindUnauthorized:
		return http.StatusForbidden
	case engine.KindConflict:
		return http.StatusConflict
	case engine.KindUnavailable:
		return http.StatusServiceUnavailable
	}
	return http.StatusInternalServerError
}

// logFailure records that an internal failure happened and in which operation; the message is
// one the host wrote, never engine output or file contents.
func (s *Server) logFailure(op string, env engine.Envelope) {
	if !env.OK && env.Error.Kind == engine.KindInternal {
		s.opts.Logger.Printf("engine %s: %s", op, env.Error.Message)
	}
}

func writeEnvelope(w http.ResponseWriter, status int, env engine.Envelope) {
	data, err := json.Marshal(env)
	if err != nil {
		status = http.StatusInternalServerError
		data = []byte(`{"ok":false,"error":{"kind":"internal","message":"The host could not encode its reply."}}`)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(append(data, '\n'))
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// recorder notes the status for the log line and keeps Flush working for server-sent events.
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
