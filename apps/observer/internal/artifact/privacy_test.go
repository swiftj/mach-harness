package artifact

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

// M6.5 security review, finding S1: an evidence file whose NAME is a credential (results.json
// names "sk-ant-api03-....txt") was catalogued, and the catalog's safe-name list then protected
// that name from the scrubber inside the served results.json too. Such a name is never
// catalogued, so it appears nowhere: not in the catalog, not in a Content-Disposition, and the
// served results.json has it redacted.
func TestCredentialShapedNamesAreNeverCatalogued(t *testing.T) {
	secret := "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX.txt"
	mail := "zelda.q@example.org.txt"
	f := project(t, map[string]string{secret: "x\n", mail: "y\n", "AC-02-ok.txt": "fine\n"})
	c := New(f.root)
	entries, _ := c.Snapshot()
	blob, _ := json.Marshal(entries)
	for _, needle := range []string{"sk-ant-api03", "zelda.q@example.org"} {
		if strings.Contains(string(blob), needle) {
			t.Fatalf("the catalog shows a credential-shaped or e-mail name %q: %s", needle, blob)
		}
	}
	if _, ok := byPath(c)["cell:evidence/AC-02-ok.txt"]; !ok {
		t.Fatal("an ordinary evidence name must still be catalogued")
	}
	for _, n := range c.SafeNames("T-1") {
		if strings.Contains(n, "sk-ant") || strings.Contains(n, "@") {
			t.Fatalf("a credential-shaped name is protected from the scrubber: %q", n)
		}
	}
	got, err := c.Read(byPath(c)["cell:evidence/results.json"])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got.Data), "sk-ant-api03") || strings.Contains(string(got.Data), "zelda.q@example.org") {
		t.Fatalf("results.json serves the credential-shaped name: %s", got.Data)
	}
}

// S2: a file whose name says it holds credentials (credentials.txt, id_rsa, secrets.json) is
// catalogued as metadata only. Its content is never served, whatever the scrubber would make of
// it ("password hunter2" has no "=" for the key=value rule to catch).
func TestCredentialNamedFilesAreMetadataOnly(t *testing.T) {
	f := project(t, map[string]string{"credentials.txt": "user admin\npassword hunter2\n", "id_rsa": "not a key\n", "AC-03-ok.txt": "fine\n"})
	c := New(f.root)
	got := byPath(c)
	for _, p := range []string{"cell:evidence/credentials.txt", "cell:evidence/id_rsa"} {
		e, ok := got[p]
		if !ok {
			t.Fatalf("%s should be listed (metadata only)", p)
		}
		if e.ContentAccess != "none" || !strings.Contains(e.AccessReason, "credentials") || e.FreeText {
			t.Fatalf("%s: content must not be offered: %+v", p, e)
		}
		if _, err := c.Read(e); !errors.Is(err, ErrCredentialName) {
			t.Fatalf("%s: Read must refuse a credential-named file, got %v", p, err)
		}
	}
	if e := got["cell:evidence/AC-03-ok.txt"]; e.ContentAccess != "text" {
		t.Fatalf("an ordinary text file is still served: %+v", e)
	}
}

// S5: the served text is cut to ServedText on a character boundary, never inside a UTF-8 sequence.
func TestTruncationKeepsWholeCharacters(t *testing.T) {
	// Lines of 100 bytes (the document scrubber caps one line), then 'é' (2 bytes) straddling the cut.
	body := strings.Repeat(strings.Repeat("a", 99)+"\n", (ServedText-1)/100)
	body += strings.Repeat("a", ServedText-1-len(body)) + strings.Repeat("é", 10)
	f := project(t, map[string]string{"long.txt": body})
	c := New(f.root)
	got, err := c.Read(byPath(c)["cell:evidence/long.txt"])
	if err != nil {
		t.Fatal(err)
	}
	if !got.Truncated || len(got.Data) > ServedText || !utf8.Valid(got.Data) {
		t.Fatalf("truncated=%v len=%d valid=%v", got.Truncated, len(got.Data), utf8.Valid(got.Data))
	}
}
