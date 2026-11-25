package engine_test

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"mach/studio/internal/engine"
)

// The contract's section 3, plus slice.show. Nothing else may be reachable.
func TestAllowlistIsExactlyTheContract(t *testing.T) {
	want := []string{
		"brief.check", "brief.show", "case.check", "case.show",
		"design.import", "design.list", "design.publish", "design.settle", "design.show",
		"epic.add", "epic.current", "epic.link", "epic.renumber", "epic.set",
		"idea.add", "idea.apply", "idea.chain", "idea.change", "idea.faults", "idea.list", "idea.lookups", "idea.map", "idea.map-status", "idea.publish",
		"idea.renumber", "idea.settle", "idea.show", "idea.size", "idea.stage",
		"jira.export", "jira.keys", "lookback.record",
		"need.add", "need.list", "need.none", "need.publish", "need.retire", "need.set",
		"policy.accept", "policy.list",
		"prd.apply", "prd.confirm", "prd.draft", "prd.import", "prd.list", "prd.map", "prd.settle", "prd.show", "prd.status",
		"principle.add", "principle.list", "principle.publish", "principle.retire", "principle.set",
		"project.close-issue", "project.export", "project.import", "project.import.abandon", "project.imports", "project.imports.ready", "project.init", "project.join", "project.set",
		"reconcile", "reconcile.needs", "reconcile.principles", "refresh", "request.link", "request.list", "request.met", "request.pick", "request.show",
		"slice.check", "slice.link", "slice.mock.add", "slice.mock.list", "slice.mock.remove", "slice.move", "slice.new", "slice.pause", "slice.ready",
		"slice.renumber", "slice.reopen", "slice.resume", "slice.set", "slice.show", "slice.take", "slice.widen", "status", "validate", "verdict.record", "where",
	}
	if got := engine.Names(); !reflect.DeepEqual(got, want) {
		t.Fatalf("allowlist\n got %v\nwant %v", got, want)
	}
	// M15: reads that change nothing on disk.
	for _, name := range []string{"epic.current", "policy.list", "prd.list", "prd.show", "prd.status", "slice.mock.list"} {
		if op, _ := engine.Lookup(name); !op.ReadOnly || op.Network {
			t.Errorf("%s should be read-only and local", name)
		}
	}
	// Publishing the principles writes the project's GitHub issue; choosing a version of them reads GitHub's.
	// Closing an extra project issue writes GitHub too.
	for _, name := range []string{"principle.publish", "reconcile.principles", "project.close-issue", "project.join"} {
		if op, _ := engine.Lookup(name); !op.Network || op.ReadOnly {
			t.Errorf("%s reaches GitHub and changes the workspace", name)
		}
	}
	// Only the export offers files back; only the operations that carry a file take a larger body.
	for _, name := range engine.Names() {
		op, _ := engine.Lookup(name)
		if op.Download != (name == "jira.export" || name == "project.export") {
			t.Errorf("%s: Download is %v", name, op.Download)
		}
		if name == "project.import" {
			continue // M21 F: a project file, kept between requests (ops_move_test.go)
		}
		_, file := op.New().(engine.FileArgs)
		carries := map[string]bool{"jira.keys": true, "prd.import": true, "prd.map": true, "prd.draft": true, "slice.mock.add": true,
			"idea.lookups": true, "idea.map": true, "design.import": true}[name]
		if file != carries || (op.BodyLimit() > engine.MaxBodyBytes) != carries {
			t.Errorf("%s: carries a file %v, body limit %d", name, file, op.BodyLimit())
		}
		if op.BodyLimit() > 12<<20 {
			t.Errorf("%s: body limit %d is more than any file it carries needs", name, op.BodyLimit())
		}
	}
	// M16: Shape's reads; publishing an idea, recording a verdict (the signed-in login) and a look back
	// (a comment on the idea's issue) reach GitHub; every other Shape act stays on this computer.
	for _, name := range []string{"idea.list", "idea.faults", "idea.show", "idea.map-status", "idea.chain", "brief.show", "case.show", "case.check"} {
		if op, _ := engine.Lookup(name); !op.ReadOnly || op.Network {
			t.Errorf("%s should be read-only and local", name)
		}
	}
	for _, name := range []string{"idea.publish", "verdict.record", "lookback.record"} {
		if op, _ := engine.Lookup(name); !op.Network || op.ReadOnly {
			t.Errorf("%s reaches GitHub and changes the workspace", name)
		}
	}
	for _, name := range []string{"idea.add", "idea.stage", "idea.lookups", "idea.renumber", "idea.size", "idea.map", "idea.settle", "idea.apply", "idea.change", "brief.check"} {
		if op, _ := engine.Lookup(name); op.Network || op.ReadOnly {
			t.Errorf("%s changes the workspace and never reaches GitHub", name)
		}
	}
	// M17: the needs' and designs' reads; publishing the needs writes the project's GitHub issue and
	// choosing a version of them reads GitHub's; every other act stays on this computer (a design is
	// never sent to GitHub).
	for _, name := range []string{"need.list", "design.list", "design.show"} {
		if op, _ := engine.Lookup(name); !op.ReadOnly || op.Network {
			t.Errorf("%s should be read-only and local", name)
		}
	}
	for _, name := range []string{"need.publish", "reconcile.needs"} {
		if op, _ := engine.Lookup(name); !op.Network || op.ReadOnly {
			t.Errorf("%s reaches GitHub and changes the workspace", name)
		}
	}
	for _, name := range []string{"need.add", "need.set", "need.retire", "need.none", "design.import", "design.settle", "design.publish"} {
		if op, _ := engine.Lookup(name); op.Network || op.ReadOnly {
			t.Errorf("%s changes the workspace and never reaches GitHub", name)
		}
	}
	// The needs conversation records a design's map; no person's button does.
	if _, ok := engine.Lookup("design.map"); ok {
		t.Errorf("design.map is reachable as an operation")
	}
	for _, name := range []string{"request.list", "request.show", "slice.show", "where"} {
		if op, _ := engine.Lookup(name); !op.ReadOnly {
			t.Errorf("%s should be read-only", name)
		}
	}
	for _, name := range []string{"slice.check", "validate"} {
		if op, _ := engine.Lookup(name); !op.JSONOnFailure {
			t.Errorf("%s reports problems as JSON with exit code 1", name)
		}
	}
	// Reaching GitHub: marking ready, reopening, taking a version, picking up a request (a live
	// re-read) and marking it as met (closing the issue).
	for _, name := range []string{"slice.ready", "slice.reopen", "slice.move", "slice.take", "reconcile", "request.pick", "request.met"} {
		if op, _ := engine.Lookup(name); !op.Network || op.ReadOnly {
			t.Errorf("%s reaches GitHub and changes the workspace", name)
		}
	}
	if op, _ := engine.Lookup("request.link"); op.Network || op.ReadOnly {
		t.Errorf("request.link changes only the draft and never reaches GitHub")
	}
}

