package store

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
	"mach/observer/internal/tail"
)

// Format is the on-disk layout version. 2: numbered segments. 3: events in their compact form
// (event.MarshalCompact), expanded to the full envelope when read.
const Format = 3

// Defaults.
const (
	DefaultMaxMemory = 50000
	// DefaultHotRaw: of the memory window, only the most recent this many events keep their
	// served envelope in memory; older ones keep their index fields and where their line is on
	// disk, and are read back from it (one positioned read) when asked for. The window's bytes
	// were most of the observer's steady memory (R3 of the M6.2 re-check: 98 MB of 176 MB live).
	DefaultHotRaw       = 16384
	DefaultSegmentBytes = 64 << 20
	DefaultRetainBytes  = 512 << 20
	sparseEvery         = 1024
)

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
	EventRevision    int    `json:"event_revision"`
}

// Entry is one stored event: its index fields (event.Slim: id, position, order, ticket,
// execution, entities, kind, content hash) and its full version 3 envelope, made once. Event is
// not the whole event: decode Raw for that.
type Entry struct {
	Event *event.Head
	Raw   []byte
	loc   diskLoc
}

// diskLoc is where an event's compact line is: its segment's number, offset and length (no
// newline). seg 0: not on disk (a store kept in memory only).
type diskLoc struct {
	seg, n int32
	off    int64
}

// Info summarises the store.
type Info struct {
	Generation string `json:"generation"`
	Head       uint64 `json:"head"`
	Floor      uint64 `json:"floor"`
	InMemory   int    `json:"in_memory"`
	Persisted  bool   `json:"persisted"`
	Rebuilt    string `json:"rebuilt,omitempty"`
	Duplicates int64  `json:"duplicates"`
	Segments   int    `json:"segments"`
	DiskBytes  int64  `json:"disk_bytes"`
	Dropped    int64  `json:"dropped_segments"`
	MaxOrder   string `json:"max_order,omitempty"`
}

// Options configure a store.
type Options struct {
	MaxMemory    int   // events held in memory (and indexed by ticket, execution and entity)
	HotRaw       int   // of those, the most recent this many keep their envelope in memory (DefaultHotRaw)
	SegmentBytes int64 // a segment is closed when it grows past this
	RetainBytes  int64 // whole oldest segments are dropped while the total is above this
}

type segment struct {
	n           int
	path        string
	first, last uint64
	size        int64
	marks       []mark
}

type mark struct {
	pos    uint64
	offset int64
}

type held struct {
	pos uint64
}

// Store is safe for concurrent use: one writer (the ingest loop), many readers.
type Store struct {
	dir  string
	opts Options

	mu          sync.RWMutex
	meta        Meta
	entries     []Entry // contiguous: entries[i].Event.Pos == first+i
	first       uint64
	head        uint64
	ids         map[string]held
	byTicket    map[string][]uint64
	byExec      map[string][]uint64
	byEntity    map[string][]uint64
	segs        []*segment
	cur         *os.File
	diskFloor   uint64
	checkpoints map[string]tail.Checkpoint
	changed     chan struct{}
	rebuilt     string
	dupes       int64
	dropped     int64
	maxOrder    string
	evictedMax  string // the largest order of any event that left the memory window
	watermark   int64
	byOrder     []orderRef // the memory window in history order (entries leave it lazily)
	orderBuf    []orderRef // appended out of order since the last merge
	series      seriesAgg  // counts per minute, by kind and authority, of everything indexed
	oidx        orderIndex // where on disk each minute of order time is (history beyond the memory window)
	closed      bool
}

// Open opens or creates the index in dir with default options. An empty dir keeps everything in
// memory only.
func Open(dir string, maxMemory int) (*Store, error) {
	return OpenWith(dir, Options{MaxMemory: maxMemory})
}

