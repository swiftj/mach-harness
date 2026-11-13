package synth

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"time"

	"mach/observer/internal/testkit"
)

// StateFile is written next to .factory in a generated project: what --append needs to continue
// the history's open execution. It is not a Factory file and the observer never reads it.
const StateFile = "synth-state.json"

// SummaryFile holds the generation summary, beside StateFile.
const SummaryFile = "synth-summary.json"

// State is the live edge of a generated history: the execution still running at its end.
type State struct {
	IntakeSeq int         `json:"intake_seq"`
	Ticket    string      `json:"ticket"`
	Slice     string      `json:"slice"`
	Wave      string      `json:"wave"`
	Revision  int         `json:"revision"`
	Execution string      `json:"execution"`
	TaskID    string      `json:"task_id"`
	ToolUse   string      `json:"tool_use"`
	Session   string      `json:"session"`
	NextIndex int         `json:"next_index"`
	Agents    []OpenAgent `json:"agents"`
	LifeSeq   int         `json:"lifecycle_seq"`
	Visit     int         `json:"visit"`
	Round     int         `json:"round"`
	Head      string      `json:"head"`
	WFStartMS int64       `json:"workflow_started_ms"`
	ToolSeq   int         `json:"tool_seq"`
	Appended  int         `json:"appended_events"`
}

// OpenAgent is a workflow agent still running.
type OpenAgent struct {
	Index     int    `json:"index"`
	Label     string `json:"label"`
	ID        string `json:"id"`
	Phase     int    `json:"phase"`
	AgentType string `json:"agent_type,omitempty"`
	Model     string `json:"model"`
	QueuedMS  int64  `json:"queued_ms"`
	StartMS   int64  `json:"start_ms"`
	Tokens    int64  `json:"tokens"`
	Calls     int64  `json:"calls"`
	Filler    bool   `json:"filler,omitempty"`
}

func (g *gen) recordOpen(s *streamGen) {
	x := s.x
	st := g.state
	st.Ticket, st.Slice, st.Wave, st.Revision = x.cell.ticket, x.cell.slice.id, x.cell.slice.wave.id, x.cell.slice.rev
	st.Execution, st.TaskID, st.ToolUse, st.Session = x.id, x.taskID, x.toolUse, x.session
	st.NextIndex = x.nextIndex + 1
	st.WFStartMS = g.w.ms(x.wfStart)
	st.ToolSeq = g.w.toolSeq + 1
	st.Head = x.cell.head
	st.Agents = nil
	for _, a := range s.agents {
		if a.status == "done" && a.end <= s.cut {
			continue
		}
		st.Agents = append(st.Agents, OpenAgent{Index: a.index, Label: a.label, ID: a.id, Phase: a.phase, AgentType: a.agentType, Model: a.model,
			QueuedMS: g.w.ms(a.queued), StartMS: g.w.ms(a.start), Tokens: a.tokens, Calls: a.calls})
	}
}

func (g *gen) writeState() error {
	if g.state.Execution == "" {
		return nil
	}
	data, _ := json.MarshalIndent(g.state, "", "  ")
	return os.WriteFile(filepath.Join(g.root, StateFile), append(data, '\n'), 0o644)
}

// AppendOptions say how to extend a generated project live.
type AppendOptions struct {
	Out      string
	Rate     int           // events per second
	Duration time.Duration // 0: until stop is closed
	Seed     uint64
	Now      func() time.Time
}

// AppendSummary says what was appended.
type AppendSummary struct {
	Events    int            `json:"events"`
	ByType    map[string]int `json:"events_by_type"`
	Seconds   float64        `json:"seconds"`
	Rate      float64        `json:"rate_achieved"`
	Late      int            `json:"late_lines"`
	Arrival   int            `json:"arrival_only_records"`
	Ticket    string         `json:"ticket"`
	Execution string         `json:"execution"`
}

type appender struct {
	o     AppendOptions
	st    *State
	rng   *rand.Rand
	sum   *AppendSummary
	files map[string]*os.File
}

