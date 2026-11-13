package store

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

// The order index: where on disk the events of each minute of order time are, so /history can
// serve a window the memory window no longer holds (M6.3, observer extension 7).
//
// Events are on disk in position (delivery) order, which is not history order: a catch-up reads
// one source after another, and late events arrive long after their neighbours. For each minute of
// order time the index keeps a few chunks: a run of positions in one segment (and its byte range)
// holding that minute's events, with the smallest and largest order key among them. A chunk is
// closed when the next event of its minute is more than chunkGap positions on, or would make it
// span more than chunkSpan positions; reading a chunk reads its byte range and keeps the lines of
// its own minute (the gap's other lines belong to other chunks).
//
// Cost: one chunk per run of a minute's events, about 150 bytes with its two order keys. Events
// delivered in order make chunks of up to chunkSpan events; a catch-up makes one per source per
// minute. Past MaxOrderChunks, the chunks of each minute are merged in pairs (fewer, longer reads;
// never a wrong answer). It is built as events are written and rebuilt from the segments on open,
// in the same scan that rebuilds the series counts, and pruned when retention drops a segment.

const (
	chunkSpan = 1024 // positions one chunk covers at most (about 300 KB of compact lines)
	chunkGap  = 64   // positions of other minutes a chunk reads over rather than starting another
	// MaxOrderChunks is the soft bound on chunks: past it, each minute's chunks are merged in pairs.
	// A minute keeps at least one chunk, so the floor is one per retained minute that has events.
	MaxOrderChunks = 1 << 17
	// HistoryScanCap is how many lines a /history page reads from the segments before it stops
	// early (with more=true and next_from_order where it stopped). A chunk is always read whole, so
	// a page always moves on.
	HistoryScanCap = 10000
)

type chunk struct {
	lo, hi             uint64 // the positions it covers, [lo, hi]
	seg                int32
	n                  int32 // events of its minute in it
	off, end           int64 // its byte range in the segment, [off, end)
	minOrder, maxOrder string
}

type orderIndex struct {
	minutes map[int64][]chunk // by minute of order time (-1: an order key with no time prefix)
	keys    []int64           // the minutes, sorted
	chunks  int
	limit   int    // coarsen past this (MaxOrderChunks, raised when merging cannot reduce)
	lostMax string // the largest order key that retention may have dropped ("": nothing dropped)
}

// orderMS is the order_ms prefix of an order key, or -1.
func orderMS(order string) int64 {
	if len(order) < 15 || len(order) > 15 && order[15] != '~' {
		return -1
	}
	var n int64
	for i := 0; i < 15; i++ {
		c := order[i]
		if c < '0' || c > '9' {
			return -1
		}
		n = n*10 + int64(c-'0')
	}
	return n
}

func minuteOf(order string) int64 {
	ms := orderMS(order)
	if ms < 0 {
		return -1
	}
	return ms - ms%SeriesMinute
}

// add notes an event written at pos, in segment seg at byte off, its line n bytes with the newline.
func (x *orderIndex) add(order string, pos uint64, seg int32, off int64, n int) {
	m := minuteOf(order)
	if x.minutes == nil {
		x.minutes = map[int64][]chunk{}
	}
	list, ok := x.minutes[m]
	if !ok {
		i := sort.Search(len(x.keys), func(i int) bool { return x.keys[i] >= m })
		x.keys = append(x.keys, 0)
		copy(x.keys[i+1:], x.keys[i:])
		x.keys[i] = m
	}
	if k := len(list) - 1; k >= 0 {
		c := &list[k]
		if c.seg == seg && pos > c.hi && pos-c.hi <= chunkGap && pos-c.lo < chunkSpan {
			c.hi, c.end = pos, off+int64(n)
			c.n++
			if order < c.minOrder {
				c.minOrder = order
			}
			if order > c.maxOrder {
				c.maxOrder = order
			}
			return
		}
	}
	x.minutes[m] = append(list, chunk{lo: pos, hi: pos, seg: seg, n: 1, off: off, end: off + int64(n), minOrder: order, maxOrder: order})
	x.chunks++
	if x.limit == 0 {
		x.limit = MaxOrderChunks
	}
	if x.chunks > x.limit {
		x.coarsen()
	}
}

