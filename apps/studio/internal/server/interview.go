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
		env := engine.Fail(engine.KindConflict, conflict.Message)
		if conflict.InterviewID != "" {
			// Held by this host: the hint names the live interview, so the app can attach to it.
			env.Error.Hint, _ = json.Marshal(map[string]string{"kind": "open_interview", "target": conflict.InterviewID})
		} else if conflict.TakeOver {
			// Held by another live process on this computer: the message is the warning, and the app
			// offers to continue here (the same start with take_over: true).
			env.Error.Hint, _ = json.Marshal(map[string]any{"kind": "take_over", "target": nil})
		}
		writeEnvelope(w, http.StatusConflict, env)
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

// POST /api/interview {slice_id, idea?} or, M16, {idea_id}: the Shape conversation for one idea.
func (s *Server) interviewStart(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBody(w, r, 32<<10)
	if !ok {
		return
	}
	var body struct {
		SliceID string  `json:"slice_id"`
		Idea    string  `json:"idea"`
		IdeaID  *string `json:"idea_id"`
		Needs   *bool   `json:"needs"`
		PrdID   *string `json:"prd_id"`
		// TakeOver: continue here although another window on this computer holds the lock (the
		// conflict before it carried the warning and hint {kind: "take_over"}).
		TakeOver bool `json:"take_over"`
	}
	if err := engine.Decode(raw, &body); err != nil {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, err.Error()))
		return
	}
	if body.PrdID != nil {
		if body.Needs != nil || body.IdeaID != nil || body.SliceID != "" || body.Idea != "" {
			writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "Give prd_id alone, or slice_id, or idea_id, or needs: true."))
			return
		}
		s.prdConversationStart(w, r, *body.PrdID, body.TakeOver)
		return
	}
	if body.Needs != nil {
		if !*body.Needs || body.IdeaID != nil || body.SliceID != "" || body.Idea != "" {
			writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "Give needs: true alone, or slice_id, or idea_id."))
			return
		}
		s.needsConversationStart(w, r, body.TakeOver)
		return
	}
	if body.IdeaID != nil {
		if body.SliceID != "" || body.Idea != "" {
			writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "Give slice_id or idea_id, not both."))
			return
		}
		s.ideaConversationStart(w, r, *body.IdeaID, body.TakeOver)
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
	var epicID, question string
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
		if view.Github.Question != nil {
			question = *view.Github.Question
		}
		return engine.OKValue(nil)
	})
	if !check.OK {
		writeEnvelope(w, statusFor(check), check)
		return
	}
	started, err := s.opts.Bridge.Start(r.Context(), interview.StartRequest{SliceID: body.SliceID, EpicID: epicID, Idea: strings.TrimSpace(body.Idea),
		BuildersQuestion: question, TakeOver: body.TakeOver})
	if err != nil {
		s.interviewError(w, err)
		return
	}
	writeEnvelope(w, http.StatusOK, engine.OKValue(started))
}

// ideaConversationStart: the engine says whether the idea exists and is not yet shaped into work
// (its brief is then kept as it was when its slices were made); then the bridge starts the Shape
// conversation, whose rules let it write only this idea's brief and case (interview.Paths).
func (s *Server) ideaConversationStart(w http.ResponseWriter, r *http.Request, ideaID string, takeOver bool) {
	if len(ideaID) > 32 || !engine.IdeaIDPattern.MatchString(ideaID) {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "idea_id must be an ID such as IDEA-001."))
		return
	}
	if available, reason := s.opts.Bridge.Available(); !available {
		writeEnvelope(w, http.StatusServiceUnavailable, engine.Fail(engine.KindUnavailable, reason))
		return
	}
	check := s.opts.Engine.Transaction(r.Context(), func(tx *engine.Tx) engine.Envelope {
		env := tx.Call(r.Context(), "idea.show", engine.ShowIdea(ideaID))
		if !env.OK {
			return env
		}
		var view struct {
			Idea struct {
				Stage string `json:"stage"`
			} `json:"idea"`
		}
		if json.Unmarshal(env.Data, &view) != nil || view.Idea.Stage == "" {
			return engine.Fail(engine.KindInternal, "The product engine's answer about the idea could not be read.")
		}
		if view.Idea.Stage == "shaped" {
			return engine.Fail(engine.KindRefused, ideaID+" is shaped into work, so its brief stays as it was when its slices were made.")
		}
		return engine.OKValue(nil)
	})
	if !check.OK {
		writeEnvelope(w, statusFor(check), check)
		return
	}
	started, err := s.opts.Bridge.Start(r.Context(), interview.StartRequest{IdeaID: ideaID, TakeOver: takeOver})
	if err != nil {
		s.interviewError(w, err)
		return
	}
	writeEnvelope(w, http.StatusOK, engine.OKValue(started))
}

// needsConversationStart: the engine says the technical needs can be read (a project exists and its
// needs file is in the form Product Studio writes); then the bridge starts the needs conversation,
// whose rules let it record needs and a design's map only (interview.Paths).
func (s *Server) needsConversationStart(w http.ResponseWriter, r *http.Request, takeOver bool) {
	if available, reason := s.opts.Bridge.Available(); !available {
		writeEnvelope(w, http.StatusServiceUnavailable, engine.Fail(engine.KindUnavailable, reason))
		return
	}
	check := s.opts.Engine.Transaction(r.Context(), func(tx *engine.Tx) engine.Envelope {
		env := tx.Call(r.Context(), "status", engine.StatusArgs())
		if !env.OK {
			return env
		}
		var view struct {
			Project *struct {
				ProjectID string `json:"project_id"`
			} `json:"project"`
		}
		if json.Unmarshal(env.Data, &view) != nil || view.Project == nil || view.Project.ProjectID == "" {
			return engine.Fail(engine.KindRefused, "Set up the project first: technical needs belong to a project.")
		}
		return tx.Call(r.Context(), "need.list", engine.NeedListArgs())
	})
	if !check.OK {
		writeEnvelope(w, statusFor(check), check)
		return
	}
	started, err := s.opts.Bridge.Start(r.Context(), interview.StartRequest{Needs: true, TakeOver: takeOver})
	if err != nil {
		s.interviewError(w, err)
		return
	}
	writeEnvelope(w, http.StatusOK, engine.OKValue(started))
}

