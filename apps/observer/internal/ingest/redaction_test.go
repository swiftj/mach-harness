package ingest

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mach/observer/internal/redact"
	"mach/observer/internal/testkit"
)

// The adversarial corpus: every kind of value that must never reach an event, the index or a
// checkpoint. Each carries a distinctive marker that is searched for afterwards.
var secrets = []string{
	"sk-ant-api03-MARKERaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	"ghp_MARKERbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	"AKIAMARKER0000000000",
	"Bearer MARKERcccccccccccccccccccccccc",
	"-----BEGIN RSA PRIVATE KEY-----\nMARKERdddd\n-----END RSA PRIVATE KEY-----",
	"/Users/MARKERalice/.ssh/id_rsa",
	"/home/MARKERbob/.aws/credentials",
	"~/MARKERdotfiles/.netrc",
	`C:\Users\MARKERcarol\secret.txt`,
	"postgres://admin:MARKERhunter2@db.example.com:5432/prod",
	"MARKER.dave@example.com",
	"AWS_SECRET_ACCESS_KEY=MARKERwJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
	"PATH=/usr/local/MARKERbin:/usr/bin HOME=/Users/MARKERerin",
	"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJNQVJLRVIifQ.MARKERsignature0000",
	"xoxb-MARKER-1234567890-abcdefghij",
	"password=MARKERhunter3",
	"export GITHUB_TOKEN=MARKERgho0000000000000000000",
	"curl -H 'Authorization: token MARKERffffffffffffff' https://api.github.com",
	strings.Repeat("MARKERlong free text that a model wrote about the code ", 40),
	"file:///private/var/MARKERfolders/x",
}

// marker finds anything of the corpus in b. Every corpus string contains MARKER exactly where a
// leak would show; replaced spans never keep it.
func leaks(b []byte) int { return bytes.Count(b, []byte("MARKER")) }

// structural keys stay as they are so records still classify and parse; everything else is
// replaced by or extended with a secret.
var structural = map[string]bool{"type": true, "subtype": true, "v": true, "schema_version": true, "seq": true, "at": true,
	"ticket_id": true, "station": true, "visit": true, "task_id": true, "tool_use_id": true, "agentId": true, "task_type": true,
	"state": true, "id": true, "role": true, "result_index": true, "claude_code_version": true, "execution_id": true}

type corpus struct {
	fields, records int
	k               int
}

func (c *corpus) secret() string {
	c.k++
	return secrets[c.k%len(secrets)]
}

// mutate rewrites every string leaf: mode 0 replaces it, mode 1 appends a secret to it, mode 2
// replaces non-structural leaves only (the record stays valid, the secrets ride in its payload),
// mode 3 also adds a secret key and value to every object.
func (c *corpus) mutate(v any, key string, mode int) any {
	switch x := v.(type) {
	case string:
		if structural[key] && mode != 1 || structural[key] && key == "type" {
			return x
		}
		c.fields++
		if mode == 1 {
			return x + " " + c.secret()
		}
		return c.secret()
	case []any:
		for i := range x {
			x[i] = c.mutate(x[i], key, mode)
		}
		if mode >= 2 {
			c.fields++
			x = append(x, c.secret())
		}
		return x
	case map[string]any:
		for k, child := range x {
			x[k] = c.mutate(child, k, mode)
		}
		if mode == 3 {
			c.fields += 2
			x["token_"+fmt.Sprint(c.k)] = c.secret()
			x[c.secret()] = "value"
		}
		return x
	}
	return v
}

func (c *corpus) lines(t *testing.T, data []byte, mode int) []byte {
	var out bytes.Buffer
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 1<<20), 8<<20)
	for sc.Scan() {
		var rec any
		if json.Unmarshal(sc.Bytes(), &rec) != nil {
			continue
		}
		c.records++
		b, _ := json.Marshal(c.mutate(rec, "", mode))
		out.Write(b)
		out.WriteByte('\n')
	}
	return out.Bytes()
}

