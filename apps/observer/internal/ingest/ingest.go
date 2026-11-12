// Package ingest is the observer's one writer: it polls every source, normalizes what is new,
// and appends it to the store with the sources' new positions. It is the only goroutine that
// touches the tailers. Nothing a browser does can slow it down: readers pull from the store.
package ingest

import (
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
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
	LedgerPath    = ".factory/intake/events.jsonl"
	WorktreesPath = ".factory/worktrees"
	LifecycleFile = "lifecycle.jsonl"
	LedgerKey     = "ledger"
	cellKeyPrefix = "cell/"
)

// Options configure the loop.
type Options struct {
	Root    string // absolute project root
	Store   *store.Store
	PollMin time.Duration // the interval while sources are changing
	PollMax time.Duration // the interval when idle (the interval doubles up to this)
	Now     func() time.Time
	Logger  *log.Logger
}

// SourceStat is one source's state, for the status endpoint. Only the key and counts.
type SourceStat struct {
	Key        string `json:"key"`
	Path       string `json:"path"`
	Offset     int64  `json:"offset"`
	LastSeq    int64  `json:"last_seq"`
	Lines      int64  `json:"lines"`
	Refused    int64  `json:"refused"`
	Duplicates int64  `json:"duplicates"`
	Oversized  int64  `json:"oversized"`
	Resets     int64  `json:"resets"`
	Gone       bool   `json:"gone"`
	Blocked    bool   `json:"blocked"`
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
}

type source struct {
	key       string
	ticket    string // cells only
	tailer    *tail.Tailer
	normalize func([]byte, normalize.Context) normalize.Result
}

// Observer runs the loop.
type Observer struct {
	opts    Options
	sources map[string]*source

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
	o := &Observer{opts: opts, sources: map[string]*source{}, interval: opts.PollMin}
	for key, cp := range opts.Store.Checkpoints() {
		switch {
		case key == LedgerKey:
			o.addLedger(cp)
		case strings.HasPrefix(key, cellKeyPrefix):
			if ticket, ok := redact.ID(strings.TrimPrefix(key, cellKeyPrefix)); ok {
				o.addCell(ticket, cp)
			}
		}
	}
	if _, ok := o.sources[LedgerKey]; !ok {
		o.addLedger(tail.Checkpoint{Path: LedgerPath})
	}
	return o
}

func (o *Observer) addLedger(cp tail.Checkpoint) {
	cp.Path = LedgerPath
	o.sources[LedgerKey] = &source{key: LedgerKey, tailer: tail.New(filepath.Join(o.opts.Root, LedgerPath), cp), normalize: normalize.Ledger}
}

func (o *Observer) addCell(ticket string, cp tail.Checkpoint) {
	rel := WorktreesPath + "/" + ticket + "/" + LifecycleFile
	cp.Path = rel
	o.sources[cellKeyPrefix+ticket] = &source{key: cellKeyPrefix + ticket, ticket: ticket,
		tailer: tail.New(filepath.Join(o.opts.Root, filepath.FromSlash(rel)), cp), normalize: normalize.Lifecycle}
}

// realDir: the path exists and is a folder, not a link to one.
func realDir(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir()
}

// discover adds a tailer for every cell folder that has appeared. It reads one directory.
func (o *Observer) discover() {
	dir := filepath.Join(o.opts.Root, WorktreesPath)
	if !realDir(filepath.Join(o.opts.Root, ".factory")) || !realDir(dir) {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || e.Type()&fs.ModeSymlink != 0 { // ReadDir does not follow links
			continue
		}
		ticket, ok := redact.ID(e.Name())
		if !ok {
			continue
		}
		if _, known := o.sources[cellKeyPrefix+ticket]; !known {
			o.addCell(ticket, tail.Checkpoint{})
		}
	}
}

// Tick makes one pass over every source and returns how many events it added.
func (o *Observer) Tick() (int, error) {
	started := o.opts.Now()
	factory := realDir(filepath.Join(o.opts.Root, ".factory"))
	if factory {
		o.discover()
	}
	keys := make([]string, 0, len(o.sources))
	for k := range o.sources {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { // the ledger first, then cells by ticket
		if (keys[i] == LedgerKey) != (keys[j] == LedgerKey) {
			return keys[i] == LedgerKey
		}
		return keys[i] < keys[j]
	})
	var batch []*event.Event
	prev := map[string]tail.Checkpoint{}
	changed := map[string]tail.Checkpoint{}
	var pollErr error
	for _, key := range keys {
		src := o.sources[key]
		before := src.tailer.CP
		prev[key] = before
		if src.ticket != "" && !realDir(filepath.Dir(src.tailer.Abs)) && !src.tailer.CP.Gone {
			// The cell folder is gone or became a link: do not open anything inside it.
			// DEPENDS ON archive catch-up (design 4.3): lines written after the last poll are in
			// .factory/archive/<ticket>.tar.gz; reading them back is not built yet.
			src.tailer.CP.Gone = before.Offset > 0 || before.Ino != 0
		} else if src.ticket == "" || realDir(filepath.Dir(src.tailer.Abs)) {
			lines, notes, err := src.tailer.Poll()
			if err != nil {
				pollErr = errors.Join(pollErr, errors.New("could not read "+src.tailer.CP.Path))
			}
			for _, n := range notes {
				if ev := o.note(src, n, started); ev != nil {
					batch = append(batch, ev)
				}
			}
			batch = append(batch, o.lines(src, lines, started)...)
		}
		if src.tailer.CP != before {
			changed[key] = src.tailer.CP
		}
	}
	added := 0
	if len(batch) > 0 || len(changed) > 0 {
		n, err := o.opts.Store.Append(batch, changed)
		if err != nil {
			// Nothing was made visible: put every source back where it was and try again next tick.
			for key, cp := range prev {
				o.sources[key].tailer.CP = cp
			}
			pollErr = errors.Join(pollErr, err)
		}
		added = n
	}
	o.record(started, factory, pollErr)
	return added, pollErr
}

