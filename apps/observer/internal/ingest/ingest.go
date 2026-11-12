// Package ingest is the observer's one writer: it polls every source, normalises what is new,
// places it in the history order, enforces the allowlist and the scrubber, holds it for the
// settle window, and commits it to the store with the sources' new positions. It is the only
// goroutine that touches the tailers and normalisers. Nothing a browser does can slow it down:
// readers pull from the store.
//
// Sources (contract section 2): the intake log, each cell's lifecycle.jsonl (live, then from the
// cell's archive after cleanup), each execution's started.json / result.json / stream.jsonl, and
// .factory/archive/runs.jsonl. It reads only; it takes no lock MACH uses and runs no command.
//
// Restart: checkpoints are persisted with the events read up to them. On start every tailed
// source is read again from its beginning: lines at or before the committed checkpoint are
// normalised (to rebuild the normalisers' and the sequencer's state) and what they yield is
// discarded; later lines are new. So a restart neither repeats nor loses an event, and the ids
// and order keys are the ones a rebuild would give.
package ingest

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/normalize"
	"mach/observer/internal/redact"
	"mach/observer/internal/store"
	"mach/observer/internal/tail"
)

// Source paths, relative to the project root.
const (
	LedgerPath     = ".factory/intake/events.jsonl"
	LedgerJSON     = ".factory/intake/ledger.json"
	WorktreesPath  = ".factory/worktrees"
	ExecutionsPath = ".factory/local/executions"
	ArchivePath    = ".factory/archive"
	RunsPath       = ".factory/archive/runs.jsonl"
	HoldoutsPath   = ".factory/holdouts"
	LifecycleFile  = "lifecycle.jsonl"

	LedgerKey = "ledger"
	RunsKey   = "runs"
	cellKey   = "cell/"
	execKey   = "exec/"
	streamKey = "stream/"
	archKey   = "archive/"
)

// Checkpoint flags for sources read whole.
const (
	flagStarted  = 1 << iota // execution.process_started emitted
	flagEnded                // execution.process_ended emitted
	flagFinished             // the stream's closings emitted
	flagBegan                // history.began emitted for a cell without a lifecycle log
	flagArchive              // an archive was read
)

// DefaultSettle is the settle window W (contract 6.5).
const DefaultSettle = 1500 * time.Millisecond

// Options configure the loop.
type Options struct {
	Root    string // absolute project root
	Store   *store.Store
	PollMin time.Duration // the interval while sources are changing
	PollMax time.Duration // the interval when idle (the interval doubles up to this)
	Now     func() time.Time
	Logger  *log.Logger
	// Settle is how long a read event is held before it is committed, so events of several
	// sources arriving close together are committed in history order. 0 means DefaultSettle.
	Settle time.Duration
	// NoSettle commits every event at the tick that read it (tests).
	NoSettle bool
	// MaxPending bounds the events held in the settle window; past it they are committed at once.
	MaxPending int
	// StaleAfter: a running execution whose stream has not grown for this long is "stale".
	StaleAfter time.Duration
	// TickBudget: events one tick reads at most (0: TickBudget).
	TickBudget int
}

// SourceStat is one source's state, for the status endpoint. Only the key, the
// project-relative path and counts.
type SourceStat struct {
	Key    string `json:"key"`
	Path   string `json:"path"`
	State  string `json:"state"` // live, idle, stale, ended, unreadable
	Offset int64  `json:"offset"`
	// Size is the file's size when it was last read (nil while it is missing or refused), so
	// size - offset is how many bytes are still to be read.
	Size *int64 `json:"size"`
	// LastReadAt is when the file was last read (RFC 3339, "" before the first read). A tick that
	// reached its read budget leaves some sources unread, so this can be older than the last tick.
	LastReadAt string `json:"last_read_at,omitempty"`
	Lines      int64  `json:"lines"`
	Refused    int64  `json:"refused"`
	Duplicates int64  `json:"duplicates"`
	Oversized  int64  `json:"oversized"`
	Resets     int64  `json:"resets"`
	Gone       bool   `json:"gone"`
	Blocked    bool   `json:"blocked"`
	// For execution streams: the Claude Code version and whether the parser knows it.
	ClaudeVersion string           `json:"claude_code_version,omitempty"`
	StreamKnown   *bool            `json:"stream_observations,omitempty"`
	Unrecognised  map[string]int64 `json:"unrecognised,omitempty"`
}

// Stats is a snapshot of the loop's health.
type Stats struct {
	Ticks        int64        `json:"ticks"`
	LastTickAt   string       `json:"last_tick_at,omitempty"`
	LastTickMS   float64      `json:"last_tick_ms"`
	Errors       int64        `json:"errors"`
	LastError    string       `json:"last_error,omitempty"`
	IntervalMS   int64        `json:"interval_ms"`
	Sources      []SourceStat `json:"sources"`
	FactoryFound bool         `json:"factory_found"`
	Pending      int          `json:"pending"`
	Watermark    int64        `json:"watermark_ms"`
	Committed    int64        `json:"committed"`
	Late         int64        `json:"late"`
	// CatchingUp: the observer is still reading what was written before it started (or before an
	// index rebuild). Events committed meanwhile are backfill: delivered in read order, never late.
	CatchingUp   bool             `json:"catching_up"`
	Backfill     int64            `json:"backfill"`
	Duplicates   int64            `json:"duplicates"`
	Conflicts    int64            `json:"conflicts"`
	Suppressed   int64            `json:"replayed"`
	Redaction    redact.Counters  `json:"redaction"`
	Unrecognised map[string]int64 `json:"unrecognised"`
}

