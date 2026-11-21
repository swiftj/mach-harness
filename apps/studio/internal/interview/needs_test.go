package interview_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"mach/studio/internal/interview"
	"mach/studio/internal/testkit"
)

// M17: the needs conversation is the interview's third, equally narrow mode, for the product as a
// whole. These tests hold its boundary as idea_test.go holds the Shape conversation's: what it may
// run and write, what is denied again, and that the slice interview and the Shape conversation reach
// none of it.

// needsActs are the product manager's acts on the needs and a design: never the conversation's.
var needsActs = []string{"need retire", "need publish", "reconcile", "design import", "design settle", "design publish"}

func needsRules(t *testing.T, p interview.Paths) (allow, deny []string) {
	t.Helper()
	args := p.PermissionArgs(interview.NeedsSubject)
	split := indexOf(args, "--disallowedTools")
	if args[0] != "--allowedTools" || split < 0 {
		t.Fatalf("args %q", args)
	}
	return args[1:split], args[split+1:]
}

func TestTheNeedsConversationMayOnlyReadRecordNeedsAndMapADesign(t *testing.T) {
	r := newRig(t)
	draft := testkit.Draft(r.project)
	for _, dir := range []string{"DES-01", "DES-03", "notes", "DES-1"} {
		os.MkdirAll(filepath.Join(draft, "product", "designs", dir), 0o755)
	}
	// A link that looks like a design is not one the conversation may map.
	os.Symlink(filepath.Join(draft, "product", "designs", "DES-01"), filepath.Join(draft, "product", "designs", "DES-09"))
	p := r.bridge.Paths()
	allow, deny := needsRules(t, p)
	var scripts, pythons []string
	for _, s := range p.Scripts {
		scripts = append(scripts, regexp.QuoteMeta(s))
	}
	for _, py := range p.Pythons {
		pythons = append(pythons, regexp.QuoteMeta(py))
	}
	input := p.DesignMapInput()
	if input != filepath.Join(r.project, ".factory", "studio", "interviews", "inputs", "needs.design-map.json") {
		t.Fatalf("the map input is %s", input)
	}
	if strings.HasPrefix(input, draft) {
		t.Fatal("the map input must not be inside the draft workspace, where the engine keeps its own map")
	}
	quoted := regexp.QuoteMeta(input)
	bash := regexp.MustCompile(`^Bash\((` + strings.Join(pythons, "|") + `) "?(` + strings.Join(scripts, "|") + `)"? ` +
		`(where|status|validate|refresh|need list|design list|principle list|policy list|` +
		`need add \*|need set \*|need none \*|design show \*|` +
		`design map (DES-01|DES-03) --from[ =](` + quoted + `|"` + quoted + `"))\)$`)
	counts := map[string]int{}
	for _, rule := range allow {
		switch {
		case rule == "Read" || rule == "Glob" || rule == "Grep":
		case rule == "Edit(/"+input+")":
			counts["edit"]++
		case bash.MatchString(rule):
			counts["bash"]++
		default:
			t.Errorf("unexpected allow rule %q", rule)
		}
		if strings.Contains(rule, "SLICE-") || strings.Contains(rule, "IDEA-") || strings.Contains(rule, " slice ") || strings.Contains(rule, " idea ") ||
			strings.Contains(rule, "/specs/") || strings.Contains(rule, "/briefs/") {
			t.Errorf("a slice or idea rule in the needs conversation: %s", rule)
		}
		if strings.Contains(rule, "DES-09") || strings.Contains(rule, "DES-1 ") || strings.Contains(rule, "notes") {
			t.Errorf("a design map rule for something that is not a design: %s", rule)
		}
		if strings.Contains(rule, "needs.json") {
			t.Errorf("the needs file is written only by the engine: %s", rule)
		}
		for _, act := range needsActs {
			if strings.Contains(rule, " "+act+" ") || strings.HasSuffix(rule, " "+act+")") {
				t.Errorf("an allow rule for the product manager's act %q: %s", act, rule)
			}
		}
		if strings.HasPrefix(rule, "Write(") || strings.Contains(rule, "Edit(.") || (strings.HasPrefix(rule, "Edit(") && strings.Contains(rule, "*")) {
			t.Errorf("a Write, relative or wildcard Edit rule: %s", rule)
		}
		if strings.Contains(rule, "design map") && strings.Contains(rule, "*") {
			t.Errorf("a wildcard design map rule: %s", rule)
		}
	}
	// 8 plain reads, 4 commands with their options, and design map for 2 designs in 4 spellings, for
	// 2 scripts x 2 spellings x each interpreter; exactly one file to edit.
	if counts["edit"] != 1 || counts["bash"] != (8+4+2*4)*2*2*len(p.Pythons) {
		t.Fatalf("counts %v with %d interpreters", counts, len(p.Pythons))
	}
	for _, op := range append(append([]string{}, needsActs...), "slice", "project", "epic", "principle add", "principle publish", "policy accept",
		"jira", "prd", "request", "idea", "brief", "case", "verdict", "lookback", "acceptance") {
		found := false
		for _, rule := range deny {
			if strings.HasSuffix(rule, " "+op+" *)") {
				found = true
			}
		}
		if !found {
			t.Errorf("no deny rule for %s", op)
		}
	}
	// A deny rule beats an allow rule, so none may cover what the conversation is allowed.
	for _, rule := range deny {
		for _, allowed := range []string{" need list)", " need add ", " need set ", " need none ", " design list)", " design show ", " design map ",
			" principle list)", " policy list)", " status)", " refresh)", " where)", " validate)"} {
			if strings.Contains(rule, allowed) {
				t.Errorf("deny rule %s would refuse what is allowed", rule)
			}
		}
	}
}

