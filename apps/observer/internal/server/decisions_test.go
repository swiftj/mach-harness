package server

import (
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"mach/observer/internal/feedtest"
	"mach/observer/internal/redact"
)

const adrMark = "QQADRMARK"

func adrFile(status, title string, applies ...string) string {
	head := "---\nstatus: " + status + "\ndate: 2026-11-01\n"
	if len(applies) > 0 {
		head += "applies-to:\n"
		for _, a := range applies {
			head += "  - " + a + "\n"
		}
	}
	return head + "---\n\n# " + title + "\n\n## Context and Problem Statement\n\nPlain text.\n"
}

// decisionsProject writes a project with ADRs and live cells that exercise every part of the page.
func decisionsProject(t *testing.T, root string) {
	t.Helper()
	dir := filepath.Join(root, "docs", "adr")
	files := map[string]string{
		"0001-use-go.md": "---\nstatus: accepted\ndecision-makers: Quentin Archer\napplies-to:\n  - topic:language\n  - topic:testing\n  - path:src/**\n---\n\n# Write the services in Go " + adrMark +
			"\n\n## Decision Outcome\n\nQuentin Archer chose it. <script>alert(1)</script> [a link](https://example.test) token=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX\n",
		"0002-use-sqlite.md":   adrFile("superseded by ADR-0003", "Keep data in SQLite", "topic:storage"),
		"0003-use-postgres.md": adrFile("accepted", "Use PostgreSQL", "topic:storage", "topic:framework", "topic:coding-standards"),
		"0004-broken.md":       "---\nstatus: maybe " + adrMark + "\n---\n\n# Broken " + adrMark + "\n",
		"0005-proposed.md":     adrFile("proposed", "Deploy to one host", "topic:deployment"),
		"README.md":            "# not an ADR\n",
	}
	for name, text := range files {
		writeFile(t, filepath.Join(dir, name), []byte(text))
	}
	writeFile(t, filepath.Join(dir, "0006-huge.md"), []byte("---\nstatus: accepted\n---\n# Huge\n"+strings.Repeat("x", 1<<20)))
	cell := func(ticket string, v map[string]any) {
		b, _ := json.Marshal(v)
		writeFile(t, filepath.Join(root, ".factory", "worktrees", ticket, "cell.json"), b)
	}
	cell("T-7", map[string]any{"ticket_id": "T-7", "stage": "spec-ready", "risk": "Medium",
		"adr_conflict": map[string]any{"adr": "ADR-0003", "digest": "ab", "title": "Use PostgreSQL " + adrMark, "file": "docs/adr/0003-use-postgres.md",
			"reason": "The slice needs a document store " + adrMark + "; Quentin Archer agreed.", "at": "2026-11-20T10:00:00+00:00"}})
	cell("T-8", map[string]any{"ticket_id": "T-8", "stage": "planned", "risk": "High", "main_conflict": map[string]any{"branch": "feature/T-8"},
		"adrs": map[string]any{"planned_at": "2026-11-21T09:00:00+00:00",
			"planned_under": []any{map[string]any{"id": "ADR-0001", "digest": "0000000000000000000000000000000000000000000000000000000000000000", "title": "x", "origin": "main"}},
			"proposed":      []any{map[string]any{"id": "ADR-0009", "file": "docs/adr/0009-use-redis.md", "digest": "ab", "title": "Use Redis for sessions " + adrMark}}}})
	cell("T-9", map[string]any{"ticket_id": "T-9", "stage": "built", "risk": "Low",
		"adrs": map[string]any{"planned_at": "2026-11-19T09:00:00+00:00", "planned_under": []any{map[string]any{"id": "ADR-0003", "digest": "2222222222222222222222222222222222222222222222222222222222222222", "origin": "main"}}},
		"adr_exceptions": []any{map[string]any{"adr": "ADR-0003", "digest": "1111111111111111111111111111111111111111111111111111111111111111", "title": "Use PostgreSQL", "by": "Quentin Archer",
			"reason": "Prototype only " + adrMark + "; Quentin Archer will remove it.", "at": "2026-11-18T08:00:00+00:00",
			"recorded_by": "an agent, on the person's instruction in conversation"}}})
	cell("T-10", map[string]any{"ticket_id": "T-10", "stage": "spec-ready", "spec_question": map[string]any{"text": "?"}, "adr_conflict": map[string]any{"adr": "ADR-0003"}})
	writeFile(t, filepath.Join(root, ".factory", "worktrees", "T-11", "cell.json"), []byte("{not json"))
}

