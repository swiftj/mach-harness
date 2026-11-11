package interview

import (
	"encoding/json"
	"math"
	"strings"
)

// streamLine is the part of one line of Claude Code's stream-json the host reads. Everything else
// (tool inputs echoed back, file contents, paths, account details) is never copied anywhere.
type streamLine struct {
	Type            string          `json:"type"`
	Subtype         string          `json:"subtype"`
	ParentToolUseID *string         `json:"parent_tool_use_id"`
	APIMessageID    string          `json:"api_message_id"`
	Event           *streamEvent    `json:"event"`
	Message         *streamMessage  `json:"message"`
	ToolUseID       string          `json:"tool_use_id"`
	ToolName        string          `json:"tool_name"`
	IsError         bool            `json:"is_error"`
	TotalCostUSD    *float64        `json:"total_cost_usd"`
	Usage           map[string]cost `json:"model_usage_since_last_result"`
	Denials         []any           `json:"permission_denials"`
}

type streamEvent struct {
	Type    string `json:"type"`
	Message *struct {
		ID string `json:"id"`
	} `json:"message"`
	Delta *struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"delta"`
}

type streamMessage struct {
	ID      string          `json:"id"`
	Content json.RawMessage `json:"content"`
}

type contentBlock struct {
	Type      string          `json:"type"`
	IsError   bool            `json:"is_error"`
	Content   json.RawMessage `json:"content"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     map[string]any  `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
}

type cost struct {
	CostUSD *float64 `json:"costUSD"`
}

type toolCall struct {
	name  string
	input map[string]any
}

// turnParser turns one turn's stream into the contract's events. It is driven line by line and
// knows nothing of processes, so it is tested against recorded streams directly.
type turnParser struct {
	paths    Paths
	sliceID  string
	emit     func(name string, data any)
	snapshot func() map[string]string
	before   map[string]string

	tools   map[string]toolCall
	denied  map[string]bool
	texts   map[string][]byte
	order   []string
	current string
	result  *streamLine
}

func newTurnParser(paths Paths, sliceID string, emit func(string, any), snapshot func() map[string]string) *turnParser {
	return &turnParser{paths: paths, sliceID: sliceID, emit: emit, snapshot: snapshot, before: snapshot(),
		tools: map[string]toolCall{}, denied: map[string]bool{}, texts: map[string][]byte{}}
}

func (t *turnParser) line(raw []byte) {
	var ev streamLine
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	if ev.ParentToolUseID != nil && *ev.ParentToolUseID != "" {
		return // sub-agent traffic (none expected: Agent is not available)
	}
	switch ev.Type {
	case "stream_event":
		if ev.Event == nil {
			return
		}
		if ev.Event.Type == "message_start" && ev.Event.Message != nil {
			t.current = ev.Event.Message.ID
		}
		if ev.Event.Type == "content_block_delta" && ev.Event.Delta != nil && ev.Event.Delta.Type == "text_delta" {
			id := ev.APIMessageID
			if id == "" {
				id = t.current
			}
			if id == "" {
				id = "m"
			}
			if _, seen := t.texts[id]; !seen {
				t.texts[id] = nil
				t.order = append(t.order, id)
			}
			t.texts[id] = append(t.texts[id], ev.Event.Delta.Text...)
			t.emit("text", map[string]any{"message_id": id, "delta": ev.Event.Delta.Text})
		}
	case "assistant":
		for _, block := range blocks(ev.Message) {
			if block.Type == "tool_use" {
				t.tools[block.ID] = toolCall{block.Name, block.Input}
				t.emit("state", map[string]any{"state": "working"})
			}
		}
	case "user":
		results := 0
		for _, block := range blocks(ev.Message) {
			if block.Type != "tool_result" {
				continue
			}
			results++
			call, known := t.tools[block.ToolUseID]
			switch {
			case !known || t.denied[block.ToolUseID]: // a refusal was reported already
			case block.IsError && outsideProject(block.Content):
				// --restricted refuses file access outside the working folders as a tool error,
				// not a permission_denied event.
				t.emit("activity", map[string]any{"kind": "refused", "text": "tried to open a file outside the project"})
			case block.IsError:
				t.emit("activity", map[string]any{"kind": "other", "text": "a step did not work; the interviewer carried on"})
			default: // described once it ran
				kind, text := t.paths.Describe(call.name, call.input)
				t.emit("activity", map[string]any{"kind": kind, "text": text})
			}
		}
		if results == 0 {
			return
		}
		after := t.snapshot()
		var changed []string
		for path := range union(t.before, after) {
			if t.before[path] != after[path] {
				changed = append(changed, path)
			}
		}
		if what := WhatChanged(changed); len(what) > 0 {
			t.emit("draft_changed", map[string]any{"slice_id": t.sliceID, "what": what})
		}
		t.before = after
		t.emit("state", map[string]any{"state": "thinking"})
	case "system":
		if ev.Subtype == "permission_denied" {
			t.denied[ev.ToolUseID] = true
			call, known := t.tools[ev.ToolUseID]
			if !known {
				call = toolCall{name: ev.ToolName}
				if call.name == "" {
					call.name = "a tool"
				}
			}
			t.emit("activity", map[string]any{"kind": "refused", "text": t.paths.Refused(call.name, call.input)})
		}
	case "result":
		t.result = &ev
	}
}

// final is the turn's last text message: the one the product manager answers.
func (t *turnParser) final() (id, text string) {
	if len(t.order) == 0 {
		return "", ""
	}
	id = t.order[len(t.order)-1]
	return id, string(t.texts[id])
}

// costs: the session's running total, and this turn's own spend when Claude Code reports it.
func (t *turnParser) costs(previousSession float64) (turn, session *float64) {
	if t.result == nil || t.result.TotalCostUSD == nil {
		return nil, nil
	}
	session = t.result.TotalCostUSD
	sum, found := 0.0, false
	for _, model := range t.result.Usage {
		if model.CostUSD != nil {
			sum += *model.CostUSD
			found = true
		}
	}
	if !found {
		sum = *session - previousSession
	}
	sum = math.Round(sum*1e6) / 1e6
	return &sum, session
}

func blocks(m *streamMessage) []contentBlock {
	if m == nil || len(m.Content) == 0 || m.Content[0] != '[' {
		return nil
	}
	var list []contentBlock
	json.Unmarshal(m.Content, &list)
	return list
}

func union(a, b map[string]string) map[string]bool {
	keys := map[string]bool{}
	for k := range a {
		keys[k] = true
	}
	for k := range b {
		keys[k] = true
	}
	return keys
}

// outsideProject recognises Claude Code's --restricted refusal in a tool result. The text is read
// only to classify it; it is never passed on.
func outsideProject(content json.RawMessage) bool {
	var text string
	if json.Unmarshal(content, &text) != nil {
		var parts []struct {
			Text string `json:"text"`
		}
		json.Unmarshal(content, &parts)
		for _, part := range parts {
			text += part.Text
		}
	}
	return strings.Contains(text, " is outside ") || strings.Contains(text, "--restricted")
}
