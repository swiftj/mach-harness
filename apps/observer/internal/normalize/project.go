// Package normalize turns one source line into at most one normalized event. Each source has its
// own normalizer, and each normalizer keeps only allowlisted fields: anything not named in a
// table here is dropped and counted, never passed on. Unknown record types keep their identities
// and lose their data.
package normalize

import (
	"sort"
	"time"

	"mach/observer/internal/redact"
)

// Context is what a normalizer knows about the line besides its bytes.
type Context struct {
	ProjectRoot string
	Epoch       string // the file's generation (first 8 hex of SHA-256 of its first line)
	Offset      int64  // byte offset of the line
	Line        int64  // 1-based physical line number
	ObservedAt  time.Time
	Live        bool
	// Ticket is the cell folder's ticket ID, for lifecycle lines.
	Ticket string
}

// Problem kinds a line can be refused for. A refused line is counted, never shown.
const (
	ProblemMalformed   = "malformed"    // not a JSON object
	ProblemVersion     = "version"      // the wrong schema version
	ProblemEnvelope    = "envelope"     // a required envelope field is missing or has the wrong shape
	ProblemWrongTicket = "wrong-ticket" // a lifecycle line naming another cell
)

type kind int

const (
	kID        kind = iota // a MACH identifier
	kIDList                // a list of identifiers (at most 64 kept)
	kToken                 // a short lower-case word
	kTokenList             // a list of words (program names, categories)
	kCommit                // a hex commit
	kDigest                // a hex digest
	kNumber                // a finite number
	kInt                   // a whole number
	kBool                  // a boolean
	kText                  // MACH-written prose, scrubbed
	kTextList              // a list of prose items, scrubbed (at most 8 kept)
	kRelPath               // a plain relative path
	kCount                 // a list or object reduced to its length
	kPresent               // reduced to whether it was present and not empty
	kNumbers               // an object of numbers (limits), other values dropped
	kHeld                  // scheduling.decided's held list: [{slice_id|ticket_id, why}]
	kEvidence              // [{path|file, sha256}] with relative files and hex digests
	kLabel                 // a short label a station writes verbatim ("PASS", "APPROVED", "Gold"): an identifier of at most 40 characters
	kLabels                // an object of word -> label (review votes by seat, models by seat)
	kScalar                // a number or a boolean
)

// MaxLabel is the longest label kept.
const MaxLabel = 40

type field struct {
	name string
	kind kind
	as   string // output name; the input name when empty
}

// project applies spec to data and returns the kept values and how many input keys were dropped
// or failed their check.
func project(data map[string]any, spec []field, root string) (map[string]any, int) {
	return projectCounts(data, spec, root, false)
}

// projectCounts is project, and with counts it also keeps every other key whose name is a word
// and whose value is a whole number or a boolean, under data.counts: the "integer and boolean
// facts" the lifecycle contract allows for station entries and exits. Neither can carry text.
func projectCounts(data map[string]any, spec []field, root string, counts bool) (map[string]any, int) {
	if len(data) == 0 {
		return nil, 0
	}
	out := map[string]any{}
	used := map[string]bool{}
	withheld := 0
	for _, f := range spec {
		raw, ok := data[f.name]
		if !ok {
			continue
		}
		used[f.name] = true
		if raw == nil {
			continue
		}
		name := f.as
		if name == "" {
			name = f.name
		}
		value, ok := convert(raw, f.kind, root)
		if !ok {
			withheld++
			continue
		}
		out[name] = value
	}
	extra := map[string]any{}
	for k, v := range data {
		if used[k] {
			continue
		}
		if counts && len(extra) < 32 {
			name, okName := redact.Token(k)
			if b, isBool := v.(bool); okName && isBool {
				extra[name] = b
				continue
			}
			if n, isInt := redact.Int(v); okName && isInt {
				extra[name] = n
				continue
			}
		}
		withheld++
	}
	if len(extra) > 0 {
		out["counts"] = extra
	}
	if len(out) == 0 {
		out = nil
	}
	return out, withheld
}

func label(v any) (string, bool) {
	s, ok := redact.ID(v)
	if !ok || len(s) > MaxLabel {
		return "", false
	}
	return s, true
}

