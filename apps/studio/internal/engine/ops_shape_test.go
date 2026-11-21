package engine_test

import (
	"errors"
	"strings"
	"testing"

	"mach/studio/internal/engine"
)

// M16: the requests the host refuses for Shape's operations, before the engine sees them.
func TestShapeOpsTheHostRejects(t *testing.T) {
	big := `{"shipped_rules":[{"rule":"SLICE-001/FR-01","note":"` + strings.Repeat("x", 256<<10) + `"}]}`
	cases := []struct{ op, body, says string }{
		{"idea.add", `{}`, "title is required"},
		{"idea.add", `{"title":"   "}`, "title is required"},
		{"idea.add", `{"title":"` + strings.Repeat("x", 121) + `"}`, "longer than 120"},
		{"idea.add", `{"title":"Line one\nLine two"}`, "one line"},
		{"idea.add", `{"title":"T","from_request":57,"from_issue":58}`, "at most one"},
		{"idea.add", `{"title":"T","from_request":0}`, "request number"},
		{"idea.add", `{"title":"T","from_request":"57"}`, "wrong type"},
		{"idea.add", `{"title":"T","from_issue":-1}`, "issue number"},
		{"idea.add", `{"title":"T","from_fault":"AUTO-1; rm -rf /"}`, "fault ticket"},
		{"idea.add", `{"title":"T","from_fault":"--from-request=5"}`, "fault ticket"},
		{"idea.add", `{"title":"T","idea_id":"IDEA-007"}`, "Unknown field"},
		{"idea.list", `{"stage":"new"}`, "Unknown field"},
		{"idea.show", `{}`, "idea_id is required"},
		{"idea.show", `{"idea_id":"IDEA-1"}`, "IDEA-001"},
		{"idea.show", `{"idea_id":"idea-001"}`, "IDEA-001"},
		{"idea.show", `{"idea_id":"IDEA-001/../x"}`, "IDEA-001"},
		{"idea.show", `{"idea_id":"--help"}`, "IDEA-001"},
		{"idea.stage", `{"idea_id":"IDEA-001","stage":"decided"}`, "exploring"},
		{"idea.stage", `{"idea_id":"IDEA-001"}`, "exploring"},
		{"idea.lookups", `{"idea_id":"IDEA-001"}`, "lookups is required"},
		{"idea.lookups", `{"idea_id":"IDEA-001","lookups":[]}`, "JSON object"},
		{"idea.lookups", `{"idea_id":"IDEA-001","lookups":"rules"}`, "object or list"},
		{"idea.lookups", `{"idea_id":"IDEA-001","lookups":` + big + `}`, "larger than 256 KiB"},
		{"idea.lookups", `{"idea_id":"IDEA-001","lookups":{},"path":"/etc/passwd"}`, "Unknown field"},
		{"idea.lookups", `{"idea_id":"SLICE-001","lookups":{}}`, "IDEA-001"},
		{"idea.map", `{"idea_id":"IDEA-001","map":null}`, "map is required"},
		{"idea.map", `{"idea_id":"IDEA-001","map":[{"key":"S1"}]}`, "JSON object"},
		{"idea.settle", `{"idea_id":"IDEA-001","outcome":"O-0","as":"later"}`, "O-2"},
		{"idea.settle", `{"idea_id":"IDEA-001","outcome":"A-1","as":"later"}`, "O-2"},
		{"idea.settle", `{"idea_id":"IDEA-001","outcome":"O-2","as":"slice"}`, "map slice"},
		{"idea.settle", `{"idea_id":"IDEA-001","outcome":"O-2","as":"slice","slice":"S 2"}`, "map slice"},
		{"idea.settle", `{"idea_id":"IDEA-001","outcome":"O-2","as":"later","slice":"S2"}`, "only when"},
		{"idea.settle", `{"idea_id":"IDEA-001","outcome":"O-2","as":"slice:S2"}`, "as must be"},
		{"idea.settle", `{"idea_id":"IDEA-001","outcome":"O-2","as":"later","reason":"` + strings.Repeat("r", 301) + `"}`, "longer than 300"},
		{"idea.settle", `{"idea_id":"IDEA-001","outcome":"O-2","as":"later","reason":"two\nlines"}`, "one line"},
		{"idea.change", `{"rule":"SLICE-007"}`, "SLICE-007/INV-01"},
		{"idea.change", `{"rule":"SLICE-007/FR-1"}`, "SLICE-007/INV-01"},
		{"idea.change", `{"rule":"--title=x"}`, "SLICE-007/INV-01"},
		{"idea.change", `{"rule":"SLICE-007/INV-01","title":""}`, "title is required"},
		{"idea.change", `{"rule":"SLICE-007/INV-01","idea_id":"IDEA-001"}`, "Unknown field"},
		{"verdict.record", `{"idea_id":"IDEA-001","decision":"yes","reason":"R"}`, "decision must be"},
		{"verdict.record", `{"idea_id":"IDEA-001","decision":"Go","reason":"R"}`, "decision must be"},
		{"verdict.record", `{"idea_id":"IDEA-001","decision":"go"}`, "reason is required"},
		{"verdict.record", `{"idea_id":"IDEA-001","decision":"go","reason":"` + strings.Repeat("r", 501) + `"}`, "longer than 500"},
		{"verdict.record", `{"idea_id":"IDEA-001","decision":"go","reason":"a\nb"}`, "one line"},
		{"verdict.record", `{"idea_id":"IDEA-001","decision":"go","reason":"R","by":"someone-else"}`, "Unknown field"},
		{"lookback.record", `{"idea_id":"IDEA-001","result":"met","note":"n"}`, "exactly one"},
		{"lookback.record", `{"idea_id":"IDEA-001","outcome":"O-1","assumption":"A-1","result":"met","note":"n"}`, "exactly one"},
		{"lookback.record", `{"idea_id":"IDEA-001","outcome":"O-1","result":"wrong","note":"n"}`, "outcome's result"},
		{"lookback.record", `{"idea_id":"IDEA-001","assumption":"A-1","result":"met","note":"n"}`, "assumption's result"},
		{"lookback.record", `{"idea_id":"IDEA-001","assumption":"O-1","result":"wrong","note":"n"}`, "A-1"},
		{"lookback.record", `{"idea_id":"IDEA-001","outcome":"O-1","result":"met"}`, "note is required"},
		{"lookback.record", `{"idea_id":"IDEA-001","outcome":"O-1","result":"met","note":"a\nb"}`, "one line"},
		{"lookback.record", `{"idea_id":"IDEA-001","outcome":"O-1","result":"met","note":"n","by":"x"}`, "Unknown field"},
		{"brief.check", `{"idea_id":"IDEA-001","text":"# Brief"}`, "Unknown field"},
		{"case.show", `{"idea_id":"IDEA-001","path":"product/briefs/IDEA-001.case.md"}`, "Unknown field"},
	}
	for _, c := range cases {
		_, err := argv(t, c.op, c.body)
		var bad *engine.InvalidError
		if !errors.As(err, &bad) {
			t.Errorf("%s %s: want an invalid request, got %v", c.op, c.body, err)
			continue
		}
		if !strings.Contains(bad.Message, c.says) {
			t.Errorf("%s %s: message %q should mention %q", c.op, c.body, bad.Message, c.says)
		}
	}
}

