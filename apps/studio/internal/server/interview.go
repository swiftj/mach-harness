package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"mach/studio/internal/engine"
	"mach/studio/internal/interview"
)

var interviewID = regexp.MustCompile(`^[a-f0-9]{32}$`)

// Bounds on what the product manager types. The text is only ever the user message of a turn.
const (
	maxReplyRunes = 8000
	maxIdeaRunes  = 4000
)

func (s *Server) interviewError(w http.ResponseWriter, err error) {
	var conflict *interview.ConflictError
	switch {
	case errors.Is(err, interview.ErrUnavailable):
		reason := interview.UnavailableReason(err)
		if reason == "" {
			_, reason = s.opts.Bridge.Available()
		}
		writeEnvelope(w, http.StatusServiceUnavailable, engine.Fail(engine.KindUnavailable, reason))
	case errors.As(err, &conflict):
		writeEnvelope(w, http.StatusConflict, engine.Fail(engine.KindConflict, conflict.Message))
	case errors.Is(err, interview.ErrNotFound):
		writeEnvelope(w, http.StatusNotFound, engine.Fail(engine.KindInvalid, "There is no such interview."))
	default:
		s.opts.Logger.Printf("interview: %s", errorClass(err))
		writeEnvelope(w, http.StatusInternalServerError, engine.Fail(engine.KindInternal, "The interview could not continue."))
	}
}

// errorClass names an error without echoing its text (which could hold a path or a message).
func errorClass(err error) string { return fmt.Sprintf("%T", err) }

func (s *Server) interviewParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if !interviewID.MatchString(id) {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "That is not an interview ID."))
		return "", false
	}
	return id, true
}

// checkPMText accepts what a person typed: UTF-8, no control characters but newline and tab,
// bounded, and (when required) not blank.
func checkPMText(field, text string, max int, required bool) string {
	if !utf8.ValidString(text) {
		return field + " is not valid UTF-8 text."
	}
	for _, r := range text {
		if r == 0 || (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f {
			return field + " contains a control character."
		}
	}
	if utf8.RuneCountInString(text) > max {
		return field + " is longer than " + strconv.Itoa(max) + " characters."
	}
	if required && strings.TrimSpace(text) == "" {
		return field + " is required."
	}
	return ""
}

// POST /api/interview {slice_id, idea?}
func (s *Server) interviewStart(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBody(w, r, 32<<10)
	if !ok {
		return
	}
	var body struct {
		SliceID string `json:"slice_id"`
		Idea    string `json:"idea"`
	}
	if err := engine.Decode(raw, &body); err != nil {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, err.Error()))
		return
	}
	if len(body.SliceID) > 32 || !engine.SliceIDPattern.MatchString(body.SliceID) {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "slice_id must be an ID such as SLICE-001."))
		return
	}
	if msg := checkPMText("idea", body.Idea, maxIdeaRunes, false); msg != "" {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, msg))
		return
	}
	if available, reason := s.opts.Bridge.Available(); !available {
		writeEnvelope(w, http.StatusServiceUnavailable, engine.Fail(engine.KindUnavailable, reason))
		return
	}
	// The engine says whether the slice exists and may still be edited; an approved slice is refused.
	var epicID string
	check := s.opts.Engine.Transaction(r.Context(), func(tx *engine.Tx) engine.Envelope {
		view, env := show(r.Context(), tx, body.SliceID)
		if view == nil {
			return env
		}
		if !view.Editable {
			message := body.SliceID + " cannot be changed."
			if view.EditRefusal != nil {
				message = *view.EditRefusal
			}
			return engine.Fail(engine.KindRefused, message)
		}
		epicID = view.Slice.EpicID
		return engine.OKValue(nil)
	})
	if !check.OK {
		writeEnvelope(w, statusFor(check), check)
		return
	}
	started, err := s.opts.Bridge.Start(r.Context(), interview.StartRequest{SliceID: body.SliceID, EpicID: epicID, Idea: strings.TrimSpace(body.Idea)})
	if err != nil {
		s.interviewError(w, err)
		return
	}
	writeEnvelope(w, http.StatusOK, engine.OKValue(started))
}

// GET /api/interview?slice_id=SLICE-001 → {interview: Current|null}
func (s *Server) interviewCurrent(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("slice_id")
	if len(id) > 32 || !engine.SliceIDPattern.MatchString(id) {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "slice_id must be an ID such as SLICE-001."))
		return
	}
	current, err := s.opts.Bridge.Current(id)
	if err != nil && !errors.Is(err, interview.ErrUnavailable) {
		s.interviewError(w, err)
		return
	}
	writeEnvelope(w, http.StatusOK, engine.OKValue(map[string]any{"interview": current}))
}

// GET /api/interview/<id>/events: server-sent events, replayed after Last-Event-ID.
func (s *Server) interviewEvents(w http.ResponseWriter, r *http.Request) {
	id, ok := s.interviewParam(w, r)
	if !ok {
		return
	}
	var after int64
	if last := r.Header.Get("Last-Event-ID"); last != "" {
		n, err := strconv.ParseInt(last, 10, 64)
		if err != nil || n < 0 {
			writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "Last-Event-ID must be a number."))
			return
		}
		after = n
	}
	replay, events, cancel, err := s.opts.Bridge.Subscribe(id, after)
	if err != nil {
		s.interviewError(w, err)
		return
	}
	defer cancel()
	controller := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	write := func(ev interview.Event) bool {
		data, err := json.Marshal(ev.Data)
		if err != nil {
			return true
		}
		if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", ev.Seq, ev.Name, data); err != nil {
			return false
		}
		// The last event of an interview is state "ended" (after the ended event itself).
		if m, ok := ev.Data.(map[string]any); ok && ev.Name == "state" && m["state"] == "ended" {
			return false
		}
		return true
	}
	for _, ev := range replay {
		if !write(ev) {
			controller.Flush()
			return
		}
	}
	controller.Flush()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			controller.Flush()
		case ev, open := <-events:
			if !open {
				return
			}
			more := write(ev)
			controller.Flush()
			if !more {
				return
			}
		}
	}
}

// POST /api/interview/<id>/reply {text}
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
	if msg := checkPMText("text", body.Text, maxReplyRunes, true); msg != "" {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, msg))
		return
	}
	if err := s.opts.Bridge.Reply(r.Context(), id, body.Text); err != nil {
		s.interviewError(w, err)
		return
	}
	writeEnvelope(w, http.StatusOK, engine.OKValue(map[string]bool{"sent": true}))
}

func (s *Server) interviewControl(stop bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := s.interviewParam(w, r)
		if !ok {
			return
		}
		raw, ok := readBody(w, r, 1024)
		if !ok {
			return
		}
		var body struct{}
		if err := engine.Decode(raw, &body); err != nil {
			writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, err.Error()))
			return
		}
		var err error
		if stop {
			err = s.opts.Bridge.Stop(r.Context(), id)
		} else {
			err = s.opts.Bridge.Interrupt(r.Context(), id)
		}
		if err != nil {
			s.interviewError(w, err)
			return
		}
		key := "interrupted"
		if stop {
			key = "stopped"
		}
		writeEnvelope(w, http.StatusOK, engine.OKValue(map[string]bool{key: true}))
	}
}
