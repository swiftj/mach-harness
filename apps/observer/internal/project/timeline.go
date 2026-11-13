package project

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Timeline is the spans and marks of one projection position, built from a private copy of the
// state outside the projection's lock (A1 of the M6.3 round 4 review). Under the lock a request
// only takes a snapshot of the state (the checkpoint encoding of what changed since the last one);
// decoding it, building the spans and marks and encoding the reply all happen without the lock,
// so a request never holds the projection's write path longer than that snapshot takes. A built
// timeline is shared and never changed.
type Timeline struct {
	Epoch   string
	Pos     uint64
	Applied int64
	LastMS  int64
	Partial string
	// Rebuilding: the projection was still replaying its log when this was built (A7).
	Rebuilding bool
	Built      time.Time
	// How long the build took: the snapshot (under the projection's lock), decoding it and
	// building the spans (both without it).
	SnapshotTook, DecodeTook, SpansTook time.Duration

	st        *State // private to this timeline; read only
	spans     []*Span
	marksOnce sync.Once
	marks     []*Mark
	marksTook atomic.Int64
}

// TimelineStats says what building the latest timeline cost (health and the load harness).
type TimelineStats struct {
	Builds     int64   `json:"builds"`
	Pos        uint64  `json:"pos"`
	SnapshotMS float64 `json:"snapshot_ms"` // under the projection's lock
	DecodeMS   float64 `json:"decode_ms"`
	SpansMS    float64 `json:"spans_ms"`
	MarksMS    float64 `json:"marks_ms"`
}

