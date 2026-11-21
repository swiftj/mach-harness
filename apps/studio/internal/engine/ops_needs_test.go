package engine_test

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"mach/studio/internal/engine"
)

// M17: the argument vector of every technical needs and design operation (TestEveryOperationsArgumentVector
// runs them with the others). Options are --name=value, so a statement that looks like an option stays words.
var needsArgvCases = []struct {
	op, body string
	want     []string
}{
	{"need.list", ``, []string{"need", "list"}},
	{"need.add", `{"kind":"people","statement":"Up to 300 staff use it at once on the first working day of each month.","why":"Payroll closes then."}`,
		[]string{"need", "add", "--kind=people", "--statement=Up to 300 staff use it at once on the first working day of each month.", "--why=Payroll closes then."}},
	{"need.add", `{"kind":"data","statement":"--kind=given is not my statement","why":"Kept seven years."}`,
		[]string{"need", "add", "--kind=data", "--statement=--kind=given is not my statement", "--why=Kept seven years."}},
	{"need.add", `{"kind":"given","statement":"Runs on the company's existing cloud account.","why":"Procurement.","said_by":"Head of IT","said_on":"2026-11-02"}`,
		[]string{"need", "add", "--kind=given", "--statement=Runs on the company's existing cloud account.", "--why=Procurement.", "--said-by=Head of IT", "--said-on=2026-11-02"}},
	{"need.set", `{"need_id":"TN-03","statement":"Kept for at most one year."}`, []string{"need", "set", "TN-03", "--statement=Kept for at most one year."}},
	{"need.set", `{"need_id":"TN-06","why":"Policy.","said_by":"POL-hosting","said_on":"2026-10-01"}`,
		[]string{"need", "set", "TN-06", "--why=Policy.", "--said-by=POL-hosting", "--said-on=2026-10-01"}},
	{"need.retire", `{"need_id":"TN-02"}`, []string{"need", "retire", "TN-02"}},
	{"need.none", `{"kind":"connections"}`, []string{"need", "none", "--kind=connections"}},
	{"need.publish", `{}`, []string{"need", "publish"}},
	{"reconcile.needs", `{"take":"theirs"}`, []string{"reconcile", "needs", "--take=theirs"}},
	{"design.list", `{}`, []string{"design", "list"}},
	{"design.import", `{"file":{"name":"../../Architecture v2.md","content_base64":"` + base64.StdEncoding.EncodeToString([]byte("# Design\n")) + `"}}`,
		[]string{"design", "import", "/staged/Architecture v2.md"}},
	{"design.show", `{"design_id":"DES-01"}`, []string{"design", "show", "DES-01"}},
	{"design.show", `{"design_id":"DES-01","lines":"40-80"}`, []string{"design", "show", "DES-01", "--lines=40-80"}},
	{"design.settle", `{"design_id":"DES-02","conflict":1,"as":"ask-engineer","reason":"--as=stands is what they wrote"}`,
		[]string{"design", "settle", "DES-02", "--conflict=1", "--as=ask-engineer", "--reason=--as=stands is what they wrote"}},
	{"design.settle", `{"design_id":"DES-02","conflict":3,"as":"design-is-wrong","reason":"Out of date.","by":"Head of Product"}`,
		[]string{"design", "settle", "DES-02", "--conflict=3", "--as=design-is-wrong", "--reason=Out of date.", "--by=Head of Product"}},
	{"design.publish", `{"design_id":"DES-02"}`, []string{"design", "publish", "DES-02"}},
}

