package redact

import (
	"encoding/json"
	"strings"
	"testing"

	"mach/observer/internal/event"
)

func TestEveryKindHasAnAllowlist(t *testing.T) {
	for _, k := range event.Kinds {
		if Allow[k] == nil {
			t.Errorf("no allowlist for %s", k)
		}
	}
	if len(Allow) != len(event.Kinds) || len(event.Kinds) != 54 {
		t.Fatalf("%d allowlists, %d kinds", len(Allow), len(event.Kinds))
	}
}

// A careless normaliser that passes raw data through still cannot get it stored: the allowlist
// drops what is not named, and the scrubber replaces what looks sensitive in what is.
func TestEnforceAndScrubBehindACarelessNormaliser(t *testing.T) {
	ev := &event.Event{Type: "agent.started", Authority: event.Observed,
		Origin:   event.Origin{Stream: event.StreamClaude, Key: "s:x", Writer: "claude", Script: "/bin/sh -c"},
		IDs:      event.IDs{ExecutionID: "x0123456789ab", AgentID: "x0123456789ab/a1", TicketID: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA"},
		Entities: []string{"agent:x0123456789ab/a1", "cell:/Users/alice/p"},
		Data: map[string]any{
			"index": 1.0, "label": "deploy with password=hunter2 to alice@example.com", "phase": "/home/bob/.ssh/id_rsa",
			"model": "Bearer abcdefghijklmnopqrstuvwxyz", "agent_type": "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----",
			"agent_try": 1.0, "prompt": "the whole workflow script", "promptPreview": "x", "lastToolSummary": "rm -rf /",
			"nested": map[string]any{"env": "AWS_SECRET_ACCESS_KEY=abc"},
		}}
	var c Counters
	if !Enforce(ev, &c) {
		t.Fatal("refused a known kind")
	}
	ScrubEvent(ev, "/work/p", &c)
	out, _ := json.Marshal(ev)
	for _, bad := range []string{"sk-ant", "/Users/alice", "hunter2", "alice@example.com", "/home/bob", "abcdefghijklmnop", "BEGIN RSA", "workflow script", "rm -rf", "AWS_SECRET", "/bin/sh"} {
		if strings.Contains(string(out), bad) {
			t.Errorf("%q survived: %s", bad, out)
		}
	}
	if c.FieldsDropped != 4 || c.Replaced < 5 || ev.Withheld < 9 || ev.IDs.TicketID != "" || len(ev.Entities) != 1 {
		t.Fatalf("counters %+v withheld %d ids %+v entities %v", c, ev.Withheld, ev.IDs, ev.Entities)
	}
	if Enforce(&event.Event{Type: "stream.unrecognised", Origin: event.Origin{Stream: event.StreamClaude, Writer: "claude"}}, &c) {
		t.Fatal("a kind outside the catalog was accepted")
	}
}

func TestFiltersRefuseRatherThanRepair(t *testing.T) {
	for _, v := range []any{"../etc", "a/b", "sk-ant-api03-xxxxxxxxxxxxxxxx", "", 3.0, "a b"} {
		if _, ok := ID(v); ok {
			t.Errorf("ID accepted %v", v)
		}
	}
	for _, v := range []string{"/abs", "a/../b", ".env", "config/.env.local", "keys/id_rsa", "x/server.pem", "~/x"} {
		if _, ok := RelPath(v); ok {
			t.Errorf("RelPath accepted %q", v)
		}
	}
	if s, _ := Text(strings.Repeat("word ", 200), "", 280); s != "[withheld]" {
		t.Fatalf("long free text is replaced whole: %q", s)
	}
	if s := Scrub("see /work/p/src/a.go and /Users/x/y and postgres://u:pw@h/db", "/work/p"); strings.Contains(s, "/Users") || strings.Contains(s, "pw@") || !strings.Contains(s, "src/a.go") {
		t.Fatalf("%q", s)
	}
	digest := strings.Repeat("ab", 32)
	if Sensitive(digest) || Sensitive("agent:x0123456789ab/a0000000000000001") || Sensitive("artifact:T-1:evidence/a.png@9f2c0a1b3d4e") {
		t.Fatal("a digest or a reference read as sensitive")
	}
}

func TestScrubDocumentKeepsLinesAndKnownHashesOnly(t *testing.T) {
	sha := strings.Repeat("ab12", 16)
	doc := "line one\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\n" +
		`{"sha256": "` + sha + `", "x_sha256": "` + sha + `", "head":"not hex at all", "commit": "` + sha + `"}` + "\n" +
		"/work/p/src/a.go and 0 forged\n"
	out, n := ScrubDocument(doc, "/work/p", DocOptions{HashKeys: []string{"sha256", "commit"}})
	want := "line one\n[redacted]\n" +
		`{"sha256": "` + sha + `", "x_sha256": "[redacted]", "head":"not hex at all", "commit": "` + sha + `"}` + "\n" +
		"src/a.go and 0 forged\n"
	if out != want || n != 2 {
		t.Fatalf("%d\n%q\nwant\n%q", n, out, want)
	}
	// Without hash keys every long hex run goes, and a whole-value digest is still not "sensitive"
	// for a typed event field.
	if out, _ := ScrubDocument(`{"sha256":"`+sha+`"}`, "", DocOptions{}); strings.Contains(out, sha) {
		t.Fatalf("%q", out)
	}
	if Sensitive(sha) || !Sensitive("see "+sha) {
		t.Fatal("a digest field is a hash; a digest inside prose is scrubbed")
	}
	// A very long line is bounded, not scanned whole.
	long := strings.Repeat("a", MaxDocumentLine+10) + "\nnext"
	if out, n := ScrubDocument(long, "", DocOptions{}); len(out) != MaxDocumentLine+5 || n != 1 {
		t.Fatalf("%d %d", len(out), n)
	}
}

// The supervisor's held sentence is prose, not a key and its value: "authorized:" is a verb, so
// nothing in it is removed (M6.6 D3, from a real run's scheduling.decided.held[].why). Real
// authorization keys and their values still are.
func TestAuthProseIsNotACredentialButAuthKeysAre(t *testing.T) {
	prose := "Dispatch by 'supervisor' was not authorized: the readiness audit is stale. Nothing was dispatched."
	for _, s := range []string{prose, "unauthorized: the runner is paused", "Authorizing: a person must re-run the audit"} {
		if got := Scrub(s, ""); got != s {
			t.Errorf("prose changed: %q -> %q", s, got)
		}
	}
	for _, s := range []string{
		"curl -H 'Authorization: Bearer MARKERtok' https://e",
		"curl -H 'Authorization: MARKERsecretvalue' https://e",
		"Proxy-Authorization: Basic MARKERdXNlcjpwYXNz",
		"HTTP_AUTHORIZATION=MARKERxyz",
		"auth: MARKERabc",
		"X_AUTH=MARKERabc",
		"auth_header: MARKERabc",
		"authz=MARKERabc",
		"authentication: \"MARKER quoted value\"",
		"export AUTH_TOKEN=MARKERabc",
	} {
		if got := Scrub(s, ""); strings.Contains(got, "MARKER") || !strings.Contains(got, "[redacted]") {
			t.Errorf("credential kept: %q -> %q", s, got)
		}
	}
}
