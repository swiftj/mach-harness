// Package feed is the serving side's whole view of the observer's merged log: a narrow interface
// (Log), the version 3 event as the serving side reads it (Event), cursors, and filters.
//
// The ingest side (internal/event, store, ingest, ...) owns how events are made and kept. The
// serving side never imports those packages: cmd/mach-observer adapts the store to Log in one
// small file, so a change to the store costs one adapter edit, and every projection, endpoint and
// test here works from the version 3 shape the contract defines
// (docs/mach-next/M6_1_EVENT_CONTRACT.md, schemas/factory-event.v3.schema.json).
package feed

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

// SchemaVersion is the event schema the serving side reads and serves.
const SchemaVersion = 3

// SchemaRevision is the additive revision within version 3 that this observer serves (1:
// execution.usage.cost_complete and cost_incomplete_reasons).
const SchemaRevision = 1

// Errors a Log read returns.
var (
	// ErrExpired: the position is older than what the log still holds.
	ErrExpired = errors.New("the cursor is older than what this observer still holds")
	// ErrFuture: the position is ahead of the log's head.
	ErrFuture = errors.New("the cursor is ahead of this observer's log")
)

// Record is one stored event: its delivery position and its encoded version 3 form, exactly as
// the store holds it (already allow-listed and redacted by ingest).
type Record struct {
	Pos uint64
	Raw json.RawMessage
}

// Log is what the serving side needs from the store. Positions are 1, 2, 3... within one epoch;
// 0 means "before everything". Implementations are safe for concurrent use.
type Log interface {
	// Epoch is the index generation: 16 lowercase hex. A cursor from another epoch is reset.
	Epoch() string
	// Bounds: floor is one before the oldest position still held; head is the newest.
	Bounds() (floor, head uint64)
	// After returns up to limit records after pos, in position order. ErrExpired when pos is
	// below the floor, ErrFuture when it is above the head, nil and no records at the head.
	After(pos uint64, limit int) ([]Record, error)
	// Changed returns a channel closed at the next append. Take it before reading.
	Changed() <-chan struct{}
}

// HistoryQuery asks for a window of history in ORDER (the events' `order` key), the replay
// window of the event contract (section 14, "/history").
type HistoryQuery struct {
	FromOrder, ToOrder string   // [from, to); "" is open
	Entities           []string // events touching any of these refs (none: all)
	Ticket, Execution  string
	TypePrefix         string
	Limit              int
}

// HistoryPage is one window. Next is the FromOrder of the next page when More (a page never
// splits events that share an order key). Complete is false when events of the window may no
// longer be held (only the most recent ones are kept in memory).
type HistoryPage struct {
	Records  []Record
	Next     string
	More     bool
	Complete bool
}

// Historian is a Log that can serve history in order as well as in delivery order.
type Historian interface {
	History(HistoryQuery) HistoryPage
}

// ---- cursors ----

// Cursor is "<epoch>.<pos>".
type Cursor struct {
	Epoch string
	Pos   uint64
}

func (c Cursor) String() string { return c.Epoch + "." + strconv.FormatUint(c.Pos, 10) }

// ErrBadCursor is a cursor that cannot be parsed.
var ErrBadCursor = errors.New("the cursor is not one this observer issued")

// ParseCursor reads the wire form. An empty string is the zero cursor (and ok).
func ParseCursor(s string) (Cursor, error) {
	if s == "" {
		return Cursor{}, nil
	}
	if len(s) > 64 {
		return Cursor{}, ErrBadCursor
	}
	epoch, pos, ok := strings.Cut(s, ".")
	if !ok || !ValidEpoch(epoch) || pos == "" || len(pos) > 20 {
		return Cursor{}, ErrBadCursor
	}
	for _, r := range pos {
		if r < '0' || r > '9' {
			return Cursor{}, ErrBadCursor
		}
	}
	n, err := strconv.ParseUint(pos, 10, 64)
	if err != nil {
		return Cursor{}, ErrBadCursor
	}
	return Cursor{Epoch: epoch, Pos: n}, nil
}