// OpenWith opens or creates the index with options.
func OpenWith(dir string, opts Options) (*Store, error) {
	if opts.MaxMemory <= 0 {
		opts.MaxMemory = DefaultMaxMemory
	}
	if opts.SegmentBytes <= 0 {
		opts.SegmentBytes = DefaultSegmentBytes
	}
	if opts.HotRaw <= 0 {
		opts.HotRaw = DefaultHotRaw
	}
	if opts.RetainBytes <= 0 {
		opts.RetainBytes = DefaultRetainBytes
	}
	s := &Store{dir: dir, opts: opts, ids: map[string]held{}, byTicket: map[string][]uint64{}, byExec: map[string][]uint64{},
		byEntity: map[string][]uint64{}, checkpoints: map[string]tail.Checkpoint{}, changed: make(chan struct{}), first: 1}
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
	if err := s.openCurrent(); err != nil {
		return nil, err
	}
	return s, nil
}

func newMeta() Meta {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic("no randomness: " + err.Error())
	}
	return Meta{Format: Format, Generation: hex.EncodeToString(b), CreatedAt: time.Now().UTC().Format(time.RFC3339),
		RedactionVersion: redact.Version, EventVersion: event.Version, EventRevision: event.Revision}
}

var segmentRe = regexp.MustCompile(`^segment-([0-9]{6})\.log$`)

func (s *Store) segmentPath(n int) string {
	return filepath.Join(s.dir, fmt.Sprintf("segment-%06d.log", n))
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
	case meta.EventVersion != event.Version || meta.EventRevision != event.Revision:
		return "event version changed", nil
	}
	s.meta = meta
	if reason, err := s.loadSegments(); reason != "" || err != nil {
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

type posLine struct {
	Pos       uint64 `json:"pos"`
	Order     string `json:"order"`
	Type      string `json:"type"`
	Authority string `json:"authority"`
	Time      struct {
		OrderMS int64 `json:"order_ms"`
	} `json:"time"`
	IDs struct {
		TicketID    string `json:"ticket_id"`
		ExecutionID string `json:"execution_id"`
	} `json:"ids"`
}

// loadSegments scans every retained segment: positions must run on without a hole, a torn last
// line (a crash during append) is cut off, anything else unreadable starts the index again. The
// most recent MaxMemory events are decoded into memory.
func (s *Store) loadSegments() (string, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return "", err
	}
	var nums []int
	for _, e := range entries {
		if m := segmentRe.FindStringSubmatch(e.Name()); m != nil && e.Type().IsRegular() {
			n, _ := strconv.Atoi(m[1])
			nums = append(nums, n)
		}
	}
	sort.Ints(nums)
	var expect uint64
	for i, n := range nums {
		seg := &segment{n: n, path: s.segmentPath(n)}
		f, err := os.Open(seg.path)
		if err != nil {
			return "", err
		}
		r := bufio.NewReaderSize(f, 1<<20)
		var offset int64
		count := 0
		for {
			line, err := r.ReadBytes('\n')
			if len(line) > 0 && line[len(line)-1] == '\n' {
				var p posLine
				if json.Unmarshal(line, &p) != nil || p.Pos == 0 || (expect != 0 && p.Pos != expect+1) {
					if _, peek := r.Peek(1); peek == io.EOF && i == len(nums)-1 {
						break // a torn or unreadable last line
					}
					f.Close()
					return "index log corrupt", nil
				}
				if seg.first == 0 {
					seg.first = p.Pos
				}
				if count%sparseEvery == 0 {
					seg.marks = append(seg.marks, mark{pos: p.Pos, offset: offset})
				}
				count++
				seg.last, expect = p.Pos, p.Pos
				if p.Order > s.maxOrder {
					s.maxOrder = p.Order
				}
				s.series.add(p.Time.OrderMS, p.Type, p.Authority, p.IDs.TicketID, p.IDs.ExecutionID)
				s.oidx.add(p.Order, p.Pos, int32(n), offset, len(line))
				offset += int64(len(line))
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				f.Close()
				return "", err
			}
		}
		f.Close()
		if info, err := os.Stat(seg.path); err == nil && info.Size() > offset {
			if i != len(nums)-1 {
				return "index log corrupt", nil
			}
			if err := os.Truncate(seg.path, offset); err != nil {
				return "", fmt.Errorf("could not cut a torn line from the index log: %w", err)
			}
		}
		seg.size = offset
		if seg.first == 0 {
			if i == len(nums)-1 && i > 0 {
				seg.first = expect + 1
			} else if i != len(nums)-1 {
				return "index log corrupt", nil
			}
		}
		s.segs = append(s.segs, seg)
	}
	if len(s.segs) > 0 && s.segs[0].first > 0 {
		s.diskFloor = s.segs[0].first - 1
	}
	if s.diskFloor > 0 {
		// Retention dropped segments before this start: what they held is not known, so a window is
		// taken as complete only from the earliest order retained on (as the series counts do).
		for _, m := range s.oidx.keys {
			for _, c := range s.oidx.minutes[m] {
				if s.oidx.lostMax == "" || c.minOrder < s.oidx.lostMax {
					s.oidx.lostMax = c.minOrder
				}
			}
			if m >= 0 {
				break
			}
		}
	}
	s.head = expect
	if s.head == 0 {
		return "", nil
	}
	from := uint64(1)
	if s.head > uint64(s.opts.MaxMemory) {
		from = s.head - uint64(s.opts.MaxMemory) + 1
	}
	if from <= s.diskFloor {
		from = s.diskFloor + 1
	}
	if from > 1 {
		// Events before the memory window left it in an earlier run: the largest order they may
		// have (from the order index; at least as large as theirs) is what left the window.
		s.evictedMax = s.oidx.lostMax
		for _, list := range s.oidx.minutes {
			for _, c := range list {
				if c.lo < from && c.maxOrder > s.evictedMax {
					s.evictedMax = c.maxOrder
				}
			}
		}
	}
	got, err := s.readDisk(from-1, s.opts.MaxMemory+1)
	if err != nil {
		return "index log corrupt", nil
	}
	s.head = 0
	for _, e := range got {
		s.push(e)
	}
	s.head = expect
	return "", nil
}

