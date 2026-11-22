package interview_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"mach/studio/internal/interview"
	"mach/studio/internal/testkit"
)

// M18: the slice interview for a small change may widen it by a rule an answer showed does not hold
// (skills/intent/references/small-change.md, "An answer showed it"), for exactly the rules the short
// interview names, and nothing else. Widening on the product manager's own reason is their button.

func writeWorkOrder(t *testing.T, project, sliceID, body string) {
	t.Helper()
	path := filepath.Join(testkit.Draft(project), "product", "slices", sliceID+".json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func widenRules(rules []string) []string {
	var out []string
	for _, rule := range rules {
		if strings.Contains(rule, " slice widen ") {
			out = append(out, rule)
		}
	}
	return out
}

func TestASmallChangesInterviewMayWidenItByARuleOnly(t *testing.T) {
	r := newRig(t)
	p := r.bridge.Paths()
	writeWorkOrder(t, r.project, "SLICE-007", `{"slice_id":"SLICE-007","kind":"small","small":{"change":"adjustment","shipped_rule":null}}`)
	args := p.PermissionArgs("SLICE-007")
	split := indexOf(args, "--disallowedTools")
	allow, deny := args[1:split], args[split+1:]

	var scripts, pythons []string
	for _, s := range p.Scripts {
		scripts = append(scripts, regexp.QuoteMeta(s))
	}
	for _, py := range p.Pythons {
		pythons = append(pythons, regexp.QuoteMeta(py))
	}
	codes := strings.Join(interview.SmallChangeRules(), "|")
	exact := regexp.MustCompile(`^Bash\((` + strings.Join(pythons, "|") + `) "?(` + strings.Join(scripts, "|") + `)"? ` +
		`slice widen SLICE-007 --by-rule[ =](` + codes + `)\)$`)
	widen := widenRules(allow)
	for _, rule := range widen {
		if !exact.MatchString(rule) {
			t.Errorf("unexpected widen rule %q", rule)
		}
		if strings.Contains(rule, "*") || strings.Contains(rule, "--why") {
			t.Errorf("a widen rule with a wildcard or a reason: %s", rule)
		}
	}
	// 13 rules x 2 spellings of the option x 2 scripts x 2 spellings of the script x each interpreter.
	if want := 13 * 2 * 2 * 2 * len(p.Pythons); len(widen) != want || len(interview.SmallChangeRules()) != 13 {
		t.Fatalf("%d widen rules, want %d", len(widen), want)
	}
	for _, code := range []string{"actor", "questions", "risk", "changed-rules", "unshipped-dependency"} {
		found := false
		for _, rule := range widen {
			found = found || strings.HasSuffix(rule, " --by-rule "+code+")")
		}
		if !found {
			t.Errorf("no widen rule for %s", code)
		}
	}
	// The plan's rules are the builders' to find, never the interview's.
	for _, code := range []string{"contract", "high-risk-file", "adr"} {
		for _, rule := range widen {
			if strings.HasSuffix(rule, code+")") {
				t.Errorf("the interview may widen by a plan rule: %s", rule)
			}
		}
	}
	whyDenied := 0
	for _, rule := range deny {
		if strings.HasSuffix(rule, " slice widen SLICE-007 --why *)") || strings.HasSuffix(rule, " slice widen SLICE-007 --why=*)") {
			whyDenied++
		}
	}
	if whyDenied != 2*2*2*len(p.Pythons) {
		t.Fatalf("%d deny rules for widening on the product manager's word", whyDenied)
	}
	if !strings.Contains(interview.HostNote, "--by-rule") || !strings.Contains(interview.HostNote, "their button") {
		t.Fatalf("the host note does not say how a small change is widened: %s", interview.HostNote)
	}
}

func TestAFullSlicesInterviewMayNotWiden(t *testing.T) {
	r := newRig(t)
	p := r.bridge.Paths()
	for name, body := range map[string]string{
		"SLICE-007": `{"slice_id":"SLICE-007"}`,               // a full slice
		"SLICE-008": `{"slice_id":"SLICE-008","kind":"tiny"}`, // not the engine's kind
		"SLICE-009": `not json`,                               // unreadable
	} {
		writeWorkOrder(t, r.project, name, body)
	}
	for _, id := range []string{"SLICE-007", "SLICE-008", "SLICE-009", "SLICE-010"} { // SLICE-010: no work order
		if widen := widenRules(p.PermissionArgs(id)[1:indexOf(p.PermissionArgs(id), "--disallowedTools")]); len(widen) != 0 {
			t.Errorf("%s: widen rules %q", id, widen)
		}
	}
	// A work order behind a link is not read.
	writeWorkOrder(t, r.project, "SLICE-011", `{"kind":"small"}`)
	dir := filepath.Join(testkit.Draft(r.project), "product", "slices")
	if err := os.Symlink(filepath.Join(dir, "SLICE-011.json"), filepath.Join(dir, "SLICE-012.json")); err != nil {
		t.Fatal(err)
	}
	args := p.PermissionArgs("SLICE-012")
	if widen := widenRules(args[1:indexOf(args, "--disallowedTools")]); len(widen) != 0 {
		t.Errorf("a linked work order: %q", widen)
	}
	// The Shape and needs conversations never widen a slice.
	for _, subject := range []string{"IDEA-001", interview.NeedsSubject} {
		args := p.PermissionArgs(subject)
		if widen := widenRules(args[1:indexOf(args, "--disallowedTools")]); len(widen) != 0 {
			t.Errorf("%s: widen rules %q", subject, widen)
		}
	}
}

func TestWideningIsDescribedInPlainWords(t *testing.T) {
	r := newRig(t)
	p := r.bridge.Paths()
	kind, text := p.Describe("Bash", map[string]any{"command": "python3 " + p.Scripts[0] + " slice widen SLICE-007 --by-rule actor"})
	if kind != "save" || text != "made this small change a full slice" {
		t.Fatalf("describe: %s %q", kind, text)
	}
}
