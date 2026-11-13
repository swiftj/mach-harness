package store

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
	"mach/observer/internal/tail"
)

func ev(id string) *event.Event {
	return &event.Event{ID: id, Type: "t", Authority: event.Authoritative}
}

func batch(from, to int) []*event.Event {
	var out []*event.Event
	for i := from; i <= to; i++ {
		out = append(out, ev("e"+strconv.Itoa(i)))
	}
	return out
}

func TestAppendAfterAndDedupe(t *testing.T) {
	s, err := Open(t.TempDir(), 100)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	n, err := s.Append(batch(1, 3), nil)
	if err != nil || n != 3 {
		t.Fatalf("%d %v", n, err)
	}
	if n, _ := s.Append(append(batch(2, 3), ev("e4")), nil); n != 1 {
		t.Fatalf("duplicates were added: %d", n)
	}
	got, err := s.After(1, 10)
	if err != nil || len(got) != 3 || got[0].Event.ID != "e2" || got[2].Event.Pos != 4 {
		t.Fatalf("%v %v", got, err)
	}
	if _, err := s.After(5, 10); err != ErrFuture {
		t.Fatalf("future cursor: %v", err)
	}
	if s.Info().Duplicates != 2 {
		t.Fatalf("duplicates %d", s.Info().Duplicates)
	}
}

func TestEvictionAndExpiry(t *testing.T) {
	s, _ := Open("", 3)
	s.Append(batch(1, 5), nil)
	floor, head := s.Bounds()
	if floor != 2 || head != 5 {
		t.Fatalf("floor %d head %d", floor, head)
	}
	if _, err := s.After(1, 10); err != ErrExpired {
		t.Fatalf("expired cursor: %v", err)
	}
	if got, _ := s.After(2, 10); len(got) != 3 {
		t.Fatalf("from the floor: %d", len(got))
	}
}

func TestReopenKeepsGenerationPositionsAndCheckpoints(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, 100)
	gen := s.Generation()
	s.Append(batch(1, 3), map[string]tail.Checkpoint{"ledger": {Offset: 42, LastSeq: 3}})
	s.Close()

	r, err := Open(dir, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if r.Generation() != gen || r.Info().Rebuilt != "" {
		t.Fatalf("generation %s vs %s, rebuilt %q", r.Generation(), gen, r.Info().Rebuilt)
	}
	if _, head := r.Bounds(); head != 3 {
		t.Fatalf("head %d", head)
	}
	if r.Checkpoints()["ledger"].Offset != 42 {
		t.Fatal("checkpoint lost")
	}
	if n, _ := r.Append(batch(2, 4), nil); n != 1 {
		t.Fatalf("after reopen, held IDs are still deduplicated: added %d", n)
	}
	got, _ := r.After(3, 1)
	if got[0].Event.Cursor != gen+".4" {
		t.Fatalf("cursor %s", got[0].Event.Cursor)
	}
}

func TestTornIndexTailIsCut(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, 100)
	s.Append(batch(1, 2), map[string]tail.Checkpoint{"ledger": {Offset: 1}})
	s.Close()
	f, _ := os.OpenFile(filepath.Join(dir, "segment-000001.log"), os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"schema_version":3,"id":"e3","po`)
	f.Close()
	r, err := Open(dir, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, head := r.Bounds(); head != 2 || r.Info().Rebuilt != "" {
		t.Fatalf("head %d rebuilt %q", head, r.Info().Rebuilt)
	}
	if n, _ := r.Append(batch(3, 3), nil); n != 1 {
		t.Fatal("append after a cut tail")
	}
}

func TestChangedRulesRebuildUnderNewGeneration(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, 100)
	gen := s.Generation()
	s.Append(batch(1, 2), nil)
	s.Close()
	var meta Meta
	data, _ := os.ReadFile(filepath.Join(dir, "meta.json"))
	json.Unmarshal(data, &meta)
	meta.RedactionVersion = redact.Version - 1
	data, _ = json.Marshal(meta)
	os.WriteFile(filepath.Join(dir, "meta.json"), data, 0o600)

	r, _ := Open(dir, 100)
	defer r.Close()
	if r.Generation() == gen || r.Info().Rebuilt != "redaction rules changed" {
		t.Fatalf("generation %s rebuilt %q", r.Generation(), r.Info().Rebuilt)
	}
	if _, head := r.Bounds(); head != 0 || len(r.Checkpoints()) != 0 {
		t.Fatal("a rebuilt index starts empty and reads every source again")
	}
}

