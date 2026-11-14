package normalize

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
)

// Ledger normalises .factory/intake/events.jsonl (factory event v2) for one file generation
// (contract 10.1). It also reconstructs capacity.wait_changed from the scheduler's recorded
// decisions (contract 10.6, D16).
type Ledger struct {
	Gen      string
	Root     string
	Identity *Identity

	key     string
	lastSeq int64
	claims  map[string]string // execution -> work.claimed event id
	waiting map[string]int64  // ticket -> the limit it is waiting on
}

// NewLedger makes the normaliser for one generation of the intake log.
func NewLedger(gen, root string, identity *Identity) *Ledger {
	return &Ledger{Gen: gen, Root: root, Identity: identity, key: event.IntakeKey(gen), claims: map[string]string{}, waiting: map[string]int64{}}
}

// Key is the partition key.
func (l *Ledger) Key() string { return l.key }

// The kinds of the intake log (contract 11.1), all 22.
var intakeKinds = map[string]bool{}

func init() {
	for _, k := range event.Kinds[:22] {
		intakeKinds[k] = true
	}
}

type ledgerLine struct {
	SchemaVersion *int64         `json:"schema_version"`
	Seq           *int64         `json:"seq"`
	At            any            `json:"at"`
	Type          any            `json:"type"`
	ProjectID     any            `json:"project_id"`
	WaveID        any            `json:"wave_id"`
	SliceID       any            `json:"slice_id"`
	Revision      any            `json:"revision"`
	TicketID      any            `json:"ticket_id"`
	RunnerID      any            `json:"runner_id"`
	ExecutionID   any            `json:"execution_id"`
	Source        any            `json:"source"`
	Cause         any            `json:"cause"`
	SourceCommit  any            `json:"source_commit"` // the product source commit; kept on execution.started (revision 3)
	Data          map[string]any `json:"data"`
}

// heldSentence is the supervisor's fixed sentence for a capacity hold (supervisor.py schedule).
var heldSentence = regexp.MustCompile(`^all ([0-9]{1,4}) place\(s\) are in use$`)

// Line normalises one line.
func (l *Ledger) Line(line []byte, r Read) []*event.Event {
	// Whoever a line names ("by", an approval's actor) joins the project's people, before any of
	// the line's text is kept: the name is then replaced wherever it appears (redact.People).
	if bytes.Contains(line, []byte(`"by"`)) || bytes.Contains(line, []byte(`"actor"`)) || bytes.Contains(line, []byte(`_by"`)) {
		redact.PeopleFor(l.Root).LearnJSON(line)
	}
	var in ledgerLine
	if err := json.Unmarshal(line, &in); err != nil || in.SchemaVersion == nil || *in.SchemaVersion != 2 || in.Seq == nil || *in.Seq < 1 {
		ev := gapEvent(event.ObserverID("gap", l.key, int(r.Line)), l.key, "unparsable-line", nil, nil, 1, nil, r)
		ev.AnchorKey, ev.AnchorSeq = l.key, l.lastSeq
		return []*event.Event{ev}
	}
	seq := *in.Seq
	var out []*event.Event
	if seq <= l.lastSeq {
		return nil // already seen (a rewrite with the same history); ids would repeat
	}
	if l.lastSeq > 0 && seq > l.lastSeq+1 || l.lastSeq == 0 && seq > 1 {
		from := l.lastSeq + 1
		g := gapEvent(event.ObserverID("gap", l.key+":"+itoa(from)+"-"+itoa(seq-1)), l.key, "missing-seq", from, seq-1, seq-from, nil, r)
		g.AnchorKey, g.AnchorSeq = l.key, l.lastSeq
		out = append(out, g)
	}
	l.lastSeq = seq
	typ, _ := in.Type.(string)
	if !intakeKinds[typ] {
		g := gapEvent(event.ObserverID("gap", l.key+":"+itoa(seq)+":type"), l.key, "unknown-type", seq, seq, 1, nil, r)
		g.AnchorKey, g.AnchorSeq = l.key, seq
		return append(out, g)
	}
	ev := newEvent(typ, event.StreamIntake, l.key, seq, "intake", event.Authoritative)
	ev.ID = event.At(l.key, seq)
	ev.Origin.SourceVersion = IntakeVersion
	if w := enum(in.Source, "intake", "engineer", "supervisor"); w != nil {
		ev.Origin.Writer = w.(string)
	}
	if typ == "station.observed" {
		ev.Authority = event.Observed
	}
	secondTime(ev, in.At, r)
	ids := &ev.IDs
	ids.ProjectID, _ = redact.ID(in.ProjectID)
	ids.WaveID, _ = redact.ID(in.WaveID)
	ids.SliceID, _ = redact.ID(in.SliceID)
	ids.TicketID, _ = Ticket(in.TicketID)
	ids.RunnerID, _ = redact.ID(in.RunnerID)
	ids.ExecutionID, _ = ExecutionID(in.ExecutionID)
	if rev, ok := redact.Int(in.Revision); ok {
		ids.Revision = &rev
	}
	if c, ok := redact.Int(in.Cause); ok && c > 0 {
		ev.Cause = &event.Cause{EventID: event.At(l.key, c), Basis: "recorded"}
	}
	if ids.ProjectID != "" && l.Identity != nil && l.Identity.ProjectID == "" {
		l.Identity.ProjectID = ids.ProjectID
	}
	if ids.ExecutionID != "" && ids.TicketID != "" && l.Identity != nil {
		l.Identity.LearnExecution(ids.ExecutionID, ids.TicketID)
	}
	data := in.Data
	if data == nil {
		data = map[string]any{}
	}
	d, used := l.data(ev, typ, data)
	if typ == "execution.started" {
		d["source_commit"] = fullCommitOrNil(in.SourceCommit) // revision 3: the source revision the execution started from
	}
	if typ == "slice.materialized" {
		// The intake log records no title; the intake ledger does, for the slice's current revision
		// (M6.6 D6). Product prose: scrubbed like every free-text field (redact.FreeTextFields).
		d["title"] = nil
		if l.Identity != nil && ids.Revision != nil {
			if t, rev, ok := l.Identity.SliceTitle(ids.SliceID); ok && rev == *ids.Revision {
				d["title"] = textOrNil(t, l.Root, SliceTitleMax)
			}
		}
	}
	ev.Data = d
	for k := range data {
		if !used[k] {
			ev.Withheld++
		}
	}
	l.refs(ev)
	out = append(out, ev)
	if typ == "scheduling.decided" {
		out = append(out, l.capacity(ev, data, r)...)
	}
	return out
}

