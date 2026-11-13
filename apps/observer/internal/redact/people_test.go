package redact

import (
	"strings"
	"testing"
)

func TestPeopleDenyList(t *testing.T) {
	p := &People{names: map[string]bool{}}
	// Role words MACH writes are never taken for names; names and e-mails are, with their parts.
	p.Learn("engineer", "supervisor", "a person", "security", "Ann Lee", "Bo Ek <bo.ek@example.org>", "x", "")
	if p.Len() != 4 || !p.Is("ann lee") || !p.Is("bo ek") || !p.Is("bo.ek@example.org") || !p.Is("bo.ek") {
		t.Fatalf("learned %v", p.names)
	}
	out, n := p.Replace("Approved by ANN LEE; ann lee's note; Bo Ek wrote to bo.ek@example.org")
	if n != 4 || strings.Contains(strings.ToLower(out), "ann") || strings.Contains(out, "Bo Ek") {
		t.Fatalf("%d %q", n, out)
	}
	// Whole words only: a name inside another word stays.
	p.Learn("Ann")
	if out, n := p.Replace("planning an annual review"); n != 0 || out != "planning an annual review" {
		t.Fatalf("%d %q", n, out)
	}
	b, n := p.ReplaceBytes([]byte(`{"t":"planning by Ann","u":"Ann Lee\nAnn","v":"annual"}`))
	if n != 3 || string(b) != `{"t":"planning by a person","u":"a person\na person","v":"annual"}` {
		t.Fatalf("%d %s", n, b)
	}
}

func TestLearnJSONFindsPeopleByKey(t *testing.T) {
	p := &People{names: map[string]bool{}}
	p.LearnJSON([]byte(`{"human_approval":{"by":"Ada Lovelace","recorded_by":"Grace Hopper","recorded_at":"2026-11-12T10:00:00Z","note":"ok"},
		"votes":{"security":"APPROVE"},"tasks":[{"author":"Linus T","commit":"abcdef1"}],"reviewer":"security","approval":{"actor":"Kay J"}}`))
	for _, want := range []string{"ada lovelace", "grace hopper", "linus t", "kay j"} {
		if !p.Is(want) {
			t.Errorf("%s not learned: %v", want, p.names)
		}
	}
	if p.Is("security") || p.Is("ok") || p.Is("approve") {
		t.Fatalf("a non-person was learned: %v", p.names)
	}
}

// Structured records: person fields by role, unknown keys only when clean, the catalog's relative
// names kept (D25), the known hashes kept, unknown kinds refused (served as text instead).
func TestScrubRecordByKind(t *testing.T) {
	root := "/work/p"
	PeopleFor(root).Learn("Ada Lovelace")
	decision := []byte(`{"ticket_id":"T-1","round":3,"outcome":"APPROVED","human_approval":{"by":"Ada Lovelace","note":"thanks Ada Lovelace",` +
		`"recorded_at":"2026-11-12T22:57:15+00:00","recorded_by":"someone else"},"head":"b68db4be71fe56e6e4264e79472987a639dc8773",` +
		`"findings":"/work/p/.factory/worktrees/T-1/review/round-3/findings.md","extra":"/Users/x/secret","fine":"plain words"}`)
	out, n, err := ScrubRecord(decision, KindDecision, root, RecordOptions{HashKeys: []string{"head"},
		SafeNames: []string{".factory/worktrees/T-1/review/round-3/findings.md"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"by": "a person"`, `"recorded_by": "a person"`, `"note": "thanks a person"`,
		`"head": "b68db4be71fe56e6e4264e79472987a639dc8773"`, `"findings": ".factory/worktrees/T-1/review/round-3/findings.md"`,
		`"extra": "[withheld]"`, `"fine": "plain words"`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %s in %s", want, out)
		}
	}
	if strings.Contains(out, "Lovelace") || strings.Contains(out, "someone else") || n < 5 {
		t.Fatalf("%d %s", n, out)
	}
	if strings.Index(out, `"ticket_id"`) > strings.Index(out, `"round"`) {
		t.Fatal("key order not kept")
	}
	vote, _, _ := ScrubRecord([]byte(`{"reviewer":"security","vote":"REJECT"}`), KindVote, root, RecordOptions{})
	if !strings.Contains(vote, `"reviewer": "security"`) {
		t.Fatalf("a seat was taken for a person: %s", vote)
	}
	if _, _, err := ScrubRecord([]byte(`{"a":1}`), KindUnknown, root, RecordOptions{}); err != ErrNotRecord {
		t.Fatal("an unknown kind was scrubbed as a record")
	}
	if _, _, err := ScrubRecord([]byte(`not json`), KindDecision, root, RecordOptions{}); err != ErrNotRecord {
		t.Fatal("not JSON")
	}
	if KindOf("review/round-2/votes/security.json") != KindVote || KindOf("evidence/previous-1/results.json") != KindResults || KindOf("evidence/x.json") != KindUnknown {
		t.Fatal("kinds")
	}
}

// D25: a relative name the catalog knows is kept in text; an unknown long one still is not.
func TestDocumentKeepsSafeNames(t *testing.T) {
	name := ".factory/worktrees/LOCAL-001/review/round-3/findings.md"
	got, _ := ScrubDocument("see "+name+" and /work/p/"+name, "/work/p", DocOptions{SafeNames: []string{name}})
	if got != "see "+name+" and "+name {
		t.Fatalf("%q", got)
	}
	got, _ = ScrubDocument("see "+name, "/work/p", DocOptions{})
	if strings.Contains(got, "LOCAL-001/review/round-3/findings") {
		t.Fatalf("without the catalog's names the long run is still scrubbed: %q", got)
	}
}
