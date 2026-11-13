package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"mach/observer/internal/feed"
	"mach/observer/internal/testkit/synth"
)

// TestTimelineUnderLoad measures the Timeline routes while events keep arriving (A1 of the M6.3
// round 4 review): the real observer (run) over a synthetic history, synth.Append writing more
// events at a fixed rate, and three phases: ingest alone, ingest with a client polling every
// 500 ms, and ingest with four clients asking for spans back to back. It is off unless
// MACH_OBSERVER_LOAD names the history's size in events (for example 250000); MACH_OBSERVER_LOAD_RATE
// sets the append rate (default 4000 per second) and MACH_OBSERVER_LOAD_SECONDS each phase's
// length (default 15).
func TestTimelineUnderLoad(t *testing.T) {
	n, _ := strconv.Atoi(os.Getenv("MACH_OBSERVER_LOAD"))
	if n == 0 {
		t.Skip("set MACH_OBSERVER_LOAD to the history's size in events to measure")
	}
	rate := envInt("MACH_OBSERVER_LOAD_RATE", 4000)
	phase := time.Duration(envInt("MACH_OBSERVER_LOAD_SECONDS", 15)) * time.Second
	root := t.TempDir()
	began := time.Now()
	sum, err := synth.Generate(synth.Options{Out: root, Events: n, Seed: 11})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("generated %d events in %s", sum.Events, time.Since(began).Round(time.Millisecond))
	began = time.Now()
	r := launch(t, root)
	defer r.stop(t)
	r.client.Timeout = 2 * time.Minute
	waitSettled(t, r, 10*time.Minute, 0)
	t.Logf("indexed and projected in %s", time.Since(began).Round(time.Millisecond))

	window := func() string {
		now := time.Now().UnixMilli() + 60_000
		return fmt.Sprintf("from_ms=%d&to_ms=%d", now-11*60_000, now)
	}
	// Idle: nothing arriving.
	idle := timeRequests(t, r, 20, func() string { return "/api/v1/spans?" + window() })
	t.Logf("idle: /spans 10-minute window p50 %s p95 %s", pct(idle, 50), pct(idle, 95))

	ingestPhase := func(name string, clients func(stop <-chan struct{}) func() []time.Duration) {
		_, p0 := positions(t, r)
		stop := make(chan struct{})
		var collect func() []time.Duration
		if clients != nil {
			collect = clients(stop)
		}
		start := time.Now()
		app, err := synth.Append(synth.AppendOptions{Out: root, Rate: rate, Duration: phase, Seed: 3}, nil)
		if err != nil {
			t.Fatal(err)
		}
		appended := time.Since(start)
		// Settled: the appended events are in (the observer may drop a few late duplicates).
		total := waitSettled(t, r, 5*time.Minute, p0+uint64(app.Events)*98/100).Sub(start)
		close(stop)
		_, p1 := positions(t, r)
		msg := fmt.Sprintf("%s: appended %d events in %s (%.0f/s); projected %d events, caught up %s after appending stopped: %.0f events/s",
			name, app.Events, appended.Round(time.Millisecond), app.Rate, p1-p0, (total - appended).Round(time.Millisecond), float64(p1-p0)/total.Seconds())
		if collect != nil {
			lat := collect()
			msg += fmt.Sprintf("; %d requests (%.1f/s), p50 %s p95 %s max %s", len(lat), float64(len(lat))/total.Seconds(), pct(lat, 50), pct(lat, 95), pct(lat, 100))
		}
		t.Log(msg)
		logTimeline(t, r)
	}
	ingestPhase("warm-up (not measured)", nil)
	ingestPhase("ingest alone", nil)
	ingestPhase("ingest, one client polling every 500 ms", func(stop <-chan struct{}) func() []time.Duration {
		return clients(t, r, 1, 500*time.Millisecond, stop, func() []string {
			w := window()
			return []string{"/api/v1/spans?" + w, "/api/v1/marks?limit=1000&" + w}
		})
	})
	ingestPhase("ingest, four clients asking for spans back to back", func(stop <-chan struct{}) func() []time.Duration {
		return clients(t, r, 4, 0, stop, func() []string { return []string{"/api/v1/spans?" + window()} })
	})
}

