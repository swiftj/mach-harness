package project

import (
	"math"
	"sort"
)

// Concurrency: how many spans of each kind were active, per time bucket, swept over the spans of
// one projection position. A span is active over its extent [start's earliest bound, end's latest
// bound); an open span until what the projection holds (State.LastMS), never beyond it. A span of
// no length counts toward the maximum at its instant and nothing toward the mean.

// Active is one kind's activity in one bucket.
type Active struct {
	Max  int     `json:"max"`
	Mean float64 `json:"mean"`
}

// ConcurrencyBucket is one bucket.
type ConcurrencyBucket struct {
	FromMS int64             `json:"from_ms"`
	Active map[string]Active `json:"active"`
}

// LimitView is one recorded Factory limit and when it applied.
type LimitView struct {
	Name    string  `json:"name"`
	Value   float64 `json:"value"`
	FromMS  int64   `json:"from_ms"`
	ToMS    *int64  `json:"to_ms"`
	EventID string  `json:"event_id"`
}

// Concurrency sweeps the spans of the given kinds (all when empty) over [from, to) in buckets of
// bucket milliseconds.
func Concurrency(s *State, from, to, bucket int64, kinds map[string]bool) []ConcurrencyBucket {
	n := int((to - from + bucket - 1) / bucket)
	out := make([]ConcurrencyBucket, n)
	for i := range out {
		out[i] = ConcurrencyBucket{FromMS: from + int64(i)*bucket, Active: map[string]Active{}}
	}
	live := s.LastMS
	type edge struct {
		t    int64
		ord  int // 0: end of a span with length, 1: start, 2: end of a span of no length
		kind string
	}
	byKind := map[string][]edge{}
	for _, sp := range allSpans(s) {
		if len(kinds) > 0 && !kinds[sp.Kind] {
			continue
		}
		a, b := sp.from, sp.to
		if b == math.MaxInt64 {
			b = max(live, a)
		}
		if b < from || a >= to {
			continue
		}
		e := byKind[sp.Kind]
		if b == a {
			e = append(e, edge{a, 1, sp.Kind}, edge{a, 2, sp.Kind})
		} else {
			e = append(e, edge{a, 1, sp.Kind}, edge{b, 0, sp.Kind})
		}
		byKind[sp.Kind] = e
	}
	for kind, edges := range byKind {
		sort.Slice(edges, func(i, j int) bool {
			if edges[i].t != edges[j].t {
				return edges[i].t < edges[j].t
			}
			return edges[i].ord < edges[j].ord
		})
		cur, k := 0, 0
		// Everything that starts before the range and is still active at its start.
		for k < len(edges) && edges[k].t < from {
			cur += delta(edges[k].ord)
			k++
		}
		for i := range out {
			bs := out[i].FromMS
			be := min(bs+bucket, to)
			peak, area, t := 0, int64(0), bs
			for k < len(edges) && edges[k].t < be {
				ev := edges[k]
				if ev.t > t {
					peak = max(peak, cur) // cur was active over [t, ev.t)
					area += int64(cur) * (ev.t - t)
					t = ev.t
				}
				cur += delta(ev.ord)
				if ev.ord == 1 {
					peak = max(peak, cur) // a start counts at its instant, even for a span of no length
				}
				k++
			}
			if be > t {
				peak = max(peak, cur)
				area += int64(cur) * (be - t)
			}
			if peak > 0 {
				out[i].Active[kind] = Active{Max: peak, Mean: math.Round(float64(area)/float64(be-bs)*1000) / 1000}
			}
		}
	}
	return out
}

func delta(ord int) int {
	if ord == 1 {
		return 1
	}
	return -1
}

// Limits lists the recorded Factory limits and when each applied.
func Limits(s *State) []LimitView {
	out := []LimitView{}
	for _, l := range s.Factory.LimitHistory {
		if l.From == nil {
			continue
		}
		v := LimitView{Name: l.Name, Value: l.Value, FromMS: stampMS(l.From), EventID: l.From.EventID}
		if l.To != nil {
			v.ToMS = ptr(stampMS(l.To))
		}
		out = append(out, v)
	}
	return out
}

// SpanExtent is the earliest start and the latest finite end over every span (ok false when there
// are none), for a reply's default range.
func SpanExtent(s *State) (lo, hi int64, ok bool) {
	for _, sp := range allSpans(s) {
		if !ok || sp.from < lo {
			lo = sp.from
		}
		end := sp.to
		if end == math.MaxInt64 {
			end = max(s.LastMS, sp.from)
		}
		if !ok || end > hi {
			hi = end
		}
		ok = true
	}
	return lo, hi, ok
}

// HistoryLostIn reports whether a recorded gap that lost history falls in [from, to), or the
// projection itself begins part-way.
func HistoryLostIn(s *State, from, to int64) bool {
	if s.Partial != "" {
		return true
	}
	for _, g := range s.Gaps {
		if g.Lost && g.At != nil {
			if t := stampMS(g.At); t >= from && t < to {
				return true
			}
		}
	}
	return false
}
