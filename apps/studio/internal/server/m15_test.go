package server_test

// M15: the routes and operations the new Product Studio screens use. Uploads travel as base64
// inside the JSON body and are bounded per operation; the download route serves exactly the
// files the last export wrote; neither is reachable from another origin or without the session.

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mach/studio/internal/engine"
	"mach/studio/internal/testkit"
)

type exported struct {
	File      string `json:"file"`
	Readme    string `json:"readme"`
	Downloads []struct {
		Name  string `json:"name"`
		URL   string `json:"url"`
		Bytes int    `json:"bytes"`
	} `json:"downloads"`
}

func (h *host) get(path string, adjust func(*http.Request)) (*http.Response, []byte) {
	h.t.Helper()
	req, _ := http.NewRequest("GET", h.base+path, nil)
	if h.cookie != nil {
		req.AddCookie(h.cookie)
	}
	if adjust != nil {
		adjust(req)
	}
	resp, err := noRedirect.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp, raw
}

func TestTheExportIsOfferedAndNothingElse(t *testing.T) {
	h := start(t)
	h.login()
	h.startSlice()
	var first exported
	if err := json.Unmarshal(h.mustOp("jira.export", `{"state":"all"}`), &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Downloads) != 2 || first.Downloads[0].Name != "mach-jira.csv" || first.Downloads[1].Name != "README.txt" {
		t.Fatalf("downloads %+v", first.Downloads)
	}
	if !strings.HasPrefix(first.File, filepath.Join(h.project, ".factory", "studio", "jira")+string(filepath.Separator)) {
		t.Fatalf("the engine wrote outside its own folder: %s", first.File)
	}
	onDisk, _ := os.ReadFile(first.File)
	resp, body := h.get(first.Downloads[0].URL, nil)
	if resp.StatusCode != 200 || string(body) != string(onDisk) || len(body) != first.Downloads[0].Bytes {
		t.Fatalf("download: %d, %d bytes, want %d", resp.StatusCode, len(body), len(onDisk))
	}
	if resp.Header.Get("Content-Type") != "text/csv; charset=utf-8" || resp.Header.Get("Content-Disposition") != `attachment; filename="mach-jira.csv"` ||
		resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("headers %v", resp.Header)
	}
	// What is served is what the export wrote: a later change on disk is not served.
	os.WriteFile(first.File, []byte("changed"), 0o644)
	if _, again := h.get(first.Downloads[0].URL, nil); string(again) != string(onDisk) {
		t.Fatal("the download followed a later change on disk")
	}
	// Without the session, from another host name, or by another method: refused.
	resp, _ = h.get(first.Downloads[0].URL, func(r *http.Request) { r.Header.Del("Cookie") })
	if resp.StatusCode != 401 {
		t.Fatalf("without the session: %d", resp.StatusCode)
	}
	resp, _ = h.get(first.Downloads[0].URL, func(r *http.Request) { r.Host = "evil.example" })
	if resp.StatusCode != 403 {
		t.Fatalf("another host: %d", resp.StatusCode)
	}
	if status, env := h.call("POST", first.Downloads[0].URL, `{}`, nil); status != 405 || env.OK {
		t.Fatalf("POST: %d %+v", status, env.Error)
	}
	// Names and tokens that are not the last export's.
	token := strings.Split(first.Downloads[0].URL, "/")[3]
	for _, path := range []string{
		"/api/downloads/" + token + "/spec.md", "/api/downloads/" + token + "/..%2f..%2fREADME.md", "/api/downloads/" + token + "/../ops/status",
		"/api/downloads/" + strings.Repeat("A", 43) + "/mach-jira.csv", "/api/downloads/" + token, "/api/downloads/" + token + "/mach-jira.csv/x",
	} {
		resp, raw := h.get(path, nil)
		var env engine.Envelope
		if json.Unmarshal(raw, &env) != nil || env.OK || resp.StatusCode == 200 {
			t.Errorf("%s: %d %s", path, resp.StatusCode, raw)
		}
	}
	// A new export replaces the set: the first token stops working.
	var second exported
	json.Unmarshal(h.mustOp("jira.export", `{"state":"all","flavour":"data-center"}`), &second)
	if resp, _ := h.get(first.Downloads[0].URL, nil); resp.StatusCode != 404 {
		t.Fatalf("an earlier export is still offered: %d", resp.StatusCode)
	}
	if resp, body := h.get(second.Downloads[1].URL, nil); resp.StatusCode != 200 || !strings.Contains(string(body), "Data Center") {
		t.Fatalf("second export: %d", resp.StatusCode)
	}
}

