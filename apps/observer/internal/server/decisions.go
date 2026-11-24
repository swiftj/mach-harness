package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"mach/observer/internal/adr"
	"mach/observer/internal/normalize"
	"mach/observer/internal/redact"
)

// Decisions in force: the project's architecture decisions (ADRs), the required baseline, what waits
// on a person about them, and one decision's page. Read on request, read-only, from files:
//
//   - the ADR folder in the main checkout's working tree (internal/adr, a port of adr.py's rules);
//   - .factory/config.json's "adr" section (the folder and the required topics);
//   - each live cell's cell.json under .factory/worktrees (adrs.planned_under, adrs.proposed,
//     adr_acceptances, adr_exceptions, adr_conflict, spec_question, main_conflict, stage, risk).
//
// Archived tickets are not read: their records are inside compressed archives the observer unpacks
// only for the evidence catalog, so tickets planned under a decision are the live cells only, and
// the reply says so.
//
// Nothing here accepts, changes or excepts a decision. People's text (an ADR's title and text, a
// problem that quotes a header, an exception's or a conflict's reason) is bounded, scrubbed by the
// observer's own text rules (people the project's records name become "a person") and declared as
// free text in the session's display policy (decisionFreeText). A person's name is never served:
// an exception says "a person" decided, as every other reply does.

const (
	maxDecisionCells = 512
	maxCellJSON      = 4 << 20
	maxProblemText   = 400
	maxReasonText    = 1000
)

// decisionsBasis is what every decisions reply says it was read from.
const decisionsBasis = "Read from the ADR folder in the main checkout's working tree, as the files are on disk. MACH binds only what is committed on the main branch; " +
	"the observer reads no git history, so an edit not yet committed shows here as it is on disk. Tickets are the live cells under .factory/worktrees " +
	"(cell.json); archived tickets are not read."

// decisionFreeText declares every path in the decisions replies that holds people's text (R1), for
// display_policy.free_text.catalog_fields. A test fills each source with a marker and fails on prose
// at any path not listed here.
var decisionFreeText = []map[string]any{
	{"route": "/api/v1/decisions", "path": "adrs[].title", "from": "the ADR file's first heading", "max": 200},
	{"route": "/api/v1/decisions", "path": "adrs[].file_text", "from": "the ADR file's name, when it is not a plain path", "max": 200},
	{"route": "/api/v1/decisions", "path": "adrs[].problems[]", "from": "adr.py's problem sentences, which quote the file's header", "max": maxProblemText},
	{"route": "/api/v1/decisions", "path": "problems[]", "from": "adr.py's problem sentences, which quote the file's header", "max": maxProblemText},
	{"route": "/api/v1/decisions", "path": "baseline.setting_problems[]", "from": "adr.required_topics in .factory/config.json", "max": maxProblemText},
	{"route": "/api/v1/decisions", "path": "waiting.proposals[].title", "from": "cell.json adrs.proposed[].title", "max": 200},
	{"route": "/api/v1/decisions", "path": "waiting.stopped[].title", "from": "cell.json adr_conflict.title", "max": 200},
	{"route": "/api/v1/decisions", "path": "waiting.stopped[].reason", "from": "cell.json adr_conflict.reason", "max": maxReasonText},
	{"route": "/api/v1/decisions/{adr}", "path": "adr.title", "from": "the ADR file's first heading", "max": 200},
	{"route": "/api/v1/decisions/{adr}", "path": "adr.file_text", "from": "the ADR file's name, when it is not a plain path", "max": 200},
	{"route": "/api/v1/decisions/{adr}", "path": "adr.problems[]", "from": "adr.py's problem sentences, which quote the file's header", "max": maxProblemText},
	{"route": "/api/v1/decisions/{adr}", "path": "text", "from": "the ADR file", "max": adr.TextLimit},
	{"route": "/api/v1/decisions/{adr}", "path": "exceptions[].reason", "from": "cell.json adr_exceptions[].reason", "max": maxReasonText},
	{"route": "/api/v1/decisions/{adr}", "path": "conflicts[].reason", "from": "cell.json adr_conflict.reason", "max": maxReasonText},
	{"route": "/api/v1/decisions/{adr}", "path": "proposed_by[].title", "from": "cell.json adrs.proposed[].title", "max": 200},
}