func TestChangedClosesOnAppend(t *testing.T) {
	s, _ := Open("", 10)
	ch := s.Changed()
	s.Append(batch(1, 1), nil)
	select {
	case <-ch:
	default:
		t.Fatal("readers were not woken")
	}
}

func evAt(id, ticket, order string, refs ...string) *event.Event {
	return &event.Event{ID: id, Type: "station.entered", Authority: event.Authoritative, Order: order,
		IDs: event.IDs{TicketID: ticket, ExecutionID: "x" + ticket}, Entities: refs}
}

func TestSegmentsRollRetainAndServeBelowMemory(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenWith(dir, Options{MaxMemory: 50, SegmentBytes: 20 << 10, RetainBytes: 200 << 10})
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2000; i += 10 {
		s.Append(batch(i, i+9), map[string]tail.Checkpoint{"ledger": {Offset: int64(i)}})
	}
	info := s.Info()
	if info.Segments < 3 || info.Dropped == 0 || info.DiskBytes > 240<<10 {
		t.Fatalf("segments %+v", info)
	}
	floor, head := s.Bounds()
	if head != 2000 || floor == 0 || floor >= 1950 {
		t.Fatalf("floor %d head %d", floor, head)
	}
	got, err := s.After(floor, 100) // below the memory window: read from the segments
	if err != nil || len(got) != 100 || got[0].Event.Pos != floor+1 || got[99].Event.Pos != floor+100 || got[0].Event.Cursor == "" {
		t.Fatalf("%d %v", len(got), err)
	}
	if _, err := s.After(floor-1, 1); err != ErrExpired {
		t.Fatalf("below the retained floor: %v", err)
	}
	s.Close()
	r, err := OpenWith(dir, Options{MaxMemory: 50, SegmentBytes: 20 << 10, RetainBytes: 200 << 10})
	if err != nil || r.Info().Rebuilt != "" {
		t.Fatalf("%v %q", err, r.Info().Rebuilt)
	}
	defer r.Close()
	if f2, h2 := r.Bounds(); f2 != floor || h2 != 2000 {
		t.Fatalf("after reopen floor %d head %d", f2, h2)
	}
	if n, _ := r.Append(batch(2001, 2001), nil); n != 1 {
		t.Fatal("append after reopen")
	}
}

func TestQueriesAndHistoryOrder(t *testing.T) {
	s, _ := Open("", 100)
	s.Append([]*event.Event{
		evAt("a", "T-1", "000000000000003~2~c~000000000001~0000", "cell:T-1"),
		evAt("b", "T-2", "000000000000001~2~c~000000000001~0000", "cell:T-2"),
		evAt("c", "T-1", "000000000000002~2~c~000000000002~0000", "cell:T-1", "visit:T-1/build#1"),
	}, nil)
	p, _ := s.ByTicket("T-1", 0, 10)
	if len(p.Entries) != 2 || p.Entries[1].Event.ID != "c" {
		t.Fatalf("%+v", p)
	}
	p, _ = s.ByEntity("visit:T-1/build#1", 0, 10)
	if len(p.Entries) != 1 {
		t.Fatal("entity")
	}
	p, _ = s.ByExecution("xT-2", 0, 10)
	if len(p.Entries) != 1 || p.Entries[0].Event.ID != "b" {
		t.Fatal("execution")
	}
	p, _ = s.Run(Query{After: 1, TypePrefix: "station."})
	if len(p.Entries) != 2 {
		t.Fatal("type prefix after a cursor")
	}
	h := s.History(HistoryQuery{Entities: []string{"cell:T-1"}, Limit: 10})
	if len(h.Entries) != 2 || h.Entries[0].Event.ID != "c" || h.More || !h.Complete {
		t.Fatalf("history in order: %+v", h)
	}
	if s.MaxOrder() != "000000000000003~2~c~000000000001~0000" {
		t.Fatal(s.MaxOrder())
	}
	if e, ok := s.Get("b"); !ok || e.Event.Pos != 2 {
		t.Fatal("get")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go s.Append(batch(9, 9), nil)
	if err := s.Wait(ctx, 3); err != nil {
		t.Fatal(err)
	}
}

func TestOldFormatIndexIsRebuilt(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "meta.json"), []byte(`{"format":1,"generation":"0123456789abcdef","redaction_version":1,"event_version":3}`), 0o600)
	os.WriteFile(filepath.Join(dir, "events.log"), []byte(`{"v":3}`+"\n"), 0o600)
	s, err := Open(dir, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Info().Rebuilt != "index format changed" {
		t.Fatal(s.Info().Rebuilt)
	}
	if _, err := os.Stat(filepath.Join(dir, "events.log")); err == nil {
		t.Fatal("the old log was kept")
	}
}

