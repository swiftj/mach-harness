package normalize

import (
	"encoding/json"
	"strings"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
)

// ExecutionStarted is execution.process_started from started.json (contract 10.3): the true
// start of the process, written once by executor.wrapper. Process ids are never read.
func ExecutionStarted(execution string, data []byte, identity *Identity, r Read) *event.Event {
	var raw map[string]any
	if json.Unmarshal(data, &raw) != nil {
		return nil
	}
	ev := execRecord("execution.process_started", execution, 1, identity, r)
	secondTime(ev, raw["started_at"], r)
	ev.Withheld = len(raw) - 2 // execution_id and started_at are read; the process ids are not
	ev.Data = map[string]any{}
	return ev
}

// ExecutionEnded is execution.process_ended from result.json.
func ExecutionEnded(execution string, data []byte, identity *Identity, r Read) *event.Event {
	var raw map[string]any
	if json.Unmarshal(data, &raw) != nil {
		return nil
	}
	ev := execRecord("execution.process_ended", execution, 2, identity, r)
	secondTime(ev, raw["ended_at"], r)
	d := map[string]any{"exit_code": intOrNil(raw["exit_code"]), "seconds": intOrNil(raw["seconds"])}
	require(ev, d, "ended", enum(raw["ended"], "exited", "timed-out", "interrupted", "could-not-start"), "exited")
	ev.Data = d
	for k := range raw {
		switch k {
		case "execution_id", "ended", "exit_code", "ended_at", "seconds":
		default:
			ev.Withheld++ // "error" (exception text) never leaves the observer
		}
	}
	return ev
}

// EndedMS reads result.json's end, for the closings of open spans (contract 8).
func EndedMS(data []byte) (int64, bool) {
	var raw map[string]any
	if json.Unmarshal(data, &raw) != nil {
		return 0, false
	}
	ms, _, ok := parseTime(raw["ended_at"])
	return ms + 999, ok
}

// StartedMS reads started.json's start.
func StartedMS(data []byte) (int64, bool) {
	var raw map[string]any
	if json.Unmarshal(data, &raw) != nil {
		return 0, false
	}
	ms, _, ok := parseTime(raw["started_at"])
	return ms, ok
}

func execRecord(typ, execution string, seq int64, identity *Identity, r Read) *event.Event {
	key := event.ExecRecordKey(execution)
	ev := newEvent(typ, event.StreamExecution, key, seq, "executor", event.Authoritative)
	if seq == 1 {
		ev.ID = key + ":started"
	} else {
		ev.ID = key + ":ended"
	}
	ev.IDs.ExecutionID = execution
	ev.Ref(event.RefExecution(execution))
	if identity != nil {
		ev.IDs.ProjectID = identity.ProjectID
		if t := identity.TicketOf(execution); t != "" {
			ev.IDs.TicketID = t
			p := identity.ProductOf(t)
			ev.IDs.SliceID, ev.IDs.WaveID, ev.IDs.Revision = p.SliceID, p.WaveID, p.Revision
			cell := event.CellRef(t, identity.Current(t))
			ev.Ref(cell)
			ev.Parent = cell
		}
	}
	if ev.IDs.TicketID == "" {
		ev.AddUnknown("ids.ticket_id")
	}
	return ev
}

// Runs normalises .factory/archive/runs.jsonl (contract 10.4): one run.recorded per line, the
// cell's completion record that survives the deletion of its folder.
type Runs struct {
	Gen      string
	Root     string
	Identity *Identity
	key      string
}

// NewRuns makes the normaliser for one generation of runs.jsonl.
func NewRuns(gen, root string, identity *Identity) *Runs {
	return &Runs{Gen: gen, Root: root, Identity: identity, key: event.RunKey(gen)}
}

// Key is the partition key.
func (n *Runs) Key() string { return n.key }

