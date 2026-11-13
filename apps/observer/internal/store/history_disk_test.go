package store

import (
	"fmt"
	"math/rand"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/tail"
	"mach/observer/internal/testkit"
)

// genHistory makes n events shaped like a real index: a catch-up that reads one source after
// another (each in its own order), then live events from every source interleaved, with late
// events (an order long past) and ties (several events sharing an order key). Times start at base.
func genHistory(n int, seed int64) []*event.Event {
	rng := rand.New(rand.NewSource(seed))
	const base = int64(1_800_000_000_000)
	kinds := []string{"station.entered", "station.exited", "gate.evaluated", "tool.called", "dependency.blocked"}
	auths := []string{event.Authoritative, "derived", "observed"}
	sources := 12
	var out []*event.Event
	mk := func(i int, src int, ms int64, seq int) *event.Event {
		ticket := fmt.Sprintf("T-%d", src%7)
		if src == 11 {
			ticket = "" // a source with no ticket (the scheduler)
		}
		e := &event.Event{ID: fmt.Sprintf("e%07d", i), Type: kinds[rng.Intn(len(kinds))], Authority: auths[rng.Intn(len(auths))],
			Order: event.OrderKey(ms, 2, fmt.Sprintf("c:%d", src), int64(seq), 0),
			IDs:   event.IDs{TicketID: ticket, ExecutionID: fmt.Sprintf("x%02d", src%5)}, Entities: []string{fmt.Sprintf("cell:S%d", src)}}
		e.Time.OrderMS = ms
		return e
	}
	catchUp := n * 6 / 10
	per := catchUp / sources
	i := 0
	for src := 0; src < sources; src++ {
		ms := base + int64(src)*7_000
		for k := 0; k < per; k++ {
			ms += int64(rng.Intn(4000))
			seq := k
			if k > 0 && rng.Intn(50) == 0 {
				seq = k - 1 // a tie with the previous event of this source
				ms = orderMS(out[len(out)-1].Order)
			}
			out = append(out, mk(i, src, ms, seq))
			i++
		}
	}
	last := make([]int64, sources)
	for src := range last {
		last[src] = base + int64(per)*2000 + int64(src)*1000
	}
	for i < n {
		src := rng.Intn(sources)
		last[src] += int64(rng.Intn(3000))
		ms := last[src]
		if rng.Intn(200) == 0 {
			ms = base + rng.Int63n(int64(per)*2000) // late: an order long past
		}
		out = append(out, mk(i, src, ms, i))
		i++
	}
	return out
}

func appendAll(t testing.TB, s *Store, evs []*event.Event, batch int) {
	t.Helper()
	for i := 0; i < len(evs); i += batch {
		if _, err := s.Append(evs[i:min(i+batch, len(evs))], map[string]tail.Checkpoint{"ledger": {Offset: int64(i)}}); err != nil {
			t.Fatal(err)
		}
	}
}

// heldInOrder is every held event (After from the floor), sorted by order then position.
func heldInOrder(t testing.TB, s *Store) []Entry {
	t.Helper()
	floor, _ := s.Bounds()
	var all []Entry
	for pos := floor; ; {
		b, err := s.After(pos, 10000)
		if err != nil {
			t.Fatal(err)
		}
		if len(b) == 0 {
			break
		}
		all = append(all, b...)
		pos = b[len(b)-1].Event.Pos
	}
	sort.Slice(all, func(i, j int) bool { return entryLess(&all[i], &all[j]) })
	return all
}

// bruteHistory is the brute-force answer to q: the ids of the held events matching it, in order.
func bruteHistory(all []Entry, q HistoryQuery) []string {
	want := map[string]bool{}
	for _, e := range q.Entities {
		want[e] = true
	}
	var ids []string
	for _, e := range all {
		h := e.Event
		if h.Order < q.FromOrder || q.ToOrder != "" && h.Order >= q.ToOrder || !q.matches(h.IDs.TicketID, h.IDs.ExecutionID, h.Type, h.Entities, want) {
			continue
		}
		ids = append(ids, h.ID)
	}
	return ids
}

