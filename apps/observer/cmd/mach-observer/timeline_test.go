package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"mach/observer/internal/artifact"
	"mach/observer/internal/event"
	"mach/observer/internal/project"
	"mach/observer/internal/security"
	"mach/observer/internal/server"
	"mach/observer/internal/store"
	"mach/observer/internal/tail"
	"mach/observer/internal/testkit"
	"mach/observer/internal/webui"
)

// The Execution Timeline's routes through the real pieces: raw Factory lines through the real
// normalisers to /spans, and /history and /series served from the real store through adapt.go.

// ledgerAt is one intake log line at a given time.
func ledgerAt(seq int, at, typ, ticket string, data map[string]any) []byte {
	var tk any
	if ticket != "" {
		tk = ticket
	}
	line, _ := json.Marshal(map[string]any{"schema_version": 2, "seq": seq, "at": at, "type": typ, "project_id": "P-1", "source_commit": nil,
		"wave_id": "WAVE-001", "slice_id": "SLICE-002", "revision": 1, "ticket_id": tk, "runner_id": nil, "execution_id": nil,
		"source": "supervisor", "cause": nil, "refs": nil, "data": data})
	return append(line, '\n')
}

// The supervisor writes a capacity hold only as a held ticket whose why is its fixed sentence
// ("all N place(s) are in use", supervisor.py schedule). The ledger normaliser reconstructs
// capacity.wait_changed from it, and the closed wait reaches /spans as a capacity-wait.
func TestCapacityWaitFromRawLedgerLines(t *testing.T) {
	root := testkit.Project(t)
	held := func(why string) map[string]any {
		return map[string]any{"state": "supervised", "dispatched": []any{}, "started": []any{},
			"held": []any{map[string]any{"ticket_id": "T-2", "slice_id": "SLICE-002", "why": why}}}
	}
	lines := append(ledgerAt(1, "2026-11-12T10:00:00Z", "scheduling.decided", "", held("all 2 place(s) are in use")),
		ledgerAt(2, "2026-11-12T10:00:30Z", "scheduling.decided", "", map[string]any{"state": "supervised", "dispatched": []any{}, "started": []any{"T-2"}, "held": []any{}})...)
	// Held for another reason: not a capacity wait, and never read as one.
	lines = append(lines, ledgerAt(3, "2026-11-12T10:01:00Z", "scheduling.decided", "", held("an engineer is moving this ticket by hand"))...)
	testkit.Append(t, testkit.LedgerPath(root), lines)
	r := launch(t, root)
	defer r.stop(t)
	var reply struct {
		Data struct {
			Items []project.Span `json:"items"`
		} `json:"data"`
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		json.Unmarshal(r.get(t, "/api/v1/spans?kinds=capacity-wait"), &reply)
		if len(reply.Data.Items) > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(reply.Data.Items) != 1 {
		t.Fatalf("want one capacity wait, got %+v", reply.Data.Items)
	}
	sp := reply.Data.Items[0]
	if sp.Entity != "cell:T-2" || sp.IDs["ticket_id"] != "T-2" || sp.End == nil || sp.Authority != event.Reconstructed {
		t.Fatalf("%+v end %+v", sp, sp.End)
	}
	if sp.Duration.MS == nil || *sp.Duration.MS != 30000 {
		t.Fatalf("duration %+v", sp.Duration)
	}
}

// genEvents is n events over ten tickets, a few seconds apart, every 2500th on the ticket RARE.
func genEvents(n int, base int64) (evs []*event.Event, perTicket map[string]int) {
	perTicket = map[string]int{}
	for i := 0; i < n; i++ {
		ms := base + int64(i)*700
		ticket := fmt.Sprintf("T-%d", i%10)
		if i%2500 == 7 {
			ticket = "RARE"
		}
		perTicket[ticket]++
		e := &event.Event{ID: fmt.Sprintf("e%07d", i), Type: "station.entered", Authority: event.Authoritative,
			Order: event.OrderKey(ms, 2, "c:"+ticket, int64(i), 0), IDs: event.IDs{TicketID: ticket}, Entities: []string{"cell:" + ticket}}
		e.Time.OrderMS = ms
		evs = append(evs, e)
	}
	return evs, perTicket
}

func TestHistoryAndSeriesFromTheRealStore(t *testing.T) {
	const n, memory = 30000, 1000
	base := time.Date(2026, 11, 12, 5, 29, 0, 0, time.UTC).UnixMilli()
	st, err := store.Open(filepath.Join(t.TempDir(), "index"), memory)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	evs, perTicket := genEvents(n, base)
	for i := 0; i < n; i += 1000 {
		if _, err := st.Append(evs[i:i+1000], map[string]tail.Checkpoint{"ledger": {Offset: int64(i)}}); err != nil {
			t.Fatal(err)
		}
	}
	if info := st.Info(); !info.Persisted || info.InMemory > memory || info.Head != n {
		t.Fatalf("the oldest events must be on disk only: %+v", info)
	}
	l, err := security.Listen("127.0.0.1", 0)
	if err != nil {
		t.Fatal(err)
	}
	guard, _ := security.NewGuard(l.Addr().(*net.TCPAddr).Port)
	done := make(chan struct{})
	defer close(done)
	root := testkit.Project(t)
	proj := project.New(project.Options{Log: storeLog{st}})
	defer proj.Close()
	srv := server.New(server.Options{Root: root, Guard: guard, Log: storeLog{st}, Projector: proj, Catalog: artifact.New(root),
		Factory: factorySource{root}, UI: webui.Handler(), Done: done}).HTTPServer()
	go srv.Serve(l)
	defer srv.Close()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 10 * time.Second}
	if resp, err := client.Get(guard.StartURL()); err != nil {
		t.Fatal(err)
	} else {
		resp.Body.Close()
	}
	origin := "http://" + l.Addr().String()
	get := func(path string, into any) {
		t.Helper()
		resp, err := client.Get(origin + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("%s: %d %s", path, resp.StatusCode, body)
		}
		if err := json.Unmarshal(body, into); err != nil {
			t.Fatal(err)
		}
	}
	type historyReply struct {
		Data struct {
			Events   []event.Event `json:"events"`
			Next     *string       `json:"next_from_order"`
			More     bool          `json:"more"`
			Complete bool          `json:"complete"`
			Capped   *bool         `json:"capped"`
		} `json:"data"`
	}

	// The oldest page comes from disk, far below the memory window, in order.
	var h historyReply
	get("/api/v1/history?limit=500", &h)
	if len(h.Data.Events) != 500 || h.Data.Events[0].ID != "e0000000" || !h.Data.More || !h.Data.Complete || h.Data.Capped == nil || *h.Data.Capped {
		t.Fatalf("oldest page: %d events, first %v, more %v complete %v capped %v", len(h.Data.Events), h.Data.Events[0].ID, h.Data.More, h.Data.Complete, h.Data.Capped)
	}

	// A rare ticket: a page stops at the disk scan cap and says so; paging on finds every event.
	got, capped := 0, 0
	from := ""
	for pages := 0; ; pages++ {
		if pages > 100 {
			t.Fatal("paging did not end")
		}
		q := "/api/v1/history?ticket=RARE&limit=100"
		if from != "" {
			q += "&from_order=" + url.QueryEscape(from)
		}
		h = historyReply{}
		get(q, &h)
		got += len(h.Data.Events)
		if *h.Data.Capped {
			capped++
			if !h.Data.More {
				t.Fatal("a capped page must say more")
			}
		}
		if !h.Data.More {
			break
		}
		from = *h.Data.Next
	}
	if got != perTicket["RARE"] || capped == 0 {
		t.Fatalf("RARE: %d of %d events, %d capped pages", got, perTicket["RARE"], capped)
	}

	// Per-ticket minutes cover the whole index, not only the memory window.
	var s struct {
		Data struct {
			Total    int64  `json:"total"`
			Complete bool   `json:"complete"`
			Source   string `json:"source"`
			Buckets  []struct {
				FromMS int64 `json:"from_ms"`
				Count  int64 `json:"count"`
			} `json:"buckets"`
		} `json:"data"`
	}
	end := base + int64(n)*700 + 60_000
	get(fmt.Sprintf("/api/v1/series?ticket=T-3&bucket_ms=60000&from_ms=%d&to_ms=%d", base, end-end%60_000+60_000), &s)
	if s.Data.Source != "minutes" || !s.Data.Complete || s.Data.Total != int64(perTicket["T-3"]) || len(s.Data.Buckets) < 300 {
		t.Fatalf("series: source %s complete %v total %d of %d, %d buckets", s.Data.Source, s.Data.Complete, s.Data.Total, perTicket["T-3"], len(s.Data.Buckets))
	}
	if s.Data.Buckets[0].FromMS != base {
		t.Fatalf("first bucket %d, want %d", s.Data.Buckets[0].FromMS, base)
	}
}