// Commands the app never offers: the removed slice approve, waves, send and feedback, and acceptance
// record, which stays a terminal command. None is reachable by name, and no operation's argument
// vector starts with one, whatever its arguments.
func TestCommandsTheAppNeverOffersAreUnreachable(t *testing.T) {
	for _, name := range []string{"slice.approve", "wave.new", "wave.add", "wave.remove", "wave.approve", "wave.renumber",
		"send", "send.preview", "feedback", "acceptance.record", "acceptance.show", "acceptance"} {
		if _, ok := engine.Lookup(name); ok {
			t.Errorf("%s is reachable", name)
		}
	}
	offered := func(argv []string) bool {
		if len(argv) == 0 {
			return false
		}
		switch argv[0] {
		case "wave", "send", "feedback", "acceptance":
			return true
		}
		return len(argv) > 1 && (argv[0] == "slice" || argv[0] == "epic") && argv[1] == "approve"
	}
	bodies := []string{`{}`, `{"slice_id":"SLICE-001"}`, `{"slice_id":"SLICE-001","first":true}`, `{"issue":41}`, `{"slice_id":"SLICE-001","take":"mine"}`, `{"identifier":"SLICE-001"}`,
		`{"identifier":"EPIC-001"}`, `{"epic_id":"EPIC-001"}`, `{"number":42}`, `{"number":42,"slice_id":"SLICE-001"}`}
	for _, name := range engine.Names() {
		for _, body := range bodies {
			got, err := argv(t, name, body)
			if err == nil && offered(got) {
				t.Errorf("%s %s reaches a command the app never offers: %q", name, body, got)
			}
		}
	}
	// The slice form of reconcile: a slice ID, never a path, a wave or a field.
	for _, body := range []string{`{"artifact":"product/project.json","take":"mine"}`, `{"slice_id":"WAVE-001","take":"mine"}`,
		`{"slice_id":"SLICE-001","take":"mine","field":"title"}`} {
		if _, err := argv(t, "reconcile", body); err == nil {
			t.Errorf("reconcile %s was accepted", body)
		}
	}
}

