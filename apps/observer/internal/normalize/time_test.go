package normalize

import (
	"encoding/json"
	"testing"
	"time"

	"mach/observer/internal/event"
)

// M6.6 F1: a time before 2000 or more than a day after its line was read is not a record's own
// time. One such stream record placed the record, and every later record of its source, in year
// 9999, and the Timeline paged through the span until the tab died.
func TestImplausibleTimestampsHaveNoOwnTime(t *testing.T) {
	readAt := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	r := Read{Line: 1, At: readAt, Prev: readAt.Add(-time.Second), Live: true}
	bad := []string{"9999-12-31T23:59:59.999Z", "1900-01-01T00:00:00Z", "2026-11-15T12:00:01.000Z", "1999-12-31T23:59:59Z"}
	good := []string{"2026-11-14T11:59:00.000Z", "2026-11-15T11:59:00.000Z", "2000-01-01T00:00:00Z"}

	t.Run("parse", func(t *testing.T) {
		for _, v := range bad {
			if _, _, ok, implausible := parseTimeRead(v, readAt); ok || !implausible {
				t.Errorf("%s: ok=%v implausible=%v", v, ok, implausible)
			}
		}
		for _, v := range good {
			if _, _, ok, implausible := parseTimeRead(v, readAt); !ok || implausible {
				t.Errorf("%s: ok=%v implausible=%v", v, ok, implausible)
			}
		}
		if _, _, ok, implausible := parseTimeRead("not a time", readAt); ok || implausible {
			t.Error("an unparsable value is not called implausible")
		}
	})

	t.Run("stream", func(t *testing.T) {
		for _, v := range bad[:2] {
			s := NewStream("x0123456789ab", "/work/p", NewIdentity())
			rec, _ := json.Marshal(map[string]any{"type": "assistant", "session_id": "s", "timestamp": v, "parent_tool_use_id": nil,
				"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": map[string]any{"command": "true"}}}}})
			evs := s.Line(rec, r)
			var called *event.Event
			for _, e := range evs {
				if e.Type == "tool.called" {
					called = e
				}
			}
			if called == nil {
				t.Fatalf("%s: no tool.called in %d events", v, len(evs))
			}
			if called.Time.OccurredAt == stampMS(mustMS(v)) || called.Time.Precision == event.PrecisionMS {
				t.Errorf("%s: kept as its own time: %+v", v, called.Time)
			}
			if !hasUnknown(called, "time.occurred_at") {
				t.Errorf("%s: not recorded as unknown: %v", v, called.Unknown)
			}
		}
	})

	t.Run("lifecycle", func(t *testing.T) {
		line := func(v string) []byte {
			b, _ := json.Marshal(map[string]any{"v": 1, "seq": 1, "at": v, "type": "station.entered", "ticket_id": "T-1", "station": "build",
				"visit": "build#1", "round": nil, "data": map[string]any{"stage": "building"}})
			return b
		}
		entered := 0
		for _, e := range NewLifecycle("T-1", "g", "/work/p", NewIdentity()).Line(line(good[0]), r) {
			if e.Type == "station.entered" {
				entered++
			}
		}
		if entered != 1 {
			t.Fatal("the plausible line was not read; the check below would prove nothing")
		}
		for _, v := range bad[:2] {
			for _, e := range NewLifecycle("T-1", "g", "/work/p", NewIdentity()).Line(line(v), r) {
				if e.Type != "history.gap" {
					t.Errorf("%s: a %s was made from a line with an implausible time: %+v", v, e.Type, e.Time)
				}
			}
		}
	})

	t.Run("ledger", func(t *testing.T) {
		for _, v := range bad[:2] {
			l := NewLedger("g", "/work/p", NewIdentity())
			line, _ := json.Marshal(map[string]any{"schema_version": 2, "seq": 1, "at": v, "type": "human.required", "source": "supervisor",
				"ticket_id": "T-1", "data": map[string]any{"reason": "a person must approve"}})
			seen := 0
			defer func() {
				if seen != 1 {
					t.Errorf("%s: %d human.required events", v, seen)
				}
			}()
			for _, e := range l.Line(line, r) {
				if e.Type != "human.required" {
					continue
				}
				seen++
				if e.Time.OccurredAt != "" || e.Time.Precision != event.PrecisionUnknown || !hasUnknown(e, "time.occurred_at") {
					t.Errorf("%s: %+v unknown=%v", v, e.Time, e.Unknown)
				}
			}
		}
	})
}

func mustMS(v string) int64 {
	t, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		panic(err)
	}
	return t.UnixMilli()
}
