package normalize

import (
	"regexp"
	"strings"

	"mach/observer/internal/redact"
)

// Stops are the routing sheet's stop codes (redact.StopCodes). Revision 7 carries one on
// human.required and execution.completed (data.needs) when MACH's own record names it. A code this
// list does not know is never passed on: the field is null and the recorded words are shown as
// before (a generic wait), so a stop added to MACH later degrades to what the Floor showed before.
var Stops = redact.StopCodes

var stopSet = func() map[string]bool {
	m := map[string]bool{}
	for _, s := range Stops {
		m[s] = true
	}
	return m
}()

// StopCode is v when it is a known stop code, else "".
func StopCode(v any) string {
	s, _ := v.(string)
	s = strings.TrimSpace(s)
	if stopSet[s] {
		return s
	}
	return ""
}

// waitingForRe is intake's fixed phrase in a human.required reason (intake.py record: "waiting for
// <needs>", joined with "; " among the other reasons it lists).
var waitingForRe = regexp.MustCompile(`(?:^|; )waiting for ([a-z][a-z-]{0,39})(?:;|$)`)

// NeedsFromReason reads the stop code from intake's fixed phrase in a human.required reason. Only a
// known code counts; "" when the reason names none (the supervisor's other words, a stale revision).
func NeedsFromReason(reason any) string {
	s, _ := reason.(string)
	if len(s) > 2000 {
		return ""
	}
	for _, m := range waitingForRe.FindAllStringSubmatch(s, -1) {
		if code := StopCode(m[1]); code != "" {
			return code
		}
	}
	return ""
}

// mocksPhrase is intake's fixed sentence for a slice issue whose design mocks are not yet on the
// integration branch (intake.py with_mocks, M14 part C): the not_accepted item's `waiting: mocks`
// reaches the log only as this sentence in intake.refused's problems.
const mocksPhrase = "Waiting for its design mocks:"

// WaitingOf is "mocks" when one of intake.refused's problems is the design-mocks sentence, else "".
func WaitingOf(problems any) string {
	for _, p := range arr(problems) {
		if s, ok := p.(string); ok && strings.HasPrefix(strings.TrimSpace(s), mocksPhrase) {
			return "mocks"
		}
	}
	return ""
}

// jiraKeyRe is Jira's form of an issue key, as issue_rules.JIRA_KEY_RE writes it (M13 part E).
var jiraKeyRe = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,31}-[1-9][0-9]{0,8}$`)

// JiraKey checks a Jira key again (it is an identifier, never free text): Jira's form, at most 42
// characters. Anything else is no key.
func JiraKey(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || len(s) > 42 || !jiraKeyRe.MatchString(s) {
		return "", false
	}
	return s, true
}

var changeRecordRe = regexp.MustCompile(`^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+){0,8}\.md$`)

// ChangeRecord reads the change record's identity (M13: cell.json and the run record's
// `change_record`): its repository-relative path and SHA-256. The path is shown as text, never as a
// link; one outside the form merge.py writes (`<records.dir>/<ticket>.md`), or under .factory, .git
// or .claude, is not kept. nil when there is no usable path.
func ChangeRecord(v any) map[string]any {
	m := obj(v)
	if m == nil {
		return nil
	}
	p, ok := redact.RelPath(m["path"])
	if !ok || len(p) > 200 || !changeRecordRe.MatchString(p) {
		return nil
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".factory" || part == ".git" || part == ".claude" || part == "." || part == ".." {
			return nil
		}
	}
	var sum any
	if s, ok := m["sha256"].(string); ok && sha256Re.MatchString(s) {
		sum = s
	}
	return map[string]any{"path": p, "sha256": sum}
}

var sha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)
