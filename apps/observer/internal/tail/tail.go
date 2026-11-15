// Package tail follows one append-only JSON-lines file by byte offset, without locks, without
// writing, and without trusting the file to stay the same file.
//
// It recognises: growth (new complete lines), a torn last line (held back until its newline
// arrives), an over-long line (skipped and counted), truncation, replacement by another file
// (a new inode), recreation with different content (a new epoch), disappearance, and a path that
// is a symbolic link or not a regular file (refused).
package tail

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
)

// Defaults for the read bounds.
const (
	DefaultMaxRead = 4 << 20 // bytes read from one file in one poll
	DefaultMaxLine = 1 << 20 // a longer line is skipped
)

// Checkpoint is a tailer's durable position. The store persists it after the events read up to
// it are on disk, so a restart resumes exactly here.
type Checkpoint struct {
	Path     string `json:"path"` // project-relative
	Dev      uint64 `json:"dev"`
	Ino      uint64 `json:"ino"`
	Offset   int64  `json:"offset"`    // bytes consumed: always just after a newline, or inside a skipped line
	LineNo   int64  `json:"line_no"`   // physical lines consumed (every newline, including blank, refused and skipped lines)
	LastLine int64  `json:"last_line"` // the highest line number accepted (for sources without a sequence)
	Epoch    string `json:"epoch"`     // identity of the file's contents: a hash of its first line
	Skipping bool   `json:"skipping,omitempty"`
	LastSeq  int64  `json:"last_seq"` // the highest source sequence number accepted
	Lines    int64  `json:"lines"`
	Refused  int64  `json:"refused"` // lines a normalizer refused (malformed, wrong version, ...)
	Dupes    int64  `json:"duplicates"`
	Oversize int64  `json:"oversized"`
	Resets   int64  `json:"resets"`
	Gone     bool   `json:"gone,omitempty"`
	Blocked  bool   `json:"blocked,omitempty"` // the path is a link or not a regular file
	// For sources read whole rather than tailed (execution records, archives): what has been
	// emitted (bit flags owned by ingest) and the identity of the file when it was read.
	Flags uint32 `json:"flags,omitempty"`
	Size  int64  `json:"size,omitempty"`
	MTime int64  `json:"mtime,omitempty"`
}

// Line is one complete line and where it started.
type Line struct {
	Bytes  []byte
	Offset int64
	Number int64 // 1-based physical line number
	Live   bool  // false for lines that were already in the file when the tailer first looked
}

// Note kinds: something about the file changed in a way consumers should hear about.
const (
	NoteReset     = "reset"     // new contents (another epoch): read again from the start
	NoteTruncated = "truncated" // same epoch, shorter: read again from the start, duplicates dropped by sequence
	NoteReplaced  = "replaced"  // another inode with the same history: continue at the offset
	NoteGone      = "gone"      // the file disappeared
	NoteBlocked   = "blocked"   // the path is a symbolic link or not a regular file
)

// Note reports a change.
type Note struct {
	Kind     string
	OldEpoch string
}

// Tailer follows one file. It is used by one goroutine.
type Tailer struct {
	Abs     string
	CP      Checkpoint
	MaxRead int64
	MaxLine int64
	// Size is the file's size at the last poll that found it (-1 before the first, or while it is
	// gone or refused): with the offset, how far behind the reader is.
	Size int64
	// ModNS is the file's modification time at the last poll that found it (Unix ns), so a caller
	// needs no second stat.
	ModNS int64
	// LiveFromStart makes every line live, including what is already on disk at the first poll: for
	// a file that appeared while the observer was already following the Factory, whose lines were
	// all written after the observer started.
	LiveFromStart bool

	startSize int64
	started   bool
	// absentFirst: the first poll found no file, so whatever it holds when it appears was written
	// while the observer watched: all of it is live (D16).
	absentFirst bool
	readToEnd   bool // the last poll read every complete line the file had
}

