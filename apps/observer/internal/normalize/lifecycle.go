package normalize

import (
	"encoding/json"
	"regexp"
	"strings"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
)

// Lifecycle normalises one generation of a cell's lifecycle.jsonl (contract 10.2), live or from
// the cell's archive: the ids depend only on the ticket, the file's generation and the physical
// line, so the live file and its archived copy give the same ids.
//
// It also reconstructs, from the cell's own files (Files), what the contract derives at each
// record (10.6): verify.targets_listed at a verify entry, review.finding from a verdict's vote
// file, artifact.recorded for the artifacts an authoritative record names.
type Lifecycle struct {
	Ticket   string
	Gen      string
	Root     string
	Identity *Identity
	Files    Files                        // the cell's files; nil when none can be read
	Holdouts func(ticket string) []string // holdout check ids for a ticket; nil for none

	key      string
	k        int
	lastSeq  int64
	lastAt   int64
	visits   map[string]*visit // open visit id -> entry
	rounds   map[int64]map[string]string
	started  map[int64]string // round -> review.round_started event id
	stage    string           // the stage the log implies (the last record that carried one)
	lastLine int64
}

type visit struct {
	enteredMS int64
	eventID   string
	items     map[string]bool
}

// NewLifecycle makes the normaliser for one lifecycle file generation.
func NewLifecycle(ticket, gen, root string, identity *Identity) *Lifecycle {
	return &Lifecycle{Ticket: ticket, Gen: gen, Root: root, Identity: identity, key: event.CellKey(ticket, gen),
		visits: map[string]*visit{}, rounds: map[int64]map[string]string{}, started: map[int64]string{}}
}

// Key is the partition key.
func (l *Lifecycle) Key() string { return l.key }

// ImpliedStage is the stage the log implies, and the last line read.
func (l *Lifecycle) ImpliedStage() (string, int64) { return l.stage, l.lastLine }

var (
	visitRe        = regexp.MustCompile(`^(groom|plan|audit|build|verify|review|human-approval|merge|cleanup)#([1-9][0-9]{0,5})$`)
	gateRe         = regexp.MustCompile(`^[a-z][a-z-]*(?:\.[a-z][a-z-]*)?$`)
	taskRe         = regexp.MustCompile(`^(?:R\d+-)?T\d+$`)
	ruleIDRe       = regexp.MustCompile(`\b(?:(?:FR|INV|AC)-\d{2,}|R\d{1,3})\b`)
	lifecycleKinds = map[string]bool{}
)

func init() {
	for _, k := range event.Kinds[22:33] {
		lifecycleKinds[k] = true
	}
}

// scriptOf names the station script that writes a station's records.
func scriptOf(station string) string {
	switch station {
	case "audit":
		return "audit.py"
	case "groom", "plan":
		return "cell.py"
	case "build":
		return "build.py"
	case "verify":
		return "verify.py"
	case "review", "human-approval":
		return "review.py"
	case "merge":
		return "merge.py"
	case "cleanup":
		return "cleanup.py"
	}
	return ""
}

func (l *Lifecycle) cellName() string { return event.CellName(l.Ticket, l.k) }

type lifecycleLine struct {
	V           any            `json:"v"`
	Seq         any            `json:"seq"`
	At          any            `json:"at"`
	TicketID    any            `json:"ticket_id"`
	Type        any            `json:"type"`
	Station     any            `json:"station"`
	Visit       any            `json:"visit"`
	Round       any            `json:"round"`
	Attempt     any            `json:"attempt"`
	ExecutionID any            `json:"execution_id"`
	Data        map[string]any `json:"data"`
}

