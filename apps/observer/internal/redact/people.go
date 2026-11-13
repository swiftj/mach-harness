package redact

import (
	"bytes"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

// People is a project's deny-list of people: the names and e-mail addresses MACH's own files
// say belong to a person (an approver, whoever enabled the Factory, a ledger "by", a git author
// or committer of the project). People's names are never sent to the browser in this milestone,
// so every text the observer lets out (each event string, each served document, each reply body)
// has these replaced by the role form, "a person". The list only grows while the observer runs.
//
// It is a complement to the structural rules, never a replacement: a person-bearing field is
// replaced by its key whatever its value (PersonKey); the list catches the same name where it
// reappears in free text (a finding, a note, a reason).
type People struct {
	mu      sync.RWMutex
	names   map[string]bool // lower-cased
	re      *regexp.Regexp  // case-insensitive, whole words; nil while empty
	variant [][]byte        // exact byte forms for the reply filter (as written, lower, Title)
}

// Role is what a person is called in everything the observer serves.
const Role = "a person"

var peopleFor sync.Map // root -> *People

// PeopleFor is the deny-list of the project at root (one per project; "" has its own).
func PeopleFor(root string) *People {
	if p, ok := peopleFor.Load(root); ok {
		return p.(*People)
	}
	p, _ := peopleFor.LoadOrStore(root, &People{names: map[string]bool{}})
	return p.(*People)
}

// notAName are words MACH itself writes where a person could be named (a writer, a role, a seat,
// a tool): they describe a role, not a person, and must stay readable.
var notAName = map[string]bool{
	"a person": true, "person": true, "people": true, "engineer": true, "supervisor": true, "scheduler": true, "human": true,
	"product manager": true, "pm": true, "system": true, "observer": true, "mach": true, "claude": true, "runner": true,
	"reviewer": true, "architecture": true, "security": true, "product": true, "general": true, "automation": true,
	"belt": true, "factory": true, "studio": true, "unknown": true, "none": true, "null": true, "true": true, "false": true,
	"root": true, "admin": true, "user": true, "users": true, "nobody": true, "bot": true, "ci": true, "git": true,
	"github": true, "github-actions": true, "local": true, "localhost": true, "test": true, "tests": true, "build": true,
	"verify": true, "review": true, "merge": true, "cleanup": true, "intent": true, "audit": true, "ticket": true,
	"observe": true, "supervised": true, "manual": true, "auto": true, "operator": true, "owner": true, "approver": true,
}

// candidate normalises a value that may be a person's name or e-mail; "" when it is not one.
func candidate(v string) string {
	v = strings.TrimSpace(v)
	if strings.ContainsAny(v, "\n\r\t") || !utf8.ValidString(v) {
		return ""
	}
	if n := utf8.RuneCountInString(v); n < 3 || n > 80 {
		return ""
	}
	if strings.IndexFunc(v, unicode.IsLetter) < 0 || notAName[strings.ToLower(v)] {
		return ""
	}
	return v
}

// Learn adds names (and e-mail addresses, with their local part) to the list. It reports
// whether the list changed.
func (p *People) Learn(values ...string) bool {
	if p == nil {
		return false
	}
	var add []string
	for _, v := range values {
		v = candidate(v)
		if v == "" {
			continue
		}
		forms := []string{v}
		// "Name <email>" (a git identity): both halves, not the pair.
		if i := strings.IndexByte(v, '<'); i > 0 && strings.HasSuffix(v, ">") {
			forms = []string{strings.TrimSpace(v[:i]), v[i+1 : len(v)-1]}
		}
		for _, f := range forms {
			if at := strings.IndexByte(f, '@'); at > 0 {
				if local := candidate(f[:at]); local != "" && utf8.RuneCountInString(local) >= 4 {
					forms = append(forms, local)
				}
			}
		}
		for _, f := range forms {
			if f = candidate(f); f != "" {
				add = append(add, f)
			}
		}
	}
	if len(add) == 0 {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	changed := false
	for _, a := range add {
		k := strings.ToLower(a)
		if !p.names[k] && len(p.names) < 512 {
			p.names[k] = true
			changed = true
		}
	}
	if changed {
		p.rebuild()
	}
	return changed
}

func (p *People) rebuild() {
	keys := make([]string, 0, len(p.names))
	for k := range p.names {
		keys = append(keys, k)
	}
	// Longest first, so "Ann Lee" is replaced before "Ann".
	sort.Slice(keys, func(i, j int) bool {
		if len(keys[i]) != len(keys[j]) {
			return len(keys[i]) > len(keys[j])
		}
		return keys[i] < keys[j]
	})
	parts := make([]string, len(keys))
	// A new slice, never the old one's array: readers hold the old one without the lock.
	var variant [][]byte
	seen := map[string]bool{}
	for i, k := range keys {
		parts[i] = regexp.QuoteMeta(k)
		for _, f := range []string{k, strings.ToUpper(k[:1]) + k[1:], titleWords(k), strings.ToUpper(k)} {
			for _, enc := range []string{f, jsonString(f)} {
				if !seen[enc] {
					seen[enc] = true
					variant = append(variant, []byte(enc))
				}
			}
		}
	}
	sort.SliceStable(variant, func(i, j int) bool { return len(variant[i]) > len(variant[j]) })
	p.variant = variant
	p.re = regexp.MustCompile(`(?i)(^|[^\pL\pN_])(` + strings.Join(parts, "|") + `)($|[^\pL\pN_])`)
}

func titleWords(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		r, n := utf8.DecodeRuneInString(w)
		words[i] = string(unicode.ToUpper(r)) + w[n:]
	}
	return strings.Join(words, " ")
}

// jsonString is s as it appears inside a JSON string (without the quotes).
func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b[1 : len(b)-1])
}

