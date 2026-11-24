package act

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Where MACH's run.py lives, relative to a folder, in each way MACH is installed (bin/mach: the run
// skill is installed into a project as .claude/skills/mach/).
var scriptLayouts = []struct{ Install, Relative string }{
	{"mach", filepath.Join("skills", "run", "scripts", "run.py")},                // the plugin, or MACH's own repository
	{"project", filepath.Join(".claude", "skills", "mach", "scripts", "run.py")}, // installed into a project
}

// Located says where run.py was found and how.
type Located struct {
	Script  string
	Install string // explicit, mach (the plugin or MACH's repository) or project
}

// LocateScript resolves run.py once, at start-up:
//
//  1. an explicit path (the --mach-run flag), used as given;
//  2. beside the binary: its folder and each folder above it (up to eight levels) is tried for
//     skills/run/scripts/run.py (the plugin or MACH's repository, where apps/observer/bin/ is),
//     then .claude/skills/mach/scripts/run.py (a project install, where .factory/bin/ is);
//  3. the project's own install: <project>/.claude/skills/mach/scripts/run.py.
//
// The binary's MACH comes first, so the Floor and the stations it runs are the same release.
func LocateScript(explicit, executable, project string) (Located, error) {
	if explicit != "" {
		abs, err := filepath.Abs(explicit)
		if err != nil {
			return Located{}, err
		}
		if !isRegular(abs) || filepath.Base(abs) != "run.py" {
			return Located{}, fmt.Errorf("%s is not MACH's run.py", abs)
		}
		return Located{Script: abs, Install: "explicit"}, nil
	}
	var tried []string
	if executable != "" {
		if resolved, err := filepath.EvalSymlinks(executable); err == nil {
			executable = resolved
		}
		dir := filepath.Dir(executable)
		for level := 0; level <= 8; level++ {
			for _, layout := range scriptLayouts {
				candidate := filepath.Join(dir, layout.Relative)
				tried = append(tried, candidate)
				if isRegular(candidate) {
					return Located{Script: candidate, Install: layout.Install}, nil
				}
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	if project != "" {
		candidate := filepath.Join(project, scriptLayouts[1].Relative)
		tried = append(tried, candidate)
		if isRegular(candidate) {
			return Located{Script: candidate, Install: "project"}, nil
		}
	}
	return Located{}, fmt.Errorf("MACH's run.py was not found; looked in:\n  %s", strings.Join(tried, "\n  "))
}

// LocatePython resolves the interpreter once: the explicit path, else python3 on PATH, made
// absolute (not through links, so a virtual environment keeps working).
func LocatePython(explicit string) (string, error) {
	name := explicit
	if name == "" {
		name = "python3"
	}
	path, err := exec.LookPath(name)
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) && explicit == "" {
			return "", errors.New("python3 was not found on PATH")
		}
		return "", fmt.Errorf("the interpreter %s cannot be used: %v", name, err)
	}
	return filepath.Abs(path)
}

func isRegular(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}