// Line normalises one physical line.
func (l *Lifecycle) Line(line []byte, r Read) []*event.Event {
	l.lastLine = r.Line
	var in lifecycleLine
	err := json.Unmarshal(line, &in)
	if v, ok := redact.Int(in.V); err != nil || !ok || v != 1 {
		return []*event.Event{l.gap("line-"+itoa(r.Line), "unparsable-line", r.Line, r.Line, 1, r)}
	}
	at, _, okAt := parseTime(in.At)
	if r.Line == 1 && l.Identity != nil {
		l.Identity.LearnIncarnation(l.Ticket, l.Gen, at)
	}
	if l.Identity != nil {
		l.k = l.Identity.Incarnation(l.Ticket, l.Gen)
	}
	var out []*event.Event
	if in.Seq != nil {
		if s, ok := redact.Int(in.Seq); ok && s >= 1 {
			if l.lastSeq > 0 && s > l.lastSeq+1 {
				out = append(out, l.gap("seq-"+itoa(l.lastSeq+1)+"-"+itoa(s-1), "missing-seq", l.lastSeq+1, s-1, s-l.lastSeq-1, r))
			}
			if s > l.lastSeq {
				l.lastSeq = s
			}
		}
	}
	ticket, okT := Ticket(in.TicketID)
	typ, _ := in.Type.(string)
	station, _ := in.Station.(string)
	vm := visitRe.FindStringSubmatch(strOf(in.Visit))
	if !okT || ticket != l.Ticket || vm == nil || vm[1] != station || !okAt {
		return append(out, l.gap("line-"+itoa(r.Line), "unparsable-line", r.Line, r.Line, 1, r))
	}
	if !lifecycleKinds[typ] {
		return append(out, l.gap("type-"+itoa(r.Line), "unknown-type", r.Line, r.Line, 1, r))
	}
	writer := "station"
	if station == "cleanup" {
		writer = "cleanup"
	}
	ev := newEvent(typ, event.StreamLifecycle, l.key, r.Line, writer, event.Authoritative)
	ev.ID = event.At(l.key, r.Line)
	ev.Origin.Script = scriptOf(station)
	ev.Origin.SourceVersion = LifecycleVersion
	msTime(ev, at, r)
	l.lastAt = at
	ids := &ev.IDs
	ids.TicketID = ticket
	ids.CellInstance = l.Gen
	ids.Station = station
	ids.VisitID = l.cellName() + "/" + vm[0]
	round := in.Round
	if round == nil {
		round = in.Attempt // a file written before the field was renamed (decision 2)
	}
	if n, ok := redact.Int(round); ok && n >= 1 {
		ids.Round = n
	}
	if x, ok := ExecutionID(in.ExecutionID); ok {
		ids.ExecutionID = x
	} else {
		ev.AddUnknown("ids.execution_id")
	}
	if l.Identity != nil {
		p := l.Identity.ProductOf(ticket)
		ids.SliceID, ids.WaveID, ids.Revision, ids.ProjectID = p.SliceID, p.WaveID, p.Revision, l.Identity.ProjectID
	}
	cell := event.CellRef(ticket, l.k)
	visitRef := "visit:" + ids.VisitID
	ev.Ref(cell, "station:"+l.cellName()+"/"+station, visitRef)
	if ids.ExecutionID != "" {
		ev.Ref(event.RefExecution(ids.ExecutionID))
	}
	if ids.SliceID != "" {
		ev.Ref(event.RefSlice(ids.SliceID))
	}
	if typ == "station.entered" || typ == "station.exited" {
		if ids.ExecutionID != "" {
			ev.Parent = event.RefExecution(ids.ExecutionID)
		}
	} else {
		ev.Parent = visitRef
	}
	data := in.Data
	if data == nil {
		data = map[string]any{}
	}
	used := map[string]bool{}
	ev.Data = l.data(ev, typ, station, data, used, at)
	for k := range data {
		if !used[k] {
			ev.Withheld++
		}
	}
	if s, ok := ev.Data["stage"].(string); ok && (typ == "station.entered" || typ == "station.exited") {
		l.stage = s
	}
	out = append(out, ev)
	out = append(out, l.reconstruct(ev, data, r)...)
	return out
}

func strOf(v any) string {
	s, _ := v.(string)
	return s
}