// coarsen merges each minute's chunks in pairs (same segment only). When that frees too little
// (most minutes have one chunk), the bound is raised instead: a minute always keeps one.
func (x *orderIndex) coarsen() {
	for m, list := range x.minutes {
		if len(list) < 2 {
			continue
		}
		out := list[:0]
		for i := 0; i < len(list); i++ {
			if i+1 < len(list) && list[i].seg == list[i+1].seg {
				a, b := list[i], list[i+1]
				a.hi, a.end, a.n = b.hi, b.end, a.n+b.n
				a.minOrder, a.maxOrder = min(a.minOrder, b.minOrder), max(a.maxOrder, b.maxOrder)
				out = append(out, a)
				i++
				x.chunks--
				continue
			}
			out = append(out, list[i])
		}
		clear(list[len(out):])
		x.minutes[m] = out
	}
	if x.chunks > x.limit*3/4 {
		x.limit = x.chunks + x.chunks/2
	}
}

// prune forgets chunks wholly at or below the disk floor (retention dropped their segment) and
// notes the largest order key that may have been lost with them.
func (x *orderIndex) prune(floor uint64) {
	keys := x.keys[:0]
	for _, m := range x.keys {
		list := x.minutes[m]
		out := list[:0]
		for _, c := range list {
			if c.lo <= floor && c.maxOrder > x.lostMax {
				x.lostMax = c.maxOrder
			}
			if c.hi <= floor {
				x.chunks--
				continue
			}
			out = append(out, c)
		}
		clear(list[len(out):])
		if len(out) == 0 {
			delete(x.minutes, m)
			continue
		}
		x.minutes[m] = out
		keys = append(keys, m)
	}
	x.keys = keys
}

// memBytes estimates the index's memory.
func (x *orderIndex) memBytes() int64 {
	var b int64
	for _, list := range x.minutes {
		b += 48 + int64(cap(list))*72 // map entry and slice; a chunk is 72 bytes
		for _, c := range list {
			b += int64(len(c.minOrder) + len(c.maxOrder))
		}
	}
	return b + int64(cap(x.keys))*8
}

// histLine is what a history window filters a segment line on.
type histLine struct {
	Pos   uint64 `json:"pos"`
	Order string `json:"order"`
	Type  string `json:"type"`
	IDs   struct {
		TicketID    string `json:"ticket_id"`
		ExecutionID string `json:"execution_id"`
	} `json:"ids"`
	Entities []string `json:"entities"`
}

var orderField = []byte(`"order":"`)

// lineOrder finds a compact line's order key without decoding it. The fields before it (ids,
// type, pos, origin, authority, time) are fixed, so its first occurrence is the event's own.
func lineOrder(line []byte) string {
	i := bytes.Index(line, orderField)
	if i < 0 {
		return ""
	}
	rest := line[i+len(orderField):]
	j := bytes.IndexByte(rest, '"')
	if j < 0 {
		return ""
	}
	return string(rest[:j])
}

func (q HistoryQuery) matches(ticket, execution, typ string, entities []string, want map[string]bool) bool {
	if q.Ticket != "" && ticket != q.Ticket || q.Execution != "" && execution != q.Execution ||
		q.TypePrefix != "" && !strings.HasPrefix(typ, q.TypePrefix) {
		return false
	}
	if len(want) == 0 {
		return true
	}
	for _, ref := range entities {
		if want[ref] {
			return true
		}
	}
	return false
}

// historyReader reads the chunks of a window from the segments (the caller holds the read lock).
type historyReader struct {
	s        *Store
	q        HistoryQuery
	want     map[string]bool
	files    map[int32]*os.File
	keyAt    int     // the next minute (index into keys) not yet opened
	queue    []chunk // the opened minute's chunks not yet read, by minOrder
	queueMin int64
	hiMinute int64 // the last minute the window reaches (-2: no bound)
	special  bool  // the -1 minute (order keys with no time prefix) has been read
	examined int
}

func (s *Store) newHistoryReader(q HistoryQuery, want map[string]bool) *historyReader {
	r := &historyReader{s: s, q: q, want: want, hiMinute: -2}
	x := &s.oidx
	from := minuteOf(q.FromOrder)
	r.keyAt = sort.Search(len(x.keys), func(i int) bool { return x.keys[i] >= from })
	if q.FromOrder == "" || from < 0 {
		r.keyAt = sort.Search(len(x.keys), func(i int) bool { return x.keys[i] >= 0 })
	}
	if q.ToOrder != "" {
		if ms := orderMS(q.ToOrder[:min(15, len(q.ToOrder))]); ms >= 0 {
			r.hiMinute = ms - ms%SeriesMinute
		}
	}
	return r
}