// TimelineStats reports the latest timeline's costs.
func (p *Projector) TimelineStats() TimelineStats {
	p.tl.mu.Lock()
	defer p.tl.mu.Unlock()
	st := TimelineStats{Builds: p.tl.builds}
	if tl := p.tl.cur; tl != nil {
		ms := func(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
		st.Pos, st.SnapshotMS, st.DecodeMS, st.SpansMS, st.MarksMS = tl.Pos, ms(tl.SnapshotTook), ms(tl.DecodeTook), ms(tl.SpansTook), ms(time.Duration(tl.marksTook.Load()))
	}
	return st
}

// Spans returns the spans that match f, sorted by start (earliest bound first).
func (tl *Timeline) Spans(f SpanFilter) []*Span { return spansOf(tl.spans, f) }

// Marks returns the marks that match f (see Marks); built on first use.
func (tl *Timeline) Marks(f MarkFilter, limit int) ([]*Mark, int) {
	tl.marksOnce.Do(func() {
		began := time.Now()
		tl.marks = allMarks(tl.st)
		tl.marksTook.Store(int64(time.Since(began)))
	})
	return marksOf(tl.marks, f, limit)
}

// Concurrency sweeps the timeline's spans (see Concurrency).
func (tl *Timeline) Concurrency(from, to, bucket int64, kinds map[string]bool) []ConcurrencyBucket {
	return concurrencyOf(tl.spans, tl.LastMS, from, to, bucket, kinds)
}

// Extent is SpanExtent over the timeline's spans.
func (tl *Timeline) Extent() (lo, hi int64, ok bool) { return extentOf(tl.spans, tl.LastMS) }

// Limits are the recorded Factory limits at the timeline's position.
func (tl *Timeline) Limits() []LimitView { return Limits(tl.st) }

// HistoryLostIn: see HistoryLostIn. A projection still replaying its log is not complete.
func (tl *Timeline) HistoryLostIn(from, to int64) bool {
	return tl.Rebuilding || HistoryLostIn(tl.st, from, to)
}

func spansOf(all []*Span, f SpanFilter) []*Span {
	end := len(all)
	if f.ToMS != nil {
		to := *f.ToMS
		end = sort.Search(len(all), func(i int) bool { return all[i].from > to })
	}
	out := []*Span{}
	for _, sp := range all[:end] {
		if f.match(sp) {
			out = append(out, sp)
		}
	}
	return out
}

// DefaultTimelineMaxAge is how long a built timeline is served while events keep arriving.
const DefaultTimelineMaxAge = time.Second

type timelineCache struct {
	mu       sync.Mutex
	cur      *Timeline
	building chan struct{} // closed when the build in flight ends
	builds   int64

	// The previous build's entity encodings and what they decoded to (used only by the one build
	// in flight): an entity whose encoding is the same bytes is not decoded again. Decoded entities
	// are shared by successive timelines and never changed.
	prevEnts map[string][]byte
	prevObjs map[string]any
}

// decode is decodeCheckpoint, reusing the entities that did not change since the last build.
func (c *timelineCache) decode(cp checkpoint) (*State, error) {
	var s State
	if err := json.Unmarshal(cp.top, &s); err != nil {
		return nil, err
	}
	s.Waves, s.Slices, s.Cells, s.Executions = map[string]*Wave{}, map[string]*Slice{}, map[string]*Cell{}, map[string]*Execution{}
	objs := make(map[string]any, len(cp.ents))
	for k, data := range cp.ents {
		obj := c.prevObjs[k]
		if prev, ok := c.prevEnts[k]; !ok || obj == nil || len(prev) != len(data) || len(data) == 0 || &prev[0] != &data[0] {
			prefix, _, _ := strings.Cut(k, "\x00")
			switch prefix + "\x00" {
			case entCell:
				obj = &Cell{}
			case entSlice:
				obj = &Slice{}
			case entExecution:
				obj = &Execution{}
			case entWave:
				obj = &Wave{}
			default:
				continue
			}
			if err := json.Unmarshal(data, obj); err != nil {
				return nil, err
			}
			if x, ok := obj.(*Execution); ok { // fill's part, before the entity is shared
				fillExecution(x)
			}
		}
		objs[k] = obj
		_, id, _ := strings.Cut(k, "\x00")
		switch v := obj.(type) {
		case *Cell:
			s.Cells[id] = v
		case *Slice:
			s.Slices[id] = v
		case *Execution:
			s.Executions[id] = v
		case *Wave:
			s.Waves[id] = v
		}
	}
	c.prevEnts, c.prevObjs = cp.ents, objs
	s.fill()
	return &s, nil
}

// Timeline returns the spans and marks at the projection's position, brought up to date first. A
// request never waits for the projection's writer when a timeline is already built: while the
// writer holds the lock (applying events, a checkpoint, a save) the latest timeline is served. A
// timeline built at an earlier position is also served while it is younger than TimelineMaxAge,
// and while another request is building the next one (its own Pos says where it was built). One
// build runs at a time.
func (p *Projector) Timeline() (*Timeline, error) {
	c := &p.tl
	for {
		if !p.mu.TryLock() {
			c.mu.Lock()
			cur := c.cur
			c.mu.Unlock()
			if cur != nil && p.opts.TimelineMaxAge > 0 {
				return cur, nil
			}
			p.mu.Lock()
		}
		// With Run following the log, the request reads where the projection is and applies nothing.
		if !p.rebuilding && !p.running.Load() {
			p.syncLocked()
		}
		epoch, pos, applied := p.state.Epoch, p.state.Pos, p.state.Applied
		p.mu.Unlock()

		c.mu.Lock()
		cur := c.cur
		same := cur != nil && cur.Epoch == epoch
		if same && (cur.Pos == pos && cur.Applied == applied || time.Since(cur.Built) < p.opts.TimelineMaxAge) {
			c.mu.Unlock()
			return cur, nil
		}
		if ch := c.building; ch != nil {
			if same && p.opts.TimelineMaxAge > 0 {
				c.mu.Unlock()
				return cur, nil
			}
			c.mu.Unlock()
			<-ch
			c.mu.Lock()
			got := c.cur
			c.mu.Unlock()
			if got != nil && got.Epoch == epoch && got.Pos >= pos {
				return got, nil
			}
			continue
		}
		ch := make(chan struct{})
		c.building = ch
		c.mu.Unlock()

		tl, err := p.buildTimeline()

		c.mu.Lock()
		if err == nil {
			c.cur = tl
			c.builds++
		}
		c.building = nil
		close(ch)
		c.mu.Unlock()
		return tl, err
	}
}

// TimelineBuilds counts the timelines built (tests).
func (p *Projector) TimelineBuilds() int64 {
	p.tl.mu.Lock()
	defer p.tl.mu.Unlock()
	return p.tl.builds
}

// buildTimeline snapshots the live state under the lock and builds from the copy without it.
func (p *Projector) buildTimeline() (*Timeline, error) {
	t0 := time.Now()
	p.mu.Lock()
	cp, err := p.blobs.snapshot(p.state)
	if err != nil {
		p.blobs.valid = false
	}
	rebuilding := p.rebuilding
	p.mu.Unlock()
	t1 := time.Now()
	if err != nil {
		return nil, err
	}
	s, err := p.tl.decode(cp)
	if err != nil {
		return nil, err
	}
	t2 := time.Now()
	spans := allSpans(s)
	t3 := time.Now()
	return &Timeline{Epoch: s.Epoch, Pos: s.Pos, Applied: s.Applied, LastMS: s.LastMS, Partial: s.Partial, Rebuilding: rebuilding, Built: t3,
		SnapshotTook: t1.Sub(t0), DecodeTook: t2.Sub(t1), SpansTook: t3.Sub(t2), st: s, spans: spans}, nil
}
