package ingest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mach/observer/internal/artifact"
)

// M14 parts D and E add two folders the Factory Floor does not show: the factory evals'
// .factory/evals/ and the self-report's .factory/local/faults/ (machine-local, private). The
// observer reads neither: lines shaped like MACH's own records placed there yield no event, and
// no catalogue entry names them. Neither folder is named anywhere in the observer's source.
func TestEvalsAndFaultsAreNeverRead(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	marker := "M15-MARKER-never-read"
	intakeLine := string(mustJSON(map[string]any{"schema_version": 3, "seq": 1, "at": "2026-11-12T10:00:00Z", "type": "human.required", "ticket_id": "T-1",
		"source": "supervisor", "data": map[string]any{"reason": marker}})) + "\n"
	lifeLine := string(mustJSON(map[string]any{"v": 1, "seq": 1, "at": "2026-11-12T10:00:00.000Z", "ticket_id": "T-1", "type": "station.entered",
		"station": "build", "visit": "build#1", "round": 1, "data": map[string]any{"stage": marker}})) + "\n"
	for rel, body := range map[string]string{
		".factory/evals/runs/e1/events.jsonl":                  intakeLine,
		".factory/evals/runs/e1/worktrees/T-1/lifecycle.jsonl": lifeLine,
		".factory/evals/results.json":                          `{"note":"` + marker + `"}`,
		".factory/local/faults/f1.json":                        `{"error":"` + marker + `"}`,
		".factory/local/faults/events.jsonl":                   intakeLine,
	} {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	os.MkdirAll(filepath.Join(root, ".factory/worktrees"), 0o755)
	h := newHarness(t, root, t.TempDir(), false)
	defer h.close()
	h.drain()
	for _, raw := range h.raws() {
		if strings.Contains(string(raw), marker) || strings.Contains(string(raw), "evals") || strings.Contains(string(raw), "faults") {
			t.Fatalf("an event from a folder the observer does not read: %s", raw)
		}
	}
	entries, _ := artifact.New(root).Snapshot()
	for _, e := range entries {
		if strings.Contains(e.Path, "evals") || strings.Contains(e.Path, "faults") {
			t.Fatalf("catalogued %s", e.Path)
		}
	}
	// The source names neither folder (a reader of them would have to).
	for _, dir := range []string{"..", "../../cmd"} {
		filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
				return nil
			}
			b, _ := os.ReadFile(p)
			if strings.Contains(string(b), ".factory/evals") || strings.Contains(string(b), "local/faults") {
				t.Errorf("%s names a folder the observer must not read", p)
			}
			return nil
		})
	}
}
