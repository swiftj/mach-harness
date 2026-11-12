package redact

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The text rules, shared by every path that lets text out of the observer: event fields (Text,
// Scrub, ScrubEvent) and served artifact content (ScrubDocument). There is one copy of the
// patterns, in redact.go; nothing else may keep its own.

// rootRelative makes the project root disappear from s: "<root>/x" becomes "x", "<root>" alone
// becomes "<project>".
func rootRelative(s, projectRoot string) string {
	if projectRoot == "" || projectRoot == "/" {
		return s
	}
	root := strings.TrimRight(projectRoot, "/")
	if !strings.Contains(s, root) {
		return s
	}
	s = strings.ReplaceAll(s, root+"/", "")
	return strings.ReplaceAll(s, root, "<project>")
}

// replaceSensitive replaces every credential-shaped span, long opaque run, e-mail address and
// absolute or home path in s, and counts the replacements. pem: also look for PEM blocks (a
// document has them removed whole before it is split into lines).
func replaceSensitive(s string, pem bool) (string, int) {
	if !mayBeSensitive(s) {
		return s, 0
	}
	n := 0
	for i, re := range secretPatterns {
		if i == 0 && !pem {
			continue
		}
		if re.MatchString(s) {
			n += len(re.FindAllStringIndex(s, -1))
			s = re.ReplaceAllString(s, "[redacted]")
		}
	}
	if opaque(s) {
		s = opaqueRe.ReplaceAllStringFunc(s, func(m string) string {
			if !opaqueRun(m) {
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
		s = homeRe.ReplaceAllString(s, "[path]")
	}
	return s, n
}

// invisible: control, line-separator, bidirectional-override and zero-width characters.
func invisible(r rune) bool {
	return unicode.IsControl(r) || r == '\u2028' || r == '\u2029' || (r >= '\u202A' && r <= '\u202E') || (r >= '\u2066' && r <= '\u2069') ||
		r == '\u200B' || r == '\uFEFF'
}

// stripControls removes invisible characters. keepLines keeps tab, CR and LF (a document);
// otherwise they become spaces (a field).
func stripControls(s string, keepLines bool) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || r == '\r' {
			if keepLines {
				return r
			}
			return ' '
		}
		if invisible(r) {
			return -1
		}
		return r
	}, s)
}

// MaxDocumentLine bounds the text the rules examine on one line of a document; the rest of a
// longer line is dropped (and counted as a replacement), so the work per line is bounded.
const MaxDocumentLine = 64 << 10

// Placeholders for protected hash values while a document is scrubbed. Private-use characters,
// removed from the input first, so a document cannot forge one.
const (
	protectOpen  = '\uE000'
	protectClose = '\uE001'
)

// DocOptions tune ScrubDocument.
type DocOptions struct {
	// HashKeys are JSON keys whose value is a known hash in this kind of record (for example
	// "sha256" and "head" in a verification record). A value under one of them that is wholly a
	// hex digest or commit id (7 to 64 hex characters) is kept: the long-hex rule does not apply
	// to it. Everything else in the document is scrubbed as usual.
	HashKeys []string
}

// ScrubDocument applies the text rules to a whole text, keeping its lines: credential-shaped
// text becomes [redacted], long opaque and long hex runs [redacted], e-mail addresses [email],
// the project root <project> (or a relative path), other absolute and home paths [path]; control,
// bidirectional-override and zero-width characters are removed. It returns the scrubbed text and
// how many replacements were made.
func ScrubDocument(s, projectRoot string, opt DocOptions) (string, int) {
	n := 0
	defer func() { TextReplaced.Add(int64(n)) }()
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "\uFFFD")
	}
	if strings.ContainsRune(s, protectOpen) || strings.ContainsRune(s, protectClose) {
		s = strings.Map(func(r rune) rune {
			if r == protectOpen || r == protectClose {
				return -1
			}
			return r
		}, s)
	}
	var kept []string
	if len(opt.HashKeys) > 0 {
		s, kept = protectHashes(s, opt.HashKeys)
	}
	s = rootRelative(s, projectRoot)
	// A PEM block spans lines: remove whole blocks before going line by line.
	if secretPatterns[0].MatchString(s) {
		n += len(secretPatterns[0].FindAllStringIndex(s, -1))
		s = secretPatterns[0].ReplaceAllString(s, "[redacted]")
	}
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		if len(line) > MaxDocumentLine {
			line = strings.ToValidUTF8(line[:MaxDocumentLine], "")
			n++
		}
		line, k := replaceSensitive(line, false)
		n += k
		before := len(line)
		line = stripControls(line, true)
		if len(line) != before {
			n++
		}
		lines[i] = line
	}
	s = strings.Join(lines, "\n")
	if len(kept) > 0 {
		s = restoreHashes(s, kept)
	}
	return s, n
}

var hashValueRe = regexp.MustCompile(`^[0-9a-f]{7,64}$`)

// protectHashes swaps the hex values of the given JSON keys for numbered placeholders.
func protectHashes(s string, keys []string) (string, []string) {
	quoted := make([]string, len(keys))
	for i, k := range keys {
		quoted[i] = regexp.QuoteMeta(k)
	}
	re := regexp.MustCompile(`("(?:` + strings.Join(quoted, "|") + `)"\s*:\s*")([0-9a-f]{7,64})"`)
	var kept []string
	s = re.ReplaceAllStringFunc(s, func(m string) string {
		sub := re.FindStringSubmatch(m)
		if !hashValueRe.MatchString(sub[2]) {
			return m
		}
		kept = append(kept, sub[2])
		return sub[1] + string(protectOpen) + strconv.Itoa(len(kept)-1) + string(protectClose) + `"`
	})
	return s, kept
}

var placeholderRe = regexp.MustCompile("\uE000([0-9]+)\uE001")

func restoreHashes(s string, kept []string) string {
	return placeholderRe.ReplaceAllStringFunc(s, func(m string) string {
		i, err := strconv.Atoi(m[len(string(protectOpen)) : len(m)-len(string(protectClose))])
		if err != nil || i < 0 || i >= len(kept) {
			return ""
		}
		return kept[i]
	})
}
