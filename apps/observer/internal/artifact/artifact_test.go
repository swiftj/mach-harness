package artifact

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mach/observer/internal/redact"
)

var png = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{1}, 64)...)

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func write(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

type fx struct {
	root, cell string
	text       []byte
}

// project builds a cell with evidence that results.json names, review rounds, a repo/ checkout and
// .factory/local/ files that must never be served.
func project(t *testing.T, extra map[string]string) fx {
	t.Helper()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	cell := filepath.Join(root, ".factory/worktrees/T-1")
	text := []byte("ran the CLI\ntoken: sk-ant-abcdefghijklmnopqrstuvwxyz\nat " + root + "/src/main.go and /Users/someone/.ssh/id_rsa\nok\n")
	write(t, filepath.Join(cell, "evidence/AC-01.txt"), text)
	write(t, filepath.Join(cell, "evidence/shot.png"), png)
	write(t, filepath.Join(cell, "evidence/fake.png"), []byte("<!doctype html><script>alert(1)</script>"))
	write(t, filepath.Join(cell, "evidence/test-suite.log"), []byte("test output"))
	write(t, filepath.Join(cell, "review/round-1/findings.md"), []byte("# Findings\n"))
	write(t, filepath.Join(cell, "review/round-1/decision.json"), []byte(`{"decision":"APPROVED"}`))
	write(t, filepath.Join(cell, "review/round-1/packet.json"), []byte(`{"workdir":"/abs"}`))
	write(t, filepath.Join(cell, "repo/secret.txt"), []byte("SOURCE"))
	write(t, filepath.Join(root, ".factory/local/runner.json"), []byte(`{"enabled":true}`))
	write(t, filepath.Join(root, ".factory/local/executions/x1/stream.jsonl"), []byte("{}\n"))
	files := []map[string]string{
		{"file": "AC-01.txt", "sha256": sum(text)},
		{"file": "shot.png", "sha256": sum(png)},
		{"file": "fake.png", "sha256": sum([]byte("<!doctype html><script>alert(1)</script>"))},
		{"file": "test-suite.log", "sha256": "0"},
		{"file": "../repo/secret.txt", "sha256": "0"},
		{"file": "/etc/passwd", "sha256": "0"},
		{"file": "a/../../repo/secret.txt", "sha256": "0"},
		{"file": "%2e%2e/repo/secret.txt", "sha256": "0"},
		{"file": "nul\x00.txt", "sha256": "0"},
		{"file": "../../local/runner.json", "sha256": "0"},
	}
	for name, content := range extra {
		write(t, filepath.Join(cell, "evidence", name), []byte(content))
		files = append(files, map[string]string{"file": name, "sha256": sum([]byte(content))})
	}
	res, _ := json.Marshal(map[string]any{"head": "abcdef1", "review_loop": 0, "records": map[string]any{
		"AC-01": map[string]any{"kind": "scenario", "result": "pass", "evidence": files},
	}})
	write(t, filepath.Join(cell, "evidence/results.json"), res)
	write(t, filepath.Join(cell, "evidence/summary.json"), []byte(`{"status":"PASS"}`))
	return fx{root: root, cell: cell, text: text}
}

func byPath(c *Catalog) map[string]Entry {
	entries, _ := c.Snapshot()
	out := map[string]Entry{}
	for _, e := range entries {
		out[e.Origin+":"+e.Path] = e
	}
	return out
}

func fresh(c *Catalog) { c.mu.Lock(); c.byID = nil; c.mu.Unlock() }

func TestCatalogListsOnlyAllowedRoots(t *testing.T) {
	f := project(t, nil)
	c := New(f.root)
	got := byPath(c)
	for _, want := range []string{"cell:evidence/AC-01.txt", "cell:evidence/shot.png", "cell:evidence/results.json", "cell:evidence/summary.json",
		"cell:review/round-1/findings.md", "cell:review/round-1/decision.json"} {
		if _, ok := got[want]; !ok {
			t.Fatalf("missing %s in %v", want, keys(got))
		}
	}
	for k := range got {
		if strings.Contains(k, "repo") || strings.Contains(k, "local") || strings.Contains(k, "..") || strings.Contains(k, "passwd") ||
			strings.Contains(k, "test-suite.log") || strings.Contains(k, "packet.json") || strings.Contains(k, "%2e") || strings.Contains(k, "\x00") {
			t.Fatalf("catalogued something outside the allowlist: %s", k)
		}
	}
	ev := got["cell:evidence/AC-01.txt"]
	if ev.Integrity != "match" || !ev.Verified || ev.Nature != "evidence" || ev.MediaType != "text/plain" || ev.ContentAccess != "text" ||
		*ev.Round != 1 || ev.Commit != "abcdef1" || len(ev.Targets) != 1 || ev.Targets[0].ID != "AC-01" || ev.Provenance.Writer != "verify.py" {
		t.Fatalf("%+v", ev)
	}
	if f := got["cell:review/round-1/findings.md"]; f.Nature != "prose" || f.Verified {
		t.Fatalf("findings are prose, never verified evidence: %+v", f)
	}
}

func keys(m map[string]Entry) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestTextIsScrubbed(t *testing.T) {
	f := project(t, nil)
	c := New(f.root)
	e := byPath(c)["cell:evidence/AC-01.txt"]
	got, err := c.Read(e)
	if err != nil {
		t.Fatal(err)
	}
	s := string(got.Data)
	if strings.Contains(s, "sk-ant-") || strings.Contains(s, f.root) || strings.Contains(s, "/Users/someone") || got.Redacted == 0 {
		t.Fatalf("not scrubbed (%d): %q", got.Redacted, s)
	}
	if !strings.Contains(s, "ran the CLI\n") || !strings.Contains(s, "src/main.go") {
		t.Fatalf("lines lost: %q", s)
	}
}

func TestImagesNeedTheOptIn(t *testing.T) {
	f := project(t, nil)
	c := New(f.root)
	if e := byPath(c)["cell:evidence/shot.png"]; e.ContentAccess != "media-disabled" || !strings.Contains(e.AccessReason, "evidence_media") {
		t.Fatalf("%+v", e)
	}
	write(t, filepath.Join(f.root, ".factory/config.json"), []byte(`{"tower":{"evidence_media":true}}`))
	fresh(c)
	e := byPath(c)["cell:evidence/shot.png"]
	if e.ContentAccess != "media" {
		t.Fatalf("%+v", e)
	}
	got, err := c.Read(e)
	if err != nil || !bytes.Equal(got.Data, png) || got.MediaType != "image/png" {
		t.Fatalf("%v", err)
	}
	// A config file that is a link is not read: the default (off) applies.
	os.Remove(filepath.Join(f.root, ".factory/config.json"))
	write(t, filepath.Join(f.root, "elsewhere.json"), []byte(`{"tower":{"evidence_media":true}}`))
	os.Symlink(filepath.Join(f.root, "elsewhere.json"), filepath.Join(f.root, ".factory/config.json"))
	fresh(c)
	if e := byPath(c)["cell:evidence/shot.png"]; e.ContentAccess != "media-disabled" {
		t.Fatalf("a linked config was followed: %+v", e)
	}
}

func TestWrongTypeIsRefused(t *testing.T) {
	f := project(t, map[string]string{"page.svg": "<svg onload=alert(1)>", "blob.bin": "\x00\x01\x02"})
	c := New(f.root)
	got := byPath(c)
	for _, k := range []string{"cell:evidence/fake.png", "cell:evidence/page.svg", "cell:evidence/blob.bin"} {
		e := got[k]
		if e.ContentAccess != "none" {
			t.Fatalf("%s: %+v", k, e)
		}
		if _, err := c.Read(e); !errors.Is(err, ErrTypeMatch) {
			t.Fatalf("%s: %v", k, err)
		}
	}
}

func TestLinksAreRefused(t *testing.T) {
	f := project(t, nil)
	outside := filepath.Join(t.TempDir(), "secret.txt")
	write(t, outside, []byte("SECRET"))
	// a link as the evidence file, to a file outside the project
	os.Remove(filepath.Join(f.cell, "evidence/AC-01.txt"))
	os.Symlink(outside, filepath.Join(f.cell, "evidence/AC-01.txt"))
	c := New(f.root)
	if e := byPath(c)["cell:evidence/AC-01.txt"]; e.Integrity != "missing" || e.SHA256 != "" {
		t.Fatalf("a linked evidence file was read: %+v", e)
	}
	// a link in a parent: the whole evidence folder is a link to repo/
	os.Rename(filepath.Join(f.cell, "evidence"), filepath.Join(f.cell, "evidence-real"))
	os.Symlink(filepath.Join(f.cell, "evidence-real"), filepath.Join(f.cell, "evidence"))
	fresh(c)
	for k := range byPath(c) {
		if strings.HasPrefix(k, "cell:evidence") {
			t.Fatalf("followed a linked evidence folder: %s", k)
		}
	}
	// a linked cell folder
	os.Rename(f.cell, filepath.Join(f.root, "elsewhere-cell"))
	os.Symlink(filepath.Join(f.root, "elsewhere-cell"), f.cell)
	fresh(c)
	if len(byPath(c)) != 0 {
		t.Fatalf("followed a linked cell: %v", keys(byPath(c)))
	}
}

func TestHardLinkIsRefused(t *testing.T) {
	f := project(t, nil)
	outside := filepath.Join(f.root, "outside-secret.txt")
	write(t, outside, f.text) // same content, so only the link count can tell
	os.Remove(filepath.Join(f.cell, "evidence/AC-01.txt"))
	if err := os.Link(outside, filepath.Join(f.cell, "evidence/AC-01.txt")); err != nil {
		t.Skip(err)
	}
	c := New(f.root)
	if e := byPath(c)["cell:evidence/AC-01.txt"]; e.Integrity != "missing" {
		t.Fatalf("a hard link was read: %+v", e)
	}
}

func TestOversizedIsNotRead(t *testing.T) {
	f := project(t, map[string]string{"big.txt": "x"})
	big := filepath.Join(f.cell, "evidence/big.txt")
	if err := os.Truncate(big, MaxVideo+1); err != nil {
		t.Fatal(err)
	}
	c := New(f.root)
	e := byPath(c)["cell:evidence/big.txt"]
	if e.Integrity != "unchecked" || e.SHA256 != "" || e.ContentAccess != "none" {
		t.Fatalf("%+v", e)
	}
	if _, err := c.Read(e); err == nil {
		t.Fatal("an oversized file was read")
	}
	// a text file between the text cap and the hash cap is catalogued but not served
	if err := os.Truncate(big, MaxText+1); err != nil {
		t.Fatal(err)
	}
	fresh(c)
	e = byPath(c)["cell:evidence/big.txt"]
	if _, err := c.Read(e); err == nil {
		t.Fatalf("served a text file over the cap: %+v", e)
	}
}

func TestSwappedAfterCataloguing(t *testing.T) {
	f := project(t, nil)
	c := New(f.root)
	e := byPath(c)["cell:evidence/AC-01.txt"]
	// contents changed
	write(t, filepath.Join(f.cell, "evidence/AC-01.txt"), []byte("something else\n"))
	if _, err := c.Read(e); !errors.Is(err, ErrChanged) {
		t.Fatalf("changed contents: %v", err)
	}
	// replaced by a link to a file with the very same contents
	same := filepath.Join(t.TempDir(), "same.txt")
	write(t, same, f.text)
	os.Remove(filepath.Join(f.cell, "evidence/AC-01.txt"))
	os.Symlink(same, filepath.Join(f.cell, "evidence/AC-01.txt"))
	if _, err := c.Read(e); err == nil {
		t.Fatal("a link swapped in after cataloguing was followed")
	}
	// the evidence folder replaced by a link to a folder holding the same file
	os.Remove(filepath.Join(f.cell, "evidence/AC-01.txt"))
	write(t, filepath.Join(f.cell, "evidence/AC-01.txt"), f.text)
	other := filepath.Join(f.root, "other")
	os.MkdirAll(other, 0o755)
	write(t, filepath.Join(other, "AC-01.txt"), f.text)
	os.Rename(filepath.Join(f.cell, "evidence"), filepath.Join(f.cell, "evidence-old"))
	os.Symlink(other, filepath.Join(f.cell, "evidence"))
	if _, err := c.Read(e); err == nil {
		t.Fatal("a folder swapped for a link was followed")
	}
}

func TestIDsBelongToOneProject(t *testing.T) {
	a := project(t, nil)
	b := project(t, nil)
	ca, cb := New(a.root), New(b.root)
	ea := byPath(ca)["cell:evidence/AC-01.txt"]
	if _, _, ok := cb.Lookup(ea.ID); ok {
		t.Fatal("another project's catalog id resolved")
	}
	if _, _, ok := ca.Lookup(ea.ID); !ok {
		t.Fatal("own id did not resolve")
	}
	for _, bad := range []string{"", "../x", "a/../../etc", "%2e%2e", "a\x00b", strings.Repeat("a", 5000)} {
		if _, _, ok := ca.Lookup(bad); ok {
			t.Fatalf("%q resolved", bad)
		}
	}
}

func targz(t *testing.T, path string, members []tar.Header, bodies [][]byte) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for i, h := range members {
		h := h
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(len(bodies[i]))
		}
		h.Mode, h.ModTime = 0o644, time.Unix(0, 0)
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			tw.Write(bodies[i])
		}
	}
	tw.Close()
	gz.Close()
	write(t, path, buf.Bytes())
}