// Line normalises one line.
func (n *Runs) Line(line []byte, r Read) []*event.Event {
	var raw map[string]any
	if json.Unmarshal(line, &raw) != nil || raw == nil {
		g := gapEvent(event.ObserverID("gap", n.key+":line-"+itoa(r.Line)), n.key, "unparsable-line", r.Line, r.Line, 1, nil, r)
		g.AnchorKey, g.AnchorSeq = n.key, r.Line
		return []*event.Event{g}
	}
	// observe.py strips a ticket id and keeps any non-empty one; the observer strips it too, and an
	// id still outside its pattern is refused (a gap, counted in the analytics coverage).
	if t, isStr := raw["ticket_id"].(string); isStr {
		raw["ticket_id"] = strings.TrimSpace(t)
	}
	ticket, ok := Ticket(raw["ticket_id"])
	if !ok {
		g := gapEvent(event.ObserverID("gap", n.key+":line-"+itoa(r.Line)), n.key, "unparsable-line", r.Line, r.Line, 1, nil, r)
		g.AnchorKey, g.AnchorSeq = n.key, r.Line
		return []*event.Event{g}
	}
	ev := newEvent("run.recorded", event.StreamRun, n.key, r.Line, "cleanup", event.Authoritative)
	ev.ID = event.At(n.key, r.Line)
	ev.Origin.Script = "cleanup.py"
	if v, ok := redact.Int(raw["record_version"]); ok {
		ev.Origin.SourceVersion = itoa(v)
	}
	secondTime(ev, raw["closed_at"], r)
	ev.IDs.TicketID = ticket
	product := obj(raw["product"])
	ev.IDs.SliceID, _ = redact.ID(product["slice_id"])
	if ev.IDs.SliceID == "" {
		ev.IDs.SliceID, _ = redact.ID(raw["slice_id"])
	}
	ev.IDs.WaveID, _ = redact.ID(product["wave_id"])
	if rev, ok := redact.Int(product["revision"]); ok {
		ev.IDs.Revision = &rev
	}
	if n.Identity != nil {
		ev.IDs.ProjectID = n.Identity.ProjectID
	}
	integration := obj(raw["integration"])
	d := map[string]any{
		"rounds":         numOrNil(raw["rounds"]), // a number, as observe.py counts it
		"first_pass":     boolOr(raw["first_pass"], false),
		"escalated":      boolOr(raw["escalated"], false),
		"human_approval": boolOr(raw["human_approval"], false),
		"deviations":     int64(len(arr(raw["deviations"]))),
		"blockers":       int64(len(arr(raw["blockers"]))),
		"risk":           enum(raw["risk"], risks...),
		"app_type":       tokOrNil(raw["app_type"]),
		"merge_method":   enum(integration["method"], "local", "pr", "squash-or-rebase", "manual"),
		"merge_commit":   commitOrNil(integration["merge_commit"]),
	}
	require(ev, d, "record_version", intOrNil(raw["record_version"]), int64(1))
	require(ev, d, "outcome", enum(raw["outcome"], "merged", "abandoned"), "merged")
	for _, k := range []string{"verify_failures", "review_rejections"} {
		require(ev, d, k, intOrNil(raw[k]), int64(0))
	}
	// observe.py sums these as numbers (number()): fractions count, anything else is 0.
	for _, k := range []string{"tests_seen_failing_first", "tests_passing_on_first_run"} {
		require(ev, d, k, numOrNil(raw[k]), float64(0))
	}
	ev.Data = d
	used := map[string]bool{"record_version": true, "ticket_id": true, "slice_id": true, "product": true, "integration": true, "closed_at": true,
		"rounds": true, "first_pass": true, "escalated": true, "human_approval": true, "deviations": true, "blockers": true, "risk": true,
		"app_type": true, "outcome": true, "verify_failures": true, "review_rejections": true, "tests_seen_failing_first": true,
		"tests_passing_on_first_run": true}
	for k := range raw {
		if !used[k] {
			ev.Withheld++ // title, abandon_reason, notes, verify_findings, archive path, created_at, mode
		}
	}
	k := 1
	if n.Identity != nil {
		k = n.Identity.Current(ticket)
	}
	ev.Ref(event.CellRef(ticket, k))
	if ev.IDs.SliceID != "" {
		ev.Ref(event.RefSlice(ev.IDs.SliceID))
	}
	if c, ok := d["merge_commit"].(string); ok {
		ref := "artifact:" + event.CellName(ticket, k) + ":commit/" + c
		ev.Artifacts = []event.Artifact{{Ref: ref, Commit: c}}
		ev.Ref(ref)
	}
	return []*event.Event{ev}
}