func argv(t *testing.T, name, body string) ([]string, error) {
	t.Helper()
	op, ok := engine.Lookup(name)
	if !ok {
		t.Fatalf("no operation %s", name)
	}
	args := op.New()
	if err := engine.Decode([]byte(body), args); err != nil {
		return nil, err
	}
	// An operation that carries a file: the engine stages it first (security.StageUpload); here the
	// staged copy is a fixed path, so the vector can be compared.
	if files, ok := args.(engine.FileArgs); ok {
		name, _, err := files.Staged()
		if err != nil {
			return nil, err
		}
		files.SetPath("/staged/" + name)
	}
	// M21 F: a project file is kept between the plan and the import (security.KeepIncoming).
	if imported, ok := args.(*engine.ProjectImportArgs); ok {
		if err := engine.StageImportForTest(imported, "/kept/project.zip"); err != nil {
			return nil, err
		}
	}
	return args.Argv()
}

// studioCommands are the first words of the engine's own commands the host may run.
var studioCommands = map[string]bool{"where": true, "status": true, "validate": true, "refresh": true, "project": true, "epic": true, "slice": true,
	"reconcile": true, "request": true, "principle": true, "policy": true, "jira": true, "prd": true,
	"idea": true, "brief": true, "case": true, "verdict": true, "lookback": true, "need": true, "design": true}

