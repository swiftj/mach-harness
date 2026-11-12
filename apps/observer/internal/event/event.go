// Package event defines the observer's normalised event (version 3 of the factory event, a view
// that nothing writes to disk under .factory/) and its cursor.
//
// The authority is docs/mach-next/M6_1_EVENT_CONTRACT.md (sections 4 to 7) and
// docs/mach-next/schemas/factory-event.v3.schema.json. Every field of the envelope is always
// present on the wire; a field that does not apply is null, and one that applies but is not known
// is null and named in Unknown. In Go, an empty string (or 0 where the schema's minimum is 1, or a
// nil pointer) stands for null; the JSON methods below write it as null.
package event

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Version is the schema version; Revision the additive revision within it.
// Revision 1 added execution.usage's cost_complete and cost_incomplete_reasons.
const (
	Version  = 3
	Revision = 1
)

// Authority (contract section 7).
const (
	Authoritative = "authoritative"
	Observed      = "observed"
	Reconstructed = "reconstructed"
)

// Streams (origin.stream) and their rank in the history order (contract section 6.3).
const (
	StreamIntake    = "intake-log"
	StreamLifecycle = "cell-lifecycle"
	StreamExecution = "execution-record"
	StreamRun       = "run-record"
	StreamClaude    = "execution-stream"
	StreamObserver  = "observer"
)

// Rank is a stream's rank in the order key.
func Rank(stream string) int {
	switch stream {
	case StreamIntake:
		return 1
	case StreamLifecycle:
		return 2
	case StreamExecution:
		return 3
	case StreamRun:
		return 4
	case StreamClaude:
		return 5
	}
	return 6
}

// Time precision (contract section 6.1).
const (
	PrecisionMS      = "ms"
	PrecisionSecond  = "s"
	PrecisionArrival = "arrival"
	PrecisionBounded = "bounded"
	PrecisionUnknown = "unknown"
)

// Origin says where an event came from. Seq is the durable per-source sequence (0 = null);
// Part numbers the events one record yields (nil = null).
type Origin struct {
	Stream        string
	Key           string
	Seq           int64
	Part          *int
	Writer        string
	Script        string
	SourceVersion string
}

// Time carries when the fact happened, how well that is known, and where it sorts.
type Time struct {
	OccurredAt string
	Precision  string
	NotBefore  string
	NotAfter   string
	ObservedAt string
	OrderMS    int64
}

// IDs are the identities an event is about (contract section 4). Every key is always written.
type IDs struct {
	ProjectID     string
	WaveID        string
	SliceID       string
	Revision      *int64
	TicketID      string
	CellInstance  string
	ExecutionID   string
	RunnerID      string
	VisitID       string
	Station       string
	Round         int64 // the judging round; 0 = null
	Attempt       int64 // the execution attempt; 0 = null
	Seat          string
	AgentID       string
	ParentAgentID string
	ToolCallID    string
}

// Cause is a recorded or identity-based link to an earlier event (contract section 7).
type Cause struct {
	EventID string `json:"event_id"`
	Basis   string `json:"basis"`
}

// Artifact is a reference to an artifact this event produced or names.
type Artifact struct {
	Ref    string `json:"ref"`
	SHA256 string `json:"-"`
	Commit string `json:"-"`
}

// Provenance is required for reconstructed events.
type Provenance struct {
	Basis []string `json:"basis"`
	Rule  string   `json:"rule"`
	Files []string `json:"files"`
}

// Event is one normalised event. Data holds only allowlisted, redacted values.
type Event struct {
	ID         string
	Type       string
	Pos        uint64
	Origin     Origin
	Authority  string
	Time       Time
	Order      string
	IDs        IDs
	Entities   []string
	Parent     string
	Cause      *Cause
	Artifacts  []Artifact
	Unknown    []string
	Inferred   map[string]string
	Provenance *Provenance
	Late       bool
	Withheld   int
	Data       map[string]any

	// Cursor is "<epoch>.<pos>", set by the store. It is not part of the event on the wire.
	Cursor string
	// OrderBasis is, for an observer event, the event it is placed after in the history order
	// (contract 6.3). Ingest only; never stored.
	OrderBasis *Event
	// Anchor is, for an observer event with no basis event, the source partition and sequence it
	// belongs next to (a gap in that partition). Ingest only; never stored.
	AnchorKey string
	AnchorSeq int64
	// Backfill: read while catching a source up with what was written before the observer started
	// (or before an index rebuild), not as it was written. Such an event is never late; it carries
	// provenance rule "backfill" instead (contract 6.5). Ingest only; never stored.
	Backfill bool

	hash string // ContentHash, once computed
}

