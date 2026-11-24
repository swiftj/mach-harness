// Package adr reads a project's architecture decisions (ADRs) for the Factory Floor's "Decisions in
// force" page.
//
// skills/intent/scripts/adr.py is the authority on the ADR grammar. This is a port of only what the
// page needs, following adr.py's rules for everything it does read: the folder setting (folder_of),
// the file name (FILE_RE), the header (front_matter), one file as a record (parse, with check_applies
// and check_serves, whose problems decide whether an ADR binds), the folder (read_folder: which files
// are ADRs, two files with one number, a missing superseding ADR), the required topics
// (required_topics) and the baseline's coverage (coverage). It never calls Python and never runs git.
// A shared fixture (tests/fixtures/adr-parity) is parsed by adr.py in tests/test_adr_floor_parity.py
// and by this package in adr_test.go, both against one expected.json, so the two cannot drift
// silently. When adr.py changes a rule, change it here too.
//
// Where it reads: adr.py reads the main checkout's committed state (git's HEAD). The observer reads
// no git objects (it has no git dependency and runs no command), so this reads the ADR folder in the
// main checkout's working tree, as adr.py itself does in a project with no commit yet. A file edited
// and not committed is therefore read as it is on disk. Callers say so in the reply's basis.
//
// Deliberate differences, each in the direction of saying more, never less:
//   - a file that cannot be read (too large to read at all, a link, a race) is listed as unreadable
//     with its reason; adr.py's files_on_disk skips such a file;
//   - a folder reached through a symbolic link is not followed, and that is reported as a problem;
//   - at most MaxFiles Markdown files of the folder are read; more is reported as a problem.
//
// One narrow difference in the other direction: whether a name "starts with a digit" uses Unicode
// decimal digits; Python's str.isdigit also counts a few other digit characters (superscripts,
// circled digits), so a file named with one of those first is not listed here.
package adr

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"mach/observer/internal/normalize"
)

const (
	// DefaultDir is adr.DEFAULT_DIR.
	DefaultDir = "docs/adr"
	// MaxBytes is adr.MAX_BYTES: a larger ADR is a problem.
	MaxBytes = 200_000
	// TextLimit is adr.TEXT_LIMIT: the characters of one ADR's text shown.
	TextLimit = 6000
	// MaxReadBytes bounds what is read of one file; a larger file is listed as unreadable.
	MaxReadBytes = 1 << 20
	// MaxFiles bounds the Markdown files read from the folder.
	MaxFiles = 1000
)

// Statuses are adr.STATUSES.
var Statuses = []string{"proposed", "accepted", "deprecated", "rejected", "superseded"}

// AppTypes are adr.APP_TYPES.
var AppTypes = []string{"web", "cli", "api", "grpc", "rest", "desktop", "mobile", "library"}

// Python's `\s` and `\d` match Unicode whitespace and Unicode decimal digits; Go's do not. These
// classes stand in for them wherever adr.py's patterns use them.
const (
	ws    = `\t\n\v\f\r \x{1c}-\x{1f}\x{85}\p{Z}`
	digit = `\p{Nd}`
)

var (
	fileRe       = regexp.MustCompile(`^(` + digit + `{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$`)
	supersededRe = regexp.MustCompile(`(?i)^superseded by \[?(ADR-` + digit + `{4})\]?(?:\([^()` + ws + `]*\))?$`)
	topicRe      = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	keyRe        = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)
	itemRe       = regexp.MustCompile(`^[` + ws + `]+-[` + ws + `]+(.+)$`)
	itemTopRe    = regexp.MustCompile(`^-[` + ws + `]+(.+)$`)
	pairRe       = regexp.MustCompile(`^([^:` + ws + `][^:]*):(?:[` + ws + `]+(.*))?$`)
	fenceRe      = regexp.MustCompile("^[" + ws + "]*(```|~~~)")
	headingRe    = regexp.MustCompile(`^#[` + ws + `]+([^` + ws + `].*?)[` + ws + `]*$`)
	servesRe     = regexp.MustCompile(`^(TN-` + digit + `{2,})@([1-9]` + digit + `*)$`)
	// IDRe is an ADR identifier as the page names one (ASCII digits).
	IDRe = regexp.MustCompile(`^ADR-[0-9]{4}$`)
)