// reset starts a new generation: it removes the index's own files (by exact name) and writes
// fresh metadata. It never removes anything else.
func (s *Store) reset() error {
	entries, _ := os.ReadDir(s.dir)
	for _, e := range entries {
		name := e.Name()
		if segmentRe.MatchString(name) || name == "events.log" || name == "checkpoints.json" || name == "meta.json" {
			if err := os.Remove(filepath.Join(s.dir, name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
	}
	s.meta = newMeta()
	s.entries, s.first, s.head, s.diskFloor, s.segs, s.maxOrder, s.evictedMax = nil, 1, 0, 0, nil, "", ""
	s.ids = map[string]held{}
	s.byTicket, s.byExec, s.byEntity = map[string][]uint64{}, map[string][]uint64{}, map[string][]uint64{}
	s.checkpoints = map[string]tail.Checkpoint{}
	s.byOrder, s.orderBuf, s.series, s.oidx = nil, nil, seriesAgg{}, orderIndex{}
	data, _ := json.MarshalIndent(s.meta, "", "  ")
	return writeAtomic(filepath.Join(s.dir, "meta.json"), append(data, '\n'))
}

func (s *Store) openCurrent() error {
	if len(s.segs) == 0 {
		s.segs = append(s.segs, &segment{n: 1, path: s.segmentPath(1), first: s.head + 1})
	}
	last := s.segs[len(s.segs)-1]
	f, err := os.OpenFile(last.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return fmt.Errorf("could not open the index log: %w", err)
	}
	s.cur = f
	return nil
}

func index(m map[string][]uint64, key string, pos uint64) {
	if key != "" {
		m[key] = append(m[key], pos)
	}
}

func (s *Store) push(e Entry) {
	if len(s.entries) == 0 {
		s.first = e.Event.Pos
	}
	s.entries = append(s.entries, e)
	s.head = e.Event.Pos
	s.ids[e.Event.ID] = held{pos: e.Event.Pos}
	index(s.byTicket, e.Event.IDs.TicketID, e.Event.Pos)
	index(s.byExec, e.Event.IDs.ExecutionID, e.Event.Pos)
	for _, ref := range e.Event.Entities {
		index(s.byEntity, ref, e.Event.Pos)
	}
	if e.Event.Order > s.maxOrder {
		s.maxOrder = e.Event.Order
	}
	s.indexOrder(e.Event.Order, e.Event.Pos)
	if over := len(s.entries) - s.opts.MaxMemory; over > 0 {
		for i, old := range s.entries[:over] {
			delete(s.ids, old.Event.ID)
			if old.Event.Order > s.evictedMax {
				s.evictedMax = old.Event.Order
			}
			s.entries[i] = Entry{} // the backing array outlives the window: let the bytes go
		}
		if cap(s.entries) > 2*s.opts.MaxMemory {
			s.entries = append([]Entry(nil), s.entries[over:]...)
		} else {
			s.entries = s.entries[over:]
		}
		s.first += uint64(over)
		if s.first%uint64(max(1, s.opts.MaxMemory/4)) < uint64(over) {
			s.trimIndexes()
		}
	}
	// The event leaving the hot tail keeps only where its line is (read back by fill).
	if i := len(s.entries) - 1 - s.opts.HotRaw; i >= 0 && s.entries[i].loc.seg > 0 {
		s.entries[i].Raw = nil
	}
}

// fill reads back the envelope of every entry that left the hot tail, from its line on disk
// (the caller holds the lock, so no segment is dropped meanwhile). The entries are copies: what
// is read is not kept.
func (s *Store) fill(out []Entry) error {
	var files map[int32]*os.File
	defer func() {
		for _, f := range files {
			f.Close()
		}
	}()
	for i := range out {
		if out[i].Raw != nil {
			continue
		}
		l := out[i].loc
		if l.seg <= 0 {
			return errors.New("an event's envelope is not held")
		}
		f := files[l.seg]
		if f == nil {
			var err error
			if f, err = os.Open(s.segmentPath(int(l.seg))); err != nil {
				return fmt.Errorf("could not read the index log: %w", err)
			}
			if files == nil {
				files = map[int32]*os.File{}
			}
			files[l.seg] = f
		}
		line := make([]byte, l.n)
		if _, err := f.ReadAt(line, l.off); err != nil {
			return fmt.Errorf("could not read the index log: %w", err)
		}
		e, err := s.expand(line)
		if err != nil {
			return err
		}
		if e.Event.Pos != out[i].Event.Pos {
			return errors.New("the index log does not match its memory window")
		}
		out[i].Raw = e.Raw
	}
	return nil
}

// expand turns a compact line from a segment into an entry with the served envelope.
func (s *Store) expand(compact []byte) (Entry, error) {
	var ev event.Event
	if err := json.Unmarshal(compact, &ev); err != nil {
		return Entry{}, err
	}
	ev.Cursor = event.Cursor{Generation: s.meta.Generation, Position: ev.Pos}.String()
	full, err := json.Marshal(&ev) // the compact form, expanded to the served envelope
	if err != nil {
		return Entry{}, err
	}
	return Entry{Event: ev.Slim(), Raw: full}, nil
}

// trimIndexes drops positions that left the memory window from the secondary indexes.
func (s *Store) trimIndexes() {
	kept := s.byOrder[:0]
	for _, r := range s.byOrder {
		if r.pos >= s.first {
			kept = append(kept, r)
		}
	}
	clear(s.byOrder[len(kept):])
	s.byOrder = kept
	buf := s.orderBuf[:0]
	for _, r := range s.orderBuf {
		if r.pos >= s.first {
			buf = append(buf, r)
		}
	}
	clear(s.orderBuf[len(buf):])
	s.orderBuf = buf
	for _, m := range []map[string][]uint64{s.byTicket, s.byExec, s.byEntity} {
		for k, list := range m {
			i := sort.Search(len(list), func(i int) bool { return list[i] >= s.first })
			switch {
			case i == len(list):
				delete(m, k)
			case i > 0:
				m[k] = append([]uint64(nil), list[i:]...)
			}
		}
	}
}

// Generation is this index's epoch (the contract's <epoch>; called generation in the design).
func (s *Store) Generation() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.meta.Generation
}

// Epoch is Generation.
func (s *Store) Epoch() string { return s.Generation() }

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

// Lookup returns the content hash of an event held in memory by id.
func (s *Store) Lookup(id string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	h, ok := s.ids[id]
	if !ok || h.pos < s.first {
		return "", false
	}
	return s.entries[h.pos-s.first].Event.ContentHash(), true // computed once, on demand
}

// MaxOrder is the largest history order key committed.
func (s *Store) MaxOrder() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.maxOrder
}

// SetWatermark records the order_ms up to which ingest asserts history is complete (contract 6.6).
func (s *Store) SetWatermark(ms int64) {
	s.mu.Lock()
	if ms > s.watermark {
		s.watermark = ms
	}
	s.mu.Unlock()
}

// Watermark is the live edge: the order_ms up to which history is complete, apart from late arrivals.
func (s *Store) Watermark() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.watermark
}

