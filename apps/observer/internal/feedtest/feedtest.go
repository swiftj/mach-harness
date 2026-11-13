// Package feedtest builds version 3 events and an in-memory log for the serving side's tests.
// The events follow schemas/factory-event.v3.schema.json's envelope exactly (every field present,
// nullable where it may be), so the projections are tested against the contract, not against
// whatever the ingest side happens to emit today. Imported by tests only.
package feedtest

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"mach/observer/internal/feed"
)

// Mem is an in-memory feed.Log with a bounded window, like the store.
type Mem struct {
	mu      sync.RWMutex
	epoch   string
	recs    []feed.Record
	first   uint64 // position of recs[0]
	head    uint64
	window  int
	changed chan struct{}
}

// NewMem makes an empty log. window <= 0 keeps everything.
func NewMem(epoch string, window int) *Mem {
	if epoch == "" {
		epoch = "0123456789abcdef"
	}
	return &Mem{epoch: epoch, first: 1, window: window, changed: make(chan struct{})}
}

func (m *Mem) Epoch() string { m.mu.RLock(); defer m.mu.RUnlock(); return m.epoch }

func (m *Mem) Bounds() (uint64, uint64) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.floor(), m.head
}

func (m *Mem) floor() uint64 {
	if len(m.recs) == 0 {
		return m.head
	}
	return m.first - 1
}

func (m *Mem) After(pos uint64, limit int) ([]feed.Record, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if pos > m.head {
		return nil, feed.ErrFuture
	}
	if pos < m.floor() {
		return nil, feed.ErrExpired
	}
	if pos == m.head {
		return nil, nil
	}
	start := int(pos + 1 - m.first)
	end := min(start+limit, len(m.recs))
	return append([]feed.Record(nil), m.recs[start:end]...), nil
}

func (m *Mem) Changed() <-chan struct{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.changed
}

// Append adds events, giving each the next position (written into its pos field), and wakes readers.
func (m *Mem) Append(events ...map[string]any) []uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []uint64
	for _, ev := range events {
		m.head++
		ev["pos"] = m.head
		raw, err := json.Marshal(ev)
		if err != nil {
			panic(err)
		}
		if len(m.recs) == 0 {
			m.first = m.head
		}
		m.recs = append(m.recs, feed.Record{Pos: m.head, Raw: raw})
		out = append(out, m.head)
	}
	if m.window > 0 && len(m.recs) > m.window {
		over := len(m.recs) - m.window
		m.recs = append([]feed.Record(nil), m.recs[over:]...)
		m.first += uint64(over)
	}
	close(m.changed)
	m.changed = make(chan struct{})
	return out
}

// History serves a window in order, like the store: filters, ties kept whole across pages.
// Everything appended and still in the window is held, so it is complete unless the window
// dropped something.
func (m *Mem) History(q feed.HistoryQuery) feed.HistoryPage {
	if q.Limit <= 0 {
		q.Limit = 1000
	}
	m.mu.RLock()
	recs := append([]feed.Record(nil), m.recs...)
	dropped := m.first > 1
	m.mu.RUnlock()
	type item struct {
		rec   feed.Record
		order string
	}
	want := map[string]bool{}
	for _, e := range q.Entities {
		want[e] = true
	}
	var items []item
	for _, r := range recs {
		ev, err := feed.Decode(r)
		if err != nil || q.FromOrder != "" && ev.Order < q.FromOrder || q.ToOrder != "" && ev.Order >= q.ToOrder ||
			q.Ticket != "" && feed.Str(ev.IDs.TicketID) != q.Ticket || q.Execution != "" && feed.Str(ev.IDs.ExecutionID) != q.Execution ||
			!strings.HasPrefix(ev.Type, q.TypePrefix) {
			continue
		}
		hit := len(want) == 0
		for _, ref := range ev.Entities {
			hit = hit || want[ref]
		}
		if hit {
			items = append(items, item{r, ev.Order})
		}
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].order < items[j].order })
	page := feed.HistoryPage{Complete: !dropped}
	if len(items) > q.Limit {
		cut := q.Limit
		for cut > 0 && items[cut-1].order == items[cut].order {
			cut--
		}
		if cut == 0 {
			for cut = q.Limit; cut < len(items) && items[cut].order == items[q.Limit-1].order; cut++ {
			}
		}
		if cut < len(items) {
			page.Next, page.More = items[cut].order, true
		}
		items = items[:cut]
	}
	for _, it := range items {
		page.Records = append(page.Records, it.rec)
	}
	return page
}

