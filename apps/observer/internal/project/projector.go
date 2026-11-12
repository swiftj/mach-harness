package project

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"sort"
	"sync"
	"time"

	"mach/observer/internal/feed"
	"mach/observer/internal/metrics"
)

// Defaults.
const (
	DefaultInterval       = 1000 // positions between in-memory checkpoints
	DefaultMaxCheckpoints = 64
	DefaultPersistEvery   = 5000 // positions between saved projections
)

// ErrNotHeld: a snapshot at that cursor cannot be rebuilt because the events before it are no
// longer held and no checkpoint covers them.
var ErrNotHeld = errors.New("the projection at that cursor can no longer be rebuilt")

// Options configure a Projector.
type Options struct {
	Log            feed.Log
	Interval       uint64 // checkpoint every Interval positions
	MaxCheckpoints int
	// PersistDir, when set, holds projection.json: the latest projection, so a restart replays only
	// the log's tail and a long history survives the store's memory window.
	PersistDir   string
	PersistEvery uint64
	Logger       *log.Logger
}

type checkpoint struct {
	pos  uint64
	data []byte // the encoded State: immutable, cheap to keep
}

// Projector keeps the projection up to date with the log. One goroutine (Run) follows the log;
// any request may also bring it up to date (Sync) before reading. Both take the same lock, so a
// read always sees the state at exactly one position.
type Projector struct {
	opts Options

	mu          sync.Mutex
	state       *State
	cps         []checkpoint
	lastPersist uint64
	lastErr     string
	syncs       int64
}

// New makes a projector, loading a saved projection when one matches the log.
func New(opts Options) *Projector {
	if opts.Interval == 0 {
		opts.Interval = DefaultInterval
	}
	if opts.MaxCheckpoints <= 0 {
		opts.MaxCheckpoints = DefaultMaxCheckpoints
	}
	if opts.PersistEvery == 0 {
		opts.PersistEvery = DefaultPersistEvery
	}
	if opts.Logger == nil {
		opts.Logger = log.New(io.Discard, "", 0)
	}
	p := &Projector{opts: opts}
	p.mu.Lock()
	p.start()
	p.mu.Unlock()
	return p
}

// start sets the base state: a saved projection if it fits the log, else empty (and partial when
// the log no longer holds its beginning).
func (p *Projector) start() {
	epoch := p.opts.Log.Epoch()
	floor, head := p.opts.Log.Bounds()
	p.cps = nil
	if saved, err := loadSaved(p.opts.PersistDir); err == nil && saved != nil {
		if saved.Epoch == epoch && saved.Format == FormatVersion && saved.Metrics != nil && saved.Metrics.Version == metrics.DefinitionsVersion &&
			saved.Pos <= head && saved.Pos >= floor {
			p.state = saved
			p.lastPersist = saved.Pos
			p.addCheckpoint()
			return
		}
	}
	p.state = NewState(epoch)
	if floor > 0 {
		p.state.Partial = fmt.Sprintf("history before position %d is no longer held by the log and no saved projection covers it", floor)
		p.state.Pos = floor
	}
	p.addCheckpoint()
}

func (p *Projector) addCheckpoint() {
	data, err := json.Marshal(p.state)
	if err != nil {
		p.lastErr = "could not encode a checkpoint"
		return
	}
	if n := len(p.cps); n > 0 && p.cps[n-1].pos == p.state.Pos {
		p.cps[n-1].data = data
		return
	}
	p.cps = append(p.cps, checkpoint{pos: p.state.Pos, data: data})
	p.trimCheckpoints()
}

// trimCheckpoints keeps the newest checkpoint at or below the log's floor and every one after it,
// and at most MaxCheckpoints in all (dropping the oldest).
func (p *Projector) trimCheckpoints() {
	floor, _ := p.opts.Log.Bounds()
	keepFrom := 0
	for i, c := range p.cps {
		if c.pos <= floor {
			keepFrom = i
		}
	}
	if keepFrom > 0 {
		p.cps = append([]checkpoint(nil), p.cps[keepFrom:]...)
	}
	// Over the cap, thin the older half (every second one goes), keeping the oldest and the newest:
	// checkpoints stay spread over everything the log holds, densest near the head.
	for len(p.cps) > p.opts.MaxCheckpoints {
		half := len(p.cps) / 2
		kept := []checkpoint{p.cps[0]}
		for i := 1; i < half; i++ {
			if i%2 == 0 {
				kept = append(kept, p.cps[i])
			}
		}
		p.cps = append(kept, p.cps[half:]...)
	}
}

// Sync applies every event the log holds after the projection's position.
func (p *Projector) Sync() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.syncLocked()
}