// IsTopic reports a topic word (adr.TOPIC_RE).
func IsTopic(s string) bool { return topicRe.MatchString(s) }

// isSpace is Python's str.isspace for one character.
func isSpace(r rune) bool { return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f) }

// strip is Python's str.strip() with no argument.
func strip(s string) string { return strings.TrimFunc(s, isSpace) }

func lstrip(s string) string { return strings.TrimLeftFunc(s, isSpace) }

// cut is Python's s[:n] on characters.
func cut(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// digitValue is the value of a Unicode decimal digit: every run of decimal digits in Unicode starts
// at a zero and comes in tens, so the value is the distance from the run's start, modulo ten.
func digitValue(r rune) int {
	if r >= '0' && r <= '9' {
		return int(r - '0')
	}
	for _, rg := range unicode.Nd.R16 {
		if rune(rg.Lo) <= r && r <= rune(rg.Hi) {
			return int(r-rune(rg.Lo)) % 10
		}
	}
	for _, rg := range unicode.Nd.R32 {
		if rune(rg.Lo) <= r && r <= rune(rg.Hi) {
			return int(r-rune(rg.Lo)) % 10
		}
	}
	return 0
}

// number is Python's int() of a run of decimal digits.
func number(s string) int {
	n := 0
	for _, r := range s {
		n = n*10 + digitValue(r)
	}
	return n
}

// pyStr renders a decoded JSON value as Python's str() would, for messages that quote a setting.
func pyStr(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case bool:
		if x {
			return "True"
		}
		return "False"
	case string:
		return x
	case float64:
		if x == float64(int64(x)) && x < 1e15 && x > -1e15 {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'g', -1, 64)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = pyRepr(e)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case []string:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = pyRepr(e)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case map[string]any:
		return "{...}"
	}
	return fmt.Sprint(v)
}

func pyRepr(v any) string {
	if s, ok := v.(string); ok {
		return "'" + s + "'"
	}
	return pyStr(v)
}

// ---------------------------------------------------------------- the folder and the settings

// Config is the part of .factory/config.json this package reads: its "adr" section.
type Config struct {
	ADR map[string]any
}

// ConfigOf takes a decoded .factory/config.json (anything; not an object means no settings).
func ConfigOf(v any) Config {
	m, _ := v.(map[string]any)
	section, _ := m["adr"].(map[string]any)
	return Config{ADR: section}
}

// FolderOf is adr.folder_of: the ADR folder relative to the repository root, and a problem when
// the setting cannot be used.
func FolderOf(c Config) (string, string) {
	value, given := c.ADR["dir"]
	if c.ADR == nil || !given || value == nil {
		return DefaultDir, ""
	}
	s, isStr := value.(string)
	text := ""
	if isStr {
		text = strings.Trim(strip(s), "/")
	}
	var parts []string
	if text != "" {
		parts = strings.Split(text, "/")
	}
	bad := !isStr || text == "" || strings.HasPrefix(strip(s), "/") || strings.HasPrefix(strip(s), "~") || strings.Contains(text, "\\") || strings.Contains(text, ":")
	for _, p := range parts {
		if p == "" || p == "." || p == ".." {
			bad = true
		}
	}
	if !bad && parts[0] == ".factory" {
		bad = true
	}
	if bad {
		return DefaultDir, fmt.Sprintf("adr.dir in .factory/config.json (%s) is not a folder inside the repository, such as docs/adr; %s is read instead until it is fixed.",
			pyRepr(cut(pyStr(value), 80)), DefaultDir)
	}
	return strings.Join(parts, "/"), ""
}

