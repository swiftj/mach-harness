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

// M16: the Shape conversation is the interview's second, equally narrow mode, for exactly one idea.
// These tests hold its boundary: what it may run and write, what is denied again, and that the
// slice interview reaches none of Shape.

// shapeActs are every Shape command that changes something on the product manager's word, and the
// stage set by hand: never the conversation's.
var shapeActs = []string{"idea add", "idea stage", "idea renumber", "idea publish", "idea size", "idea map", "idea settle", "idea apply",
	"idea change", "verdict", "lookback"}

func TestTheIdeaConversationMayOnlyReadLookUpAndWriteItsOwnBriefAndCase(t *testing.T) {
	r := newRig(t)
	p := r.bridge.Paths()
	args := p.PermissionArgs("IDEA-007")
	split := indexOf(args, "--disallowedTools")
	if args[0] != "--allowedTools" || split < 0 {
		t.Fatalf("args %q", args)
	}
	allow, deny := args[1:split], args[split+1:]
	var scripts, pythons []string
	for _, s := range p.Scripts {
		scripts = append(scripts, regexp.QuoteMeta(s))
	}
	for _, py := range p.Pythons {
		pythons = append(pythons, regexp.QuoteMeta(py))
	}
	input := p.LookupsInput("IDEA-007")
	if input != filepath.Join(r.project, ".factory", "studio", "interviews", "inputs", "IDEA-007.lookups.json") {
		t.Fatalf("the lookups input is %s", input)
	}
	draft := testkit.Draft(r.project)
	if strings.HasPrefix(input, draft) {
		t.Fatal("the lookups input must not be inside the draft workspace, where the engine keeps its own lookups")
	}
	quoted := regexp.QuoteMeta(input)
	bash := regexp.MustCompile(`^Bash\((` + strings.Join(pythons, "|") + `) "?(` + strings.Join(scripts, "|") + `)"? ` +
		`(where|status|validate|refresh|idea list|request list|principle list|policy list|epic current \*|` +
		`idea show IDEA-007|brief show IDEA-007|brief check IDEA-007|case show IDEA-007|case check IDEA-007|` +
		`idea lookups IDEA-007 --from[ =](` + quoted + `|"` + quoted + `"))\)$`)
	edits := map[string]bool{
		"Edit(/" + draft + "/product/briefs/IDEA-007.md)":      true,
		"Edit(/" + draft + "/product/briefs/IDEA-007.case.md)": true,
		"Edit(/" + input + ")":                                 true,
	}
	counts := map[string]int{}
	for _, rule := range allow {
		switch {
		case rule == "Read" || rule == "Glob" || rule == "Grep":
		case edits[rule]:
			counts["edit"]++
		case bash.MatchString(rule):
			counts["bash"]++
		default:
			t.Errorf("unexpected allow rule %q", rule)
		}
		if strings.Contains(rule, "SLICE-") || strings.Contains(rule, " slice ") || strings.Contains(rule, "/specs/") || strings.Contains(rule, "/intents/") {
			t.Errorf("a slice rule in the idea conversation: %s", rule)
		}
		if regexp.MustCompile(`IDEA-[0-9]+`).FindString(strings.ReplaceAll(rule, "IDEA-007", "")) != "" {
			t.Errorf("a rule for another idea: %s", rule)
		}
		for _, act := range shapeActs {
			if strings.Contains(rule, " "+act+" ") || strings.HasSuffix(rule, " "+act+")") {
				t.Errorf("an allow rule for the product manager's act %q: %s", act, rule)
			}
		}
		if strings.HasPrefix(rule, "Write(") || strings.Contains(rule, "Edit(.") || (strings.HasPrefix(rule, "Edit(") && strings.Contains(rule, "*")) {
			t.Errorf("a Write, relative or wildcard Edit rule: %s", rule)
		}
	}
	// 8 plain reads, epic current, 5 reads and checks of its own idea, and idea lookups in 4 spellings,
	// for 2 scripts x 2 spellings x each interpreter; exactly three files to edit.
	if counts["edit"] != 3 || counts["bash"] != (8+1+5+4)*2*2*len(p.Pythons) {
		t.Fatalf("counts %v with %d interpreters", counts, len(p.Pythons))
	}
	for _, op := range append(append([]string{}, shapeActs...), "idea map-status", "idea chain", "slice", "reconcile", "project", "epic add",
		"epic set", "principle add", "principle publish", "policy accept", "jira", "prd", "request pick", "request met", "acceptance") {
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
		for _, allowed := range []string{" idea show ", " idea list)", " brief check ", " brief show ", " case show ", " case check ", " idea lookups ",
			" principle list)", " policy list)", " request list)", " epic current "} {
			if strings.Contains(rule, allowed) {
				t.Errorf("deny rule %s would refuse what is allowed", rule)
			}
		}
	}
}

