package server

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"mach/observer/internal/feedtest"
	"mach/observer/internal/redact"
)

// M6.5 S3 (R1 beyond artifact content): the session states where prose not checked for names can
// appear, so every client, analytics drill-downs included, can contain it.
func TestSessionDeclaresFreeTextFields(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	s := h.get(t, "/api/v1/session")
	ft, ok := s["display_policy"].(map[string]any)["free_text"].(map[string]any)
	if !ok || ft["checked_for_names"] != false || ft["note"] != redact.FreeTextNote || ft["artifact_field"] != "free_text" ||
		ft["artifact_header"] != redact.FreeTextHeader+": "+redact.FreeTextValue {
		t.Fatalf("display_policy.free_text: %v", s["display_policy"])
	}
	fields, _ := ft["event_fields"].([]any)
	if len(fields) != len(redact.FreeTextFields) {
		t.Fatalf("event_fields %v", fields)
	}
	found := false
	for _, f := range fields {
		m := f.(map[string]any)
		if m["kind"] == "review.finding" && m["path"] == "data.title" {
			found = true
		}
	}
	if !found {
		t.Fatalf("a finding's title (model-written prose) must be declared: %v", fields)
	}
}

// M6.5 S1 and S2 through the HTTP surface: a credential-shaped evidence name appears in no reply,
// and a credential-named file's content is refused.
func TestCredentialNamesThroughTheAPI(t *testing.T) {
	h := start(t, config{events: feedtest.Scenario()})
	cell := filepath.Join(h.root, ".factory/worktrees/T-1")
	secretName := "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV.txt"
	files := map[string][]byte{"AC-01.txt": []byte("ok\n"), secretName: []byte("x\n"), "credentials.txt": []byte("password hunter2\n")}
	var list []map[string]string
	for name, data := range files {
		writeFile(t, filepath.Join(cell, "evidence", name), data)
		list = append(list, map[string]string{"file": name, "sha256": sha(data)})
	}
	res, _ := json.Marshal(map[string]any{"head": "abcdef1", "review_loop": 0, "records": map[string]any{"AC-01": map[string]any{"kind": "scenario", "result": "pass", "evidence": list}}})
	writeFile(t, filepath.Join(cell, "evidence/results.json"), res)

	byPath := map[string]map[string]any{}
	_, _, catalog := h.do(t, "GET", "/api/v1/artifacts?ticket=T-1", nil)
	if strings.Contains(string(catalog), "sk-ant-api03") {
		t.Fatalf("the catalog shows a credential-shaped name: %s", catalog)
	}
	for _, it := range h.get(t, "/api/v1/artifacts?ticket=T-1")["items"].([]any) {
		m := it.(map[string]any)
		byPath[m["path_rel"].(string)] = m
	}
	for _, route := range []string{"/api/v1/cells/T-1/evidence", "/api/v1/artifacts/" + byPath["evidence/results.json"]["id"].(string) + "/content"} {
		if _, _, body := h.do(t, "GET", route, nil); strings.Contains(string(body), "sk-ant-api03") {
			t.Fatalf("%s shows a credential-shaped name: %s", route, body)
		}
	}
	cred := byPath["evidence/credentials.txt"]
	if cred == nil || cred["content_access"] != "none" {
		t.Fatalf("credentials.txt must be metadata only: %v", cred)
	}
	resp, env, body := h.do(t, "GET", "/api/v1/artifacts/"+cred["id"].(string)+"/content", nil)
	if resp.StatusCode != 403 || env.Error == nil || env.Error.Reason != "credential-name" || strings.Contains(string(body), "hunter2") {
		t.Fatalf("credentials.txt content served: %d %s", resp.StatusCode, body)
	}
}
