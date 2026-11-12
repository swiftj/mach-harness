package artifact

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ScrubText applies the observer's text rules to a whole text file, line by line, keeping its
// lines (internal/redact.Scrub is for one short field: it joins lines and cuts at 280 characters).
// Credential-shaped text becomes [redacted]; the project root becomes <project>; other absolute
// and home paths become [path]; control and bidirectional-override characters are removed. It
// returns how many replacements were made, so the response can say so.
//
// The patterns are the same as internal/redact's (owned by the ingest side); a test holds the two
// to the same verdict on the same secrets, so they cannot drift apart unnoticed.
func ScrubText(s, projectRoot string) (string, int) {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	n := 0
	if projectRoot != "" && projectRoot != "/" {
		root := strings.TrimRight(projectRoot, "/")
		n += strings.Count(s, root)
		s = strings.ReplaceAll(s, root+"/", "")
		s = strings.ReplaceAll(s, root, "<project>")
	}
	// A private key spans lines: replace whole blocks before going line by line.
	s = secretPatterns[0].ReplaceAllStringFunc(s, func(string) string { n++; return "[redacted]" })
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		if len(line) > 64<<10 {
			line = line[:64<<10] // bound the regex work per line
			n++
		}
		for _, re := range secretPatterns[1:] {
			line = re.ReplaceAllStringFunc(line, func(string) string { n++; return "[redacted]" })
		}
		line = absPathRe.ReplaceAllStringFunc(line, func(string) string { n++; return "[path]" })
		line = strings.Map(func(r rune) rune {
			if r == '\t' || r == '\r' {
				return r
			}
			if unicode.IsControl(r) || r == ' ' || r == ' ' || (r >= '‪' && r <= '‮') || (r >= '⁦' && r <= '⁩') {
				n++
				return -1
			}
			return r
		}, line)
		lines[i] = line
	}
	return strings.Join(lines, "\n"), n
}

var (
	secretPatterns = []*regexp.Regexp{
		regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)`),
		regexp.MustCompile(`(?i)\b(sk-ant-[a-z0-9_-]{8,}|sk-[a-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})`),
		regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`),
		regexp.MustCompile(`(?i)\b([A-Z0-9_]*(key|token|secret|passw(or)?d|credential|auth|cookie|session)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)`),
		regexp.MustCompile(`\b[A-Za-z0-9+/_-]{40,}={0,2}`),
	}
	absPathRe = regexp.MustCompile(`(~|\b[A-Za-z]:)?(/[^\s"'<>|:;,()\[\]{}]+){2,}`)
)