// ValidEpoch: 16 lowercase hex characters.
func ValidEpoch(g string) bool {
	if len(g) != 16 {
		return false
	}
	for _, r := range g {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

// ---- the version 3 event, as the serving side reads it ----

// Origin is the event's source (contract section 4).
type Origin struct {
	Stream        string `json:"stream"`
	Key           string `json:"key"`
	Seq           *int64 `json:"seq"`
	Part          *int64 `json:"part"`
	Writer        string `json:"writer"`
	Script        string `json:"script"`
	SourceVersion string `json:"source_version"`
}

// Time is the event's time block (contract section 6).
type Time struct {
	OccurredAt *string `json:"occurred_at"`
	Precision  string  `json:"precision"`
	NotBefore  *string `json:"not_before"`
	NotAfter   *string `json:"not_after"`
	ObservedAt string  `json:"observed_at"`
	OrderMS    int64   `json:"order_ms"`
}

// IDs are every identity key, all nullable (contract section 4).
type IDs struct {
	ProjectID     *string `json:"project_id"`
	WaveID        *string `json:"wave_id"`
	SliceID       *string `json:"slice_id"`
	Revision      *int64  `json:"revision"`
	TicketID      *string `json:"ticket_id"`
	CellInstance  *string `json:"cell_instance"`
	ExecutionID   *string `json:"execution_id"`
	RunnerID      *string `json:"runner_id"`
	VisitID       *string `json:"visit_id"`
	Station       *string `json:"station"`
	Round         *int64  `json:"round"`
	Attempt       *int64  `json:"attempt"`
	Seat          *string `json:"seat"`
	AgentID       *string `json:"agent_id"`
	ParentAgentID *string `json:"parent_agent_id"`
	ToolCallID    *string `json:"tool_call_id"`
}

// Cause is a recorded or identity link.
type Cause struct {
	EventID string `json:"event_id"`
	Basis   string `json:"basis"`
}

// ArtifactRef names an artifact an event produced or names.
type ArtifactRef struct {
	Ref    string  `json:"ref"`
	SHA256 *string `json:"sha256"`
	Commit *string `json:"commit"`
}

// Event is a decoded version 3 event. Data stays raw: each projection decodes the kind's own
// allow-listed payload into a fixed struct, and ignores what it does not know (contract D12).
type Event struct {
	SchemaVersion  int               `json:"schema_version"`
	SchemaRevision int               `json:"schema_revision"`
	ID             string            `json:"id"`
	Type           string            `json:"type"`
	Pos            uint64            `json:"pos"`
	Origin         Origin            `json:"origin"`
	Authority      string            `json:"authority"`
	Time           Time              `json:"time"`
	Order          string            `json:"order"`
	IDs            IDs               `json:"ids"`
	Entities       []string          `json:"entities"`
	Parent         *string           `json:"parent"`
	Cause          *Cause            `json:"cause"`
	Artifacts      []ArtifactRef     `json:"artifacts"`
	Unknown        []string          `json:"unknown"`
	Inferred       map[string]string `json:"inferred"`
	Late           bool              `json:"late"`
	Withheld       int               `json:"withheld"`
	Data           json.RawMessage   `json:"data"`
}

// ErrNotV3 is an event that is not version 3 (or not an event at all).
var ErrNotV3 = errors.New("not a version 3 event")

// Decode reads one record. The record's position wins over any pos in the body.
func Decode(r Record) (*Event, error) {
	var ev Event
	if err := json.Unmarshal(r.Raw, &ev); err != nil {
		return nil, err
	}
	if ev.SchemaVersion != SchemaVersion || ev.ID == "" || ev.Type == "" {
		return nil, ErrNotV3
	}
	ev.Pos = r.Pos
	return &ev, nil
}

// DataAs decodes the event's data into out; a missing or malformed payload leaves out zero.
func (e *Event) DataAs(out any) bool {
	if len(e.Data) == 0 {
		return false
	}
	return json.Unmarshal(e.Data, out) == nil
}

// Str returns *p or "".
func Str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Ticket, Execution: shorthands.
func (e *Event) Ticket() string    { return Str(e.IDs.TicketID) }
func (e *Event) Execution() string { return Str(e.IDs.ExecutionID) }

// HasEntity reports whether the event names ref.
func (e *Event) HasEntity(ref string) bool {
	for _, x := range e.Entities {
		if x == ref {
			return true
		}
	}
	return false
}

// ParseMS reads an RFC 3339 time as Unix milliseconds.
func ParseMS(s *string) (int64, bool) {
	if s == nil || *s == "" {
		return 0, false
	}
	t, err := time.Parse(time.RFC3339Nano, *s)
	if err != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}

// FormatMS writes Unix milliseconds as RFC 3339 UTC with milliseconds.
func FormatMS(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// ---- filters ----

// Filter selects events. Empty fields match everything.
type Filter struct {
	Ticket    string
	Execution string
	TypePref  string // a prefix of the kind: "review." or "station.entered"
	Entity    string // a kind:id ref the event names
	Authority string
	Station   string
}

// Empty reports whether the filter selects everything.
func (f Filter) Empty() bool { return f == Filter{} }

// Match tests one decoded event.
func (f Filter) Match(e *Event) bool {
	return (f.Ticket == "" || e.Ticket() == f.Ticket) &&
		(f.Execution == "" || e.Execution() == f.Execution) &&
		(f.TypePref == "" || strings.HasPrefix(e.Type, f.TypePref)) &&
		(f.Entity == "" || e.HasEntity(f.Entity)) &&
		(f.Authority == "" || e.Authority == f.Authority) &&
		(f.Station == "" || Str(e.IDs.Station) == f.Station)
}

// MatchRaw tests a record. With an empty filter it matches without decoding. A record that is
// not a version 3 event matches only the empty filter.
func (f Filter) MatchRaw(r Record) bool {
	if f.Empty() {
		return true
	}
	ev, err := Decode(r)
	return err == nil && f.Match(ev)
}

// Page is the result of Scan.
type Page struct {
	Records []Record
	Next    uint64 // the last position examined: page again from here
	Scanned int
}

// Scan reads records after pos that match f, up to limit matches and at most scanCap records
// examined, so a selective filter over a long log cannot make one request unbounded.
func Scan(log Log, pos uint64, f Filter, limit, scanCap int) (Page, error) {
	page := Page{Next: pos}
	for len(page.Records) < limit && page.Scanned < scanCap {
		batch := min(scanCap-page.Scanned, 1000)
		if f.Empty() {
			batch = min(batch, limit-len(page.Records))
		}
		recs, err := log.After(page.Next, batch)
		if err != nil {
			return page, err
		}
		if len(recs) == 0 {
			break
		}
		for _, r := range recs {
			page.Next = r.Pos
			page.Scanned++
			if f.MatchRaw(r) {
				page.Records = append(page.Records, r)
				if len(page.Records) >= limit {
					break
				}
			}
		}
	}
	return page, nil
}
