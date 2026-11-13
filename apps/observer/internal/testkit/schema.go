package testkit

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Schema is a minimal JSON Schema (draft 2020-12) checker, general for the keywords the version 3
// factory event schema uses: $ref (local), type, enum, const, properties, required,
// additionalProperties, propertyNames, items, uniqueItems, pattern, maxLength, minimum, format
// (date-time), not, allOf, anyOf, oneOf, if/then/else. A keyword it does not know is an error at
// load time, so a schema change cannot be silently half-checked.
type Schema struct {
	root  map[string]any
	mu    sync.Mutex
	regex map[string]*regexp.Regexp
}

var supported = map[string]bool{
	"$schema": true, "$id": true, "$defs": true, "$ref": true, "$comment": true, "title": true, "description": true, "examples": true,
	"type": true, "enum": true, "const": true, "properties": true, "required": true, "additionalProperties": true,
	"propertyNames": true, "items": true, "uniqueItems": true, "pattern": true, "maxLength": true, "minimum": true,
	"format": true, "not": true, "allOf": true, "anyOf": true, "oneOf": true, "if": true, "then": true, "else": true,
}

// RepoRoot is the repository root (three folders above apps/observer/internal/testkit).
func RepoRoot() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", ".."))
}

// LoadSchema reads and checks a schema file.
func LoadSchema(path string) (*Schema, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var root map[string]any
	if err := json.Unmarshal(b, &root); err != nil {
		return nil, err
	}
	s := &Schema{root: root, regex: map[string]*regexp.Regexp{}}
	if err := s.check(root, "#"); err != nil {
		return nil, err
	}
	return s, nil
}

// EventSchema loads docs/mach-next/schemas/factory-event.v3.schema.json.
func EventSchema() (*Schema, error) {
	return LoadSchema(filepath.Join(RepoRoot(), "docs", "mach-next", "schemas", "factory-event.v3.schema.json"))
}

func (s *Schema) check(node any, at string) error {
	m, ok := node.(map[string]any)
	if !ok {
		return nil
	}
	for k, v := range m {
		if !supported[k] {
			return fmt.Errorf("%s: keyword %q is not supported by the checker", at, k)
		}
		switch k {
		case "properties", "$defs":
			for name, child := range v.(map[string]any) {
				if err := s.check(child, at+"/"+k+"/"+name); err != nil {
					return err
				}
			}
		case "allOf", "anyOf", "oneOf":
			for i, child := range v.([]any) {
				if err := s.check(child, fmt.Sprintf("%s/%s/%d", at, k, i)); err != nil {
					return err
				}
			}
		case "items", "not", "if", "then", "else", "additionalProperties", "propertyNames":
			if err := s.check(v, at+"/"+k); err != nil {
				return err
			}
		case "pattern":
			if _, err := regexp.Compile(v.(string)); err != nil {
				return fmt.Errorf("%s: pattern %q: %v", at, v, err)
			}
		}
	}
	return nil
}

// ValidateJSON checks one encoded document and returns every violation.
func (s *Schema) ValidateJSON(b []byte) []string {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return []string{"not JSON: " + err.Error()}
	}
	return s.Validate(v)
}

// Validate checks a decoded document.
func (s *Schema) Validate(v any) []string {
	var errs []string
	s.validate(s.root, v, "", &errs)
	return errs
}

func (s *Schema) re(p string) *regexp.Regexp {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.regex[p]; ok {
		return r
	}
	r := regexp.MustCompile(p)
	s.regex[p] = r
	return r
}

func (s *Schema) resolve(ref string) any {
	if !strings.HasPrefix(ref, "#/") {
		return nil
	}
	var node any = s.root
	for _, part := range strings.Split(ref[2:], "/") {
		m, ok := node.(map[string]any)
		if !ok {
			return nil
		}
		node = m[part]
	}
	return node
}

func typeOf(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case string:
		return "string"
	case float64:
		if x == float64(int64(x)) {
			return "integer"
		}
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}

func typeMatches(want string, v any) bool {
	got := typeOf(v)
	return want == got || want == "number" && got == "integer"
}