func (p *Projector) syncLocked() {
	p.syncs++
	if p.opts.Log.Epoch() != p.state.Epoch {
		p.start() // the log was rebuilt: its cursors and positions are new
	}
	for {
		recs, err := p.opts.Log.After(p.state.Pos, 1000)
		if errors.Is(err, feed.ErrExpired) {
			floor, _ := p.opts.Log.Bounds()
			p.state.Partial = fmt.Sprintf("events %d to %d were evicted before the projection read them", p.state.Pos+1, floor)
			p.state.Pos = floor
			p.cps = nil
			p.addCheckpoint()
			continue
		}
		if errors.Is(err, feed.ErrFuture) {
			p.start()
			return
		}
		if err != nil {
			p.lastErr = err.Error()
			return
		}
		if len(recs) == 0 {
			break
		}
		for _, r := range recs {
			p.applyRecord(p.state, r)
			if r.Pos%p.opts.Interval == 0 {
				p.addCheckpoint()
			}
		}
	}
	if p.opts.PersistDir != "" && p.state.Pos-p.lastPersist >= p.opts.PersistEvery {
		p.persistLocked()
	}
}

func (p *Projector) applyRecord(s *State, r feed.Record) {
	ev, err := feed.Decode(r)
	if err != nil {
		s.Pos = r.Pos
		s.NotV3++
		return
	}
	s.Apply(ev)
}

func (p *Projector) persistLocked() {
	if p.opts.PersistDir == "" {
		return
	}
	data, err := json.Marshal(p.state)
	if err == nil {
		err = saveProjection(p.opts.PersistDir, data)
	}
	if err != nil {
		p.lastErr = "could not save the projection: " + err.Error()
		p.opts.Logger.Printf("projection: %v", err)
		return
	}
	p.lastPersist = p.state.Pos
}

// Run follows the log until done is closed, then saves the projection.
func (p *Projector) Run(done <-chan struct{}) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		changed := p.opts.Log.Changed()
		p.Sync()
		select {
		case <-changed:
		case <-tick.C:
		case <-done:
			p.mu.Lock()
			p.persistLocked()
			p.mu.Unlock()
			return
		}
	}
}

// View runs fn on the current state, brought up to date first. fn must not keep the state.
func (p *Projector) View(fn func(*State)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.syncLocked()
	fn(p.state)
}

// Status reports the projector's own health.
type Status struct {
	Pos         uint64 `json:"pos"`
	Applied     int64  `json:"applied"`
	NotV3       int64  `json:"not_v3"`
	Checkpoints int    `json:"checkpoints"`
	OldestCP    uint64 `json:"oldest_checkpoint"`
	Persisted   uint64 `json:"persisted_at"`
	Partial     string `json:"partial,omitempty"`
	LastError   string `json:"last_error,omitempty"`
}

// Status reads the projector's health without syncing.
func (p *Projector) Status() Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	st := Status{Pos: p.state.Pos, Applied: p.state.Applied, NotV3: p.state.NotV3, Checkpoints: len(p.cps), Persisted: p.lastPersist,
		Partial: p.state.Partial, LastError: p.lastErr}
	if len(p.cps) > 0 {
		st.OldestCP = p.cps[0].pos
	}
	return st
}

// At returns a private copy of the projection at position at (0 means the current head), and
// whether it was reconstructed from a checkpoint (an earlier position) rather than being the live
// projection. The copy is built from a fixed cursor: appends while it is built change nothing.
func (p *Projector) At(at uint64) (*State, bool, error) {
	p.mu.Lock()
	p.syncLocked()
	cur := p.state.Pos
	if at == 0 || at == cur {
		data, err := json.Marshal(p.state)
		p.mu.Unlock()
		if err != nil {
			return nil, false, err
		}
		s, err := decodeState(data)
		return s, false, err
	}
	if at > cur {
		p.mu.Unlock()
		return nil, false, feed.ErrFuture
	}
	i := sort.Search(len(p.cps), func(i int) bool { return p.cps[i].pos > at }) - 1
	if i < 0 {
		p.mu.Unlock()
		return nil, false, ErrNotHeld
	}
	base := p.cps[i]
	p.mu.Unlock()

	s, err := decodeState(base.data)
	if err != nil {
		return nil, false, err
	}
	for s.Pos < at {
		recs, err := p.opts.Log.After(s.Pos, int(min(at-s.Pos, 1000)))
		if errors.Is(err, feed.ErrExpired) {
			return nil, false, ErrNotHeld
		}
		if err != nil {
			return nil, false, err
		}
		if len(recs) == 0 {
			return nil, false, ErrNotHeld
		}
		for _, r := range recs {
			if r.Pos > at {
				break
			}
			p.applyRecord(s, r)
		}
	}
	return s, true, nil
}

func decodeState(data []byte) (*State, error) {
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	s.fill()
	return &s, nil
}

// Encode is the canonical encoding of a state (used by tests to compare two projections).
func Encode(s *State) []byte {
	data, _ := json.Marshal(s)
	return data
}

// Close saves the projection.
func (p *Projector) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.persistLocked()
}
