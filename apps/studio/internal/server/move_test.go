package server_test

// M21 F: the project's own file is offered for download after `project.export`, read again from
// the engine's folder for each download and served only while it is the bytes the export wrote;
// a Jira export does not replace it. A project file brought in has its own body limit, whose
// refusal names the way to bring in a larger one.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"mach/studio/internal/engine"
)

func TestTheProjectFileIsOfferedAndNothingElse(t *testing.T) {
	h := start(t)
	h.login()
	h.startSlice()
	var first exported
	if err := json.Unmarshal(h.mustOp("project.export", `{}`), &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Downloads) != 1 || !regexp.MustCompile(`^mach-project-team-space-[0-9]{8}T[0-9]{6}Z\.zip$`).MatchString(first.Downloads[0].Name) {
		t.Fatalf("downloads %+v", first.Downloads)
	}
	if filepath.Dir(first.File) != filepath.Join(h.project, ".factory", "studio", "export") {
		t.Fatalf("the engine wrote outside its own folder: %s", first.File)
	}
	onDisk, _ := os.ReadFile(first.File)
	resp, body := h.get(first.Downloads[0].URL, nil)
	if resp.StatusCode != 200 || string(body) != string(onDisk) || len(body) != first.Downloads[0].Bytes {
		t.Fatalf("download: %d, %d bytes, want %d", resp.StatusCode, len(body), len(onDisk))
	}
	if resp.Header.Get("Content-Type") != "application/zip" || resp.Header.Get("Content-Disposition") != `attachment; filename="`+first.Downloads[0].Name+`"` ||
		resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("headers %v", resp.Header)
	}
	// Without the session: refused.
	if resp, _ := h.get(first.Downloads[0].URL, func(r *http.Request) { r.Header.Del("Cookie") }); resp.StatusCode != 401 {
		t.Fatalf("without the session: %d", resp.StatusCode)
	}
	// A Jira export leaves the project's file offered.
	h.mustOp("jira.export", `{"state":"all"}`)
	if resp, _ := h.get(first.Downloads[0].URL, nil); resp.StatusCode != 200 {
		t.Fatalf("a Jira export replaced the project's file: %d", resp.StatusCode)
	}
	// Another name with the same token, or the right name with another token: refused.
	token := strings.Split(first.Downloads[0].URL, "/")[3]
	for _, path := range []string{
		"/api/downloads/" + token + "/mach-project-other-20261124T100000Z.zip",
		"/api/downloads/" + strings.Repeat("A", 43) + "/" + first.Downloads[0].Name,
		"/api/downloads/" + token + "/mach-jira.csv",
	} {
		resp, raw := h.get(path, nil)
		var env engine.Envelope
		if json.Unmarshal(raw, &env) != nil || env.OK || resp.StatusCode == 200 {
			t.Errorf("%s: %d %s", path, resp.StatusCode, raw)
		}
	}
	// What is served is what the export wrote: a file changed on disk is not served, and the
	// answer says what to do.
	os.WriteFile(first.File, []byte("changed"), 0o644)
	resp, raw := h.get(first.Downloads[0].URL, nil)
	if resp.StatusCode != 404 || !strings.Contains(string(raw), "Download the project again") {
		t.Fatalf("a changed file: %d %s", resp.StatusCode, raw)
	}
	// A link in its place is never followed.
	os.Remove(first.File)
	os.Symlink(filepath.Join(h.project, "README.md"), first.File)
	if resp, _ := h.get(first.Downloads[0].URL, nil); resp.StatusCode != 404 {
		t.Fatalf("a link was served: %d", resp.StatusCode)
	}
}

func TestAProjectFileHasItsOwnLimit(t *testing.T) {
	h := start(t)
	h.login()
	// Over the operation's body limit: refused whole, naming the way for a larger file.
	op, _ := engine.Lookup("project.import")
	huge := `{"plan":true,"file":{"name":"big.zip","content_base64":"` + strings.Repeat("A", int(op.BodyLimit())) + `"}}`
	status, env := h.call("POST", "/api/ops/project.import", huge, nil)
	expect(t, status, env, 413, engine.KindInvalid)
	if !strings.Contains(env.Error.Message, "/mach-studio") {
		t.Fatalf("too large: %q", env.Error.Message)
	}
	// Any other operation keeps the general sentence.
	status, env = h.call("POST", "/api/ops/principle.add", `{"title":"`+strings.Repeat("x", 70<<10)+`","statement":"s","reason":"r"}`, nil)
	expect(t, status, env, 413, engine.KindInvalid)
	if env.Error.Message != "The request body is too large." {
		t.Fatalf("principle.add too large: %q", env.Error.Message)
	}
	if _, err := os.Stat(filepath.Join(h.project, ".factory", "studio", "incoming")); err == nil {
		t.Fatal("a refused body kept a file")
	}
}