func (l *Lifecycle) gap(detail, reason string, from, to, count int64, r Read) *event.Event {
	g := gapEvent(event.ObserverID("gap", l.key+":"+detail), l.key, reason, from, to, count, nil, r)
	g.AnchorKey, g.AnchorSeq = l.key, from
	g.IDs.TicketID, g.IDs.CellInstance = l.Ticket, l.Gen
	g.Ref(event.CellRef(l.Ticket, l.k))
	return g
}

// counts keeps a record's other integer and boolean facts (contract 10.2, "counts").
var countKey = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

func counts(data map[string]any, used map[string]bool) map[string]any {
	out := map[string]any{}
	for k, v := range data {
		if used[k] || !countKey.MatchString(k) || len(out) >= 32 {
			continue
		}
		switch x := v.(type) {
		case bool:
			out[k] = x
			used[k] = true
		case float64:
			if n, ok := redact.Int(x); ok {
				out[k] = n
				used[k] = true
			}
		}
	}
	return out
}

func stationAction(station string) any {
	switch station {
	case "audit", "groom", "plan", "build", "verify", "review", "merge", "cleanup":
		return station
	}
	return nil
}

func (l *Lifecycle) data(ev *event.Event, typ, station string, in map[string]any, used map[string]bool, at int64) map[string]any {
	get := func(k string) any { used[k] = true; return in[k] }
	d := map[string]any{}
	vid := ev.IDs.VisitID
	switch typ {
	case "station.entered":
		d["station"] = station
		d["stage"] = stage(get("stage"))
		if _, rev := in["revision"]; rev {
			get("revision")
			d["action"] = "revise"
		} else {
			d["action"] = stationAction(station)
		}
		d["resumed"] = boolOr(get("resumed"), false)
		uv := get("unclosed_visit")
		if s, ok := uv.(string); ok && visitRe.MatchString(s) {
			d["unclosed_visit"] = s
		} else {
			d["unclosed_visit"] = nil
		}
		d["head"] = commitOrNil(get("head"))
		get("round")
		d["counts"] = counts(in, used)
		l.visits[vid] = &visit{enteredMS: at, eventID: ev.ID, items: map[string]bool{}}
	case "station.exited":
		d["station"] = station
		out, ok := redact.Label(get("outcome"))
		require(ev, d, "outcome", nullStr(out, ok), "unknown")
		d["stage"] = stage(get("stage"))
		if v := l.visits[vid]; v != nil {
			d["duration_ms"] = at - v.enteredMS
			ev.Cause = &event.Cause{EventID: v.eventID, Basis: "identity"}
			delete(l.visits, vid)
		} else {
			d["duration_ms"] = nil
			ev.AddUnknown("data.duration_ms")
		}
		d["closed_by"] = enum(get("closed_by"), "cleanup")
		d["head"] = commitOrNil(get("head"))
		get("round")
		d["counts"] = counts(in, used)
	case "gate.evaluated":
		gate, _ := get("gate").(string)
		if !gateRe.MatchString(gate) || len(gate) > 60 {
			d["gate"] = station
			ev.AddUnknown("data.gate")
		} else {
			d["gate"] = gate
		}
		verdict := map[string]string{"pass": "passed", "refuse": "refused", "override": "overridden"}[strOf(get("outcome"))]
		require(ev, d, "verdict", nullStr(verdict, verdict != ""), "refused")
		reason, okR := redact.Label(get("reason_code"))
		if !okR {
			reason, okR = redact.Token(in["reason_code"])
		}
		d["reason_code"] = nullStr(reason, okR)
		get("overridden_by_reason")
		var subject any
		for _, k := range []string{"task", "item", "seat"} {
			if s, ok := redact.ID(get(k)); ok && len(s) <= 60 && subject == nil {
				subject = s
			}
		}
		d["subject"] = subject
		d["status"] = nil
		if gate == "verify.verdict" {
			d["status"] = enum(reason, "PASS", "FAIL_WITH_EVIDENCE")
		} else if gate == "verify.finish" && verdict == "refused" && reason == "incomplete-evidence" {
			d["status"] = "INCOMPLETE_EVIDENCE"
		}
		tier, okTier := redact.Label(get("audit_tier"))
		if len(tier) > 20 {
			okTier = false
		}
		d["audit_tier"] = nullStr(tier, okTier)
		d["counts"] = counts(in, used)
		if s, ok := subject.(string); ok && strings.Contains(gate, "review") {
			if seat := enum(s, seats...); seat != nil {
				ev.IDs.Seat = s
			}
		}
		ref := "gate:" + l.cellName() + "/" + event.Enc(d["gate"].(string))
		if ev.IDs.Round > 0 {
			ref += "#" + itoa(ev.IDs.Round)
		}
		ev.Ref(ref)
	case "build.task_completed":
		task, _ := get("task").(string)
		if !taskRe.MatchString(task) {
			task = "T0"
			ev.AddUnknown("data.task_id")
		}
		d["task_id"] = task
		require(ev, d, "kind", enum(get("kind"), "test", "impl", "contract", "refactor", "docs"), "impl")
		require(ev, d, "step", enum(get("step"), "red", "green", "done"), "done")
		d["first_run"] = enum(get("first_run"), "pass", "fail", "not-run")
		d["suite"] = enum(get("suite"), "unknown", "red", "green")
		d["commit"] = commitOrNil(get("commit"))
		if c, ok := d["commit"].(string); ok {
			ref := "artifact:" + l.cellName() + ":commit/" + c
			ev.Artifacts = append(ev.Artifacts, event.Artifact{Ref: ref, Commit: c})
			ev.Ref(ref)
		}
	case "verify.check_recorded":
		target, ok := redact.ID(get("item"))
		if !ok || len(target) > 40 {
			target = "unknown"
			ev.AddUnknown("data.target_id")
		}
		d["target_id"] = target
		kind := enum(get("kind"), "scenario", "matrix rule", "holdout")
		if kind == nil {
			kind = targetKindOf(target)
			ev.Infer("data.target_kind", "label")
		}
		d["target_kind"] = kind
		require(ev, d, "result", enum(get("result"), "pass", "fail"), "fail")
		evidence := []any{}
		for _, item := range arr(get("evidence")) {
			e := obj(item)
			p, okP := redact.RelPath(e["path"])
			sum, okS := redact.Commit(e["sha256"])
			if !okP || !okS || len(evidence) >= 64 {
				continue
			}
			var size any
			if l.Files != nil {
				if _, n, ok := l.Files.Hash(p); ok {
					size = n
				}
			}
			evidence = append(evidence, map[string]any{"file": p, "sha256": sum, "bytes": size})
			ref := "artifact:" + l.cellName() + ":" + p + "@" + sum[:min(12, len(sum))]
			ev.Artifacts = append(ev.Artifacts, event.Artifact{Ref: ref, SHA256: sum})
			ev.Ref(ref)
		}
		d["evidence"] = evidence
		v := l.visits[ev.IDs.VisitID]
		d["rerecorded"] = v != nil && v.items[target]
		if v != nil {
			v.items[target] = true
		}
	case "review.round_started":
		require(ev, d, "risk", enum(get("risk"), risks...), "Medium")
		require(ev, d, "max_rounds", intOrNil(get("max_rounds")), int64(3))
		d["tuning"] = boolOr(get("tuning"), false)
		require(ev, d, "approvals_needed", intOrNil(get("approvals_needed")), int64(0))
		d["human_approval_required"] = boolOr(get("human_approval_required"), false)
		models := obj(get("models"))
		panel := []any{}
		m := map[string]string{}
		for _, s := range arr(get("seats")) {
			seat, ok := enum(s, seats...).(string)
			if !ok {
				continue
			}
			model, okM := redact.Name(models[seat])
			m[seat] = model
			panel = append(panel, map[string]any{"seat": seat, "model": nullStr(model, okM)})
		}
		d["panel"] = panel
		d["delta"] = boolOr(get("delta"), false)
		get("round")
		r := ev.IDs.Round
		_, again := l.started[r]
		d["restarted"] = again
		l.rounds[r] = m
		l.started[r] = ev.ID
		gate := "gate:" + l.cellName() + "/review#" + itoa(r)
		ev.Ref(gate)
		for _, p := range panel {
			ev.Ref("seat:" + l.cellName() + "/review#" + itoa(r) + "/" + p.(map[string]any)["seat"].(string))
		}
	case "review.verdict_submitted":
		seat := enum(get("seat"), seats...)
		require(ev, d, "seat", seat, "general")
		if s, ok := seat.(string); ok {
			ev.IDs.Seat = s
			ev.Ref("seat:" + l.cellName() + "/review#" + itoa(ev.IDs.Round) + "/" + s)
		} else {
			ev.IDs.Seat = "general"
		}
		require(ev, d, "vote", vote(get("vote")), "REJECT")
		require(ev, d, "blockers", intOrNil(get("blockers")), int64(0))
		require(ev, d, "notes", intOrNil(get("notes")), int64(0))
		rules := []any{}
		for _, rule := range arr(get("rules")) {
			if s, ok := rule.(string); ok && ruleIDRe.MatchString(s) && len(s) <= 12 && len(rules) < 50 {
				rules = append(rules, s)
			}
		}
		d["rules"] = rules
		get("round")
		var model any
		if s, ok := seat.(string); ok {
			if m := l.rounds[ev.IDs.Round][s]; m != "" {
				model = m
			}
		}
		d["model"] = model
	case "review.decided":
		require(ev, d, "outcome", enum(get("decision"), "APPROVED", "AWAITING_HUMAN", "REJECTED", "ESCALATE"), "REJECTED")
		require(ev, d, "approvals", intOrNil(get("approvals")), int64(0))
		require(ev, d, "approvals_needed", intOrNil(get("needed")), int64(0))
		votes := map[string]any{}
		for k, v := range obj(get("votes")) {
			if seat := enum(k, seats...); seat != nil {
				if vv := vote(v); vv != nil {
					votes[k] = vv
				}
			}
		}
		d["votes"] = votes
		require(ev, d, "blockers", intOrNil(get("blockers")), int64(0))
		d["security_veto"] = boolOr(get("security_veto"), false)
		d["human_approval_required"] = boolOr(get("human_approval_required"), false)
		get("round")
		if id, ok := l.started[ev.IDs.Round]; ok {
			ev.Cause = &event.Cause{EventID: id, Basis: "identity"}
		}
		ev.Ref("gate:" + l.cellName() + "/review#" + itoa(ev.IDs.Round))
	case "human.approval_recorded":
		d["by_role"] = "person"
		d["note_given"] = boolOr(get("note_given"), false)
		get("round")
		get("decision")
		ev.Ref(event.RefActor("person"))
	case "merge.completed":
		require(ev, d, "method", enum(get("method"), "local", "pr"), "local")
		for _, k := range []string{"merge_commit", "approved_commit", "landed_commit"} {
			d[k] = commitOrNil(get(k))
		}
		d["revalidated"] = boolOr(get("revalidated"), false)
		d["pull_request"] = intOrNil(get("pull_request"))
		if c, ok := d["merge_commit"].(string); ok {
			ref := "artifact:" + l.cellName() + ":commit/" + c
			ev.Artifacts = append(ev.Artifacts, event.Artifact{Ref: ref, Commit: c})
			ev.Ref(ref)
		}
	case "cleanup.completed":
		require(ev, d, "outcome", enum(get("outcome"), "merged", "abandoned"), "merged")
		archive, ok := redact.RelPath(get("archive"))
		if len(archive) > 200 {
			ok = false
		}
		d["archive"] = nullStr(archive, ok)
		d["bundle"] = boolOr(get("bundle"), false)
		d["uncommitted_saved"] = boolOr(get("uncommitted_saved"), false)
	}
	return d
}

func vote(v any) any {
	s, _ := v.(string)
	return enum(strings.ToUpper(s), "APPROVE", "REJECT")
}

func targetKindOf(id string) string {
	switch {
	case strings.HasPrefix(id, "H-"):
		return "holdout"
	case regexp.MustCompile(`^R\d+$`).MatchString(id):
		return "matrix rule"
	}
	return "scenario"
}
