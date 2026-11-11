package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Nothing in this host may run or name the engineering line: Product Studio and that authority
// stay separate (contract section 5). This scans every Go source file and the embedded web app.
//
// The only allowed mention of the tool folder is the draft workspace path and the project marker
// used to find the project root; both are removed before the scan.
func TestTheHostNeverNamesTheEngineeringLine(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	self, _ := filepath.Abs("boundary_test.go")
	allowed := []string{`".factory/studio/draft"`, `".factory"`}
	forbidden := []*regexp.Regexp{
		regexp.MustCompile(`(?i)factory`),
		regexp.MustCompile(`(?i)\brun\.py\b`),
		regexp.MustCompile(`(?i)dispatch`),
		regexp.MustCompile(`(?i)\bbelt\b`),
		regexp.MustCompile(`(?i)\.factory/local`),
		regexp.MustCompile(`(?i)\b(intake|ticket|audit|build|verify|review|merge|cleanup|observe|cell|supervisor)\.py\b`),
		regexp.MustCompile(`(?i)mach[-:](run|build|verify|review|merge|cleanup|observe|ticket|audit|intent)\b`),
		regexp.MustCompile(`(?i)workflows/`),
	}
	scanned := 0
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || path == self {
			return nil
		}
		ext := filepath.Ext(path)
		if ext != ".go" && !strings.Contains(path, string(filepath.Separator)+"dist"+string(filepath.Separator)) {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		text := string(data)
		for _, ok := range allowed {
			text = strings.ReplaceAll(text, ok, `""`)
		}
		for _, pattern := range forbidden {
			if loc := pattern.FindStringIndex(text); loc != nil {
				line := strings.Count(text[:loc[0]], "\n") + 1
				rel, _ := filepath.Rel(root, path)
				t.Errorf("%s:%d names %q", rel, line, text[loc[0]:loc[1]])
			}
		}
		scanned++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if scanned < 10 {
		t.Fatalf("only %d files scanned; the scan is not looking in the right place", scanned)
	}
}

func TestFlags(t *testing.T) {
	var out, errs strings.Builder
	if err := run([]string{"--port", "x"}, &out, &errs); err == nil {
		t.Fatal("a bad port was accepted")
	}
	if err := run([]string{"stray"}, &out, &errs); err == nil || !strings.Contains(err.Error(), "unexpected argument") {
		t.Fatalf("a stray argument: %v", err)
	}
	if err := run([]string{"--engine", filepath.Join(t.TempDir(), "missing.py"), "--no-open"}, &out, &errs); err == nil {
		t.Fatal("a missing engine was accepted")
	}
}