func (r *historyReader) close() {
	for _, f := range r.files {
		f.Close()
	}
}

// frontier is a lower bound on the order of every disk event of the window not yet read; ok is
// false when everything has been read.
func (r *historyReader) frontier() (string, bool) {
	if len(r.queue) > 0 {
		return r.queue[0].minOrder, true
	}
	x := &r.s.oidx
	if r.keyAt < len(x.keys) && (r.hiMinute == -2 || x.keys[r.keyAt] <= r.hiMinute) {
		return orderPrefix(x.keys[r.keyAt]), true
	}
	return "", false
}

// wanted says whether a chunk can hold a disk event of the window.
func (r *historyReader) wanted(c *chunk) bool {
	s := r.s
	return c.maxOrder >= r.q.FromOrder && (r.q.ToOrder == "" || c.minOrder < r.q.ToOrder) && c.hi > s.diskFloor && c.lo < s.first
}

// step opens the next minute or reads the next chunk, returning the window's events found.
func (r *historyReader) step() ([]Entry, error) {
	x := &r.s.oidx
	if len(r.queue) == 0 {
		m := x.keys[r.keyAt]
		r.keyAt++
		for _, c := range x.minutes[m] {
			if r.wanted(&c) {
				r.queue = append(r.queue, c)
			}
		}
		sort.SliceStable(r.queue, func(i, j int) bool { return r.queue[i].minOrder < r.queue[j].minOrder })
		r.queueMin = m
		return nil, nil
	}
	c := r.queue[0]
	r.queue = r.queue[1:]
	return r.read(&c, r.queueMin)
}

// readSpecial reads the chunks whose events' order keys have no time prefix (none in practice).
func (r *historyReader) readSpecial() ([]Entry, error) {
	r.special = true
	var out []Entry
	for _, c := range r.s.oidx.minutes[-1] {
		if !r.wanted(&c) {
			continue
		}
		got, err := r.read(&c, -1)
		if err != nil {
			return nil, err
		}
		out = append(out, got...)
	}
	return out, nil
}

// read reads one chunk's byte range and returns its minute's events in the window that match.
func (r *historyReader) read(c *chunk, minute int64) ([]Entry, error) {
	s := r.s
	f := r.files[c.seg]
	if f == nil {
		var err error
		if f, err = os.Open(s.segmentPath(int(c.seg))); err != nil {
			return nil, fmt.Errorf("could not read the index log: %w", err)
		}
		if r.files == nil {
			r.files = map[int32]*os.File{}
		}
		r.files[c.seg] = f
	}
	buf := make([]byte, c.end-c.off)
	if _, err := f.ReadAt(buf, c.off); err != nil {
		return nil, fmt.Errorf("could not read the index log: %w", err)
	}
	var out []Entry
	at := c.off
	for len(buf) > 0 {
		i := bytes.IndexByte(buf, '\n')
		if i < 0 {
			i = len(buf)
		}
		line := buf[:i]
		start := at
		at += int64(i + 1)
		buf = buf[min(i+1, len(buf)):]
		r.examined++
		order := lineOrder(line)
		if minuteOf(order) != minute || order < r.q.FromOrder || r.q.ToOrder != "" && order >= r.q.ToOrder {
			continue
		}
		filtered := r.q.Ticket != "" || r.q.Execution != "" || r.q.TypePrefix != "" || len(r.want) > 0
		if filtered {
			// Decode only what the filters need; expand only what matches.
			var h histLine
			if json.Unmarshal(line, &h) != nil {
				return nil, fmt.Errorf("the index log has an unreadable line")
			}
			if h.Pos <= s.diskFloor || h.Pos >= s.first || h.Pos < c.lo || h.Pos > c.hi ||
				!r.q.matches(h.IDs.TicketID, h.IDs.ExecutionID, h.Type, h.Entities, r.want) {
				continue
			}
		}
		e, err := s.expand(line)
		if err != nil {
			return nil, err
		}
		if p := e.Event.Pos; p <= s.diskFloor || p >= s.first || p < c.lo || p > c.hi {
			continue
		}
		e.loc = diskLoc{seg: c.seg, off: start, n: int32(len(line))}
		out = append(out, e)
	}
	return out, nil
}

func entryLess(a, b *Entry) bool {
	return a.Event.Order < b.Event.Order || a.Event.Order == b.Event.Order && a.Event.Pos < b.Event.Pos
}

