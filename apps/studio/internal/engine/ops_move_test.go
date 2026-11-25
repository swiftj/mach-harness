package engine_test

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mach/studio/internal/engine"
	"mach/studio/internal/testkit"
)

// M21 F: moving the whole project from the app.
var moveArgvCases = []struct {
	op, body string
	want     []string
}{
	{"project.export", `{}`, []string{"project", "export"}},
	{"project.export", `{"only_mine":true}`, []string{"project", "export", "--only-mine"}},
	{"project.import", `{"file":{"name":"mach-project-lending-20261124T100000Z.zip","content_base64":"UEsDBA=="},"plan":true}`,
		[]string{"project", "import", "/kept/project.zip", "--plan"}},
	{"project.import", `{"kept":"` + strings.Repeat("ab", 32) + `"}`, []string{"project", "import", "/kept/project.zip"}},
	{"project.import", `{"kept":"` + strings.Repeat("ab", 32) + `","ready":true}`, []string{"project", "import", "/kept/project.zip", "--ready"}},
	{"project.import.abandon", `{}`, []string{"project", "import", "--abandon"}},
	{"project.import.abandon", `{"archive":"lending.zip"}`, []string{"project", "import", "--abandon", "lending.zip"}},
	{"project.imports", `{}`, []string{"project", "imports"}},
	{"project.imports", `{"identifier":"SLICE-007"}`, []string{"project", "imports", "SLICE-007"}},
}

func TestMoveOperationsAreBoundedAndTimed(t *testing.T) {
	export, _ := engine.Lookup("project.export")
	if !export.Download || !export.Network || export.ReadOnly || export.Timeout < 10*time.Minute || export.BodyLimit() != engine.MaxBodyBytes {
		t.Errorf("project.export: %+v", export)
	}
	imported, _ := engine.Lookup("project.import")
	if !imported.Network || imported.ReadOnly || imported.Download || imported.Timeout < 10*time.Minute {
		t.Errorf("project.import: %+v", imported)
	}
	// The body takes a 64 MiB file as base64, and no more; the refusal names the way for a larger one.
	if limit := imported.BodyLimit(); limit < int64(base64.StdEncoding.EncodedLen(64<<20)) || limit > 90<<20 {
		t.Errorf("project.import body limit %d", limit)
	}
	if !strings.Contains(imported.TooLarge, "/mach-studio") || !strings.Contains(imported.TooLarge, "64 MB") {
		t.Errorf("project.import too large: %q", imported.TooLarge)
	}
	if lookup, _ := engine.Lookup("project.imports"); !lookup.ReadOnly || lookup.Network {
		t.Errorf("project.imports reads only, on this computer")
	}
	if abandon, _ := engine.Lookup("project.import.abandon"); abandon.ReadOnly || abandon.Network {
		t.Errorf("project.import.abandon changes this computer only")
	}
}

func TestMoveRequestsAreChecked(t *testing.T) {
	bad := []struct{ op, body, says string }{
		{"project.export", `{"out":"/tmp"}`, "out"},
		{"project.import", `{}`, "Choose the project file"},
		{"project.import", `{"file":{"name":"a.zip","content_base64":"UEsDBA=="},"kept":"` + strings.Repeat("ab", 32) + `"}`, "exactly one"},
		{"project.import", `{"kept":"../../etc/passwd"}`, "SHA-256"},
		{"project.import", `{"kept":"` + strings.Repeat("AB", 32) + `"}`, "SHA-256"},
		{"project.import", `{"file":{"name":"a.zip","content_base64":"UEsDBA=="},"plan":true,"ready":true}`, "changes nothing"},
		{"project.import", `{"file":{"name":"project.tar","content_base64":"UEsDBA=="}}`, ".zip"},
		{"project.import", `{"file":{"name":"a.zip","content_base64":""}}`, "empty"},
		{"project.import", `{"path":"/tmp/a.zip"}`, "path"},
		{"project.import.abandon", `{"archive":"--plan"}`, "name of the file"},
		{"project.import.abandon", `{"archive":"a\nb"}`, "one line"},
		{"project.imports", `{"identifier":"SLICE-7"}`, "such as SLICE-007"},
		{"project.imports", `{"identifier":"--plan"}`, "such as SLICE-007"},
	}
	for _, c := range bad {
		_, err := argv(t, c.op, c.body)
		if err == nil || !strings.Contains(err.Error(), c.says) {
			t.Errorf("%s %s: want an error mentioning %q, got %v", c.op, c.body, c.says, err)
		}
	}
	// A file over 64 MiB is refused before anything is decoded, with the way for a larger one.
	over := `{"file":{"name":"big.zip","content_base64":"` + strings.Repeat("A", base64.StdEncoding.EncodedLen(64<<20+8)) + `"},"plan":true}`
	if _, err := argv(t, "project.import", over); err == nil || !strings.Contains(err.Error(), "/mach-studio") {
		t.Errorf("a file over 64 MiB: %v", err)
	}
}

