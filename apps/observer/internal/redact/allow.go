package redact

import (
	"sort"

	"mach/observer/internal/event"
)

// Shape is one node of a kind's allowlist.
type Shape struct {
	kind int               // shapeScalar, shapeObject, shapeList, shapeMap
	keys map[string]*Shape // shapeObject: exactly these keys
	elem *Shape            // shapeList: each item; shapeMap: each value (keys must be words or names)
}

const (
	shapeScalar = iota
	shapeObject
	shapeList
	shapeMap
)

var scalar = &Shape{kind: shapeScalar} // a string, number, boolean or null

func obj(fields ...any) *Shape {
	s := &Shape{kind: shapeObject, keys: map[string]*Shape{}}
	for i := 0; i < len(fields); i++ {
		name := fields[i].(string)
		child := scalar
		if i+1 < len(fields) {
			if c, ok := fields[i+1].(*Shape); ok {
				child = c
				i++
			}
		}
		s.keys[name] = child
	}
	return s
}

func list(each *Shape) *Shape { return &Shape{kind: shapeList, elem: each} }
func anyKeys(v *Shape) *Shape { return &Shape{kind: shapeMap, elem: v} }

var leafList = list(scalar)

// Allow is the per-kind data allowlist: the schema's $defs (factory-event.v3.schema.json),
// key for key. A kind not here is not served.
var Allow = map[string]*Shape{
	"wave.discovered":     obj("slices", leafList, "approval", obj("approved_at", "by_role")),
	"intake.validated":    obj("digest"),
	"intake.refused":      obj("problems", leafList),
	"slice.materialized":  obj("digest", "adopted", "dependencies", leafList, "reissued"),
	"slice.integrated":    obj("commit"),
	"dependency.resolved": obj("depends_on", leafList),
	"dependency.blocked":  obj("reasons", leafList),
	"work.scheduled":      obj("stage", "risk", "branch", "by_role", "authorization"),
	"revision.superseded": obj("from_revision", "effect"),
	"human.required":      obj("reason"),
	"factory.activated": obj("autonomy", "by_role", "limits", anyKeys(scalar), "allow_merge", "persistent", "backlog",
		"excluded_slices", leafList),
	"factory.disabled":    obj("by_role", "stopped"),
	"factory.paused":      obj("by_role", "reason"),
	"factory.resumed":     obj("by_role", "retrying", leafList),
	"revision.discovered": obj("from_commit", "commit"),
	"scheduling.decided":  obj("state", "dispatched", leafList, "started", leafList, "held", list(obj("slice_id", "ticket_id", "why"))),
	"work.claimed":        obj("stage", "next", "attempt"),
	"execution.started":   obj("until", "workflow", "limits", obj("minutes", "budget_usd")),
	"station.observed":    obj("from_stage", "stage"),
	"recovery.started":    obj("kind"),
	"execution.completed": obj("stage", "next", "waiting_for", "how", "seen_to_end", "cost_usd", "refused_tools", leafList),
	"execution.failed":    obj("stage", "next", "how", "claude_error", "exit_code", "attempt"),

	"station.entered":          obj("station", "stage", "action", "resumed", "unclosed_visit", "head", "counts", anyKeys(scalar)),
	"station.exited":           obj("station", "outcome", "stage", "duration_ms", "closed_by", "head", "counts", anyKeys(scalar), "app_type", "risk"), // revision 2: app_type, risk (plan exit)
	"gate.evaluated":           obj("gate", "verdict", "reason_code", "subject", "status", "audit_tier", "counts", anyKeys(scalar)),
	"build.task_completed":     obj("task_id", "kind", "step", "first_run", "suite", "commit"),
	"verify.check_recorded":    obj("target_id", "target_kind", "result", "evidence", list(obj("file", "sha256", "bytes")), "rerecorded"),
	"review.round_started":     obj("risk", "max_rounds", "tuning", "approvals_needed", "human_approval_required", "panel", list(obj("seat", "model")), "delta", "restarted"),
	"review.verdict_submitted": obj("seat", "vote", "blockers", "notes", "rules", leafList, "model"),
	"review.decided":           obj("outcome", "approvals", "approvals_needed", "votes", anyKeys(scalar), "blockers", "security_veto", "human_approval_required"),
	"human.approval_recorded":  obj("by_role", "note_given"),
	"merge.completed":          obj("method", "merge_commit", "approved_commit", "landed_commit", "revalidated", "pull_request"),
	"cleanup.completed":        obj("outcome", "archive", "bundle", "uncommitted_saved"),

	"execution.process_started": obj(),
	"execution.process_ended":   obj("ended", "exit_code", "seconds"),
	"run.recorded": obj("record_version", "outcome", "rounds", "first_pass", "verify_failures", "review_rejections", "escalated",
		"human_approval", "deviations", "blockers", "tests_seen_failing_first", "tests_passing_on_first_run", "risk", "app_type",
		"merge_method", "merge_commit"),

	"session.initialized":      obj("claude_code_version", "model", "permission_mode", "tools", leafList, "agents", leafList),
	"workflow.started":         obj("workflow", "tickets", leafList, "until"),
	"workflow.phases_declared": obj("phases", list(obj("index", "title"))),
	"workflow.finished": obj("status", "notification_status", "total_tokens", "tool_uses", "duration_ms", "stop_reason", "workflow_json",
		"tickets", list(obj("ticket", "outcome", "stage", "waiting_for", "stations", leafList))),
	"agent.queued":     obj("index", "label", "phase", "phase_index", "model"),
	"agent.started":    obj("index", "label", "phase", "phase_index", "agent_type", "model", "agent_try"),
	"agent.progressed": obj("tool_calls", "tokens", "last_tool"),
	"agent.finished":   obj("status", "duration_ms", "tokens", "tool_calls"),
	"tool.called":      obj("tool", "target_class", "script", "path_rel"),
	"tool.returned":    obj("status", "duration_ms"),
	"tool.refused":     obj("tool", "summary"),
	"execution.usage": obj("total_cost_usd", "subtype", "is_error", "terminal_reason", "budget_exhausted",
		"models", anyKeys(obj("cost_usd", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens")),
		"cost_complete", "cost_incomplete_reasons", leafList), // revision 1

	"review.finding":        obj("seat", "n", "severity", "rule", "file_rel", "title"),
	"artifact.recorded":     obj("kind", "path_rel", "sha256", "bytes", "media_type", "commit", "nature", "integrity"),
	"verify.targets_listed": obj("targets", list(obj("id", "kind")), "source"),
	"capacity.wait_changed": obj("state", "scope", "limit"),
	"history.began":         obj("reason", "snapshot", obj("stage", "round", "station", "state")),
	"history.gap":           obj("source_key", "from_seq", "to_seq", "reason", "count", "class", "history_lost"), // revision 2: class, history_lost
}

// RequiredIDs are the ids each kind must carry (the schema's allOf); an event without one of
// them is not served (ingest reports the record as a gap instead).
var RequiredIDs = map[string][]string{
	"wave.discovered": {"wave_id"}, "slice.materialized": {"slice_id", "ticket_id"}, "slice.integrated": {"slice_id"},
	"dependency.resolved": {"slice_id"}, "dependency.blocked": {"slice_id"}, "work.scheduled": {"slice_id", "ticket_id"},
	"revision.superseded": {"slice_id"}, "work.claimed": {"ticket_id", "execution_id"}, "execution.started": {"ticket_id", "execution_id"},
	"station.observed": {"ticket_id"}, "execution.completed": {"ticket_id", "execution_id"}, "execution.failed": {"ticket_id", "execution_id"},
	"execution.process_started": {"execution_id"}, "execution.process_ended": {"execution_id"}, "run.recorded": {"ticket_id"},
	"session.initialized": {"execution_id"}, "workflow.started": {"execution_id"}, "workflow.phases_declared": {"execution_id"},
	"workflow.finished": {"execution_id"}, "agent.queued": {"execution_id"}, "agent.started": {"execution_id", "agent_id"},
	"agent.progressed": {"execution_id", "agent_id"}, "agent.finished": {"execution_id", "agent_id"},
	"tool.called": {"execution_id", "agent_id", "tool_call_id"}, "tool.returned": {"execution_id", "agent_id", "tool_call_id"},
	"tool.refused": {"execution_id"}, "execution.usage": {"execution_id"}, "review.finding": {"ticket_id", "round", "seat"},
	"artifact.recorded": {"ticket_id"}, "verify.targets_listed": {"ticket_id", "visit_id"}, "capacity.wait_changed": {"ticket_id"},
}

func init() {
	for _, k := range []string{"station.entered", "station.exited", "gate.evaluated", "build.task_completed", "verify.check_recorded",
		"review.round_started", "review.decided", "human.approval_recorded", "merge.completed", "cleanup.completed"} {
		RequiredIDs[k] = []string{"ticket_id", "cell_instance", "visit_id", "station"}
	}
	RequiredIDs["review.verdict_submitted"] = []string{"ticket_id", "cell_instance", "visit_id", "station", "seat"}
}

// MissingID names the first required id an event lacks, or "".
func MissingID(ev *event.Event) string {
	for _, k := range RequiredIDs[ev.Type] {
		var empty bool
		switch k {
		case "wave_id":
			empty = ev.IDs.WaveID == ""
		case "slice_id":
			empty = ev.IDs.SliceID == ""
		case "ticket_id":
			empty = ev.IDs.TicketID == ""
		case "execution_id":
			empty = ev.IDs.ExecutionID == ""
		case "agent_id":
			empty = ev.IDs.AgentID == ""
		case "tool_call_id":
			empty = ev.IDs.ToolCallID == ""
		case "cell_instance":
			empty = ev.IDs.CellInstance == ""
		case "visit_id":
			empty = ev.IDs.VisitID == ""
		case "station":
			empty = ev.IDs.Station == ""
		case "seat":
			empty = ev.IDs.Seat == ""
		case "round":
			empty = ev.IDs.Round == 0
		}
		if empty {
			return k
		}
	}
	return ""
}

// Writers, streams and MACH's own scripts that origin may name.
var (
	writers = map[string]bool{"intake": true, "engineer": true, "supervisor": true, "station": true, "executor": true,
		"cleanup": true, "claude": true, "observer": true}
	streams = map[string]bool{event.StreamIntake: true, event.StreamLifecycle: true, event.StreamExecution: true,
		event.StreamRun: true, event.StreamClaude: true, event.StreamObserver: true}
	// Scripts are MACH's own, by file name; a tool call may add one subcommand word.
	Scripts = map[string]bool{"audit.py": true, "cell.py": true, "build.py": true, "verify.py": true, "review.py": true,
		"merge.py": true, "cleanup.py": true, "run.py": true, "ticket.py": true, "observe.py": true, "intake.py": true,
		"studio.py": true, "lifecycle.py": true, "validate_slice.py": true, "supervisor.py": true, "executor.py": true,
		"policy.py": true, "service.py": true, "activation.py": true, "mach": true}
)

// Counters is what Enforce and ScrubEvent did, for health and for the coverage test.
type Counters struct {
	Events        int64 // events checked
	Dropped       int64 // events of a kind outside the catalog, or with a broken envelope
	FieldsDropped int64 // data keys the allowlist does not name
	Strings       int64 // string values scanned by the scrubber
	Replaced      int64 // sensitive spans replaced
	People        int64 // of which: mentions of a listed person (People), replaced by the role form
}

// Enforce applies the kind's allowlist to ev. It returns false when the event must not be
// stored at all. Dropped fields are counted in ev.Withheld and in c.
func Enforce(ev *event.Event, c *Counters) bool {
	if c != nil {
		c.Events++
	}
	shape, ok := Allow[ev.Type]
	if !ok || !streams[ev.Origin.Stream] || !writers[ev.Origin.Writer] {
		if c != nil {
			c.Dropped++
		}
		return false
	}
	if ev.Origin.Script != "" {
		name, sub, _ := cut(ev.Origin.Script)
		if !Scripts[name] || (sub != "" && !tokenRe.MatchString(sub)) {
			ev.Origin.Script = ""
			ev.Withheld++
		}
	}
	if ev.Data == nil {
		ev.Data = map[string]any{}
	}
	n := prune(ev.Data, shape)
	ev.Withheld += n
	if c != nil {
		c.FieldsDropped += int64(n)
	}
	return true
}

func cut(s string) (string, string, bool) {
	for i := 0; i < len(s); i++ {
		if s[i] == ' ' {
			return s[:i], s[i+1:], true
		}
	}
	return s, "", false
}

// prune removes from m every key the shape does not allow, at every depth, and returns how many.
func prune(m map[string]any, shape *Shape) int {
	n := 0
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		var child *Shape
		allowed := false
		switch shape.kind {
		case shapeMap:
			child, allowed = shape.elem, tokenRe.MatchString(k) || nameRe.MatchString(k)
		case shapeObject:
			child, allowed = shape.keys[k]
		}
		if !allowed {
			delete(m, k)
			n++
			continue
		}
		v, dropped, ok := pruneValue(m[k], child)
		if !ok {
			delete(m, k)
			n++
			continue
		}
		m[k] = v
		n += dropped
	}
	return n
}

// pruneValue checks v against shape: a scalar where a scalar is allowed, an object or a list
// pruned to its shape. Anything else is refused.
func pruneValue(v any, shape *Shape) (any, int, bool) {
	switch x := v.(type) {
	case nil:
		return nil, 0, true
	case bool, string, float64, int, int64:
		return v, 0, shape.kind == shapeScalar
	case map[string]any:
		if shape.kind != shapeObject && shape.kind != shapeMap {
			return nil, 0, false
		}
		return x, prune(x, shape), true
	case []any:
		if shape.kind != shapeList {
			return nil, 0, false
		}
		out := make([]any, 0, len(x))
		dropped := 0
		for _, item := range x {
			p, d, ok := pruneValue(item, shape.elem)
			if !ok {
				dropped++
				continue
			}
			out = append(out, p)
			dropped += d
		}
		return out, dropped, true
	case []string:
		return x, 0, shape.kind == shapeList && shape.elem.kind == shapeScalar
	}
	return nil, 0, false
}
