// Package redact holds the observer's value filters, the per-kind allowlist that every event
// passes before it is stored, and a defence-in-depth scrubber.
//
// Three layers, applied in this order:
//
//  1. The normalisers build each kind's payload field by field from typed filters here (ID,
//     Token, Commit, Text, ...). A value that does not fit is dropped, not repaired.
//  2. Enforce (allow.go) is the one place every event passes before the store: it drops an event
//     of a kind outside the version 3 catalog, and every data key (at any depth) that the kind's
//     allowlist does not name. The allowlist is the schema's $defs, written as Go.
//  3. ScrubEvent (scrub.go) walks every string the event carries and REPLACES anything shaped
//     like a secret, an absolute or home path, an e-mail address, a URL with credentials, a PEM
//     block or over-long free text, counting each replacement in the event's withheld count.
//
// Version changes whenever a rule here, an allowlist or a normaliser's mapping changes. An index
// built under another version is rebuilt from the sources, so a tightened rule applies to history.
package redact

import (
	"regexp"
	"strings"
	"sync/atomic"
	"unicode"
	"unicode/utf8"
)

// Version of the redaction and normalisation rules.
const Version = 3

var (
	idRe     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:#-]{0,127}$`)
	tokenRe  = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)
	commitRe = regexp.MustCompile(`^[0-9a-f]{7,64}$`)
	digestRe = regexp.MustCompile(`^(sha256:)?[0-9a-f]{16,128}$`)
	relRe    = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)
	nameRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:\-\[\]]{0,79}$`)
	labelRe  = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,40}$`)

	// Credential-shaped text.
	secretPatterns = []*regexp.Regexp{
		regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*-----[\s\S]*?(-----END [A-Z0-9 ]*-----|$)`),
		regexp.MustCompile(`(?i)\b(sk-ant-[a-z0-9_-]{8,}|sk-[a-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,})`),
		regexp.MustCompile(`(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}`),
		regexp.MustCompile(`(?i)\b([A-Z0-9_]*(key|token|secret|passw(or)?d|pwd|credential|auth|cookie|session)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)`),
		regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}`), // JWT
		regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@`),                  // URL credentials
	}
	// A long opaque run: a key, token or blob. Checked separately so hex digests stay.
	opaqueRe = regexp.MustCompile(`[A-Za-z0-9+/_=-]{40,}`)
	emailRe  = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`)
	// Absolute and home paths, in text: at the start or after a separator.
	absPathRe = regexp.MustCompile(`(^|[\s"'=(,;\[{<>|])((~|\$HOME|%USERPROFILE%)[/\\]|/[A-Za-z0-9._~-]|[A-Za-z]:[/\\]|file://)[^\s"'<>|;,()\[\]{}]*`)
	homeRe    = regexp.MustCompile(`(?i)(/Users/|/home/|/root/|\\Users\\|/private/var/|/var/folders/|/tmp/)`)
)

// TextReplaced counts every span the text rules replaced, across all filters.
var TextReplaced atomic.Int64

// opaque reports a long run that is not a plain hex digest and mixes letters and digits.
func opaque(s string) bool {
	for _, m := range opaqueRe.FindAllString(s, -1) {
		if commitRe.MatchString(m) || strings.Trim(m, "0123456789abcdef") == "" {
			continue
		}
		if strings.ContainsAny(m, "0123456789") && strings.IndexFunc(m, unicode.IsLetter) >= 0 {
			return true
		}
	}
	return false
}

// keywords is a cheap prefilter: a string none of the patterns can match is let through
// without running them. Every pattern needs one of these characters, one of these words, or a
// run of 40 characters.
var keywords = []string{"sk-", "gh", "github_pat", "xox", "akia", "aiza", "glpat", "npm_", "bearer", "basic", "token", "key",
	"secret", "pass", "pwd", "credential", "auth", "cookie", "session", "eyj", "-----", "users", "home", "root", "tmp", "var"}

func mayBeSensitive(s string) bool {
	if len(s) >= 40 || strings.ContainsAny(s, "/\\@=:~$%") {
		return true
	}
	lower := strings.ToLower(s)
	for _, k := range keywords {
		if strings.Contains(lower, k) {
			return true
		}
	}
	return false
}

// Sensitive reports whether s contains anything the scrubber would replace.
func Sensitive(s string) bool {
	if !mayBeSensitive(s) {
		return false
	}
	for _, re := range secretPatterns {
		if re.MatchString(s) {
			return true
		}
	}
	return opaque(s) || emailRe.MatchString(s) || absPathRe.MatchString(s) || homeRe.MatchString(s)
}