// Append adds events that are not already held (by id), persists them, then persists the
// checkpoints, then makes them visible and wakes every reader. It returns how many were added.
func (s *Store) Append(batch []*event.Event, checkpoints map[string]tail.Checkpoint) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0, errors.New("the store is closed")
	}
	var buf bytes.Buffer
	var fresh []Entry
	var sizes []int
	seen := map[string]bool{}
	next := s.head
	for _, ev := range batch {
		if _, dup := s.ids[ev.ID]; dup || seen[ev.ID] {
			s.dupes++
			continue
		}
		seen[ev.ID] = true
		next++
		ev.Pos = next
		ev.Cursor = event.Cursor{Generation: s.meta.Generation, Position: next}.String()
		raw, err := json.Marshal(ev)
		if err != nil {
			return 0, err
		}
		compact, err := ev.MarshalCompact()
		if err != nil {
			return 0, err
		}
		buf.Write(compact)
		buf.WriteByte('\n')
		sizes = append(sizes, len(compact)+1)
		fresh = append(fresh, Entry{Event: ev.Slim(), Raw: raw})
	}
	if s.cur != nil {
		if buf.Len() > 0 {
			if err := s.write(buf.Bytes(), fresh, sizes); err != nil {
				return 0, err
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
		s.series.add(e.Event.Time.OrderMS, e.Event.Type, e.Event.Authority, e.Event.IDs.TicketID, e.Event.IDs.ExecutionID)
	}
	if len(fresh) > 0 {
		close(s.changed)
		s.changed = make(chan struct{})
	}
	return len(fresh), nil
}

// write appends encoded lines to the current segment, syncs, keeps the sparse index, rolls to a
// new segment past the size bound and drops the oldest segments past the retention bound.
func (s *Store) write(data []byte, fresh []Entry, sizes []int) error {
	seg := s.segs[len(s.segs)-1]
	if _, err := s.cur.Write(data); err != nil {
		return fmt.Errorf("could not append to the index log: %w", err)
	}
	if err := s.cur.Sync(); err != nil {
		return fmt.Errorf("could not sync the index log: %w", err)
	}
	offset := seg.size
	count := 0
	if seg.last >= seg.first && seg.last != 0 {
		count = int(seg.last - seg.first + 1)
	}
	for i, e := range fresh {
		fresh[i].loc = diskLoc{seg: int32(seg.n), off: offset, n: int32(sizes[i] - 1)}
		if seg.first == 0 || count == 0 {
			seg.first = e.Event.Pos
		}
		if count%sparseEvery == 0 {
			seg.marks = append(seg.marks, mark{pos: e.Event.Pos, offset: offset})
		}
		count++
		seg.last = e.Event.Pos
		s.oidx.add(e.Event.Order, e.Event.Pos, int32(seg.n), offset, sizes[i])
		offset += int64(sizes[i])
	}
	seg.size = offset
	if seg.size < s.opts.SegmentBytes {
		return nil
	}
	if err := s.cur.Close(); err != nil {
		return err
	}
	next := &segment{n: seg.n + 1, path: s.segmentPath(seg.n + 1), first: seg.last + 1}
	f, err := os.OpenFile(next.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("could not start a new index segment: %w", err)
	}
	s.cur = f
	s.segs = append(s.segs, next)
	var total int64
	for _, g := range s.segs {
		total += g.size
	}
	for total > s.opts.RetainBytes && len(s.segs) > 1 {
		old := s.segs[0]
		if err := os.Remove(old.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		total -= old.size
		s.segs = s.segs[1:]
		s.diskFloor = old.last
		s.dropped++
		s.oidx.prune(s.diskFloor)
	}
	return nil
}

// Changed returns a channel that is closed at the next append. Take it before reading, so an
// append between the read and the wait is never missed.
func (s *Store) Changed() <-chan struct{} {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.changed
}

// Wait returns when the head is past after, or ctx ends.
func (s *Store) Wait(ctx context.Context, after uint64) error {
	for {
		ch := s.Changed()
		if _, head := s.Bounds(); head > after {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ch:
		}
	}
}

// Bounds returns the floor and head positions. A cursor at the floor has missed nothing still held.
func (s *Store) Bounds() (floor, head uint64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.floorLocked(), s.head
}

// Head is the newest position.
func (s *Store) Head() uint64 {
	_, head := s.Bounds()
	return head
}

func (s *Store) memFloor() uint64 {
	if len(s.entries) == 0 {
		return s.head
	}
	return s.first - 1
}

func (s *Store) floorLocked() uint64 {
	if s.cur != nil {
		return min(s.diskFloor, s.memFloor())
	}
	return s.memFloor()
}

// After returns up to limit entries after position c, in position order: from memory when the
// window holds them, else from the segments on disk.
func (s *Store) After(c uint64, limit int) ([]Entry, error) {
	if limit <= 0 {
		limit = 1
	}
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
	if c >= s.memFloor() {
		start := int(c + 1 - s.first)
		end := min(start+limit, len(s.entries))
		out := append([]Entry(nil), s.entries[start:end]...)
		if err := s.fill(out); err != nil {
			return nil, err
		}
		return out, nil
	}
	return s.readDisk(c, limit)
}

// readDisk reads up to limit entries after position c from the segments. The caller holds the lock.
func (s *Store) readDisk(c uint64, limit int) ([]Entry, error) {
	var out []Entry
	for _, seg := range s.segs {
		if seg.last <= c || seg.last == 0 {
			continue
		}
		var offset int64
		for _, m := range seg.marks {
			if m.pos <= c+1 {
				offset = m.offset
			}
		}
		f, err := os.Open(seg.path)
		if err != nil {
			return nil, err
		}
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			f.Close()
			return nil, err
		}
		r := bufio.NewReaderSize(f, 1<<16)
		at := offset
		for len(out) < limit {
			line, err := r.ReadBytes('\n')
			start := at
			at += int64(len(line))
			if len(line) > 0 && line[len(line)-1] == '\n' {
				raw := line[:len(line)-1]
				var p posLine
				if json.Unmarshal(raw, &p) == nil && p.Pos > c {
					e, err := s.expand(raw)
					if err != nil {
						f.Close()
						return nil, err
					}
					e.loc = diskLoc{seg: int32(seg.n), off: start, n: int32(len(raw))}
					out = append(out, e)
				}
			}
			if err != nil {
				break
			}
		}
		f.Close()
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

// Get returns an event held in memory by id.
func (s *Store) Get(id string) (Entry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	h, ok := s.ids[id]
	if !ok || h.pos < s.first {
		return Entry{}, false
	}
	out := []Entry{s.entries[h.pos-s.first]}
	if s.fill(out) != nil {
		return Entry{}, false
	}
	return out[0], true
}

// Query selects events after a position. Every filter set must match (an event matches Entity
// when it lists that reference). Within the memory window the ticket, execution and entity
// filters use indexes; outside it the segments are scanned, at most Scan events per call.
type Query struct {
	After      uint64
	Limit      int
	Ticket     string
	Execution  string
	Entity     string
	TypePrefix string
	Scan       int // events examined at most when no index applies (default 10,000)
}

// Page is a query's answer: the entries, the position scanned up to (the next After), and
// whether more may follow.
type Page struct {
	Entries []Entry
	Next    uint64
	More    bool
}

func (q Query) match(e *event.Head) bool {
	if q.Ticket != "" && e.IDs.TicketID != q.Ticket {
		return false
	}
	if q.Execution != "" && e.IDs.ExecutionID != q.Execution {
		return false
	}
	if q.TypePrefix != "" && (len(e.Type) < len(q.TypePrefix) || e.Type[:len(q.TypePrefix)] != q.TypePrefix) {
		return false
	}
	if q.Entity != "" {
		found := false
		for _, ref := range e.Entities {
			if ref == q.Entity {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// Run answers a query.
func (s *Store) Run(q Query) (Page, error) {
	if q.Limit <= 0 || q.Limit > 10000 {
		q.Limit = 1000
	}
	if q.Scan <= 0 {
		q.Scan = 10000
	}
	s.mu.RLock()
	if q.After > s.head {
		s.mu.RUnlock()
		return Page{}, ErrFuture
	}
	if q.After < s.floorLocked() {
		s.mu.RUnlock()
		return Page{}, ErrExpired
	}
	if q.After >= s.memFloor() {
		var list []uint64
		indexed := true
		switch {
		case q.Ticket != "":
			list = s.byTicket[q.Ticket]
		case q.Execution != "":
			list = s.byExec[q.Execution]
		case q.Entity != "":
			list = s.byEntity[q.Entity]
		default:
			indexed = false
		}
		if indexed {
			page := Page{Next: s.head}
			i := sort.Search(len(list), func(i int) bool { return list[i] > q.After })
			for ; i < len(list); i++ {
				pos := list[i]
				if pos < s.first {
					continue
				}
				e := s.entries[pos-s.first]
				if !q.match(e.Event) {
					continue
				}
				if len(page.Entries) == q.Limit {
					page.Next, page.More = page.Entries[len(page.Entries)-1].Event.Pos, true
					break
				}
				page.Entries = append(page.Entries, e)
			}
			err := s.fill(page.Entries)
			s.mu.RUnlock()
			if err != nil {
				return Page{}, err
			}
			return page, nil
		}
	}
	s.mu.RUnlock()
	page := Page{Next: q.After}
	scanned := 0
	for scanned < q.Scan {
		batch, err := s.After(page.Next, min(1000, q.Scan-scanned))
		if err != nil {
			return page, err
		}
		if len(batch) == 0 {
			return page, nil
		}
		for _, e := range batch {
			scanned++
			if q.match(e.Event) {
				if len(page.Entries) == q.Limit {
					page.More = true
					return page, nil
				}
				page.Entries = append(page.Entries, e)
			}
			page.Next = e.Event.Pos
		}
	}
	page.More = page.Next < s.Head()
	return page, nil
}

// ByTicket is Run with a ticket filter.
func (s *Store) ByTicket(ticket string, after uint64, limit int) (Page, error) {
	return s.Run(Query{After: after, Limit: limit, Ticket: ticket})
}

// ByExecution is Run with an execution filter.
func (s *Store) ByExecution(execution string, after uint64, limit int) (Page, error) {
	return s.Run(Query{After: after, Limit: limit, Execution: execution})
}

// ByEntity is Run with an entity reference filter ("cell:LOCAL-031", "agent:x…/a…").
func (s *Store) ByEntity(ref string, after uint64, limit int) (Page, error) {
	return s.Run(Query{After: after, Limit: limit, Entity: ref})
}

// HistoryQuery selects a window of history in ORDER (the `order` key), for replay and the
// Timeline (contract 14, "/history").
type HistoryQuery struct {
	FromOrder, ToOrder string   // [from, to); "" is open
	Entities           []string // any of these refs (none: all)
	Ticket, Execution  string   // ids.ticket_id, ids.execution_id
	TypePrefix         string
	Limit              int // default 1,000, at most MaxHistory
}

// MaxHistory is the most events one History call returns.
const MaxHistory = 5000

// HistoryPage is a window of history. Next is the FromOrder of the next page when More; a page
// never ends in the middle of events that share an order key. Complete is false when events of
// the window may no longer be held: dropped by retention from the segments (or, for a store kept
// in memory only, evicted from the memory window).
type HistoryPage struct {
	Entries  []Entry
	Next     string
	More     bool
	Complete bool
	Capped   bool // the page stopped early at HistoryScanCap lines read from disk (More is then true)
}

// orderRef is one memory-window event in the order index.
type orderRef struct {
	order string
	pos   uint64
}

// indexOrder notes an event for the order index. Events arrive mostly in history order, but a
// catch-up reads one source after another, so most of its events would land in the middle: they
// are buffered and merged in one pass when a history window is next read (sortOrder).
func (s *Store) indexOrder(order string, pos uint64) {
	if len(s.orderBuf) == 0 && (len(s.byOrder) == 0 || s.byOrder[len(s.byOrder)-1].order <= order) {
		s.byOrder = append(s.byOrder, orderRef{order, pos})
		return
	}
	s.orderBuf = append(s.orderBuf, orderRef{order, pos})
}

// sortOrder merges the buffered events into the order index (caller holds the write lock).
func (s *Store) sortOrder() {
	if len(s.orderBuf) == 0 {
		return
	}
	buf := s.orderBuf[:0]
	for _, r := range s.orderBuf {
		if r.pos >= s.first {
			buf = append(buf, r)
		}
	}
	less := func(a, b orderRef) bool { return a.order < b.order || a.order == b.order && a.pos < b.pos }
	sort.Slice(buf, func(i, j int) bool { return less(buf[i], buf[j]) })
	merged := make([]orderRef, 0, len(s.byOrder)+len(buf))
	i, j := 0, 0
	for i < len(s.byOrder) || j < len(buf) {
		switch {
		case j == len(buf) || i < len(s.byOrder) && !less(buf[j], s.byOrder[i]):
			if s.byOrder[i].pos >= s.first {
				merged = append(merged, s.byOrder[i])
			}
			i++
		default:
			merged = append(merged, buf[j])
			j++
		}
	}
	s.byOrder, s.orderBuf = merged, nil
}

// Info summarises the store.
func (s *Store) Info() Info {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var disk int64
	for _, g := range s.segs {
		disk += g.size
	}
	return Info{Generation: s.meta.Generation, Head: s.head, Floor: s.floorLocked(), InMemory: len(s.entries),
		Persisted: s.cur != nil, Rebuilt: s.rebuilt, Duplicates: s.dupes, Segments: len(s.segs), DiskBytes: disk,
		Dropped: s.dropped, MaxOrder: s.maxOrder}
}

// Close closes the log file. Readers see no further appends.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	if s.cur != nil {
		return s.cur.Close()
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
