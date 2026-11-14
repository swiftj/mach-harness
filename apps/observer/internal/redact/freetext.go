package redact

import (
	"encoding/json"
	"strings"
	"unicode"
)

// Free text (R1 of the M6.2 re-check, decided by the product owner: label, do not withhold).
//
// The scrubber replaces every person the project's records and git identities name (People),
// wherever they appear. A name that appears only in prose (a reviewer's finding, a verifier's
// note) is not known to it and is served as written. A served text that holds such prose says so,
// so the Control Tower can show it: the catalog entry carries FreeText and FreeTextNote, and the
// content reply the header FreeTextHeader with FreeTextValue.
const (
	FreeTextHeader = "X-MACH-Free-Text"
	FreeTextValue  = "unchecked-for-names"
	FreeTextNote   = "free text, not checked for names"
)

// FreeTextField is an event field whose value is prose kept after scrubbing (Text): secrets, paths
// and e-mail addresses are replaced and known people are "a person", but a name that appears only
// in the prose is served as written (R1). The same holds wherever the projection copies it.
type FreeTextField struct {
	Kind string `json:"kind"` // the event kind
	Path string `json:"path"` // in the event: "data.title", "data.reasons[]", "data.held[].why"
	Max  int    `json:"max"`  // characters kept at most
}

// FreeTextFields are every event field that keeps prose, the set M6.2 R1 extends to beyond
// artifact content. The session reply lists them (display_policy.free_text.event_fields), so a
// client shows each one as text, never as markup, and says it was not checked for names. A test
// holds each path to the allowlist (Allow); a kind or field that keeps prose must be added here.
var FreeTextFields = []FreeTextField{
	{"review.finding", "data.title", 200},
	{"agent.queued", "data.label", 120},
	{"agent.started", "data.label", 120},
	{"agent.queued", "data.phase", 60},
	{"agent.started", "data.phase", 60},
	{"workflow.phases_declared", "data.phases[].title", 60},
	{"intake.refused", "data.problems[]", 280},
	{"dependency.blocked", "data.reasons[]", 280},
	{"human.required", "data.reason", 280},
	{"factory.paused", "data.reason", 280},
	{"scheduling.decided", "data.held[].why", 280},
	{"work.scheduled", "data.authorization", 280},
	{"revision.superseded", "data.effect", 280},
	{"execution.completed", "data.waiting_for", 200},
	{"workflow.finished", "data.tickets[].waiting_for", 200},
}

// structuralKeys hold MACH-written values that are several words but never prose about people:
// a test command, and review.py's fixed reasons for a human approval.
var structuralKeys = keys("command", "human_approval_reasons")

// HasFreeText reports whether a text artifact holds prose the observer cannot check for names. A
// MACH record of a known kind (decision.json, results.json, ...) holds free text when any of its
// values, at any depth, is a string of more than one word, except under a person key (replaced
// by its role or kept as a role phrase, R2) or a structural key; a record whose values are all
// identifiers, numbers, times, hashes and paths does not. Anything else that is text (findings.md,
// a transcript, a log, an unknown JSON file) is free text unless it is empty.
func HasFreeText(rel string, data []byte) bool {
	if len(strings.TrimSpace(string(data))) == 0 {
		return false
	}
	kind := KindOf(rel)
	if kind == KindUnknown {
		return true
	}
	lines := [][]byte{data}
	if kind == KindRunRecord {
		lines = nil
		for _, l := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(l) != "" {
				lines = append(lines, []byte(l))
			}
		}
	}
	for _, l := range lines {
		var v any
		if json.Unmarshal(l, &v) != nil {
			return true // served through the text scrubber: prose for all it knows
		}
		if prose(v, "", 0) {
			return true
		}
	}
	return false
}

func prose(v any, key string, depth int) bool {
	if depth > 64 {
		return true
	}
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			if words(k) > 1 {
				return true // a free-text key (a summary's evidence kinds)
			}
			if PersonKey(k) || structuralKeys[k] {
				continue
			}
			if prose(val, k, depth+1) {
				return true
			}
		}
	case []any:
		for _, item := range x {
			if prose(item, key, depth+1) {
				return true
			}
		}
	case string:
		return words(x) > 1
	}
	return false
}

// words counts the runs of letters separated by spaces (a path or an identifier is one).
func words(s string) int {
	n := 0
	for _, f := range strings.Fields(s) {
		if strings.IndexFunc(f, unicode.IsLetter) >= 0 {
			n++
		}
	}
	return n
}
