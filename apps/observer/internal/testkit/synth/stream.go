package synth

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
)

// The Claude Code stream of one execution (stream-json --verbose), in the shapes of the recorded
// fixtures (tests/fixtures/execution-streams/), reduced to the fields the observer reads plus the
// envelope. Workflow agents report only snapshots: lifecycle, queue time, tokens and tool-call
// counts; the main loop's own tool calls are individually observable.

const claudeVersion = "2.1.323"

type update struct {
	ms     int64
	a      *agent
	kind   string // queued, started, progress, done
	tokens int64
	calls  int64
	last   string
}

type sline struct {
	ms   int64
	ord  int
	data []byte
}

type streamGen struct {
	g           *gen
	x           *execution
	cut         float64 // model time after which nothing is written
	cutMS       int64
	closed      bool // the process ended inside the history (result.json written)
	lines       []sline
	updates     []update
	agents      []*agent // started inside the history
	fixedEvents int
	ord         int
}

func (s *streamGen) add(ms int64, v any) {
	b, _ := json.Marshal(v)
	s.ord++
	s.lines = append(s.lines, sline{ms: ms, ord: s.ord, data: b})
}

func (s *streamGen) count(typ string, n int) {
	s.fixedEvents += n
	s.g.cnt.add("execution-stream", typ, n)
}

