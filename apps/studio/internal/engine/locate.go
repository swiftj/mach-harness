package engine

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Where studio.py lives, relative to a folder, in each way MACH is installed.
var scriptLayouts = []struct{ Install, Relative string }{
	{"plugin", filepath.Join("skills", "product-studio", "scripts", "studio.py")},                  // the plugin, or this repository
	{"project", filepath.Join(".claude", "skills", "mach-product-studio", "scripts", "studio.py")}, // a script install into a project
}

// Located says where the engine script was found and how.
type Located struct {
	Script  string `json:"-"`
	Install string `json:"install"` // explicit, plugin or project
}

// LocateScript resolves studio.py once, at start-up:
//
//  1. an explicit path (the --engine flag), used as given;
//  2. next to the binary: the binary's folder and each folder above it (up to eight levels) is
//     tried for skills/product-studio/scripts/studio.py (plugin or repository layout), then
//     .claude/skills/mach-product-studio/scripts/studio.py (project install);
//  3. the project itself: <project>/.claude/skills/mach-product-studio/scripts/studio.py.
//
// The binary is checked before the project so the host and engine come from the same install.
func LocateScript(explicit, executable, project string) (Located, error) {
	if explicit != "" {
		abs, err := filepath.Abs(explicit)
		if err != nil {
			return Located{}, err
		}
		if !isRegular(abs) {
			return Located{}, fmt.Errorf("the engine script %s does not exist", abs)
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
	return Located{}, fmt.Errorf("could not find the Product Studio engine (studio.py); looked in:\n  %s\nPass --engine <path to studio.py>", strings.Join(tried, "\n  "))
}

// LocatePython resolves the interpreter once: the explicit path, else python3 on PATH, made
// absolute. It is not resolved through symlinks, so a virtual environment keeps working.
func LocatePython(explicit string) (string, error) {
	name := explicit
	if name == "" {
		name = "python3"
	}
	path, err := exec.LookPath(name)
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) && explicit == "" {
			return "", errors.New("python3 was not found on PATH; Product Studio's engine needs it (pass --python <path>)")
		}
		return "", fmt.Errorf("the interpreter %s cannot be used: %v", name, err)
	}
	return filepath.Abs(path)
}

func isRegular(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// FindProject mirrors the engine's own rule for the project root (cell.find_project): inside a
// cell, the folder that holds the cells; otherwise the nearest folder with the project's tool
// folder, else the nearest with Git, else start.
func FindProject(start string) (string, error) {
	abs, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	parts := strings.Split(filepath.ToSlash(abs), "/")
	for i := len(parts) - 2; i > 0; i-- {
		if parts[i] == "worktrees" && parts[i-1] == ".factory" {
			return filepath.FromSlash(strings.Join(parts[:i-1], "/")), nil
		}
	}
	for _, marker := range []string{".factory", ".git"} {
		for dir := abs; ; dir = filepath.Dir(dir) {
			info, err := os.Stat(filepath.Join(dir, marker))
			if err == nil && (marker == ".git" || info.IsDir()) {
				return dir, nil
			}
			if filepath.Dir(dir) == dir {
				break
			}
		}
	}
	return abs, nil
}