// pageAll pages through a window and checks every page: in order, no tie split across pages, Next
// after the page, an envelope for every event. It returns the ids and how many pages were capped.
func pageAll(t testing.TB, s *Store, q HistoryQuery) ([]string, int, bool) {
	t.Helper()
	var ids []string
	capped := 0
	complete := true
	prev := ""
	for pages := 0; ; pages++ {
		if pages > 100000 {
			t.Fatal("paging does not end")
		}
		p := s.History(q)
		complete = complete && p.Complete
		if p.Capped {
			capped++
			if !p.More {
				t.Fatal("a capped page says there is no more")
			}
		}
		for _, e := range p.Entries {
			if e.Event.Order < prev {
				t.Fatalf("out of order: %s after %s", e.Event.Order, prev)
			}
			if len(e.Raw) == 0 || !strings.Contains(string(e.Raw), `"id":"`+e.Event.ID+`"`) {
				t.Fatalf("envelope of %s: %s", e.Event.ID, e.Raw)
			}
			prev = e.Event.Order
			ids = append(ids, e.Event.ID)
		}
		if !p.More {
			return ids, capped, complete
		}
		if len(p.Entries) > 0 && p.Entries[len(p.Entries)-1].Event.Order >= p.Next {
			t.Fatalf("next %s does not follow the page's last key %s (a tie split?)", p.Next, p.Entries[len(p.Entries)-1].Event.Order)
		}
		if p.Next <= q.FromOrder {
			t.Fatalf("no progress: next %s from %s", p.Next, q.FromOrder)
		}
		q.FromOrder = p.Next
	}
}

func sameIDs(t testing.TB, label string, got, want []string) {
	t.Helper()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		n := 0
		for n < len(got) && n < len(want) && got[n] == want[n] {
			n++
		}
		t.Fatalf("%s: %d events, want %d; first difference at %d", label, len(got), len(want), n)
	}
}

// History reaches past the memory window: windows held in memory, on disk only, and straddling
// the boundary each match a brute-force ordered scan of everything held, with filters, late
// events where they belong, pages that never split a tie, and the same after a reopen (the order
// index rebuilt from the segments).
func TestHistoryFallsBackToTheSegments(t *testing.T) {
	dir := t.TempDir()
	n, limits := 24000, []int{1, 7, 250, 5000}
	opts := Options{MaxMemory: 3000, HotRaw: 500, SegmentBytes: 512 << 10}
	if testing.Short() || testkit.Race {
		n, limits = 9000, []int{7, 250}
		opts.MaxMemory, opts.SegmentBytes = 1500, 256<<10
	}
	s, err := OpenWith(dir, opts)
	if err != nil {
		t.Fatal(err)
	}
	evs := genHistory(n, 1)
	appendAll(t, s, evs, 400)
	if s.Info().Segments < 3 {
		t.Fatalf("expected several segments: %+v", s.Info())
	}

	// Windows by where their events are: in the memory window, on disk only, and both.
	sorted := append([]*event.Event(nil), evs...)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].Order < sorted[j].Order || sorted[i].Order == sorted[j].Order && sorted[i].Pos < sorted[j].Pos
	})
	first := s.first
	findWindow := func(want func(mem, disk int) bool) (string, string) {
		for i := 0; i+400 < len(sorted); i += 50 {
			mem, disk := 0, 0
			for _, e := range sorted[i : i+400] {
				if e.Pos >= first {
					mem++
				} else {
					disk++
				}
			}
			if want(mem, disk) && sorted[i+400].Order > sorted[i].Order {
				return sorted[i].Order, sorted[i+400].Order
			}
		}
		t.Fatal("no such window in the generated history")
		return "", ""
	}
	type window struct {
		label    string
		from, to string
	}
	memFrom, memTo := findWindow(func(mem, disk int) bool { return disk == 0 })
	diskFrom, diskTo := findWindow(func(mem, disk int) bool { return mem == 0 })
	bothFrom, bothTo := findWindow(func(mem, disk int) bool { return mem > 50 && disk > 50 })
	windows := []window{{"in memory", memFrom, memTo}, {"on disk", diskFrom, diskTo}, {"straddling", bothFrom, bothTo}, {"everything", "", ""}}
	filters := []HistoryQuery{{}, {Ticket: "T-3"}, {Execution: "x02", TypePrefix: "station."}, {Entities: []string{"cell:S4", "cell:S9"}}}
	check := func(s *Store, label string) {
		all := heldInOrder(t, s)
		for _, w := range windows {
			for fi, f := range filters {
				for _, limit := range limits {
					if limit < 250 && w.label == "everything" {
						continue
					}
					q := f
					q.FromOrder, q.ToOrder, q.Limit = w.from, w.to, limit
					got, _, complete := pageAll(t, s, q)
					want := bruteHistory(all, q)
					sameIDs(t, fmt.Sprintf("%s: %s, filter %d, limit %d", label, w.label, fi, limit), got, want)
					if !complete {
						t.Fatalf("%s: %s: nothing was dropped, yet not complete", label, w.label)
					}
				}
			}
		}
		// Late events come back where they belong, from disk.
		late := 0
		for _, e := range evs {
			if e.Pos < first && e.Pos > 1 && orderMS(e.Order) < orderMS(evs[e.Pos-2].Order)-600_000 {
				p := s.History(HistoryQuery{FromOrder: e.Order, Limit: 1})
				if len(p.Entries) == 0 || p.Entries[0].Event.Order != e.Order {
					t.Fatalf("%s: late event %s not at its order", label, e.ID)
				}
				late++
			}
		}
		if late == 0 {
			t.Fatal("the generated history has no late event on disk")
		}
	}
	check(s, "live")
	s.Close()
	r, err := OpenWith(dir, opts)
	if err != nil || r.Info().Rebuilt != "" {
		t.Fatalf("%v %q", err, r.Info().Rebuilt)
	}
	defer r.Close()
	if r.oidx.chunks == 0 {
		t.Fatal("the order index was not rebuilt")
	}
	check(r, "after a reopen")
}

