package redact

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"path"
	"strings"
)

// Structured redaction of the JSON records MACH's stations write, for serving them whole
// (artifact content) or reading them (people). Each kind of record has the keys its writer is
// known to use; a known key's string is scrubbed by the text rules and kept; a person-bearing key
// (PersonKey, and every person field of an approval object) is replaced by the role form whatever
// it holds; an unknown key is kept only when its value passes the scrubber untouched, otherwise
// its value is withheld. Map keys that are identifiers (verification items, seats) must be
// identifiers. Key order is kept. A record that is not JSON, or of a kind not listed here, is
// served through the text scrubber instead (ScrubDocument).

// RecordKind names a kind of MACH record.
type RecordKind string

// Record kinds the observer knows.
const (
	KindDecision    RecordKind = "decision"     // review/round-N/decision.json (review.py)
	KindVote        RecordKind = "vote"         // review/round-N/votes/<seat>.json (review.py)
	KindResults     RecordKind = "results"      // evidence/results.json (verify.py)
	KindSummary     RecordKind = "summary"      // evidence/summary.json (verify.py)
	KindBuildReport RecordKind = "build-report" // build-report.json (build.py)
	KindCell        RecordKind = "cell"         // cell.json (cell.py)
	KindRunRecord   RecordKind = "run-record"   // one line of .factory/archive/runs.jsonl (cleanup.py)
	KindUnknown     RecordKind = ""
)

// KindOf is the record kind of a cell- or project-relative file name.
func KindOf(rel string) RecordKind {
	base := path.Base(rel)
	switch {
	case base == "decision.json":
		return KindDecision
	case path.Base(path.Dir(rel)) == "votes" && strings.HasSuffix(base, ".json"):
		return KindVote
	case base == "results.json":
		return KindResults
	case base == "summary.json":
		return KindSummary
	case base == "build-report.json":
		return KindBuildReport
	case base == "cell.json":
		return KindCell
	case base == "runs.jsonl":
		return KindRunRecord
	}
	return KindUnknown
}

type recordRules struct {
	known map[string]bool // keys (at any depth) whose values are MACH-written
	idMap map[string]bool // keys whose object's keys are identifiers (items, seats)
	free  map[string]bool // keys whose object's keys are free text (scrubbed, dropped when sensitive)
}

func keys(list ...string) map[string]bool {
	m := map[string]bool{}
	for _, k := range list {
		m[k] = true
	}
	return m
}

var rules = map[RecordKind]recordRules{
	KindDecision: {known: keys("ticket_id", "round", "risk", "outcome", "approvals", "approvals_needed", "votes", "blockers", "security_veto",
		"human_approval_required", "human_approval_reasons", "human_approval", "note", "recorded_at", "head", "findings", "decided_at",
		"since_commit", "delta", "seats", "models", "notes"),
		idMap: keys("votes", "models")},
	KindVote: {known: keys("at", "head", "seat", "reviewer", "model", "summary", "vote", "findings", "severity", "rule", "file", "title",
		"detail", "line", "round", "notes", "note", "since_commit")},
	KindResults: {known: keys("app_type", "contracts", "log", "valid", "head", "records", "at", "evidence", "bytes", "file", "sha256", "kind",
		"note", "result", "review_loop", "slice_id", "started_at", "started_epoch", "suite", "command", "exit_code", "passed", "seconds",
		"ticket_id", "tools_available", "holdouts"),
		idMap: keys("records")},
	KindSummary: {known: keys("app_type", "checks", "evidence", "kind", "note", "result", "contract_valid", "evidence_files", "file", "sha256",
		"evidence_kinds", "head", "holdout_tests_passed", "review_loop", "slice_id", "status", "suite", "command", "exit_code", "log",
		"passed", "seconds", "ticket_id", "timestamp", "tools_available", "missing", "verdict"),
		idMap: keys("checks"), free: keys("evidence_kinds")},
	KindBuildReport: {known: keys("baseline", "branch", "diff", "files_changed", "finished_at", "head", "human_review_required", "lint", "command",
		"status", "review_loop", "risk", "slice_id", "tasks", "commit", "first_run", "id", "kind", "loop", "note", "test_files", "tests",
		"exit_code", "passed", "seconds", "tests_seen_failing_first", "ticket_id", "overrides", "gate", "reason", "deviations", "ui_findings")},
	KindCell: {known: keys("app_type", "branch", "created_at", "human_review_required", "isolation", "merged", "at", "commit", "landed_commit",
		"method", "mode", "review", "risk", "slice_id", "spec_path", "spec_sha256", "stage", "ticket_id", "title", "updated_at",
		"verification", "contracts", "product", "wave_id", "revision", "source_commit", "digest")},
	KindRunRecord: {known: keys("abandon_reason", "app_type", "archive", "blockers", "closed_at", "created_at", "deviations", "escalated",
		"first_pass", "human_approval", "integration", "branch", "into", "method", "approved_commit", "landed_commit", "merge_commit",
		"pull_request", "merged_at", "mode", "notes", "outcome", "product", "record_version", "review_rejections", "risk", "rounds",
		"slice_id", "tests_passing_on_first_run", "tests_seen_failing_first", "ticket_id", "title", "verify_failures", "verify_findings",
		"rule", "count", "seat", "type", "kind", "wave_id", "revision")},
}