// /history pages through a window in order, never splits a tie between pages, filters by ticket,
// execution, type and entity, and says when the window may have lost events to eviction.
func TestHistoryPagesFiltersAndCompleteness(t *testing.T) {
	s, _ := Open("", 6)
	order := func(ms int) string { return event.OrderKey(int64(ms), 2, "c:T-1:g", int64(ms), 0) }
	var evs []*event.Event
	for i, ms := range []int{5, 1, 3, 3, 3, 2, 4, 9} { // delivered out of order; three share ms 3
		e := evAt("e"+strconv.Itoa(i), "T-1", order(ms), "cell:T-1")
		if ms == 9 {
			e.IDs.TicketID, e.IDs.ExecutionID, e.Entities = "T-2", "xT-2", []string{"cell:T-2"}
		}
		evs = append(evs, e)
	}
	s.Append(evs, nil) // 8 events, memory window 6: the first two delivered (ms 5 and 1) are evicted
	p := s.History(HistoryQuery{Limit: 2})
	if p.Complete || len(p.Entries) != 1 || p.Entries[0].Event.Order != order(2) || !p.More || p.Next != order(3) {
		t.Fatalf("first page: %+v", p) // two requested, but the second would split the three at ms 3
	}
	p = s.History(HistoryQuery{FromOrder: p.Next, Limit: 2})
	if len(p.Entries) != 3 || !p.More || p.Next != order(4) {
		t.Fatalf("ties come whole: %+v", p)
	}
	if p := s.History(HistoryQuery{FromOrder: order(6), Ticket: "T-2"}); !p.Complete || len(p.Entries) != 1 || p.More {
		t.Fatalf("after everything evicted, filtered: %+v", p)
	}
	if p := s.History(HistoryQuery{FromOrder: order(4), ToOrder: order(9), Execution: "xT-1", TypePrefix: "station."}); len(p.Entries) != 1 {
		t.Fatalf("[4, 9): %+v", p)
	}
	if p := s.History(HistoryQuery{FromOrder: order(5)}); p.Complete {
		t.Fatal("ms 5 was evicted: a window from it is not complete")
	}
}

// The index keeps events in their compact form on disk and serves the full envelope: an event
// read back from a segment is byte for byte the one appended, and the compact line is smaller.
func TestCompactRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenWith(dir, Options{MaxMemory: 1})
	if err != nil {
		t.Fatal(err)
	}
	seq, part := int64(7), 0
	ev := &event.Event{ID: "c:T-1:abc:7", Type: "station.exited", Authority: event.Authoritative, Order: "001~2~c~000000000007~0000",
		Origin: event.Origin{Stream: "cell-lifecycle", Key: "c:T-1:abc", Seq: seq, Part: &part, Writer: "build.py", RuntimeState: ""},
		Time:   event.Time{OccurredAt: "2026-11-12T10:00:00.000Z", Precision: "ms", ObservedAt: "2026-11-12T10:00:00.100Z", OrderMS: 1794477600000},
		IDs:    event.IDs{TicketID: "T-1", Station: "plan", Round: 1}, Entities: []string{"cell:T-1"},
		Data:       map[string]any{"station": "plan", "outcome": "planned", "stage": "planned", "duration_ms": nil, "closed_by": nil, "head": nil, "counts": map[string]any{"tasks": 3.0}},
		Provenance: &event.Provenance{Basis: []string{}, Rule: "backfill", Files: []string{}}}
	s.Append([]*event.Event{ev, evAt("b", "T-2", "002~2~c~000000000001~0000")}, nil)
	want, _ := json.Marshal(ev)
	got, err := s.After(0, 1) // below the memory window of one: read from disk
	if err != nil || len(got) != 1 || string(got[0].Raw) != string(want) {
		t.Fatalf("%v\n got %s\nwant %s", err, got[0].Raw, want)
	}
	compact, _ := ev.MarshalCompact()
	if len(compact) >= len(want) {
		t.Fatalf("compact %d >= full %d", len(compact), len(want))
	}
	s.Close()
}

