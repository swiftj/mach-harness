// Package testkit builds real temporary projects and a real engine for the host's tests. It is
// imported only by tests.
package testkit

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"mach/studio/internal/engine"
)

// IntentText is the slice's why the Python suite uses (tests/test_mach_product_studio.py).
const IntentText = `# Intent: Invite a teammate

- **Slice:** SLICE-001 at specs/slices/SLICE-001-invite-teammate.md
- **Status:** Ready for approval

## Why

- **Problem:** A workspace admin cannot bring a colleague into the workspace.
- **Who it is for:** A workspace admin.
- **Success looks like:** The colleague receives an invitation.

## Goal ancestry

- **Goal:** Teams can work together
- **Epic:** EPIC-001: Team membership
- **Slice:** SLICE-001: An admin invites one teammate by email.

## Constraints

- None.

## Risk

- **Tier:** High
- **Reason:** It grants access to a workspace.

## Deferred work

- Inviting many teammates at once (SLICE-002)
`

// SpecName is the fixture spec's file name.
const SpecName = "SLICE-001-invite-teammate.md"

// RepoRoot is the repository that holds this module, found by walking up from the test's folder.
func RepoRoot(t testing.TB) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "skills", "product-studio", "scripts", "studio.py")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find the repository root above the test")
		}
		dir = parent
	}
}

// Script is the real studio.py.
func Script(t testing.TB) string {
	return filepath.Join(RepoRoot(t), "skills", "product-studio", "scripts", "studio.py")
}

// Python is python3 on PATH; the test is skipped without it.
func Python(t testing.TB) string {
	t.Helper()
	path, err := engine.LocatePython("")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	return path
}

// Fixture is the ready slice spec the Python suite uses.
func Fixture(t testing.TB) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(RepoRoot(t), "tests", "fixtures", SpecName))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// Git runs git in dir and fails the test on error.
func Git(t testing.TB, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// NewProject makes a project the way the Python suite does: a Git repository with a committed
// README and a configured identity. The path is free of symbolic links.
func NewProject(t testing.TB) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(dir, "project")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "README.md"), []byte("# Sample\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	Git(t, project, "init", "-q", "-b", "main")
	Git(t, project, "config", "user.name", "Pat PM")
	Git(t, project, "config", "user.email", "pat@example.com")
	Git(t, project, "config", "commit.gpgsign", "false")
	Git(t, project, "add", "-A")
	Git(t, project, "commit", "-q", "-m", "start")
	return project
}

// NewEngine is the real engine for a project.
func NewEngine(t testing.TB, project string, adjust ...func(*engine.Config)) *engine.Engine {
	t.Helper()
	cfg := engine.Config{Python: Python(t), Script: Script(t), Project: project}
	for _, f := range adjust {
		f(&cfg)
	}
	e, err := engine.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// Draft is a path inside the project's draft workspace.
func Draft(project string, rel ...string) string {
	return filepath.Join(append([]string{project, ".factory", "studio", "draft"}, rel...)...)
}