// Append continues the generated history's open execution at the given rate: workflow agents'
// progress (timestamped now), new agents queued and started, main-loop tool calls with no
// timestamp (placed by arrival), the open build visit's gate evaluations, every half minute a late
// batch of lifecycle lines stamped ten minutes ago, and the supervisor's passes in the intake log.
func Append(o AppendOptions, stop <-chan struct{}) (*AppendSummary, error) {
	if o.Rate < 1 {
		o.Rate = 200
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	raw, err := os.ReadFile(filepath.Join(o.Out, StateFile))
	if err != nil {
		return nil, fmt.Errorf("not a generated project with an open execution (%s): %w", StateFile, err)
	}
	st := &State{}
	if err := json.Unmarshal(raw, st); err != nil {
		return nil, err
	}
	a := &appender{o: o, st: st, rng: rand.New(rand.NewPCG(o.Seed^uint64(st.Appended), 0x617070)), files: map[string]*os.File{},
		sum: &AppendSummary{ByType: map[string]int{}, Ticket: st.Ticket, Execution: st.Execution}}
	defer func() {
		for _, f := range a.files {
			f.Close()
		}
	}()
	began := o.Now()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	var deadline <-chan time.Time
	if o.Duration > 0 {
		deadline = time.After(o.Duration)
	}
	owed := 0.0
	last := began
	ticks := 0
loop:
	for {
		select {
		case <-stop:
			break loop
		case <-deadline:
			break loop
		case <-tick.C:
		}
		now := o.Now()
		owed += now.Sub(last).Seconds() * float64(o.Rate)
		last = now
		ticks++
		n := int(owed)
		owed -= float64(n)
		if err := a.tick(now, n, ticks); err != nil {
			return a.sum, err
		}
	}
	a.sum.Seconds = math.Round(o.Now().Sub(began).Seconds()*100) / 100
	if a.sum.Seconds > 0 {
		a.sum.Rate = math.Round(float64(a.sum.Events)/a.sum.Seconds*10) / 10
	}
	st.Appended += a.sum.Events
	data, _ := json.MarshalIndent(st, "", "  ")
	return a.sum, os.WriteFile(filepath.Join(o.Out, StateFile), append(data, '\n'), 0o644)
}

func (a *appender) file(rel string) (*os.File, error) {
	if f := a.files[rel]; f != nil {
		return f, nil
	}
	f, err := os.OpenFile(filepath.Join(a.o.Out, filepath.FromSlash(rel)), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	a.files[rel] = f
	return f, nil
}

func (a *appender) put(rel string, lines ...[]byte) error {
	f, err := a.file(rel)
	if err != nil {
		return err
	}
	var buf []byte
	for _, l := range lines {
		buf = append(buf, l...)
		if len(l) == 0 || l[len(l)-1] != '\n' {
			buf = append(buf, '\n')
		}
	}
	_, err = f.Write(buf)
	return err
}

func (a *appender) count(typ string, n int) {
	a.sum.Events += n
	a.sum.ByType[typ] += n
}

func (a *appender) stream() string {
	return ".factory/local/executions/" + a.st.Execution + "/stream.jsonl"
}

func (a *appender) tick(now time.Time, budget, ticks int) error {
	st := a.st
	ms := now.UnixMilli()
	// Every two seconds a new agent joins and, when many run, the oldest helper finishes.
	if ticks%20 == 1 {
		ag := OpenAgent{Index: st.NextIndex, Label: fillerLabels[a.rng.IntN(len(fillerLabels))], ID: fmt.Sprintf("a%016x", a.rng.Uint64()), Phase: 3,
			Model: "claude-haiku-5-5", QueuedMS: ms - int64(a.rng.IntN(3000)), StartMS: ms, Filler: true}
		st.NextIndex++
		st.Agents = append(st.Agents, ag)
		if err := a.snapshot(ms, []map[string]any{a.agentObj(ag, "queued", ag.QueuedMS)}); err != nil {
			return err
		}
		if err := a.snapshot(ms, []map[string]any{a.agentObj(ag, "start", ms)}); err != nil {
			return err
		}
		a.count("agent.queued", 1)
		a.count("agent.started", 1)
		budget -= 2
		if len(st.Agents) > 10 {
			for i, old := range st.Agents {
				if old.Filler {
					old.Tokens += 100
					obj := a.agentObj(old, "done", ms)
					obj["durationMs"] = ms - old.StartMS
					if err := a.snapshot(ms, []map[string]any{obj}); err != nil {
						return err
					}
					a.count("agent.finished", 1)
					budget--
					st.Agents = append(st.Agents[:i], st.Agents[i+1:]...)
					break
				}
			}
		}
	}
	// Every second, a main-loop tool call whose records carry no timestamp.
	if ticks%10 == 5 {
		id := fmt.Sprintf("toolu_SYN%06d", st.ToolSeq)
		st.ToolSeq++
		call, _ := json.Marshal(map[string]any{"type": "assistant", "message": map[string]any{"model": "claude-opus-5-5", "role": "assistant", "type": "message",
			"content": []any{map[string]any{"type": "tool_use", "id": id, "name": "Bash", "input": map[string]any{"command": "python3 skills/run/scripts/run.py board"}}}},
			"parent_tool_use_id": nil, "session_id": st.Session})
		ret, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result",
			"tool_use_id": id, "content": "<synthetic>", "is_error": false}}}, "parent_tool_use_id": nil, "session_id": st.Session})
		if err := a.put(a.stream(), call, ret); err != nil {
			return err
		}
		a.count("tool.called", 1)
		a.count("tool.returned", 1)
		a.sum.Arrival += 2
		budget -= 2
	}
	// Every three seconds, a gate on the open build visit; every thirty, a late batch.
	if ticks%30 == 15 {
		if err := a.lifecycle(ms, ms, "gate.evaluated", map[string]any{"gate": "build.green", "outcome": "refuse", "reason_code": "suite-failing", "task": "R3-T1"}); err != nil {
			return err
		}
		budget--
	}
	if ticks%300 == 150 {
		for k := 0; k < 2; k++ {
			if err := a.lifecycle(ms-600000+int64(k), ms, "gate.evaluated", map[string]any{"gate": "build.red", "outcome": "refuse", "reason_code": "suite-green", "task": "R3-T1"}); err != nil {
				return err
			}
			a.sum.Late++
			budget--
		}
	}
	// Every five seconds, the supervisor's pass.
	if ticks%50 == 3 {
		st.IntakeSeq++
		line, _ := json.Marshal(map[string]any{"schema_version": 2, "seq": st.IntakeSeq, "at": isoS(ms), "type": "scheduling.decided", "project_id": "P-SYNTH",
			"source_commit": nil, "wave_id": nil, "slice_id": nil, "revision": nil, "ticket_id": nil, "runner_id": "runner-synth", "execution_id": nil,
			"source": "supervisor", "cause": nil, "refs": nil, "data": map[string]any{"state": "supervised", "dispatched": []any{}, "started": []any{}, "held": []any{}}})
		if err := a.put(".factory/intake/events.jsonl", line); err != nil {
			return err
		}
		a.count("scheduling.decided", 1)
		budget--
	}
	// The rest of the budget: progress of the running agents, a few per snapshot line.
	if len(st.Agents) == 0 {
		return nil
	}
	var group []map[string]any
	seen := map[int]bool{}
	for k := 0; k < budget; k++ {
		i := a.rng.IntN(len(st.Agents))
		if seen[i] {
			if err := a.snapshot(ms, group); err != nil {
				return err
			}
			group, seen = nil, map[int]bool{}
		}
		seen[i] = true
		ag := &st.Agents[i]
		ag.Tokens += int64(200 + a.rng.IntN(2000))
		if a.rng.IntN(3) == 0 {
			ag.Calls++
		}
		group = append(group, a.agentObj(*ag, "progress", ms))
		a.count("agent.progressed", 1)
	}
	if len(group) > 0 {
		return a.snapshot(ms, group)
	}
	return nil
}