func TestRedactionCoverage(t *testing.T) {
	c := &corpus{}
	root := testkit.Project(t)
	fixtures := []string{"probe-workflow.jsonl", "belt-build-verify-review.jsonl", "agent-tool-contrast.jsonl", "workflow-tool-refused.jsonl",
		"budget-exceeded.jsonl", "budget-stops-workflow.jsonl"}
	n := 0
	for _, f := range fixtures {
		raw, err := os.ReadFile(testkit.StreamFixture(f))
		if err != nil {
			t.Fatal(err)
		}
		for mode := 0; mode < 4; mode++ {
			n++
			x := fmt.Sprintf("x%012x", n)
			dir := testkit.ExecDir(root, x)
			testkit.WriteFile(t, filepath.Join(dir, "stream.jsonl"), c.lines(t, raw, mode))
			testkit.WriteFile(t, filepath.Join(dir, "started.json"), mustJSON(map[string]any{"execution_id": x, "started_at": "2026-11-12T10:00:00Z", "wrapper_pid": c.secret()}))
			testkit.WriteFile(t, filepath.Join(dir, "result.json"), mustJSON(map[string]any{"execution_id": x, "ended": "exited", "exit_code": 0,
				"ended_at": "2026-11-12T10:10:00Z", "seconds": 600, "error": c.secret()}))
			testkit.WriteFile(t, filepath.Join(dir, "stderr.log"), []byte("Budget limit reached\n"+c.secret()))
			testkit.WriteFile(t, filepath.Join(dir, "spec.json"), mustJSON(map[string]any{"argv": []any{c.secret()}, "cwd": c.secret()}))
			c.records += 4
			c.fields += 6
		}
	}
	// Planted tool calls of the main loop: an .env read, a command with a token, an edit of a credential file.
	var planted bytes.Buffer
	for i, input := range []map[string]any{
		{"file_path": root + "/.env.production"},
		{"command": "GITHUB_TOKEN=MARKERghp0000000000000000 gh api /user --header 'Authorization: Bearer MARKERtok'"},
		{"file_path": root + "/config/MARKERcredentials.json", "old_string": "MARKERold", "new_string": "MARKERnew"},
		{"file_path": "/etc/MARKERshadow"},
		{"command": "python3 /Users/MARKERfrank/p/skills/build/scripts/build.py green T-1 --reason 'MARKER secret'"},
	} {
		name := "Read"
		if _, ok := input["command"]; ok {
			name = "Bash"
		} else if _, ok := input["old_string"]; ok {
			name = "Edit"
		}
		b, _ := json.Marshal(map[string]any{"type": "assistant", "timestamp": "2026-11-12T10:00:01.000Z", "parent_tool_use_id": nil,
			"message": map[string]any{"content": []any{map[string]any{"type": "tool_use", "id": fmt.Sprintf("toolu_%02d", i), "name": name, "input": input}}}})
		planted.Write(append(b, '\n'))
		b, _ = json.Marshal(map[string]any{"type": "user", "timestamp": "2026-11-12T10:00:02.000Z",
			"message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": fmt.Sprintf("toolu_%02d", i), "content": "MARKER file contents", "is_error": false}}},
			"tool_use_result": map[string]any{"originalFile": "MARKER original"}})
		planted.Write(append(b, '\n'))
		c.records += 2
		c.fields += 8
	}
	testkit.WriteFile(t, filepath.Join(testkit.ExecDir(root, "xfeedfeedfeed"), "stream.jsonl"), planted.Bytes())

	// The intake log, a cell (its log, spec, votes, evidence), its archive and the run record.
	var ledger bytes.Buffer
	for _, line := range intakeSample() {
		ledger.Write(line)
	}
	for mode := 2; mode < 4; mode++ {
		mutated := c.lines(t, ledger.Bytes(), mode)
		// renumber so every mutated line is read
		var out bytes.Buffer
		seq := 0
		for _, line := range bytes.Split(bytes.TrimSpace(mutated), []byte("\n")) {
			var m map[string]any
			json.Unmarshal(line, &m)
			seq++
			m["seq"] = (mode-2)*100 + seq
			b, _ := json.Marshal(m)
			out.Write(append(b, '\n'))
		}
		testkit.Append(t, testkit.LedgerPath(root), out.Bytes())
	}
	var life bytes.Buffer
	for _, r := range cellRecords("T-9") {
		life.Write(r.Line())
	}
	helper, _ := os.ReadFile(filepath.Join("..", "normalize", "testdata", "lifecycle-helper.jsonl"))
	cell(t, root, "T-9", nil)
	testkit.Append(t, testkit.CellLog(root, "T-9"), c.lines(t, life.Bytes(), 2))
	testkit.Append(t, testkit.CellLog(root, "T-9"), c.lines(t, life.Bytes(), 3))
	testkit.WriteFile(t, filepath.Join(testkit.CellDir(root, "T-9"), "review", "round-1", "votes", "security.json"), c.lines(t, mustJSON(map[string]any{
		"findings": []any{map[string]any{"severity": "blocker", "rule": "FR-01", "title": "t", "file": "f"}}, "summary": "s"}), 2))
	testkit.WriteFile(t, filepath.Join(testkit.CellDir(root, "T-9"), "spec.json"), c.lines(t, mustJSON(map[string]any{
		"scenarios": []any{map[string]any{"id": "AC-01", "title": "x"}}, "decision_matrix": map[string]any{"rules": []any{map[string]any{"id": "R1"}}}}), 2))
	arch := c.lines(t, helper, 3)
	testkit.WriteArchive(t, filepath.Join(root, ".factory", "archive", "LOCAL-001.tar.gz"), "LOCAL-001", map[string][]byte{
		"lifecycle.jsonl": bytes.ReplaceAll(c.lines(t, helper, 2), []byte(`"ticket_id":"LOCAL-001"`), []byte(`"ticket_id":"LOCAL-001"`)),
		"cell.json":       c.lines(t, mustJSON(map[string]any{"stage": "merged", "created_at": "2026-11-12T00:00:00Z", "title": "x"}), 2),
		"intent.md":       []byte("MARKER intent text"),
	})
	_ = arch
	run := mustJSON(map[string]any{"record_version": 2, "ticket_id": "T-9", "outcome": "merged", "closed_at": "2026-11-12T12:00:00+00:00",
		"title": "x", "abandon_reason": "x", "deviations": []any{map[string]any{"detail": "x"}}, "notes": []any{map[string]any{"title": "x"}},
		"integration": map[string]any{"method": "local", "branch": "x"}, "verify_findings": []any{"x"}})
	testkit.Append(t, filepath.Join(root, ".factory", "archive", "runs.jsonl"), c.lines(t, run, 2))
	testkit.Append(t, filepath.Join(root, ".factory", "archive", "runs.jsonl"), c.lines(t, run, 3))

	dir := filepath.Join(root, ".factory", "local", "observer", "index")
	h := newHarness(t, root, dir, false)
	h.drain()
	h.close()

	stored := 0
	leaked := 0
	for _, raw := range h.raws() {
		stored++
		if k := leaks(raw); k > 0 {
			leaked += k
			t.Errorf("leak in a stored event: %s", raw)
		}
	}
	// Nothing on disk under the index either: segments, checkpoints, metadata.
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := os.ReadFile(p)
			if k := leaks(b); k > 0 {
				leaked += k
				t.Errorf("leak in %s", filepath.Base(p))
			}
		}
		return nil
	})
	st := h.o.Stats()
	t.Logf("redaction coverage: %d source records, %d planted string fields, %d events stored and scanned, %d strings scanned by the scrubber, %d spans replaced by the filters, %d by the scrubber, %d data fields dropped by the allowlist, %d records refused for unusable ids, leaks = %d",
		c.records, c.fields, stored, st.Redaction.Strings, redact.TextReplaced.Load(), st.Redaction.Replaced, st.Redaction.FieldsDropped, st.Redaction.Dropped, leaked)
	if stored < 200 {
		t.Fatalf("only %d events: the corpus did not exercise the pipeline", stored)
	}
	h2 := newHarness(t, root, "", false)
	h2.drain()
	h2.validate()
}