// A page that reads HistoryScanCap lines from disk without filling stops early with more=true
// and a next key past what it read: never a short page presented as the end.
func TestHistoryScanCapStopsWithMore(t *testing.T) {
	s, err := OpenWith(t.TempDir(), Options{MaxMemory: 1000, SegmentBytes: 1 << 20})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	evs := genHistory(40000, 2)
	rare := 0
	for i, e := range evs {
		if i%2500 == 7 {
			e.IDs.TicketID = "RARE"
			rare++
		}
	}
	appendAll(t, s, evs, 1000)
	q := HistoryQuery{Ticket: "RARE", Limit: 100}
	first := s.History(q)
	if !first.Capped || !first.More || first.Next == "" || len(first.Entries) >= rare {
		t.Fatalf("first page: capped %v more %v next %q, %d events", first.Capped, first.More, first.Next, len(first.Entries))
	}
	got, capped, _ := pageAll(t, s, q)
	sameIDs(t, "rare ticket", got, bruteHistory(heldInOrder(t, s), q))
	if capped < 2 {
		t.Fatalf("only %d capped pages", capped)
	}
}

// When retention drops segments, a window reaching into what was dropped is not complete; one
// after it is, and matches a brute-force scan of what is held.
func TestHistoryAfterRetentionDrops(t *testing.T) {
	s, err := OpenWith(t.TempDir(), Options{MaxMemory: 500, SegmentBytes: 128 << 10, RetainBytes: 1 << 20})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	evs := genHistory(15000, 3)
	appendAll(t, s, evs, 500)
	if s.Info().Dropped == 0 {
		t.Fatal("no segment was dropped")
	}
	if p := s.History(HistoryQuery{Limit: 10}); p.Complete {
		t.Fatal("a window from the start is complete although segments were dropped")
	}
	from := s.oidx.lostMax + "~" // just after the largest order that may have been lost
	q := HistoryQuery{FromOrder: from, Limit: 300}
	got, _, complete := pageAll(t, s, q)
	if !complete {
		t.Fatal("a window after everything dropped is not complete")
	}
	sameIDs(t, "after the drop", got, bruteHistory(heldInOrder(t, s), q))
}