// seatNames are what a vote's "reviewer" holds when a model, not a person, reviewed.
var seatNames = keys("architecture", "security", "product", "general")

// RecordOptions tune ScrubRecord.
type RecordOptions struct {
	HashKeys  []string // keys whose value, when wholly a digest or commit, is kept
	SafeNames []string // relative file names known to be safe (see DocOptions.SafeNames)
}

// ErrNotRecord: the bytes are not a JSON record of a known kind; serve them as text instead.
var ErrNotRecord = errors.New("not a JSON record of a known kind")

// ScrubRecord applies the structured rules of kind to a JSON record (for KindRunRecord, to each
// line of a JSON-lines file) and returns it indented, with how many values it replaced.
func ScrubRecord(data []byte, kind RecordKind, projectRoot string, opt RecordOptions) (string, int, error) {
	r, ok := rules[kind]
	if !ok {
		return "", 0, ErrNotRecord
	}
	w := &walker{r: r, root: projectRoot, people: PeopleFor(projectRoot), hash: keys(opt.HashKeys...), safe: keys(opt.SafeNames...)}
	var out bytes.Buffer
	if kind == KindRunRecord {
		for _, line := range bytes.Split(data, []byte("\n")) {
			if len(bytes.TrimSpace(line)) == 0 {
				continue
			}
			v, err := decodeOrdered(line)
			if err != nil {
				return "", 0, ErrNotRecord
			}
			v = w.value(v, "", false, false, 0)
			b, _ := encodeOrdered(v, "")
			out.Write(b)
			out.WriteByte('\n')
		}
	} else {
		v, err := decodeOrdered(data)
		if err != nil {
			return "", 0, ErrNotRecord
		}
		v = w.value(v, "", false, false, 0)
		b, _ := encodeOrdered(v, "  ")
		out.Write(b)
		out.WriteByte('\n')
	}
	return out.String(), w.n, nil
}

type walker struct {
	r      recordRules
	root   string
	people *People
	hash   map[string]bool
	safe   map[string]bool
	n      int
}

// value redacts v found under key. known: the key is one the kind knows; approval: inside an
// approval object.
func (w *walker) value(v any, key string, known, approval bool, depth int) any {
	if depth > 64 {
		w.n++
		return "[withheld]"
	}
	switch x := v.(type) {
	case *ordered:
		idMap, free := w.r.idMap[key], w.r.free[key]
		kept := x.kv[:0]
		for _, kv := range x.kv {
			k := kv.k
			switch {
			case idMap:
				if _, ok := ID(k); !ok {
					w.n++
					continue
				}
				kv.v = w.value(kv.v, "", true, approval, depth+1)
				kept = append(kept, kv)
				continue
			case free:
				if Sensitive(k) || len(k) > 200 || w.people.Hit(k) {
					w.n++
					continue
				}
				kv.v = w.value(kv.v, "", true, approval, depth+1)
				kept = append(kept, kv)
				continue
			}
			if Sensitive(k) || w.people.Hit(k) {
				w.n++
				continue
			}
			if PersonKey(k) || approval && personInApproval(k) {
				if s, ok := kv.v.(string); ok && k == "reviewer" && seatNames[s] {
					kept = append(kept, kv) // a seat, not a person
					continue
				}
				if s, ok := kv.v.(string); ok && RolePhrase(s) && !w.people.Hit(s) && !Sensitive(s) {
					kept = append(kept, kv) // a role MACH wrote ("an agent, on the person's instruction…"), not a person
					continue
				}
				if kv.v != nil {
					w.n++
					kv.v = Role
				}
				kept = append(kept, kv)
				continue
			}
			kv.v = w.value(kv.v, k, w.r.known[k], approval || ApprovalKey(k), depth+1)
			kept = append(kept, kv)
		}
		x.kv = kept
		return x
	case []any:
		for i := range x {
			x[i] = w.value(x[i], key, known, approval, depth+1)
		}
		return x
	case string:
		return w.str(x, key, known)
	}
	return v
}