// Len is how many names the list holds.
func (p *People) Len() int {
	if p == nil {
		return 0
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	return len(p.names)
}

// Is reports whether v is wholly one of the listed names or addresses.
func (p *People) Is(v string) bool {
	if p == nil {
		return false
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.names[strings.ToLower(strings.TrimSpace(v))]
}

// Hit reports whether s mentions a listed person.
func (p *People) Hit(s string) bool {
	if p == nil {
		return false
	}
	p.mu.RLock()
	re := p.re
	p.mu.RUnlock()
	return re != nil && re.MatchString(s)
}

// Replace replaces every mention of a listed person in s by the role form and counts them.
func (p *People) Replace(s string) (string, int) {
	if p == nil {
		return s, 0
	}
	p.mu.RLock()
	re := p.re
	p.mu.RUnlock()
	if re == nil || !re.MatchString(s) {
		return s, 0
	}
	n := 0
	// The pattern consumes one boundary character on each side; run it until nothing is left, so
	// two names separated by one character are both replaced.
	for i := 0; i < 8 && re.MatchString(s); i++ {
		s = re.ReplaceAllStringFunc(s, func(m string) string {
			sub := re.FindStringSubmatch(m)
			n++
			return sub[1] + Role + sub[3]
		})
	}
	return s, n
}

// ReplaceBytes is the last filter on a reply body: every listed name, in the forms it is written
// in (as given, lower case, capitalised, upper case, and JSON-escaped), becomes the role form.
// It is exact-match (fast on a large body); Replace, case-insensitive, has already run on every
// string the observer built.
func (p *People) ReplaceBytes(b []byte) ([]byte, int) {
	if p == nil {
		return b, 0
	}
	p.mu.RLock()
	variants := p.variant
	p.mu.RUnlock()
	n := 0
	for _, v := range variants {
		if len(v) == 0 || !bytes.Contains(b, v) {
			continue
		}
		var out []byte
		last := 0
		for i := 0; i <= len(b)-len(v); {
			j := bytes.Index(b[i:], v)
			if j < 0 {
				break
			}
			at := i + j
			end := at + len(v)
			if wordEdge(b, at, true) && wordEdge(b, end, false) {
				out = append(out, b[last:at]...)
				out = append(out, Role...)
				last = end
				n++
				i = end
				continue
			}
			i = at + 1
		}
		if out != nil {
			b = append(out, b[last:]...)
		}
	}
	return b, n
}

// wordEdge: position i of b is a word boundary on that side (no letter, digit or underscore
// touching it). In JSON text an escape such as \n before a name counts as a boundary.
func wordEdge(b []byte, i int, before bool) bool {
	var r rune
	if before {
		if i == 0 {
			return true
		}
		r, _ = utf8.DecodeLastRune(b[:i])
		if i >= 2 && b[i-2] == '\\' && (b[i-1] == 'n' || b[i-1] == 't' || b[i-1] == 'r') {
			return true
		}
	} else {
		if i >= len(b) {
			return true
		}
		r, _ = utf8.DecodeRune(b[i:])
	}
	return !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_')
}

// PersonKey reports whether a JSON key names a person in MACH's records (and in git's): who
// approved, recorded, enabled, authored or committed something, and their e-mail.
func PersonKey(k string) bool {
	switch strings.ToLower(k) {
	case "by", "recorded_by", "approved_by", "enabled_by", "disabled_by", "paused_by", "resumed_by", "requested_by", "decided_by",
		"author", "author_name", "author_email", "committer", "committer_name", "committer_email", "authored_by", "committed_by",
		"actor", "approver", "reviewer", "reviewer_name", "user_name", "username", "email", "mail", "owner_name", "signed_off_by":
		return true
	}
	return false
}

// ApprovalKey reports a key whose object describes an approval: every string in it that is not a
// time or a note names a person.
func ApprovalKey(k string) bool {
	switch strings.ToLower(k) {
	case "human_approval", "approval", "approvals", "approver", "approved", "sign_off", "signoff":
		return true
	}
	return false
}

// LearnJSON adds to the list every string a JSON record holds under a person key or inside an
// approval object, at any depth. It reads nothing else.
func (p *People) LearnJSON(data []byte) bool {
	if p == nil || len(data) == 0 || len(data) > 16<<20 {
		return false
	}
	var v any
	if json.Unmarshal(data, &v) != nil {
		return false
	}
	var found []string
	collectPeople(v, false, &found, 0)
	return p.Learn(found...)
}

func collectPeople(v any, inApproval bool, out *[]string, depth int) {
	if depth > 32 || len(*out) > 256 {
		return
	}
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			switch s := val.(type) {
			case string:
				if PersonKey(k) || inApproval && personInApproval(k) {
					*out = append(*out, s)
				}
			case []any:
				if PersonKey(k) {
					for _, item := range s {
						if str, ok := item.(string); ok {
							*out = append(*out, str)
						}
					}
				} else {
					collectPeople(s, inApproval || ApprovalKey(k), out, depth+1)
				}
			default:
				collectPeople(val, inApproval || ApprovalKey(k), out, depth+1)
			}
		}
	case []any:
		for _, item := range x {
			collectPeople(item, inApproval, out, depth+1)
		}
	}
}

// personInApproval: inside an approval object, which keys hold a person (not its time, note,
// reason or state).
func personInApproval(k string) bool {
	k = strings.ToLower(k)
	if PersonKey(k) {
		return true
	}
	return strings.Contains(k, "name") || strings.Contains(k, "email") || strings.HasSuffix(k, "_by") || k == "who" || k == "person" || k == "user"
}