// History reads a window through the order index: late arrivals sit where they belong, pages
// never split a tie, and a page is O(window): a narrow window of a long history touches only it.
func TestHistoryOrderIndexPagesAndLateArrivals(t *testing.T) {
	s, _ := Open("", 100000)
	key := func(ms int, seq int) string { return fmt.Sprintf("%015d~2~c~%012d~0000", ms, seq) }
	var b []*event.Event
	for i := 1; i <= 3000; i++ {
		b = append(b, evAt(fmt.Sprintf("e%d", i), "T-1", key(i*10, i)))
	}
	s.Append(b, nil)
	// Late: three events that sort inside the history, one a tie with an existing key.
	s.Append([]*event.Event{evAt("late1", "T-2", key(15, 1)), evAt("late2", "T-2", key(20, 2)), evAt("late3", "T-2", key(29995, 0))}, nil)
	h := s.History(HistoryQuery{FromOrder: key(10, 0), ToOrder: key(31, 0), Limit: 10})
	var ids []string
	for _, e := range h.Entries {
		ids = append(ids, e.Event.ID)
	}
	if strings.Join(ids, ",") != "e1,late1,e2,late2,e3" || h.More {
		t.Fatalf("window %v more %v", ids, h.More)
	}
	// Paging through everything gives every event once, in order.
	seen, from, pages := 0, "", 0
	prev := ""
	for {
		p := s.History(HistoryQuery{FromOrder: from, Limit: 250})
		for _, e := range p.Entries {
			if e.Event.Order < prev {
				t.Fatalf("out of order at %s", e.Event.ID)
			}
			prev = e.Event.Order
			seen++
		}
		pages++
		if !p.More {
			break
		}
		from = p.Next
	}
	if seen != 3003 || pages < 12 {
		t.Fatalf("%d events in %d pages", seen, pages)
	}
	// Ties are not split: 5 events at one key, a page of 3 takes all 5.
	t2, _ := Open("", 100)
	var ties []*event.Event
	for i := 0; i < 5; i++ {
		ties = append(ties, evAt(fmt.Sprintf("t%d", i), "T-1", "000000000000100~2~c~000000000001~0000"))
	}
	ties = append(ties, evAt("after", "T-1", "000000000000200~2~c~000000000001~0000"))
	t2.Append(ties, nil)
	p := t2.History(HistoryQuery{Limit: 3})
	if len(p.Entries) != 5 || !p.More || p.Next != "000000000000200~2~c~000000000001~0000" {
		t.Fatalf("ties: %d more %v next %q", len(p.Entries), p.More, p.Next)
	}
}

// Series: counts per minute by kind and authority over everything indexed (also after a restart
// and beyond the memory window), finer buckets from the memory window.
func TestSeriesCountsAndSurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenWith(dir, Options{MaxMemory: 10})
	var b []*event.Event
	for i := 0; i < 100; i++ {
		e := evAt(fmt.Sprintf("e%d", i), "T-1", fmt.Sprintf("%015d~2~c~%012d~0000", 1_800_000_000_000+int64(i)*30_000, i))
		e.Time.OrderMS = 1_800_000_000_000 + int64(i)*30_000 // one every 30 s: two per minute
		b = append(b, e)
	}
	s.Append(b, map[string]tail.Checkpoint{"ledger": {Offset: 1}})
	r := s.Series(SeriesQuery{FromMS: 1_800_000_000_000 - 1_800_000_000_000%60_000, ToMS: 1_800_000_000_000 + 3_000_000, BucketMS: 600_000})
	if r.Total != 100 || r.Source != "minutes" || len(r.Buckets) != 5 || r.Buckets[0].Count != 20 || r.Kinds["station.entered"] != 100 || r.Authorities["authoritative"] != 100 || !r.Complete {
		t.Fatalf("%+v", r)
	}
	fine := s.Series(SeriesQuery{FromMS: 1_800_000_000_000, ToMS: 1_800_000_000_000 + 3_000_000, BucketMS: 1000})
	if fine.Source != "memory-window" || fine.Total != 10 || fine.Complete {
		t.Fatalf("fine %+v", fine)
	}
	s.Close()
	r2, _ := OpenWith(dir, Options{MaxMemory: 10})
	defer r2.Close()
	again := r2.Series(SeriesQuery{FromMS: 1_800_000_000_000 - 1_800_000_000_000%60_000, ToMS: 1_800_000_000_000 + 3_000_000, BucketMS: 600_000})
	if again.Total != 100 {
		t.Fatalf("after a restart %+v", again)
	}
}
