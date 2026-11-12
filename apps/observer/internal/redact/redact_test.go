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
		Origin: event.Origin{Stream: event.StreamClaude, Key: "s:x", Writer: "claude", Script: "/bin/sh -c"},
		IDs:    event.IDs{ExecutionID: "x0123456789ab", AgentID: "x0123456789ab/a1", TicketID: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA"},
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