func (g *gen) newStream(x *execution) *streamGen {
	w := g.w
	s := &streamGen{g: g, x: x}
	s.cut = math.Min(x.end, w.endT)
	s.cutMS = w.ms(s.cut)
	s.closed = !math.IsInf(x.end, 1) && g.in(x.end)
	if !g.in(x.claim) {
		return s
	}
	// The execution records (written later) belong to the fixed part of the budget.
	s.fixedEvents++
	if s.closed {
		s.fixedEvents++
	}
	ms := w.ms
	in := func(t float64) bool { return t <= s.cut }
	session := x.session
	if in(x.start + 1.5) {
		s.add(ms(x.start+1.5), map[string]any{"type": "system", "subtype": "init", "session_id": session, "claude_code_version": claudeVersion,
			"model": "claude-opus-5-5", "permissionMode": "dontAsk", "cwd": "<project>", "tools": []string{"Bash", "Read", "Edit", "Glob", "Grep", "Workflow", "Write"},
			"agents": []string{"mach-builder", "mach-verifier", "mach-reviewer", "mach-contract-engineer"}, "synthetic": true})
		s.count("session.initialized", 1)
	}
	calls := append([]mainCall(nil), x.calls...)
	if x.workflow {
		calls = append(calls, mainCall{id: x.toolUse, tool: "Workflow", called: x.wfStart - 0.05, ret: x.wfStart - 0.007})
	}
	for _, c := range calls {
		if !in(c.called) {
			continue
		}
		input := map[string]any{"command": "python3 skills/run/scripts/run.py next " + x.cell.ticket}
		switch c.tool {
		case "Read":
			input = map[string]any{"file_path": ".factory/worktrees/" + x.cell.ticket + "/cell.json"}
		case "Edit", "Write":
			input = map[string]any{"file_path": "notes/synthetic.md"}
		case "Workflow":
			input = map[string]any{"name": "mach-belt", "args": map[string]any{"tickets": []string{x.cell.ticket}, "until": "merge"}}
		}
		rec := map[string]any{"type": "assistant", "message": map[string]any{"model": "claude-opus-5-5", "role": "assistant", "type": "message",
			"content": []any{map[string]any{"type": "tool_use", "id": c.id, "name": c.tool, "input": input}}}, "parent_tool_use_id": nil, "session_id": session}
		if !c.noTime {
			rec["timestamp"] = isoMS(ms(c.called))
		}
		s.add(ms(c.called), rec)
		s.count("tool.called", 1)
		if c.tool == "Workflow" {
			s.add(ms(c.called)+20, map[string]any{"type": "system", "subtype": "background_tasks_changed", "session_id": session,
				"tasks": []any{map[string]any{"task_id": x.taskID, "task_type": "local_workflow", "description": "mach-belt"}}})
			s.add(ms(c.called)+21, map[string]any{"type": "system", "subtype": "task_started", "task_id": x.taskID, "run_id": "run-" + x.taskID,
				"tool_use_id": c.id, "description": "mach-belt", "task_type": "local_workflow", "workflow_name": "mach-belt", "prompt": "<synthetic>", "session_id": session})
			s.count("workflow.started", 1)
		}
		if !in(c.ret) {
			if s.closed {
				s.g.recon["tool.returned (status unknown, closed at the process end)"]++
			}
			continue
		}
		res := map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": c.id,
			"content": "<synthetic>", "is_error": false}}}, "parent_tool_use_id": nil, "session_id": session}
		if c.tool == "Workflow" {
			res["tool_use_result"] = map[string]any{"status": "async_launched", "taskId": x.taskID, "taskType": "local_workflow", "workflowName": "mach-belt"}
		}
		if !c.noTime {
			res["timestamp"] = isoMS(ms(c.ret))
		}
		s.add(ms(c.ret), res)
		s.count("tool.returned", 1)
		g.spans["tool"]++
	}
	if x.workflow {
		for _, a := range x.agents {
			if !in(a.queued) {
				continue
			}
			s.updates = append(s.updates, update{ms: ms(a.queued), a: a, kind: "queued"})
			s.count("agent.queued", 1)
			g.spans["agent-queue"]++
			if !in(a.start) {
				continue
			}
			s.agents = append(s.agents, a)
			g.agents++
			g.spans["agent"]++
			s.updates = append(s.updates, update{ms: ms(a.start), a: a, kind: "started"})
			s.count("agent.started", 1)
			if a.status == "done" && in(a.end) {
				s.count("agent.finished", 1)
			} else if s.closed {
				s.g.recon["agent.finished (status unknown, closed at the process end)"]++
			}
		}
		if len(s.updates) > 0 {
			s.count("workflow.phases_declared", 1)
		}
		if s.closed && x.ended == "exited" && in(x.wfEnd) {
			end := ms(x.wfEnd)
			gap := max(int64(16), ms(x.end)-end) // the tail of the run, between the workflow's end and the process's
			tokens, tools := int64(0), int64(0)
			for _, a := range x.agents {
				tokens += a.tokens
				tools += a.calls
			}
			s.add(end, map[string]any{"type": "system", "subtype": "task_updated", "task_id": x.taskID, "patch": map[string]any{"status": "completed", "end_time": end}, "session_id": session})
			s.add(end+gap/16, map[string]any{"type": "system", "subtype": "task_notification", "task_id": x.taskID, "tool_use_id": x.toolUse, "status": "completed",
				"usage": map[string]any{"total_tokens": tokens, "tool_uses": tools, "duration_ms": end - ms(x.wfStart)}, "session_id": session})
			s.add(end+gap/16+1, map[string]any{"type": "system", "subtype": "background_tasks_changed", "tasks": []any{}, "session_id": session})
			s.add(end+gap/8, map[string]any{"type": "system", "subtype": "init", "session_id": session, "claude_code_version": claudeVersion, "model": "claude-opus-5-5",
				"permissionMode": "dontAsk", "tools": []string{"Bash", "Workflow"}, "agents": []string{}})
			s.add(end+gap/4, map[string]any{"type": "assistant", "message": map[string]any{"model": "claude-opus-5-5", "role": "assistant", "type": "message",
				"content": []any{map[string]any{"type": "text", "text": "<synthetic>"}}}, "parent_tool_use_id": nil, "session_id": session, "timestamp": isoMS(end + gap/4)})
			s.count("workflow.finished", 1)
		}
	}
	if s.closed && x.ended == "exited" {
		usage := map[string]any{}
		share := map[string]float64{"claude-sonnet-5-5": 0.7, "claude-opus-5-5": 0.2, "claude-haiku-5-5": 0.1}
		for _, m := range []string{"claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"} {
			usage[m] = map[string]any{"costUSD": math.Round(x.cost*share[m]*1e4) / 1e4, "inputTokens": 900, "outputTokens": 30000, "cacheReadInputTokens": 900000, "cacheCreationInputTokens": 90000}
		}
		end := ms(x.end)
		results := []int{0}
		if x.workflow {
			results = []int{0, 1}
		}
		for _, idx := range results {
			rec := map[string]any{"type": "result", "subtype": "success", "is_error": false, "total_cost_usd": x.cost, "terminal_reason": "completed",
				"result_index": idx, "modelUsage": usage, "session_id": session, "result": "<synthetic>"}
			if idx == 1 {
				text, _ := json.Marshal(map[string]any{"tickets": []any{map[string]any{"ticket": x.cell.ticket, "outcome": x.outcome, "stage": x.stage,
					"waiting_for": x.waiting, "stations": x.stations}}})
				rec["result"] = string(text)
			}
			s.add(end-int64(2-idx)*max(int64(2), (end-ms(x.start))/2000), rec)
		}
		s.count("execution.usage", 1)
	}
	return s
}

