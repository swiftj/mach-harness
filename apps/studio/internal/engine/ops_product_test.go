package engine_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mach/studio/internal/engine"
	"mach/studio/internal/testkit"
)

// M15: the requests the host refuses for the M13 and M14 operations, before the engine sees them.
func TestProductOpsTheHostRejects(t *testing.T) {
	big := base64.StdEncoding.EncodeToString(make([]byte, 512<<10+1))
	cases := []struct{ op, body, says string }{
		{"principle.add", `{"title":"T","statement":"S MUST hold.","reason":""}`, "reason is required"},
		{"principle.add", `{"title":"T","statement":"Line one MUST hold.\nLine two.","reason":"R"}`, "one line"},
		{"principle.add", `{"title":"T","statement":"S","reason":"R","id":"PP-09"}`, "Unknown field"},
		{"principle.set", `{"principle_id":"PP-01"}`, "at least one"},
		{"principle.set", `{"principle_id":"PP-1","title":"T"}`, "PP-01"},
		{"principle.set", `{"principle_id":"--statement=x","title":"T"}`, "PP-01"},
		{"principle.retire", `{"principle_id":"PP-01 PP-02"}`, "PP-01"},
		{"principle.publish", `{"to":"folder"}`, "Unknown field"},
		{"reconcile.principles", `{"take":"both"}`, "mine"},
		{"reconcile.principles", `{"take":"mine","artifact":"principles"}`, "Unknown field"},
		{"policy.list", `{"dir":"/etc"}`, "Unknown field"},
		{"policy.accept", `{"slice_id":"SLICE-001","policy_id":"POL-privacy","by":"DPO","reason":"Their words here."}`, "POL-privacy-02"},
		{"policy.accept", `{"slice_id":"SLICE-001","policy_id":"POL-Privacy-02","by":"DPO","reason":"Their words here."}`, "POL-privacy-02"},
		{"policy.accept", `{"slice_id":"SLICE-001","policy_id":"POL-privacy-02","by":"","reason":"Their words here."}`, "by is required"},
		{"policy.accept", `{"slice_id":"SLICE-001","policy_id":"POL-privacy-02","by":"DPO"}`, "reason is required"},
		{"epic.current", `{}`, "exactly one"},
		{"epic.current", `{"epic_id":"EPIC-001","issue":12}`, "exactly one"},
		{"epic.current", `{"epic_id":"--json"}`, "EPIC-001"},
		{"epic.current", `{"issue":0}`, "issue number"},
		{"epic.link", `{"epic_id":"EPIC-001"}`, "exactly one"},
		{"epic.link", `{"epic_id":"EPIC-001","jira":"ABC-1","remove":true}`, "exactly one"},
		{"epic.link", `{"epic_id":"EPIC-001","jira":"abc-1"}`, "ABC-123"},
		{"epic.link", `{"epic_id":"EPIC-001","jira":"ABC-01"}`, "ABC-123"},
		{"epic.link", `{"epic_id":"EPIC-001","jira":"ABC-1 --no-jira"}`, "ABC-123"},
		{"epic.link", `{"slice_id":"SLICE-001","jira":"ABC-1"}`, "Unknown field"},
		{"slice.link", `{"slice_id":"SLICE-001","jira":"[ABC-1](http://x)"}`, "ABC-123"},
		{"jira.export", `{"out":"/tmp/x"}`, "Unknown field"},
		{"jira.export", `{"state":"drafts"}`, "ready"},
		{"jira.export", `{"flavour":"server"}`, "cloud"},
		{"jira.export", `{"epic":"../x"}`, "EPIC-001"},
		{"jira.keys", `{}`, "file is required"},
		{"jira.keys", `{"file":"/home/me/keys.csv"}`, "wrong type"},
		{"jira.keys", `{"file":{"name":"keys.xlsx","content_base64":"YQ=="}}`, "CSV"},
		{"jira.keys", `{"file":{"name":"keys.csv","content_base64":"not base64!"}}`, "not base64"},
		{"jira.keys", `{"file":{"name":"keys.csv","content_base64":""}}`, "empty"},
		{"jira.keys", `{"file":{"name":"keys.csv","path":"/etc/passwd"}}`, "Unknown field"},
		{"prd.import", `{"file":{"name":"prd.pdf","content_base64":"YQ=="}}`, "Markdown"},
		{"prd.import", `{"file":{"name":"prd","content_base64":"YQ=="}}`, "Markdown"},
		{"prd.import", `{"file":{"name":"prd.md","content_base64":"` + big + `"}}`, "larger than 512 KiB"},
		{"prd.import", `{"file":{"name":"","content_base64":"YQ=="}}`, "required"},
		{"prd.show", `{"prd_id":"PRD-1"}`, "PRD-01"},
		{"prd.show", `{"prd_id":"PRD-01","lines":"1-2; rm"}`, "range"},
		{"prd.map", `{"prd_id":"PRD-01"}`, "map is required"},
		{"prd.map", `{"prd_id":"PRD-01","map":"slices"}`, "object or list"},
		{"prd.map", `{"prd_id":"PRD-01","map":null}`, "map is required"},
		{"prd.map", `{"prd_id":"../PRD-01","map":{}}`, "PRD-01"},
		{"prd.settle", `{"prd_id":"PRD-01","section":0,"as":"later"}`, "section number"},
		{"prd.settle", `{"prd_id":"PRD-01","section":2,"as":"slice"}`, "map slice"},
		{"prd.settle", `{"prd_id":"PRD-01","section":2,"as":"slice","slice":"SLICE 1"}`, "map slice"},
		{"prd.settle", `{"prd_id":"PRD-01","section":2,"as":"later","slice":"M1"}`, "only when"},
		{"prd.settle", `{"prd_id":"PRD-01","section":2,"as":"slice:M1"}`, "as must be"},
		{"prd.settle", `{"prd_id":"PRD-01","section":2.5,"as":"later"}`, "wrong type"},
		{"prd.draft", `{"slice_id":"SLICE-001","answers":42}`, "object or list"},
		{"prd.confirm", `{"slice_id":"SLICE-001"}`, "accept, discuss"},
		{"prd.confirm", `{"slice_id":"SLICE-001","accept":"some"}`, "\"all\""},
		{"prd.confirm", `{"slice_id":"SLICE-001","accept":[0]}`, "answer numbers"},
		{"prd.confirm", `{"slice_id":"SLICE-001","discuss":[]}`, "between 1 and 80"},
		{"prd.confirm", `{"slice_id":"SLICE-001","accept":{"n":1}}`, "\"all\""},
		{"slice.mock.add", `{"slice_id":"SLICE-001","file":{"name":"a.gif","content_base64":"R0lG"}}`, "PNG or JPEG"},
		{"slice.mock.add", `{"slice_id":"SLICE-001","file":{"name":"a.png","content_base64":"iVBO"},"binding":true}`, "binding"},
		{"slice.mock.add", `{"slice_id":"SLICE-001","file":{"name":"a.png","content_base64":"iVBO"},"for":"R1"}`, "AC-01"},
		{"slice.mock.add", `{"slice_id":"SLICE-001","file":{"name":"a.png","content_base64":"iVBO"},"note":"two\nlines"}`, "one line"},
		{"slice.mock.add", `{"slice_id":"SLICE-001"}`, "file is required"},
		{"slice.mock.remove", `{"slice_id":"SLICE-001","mock":"abc"}`, "at least 8"},
		{"slice.mock.remove", `{"slice_id":"SLICE-001","mock":"--binding0"}`, "at least 8"},
		{"slice.mock.list", `{"slice_id":"SLICE-001","path":"x"}`, "Unknown field"},
	}
	for _, c := range cases {
		_, err := argv(t, c.op, c.body)
		var bad *engine.InvalidError
		if !errors.As(err, &bad) {
			t.Errorf("%s %s: want an invalid request, got %v", c.op, truncateForLog(c.body), err)
			continue
		}
		if !strings.Contains(bad.Message, c.says) {
			t.Errorf("%s %s: message %q should mention %q", c.op, truncateForLog(c.body), bad.Message, c.says)
		}
	}
}