// Every operation's JSON arguments become one fixed vector, options always in --name=value form.
func TestEveryOperationsArgumentVector(t *testing.T) {
	cases := []struct {
		op, body string
		want     []string
	}{
		{"where", ``, []string{"where"}},
		{"status", `{}`, []string{"status"}},
		{"validate", `{}`, []string{"validate"}},
		{"refresh", `{}`, []string{"refresh"}},
		{"project.init", `{"id":"team-space","name":"Team Space","vision":"Teams work.","outcome":["One","Two"]}`,
			[]string{"project", "init", "--id=team-space", "--name=Team Space", "--vision=Teams work.", "--outcome=One", "--outcome=Two"}},
		{"project.set", `{}`, []string{"project", "set"}},
		{"project.close-issue", `{"number":9}`, []string{"project", "close-issue", "9"}},
		{"project.join", `{}`, []string{"project", "join"}},
		{"project.join", `{"batch":4}`, []string{"project", "join", "--batch", "4"}},
		{"project.set", `{"name":"N","vision":"V","outcome":["O"],"status":"active"}`,
			[]string{"project", "set", "--name=N", "--vision=V", "--outcome=O", "--status=active"}},
		{"epic.add", `{"title":"Team membership","criterion":["Only invited people can join"]}`,
			[]string{"epic", "add", "--title=Team membership", "--criterion=Only invited people can join"}},
		{"epic.set", `{"epic_id":"EPIC-001","title":"T","criterion":["a","b"],"status":"deferred"}`,
			[]string{"epic", "set", "EPIC-001", "--title=T", "--criterion=a", "--criterion=b", "--status=deferred"}},
		{"epic.renumber", `{"identifier":"EPIC-002"}`, []string{"epic", "renumber", "EPIC-002"}},
		{"slice.new", `{"epic":"EPIC-001","title":"Invite","depends_on":["SLICE-001"],"id":"SLICE-004"}`,
			[]string{"slice", "new", "--epic=EPIC-001", "--title=Invite", "--depends-on=SLICE-001", "--id=SLICE-004"}},
		{"slice.new", `{"epic":"EPIC-001","title":"-rf looks like an option"}`,
			[]string{"slice", "new", "--epic=EPIC-001", "--title=-rf looks like an option"}},
		{"slice.set", `{"slice_id":"SLICE-001","title":"T","epic":"EPIC-002","depends_on":["SLICE-002","SLICE-003"]}`,
			[]string{"slice", "set", "SLICE-001", "--title=T", "--epic=EPIC-002", "--depends-on=SLICE-002", "--depends-on=SLICE-003"}},
		{"slice.set", `{"slice_id":"SLICE-001","depends_on":[]}`, []string{"slice", "set", "SLICE-001", "--depends-on=none"}},
		{"slice.set", `{"slice_id":"SLICE-001"}`, []string{"slice", "set", "SLICE-001"}},
		{"slice.resume", `{}`, []string{"slice", "resume"}},
		{"slice.resume", `{"slice_id":"SLICE-001"}`, []string{"slice", "resume", "SLICE-001"}},
		{"slice.pause", `{"slice_id":"SLICE-001","note":"Next: expiry?"}`, []string{"slice", "pause", "SLICE-001", "--note=Next: expiry?"}},
		{"slice.check", `{"slice_id":"SLICE-001"}`, []string{"slice", "check", "SLICE-001"}},
		{"slice.check", `{"slice_id":"SLICE-001","ready":true}`, []string{"slice", "check", "SLICE-001", "--ready"}},
		{"slice.show", `{"slice_id":"SLICE-001"}`, []string{"slice", "show", "SLICE-001"}},
		{"slice.ready", `{"slice_id":"SLICE-001"}`, []string{"slice", "ready", "SLICE-001"}},
		{"slice.move", `{"slice_id":"SLICE-003","before":"SLICE-002"}`, []string{"slice", "move", "SLICE-003", "--before=SLICE-002"}},
		{"slice.move", `{"slice_id":"SLICE-003","after":"SLICE-004"}`, []string{"slice", "move", "SLICE-003", "--after=SLICE-004"}},
		{"slice.move", `{"slice_id":"SLICE-003","first":true}`, []string{"slice", "move", "SLICE-003", "--first"}},
		{"slice.move", `{"slice_id":"SLICE-003","last":true}`, []string{"slice", "move", "SLICE-003", "--last"}},
		{"slice.take", `{"issue":41}`, []string{"slice", "take", "41"}},
		{"slice.take", `{"slice_id":"SLICE-007"}`, []string{"slice", "take", "SLICE-007"}},
		{"slice.reopen", `{"slice_id":"SLICE-001"}`, []string{"slice", "reopen", "SLICE-001"}},
		{"slice.renumber", `{"identifier":"SLICE-002"}`, []string{"slice", "renumber", "SLICE-002"}},
		{"reconcile", `{"slice_id":"SLICE-001","take":"mine"}`, []string{"reconcile", "SLICE-001", "--take=mine"}},
		{"reconcile", `{"slice_id":"SLICE-002","take":"theirs"}`, []string{"reconcile", "SLICE-002", "--take=theirs"}},
		{"reconcile", `{"target":"project","take":"mine"}`, []string{"reconcile", "project", "--take=mine"}},
		{"reconcile", `{"target":"EPIC-002","take":"theirs"}`, []string{"reconcile", "EPIC-002", "--take=theirs"}},
		{"request.list", `{}`, []string{"request", "list"}},
		{"request.show", `{"number":42}`, []string{"request", "show", "42"}},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":"Export a report"}`,
			[]string{"request", "pick", "42", "--epic=EPIC-001", "--title=Export a report"}},
		{"request.link", `{"number":42,"slice_id":"SLICE-003"}`, []string{"request", "link", "42", "SLICE-003"}},
		{"request.met", `{"number":42}`, []string{"request", "met", "42"}},
		// M15: the M13 and M14 operations.
		{"principle.list", `{}`, []string{"principle", "list"}},
		{"principle.add", `{"title":"Versions stay","statement":"A published version MUST NOT be edited in place.","reason":"Readers rely on it."}`,
			[]string{"principle", "add", "--title=Versions stay", "--statement=A published version MUST NOT be edited in place.", "--reason=Readers rely on it."}},
		{"principle.set", `{"principle_id":"PP-01","statement":"--title=x MUST hold."}`, []string{"principle", "set", "PP-01", "--statement=--title=x MUST hold."}},
		{"principle.set", `{"principle_id":"PP-02","title":"T","reason":"R"}`, []string{"principle", "set", "PP-02", "--title=T", "--reason=R"}},
		{"principle.retire", `{"principle_id":"PP-03"}`, []string{"principle", "retire", "PP-03"}},
		{"principle.publish", `{}`, []string{"principle", "publish"}},
		{"reconcile.principles", `{"take":"theirs"}`, []string{"reconcile", "principles", "--take=theirs"}},
		{"policy.list", ``, []string{"policy", "list"}},
		{"policy.accept", `{"slice_id":"SLICE-002","policy_id":"POL-privacy-02","by":"Data protection officer","reason":"The provider signed the EU clauses."}`,
			[]string{"policy", "accept", "SLICE-002", "POL-privacy-02", "--by=Data protection officer", "--reason=The provider signed the EU clauses."}},
		{"epic.current", `{"epic_id":"EPIC-001"}`, []string{"epic", "current", "EPIC-001", "--json"}},
		{"epic.current", `{"issue":12}`, []string{"epic", "current", "12", "--json"}},
		{"epic.link", `{"epic_id":"EPIC-001","jira":"ABC-1"}`, []string{"epic", "link", "EPIC-001", "--jira=ABC-1"}},
		{"epic.link", `{"epic_id":"EPIC-001","remove":true}`, []string{"epic", "link", "EPIC-001", "--no-jira"}},
		{"slice.link", `{"slice_id":"SLICE-001","jira":"TEAM_2-123"}`, []string{"slice", "link", "SLICE-001", "--jira=TEAM_2-123"}},
		{"slice.link", `{"slice_id":"SLICE-001","remove":true}`, []string{"slice", "link", "SLICE-001", "--no-jira"}},
		{"jira.export", `{}`, []string{"jira", "export"}},
		{"jira.export", `{"epic":"EPIC-002","state":"all","flavour":"data-center"}`, []string{"jira", "export", "--epic=EPIC-002", "--state=all", "--flavour=data-center"}},
		{"jira.keys", `{"file":{"name":"Jira export (1).csv","content_base64":"SXNzdWUga2V5"}}`, []string{"jira", "keys", "/staged/Jira export -1-.csv"}},
		{"jira.keys", `{"file":{"name":"keys.csv","content_base64":"SXNzdWUga2V5"},"dry_run":true}`, []string{"jira", "keys", "/staged/keys.csv", "--dry-run"}},
		{"prd.import", `{"file":{"name":"Team PRD.md","content_base64":"IyBQUkQK"}}`, []string{"prd", "import", "/staged/Team PRD.md"}},
		{"prd.list", `{}`, []string{"prd", "list"}},
		{"prd.show", `{"prd_id":"PRD-01"}`, []string{"prd", "show", "PRD-01"}},
		{"prd.show", `{"prd_id":"PRD-01","lines":"40-80"}`, []string{"prd", "show", "PRD-01", "--lines=40-80"}},
		{"prd.map", `{"prd_id":"PRD-01","map":{"epics":[],"slices":[]}}`, []string{"prd", "map", "PRD-01", "--from=/staged/map.json"}},
		{"prd.settle", `{"prd_id":"PRD-01","section":3,"as":"slice","slice":"M2"}`, []string{"prd", "settle", "PRD-01", "--section=3", "--as=slice:M2"}},
		{"prd.settle", `{"prd_id":"PRD-01","section":4,"as":"out-of-scope","reason":"Billing is next year."}`,
			[]string{"prd", "settle", "PRD-01", "--section=4", "--as=out-of-scope", "--reason=Billing is next year."}},
		{"prd.status", `{"prd_id":"PRD-02"}`, []string{"prd", "status", "PRD-02"}},
		{"prd.apply", `{"prd_id":"PRD-02"}`, []string{"prd", "apply", "PRD-02"}},
		{"prd.draft", `{"slice_id":"SLICE-004","answers":[{"question":"q"}]}`, []string{"prd", "draft", "SLICE-004", "--from=/staged/answers.json"}},
		{"prd.confirm", `{"slice_id":"SLICE-004","accept":"all","discuss":[2,4]}`, []string{"prd", "confirm", "SLICE-004", "--accept=all", "--discuss=2,4"}},
		{"prd.confirm", `{"slice_id":"SLICE-004","accept":[1,3]}`, []string{"prd", "confirm", "SLICE-004", "--accept=1,3"}},
		{"prd.confirm", `{"slice_id":"SLICE-004","discuss":[5]}`, []string{"prd", "confirm", "SLICE-004", "--discuss=5"}},
		{"slice.mock.add", `{"slice_id":"SLICE-001","file":{"name":"invite.PNG","content_base64":"iVBORw=="},"for":"AC-02","binding":true,"note":"The invite form"}`,
			[]string{"slice", "mock", "add", "SLICE-001", "/staged/invite.png", "--for=AC-02", "--binding", "--note=The invite form"}},
		{"slice.mock.add", `{"slice_id":"SLICE-001","file":{"name":"whole.jpg","content_base64":"/9j/"}}`, []string{"slice", "mock", "add", "SLICE-001", "/staged/whole.jpg"}},
		{"slice.mock.remove", `{"slice_id":"SLICE-001","mock":"0123abcd"}`, []string{"slice", "mock", "remove", "SLICE-001", "0123abcd"}},
		{"slice.mock.list", `{"slice_id":"SLICE-001"}`, []string{"slice", "mock", "list", "SLICE-001"}},
		// M16: Shape.
		{"idea.add", `{"title":"Let members renew a loan themselves"}`, []string{"idea", "add", "--", "Let members renew a loan themselves"}},
		{"idea.add", `{"title":"--from-request=5 looks like an option"}`, []string{"idea", "add", "--", "--from-request=5 looks like an option"}},
		{"idea.add", `{"title":"Renew online","from_request":57}`, []string{"idea", "add", "--from-request=57", "--", "Renew online"}},
		{"idea.add", `{"title":"Renew it myself","from_issue":58}`, []string{"idea", "add", "--from-issue=58", "--", "Renew it myself"}},
		{"idea.add", `{"title":"Fine shown twice","from_fault":"AUTO-20261120T101500Z"}`, []string{"idea", "add", "--from-fault=AUTO-20261120T101500Z", "--", "Fine shown twice"}},
		{"idea.list", ``, []string{"idea", "list"}},
		{"idea.faults", `{}`, []string{"idea", "faults"}},
		{"idea.show", `{"idea_id":"IDEA-019"}`, []string{"idea", "show", "IDEA-019"}},
		{"idea.stage", `{"idea_id":"IDEA-019","stage":"exploring"}`, []string{"idea", "stage", "IDEA-019", "exploring"}},
		{"idea.lookups", `{"idea_id":"IDEA-019","lookups":{"shipped_rules":[{"rule":"SLICE-004/FR-02","note":"n"}]}}`,
			[]string{"idea", "lookups", "IDEA-019", "--from=/staged/lookups.json"}},
		{"idea.renumber", `{"idea_id":"IDEA-019"}`, []string{"idea", "renumber", "IDEA-019"}},
		{"idea.publish", `{"idea_id":"IDEA-019"}`, []string{"idea", "publish", "IDEA-019"}},
		{"idea.size", `{"idea_id":"IDEA-019"}`, []string{"idea", "size", "IDEA-019"}},
		{"idea.map", `{"idea_id":"IDEA-019","map":{"epics":[],"slices":[]}}`, []string{"idea", "map", "IDEA-019", "--from=/staged/map.json"}},
		{"idea.settle", `{"idea_id":"IDEA-019","outcome":"O-2","as":"slice","slice":"S2","reason":"The catalogue says why."}`,
			[]string{"idea", "settle", "IDEA-019", "--outcome=O-2", "--as=slice:S2", "--reason=The catalogue says why."}},
		{"idea.settle", `{"idea_id":"IDEA-019","outcome":"O-3","as":"later"}`, []string{"idea", "settle", "IDEA-019", "--outcome=O-3", "--as=later"}},
		{"idea.map-status", `{"idea_id":"IDEA-019"}`, []string{"idea", "map-status", "IDEA-019"}},
		{"idea.apply", `{"idea_id":"IDEA-019"}`, []string{"idea", "apply", "IDEA-019"}},
		{"idea.apply", `{"idea_id":"IDEA-019","change":"fix"}`, []string{"idea", "apply", "IDEA-019", "--change=fix"}},
		{"idea.apply", `{"idea_id":"IDEA-019","change":"adjustment"}`, []string{"idea", "apply", "IDEA-019", "--change=adjustment"}},
		{"idea.change", `{"rule":"SLICE-007/INV-01"}`, []string{"idea", "change", "SLICE-007/INV-01"}},
		{"idea.change", `{"rule":"SLICE-004/R3","title":"-- a third renewal"}`, []string{"idea", "change", "SLICE-004/R3", "--title=-- a third renewal"}},
		{"idea.chain", `{"idea_id":"IDEA-019"}`, []string{"idea", "chain", "IDEA-019"}},
		{"brief.check", `{"idea_id":"IDEA-019"}`, []string{"brief", "check", "IDEA-019"}},
		{"brief.show", `{"idea_id":"IDEA-019"}`, []string{"brief", "show", "IDEA-019"}},
		{"case.show", `{"idea_id":"IDEA-019"}`, []string{"case", "show", "IDEA-019"}},
		{"case.check", `{"idea_id":"IDEA-019"}`, []string{"case", "check", "IDEA-019"}},
		{"verdict.record", `{"idea_id":"IDEA-019","decision":"not-now","reason":"--decision=go is not my reason"}`,
			[]string{"verdict", "record", "IDEA-019", "--decision=not-now", "--reason=--decision=go is not my reason"}},
		{"lookback.record", `{"idea_id":"IDEA-019","outcome":"O-1","result":"met","note":"Down to 11 a week."}`,
			[]string{"lookback", "record", "IDEA-019", "--outcome=O-1", "--result=met", "--note=Down to 11 a week."}},
		{"lookback.record", `{"idea_id":"IDEA-019","assumption":"A-2","result":"unknown","note":"Not counted."}`,
			[]string{"lookback", "record", "IDEA-019", "--assumption=A-2", "--result=unknown", "--note=Not counted."}},
	}
	cases = append(cases, needsArgvCases...)
	cases = append(cases, smallArgvCases...)
	cases = append(cases, moveArgvCases...)
	covered := map[string]bool{}
	for _, c := range cases {
		got, err := argv(t, c.op, c.body)
		if err != nil {
			t.Errorf("%s %s: %v", c.op, c.body, err)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s %s\n got %q\nwant %q", c.op, c.body, got, c.want)
		}
		covered[c.op] = true
		// Every vector starts with one of Product Studio's own commands, and none writes where the
		// request says (M15: `jira export` never takes --out; the engine writes into its own folder
		// and the host offers those files) or names another project.
		if !studioCommands[got[0]] {
			t.Errorf("%s %s starts with %q", c.op, c.body, got[0])
		}
		for _, word := range got {
			if strings.HasPrefix(word, "--out=") || word == "--out" || strings.HasPrefix(word, "--project") || strings.HasPrefix(word, "--app") {
				t.Errorf("%s %s carries %q", c.op, c.body, word)
			}
		}
	}
	for _, name := range engine.Names() {
		if !covered[name] {
			t.Errorf("no argument-vector case for %s", name)
		}
	}
}