// Without a design in the workspace, the conversation can record no map at all.
func TestTheNeedsConversationMapsNothingWithoutADesign(t *testing.T) {
	r := newRig(t)
	allow, _ := needsRules(t, r.bridge.Paths())
	for _, rule := range allow {
		if strings.Contains(rule, "design map") {
			t.Errorf("a design map rule with no design brought in: %s", rule)
		}
	}
}

func TestTheSliceInterviewAndTheShapeConversationReachNoneOfTheNeeds(t *testing.T) {
	r := newRig(t)
	os.MkdirAll(testkit.Draft(r.project, "product", "designs", "DES-01"), 0o755)
	for _, subject := range []string{"SLICE-007", "IDEA-007"} {
		args := r.bridge.Paths().PermissionArgs(subject)
		split := indexOf(args, "--disallowedTools")
		allow, deny := args[1:split], args[split+1:]
		for _, rule := range allow {
			if regexp.MustCompile(` (need|design) `).MatchString(rule) || strings.Contains(rule, "DES-") || strings.Contains(rule, "design-map") {
				t.Errorf("%s may reach the needs: %s", subject, rule)
			}
		}
		for _, op := range []string{"need", "design"} {
			found := false
			for _, rule := range deny {
				if strings.HasSuffix(rule, " "+op+" *)") {
					found = true
				}
			}
			if !found {
				t.Errorf("no deny rule for %s in %s", op, subject)
			}
		}
	}
}

func TestTheNeedsCommandFollowsTheInstall(t *testing.T) {
	for continueCommand, want := range map[string]string{
		"/mach:product-studio continue": "/mach:product-studio needs",
		"/mach-product-studio continue": "/mach-product-studio needs",
		"/mach:product-studio":          "",
		"two words continue":            "",
		"":                              "",
	} {
		if got := interview.NeedsCommandOf(continueCommand); got != want {
			t.Errorf("NeedsCommandOf(%q) = %q, want %q", continueCommand, got, want)
		}
	}
}

