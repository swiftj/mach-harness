package normalize

import (
	"encoding/json"
	"path"
	"regexp"
	"sort"
	"strings"

	"mach/observer/internal/event"
	"mach/observer/internal/redact"
)

// reconstruct derives the observer's events from one lifecycle record and the cell's files
// (contract 10.6). Each is reconstructed, carries provenance and is placed just after its basis.
func (l *Lifecycle) reconstruct(basis *event.Event, raw map[string]any, r Read) []*event.Event {
	var out []*event.Event
	d := basis.Data
	switch basis.Type {
	case "station.entered":
		if basis.IDs.Station == "verify" {
			if ev := l.targets(basis); ev != nil {
				out = append(out, ev)
			}
		}
	case "station.exited":
		files := map[string][]string{
			"groom": {"intent.md", "spec.md", "spec.json"}, "plan": {"plan.md"}, "build": {"build-report.json"},
			"verify": {"evidence/summary.json"},
		}[basis.IDs.Station]
		if s, _ := d["stage"].(string); s == "blocked" || s == "spec-open" && basis.IDs.Station != "groom" {
			files = nil
		}
		for _, f := range files {
			if ev := l.artifact(basis, f, "", ""); ev != nil {
				out = append(out, ev)
			}
		}
	case "verify.check_recorded":
		for _, item := range arr(d["evidence"]) {
			e := item.(map[string]any)
			if ev := l.artifact(basis, e["file"].(string), e["sha256"].(string), ""); ev != nil {
				out = append(out, ev)
			}
		}
	case "build.task_completed", "merge.completed":
		key := "commit"
		if basis.Type == "merge.completed" {
			key = "merge_commit"
		}
		if c, ok := d[key].(string); ok {
			out = append(out, l.artifact(basis, "commit/"+c, "", c))
		}
	case "review.verdict_submitted":
		seat, _ := d["seat"].(string)
		rel := "review/round-" + itoa(basis.IDs.Round) + "/votes/" + seat + ".json"
		out = append(out, l.findings(basis, rel, seat)...)
		if ev := l.artifact(basis, rel, "", ""); ev != nil {
			out = append(out, ev)
		}
	case "review.decided":
		if ev := l.artifact(basis, "review/round-"+itoa(basis.IDs.Round)+"/decision.json", "", ""); ev != nil {
			out = append(out, ev)
		}
	}
	for i, ev := range out {
		p := i
		ev.Origin.Part = &p
	}
	return out
}

func (l *Lifecycle) observed(typ, rule string, basis *event.Event, files []string) *event.Event {
	ev := observerEvent(typ, "", rule, []string{basis.ID}, files)
	copyTime(ev, basis)
	ev.IDs = basis.IDs
	ev.IDs.Seat = basis.IDs.Seat
	ev.Unknown = append([]string(nil), basis.Unknown...)
	filtered := ev.Unknown[:0]
	for _, u := range ev.Unknown {
		if strings.HasPrefix(u, "ids.") {
			filtered = append(filtered, u)
		}
	}
	ev.Unknown = filtered
	ev.Ref(event.CellRef(l.Ticket, l.k))
	if basis.IDs.VisitID != "" {
		ev.Ref("visit:" + basis.IDs.VisitID)
		ev.Parent = "visit:" + basis.IDs.VisitID
	}
	return ev
}

// targets is verify.targets_listed: what this verification must prove, recomputed as
// verify.py Cell.targets does (scenarios, matrix rules, holdouts by id only; lead's decision 3).
func (l *Lifecycle) targets(basis *event.Event) *event.Event {
	if l.Files == nil {
		return nil
	}
	b, ok := l.Files.Read("spec.json", 8<<20)
	if !ok {
		return nil
	}
	var spec struct {
		Scenarios []map[string]any `json:"scenarios"`
		Matrix    struct {
			Rules []map[string]any `json:"rules"`
		} `json:"decision_matrix"`
	}
	if json.Unmarshal(b, &spec) != nil {
		return nil
	}
	targets := []any{}
	add := func(id any, kind string) {
		s, ok := redact.ID(id)
		if ok && len(s) <= 40 && len(targets) < 500 {
			targets = append(targets, map[string]any{"id": s, "kind": kind})
		}
	}
	for _, s := range spec.Scenarios {
		add(s["id"], "scenario")
	}
	for _, r := range spec.Matrix.Rules {
		add(r["id"], "matrix rule")
	}
	files := []string{"spec.json"}
	if l.Holdouts != nil {
		for _, h := range l.Holdouts(l.Ticket) {
			add(h, "holdout")
		}
		files = append(files, ".factory/holdouts/"+l.Ticket+"/")
	}
	ev := l.observed("verify.targets_listed", "verify-targets", basis, files)
	ev.ID = event.ObserverID("targets", basis.ID)
	ev.Data = map[string]any{"targets": targets, "source": "spec.json"}
	return ev
}

