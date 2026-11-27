package artifact

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"time"
	"unicode"
)

// NotKept says why a finished ticket's files are not there to read: the cell folder is gone and
// the cleanup station kept no archive of it (cleanup.archive), or the archive its run record names
// is not in .factory/archive/. It is read from the ticket's latest run record in
// .factory/archive/runs.jsonl, which cleanup always writes. Null wherever the files are there, and
// for a ticket with no run record.
type NotKept struct {
	// Reason is the run record's own sentence (archive_kept.reason, written by MACH), or
	// NotKeptFallback for a record that gives none.
	Reason string `json:"reason"`
	// Setting is cleanup.archive as cleanup read it ("none", "raised" or "all"); ChosenBy is
	// "setting", or "flag" when a person chose for that one cleanup. Null for a record that does
	// not say (one written before the setting existed).
	Setting  *string `json:"setting"`
	ChosenBy *string `json:"chosen_by"`
	// Published: the archive was handed to records.publish_command before it was removed here.
	Published *bool `json:"published"`
	// RaisedToPerson: the codes of what a person decided on the ticket, as the run record lists them.
	RaisedToPerson []string `json:"raised_to_person"`
	// Archive is the archive the run record names when that file is missing; null when the record
	// names none (none was kept).
	Archive *string `json:"archive"`
	Outcome *string `json:"outcome"`
	// ClosedAt is when cleanup closed the ticket, as its run record says (closed_at); null when it does not.
	ClosedAt *string `json:"closed_at"`
}

// NotKeptFallback is said when a run record names no archive and gives no reason.
const NotKeptFallback = "The evidence files were not kept after cleanup (cleanup.archive)."

const (
	runsMax      = 64 << 20 // runs.jsonl read at most; larger is not read (nothing is said)
	maxNotKeptRe = 400
)

var settingValues = map[string]bool{"none": true, "raised": true, "all": true}
var chosenValues = map[string]bool{"setting": true, "flag": true}

// ArchiveNotKept reads the project at root for a ticket whose cell folder is gone: nil when the
// cell is live, when the ticket has no run record, or when the archive is there to read.
func ArchiveNotKept(root *os.Root, ticket string) *NotKept {
	if !ticketRe.MatchString(ticket) || len(ticket) > 128 || isDir(root, ".factory/worktrees/"+ticket) {
		return nil
	}
	data, _, err := readFile(root, ".factory/archive/runs.jsonl", runsMax)
	if err != nil {
		return nil
	}
	var last map[string]json.RawMessage
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 || !bytes.Contains(line, []byte(ticket)) {
			continue
		}
		var rec map[string]json.RawMessage
		if json.Unmarshal(line, &rec) != nil {
			continue
		}
		var id string
		if json.Unmarshal(rec["ticket_id"], &id) != nil || strings.TrimSpace(id) != ticket {
			continue
		}
		last = rec
	}
	if last == nil {
		return nil
	}
	raw, present := last["archive"]
	var named *string
	if present && string(bytes.TrimSpace(raw)) != "null" {
		var s string
		if json.Unmarshal(raw, &s) != nil || s == "" {
			return nil // not a path this reader knows: the catalog's own reading stands
		}
		named = &s
	}
	if named == nil && !present {
		// A record written before cleanup could choose: its archive is the ticket's default name.
		if _, err := statFile(root, ".factory/archive/"+ticket+".tar.gz"); err == nil {
			return nil
		}
		def := ".factory/archive/" + ticket + ".tar.gz"
		named = &def
	}
	if named != nil {
		rel := *named
		if !strings.HasPrefix(rel, ".factory/archive/") || !strings.HasSuffix(rel, ".tar.gz") || strings.Contains(rel, "..") {
			return nil
		}
		if _, err := statFile(root, rel); err == nil {
			return nil // the archive is there: it is read as before
		}
		if _, err := statFile(root, ".factory/archive/"+ticket+".tar.gz"); err == nil {
			return nil
		}
	}
	out := &NotKept{RaisedToPerson: []string{}, Archive: named}
	var kept struct {
		Kept      *bool   `json:"kept"`
		Setting   *string `json:"setting"`
		ChosenBy  *string `json:"chosen_by"`
		Published *bool   `json:"published"`
		Reason    *string `json:"reason"`
	}
	_ = json.Unmarshal(last["archive_kept"], &kept)
	if kept.Setting != nil && settingValues[*kept.Setting] {
		out.Setting = kept.Setting
	}
	if kept.ChosenBy != nil && chosenValues[*kept.ChosenBy] {
		out.ChosenBy = kept.ChosenBy
	}
	out.Published = kept.Published
	var codes []string
	_ = json.Unmarshal(last["raised_to_person"], &codes)
	for _, c := range codes {
		if codeRe(c) {
			out.RaisedToPerson = append(out.RaisedToPerson, c)
		}
	}
	var outcome string
	if json.Unmarshal(last["outcome"], &outcome) == nil && (outcome == "merged" || outcome == "abandoned") {
		out.Outcome = &outcome
	}
	var closed string
	if json.Unmarshal(last["closed_at"], &closed) == nil {
		if t, err := time.Parse(time.RFC3339, closed); err == nil {
			s := t.UTC().Format(time.RFC3339)
			out.ClosedAt = &s
		}
	}
	switch {
	case named != nil:
		out.Reason = "This ticket's archive (" + *named + ") is not in .factory/archive/, so its evidence files cannot be read here."
	case kept.Reason != nil && plainSentence(*kept.Reason):
		out.Reason = *kept.Reason
	default:
		out.Reason = NotKeptFallback
	}
	return out
}

// codeRe: a code MACH writes, lower-case words joined by hyphens.
func codeRe(s string) bool {
	if s == "" || len(s) > 40 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// plainSentence: MACH's own words, short, with no control characters and no path outside the project.
func plainSentence(s string) bool {
	if strings.TrimSpace(s) == "" || len(s) > maxNotKeptRe || strings.Contains(s, "/Users/") || strings.Contains(s, "/home/") {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// NotKeptAt is ArchiveNotKept for the project at root (an absolute, link-resolved path).
func NotKeptAt(root, ticket string) *NotKept {
	if root == "" {
		return nil
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil
	}
	defer r.Close()
	return ArchiveNotKept(r, ticket)
}