func TestDecisionsList(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	// Before anything exists: every required topic is missing, and no ticket is planned or built.
	empty := h.get(t, "/api/v1/decisions")
	if b := empty["baseline"].(map[string]any); b["covered"] != false || len(b["missing"].([]any)) != 6 || len(empty["adrs"].([]any)) != 0 {
		t.Fatalf("empty project: %v", empty)
	}
	decisionsProject(t, h.root)
	d := h.get(t, "/api/v1/decisions")
	if !strings.Contains(d["basis"].(string), "working tree") || !strings.Contains(d["basis"].(string), "archived tickets are not read") {
		t.Fatalf("basis %v", d["basis"])
	}
	byID := map[string]map[string]any{}
	for _, a := range d["adrs"].([]any) {
		m := a.(map[string]any)
		if id, ok := m["id"].(string); ok {
			byID[id] = m
		}
	}
	if len(byID) != 6 {
		t.Fatalf("adrs %v", d["adrs"])
	}
	if a := byID["ADR-0002"]; a["status"] != "superseded" || a["superseded_by"] != "ADR-0003" || a["binding"] != false {
		t.Fatalf("superseded %v", a)
	}
	if a := byID["ADR-0003"]; a["binding"] != true || !equalList(a["supersedes"], "ADR-0002") || !equalList(a["topics"], "storage", "framework", "coding-standards") {
		t.Fatalf("superseding %v", a)
	}
	if a := byID["ADR-0004"]; a["readable"] != false || a["status"] != nil || len(a["problems"].([]any)) != 1 {
		t.Fatalf("broken %v", a)
	}
	if a := byID["ADR-0006"]; a["unread"] != true || a["readable"] != false || a["title"] != nil || !strings.Contains(a["problems"].([]any)[0].(string), "larger than") {
		t.Fatalf("an unreadable file is listed, with why: %v", a)
	}
	if a := byID["ADR-0001"]; !equalList(a["applies_to"], "topic:language", "topic:testing", "path:src/**") || a["file"] != "docs/adr/0001-use-go.md" {
		t.Fatalf("applies-to %v", a)
	}
	b := d["baseline"].(map[string]any)
	if b["covered"] != false || !equalList(b["missing"], "deployment") {
		t.Fatalf("a missing required topic: %v", b)
	}
	waiting := d["waiting"].(map[string]any)
	if !equalList(waiting["proposed_on_main"], "ADR-0005") {
		t.Fatalf("proposed on main %v", waiting)
	}
	proposals := waiting["proposals"].([]any)
	if len(proposals) != 1 || proposals[0].(map[string]any)["ticket"] != "T-8" || proposals[0].(map[string]any)["holds_build"] != true {
		t.Fatalf("proposals %v", proposals)
	}
	stops := map[string]map[string]any{}
	for _, s := range waiting["stopped"].([]any) {
		m := s.(map[string]any)
		stops[m["ticket"].(string)] = m
	}
	if s := stops["T-7"]; s == nil || s["needs"] != "adr-decision" || s["adr"] != "ADR-0003" || s["at"] != "2026-11-20T10:00:00+00:00" {
		t.Fatalf("a cell stopped on a decision: %v", stops)
	}
	if s := stops["T-8"]; s == nil || s["needs"] != "adr-acceptance" || !equalList(s["adrs"], "ADR-0009") || s["also_recorded"] != "main-conflict" {
		t.Fatalf("a proposal holding a High-risk build: %v", stops)
	}
	if _, asked := stops["T-10"]; asked || len(stops) != 2 {
		t.Fatalf("a spec question is stopped on first, as run.py does: %v", stops)
	}
	if cells := d["cells"].(map[string]any); cells["read"] != 4.0 || !equalList(cells["unreadable"], "T-11") || cells["archived"] != "not read" {
		t.Fatalf("cells %v", cells)
	}
	// With a broken ADR on the main branch, a spec-ready ticket without a conflict stops for adr-fix.
	writeFile(t, filepath.Join(h.root, ".factory", "worktrees", "T-12", "cell.json"), []byte(`{"stage":"spec-ready"}`))
	d = h.get(t, "/api/v1/decisions")
	found := false
	for _, s := range d["waiting"].(map[string]any)["stopped"].([]any) {
		m := s.(map[string]any)
		found = found || (m["ticket"] == "T-12" && m["needs"] == "adr-fix")
	}
	if !found {
		t.Fatalf("adr-fix: %v", d["waiting"])
	}
}