// budget spreads n progress records over the started agents, by how long each ran in the history.
func (g *gen) budget(streams []*streamGen, n int) {
	type item struct {
		a *agent
		d float64
	}
	var items []item
	total := 0.0
	for _, s := range streams {
		for _, a := range s.agents {
			end := math.Min(a.end, s.cut)
			d := math.Max(0, end-a.start)
			// A progress record needs at least two milliseconds of room.
			if g.w.ms(end)-g.w.ms(a.start) < 4 {
				d = 0
			}
			items = append(items, item{a, d})
			total += d
		}
	}
	if n <= 0 || total == 0 {
		return
	}
	given := 0
	type frac struct {
		i int
		f float64
	}
	var fracs []frac
	for i, it := range items {
		share := float64(n) * it.d / total
		k := int(share)
		maxK := int(g.w.ms(math.Min(it.a.end, 1e12))-g.w.ms(it.a.start)) / 2
		if maxK >= 0 && k > maxK && !math.IsInf(it.a.end, 1) {
			k = maxK
		}
		it.a.progress = k
		given += k
		fracs = append(fracs, frac{i, share - float64(k)})
	}
	sort.SliceStable(fracs, func(i, j int) bool { return fracs[i].f > fracs[j].f })
	for i := 0; given < n && len(fracs) > 0; i = (i + 1) % len(fracs) {
		if items[fracs[i].i].d > 0 {
			items[fracs[i].i].a.progress++
			given++
		}
	}
}

func (s *streamGen) agentObj(u update) map[string]any {
	a := u.a
	o := map[string]any{"type": "workflow_agent", "index": a.index, "label": a.label, "phaseIndex": a.phase, "phaseTitle": phaseTitles[a.phase-1],
		"model": a.model, "queuedAt": s.g.w.ms(a.queued), "attempt": 1, "tokens": u.tokens, "toolCalls": u.calls, "state": "queued"}
	if u.kind == "queued" {
		return o
	}
	o["agentId"] = a.id
	o["startedAt"] = s.g.w.ms(a.start)
	if a.agentType != "" {
		o["agentType"] = a.agentType
	}
	o["state"] = "progress"
	if u.kind == "started" {
		o["state"] = "start"
	}
	if u.last != "" {
		o["lastToolName"] = u.last
	}
	o["lastProgressAt"] = u.ms
	if u.kind == "done" {
		o["state"] = "done"
		o["durationMs"] = u.ms - s.g.w.ms(a.start)
	}
	return o
}