// ID accepts a MACH identifier (ticket, slice, wave, execution, runner, visit) or returns "".
func ID(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || !idRe.MatchString(s) || strings.Contains(s, "..") || Sensitive(s) {
		return "", false
	}
	return s, true
}

// Token accepts a short lower-case word such as a stage, outcome, verdict or tool category.
func Token(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || !tokenRe.MatchString(s) || Sensitive(s) {
		return "", false
	}
	return s, true
}

// Name accepts a tool, model, agent or skill name: letters, digits and _.:-[] up to 80.
func Name(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || !nameRe.MatchString(s) || Sensitive(s) {
		return "", false
	}
	return s, true
}

// Label accepts a short label a station writes verbatim ("PASS", "APPROVED", "Gold", a merge error code).
func Label(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || !labelRe.MatchString(s) || Sensitive(s) {
		return "", false
	}
	return s, true
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

// CredentialName: a file name that holds or may hold credentials. Such a path is never shown,
// only its class.
var credentialNameRe = regexp.MustCompile(`(?i)(^|/)(\.env[^/]*|[^/]*(secret|credential|passw|token|apikey|api_key|private[_-]?key|id_rsa|id_ed25519)[^/]*|[^/]*\.(pem|key|p12|pfx|keystore))$`)

// CredentialPath reports a path whose name suggests credentials.
func CredentialPath(p string) bool { return credentialNameRe.MatchString(p) }

// RelPath accepts a plain project- or cell-relative path: no leading slash, no "..", no "~", and
// not a credential-like name.
func RelPath(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || len(s) > 300 || !relRe.MatchString(s) || CredentialPath(s) || Sensitive(s) {
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

// MaxText is the longest free text kept by Text.
const MaxText = 280

// Text keeps MACH-written prose (a blocked reason, a human-required reason) after scrubbing. It
// is shown as text, never rendered as markup, by the browser. projectRoot, when set, is removed
// so project-relative meaning survives.
func Text(v any, projectRoot string, max int) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	if max <= 0 || max > MaxText {
		max = MaxText
	}
	s, _ = scrubText(s, projectRoot, max)
	return s, true
}

// Scrub applies the text rules to s.
func Scrub(s, projectRoot string) string {
	out, _ := scrubText(s, projectRoot, MaxText)
	return out
}

// scrubText replaces every sensitive span in s and returns how many it replaced.
func scrubText(s, projectRoot string, max int) (string, int) {
	n := 0
	defer func() { TextReplaced.Add(int64(n)) }()
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "\uFFFD")
	}
	if utf8.RuneCountInString(s) > 2*max {
		// Long free text: no field allows it, so it is replaced, not cut short.
		n++
		return "[withheld]", n
	}
	if projectRoot != "" && projectRoot != "/" {
		root := strings.TrimRight(projectRoot, "/")
		if strings.Contains(s, root) {
			s = strings.ReplaceAll(s, root+"/", "")
			s = strings.ReplaceAll(s, root, "<project>")
		}
	}
	for _, re := range secretPatterns {
		if re.MatchString(s) {
			n += len(re.FindAllStringIndex(s, -1))
			s = re.ReplaceAllString(s, "[redacted]")
		}
	}
	if opaque(s) {
		s = opaqueRe.ReplaceAllStringFunc(s, func(m string) string {
			if commitRe.MatchString(m) || !strings.ContainsAny(m, "0123456789") || strings.IndexFunc(m, unicode.IsLetter) < 0 {
				return m
			}
			n++
			return "[redacted]"
		})
	}
	if emailRe.MatchString(s) {
		n += len(emailRe.FindAllStringIndex(s, -1))
		s = emailRe.ReplaceAllString(s, "[email]")
	}
	if absPathRe.MatchString(s) {
		n += len(absPathRe.FindAllStringIndex(s, -1))
		s = absPathRe.ReplaceAllString(s, "${1}[path]")
	}
	if homeRe.MatchString(s) {
		n++
		s = homeRe.ReplaceAllString(s, "[path]/")
	}
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || r == '\r' {
			return ' '
		}
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' || (r >= '\u202a' && r <= '\u202e') || (r >= '\u2066' && r <= '\u2069') || r == '\u200b' || r == '\ufeff' {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > max {
		runes := []rune(s)
		s = string(runes[:max-1]) + "…"
	}
	return s, n
}
