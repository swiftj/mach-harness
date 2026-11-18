package server

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"mach/observer/internal/redact"
)

// Release readiness snapshots (M7 D11): .factory/release/<id>/readiness.json, written by release
// qualification, read here as plain files, read-only, on request. Only codes and commits are
// served: the release id, the commit it is for, the outcome, product acceptance's decision, the
// epic the release was qualified for (M11: a release covers an epic or named slices), and run.json's evaluated_at, which orders them (the newest is the last
// evaluated). Acceptance is never inferred: a snapshot that records none says not_recorded, and no
// snapshot means none is served.

var (
	releaseCommitRe = regexp.MustCompile(`^[0-9a-f]{7,64}$`)
	releaseCodeRe   = regexp.MustCompile(`^[a-z][a-z_-]{0,39}$`)
	releaseTimeRe   = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,15}(Z|[+-][0-9]{2}:[0-9]{2})$`)
)

const (
	maxReleaseDirs = 256
	maxReleaseFile = 4 << 20
)

// ReleaseSnapshot is one readiness snapshot as served.
type ReleaseSnapshot struct {
	ReleaseID         string  `json:"release_id"`
	Commit            *string `json:"commit"`
	Outcome           *string `json:"outcome"`
	ProductAcceptance *string `json:"product_acceptance"`
	EpicID            *string `json:"epic_id"`
	EvaluatedAt       *string `json:"evaluated_at"`
}

func code(v any) *string {
	if s, ok := v.(string); ok && releaseCodeRe.MatchString(s) {
		return &s
	}
	return nil
}

func plainFile(p string) ([]byte, bool) {
	info, err := os.Lstat(p)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxReleaseFile {
		return nil, false
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxReleaseFile+1))
	return b, err == nil && len(b) <= maxReleaseFile
}

// ReadReleases reads every readiness snapshot under root/.factory/release, oldest first.
func ReadReleases(root string) []ReleaseSnapshot {
	dir := filepath.Join(root, ".factory", "release")
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() {
		return []ReleaseSnapshot{}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []ReleaseSnapshot{}
	}
	out := []ReleaseSnapshot{}
	for i, e := range entries {
		if i >= maxReleaseDirs {
			break
		}
		id, good := redact.ID(e.Name())
		if !good || e.Type()&os.ModeSymlink != 0 || !e.IsDir() {
			continue
		}
		b, okR := plainFile(filepath.Join(dir, e.Name(), "readiness.json"))
		if !okR {
			continue
		}
		var r struct {
			Outcome any `json:"outcome"`
			Release struct {
				Commit    any `json:"commit"`
				ReleaseID any `json:"release_id"`
			} `json:"release"`
			ProductAcceptance struct {
				Decision any `json:"decision"`
			} `json:"product_acceptance"`
			Scope struct {
				Epic struct {
					EpicID any `json:"epic_id"`
				} `json:"epic"`
			} `json:"scope"`
		}
		if json.Unmarshal(b, &r) != nil {
			continue
		}
		snap := ReleaseSnapshot{ReleaseID: id, Outcome: code(r.Outcome), ProductAcceptance: code(r.ProductAcceptance.Decision)}
		if c, ok := r.Release.Commit.(string); ok && releaseCommitRe.MatchString(c) {
			snap.Commit = &c
		}
		if eid, ok := redact.ID(r.Scope.Epic.EpicID); ok {
			snap.EpicID = &eid
		}
		if rb, ok := plainFile(filepath.Join(dir, e.Name(), "run.json")); ok {
			var run struct {
				EvaluatedAt any `json:"evaluated_at"`
			}
			if json.Unmarshal(rb, &run) == nil {
				if t, ok := run.EvaluatedAt.(string); ok && releaseTimeRe.MatchString(t) {
					snap.EvaluatedAt = &t
				}
			}
		}
		out = append(out, snap)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := "", ""
		if out[i].EvaluatedAt != nil {
			a = *out[i].EvaluatedAt
		}
		if out[j].EvaluatedAt != nil {
			b = *out[j].EvaluatedAt
		}
		return a < b || a == b && out[i].ReleaseID < out[j].ReleaseID
	})
	return out
}

// releases serves GET /api/v1/release/readiness: every snapshot, and the newest (null when none).
func (s *Server) releases(w http.ResponseWriter, r *http.Request) {
	items := ReadReleases(s.opts.Root)
	var latest any
	if n := len(items); n > 0 {
		latest = items[n-1]
	}
	writeJSON(w, http.StatusOK, ok(map[string]any{"items": items, "latest": latest,
		"basis": "read from .factory/release/<id>/readiness.json; ordered by run.json's evaluated_at; acceptance is never inferred"}))
}