func TestArchiveMembers(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	ev := []byte("archived evidence\n")
	res, _ := json.Marshal(map[string]any{"head": "abcdef1", "review_loop": 1, "records": map[string]any{
		"AC-02": map[string]any{"kind": "scenario", "result": "pass", "evidence": []map[string]string{{"file": "AC-02.txt", "sha256": sum(ev)}, {"file": "gone.txt", "sha256": sum(ev)}}},
	}})
	targz(t, filepath.Join(root, ".factory/archive/T-0.tar.gz"), []tar.Header{
		{Name: "T-0/evidence/results.json", Typeflag: tar.TypeReg},
		{Name: "T-0/evidence/AC-02.txt", Typeflag: tar.TypeReg},
		{Name: "T-0/../escape.txt", Typeflag: tar.TypeReg},
		{Name: "T-0/evidence/link.txt", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"},
		{Name: "T-0/repo/main.go", Typeflag: tar.TypeReg},
		{Name: "T-0/review/round-2/findings.md", Typeflag: tar.TypeReg},
		{Name: "T-0/lifecycle.jsonl", Typeflag: tar.TypeReg},
	}, [][]byte{res, ev, []byte("x"), nil, []byte("package main"), []byte("# f\n"), []byte("{}\n")})
	c := New(root)
	got := byPath(c)
	e, ok := got["archive:evidence/AC-02.txt"]
	if !ok || e.Integrity != "match" || *e.Round != 2 {
		t.Fatalf("%v %+v", keys(got), e)
	}
	if g := got["archive:evidence/gone.txt"]; g.Integrity != "missing" {
		t.Fatalf("%+v", g)
	}
	for k := range got {
		if strings.Contains(k, "repo") || strings.Contains(k, "escape") || strings.Contains(k, "link") || strings.Contains(k, "lifecycle") {
			t.Fatalf("catalogued %s", k)
		}
	}
	content, err := c.Read(e)
	if err != nil || string(content.Data) != string(ev) {
		t.Fatalf("%v %+v", err, content)
	}
	// A live cell of the same ticket hides its archive.
	os.MkdirAll(filepath.Join(root, ".factory/worktrees/T-0"), 0o755)
	fresh(c)
	if _, ok := byPath(c)["archive:evidence/AC-02.txt"]; ok {
		t.Fatal("an archive was read while the live cell exists")
	}
}

// Served text goes through the one scrubber in internal/redact (no copy here). In a JSON
// record, the hex values under the keys the catalog knows (sha256, head, ...) are hashes and
// stay; a long hex run anywhere else, in the same record or in plain text, is scrubbed.
func TestServedTextUsesTheSharedScrubber(t *testing.T) {
	hexKey := strings.Repeat("0123456789abcdef", 4) // could be a hex API key as well as a digest
	commit := strings.Repeat("abcdef12", 5)
	f := project(t, map[string]string{"plain.txt": "sha256 " + hexKey + "\nbidi \u202egnp.exe\u202c and a bell\a\n"})
	record := []byte(`{"decision":"APPROVED","head":"` + commit + `","note":"key ` + hexKey + `","api_key":"` + hexKey + `"}`)
	write(t, filepath.Join(f.root, ".factory/worktrees/T-1/review/round-1/decision.json"), record)
	c := New(f.root)
	results, err := c.Read(byPath(c)["cell:evidence/results.json"])
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Head    string `json:"head"`
		Records map[string]struct {
			Evidence []struct {
				SHA256 string `json:"sha256"`
			} `json:"evidence"`
		} `json:"records"`
	}
	if err := json.Unmarshal(results.Data, &parsed); err != nil || parsed.Records["AC-01"].Evidence[0].SHA256 != sum(f.text) {
		t.Fatalf("a recorded evidence hash was scrubbed: %v %s", err, results.Data)
	}
	decision, err := c.Read(byPath(c)["cell:review/round-1/decision.json"])
	if err != nil {
		t.Fatal(err)
	}
	if d := string(decision.Data); !strings.Contains(d, `"head":"`+commit+`"`) || strings.Contains(d, hexKey) || decision.Redacted != 2 {
		t.Fatalf("decision.json: %d %s", decision.Redacted, d)
	}
	text, err := c.Read(byPath(c)["cell:evidence/plain.txt"])
	if err != nil {
		t.Fatal(err)
	}
	if d := string(text.Data); strings.Contains(d, hexKey) || strings.ContainsAny(d, "\u202e\u202c\a") || !strings.HasPrefix(d, "sha256 [redacted]\n") {
		t.Fatalf("plain text: %q", d)
	}
	// The same rules as the event path: a field and a document agree on every secret.
	for _, secret := range []string{"sk-ant-api03-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123", "AKIAABCDEFGHIJKLMNOP",
		"Bearer abcdefghijklmnop", "API_TOKEN=supersecretvalue", "xoxb-1234567890-abcdef", strings.Repeat("Ab1", 20), hexKey, "/home/user/.ssh/id_ed25519"} {
		doc, n := redact.ScrubDocument("x "+secret+" y", "", redact.DocOptions{HashKeys: HashKeys})
		field := redact.Scrub("x "+secret+" y", "")
		if n == 0 || strings.Contains(doc, secret) || strings.Contains(field, secret) {
			t.Errorf("%q survived: document %q, field %q", secret, doc, field)
		}
	}
}