// HoldoutID is verify.py's id for a holdout file: "H-" and the file's stem.
func HoldoutID(name string) string {
	stem := strings.TrimSuffix(name, path.Ext(name))
	return "H-" + strings.Trim(nonAlnum.ReplaceAllString(stem, "-"), "-")
}

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]+`)

// findings reads one vote file and yields a review.finding per finding: severity, rule ids, the
// cell-relative file and the title (model-written, capped at 200, shown as text).
func (l *Lifecycle) findings(basis *event.Event, rel, seat string) []*event.Event {
	if l.Files == nil {
		return nil
	}
	b, ok := l.Files.Read(rel, 4<<20)
	if !ok {
		return nil
	}
	var vote struct {
		Findings []map[string]any `json:"findings"`
	}
	if json.Unmarshal(b, &vote) != nil {
		return nil
	}
	var out []*event.Event
	for i, f := range vote.Findings {
		if i >= 200 {
			break
		}
		n := i + 1
		ev := l.observed("review.finding", "vote-file", basis, []string{rel})
		ev.ID = event.ObserverID("finding", basis.ID, n)
		ev.IDs.Seat = seat
		var rule any
		if s, ok := f["rule"].(string); ok {
			if ids := ruleIDRe.FindAllString(s, 8); len(ids) > 0 {
				sort.Strings(ids)
				rule = clip(strings.Join(ids, ", "), 80)
			}
		}
		var file any
		if s, ok := redact.RelPath(f["file"]); ok {
			file = s
		}
		title, _ := redact.Text(f["title"], l.Root, 200)
		ev.Data = map[string]any{"seat": seat, "n": n, "severity": enum(f["severity"], "blocker", "note"), "rule": rule, "file_rel": file, "title": title}
		if ev.Data["severity"] == nil {
			ev.Data["severity"] = "note"
			ev.AddUnknown("data.severity")
		}
		ev.Ref("finding:" + l.cellName() + "/r" + itoa(basis.IDs.Round) + "/" + seat + "/" + itoa(int64(n)))
		ev.Ref("seat:" + l.cellName() + "/review#" + itoa(basis.IDs.Round) + "/" + seat)
		out = append(out, ev)
	}
	return out
}

var mediaTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
	".webm": "video/webm", ".mp4": "video/mp4", ".json": "application/json", ".jsonl": "application/jsonl", ".md": "text/markdown",
	".txt": "text/plain", ".log": "text/plain", ".html": "text/html", ".cast": "application/x-asciicast", ".zip": "application/zip",
	".proto": "text/plain", ".yaml": "text/yaml", ".yml": "text/yaml",
}

var artifactKinds = map[string]string{"intent.md": "intent", "spec.md": "spec", "spec.json": "spec-data", "plan.md": "plan",
	"build-report.json": "build-report", "summary.json": "verification-summary", "decision.json": "review-decision"}

// artifact is artifact.recorded for one named artifact: hashed (or rechecked) by the observer.
// recorded is the hash an authoritative record gave, commit a commit's id.
func (l *Lifecycle) artifact(basis *event.Event, rel, recorded, commit string) *event.Event {
	ev := l.observed("artifact.recorded", "artifact", basis, []string{rel})
	data := map[string]any{"path_rel": rel, "sha256": nil, "bytes": nil, "media_type": nil, "commit": nil}
	var ref string
	switch {
	case commit != "":
		data["kind"], data["nature"], data["integrity"], data["commit"] = "commit", "code", "unchecked", commit
		ev.Provenance.Files = []string{}
		ref = "artifact:" + l.cellName() + ":commit/" + commit
		ev.Artifacts = []event.Artifact{{Ref: ref, Commit: commit}}
	default:
		if _, ok := redact.RelPath(rel); !ok {
			return nil
		}
		kind := artifactKinds[path.Base(rel)]
		nature := "record"
		switch {
		case strings.HasPrefix(rel, "evidence/") && kind == "":
			kind, nature = "evidence", "evidence"
		case strings.HasPrefix(rel, "review/") && strings.Contains(rel, "/votes/"):
			kind = "review-vote"
		case strings.HasSuffix(rel, ".md"):
			nature = "prose"
		}
		if kind == "" {
			kind = "file"
		}
		data["kind"], data["nature"] = kind, nature
		if mt, ok := mediaTypes[strings.ToLower(path.Ext(rel))]; ok {
			data["media_type"] = mt
		}
		sum, size, ok := "", int64(0), false
		if l.Files != nil {
			sum, size, ok = l.Files.Hash(rel)
		}
		switch {
		case !ok && recorded != "":
			data["integrity"], data["sha256"] = "missing", recorded
		case !ok:
			return nil // a file no record names by hash is reported only when it exists
		case recorded != "" && sum != recorded:
			data["integrity"], data["sha256"], data["bytes"] = "mismatch", sum, size
		case recorded != "":
			data["integrity"], data["sha256"], data["bytes"] = "match", sum, size
		default:
			data["integrity"], data["sha256"], data["bytes"] = "unchecked", sum, size
		}
		if s, ok := data["sha256"].(string); ok {
			ref = "artifact:" + l.cellName() + ":" + rel + "@" + s[:12]
			ev.Artifacts = []event.Artifact{{Ref: ref, SHA256: s}}
		} else {
			ref = "artifact:" + l.cellName() + ":" + rel
			ev.Artifacts = []event.Artifact{{Ref: ref}}
		}
		if l.Files != nil {
			ev.Provenance.Files = []string{rel}
			ev.Provenance.Rule = "artifact:" + l.Files.Where()
		}
	}
	ev.ID = event.ObserverID("artifact", basis.ID) + ":" + event.Enc(rel)
	ev.Data = data
	ev.Ref(ref)
	return ev
}

// Began is history.began for a cell whose history the observer cannot read from a lifecycle
// log (contract 8): a snapshot from cell.json, reconstructed. cellInstance is the generation of
// its lifecycle file, or, with none, the first 8 hex of SHA-256 of cell.json's created_at [A1].
func Began(ticket, reason string, info CellInfo, identity *Identity, r Read, files []string) *event.Event {
	instance := event.Hash8([]byte(info.CreatedAt))
	ev := observerEvent("history.began", event.ObserverID("began", event.Enc(ticket)+":"+instance), "cell-created-at", nil, files)
	ev.Time.ObservedAt = Stamp(r.At)
	if ms, _, ok := parseTime(info.CreatedAt); ok {
		ev.Time.OccurredAt, ev.Time.Precision = stampMS(ms+999), event.PrecisionSecond
		ev.Time.NotBefore, ev.Time.NotAfter = stampMS(ms), stampMS(ms+999)
	} else {
		ev.Time.Precision = event.PrecisionUnknown
	}
	ev.IDs.TicketID, ev.IDs.CellInstance = ticket, instance
	if identity != nil {
		p := identity.ProductOf(ticket)
		ev.IDs.SliceID, ev.IDs.WaveID, ev.IDs.Revision, ev.IDs.ProjectID = p.SliceID, p.WaveID, p.Revision, identity.ProjectID
	}
	var st, round any
	if info.Stage != "" {
		st = info.Stage
	}
	if info.Round > 0 {
		round = info.Round
	}
	ev.Data = map[string]any{"reason": reason, "snapshot": map[string]any{"stage": st, "round": round, "station": nil, "state": nil}}
	ev.Ref(event.CellRef(ticket, 1))
	return ev
}

// StateMismatch is history.gap with reason state-mismatch (contract 6.5): the stage the log
// implies differs from cell.json's. It never fabricates the missing records.
func (l *Lifecycle) StateMismatch(cellStage string, r Read) *event.Event {
	if l.stage == "" || cellStage == "" || l.stage == cellStage {
		return nil
	}
	g := l.gap("state-"+itoa(l.lastLine)+"-"+cellStage, "state-mismatch", l.lastLine, l.lastLine, 0, r)
	g.Data["count"] = nil
	g.Provenance.Files = []string{"cell.json", "lifecycle.jsonl"}
	g.Provenance.Rule = "state-mismatch"
	return g
}