// New makes a tailer that resumes from cp.
func New(abs string, cp Checkpoint) *Tailer {
	return &Tailer{Abs: abs, CP: cp, MaxRead: DefaultMaxRead, MaxLine: DefaultMaxLine, Size: -1}
}

// CaughtUp reports whether every complete line that was in the file when the tailer first looked
// has been read (or the file has not been looked at yet). Lines read before that are backfill. A
// torn last line does not hold it back: it is not a line until its newline arrives.
func (t *Tailer) CaughtUp() bool { return !t.started || t.CP.Offset >= t.startSize || t.readToEnd }

// ReadToEnd reports whether the last poll read every complete line the file had.
func (t *Tailer) ReadToEnd() bool { return t.readToEnd }

// FileID is the file's device and inode (0, 0 where the platform has none).
func FileID(info fs.FileInfo) (dev, ino uint64) { return fileID(info) }

// identity is how Poll reads a file's device and inode: fileID, replaced in tests to simulate a
// filesystem that reuses an inode for a file created right after another was removed (common on
// Linux).
var identity = fileID

// Poll reads what is new. It never blocks on the file and never holds it open between calls.
func (t *Tailer) Poll() ([]Line, []Note, error) {
	var notes []Note
	t.Size = -1
	info, err := os.Lstat(t.Abs)
	if errors.Is(err, fs.ErrNotExist) {
		if !t.started && t.CP.Offset == 0 && t.CP.Ino == 0 {
			t.absentFirst = true
		}
		if !t.CP.Gone && (t.CP.Offset > 0 || t.CP.Ino != 0) {
			t.CP.Gone = true
			notes = append(notes, Note{Kind: NoteGone, OldEpoch: t.CP.Epoch})
		}
		return nil, notes, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		if !t.CP.Blocked {
			t.CP.Blocked = true
			notes = append(notes, Note{Kind: NoteBlocked})
		}
		return nil, notes, nil
	}
	prevMod := t.ModNS
	t.ModNS = info.ModTime().UnixNano()
	// Nothing new: the same file, the same size as read up to, not written since the last poll.
	// One stat per idle poll, no open (a project with a thousand cells is polled several times a
	// second for low latency). A write that left the size unchanged (a file recreated on a reused
	// inode with as many bytes) goes on to the first-line check below.
	if dev, ino := identity(info); t.started && !t.CP.Blocked && !t.CP.Gone && t.CP.Ino != 0 && dev == t.CP.Dev && ino == t.CP.Ino &&
		info.Size() == t.CP.Offset && !t.CP.Skipping && t.ModNS == prevMod {
		t.Size = info.Size()
		t.readToEnd = true
		return nil, nil, nil
	}
	f, err := openReadOnly(t.Abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil, nil
		}
		if isLinkRefusal(err) {
			if !t.CP.Blocked {
				t.CP.Blocked = true
				notes = append(notes, Note{Kind: NoteBlocked})
			}
			return nil, notes, nil
		}
		return nil, nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !st.Mode().IsRegular() {
		if !t.CP.Blocked {
			t.CP.Blocked = true
			notes = append(notes, Note{Kind: NoteBlocked})
		}
		return nil, notes, nil
	}
	t.CP.Blocked = false
	wasGone := t.CP.Gone
	t.CP.Gone = false
	size := st.Size()
	t.Size = size
	if !t.started {
		t.started = true
		t.startSize = size
		if t.LiveFromStart || t.absentFirst {
			t.startSize = 0
		}
	}
	dev, ino := identity(st)
	// Another file: another inode, or a file that was seen to disappear and is back. The inode
	// alone cannot tell: a filesystem may give a file created right after a removal the removed
	// file's inode (ext4 often does), and some platforms have no inode at all. So a file that has
	// already given its first line is also checked by that line: different first line, different
	// file, whatever its inode and size.
	replaced := (t.CP.Ino != 0 && (dev != t.CP.Dev || ino != t.CP.Ino)) || (wasGone && t.CP.Offset > 0)
	truncated := size < t.CP.Offset
	newEpoch, checked := "", false
	if !replaced && !truncated && t.CP.Epoch != "" && t.CP.Offset > 0 {
		newEpoch, checked = t.firstLineEpoch(f), true
		replaced = newEpoch != t.CP.Epoch
	}
	if replaced || truncated {
		if !checked {
			newEpoch = t.firstLineEpoch(f)
		}
		switch {
		case !truncated && t.CP.Epoch != "" && newEpoch == t.CP.Epoch:
			notes = append(notes, Note{Kind: NoteReplaced, OldEpoch: t.CP.Epoch})
		case t.CP.Epoch != "" && newEpoch == t.CP.Epoch:
			notes = append(notes, Note{Kind: NoteTruncated, OldEpoch: t.CP.Epoch})
			t.CP.Offset, t.CP.Skipping, t.CP.LineNo = 0, false, 0
			t.CP.Resets++
			t.startSize = 0
		default:
			notes = append(notes, Note{Kind: NoteReset, OldEpoch: t.CP.Epoch})
			t.CP.Offset, t.CP.Skipping, t.CP.Epoch, t.CP.LastSeq, t.CP.LineNo, t.CP.LastLine = 0, false, "", 0, 0, 0
			t.CP.Resets++
			t.startSize = 0
		}
	}
	t.CP.Dev, t.CP.Ino = dev, ino
	t.readToEnd = false
	if size <= t.CP.Offset {
		t.readToEnd = true
		return nil, notes, nil
	}
	want := min(size-t.CP.Offset, t.MaxRead)
	buf := make([]byte, want)
	n, err := f.ReadAt(buf, t.CP.Offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, notes, err
	}
	buf = buf[:n]
	base := t.CP.Offset
	pos := 0
	var lines []Line
	for pos < len(buf) {
		idx := bytes.IndexByte(buf[pos:], '\n')
		if t.CP.Skipping {
			if idx < 0 {
				pos = len(buf)
				break
			}
			pos += idx + 1
			t.CP.Skipping = false
			t.CP.LineNo++
			continue
		}
		if idx < 0 {
			if int64(len(buf)-pos) >= t.MaxLine {
				t.CP.Oversize++
				t.CP.Skipping = true
				pos = len(buf)
			}
			break // a torn last line: wait for its newline
		}
		t.CP.LineNo++
		if int64(idx) > t.MaxLine {
			t.CP.Oversize++
			pos += idx + 1
			continue
		}
		raw := bytes.TrimRight(buf[pos:pos+idx], "\r")
		offset := base + int64(pos)
		pos += idx + 1
		if len(bytes.TrimSpace(raw)) == 0 {
			continue
		}
		if offset == 0 && t.CP.Epoch == "" {
			t.CP.Epoch = epochOf(raw)
		}
		t.CP.Lines++
		lines = append(lines, Line{Bytes: bytes.Clone(raw), Offset: offset, Number: t.CP.LineNo, Live: offset >= t.startSize})
	}
	t.CP.Offset = base + int64(pos)
	t.readToEnd = base+int64(len(buf)) >= size
	return lines, notes, nil
}

// firstLineEpoch hashes the file's first complete line, or "" when there is none yet. It reads a
// small block first (it runs on every poll that finds new bytes) and more only for a long line.
func (t *Tailer) firstLineEpoch(f *os.File) string {
	limit := min(t.MaxLine+1, 1<<20)
	for size := min(int64(4096), limit); ; size = min(size*16, limit) {
		buf := make([]byte, size)
		n, _ := f.ReadAt(buf, 0)
		if idx := bytes.IndexByte(buf[:n], '\n'); idx >= 0 {
			return epochOf(bytes.TrimRight(buf[:idx], "\r"))
		}
		if int64(n) < size || size == limit {
			return ""
		}
	}
}

// epochOf is the file's generation: the first 8 hex of SHA-256 of its first line
// (M6_1_EVENT_CONTRACT.md section 5.1).
func epochOf(line []byte) string {
	h := sha256.Sum256(line)
	return hex.EncodeToString(h[:4])
}
