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
	{"slice.materialized", "data.title", 200}, // M6.6: the slice's title, from the intake ledger
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
	// M6.6 F6: a refused request as the supervisor recorded it ("Bash: git push"), kept through
	// redact.Scrub, not Text; up to 60 characters of whatever the ledger holds.
	{"execution.completed", "data.refused_tools[]", 60},
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

// ProjectionField is a place outside the events where the projection serves a copy of a declared
// event field (M6.6 F6): a reply route and the path in its data ("*" stands for any one key of a
// map keyed by an id). The session reply lists them (display_policy.free_text.projection_fields),
// so a client can label every copy from the policy, not only the events. Unexercised marks a
// path the server test's scenario does not reach.
type ProjectionField struct {
	Route       string   `json:"route"`
	Path        string   `json:"path"`
	From        []string `json:"from"` // the event fields it copies: "<kind> <path>"
	Unexercised bool     `json:"-"`
}

// ProjectionFields are every declared copy. Events inside a reply (events[] in /events, /history,
// a visit, and the stream) are events: event_fields apply to them. A server test fills every
// event field with a marker and fails on prose at any path not listed here.
var ProjectionFields = []ProjectionField{
	{Route: "/api/v1/cells/{ticket}", Path: "findings[].title", From: []string{"review.finding data.title"}},
	{Route: "/api/v1/cells/{ticket}", Path: "human_gates[].reason", From: []string{"human.required data.reason"}},
	{Route: "/api/v1/cells/{ticket}", Path: "waiting.reasons[]", From: []string{"human.required data.reason", "scheduling.decided data.held[].why", "dependency.blocked data.reasons[]", "execution.completed data.waiting_for"}},
	{Route: "/api/v1/slices", Path: "items[].title", From: []string{"slice.materialized data.title"}},
	{Route: "/api/v1/slices/{slice}", Path: "title", From: []string{"slice.materialized data.title"}},
	{Route: "/api/v1/waves/{wave}", Path: "slices[].title", From: []string{"slice.materialized data.title"}},
	{Route: "/api/v1/snapshot", Path: "state.slices.*.title", From: []string{"slice.materialized data.title"}},
	{Route: "/api/v1/slices", Path: "items[].last_reasons[]", From: []string{"dependency.blocked data.reasons[]"}},
	{Route: "/api/v1/slices", Path: "items[].waiting.reasons[]", From: []string{"human.required data.reason", "scheduling.decided data.held[].why", "dependency.blocked data.reasons[]", "execution.completed data.waiting_for"}},
	{Route: "/api/v1/slices/{slice}", Path: "last_reasons[]", From: []string{"dependency.blocked data.reasons[]"}},
	{Route: "/api/v1/slices/{slice}", Path: "waiting.reasons[]", From: []string{"human.required data.reason", "scheduling.decided data.held[].why", "dependency.blocked data.reasons[]", "execution.completed data.waiting_for"}},
	{Route: "/api/v1/waves/{wave}", Path: "slices[].last_reasons[]", From: []string{"dependency.blocked data.reasons[]"}},
	{Route: "/api/v1/waves/{wave}", Path: "slices[].waiting.reasons[]", From: []string{"human.required data.reason", "scheduling.decided data.held[].why", "dependency.blocked data.reasons[]", "execution.completed data.waiting_for"}},
	{Route: "/api/v1/project", Path: "human_gates_open[].reason", From: []string{"human.required data.reason"}},
	{Route: "/api/v1/project", Path: "factory.held[].why", From: []string{"scheduling.decided data.held[].why"}},
	{Route: "/api/v1/project", Path: "factory.paused_reason", From: []string{"factory.paused data.reason"}},
	{Route: "/api/v1/factory/status", Path: "recorded_mode.held[].why", From: []string{"scheduling.decided data.held[].why"}},
	{Route: "/api/v1/factory/status", Path: "recorded_mode.paused_reason", From: []string{"factory.paused data.reason"}},
	{Route: "/api/v1/runs", Path: "items[].refused_tools[]", From: []string{"execution.completed data.refused_tools[]"}},
	{Route: "/api/v1/runs/{execution}", Path: "run.refused_tools[]", From: []string{"execution.completed data.refused_tools[]"}},
	{Route: "/api/v1/runs/{execution}", Path: "workflows[].phases[].title", From: []string{"workflow.phases_declared data.phases[].title"}},
	{Route: "/api/v1/runs/{execution}/agents", Path: "items[].label", From: []string{"agent.queued data.label", "agent.started data.label"}},
	{Route: "/api/v1/runs/{execution}/agents", Path: "items[].phase", From: []string{"agent.queued data.phase", "agent.started data.phase"}},
	{Route: "/api/v1/spans", Path: "items[].attrs.label", From: []string{"agent.queued data.label", "agent.started data.label"}},
	{Route: "/api/v1/spans", Path: "items[].attrs.reasons[]", From: []string{"human.required data.reason", "scheduling.decided data.held[].why", "dependency.blocked data.reasons[]", "execution.completed data.waiting_for"}},
	{Route: "/api/v1/analytics/metrics", Path: "metrics[].groups[].key", From: []string{"agent.queued data.phase", "agent.started data.phase"}},
	{Route: "/api/v1/analytics/metrics", Path: "metrics[].groups[].keys.phase", From: []string{"agent.queued data.phase", "agent.started data.phase"}},
	{Route: "/api/v1/snapshot", Path: "state.cells.*.findings[].title", From: []string{"review.finding data.title"}},
	{Route: "/api/v1/snapshot", Path: "state.cells.*.human_gates[].reason", From: []string{"human.required data.reason"}},
	{Route: "/api/v1/snapshot", Path: "state.cells.*.waiting.reasons[]", From: []string{"human.required data.reason", "scheduling.decided data.held[].why", "dependency.blocked data.reasons[]", "execution.completed data.waiting_for"}},
	{Route: "/api/v1/snapshot", Path: "state.slices.*.last_reasons[]", From: []string{"dependency.blocked data.reasons[]"}},
	{Route: "/api/v1/snapshot", Path: "state.slices.*.waiting.reasons[]", From: []string{"human.required data.reason", "scheduling.decided data.held[].why", "dependency.blocked data.reasons[]", "execution.completed data.waiting_for"}},
	{Route: "/api/v1/snapshot", Path: "state.gates[].reason", From: []string{"human.required data.reason"}},
	{Route: "/api/v1/snapshot", Path: "state.factory.held[].why", From: []string{"scheduling.decided data.held[].why"}},
	{Route: "/api/v1/snapshot", Path: "state.factory.paused_reason", From: []string{"factory.paused data.reason"}},
	{Route: "/api/v1/snapshot", Path: "state.project.factory.held[].why", From: []string{"scheduling.decided data.held[].why"}},
	{Route: "/api/v1/snapshot", Path: "state.project.factory.paused_reason", From: []string{"factory.paused data.reason"}},
	{Route: "/api/v1/snapshot", Path: "state.project.human_gates_open[].reason", From: []string{"human.required data.reason"}},
	{Route: "/api/v1/snapshot", Path: "state.executions.*.agents[].label", From: []string{"agent.queued data.label", "agent.started data.label"}},
	{Route: "/api/v1/snapshot", Path: "state.executions.*.agents[].phase", From: []string{"agent.queued data.phase", "agent.started data.phase"}},
	{Route: "/api/v1/snapshot", Path: "state.executions.*.workflows.*.phases[].title", From: []string{"workflow.phases_declared data.phases[].title"}},
	{Route: "/api/v1/snapshot", Path: "state.executions.*.run.refused_tools[]", From: []string{"execution.completed data.refused_tools[]"}},
}
