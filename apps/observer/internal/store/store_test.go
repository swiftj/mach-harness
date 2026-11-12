package store

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
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
	s, err := OpenWith(dir, Options{MaxMemory: 50, SegmentBytes: 40 << 10, RetainBytes: 400 << 10})
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2000; i += 10 {
		s.Append(batch(i, i+9), map[string]tail.Checkpoint{"ledger": {Offset: int64(i)}})
	}
	info := s.Info()
	if info.Segments < 3 || info.Dropped == 0 || info.DiskBytes > 480<<10 {
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
	r, err := OpenWith(dir, Options{MaxMemory: 50, SegmentBytes: 40 << 10, RetainBytes: 400 << 10})
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
	h := s.History("", "", []string{"cell:T-1"}, 10)
	if len(h) != 2 || h[0].Event.ID != "c" {
		t.Fatalf("history in order: %v", h)
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
