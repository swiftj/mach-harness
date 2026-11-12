package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
	"mach/observer/internal/tail"
)

func ev(id string) *event.Event {
	return &event.Event{V: event.Version, ID: id, Type: "t", Authority: event.Authoritative}
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
	if err != nil || len(got) != 3 || got[0].Event.ID != "e2" || got[2].Event.Position != 4 {
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
	f, _ := os.OpenFile(filepath.Join(dir, "events.log"), os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"v":3,"id":"e3","cur`)
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