func TestTheNeedsConversationRunsWithItsOwnRulesAndRecords(t *testing.T) {
	script := testkit.Script(t)
	needsFile := filepath.Join(".factory", "studio", "draft", "product", "needs.json")
	r := newRig(t,
		testkit.Turn{Text: "❓ **Q1** - **People**: Who uses it, how many, from where, and at what busiest moment?", Tools: []testkit.FakeTool{
			{ID: "toolu_1", Name: "Bash", Input: map[string]any{"command": `python3 "` + script + `" need list`}},
			{ID: "toolu_2", Name: "Bash", Input: map[string]any{"command": `python3 "` + script + `" need none --kind given`}, Write: needsFile},
			{ID: "toolu_3", Name: "Bash", Input: map[string]any{"command": `python3 "` + script + `" need publish`}, Denied: true},
		}},
	)
	os.MkdirAll(testkit.Draft(r.project, "product"), 0o755)
	started, err := r.bridge.Start(context.Background(), interview.StartRequest{Needs: true})
	if err != nil {
		t.Fatal(err)
	}
	if !started.Needs || started.SliceID != "" || started.IdeaID != "" {
		t.Fatalf("started %+v", started)
	}
	encoded, _ := json.Marshal(started)
	if strings.Contains(string(encoded), "slice_id") || strings.Contains(string(encoded), "idea_id") || !strings.Contains(string(encoded), `"needs":true`) {
		t.Fatalf("the needs conversation's answer: %s", encoded)
	}
	evs := until(t, r.bridge, started.InterviewID, 0, "waiting_for_reply")
	if d := dataOf(evs[0]); d["state"] != "starting" || d["needs"] != true || d["slice_id"] != nil || d["idea_id"] != nil {
		t.Fatalf("first event %v", d)
	}
	changed := find(evs, "draft_changed")
	if len(changed) != 1 || dataOf(changed[0])["needs"] != true || stringify(dataOf(changed[0])["what"]) != "[needs]" {
		t.Fatalf("draft_changed %v", names(evs))
	}
	var texts []string
	for _, a := range find(evs, "activity") {
		texts = append(texts, dataOf(a)["text"].(string))
	}
	if strings.Join(texts, "|") != "read the technical needs|recorded nothing to say about a kind|tried a Product Studio step that is not available here" {
		t.Fatalf("activities %q", texts)
	}
	calls := testkit.Calls(t, r.claude)
	p := r.bridge.Paths()
	first := calls[0].Argv
	session := first[indexOf(first, "--session-id")+1]
	want := p.Args(interview.NeedsSubject, interview.TurnOptions{BudgetUSD: 2, SessionID: session}, "/mach:product-studio needs. "+interview.NeedsOpeningNote)
	if strings.Join(first, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv\n got %q\nwant %q", first, want)
	}
	if note := first[indexOf(first, "--append-system-prompt")+1]; note != interview.NeedsHostNote(p.DesignMapInput()) || note == interview.HostNote {
		t.Fatalf("host note %q", note)
	}
	joined := strings.Join(first, " ")
	if !strings.Contains(joined, "Edit(/"+p.DesignMapInput()+")") || strings.Contains(joined, "/specs/slices/") || strings.Contains(joined, "/briefs/") {
		t.Fatal("the turn ran without the needs conversation's own rules")
	}
	// The session record names the needs and no slice or idea; the saved state answers by the needs.
	raw, err := os.ReadFile(filepath.Join(p.Home, "needs.json"))
	if err != nil || !strings.Contains(string(raw), `"needs": true`) || strings.Contains(string(raw), "slice_id") || strings.Contains(string(raw), "idea_id") {
		t.Fatalf("record %s %v", raw, err)
	}
	cur, _ := r.bridge.Current(interview.NeedsSubject)
	if cur == nil || !cur.Live || !cur.Needs || cur.SliceID != "" || cur.IdeaID != "" {
		t.Fatalf("current %+v", cur)
	}
	if none, _ := r.bridge.Current("IDEA-001"); none != nil {
		t.Fatalf("the needs conversation answers for an idea: %+v", none)
	}
	if events, _, err := r.bridge.History(interview.NeedsSubject); err != nil || len(events) == 0 {
		t.Fatalf("history %d %v", len(events), err)
	}
	if r.bridge.Busy(interview.NeedsSubject) {
		t.Fatal("busy after the turn")
	}
}

func TestWhatChangedNamesTheNeedsAndADesign(t *testing.T) {
	got := interview.WhatChanged([]string{"product/needs.json", "product/designs/DES-01/map.json", "product/ready/NEEDS/needs.json"})
	if strings.Join(got, ",") != "design,needs" {
		t.Fatalf("WhatChanged = %v", got)
	}
}