// logTimeline logs what building the latest timeline cost (an observer with project.Timeline).
func logTimeline(t *testing.T, r *running) {
	var reply struct {
		Data struct {
			Projection struct {
				Timeline json.RawMessage `json:"timeline"`
			} `json:"projection"`
		} `json:"data"`
	}
	json.Unmarshal(r.get(t, "/api/v1/health"), &reply)
	if len(reply.Data.Projection.Timeline) > 0 {
		t.Logf("  latest timeline build: %s", reply.Data.Projection.Timeline)
	}
}

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return def
}

// positions reads the store's head and the projection's position from /health.
func positions(t *testing.T, r *running) (head, proj uint64) {
	t.Helper()
	var reply struct {
		Data struct {
			Index struct {
				Head string `json:"head"`
			} `json:"index"`
			Projection struct {
				Pos uint64 `json:"pos"`
			} `json:"projection"`
			Ingest struct {
				CatchingUp bool `json:"catching_up"`
			} `json:"ingest"`
		} `json:"data"`
	}
	if err := json.Unmarshal(r.get(t, "/api/v1/health"), &reply); err != nil {
		t.Fatal(err)
	}
	c, err := feed.ParseCursor(reply.Data.Index.Head)
	if err != nil {
		t.Fatal(err)
	}
	return c.Pos, reply.Data.Projection.Pos
}

// waitSettled waits until the head has not moved for two seconds and the projection holds it,
// and returns when the projection first held that head.
func waitSettled(t *testing.T, r *running, limit time.Duration, least uint64) time.Time {
	t.Helper()
	deadline := time.Now().Add(limit)
	var last uint64
	stable := time.Now()
	var reached time.Time
	for time.Now().Before(deadline) {
		head, proj := positions(t, r)
		if head != last {
			last, stable, reached = head, time.Now(), time.Time{}
		}
		if head > 0 && head >= least && proj >= head && reached.IsZero() {
			reached = time.Now()
		}
		if !reached.IsZero() && time.Since(stable) > 2*time.Second {
			return reached
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the observer did not settle")
	return time.Time{}
}

func timeRequests(t *testing.T, r *running, n int, path func() string) []time.Duration {
	t.Helper()
	out := make([]time.Duration, 0, n)
	for range n {
		start := time.Now()
		r.get(t, path())
		out = append(out, time.Since(start))
	}
	return out
}

// clients starts n clients, each asking for paths() then waiting every (0: none), until stop; the
// returned function waits for them and returns every request's latency.
func clients(t *testing.T, r *running, n int, every time.Duration, stop <-chan struct{}, paths func() []string) func() []time.Duration {
	var mu sync.Mutex
	var lat []time.Duration
	var failed atomic.Value
	var wg sync.WaitGroup
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				for _, p := range paths() {
					start := time.Now()
					resp, err := r.client.Get(r.base + p)
					if err != nil {
						failed.Store(err.Error())
						return
					}
					io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
					if resp.StatusCode != 200 {
						failed.Store(fmt.Sprintf("%s: %d", p, resp.StatusCode))
						return
					}
					mu.Lock()
					lat = append(lat, time.Since(start))
					mu.Unlock()
				}
				if every > 0 {
					select {
					case <-stop:
						return
					case <-time.After(every):
					}
				}
			}
		}()
	}
	return func() []time.Duration {
		wg.Wait()
		if v := failed.Load(); v != nil {
			t.Fatalf("a client failed: %v", v)
		}
		return lat
	}
}

// pct is the p-th percentile of the latencies (100: the maximum).
func pct(lat []time.Duration, p int) time.Duration {
	if len(lat) == 0 {
		return 0
	}
	s := append([]time.Duration(nil), lat...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	i := (len(s)*p + 99) / 100
	return s[min(max(i-1, 0), len(s)-1)].Round(time.Millisecond)
}
