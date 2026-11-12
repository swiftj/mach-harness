package project

import (
	"mach/observer/internal/feed"
)

// Stamp is one end of a span: the event that recorded it and how well its time is known.
// Times are Unix milliseconds; Precision is the contract's (ms, s, arrival, bounded, unknown).
type Stamp struct {
	EventID   string `json:"event_id"`
	Pos       uint64 `json:"pos"`
	At        *int64 `json:"at_ms"`
	Precision string `json:"precision"`
	NotBefore *int64 `json:"not_before_ms"`
	NotAfter  *int64 `json:"not_after_ms"`
	OrderMS   int64  `json:"order_ms"`
	Authority string `json:"authority"`
}

func stampOf(e *feed.Event) *Stamp {
	s := &Stamp{EventID: e.ID, Pos: e.Pos, Precision: e.Time.Precision, OrderMS: e.Time.OrderMS, Authority: e.Authority}
	if ms, ok := feed.ParseMS(e.Time.OccurredAt); ok {
		s.At = &ms
	}
	if ms, ok := feed.ParseMS(e.Time.NotBefore); ok {
		s.NotBefore = &ms
	}
	if ms, ok := feed.ParseMS(e.Time.NotAfter); ok {
		s.NotAfter = &ms
	}
	if s.Precision == "" {
		s.Precision = "unknown"
	}
	return s
}

// lo and hi are the earliest and latest the moment can have been.
func (s *Stamp) lo() (int64, bool) {
	if s == nil {
		return 0, false
	}
	if s.NotBefore != nil {
		return *s.NotBefore, true
	}
	if s.At != nil {
		return *s.At, true
	}
	return 0, false
}

func (s *Stamp) hi() (int64, bool) {
	if s == nil {
		return 0, false
	}
	if s.NotAfter != nil {
		return *s.NotAfter, true
	}
	if s.At != nil {
		return *s.At, true
	}
	return 0, false
}

// exact reports a point time: ms or whole-second precision with an occurred time.
func (s *Stamp) exact() bool {
	return s != nil && s.At != nil && (s.Precision == "ms" || s.Precision == "s")
}

// Duration is a span's length and how well it is known (shared contracts, section 1).
type Duration struct {
	MS    *int64 `json:"ms"`
	MinMS *int64 `json:"min_ms"`
	MaxMS *int64 `json:"max_ms"`
	Basis string `json:"basis"` // measured | bounded | inferred | open | unknown
}

// between measures from start to end. Both ends point times: measured (with bounds when either is
// whole seconds). Otherwise bounded by what the bounds allow, or unknown. No end: open.
func between(start, end *Stamp, inferred bool) Duration {
	if start == nil {
		return Duration{Basis: "unknown"}
	}
	if end == nil {
		return Duration{Basis: "open"}
	}
	var d Duration
	if lo, ok := end.lo(); ok {
		if hi, ok2 := start.hi(); ok2 {
			v := max(0, lo-hi)
			d.MinMS = &v
		}
	}
	if hi, ok := end.hi(); ok {
		if lo, ok2 := start.lo(); ok2 {
			v := max(0, hi-lo)
			d.MaxMS = &v
		}
	}
	if start.exact() && end.exact() {
		v := max(0, *end.At-*start.At)
		d.MS = &v
		d.Basis = "measured"
		if inferred {
			d.Basis = "inferred"
		}
		if start.Precision == "ms" && end.Precision == "ms" {
			d.MinMS, d.MaxMS = &v, &v
		}
		return d
	}
	if d.MinMS != nil || d.MaxMS != nil {
		d.Basis = "bounded"
	} else {
		d.Basis = "unknown"
	}
	return d
}

// weaker returns the weaker of two authorities.
func weaker(a, b string) string {
	rank := map[string]int{"authoritative": 3, "observed": 2, "reconstructed": 1}
	if b == "" || rank[a] <= rank[b] && a != "" {
		return a
	}
	return b
}

func ptr[T any](v T) *T { return &v }