// RequiredTopics are adr.REQUIRED_TOPICS, in order, each with its one line.
var RequiredTopics = []struct{ Topic, Description string }{
	{"language", "Language and runtime: the programming languages the code is written in, and the runtime versions it runs on."},
	{"framework", "Framework and application type: the frameworks the code is built on, and what kind of application it is."},
	{"storage", "Data storage: where and how the application keeps its data, or that it keeps none."},
	{"testing", "Testing approach: the test runner, the kinds of tests, and where they live."},
	{"deployment", "Deployment environment: where the application runs, and how a change gets there."},
	{"coding-standards", "Coding standards: the linter, formatter, type checking and conventions the code follows."},
}

// AddedTopic is adr.ADDED_TOPIC.
const AddedTopic = "A topic this project added to adr.required_topics in .factory/config.json."

// DescribeTopic is adr.describe_topic.
func DescribeTopic(topic string) string {
	for _, t := range RequiredTopics {
		if t.Topic == topic {
			return t.Description
		}
	}
	return AddedTopic
}

// RequiredTopicsOf is adr.required_topics: the topics a project requires, and the problems with its setting.
func RequiredTopicsOf(c Config) ([]string, []string) {
	defaults := func() []string {
		out := make([]string, len(RequiredTopics))
		for i, t := range RequiredTopics {
			out[i] = t.Topic
		}
		return out
	}
	value, given := c.ADR["required_topics"]
	if c.ADR == nil || !given {
		return defaults(), nil
	}
	list, isList := value.([]any)
	if !isList {
		return defaults(), []string{"adr.required_topics in .factory/config.json is not a list of topic words, so the default topics are required until it is fixed."}
	}
	topics := []string{}
	var problems []string
	for _, item := range list {
		name := cut(pyStr(item), 40)
		s, isStr := item.(string)
		if !isStr || !topicRe.MatchString(s) {
			problems = append(problems, fmt.Sprintf("adr.required_topics names %s, which is not a topic (one lowercase word, or words joined by '-'); no ADR can cover it until the setting is fixed.", pyRepr(name)))
		}
		dup := false
		for _, t := range topics {
			dup = dup || t == name
		}
		if !dup {
			topics = append(topics, name)
		}
	}
	return topics, problems
}

// ---------------------------------------------------------------- parsing

// Field is one header value: a string, or a list of strings.
type Field struct {
	Str    string
	List   []string
	IsList bool
}

func scalar(raw string) string {
	v := strip(raw)
	if len(v) >= 2 && v[0] == v[len(v)-1] && (v[0] == '\'' || v[0] == '"') {
		return v[1 : len(v)-1]
	}
	return v
}

// FrontMatter is adr.front_matter: the header's fields, the body after it, and every problem found.
func FrontMatter(text string) (map[string]*Field, string, []string) {
	var problems []string
	text = strings.TrimLeft(text, string(rune(0xFEFF)))
	lines := strings.Split(text, "\n")
	if len(lines) == 0 || strings.TrimRight(lines[0], "\r") != "---" {
		return map[string]*Field{}, text, []string{"it has no header: the file must start with a '---' line, then 'status: ...', then '---'"}
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimRight(lines[i], "\r") == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		return map[string]*Field{}, text, []string{"its header is not closed: add a '---' line after the last field"}
	}
	fields := map[string]*Field{}
	current := ""
	for i, raw := range lines[1:end] {
		number := i + 2
		line := strings.TrimRight(raw, "\r")
		if strings.Contains(line, "\t") {
			problems = append(problems, fmt.Sprintf("header line %d has a tab; use spaces", number))
			continue
		}
		if strip(line) == "" || strings.HasPrefix(lstrip(line), "#") {
			continue
		}
		item := itemRe.FindStringSubmatch(line)
		if item == nil {
			item = itemTopRe.FindStringSubmatch(line)
		}
		if item != nil {
			if f := fields[current]; current == "" || f == nil || !f.IsList {
				problems = append(problems, fmt.Sprintf("header line %d is a list item that belongs to no field", number))
			} else {
				f.List = append(f.List, scalar(item[1]))
			}
			continue
		}
		pair := pairRe.FindStringSubmatch(line)
		first, _ := utf8.DecodeRuneInString(line)
		if pair == nil || isSpace(first) || !keyRe.MatchString(strip(pair[1])) {
			problems = append(problems, fmt.Sprintf("header line %d is not 'key: value' or a '  - item' line", number))
			current = ""
			continue
		}
		key, value := strip(pair[1]), strip(pair[2])
		if _, twice := fields[key]; twice {
			problems = append(problems, fmt.Sprintf("the header names '%s' twice", key))
		}
		switch {
		case value == "":
			fields[key] = &Field{IsList: true, List: []string{}}
		case strings.HasPrefix(value, "["):
			if !strings.HasSuffix(value, "]") {
				problems = append(problems, fmt.Sprintf("header line %d: a list in brackets must end with ']'", number))
				fields[key] = &Field{IsList: true, List: []string{}}
			} else {
				inner := strip(value[1 : len(value)-1])
				list := []string{}
				if inner != "" {
					for _, part := range strings.Split(inner, ",") {
						list = append(list, scalar(part))
					}
				}
				fields[key] = &Field{IsList: true, List: list}
			}
		default:
			fields[key] = &Field{Str: scalar(value)}
		}
		current = key
	}
	return fields, strings.Join(lines[end+1:], "\n"), problems
}

