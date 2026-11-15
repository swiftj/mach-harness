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
	put("WAVE-001-fb1ba6653304", `{"outcome":"blocked","release":{"commit":"fb1ba6653304e7ad126192b54c01e5b0f66fbade","integration_branch":"main","release_id":"WAVE-001-fb1ba6653304"},
"product_acceptance":{"decision":"not_recorded","waves":[{"decision":"not_recorded","reason":"No acceptance file in the merged product files.","wave_id":"WAVE-001"}]}}`,
		`{"commit":"fb1ba6653304e7ad126192b54c01e5b0f66fbade","evaluated_at":"2026-11-14T22:56:29Z"}`)
	put("WAVE-002-e325cb6f23ba", `{"outcome":"qualified","release":{"commit":"e325cb6f23babe1c9ef56c561d9063e83c4b216d","integration_branch":"main","release_id":"WAVE-002-e325cb6f23ba"},
"product_acceptance":{"decision":"accepted","waves":[{"at":"2026-11-14T22:59:26Z","by":"Jane Roe","decision":"accepted","source":"product/acceptance/WAVE-002.json on the integration branch","wave_id":"WAVE-002"}]}}`,
		`{"evaluated_at":"2026-11-14T23:00:08Z"}`)
	put("WAVE-001-e325cb6f23ba", `{"outcome":"qualified_with_exceptions","release":{"commit":"e325cb6f23babe1c9ef56c561d9063e83c4b216d"},
"product_acceptance":{"decision":"not_recorded","waves":[{"decision":"not_recorded","wave_id":"WAVE-001"}]}}`,
		`{"evaluated_at":"2026-11-14T22:58:05Z"}`)
	os.Symlink(filepath.Join(root, ".factory", "release", "WAVE-002-e325cb6f23ba"), filepath.Join(root, ".factory", "release", "WAVE-009-link"))
	got := ReadReleases(root)
	if len(got) != 3 {
		t.Fatalf("snapshots = %+v", got)
	}
	last := got[2]
	if last.ReleaseID != "WAVE-002-e325cb6f23ba" || *last.Outcome != "qualified" || *last.ProductAcceptance != "accepted" ||
		*last.Commit != "e325cb6f23babe1c9ef56c561d9063e83c4b216d" || len(last.Waves) != 1 || *last.Waves[0].Decision != "accepted" {
		t.Fatalf("latest = %+v", last)
	}
	if got[0].ReleaseID != "WAVE-001-fb1ba6653304" || *got[0].ProductAcceptance != "not_recorded" {
		t.Fatalf("oldest = %+v", got[0])
	}
	b, _ := jsonMarshal(got)
	if strings.Contains(b, "Jane") || strings.Contains(b, "product/acceptance") || strings.Contains(b, "No acceptance file") {
		t.Fatalf("prose served: %s", b)
	}
}

func jsonMarshal(v any) (string, error) {
	b, err := json.Marshal(v)
	return string(b), err
}