func TestDecisionPage(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	decisionsProject(t, h.root)
	d := h.get(t, "/api/v1/decisions/ADR-0003")
	a := d["adr"].(map[string]any)
	if a["title"] != "Use PostgreSQL" || !equalList(a["supersedes"], "ADR-0002") || !strings.Contains(d["text"].(string), "# Use PostgreSQL") || d["text_cut"] != false {
		t.Fatalf("page %v", d)
	}
	ex := d["exceptions"].([]any)
	if len(ex) != 1 {
		t.Fatalf("exceptions %v", ex)
	}
	e := ex[0].(map[string]any)
	if e["ticket"] != "T-9" || e["by"] != "a person" || e["recorded_by"] != "an agent, on the person's instruction in conversation" || e["at"] != "2026-11-18T08:00:00+00:00" ||
		!strings.Contains(e["reason"].(string), "Prototype only") || e["same_text"] != false {
		t.Fatalf("an exception, with who, when and why: %v", e)
	}
	if pu := d["planned_under"].([]any); len(pu) != 1 || pu[0].(map[string]any)["ticket"] != "T-9" || pu[0].(map[string]any)["same_text"] != false {
		t.Fatalf("planned under %v", pu)
	}
	if c := d["conflicts"].([]any); len(c) != 2 {
		t.Fatalf("conflicts %v", c) // T-7, and T-10 (recorded, though its routing stop is the spec question)
	}
	// A ticket's own proposal, not on the main branch: its page is the tickets that name it.
	p := h.get(t, "/api/v1/decisions/ADR-0009")
	if p["adr"] != nil || p["text"] != nil || len(p["proposed_by"].([]any)) != 1 || p["proposed_by"].([]any)[0].(map[string]any)["holds_build"] != true {
		t.Fatalf("proposal page %v", p)
	}
	// The text is served as data: bounded, people replaced, secrets redacted.
	one := h.get(t, "/api/v1/decisions/ADR-0001")
	text := one["text"].(string)
	if strings.Contains(text, "Quentin") || strings.Contains(text, "sk-ant-api03") || !strings.Contains(text, "a person") || one["render"] != "text only; never markup" {
		t.Fatalf("text %q", text)
	}
	if pu := one["planned_under"].([]any); len(pu) != 1 || pu[0].(map[string]any)["same_text"] != false {
		t.Fatalf("planned under an earlier text: %v", pu)
	}
	for _, path := range []string{"/api/v1/decisions/ADR-0404"} {
		if resp, env, _ := h.do(t, "GET", path, nil); resp.StatusCode != 404 || env.Error.Kind != KindNotFound {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
	}
	for _, path := range []string{"/api/v1/decisions/adr-1", "/api/v1/decisions/ADR-12345", "/api/v1/decisions/..%2Fx"} {
		if resp, _, _ := h.do(t, "GET", path, nil); resp.StatusCode != 400 {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
	}
	// A long text is cut, and says so.
	writeFile(t, filepath.Join(h.root, "docs", "adr", "0007-long.md"), []byte(adrFile("accepted", "Long", "all")+strings.Repeat("word ", 3000)))
	if long := h.get(t, "/api/v1/decisions/ADR-0007"); long["text_cut"] != true || len([]rune(long["text"].(string))) != 6000 {
		t.Fatalf("cut %v", long["text_cut"])
	}
}

// People's names never leave the observer, and every path holding people's text is declared as free
// text in the session's display policy (R1), as freetext_copies_test.go holds the other routes to.
func TestDecisionsFreeTextAndPeople(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	decisionsProject(t, h.root)
	ft := h.get(t, "/api/v1/session")["display_policy"].(map[string]any)["free_text"].(map[string]any)
	declared := map[string]bool{}
	for _, f := range ft["catalog_fields"].([]any) {
		m := f.(map[string]any)
		declared[m["route"].(string)+" "+m["path"].(string)] = true
	}
	for _, f := range decisionFreeText {
		if !declared[f["route"].(string)+" "+f["path"].(string)] {
			t.Fatalf("not in the session: %v", f)
		}
	}
	seen := map[string]bool{}
	var undeclared []string
	for path, route := range map[string]string{"/api/v1/decisions": "/api/v1/decisions", "/api/v1/decisions/ADR-0001": "/api/v1/decisions/{adr}",
		"/api/v1/decisions/ADR-0003": "/api/v1/decisions/{adr}", "/api/v1/decisions/ADR-0004": "/api/v1/decisions/{adr}", "/api/v1/decisions/ADR-0009": "/api/v1/decisions/{adr}"} {
		_, env, body := h.do(t, "GET", path, nil)
		if !env.OK {
			t.Fatalf("%s: %s", path, body)
		}
		if strings.Contains(string(body), "Quentin") || strings.Contains(string(body), "Archer") {
			t.Fatalf("%s serves a person's name: %s", path, body)
		}
		var v any
		json.Unmarshal(body, &v)
		walkStrings(v.(map[string]any)["data"], nil, func(segs []string, s string) {
			if !strings.Contains(s, adrMark) {
				return
			}
			key := route + " " + strings.Join(segs, ".")
			if declared[key] {
				seen[key] = true
				return
			}
			undeclared = append(undeclared, key)
		})
	}
	sort.Strings(undeclared)
	if len(undeclared) > 0 {
		t.Errorf("people's text at undeclared paths (add them to decisionFreeText):\n%s", strings.Join(dedupe(undeclared), "\n"))
	}
	for _, f := range decisionFreeText {
		key := f["route"].(string) + " " + f["path"].(string)
		if !seen[key] && !strings.Contains(key, "file_text") && !strings.Contains(key, "setting_problems") && !strings.HasSuffix(key, "{adr} text") {
			t.Errorf("declared but not seen with the marker: %s", key)
		}
	}
	if redact.Role != "a person" {
		t.Fatal("the role word changed")
	}
}

func equalList(v any, want ...string) bool {
	got, _ := v.([]any)
	if len(got) != len(want) {
		return false
	}
	for i := range want {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