// prdConversationStart (M19): the engine says the PRD exists, its copy in the workspace still matches
// what was imported, and no drafts have been made from it yet (its map is then kept as it was); then
// the bridge starts the PRD conversation, whose rules let it record that PRD's map only
// (interview.Paths). It needs no project: a map is recorded before the project is named.
func (s *Server) prdConversationStart(w http.ResponseWriter, r *http.Request, prdID string, takeOver bool) {
	if len(prdID) > 32 || !engine.PRDIDPattern.MatchString(prdID) {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "prd_id must be an ID such as PRD-01."))
		return
	}
	if available, reason := s.opts.Bridge.Available(); !available {
		writeEnvelope(w, http.StatusServiceUnavailable, engine.Fail(engine.KindUnavailable, reason))
		return
	}
	check := s.opts.Engine.Transaction(r.Context(), func(tx *engine.Tx) engine.Envelope {
		env := tx.Call(r.Context(), "prd.status", engine.PRDStatus(prdID))
		if !env.OK {
			return env
		}
		var view struct {
			Prd *struct {
				DocumentMatches *bool    `json:"document_matches"`
				Applied         []string `json:"applied"`
			} `json:"prd"`
		}
		if json.Unmarshal(env.Data, &view) != nil || view.Prd == nil || view.Prd.DocumentMatches == nil {
			return engine.Fail(engine.KindInternal, "The product engine's answer about the PRD could not be read.")
		}
		if !*view.Prd.DocumentMatches {
			return engine.Fail(engine.KindRefused, "The copy of "+prdID+" in your workspace no longer matches the document that was imported. Import the document again.")
		}
		if len(view.Prd.Applied) > 0 {
			return engine.Fail(engine.KindRefused, "The drafts were made from "+prdID+", so its map stays as it was when they were made.")
		}
		return engine.OKValue(nil)
	})
	if !check.OK {
		writeEnvelope(w, statusFor(check), check)
		return
	}
	started, err := s.opts.Bridge.Start(r.Context(), interview.StartRequest{PrdID: prdID, TakeOver: takeOver})
	if err != nil {
		s.interviewError(w, err)
		return
	}
	writeEnvelope(w, http.StatusOK, engine.OKValue(started))
}

// subjectParam reads ?slice_id=, M16 ?idea_id=, M17 ?needs=true or M19 ?prd_id=: exactly one, in its engine pattern.
func subjectParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	query := r.URL.Query()
	slice, idea := query.Get("slice_id"), query.Get("idea_id")
	given := 0
	for _, name := range []string{"slice_id", "idea_id", "needs", "prd_id"} {
		if query.Has(name) {
			given++
		}
	}
	switch {
	case given > 1:
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "Give one of slice_id, idea_id, needs or prd_id."))
		return "", false
	case query.Has("prd_id"):
		prd := query.Get("prd_id")
		if len(prd) > 32 || !engine.PRDIDPattern.MatchString(prd) {
			writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "prd_id must be an ID such as PRD-01."))
			return "", false
		}
		return prd, true
	case query.Has("needs"):
		if query.Get("needs") != "true" {
			writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "needs must be true."))
			return "", false
		}
		return interview.NeedsSubject, true
	case query.Has("idea_id"):
		if len(idea) > 32 || !engine.IdeaIDPattern.MatchString(idea) {
			writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "idea_id must be an ID such as IDEA-001."))
			return "", false
		}
		return idea, true
	}
	if len(slice) > 32 || !engine.SliceIDPattern.MatchString(slice) {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "slice_id must be an ID such as SLICE-001."))
		return "", false
	}
	return slice, true
}

// GET /api/interview?slice_id=SLICE-001 (or ?idea_id=IDEA-001) → {interview: Current|null}
func (s *Server) interviewCurrent(w http.ResponseWriter, r *http.Request) {
	id, ok := subjectParam(w, r)
	if !ok {
		return
	}
	current, err := s.opts.Bridge.Current(id)
	if err != nil && !errors.Is(err, interview.ErrUnavailable) {
		s.interviewError(w, err)
		return
	}
	writeEnvelope(w, http.StatusOK, engine.OKValue(map[string]any{"interview": current}))
}

// GET /api/interview/history?slice_id=SLICE-001 (or ?idea_id=IDEA-001) → {slice_id|idea_id, events, truncated}
func (s *Server) interviewHistory(w http.ResponseWriter, r *http.Request) {
	id, ok := subjectParam(w, r)
	if !ok {
		return
	}
	events, truncated, err := s.opts.Bridge.History(id)
	if err != nil {
		s.interviewError(w, err)
		return
	}
	var answer map[string]any
	switch {
	case interview.IsNeeds(id):
		answer = map[string]any{"needs": true}
	case interview.IsIdea(id):
		answer = map[string]any{"idea_id": id}
	case interview.IsPrd(id):
		answer = map[string]any{"prd_id": id}
	default:
		answer = map[string]any{"slice_id": id}
	}
	answer["events"], answer["truncated"] = events, truncated
	writeEnvelope(w, http.StatusOK, engine.OKValue(answer))
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