// The server holds an act on an idea while the conversation writes that idea's files: WritesIdea
// names the idea for every Shape operation that changes something, and nothing for a read, another
// operation or a body that does not decode.
func TestWritesIdeaNamesTheIdeaOfEveryShapeAct(t *testing.T) {
	acts := map[string]string{
		"idea.stage":      `{"idea_id":"IDEA-004","stage":"exploring"}`,
		"idea.lookups":    `{"idea_id":"IDEA-004","lookups":{}}`,
		"idea.renumber":   `{"idea_id":"IDEA-004"}`,
		"idea.publish":    `{"idea_id":"IDEA-004"}`,
		"idea.size":       `{"idea_id":"IDEA-004"}`,
		"idea.map":        `{"idea_id":"IDEA-004","map":{}}`,
		"idea.settle":     `{"idea_id":"IDEA-004","outcome":"O-1","as":"later"}`,
		"idea.apply":      `{"idea_id":"IDEA-004"}`,
		"brief.check":     `{"idea_id":"IDEA-004"}`,
		"verdict.record":  `{"idea_id":"IDEA-004","decision":"no","reason":"No."}`,
		"lookback.record": `{"idea_id":"IDEA-004","outcome":"O-1","result":"met","note":"n"}`,
	}
	for name, body := range acts {
		if got := engine.WritesIdea(name, []byte(body)); got != "IDEA-004" {
			t.Errorf("%s: WritesIdea = %q", name, got)
		}
	}
	for name, body := range map[string]string{
		"idea.show": `{"idea_id":"IDEA-004"}`, "brief.show": `{"idea_id":"IDEA-004"}`, "case.check": `{"idea_id":"IDEA-004"}`,
		"idea.chain": `{"idea_id":"IDEA-004"}`, "idea.map-status": `{"idea_id":"IDEA-004"}`, "slice.ready": `{"slice_id":"SLICE-004"}`,
		"idea.publish": `{"idea_id":"IDEA-004","x":1}`, "verdict.record": `not json`, "no.such": `{}`,
	} {
		if got := engine.WritesIdea(name, []byte(body)); got != "" {
			t.Errorf("%s %s: WritesIdea = %q, want none", name, body, got)
		}
	}
}