func (s *Schema) ok(node, v any) bool {
	var errs []string
	s.validate(node, v, "", &errs)
	return len(errs) == 0
}

func (s *Schema) validate(node, v any, at string, errs *[]string) {
	if b, isBool := node.(bool); isBool {
		if !b {
			*errs = append(*errs, at+": not allowed")
		}
		return
	}
	m, _ := node.(map[string]any)
	if m == nil {
		return
	}
	fail := func(format string, args ...any) { *errs = append(*errs, at+": "+fmt.Sprintf(format, args...)) }
	if ref, ok := m["$ref"].(string); ok {
		target := s.resolve(ref)
		if target == nil {
			fail("unresolved $ref %s", ref)
		} else {
			s.validate(target, v, at, errs)
		}
	}
	if t, ok := m["type"]; ok {
		matched := false
		switch tt := t.(type) {
		case string:
			matched = typeMatches(tt, v)
		case []any:
			for _, x := range tt {
				if typeMatches(x.(string), v) {
					matched = true
				}
			}
		}
		if !matched {
			fail("type %v, got %s", t, typeOf(v))
			return
		}
	}
	if e, ok := m["enum"].([]any); ok {
		found := false
		for _, x := range e {
			if reflect.DeepEqual(x, v) {
				found = true
			}
		}
		if !found {
			fail("%v is not one of %v", v, e)
		}
	}
	if c, ok := m["const"]; ok && !reflect.DeepEqual(c, v) {
		fail("%v is not %v", v, c)
	}
	switch x := v.(type) {
	case string:
		if p, ok := m["pattern"].(string); ok && !s.re(p).MatchString(x) {
			fail("%q does not match %s", x, p)
		}
		if n, ok := m["maxLength"].(float64); ok && utf8.RuneCountInString(x) > int(n) {
			fail("longer than %v", n)
		}
		if f, ok := m["format"].(string); ok && f == "date-time" {
			if _, err := time.Parse(time.RFC3339Nano, x); err != nil {
				fail("%q is not a date-time", x)
			}
		}
	case float64:
		if n, ok := m["minimum"].(float64); ok && x < n {
			fail("%v is below %v", x, n)
		}
	case []any:
		if items, ok := m["items"]; ok {
			for i, item := range x {
				s.validate(items, item, fmt.Sprintf("%s/%d", at, i), errs)
			}
		}
		if u, ok := m["uniqueItems"].(bool); ok && u {
			seen := map[string]bool{}
			for _, item := range x {
				b, _ := json.Marshal(item)
				if seen[string(b)] {
					fail("duplicate item %s", b)
				}
				seen[string(b)] = true
			}
		}
	case map[string]any:
		props, _ := m["properties"].(map[string]any)
		for _, r := range asList(m["required"]) {
			if _, ok := x[r.(string)]; !ok {
				fail("missing required %q", r)
			}
		}
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if pn, ok := m["propertyNames"]; ok {
				s.validate(pn, k, at+"/"+k+"(name)", errs)
			}
			if p, ok := props[k]; ok {
				s.validate(p, x[k], at+"/"+k, errs)
			} else if ap, ok := m["additionalProperties"]; ok {
				s.validate(ap, x[k], at+"/"+k, errs)
			}
		}
	}
	for _, sub := range asList(m["allOf"]) {
		s.validate(sub, v, at, errs)
	}
	if any, ok := m["anyOf"].([]any); ok {
		hit := false
		for _, sub := range any {
			if s.ok(sub, v) {
				hit = true
				break
			}
		}
		if !hit {
			fail("matches none of anyOf")
		}
	}
	if one, ok := m["oneOf"].([]any); ok {
		n := 0
		for _, sub := range one {
			if s.ok(sub, v) {
				n++
			}
		}
		if n != 1 {
			fail("matches %d of oneOf, want 1", n)
		}
	}
	if not, ok := m["not"]; ok && s.ok(not, v) {
		fail("matches a schema it must not")
	}
	if cond, ok := m["if"]; ok {
		if s.ok(cond, v) {
			if then, ok := m["then"]; ok {
				s.validate(then, v, at, errs)
			}
		} else if els, ok := m["else"]; ok {
			s.validate(els, v, at, errs)
		}
	}
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}
