package redact

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// shapeAt resolves "data.a[].b" in a kind's allowlist; nil when the path does not exist.
func shapeAt(kind, path string) *Shape {
	s, ok := Allow[kind]
	if !ok || !strings.HasPrefix(path, "data.") {
		return nil
	}
	for _, part := range strings.Split(strings.TrimPrefix(path, "data."), ".") {
		list := strings.HasSuffix(part, "[]")
		part = strings.TrimSuffix(part, "[]")
		if s.kind != shapeObject {
			return nil
		}
		if s = s.keys[part]; s == nil {
			return nil
		}
		if list {
			if s.kind != shapeList {
				return nil
			}
			s = s.elem
		}
	}
	return s
}

// R1 beyond artifact content (M6.5 S3): every declared free-text field exists in the allowlist as
// a scalar, so the list the session serves cannot name a field that no longer exists.
func TestFreeTextFieldsExistInTheAllowlist(t *testing.T) {
	seen := map[string]bool{}
	for _, f := range FreeTextFields {
		key := f.Kind + " " + f.Path
		if seen[key] {
			t.Fatalf("declared twice: %s", key)
		}
		seen[key] = true
		if s := shapeAt(f.Kind, f.Path); s == nil || s.kind != shapeScalar {
			t.Fatalf("%s is not a scalar field of the allowlist", key)
		}
		if f.Max <= 0 || f.Max > MaxText {
			t.Fatalf("%s: max %d", key, f.Max)
		}
	}
}

// A tripwire: the normalisers keep prose only through redact.Text, textOrNil and textList. Each
// call site is one declared free-text field; a new one must be added to FreeTextFields (and to
// docs/mach-next/M6_5_SECURITY.md) before this count is raised.
func TestEveryProseCallSiteIsDeclared(t *testing.T) {
	files, err := filepath.Glob("../normalize/*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("normalize sources not found: %v", err)
	}
	call := regexp.MustCompile(`\b(redact\.Text|textOrNil|textList)\(`)
	n := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(string(b), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "func ") || strings.HasPrefix(trimmed, "//") {
				continue
			}
			// The two helpers' own bodies call redact.Text once each.
			if strings.Contains(trimmed, "redact.Text(item, root, each)") || strings.Contains(trimmed, "s, ok := redact.Text(v, root, max)") {
				continue
			}
			n += len(call.FindAllString(line, -1))
		}
	}
	// 13 call sites; agent.queued and agent.started share the label and phase call sites, so the
	// list declares 15 fields.
	if n != 13 || len(FreeTextFields) != 15 {
		t.Fatalf("prose call sites in internal/normalize: %d (want 13), declared fields: %d (want 15); declare the new field in redact.FreeTextFields", n, len(FreeTextFields))
	}
}

func TestSecretName(t *testing.T) {
	for _, bad := range []string{"sk-ant-api03-ABCDEFGHIJKL.txt", "evidence/ghp_ABCDEFGHIJKLMNOPQRST.log", "a@example.org.txt", "AKIAABCDEFGHIJKLMNOP.png"} {
		if !SecretName(bad) {
			t.Fatalf("%q should be a secret name", bad)
		}
	}
	// Long ordinary names are not secrets (the opaque-run rule does not apply to names).
	for _, good := range []string{"AC-01-r1.txt", "evidence/previous-12/example-spec-ts-has-title-chromium-retry1/test-failed-1.png", "token-refresh.txt"} {
		if SecretName(good) {
			t.Fatalf("%q is not a secret name", good)
		}
	}
}
