// Package store is the observer's merged log: every normalized event, in the order the observer
// accepted it, each at a position that never changes within a generation.
//
// It is a projection of MACH's files, never a replacement: deleting it loses nothing, because it
// is rebuilt from the sources (under a new generation, so clients know their cursors no longer
// apply). On disk it is three files under the index folder:
//
//	meta.json         format, generation, and the redaction and event versions it was built under
//	events.log        one normalized event per line, append-only, fsynced before checkpoints move
//	checkpoints.json  each source's tail position, written atomically after events.log is synced
//
// Because events.log is synced before checkpoints.json is replaced, a crash can only leave the
// checkpoints behind the log, never ahead. The lines between are read again on restart and
// dropped by their deterministic IDs, so nothing is lost and nothing is repeated.
package store

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
	"mach/observer/internal/tail"
)

// Format is the on-disk layout version.
const Format = 1

// DefaultMaxMemory is how many recent events are held in memory and so served by cursor.
const DefaultMaxMemory = 50000

// Errors a cursor read can return.
var (
	ErrExpired = errors.New("the cursor is older than what this observer still holds")
	ErrFuture  = errors.New("the cursor is ahead of this observer's log")
)

// Meta is meta.json.
type Meta struct {
	Format           int    `json:"format"`
	Generation       string `json:"generation"`
	CreatedAt        string `json:"created_at"`
	RedactionVersion int    `json:"redaction_version"`
	EventVersion     int    `json:"event_version"`
}

// Entry is one stored event: the decoded event and its encoded line, made once.
type Entry struct {
	Event *event.Event
	Raw   []byte
}

// Info summarises the store.
type Info struct {
	Generation string `json:"generation"`
	Head       uint64 `json:"head"`
	Floor      uint64 `json:"floor"`
	InMemory   int    `json:"in_memory"`
	Persisted  bool   `json:"persisted"`
	Rebuilt    string `json:"rebuilt,omitempty"` // why the index was started again at open, if it was
	Duplicates int64  `json:"duplicates"`
}

// Store is safe for concurrent use: one writer (the ingest loop), many readers.
type Store struct {
	dir    string
	maxMem int

	mu          sync.RWMutex
	meta        Meta
	entries     []Entry // contiguous: entries[i].Event.Position == first+i
	first       uint64
	head        uint64
	ids         map[string]uint64
	seg         *os.File
	checkpoints map[string]tail.Checkpoint
	changed     chan struct{}
	rebuilt     string
	dupes       int64
	closed      bool
}

// Open opens or creates the index in dir. An empty dir keeps everything in memory only.
func Open(dir string, maxMemory int) (*Store, error) {
	if maxMemory <= 0 {
		maxMemory = DefaultMaxMemory
	}
	s := &Store{dir: dir, maxMem: maxMemory, ids: map[string]uint64{}, checkpoints: map[string]tail.Checkpoint{}, changed: make(chan struct{}), first: 1}
	if dir == "" {
		s.meta = newMeta()
		return s, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("could not make the index folder: %w", err)
	}
	reason, err := s.load()
	if err != nil {
		return nil, err
	}
	if reason != "" {
		s.rebuilt = reason
		if err := s.reset(); err != nil {
			return nil, err
		}
	}
	seg, err := os.OpenFile(filepath.Join(dir, "events.log"), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("could not open the index log: %w", err)
	}
	s.seg = seg
	return s, nil
}

func newMeta() Meta {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic("no randomness: " + err.Error())
	}
	return Meta{Format: Format, Generation: hex.EncodeToString(b), CreatedAt: time.Now().UTC().Format(time.RFC3339),
		RedactionVersion: redact.Version, EventVersion: event.Version}
}

// load reads an existing index. It returns a reason when the index must be started again.
func (s *Store) load() (string, error) {
	data, err := os.ReadFile(filepath.Join(s.dir, "meta.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return "new", nil
	}
	if err != nil {
		return "", fmt.Errorf("could not read the index metadata: %w", err)
	}
	var meta Meta
	if json.Unmarshal(data, &meta) != nil || !event.ValidGeneration(meta.Generation) {
		return "metadata unreadable", nil
	}
	switch {
	case meta.Format != Format:
		return "index format changed", nil
	case meta.RedactionVersion != redact.Version:
		return "redaction rules changed", nil
	case meta.EventVersion != event.Version:
		return "event version changed", nil
	}
	s.meta = meta
	if reason, err := s.loadLog(); reason != "" || err != nil {
		return reason, err
	}
	if data, err := os.ReadFile(filepath.Join(s.dir, "checkpoints.json")); err == nil {
		if json.Unmarshal(data, &s.checkpoints) != nil {
			return "checkpoints unreadable", nil
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	} else if s.head > 0 {
		return "checkpoints missing", nil
	}
	return "", nil
}

// loadLog reads events.log. A torn or unreadable last line (a crash during append) is cut off; an
// unreadable line anywhere else, or positions out of order, mean the index is started again.
func (s *Store) loadLog() (string, error) {
	path := filepath.Join(s.dir, "events.log")
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<16)
	var good int64
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' {
			var ev event.Event
			if json.Unmarshal(line, &ev) != nil {
				if _, peekErr := r.Peek(1); peekErr == io.EOF {
					break // the last line is unreadable: treat as torn
				}
				return "index log corrupt", nil
			}
			c, perr := event.ParseCursor(ev.Cursor)
			if perr != nil || c.Generation != s.meta.Generation || c.Position != s.head+1 {
				return "index log out of order", nil
			}
			ev.Position = c.Position
			s.push(Entry{Event: &ev, Raw: bytes.TrimRight(line, "\n")})
			good += int64(len(line))
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}
	if info, err := f.Stat(); err == nil && info.Size() > good {
		if err := os.Truncate(path, good); err != nil {
			return "", fmt.Errorf("could not cut a torn line from the index log: %w", err)
		}
	}
	return "", nil
}