var (
	// An applies-to item served as it is: a code, a topic word, or a plain path glob.
	appliesItemRe = regexp.MustCompile(`^(all|app:[a-z]+|topic:[a-z0-9]+(?:-[a-z0-9]+)*|path:[A-Za-z0-9._*?/-]{1,200})$`)
	adrRouteRe    = regexp.MustCompile(`^ADR-[0-9]{4}$`)
	whiteRunRe    = regexp.MustCompile(`\s+`)
)

// bounded scrubs people's text with the observer's own text rules and cuts it to max characters.
// oneLine folds its lines into one.
func bounded(s, root string, max int, oneLine bool) (string, bool) {
	out, _ := redact.ScrubDocument(s, root, redact.DocOptions{})
	out = strings.ReplaceAll(out, "\r\n", "\n")
	if oneLine {
		out = strings.TrimSpace(whiteRunRe.ReplaceAllString(out, " "))
	}
	if utf8.RuneCountInString(out) <= max {
		return out, false
	}
	return string([]rune(out)[:max-1]) + "…", true
}

func boundedList(items []string, root string, max int) []string {
	out := make([]string, 0, len(items))
	for _, s := range items {
		t, _ := bounded(s, root, max, true)
		out = append(out, t)
	}
	return out
}

func textOrNil(v any, root string, max int) any {
	s, ok := v.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return nil
	}
	t, _ := bounded(s, root, max, true)
	return t
}

func adrID(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || !adrRouteRe.MatchString(s) {
		return "", false
	}
	return s, true
}

func timeOrNil(v any) any {
	if s, ok := v.(string); ok && releaseTimeRe.MatchString(s) {
		return s
	}
	return nil
}

// ---------------------------------------------------------------- the live cells

// decisionCell is what one live cell's cell.json says about architecture decisions.
type decisionCell struct {
	ticket string
	stage  string
	risk   string
	raw    map[string]any
}

func (c decisionCell) object(key string) (map[string]any, bool) {
	m, ok := c.raw[key].(map[string]any)
	return m, ok
}