// History returns the events whose order is in [FromOrder, ToOrder) and that match the filters,
// sorted by order (late events appear where they belong, not where they were delivered), ties by
// position. It merges the memory window (through its order index) with the segments on disk for
// the events that left it (through the order index on disk). A page never splits events sharing
// an order key; it stops early, with More and Next, after HistoryScanCap lines read from disk.
func (s *Store) History(q HistoryQuery) HistoryPage {
	if q.Limit <= 0 {
		q.Limit = 1000
	}
	q.Limit = min(q.Limit, MaxHistory)
	want := map[string]bool{}
	for _, e := range q.Entities {
		want[e] = true
	}
	s.mu.Lock()
	s.sortOrder()
	s.mu.Unlock()
	s.mu.RLock()
	defer s.mu.RUnlock()
	var complete bool
	if s.cur == nil {
		complete = s.evictedMax == "" || q.FromOrder != "" && q.FromOrder > s.evictedMax
	} else {
		complete = s.oidx.lostMax == "" || q.FromOrder > s.oidx.lostMax
	}

	// The memory window, in order.
	mi := sort.Search(len(s.byOrder), func(i int) bool { return s.byOrder[i].order >= q.FromOrder })
	memHead := func() *Entry {
		for ; mi < len(s.byOrder); mi++ {
			r := s.byOrder[mi]
			if q.ToOrder != "" && r.order >= q.ToOrder {
				return nil
			}
			if r.pos < s.first {
				continue
			}
			e := &s.entries[r.pos-s.first]
			if q.matches(e.Event.IDs.TicketID, e.Event.IDs.ExecutionID, e.Event.Type, e.Event.Entities, want) {
				return e
			}
		}
		return nil
	}

	// The segments, for what left it.
	var disk *historyReader
	var pending []Entry
	var readErr error
	if s.cur != nil && s.first > s.diskFloor+1 {
		disk = s.newHistoryReader(q, want)
		defer disk.close()
		if len(s.oidx.minutes[-1]) > 0 {
			pending, readErr = disk.readSpecial()
			sort.Slice(pending, func(i, j int) bool { return entryLess(&pending[i], &pending[j]) })
		}
	}

	var out []Entry
	stopped, capped := false, false
	frontier, more := "", false
	for readErr == nil {
		if disk != nil {
			frontier, more = disk.frontier()
		}
		m := memHead()
		var h *Entry
		fromDisk := false
		if len(pending) > 0 && (m == nil || entryLess(&pending[0], m)) {
			h, fromDisk = &pending[0], true
		} else {
			h = m
		}
		if h != nil && (!more || h.Event.Order < frontier) {
			out = append(out, *h)
			if fromDisk {
				pending = pending[1:]
			} else {
				mi++
			}
			if len(out) > q.Limit && out[len(out)-1].Event.Order != out[q.Limit-1].Event.Order {
				stopped = true
				break
			}
			continue
		}
		if !more {
			break // everything in the window has been read
		}
		if disk.examined >= HistoryScanCap && frontier > q.FromOrder {
			capped = true
			break
		}
		got, err := disk.step()
		if err != nil {
			readErr = err
			break
		}
		if len(got) > 0 {
			pending = append(pending, got...)
			sort.Slice(pending, func(i, j int) bool { return entryLess(&pending[i], &pending[j]) })
		}
	}
	if readErr != nil {
		// The segments could not be read: serve what was found before, and say so.
		complete = false
	}

	page := HistoryPage{Complete: complete}
	if stopped || capped && len(out) > q.Limit {
		// Do not split events that share an order key: the next page starts at that key; when the
		// whole page is one key, take all of it and start after it.
		k := out[q.Limit-1].Event.Order
		g := q.Limit - 1
		for g > 0 && out[g-1].Event.Order == k {
			g--
		}
		switch {
		case out[q.Limit].Event.Order != k:
			page.Next, out = out[q.Limit].Event.Order, out[:q.Limit]
		case g > 0:
			page.Next, out = k, out[:g]
		case stopped:
			last := len(out) - 1
			page.Next, out = out[last].Event.Order, out[:last]
		default:
			page.Next = frontier
		}
		page.More = true
	} else if capped {
		page.Next, page.More = frontier, true
	}
	if page.More && page.Next == "" {
		page.More = false
	}
	if s.fill(out) != nil {
		// An envelope could not be read back: leave it out and say the window is not complete.
		kept := out[:0]
		for _, e := range out {
			if e.Raw != nil {
				kept = append(kept, e)
			}
		}
		out, page.Complete = kept, false
	}
	page.Entries = out
	page.Capped = capped
	return page
}
