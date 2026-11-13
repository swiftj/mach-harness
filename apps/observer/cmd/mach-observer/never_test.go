package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/feed"
)

// The observer takes no lock MACH uses and holds none: while it runs, every MACH file (its own
// lock file included as a control) can be locked exclusively at once by someone else, exactly as
// intake.py, the supervisor and the lifecycle helper lock them.
func TestNoLockOnMACHFiles(t *testing.T) {
	root := fixture(t)
	r := launch(t, root)
	defer r.stop(t)
	waitEvents(t, r, 7)
	touchEveryEndpoint(t, r)
	for _, rel := range []string{".factory/intake/lock", ".factory/intake/events.jsonl", ".factory/intake/ledger.json", ".factory/local/runner.json",
		".factory/local/supervisor.json", ".factory/worktrees/T-1/lifecycle.jsonl", ".factory/worktrees/T-1/cell.json", ".factory/archive/runs.jsonl",
		".factory/local/executions/x0123456789ab/stream.jsonl"} {
		f, err := os.OpenFile(filepath.Join(root, rel), os.O_RDONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			t.Errorf("%s is locked while the observer runs: %v", rel, err)
		}
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}
	// The control: the observer's own lock IS held, so the check above can see a lock.
	own, err := os.Open(filepath.Join(root, IndexDir, "lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer own.Close()
	if err := syscall.Flock(int(own.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err == nil {
		t.Fatal("the control failed: the observer's own lock could be taken")
	}
}

// No MACH file is held open between polls: each poll opens, reads and closes. Sampled every 20 ms
// for 1.5 s while the observer runs; a poll takes well under a millisecond, so a MACH path open
// in three samples in a row would be one held open.
func TestNothingHeldOpenBetweenPolls(t *testing.T) {
	if !canListOpenPaths {
		t.Skip("no way to list open files on this system")
	}
	root := fixture(t)
	r := launch(t, root)
	defer r.stop(t)
	waitEvents(t, r, 7)
	run := map[string]int{}
	deadline := time.Now().Add(1500 * time.Millisecond)
	samples := 0
	for time.Now().Before(deadline) {
		samples++
		seen := map[string]bool{}
		for _, p := range openPaths() {
			if p, err := filepath.EvalSymlinks(p); err == nil && strings.HasPrefix(p, root+"/") && !strings.HasPrefix(p, filepath.Join(root, IndexDir)+"/") {
				seen[p] = true
			}
		}
		for p := range run {
			if !seen[p] {
				delete(run, p)
			}
		}
		for p := range seen {
			if run[p]++; run[p] >= 3 {
				t.Fatalf("%s is held open across polls", p)
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if samples < 20 {
		t.Fatalf("only %d samples", samples)
	}
	// The sampler can see an open file: the observer's own index is open the whole time.
	own := false
	for _, p := range openPaths() {
		if p, err := filepath.EvalSymlinks(p); err == nil && strings.HasPrefix(p, filepath.Join(root, IndexDir)+"/") {
			own = true
		}
	}
	if !own {
		t.Fatal("the control failed: the observer's own open files are not listed")
	}
}

// The revision the store writes events under and the one /session reports are the same number.
func TestServedRevisionIsTheWrittenOne(t *testing.T) {
	if event.Revision != feed.SchemaRevision || event.Version != feed.SchemaVersion {
		t.Fatalf("event %d.%d, served %d.%d", event.Version, event.Revision, feed.SchemaVersion, feed.SchemaRevision)
	}
}
