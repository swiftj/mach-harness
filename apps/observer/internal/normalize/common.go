// Package normalize turns the Factory's five sources into version 3 events
// (docs/mach-next/M6_1_EVENT_CONTRACT.md sections 4 to 11).
//
// Each source has a stateful normaliser that sees its file's lines in order and returns the events
// each line yields: the intake log (Ledger), a cell's lifecycle log (Lifecycle), an execution's
// started.json and result.json (ExecutionRecords), runs.jsonl (Runs) and an execution's stream
// (Stream). Every payload is built field by field from typed filters (package redact); nothing is
// passed through. Events come out complete except for pos (the store), order_ms and order (the
// Sequencer, below) and late (ingest's settle window).
//
// Normalisers never read a clock: the time a line was read is given to them. They are therefore
// deterministic: the same lines give the same events, which is what makes a rebuild give the same
// ids, and what lets ingest rebuild a normaliser's state after a restart by replaying the lines it
// already committed and discarding what they yield.
package normalize

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
)

// SourceVersions.
const (
	IntakeVersion    = "2"
	LifecycleVersion = "1"
	// ClaudeVersion is the only Claude Code version the stream parser is pinned to (contract 10.5).
	ClaudeVersion = "2.1.322"
)

// Read is what a normaliser knows about a line besides its bytes.
type Read struct {
	Line int64     // 1-based physical line number
	At   time.Time // the poll that read the line
	Prev time.Time // the poll before it (arrival bounds); zero when unknown
	Live bool      // false for lines already on disk when the source was first opened
}

// stampMS formats Unix milliseconds the way every v3 time is written.
func stampMS(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }

// Stamp formats a time.
func Stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// parseTime reads the time formats MACH writes: whole seconds with "Z" or "+00:00" (intake,
// supervisor, executor, cleanup) and milliseconds (lifecycle).
func parseTime(raw any) (int64, bool, bool) {
	s, ok := raw.(string)
	if !ok || len(s) > 40 {
		return 0, false, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli(), t.Nanosecond() != 0, true
		}
	}
	return 0, false, false
}

// secondTime fills a whole-second record's time (contract 6.1): occurred at + 999 ms, bounds the second.
func secondTime(ev *event.Event, raw any, r Read) {
	ev.Time.ObservedAt = Stamp(r.At)
	ms, frac, ok := parseTime(raw)
	if !ok {
		ev.Time.Precision = event.PrecisionUnknown
		ev.AddUnknown("time.occurred_at")
		return
	}
	if frac {
		ev.Time.OccurredAt, ev.Time.Precision = stampMS(ms), event.PrecisionMS
		return
	}
	ev.Time.OccurredAt = stampMS(ms + 999)
	ev.Time.Precision = event.PrecisionSecond
	ev.Time.NotBefore, ev.Time.NotAfter = stampMS(ms), stampMS(ms+999)
}

// msTime fills a millisecond-stamped record's time.
func msTime(ev *event.Event, ms int64, r Read) {
	ev.Time.ObservedAt = Stamp(r.At)
	ev.Time.OccurredAt, ev.Time.Precision = stampMS(ms), event.PrecisionMS
}