// The request operations: typed arguments to a fixed vector; the number is a positive whole number.
func TestRequestOpsArgv(t *testing.T) {
	good := []struct {
		op, body string
		want     []string
	}{
		{"request.list", ``, []string{"request", "list"}},
		{"request.show", `{"number":1}`, []string{"request", "show", "1"}},
		{"request.met", `{"number":999999999}`, []string{"request", "met", "999999999"}},
		{"request.pick", `{"number":7,"epic":"EPIC-002","title":"--also","also":false}`,
			[]string{"request", "pick", "7", "--epic=EPIC-002", "--title=--also"}},
		{"request.pick", `{"number":7,"epic":"EPIC-002","title":"Export","also":true}`,
			[]string{"request", "pick", "7", "--epic=EPIC-002", "--title=Export", "--also"}},
		{"request.link", `{"number":12,"slice_id":"SLICE-010"}`, []string{"request", "link", "12", "SLICE-010"}},
	}
	for _, c := range good {
		got, err := argv(t, c.op, c.body)
		if err != nil {
			t.Errorf("%s %s: %v", c.op, c.body, err)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s %s\n got %q\nwant %q", c.op, c.body, got, c.want)
		}
	}
	bad := []struct{ op, body, says string }{
		{"request.show", `{}`, "request number"},
		{"request.show", `{"number":0}`, "request number"},
		{"request.show", `{"number":-3}`, "request number"},
		{"request.met", `{"number":1000000000}`, "request number"},
		{"request.met", `{"number":"42"}`, "wrong type"},
		{"request.met", `{"number":"42; rm -rf /"}`, "wrong type"},
		{"request.met", `{"number":4.5}`, "wrong type"},
		{"request.met", `{"number":1e3}`, "wrong type"},
		{"request.met", `{"number":null}`, "request number"},
		{"request.show", `{"number":42,"verb":"met"}`, "Unknown field"},
		{"request.list", `{"number":42}`, "Unknown field"},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":"T","id":"SLICE-004"}`, "Unknown field"},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":"T","repo":"other/repo"}`, "Unknown field"},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":"T","also":"yes"}`, "wrong type"},
		{"request.pick", `{"number":42,"epic":"EPIC-1","title":"T"}`, "EPIC-001"},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":""}`, "title is required"},
		{"request.pick", `{"number":42,"epic":"EPIC-001","title":"a\u0000b"}`, "control character"},
		{"request.pick", `{"epic":"EPIC-001","title":"T"}`, "request number"},
		{"request.link", `{"number":42,"slice_id":"SLICE-001/../x"}`, "SLICE-001"},
		{"request.link", `{"number":42}`, "slice_id is required"},
		{"request.link", `{"number":-1,"slice_id":"SLICE-001"}`, "request number"},
		{"request.link", `{"number":42,"slice_id":"SLICE-001","also":true}`, "Unknown field"},
	}
	for _, c := range bad {
		_, err := argv(t, c.op, c.body)
		var refused *engine.InvalidError
		if !errors.As(err, &refused) {
			t.Errorf("%s %s: want an invalid request, got %v", c.op, c.body, err)
			continue
		}
		if !strings.Contains(refused.Message, c.says) {
			t.Errorf("%s %s: message %q should mention %q", c.op, c.body, refused.Message, c.says)
		}
	}
}