// Per-ticket and per-execution counts per minute cover the whole history, also after a reopen,
// and match a brute-force count; past the bound, the oldest minutes go and a filtered series
// reaching before them is not complete.
func TestSeriesPerTicketCoversTheWholeHistory(t *testing.T) {
	dir := t.TempDir()
	opts := Options{MaxMemory: 1000, SegmentBytes: 1 << 20}
	s, _ := OpenWith(dir, opts)
	evs := genHistory(20000, 4)
	appendAll(t, s, evs, 1000)
	lo, hi := s.SeriesBounds()
	brute := func(ticket, execution string, bucket int64) map[int64]SeriesBucket {
		out := map[int64]SeriesBucket{}
		for _, e := range evs {
			if ticket != "" && e.IDs.TicketID != ticket || execution != "" && e.IDs.ExecutionID != execution {
				continue
			}
			k := lo + (e.Time.OrderMS-lo)/bucket*bucket
			b, ok := out[k]
			if !ok {
				b = SeriesBucket{FromMS: k, Kinds: map[string]int64{}, Authorities: map[string]int64{}}
			}
			b.Count++
			b.Kinds[e.Type]++
			b.Authorities[e.Authority]++
			out[k] = b
		}
		return out
	}
	check := func(s *Store, label string) {
		for _, f := range []SeriesQuery{{Ticket: "T-3"}, {Ticket: "T-0"}, {Execution: "x04"}, {Ticket: "NONE"}} {
			for _, bucket := range []int64{60_000, 600_000, 3_600_000} {
				r := s.Series(SeriesQuery{FromMS: lo, ToMS: hi + 1, BucketMS: bucket, Ticket: f.Ticket, Execution: f.Execution})
				if r.Source != "minutes" || !r.Complete {
					t.Fatalf("%s %+v: source %s complete %v", label, f, r.Source, r.Complete)
				}
				want := brute(f.Ticket, f.Execution, bucket)
				if len(r.Buckets) != len(want) {
					t.Fatalf("%s %+v/%d: %d buckets, want %d", label, f, bucket, len(r.Buckets), len(want))
				}
				for _, b := range r.Buckets {
					w := want[b.FromMS]
					if b.Count != w.Count || fmt.Sprint(b.Kinds) != fmt.Sprint(w.Kinds) || fmt.Sprint(b.Authorities) != fmt.Sprint(w.Authorities) {
						t.Fatalf("%s %+v/%d at %d: %+v want %+v", label, f, bucket, b.FromMS, b, w)
					}
				}
			}
		}
		if r := s.Series(SeriesQuery{FromMS: lo, ToMS: hi + 1, BucketMS: 60_000, Ticket: "T-3", Execution: "x03"}); r.Source != "memory-window" || r.Complete {
			t.Fatalf("%s: two filters are counted from the memory window: %+v", label, r.Source)
		}
	}
	check(s, "live")
	s.Close()
	r, _ := OpenWith(dir, opts)
	check(r, "after a reopen")
	r.Close()

	keyedCellLimit = 400
	defer func() { keyedCellLimit = MaxKeyedCells }()
	b, _ := OpenWith(dir, opts)
	defer b.Close()
	if b.series.cells > 400 || b.series.keyedFloor == 0 {
		t.Fatalf("bound: %d cells, floor %d", b.series.cells, b.series.keyedFloor)
	}
	if r := b.Series(SeriesQuery{FromMS: lo, ToMS: hi + 1, BucketMS: 60_000, Ticket: "T-3"}); r.Complete {
		t.Fatal("a series reaching before the kept minutes is complete")
	}
	from := b.series.keyedFloor
	r2 := b.Series(SeriesQuery{FromMS: from, ToMS: hi + 1, BucketMS: 60_000, Ticket: "T-3"})
	var n int64
	for _, e := range evs {
		if e.IDs.TicketID == "T-3" && e.Time.OrderMS >= from {
			n++
		}
	}
	if !r2.Complete || r2.Total != n {
		t.Fatalf("after the kept floor: complete %v total %d want %d", r2.Complete, r2.Total, n)
	}
}

