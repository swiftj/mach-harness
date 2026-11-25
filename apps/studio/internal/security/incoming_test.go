package security

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAProjectFileIsKeptByItsHash(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	path, key, err := KeepIncoming(root, "lending.zip", []byte("PK one"))
	if err != nil || filepath.Base(path) != "lending.zip" || filepath.Base(filepath.Dir(path)) != key || key != IncomingKey([]byte("PK one")) {
		t.Fatalf("kept %s %s %v", path, key, err)
	}
	found, name, size, err := FindIncoming(root, key, 1<<20)
	if err != nil || found != path || name != "lending.zip" || size != 6 {
		t.Fatalf("found %s %s %d %v", found, name, size, err)
	}
	// The same bytes under another name replace it; the name chosen last is kept.
	if again, _, err := KeepIncoming(root, "lending 1.zip", []byte("PK one")); err != nil || filepath.Base(again) != "lending 1.zip" {
		t.Fatalf("again %s %v", again, err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(path)); len(entries) != 1 {
		t.Fatalf("two files under one hash: %v", entries)
	}
	// Bytes changed on disk, a name that is not plain, an unknown hash, a file too large: not kept.
	os.WriteFile(filepath.Join(filepath.Dir(path), "lending 1.zip"), []byte("PK two"), 0o600)
	if _, _, _, err := FindIncoming(root, key, 1<<20); !errors.Is(err, ErrNotKept) {
		t.Fatalf("changed bytes: %v", err)
	}
	if _, _, err := KeepIncoming(root, "../x.zip", []byte("x")); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("a name with a folder: %v", err)
	}
	if _, _, _, err := FindIncoming(root, "nothex", 1<<20); !errors.Is(err, ErrNotKept) {
		t.Fatalf("not a hash: %v", err)
	}
	_, other, _ := KeepIncoming(root, "b.zip", []byte("PK three"))
	if _, _, _, err := FindIncoming(root, other, 3); !errors.Is(err, ErrNotKept) {
		t.Fatalf("too large: %v", err)
	}
	// Forgetting all but one, then that one.
	if err := ForgetIncomingExcept(root, other); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(filepath.Join(root, ".factory", "studio", "incoming")); len(entries) != 1 || entries[0].Name() != other {
		t.Fatalf("after forgetting the others: %v", entries)
	}
	if err := ForgetIncoming(root, other); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(filepath.Join(root, ".factory", "studio", "incoming")); len(entries) != 0 {
		t.Fatalf("after forgetting: %v", entries)
	}
}

func TestALinkInTheIncomingFolderIsNeverFollowed(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	outside := t.TempDir()
	os.MkdirAll(filepath.Join(root, ".factory", "studio"), 0o755)
	os.Symlink(outside, filepath.Join(root, ".factory", "studio", "incoming"))
	if _, _, err := KeepIncoming(root, "a.zip", []byte("PK")); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("kept through a link: %v", err)
	}
	if _, _, _, err := FindIncoming(root, IncomingKey([]byte("PK")), 10); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("found through a link: %v", err)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("wrote outside: %v", entries)
	}
	// A link where a kept file's folder would be is removed, never what it points to.
	os.Remove(filepath.Join(root, ".factory", "studio", "incoming"))
	os.MkdirAll(filepath.Join(root, ".factory", "studio", "incoming"), 0o755)
	os.WriteFile(filepath.Join(outside, "keep.txt"), []byte("mine"), 0o644)
	key := IncomingKey([]byte("PK"))
	os.Symlink(outside, filepath.Join(root, ".factory", "studio", "incoming", key))
	if _, _, err := KeepIncoming(root, "a.zip", []byte("PK")); err != nil {
		t.Fatalf("over a link: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(outside, "keep.txt")); err != nil || string(data) != "mine" {
		t.Fatal("a file outside was touched")
	}
}
