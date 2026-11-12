package normalize

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Files reads a cell's own files by cell-relative path, read-only: a live cell folder or the
// members of its archive. Implementations refuse links, absolute paths and "..".
type Files interface {
	// Read returns a file's bytes when it is a regular file of at most max bytes.
	Read(rel string, max int64) ([]byte, bool)
	// Hash returns a file's SHA-256 and size when it is a regular file.
	Hash(rel string) (sum string, size int64, ok bool)
	// List returns the names directly inside a folder (regular files only), sorted.
	List(rel string) []string
	// Where names the source for provenance: "cell" or "archive".
	Where() string
}

// MaxHashBytes bounds how much of one file the observer hashes.
const MaxHashBytes = 256 << 20

func cleanRel(rel string) bool {
	if rel == "" || strings.HasPrefix(rel, "/") || strings.Contains(rel, "\\") {
		return false
	}
	for _, p := range strings.Split(rel, "/") {
		if p == "" || p == "." || p == ".." {
			return false
		}
	}
	return true
}

// DirFiles reads a live cell folder.
type DirFiles struct{ Dir string }

func (d DirFiles) open(rel string) (*os.File, fs.FileInfo, bool) {
	if !cleanRel(rel) {
		return nil, nil, false
	}
	path := filepath.Join(d.Dir, filepath.FromSlash(rel))
	// No component may be a link: walk from the cell folder.
	cur := d.Dir
	parts := strings.Split(rel, "/")
	for i, p := range parts {
		cur = filepath.Join(cur, p)
		info, err := os.Lstat(cur)
		if err != nil {
			return nil, nil, false
		}
		if info.Mode()&fs.ModeSymlink != 0 || (i < len(parts)-1 && !info.IsDir()) {
			return nil, nil, false
		}
	}
	f, err := openNoFollow(path)
	if err != nil {
		return nil, nil, false
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, nil, false
	}
	return f, info, true
}

// Read implements Files.
func (d DirFiles) Read(rel string, max int64) ([]byte, bool) {
	f, info, ok := d.open(rel)
	if !ok {
		return nil, false
	}
	defer f.Close()
	if info.Size() > max {
		return nil, false
	}
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil || int64(len(b)) > max {
		return nil, false
	}
	return b, true
}

// Hash implements Files.
func (d DirFiles) Hash(rel string) (string, int64, bool) {
	f, info, ok := d.open(rel)
	if !ok || info.Size() > MaxHashBytes {
		if f != nil {
			f.Close()
		}
		return "", 0, false
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, MaxHashBytes+1))
	if err != nil || n > MaxHashBytes {
		return "", 0, false
	}
	return hex.EncodeToString(h.Sum(nil)), n, true
}

// List implements Files.
func (d DirFiles) List(rel string) []string {
	dir := d.Dir
	if rel != "." {
		if !cleanRel(rel) {
			return nil
		}
		dir = filepath.Join(d.Dir, filepath.FromSlash(rel))
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.Type().IsRegular() && !strings.HasPrefix(e.Name(), ".") {
			out = append(out, e.Name())
		}
		if len(out) >= 1000 {
			break
		}
	}
	sort.Strings(out)
	return out
}

// Where implements Files.
func (DirFiles) Where() string { return "cell" }

// MemFiles holds an archive's members: small files' bytes and every regular file's hash.
type MemFiles struct {
	Bytes map[string][]byte
	Sums  map[string]string
	Sizes map[string]int64
}

// NewMemFiles makes an empty member set.
func NewMemFiles() *MemFiles {
	return &MemFiles{Bytes: map[string][]byte{}, Sums: map[string]string{}, Sizes: map[string]int64{}}
}

// Read implements Files.
func (m *MemFiles) Read(rel string, max int64) ([]byte, bool) {
	b, ok := m.Bytes[rel]
	if !ok || int64(len(b)) > max {
		return nil, false
	}
	return b, true
}

// Hash implements Files.
func (m *MemFiles) Hash(rel string) (string, int64, bool) {
	s, ok := m.Sums[rel]
	return s, m.Sizes[rel], ok
}

// List implements Files.
func (m *MemFiles) List(rel string) []string {
	var out []string
	prefix := rel + "/"
	for name := range m.Sums {
		if strings.HasPrefix(name, prefix) && !strings.Contains(name[len(prefix):], "/") {
			out = append(out, name[len(prefix):])
		}
	}
	sort.Strings(out)
	return out
}

// Where implements Files.
func (*MemFiles) Where() string { return "archive" }

// ErrNotFound is returned by readers when a file is absent.
var ErrNotFound = errors.New("not found")
