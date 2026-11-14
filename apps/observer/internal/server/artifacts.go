package server

import (
	"bytes"
	"errors"
	"mime"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"mach/observer/internal/artifact"
	"mach/observer/internal/project"
	"mach/observer/internal/redact"
)

// ArtifactCSP is the policy on artifact content: nothing may load or run, and the response is a
// sandboxed document if a browser ever navigates to it.
const ArtifactCSP = "default-src 'none'; img-src 'self'; media-src 'self'; sandbox"

var artifactIDRe = regexp.MustCompile(`^a[0-9a-f]{24}$`)

// linkVisits fills each evidence entry's visit from the projection: the verify visit of its round.
func (s *Server) linkVisits(entries []artifact.Entry) {
	s.opts.Projector.View(func(st *project.State) {
		// Recorded links first; then a verification folder's records (results.json, summary.json,
		// findings.md) take the visit an evidence file of the same folder was recorded in.
		folder := map[string]string{} // ticket + folder -> recorded visit
		for i := range entries {
			e := &entries[i]
			id, basis, rule := project.LinkArtifact(st.Cells[e.TicketID], e.Path, e.SHA256, e.Round, e.ModifiedMS)
			if basis == "recorded" {
				e.VisitID, e.Visit = id, &artifact.VisitLink{VisitID: id, Basis: basis, Rule: rule}
				folder[e.TicketID+"\x00"+path.Dir(e.Path)] = id
			}
		}
		for i := range entries {
			e := &entries[i]
			if e.Visit != nil {
				continue
			}
			if id, ok := folder[e.TicketID+"\x00"+path.Dir(e.Path)]; ok {
				e.VisitID, e.Visit = id, &artifact.VisitLink{VisitID: id, Basis: "reconstructed", Rule: "folder"}
				continue
			}
			if id, basis, rule := project.LinkArtifact(st.Cells[e.TicketID], e.Path, "", e.Round, e.ModifiedMS); id != "" {
				e.VisitID, e.Visit = id, &artifact.VisitLink{VisitID: id, Basis: basis, Rule: rule}
			}
		}
	})
}

// artifacts: GET /api/v1/artifacts?ticket&kind&nature&limit&offset (metadata only).
func (s *Server) artifacts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ticket, bad := optIdent(q, "ticket")
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	kind, nature := q.Get("kind"), q.Get("nature")
	if len(kind) > 40 || len(nature) > 20 {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "A filter is too long."))
		return
	}
	limit, bad := pageLimit(r, DefaultPage)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	off, bad := offset(r)
	if bad != nil {
		writeJSON(w, http.StatusBadRequest, *bad)
		return
	}
	all, set := s.opts.Catalog.Snapshot()
	var items []artifact.Entry
	for _, e := range all {
		if (ticket == "" || e.TicketID == ticket) && (kind == "" || e.Kind == kind) && (nature == "" || e.Nature == nature) {
			items = append(items, e)
		}
	}
	if items == nil {
		items = []artifact.Entry{}
	}
	s.linkVisits(items)
	v := pageOf(items, off, limit, "")
	delete(v, "cursor")
	v["settings"] = set
	writeJSON(w, http.StatusOK, ok(v))
}

func (s *Server) artifact(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !artifactIDRe.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "An artifact is named by its catalog id, never by a path."))
		return
	}
	e, _, found := s.opts.Catalog.Lookup(id)
	if !found {
		writeJSON(w, http.StatusNotFound, fail(KindNotFound, "No artifact has that id in this project's catalog (it may have changed; reload the catalog)."))
		return
	}
	list := []artifact.Entry{e}
	s.linkVisits(list)
	writeJSON(w, http.StatusOK, ok(list[0]))
}