type kind int

const (
	kindLedger kind = iota
	kindCell
	kindStream
	kindRuns
)

type lineNorm interface {
	Line([]byte, normalize.Read) []*event.Event
	Key() string
}

type source struct {
	key       string
	kind      kind
	ticket    string
	execution string
	rel       string
	tailer    *tail.Tailer
	norm      lineNorm
	gen       string
	suppress  int64  // committed before a restart: replay and discard up to this line
	saved     string // the generation those lines belonged to
	lastLine  time.Time
	lastRead  time.Time // the last poll that found the file
	gone      bool
	// preexisting: found while catching up (it was there before the observer started); liveSeen:
	// a line written since has been read. Events derived from a preexisting source before any
	// live line (a stream's closings, a cell's history.began) are backfill too.
	preexisting, liveSeen bool

	// cells
	cellSize, cellMTime int64
	cellInfo            normalize.CellInfo
	cellStage           string
	mismatch            map[string]bool
	firstSeen           time.Time

	// executions
	stream             *normalize.Stream
	startedMS, endedMS int64
}

type pending struct {
	at     time.Time
	events []*event.Event
	cps    map[string]tail.Checkpoint
}

// Observer runs the loop.
type Observer struct {
	opts     Options
	identity *normalize.Identity
	seq      *normalize.Sequencer
	sources  map[string]*source
	records  map[string]tail.Checkpoint // exec/<x> and archive/<name>
	ledgerSz int64
	ledgerMT int64
	queue    []pending
	lastTick time.Time
	red      redact.Counters
	// catchingUp is true from start until a tick reads within its budget and every source has
	// read past what was in it when first looked at. Until then every event is backfill.
	catchingUp bool

	mu       sync.RWMutex
	stats    Stats
	interval time.Duration
}