// OccurredMS is the moment an event's order_ms starts from: occurred_at, or not_before when it
// is not known (contract 6.2). ok is false when neither is known.
func OccurredMS(ev *event.Event) (int64, bool) {
	for _, s := range []string{ev.Time.OccurredAt, ev.Time.NotBefore} {
		if s == "" {
			continue
		}
		if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

// newEvent starts an event with the envelope fields every source fills.
func newEvent(typ, stream, key string, seq int64, writer, authority string) *event.Event {
	return &event.Event{Type: typ, Origin: event.Origin{Stream: stream, Key: key, Seq: seq, Writer: writer}, Authority: authority}
}

// observerEvent starts a reconstructed event with its provenance.
func observerEvent(typ, id, rule string, basis []string, files []string) *event.Event {
	if basis == nil {
		basis = []string{}
	}
	if files == nil {
		files = []string{}
	}
	ev := newEvent(typ, event.StreamObserver, event.ObserverKey, 0, "observer", event.Reconstructed)
	ev.ID = id
	ev.Provenance = &event.Provenance{Basis: basis, Rule: rule, Files: files}
	return ev
}

// copyTime gives an observer event its basis event's time (contract 6.1: "as its basis").
func copyTime(ev, basis *event.Event) {
	ev.Time = basis.Time
	ev.OrderBasis = basis
}

// ---- value helpers ----

func str(m map[string]any, k string) (string, bool) {
	s, ok := m[k].(string)
	return s, ok
}

func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func arr(v any) []any {
	a, _ := v.([]any)
	return a
}

// nullable returns v, or nil when v is the zero value.
func nullStr(s string, ok bool) any {
	if !ok || s == "" {
		return nil
	}
	return s
}

func idOrNil(v any) any  { return nullStr(redact.ID(v)) }
func tokOrNil(v any) any { return nullStr(redact.Token(v)) }
func commitOrNil(v any) any {
	s, ok := redact.Commit(v)
	if !ok {
		return nil
	}
	if len(s) > 12 {
		s = s[:12]
	}
	return s
}

func intOrNil(v any) any {
	if n, ok := redact.Int(v); ok {
		return n
	}
	return nil
}

func numOrNil(v any) any {
	if n, ok := redact.Number(v); ok {
		return n
	}
	return nil
}

func boolOrNil(v any) any {
	if b, ok := v.(bool); ok {
		return b
	}
	return nil
}

func boolOr(v any, fallback bool) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return fallback
}

// enum returns v when it is one of allowed, else nil.
func enum(v any, allowed ...string) any {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	for _, a := range allowed {
		if s == a {
			return s
		}
	}
	return nil
}

// idList keeps the identifiers of a list, at most max.
func idList(v any, max int) []any {
	out := []any{}
	for _, item := range arr(v) {
		if len(out) >= max {
			break
		}
		if id, ok := redact.ID(item); ok {
			out = append(out, id)
		}
	}
	return out
}

func textList(v any, root string, max, each int) []any {
	out := []any{}
	for _, item := range arr(v) {
		if len(out) >= max {
			break
		}
		if s, ok := redact.Text(item, root, each); ok {
			out = append(out, s)
		}
	}
	return out
}

func textOrNil(v any, root string, max int) any {
	s, ok := redact.Text(v, root, max)
	if !ok || s == "" {
		return nil
	}
	return s
}

// require sets a required field that may not be null: when the source lacks it, the zero value
// is written and the field is named in unknown, so nothing pretends to be known.
func require(ev *event.Event, d map[string]any, key string, v any, zero any) {
	if v == nil {
		d[key] = zero
		ev.AddUnknown("data." + key)
		return
	}
	d[key] = v
}

// Stages and actions (the schema's enums).
var (
	stages  = []string{"interview", "spec-open", "spec-ready", "planned", "building", "built", "verified", "awaiting-human", "approved", "pr-open", "merged", "blocked"}
	actions = []string{"audit", "groom", "plan", "build", "revise", "verify", "review", "merge", "cleanup", "stop"}
	seats   = []string{"architecture", "security", "product", "general"}
	risks   = []string{"High", "Medium", "Low"}
	// Lifecycle stations and the observer's ids.station enum.
	stations = []string{"intake", "groom", "plan", "audit", "build", "verify", "review", "human-approval", "merge", "cleanup", "observe"}
)

func stage(v any) any  { return enum(v, stages...) }
func action(v any) any { return enum(v, actions...) }

// Ticket ids: lifecycle's TICKET_ID_RE.
var ticketRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$`)

// Ticket accepts a ticket id.
func Ticket(v any) (string, bool) {
	s, ok := redact.ID(v)
	if !ok || len(s) > 80 || !ticketRe.MatchString(s) {
		return "", false
	}
	return s, true
}

var executionRe = regexp.MustCompile(`^x[0-9a-f]{12}$`)

// ExecutionID accepts an execution id (x + 12 hex).
func ExecutionID(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || !executionRe.MatchString(s) {
		return "", false
	}
	return s, true
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func sortStrings(s []string) { sort.Strings(s) }

// gapEvent is a history.gap (contract 6.5). id must be deterministic.
func gapEvent(id, sourceKey, reason string, from, to, count any, basis []string, r Read) *event.Event {
	ev := observerEvent("history.gap", id, "gap:"+reason, basis, nil)
	ev.Time.ObservedAt = Stamp(r.At)
	ev.Time.Precision = event.PrecisionUnknown
	ev.Data = map[string]any{"source_key": sourceKey, "from_seq": from, "to_seq": to, "reason": reason, "count": count}
	return ev
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "")
}