func (c decisionCell) list(key string) []map[string]any {
	var out []map[string]any
	items, _ := c.raw[key].([]any)
	for _, it := range items {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func (c decisionCell) planned(key string) []map[string]any {
	adrs, _ := c.object("adrs")
	items, _ := adrs[key].([]any)
	var out []map[string]any
	for _, it := range items {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// pending is adr.pending_acceptance: the ticket's own proposals no person has accepted yet.
func (c decisionCell) pending() []map[string]any {
	accepted := map[string]bool{}
	for _, a := range c.list("adr_acceptances") {
		if id, ok := a["id"].(string); ok {
			accepted[id] = true
		}
	}
	var out []map[string]any
	for _, p := range c.planned("proposed") {
		if id, ok := p["id"].(string); !ok || !accepted[id] {
			out = append(out, p)
		}
	}
	return out
}

// readDecisionCells reads every live cell's cell.json; the second result lists the cells whose
// record could not be read.
func readDecisionCells(root string) ([]decisionCell, []string) {
	dir := filepath.Join(root, ".factory", "worktrees")
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() {
		return nil, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil
	}
	files := normalize.DirFiles{Dir: root}
	var cells []decisionCell
	var unreadable []string
	for _, e := range entries {
		if len(cells)+len(unreadable) >= maxDecisionCells {
			break
		}
		ticket, good := redact.ID(e.Name())
		if !good || !e.IsDir() || e.Type()&os.ModeSymlink != 0 {
			continue
		}
		rel := ".factory/worktrees/" + ticket + "/cell.json"
		if _, err := os.Lstat(filepath.Join(root, filepath.FromSlash(rel))); err != nil {
			continue // a folder without a record yet
		}
		b, ok := files.Read(rel, maxCellJSON)
		var raw map[string]any
		if !ok || json.Unmarshal(b, &raw) != nil || raw == nil {
			unreadable = append(unreadable, ticket)
			continue
		}
		c := decisionCell{ticket: ticket, raw: raw}
		c.stage, _ = redact.Token(raw["stage"])
		c.risk, _ = redact.Label(raw["risk"])
		// A person's name in this record is replaced wherever it reappears in text served here.
		people := redact.PeopleFor(root)
		for _, key := range []string{"adr_exceptions", "adr_acceptances"} {
			for _, item := range c.list(key) {
				if by, ok := item["by"].(string); ok {
					people.Learn(by)
				}
			}
		}
		cells = append(cells, c)
	}
	return cells, unreadable
}

// ---------------------------------------------------------------- one ADR as served

type decisionsRead struct {
	listing    adr.Listing
	cfg        adr.Config
	cells      []decisionCell
	unreadable []string
}

func (s *Server) readDecisions() decisionsRead {
	root := s.opts.Root
	cfg, state := adr.ReadConfig(root)
	l := adr.Read(root, cfg, state)
	people := redact.PeopleFor(root)
	for _, r := range l.Records {
		people.Learn(r.DecisionMakers...)
	}
	cells, unreadable := readDecisionCells(root)
	return decisionsRead{listing: l, cfg: cfg, cells: cells, unreadable: unreadable}
}

func adrView(r *adr.Record, root string) map[string]any {
	var id, superseded, title, file, fileText any
	if r.ID != "" {
		id = r.ID
	}
	if sb, ok := adrID(r.SupersededBy); ok {
		superseded = sb
	}
	if r.Title != "" {
		title, _ = bounded(r.Title, root, 200, true)
	}
	if f, ok := redact.RelPath(r.File); ok {
		file = f
	} else {
		fileText, _ = bounded(r.File, root, 200, true)
	}
	applies := []string{}
	hidden := 0
	for _, item := range r.AppliesTo {
		if appliesItemRe.MatchString(item) && !redact.Sensitive(item) {
			applies = append(applies, item)
		} else {
			hidden++
		}
	}
	topics := r.Topics()
	if topics == nil {
		topics = []string{}
	}
	status := any(nil)
	if r.Status != "" {
		status = r.Status
	}
	var digest any
	if r.Digest != "" {
		digest = r.Digest
	}
	return map[string]any{
		"id": id, "number": numberOrNil(r.Number), "file": file, "file_text": fileText, "title": title, "status": status,
		"superseded_by": superseded, "topics": topics, "applies_to": applies, "applies_to_hidden": hidden, "applies_to_given": r.AppliesToGiven,
		"binding": r.Binding, "readable": len(r.Problems) == 0, "unread": r.Unread, "problems": boundedList(r.Problems, root, maxProblemText), "digest": digest,
	}
}

func numberOrNil(n int) any {
	if n < 0 {
		return nil
	}
	return n
}

// decisions serves GET /api/v1/decisions.
func (s *Server) decisions(w http.ResponseWriter, r *http.Request) {
	root := s.opts.Root
	d := s.readDecisions()
	l := d.listing
	adrs := []map[string]any{}
	supersedes := map[string][]string{}
	proposedOnMain := []string{}
	for _, rec := range l.Records {
		adrs = append(adrs, adrView(rec, root))
		if rec.SupersededBy != "" && rec.ID != "" {
			supersedes[rec.SupersededBy] = append(supersedes[rec.SupersededBy], rec.ID)
		}
		if rec.Status == "proposed" && rec.ID != "" {
			proposedOnMain = append(proposedOnMain, rec.ID)
		}
	}
	for _, a := range adrs {
		if id, ok := a["id"].(string); ok {
			a["supersedes"] = append([]string{}, supersedes[id]...)
		} else {
			a["supersedes"] = []string{}
		}
	}
	cov := adr.CoverageOf(d.cfg, l.Records)
	// Only topic words are served as topics. A setting entry that is not one stays required (no ADR
	// can cover it, so the baseline is not covered); it is counted here and named in setting_problems.
	topics := []map[string]any{}
	required, missing := []string{}, []string{}
	unusable := 0
	for _, t := range cov.Topics {
		if !adr.IsTopic(t.Topic) {
			unusable++
			continue
		}
		files := []string{}
		for _, f := range t.Files {
			if p, ok := redact.RelPath(f); ok {
				files = append(files, p)
			}
		}
		required = append(required, t.Topic)
		if len(t.CoveredBy) == 0 {
			missing = append(missing, t.Topic)
		}
		topics = append(topics, map[string]any{"topic": t.Topic, "description": t.Description, "added_by_project": t.Description == adr.AddedTopic,
			"covered_by": t.CoveredBy, "files": files})
	}

	proposals := []map[string]any{}
	stopped := []map[string]any{}
	for _, c := range d.cells {
		holds := c.stage == "planned" && c.risk == "High"
		for _, p := range c.pending() {
			id, ok := adrID(p["id"])
			if !ok {
				continue
			}
			file, _ := redact.RelPath(p["file"])
			proposals = append(proposals, map[string]any{"ticket": c.ticket, "adr": id, "title": textOrNil(p["title"], root, 200), "file": orNil(file),
				"stage": orNil(c.stage), "risk": orNil(c.risk), "holds_build": holds})
		}
		if stop := stopOf(c, len(l.Problems) > 0, root); stop != nil {
			stopped = append(stopped, stop)
		}
	}
	sort.SliceStable(stopped, func(i, j int) bool { return stopped[i]["ticket"].(string) < stopped[j]["ticket"].(string) })

	writeJSON(w, http.StatusOK, ok(map[string]any{
		"basis":  decisionsBasis,
		"source": map[string]any{"kind": "working-tree", "dir": l.Dir, "dir_found": l.Found, "dir_setting_problem": l.DirProblem != "", "config": l.Config},
		"adrs":   adrs, "problems": boundedList(l.Problems, root, maxProblemText),
		"baseline": map[string]any{"required": required, "topics": topics, "missing": missing, "covered": len(cov.Missing) == 0, "unusable_entries": unusable,
			"setting_problems": boundedList(cov.Problems, root, maxProblemText), "setting": "adr.required_topics in .factory/config.json"},
		"waiting": map[string]any{"proposals": proposals, "stopped": stopped, "proposed_on_main": proposedOnMain},
		"cells":   map[string]any{"read": len(d.cells), "unreadable": nonNil(d.unreadable), "archived": "not read"},
	}))
}

func orNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// stopOf is the routing sheet's stop for an architecture decision, as run.py next derives it from
// cell.json for the three codes this page shows: adr-decision and adr-fix at spec-ready (after a
// spec question, which run.py stops on first), adr-acceptance at planned for a High-risk ticket.
// Nil when the cell is not stopped on one of them.
func stopOf(c decisionCell, listingProblems bool, root string) map[string]any {
	stop := map[string]any{"ticket": c.ticket, "stage": orNil(c.stage), "risk": orNil(c.risk), "adr": nil, "adrs": []string{}, "title": nil,
		"reason": nil, "at": nil, "also_recorded": nil}
	switch c.stage {
	case "spec-ready":
		if _, asked := c.object("spec_question"); asked {
			return nil
		}
		if conflict, found := c.object("adr_conflict"); found {
			stop["needs"] = "adr-decision"
			if id, ok := adrID(conflict["adr"]); ok {
				stop["adr"] = id
				stop["adrs"] = []string{id}
			}
			stop["title"] = textOrNil(conflict["title"], root, 200)
			stop["reason"] = textOrNil(conflict["reason"], root, maxReasonText)
			stop["at"] = timeOrNil(conflict["at"])
			return stop
		}
		if listingProblems {
			stop["needs"] = "adr-fix"
			return stop
		}
	case "planned":
		if c.risk != "High" {
			return nil
		}
		var ids []string
		for _, p := range c.pending() {
			if id, ok := adrID(p["id"]); ok {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			return nil
		}
		stop["needs"] = "adr-acceptance"
		stop["adrs"] = ids
		if _, found := c.object("main_conflict"); found {
			// run.py stops on a conflict with main first when the branch and main are still where it was recorded.
			stop["also_recorded"] = "main-conflict"
		}
		return stop
	}
	return nil
}

// decision serves GET /api/v1/decisions/{adr}: one decision's page.
func (s *Server) decision(w http.ResponseWriter, r *http.Request) {
	id, good := adrID(r.PathValue("adr"))
	if !good {
		writeJSON(w, http.StatusBadRequest, fail(KindInvalid, "An architecture decision is named by its ID, such as ADR-0007."))
		return
	}
	root := s.opts.Root
	d := s.readDecisions()
	var rec *adr.Record
	var same []string
	for _, x := range d.listing.Records {
		if x.ID != id {
			continue
		}
		if rec == nil {
			rec = x
		} else if p, ok := redact.RelPath(x.File); ok {
			same = append(same, p)
		}
	}
	plannedUnder := []map[string]any{}
	exceptions := []map[string]any{}
	conflicts := []map[string]any{}
	proposedBy := []map[string]any{}
	acceptances := []map[string]any{}
	digestMatches := func(v any) any {
		dg, ok := redact.Digest(v)
		if !ok || rec == nil || rec.Digest == "" {
			return nil
		}
		return dg == rec.Digest
	}
	for _, c := range d.cells {
		adrs, _ := c.object("adrs")
		for _, p := range c.planned("planned_under") {
			if p["id"] != id {
				continue
			}
			origin, _ := redact.Token(p["origin"])
			plannedUnder = append(plannedUnder, map[string]any{"ticket": c.ticket, "stage": orNil(c.stage), "planned_at": timeOrNil(adrs["planned_at"]),
				"origin": orNil(origin), "same_text": digestMatches(p["digest"])})
		}
		for _, e := range c.list("adr_exceptions") {
			if e["adr"] != id {
				continue
			}
			reason, cut := "", false
			if words, isText := e["reason"].(string); isText {
				reason, cut = bounded(words, root, maxReasonText, true)
			}
			recordedBy := redact.Role
			if rb, ok := e["recorded_by"].(string); ok && redact.RolePhrase(rb) && !redact.PeopleFor(root).Hit(rb) {
				recordedBy = rb
			}
			exceptions = append(exceptions, map[string]any{"ticket": c.ticket, "stage": orNil(c.stage), "at": timeOrNil(e["at"]), "by": redact.Role,
				"recorded_by": recordedBy, "reason": orNil(reason), "reason_cut": cut, "same_text": digestMatches(e["digest"])})
		}
		if conflict, found := c.object("adr_conflict"); found && conflict["adr"] == id {
			conflicts = append(conflicts, map[string]any{"ticket": c.ticket, "stage": orNil(c.stage), "at": timeOrNil(conflict["at"]),
				"reason": textOrNil(conflict["reason"], root, maxReasonText)})
		}
		pending := map[string]bool{}
		for _, p := range c.pending() {
			if pid, ok := p["id"].(string); ok {
				pending[pid] = true
			}
		}
		for _, p := range c.planned("proposed") {
			if p["id"] != id {
				continue
			}
			file, _ := redact.RelPath(p["file"])
			proposedBy = append(proposedBy, map[string]any{"ticket": c.ticket, "stage": orNil(c.stage), "risk": orNil(c.risk), "title": textOrNil(p["title"], root, 200),
				"file": orNil(file), "accepted": !pending[id], "holds_build": pending[id] && c.stage == "planned" && c.risk == "High"})
		}
		for _, a := range c.list("adr_acceptances") {
			if a["id"] == id {
				acceptances = append(acceptances, map[string]any{"ticket": c.ticket, "at": timeOrNil(a["at"]), "by": redact.Role})
			}
		}
	}
	if rec == nil && len(plannedUnder)+len(exceptions)+len(conflicts)+len(proposedBy) == 0 {
		writeJSON(w, http.StatusNotFound, fail(KindNotFound, "No architecture decision has this ID in the ADR folder, and no live ticket names it."))
		return
	}
	var view, text any
	textCut := false
	if rec != nil {
		v := adrView(rec, root)
		var supersedes []string
		for _, x := range d.listing.Records {
			if x.SupersededBy == id && x.ID != "" {
				supersedes = append(supersedes, x.ID)
			}
		}
		v["supersedes"] = nonNil(supersedes)
		v["same_number"] = nonNil(same)
		view = v
		if !rec.Unread {
			t, c := bounded(rec.Text, root, adr.TextLimit, false)
			text, textCut = t, c
		}
	}
	writeJSON(w, http.StatusOK, ok(map[string]any{
		"basis": decisionsBasis, "id": id, "adr": view, "text": text, "text_cut": textCut, "text_limit": adr.TextLimit, "render": "text only; never markup",
		"planned_under": plannedUnder, "exceptions": exceptions, "conflicts": conflicts, "proposed_by": proposedBy, "acceptances": acceptances,
		"cells": map[string]any{"read": len(d.cells), "unreadable": nonNil(d.unreadable), "archived": "not read"},
	}))
}
