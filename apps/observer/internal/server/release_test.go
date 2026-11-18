package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// M7 D11: the run's three readiness snapshots (lending-desk), the newest by evaluated_at served as
// latest; prose (the acceptance's "by", "source", reasons) is never served; no folder, no snapshot.
func TestReleaseReadinessSnapshots(t *testing.T) {
	root := t.TempDir()
	if got := ReadReleases(root); len(got) != 0 {
		t.Fatalf("no release folder: %+v", got)
	}
	put := func(id, readiness, run string) {
		d := filepath.Join(root, ".factory", "release", id)
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(d, "readiness.json"), []byte(readiness), 0o644)
		os.WriteFile(filepath.Join(d, "run.json"), []byte(run), 0o644)
	}
	put("EPIC-001-fb1ba6653304", `{"outcome":"blocked","release":{"commit":"fb1ba6653304e7ad126192b54c01e5b0f66fbade","integration_branch":"main","release_id":"EPIC-001-fb1ba6653304"},
"scope":{"epic":{"epic_id":"EPIC-001","issue":41},"slices":["SLICE-001"],"issues_not_taken_in":[]},
"product_acceptance":{"decision":"not_recorded","reason":"No acceptance comment on the epic's issue.","epic":{"epic_id":"EPIC-001","issue":41}}}`,
		`{"commit":"fb1ba6653304e7ad126192b54c01e5b0f66fbade","evaluated_at":"2026-11-14T22:56:29Z"}`)
	put("EPIC-002-e325cb6f23ba", `{"outcome":"qualified","release":{"commit":"e325cb6f23babe1c9ef56c561d9063e83c4b216d","integration_branch":"main","release_id":"EPIC-002-e325cb6f23ba"},
"scope":{"epic":{"epic_id":"EPIC-002","issue":52},"slices":["SLICE-004"],"issues_not_taken_in":[]},
"product_acceptance":{"decision":"accepted","at":"2026-11-14T22:59:26Z","by":"Jane Roe","source":"product/acceptance comment on issue #52","epic":{"epic_id":"EPIC-002","issue":52}}}`,
		`{"evaluated_at":"2026-11-14T23:00:08Z"}`)
	put("SLICE-001-e325cb6f23ba", `{"outcome":"qualified_with_exceptions","release":{"commit":"e325cb6f23babe1c9ef56c561d9063e83c4b216d"},
"scope":{"epic":null,"slices":["SLICE-001"],"issues_not_taken_in":[]},
"product_acceptance":{"decision":"not_recorded","reason":"A release of named slices records no acceptance.","epic":null}}`,
		`{"evaluated_at":"2026-11-14T22:58:05Z"}`)
	os.Symlink(filepath.Join(root, ".factory", "release", "EPIC-002-e325cb6f23ba"), filepath.Join(root, ".factory", "release", "EPIC-009-link"))
	got := ReadReleases(root)
	if len(got) != 3 {
		t.Fatalf("snapshots = %+v", got)
	}
	last := got[2]
	if last.ReleaseID != "EPIC-002-e325cb6f23ba" || *last.Outcome != "qualified" || *last.ProductAcceptance != "accepted" ||
		*last.Commit != "e325cb6f23babe1c9ef56c561d9063e83c4b216d" || last.EpicID == nil || *last.EpicID != "EPIC-002" {
		t.Fatalf("latest = %+v", last)
	}
	if got[0].ReleaseID != "EPIC-001-fb1ba6653304" || *got[0].ProductAcceptance != "not_recorded" || got[1].EpicID != nil {
		t.Fatalf("oldest = %+v", got[0])
	}
	b, _ := jsonMarshal(got)
	if strings.Contains(b, "Jane") || strings.Contains(b, "product/acceptance") || strings.Contains(b, "No acceptance comment") {
		t.Fatalf("prose served: %s", b)
	}
}

func jsonMarshal(v any) (string, error) {
	b, err := json.Marshal(v)
	return string(b), err
}
