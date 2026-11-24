package adr

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The shared fixture (tests/fixtures/adr-parity): tests/test_adr_floor_parity.py holds adr.py to the
// same expected.json, so this reader cannot drift from adr.py silently.
func TestParityWithAdrPy(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "tests", "fixtures", "adr-parity")
	raw, err := os.ReadFile(filepath.Join(root, "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	var want struct {
		Dir  string `json:"dir"`
		ADRs []struct {
			File         string   `json:"file"`
			ID           *string  `json:"id"`
			Number       *int     `json:"number"`
			Title        *string  `json:"title"`
			Status       *string  `json:"status"`
			SupersededBy *string  `json:"superseded_by"`
			Topics       []string `json:"topics"`
			Binding      bool     `json:"binding"`
			ProblemCount int      `json:"problem_count"`
		} `json:"adrs"`
		Missing   []string            `json:"missing"`
		CoveredBy map[string][]string `json:"covered_by"`
	}
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	l := Read(root, Config{}, "missing")
	if l.Dir != want.Dir || !l.Found {
		t.Fatalf("folder %q found=%v", l.Dir, l.Found)
	}
	if len(l.Records) != len(want.ADRs) {
		var names []string
		for _, r := range l.Records {
			names = append(names, r.File)
		}
		t.Fatalf("%d records, want %d: %v", len(l.Records), len(want.ADRs), names)
	}
	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	for i, w := range want.ADRs {
		r := l.Records[i]
		number := -1
		if w.Number != nil {
			number = *w.Number
		}
		topics := r.Topics()
		if topics == nil {
			topics = []string{}
		}
		if r.File != w.File || r.ID != str(w.ID) || r.Number != number || r.Title != str(w.Title) || r.Status != str(w.Status) ||
			r.SupersededBy != str(w.SupersededBy) || !reflect.DeepEqual(topics, w.Topics) || r.Binding != w.Binding || len(r.Problems) != w.ProblemCount {
			t.Errorf("%s:\n got id=%q n=%d title=%q status=%q by=%q topics=%v binding=%v problems=%q\nwant %+v", w.File, r.ID, r.Number, r.Title, r.Status,
				r.SupersededBy, topics, r.Binding, r.Problems, w)
		}
	}
	c := CoverageOf(Config{}, l.Records)
	if !reflect.DeepEqual(c.Missing, want.Missing) {
		t.Errorf("missing %v, want %v", c.Missing, want.Missing)
	}
	for _, row := range c.Topics {
		if !reflect.DeepEqual(row.CoveredBy, want.CoveredBy[row.Topic]) {
			t.Errorf("%s covered by %v, want %v", row.Topic, row.CoveredBy, want.CoveredBy[row.Topic])
		}
	}
}

func TestFolderAndTopicSettings(t *testing.T) {
	for _, c := range []struct {
		v    any
		dir  string
		fail bool
	}{
		{nil, "docs/adr", false}, {"/docs/adr/", "docs/adr", false}, {"decisions", "decisions", false}, {"../x", "docs/adr", true},
		{"/etc", "docs/adr", false}, {"~/x", "docs/adr", true}, {".factory/adr", "docs/adr", true}, {"a\\b", "docs/adr", true}, {5.0, "docs/adr", true}, {"", "docs/adr", true},
	} {
		cfg := ConfigOf(map[string]any{"adr": map[string]any{"dir": c.v}})
		dir, problem := FolderOf(cfg)
		// "/etc" strips to "etc" in adr.py only after the leading-slash check: it is refused.
		if c.v == "/etc" || c.v == "/docs/adr/" {
			if problem == "" {
				t.Errorf("%v: a leading slash is refused", c.v)
			}
			continue
		}
		if dir != c.dir || (problem != "") != c.fail {
			t.Errorf("%v: %q %q", c.v, dir, problem)
		}
	}
	topics, problems := RequiredTopicsOf(ConfigOf(map[string]any{"adr": map[string]any{"required_topics": []any{"language", "Bad Word", "language", 3.0}}}))
	if !reflect.DeepEqual(topics, []string{"language", "Bad Word", "3"}) || len(problems) != 2 {
		t.Fatalf("%v %v", topics, problems)
	}
	if topics, problems := RequiredTopicsOf(ConfigOf(map[string]any{"adr": map[string]any{"required_topics": []any{}}})); len(topics) != 0 || problems != nil {
		t.Fatalf("an empty list requires nothing: %v %v", topics, problems)
	}
	if topics, problems := RequiredTopicsOf(ConfigOf(map[string]any{"adr": map[string]any{"required_topics": "language"}})); len(topics) != 6 || len(problems) != 1 {
		t.Fatalf("not a list: the defaults and a problem: %v %v", topics, problems)
	}
}

// What only the Go reader does: a file it cannot read, and a link, are listed as unreadable with the reason.
func TestUnreadableFilesAreListed(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "docs", "adr")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "0001-ok.md"), []byte("---\nstatus: accepted\n---\n# Fine\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "0002-huge.md"), []byte("---\nstatus: accepted\n---\n# Huge\n"+strings.Repeat("x", MaxReadBytes)), 0o644)
	os.Symlink(filepath.Join(dir, "0001-ok.md"), filepath.Join(dir, "0003-link.md"))
	l := Read(root, Config{}, "missing")
	if len(l.Records) != 3 {
		t.Fatalf("%+v", l.Records)
	}
	if !l.Records[0].Binding || !l.Records[1].Unread || !l.Records[2].Unread || l.Records[1].Binding || l.Records[1].ID != "ADR-0002" {
		t.Fatalf("%+v %+v", l.Records[1], l.Records[2])
	}
	if !strings.Contains(l.Records[2].Problems[0], "symbolic link") || !strings.Contains(l.Records[1].Problems[0], "larger than") {
		t.Fatalf("%q %q", l.Records[1].Problems, l.Records[2].Problems)
	}
	// A folder reached through a link is not followed, and that is said.
	other := t.TempDir()
	os.MkdirAll(filepath.Join(other, "docs"), 0o755)
	os.Symlink(dir, filepath.Join(other, "docs", "adr"))
	if l := Read(other, Config{}, "missing"); len(l.Records) != 0 || len(l.Problems) != 1 || !strings.Contains(l.Problems[0], "symbolic link") {
		t.Fatalf("%+v", l)
	}
	// No folder: nothing, and no problem (the baseline then shows every topic missing).
	if l := Read(t.TempDir(), Config{}, "missing"); l.Found || len(l.Records) != 0 || len(l.Problems) != 0 {
		t.Fatalf("%+v", l)
	}
}