func globProblem(pattern string) string {
	if pattern == "" || strings.HasPrefix(pattern, "/") || strings.HasPrefix(pattern, "~") || strings.Contains(pattern, "\\") {
		return "a path glob is relative to the repository root, such as src/api/**"
	}
	for _, part := range strings.Split(pattern, "/") {
		if part == "." || part == ".." {
			return "a path glob may not use '.' or '..'"
		}
	}
	if strings.ContainsAny(pattern, "[]{}!") {
		return "a path glob uses only *, ** and ?"
	}
	return ""
}

func fieldItems(f *Field) []string {
	if f == nil {
		return nil
	}
	if f.IsList {
		return append([]string(nil), f.List...)
	}
	return []string{f.Str}
}

// checkApplies is adr.check_applies: the applies-to items as given, and the problems with them.
func checkApplies(f *Field) ([]string, []string) {
	items := fieldItems(f)
	var problems []string
	if len(items) == 0 {
		problems = append(problems, "'applies-to' is empty: list at least one of path:<glob>, app:<type>, topic:<word> or all, or leave the field out to mean all")
	}
	out := make([]string, 0, len(items))
	for _, raw := range items {
		item := strip(raw)
		out = append(out, item)
		kind, rest, _ := strings.Cut(item, ":")
		switch {
		case item == "all":
		case kind == "path" && rest != "":
			if p := globProblem(rest); p != "" {
				problems = append(problems, fmt.Sprintf("'applies-to' item '%s': %s", cut(item, 80), p))
			}
		case kind == "app" && rest != "":
			known := false
			for _, a := range AppTypes {
				known = known || a == rest
			}
			if !known {
				problems = append(problems, fmt.Sprintf("'applies-to' item '%s': the app type must be one of %s", cut(item, 80), strings.Join(AppTypes, ", ")))
			}
		case kind == "topic" && rest != "":
			if !topicRe.MatchString(rest) {
				problems = append(problems, fmt.Sprintf("'applies-to' item '%s': a topic is one lowercase word, or words joined by '-'", cut(item, 80)))
			}
		default:
			problems = append(problems, fmt.Sprintf("'applies-to' item '%s' is not path:<glob>, app:<type>, topic:<word> or all", cut(item, 80)))
		}
	}
	return out, problems
}

// checkServes is adr.check_serves, for its problems only (the page does not show what an ADR serves).
func checkServes(f *Field) []string {
	var raw []string
	if f.IsList {
		raw = f.List
	} else {
		raw = strings.Split(f.Str, ",")
	}
	var items []string
	for _, item := range raw {
		if s := strip(item); s != "" {
			items = append(items, s)
		}
	}
	if len(items) == 0 {
		return []string{"'serves' is empty: name each technical need at its revision, such as TN-01@2, or leave the field out"}
	}
	var problems []string
	seen := map[string]bool{}
	for _, item := range items {
		m := servesRe.FindStringSubmatch(item)
		switch {
		case m == nil:
			problems = append(problems, fmt.Sprintf("'serves' item '%s' is not a technical need at a revision, such as TN-01@2", cut(item, 80)))
		case seen[m[1]]:
			problems = append(problems, fmt.Sprintf("'serves' names %s twice", m[1]))
		default:
			seen[m[1]] = true
		}
	}
	return problems
}