func (l *Ledger) refs(ev *event.Event) {
	ids := ev.IDs
	if ids.ProjectID != "" {
		ev.Ref(event.RefProject(ids.ProjectID))
	}
	if ids.WaveID != "" {
		ev.Ref(event.RefWave(ids.WaveID))
	}
	if ids.SliceID != "" {
		ev.Ref(event.RefSlice(ids.SliceID))
	}
	k := 1
	if ids.TicketID != "" {
		if l.Identity != nil {
			k = l.Identity.Current(ids.TicketID)
		}
		ev.Ref(event.CellRef(ids.TicketID, k))
	}
	if ids.ExecutionID != "" {
		ev.Ref(event.RefExecution(ids.ExecutionID))
		if ids.TicketID != "" {
			ev.Parent = event.CellRef(ids.TicketID, k)
		}
	}
	switch ev.Origin.Writer {
	case "supervisor":
		ev.Ref(event.RefActor("supervisor"))
	case "engineer":
		ev.Ref(event.RefActor("engineer"))
	}
	if ev.Type == "scheduling.decided" {
		ev.Ref(event.RefActor("scheduler"))
	}
	if ids.SliceID != "" {
		for _, key := range []string{"dependencies", "depends_on"} {
			for _, dep := range arr(ev.Data[key]) {
				ev.Ref(event.RefDependency(ids.SliceID, dep.(string)))
			}
		}
	}
}

// byRole replaces a person's name with a role (D15).
func byRole(writer string, allowed ...string) string {
	for _, a := range allowed {
		if a == writer {
			return writer
		}
	}
	return "person"
}