// Series counts the held events per bucket, by order time (feed.Serieser).
func (m *Mem) Series(q feed.SeriesQuery) feed.Series {
	m.mu.RLock()
	recs := append([]feed.Record(nil), m.recs...)
	dropped := m.first > 1
	m.mu.RUnlock()
	out := feed.Series{Kinds: map[string]int64{}, Authorities: map[string]int64{}, Complete: !dropped, Source: "memory-window"}
	byStart := map[int64]*feed.SeriesBucket{}
	for _, r := range recs {
		ev, err := feed.Decode(r)
		ms := ev.Time.OrderMS
		if err != nil || ms < q.FromMS || ms >= q.ToMS || q.Ticket != "" && feed.Str(ev.IDs.TicketID) != q.Ticket ||
			q.Execution != "" && feed.Str(ev.IDs.ExecutionID) != q.Execution {
			continue
		}
		k := q.FromMS + (ms-q.FromMS)/q.BucketMS*q.BucketMS
		b := byStart[k]
		if b == nil {
			b = &feed.SeriesBucket{FromMS: k, Kinds: map[string]int64{}, Authorities: map[string]int64{}}
			byStart[k] = b
		}
		b.Count++
		b.Kinds[ev.Type]++
		b.Authorities[ev.Authority]++
		out.Total++
		out.Kinds[ev.Type]++
		out.Authorities[ev.Authority]++
	}
	for _, b := range byStart {
		out.Buckets = append(out.Buckets, *b)
	}
	sort.Slice(out.Buckets, func(i, j int) bool { return out.Buckets[i].FromMS < out.Buckets[j].FromMS })
	return out
}

// SeriesBounds is the order time of the earliest and latest held event.
func (m *Mem) SeriesBounds() (int64, int64) {
	m.mu.RLock()
	recs := append([]feed.Record(nil), m.recs...)
	m.mu.RUnlock()
	var lo, hi int64
	for _, r := range recs {
		if ev, err := feed.Decode(r); err == nil {
			if lo == 0 || ev.Time.OrderMS < lo {
				lo = ev.Time.OrderMS
			}
			hi = max(hi, ev.Time.OrderMS)
		}
	}
	return lo, hi
}

// AppendRaw adds a record whose body is given as is (for "not a v3 event" tests).
func (m *Mem) AppendRaw(raw string) uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.head++
	if len(m.recs) == 0 {
		m.first = m.head
	}
	m.recs = append(m.recs, feed.Record{Pos: m.head, Raw: json.RawMessage(raw)})
	close(m.changed)
	m.changed = make(chan struct{})
	return m.head
}

// ---- event builders ----

// Base is the time all builders count from: 2026-11-12T10:00:00Z.
var Base = time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)

// At returns Base + ms, in milliseconds.
func At(ms int64) int64 { return Base.UnixMilli() + ms }

var streamRank = map[string]int{"intake-log": 1, "cell-lifecycle": 2, "execution-record": 3, "run-record": 4, "execution-stream": 5, "observer": 6}

// Ev is a builder for one version 3 event.
type Ev struct{ m map[string]any }

var seqs sync.Map // partition key -> *int64, for deterministic per-partition sequences in a test binary

// New makes an event of kind typ from stream at time ms (milliseconds after Base), with ms
// precision for the lifecycle, execution-stream and observer streams and whole seconds otherwise.
func New(stream, typ string, ms int64) *Ev {
	ids := map[string]any{}
	for _, k := range []string{"project_id", "wave_id", "slice_id", "revision", "ticket_id", "cell_instance", "execution_id", "runner_id",
		"visit_id", "station", "round", "attempt", "seat", "agent_id", "parent_agent_id", "tool_call_id"} {
		ids[k] = nil
	}
	writer := map[string]string{"intake-log": "intake", "cell-lifecycle": "station", "execution-record": "executor", "run-record": "cleanup",
		"execution-stream": "claude", "observer": "observer"}[stream]
	authority := "authoritative"
	switch stream {
	case "execution-stream":
		authority = "observed"
	case "observer":
		authority = "reconstructed"
	}
	e := &Ev{m: map[string]any{
		"schema_version": 3, "schema_revision": 0, "id": "", "type": typ, "pos": 1,
		"origin":    map[string]any{"stream": stream, "key": "", "seq": nil, "part": nil, "writer": writer, "script": nil, "source_version": nil},
		"authority": authority, "ids": ids, "entities": []string{}, "parent": nil, "cause": nil, "artifacts": []any{},
		"unknown": []string{}, "inferred": map[string]any{}, "provenance": nil, "late": false, "withheld": 0, "data": map[string]any{},
	}}
	e.time(ms, stream)
	return e
}