// evidence: GET /api/v1/cells/{ticket}/evidence: the cell's catalogued artifacts and its recorded
// checks, each check linked to the catalog entries of the files it names.
func (s *Server) evidence(w http.ResponseWriter, r *http.Request) {
	t, good := ident(r.PathValue("ticket"))
	if !good {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "That is not a ticket identifier."))
		return
	}
	all, set := s.opts.Catalog.Snapshot()
	var mine []artifact.Entry
	for _, e := range all {
		if e.TicketID == t {
			mine = append(mine, e)
		}
	}
	s.linkVisits(mine)
	byPath := map[string]artifact.Entry{}
	for _, e := range mine {
		if e.Origin == "cell" || byPath[e.Path].ID == "" {
			byPath[e.Path] = e
		}
	}
	if mine == nil {
		mine = []artifact.Entry{}
	}
	s.view(w, func(st *project.State) (int, Envelope) {
		c := st.Cells[t]
		if c == nil && len(mine) == 0 {
			return http.StatusNotFound, fail(KindNotFound, "No such cell has been seen.")
		}
		checks := []map[string]any{}
		if c != nil {
			for _, k := range c.Checks {
				files := []map[string]any{}
				for _, ev := range k.Evidence {
					entry, catalogued := byPath[ev.File]
					f := map[string]any{"file": ev.File, "sha256": ev.SHA256, "artifact_id": nil, "integrity": "missing"}
					if catalogued {
						f["artifact_id"], f["integrity"], f["content_access"] = entry.ID, entry.Integrity, entry.ContentAccess
						if entry.SHA256 != ev.SHA256 && entry.SHA256 != "" {
							f["integrity"] = "mismatch" // the file differs from what this check recorded
						}
					}
					files = append(files, f)
				}
				checks = append(checks, map[string]any{"target_id": k.TargetID, "target_kind": k.TargetKind, "result": k.Result, "round": k.Round,
					"visit_id": k.VisitID, "at": project.TV(k.At), "evidence": files})
			}
		}
		return http.StatusOK, ok(map[string]any{"ticket_id": t, "artifacts": mine, "checks": checks, "settings": set, "cursor": s.cursor(st.Pos),
			"note": "verified evidence is a file results.json names with a matching hash; prose is written by an agent and is never proof"})
	})
}