func (o *Observer) lines(src *source, lines []tail.Line, now time.Time) []*event.Event {
	var out []*event.Event
	cp := &src.tailer.CP
	for _, line := range lines {
		if src.ticket != "" && line.Number <= cp.LastLine {
			cp.Dupes++ // a lifecycle line read again after a truncation: its position is its line
			continue
		}
		res := src.normalize(line.Bytes, normalize.Context{
			ProjectRoot: o.opts.Root, Epoch: cp.Epoch, Offset: line.Offset, Line: line.Number,
			ObservedAt: now, Live: line.Live, Ticket: src.ticket,
		})
		cp.LastLine = max(cp.LastLine, line.Number)
		if res.Event == nil {
			cp.Refused++
			continue
		}
		if res.Seq > 0 { // the intake log always has one; a lifecycle record may not
			if res.Seq <= cp.LastSeq {
				cp.Dupes++
				continue
			}
			// The intake log starts at 1; a lifecycle log's numbering is only checked between
			// two numbered records.
			if res.Seq > cp.LastSeq+1 && (cp.LastSeq > 0 || src.ticket == "") {
				out = append(out, o.gap(src, cp.LastSeq+1, res.Seq-1, now))
			}
			cp.LastSeq = res.Seq
		}
		out = append(out, res.Event)
	}
	return out
}

// partition is the contract's partition key for a source at a generation.
func (src *source) partition(epoch string) string {
	if src.ticket != "" {
		return event.CellPartition(src.ticket, epoch)
	}
	return event.LedgerPartition(epoch)
}

// gap reports source sequence numbers that never arrived (MACH's torn-line failure loses the
// torn record and the one appended onto it). Reconstructed: the observer inferred it.
func (o *Observer) gap(src *source, from, to int64, now time.Time) *event.Event {
	partition := src.partition(src.tailer.CP.Epoch)
	ev := o.observerEvent(src, now)
	ev.ID = event.GapID(partition, strconv.FormatInt(from, 10)+"-"+strconv.FormatInt(to, 10))
	ev.Data = map[string]any{"source_key": partition, "from_seq": from, "to_seq": to, "reason": "sequence", "count": to - from + 1}
	return ev
}

// note turns a change in a source file into a history gap where history may be missing or
// repeated (the file was cut short or rewritten). A file that vanished, was replaced with the
// same history, or became a link is source state, reported by /factory/status, not history.
func (o *Observer) note(src *source, n tail.Note, now time.Time) *event.Event {
	reason := map[string]string{tail.NoteReset: "rewritten", tail.NoteTruncated: "truncated"}[n.Kind]
	if reason == "" {
		return nil
	}
	partition := src.partition(n.OldEpoch)
	ev := o.observerEvent(src, now)
	ev.ID = event.GapID(partition, reason+"-"+strconv.FormatInt(src.tailer.CP.Resets, 10))
	ev.Data = map[string]any{"source_key": partition, "reason": reason}
	return ev
}

func (o *Observer) observerEvent(src *source, now time.Time) *event.Event {
	return &event.Event{
		V: event.Version, Type: "history.gap", Authority: event.Reconstructed,
		Source:     event.Source{Kind: event.KindObserver, Key: "o"},
		Subject:    event.Subject{TicketID: src.ticket, Actor: "observer"},
		OccurredAt: normalize.Stamp(now), Precision: "unknown", ObservedAt: normalize.Stamp(now), Live: true,
	}
}

func (o *Observer) record(started time.Time, factory bool, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.stats.Ticks++
	o.stats.LastTickAt = normalize.Stamp(started)
	o.stats.LastTickMS = float64(o.opts.Now().Sub(started).Microseconds()) / 1000
	o.stats.FactoryFound = factory
	if err != nil {
		o.stats.Errors++
		o.stats.LastError = err.Error()
		o.opts.Logger.Printf("ingest: %v", err)
	}
	o.stats.Sources = o.stats.Sources[:0]
	for _, src := range o.sources {
		cp := src.tailer.CP
		o.stats.Sources = append(o.stats.Sources, SourceStat{Key: src.key, Path: cp.Path, Offset: cp.Offset, LastSeq: cp.LastSeq,
			Lines: cp.Lines, Refused: cp.Refused, Duplicates: cp.Dupes, Oversized: cp.Oversize, Resets: cp.Resets, Gone: cp.Gone, Blocked: cp.Blocked})
	}
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

// Run polls until ctx ends. The interval is PollMin while anything changes and doubles to
// PollMax while nothing does, so an idle Factory costs a few stat calls a second.
func (o *Observer) Run(done <-chan struct{}) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-done:
			return
		case <-timer.C:
		}
		n, _ := o.Tick()
		o.mu.Lock()
		if n > 0 {
			o.interval = o.opts.PollMin
		} else {
			o.interval = min(o.interval*2, o.opts.PollMax)
		}
		next := o.interval
		o.mu.Unlock()
		timer.Reset(next)
	}
}
