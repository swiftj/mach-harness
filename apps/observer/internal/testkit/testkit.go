// Package testkit builds fixture .factory trees and checks that nothing outside the observer's
// own folder changed.
package testkit

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Project makes a project folder with an empty Factory tree and returns its absolute,
// link-resolved path.
func Project(t testing.TB) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{".factory/intake", ".factory/worktrees", ".factory/local/executions", ".factory/archive", ".factory/observations"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// LedgerLine is one events.jsonl line (schema version 2).
func LedgerLine(seq int, typ string, ticket string, data map[string]any) []byte {
	if data == nil {
		data = map[string]any{}
	}
	var tk any
	if ticket != "" {
		tk = ticket
	}
	line, _ := json.Marshal(map[string]any{
		"schema_version": 2, "seq": seq, "at": "2026-11-12T10:00:00Z", "type": typ, "project_id": "P-1",
		"source_commit": nil, "wave_id": "WAVE-001", "slice_id": "SLICE-001", "revision": 1, "ticket_id": tk,
		"runner_id": nil, "execution_id": nil, "source": "intake", "cause": nil, "refs": nil, "data": data,
	})
	return append(line, '\n')
}

// LifecycleLine is one cell lifecycle.jsonl line (schemas/cell-lifecycle.schema.json). seq 0
// writes a null seq, as the helper does when it cannot take its lock in time.
func LifecycleLine(ticket string, seq int, typ, station string, data map[string]any) []byte {
	if data == nil {
		data = map[string]any{}
	}
	var s any
	if seq > 0 {
		s = seq
	}
	line, _ := json.Marshal(map[string]any{
		"v": 1, "seq": s, "at": "2026-11-12T10:00:01.250Z", "ticket_id": ticket, "type": typ, "station": station,
		"visit": fmt.Sprintf("%s#1", station), "round": 1, "execution_id": "x0123456789ab", "data": data,
	})
	return append(line, '\n')
}

// Append appends data to path, creating it and its folder.
func Append(t testing.TB, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		t.Fatal(err)
	}
}

// LedgerPath and CellLog are fixture paths.
func LedgerPath(root string) string { return filepath.Join(root, ".factory", "intake", "events.jsonl") }

// CellLog is a cell's lifecycle log.
func CellLog(root, ticket string) string {
	return filepath.Join(root, ".factory", "worktrees", ticket, "lifecycle.jsonl")
}

// HashTree records every path under root except those under exclude (relative, slash form):
// type, mode, size, modification time and content hash. Two equal results mean nothing was
// created, removed, written, chmod-ed or touched.
func HashTree(t testing.TB, root, exclude string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if exclude != "" && (rel == exclude || strings.HasPrefix(rel, exclude+"/")) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		sum := ""
		if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			h := sha256.Sum256(data)
			sum = hex.EncodeToString(h[:])
		}
		modTime, size := info.ModTime().UnixNano(), info.Size()
		if info.IsDir() {
			// A folder's mtime and size change when an entry is added; its entries are recorded one
			// by one instead, so the only change this hides is the observer's own folder appearing.
			modTime, size = 0, 0
		}
		out[rel] = fmt.Sprintf("%s %o %d %d %s", info.Mode().Type(), info.Mode().Perm(), size, modTime, sum)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// DiffTrees describes the differences between two HashTree results.
func DiffTrees(before, after map[string]string) []string {
	var diffs []string
	for k, v := range before {
		if w, ok := after[k]; !ok {
			diffs = append(diffs, "removed "+k)
		} else if v != w {
			diffs = append(diffs, "changed "+k)
		}
	}
	for k := range after {
		if _, ok := before[k]; !ok {
			diffs = append(diffs, "created "+k)
		}
	}
	return diffs
}

// WriteFile writes data to path, creating its folder.
func WriteFile(t testing.TB, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// ExecDir is an execution's folder.
func ExecDir(root, execution string) string {
	return filepath.Join(root, ".factory", "local", "executions", execution)
}

// CellDir is a cell's folder.
func CellDir(root, ticket string) string { return filepath.Join(root, ".factory", "worktrees", ticket) }

// StreamFixture is the path of one of tests/fixtures/execution-streams/*.jsonl.
func StreamFixture(name string) string {
	return filepath.Join(RepoRoot(), "tests", "fixtures", "execution-streams", name)
}

// Record is a lifecycle record with every field explicit.
type Record struct {
	Seq       int // 0 writes null
	At        string
	Ticket    string
	Type      string
	Station   string
	Visit     int
	Round     int // 0 writes null
	Execution string
	Data      map[string]any
	OldRound  bool // write the judging round as "attempt", as files written before decision 2 did
}

// Line encodes the record as the lifecycle helper writes it.
func (r Record) Line() []byte {
	var seq, round, x any
	if r.Seq > 0 {
		seq = r.Seq
	}
	if r.Round > 0 {
		round = r.Round
	}
	if r.Execution != "" {
		x = r.Execution
	}
	if r.Data == nil {
		r.Data = map[string]any{}
	}
	if r.At == "" {
		r.At = "2026-11-12T10:00:01.250Z"
	}
	if r.Visit == 0 {
		r.Visit = 1
	}
	m := map[string]any{"v": 1, "seq": seq, "at": r.At, "ticket_id": r.Ticket, "type": r.Type, "station": r.Station,
		"visit": fmt.Sprintf("%s#%d", r.Station, r.Visit), "execution_id": x, "data": r.Data}
	if r.OldRound {
		m["attempt"] = round
	} else {
		m["round"] = round
	}
	b, _ := json.Marshal(m)
	return append(b, '\n')
}

// WriteArchive writes a cell archive as cleanup does: a gzip tar with every member under
// "<prefix>/".
func WriteArchive(t testing.TB, path, prefix string, files map[string][]byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		data := files[n]
		if err := tw.WriteHeader(&tar.Header{Name: prefix + "/" + n, Mode: 0o644, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		tw.Write(data)
	}
	tw.Close()
	gz.Close()
	f.Close()
}
