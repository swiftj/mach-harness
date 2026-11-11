package server

import (
	"errors"
	"net/http"
	"regexp"

	"mach/studio/internal/engine"
	"mach/studio/internal/interview"
)

var interviewID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// The interview routes check shapes, then hand over to the bridge. Until the bridge is plugged in
// every one answers `unavailable` with the reason GET /api/session also reports.

func (s *Server) interviewError(w http.ResponseWriter, err error) {
	available, reason := s.opts.Bridge.Available()
	switch {
	case errors.Is(err, interview.ErrUnavailable) || !available:
		writeEnvelope(w, http.StatusServiceUnavailable, engine.Fail(engine.KindUnavailable, reason))
	case errors.Is(err, interview.ErrConflict):
		writeEnvelope(w, http.StatusConflict, engine.Fail(engine.KindConflict, "That slice already has an interview running."))
	case errors.Is(err, interview.ErrNotFound):
		writeEnvelope(w, http.StatusNotFound, engine.Fail(engine.KindInvalid, "There is no such interview."))
	default:
		s.opts.Logger.Printf("interview failed")
		writeEnvelope(w, http.StatusInternalServerError, engine.Fail(engine.KindInternal, "The interview could not continue."))
	}
}

func (s *Server) interviewParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if !interviewID.MatchString(id) {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "That is not an interview ID."))
		return "", false
	}
	return id, true
}

func (s *Server) interviewStart(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBody(w, r, 4096)
	if !ok {
		return
	}
	var body struct {
		SliceID string `json:"slice_id"`
	}
	if err := engine.Decode(raw, &body); err != nil {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, err.Error()))
		return
	}
	if len(body.SliceID) > 32 || !engine.SliceIDPattern.MatchString(body.SliceID) {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "slice_id must be an ID such as SLICE-001."))
		return
	}
	if available, _ := s.opts.Bridge.Available(); !available {
		s.interviewError(w, interview.ErrUnavailable)
		return
	}
	id, err := s.opts.Bridge.Start(r.Context(), body.SliceID)
	if err != nil {
		s.interviewError(w, err)
		return
	}
	writeEnvelope(w, http.StatusOK, engine.OKValue(map[string]string{"interview_id": id}))
}

func (s *Server) interviewEvents(w http.ResponseWriter, r *http.Request) {
	id, ok := s.interviewParam(w, r)
	if !ok {
		return
	}
	if available, _ := s.opts.Bridge.Available(); !available {
		s.interviewError(w, interview.ErrUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	if err := s.opts.Bridge.Events(r.Context(), id, w); err != nil {
		s.interviewError(w, err)
	}
}

func (s *Server) interviewReply(w http.ResponseWriter, r *http.Request) {
	id, ok := s.interviewParam(w, r)
	if !ok {
		return
	}
	raw, ok := readBody(w, r, 64<<10)
	if !ok {
		return
	}
	var body struct {
		Text string `json:"text"`
	}
	if err := engine.Decode(raw, &body); err != nil {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, err.Error()))
		return
	}
	if body.Text == "" {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "text is required."))
		return
	}
	if available, _ := s.opts.Bridge.Available(); !available {
		s.interviewError(w, interview.ErrUnavailable)
		return
	}
	if err := s.opts.Bridge.Reply(r.Context(), id, body.Text); err != nil {
		s.interviewError(w, err)
		return
	}
	writeEnvelope(w, http.StatusOK, engine.OKValue(map[string]bool{"sent": true}))
}

func (s *Server) interviewStop(w http.ResponseWriter, r *http.Request) {
	id, ok := s.interviewParam(w, r)
	if !ok {
		return
	}
	if available, _ := s.opts.Bridge.Available(); !available {
		s.interviewError(w, interview.ErrUnavailable)
		return
	}
	if err := s.opts.Bridge.Stop(r.Context(), id); err != nil {
		s.interviewError(w, err)
		return
	}
	writeEnvelope(w, http.StatusOK, engine.OKValue(map[string]bool{"stopped": true}))
}
