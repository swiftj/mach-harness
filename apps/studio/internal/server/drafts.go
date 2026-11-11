package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"mach/studio/internal/engine"
	"mach/studio/internal/security"
)

// MaxDraftBytes bounds one spec or why. Real specs are a few tens of kilobytes.
const MaxDraftBytes = 1 << 20

var specShortName = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// showView is the part of `slice show` the draft routes need. Whether a slice may be edited, and
// the words for why not, come from the engine.
type showView struct {
	Slice struct {
		EpicID string `json:"epic_id"`
	} `json:"slice"`
	Editable    bool    `json:"editable"`
	EditRefusal *string `json:"edit_refusal"`
	Paths       struct {
		Spec            *string `json:"spec"`
		SpecNamePattern string  `json:"spec_name_pattern"`
		Intent          string  `json:"intent"`
	} `json:"paths"`
	Spec *struct {
		Markdown string `json:"markdown"`
	} `json:"spec"`
	Why struct {
		Markdown *string `json:"markdown"`
	} `json:"why"`
}

func show(ctx context.Context, tx *engine.Tx, sliceID string) (*showView, engine.Envelope) {
	env := tx.Call(ctx, "slice.show", engine.ShowSlice(sliceID))
	if !env.OK {
		return nil, env
	}
	var view showView
	if err := json.Unmarshal(env.Data, &view); err != nil {
		return nil, engine.Fail(engine.KindInternal, "The product engine's view of the slice could not be read.")
	}
	return &view, env
}

func sliceParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("slice")
	if len(id) > 32 || !engine.SliceIDPattern.MatchString(id) {
		writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, "The slice must be an ID such as SLICE-001."))
		return "", false
	}
	return id, true
}

// GET /api/drafts/{spec|intent}/<slice>: the draft's markdown, as the engine reads it.
func (s *Server) getDraft(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := sliceParam(w, r)
		if !ok {
			return
		}
		env := s.opts.Engine.Transaction(r.Context(), func(tx *engine.Tx) engine.Envelope {
			view, env := show(r.Context(), tx, id)
			if view == nil {
				return env
			}
			out := map[string]any{"slice_id": id, "kind": kind, "editable": view.Editable, "edit_refusal": view.EditRefusal}
			if kind == "spec" {
				out["path"], out["spec_name_pattern"] = view.Paths.Spec, view.Paths.SpecNamePattern
				out["exists"], out["markdown"] = view.Spec != nil, nil
				if view.Spec != nil {
					out["markdown"] = view.Spec.Markdown
				}
			} else {
				out["path"], out["exists"], out["markdown"] = view.Paths.Intent, view.Why.Markdown != nil, view.Why.Markdown
			}
			return engine.OKValue(out)
		})
		s.logFailure("draft read", env)
		writeEnvelope(w, statusFor(env), env)
	}
}

type putDraftBody struct {
	Markdown *string `json:"markdown"`
	// Name is the spec's short name (the "invite-teammate" of SLICE-001-invite-teammate.md). Only
	// for a spec, and only needed before the slice has one; a spec keeps its file name.
	Name *string `json:"name"`
}

// PUT /api/drafts/{spec|intent}/<slice>: replace the draft, then run slice.check and return it.
// The lock is held across show, write and check, so no other request can come between them.
func (s *Server) putDraft(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := sliceParam(w, r)
		if !ok {
			return
		}
		raw, ok := readBody(w, r, MaxDraftBytes+64<<10)
		if !ok {
			return
		}
		var body putDraftBody
		if err := engine.Decode(raw, &body); err != nil {
			writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, err.Error()))
			return
		}
		if msg := checkDraftBody(kind, &body); msg != "" {
			writeEnvelope(w, http.StatusBadRequest, engine.Fail(engine.KindInvalid, msg))
			return
		}
		env := s.opts.Engine.Transaction(r.Context(), func(tx *engine.Tx) engine.Envelope {
			view, env := show(r.Context(), tx, id)
			if view == nil {
				return env
			}
			if s.opts.Bridge.Busy(id) {
				return engine.Fail(engine.KindConflict, "The interviewer is writing this slice's draft right now. Wait for its reply, or interrupt it.")
			}
			if !view.Editable {
				message := id + " cannot be changed."
				if view.EditRefusal != nil {
					message = *view.EditRefusal
				}
				return engine.Fail(engine.KindRefused, message)
			}
			rel, failure := draftPath(kind, id, view, body.Name)
			if failure != nil {
				return *failure
			}
			if _, err := security.WriteDraft(s.opts.Engine.Project(), rel, []byte(*body.Markdown)); err != nil {
				if errors.Is(err, security.ErrUnsafePath) {
					return engine.Fail(engine.KindInvalid, "The draft workspace has a symbolic link or an unexpected entry where this draft goes, so nothing was written.")
				}
				s.opts.Logger.Printf("draft write failed for %s %s", kind, id)
				return engine.Fail(engine.KindInternal, "The draft could not be written.")
			}
			check := tx.Call(r.Context(), "slice.check", engine.CheckSlice(id))
			if !check.OK {
				return check
			}
			return engine.OKValue(map[string]any{"slice_id": id, "kind": kind, "path": rel, "check": check.Data})
		})
		s.logFailure("draft write", env)
		writeEnvelope(w, statusFor(env), env)
	}
}

func checkDraftBody(kind string, body *putDraftBody) string {
	if body.Markdown == nil {
		return "markdown is required."
	}
	text := *body.Markdown
	if len(text) > MaxDraftBytes {
		return "The draft is larger than 1 MiB."
	}
	if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return "The draft must be UTF-8 text without NUL characters."
	}
	if body.Name != nil {
		if kind != "spec" {
			return "name applies to a spec only."
		}
		if len(*body.Name) > 80 || !specShortName.MatchString(*body.Name) {
			return "name must be lowercase words joined by hyphens, such as invite-teammate."
		}
	}
	return ""
}

// draftPath picks the one file this draft may be written to, from what the engine reported.
func draftPath(kind, id string, view *showView, name *string) (string, *engine.Envelope) {
	fail := func(kind, message string) (string, *engine.Envelope) {
		env := engine.Fail(kind, message)
		return "", &env
	}
	if kind == "intent" {
		want := "product/intents/" + id + ".md"
		if view.Paths.Intent != want {
			return fail(engine.KindInternal, "The product engine reported an unexpected place for the slice's why.")
		}
		return want, nil
	}
	var file string
	switch {
	case view.Paths.Spec != nil:
		file = strings.TrimPrefix(*view.Paths.Spec, "specs/slices/")
		if file == *view.Paths.Spec || strings.Contains(file, "/") {
			return fail(engine.KindInternal, "The product engine reported an unexpected place for the spec.")
		}
		if name != nil && file != id+"-"+*name+".md" {
			return fail(engine.KindInvalid, "This slice's spec is already called "+file+"; a spec keeps its file name.")
		}
	case name == nil:
		return fail(engine.KindInvalid, "This slice has no spec yet: give its short name, such as \"invite-teammate\", in name.")
	default:
		file = id + "-" + *name + ".md"
	}
	match := engine.SpecNamePattern.FindStringSubmatch(file)
	if match == nil || match[1] != id {
		return fail(engine.KindInvalid, "That is not a usable spec file name for "+id+".")
	}
	return "specs/slices/" + file, nil
}
