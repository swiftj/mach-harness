package store

import (
	"sort"
	"strings"
)

// Series: how many events of each kind and authority fall in each time bucket, for drawing a long
// timeline without fetching every event (GET /api/v1/series; shared contracts 2.8). The store
// keeps counts per minute of order time for everything it has indexed since its generation began
// (also what has left the memory window, and what was read back from the segments on a restart),
// and the same per ticket and per execution, so a filtered overview covers the whole history too.
// Finer buckets, and a ticket and an execution filter together, are counted from the memory
// window. Placement is by order_ms: a late event counts where it belongs.
//
// Per-ticket and per-execution counts cost one cell per (ticket or execution, minute) with events:
// a total and a short list of (kind or authority, count) pairs, about 100 bytes. They are bounded
// by MaxKeyedCells: past it the oldest minutes of every key are dropped together (about a quarter
// of the cells), and a filtered series that reaches before the earliest kept minute is not complete.

// SeriesMinute is the resolution of the kept counts.
const SeriesMinute = 60_000

// MaxKeyedCells bounds the per-ticket and per-execution minute counts (about 25 MB at most).
const MaxKeyedCells = 1 << 18

var keyedCellLimit = MaxKeyedCells // a test lowers it

type seriesBucket struct {
	total uint32
	kinds map[string]uint32
	auth  map[string]uint32
}

// keyCount is one kind's (id < authorityBit) or authority's count in a keyed cell.
type keyCount struct {
	id uint16
	n  uint32
}

const authorityBit = 1 << 15

type keyedCell struct {
	total  uint32
	counts []keyCount
}

type seriesAgg struct {
	minutes map[int64]*seriesBucket
	first   int64 // the earliest minute counted (0: none)

	keyed      map[string]map[int64]*keyedCell // "t:<ticket>" | "x:<execution>" -> minute -> counts
	cells      int
	keyedFloor int64 // minutes before this were dropped from the keyed counts (0: none)
	names      []string
	nameID     map[string]uint16
}

func (a *seriesAgg) add(orderMS int64, kind, authority, ticket, execution string) {
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
	if m < a.keyedFloor {
		return
	}
	if ticket != "" {
		a.addKeyed("t:"+ticket, m, kind, authority)
	}
	if execution != "" {
		a.addKeyed("x:"+execution, m, kind, authority)
	}
}

func (a *seriesAgg) id(name string) uint16 {
	if id, ok := a.nameID[name]; ok {
		return id
	}
	if a.nameID == nil {
		a.nameID = map[string]uint16{}
	}
	if len(a.names) >= authorityBit-1 {
		return authorityBit - 1 // more distinct kinds than any history has: counted under the last name
	}
	id := uint16(len(a.names))
	a.names = append(a.names, name)
	a.nameID[name] = id
	return id
}

func (c *keyedCell) bump(id uint16) {
	for i := range c.counts {
		if c.counts[i].id == id {
			c.counts[i].n++
			return
		}
	}
	c.counts = append(c.counts, keyCount{id: id, n: 1})
}

func (a *seriesAgg) addKeyed(key string, m int64, kind, authority string) {
	if a.keyed == nil {
		a.keyed = map[string]map[int64]*keyedCell{}
	}
	mins := a.keyed[key]
	if mins == nil {
		mins = map[int64]*keyedCell{}
		a.keyed[key] = mins
	}
	c := mins[m]
	if c == nil {
		c = &keyedCell{}
		mins[m] = c
		a.cells++
	}
	c.total++
	c.bump(a.id(kind))
	c.bump(a.id(authority) | authorityBit)
	if a.cells > keyedCellLimit {
		a.dropOldestKeyed()
	}
}

// dropOldestKeyed drops the oldest minutes of every keyed count, about a quarter of the cells.
func (a *seriesAgg) dropOldestKeyed() {
	perMinute := map[int64]int{}
	for _, mins := range a.keyed {
		for m := range mins {
			perMinute[m]++
		}
	}
	order := make([]int64, 0, len(perMinute))
	for m := range perMinute {
		order = append(order, m)
	}
	sort.Slice(order, func(i, j int) bool { return order[i] < order[j] })
	drop := 0
	floor := a.keyedFloor
	for _, m := range order {
		if drop >= a.cells/4 && m > floor {
			break
		}
		drop += perMinute[m]
		floor = m + SeriesMinute
	}
	for key, mins := range a.keyed {
		for m := range mins {
			if m < floor {
				delete(mins, m)
				a.cells--
			}
		}
		if len(mins) == 0 {
			delete(a.keyed, key)
		}
	}
	a.keyedFloor = floor
}

// keyedBytes estimates the memory of the per-ticket and per-execution counts.
func (a *seriesAgg) keyedBytes() int64 {
	var b int64
	for key, mins := range a.keyed {
		b += int64(len(key)) + 64
		for _, c := range mins {
			b += 40 + 32 + int64(cap(c.counts))*8 // map entry, cell, counts
		}
	}
	return b
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
// fine series, or one filtered by both a ticket and an execution, reaching before the memory
// window; history dropped by retention before this generation's kept counts begin; or a filtered
// series reaching before the earliest per-key minute still kept under MaxKeyedCells).
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
// there is at most one filter (a ticket or an execution), otherwise from the memory window. Empty
// buckets are left out.
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
	whole := q.BucketMS%SeriesMinute == 0 && q.FromMS%SeriesMinute == 0
	// Counts for the range are held from the kept minutes when nothing was dropped by retention, or
	// the range starts at or after the earliest minute counted.
	held := s.diskFloor == 0 || s.series.first > 0 && s.series.first <= q.FromMS
	switch {
	case whole && q.Ticket == "" && q.Execution == "":
		out.Source = "minutes"
		out.Complete = held
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
	case whole && (q.Ticket == "") != (q.Execution == ""):
		out.Source = "minutes"
		key := "t:" + q.Ticket
		if q.Execution != "" {
			key = "x:" + q.Execution
		}
		out.Complete = held && (s.series.keyedFloor == 0 || q.FromMS >= s.series.keyedFloor)
		for m, c := range s.series.keyed[key] {
			if m < q.FromMS || m >= q.ToMS {
				continue
			}
			t := bucket(m)
			t.Count += int64(c.total)
			for _, kc := range c.counts {
				if kc.id&authorityBit != 0 {
					t.Authorities[s.series.names[kc.id&^authorityBit]] += int64(kc.n)
				} else {
					t.Kinds[s.series.names[kc.id]] += int64(kc.n)
				}
			}
		}
	default:
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