func TestTheSliceInterviewReachesNoneOfShape(t *testing.T) {
	r := newRig(t)
	args := r.bridge.Paths().PermissionArgs("SLICE-007")
	split := indexOf(args, "--disallowedTools")
	allow, deny := args[1:split], args[split+1:]
	for _, rule := range allow {
		if strings.Contains(rule, "IDEA-") || strings.Contains(rule, "/briefs/") || strings.Contains(rule, "/inputs/") ||
			regexp.MustCompile(` (idea|brief|case|verdict|lookback) `).MatchString(rule) {
			t.Errorf("the slice interview may reach Shape: %s", rule)
		}
	}
	for _, op := range []string{"idea", "brief", "case", "verdict", "lookback"} {
		found := false
		for _, rule := range deny {
			if strings.HasSuffix(rule, " "+op+" *)") {
				found = true
			}
		}
		if !found {
			t.Errorf("no deny rule for %s in the slice interview", op)
		}
	}
}

func TestAnIdeaConversationRunsWithItsOwnRulesAndRecords(t *testing.T) {
	script := testkit.Script(t)
	brief := filepath.Join(".factory", "studio", "draft", "product", "briefs", "IDEA-001.md")
	r := newRig(t,
		testkit.Turn{Text: "❓ **Q1** - **The problem**: What happens today that you would like to be different?", Tools: []testkit.FakeTool{
			{ID: "toolu_1", Name: "Bash", Input: map[string]any{"command": `python3 "` + script + `" idea show IDEA-001`}},
			{ID: "toolu_2", Name: "Write", Input: map[string]any{"file_path": "/x/product/briefs/IDEA-001.md"}, Write: brief},
			{ID: "toolu_3", Name: "Bash", Input: map[string]any{"command": `python3 "` + script + `" verdict record IDEA-001 --decision go --reason yes`}, Denied: true},
		}},
	)
	os.MkdirAll(testkit.Draft(r.project, "product", "briefs"), 0o755)
	started, err := r.bridge.Start(context.Background(), interview.StartRequest{IdeaID: "IDEA-001"})
	if err != nil {
		t.Fatal(err)
	}
	if started.IdeaID != "IDEA-001" || started.SliceID != "" {
		t.Fatalf("started %+v", started)
	}
	encoded, _ := json.Marshal(started)
	if strings.Contains(string(encoded), "slice_id") {
		t.Fatalf("an idea's answer names a slice: %s", encoded)
	}
	evs := until(t, r.bridge, started.InterviewID, 0, "waiting_for_reply")
	if d := dataOf(evs[0]); d["state"] != "starting" || d["idea_id"] != "IDEA-001" || d["slice_id"] != nil {
		t.Fatalf("first event %v", d)
	}
	changed := find(evs, "draft_changed")
	if len(changed) != 1 || dataOf(changed[0])["idea_id"] != "IDEA-001" || stringify(dataOf(changed[0])["what"]) != "[brief]" {
		t.Fatalf("draft_changed %v", names(evs))
	}
	var texts []string
	for _, a := range find(evs, "activity") {
		texts = append(texts, dataOf(a)["text"].(string))
	}
	if strings.Join(texts, "|") != "read the idea|wrote the brief|tried a Product Studio step that is not available here" {
		t.Fatalf("activities %q", texts)
	}
	calls := testkit.Calls(t, r.claude)
	p := r.bridge.Paths()
	first := calls[0].Argv
	session := first[indexOf(first, "--session-id")+1]
	want := p.Args("IDEA-001", interview.TurnOptions{BudgetUSD: 2, SessionID: session}, "/mach:product-studio explore IDEA-001. "+interview.IdeaOpeningNote)
	if strings.Join(first, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv\n got %q\nwant %q", first, want)
	}
	if note := first[indexOf(first, "--append-system-prompt")+1]; note != interview.IdeaHostNote(p.LookupsInput("IDEA-001")) || note == interview.HostNote {
		t.Fatalf("host note %q", note)
	}
	if !strings.Contains(strings.Join(first, " "), "Edit(/"+testkit.Draft(r.project)+"/product/briefs/IDEA-001.md)") ||
		strings.Contains(strings.Join(first, " "), "/specs/slices/") {
		t.Fatal("the turn ran without the idea's own rules")
	}
	if info, err := os.Stat(p.Inputs); err != nil || !info.IsDir() {
		t.Fatalf("the inputs folder was not made: %v", err)
	}
	// The session record names the idea and no slice; the saved state answers by the idea.
	raw, err := os.ReadFile(filepath.Join(p.Home, "IDEA-001.json"))
	if err != nil || !strings.Contains(string(raw), `"idea_id": "IDEA-001"`) || strings.Contains(string(raw), "slice_id") {
		t.Fatalf("record %s %v", raw, err)
	}
	cur, _ := r.bridge.Current("IDEA-001")
	if cur == nil || !cur.Live || cur.IdeaID != "IDEA-001" || cur.SliceID != "" {
		t.Fatalf("current %+v", cur)
	}
	if none, _ := r.bridge.Current("SLICE-001"); none != nil {
		t.Fatalf("the idea's conversation answers for a slice: %+v", none)
	}
	if events, _, err := r.bridge.History("IDEA-001"); err != nil || len(events) == 0 {
		t.Fatalf("history %d %v", len(events), err)
	}
	if r.bridge.Busy("IDEA-001") {
		t.Fatal("busy after the turn")
	}
}