func TestRequestsTheHostRejects(t *testing.T) {
	long := strings.Repeat("x", 301)
	cases := []struct{ op, body, says string }{
		{"epic.set", `{"epic_id":"../../etc"}`, "EPIC-001"},
		{"epic.set", `{"epic_id":"EPIC-1"}`, "EPIC-001"},
		{"epic.set", `{}`, "required"},
		{"slice.show", `{"slice_id":"SLICE-001/../x"}`, "SLICE-001"},
		{"slice.show", `{"slice_id":"slice-001"}`, "SLICE-001"},
		{"slice.show", `{"slice_id":"SLICE-0000000000000000000000000001"}`, "SLICE-001"},
		{"slice.ready", `{"slice_id":"SLICE-001; rm -rf /"}`, "SLICE-001"},
		{"project.init", `{"id":"Team Space","name":"n","vision":"v"}`, "campaign-platform"},
		{"project.init", `{"id":"team","name":"","vision":"v"}`, "name is required"},
		{"project.init", `{"id":"team","name":"n","vision":"v","outcome":[""]}`, "required"},
		// The project issue to close is a whole number: never a flag, a string or a negative.
		{"project.close-issue", `{}`, "issue number"},
		{"project.close-issue", `{"number":0}`, "issue number"},
		{"project.close-issue", `{"number":-9}`, "issue number"},
		{"project.close-issue", `{"number":1000000000}`, "issue number"},
		{"project.close-issue", `{"number":"--all"}`, "wrong type"},
		{"project.close-issue", `{"number":9,"all":true}`, "Unknown field"},
		// Joining takes at most a whole number of slices at a time: never a flag or a string.
		{"project.join", `{"batch":0}`, "batch"},
		{"project.join", `{"batch":1001}`, "batch"},
		{"project.join", `{"batch":"--all"}`, "wrong type"},
		{"project.join", `{"force":true}`, "Unknown field"},
		{"epic.add", `{"title":"` + long + `"}`, "longer than"},
		{"epic.add", `{"title":"a\u0000b"}`, "control character"},
		{"epic.add", `{"title":"bell\u0007"}`, "control character"},
		{"slice.new", `{"epic":"EPIC-001","title":"t","depends_on":["SLICE-1"]}`, "SLICE-001"},
		{"reconcile", `{"slice_id":"../outside","take":"mine"}`, "SLICE-001"},
		{"reconcile", `{"slice_id":"--take=theirs","take":"mine"}`, "SLICE-001"},
		{"reconcile", `{"slice_id":"SLICE-001","take":"both"}`, "mine"},
		// M20: target is the project's or an epic's text; never a slice, the principles, the needs, a path or a flag.
		{"reconcile", `{"target":"SLICE-001","take":"mine"}`, "EPIC-001"},
		{"reconcile", `{"target":"principles","take":"mine"}`, "EPIC-001"},
		{"reconcile", `{"target":"needs","take":"mine"}`, "EPIC-001"},
		{"reconcile", `{"target":"../project","take":"mine"}`, "EPIC-001"},
		{"reconcile", `{"target":"--take=theirs","take":"mine"}`, "EPIC-001"},
		{"reconcile", `{"target":"Project","take":"mine"}`, "EPIC-001"},
		{"reconcile", `{"target":"EPIC-1","take":"mine"}`, "EPIC-001"},
		{"reconcile", `{"target":"project","slice_id":"SLICE-001","take":"mine"}`, "not both"},
		{"reconcile", `{"target":"project","take":"both"}`, "mine"},
		{"reconcile", `{"take":"mine"}`, "slice_id is required"},
		{"slice.move", `{"slice_id":"SLICE-001"}`, "exactly one"},
		{"slice.move", `{"slice_id":"SLICE-001","first":true,"last":true}`, "exactly one"},
		{"slice.move", `{"slice_id":"SLICE-001","before":"--first"}`, "SLICE-002"},
		{"slice.move", `{"slice_id":"SLICE-001","first":"yes"}`, "wrong type"},
		{"slice.take", `{}`, "exactly one"},
		{"slice.take", `{"issue":41,"slice_id":"SLICE-001"}`, "exactly one"},
		{"slice.take", `{"issue":0}`, "issue number"},
		{"slice.take", `{"issue":"41"}`, "wrong type"},
		{"slice.take", `{"slice_id":"--help"}`, "SLICE-001"},
		{"reconcile", `{"slice_id":"SLICE-001","take":"mine","field":"title"}`, "Unknown field"},
		// shape errors from Decode
		{"epic.set", `{"epic_id":"EPIC-001","force":true}`, "Unknown field"},
		{"epic.set", `{"epic_id":1}`, "wrong type"},
		{"epic.set", `["EPIC-001"]`, "JSON object"},
		{"epic.set", `{"epic_id":"EPIC-001"} {}`, "exactly one"},
		{"epic.set", `{"epic_id":`, "not valid JSON"},
		{"slice.check", `{"slice_id":"SLICE-001","ready":"yes"}`, "wrong type"},
	}
	for _, c := range cases {
		_, err := argv(t, c.op, c.body)
		var bad *engine.InvalidError
		if !errors.As(err, &bad) {
			t.Errorf("%s %s: want an invalid request, got %v", c.op, c.body, err)
			continue
		}
		if !strings.Contains(bad.Message, c.says) {
			t.Errorf("%s %s: message %q should mention %q", c.op, c.body, bad.Message, c.says)
		}
	}
}
