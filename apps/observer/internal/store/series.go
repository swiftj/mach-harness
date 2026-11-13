package store

import (
	"sort"
	"strings"
)

// Series: how many events of each kind and authority fall in each time bucket, for drawing a long
// timeline without fetching every event (GET /api/v1/series; shared contracts 2.8). The store
// keeps counts per minute of order time for everything it has indexed since its generation began
// (also what has left the memory window, and what was read back from the segments on a restart);
// finer buckets are counted from the memory window. Placement is by order_ms: a late event counts
// where it belongs.

// SeriesMinute is the resolution of the kept counts.
const SeriesMinute = 60_000

type seriesBucket struct {
	total uint32
	kinds map[string]uint32
	auth  map[string]uint32
}

type seriesAgg struct {
	minutes map[int64]*seriesBucket
	first   int64 // the earliest minute counted (0: none)
}

func (a *seriesAgg) add(orderMS int64, kind, authority string) {
	if orderMS <= 0 {
		return
	}
	if a.minutes == nil {
		a.minutes = map[int64]*seriesBucket{}
	}
	m := orderMS - orderMS%SeriesMinute
	b := a.minutes[m]
	if b == nil {
		b = &seriesBucket{kinds: map[string]uint32{}, auth: map[string]uint32{}}
		a.minutes[m] = b
	}
	b.total++
	b.kinds[kind]++
	b.auth[authority]++
	if a.first == 0 || m < a.first {
		a.first = m
	}
}

// SeriesQuery selects buckets. FromMS/ToMS are [from, to); BucketMS is a multiple of 1,000.
type SeriesQuery struct {
	FromMS, ToMS      int64
	BucketMS          int64
	Ticket, Execution string
}

// SeriesBucket is one bucket's counts.
type SeriesBucket struct {
	FromMS      int64            `json:"from_ms"`
	Count       int64            `json:"count"`
	Kinds       map[string]int64 `json:"kinds"`
	Authorities map[string]int64 `json:"authorities"`
}

// SeriesResult is a series. Complete is false when counts for part of the range are not held (a
// fine series or a filtered one reaching before the memory window, or history dropped by
// retention before this generation's kept counts begin).
type SeriesResult struct {
	Buckets     []SeriesBucket   `json:"buckets"`
	Total       int64            `json:"total"`
	Kinds       map[string]int64 `json:"kinds"`
	Authorities map[string]int64 `json:"authorities"`
	Complete    bool             `json:"complete"`
	Source      string           `json:"source"` // minutes | memory-window
	FirstMS     int64            `json:"first_ms"`
	LastMS      int64            `json:"last_ms"`
}

// SeriesBounds is the order time of the earliest and latest event counted (0, 0 when none).
func (s *Store) SeriesBounds() (int64, int64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var lo, hi int64
	for m := range s.series.minutes {
		if lo == 0 || m < lo {
			lo = m
		}
		if m > hi {
			hi = m
		}
	}
	if hi > 0 {
		hi += SeriesMinute - 1
	}
	return lo, hi
}

// Series answers a query: from the kept minutes when the bucket is a whole number of minutes and
// there is no filter, otherwise from the memory window. Empty buckets are left out.
func (s *Store) Series(q SeriesQuery) SeriesResult {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := SeriesResult{Kinds: map[string]int64{}, Authorities: map[string]int64{}, Buckets: []SeriesBucket{}}
	buckets := map[int64]*SeriesBucket{}
	bucket := func(ms int64) *SeriesBucket {
		k := q.FromMS + (ms-q.FromMS)/q.BucketMS*q.BucketMS
		b := buckets[k]
		if b == nil {
			b = &SeriesBucket{FromMS: k, Kinds: map[string]int64{}, Authorities: map[string]int64{}}
			buckets[k] = b
		}
		return b
	}
	fromMinutes := q.BucketMS%SeriesMinute == 0 && q.FromMS%SeriesMinute == 0 && q.Ticket == "" && q.Execution == ""
	if fromMinutes {
		out.Source = "minutes"
		out.Complete = s.diskFloor == 0 || s.series.first > 0 && s.series.first <= q.FromMS
		for m, b := range s.series.minutes {
			if m < q.FromMS || m >= q.ToMS {
				continue
			}
			t := bucket(m)
			t.Count += int64(b.total)
			for k, n := range b.kinds {
				t.Kinds[k] += int64(n)
			}
			for k, n := range b.auth {
				t.Authorities[k] += int64(n)
			}
		}
	} else {
		out.Source = "memory-window"
		lowest := int64(0)
		for _, e := range s.entries {
			ev := e.Event
			if lowest == 0 || ev.Time.OrderMS < lowest {
				lowest = ev.Time.OrderMS
			}
			ms := ev.Time.OrderMS
			if ms < q.FromMS || ms >= q.ToMS || q.Ticket != "" && ev.IDs.TicketID != q.Ticket || q.Execution != "" && ev.IDs.ExecutionID != q.Execution {
				continue
			}
			t := bucket(ms)
			t.Count++
			t.Kinds[ev.Type]++
			t.Authorities[ev.Authority]++
		}
		out.Complete = s.evictedMax == "" || lowest > 0 && strings.Compare(orderPrefix(q.FromMS), s.evictedMax) > 0
	}
	for _, b := range buckets {
		out.Buckets = append(out.Buckets, *b)
		out.Total += b.Count
		for k, n := range b.Kinds {
			out.Kinds[k] += n
		}
		for k, n := range b.Authorities {
			out.Authorities[k] += n
		}
	}
	sort.Slice(out.Buckets, func(i, j int) bool { return out.Buckets[i].FromMS < out.Buckets[j].FromMS })
	if n := len(out.Buckets); n > 0 {
		out.FirstMS, out.LastMS = out.Buckets[0].FromMS, out.Buckets[n-1].FromMS+q.BucketMS
	}
	return out
}

// orderPrefix is the 15-digit order_ms prefix of an order key.
func orderPrefix(ms int64) string {
	b := []byte("000000000000000")
	for i := len(b) - 1; i >= 0 && ms > 0; i-- {
		b[i] = byte('0' + ms%10)
		ms /= 10
	}
	return string(b)
}
