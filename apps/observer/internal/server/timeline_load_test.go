package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"mach/observer/internal/feed"
	"mach/observer/internal/feedtest"
)

// A1 and A10: the Timeline routes answered while events keep arriving, from many clients at once
// (run under -race). Every reply is whole JSON, each client's cursors never go back, the marks of
// a window page to completion with offset, and ingest keeps moving while the clients ask.
func TestTimelineRoutesDuringIngest(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	stop := make(chan struct{})
	var appended atomic.Int64
	var ingest sync.WaitGroup
	ingest.Add(1)
	go func() {
		defer ingest.Done()
		for i := 0; i < 400; i++ { // bounded: the race detector slows the projection about twentyfold
			select {
			case <-stop:
				return
			default:
			}
			ticket, visit := fmt.Sprintf("T-%d", 100+i%20), fmt.Sprintf("build#%d", i)
			ms := int64(60000 + i*500)
			h.log.Append(
				feedtest.New("cell-lifecycle", "station.entered", ms).Ticket(ticket).Visit(ticket, visit, 1).Build(),
				feedtest.New("cell-lifecycle", "gate.evaluated", ms+100).Ticket(ticket).Visit(ticket, visit, 1).Data(map[string]any{"gate": "g", "verdict": "passed"}).Build(),
				feedtest.New("cell-lifecycle", "station.exited", ms+400).Ticket(ticket).Visit(ticket, visit, 1).Build())
			appended.Add(3)
			time.Sleep(2 * time.Millisecond)
		}
	}()
	paths := []string{"/api/v1/spans?from_ms=0&to_ms=9999999999999", "/api/v1/marks?limit=50", "/api/v1/concurrency", "/api/v1/spans?kinds=visit&limit=10"}
	// Connections reused (six clients, many requests: never a new port per request).
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: 8}}
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	deadline := time.Now().Add(1500 * time.Millisecond)
	for c := range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var last uint64
			for n := 0; n < 300 && time.Now().Before(deadline); n++ {
				req, _ := http.NewRequest("GET", h.base+paths[(c+n)%len(paths)], nil)
				req.AddCookie(h.cookie)
				resp, err := client.Do(req)
				if err != nil {
					errs <- err
					return
				}
				body, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				var env struct {
					OK   bool `json:"ok"`
					Data struct {
						Cursor string `json:"cursor"`
					} `json:"data"`
				}
				if resp.StatusCode != 200 || jsonErr(body, &env) != nil || !env.OK {
					errs <- fmt.Errorf("%d %.200s", resp.StatusCode, body)
					return
				}
				cur, err := feed.ParseCursor(env.Data.Cursor)
				if err != nil {
					errs <- fmt.Errorf("cursor %q: %v", env.Data.Cursor, err)
					return
				}
				if cur.Pos < last {
					errs <- fmt.Errorf("a client's cursor went back from %d to %d", last, cur.Pos)
					return
				}
				last = cur.Pos
			}
		}()
	}
	wg.Wait()
	ingest.Wait() // every event in (400 visits), so the marks below run past one page
	close(stop)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if appended.Load() < 30 {
		t.Fatalf("ingest stalled while clients asked: %d events appended", appended.Load())
	}
	// Once settled, the window's marks page to completion past one page.
	h.proj.Sync()
	time.Sleep(1100 * time.Millisecond) // older than the timeline's age: the next reply is at the head
	first := h.get(t, "/api/v1/marks?from_ms=0&to_ms=9999999999999&limit=100")
	total := int(first["total"].(float64))
	if total <= 100 || first["truncated"] != true || first["more"] != true || first["next_offset"] != float64(100) {
		t.Fatalf("first page: total %v truncated %v more %v next %v", first["total"], first["truncated"], first["more"], first["next_offset"])
	}
	seen := map[string]bool{}
	off := 0
	for page := 0; ; page++ {
		d := h.get(t, fmt.Sprintf("/api/v1/marks?from_ms=0&to_ms=9999999999999&limit=100&offset=%d", off))
		for _, it := range d["items"].([]any) {
			id := it.(map[string]any)["id"].(string)
			if seen[id] {
				t.Fatalf("mark %s twice", id)
			}
			seen[id] = true
		}
		if d["more"] != true {
			if d["next_offset"] != nil {
				t.Fatalf("last page has next_offset %v", d["next_offset"])
			}
			break
		}
		off = int(d["next_offset"].(float64))
	}
	if len(seen) != total {
		t.Fatalf("paged %d of %d marks", len(seen), total)
	}
}

func jsonErr(body []byte, v any) error { return json.Unmarshal(body, v) }
