package tail

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path, s string, flag int) {
	t.Helper()
	f, err := os.OpenFile(path, flag|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

func appendTo(t *testing.T, path, s string) { write(t, path, s, os.O_APPEND) }

func texts(lines []Line) []string {
	var out []string
	for _, l := range lines {
		out = append(out, string(l.Bytes))
	}
	return out
}

func poll(t *testing.T, tl *Tailer) ([]string, []Note) {
	t.Helper()
	lines, notes, err := tl.Poll()
	if err != nil {
		t.Fatal(err)
	}
	return texts(lines), notes
}

func TestAppendAndTornLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log.jsonl")
	tl := New(path, Checkpoint{})
	if got, _ := poll(t, tl); len(got) != 0 {
		t.Fatalf("missing file gave lines %v", got)
	}
	appendTo(t, path, "{\"a\":1}\n{\"a\":2}\n{\"a\":")
	got, _ := poll(t, tl)
	if strings.Join(got, "|") != `{"a":1}|{"a":2}` {
		t.Fatalf("got %v", got)
	}
	if tl.CP.Offset != int64(len("{\"a\":1}\n{\"a\":2}\n")) {
		t.Fatalf("offset %d stops inside the torn line", tl.CP.Offset)
	}
	if got, _ := poll(t, tl); len(got) != 0 {
		t.Fatalf("a torn line was returned: %v", got)
	}
	appendTo(t, path, "3}\n")
	if got, _ := poll(t, tl); len(got) != 1 || got[0] != `{"a":3}` {
		t.Fatalf("completed line: %v", got)
	}
	if tl.CP.Epoch == "" {
		t.Fatal("no epoch after the first line")
	}
}

func TestBackfillIsNotLive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log.jsonl")
	appendTo(t, path, "old\n")
	tl := New(path, Checkpoint{})
	lines, _, _ := tl.Poll()
	if len(lines) != 1 || lines[0].Live {
		t.Fatalf("a line on disk before the first look is backfill: %+v", lines)
	}
	appendTo(t, path, "new\n")
	lines, _, _ = tl.Poll()
	if len(lines) != 1 || !lines[0].Live {
		t.Fatalf("a line appended later is live: %+v", lines)
	}
}

func TestTruncationSameEpochRereads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log.jsonl")
	appendTo(t, path, "one\ntwo\nthree\n")
	tl := New(path, Checkpoint{})
	poll(t, tl)
	tl.CP.LastSeq = 3
	write(t, path, "one\n", os.O_TRUNC)
	got, notes := poll(t, tl)
	if len(notes) != 1 || notes[0].Kind != NoteTruncated {
		t.Fatalf("notes %v", notes)
	}
	if len(got) != 1 || got[0] != "one" {
		t.Fatalf("after truncation the file is read again from the start: %v", got)
	}
	if tl.CP.LastSeq != 3 {
		t.Fatal("same epoch keeps the last sequence, so re-read lines are dropped as duplicates")
	}
}

func TestReplacedWithOtherContentIsNewEpoch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log.jsonl")
	appendTo(t, path, "first\nsecond\n")
	tl := New(path, Checkpoint{})
	poll(t, tl)
	tl.CP.LastSeq = 2
	old := tl.CP.Epoch
	other := filepath.Join(dir, "other")
	appendTo(t, other, "different\nlonger file\nthird line\n")
	if err := os.Rename(other, path); err != nil {
		t.Fatal(err)
	}
	got, notes := poll(t, tl)
	if len(notes) != 1 || notes[0].Kind != NoteReset || notes[0].OldEpoch != old {
		t.Fatalf("notes %v", notes)
	}
	if len(got) != 3 || tl.CP.Epoch == old || tl.CP.LastSeq != 0 {
		t.Fatalf("got %v, epoch %s (old %s), last seq %d", got, tl.CP.Epoch, old, tl.CP.LastSeq)
	}
}

func TestReplacedWithSameHistoryContinues(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log.jsonl")
	appendTo(t, path, "first\nsecond\n")
	tl := New(path, Checkpoint{})
	poll(t, tl)
	copyPath := filepath.Join(dir, "copy")
	appendTo(t, copyPath, "first\nsecond\nthird\n") // e.g. an atomic rewrite that kept history
	if err := os.Rename(copyPath, path); err != nil {
		t.Fatal(err)
	}
	got, notes := poll(t, tl)
	if len(notes) != 1 || notes[0].Kind != NoteReplaced {
		t.Fatalf("notes %v", notes)
	}
	if len(got) != 1 || got[0] != "third" {
		t.Fatalf("continue at the offset: %v", got)
	}
}

func TestGoneAndBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log.jsonl")
	appendTo(t, path, "a\n")
	tl := New(path, Checkpoint{})
	poll(t, tl)
	os.Remove(path)
	_, notes := poll(t, tl)
	if len(notes) != 1 || notes[0].Kind != NoteGone {
		t.Fatalf("notes %v", notes)
	}
	if _, notes := poll(t, tl); len(notes) != 0 {
		t.Fatal("gone is reported once")
	}
	appendTo(t, path, "b\n")
	got, notes := poll(t, tl)
	if len(got) != 1 || got[0] != "b" || len(notes) != 1 || notes[0].Kind != NoteReset {
		t.Fatalf("recreated file: %v %v", got, notes)
	}
}

func TestSymlinkRefused(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(dir, "secret")
	appendTo(t, secret, "{\"password\":\"hunter2\"}\n")
	path := filepath.Join(dir, "log.jsonl")
	if err := os.Symlink(secret, path); err != nil {
		t.Fatal(err)
	}
	tl := New(path, Checkpoint{})
	got, notes := poll(t, tl)
	if len(got) != 0 || len(notes) != 1 || notes[0].Kind != NoteBlocked || !tl.CP.Blocked {
		t.Fatalf("a link must not be read: %v %v", got, notes)
	}
}

func TestOversizedLineSkipped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log.jsonl")
	tl := New(path, Checkpoint{})
	tl.MaxLine, tl.MaxRead = 16, 32
	appendTo(t, path, "ok\n"+strings.Repeat("x", 40))
	got, _ := poll(t, tl)
	if len(got) != 1 || got[0] != "ok" {
		t.Fatalf("got %v", got)
	}
	poll(t, tl) // still inside the long line
	appendTo(t, path, "xxxx\nafter\n")
	for range 3 {
		if g, _ := poll(t, tl); len(g) > 0 {
			got = g
			break
		}
	}
	if len(got) != 1 || got[0] != "after" || tl.CP.Oversize != 1 {
		t.Fatalf("got %v oversize %d", got, tl.CP.Oversize)
	}
}

func TestResumeFromCheckpoint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log.jsonl")
	appendTo(t, path, "a\nb\n")
	first := New(path, Checkpoint{})
	poll(t, first)
	appendTo(t, path, "c\n")
	second := New(path, first.CP) // a restart
	got, notes := poll(t, second)
	if len(got) != 1 || got[0] != "c" || len(notes) != 0 {
		t.Fatalf("resume: %v %v", got, notes)
	}
}
