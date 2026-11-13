package project

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"mach/observer/internal/feedtest"
)

func visitEvents(ticket string, n, at int) []map[string]any {
	visit := fmt.Sprintf("build#%d", n)
	ms := int64(at)
	return []map[string]any{
		lc("station.entered", ms, ticket, visit, 1).Data(map[string]any{"station": "build"}).Build(),
		lc("gate.evaluated", ms+100, ticket, visit, 1).Data(map[string]any{"gate": "g", "verdict": "passed"}).Build(),
		lc("station.exited", ms+400, ticket, visit, 1).Data(map[string]any{"station": "build", "outcome": "built"}).Build(),
	}
}

// A1: a timeline is a private, unchanging copy; a new position builds a new one, and one younger
// than TimelineMaxAge is served while events keep arriving (it says the position it was built at).
func TestTimelineIsAPrivateCopy(t *testing.T) {
	m := feedtest.NewMem("", 0)
	m.Append(visitEvents("T-1", 1, 1000)...)
	p := New(Options{Log: m, TimelineMaxAge: -1})
	tl1, err := p.Timeline()
	if err != nil {
		t.Fatal(err)
	}
	n1 := len(tl1.Spans(SpanFilter{}))
	m.Append(visitEvents("T-2", 1, 2000)...)
	tl2, _ := p.Timeline()
	if len(tl1.Spans(SpanFilter{})) != n1 || tl2.Pos <= tl1.Pos || len(tl2.Spans(SpanFilter{})) <= n1 {
		t.Fatalf("tl1 %d spans at %d, tl2 %d at %d", n1, tl1.Pos, len(tl2.Spans(SpanFilter{})), tl2.Pos)
	}
	if again, _ := p.Timeline(); again != tl2 {
		t.Fatal("the same position built again")
	}

	q := New(Options{Log: m, TimelineMaxAge: time.Hour})
	a, _ := q.Timeline()
	m.Append(visitEvents("T-3", 1, 3000)...)
	b, _ := q.Timeline()
	var head uint64
	q.View(func(s *State) { head = s.Pos })
	if a != b || b.Pos >= head {
		t.Fatalf("a young timeline is served while events arrive: %d vs head %d", b.Pos, head)
	}
}

// A1 and A10: many readers while events are applied (run under -race): every reader gets a whole
// timeline, readers share builds, and the writer is never held up by a build.
func TestTimelineReadersDuringIngest(t *testing.T) {
	m := feedtest.NewMem("", 0)
	for i := range 300 {
		m.Append(visitEvents(fmt.Sprintf("T-%d", i%30), i, 1000+i*1000)...)
	}
	p := New(Options{Log: m})
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 300; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			m.Append(visitEvents(fmt.Sprintf("T-%d", i%30), i, 1000+i*1000)...)
			p.Sync()
		}
	}()
	var calls int64
	var mu sync.Mutex
	var readers sync.WaitGroup
	for range 8 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for range 40 {
				tl, err := p.Timeline()
				if err != nil {
					t.Error(err)
					return
				}
				from := tl.LastMS - 600_000
				tl.Spans(SpanFilter{FromMS: &from})
				tl.Marks(MarkFilter{FromMS: &from}, 1000)
				tl.Concurrency(from, tl.LastMS+1, 60_000, nil)
				mu.Lock()
				calls++
				mu.Unlock()
			}
		}()
	}
	readers.Wait()
	close(stop)
	wg.Wait()
	if b := p.TimelineBuilds(); b >= calls {
		t.Fatalf("%d builds for %d reads: not shared", b, calls)
	}
}

// A7: a long log at start (a first run, or a saved projection discarded by a format change) is
// replayed in the background: requests are answered from the projection as far as it has got,
// health says rebuilding, and Run brings it to the head.
func TestBackgroundRebuild(t *testing.T) {
	m := feedtest.NewMem("", 0)
	for i := 0; uint64(i)*3 <= RebuildAfter+3000; i++ {
		m.Append(visitEvents(fmt.Sprintf("T-%d", i%50), i, 1000+i*100)...)
	}
	_, head := m.Bounds()
	p := New(Options{Log: m, BackgroundRebuild: true})
	if st := p.Status(); st.State != "rebuilding" {
		t.Fatalf("state %q", st.State)
	}
	var pos uint64
	p.View(func(s *State) { pos = s.Pos })
	if pos >= head {
		t.Fatal("View replayed the whole log")
	}
	tl, _ := p.Timeline()
	if !tl.Rebuilding || !tl.HistoryLostIn(0, 1<<62) {
		t.Fatal("a timeline built while rebuilding does not say so")
	}
	done := make(chan struct{})
	go p.Run(done)
	defer close(done)
	deadline := time.Now().Add(30 * time.Second)
	for p.Status().State != "current" {
		if time.Now().After(deadline) {
			t.Fatal("never caught up")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if st := p.Status(); st.Pos != head {
		t.Fatalf("caught up at %d of %d", st.Pos, head)
	}
	// Short logs are not rebuilt in the background.
	small := feedtest.NewMem("", 0)
	small.Append(visitEvents("T-1", 1, 1000)...)
	if st := New(Options{Log: small, BackgroundRebuild: true}).Status(); st.State != "current" {
		t.Fatalf("short log: %q", st.State)
	}
}

// BenchmarkTimelineUnderIngest: a timeline read (a 10-minute window's spans and marks) while a
// writer applies events continuously.
func BenchmarkTimelineUnderIngest(b *testing.B) {
	m := feedtest.NewMem("", 0)
	for i := range 20000 {
		m.Append(visitEvents(fmt.Sprintf("T-%d", i%200), i, 1000+i*1000)...)
	}
	p := New(Options{Log: m})
	p.Sync()
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 20000; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			m.Append(visitEvents(fmt.Sprintf("T-%d", i%200), i, 1000+i*1000)...)
			p.Sync()
			time.Sleep(time.Millisecond)
		}
	}()
	b.ResetTimer()
	for b.Loop() {
		tl, err := p.Timeline()
		if err != nil {
			b.Fatal(err)
		}
		from := tl.LastMS - 600_000
		tl.Spans(SpanFilter{FromMS: &from})
		tl.Marks(MarkFilter{FromMS: &from}, 1000)
	}
	b.StopTimer()
	close(stop)
	wg.Wait()
	b.ReportMetric(float64(p.TimelineBuilds()), "builds")
}

// Recheck R7: while the writer holds the lock, a cached timeline older than TimelineMaxAge is not
// served: the request waits for the lock and reads where the projection is.
func TestTheBusyPathAppliesTheAgeLimit(t *testing.T) {
	m := feedtest.NewMem("", 0)
	m.Append(visitEvents("T-1", 1, 1000)...)
	q := New(Options{Log: m, TimelineMaxAge: time.Hour})
	a, _ := q.Timeline()
	q.mu.Lock()
	if b, _ := q.Timeline(); b != a {
		q.mu.Unlock()
		t.Fatal("a young timeline of the same epoch is served while the writer holds the lock")
	}
	q.tl.mu.Lock()
	q.tl.cur.Built = time.Now().Add(-2 * time.Hour)
	q.tl.mu.Unlock()
	done := make(chan *Timeline, 1)
	go func() { tl, _ := q.Timeline(); done <- tl }()
	select {
	case <-done:
		q.mu.Unlock()
		t.Fatal("an old timeline was served without waiting for the lock")
	case <-time.After(50 * time.Millisecond):
	}
	q.mu.Unlock()
	if tl := <-done; tl == nil {
		t.Fatal("no timeline")
	}
}