func kept(t *testing.T, project string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(project, ".factory", "studio", "incoming"))
	if err != nil {
		return nil
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

// The real engine: a project exported from one repository, looked at, then brought into another
// through the same kept file, which is forgotten once it is in.
func TestAProjectMovesThroughTheRealEngine(t *testing.T) {
	from := testkit.NewProject(t)
	source := testkit.NewEngine(t, from)
	mustOK(t, source, "project.init", `{"id":"lending","name":"Lending","vision":"Members borrow things.","outcome":["Members can borrow"]}`)
	mustOK(t, source, "epic.add", `{"title":"Loans","criterion":["A loan has a due date"]}`)
	mustOK(t, source, "slice.new", `{"epic":"EPIC-001","title":"Borrow a book"}`)

	exported := mustOK(t, source, "project.export", `{}`)
	file, _ := exported["file"].(string)
	if !strings.HasPrefix(file, filepath.Join(from, ".factory", "studio", "export")+string(filepath.Separator)) || !strings.HasSuffix(file, ".zip") {
		t.Fatalf("exported to %q", file)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	upload := `{"name":"` + filepath.Base(file) + `","content_base64":"` + base64.StdEncoding.EncodeToString(data) + `"}`

	to := testkit.NewProject(t)
	dest := testkit.NewEngine(t, to)
	// Nothing to set aside, and nothing brought in yet.
	mustFail(t, dest, "project.import.abandon", `{}`, engine.KindRefused, "nothing to set aside")
	if listed := mustOK(t, dest, "project.imports", `{}`); len(listed["imports"].([]any)) != 0 {
		t.Fatalf("imports before any: %v", listed)
	}
	// A file the host does not keep: said, with the hint to choose it again.
	env := do(t, dest, "project.import", `{"kept":"`+strings.Repeat("0", 64)+`"}`)
	if env.OK || env.Error.Kind != engine.KindInvalid || !strings.Contains(string(env.Error.Hint), "choose_file_again") {
		t.Fatalf("an unknown kept file: %+v", env.Error)
	}

	plan := mustOK(t, dest, "project.import", `{"file":`+upload+`,"plan":true}`)
	keep, _ := plan["kept"].(map[string]any)
	if plan["plan"] != true || keep == nil || keep["name"] != filepath.Base(file) || int(keep["bytes"].(float64)) != len(data) {
		t.Fatalf("plan: %v", plan)
	}
	if names := kept(t, to); len(names) != 1 || names[0] != keep["sha256"] {
		t.Fatalf("kept after the plan: %v", names)
	}
	if _, err := os.Stat(testkit.Draft(to, "product", "project.json")); err == nil {
		t.Fatal("the plan brought something in")
	}
	// A refused plan of another file forgets that file and keeps the one waiting.
	if env := do(t, dest, "project.import", `{"file":{"name":"other.zip","content_base64":"UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA=="},"plan":true}`); env.OK {
		t.Fatalf("an empty archive was accepted: %s", env.Data)
	}
	if names := kept(t, to); len(names) != 1 || names[0] != keep["sha256"] {
		t.Fatalf("kept after a refused plan: %v", names)
	}

	done := mustOK(t, dest, "project.import", `{"kept":"`+keep["sha256"].(string)+`"}`)
	if done["imported"] != true {
		t.Fatalf("import: %v", done)
	}
	if names := kept(t, to); len(names) != 0 {
		t.Fatalf("the file is still kept after the import: %v", names)
	}
	if _, err := os.Stat(testkit.Draft(to, "product", "project.json")); err != nil {
		t.Fatal("the project was not brought in")
	}
	looked := mustOK(t, dest, "project.imports", `{"identifier":"SLICE-001"}`)
	if found, _ := looked["found"].([]any); len(found) != 1 {
		t.Fatalf("lookup: %v", looked)
	}
	// Bringing the same file in again is answered, not refused.
	if again := mustOK(t, dest, "project.import", `{"file":`+upload+`,"plan":true}`); again["already"] != true {
		t.Fatalf("again: %v", again)
	}
}
