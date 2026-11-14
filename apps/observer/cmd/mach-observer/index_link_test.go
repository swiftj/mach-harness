package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mach/observer/internal/testkit"
)

// M6.6 F2: with .factory/local/observer/index a link to another folder, the observer replaced that
// folder's meta.json and checkpoints.json and wrote its event index there. A linked index folder
// is refused before anything is written, and the folder it points to is left as it was.
func TestIndexFolderLinkIsRefused(t *testing.T) {
	root := fixture(t)
	victim, _ := filepath.EvalSymlinks(t.TempDir())
	os.WriteFile(filepath.Join(victim, "meta.json"), []byte(`{"keep":"me"}`), 0o644)
	os.WriteFile(filepath.Join(victim, "checkpoints.json"), []byte("precious"), 0o644)
	if err := os.MkdirAll(filepath.Join(root, ".factory/local/observer"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(root, ".factory/local/observer/index")); err != nil {
		t.Skip("no symbolic links here:", err)
	}
	before := testkit.HashTree(t, victim, "")
	err := run(context.Background(), []string{"--project", root}, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "link") {
		t.Fatalf("an observer whose index folder is a link started (or failed for another reason): %v", err)
	}
	if diffs := testkit.DiffTrees(before, testkit.HashTree(t, victim, "")); len(diffs) > 0 {
		t.Fatalf("the folder the link points to was changed: %v", diffs)
	}
}