func (a *appender) agentObj(ag OpenAgent, state string, ms int64) map[string]any {
	o := map[string]any{"type": "workflow_agent", "index": ag.Index, "label": ag.Label, "phaseIndex": ag.Phase, "phaseTitle": phaseTitles[ag.Phase-1],
		"model": ag.Model, "queuedAt": ag.QueuedMS, "attempt": 1, "tokens": ag.Tokens, "toolCalls": ag.Calls, "state": state}
	if state == "queued" {
		o["tokens"], o["toolCalls"] = 0, 0
		return o
	}
	o["agentId"] = ag.ID
	o["startedAt"] = ag.StartMS
	o["lastProgressAt"] = ms
	if ag.AgentType != "" {
		o["agentType"] = ag.AgentType
	}
	if state != "start" {
		o["lastToolName"] = tools[int(ag.Tokens)%len(tools)]
	}
	return o
}

func (a *appender) snapshot(ms int64, agents []map[string]any) error {
	if len(agents) == 0 {
		return nil
	}
	list := make([]any, len(agents))
	for i, o := range agents {
		list[i] = o
	}
	label, _ := agents[len(agents)-1]["label"].(string)
	line, _ := json.Marshal(map[string]any{"type": "system", "subtype": "task_progress", "task_id": a.st.TaskID, "tool_use_id": a.st.ToolUse,
		"description": label, "last_tool_name": label, "usage": map[string]any{"total_tokens": 0, "tool_uses": 0, "duration_ms": ms - a.st.WFStartMS},
		"workflow_progress": list, "session_id": a.st.Session})
	return a.put(a.stream(), line)
}

func (a *appender) lifecycle(atMS, _ int64, typ string, data map[string]any) error {
	st := a.st
	st.LifeSeq++
	line := testkit.Record{Seq: st.LifeSeq, At: isoMS(atMS), Ticket: st.Ticket, Type: typ, Station: "build", Visit: st.Visit, Round: st.Round,
		Execution: st.Execution, Data: data}.Line()
	if err := a.put(".factory/worktrees/"+st.Ticket+"/lifecycle.jsonl", line); err != nil {
		return err
	}
	a.count(typ, 1)
	return nil
}
