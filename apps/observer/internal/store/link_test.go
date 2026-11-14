//go:build unix

package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// M6.6 F2: the store refuses a folder that is a link, and never writes through a link that stands
// in its folder in place of one of its own files.
func TestOpenRefusesALinkedFolder(t *testing.T) {
	base := t.TempDir()
	victim := filepath.Join(base, "victim")
	os.Mkdir(victim, 0o700)
	os.WriteFile(filepath.Join(victim, "meta.json"), []byte(`{"keep":"me"}`), 0o644)
	link := filepath.Join(base, "index")
	if err := os.Symlink(victim, link); err != nil {
		t.Fatal(err)
	}
	if s, err := Open(link, 100); !errors.Is(err, ErrLinkedFolder) {
		if s != nil {
			s.Close()
		}
		t.Fatalf("a linked folder: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(victim, "meta.json")); string(b) != `{"keep":"me"}` {
		t.Fatalf("the linked folder's meta.json was changed: %s", b)
	}
	if entries, _ := os.ReadDir(victim); len(entries) != 1 {
		t.Fatalf("files were written into the linked folder: %v", entries)
	}

	// A segment that is a link to a file elsewhere is not opened for writing.
	dir := filepath.Join(base, "real")
	os.Mkdir(dir, 0o700)
	target := filepath.Join(base, "target.txt")
	os.WriteFile(target, []byte("keep\n"), 0o644)
	os.Symlink(target, filepath.Join(dir, "segment-000001.log"))
	if s, err := Open(dir, 100); err == nil {
		s.Close()
	}
	if b, _ := os.ReadFile(target); string(b) != "keep\n" {
		t.Fatalf("written through a segment link: %q", b)
	}
}