func TestUploadsAreBoundedAndNeedTheSessionAndOrigin(t *testing.T) {
	h := start(t)
	h.login()
	h.startSlice()
	document := base64.StdEncoding.EncodeToString([]byte("# Team PRD\n\n## Goals\n\nInvite teammates.\n"))
	body := `{"file":{"name":"team.md","content_base64":"` + document + `"}}`
	// From another origin, or without the CSRF token: refused, and nothing is staged or imported.
	status, env := h.call("POST", "/api/ops/prd.import", body, func(r *http.Request) { r.Header.Set("Origin", "http://evil.example") })
	expect(t, status, env, 403, engine.KindUnauthorized)
	status, env = h.call("POST", "/api/ops/prd.import", body, func(r *http.Request) { r.Header.Del("X-MACH-CSRF") })
	expect(t, status, env, 403, engine.KindUnauthorized)
	// Not JSON (a multipart form): refused before anything is read.
	status, env = h.call("POST", "/api/ops/prd.import", "--x\r\n", func(r *http.Request) { r.Header.Set("Content-Type", "multipart/form-data; boundary=x") })
	expect(t, status, env, 415, engine.KindInvalid)
	if _, err := os.Stat(testkit.Draft(h.project, "product", "prds")); err == nil {
		t.Fatal("a refused request imported a PRD")
	}
	// A body larger than the operation carries is refused whole; so is a file over its limit.
	huge := `{"file":{"name":"team.md","content_base64":"` + strings.Repeat("A", 1<<20) + `"}}`
	status, env = h.call("POST", "/api/ops/prd.import", huge, nil)
	expect(t, status, env, 413, engine.KindInvalid)
	over := `{"file":{"name":"team.md","content_base64":"` + base64.StdEncoding.EncodeToString(make([]byte, 512<<10+10)) + `"}}`
	status, env = h.call("POST", "/api/ops/prd.import", over, nil)
	expect(t, status, env, 400, engine.KindInvalid)
	// An operation without a file keeps the 64 KiB limit.
	status, env = h.call("POST", "/api/ops/principle.add", `{"title":"`+strings.Repeat("x", 70<<10)+`","statement":"s","reason":"r"}`, nil)
	expect(t, status, env, 413, engine.KindInvalid)
	// The real thing: imported, and nothing left in the staging folder.
	var imported struct {
		PRD struct {
			ID   string `json:"prd_id"`
			Name string `json:"name"`
		} `json:"prd"`
	}
	json.Unmarshal(h.mustOp("prd.import", body), &imported)
	if imported.PRD.ID != "PRD-01" || imported.PRD.Name != "team.md" {
		t.Fatalf("imported %+v", imported)
	}
	if entries, err := os.ReadDir(filepath.Join(h.project, ".factory", "studio", "uploads")); err == nil && len(entries) > 0 {
		t.Fatalf("staged files left: %v", entries)
	}
	// A picture that is not one: the engine judges the content, the host only the name and size.
	status, env = h.call("POST", "/api/ops/slice.mock.add", `{"slice_id":"SLICE-001","file":{"name":"screen.png","content_base64":"`+document+`"}}`, nil)
	if status != 422 || env.Error.Kind != engine.KindRefused {
		t.Fatalf("a text file named .png: %d %+v", status, env.Error)
	}
}
