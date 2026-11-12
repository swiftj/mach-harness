// Package redact holds the observer's value filters. Every value that reaches the index passes
// one of these: identifiers and tokens are checked against a strict shape and dropped when they do
// not fit; free text is cut short, stripped of control characters, and scrubbed of anything that
// looks like a credential or an absolute path. Redaction runs before indexing, so the index holds
// nothing the browser may not see.
package redact

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Version changes whenever a rule here or in the normalizers' allowlists changes. An index built
// under another version is rebuilt from the sources, so a tightened rule applies to history too.
const Version = 1

var (
	idRe     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:#-]{0,127}$`)
	tokenRe  = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)
	commitRe = regexp.MustCompile(`^[0-9a-f]{7,64}$`)
	digestRe = regexp.MustCompile(`^(sha256:)?[0-9a-f]{16,128}$`)
	relRe    = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)

	// Credential-shaped text. Defence in depth: allowlisted fields should never carry these.
	secretPatterns = []*regexp.Regexp{
		regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)`),
		regexp.MustCompile(`(?i)\b(sk-ant-[a-z0-9_-]{8,}|sk-[a-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})`),
		regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`),
		regexp.MustCompile(`(?i)\b([A-Z0-9_]*(key|token|secret|passw(or)?d|credential|auth|cookie|session)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)`),
		regexp.MustCompile(`\b[A-Za-z0-9+/_-]{40,}={0,2}`), // long opaque strings: keys, tokens, blobs
	}
	// Absolute paths and home-relative paths. A project-relative path is written without a
	// leading slash and is untouched.
	absPathRe = regexp.MustCompile(`(~|\b[A-Za-z]:)?(/[^\s"'<>|:;,()\[\]{}]+){2,}`)
)

// ID accepts a MACH identifier (ticket, slice, wave, execution, runner, visit) or returns "".
func ID(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || !idRe.MatchString(s) || strings.Contains(s, "..") || secretShaped(s) {
		return "", false
	}
	return s, true
}

// Token accepts a short lower-case word such as a stage, outcome, verdict or tool category.
func Token(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || !tokenRe.MatchString(s) || secretShaped(s) {
		return "", false
	}
	return s, true
}

// secretShaped: a value that fits an identifier's shape can still be a key ("sk-ant-..."). Such
// a value is refused, not scrubbed: an identifier is either kept whole or dropped.
func secretShaped(s string) bool {
	for _, re := range secretPatterns {
		if re.MatchString(s) {
			return true
		}
	}
	return false
}

// Commit accepts a hex commit ID.
func Commit(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || !commitRe.MatchString(s) {
		return "", false
	}
	return s, true
}

// Digest accepts a hex digest, optionally prefixed "sha256:".
func Digest(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || !digestRe.MatchString(s) {
		return "", false
	}
	return s, true
}

// RelPath accepts a plain project- or cell-relative path: no leading slash, no "..", no "~".
func RelPath(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || len(s) > 256 || !relRe.MatchString(s) {
		return "", false
	}
	for _, part := range strings.Split(s, "/") {
		if part == "." || part == ".." {
			return "", false
		}
	}
	return s, true
}

// Number accepts a finite JSON number.
func Number(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || f != f || f > 1e15 || f < -1e15 {
		return 0, false
	}
	return f, true
}

// Int accepts a JSON number that is a whole number.
func Int(v any) (int64, bool) {
	f, ok := Number(v)
	if !ok || f != float64(int64(f)) {
		return 0, false
	}
	return int64(f), true
}

// Bool accepts a JSON boolean.
func Bool(v any) (bool, bool) {
	b, ok := v.(bool)
	return b, ok
}

// MaxText is the longest free text kept.
const MaxText = 280

// Text keeps MACH-written prose (a blocked reason, a human-required reason) after scrubbing. It
// is shown as text, never rendered as markup, by the browser. projectRoot, when set, is replaced
// by "<project>" before the general path scrub so project-relative meaning survives.
func Text(v any, projectRoot string) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	return Scrub(s, projectRoot), true
}

// Scrub applies the text rules to s.
func Scrub(s, projectRoot string) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	if len(s) > 4*MaxText {
		s = s[:4*MaxText] // bound the regex work before scrubbing
	}
	if projectRoot != "" && projectRoot != "/" {
		s = strings.ReplaceAll(s, strings.TrimRight(projectRoot, "/")+"/", "")
		s = strings.ReplaceAll(s, strings.TrimRight(projectRoot, "/"), "<project>")
	}
	for _, re := range secretPatterns {
		s = re.ReplaceAllString(s, "[redacted]")
	}
	s = absPathRe.ReplaceAllString(s, "[path]")
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return ' '
		}
		if unicode.IsControl(r) || r == ' ' || r == ' ' || (r >= '‪' && r <= '‮') || (r >= '⁦' && r <= '⁩') {
			return -1 // control and bidirectional-override characters
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > MaxText {
		runes := []rune(s)
		s = string(runes[:MaxText-1]) + "…"
	}
	return s
}