// Record is one ADR file, as adr.parse makes it (without the fields the page does not use).
type Record struct {
	ID             string   // "ADR-0007"; "" when the file name has no number
	Number         int      // -1 when the file name has no number
	File           string   // repository-relative path
	Title          string   // "" when it has none
	Status         string   // one of Statuses; "" when it cannot be read
	SupersededBy   string   // "ADR-0009" when superseded
	AppliesTo      []string // the applies-to items; ["all"] when the field is left out
	AppliesToGiven bool
	DecisionMakers []string // the header's decision-makers, split on commas (people's names: never served)
	Digest         string   // SHA-256 of the text, as adr.digest
	Problems       []string
	Binding        bool
	Text           string
	// Unread is set when the file itself could not be read; Text is then empty.
	Unread bool
}

// Topics are the topic words the ADR's applies-to names.
func (r *Record) Topics() []string {
	var out []string
	for _, item := range r.AppliesTo {
		if t, ok := strings.CutPrefix(item, "topic:"); ok && topicRe.MatchString(t) {
			out = append(out, t)
		}
	}
	return out
}

// Digest is adr.digest.
func Digest(text string) string {
	h := sha256.Sum256([]byte(text))
	return hex.EncodeToString(h[:])
}

// Parse is adr.parse: one ADR file as a record. A record with any problem never binds.
func Parse(text, name string) *Record {
	base := name
	if i := strings.LastIndex(name, "/"); i >= 0 {
		base = name[i+1:]
	}
	r := &Record{Number: -1, File: name, AppliesTo: []string{"all"}, Digest: Digest(text), Text: text}
	var problems []string
	m := fileRe.FindStringSubmatch(base)
	if m == nil {
		problems = append(problems, "the file name must be NNNN-title.md: four digits, then lowercase words joined by '-'")
	} else {
		r.Number = number(m[1])
		r.ID = fmt.Sprintf("ADR-%04d", r.Number)
	}
	if len(text) > MaxBytes {
		problems = append(problems, fmt.Sprintf("the file is larger than %d KB", MaxBytes/1000))
	}
	fields, body, headerProblems := FrontMatter(text)
	problems = append(problems, headerProblems...)
	for _, wrong := range []string{"applies_to", "appliesTo", "applies to", "Applies-To"} {
		if _, ok := fields[wrong]; ok {
			problems = append(problems, fmt.Sprintf("the header names '%s': MACH reads 'applies-to'", wrong))
		}
	}
	status, hasStatus := fields["status"]
	if !hasStatus && len(headerProblems) == 0 {
		problems = append(problems, "the header has no 'status' field")
	} else if hasStatus {
		value := ""
		if !status.IsList {
			value = strip(status.Str)
		}
		if sm := supersededRe.FindStringSubmatch(value); sm != nil {
			r.Status, r.SupersededBy = "superseded", strings.ToUpper(sm[1])
		} else if value != "superseded" && contains(Statuses, value) {
			r.Status = value
		} else {
			shown := status.Str
			if status.IsList {
				shown = pyStr(status.List)
			}
			problems = append(problems, fmt.Sprintf("status '%s' is not one of: proposed, accepted, deprecated, rejected, superseded by ADR-NNNN", cut(shown, 60)))
		}
	}
	if f, ok := fields["applies-to"]; ok {
		items, applies := checkApplies(f)
		r.AppliesTo, r.AppliesToGiven = items, true
		problems = append(problems, applies...)
	}
	if f, ok := fields["serves"]; ok {
		problems = append(problems, checkServes(f)...)
	}
	if f, ok := fields["decision-makers"]; ok {
		for _, item := range fieldItems(f) {
			for _, part := range strings.Split(item, ",") {
				if p := strip(part); p != "" {
					r.DecisionMakers = append(r.DecisionMakers, p)
				}
			}
		}
	}
	fenced := false
	for _, line := range strings.Split(body, "\n") {
		if fenceRe.MatchString(line) {
			fenced = !fenced
			continue
		}
		if fenced {
			continue
		}
		if h := headingRe.FindStringSubmatch(line); h != nil {
			r.Title = cut(h[1], 200)
			break
		}
	}
	if r.Title == "" {
		problems = append(problems, "it has no title: the first heading after the header must be '# <the decision>'")
	}
	r.Problems = problems
	r.Binding = r.Status == "accepted" && len(problems) == 0
	return r
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// File is one Markdown file of the folder as read: its text, or why it could not be read.
type File struct {
	Name   string // repository-relative path
	Text   string
	Unread string // why it could not be read; "" when Text holds it
}

// ReadFolder is adr.read_folder over files ({path: text}, sorted by path): every ADR directly inside
// folder, and the folder's problems. A file that could not be read is an ADR record with that
// problem when its name says it is meant to be one.
func ReadFolder(files []File, folder string) ([]*Record, []string) {
	sorted := append([]File(nil), files...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	prefix := strings.TrimRight(folder, "/") + "/"
	var records []*Record
	for _, f := range sorted {
		rest, inside := strings.CutPrefix(f.Name, prefix)
		if !inside || strings.Contains(rest, "/") {
			continue
		}
		first, _ := utf8.DecodeRuneInString(rest)
		if !strings.HasSuffix(rest, ".md") || !unicode.IsDigit(first) {
			continue
		}
		if f.Unread != "" {
			r := Parse("", f.Name)
			r.Text, r.Digest, r.Title, r.Unread = "", "", "", true
			r.Problems = []string{f.Unread}
			if m := fileRe.FindStringSubmatch(rest); m == nil {
				r.Problems = append([]string{"the file name must be NNNN-title.md: four digits, then lowercase words joined by '-'"}, r.Problems...)
			}
			r.Binding = false
			records = append(records, r)
			continue
		}
		records = append(records, Parse(f.Text, f.Name))
	}
	byNumber := map[int][]*Record{}
	var numbers []int
	for _, r := range records {
		if r.Number >= 0 {
			if _, seen := byNumber[r.Number]; !seen {
				numbers = append(numbers, r.Number)
			}
			byNumber[r.Number] = append(byNumber[r.Number], r)
		}
	}
	for _, n := range numbers {
		same := byNumber[n]
		if len(same) < 2 {
			continue
		}
		for _, r := range same {
			var others []string
			for _, o := range same {
				if o != r {
					others = append(others, o.File)
				}
			}
			// adr.py names the later file (by when it reached the main branch) and the command that
			// renumbers it; which one is later needs git, so this names both files only.
			r.Problems = append(r.Problems, fmt.Sprintf("another file has the same number: %s. Neither binds until the later one is renumbered (/mach adr renumber <file>), then the change is committed by pull request",
				strings.Join(others, ", ")))
			r.Binding = false
		}
	}
	ids := map[string]bool{}
	for _, r := range records {
		if r.ID != "" {
			ids[r.ID] = true
		}
	}
	for _, r := range records {
		if r.SupersededBy != "" && !ids[r.SupersededBy] {
			r.Problems = append(r.Problems, fmt.Sprintf("it is superseded by %s, which does not exist", r.SupersededBy))
		}
	}
	var problems []string
	for _, r := range records {
		for _, p := range r.Problems {
			problems = append(problems, r.File+": "+p)
		}
	}
	return records, problems
}

// ---------------------------------------------------------------- reading a project

// Listing is what Read found: adr.main_listing's shape, read from the working tree.
type Listing struct {
	Dir        string
	DirProblem string // the folder setting cannot be used ("" when it can)
	Config     string // "read", "missing" or "unreadable"
	Records    []*Record
	Problems   []string // the setting's problem, the folder's, then every record's ("<file>: <problem>")
	Found      bool     // the folder exists
}

// ReadConfig reads .factory/config.json under root: the decoded settings and how it went.
func ReadConfig(root string) (Config, string) {
	files := normalize.DirFiles{Dir: root}
	if _, err := os.Lstat(filepath.Join(root, ".factory", "config.json")); err != nil {
		return Config{}, "missing"
	}
	b, ok := files.Read(".factory/config.json", 4<<20)
	if !ok {
		return Config{}, "unreadable"
	}
	var v any
	if json.Unmarshal(b, &v) != nil {
		return Config{}, "unreadable"
	}
	return ConfigOf(v), "read"
}

// Read reads the project's ADRs from the ADR folder of the main checkout's working tree under root.
func Read(root string, cfg Config, configState string) Listing {
	folder, setting := FolderOf(cfg)
	l := Listing{Dir: folder, DirProblem: setting, Config: configState}
	if setting != "" {
		l.Problems = append(l.Problems, setting)
	}
	// Every component of the folder must be a real folder: a link is not followed.
	cur := root
	for _, part := range strings.Split(folder, "/") {
		cur = filepath.Join(cur, part)
		info, err := os.Lstat(cur)
		if err != nil {
			return l
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			l.Problems = append(l.Problems, folder+" is reached through a symbolic link or is not a folder; the Factory Floor does not follow links, so no ADR is read from it.")
			return l
		}
	}
	l.Found = true
	entries, err := os.ReadDir(cur)
	if err != nil {
		l.Problems = append(l.Problems, folder+" could not be listed, so no ADR is read from it.")
		return l
	}
	files := normalize.DirFiles{Dir: root}
	var read []File
	count := 0
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".md") || name == ".md" {
			continue
		}
		if !e.Type().IsRegular() {
			if e.Type()&os.ModeSymlink != 0 {
				read = append(read, File{Name: folder + "/" + name, Unread: "it is a symbolic link, which the Factory Floor does not follow"})
			}
			continue
		}
		if count++; count > MaxFiles {
			l.Problems = append(l.Problems, fmt.Sprintf("%s holds more than %d Markdown files; only the first %d are read here.", folder, MaxFiles, MaxFiles))
			break
		}
		rel := folder + "/" + name
		b, ok := files.Read(rel, MaxReadBytes)
		if !ok {
			why := "it could not be read"
			if info, err := e.Info(); err == nil && info.Size() > MaxReadBytes {
				why = fmt.Sprintf("the file is larger than %d KB", MaxBytes/1000)
			}
			read = append(read, File{Name: rel, Unread: why})
			continue
		}
		read = append(read, File{Name: rel, Text: strings.ToValidUTF8(string(b), "�")})
	}
	records, problems := ReadFolder(read, folder)
	l.Records = records
	l.Problems = append(l.Problems, problems...)
	return l
}

// ---------------------------------------------------------------- the baseline

// TopicRow is one required topic and what covers it.
type TopicRow struct {
	Topic       string
	Description string
	CoveredBy   []string
	Files       []string
}

// Coverage is adr.coverage over a listing.
type Coverage struct {
	Required []string
	Topics   []TopicRow
	Missing  []string
	Problems []string // the required_topics setting's problems
}

// CoverageOf is adr.coverage: which required topics a binding ADR covers, and which are missing.
func CoverageOf(cfg Config, records []*Record) Coverage {
	topics, problems := RequiredTopicsOf(cfg)
	c := Coverage{Required: topics, Problems: problems, Missing: []string{}}
	for _, topic := range topics {
		row := TopicRow{Topic: topic, Description: DescribeTopic(topic), CoveredBy: []string{}, Files: []string{}}
		for _, r := range records {
			if r.Binding && contains(r.AppliesTo, "topic:"+topic) {
				row.CoveredBy = append(row.CoveredBy, r.ID)
				row.Files = append(row.Files, r.File)
			}
		}
		if len(row.CoveredBy) == 0 {
			c.Missing = append(c.Missing, topic)
		}
		c.Topics = append(c.Topics, row)
	}
	return c
}
