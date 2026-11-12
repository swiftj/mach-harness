// Package event defines the observer's normalized event (the "version 3" view) and its cursor.
//
// The observer never forwards a source record. It builds one of these from an allowlisted
// projection of the record, assigns it a position in its own merged log, and serves that.
// The field set follows the assumptions in M6_1_OBSERVER_DESIGN.md section 6; the authoritative
// contract is docs/mach-next/M6_1_EVENT_CONTRACT.md, which was being written in parallel. Where
// the two differ, the contract wins and this file changes.
package event

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
)

// Version is the normalized event's schema version.
const Version = 3

// Authority says how much a consumer may trust an event.
const (
	// Authoritative: a MACH script recorded the fact as it decided it (the intake log, a cell's
	// lifecycle log, also when read from the cell's archive). Definitions: M6_1_EVENT_CONTRACT.md §7.
	Authoritative = "authoritative"
	// Observed: seen in a runtime record MACH did not decide (Claude's stream; the supervisor's
	// sampling of cell.json, `station.observed`).
	Observed = "observed"
	// Reconstructed: derived afterwards by the observer (a history gap, a finding read from a vote).
	Reconstructed = "reconstructed"
)

// Source kinds.
const (
	KindLedger    = "ledger"
	KindCell      = "cell"
	KindExecution = "execution"
	KindObserver  = "observer"
)

// Source says where an event came from, precisely enough to find the line again.
type Source struct {
	Kind string `json:"kind"`
	// Key is the partition (see Enc): "i:<gen>", "c:<ticket>:<gen>", "s:<execution>", "o".
	Key string `json:"key"`
	// Epoch is the file's generation (first 8 hex of SHA-256 of its first line), so a recreated
	// file whose numbering starts again never collides with the old one.
	Epoch string `json:"epoch,omitempty"`
	// Seq is the source's own sequence number, when the record has one.
	Seq int64 `json:"seq,omitempty"`
	// Line is the 1-based physical line in the file (the position in a lifecycle or stream ID).
	Line int64 `json:"line,omitempty"`
	// Offset is the byte offset of the line, for resuming.
	Offset int64 `json:"offset"`
}

// Subject holds the identities an event is about. Every value has passed redact.ID.
type Subject struct {
	ProjectID   string `json:"project_id,omitempty"`
	WaveID      string `json:"wave_id,omitempty"`
	SliceID     string `json:"slice_id,omitempty"`
	Revision    *int64 `json:"revision,omitempty"`
	TicketID    string `json:"ticket_id,omitempty"`
	ExecutionID string `json:"execution_id,omitempty"`
	RunnerID    string `json:"runner_id,omitempty"`
	Station     string `json:"station,omitempty"`
	Visit       string `json:"visit,omitempty"`
	Round       *int64 `json:"round,omitempty"` // the judging round (1 to 3), from a lifecycle record
	Actor       string `json:"actor,omitempty"` // intake | engineer | supervisor | station | observer
}

// Event is one normalized event. Data holds only allowlisted, redacted values.
type Event struct {
	V      int    `json:"v"`
	ID     string `json:"id"`
	Cursor string `json:"cursor"`
	// Position is the merged log position; Cursor is its wire form with the generation.
	Position  uint64  `json:"-"`
	Type      string  `json:"type"`
	Authority string  `json:"authority"`
	Source    Source  `json:"source"`
	Subject   Subject `json:"subject"`
	// OccurredAt is the best known time the fact happened; Precision says how good it is:
	// "ms", "second", "observed" (when the observer saw it) or "unknown".
	OccurredAt string `json:"occurred_at,omitempty"`
	Precision  string `json:"occurred_precision"`
	// ObservedAt is when the observer read the line, in UTC milliseconds.
	ObservedAt string `json:"observed_at"`
	// Live is false for lines that were already on disk when the observer first looked
	// (backfill), so ObservedAt is not close to when the fact happened.
	Live bool           `json:"live"`
	Data map[string]any `json:"data,omitempty"`
	// Withheld counts source fields that were dropped by the allowlist or redaction.
	Withheld int `json:"withheld,omitempty"`
}

// Event IDs follow M6_1_EVENT_CONTRACT.md section 5.1: readable, deterministic, built from the
// source partition and the position in it, so the same line read twice (after a restart, a
// rebuild, a truncate-and-rewrite, or from a cell's archived copy) always has the same ID.
//
//	intake log      i:<gen>:<seq>               partition i:<gen>
//	cell lifecycle  c:<ticket>:<gen>:<line>     partition c:<ticket>:<gen>
//	stream          s:<execution>:<line>.<part> partition s:<execution>
//	observer gap    o:gap:<partition>:<detail>
//
// <gen> is the first 8 hex of SHA-256 of the file's first line (the tailer's epoch). Components
// are percent-encoded outside [A-Za-z0-9._-], so an identifier cannot inject a separator.

// Enc percent-encodes everything outside [A-Za-z0-9._-].
func Enc(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-' {
			b.WriteByte(c)
		} else {
			b.WriteString("%" + strings.ToUpper(hex.EncodeToString([]byte{c})))
		}
	}
	return b.String()
}

// LedgerPartition is the intake log's partition key.
func LedgerPartition(gen string) string { return "i:" + Enc(gen) }

// CellPartition is a cell lifecycle log's partition key.
func CellPartition(ticket, gen string) string { return "c:" + Enc(ticket) + ":" + Enc(gen) }

// StreamPartition is an execution stream's partition key.
func StreamPartition(execution string) string { return "s:" + Enc(execution) }

// At is an ID inside a partition: <partition>:<n>.
func At(partition string, n int64) string { return partition + ":" + strconv.FormatInt(n, 10) }

// Part is an ID for the part-th event one line yields: <partition>:<line>.<part>.
func Part(partition string, line int64, part int) string {
	return At(partition, line) + "." + strconv.Itoa(part)
}

// GapID names an observer gap event by its basis partition and what is missing.
func GapID(partition, detail string) string { return "o:gap:" + partition + ":" + Enc(detail) }

// Hash8 is the first 8 hex of SHA-256 of b, the generation of a file from its first line.
func Hash8(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:4])
}

// Cursor is a position in one generation of the merged log.
type Cursor struct {
	Generation string
	Position   uint64
}

// ErrBadCursor is a cursor that cannot be parsed.
var ErrBadCursor = errors.New("the cursor is not one this observer issued")

// String is the wire form: "<generation>.<position>".
func (c Cursor) String() string {
	return c.Generation + "." + strconv.FormatUint(c.Position, 10)
}

// ParseCursor reads the wire form. An empty string is the zero cursor.
func ParseCursor(s string) (Cursor, error) {
	if s == "" {
		return Cursor{}, nil
	}
	if len(s) > 64 {
		return Cursor{}, ErrBadCursor
	}
	gen, pos, ok := strings.Cut(s, ".")
	if !ok || !ValidGeneration(gen) {
		return Cursor{}, ErrBadCursor
	}
	n, err := strconv.ParseUint(pos, 10, 64)
	if err != nil {
		return Cursor{}, ErrBadCursor
	}
	return Cursor{Generation: gen, Position: n}, nil
}

// ValidGeneration: 16 lowercase hex characters.
func ValidGeneration(g string) bool {
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