func convert(raw any, k kind, root string) (any, bool) {
	switch k {
	case kID:
		return redact.ID(raw)
	case kToken:
		return redact.Token(raw)
	case kCommit:
		return redact.Commit(raw)
	case kDigest:
		return redact.Digest(raw)
	case kNumber:
		return redact.Number(raw)
	case kInt:
		return redact.Int(raw)
	case kBool:
		return redact.Bool(raw)
	case kText:
		return redact.Text(raw, root)
	case kRelPath:
		return redact.RelPath(raw)
	case kLabel:
		return label(raw)
	case kScalar:
		if b, ok := raw.(bool); ok {
			return b, true
		}
		return redact.Number(raw)
	case kLabels:
		m, ok := raw.(map[string]any)
		if !ok {
			return nil, false
		}
		out := map[string]any{}
		for key, v := range m {
			if len(out) >= 16 {
				break
			}
			name, okName := redact.Token(key)
			value, okValue := label(v)
			if okName && okValue {
				out[name] = value
			}
		}
		return out, true
	case kIDList:
		return list(raw, 64, func(v any) (any, bool) { return redact.ID(v) })
	case kTokenList:
		return list(raw, 32, func(v any) (any, bool) { return redact.Token(v) })
	case kTextList:
		return list(raw, 8, func(v any) (any, bool) { return redact.Text(v, root) })
	case kCount:
		switch v := raw.(type) {
		case []any:
			return len(v), true
		case map[string]any:
			return len(v), true
		}
		return nil, false
	case kPresent:
		switch v := raw.(type) {
		case string:
			return v != "", true
		case []any:
			return len(v) > 0, true
		case map[string]any:
			return len(v) > 0, true
		case bool:
			return v, true
		}
		return true, true
	case kNumbers:
		m, ok := raw.(map[string]any)
		if !ok {
			return nil, false
		}
		out := map[string]any{}
		keys := make([]string, 0, len(m))
		for key := range m {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if len(out) >= 32 {
				break
			}
			name, okName := redact.Token(key)
			n, okNum := redact.Number(m[key])
			if okName && okNum {
				out[name] = n
			}
		}
		return out, true
	case kHeld:
		items, ok := raw.([]any)
		if !ok {
			return nil, false
		}
		var out []any
		for _, item := range items {
			if len(out) >= 64 {
				break
			}
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			kept := map[string]any{}
			if id, ok := redact.ID(obj["slice_id"]); ok {
				kept["slice_id"] = id
			}
			if id, ok := redact.ID(obj["ticket_id"]); ok {
				kept["ticket_id"] = id
			}
			if why, ok := redact.Text(obj["why"], root); ok {
				kept["why"] = why
			}
			if len(kept) > 0 {
				out = append(out, kept)
			}
		}
		return out, true
	case kEvidence:
		items, ok := raw.([]any)
		if !ok {
			return nil, false
		}
		var out []any
		for _, item := range items {
			if len(out) >= 64 {
				break
			}
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			ref := obj["path"]
			if ref == nil {
				ref = obj["file"]
			}
			file, okFile := redact.RelPath(ref)
			sum, okSum := redact.Digest(obj["sha256"])
			if okFile && okSum {
				out = append(out, map[string]any{"file": file, "sha256": sum})
			}
		}
		return out, true
	}
	return nil, false
}

func list(raw any, max int, each func(any) (any, bool)) (any, bool) {
	items, ok := raw.([]any)
	if !ok {
		return nil, false
	}
	out := make([]any, 0, min(len(items), max))
	for _, item := range items {
		if len(out) >= max {
			break
		}
		if v, ok := each(item); ok {
			out = append(out, v)
		}
	}
	return out, true
}

// Time formats used by MACH: intake and the supervisor write "2006-01-02T15:04:05Z", the stations
// isoformat with "+00:00". Both are UTC with one-second resolution; lifecycle lines may carry
// milliseconds.
func occurred(raw any) (string, string) {
	s, ok := raw.(string)
	if !ok || len(s) > 40 {
		return "", "unknown"
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			precision := "second"
			if t.Nanosecond() != 0 {
				precision = "ms"
			}
			return t.UTC().Format("2006-01-02T15:04:05.000Z"), precision
		}
	}
	return "", "unknown"
}

// Stamp formats an observation time.
func Stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
