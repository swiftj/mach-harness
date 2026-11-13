package normalize

import (
	"mach/observer/internal/event"
)

// Sequencer computes order_ms and the history order key (contract 6.2 and 6.3). It keeps, per
// source partition, the order_ms of the last event placed, so each source's own order is never
// contradicted. It holds one integer per partition; ingest rebuilds it after a restart by
// replaying the sources (their events are placed again and discarded).
type Sequencer struct {
	last map[string]int64
}

// NewSequencer makes an empty sequencer.
func NewSequencer() *Sequencer { return &Sequencer{last: map[string]int64{}} }

// Last is the order_ms of the last event placed in a partition.
func (s *Sequencer) Last(key string) int64 { return s.last[key] }

// Place sets ev.Time.OrderMS and ev.Order. Events of one partition must be placed in source
// order; an observer event must be placed after its basis.
func (s *Sequencer) Place(ev *event.Event) {
	if ev.Origin.Stream == event.StreamObserver {
		s.placeObserver(ev)
		return
	}
	key := ev.Origin.Key
	occurred, ok := OccurredMS(ev)
	if !ok {
		occurred = s.last[key]
	}
	if prev := s.last[key]; prev > occurred {
		occurred = prev
	}
	s.last[key] = occurred
	ev.Time.OrderMS = occurred
	part := 0
	if ev.Origin.Part != nil {
		part = *ev.Origin.Part
	}
	ev.Order = event.OrderKey(occurred, event.Rank(ev.Origin.Stream), key, ev.Origin.Seq, part)
}

// placeObserver: an observer event takes its basis event's order_ms and seq, rank 6, key "o",
// and its own index as part (contract 6.3). Without a basis it is placed at its anchor
// partition's last order_ms, or at its own time.
func (s *Sequencer) placeObserver(ev *event.Event) {
	part := 0
	if ev.Origin.Part != nil {
		part = *ev.Origin.Part
	}
	var ms, seq int64
	switch {
	case ev.OrderBasis != nil:
		ms, seq = ev.OrderBasis.Time.OrderMS, ev.OrderBasis.Origin.Seq
	case ev.AnchorKey != "":
		ms, seq = s.last[ev.AnchorKey], ev.AnchorSeq
		if own, ok := OccurredMS(ev); ok && own > ms {
			ms = own
		}
	default:
		ms, _ = OccurredMS(ev)
	}
	if ms < 0 {
		ms = 0
	}
	ev.Time.OrderMS = ms
	ev.Order = event.OrderKey(ms, 6, event.ObserverKey, seq, part)
}
