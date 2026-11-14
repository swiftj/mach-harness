package artifact

import (
	"archive/tar"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// M6.6 F7: a file too large to hash was listed as "not there to read", and an archive member whose
// name occurs twice as "changed". Each now says what is wrong with it, and neither is read.
func TestOversizedAndDuplicateMembersSayWhy(t *testing.T) {
	f := project(t, map[string]string{"big.txt": "x"})
	if err := os.Truncate(filepath.Join(f.cell, "evidence/big.txt"), MaxVideo+1); err != nil {
		t.Fatal(err)
	}
	ev1, ev2 := []byte("first\n"), []byte("second\n")
	res, _ := json.Marshal(map[string]any{"head": "abcdef1", "review_loop": 0, "records": map[string]any{
		"AC-02": map[string]any{"kind": "scenario", "result": "pass", "evidence": []map[string]string{{"file": "dup.txt", "sha256": sum(ev2)}}},
	}})
	targz(t, filepath.Join(f.root, ".factory/archive/T-0.tar.gz"), []tar.Header{
		{Name: "T-0/evidence/results.json", Typeflag: tar.TypeReg},
		{Name: "T-0/evidence/dup.txt", Typeflag: tar.TypeReg},
		{Name: "T-0/evidence/dup.txt", Typeflag: tar.TypeReg},
	}, [][]byte{res, ev1, ev2})
	c := New(f.root)
	got := byPath(c)
	big := got["cell:evidence/big.txt"]
	if big.ContentAccess != "none" || big.AccessReason != TooLargeReason {
		t.Fatalf("oversized: %s %q", big.ContentAccess, big.AccessReason)
	}
	dup, ok := got["archive:evidence/dup.txt"]
	if !ok || dup.ContentAccess != "none" || dup.AccessReason != DuplicateReason {
		t.Fatalf("duplicate: %v %s %q", ok, dup.ContentAccess, dup.AccessReason)
	}
	if _, err := c.Read(dup); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("a duplicated member was read: %v", err)
	}
}