// The requests the host refuses for the needs and design operations, before the engine sees them.
func TestNeedsOpsTheHostRejects(t *testing.T) {
	doc := func(name string, size int) string {
		return `{"file":{"name":"` + name + `","content_base64":"` + base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", size))) + `"}}`
	}
	cases := []struct{ op, body, says string }{
		{"need.list", `{"kind":"people"}`, "Unknown field"},
		{"need.add", `{}`, "kind is required"},
		{"need.add", `{"kind":"security","statement":"S","why":"W"}`, "kind must be one of"},
		{"need.add", `{"kind":"People","statement":"S","why":"W"}`, "kind must be one of"},
		{"need.add", `{"kind":"people","why":"W"}`, "statement is required"},
		{"need.add", `{"kind":"people","statement":"S"}`, "why is required"},
		{"need.add", `{"kind":"people","statement":"` + strings.Repeat("s", 401) + `","why":"W"}`, "longer than 400"},
		{"need.add", `{"kind":"people","statement":"S","why":"` + strings.Repeat("w", 301) + `"}`, "longer than 300"},
		{"need.add", `{"kind":"people","statement":"One\nTwo","why":"W"}`, "one line"},
		{"need.add", `{"kind":"people","statement":"S","why":"W","said_by":"Head of IT","said_on":"2026-11-02"}`, "Only a given"},
		{"need.add", `{"kind":"given","statement":"S","why":"W"}`, "said_by and said_on"},
		{"need.add", `{"kind":"given","statement":"S","why":"W","said_by":"Head of IT"}`, "said_by and said_on"},
		{"need.add", `{"kind":"given","statement":"S","why":"W","said_by":"Head of IT","said_on":"2 Nov 2026"}`, "2026-11-21"},
		{"need.add", `{"kind":"given","statement":"S","why":"W","said_by":"Head of IT","said_on":"2026-13-02"}`, "2026-11-21"},
		{"need.add", `{"kind":"given","statement":"S","why":"W","said_by":"` + strings.Repeat("b", 101) + `","said_on":"2026-11-02"}`, "longer than 100"},
		{"need.add", `{"kind":"people","statement":"S","why":"W","need_id":"TN-09"}`, "Unknown field"},
		{"need.set", `{"statement":"S"}`, "need_id is required"},
		{"need.set", `{"need_id":"TN-1","statement":"S"}`, "TN-01"},
		{"need.set", `{"need_id":"tn-01","statement":"S"}`, "TN-01"},
		{"need.set", `{"need_id":"--statement=x","statement":"S"}`, "TN-01"},
		{"need.set", `{"need_id":"TN-01"}`, "at least one"},
		{"need.set", `{"need_id":"TN-01","statement":""}`, "statement is required"},
		{"need.set", `{"need_id":"TN-01","kind":"data"}`, "Unknown field"},
		{"need.set", `{"need_id":"TN-01","revision":2}`, "Unknown field"},
		{"need.retire", `{"need_id":"PP-01"}`, "TN-01"},
		{"need.none", `{"kind":"anything"}`, "kind must be one of"},
		{"need.none", `{}`, "kind is required"},
		{"need.publish", `{"to":"folder"}`, "Unknown field"},
		{"reconcile.needs", `{"take":"both"}`, "take must be"},
		{"reconcile.needs", `{}`, "take must be"},
		{"design.list", `{"path":"product/designs"}`, "Unknown field"},
		{"design.import", `{}`, "file is required"},
		{"design.import", doc("design.pdf", 10), "Markdown"},
		{"design.import", doc("design", 10), "Markdown"},
		{"design.import", doc("design.md", 0), "empty"},
		{"design.import", doc("design.md", 512<<10+1), "larger than 512 KiB"},
		{"design.import", `{"file":{"name":"d.md","content_base64":"%%%"}}`, "not base64"},
		{"design.import", `{"file":{"name":"d.md","content_base64":"YQ=="},"path":"/etc/passwd"}`, "Unknown field"},
		{"design.show", `{}`, "design_id is required"},
		{"design.show", `{"design_id":"DES-1"}`, "DES-01"},
		{"design.show", `{"design_id":"PRD-01"}`, "DES-01"},
		{"design.show", `{"design_id":"DES-01","lines":"a-b"}`, "range"},
		{"design.show", `{"design_id":"DES-01","lines":"--lines=1"}`, "range"},
		{"design.settle", `{"design_id":"DES-01","conflict":0,"as":"stands","reason":"R"}`, "conflict must be"},
		{"design.settle", `{"design_id":"DES-01","conflict":41,"as":"stands","reason":"R"}`, "conflict must be"},
		{"design.settle", `{"design_id":"DES-01","conflict":"1","as":"stands","reason":"R"}`, "wrong type"},
		{"design.settle", `{"design_id":"DES-01","conflict":1,"as":"accept","reason":"R"}`, "as must be"},
		{"design.settle", `{"design_id":"DES-01","conflict":1,"as":"stands"}`, "reason is required"},
		{"design.settle", `{"design_id":"DES-01","conflict":1,"as":"stands","reason":"` + strings.Repeat("r", 301) + `"}`, "longer than 300"},
		{"design.settle", `{"design_id":"DES-01","conflict":1,"as":"stands","reason":"a\nb"}`, "one line"},
		{"design.settle", `{"design_id":"DES-01","conflict":1,"as":"stands","reason":"R","by":"` + strings.Repeat("b", 81) + `"}`, "longer than 80"},
		{"design.settle", `{"design_id":"DES-01","conflict":1,"as":"stands","reason":"R","by":""}`, "by is required"},
		{"design.publish", `{"design_id":"DES-01","files":["x"]}`, "Unknown field"},
		{"design.publish", `{"design_id":"DES-01/../x"}`, "DES-01"},
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

// The server holds an act on the needs or a design while the needs conversation writes: WritesNeeds
// is true for every such act and false for a read, another operation or a body that does not decode.
func TestWritesNeedsNamesEveryNeedsAndDesignAct(t *testing.T) {
	acts := map[string]string{
		"need.add":        `{"kind":"people","statement":"S","why":"W"}`,
		"need.set":        `{"need_id":"TN-01","why":"W"}`,
		"need.retire":     `{"need_id":"TN-01"}`,
		"need.none":       `{"kind":"data"}`,
		"need.publish":    `{}`,
		"reconcile.needs": `{"take":"mine"}`,
		"design.import":   `{"file":{"name":"d.md","content_base64":"YQ=="}}`,
		"design.settle":   `{"design_id":"DES-01","conflict":1,"as":"stands","reason":"R"}`,
		"design.publish":  `{"design_id":"DES-01"}`,
	}
	for name, body := range acts {
		if !engine.WritesNeeds(name, []byte(body)) {
			t.Errorf("%s: WritesNeeds is false", name)
		}
	}
	for name, body := range map[string]string{
		"need.list": `{}`, "design.list": `{}`, "design.show": `{"design_id":"DES-01"}`, "principle.publish": `{}`,
		"reconcile.principles": `{"take":"mine"}`, "idea.publish": `{"idea_id":"IDEA-001"}`,
		"need.publish": `{"x":1}`, "need.add": `not json`, "no.such": `{}`,
	} {
		if engine.WritesNeeds(name, []byte(body)) {
			t.Errorf("%s %s: WritesNeeds is true", name, body)
		}
	}
	// No Shape act is held by the needs conversation, and no needs act by an idea's.
	for _, name := range engine.Names() {
		if strings.HasPrefix(name, "need.") || strings.HasPrefix(name, "design.") {
			if engine.WritesIdea(name, []byte(`{"idea_id":"IDEA-001"}`)) != "" {
				t.Errorf("%s is held by an idea's conversation", name)
			}
		}
	}
}