func truncateForLog(s string) string {
	if len(s) > 120 {
		return s[:120] + "..."
	}
	return s
}

// A file's name from the browser becomes a plain name with the same extension; the path the
// browser reported, a leading dot and anything that is not a plain character never reach the engine.
func TestUploadedNamesArePlain(t *testing.T) {
	cases := map[string]string{
		"../../etc/passwd.md":                "passwd.md",
		`C:\Users\pat\PRD final.md`:          "PRD final.md",
		".hidden.md":                         "hidden.md",
		"--help.md":                          "help.md",
		"a;rm -rf ~.md":                      "a-rm -rf -.md",
		"Roadmap (v2) \u2014 final.MARKDOWN": "Roadmap -v2- - final.markdown",
		"....md":                             "upload.md",
		"\u00e9t\u00e9.txt":                  "t-.txt",
	}
	for given, want := range cases {
		body, _ := json.Marshal(map[string]any{"file": map[string]string{"name": given, "content_base64": "IyBQUkQK"}})
		got, err := argv(t, "prd.import", string(body))
		if err != nil {
			t.Errorf("%q: %v", given, err)
			continue
		}
		if got[2] != "/staged/"+want {
			t.Errorf("%q staged as %q, want %q", given, got[2], "/staged/"+want)
		}
	}
	// Without staging, a FileArgs operation never runs: its vector needs the staged copy.
	op, _ := engine.Lookup("prd.import")
	args := op.New()
	engine.Decode([]byte(`{"file":{"name":"a.md","content_base64":"YQ=="}}`), args)
	if _, err := args.Argv(); err == nil {
		t.Fatal("prd.import built a vector with no staged file")
	}
}

