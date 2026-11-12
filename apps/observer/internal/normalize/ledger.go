package normalize

import (
	"encoding/json"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
)

// Result is what a normalizer made of one line: an event, or the reason it was refused.
type Result struct {
	Event   *event.Event
	Seq     int64
	Problem string
}

// ledgerData is the allowlist for .factory/intake/events.jsonl (schema version 2), by type. A
// field not named here never leaves the observer. People's names (`by`), the session ID, process
// IDs, the Claude error text and `refs` are deliberately absent; prose fields are scrubbed.
var ledgerData = map[string][]field{
	"wave.discovered":     {{name: "slices", kind: kIDList}, {name: "approval", kind: kPresent, as: "approved"}},
	"intake.validated":    {{name: "digest", kind: kDigest}},
	"intake.refused":      {{name: "problems", kind: kCount, as: "problem_count"}},
	"slice.materialized":  {{name: "digest", kind: kDigest}, {name: "adopted", kind: kBool}, {name: "dependencies", kind: kIDList}, {name: "reissued", kind: kBool}},
	"slice.integrated":    {{name: "commit", kind: kCommit}},
	"dependency.resolved": {{name: "depends_on", kind: kIDList}},
	"dependency.blocked":  {{name: "reasons", kind: kTextList}},
	"work.scheduled":      {{name: "stage", kind: kToken}, {name: "risk", kind: kID}},
	"revision.superseded": {{name: "from_revision", kind: kInt}, {name: "effect", kind: kToken}},
	"human.required":      {{name: "reason", kind: kText}},
	"factory.activated": {{name: "autonomy", kind: kToken}, {name: "allow_merge", kind: kBool}, {name: "persistent", kind: kBool},
		{name: "limits", kind: kNumbers}, {name: "backlog", kind: kToken}, {name: "excluded_slices", kind: kIDList}},
	"factory.paused":      {{name: "reason", kind: kText}},
	"factory.resumed":     {{name: "retrying", kind: kIDList}},
	"factory.disabled":    {{name: "stopped", kind: kBool}},
	"revision.discovered": {{name: "from_commit", kind: kCommit}, {name: "commit", kind: kCommit}},
	"scheduling.decided": {{name: "state", kind: kToken}, {name: "dispatched", kind: kIDList}, {name: "started", kind: kIDList},
		{name: "held", kind: kHeld}},
	"work.claimed":      {{name: "stage", kind: kToken}, {name: "next", kind: kToken}, {name: "attempt", kind: kInt}},
	"execution.started": {{name: "until", kind: kToken}, {name: "workflow", kind: kID}, {name: "limits", kind: kNumbers}},
	"station.observed":  {{name: "from_stage", kind: kToken}, {name: "stage", kind: kToken}},
	"recovery.started":  {{name: "kind", kind: kToken}, {name: "previous_heartbeat", kind: kText}},
	"execution.completed": {{name: "stage", kind: kToken}, {name: "next", kind: kToken}, {name: "waiting_for", kind: kToken},
		{name: "how", kind: kToken}, {name: "seen_to_end", kind: kBool}, {name: "cost_usd", kind: kNumber},
		{name: "refused_tools", kind: kTokenList}},
	"execution.failed": {{name: "stage", kind: kToken}, {name: "next", kind: kToken}, {name: "how", kind: kToken},
		{name: "exit_code", kind: kInt}, {name: "attempt", kind: kInt}, {name: "claude_error", kind: kPresent, as: "claude_error_present"}},
}

// LedgerUnknownType is the type an event of a kind this observer does not know is given. Its
// identities are kept and its data is not.
const LedgerUnknownType = "ledger.unrecognised"

type ledgerLine struct {
	SchemaVersion *int64         `json:"schema_version"`
	Seq           *int64         `json:"seq"`
	At            any            `json:"at"`
	Type          string         `json:"type"`
	ProjectID     any            `json:"project_id"`
	WaveID        any            `json:"wave_id"`
	SliceID       any            `json:"slice_id"`
	Revision      any            `json:"revision"`
	TicketID      any            `json:"ticket_id"`
	RunnerID      any            `json:"runner_id"`
	ExecutionID   any            `json:"execution_id"`
	Source        any            `json:"source"`
	Data          map[string]any `json:"data"`
}

// Ledger normalizes one line of .factory/intake/events.jsonl.
func Ledger(line []byte, ctx Context) Result {
	var in ledgerLine
	if err := json.Unmarshal(line, &in); err != nil {
		return Result{Problem: ProblemMalformed}
	}
	if in.SchemaVersion == nil || *in.SchemaVersion != 2 {
		return Result{Problem: ProblemVersion}
	}
	if in.Seq == nil || *in.Seq < 1 || in.Type == "" {
		return Result{Problem: ProblemEnvelope}
	}
	seq := *in.Seq
	typ := in.Type
	spec, known := ledgerData[typ]
	if !known {
		typ = LedgerUnknownType
	}
	at, precision := occurred(in.At)
	partition := event.LedgerPartition(ctx.Epoch)
	authority := event.Authoritative
	if typ == "station.observed" {
		authority = event.Observed // the supervisor sampled cell.json; it did not decide the stage
	}
	ev := &event.Event{
		V:          event.Version,
		ID:         event.At(partition, seq),
		Type:       typ,
		Authority:  authority,
		Source:     event.Source{Kind: event.KindLedger, Key: partition, Epoch: ctx.Epoch, Seq: seq, Line: ctx.Line, Offset: ctx.Offset},
		OccurredAt: at,
		Precision:  precision,
		ObservedAt: Stamp(ctx.ObservedAt),
		Live:       ctx.Live,
	}
	s := &ev.Subject
	s.ProjectID, _ = redact.ID(in.ProjectID)
	s.WaveID, _ = redact.ID(in.WaveID)
	s.SliceID, _ = redact.ID(in.SliceID)
	s.TicketID, _ = redact.ID(in.TicketID)
	s.RunnerID, _ = redact.ID(in.RunnerID)
	s.ExecutionID, _ = redact.ID(in.ExecutionID)
	s.Actor, _ = redact.Token(in.Source)
	if rev, ok := redact.Int(in.Revision); ok {
		s.Revision = &rev
	}
	if known {
		ev.Data, ev.Withheld = project(in.Data, spec, ctx.ProjectRoot)
	} else {
		ev.Withheld = len(in.Data)
		ev.Data = map[string]any{"source_type": tokenOr(in.Type, "unknown")}
	}
	return Result{Event: ev, Seq: seq}
}

func tokenOr(v any, fallback string) string {
	if t, ok := redact.Token(v); ok {
		return t
	}
	return fallback
}