// New makes the loop and resumes every source from the store's checkpoints.
func New(opts Options) *Observer {
	if opts.PollMin <= 0 {
		opts.PollMin = 150 * time.Millisecond
	}
	if opts.PollMax < opts.PollMin {
		opts.PollMax = time.Second
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Logger == nil {
		opts.Logger = log.New(io.Discard, "", 0)
	}
	if opts.Settle <= 0 {
		opts.Settle = DefaultSettle
	}
	if opts.NoSettle {
		opts.Settle = 0
	}
	if opts.MaxPending <= 0 {
		opts.MaxPending = 100000
	}
	if opts.TickBudget <= 0 {
		opts.TickBudget = TickBudget
	}
	if opts.StaleAfter <= 0 {
		opts.StaleAfter = time.Minute
	}
	o := &Observer{opts: opts, identity: normalize.NewIdentity(), seq: normalize.NewSequencer(), sources: map[string]*source{},
		records: map[string]tail.Checkpoint{}, interval: opts.PollMin, catchingUp: true}
	o.stats.CatchingUp = true
	o.stats.Unrecognised = map[string]int64{}
	for key, cp := range opts.Store.Checkpoints() {
		switch {
		case key == LedgerKey:
			o.resume(o.addSource(key, kindLedger, "", "", LedgerPath), cp)
		case key == RunsKey:
			o.resume(o.addSource(key, kindRuns, "", "", RunsPath), cp)
		case strings.HasPrefix(key, cellKey):
			if t, ok := normalize.Ticket(strings.TrimPrefix(key, cellKey)); ok {
				src := o.addSource(key, kindCell, t, "", WorktreesPath+"/"+t+"/"+LifecycleFile)
				o.resume(src, cp)
				src.tailer.CP.Flags = cp.Flags
			}
		case strings.HasPrefix(key, streamKey):
			if x, ok := normalize.ExecutionID(strings.TrimPrefix(key, streamKey)); ok {
				o.resume(o.addSource(key, kindStream, "", x, ExecutionsPath+"/"+x+"/stream.jsonl"), cp)
			}
		case strings.HasPrefix(key, execKey), strings.HasPrefix(key, archKey):
			o.records[key] = cp
		}
	}
	return o
}

// resume sets a source up to replay its committed lines.
func (o *Observer) resume(src *source, cp tail.Checkpoint) {
	src.suppress, src.saved = cp.LineNo, cp.Epoch
	src.gone = cp.Gone
}

func (o *Observer) addSource(key string, k kind, ticket, execution, rel string) *source {
	src := &source{key: key, kind: k, ticket: ticket, execution: execution, rel: rel, mismatch: map[string]bool{},
		tailer: tail.New(filepath.Join(o.opts.Root, filepath.FromSlash(rel)), tail.Checkpoint{Path: rel})}
	// A file first found after the catch-up was written while the observer was watching: all of
	// it is live.
	src.tailer.LiveFromStart = !o.catchingUp
	src.preexisting = o.catchingUp
	o.sources[key] = src
	return src
}

// realDir: the path exists and is a folder, not a link to one.
func realDir(p string) bool {
	info, err := os.Lstat(p)
	return err == nil && info.IsDir()
}

// readSmall reads a regular file of at most max bytes without following a link.
func readSmall(p string, max int64) ([]byte, os.FileInfo, bool) {
	info, err := os.Lstat(p)
	if err != nil || !info.Mode().IsRegular() || info.Size() > max {
		return nil, nil, false
	}
	b, ok := (normalize.DirFiles{Dir: filepath.Dir(p)}).Read(filepath.Base(p), max)
	return b, info, ok
}

func (o *Observer) abs(rel string) string { return filepath.Join(o.opts.Root, filepath.FromSlash(rel)) }

// tick state
type tickCtx struct {
	now, prev time.Time
	out       []*event.Event
	cps       map[string]tail.Checkpoint
	suppress  int64
	budget    int
	err       error
}

// TickBudget bounds the events one tick reads (Options.TickBudget, default this); the rest of a
// backlog is read by the next ticks, so memory stays bounded however much history is waiting.
const TickBudget = 20000

func (t *tickCtx) full() bool { return len(t.out)+int(t.suppress) >= t.budget }

func (t *tickCtx) read(line int64, live bool) normalize.Read {
	return normalize.Read{Line: line, At: t.now, Prev: t.prev, Live: live}
}

// emit places events in the history order (in the order a normaliser gave them), then runs the
// allowlist and the scrubber: the one place every event passes before it can be stored.
func (o *Observer) emit(t *tickCtx, evs []*event.Event, discard bool) {
	for _, ev := range evs {
		if ev == nil {
			continue
		}
		o.seq.Place(ev)
		if discard {
			t.suppress++
			continue
		}
		if !redact.Enforce(ev, &o.red) {
			continue
		}
		if missing := redact.MissingID(ev); missing != "" {
			// The record's identity did not survive the filters: say a record is unreadable here,
			// show nothing of it.
			o.red.Dropped++
			if ev.Origin.Stream != event.StreamObserver {
				g := invalidGap(ev, t.read(ev.Origin.Seq, false))
				g.Backfill = ev.Backfill
				o.emit(t, []*event.Event{g}, false)
			}
			continue
		}
		if o.catchingUp {
			ev.Backfill = true
		}
		if ev.Backfill && ev.Provenance == nil {
			// Catch-up is recorded where the envelope already has room for how an event came to be.
			ev.Provenance = &event.Provenance{Basis: []string{}, Rule: "backfill", Files: []string{}}
		}
		redact.ScrubEvent(ev, o.opts.Root, &o.red)
		ev.OrderBasis = nil
		ev.Tidy()
		t.out = append(t.out, ev)
	}
}

// Tick makes one pass over every source, commits what has settled, and returns how many events
// were committed.
func (o *Observer) Tick() (int, error) {
	now := o.opts.Now()
	t := &tickCtx{now: now, prev: o.lastTick, cps: map[string]tail.Checkpoint{}, budget: o.opts.TickBudget}
	o.lastTick = now
	factory := realDir(o.abs(".factory"))
	if factory {
		o.readLedgerJSON()
		o.pollLedger(t)
		o.pollCells(t)
		o.pollExecutions(t)
		o.pollRuns(t)
		o.pollArchives(t)
	}
	if len(t.out) > 0 || len(t.cps) > 0 {
		o.queue = append(o.queue, pending{at: now, events: t.out, cps: t.cps})
	}
	n, err := o.release(now)
	if o.catchingUp && !t.full() && o.caughtUp() {
		o.catchingUp = false
	}
	o.record(now, factory, errors.Join(t.err, err), t.suppress)
	return n, errors.Join(t.err, err)
}

// backfill: what the source yields now still describes history from before the observer started.
func (src *source) backfill() bool { return src.preexisting && !src.liveSeen }

func markBackfill(evs []*event.Event) []*event.Event {
	for _, ev := range evs {
		if ev != nil {
			ev.Backfill = true
		}
	}
	return evs
}

// caughtUp: every tailed source has read past what was in it when it was first looked at.
func (o *Observer) caughtUp() bool {
	for _, src := range o.sources {
		if !src.tailer.CaughtUp() {
			return false
		}
	}
	return true
}

// Flush commits everything held, whatever its age (shutdown, tests).
func (o *Observer) Flush() (int, error) {
	return o.release(o.opts.Now().Add(24 * time.Hour))
}

func (o *Observer) readLedgerJSON() {
	p := o.abs(LedgerJSON)
	info, err := os.Lstat(p)
	if err != nil || !info.Mode().IsRegular() || info.Size() == o.ledgerSz && info.ModTime().UnixNano() == o.ledgerMT {
		return
	}
	if b, _, ok := readSmall(p, 64<<20); ok {
		o.identity.ReadLedger(b)
		o.ledgerSz, o.ledgerMT = info.Size(), info.ModTime().UnixNano()
	}
}

// pollTailed reads one tailed source: notes (rewritten, truncated), then lines, through the
// source's normaliser, created per file generation.
func (o *Observer) pollTailed(t *tickCtx, src *source, make func(gen string) lineNorm) int {
	before := src.tailer.CP
	lines, notes, err := src.tailer.Poll()
	if err != nil {
		t.err = errors.Join(t.err, errors.New("could not read "+src.rel))
	} else if src.tailer.Size >= 0 {
		src.lastRead = t.now
	}
	for _, n := range notes {
		reason := map[string]string{tail.NoteReset: "rewritten", tail.NoteTruncated: "truncated"}[n.Kind]
		if reason == "" || src.norm == nil {
			continue
		}
		key := src.norm.Key()
		g := gapFor(key, reason, before.Resets+1, t.read(before.LineNo, false))
		o.emit(t, []*event.Event{g}, false)
		if n.Kind == tail.NoteTruncated {
			src.suppress, src.saved = before.LineNo, before.Epoch // read again, discard what was read
		} else {
			src.suppress, src.saved = 0, "" // another history: read it whole
		}
		src.norm = nil
	}
	for _, line := range lines {
		cp := &src.tailer.CP
		if src.norm == nil || src.gen != cp.Epoch {
			if src.saved != "" && src.saved != cp.Epoch {
				// A restart found another file than the one committed: say so, read the new one whole.
				o.emit(t, []*event.Event{gapFor(partitionOf(src, src.saved), "rewritten", cp.Resets+1, t.read(src.suppress, false))}, false)
				src.suppress, src.saved = 0, ""
			}
			src.gen = cp.Epoch
			src.norm = make(cp.Epoch)
		}
		discard := line.Number <= src.suppress && cp.Epoch == src.saved
		evs := src.norm.Line(line.Bytes, t.read(line.Number, line.Live))
		if line.Live {
			src.liveSeen = true
		} else {
			markBackfill(evs)
		}
		o.emit(t, evs, discard)
		src.lastLine = t.now
	}
	if src.tailer.CP != before {
		cp := src.tailer.CP
		t.cps[src.key] = cp
	}
	return len(lines)
}

func partitionOf(src *source, gen string) string {
	switch src.kind {
	case kindLedger:
		return event.IntakeKey(gen)
	case kindCell:
		return event.CellKey(src.ticket, gen)
	case kindStream:
		return event.StreamKey(src.execution)
	}
	return event.RunKey(gen)
}

func gapFor(key, reason string, n int64, r normalize.Read) *event.Event {
	ev := &event.Event{Type: "history.gap", Authority: event.Reconstructed,
		Origin:     event.Origin{Stream: event.StreamObserver, Key: event.ObserverKey, Writer: "observer"},
		ID:         event.ObserverID("gap", key+":"+reason+"-"+itoa(n)),
		Provenance: &event.Provenance{Basis: []string{}, Rule: "gap:" + reason, Files: []string{}},
		Data:       map[string]any{"source_key": key, "from_seq": nil, "to_seq": nil, "reason": reason, "count": nil}}
	ev.Time.ObservedAt = normalize.Stamp(r.At)
	ev.Time.Precision = event.PrecisionUnknown
	ev.AnchorKey, ev.AnchorSeq = key, r.Line
	return ev
}

// invalidGap stands for a source record whose required identities were not usable.
func invalidGap(ev *event.Event, r normalize.Read) *event.Event {
	part := 0
	if ev.Origin.Part != nil {
		part = *ev.Origin.Part
	}
	g := gapFor(ev.Origin.Key, "unparsable-line", 0, r)
	g.ID = event.ObserverID("gap", ev.Origin.Key+":invalid-"+itoa(ev.Origin.Seq)+"."+itoa(int64(part)))
	g.Data["from_seq"], g.Data["to_seq"], g.Data["count"] = nullSeq(ev.Origin.Seq), nullSeq(ev.Origin.Seq), int64(1)
	g.AnchorKey, g.AnchorSeq = ev.Origin.Key, ev.Origin.Seq
	return g
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// hasher is SHA-256 with its hex sum.
type hasher struct{ h hash.Hash }

func newHasher() *hasher                      { return &hasher{h: sha256.New()} }
func (h *hasher) Write(p []byte) (int, error) { return h.h.Write(p) }
func (h *hasher) sum() string                 { return hex.EncodeToString(h.h.Sum(nil)) }

// limitedBuffer keeps at most max bytes and remembers whether more were written.
type limitedBuffer struct {
	b    []byte
	max  int
	over bool
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if len(l.b)+len(p) > l.max {
		l.over = true
		l.b = nil
		return len(p), nil
	}
	if !l.over {
		l.b = append(l.b, p...)
	}
	return len(p), nil
}

func (o *Observer) pollLedger(t *tickCtx) {
	src := o.sources[LedgerKey]
	if src == nil {
		src = o.addSource(LedgerKey, kindLedger, "", "", LedgerPath)
	}
	// The intake log is read to its end first, so every other source sees its identities.
	for i := 0; i < 16 && !t.full(); i++ {
		if o.pollTailed(t, src, func(gen string) lineNorm { return normalize.NewLedger(gen, o.opts.Root, o.identity) }) == 0 {
			break
		}
	}
}

func (o *Observer) pollRuns(t *tickCtx) {
	if t.full() {
		return
	}
	src := o.sources[RunsKey]
	if src == nil {
		src = o.addSource(RunsKey, kindRuns, "", "", RunsPath)
	}
	o.pollTailed(t, src, func(gen string) lineNorm { return normalize.NewRuns(gen, o.opts.Root, o.identity) })
}

func (o *Observer) holdouts(ticket string) []string {
	dir := o.abs(HoldoutsPath + "/" + ticket)
	if !realDir(dir) {
		return nil
	}
	var out []string
	for _, name := range (normalize.DirFiles{Dir: dir}).List(".") {
		out = append(out, normalize.HoldoutID(name))
	}
	return out
}

func (o *Observer) pollCells(t *tickCtx) {
	dir := o.abs(WorktreesPath)
	if !realDir(dir) {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	present := map[string]bool{}
	for _, e := range entries {
		if !e.IsDir() || e.Type()&fs.ModeSymlink != 0 {
			continue
		}
		ticket, ok := normalize.Ticket(e.Name())
		if !ok {
			continue
		}
		present[ticket] = true
		key := cellKey + ticket
		src := o.sources[key]
		if src != nil && src.gone {
			// The cell came back: a new incarnation. Its file is a new generation.
			delete(o.sources, key)
			src = nil
		}
		if src == nil {
			src = o.addSource(key, kindCell, ticket, "", WorktreesPath+"/"+ticket+"/"+LifecycleFile)
		}
		if !t.full() {
			o.pollCell(t, src)
		}
	}
	for key, src := range o.sources {
		if src.kind == kindCell && !present[src.ticket] && !src.gone {
			src.gone = true
			cp := src.tailer.CP
			cp.Gone = true
			src.tailer.CP = cp
			t.cps[key] = cp
		}
	}
}

func (o *Observer) pollCell(t *tickCtx, src *source) {
	cellDir := o.abs(WorktreesPath + "/" + src.ticket)
	if info, err := os.Lstat(filepath.Join(cellDir, "cell.json")); err == nil && info.Mode().IsRegular() &&
		(info.Size() != src.cellSize || info.ModTime().UnixNano() != src.cellMTime) {
		if b, _, ok := readSmall(filepath.Join(cellDir, "cell.json"), 4<<20); ok {
			src.cellInfo = normalize.ParseCell(b)
			src.cellSize, src.cellMTime = info.Size(), info.ModTime().UnixNano()
			src.cellStage = src.cellInfo.Stage
			o.identity.LearnProduct(src.ticket, src.cellInfo.Product)
		}
	}
	files := normalize.DirFiles{Dir: cellDir}
	n := o.pollTailed(t, src, func(gen string) lineNorm {
		l := normalize.NewLifecycle(src.ticket, gen, o.opts.Root, o.identity)
		l.Files, l.Holdouts = files, o.holdouts
		src.mismatch = map[string]bool{}
		return l
	})
	life, _ := src.norm.(*normalize.Lifecycle)
	cp := &src.tailer.CP
	// A cell with no lifecycle log: its history begins here, from cell.json (contract 8).
	if src.firstSeen.IsZero() {
		src.firstSeen = t.now
	}
	if life == nil && cp.Ino == 0 && cp.Flags&flagBegan == 0 && src.cellInfo.Present && t.now.Sub(src.firstSeen) >= 2*time.Second {
		if _, err := os.Lstat(filepath.Join(cellDir, LifecycleFile)); errors.Is(err, fs.ErrNotExist) {
			began := []*event.Event{normalize.Began(src.ticket, "no-lifecycle-log", src.cellInfo, o.identity, t.read(0, true), []string{"cell.json"})}
			if src.preexisting {
				markBackfill(began)
			}
			o.emit(t, began, false)
			cp.Flags |= flagBegan
			t.cps[src.key] = *cp
		}
	}
	// Lost lifecycle writes leave no gap; compare the stage the log implies with cell.json's
	// once the log has been quiet for the settle window and cell.json is newer (contract 6.5).
	if life != nil && n == 0 && src.cellStage != "" && t.now.Sub(src.lastLine) > o.opts.Settle {
		if info, err := os.Lstat(src.tailer.Abs); err == nil && src.cellMTime > info.ModTime().UnixNano() {
			if ev := life.StateMismatch(src.cellStage, t.read(cp.LineNo, true)); ev != nil && !src.mismatch[ev.ID] {
				src.mismatch[ev.ID] = true
				o.emit(t, []*event.Event{ev}, false)
			}
		}
	}
}

func (o *Observer) pollExecutions(t *tickCtx) {
	dir := o.abs(ExecutionsPath)
	if !realDir(dir) || !realDir(o.abs(".factory/local")) {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || e.Type()&fs.ModeSymlink != 0 {
			continue
		}
		x, ok := normalize.ExecutionID(e.Name())
		if !ok || t.full() {
			continue
		}
		o.pollExecution(t, x)
	}
}

func (o *Observer) pollExecution(t *tickCtx, x string) {
	rel := ExecutionsPath + "/" + x
	key := execKey + x
	rec := o.records[key]
	rec.Path = rel
	before := rec
	src := o.sources[streamKey+x]
	if src == nil {
		src = o.addSource(streamKey+x, kindStream, "", x, rel+"/stream.jsonl")
	}
	if src.startedMS == 0 {
		if b, _, ok := readSmall(o.abs(rel+"/started.json"), 64<<10); ok {
			src.startedMS, _ = normalize.StartedMS(b)
			if rec.Flags&flagStarted == 0 {
				o.emit(t, []*event.Event{normalize.ExecutionStarted(x, b, o.identity, t.read(1, true))}, false)
				rec.Flags |= flagStarted
			}
		}
	}
	if src.endedMS == 0 {
		if b, _, ok := readSmall(o.abs(rel+"/result.json"), 64<<10); ok {
			src.endedMS, _ = normalize.EndedMS(b)
			if src.endedMS == 0 {
				src.endedMS = -1 // ended, time unknown
			}
			if rec.Flags&flagEnded == 0 {
				o.emit(t, []*event.Event{normalize.ExecutionEnded(x, b, o.identity, t.read(2, true))}, false)
				rec.Flags |= flagEnded
			}
		}
	}
	times := func(s *normalize.Stream) {
		s.StartedMS = src.startedMS
		if src.endedMS > 0 {
			s.EndedMS = src.endedMS
		}
	}
	if src.stream != nil {
		times(src.stream)
	}
	n := o.pollTailed(t, src, func(string) lineNorm {
		s := normalize.NewStream(x, o.opts.Root, o.identity)
		s.StderrBudget = func() bool { return o.stderrBudget(rel) }
		times(s)
		src.stream = s
		return s
	})
	// The process has ended and the stream is read to its end: close what is still open.
	if src.endedMS != 0 && n == 0 && rec.Flags&flagFinished == 0 {
		size := int64(-1)
		if info, err := os.Lstat(src.tailer.Abs); err == nil {
			size = info.Size()
		}
		if size < 0 || size == src.tailer.CP.Offset {
			if src.stream != nil {
				closing := src.stream.Finish(t.read(src.tailer.CP.LineNo, false))
				if src.backfill() {
					markBackfill(closing)
				}
				o.emit(t, closing, false)
			}
			rec.Flags |= flagFinished
		}
	}
	if rec != before {
		o.records[key] = rec
		t.cps[key] = rec
	}
}

// stderrBudget reads stderr.log for Claude Code's budget line only; nothing of it is kept.
func (o *Observer) stderrBudget(rel string) bool {
	b, _, ok := readSmall(o.abs(rel+"/stderr.log"), 4<<20)
	return ok && strings.Contains(string(b), "Budget limit reached")
}

// ---- archives ----

// MaxArchiveBytes bounds what is read from one archive (uncompressed).
const MaxArchiveBytes = 1 << 30

type archive struct {
	prefix    string
	files     *normalize.MemFiles
	lifecycle []byte
	hasLog    bool
}

// readArchive reads a cell archive read-only: gzip and tar from the standard library, regular
// members under one "<ticket>/" folder only, links and odd names refused, sizes bounded.
func readArchive(p string) (*archive, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	tr := tar.NewReader(io.LimitReader(gz, MaxArchiveBytes))
	a := &archive{files: normalize.NewMemFiles()}
	for count := 0; count < 200000; count++ {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		name := path.Clean(h.Name)
		prefix, rel, ok := strings.Cut(name, "/")
		if !ok || strings.HasPrefix(h.Name, "/") || strings.Contains(name, "..") {
			continue
		}
		if a.prefix == "" {
			a.prefix = prefix
		}
		if prefix != a.prefix {
			continue
		}
		h256 := newHasher()
		var keep []byte
		keepIt := rel == LifecycleFile || rel == "cell.json" || rel == "spec.json" || strings.HasPrefix(rel, "review/") && strings.HasSuffix(rel, ".json")
		var w io.Writer = h256
		buf := &limitedBuffer{max: 64 << 20}
		if keepIt {
			w = io.MultiWriter(h256, buf)
		}
		n, err := io.Copy(w, tr)
		if err != nil {
			return nil, err
		}
		a.files.Sums[rel], a.files.Sizes[rel] = h256.sum(), n
		if keepIt && !buf.over {
			keep = buf.b
			a.files.Bytes[rel] = keep
		}
		if rel == LifecycleFile && keep != nil {
			a.lifecycle, a.hasLog = keep, true
		}
	}
	return a, nil
}

func (o *Observer) pollArchives(t *tickCtx) {
	dir := o.abs(ArchivePath)
	if !realDir(dir) {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() || !strings.HasSuffix(name, ".tar.gz") || len(name) > 200 {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if t.full() {
			return
		}
		key := archKey + name
		rec := o.records[key]
		if rec.Flags&flagArchive != 0 && rec.Size == info.Size() && rec.MTime == info.ModTime().UnixNano() {
			continue
		}
		a, err := readArchive(filepath.Join(dir, name))
		if err != nil {
			t.err = errors.Join(t.err, errors.New("could not read "+ArchivePath+"/"+name))
			continue
		}
		ticket, ok := normalize.Ticket(a.prefix)
		if !ok {
			continue
		}
		if !o.catchUp(t, ticket, a) {
			continue // the live cell is still being read; the archive is read once it is gone
		}
		rec = tail.Checkpoint{Path: ArchivePath + "/" + name, Flags: flagArchive, Size: info.Size(), MTime: info.ModTime().UnixNano()}
		o.records[key] = rec
		t.cps[key] = rec
	}
}

// catchUp reads a cell's archived lifecycle log (contract 4.3 of the design): the same events as
// the live file gave get the same ids (same generation and lines) and are discarded; the lines
// written after the last poll, and cleanup's own records, are new. It returns false when the
// archive's log is the one a live cell source is still following.
func (o *Observer) catchUp(t *tickCtx, ticket string, a *archive) bool {
	live := o.sources[cellKey+ticket]
	if !a.hasLog {
		info := normalize.ParseCell(a.files.Bytes["cell.json"])
		if !info.Present || live != nil && !live.gone {
			return live == nil || live.gone
		}
		o.emit(t, []*event.Event{normalize.Began(ticket, "archive-only", info, o.identity, t.read(0, false), []string{"cell.json"})}, false)
		return true
	}
	first := a.lifecycle
	if i := strings.IndexByte(string(first), '\n'); i >= 0 {
		first = first[:i]
	}
	gen := event.Hash8([]byte(strings.TrimRight(string(first), "\r")))
	suppress := int64(0)
	if live != nil && live.tailer.CP.Epoch == gen {
		if !live.gone {
			return false
		}
		suppress = live.tailer.CP.LineNo
	}
	l := normalize.NewLifecycle(ticket, gen, o.opts.Root, o.identity)
	l.Files, l.Holdouts = a.files, o.holdouts
	lines := strings.Split(string(a.lifecycle), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	for i, line := range lines {
		n := int64(i + 1)
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		o.emit(t, l.Line([]byte(line), t.read(n, false)), n <= suppress)
	}
	return true
}

// ---- commit ----

// release commits every held event read at or before now − W, in history order, marking late
// ones, dropping duplicates and reporting conflicts.
func (o *Observer) release(now time.Time) (int, error) {
	cutoff := now.Add(-o.opts.Settle)
	total := 0
	for _, p := range o.queue {
		total += len(p.events)
	}
	k := 0
	for k < len(o.queue) && (!o.queue[k].at.After(cutoff) || total > o.opts.MaxPending) {
		total -= len(o.queue[k].events)
		k++
	}
	if k == 0 {
		o.setWatermark(now)
		return 0, nil
	}
	var events []*event.Event
	cps := map[string]tail.Checkpoint{}
	top := ""
	for _, p := range o.queue[:k] {
		events = append(events, p.events...)
		for key, cp := range p.cps {
			cps[key] = cp
		}
		for _, ev := range p.events {
			if ev.Order > top {
				top = ev.Order
			}
		}
	}
	// Events read later but sorting before what is committed now go with it, so whatever arrives
	// within the window is delivered in history order. Their sources' checkpoints stay where they
	// are until their own tick is committed (a crash re-reads them; their ids drop the repeat).
	remaining := make([][]*event.Event, len(o.queue))
	for i := k; i < len(o.queue); i++ {
		var rest []*event.Event
		for _, ev := range o.queue[i].events {
			if ev.Order < top {
				events = append(events, ev)
			} else {
				rest = append(rest, ev)
			}
		}
		remaining[i] = rest
	}
	seen := map[string]string{}
	var dupes int64
	kept := events[:0]
	var conflicts []*event.Event
	for _, ev := range events {
		h := ev.ContentHash()
		if prev, ok := seen[ev.ID]; ok {
			if prev != h {
				conflicts = append(conflicts, o.conflict(ev, now))
			}
			dupes++
			continue
		}
		if stored, ok := o.opts.Store.Lookup(ev.ID); ok {
			if stored != h {
				conflicts = append(conflicts, o.conflict(ev, now))
			}
			dupes++
			continue
		}
		seen[ev.ID] = h
		kept = append(kept, ev)
	}
	for _, c := range conflicts {
		if _, dup := seen[c.ID]; !dup {
			seen[c.ID] = c.ContentHash()
			kept = append(kept, c)
		}
	}
	sort.SliceStable(kept, func(i, j int) bool { return kept[i].Order < kept[j].Order })
	// Late (contract 6.5): delivered after an event that sorts after it. Backfill is never late:
	// catching up delivers older history in read order by nature, and says so in its provenance.
	max := o.opts.Store.MaxOrder()
	var late, backfill int64
	for _, ev := range kept {
		switch {
		case ev.Backfill:
			backfill++
		case ev.Order < max:
			ev.Late = true
			late++
		}
		if ev.Order > max {
			max = ev.Order
		}
	}
	n, err := o.opts.Store.Append(kept, cps)
	if err != nil {
		return 0, err // everything stays queued and is tried again next tick
	}
	for i := k; i < len(o.queue); i++ {
		o.queue[i].events = remaining[i]
	}
	o.queue = append([]pending(nil), o.queue[k:]...)
	o.mu.Lock()
	o.stats.Committed += int64(n)
	o.stats.Conflicts += int64(len(conflicts))
	o.stats.Late += late
	o.stats.Backfill += backfill
	o.stats.Duplicates += dupes
	o.mu.Unlock()
	o.setWatermark(now)
	return n, nil
}

// conflict: the same id with different content. The first is kept (contract 6.5).
func (o *Observer) conflict(ev *event.Event, now time.Time) *event.Event {
	g := gapFor(ev.Origin.Key, "conflict", 0, normalize.Read{At: now, Line: ev.Origin.Seq})
	g.ID = event.ObserverID("gap", "conflict:"+ev.ID)
	g.Data["from_seq"], g.Data["to_seq"], g.Data["count"] = nullSeq(ev.Origin.Seq), nullSeq(ev.Origin.Seq), int64(1)
	g.Provenance.Basis = []string{ev.ID}
	g.Time.OrderMS = ev.Time.OrderMS
	g.Order = event.OrderKey(ev.Time.OrderMS, 6, event.ObserverKey, ev.Origin.Seq, 9999)
	redact.Enforce(g, &o.red)
	return g
}

func nullSeq(n int64) any {
	if n <= 0 {
		return nil
	}
	return n
}

// setWatermark publishes the live edge: min(now − W, the earliest event still held).
func (o *Observer) setWatermark(now time.Time) {
	wm := now.Add(-o.opts.Settle).UnixMilli()
	for _, p := range o.queue {
		for _, ev := range p.events {
			if ev.Time.OrderMS < wm {
				wm = ev.Time.OrderMS
			}
		}
	}
	o.opts.Store.SetWatermark(wm)
	o.mu.Lock()
	o.stats.Watermark = o.opts.Store.Watermark()
	o.mu.Unlock()
}

func (o *Observer) record(started time.Time, factory bool, err error, suppressed int64) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.stats.Ticks++
	o.stats.LastTickAt = normalize.Stamp(started)
	o.stats.LastTickMS = float64(o.opts.Now().Sub(started).Microseconds()) / 1000
	o.stats.FactoryFound = factory
	o.stats.CatchingUp = o.catchingUp
	o.stats.Suppressed += suppressed
	o.stats.Redaction = o.red
	if err != nil {
		o.stats.Errors++
		o.stats.LastError = err.Error()
		o.opts.Logger.Printf("ingest: %v", err)
	} else {
		o.stats.LastError = "" // health reports the current state; the count keeps the history
	}
	pend := 0
	for _, p := range o.queue {
		pend += len(p.events)
	}
	o.stats.Pending = pend
	o.stats.Sources = o.stats.Sources[:0]
	unrec := map[string]int64{}
	for _, src := range o.sources {
		cp := src.tailer.CP
		st := SourceStat{Key: src.key, Path: cp.Path, Offset: cp.Offset, Lines: cp.Lines, Refused: cp.Refused, Duplicates: cp.Dupes,
			Oversized: cp.Oversize, Resets: cp.Resets, Gone: cp.Gone || src.gone, Blocked: cp.Blocked}
		if size := src.tailer.Size; size >= 0 && !st.Gone && !st.Blocked {
			st.Size = &size
		}
		if !src.lastRead.IsZero() {
			st.LastReadAt = normalize.Stamp(src.lastRead)
		}
		switch {
		case cp.Blocked:
			st.State = "unreadable"
		case src.gone || cp.Gone:
			st.State = "ended"
		case started.Sub(src.lastLine) < 10*time.Second:
			st.State = "live"
		default:
			st.State = "idle"
		}
		if src.kind == kindStream {
			rec := o.records[execKey+src.execution]
			switch {
			case rec.Flags&flagFinished != 0:
				st.State = "ended"
			case rec.Flags&flagStarted != 0 && !src.lastLine.IsZero() && started.Sub(src.lastLine) > o.opts.StaleAfter:
				st.State = "stale"
			}
			if s := src.stream; s != nil {
				v, ok := s.Version()
				st.ClaudeVersion, st.StreamKnown = v, &ok
				if len(s.Unrecognised) > 0 {
					st.Unrecognised = map[string]int64{}
					for k, n := range s.Unrecognised {
						st.Unrecognised[k] = n
						unrec[k] += n
					}
				}
			}
		}
		o.stats.Sources = append(o.stats.Sources, st)
	}
	o.stats.Unrecognised = unrec
	sort.Slice(o.stats.Sources, func(i, j int) bool { return o.stats.Sources[i].Key < o.stats.Sources[j].Key })
	o.stats.IntervalMS = o.interval.Milliseconds()
}

// Stats returns a copy of the loop's health.
func (o *Observer) Stats() Stats {
	o.mu.RLock()
	defer o.mu.RUnlock()
	s := o.stats
	s.Sources = append([]SourceStat(nil), o.stats.Sources...)
	return s
}

// Run polls until done closes. The interval is PollMin while anything changes and doubles to
// PollMax while nothing does, so an idle Factory costs a few stat calls a second. Held events
// are committed before it returns.
func (o *Observer) Run(done <-chan struct{}) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-done:
			o.Flush()
			return
		case <-timer.C:
		}
		n, _ := o.Tick()
		o.mu.Lock()
		if n > 0 || len(o.queue) > 0 {
			o.interval = o.opts.PollMin
		} else {
			o.interval = min(o.interval*2, o.opts.PollMax)
		}
		next := o.interval
		o.mu.Unlock()
		timer.Reset(next)
	}
}