// data builds each kind's allow-listed payload (schema $defs). used names the source keys read.
func (l *Ledger) data(ev *event.Event, typ string, in map[string]any) (map[string]any, map[string]bool) {
	d := map[string]any{}
	used := map[string]bool{}
	get := func(k string) any { used[k] = true; return in[k] }
	root := l.Root
	switch typ {
	case "wave.discovered":
		d["slices"] = idList(get("slices"), 200)
		ap := obj(get("approval"))
		var at any
		if ms, _, ok := parseTime(ap["approved_at"]); ok {
			at = stampMS(ms)
		}
		d["approval"] = map[string]any{"approved_at": at, "by_role": "person"}
	case "intake.validated":
		require(ev, d, "digest", nullStr(redact.Digest(get("digest"))), "")
	case "intake.refused":
		d["problems"] = textList(get("problems"), root, 32, 280)
	case "slice.materialized":
		require(ev, d, "digest", nullStr(redact.Digest(get("digest"))), "")
		require(ev, d, "adopted", boolOrNil(get("adopted")), false)
		d["dependencies"] = idList(get("dependencies"), 64)
		d["reissued"] = boolOrNil(get("reissued"))
	case "slice.integrated":
		require(ev, d, "commit", commitOrNil(get("commit")), "0000000")
	case "dependency.resolved":
		d["depends_on"] = idList(get("depends_on"), 64)
	case "dependency.blocked":
		d["reasons"] = textList(get("reasons"), root, 16, 280)
	case "work.scheduled":
		d["stage"] = stage(get("stage"))
		d["risk"] = enum(get("risk"), risks...)
		branch, ok := redact.RelPath(get("branch"))
		require(ev, d, "branch", nullStr(branch, ok), "")
		get("by")
		d["by_role"] = byRole(ev.Origin.Writer, "engineer", "supervisor")
		d["authorization"] = textOrNil(get("authorization"), root, 280)
	case "revision.superseded":
		d["from_revision"] = intOrNil(get("from_revision"))
		require(ev, d, "effect", textOrNil(get("effect"), root, 280), "")
	case "human.required":
		require(ev, d, "reason", textOrNil(get("reason"), root, 280), "")
	case "factory.activated":
		require(ev, d, "autonomy", enum(get("autonomy"), "observe", "supervised"), "observe")
		get("by")
		d["by_role"] = byRole(ev.Origin.Writer, "engineer")
		limits := map[string]any{}
		for k, v := range obj(get("limits")) {
			if name, ok := redact.Token(k); ok && len(limits) < 32 {
				if n, ok := redact.Number(v); ok {
					limits[name] = n
				}
			}
		}
		d["limits"] = limits
		require(ev, d, "allow_merge", boolOrNil(get("allow_merge")), false)
		require(ev, d, "persistent", boolOrNil(get("persistent")), false)
		d["backlog"] = tokOrNil(get("backlog"))
		d["excluded_slices"] = idList(get("excluded_slices"), 200)
	case "factory.disabled":
		get("by")
		d["by_role"] = byRole(ev.Origin.Writer, "engineer")
		d["stopped"] = boolOr(get("stopped"), false)
	case "factory.paused":
		get("by")
		d["by_role"] = byRole(ev.Origin.Writer, "engineer")
		d["reason"] = textOrNil(get("reason"), root, 280)
	case "factory.resumed":
		get("by")
		d["by_role"] = byRole(ev.Origin.Writer, "engineer")
		d["retrying"] = idList(get("retrying"), 64)
	case "revision.discovered":
		d["from_commit"] = commitOrNil(get("from_commit"))
		require(ev, d, "commit", commitOrNil(get("commit")), "0000000")
	case "scheduling.decided":
		require(ev, d, "state", enum(get("state"), "supervised", "observe", "paused"), "observe")
		d["dispatched"] = idList(get("dispatched"), 64)
		d["started"] = idList(get("started"), 64)
		held := []any{}
		for _, item := range arr(get("held")) {
			h := obj(item)
			if h == nil || len(held) >= 64 {
				continue
			}
			why, _ := redact.Text(h["why"], root, 280)
			held = append(held, map[string]any{"slice_id": idOrNil(h["slice_id"]), "ticket_id": idOrNil(h["ticket_id"]), "why": why})
		}
		d["held"] = held
	case "work.claimed":
		d["stage"] = stage(get("stage"))
		d["next"] = action(get("next"))
		a := intOrNil(get("attempt"))
		require(ev, d, "attempt", a, int64(0))
		if n, ok := a.(int64); ok && n >= 1 {
			ev.IDs.Attempt = n
		}
		if ev.IDs.ExecutionID != "" {
			l.claims[ev.IDs.ExecutionID] = ev.ID
		}
	case "execution.started":
		d["until"] = tokOrNil(get("until"))
		wf, ok := redact.Name(get("workflow"))
		require(ev, d, "workflow", nullStr(wf, ok), "")
		lim := obj(get("limits"))
		minutes, budget := numOrNil(lim["minutes"]), numOrNil(lim["budget_usd"])
		if minutes == nil {
			minutes = float64(0)
			ev.AddUnknown("data.limits.minutes")
		}
		if budget == nil {
			budget = float64(0)
			ev.AddUnknown("data.limits.budget_usd")
		}
		d["limits"] = map[string]any{"minutes": minutes, "budget_usd": budget}
		get("session_id")
		_, present := in["provenance"] // revision 3: the snapshot taken at start; absent before M6.5
		d["provenance"], d["provenance_reason"] = provenance(get("provenance"), present, get("provenance_reason"))
		if claim, ok := l.claims[ev.IDs.ExecutionID]; ok {
			ev.Cause = &event.Cause{EventID: claim, Basis: "identity"}
		}
	case "station.observed":
		d["from_stage"] = stage(get("from_stage"))
		require(ev, d, "stage", stage(get("stage")), "planned")
	case "recovery.started":
		require(ev, d, "kind", enum(get("kind"), "ended-while-unwatched", "still-running", "claim-never-started", "outcome-unknown", "took-over-from-dead-supervisor"), "outcome-unknown")
	case "execution.completed":
		d["stage"] = stage(get("stage"))
		d["next"] = action(get("next"))
		d["waiting_for"] = textOrNil(get("waiting_for"), root, 200)
		d["how"] = tokOrNil(get("how"))
		d["seen_to_end"] = boolOr(get("seen_to_end"), false)
		d["cost_usd"] = numOrNil(get("cost_usd"))
		tools := []any{}
		for _, t := range arr(get("refused_tools")) {
			if s, ok := t.(string); ok && len(tools) < 32 {
				tools = append(tools, redact.Scrub(clip(s, 60), root))
			}
		}
		d["refused_tools"] = oneRefusalPerTool(tools)
	case "execution.failed":
		d["stage"] = stage(get("stage"))
		d["next"] = action(get("next"))
		d["how"] = tokOrNil(get("how"))
		d["claude_error"] = tokOrNil(get("claude_error"))
		d["exit_code"] = intOrNil(get("exit_code"))
		a := intOrNil(get("attempt"))
		require(ev, d, "attempt", a, int64(0))
		if n, ok := a.(int64); ok && n >= 1 {
			ev.IDs.Attempt = n
		}
	}
	return d, used
}