// The real engine through the host's staging: the file is written inside the Studio workspace for
// the one call and removed afterwards, whatever the engine answered.
func TestUploadsAreStagedInsideTheWorkspaceAndRemoved(t *testing.T) {
	project := testkit.NewProject(t)
	e := testkit.NewEngine(t, project)
	mustOK(t, e, "project.init", `{"id":"team-space","name":"Team Space","vision":"Teams work together.","outcome":["Teams can work together"]}`)
	document := "# Team invitations\n\n## Goals\n\nAdmins invite teammates by email.\n\n## Limits\n\nA workspace has at most 50 seats.\n"
	body, _ := json.Marshal(map[string]any{"file": map[string]string{"name": "Team PRD.md", "content_base64": base64.StdEncoding.EncodeToString([]byte(document))}})
	imported := mustOK(t, e, "prd.import", string(body))
	prd := imported["prd"].(map[string]any)
	if prd["prd_id"] != "PRD-01" || prd["name"] != "Team PRD.md" {
		t.Fatalf("prd.import: %v", imported)
	}
	copied, err := os.ReadFile(testkit.Draft(project, "product", "prds", "PRD-01", "document.md"))
	if err != nil || string(copied) != document {
		t.Fatalf("the engine's copy differs: %v", err)
	}
	uploads := filepath.Join(project, ".factory", "studio", "uploads")
	if entries, err := os.ReadDir(uploads); err == nil && len(entries) > 0 {
		t.Fatalf("a staged file was left behind: %v", entries)
	}
	// Refused by the engine (not a map it accepts): still nothing left behind.
	mustFail(t, e, "prd.map", `{"prd_id":"PRD-01","map":{"epics":[],"slices":[]}}`, engine.KindRefused, "was not recorded")
	if entries, err := os.ReadDir(uploads); err == nil && len(entries) > 0 {
		t.Fatalf("a staged file was left behind after a refusal: %v", entries)
	}
	// A symbolic link where the staging folder goes: nothing is written through it.
	outside := t.TempDir()
	if err := os.Symlink(outside, uploads); err != nil {
		t.Fatal(err)
	}
	mustFail(t, e, "prd.import", string(body), engine.KindInvalid, "symbolic link")
	if entries, _ := os.ReadDir(outside); len(entries) > 0 {
		t.Fatalf("a file was written through the link: %v", entries)
	}
	os.Remove(uploads)
	// An oversized body never reaches the engine; neither does a cancelled one.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if env := e.Do(ctx, "prd.import", body); env.OK {
		t.Fatal("a cancelled request ran")
	}
}
