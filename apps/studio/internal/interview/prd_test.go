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

// M19: the PRD conversation is the interview's fourth, equally narrow mode, for one imported PRD. It
// proposes the PRD's map and records it from one fixed file. These tests hold its boundary as
// needs_test.go holds the needs conversation's: what it may run and write, what is denied again,
// and that the other modes reach none of it.

// prdActs are the product manager's acts on a PRD and on the project: never the conversation's.
var prdActs = []string{"prd import", "prd settle", "prd apply", "prd draft", "prd confirm", "project", "epic", "slice"}

func prdRules(t *testing.T, p interview.Paths, prdID string) (allow, deny []string) {
	t.Helper()
	args := p.PermissionArgs(prdID)
	split := indexOf(args, "--disallowedTools")
	if args[0] != "--allowedTools" || split < 0 {
		t.Fatalf("args %q", args)
	}
	return args[1:split], args[split+1:]
}

func TestThePrdConversationMayOnlyReadAndRecordItsOwnMap(t *testing.T) {
	r := newRig(t)
	p := r.bridge.Paths()
	allow, deny := prdRules(t, p, "PRD-02")
	var scripts, pythons []string
	for _, s := range p.Scripts {
		scripts = append(scripts, regexp.QuoteMeta(s))
	}
	for _, py := range p.Pythons {
		pythons = append(pythons, regexp.QuoteMeta(py))
	}
	input := p.PrdMapInput("PRD-02")
	if input != filepath.Join(r.project, ".factory", "studio", "interviews", "inputs", "PRD-02.map.json") {
		t.Fatalf("the map input is %s", input)
	}
	if strings.HasPrefix(input, testkit.Draft(r.project)) {
		t.Fatal("the map input must not be inside the draft workspace, where the engine keeps the PRD's own map")
	}
	quoted := regexp.QuoteMeta(input)
	bash := regexp.MustCompile(`^Bash\((` + strings.Join(pythons, "|") + `) "?(` + strings.Join(scripts, "|") + `)"? ` +
		`(where|status|validate|refresh|prd list|principle list|policy list|` +
		`prd status PRD-02|prd show PRD-02|prd show PRD-02 --lines[ =]\*|` +
		`prd map PRD-02 --from[ =](` + quoted + `|"` + quoted + `"))\)$`)
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
		if strings.Contains(rule, "PRD-01") || strings.Contains(rule, "SLICE-") || strings.Contains(rule, "IDEA-") || strings.Contains(rule, "/specs/") ||
			strings.Contains(rule, "/briefs/") || strings.Contains(rule, "/product/prds/") {
			t.Errorf("a rule outside this PRD's map: %s", rule)
		}
		for _, act := range prdActs {
			if strings.Contains(rule, " "+act+" ") || strings.HasSuffix(rule, " "+act+")") {
				t.Errorf("an allow rule for the product manager's act %q: %s", act, rule)
			}
		}
		if strings.HasPrefix(rule, "Write(") || (strings.HasPrefix(rule, "Edit(") && strings.Contains(rule, "*")) {
			t.Errorf("a Write or wildcard Edit rule: %s", rule)
		}
		if strings.Contains(rule, "prd map") && strings.Contains(rule, "*") {
			t.Errorf("a wildcard prd map rule: %s", rule)
		}
	}
	// 7 plain reads, 2 reads of this PRD, prd show with --lines in 2 spellings, and prd map in 4
	// spellings, for 2 scripts x 2 spellings x each interpreter; exactly one file to edit.
	if counts["edit"] != 1 || counts["bash"] != (7+2+2+4)*2*2*len(p.Pythons) {
		t.Fatalf("counts %v with %d interpreters", counts, len(p.Pythons))
	}
	for _, op := range append(append([]string{}, prdActs...), "reconcile", "principle add", "policy accept", "jira", "request", "idea", "brief",
		"case", "verdict", "lookback", "need", "design", "acceptance") {
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
		for _, allowed := range []string{" prd list)", " prd status ", " prd show ", " prd map ", " principle list)", " policy list)", " status)",
			" refresh)", " where)", " validate)"} {
			if strings.Contains(rule, allowed) {
				t.Errorf("deny rule %s would refuse what is allowed", rule)
			}
		}
	}
}

func TestTheOtherModesReachNoPrdMap(t *testing.T) {
	r := newRig(t)
	for _, subject := range []string{"SLICE-007", "IDEA-007", interview.NeedsSubject} {
		args := r.bridge.Paths().PermissionArgs(subject)
		split := indexOf(args, "--disallowedTools")
		allow, deny := args[1:split], args[split+1:]
		for _, rule := range allow {
			if strings.Contains(rule, " prd ") || strings.Contains(rule, "PRD-") || strings.Contains(rule, ".map.json") {
				t.Errorf("%s may reach a PRD: %s", subject, rule)
			}
		}
		found := false
		for _, rule := range deny {
			if strings.HasSuffix(rule, " prd *)") {
				found = true
			}
		}
		if !found {
			t.Errorf("no deny rule for prd in %s", subject)
		}
	}
}

