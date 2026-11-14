package project

import (
	"testing"

	"mach/observer/internal/feedtest"
)

// An idle observer does no projection work: with no new event, syncing (what every tick and every
// read does) applies nothing, writes no metric cell, re-encodes no checkpoint and reclassifies no
// visit (M6.5: an idle loop here would burn CPU on a machine running the Factory).
func TestNoProjectionWorkWhenIdle(t *testing.T) {
	m := feedtest.NewMem("", 0)
	m.Append(feedtest.Scenario()...)
	p := New(Options{Log: m})
	p.Sync()
	p.mu.Lock()
	applied, cps := p.state.Applied, len(p.cps)
	p.state.Metrics.TakeDirty()
	before := string(Encode(p.state))
	p.mu.Unlock()
	for range 200 {
		p.Sync()
		p.View(func(*State) {})
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.state.Applied != applied || len(p.cps) != cps {
		t.Fatalf("idle syncs did work: applied %d -> %d, checkpoints %d -> %d", applied, p.state.Applied, cps, len(p.cps))
	}
	if d := p.state.Metrics.TakeDirty(); len(d) != 0 {
		t.Fatalf("idle syncs wrote metric cells: %v", d)
	}
	if string(Encode(p.state)) != before {
		t.Fatal("idle syncs changed the projection")
	}
}
