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

// Version of the redaction and normalisation rules. 4: one text scrubber for events and served
// artifact content; long hex runs inside text are redacted (a whole value that is a digest or a
// commit is not). 5: people by role everywhere (the per-project deny-list, structured records),
// stream records accepted by shape, gap classes, plan-exit facts.
const Version = 5

// pathRest is the rest of a path in text: up to white space, a quote, a backtick or a bracket.
const pathRest = "[^\\s\"'`<>|;,()\\[\\]{}]*"

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
	// A long opaque run: a key, token, blob, or a long hex string (a hex API key looks exactly like
	// a digest). A value that is wholly a digest or a commit is exempt (Sensitive); so are the
	// known hash keys of a served JSON record (ScrubDocument's HashKeys).
	opaqueRe = regexp.MustCompile(`[A-Za-z0-9+/_=-]{40,}`)
	emailRe  = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`)
	// Absolute and home paths, in text: at the start, or after any character that cannot be part
	// of a word, a relative path or a URL (so "src/a.go" and "https://host/x" stay, and a path in
	// backticks, quotes, brackets or after "=" does not).
	absPathRe = regexp.MustCompile(`(^|[^A-Za-z0-9._~:/\\@%+$-])((~|\$HOME|%USERPROFILE%)[/\\]|/[A-Za-z0-9._~-]|[A-Za-z]:[/\\]|file://)` + pathRest)
	// A home or temporary folder anywhere, replaced to the end of the path (the user name and
	// what follows are the sensitive part).
	homeRe = regexp.MustCompile(`(?i)(/Users/|/home/|/root/|\\Users\\|/private/var/|/var/folders/|/tmp/)` + pathRest)
)

// TextReplaced counts every span the text rules replaced, across all filters.
var TextReplaced atomic.Int64

// opaqueRun: a long run that mixes letters and digits (hex included).
func opaqueRun(m string) bool {
	return strings.ContainsAny(m, "0123456789") && strings.IndexFunc(m, unicode.IsLetter) >= 0
}

// opaque reports a long opaque run in s.
func opaque(s string) bool {
	for _, m := range opaqueRe.FindAllString(s, -1) {
		if opaqueRun(m) {
			return true
		}
	}
	return false
}

// wholeDigest: the whole value is a hex digest or commit id, as a typed field holds it.
func wholeDigest(s string) bool { return commitRe.MatchString(s) || digestRe.MatchString(s) }

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

// Sensitive reports whether s contains anything the scrubber would replace. A value that is
// wholly a hex digest or commit id is not sensitive: that is what a commit or sha256 field holds.
func Sensitive(s string) bool {
	if !mayBeSensitive(s) || wholeDigest(s) {
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

// SecretName reports a file name or path that itself holds a credential-shaped value (an API key,
// a token, a JWT, a PEM marker, URL credentials) or an e-mail address. Such a name is never shown
// and never protected from the scrubber: the name is the secret. Unlike Sensitive it does not
// apply the long-opaque-run rule, which a long, ordinary relative path trips.
func SecretName(p string) bool {
	for _, re := range secretPatterns {
		if re.MatchString(p) {
			return true
		}
	}
	return emailRe.MatchString(p)
}

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

// scrubText is the field form of the text rules (Text, Scrub, ScrubEvent): one line, cut to max
// characters, and replaced whole when it is far longer than any field allows.
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
	s, k := replaceSensitive(rootRelative(s, projectRoot), true)
	n += k
	s, k = PeopleFor(projectRoot).Replace(s)
	n += k
	s = strings.TrimSpace(stripControls(s, false))
	if utf8.RuneCountInString(s) > max {
		runes := []rune(s)
		s = string(runes[:max-1]) + "…"
	}
	return s, n
}