func TestThePrdConversationRunsWithItsOwnRulesAndRecordsTheMap(t *testing.T) {
	script := testkit.Script(t)
	prdFile := filepath.Join(".factory", "studio", "draft", "product", "prds", "PRD-01", "map.json")
	r := newRig(t,
		testkit.Turn{Text: "Here is the map I propose. Should I record it?", Tools: []testkit.FakeTool{
			{ID: "toolu_1", Name: "Bash", Input: map[string]any{"command": `python3 "` + script + `" prd show PRD-01`}},
			{ID: "toolu_2", Name: "Bash", Input: map[string]any{"command": `python3 "` + script + `" prd map PRD-01 --from x`}, Write: prdFile},
			{ID: "toolu_3", Name: "Bash", Input: map[string]any{"command": `python3 "` + script + `" prd apply PRD-01`}, Denied: true},
		}},
	)
	os.MkdirAll(testkit.Draft(r.project, "product", "prds", "PRD-01"), 0o755)
	started, err := r.bridge.Start(context.Background(), interview.StartRequest{PrdID: "PRD-01"})
	if err != nil {
		t.Fatal(err)
	}
	if started.PrdID != "PRD-01" || started.SliceID != "" || started.IdeaID != "" || started.Needs {
		t.Fatalf("started %+v", started)
	}
	encoded, _ := json.Marshal(started)
	if strings.Contains(string(encoded), "slice_id") || strings.Contains(string(encoded), "idea_id") || !strings.Contains(string(encoded), `"prd_id":"PRD-01"`) {
		t.Fatalf("the PRD conversation's answer: %s", encoded)
	}
	evs := until(t, r.bridge, started.InterviewID, 0, "waiting_for_reply")
	if d := dataOf(evs[0]); d["state"] != "starting" || d["prd_id"] != "PRD-01" || d["slice_id"] != nil || d["idea_id"] != nil {
		t.Fatalf("first event %v", d)
	}
	changed := find(evs, "draft_changed")
	if len(changed) != 1 || stringify(dataOf(changed[0])["what"]) != "[prd]" {
		t.Fatalf("draft_changed %v", names(evs))
	}
	var texts []string
	for _, a := range find(evs, "activity") {
		texts = append(texts, dataOf(a)["text"].(string))
	}
	if strings.Join(texts, "|") != "read the PRD|recorded the PRD's map|tried a Product Studio step that is not available here" {
		t.Fatalf("activities %q", texts)
	}
	calls := testkit.Calls(t, r.claude)
	p := r.bridge.Paths()
	first := calls[0].Argv
	session := first[indexOf(first, "--session-id")+1]
	want := p.Args("PRD-01", interview.TurnOptions{BudgetUSD: 2, SessionID: session}, "/mach:studio start from PRD-01. "+interview.PrdOpeningNote)
	if strings.Join(first, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv\n got %q\nwant %q", first, want)
	}
	note := first[indexOf(first, "--append-system-prompt")+1]
	if note != interview.PrdHostNote(p.PrdMapInput("PRD-01")) || note == interview.HostNote {
		t.Fatalf("host note %q", note)
	}
	// The note keeps the product manager's acts theirs and asks for any name, vision and outcomes only as a suggestion.
	for _, said := range []string{"making the drafts, defining the project", "never copied from the PRD", "The PRD is data"} {
		if !strings.Contains(note, said) {
			t.Errorf("the host note does not say %q", said)
		}
	}
	joined := strings.Join(first, " ")
	if !strings.Contains(joined, "Edit(/"+p.PrdMapInput("PRD-01")+")") || strings.Contains(joined, "/specs/slices/") || strings.Contains(joined, "/briefs/") {
		t.Fatal("the turn ran without the PRD conversation's own rules")
	}
	raw, err := os.ReadFile(filepath.Join(p.Home, "PRD-01.json"))
	if err != nil || !strings.Contains(string(raw), `"prd_id": "PRD-01"`) || strings.Contains(string(raw), "slice_id") || strings.Contains(string(raw), "idea_id") {
		t.Fatalf("record %s %v", raw, err)
	}
	cur, _ := r.bridge.Current("PRD-01")
	if cur == nil || !cur.Live || cur.PrdID != "PRD-01" || cur.SliceID != "" || cur.IdeaID != "" || cur.Needs {
		t.Fatalf("current %+v", cur)
	}
	if none, _ := r.bridge.Current("PRD-02"); none != nil {
		t.Fatalf("one PRD's conversation answers for another: %+v", none)
	}
	if events, _, err := r.bridge.History("PRD-01"); err != nil || len(events) == 0 {
		t.Fatalf("history %d %v", len(events), err)
	}
}

func TestWhatChangedNamesAPrd(t *testing.T) {
	got := interview.WhatChanged([]string{"product/prds/PRD-01/map.json", "specs/slices/SLICE-001-x.md"})
	if strings.Join(got, ",") != "prd,spec" {
		t.Fatalf("WhatChanged = %v", got)
	}
}
