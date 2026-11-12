package normalize

import (
	"encoding/json"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
)

// lifecycleData is the allowlist for a cell lifecycle.jsonl record's data, by type, from
// schemas/cell-lifecycle.schema.json and M6_1_EVENT_CONTRACT.md section 10.2 (raw field names;
// the contract's renaming to v3 names happens when the envelope moves to the full v3 shape).
// Station entries, exits and gates also keep their integer and boolean facts under data.counts.
// Free text is absent on purpose: no finding text, note, failure tail, test output or name.
var lifecycleData = map[string]struct {
	fields []field
	counts bool
}{
	"station.entered": {counts: true, fields: []field{
		{name: "stage", kind: kToken}, {name: "mode", kind: kToken}, {name: "resumed", kind: kBool}, {name: "isolation", kind: kToken},
		{name: "head", kind: kCommit}, {name: "revision", kind: kScalar}, {name: "method", kind: kToken},
		{name: "unclosed_visit", kind: kID}, {name: "round", kind: kInt},
	}},
	"station.exited": {counts: true, fields: []field{
		{name: "outcome", kind: kLabel}, {name: "stage", kind: kToken}, {name: "closed_by", kind: kToken}, {name: "head", kind: kCommit},
	}},
	"gate.evaluated": {counts: true, fields: []field{
		{name: "gate", kind: kToken}, {name: "outcome", kind: kToken}, {name: "reason_code", kind: kLabel},
		{name: "overridden_by_reason", kind: kPresent, as: "override_reason_given"},
		{name: "task", kind: kID}, {name: "item", kind: kID}, {name: "seat", kind: kToken}, {name: "audit_tier", kind: kLabel},
	}},
	"build.task_completed": {fields: []field{
		{name: "task", kind: kID}, {name: "kind", kind: kToken}, {name: "step", kind: kToken}, {name: "first_run", kind: kToken},
		{name: "suite", kind: kToken}, {name: "commit", kind: kCommit},
	}},
	"verify.check_recorded": {fields: []field{
		{name: "item", kind: kID}, {name: "kind", kind: kToken}, {name: "result", kind: kLabel}, {name: "evidence", kind: kEvidence},
	}},
	"review.round_started": {fields: []field{
		{name: "round", kind: kInt}, {name: "max_rounds", kind: kInt}, {name: "risk", kind: kLabel}, {name: "tuning", kind: kBool},
		{name: "seats", kind: kTokenList}, {name: "models", kind: kLabels}, {name: "approvals_needed", kind: kInt},
		{name: "human_approval_required", kind: kBool}, {name: "delta", kind: kBool},
	}},
	"review.verdict_submitted": {fields: []field{
		{name: "round", kind: kInt}, {name: "seat", kind: kToken}, {name: "vote", kind: kLabel}, {name: "blockers", kind: kInt},
		{name: "notes", kind: kInt}, {name: "rules", kind: kIDList},
	}},
	"review.decided": {fields: []field{
		{name: "round", kind: kInt}, {name: "decision", kind: kLabel}, {name: "approvals", kind: kInt}, {name: "needed", kind: kInt},
		{name: "votes", kind: kLabels}, {name: "blockers", kind: kInt}, {name: "security_veto", kind: kBool},
		{name: "human_approval_required", kind: kBool},
	}},
	"human.approval_recorded": {fields: []field{
		{name: "round", kind: kInt}, {name: "decision", kind: kLabel}, {name: "note_given", kind: kBool},
	}},
	"merge.completed": {fields: []field{
		{name: "method", kind: kToken}, {name: "approved_commit", kind: kCommit}, {name: "landed_commit", kind: kCommit},
		{name: "merge_commit", kind: kCommit}, {name: "revalidated", kind: kBool}, {name: "pull_request", kind: kInt},
	}},
	"cleanup.completed": {fields: []field{
		{name: "outcome", kind: kLabel}, {name: "archive", kind: kRelPath}, {name: "bundle", kind: kRelPath},
		{name: "uncommitted_saved", kind: kBool},
	}},
}

type lifecycleLine struct {
	V           *int64         `json:"v"`
	Seq         any            `json:"seq"`
	At          any            `json:"at"`
	TicketID    any            `json:"ticket_id"`
	Type        any            `json:"type"`
	Station     any            `json:"station"`
	Visit       any            `json:"visit"`
	Round       any            `json:"round"`
	Attempt     any            `json:"attempt"` // the name before the schema settled on "round"
	ExecutionID any            `json:"execution_id"`
	Data        map[string]any `json:"data"`
}

// Lifecycle normalizes one line of .factory/worktrees/<ticket>/lifecycle.jsonl. The record's own
// seq may be null (the helper writes without it when it cannot take its lock in time), so the
// event's position is the physical line; a non-null seq is returned for gap checks only. A line
// naming a ticket other than its folder's is refused: one cell cannot speak for another.
func Lifecycle(line []byte, ctx Context) Result {
	var in lifecycleLine
	if err := json.Unmarshal(line, &in); err != nil {
		return Result{Problem: ProblemMalformed}
	}
	if in.V == nil || *in.V != 1 {
		return Result{Problem: ProblemVersion}
	}
	typ, okType := redact.Token(in.Type)
	var seq int64
	if in.Seq != nil {
		n, ok := redact.Int(in.Seq)
		if !ok || n < 1 {
			return Result{Problem: ProblemEnvelope}
		}
		seq = n
	}
	if !okType || ctx.Line < 1 {
		return Result{Problem: ProblemEnvelope}
	}
	ticket, ok := redact.ID(in.TicketID)
	if !ok || ticket != ctx.Ticket {
		return Result{Problem: ProblemWrongTicket}
	}
	partition := event.CellPartition(ticket, ctx.Epoch)
	at, precision := occurred(in.At)
	ev := &event.Event{
		V:          event.Version,
		ID:         event.At(partition, ctx.Line),
		Type:       typ,
		Authority:  event.Authoritative,
		Source:     event.Source{Kind: event.KindCell, Key: partition, Epoch: ctx.Epoch, Seq: seq, Line: ctx.Line, Offset: ctx.Offset},
		OccurredAt: at,
		Precision:  precision,
		ObservedAt: Stamp(ctx.ObservedAt),
		Live:       ctx.Live,
		Subject:    event.Subject{TicketID: ticket, Actor: "station"},
	}
	ev.Subject.Station, _ = redact.Token(in.Station)
	ev.Subject.Visit, _ = redact.ID(in.Visit)
	ev.Subject.ExecutionID, _ = redact.ID(in.ExecutionID)
	round := in.Round
	if round == nil {
		round = in.Attempt
	}
	if r, ok := redact.Int(round); ok && r > 0 {
		ev.Subject.Round = &r
	}
	if spec, known := lifecycleData[typ]; known {
		ev.Data, ev.Withheld = projectCounts(in.Data, spec.fields, ctx.ProjectRoot, spec.counts)
	} else {
		// A kind this observer does not know (a newer writer): identities kept, data withheld.
		ev.Withheld = len(in.Data)
	}
	return Result{Event: ev, Seq: seq}
}