func (e *Ev) time(ms int64, stream string) {
	at := At(ms)
	t := map[string]any{"occurred_at": feed.FormatMS(at), "precision": "ms", "not_before": nil, "not_after": nil,
		"observed_at": feed.FormatMS(at + 50), "order_ms": at}
	switch stream {
	case "intake-log", "execution-record", "run-record":
		sec := at - at%1000
		t["occurred_at"] = feed.FormatMS(sec + 999)
		t["precision"] = "s"
		t["not_before"] = feed.FormatMS(sec)
		t["not_after"] = feed.FormatMS(sec + 999)
		t["order_ms"] = sec + 999
	}
	e.m["time"] = t
}

// Precision overrides the time precision (e.g. "bounded" with no occurred_at).
func (e *Ev) Precision(p string, occurred *int64, notBefore, notAfter *int64) *Ev {
	t := e.m["time"].(map[string]any)
	t["precision"] = p
	set := func(k string, v *int64) {
		if v == nil {
			t[k] = nil
		} else {
			t[k] = feed.FormatMS(At(*v))
		}
	}
	set("occurred_at", occurred)
	set("not_before", notBefore)
	set("not_after", notAfter)
	return e
}

// ID sets ids[key].
func (e *Ev) ID(key string, v any) *Ev { e.m["ids"].(map[string]any)[key] = v; return e }

// Ticket sets ids.ticket_id and the cell entity.
func (e *Ev) Ticket(t string) *Ev { e.ID("ticket_id", t); return e.Entity("cell:" + t) }

// Exec sets ids.execution_id and the execution entity.
func (e *Ev) Exec(x string) *Ev { e.ID("execution_id", x); return e.Entity("execution:" + x) }

// Visit sets the station, visit and round ids from "<station>#<n>" for ticket t.
func (e *Ev) Visit(t, visit string, round int) *Ev {
	station, _, _ := strings.Cut(visit, "#")
	e.ID("station", station).ID("visit_id", t+"/"+visit).ID("cell_instance", "9a0c41d2")
	if round > 0 {
		e.ID("round", round)
	}
	return e.Entity("visit:" + t + "/" + visit).Entity("station:" + t + "/" + station)
}

// Entity adds a ref.
func (e *Ev) Entity(ref string) *Ev {
	list := e.m["entities"].([]string)
	for _, r := range list {
		if r == ref {
			return e
		}
	}
	e.m["entities"] = append(list, ref)
	return e
}

// Parent sets the parent ref.
func (e *Ev) Parent(ref string) *Ev { e.m["parent"] = ref; return e }

// Data sets the payload.
func (e *Ev) Data(d map[string]any) *Ev { e.m["data"] = d; return e }

// Set sets any top-level field.
func (e *Ev) Set(k string, v any) *Ev { e.m[k] = v; return e }

// Inferred marks a field as inferred by rule.
func (e *Ev) Inferred(field, rule string) *Ev {
	e.m["inferred"].(map[string]any)[field] = rule
	return e
}

// Build finishes the event: a deterministic id and order from the partition and a counter.
func (e *Ev) Build() map[string]any {
	origin := e.m["origin"].(map[string]any)
	stream := origin["stream"].(string)
	key := map[string]string{"intake-log": "i:0badc0de", "cell-lifecycle": "c:%s:9a0c41d2", "execution-record": "x:%s",
		"run-record": "r:0badc0de", "execution-stream": "s:%s", "observer": "o"}[stream]
	ids := e.m["ids"].(map[string]any)
	switch stream {
	case "cell-lifecycle":
		key = fmt.Sprintf(key, ids["ticket_id"])
	case "execution-record", "execution-stream":
		key = fmt.Sprintf(key, ids["execution_id"])
	}
	counter, _ := seqs.LoadOrStore(key, new(int64))
	p := counter.(*int64)
	seqMu.Lock()
	*p++
	seq := *p
	seqMu.Unlock()
	origin["key"] = key
	if stream != "observer" {
		origin["seq"] = seq
	}
	if e.m["id"] == "" {
		e.m["id"] = fmt.Sprintf("%s:%d", key, seq)
		if stream == "observer" {
			e.m["id"] = fmt.Sprintf("o:test:%d", seq)
		}
	}
	t := e.m["time"].(map[string]any)
	e.m["order"] = fmt.Sprintf("%015d~%d~%s~%012d~%04d", t["order_ms"], streamRank[stream], key, seq, 0)
	return e.m
}

var seqMu sync.Mutex