func (w *walker) str(s, key string, known bool) any {
	if w.hash[key] && wholeDigest(s) {
		return s
	}
	rel := rootRelative(s, w.root)
	if w.safe[rel] {
		if rel != s {
			w.n++
		}
		return rel
	}
	if !known {
		// A whole hex value under a key not known to hold a hash may be a key, not a digest.
		if Sensitive(s) || w.people.Hit(s) || len(s) > 2*MaxText || len(s) >= 32 && wholeDigest(s) {
			w.n++
			return "[withheld]"
		}
		return s
	}
	out, k := ScrubDocument(s, w.root, DocOptions{SafeNames: keysOf(w.safe)})
	w.n += k
	return out
}

func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// ---- JSON with its key order kept ----

type kv struct {
	k string
	v any
}

type ordered struct{ kv []kv }

func decodeOrdered(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := readValue(dec, 0)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data")
	}
	return v, nil
}

func readValue(dec *json.Decoder, depth int) (any, error) {
	if depth > 128 {
		return nil, errors.New("too deep")
	}
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch d := t.(type) {
	case json.Delim:
		switch d {
		case '{':
			o := &ordered{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, errors.New("bad key")
				}
				v, err := readValue(dec, depth+1)
				if err != nil {
					return nil, err
				}
				o.kv = append(o.kv, kv{k, v})
			}
			_, err := dec.Token()
			return o, err
		case '[':
			list := []any{}
			for dec.More() {
				v, err := readValue(dec, depth+1)
				if err != nil {
					return nil, err
				}
				list = append(list, v)
			}
			_, err := dec.Token()
			return list, err
		}
		return nil, errors.New("unexpected delimiter")
	}
	return t, nil
}

func encodeOrdered(v any, indent string) ([]byte, error) {
	var b bytes.Buffer
	err := writeValue(&b, v, indent, 0)
	return b.Bytes(), err
}

func writeValue(b *bytes.Buffer, v any, indent string, depth int) error {
	nl := func(d int) {
		if indent != "" {
			b.WriteByte('\n')
			b.WriteString(strings.Repeat(indent, d))
		}
	}
	switch x := v.(type) {
	case *ordered:
		if len(x.kv) == 0 {
			b.WriteString("{}")
			return nil
		}
		b.WriteByte('{')
		for i, e := range x.kv {
			if i > 0 {
				b.WriteByte(',')
			}
			nl(depth + 1)
			writeString(b, e.k)
			b.WriteByte(':')
			if indent != "" {
				b.WriteByte(' ')
			}
			if err := writeValue(b, e.v, indent, depth+1); err != nil {
				return err
			}
		}
		nl(depth)
		b.WriteByte('}')
	case []any:
		if len(x) == 0 {
			b.WriteString("[]")
			return nil
		}
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			nl(depth + 1)
			if err := writeValue(b, e, indent, depth+1); err != nil {
				return err
			}
		}
		nl(depth)
		b.WriteByte(']')
	case string:
		writeString(b, x)
	case json.Number:
		b.WriteString(x.String())
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case nil:
		b.WriteString("null")
	default:
		enc, err := json.Marshal(x)
		if err != nil {
			return err
		}
		b.Write(enc)
	}
	return nil
}

func writeString(b *bytes.Buffer, s string) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.Encode(s)
	b.Write(bytes.TrimRight(buf.Bytes(), "\n"))
}