// TestHistoryDiskVolume measures, on a ~250,000-event index with the default memory window: the
// time to open it (the order index and per-key counts rebuilt), a 1,000-event history page from
// its oldest part (on disk), and the memory the order index and per-key counts add. Skipped with
// -short and under the race detector.
func TestHistoryDiskVolume(t *testing.T) {
	if testing.Short() || testkit.Race {
		t.Skip("volume measurement")
	}
	dir := t.TempDir()
	s, err := OpenWith(dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	evs := genHistory(250000, 5)
	start := time.Now()
	appendAll(t, s, evs, 2000)
	ingest := time.Since(start)
	s.Close()
	evs = nil
	runtime.GC()

	start = time.Now()
	r, err := OpenWith(dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	open := time.Since(start)
	q := HistoryQuery{Limit: 1000}
	start = time.Now()
	p := r.History(q)
	cold := time.Since(start)
	start = time.Now()
	for i := 0; i < 20; i++ {
		p = r.History(q)
	}
	warm := time.Since(start) / 20
	if len(p.Entries) < 1000 || !p.More || !p.Complete || p.Entries[0].Event.Pos >= r.first {
		t.Fatalf("oldest page: %d events, more %v, complete %v", len(p.Entries), p.More, p.Complete)
	}
	mid := r.History(HistoryQuery{FromOrder: p.Next, Limit: 1000, Ticket: "T-2"})

	start = time.Now()
	tp := r.History(HistoryQuery{Limit: 1000, Ticket: "T-2"})
	ticketPage := time.Since(start)

	est := r.oidx.memBytes() + r.series.keyedBytes()
	chunks := r.oidx.chunks
	cells := r.series.cells
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	with := ms.HeapAlloc
	r.mu.Lock()
	r.oidx, r.series.keyed = orderIndex{}, nil // dropped for the measurement; r is not read again
	r.mu.Unlock()
	runtime.GC()
	runtime.ReadMemStats(&ms)
	without := ms.HeapAlloc
	t.Logf("history disk volume: %d events (append %s); reopen %s; oldest 1,000-event page %s cold, %s warm; oldest 1,000 of one ticket %s (%d events, capped %v); next page %d events; order index %d chunks, per-key counts %d cells: %.2f MiB measured (%.2f MiB estimated)",
		r.Head(), ingest.Round(time.Millisecond), open.Round(time.Millisecond), cold.Round(time.Microsecond), warm.Round(time.Microsecond),
		ticketPage.Round(time.Microsecond), len(tp.Entries), tp.Capped, len(mid.Entries), chunks, cells, float64(int64(with)-int64(without))/(1<<20), float64(est)/(1<<20))
}

// A8: /history reads the segments without the store's lock, so appends (which evict the memory
// window to disk and roll segments) go on while a page is read; a window written before the
// appends answers the same (run under -race).
func TestHistoryReadsTheSegmentsOutsideTheLock(t *testing.T) {
	n := 12000
	if testing.Short() || testkit.Race {
		n = 6000
	}
	s, err := OpenWith(t.TempDir(), Options{MaxMemory: 1500, HotRaw: 300, SegmentBytes: 256 << 10})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	evs := genHistory(n, 3)
	appendAll(t, s, evs[:n/2], 300)
	_, to := s.Bounds()
	cut := ""
	for _, e := range heldInOrder(t, s) {
		cut = max(cut, e.Event.Order)
	}
	q := HistoryQuery{ToOrder: cut, Limit: 250}
	want := bruteHistory(heldInOrder(t, s), q)
	done := make(chan struct{})
	go func() {
		defer close(done)
		// Later events only (orders past the window), so the window's answer cannot change.
		var later []*event.Event
		for _, e := range evs[n/2:] {
			if e.Order > cut {
				later = append(later, e)
			}
		}
		for i := 0; i < len(later); i += 100 {
			s.Append(later[i:min(i+100, len(later))], map[string]tail.Checkpoint{"ledger": {Offset: int64(to) + int64(i)}})
		}
	}()
	for range 3 {
		got, _, complete := pageAll(t, s, q)
		sameIDs(t, "during appends", got, want)
		if !complete {
			t.Fatal("not complete")
		}
	}
	<-done
}
