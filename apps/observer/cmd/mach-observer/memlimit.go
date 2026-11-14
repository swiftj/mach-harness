package main

import (
	"log"
	"os"
	"runtime/debug"
	"runtime/metrics"
	"time"
)

// The soft memory limit adapts to the history (D18, M6.5). A fixed limit is a cliff: once the live
// heap nears it the collector runs continuously (at 208 MB a 250,000-event project idled at a
// quarter of a core). So, after the first full catch-up and then at most once a minute, the limit
// becomes MemLimitFactor times the live heap after the last collection, never below MemoryLimit
// and never above MemLimitCeiling, and it is changed only when the new value differs materially
// (MemLimitStep). GOMEMLIMIT in the environment wins and turns the adaptation off.
const (
	MemLimitFactor  = 1.6
	MemLimitCeiling = 2 << 30
	MemLimitStep    = 0.10 // a change of less than 10 % is not made
	memLimitEvery   = time.Minute
	memLimitWait    = time.Second // how often the catch-up is checked before the first adaptation
)

// pickLimit is the soft limit for a live heap: max(floor, factor × live), capped at ceiling.
func pickLimit(live, floor, ceiling uint64) uint64 {
	want := uint64(float64(live) * MemLimitFactor)
	want = max(want, floor)
	return min(want, ceiling)
}

// material reports whether moving the limit from cur to next is worth doing.
func material(cur, next uint64) bool {
	if cur == 0 {
		return next != 0
	}
	diff := float64(next) - float64(cur)
	return diff > float64(cur)*MemLimitStep || -diff > float64(cur)*MemLimitStep
}

// memAdapter moves the soft limit. live and set are the runtime's, replaced in tests.
type memAdapter struct {
	cur    uint64
	live   func() uint64
	set    func(int64) int64
	logger *log.Logger
}

func newMemAdapter(logger *log.Logger) *memAdapter {
	return &memAdapter{cur: MemoryLimit, live: liveHeap, set: debug.SetMemoryLimit, logger: logger}
}

// step adapts the limit once; it reports whether the limit changed.
func (m *memAdapter) step() bool {
	live := m.live()
	if live == 0 {
		return false
	}
	next := pickLimit(live, MemoryLimit, MemLimitCeiling)
	if !material(m.cur, next) {
		return false
	}
	m.set(int64(next))
	m.logger.Printf("memory limit %d MB -> %d MB (live heap %d MB)", m.cur>>20, next>>20, live>>20)
	m.cur = next
	return true
}

// run waits for the first full catch-up, adapts, then adapts at most once a minute until done.
// Before the catch-up it only polls caughtUp; after it, one timer a minute and one runtime/metrics
// read: no work proportional to the history while idle.
func (m *memAdapter) run(done <-chan struct{}, caughtUp func() bool) {
	wait := time.NewTicker(memLimitWait)
	for !caughtUp() {
		select {
		case <-done:
			wait.Stop()
			return
		case <-wait.C:
		}
	}
	wait.Stop()
	m.step()
	tick := time.NewTicker(memLimitEvery)
	defer tick.Stop()
	for {
		select {
		case <-done:
			return
		case <-tick.C:
			m.step()
		}
	}
}

// adaptiveMemory reports whether the limit adapts (GOMEMLIMIT unset).
func adaptiveMemory() bool { return os.Getenv("GOMEMLIMIT") == "" }

// liveHeap is the heap the last collection found live, in bytes (0 before the first).
func liveHeap() uint64 {
	s := []metrics.Sample{{Name: "/gc/heap/live:bytes"}}
	metrics.Read(s)
	if s[0].Value.Kind() != metrics.KindUint64 {
		return 0
	}
	return s[0].Value.Uint64()
}