// write emits the stream: the fixed lines and every agent's snapshots, in time order.
func (s *streamGen) write(out io.Writer) (int64, error) {
	w := s.g.w
	x := s.x
	if !x.workflow || len(s.updates) == 0 {
		return s.flush(out)
	}
	rng := w.rng
	ups := s.updates
	for _, a := range s.agents {
		start, end := w.ms(a.start), w.ms(math.Min(a.end, s.cut))
		n := a.progress
		step := max(int64(1), (a.tokens)/int64(n+2))
		tokens := int64(0)
		for j := 1; j <= n; j++ {
			at := start + (end-start)*int64(j)/int64(n+1)
			if at <= start {
				at = start + 1
			}
			tokens += step
			calls := a.calls * int64(j) / int64(n+1)
			ups = append(ups, update{ms: at, a: a, kind: "progress", tokens: tokens, calls: calls, last: tools[rng.IntN(len(tools))]})
			s.g.cnt.add("execution-stream", "agent.progressed", 1)
		}
		if a.status == "done" && a.end <= s.cut {
			ups = append(ups, update{ms: w.ms(a.end), a: a, kind: "done", tokens: max(a.tokens, tokens+1), calls: a.calls, last: "StructuredOutput"})
		}
		a.tokens = max(a.tokens, tokens) // what an open agent has reached, for the append state
		if a.status != "done" || a.end > s.cut {
			a.tokens, a.calls = tokens, a.calls*int64(n)/int64(n+1)
		}
	}
	sort.SliceStable(ups, func(i, j int) bool {
		if ups[i].ms != ups[j].ms {
			return ups[i].ms < ups[j].ms
		}
		return rank(ups[i].kind) < rank(ups[j].kind)
	})
	first := true
	lines := 0
	for i := 0; i < len(ups); {
		group := []any{}
		if first {
			for k, title := range phaseTitles {
				group = append(group, map[string]any{"type": "workflow_phase", "index": k + 1, "title": title})
			}
			first = false
		}
		seen := map[*agent]bool{}
		at := ups[i].ms
		for i < len(ups) && ups[i].ms-at < 1500 && !seen[ups[i].a] && len(seen) < 8 {
			seen[ups[i].a] = true
			group = append(group, s.agentObj(ups[i]))
			i++
		}
		label := ups[i-1].a.label
		s.add(at, map[string]any{"type": "system", "subtype": "task_progress", "task_id": x.taskID, "tool_use_id": x.toolUse, "description": label,
			"last_tool_name": label, "usage": map[string]any{"total_tokens": 0, "tool_uses": 0, "duration_ms": at - w.ms(x.wfStart)}, "workflow_progress": group, "session_id": x.session})
		lines++
		if lines%40 == 0 {
			// A heartbeat: no snapshot, no event.
			s.add(at+1, map[string]any{"type": "system", "subtype": "task_progress", "task_id": x.taskID, "tool_use_id": x.toolUse, "description": label,
				"last_tool_name": label, "usage": map[string]any{"total_tokens": 0, "tool_uses": 0, "duration_ms": at + 1 - w.ms(x.wfStart)}, "session_id": x.session})
		}
	}
	return s.flush(out)
}

func rank(kind string) int {
	return map[string]int{"queued": 0, "started": 1, "progress": 2, "done": 3}[kind]
}

func (s *streamGen) flush(out io.Writer) (int64, error) {
	sort.SliceStable(s.lines, func(i, j int) bool {
		if s.lines[i].ms != s.lines[j].ms {
			return s.lines[i].ms < s.lines[j].ms
		}
		return s.lines[i].ord < s.lines[j].ord
	})
	var n int64
	for _, l := range s.lines {
		if l.ms > s.cutMS {
			continue
		}
		k, err := out.Write(append(l.data, '\n'))
		n += int64(k)
		if err != nil {
			return n, err
		}
	}
	if s.x.id == s.g.w.feature["open_execution"] {
		s.g.recordOpen(s)
	}
	s.lines = nil
	return n, nil
}

func (s *streamGen) String() string { return fmt.Sprintf("stream %s (%d lines)", s.x.id, len(s.lines)) }