func nz(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func dz(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func nzi(n int64) *int64 {
	if n == 0 {
		return nil
	}
	return &n
}

func dzi(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

type originWire struct {
	Stream        string  `json:"stream"`
	Key           string  `json:"key"`
	Seq           *int64  `json:"seq"`
	Part          *int    `json:"part"`
	Writer        string  `json:"writer"`
	Script        *string `json:"script"`
	SourceVersion *string `json:"source_version"`
}

type timeWire struct {
	OccurredAt *string `json:"occurred_at"`
	Precision  string  `json:"precision"`
	NotBefore  *string `json:"not_before"`
	NotAfter   *string `json:"not_after"`
	ObservedAt string  `json:"observed_at"`
	OrderMS    int64   `json:"order_ms"`
}

type idsWire struct {
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

type artifactWire struct {
	Ref    string  `json:"ref"`
	SHA256 *string `json:"sha256"`
	Commit *string `json:"commit"`
}

type wire struct {
	SchemaVersion  int               `json:"schema_version"`
	SchemaRevision int               `json:"schema_revision"`
	ID             string            `json:"id"`
	Type           string            `json:"type"`
	Pos            uint64            `json:"pos"`
	Origin         originWire        `json:"origin"`
	Authority      string            `json:"authority"`
	Time           timeWire          `json:"time"`
	Order          string            `json:"order"`
	IDs            idsWire           `json:"ids"`
	Entities       []string          `json:"entities"`
	Parent         *string           `json:"parent"`
	Cause          *Cause            `json:"cause"`
	Artifacts      []artifactWire    `json:"artifacts"`
	Unknown        []string          `json:"unknown"`
	Inferred       map[string]string `json:"inferred"`
	Provenance     *Provenance       `json:"provenance"`
	Late           bool              `json:"late"`
	Withheld       int               `json:"withheld"`
	Data           map[string]any    `json:"data"`
}

func (e *Event) toWire() wire {
	w := wire{
		SchemaVersion: Version, SchemaRevision: Revision, ID: e.ID, Type: e.Type, Pos: e.Pos, Authority: e.Authority,
		Order: e.Order, Entities: e.Entities, Parent: nz(e.Parent), Cause: e.Cause, Unknown: e.Unknown,
		Inferred: e.Inferred, Provenance: e.Provenance, Late: e.Late, Withheld: e.Withheld, Data: e.Data,
		Origin: originWire{Stream: e.Origin.Stream, Key: e.Origin.Key, Seq: nzi(e.Origin.Seq), Part: e.Origin.Part,
			Writer: e.Origin.Writer, Script: nz(e.Origin.Script), SourceVersion: nz(e.Origin.SourceVersion)},
		Time: timeWire{OccurredAt: nz(e.Time.OccurredAt), Precision: e.Time.Precision, NotBefore: nz(e.Time.NotBefore),
			NotAfter: nz(e.Time.NotAfter), ObservedAt: e.Time.ObservedAt, OrderMS: e.Time.OrderMS},
		IDs: idsWire{ProjectID: nz(e.IDs.ProjectID), WaveID: nz(e.IDs.WaveID), SliceID: nz(e.IDs.SliceID), Revision: e.IDs.Revision,
			TicketID: nz(e.IDs.TicketID), CellInstance: nz(e.IDs.CellInstance), ExecutionID: nz(e.IDs.ExecutionID),
			RunnerID: nz(e.IDs.RunnerID), VisitID: nz(e.IDs.VisitID), Station: nz(e.IDs.Station), Round: nzi(e.IDs.Round),
			Attempt: nzi(e.IDs.Attempt), Seat: nz(e.IDs.Seat), AgentID: nz(e.IDs.AgentID), ParentAgentID: nz(e.IDs.ParentAgentID),
			ToolCallID: nz(e.IDs.ToolCallID)},
	}
	if w.Entities == nil {
		w.Entities = []string{}
	}
	if w.Unknown == nil {
		w.Unknown = []string{}
	}
	if w.Inferred == nil {
		w.Inferred = map[string]string{}
	}
	if w.Data == nil {
		w.Data = map[string]any{}
	}
	w.Artifacts = make([]artifactWire, 0, len(e.Artifacts))
	for _, a := range e.Artifacts {
		w.Artifacts = append(w.Artifacts, artifactWire{Ref: a.Ref, SHA256: nz(a.SHA256), Commit: nz(a.Commit)})
	}
	return w
}

// MarshalJSON writes the full version 3 envelope.
func (e Event) MarshalJSON() ([]byte, error) { return json.Marshal(e.toWire()) }

// UnmarshalJSON reads the full version 3 envelope (the index log, tests).
func (e *Event) UnmarshalJSON(b []byte) error {
	var w wire
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	if w.SchemaVersion != Version {
		return fmt.Errorf("schema_version %d is not %d", w.SchemaVersion, Version)
	}
	*e = Event{
		ID: w.ID, Type: w.Type, Pos: w.Pos, Authority: w.Authority, Order: w.Order, Entities: w.Entities, Parent: dz(w.Parent),
		Cause: w.Cause, Unknown: w.Unknown, Inferred: w.Inferred, Provenance: w.Provenance, Late: w.Late, Withheld: w.Withheld, Data: w.Data,
		Origin: Origin{Stream: w.Origin.Stream, Key: w.Origin.Key, Seq: dzi(w.Origin.Seq), Part: w.Origin.Part, Writer: w.Origin.Writer,
			Script: dz(w.Origin.Script), SourceVersion: dz(w.Origin.SourceVersion)},
		Time: Time{OccurredAt: dz(w.Time.OccurredAt), Precision: w.Time.Precision, NotBefore: dz(w.Time.NotBefore),
			NotAfter: dz(w.Time.NotAfter), ObservedAt: w.Time.ObservedAt, OrderMS: w.Time.OrderMS},
		IDs: IDs{ProjectID: dz(w.IDs.ProjectID), WaveID: dz(w.IDs.WaveID), SliceID: dz(w.IDs.SliceID), Revision: w.IDs.Revision,
			TicketID: dz(w.IDs.TicketID), CellInstance: dz(w.IDs.CellInstance), ExecutionID: dz(w.IDs.ExecutionID),
			RunnerID: dz(w.IDs.RunnerID), VisitID: dz(w.IDs.VisitID), Station: dz(w.IDs.Station), Round: dzi(w.IDs.Round),
			Attempt: dzi(w.IDs.Attempt), Seat: dz(w.IDs.Seat), AgentID: dz(w.IDs.AgentID), ParentAgentID: dz(w.IDs.ParentAgentID),
			ToolCallID: dz(w.IDs.ToolCallID)},
	}
	for _, a := range w.Artifacts {
		e.Artifacts = append(e.Artifacts, Artifact{Ref: a.Ref, SHA256: dz(a.SHA256), Commit: dz(a.Commit)})
	}
	return nil
}

// ContentHash identifies what an event says, for duplicate and conflict detection (contract
// section 6.5): its kind, authority, identities, entities, parent, cause, artifacts and data. It
// leaves out everything that depends on when or how the observer read it (pos, time, order, late).
func (e *Event) ContentHash() string {
	if e.hash != "" {
		return e.hash
	}
	w := e.toWire()
	b, _ := json.Marshal(struct {
		Type      string         `json:"t"`
		Authority string         `json:"a"`
		IDs       idsWire        `json:"i"`
		Entities  []string       `json:"e"`
		Parent    *string        `json:"p"`
		Cause     *Cause         `json:"c"`
		Artifacts []artifactWire `json:"r"`
		Data      map[string]any `json:"d"`
	}{w.Type, w.Authority, w.IDs, w.Entities, w.Parent, w.Cause, w.Artifacts, w.Data})
	h := sha256.Sum256(b)
	e.hash = hex.EncodeToString(h[:12])
	return e.hash
}

// Rehash forgets a cached content hash after the event was changed.
func (e *Event) Rehash() { e.hash = "" }

// Tidy sorts and de-duplicates the list fields so an event's encoding is deterministic.
func (e *Event) Tidy() {
	e.Entities = uniqSorted(e.Entities)
	e.Unknown = uniqSorted(e.Unknown)
}

func uniqSorted(in []string) []string {
	if len(in) == 0 {
		return in
	}
	sort.Strings(in)
	out := in[:1]
	for _, s := range in[1:] {
		if s != out[len(out)-1] {
			out = append(out, s)
		}
	}
	return out
}

// AddUnknown names a field that applies but is not known.
func (e *Event) AddUnknown(fields ...string) { e.Unknown = append(e.Unknown, fields...) }

// Infer names a field filled by inference, with its rule.
func (e *Event) Infer(field, rule string) {
	if e.Inferred == nil {
		e.Inferred = map[string]string{}
	}
	e.Inferred[field] = rule
}

// Ref adds entity references.
func (e *Event) Ref(refs ...string) {
	for _, r := range refs {
		if r != "" {
			e.Entities = append(e.Entities, r)
		}
	}
}

// ---- identity (contract section 5) ----

// Enc percent-encodes everything outside [A-Za-z0-9._-], so an identifier cannot inject ':',
// '/', '#', '~' or '->' into an id or a ref.
func Enc(s string) string {
	safe := true
	for i := 0; i < len(s); i++ {
		if !plain(s[i]) {
			safe = false
			break
		}
	}
	if safe {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if plain(c) {
			b.WriteByte(c)
		} else {
			b.WriteString("%" + strings.ToUpper(hex.EncodeToString([]byte{c})))
		}
	}
	return b.String()
}

func plain(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-'
}

// Partition keys (origin.key).
func IntakeKey(gen string) string           { return "i:" + Enc(gen) }
func CellKey(ticket, gen string) string     { return "c:" + Enc(ticket) + ":" + Enc(gen) }
func ExecRecordKey(execution string) string { return "x:" + Enc(execution) }
func RunKey(gen string) string              { return "r:" + Enc(gen) }
func StreamKey(execution string) string     { return "s:" + Enc(execution) }

// ObserverKey is the observer's own partition.
const ObserverKey = "o"

// At is an id inside a partition: <partition>:<n>.
func At(partition string, n int64) string { return partition + ":" + strconv.FormatInt(n, 10) }

// Part is the id of the part-th event one line yields: <partition>:<line>.<part>.
func Part(partition string, line int64, part int) string {
	return At(partition, line) + "." + strconv.Itoa(part)
}

// ObserverID is o:<rule>:<basis>[:<n>]. The basis is an event id or a ref, already encoded.
func ObserverID(rule, basis string, n ...int) string {
	id := "o:" + rule + ":" + basis
	for _, k := range n {
		id += ":" + strconv.Itoa(k)
	}
	return id
}

// Hash8 is the first 8 hex of SHA-256 of b: a file's generation from its first line.
func Hash8(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:4])
}

// OrderKey is the deterministic history order key of contract section 6.3:
// <order_ms, 15 digits>~<rank>~<origin.key>~<seq, 12 digits>~<part, 4 digits>.
func OrderKey(orderMS int64, rank int, key string, seq int64, part int) string {
	if orderMS < 0 {
		orderMS = 0
	}
	if seq < 0 {
		seq = 0
	}
	if part < 0 {
		part = 0
	}
	return fmt.Sprintf("%015d~%d~%s~%012d~%04d", orderMS, rank, key, seq%1e12, part%10000)
}

// Ref builders (contract section 5.2). Components are encoded so a ref is always parseable.
func RefProject(id string) string             { return "project:" + Enc(id) }
func RefWave(id string) string                { return "wave:" + Enc(id) }
func RefSlice(id string) string               { return "slice:" + Enc(id) }
func RefExecution(x string) string            { return "execution:" + Enc(x) }
func RefWorkflow(x, task string) string       { return "workflow:" + Enc(x) + "/" + Enc(task) }
func RefAgent(agentID string) string          { return "agent:" + agentID } // agentID is already <x>/<id>
func RefTool(toolCallID string) string        { return "tool:" + toolCallID }
func RefActor(role string) string             { return "actor:" + role }
func RefDependency(waiting, on string) string { return "dependency:" + Enc(waiting) + "->" + Enc(on) }

// CellRef is cell:<ticket>, or cell:<ticket>~<k> for the k-th incarnation (k >= 2).
func CellRef(ticket string, k int) string { return "cell:" + CellName(ticket, k) }

// CellName is <ticket> or <ticket>~<k>.
func CellName(ticket string, k int) string {
	if k >= 2 {
		return Enc(ticket) + "~" + strconv.Itoa(k)
	}
	return Enc(ticket)
}

// Cursor is a position in one epoch of the index.
type Cursor struct {
	Generation string
	Position   uint64
}

// ErrBadCursor is a cursor that cannot be parsed.
var ErrBadCursor = errors.New("the cursor is not one this observer issued")

// String is the wire form: "<epoch>.<pos>".
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

// Kinds is the version 3 kind catalog (contract section 11), in catalog order.
var Kinds = []string{
	"wave.discovered", "intake.validated", "intake.refused", "slice.materialized", "slice.integrated", "dependency.resolved",
	"dependency.blocked", "work.scheduled", "revision.superseded", "human.required", "factory.activated", "factory.disabled",
	"factory.paused", "factory.resumed", "revision.discovered", "scheduling.decided", "work.claimed", "execution.started",
	"station.observed", "recovery.started", "execution.completed", "execution.failed",
	"station.entered", "station.exited", "gate.evaluated", "build.task_completed", "verify.check_recorded", "review.round_started",
	"review.verdict_submitted", "review.decided", "human.approval_recorded", "merge.completed", "cleanup.completed",
	"execution.process_started", "execution.process_ended", "run.recorded",
	"session.initialized", "workflow.started", "workflow.phases_declared", "workflow.finished", "agent.queued", "agent.started",
	"agent.progressed", "agent.finished", "tool.called", "tool.returned", "tool.refused", "execution.usage",
	"review.finding", "artifact.recorded", "history.began", "verify.targets_listed", "capacity.wait_changed", "history.gap",
}