// capacity reconstructs capacity.wait_changed from a scheduling decision: a ticket held with the
// supervisor's fixed sentence is waiting; one that was waiting and is no longer held for that
// reason is released. Silence is never read as waiting (D16).
func (l *Ledger) capacity(basis *event.Event, raw map[string]any, r Read) []*event.Event {
	now := map[string]int64{}
	for _, item := range arr(raw["held"]) {
		h := obj(item)
		t, ok := Ticket(h["ticket_id"])
		why, _ := h["why"].(string)
		if m := heldSentence.FindStringSubmatch(why); ok && m != nil {
			n, _ := strconv.ParseInt(m[1], 10, 64)
			now[t] = n
		}
	}
	var tickets []string
	for t := range now {
		if _, was := l.waiting[t]; !was {
			tickets = append(tickets, t)
		}
	}
	for t := range l.waiting {
		if _, still := now[t]; !still {
			tickets = append(tickets, t)
		}
	}
	sortStrings(tickets)
	var out []*event.Event
	for i, t := range tickets {
		state, limit := "waiting", now[t]
		if _, still := now[t]; !still {
			state, limit = "released", l.waiting[t]
		}
		ev := observerEvent("capacity.wait_changed", event.ObserverID("capacity", basis.ID, i), "held-sentence", []string{basis.ID}, []string{".factory/intake/events.jsonl"})
		copyTime(ev, basis)
		p := i
		ev.Origin.Part = &p
		ev.IDs.TicketID = t
		ev.IDs.ProjectID = basis.IDs.ProjectID
		ev.Infer("data.state", "held-sentence")
		var lim any
		if limit > 0 {
			lim = limit
		}
		ev.Data = map[string]any{"state": state, "scope": "execution", "limit": lim}
		k := 1
		if l.Identity != nil {
			k = l.Identity.Current(t)
		}
		ev.Ref(event.CellRef(t, k), event.RefActor("scheduler"))
		out = append(out, ev)
	}
	l.waiting = now
	return out
}

// oneRefusalPerTool drops a bare tool name ("Bash") when the same list also names that tool with
// its detail ("Bash: git"). MACH reads a refusal twice, once from the stream's permission_denied
// notice (no input, so the bare name) and once from the result's permission_denials (with the
// command), and records the set of both; served as two refusals, one denial reads as two.
func oneRefusalPerTool(tools []any) []any {
	detailed := map[string]bool{}
	for _, t := range tools {
		if s, _ := t.(string); strings.Contains(s, ": ") {
			detailed[s[:strings.Index(s, ": ")]] = true
		}
	}
	out := []any{}
	for _, t := range tools {
		if s, _ := t.(string); !detailed[s] {
			out = append(out, t)
		}
	}
	return out
}