// content: GET /api/v1/artifacts/{id}/content. By catalog id only; the bytes served are exactly
// the bytes hashed and checked against the catalog.
func (s *Server) content(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !artifactIDRe.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "An artifact is named by its catalog id, never by a path."))
		return
	}
	e, set, found := s.opts.Catalog.Lookup(id)
	if !found {
		writeJSON(w, http.StatusNotFound, fail(KindNotFound, "No artifact has that id in this project's catalog (it may have changed; reload the catalog)."))
		return
	}
	refuse := func(status int, reason, msg string) {
		env := fail(KindRefused, msg)
		env.Error.Reason = reason
		writeJSON(w, status, env)
	}
	switch e.ContentAccess {
	case "text", "media":
	case "none":
		if e.AccessReason == artifact.CredentialReason {
			refuse(http.StatusForbidden, "credential-name", "The artifact's name says it holds credentials; its content is never served.")
			return
		}
		// What is wrong with the file itself, said as such (M6.6 F7), not as a type.
		switch e.AccessReason {
		case artifact.TooLargeReason:
			refuse(http.StatusRequestEntityTooLarge, "too-large", "The artifact is larger than the observer serves.")
			return
		case artifact.DuplicateReason:
			refuse(http.StatusConflict, "duplicate", "The archive holds more than one file of this name; neither is served.")
			return
		}
		refuse(http.StatusUnsupportedMediaType, "type", "The observer does not serve this artifact's content: "+e.AccessReason+".")
		return
	case "media-disabled":
		refuse(http.StatusForbidden, "media-disabled", "Screenshots and recordings are served only when the project opts in: "+artifact.SettingKey+".")
		return
	default:
		refuse(http.StatusUnsupportedMediaType, "type", "The observer does not serve this artifact's content: "+e.AccessReason+".")
		return
	}
	select {
	case s.reads <- struct{}{}:
		defer func() { <-s.reads }()
	default:
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusServiceUnavailable, fail(KindUnavailable, "Too many artifact reads at once."))
		return
	}
	got, err := s.opts.Catalog.Read(e)
	switch {
	case errors.Is(err, artifact.ErrTooLarge):
		refuse(http.StatusRequestEntityTooLarge, "too-large", "The artifact is larger than the observer serves.")
		return
	case errors.Is(err, artifact.ErrChanged), errors.Is(err, artifact.ErrSwapped):
		refuse(http.StatusConflict, "changed", "The artifact changed since it was catalogued; reload the catalog.")
		return
	case errors.Is(err, artifact.ErrDuplicate):
		refuse(http.StatusConflict, "duplicate", "The archive holds more than one file of this name; neither is served.")
		return
	case errors.Is(err, artifact.ErrCredentialName):
		refuse(http.StatusForbidden, "credential-name", "The artifact's name says it holds credentials; its content is never served.")
		return
	case errors.Is(err, artifact.ErrTypeMatch):
		refuse(http.StatusUnsupportedMediaType, "type", "The artifact's contents are not a type the observer serves.")
		return
	case errors.Is(err, artifact.ErrLink), errors.Is(err, artifact.ErrHardLink), errors.Is(err, artifact.ErrNotFile):
		refuse(http.StatusForbidden, "link", "The artifact is a link or not a plain file, and is not read.")
		return
	case err != nil:
		writeJSON(w, http.StatusNotFound, fail(KindNotFound, "The artifact is no longer there."))
		return
	}
	if got.Class != "text" && !set.EvidenceMedia {
		refuse(http.StatusForbidden, "media-disabled", "Screenshots and recordings are served only when the project opts in: "+artifact.SettingKey+".")
		return
	}
	h := w.Header()
	h.Set("Content-Security-Policy", ArtifactCSP)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Cache-Control", "no-store")
	h.Set("X-MACH-Evidence-Match", "match")
	h.Set("X-MACH-Artifact-Nature", e.Nature)
	disposition := "inline"
	if r.URL.Query().Get("download") == "1" {
		disposition = "attachment"
	}
	h.Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": safeName(got.Name)}))
	if got.Class == "text" {
		h.Set("Content-Type", "text/plain; charset=utf-8")
		h.Set("X-MACH-Redacted", strconv.Itoa(got.Redacted))
		if e.FreeText {
			// R1: names known from records and git identities are replaced; a name that appears
			// only in this prose is not known, and is served as written.
			h.Set(redact.FreeTextHeader, redact.FreeTextValue)
		}
		if got.Truncated {
			h.Set("X-MACH-Truncated", "true")
		}
		h.Set("Content-Length", strconv.Itoa(len(got.Data)))
		w.WriteHeader(http.StatusOK)
		w.Write(got.Data)
		return
	}
	h.Set("Content-Type", got.MediaType)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(got.Data)) // range requests for video
}

// freeTextPolicy is the session's statement of where prose not checked for names can appear (R1,
// extended in M6.5 beyond artifact content): artifact content carries free_text and the header;
// these event fields, and the projection fields copied from them, are always such prose. A client
// shows each as text, never as markup, and does not present it as checked for names.
func freeTextPolicy() map[string]any {
	return map[string]any{
		"checked_for_names": false,
		"note":              redact.FreeTextNote,
		"artifact_field":    "free_text",
		"artifact_header":   redact.FreeTextHeader + ": " + redact.FreeTextValue,
		"event_fields":      redact.FreeTextFields,
		"projection_fields": redact.ProjectionFields, // M6.6: where the projection serves copies of them
		"render":            "text only; never markup",
	}
}

func safeName(name string) string {
	return strings.Map(func(r rune) rune {
		if r < 32 || r == '"' || r == '\\' || r == '/' || r > 126 {
			return '_'
		}
		return r
	}, name)
}
