package main

import (
	"bytes"
	"log"
	"strings"
	"testing"
	"time"
)

const mb = 1 << 20

func TestPickLimit(t *testing.T) {
	for _, c := range []struct{ live, want uint64 }{
		{0, MemoryLimit},             // nothing known: the floor
		{100 * mb, MemoryLimit},      // a small heap keeps the floor
		{200 * mb, MemoryLimit},      // 1.6 x 200 = 320: the floor
		{300 * mb, 480 * mb},         // above it: 1.6 x the live heap
		{1500 * mb, MemLimitCeiling}, // capped
		{1 << 40, MemLimitCeiling},   // whatever the heap
	} {
		if got := pickLimit(c.live, MemoryLimit, MemLimitCeiling); got != c.want {
			t.Errorf("pickLimit(%d MB) = %d MB, want %d MB", c.live/mb, got/mb, c.want/mb)
		}
	}
	if material(320*mb, 330*mb) || !material(320*mb, 480*mb) || !material(480*mb, 320*mb) {
		t.Error("a change under 10% is not made; a larger one is, either way")
	}
}

// A live heap near the fixed limit raises it (so the collector does not run continuously), with
// one log line and no path or data in it; an unchanged heap changes nothing.
func TestLiveHeapNearTheLimitRaisesIt(t *testing.T) {
	var buf bytes.Buffer
	var set []int64
	live := uint64(300 * mb)
	m := &memAdapter{cur: MemoryLimit, live: func() uint64 { return live }, set: func(v int64) int64 { set = append(set, v); return 0 },
		logger: log.New(&buf, "", 0)}
	if !m.step() || len(set) != 1 || set[0] != 480*mb {
		t.Fatalf("set %v", set)
	}
	if line := strings.TrimSpace(buf.String()); line != "memory limit 320 MB -> 480 MB (live heap 300 MB)" {
		t.Fatalf("log %q", line)
	}
	if m.step() || len(set) != 1 {
		t.Fatal("the same heap must not move the limit again")
	}
	live = 100 * mb // the heap shrank: back to the floor
	if !m.step() || set[1] != MemoryLimit {
		t.Fatalf("set %v", set)
	}
}

// Before the first catch-up nothing is adapted; after it, one step; a closed done stops it.
func TestMemAdapterWaitsForCatchUp(t *testing.T) {
	set := make(chan int64, 4)
	m := &memAdapter{cur: MemoryLimit, live: func() uint64 { return 400 * mb }, set: func(v int64) int64 { set <- v; return 0 },
		logger: log.New(&bytes.Buffer{}, "", 0)}
	ready := make(chan struct{})
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		m.run(done, func() bool {
			select {
			case <-ready:
				return true
			default:
				return false
			}
		})
		close(finished)
	}()
	select {
	case v := <-set:
		t.Fatalf("adapted to %d before the catch-up", v)
	case <-time.After(1500 * time.Millisecond):
	}
	close(ready)
	select {
	case v := <-set:
		if v != 640*mb {
			t.Fatalf("set %d MB", v/mb)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("not adapted after the catch-up")
	}
	close(done)
	<-finished
}