// reset starts a new generation: it removes the three named files and writes fresh metadata.
// It never removes anything else.
func (s *Store) reset() error {
	for _, name := range []string{"events.log", "checkpoints.json", "meta.json"} {
		if err := os.Remove(filepath.Join(s.dir, name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	s.meta = newMeta()
	s.entries, s.first, s.head = nil, 1, 0
	s.ids = map[string]uint64{}
	s.checkpoints = map[string]tail.Checkpoint{}
	data, _ := json.MarshalIndent(s.meta, "", "  ")
	return writeAtomic(filepath.Join(s.dir, "meta.json"), append(data, '\n'))
}

func (s *Store) push(e Entry) {
	if len(s.entries) == 0 {
		s.first = e.Event.Position
	}
	s.entries = append(s.entries, e)
	s.head = e.Event.Position
	s.ids[e.Event.ID] = e.Event.Position
	if over := len(s.entries) - s.maxMem; over > 0 {
		for _, old := range s.entries[:over] {
			delete(s.ids, old.Event.ID)
		}
		if cap(s.entries) > 2*s.maxMem {
			s.entries = append([]Entry(nil), s.entries[over:]...)
		} else {
			s.entries = s.entries[over:]
		}
		s.first += uint64(over)
	}
}

// Generation is this index's generation.
func (s *Store) Generation() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.meta.Generation
}

// Checkpoints returns a copy of the persisted source positions.
func (s *Store) Checkpoints() map[string]tail.Checkpoint {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]tail.Checkpoint, len(s.checkpoints))
	for k, v := range s.checkpoints {
		out[k] = v
	}
	return out
}

// Append adds events that are not already held (by ID), persists them, then persists the
// checkpoints, then makes them visible and wakes every reader. It returns how many were added.
func (s *Store) Append(batch []*event.Event, checkpoints map[string]tail.Checkpoint) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0, errors.New("the store is closed")
	}
	var buf bytes.Buffer
	var fresh []Entry
	seen := map[string]bool{}
	next := s.head
	for _, ev := range batch {
		if _, dup := s.ids[ev.ID]; dup || seen[ev.ID] {
			s.dupes++
			continue
		}
		seen[ev.ID] = true
		next++
		ev.Position = next
		ev.Cursor = event.Cursor{Generation: s.meta.Generation, Position: next}.String()
		raw, err := json.Marshal(ev)
		if err != nil {
			return 0, err
		}
		buf.Write(raw)
		buf.WriteByte('\n')
		fresh = append(fresh, Entry{Event: ev, Raw: raw})
	}
	if s.seg != nil {
		if buf.Len() > 0 {
			if _, err := s.seg.Write(buf.Bytes()); err != nil {
				return 0, fmt.Errorf("could not append to the index log: %w", err)
			}
			if err := s.seg.Sync(); err != nil {
				return 0, fmt.Errorf("could not sync the index log: %w", err)
			}
		}
		if len(checkpoints) > 0 {
			merged := make(map[string]tail.Checkpoint, len(s.checkpoints)+len(checkpoints))
			for k, v := range s.checkpoints {
				merged[k] = v
			}
			for k, v := range checkpoints {
				merged[k] = v
			}
			data, err := json.Marshal(merged)
			if err != nil {
				return 0, err
			}
			if err := writeAtomic(filepath.Join(s.dir, "checkpoints.json"), data); err != nil {
				return 0, fmt.Errorf("could not save the checkpoints: %w", err)
			}
			s.checkpoints = merged
		}
	} else {
		for k, v := range checkpoints {
			s.checkpoints[k] = v
		}
	}
	for _, e := range fresh {
		s.push(e)
	}
	if len(fresh) > 0 {
		close(s.changed)
		s.changed = make(chan struct{})
	}
	return len(fresh), nil
}

// Changed returns a channel that is closed at the next append. Take it before reading, so an
// append between the read and the wait is never missed.
func (s *Store) Changed() <-chan struct{} {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.changed
}

// Bounds returns the floor and head positions. A cursor at the floor has missed nothing still held.
func (s *Store) Bounds() (floor, head uint64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.floorLocked(), s.head
}

func (s *Store) floorLocked() uint64 {
	if len(s.entries) == 0 {
		return s.head
	}
	return s.first - 1
}

// After returns up to limit entries after position c.
func (s *Store) After(c uint64, limit int) ([]Entry, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if c > s.head {
		return nil, ErrFuture
	}
	if c < s.floorLocked() {
		return nil, ErrExpired
	}
	if c == s.head {
		return nil, nil
	}
	start := int(c + 1 - s.first)
	end := min(start+limit, len(s.entries))
	return append([]Entry(nil), s.entries[start:end]...), nil
}

// Info summarises the store.
func (s *Store) Info() Info {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return Info{Generation: s.meta.Generation, Head: s.head, Floor: s.floorLocked(), InMemory: len(s.entries),
		Persisted: s.seg != nil, Rebuilt: s.rebuilt, Duplicates: s.dupes}
}

// Close closes the log file. Readers see no further appends.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	if s.seg != nil {
		return s.seg.Close()
	}
	return nil
}

// writeAtomic writes a temporary file in the same folder, syncs it and renames it over path.
func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
