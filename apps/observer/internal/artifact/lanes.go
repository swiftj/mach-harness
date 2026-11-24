package artifact

import (
	"archive/tar"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"regexp"
	"strings"
	"time"

	"mach/observer/internal/redact"
)

// The lanes of one ticket's build (M22, docs/mach-next/M22_PARALLEL_BUILD.md sections 7, 8 and 13), as
// the build station recorded them in the cell: build.json's "lanes" block and its tasks, each lane's
// lanes/<L>/lane.json, and build-report.json once the build finished. Read only, through the same
// guarded reads as every other cell file, from the live cell folder or, once it is gone, the cell's
// archive.
//
// Only identifiers, codes, commits, times and numbers are served, each checked again here: lane
// names, task IDs, statuses, reason codes, commit IDs, timestamps and seconds. The files also hold
// prose (task text, notes, deviation details, the failing suite's output, file paths, the holder's
// token); none of it is decoded, so none of it can be served. A file that cannot be read is named
// with why, never left out silently.

const (
	maxBuildJSON  = 8 << 20
	maxLaneJSON   = 2 << 20
	maxReportJSON = 16 << 20
	maxLanes      = 64
	maxTasks      = 2000
)

var (
	laneNameRe = regexp.MustCompile(`^L[1-9][0-9]{0,2}$`)
	taskIDRe   = regexp.MustCompile(`^(?:(?:R[0-9]+|J)-)?T[0-9]{1,5}$`)
	wordRe     = regexp.MustCompile(`^[a-z][a-z-]{0,23}$`)
)

// FileRead says whether one recorded file was read: "read", "absent" or "unreadable" with why (a
// fixed code of the observer's, never the file's words).
type FileRead struct {
	Read string  `json:"read"`
	Why  *string `json:"why"`
}

// LaneView is one lane.
type LaneView struct {
	Lane   string   `json:"lane"`
	Tasks  []string `json:"tasks"`
	Status *string  `json:"status"`
	// Waiting is "free-place" for a lane the lanes-open step did not hand out yet while other lanes
	// of the build are open: it waits for a builder's place to come free. Null otherwise.
	Waiting      *string  `json:"waiting"`
	Record       FileRead `json:"record"` // lanes/<L>/lane.json
	HandedAt     *string  `json:"handed_at"`
	StartedAt    *string  `json:"started_at"`
	LastStepAt   *string  `json:"last_step_at"`
	FinishedAt   *string  `json:"finished_at"`
	Done         *int     `json:"done"`    // tasks done in the lane; null when its record could not be read
	Total        int      `json:"total"`   // tasks the lane plan gives it
	Current      *string  `json:"current"` // the first task not done; null when every one is, or unknown
	TestSeconds  *float64 `json:"test_seconds"`
	WorktreeSecs *float64 `json:"worktree_seconds"`
}

// TaskView is one task of the plan, as build.json and, while its lane is open, the lane's own
// record say.
type TaskView struct {
	Task string  `json:"task"`
	Kind *string `json:"kind"`
	// Part: "before" or "after" the lanes, "lane", or "join" (J-T01); null for a task the lane plan
	// does not place (one a revision round added).
	Part        *string  `json:"part"`
	Lane        *string  `json:"lane"`
	Status      *string  `json:"status"`
	SetAside    bool     `json:"set_aside"`
	Commit      *string  `json:"commit"`      // the task's commit on the ticket's branch: the landed copy for a lane task
	LaneCommit  *string  `json:"lane_commit"` // the commit its lane made; it no longer exists once landed
	RanOn       *string  `json:"ran_on"`
	At          *string  `json:"at"` // when it was done
	TestSeconds *float64 `json:"test_seconds"`
}

// CommitLink follows a lane commit to the commit that landed in its place.
type CommitLink struct {
	LaneCommit string `json:"lane_commit"`
	Task       string `json:"task"`
	Lane       string `json:"lane"`
	// State: "landed" (Landed is the copy on the ticket's branch), "set-aside" (not landed; the task
	// is built again in the cell) or "not-joined" (the lanes are not joined yet: the lane commit is
	// on the lane's branch).
	State  string  `json:"state"`
	Landed *string `json:"landed_commit"`
}

// Batch is one handing-out of lanes.
type Batch struct {
	At      *string  `json:"at"`
	Lanes   []string `json:"lanes"`
	Granted *int     `json:"granted"`
}

// SetAside is a lane whose commits were not landed.
type SetAside struct {
	Lane    string     `json:"lane"`
	Tasks   []string   `json:"tasks"`
	Because []AsideWhy `json:"because"`
}

// AsideWhy is one reason a lane was set aside: the earlier lane it clashed with and the code
// ("same-file", "frozen-test"). The file is not served.
type AsideWhy struct {
	Other *string `json:"other"`
	Why   *string `json:"why"`
}

// Interaction is a whole suite that failed on the joined lanes though every lane passed alone.
type Interaction struct {
	Failing    int      `json:"failing"`     // how many failing tests the output named
	LanesNamed []string `json:"lanes_named"` // the lanes whose files the failing tests name
	Task       *string  `json:"task"`        // the task added to make them pass together (J-T01)
}

// JoinView is the join, once it ran.
type JoinView struct {
	Status      *string      `json:"status"` // JOINED or INTERACTION
	StartedAt   *string      `json:"started_at"`
	FinishedAt  *string      `json:"finished_at"`
	Tip         *string      `json:"tip"`
	Landed      int          `json:"landed"`
	SuitePassed *bool        `json:"suite_passed"`
	SuiteSecs   *float64     `json:"suite_seconds"`
	SuiteRanOn  *string      `json:"suite_ran_on"`
	LandingSecs *float64     `json:"landing_seconds"`
	SetAside    []SetAside   `json:"set_aside"`
	Interaction *Interaction `json:"interaction"`
}

// JoinRefusal is a join that stopped and landed nothing, with landing's own code.
type JoinRefusal struct {
	At         *string `json:"at"`
	ReasonCode *string `json:"reason_code"`
}

// ReportStep is one task's line of the build report's timing.
type ReportStep struct {
	Task        string   `json:"task"`
	Lane        *string  `json:"lane"`
	Seconds     *float64 `json:"seconds"` // since the previous step of its own chain (a lane's, or the cell's)
	TestSeconds *float64 `json:"test_seconds"`
}

// ReportLane is one lane's line of the report's lanes timing.
type ReportLane struct {
	Lane        string   `json:"lane"`
	Elapsed     *float64 `json:"elapsed_seconds"`
	TestSeconds *float64 `json:"test_seconds"`
}

// ReportTiming is what build-report.json measured, as written when the build finished.
type ReportTiming struct {
	FinishedAt      *string      `json:"finished_at"`
	ElapsedSeconds  *float64     `json:"elapsed_seconds"`
	Steps           []ReportStep `json:"steps"`
	WallSeconds     *float64     `json:"lanes_wall_seconds"`
	SummedSeconds   *float64     `json:"lanes_summed_seconds"`
	Ratio           *float64     `json:"lanes_ratio"`
	WorktreeSeconds *float64     `json:"worktree_seconds"`
	LandingSeconds  *float64     `json:"landing_seconds"`
	JoinedSuiteSecs *float64     `json:"joined_suite_seconds"`
	Lanes           []ReportLane `json:"lanes"`
}

// Lanes is a ticket's build in lanes, as served on GET /api/v1/cells/{ticket} under "lanes".
type Lanes struct {
	// State: build.json's (planned, open, sequential, joined), or "unreadable" when build.json could
	// not be read.
	State    string        `json:"state"`
	Source   string        `json:"source"` // "cell" or "archive"
	Build    FileRead      `json:"build_json"`
	Report   FileRead      `json:"build_report"`
	Setting  *int          `json:"setting"` // build.max_lanes when the lanes were planned
	Fork     *string       `json:"fork"`
	OpenedAt *string       `json:"opened_at"`
	Before   []string      `json:"before"`
	After    []string      `json:"after"`
	Lanes    []LaneView    `json:"lanes"`
	Batches  []Batch       `json:"batches"`
	Join     *JoinView     `json:"join"`
	Refusals []JoinRefusal `json:"join_refusals"`
	Tasks    []TaskView    `json:"tasks"`
	Commits  []CommitLink  `json:"commits"`
	Timing   *ReportTiming `json:"report_timing"`
}

// ---- what is decoded: typed, so nothing else in the files is ever looked at ----

type rawTask struct {
	ID         any `json:"id"`
	Kind       any `json:"kind"`
	Status     any `json:"status"`
	Commit     any `json:"commit"`
	LaneCommit any `json:"lane_commit"`
	RanOn      any `json:"ran_on"`
	Lane       any `json:"lane"`
	SetAside   any `json:"set_aside"`
	At         any `json:"at"`
	AddedBy    any `json:"added_by"`
	TestRun    *struct {
		Seconds any `json:"seconds"`
	} `json:"test_run"`
}

type rawLaneEntry struct {
	Lane            any   `json:"lane"`
	Tasks           []any `json:"tasks"`
	Status          any   `json:"status"`
	HandedAt        any   `json:"handed_at"`
	StartedAt       any   `json:"started_at"`
	FinishedAt      any   `json:"finished_at"`
	TestSeconds     any   `json:"test_seconds"`
	WorktreeSeconds any   `json:"worktree_seconds"`
}

type rawBuild struct {
	Tasks []rawTask `json:"tasks"`
	Lanes *struct {
		State    any `json:"state"`
		Setting  any `json:"setting"`
		Fork     any `json:"fork"`
		OpenedAt any `json:"opened_at"`
		Plan     *struct {
			Before []any `json:"before"`
			After  []any `json:"after"`
		} `json:"plan"`
		Lanes   []rawLaneEntry `json:"lanes"`
		Batches []struct {
			At      any   `json:"at"`
			Lanes   []any `json:"lanes"`
			Granted any   `json:"granted"`
		} `json:"batches"`
		Join *struct {
			Status     any `json:"status"`
			StartedAt  any `json:"started_at"`
			FinishedAt any `json:"finished_at"`
			Tip        any `json:"tip"`
			Landed     []struct {
				Task       any `json:"task"`
				Commit     any `json:"commit"`
				LaneCommit any `json:"lane_commit"`
			} `json:"landed"`
			SetAside []struct {
				Lane    any   `json:"lane"`
				Tasks   []any `json:"tasks"`
				Because []struct {
					Other any `json:"other"`
					Why   any `json:"why"`
				} `json:"because"`
			} `json:"set_aside"`
			Suite *struct {
				Passed  any `json:"passed"`
				Seconds any `json:"seconds"`
				RanOn   any `json:"ran_on"`
			} `json:"suite"`
			Interaction *struct {
				Failing    []any `json:"failing"`
				LanesNamed []struct {
					Lane any `json:"lane"`
				} `json:"lanes_named"`
			} `json:"interaction"`
			LandingSeconds any `json:"landing_seconds"`
		} `json:"join"`
		JoinRefusals []struct {
			At     any `json:"at"`
			Reason any `json:"reason"`
		} `json:"join_refusals"`
	} `json:"lanes"`
}

type rawLane struct {
	Status     any       `json:"status"`
	HandedAt   any       `json:"handed_at"`
	StartedAt  any       `json:"started_at"`
	LastStepAt any       `json:"last_step_at"`
	FinishedAt any       `json:"finished_at"`
	Tasks      []rawTask `json:"tasks"`
	Worktree   any       `json:"worktree_seconds"`
}

type rawReport struct {
	FinishedAt any `json:"finished_at"`
	Timing     *struct {
		Elapsed any `json:"elapsed_seconds"`
		Steps   []struct {
			Task        any `json:"task"`
			Lane        any `json:"lane"`
			Seconds     any `json:"seconds_since_previous_step"`
			TestSeconds any `json:"test_seconds"`
		} `json:"steps"`
		Lanes *struct {
			Wall     any `json:"wall_seconds"`
			Summed   any `json:"summed_lane_seconds"`
			Ratio    any `json:"ratio"`
			Worktree any `json:"worktree_seconds"`
			Landing  any `json:"landing_seconds"`
			Joined   any `json:"joined_suite_seconds"`
			Lanes    []struct {
				Lane        any `json:"lane"`
				Elapsed     any `json:"elapsed_seconds"`
				TestSeconds any `json:"test_seconds"`
			} `json:"lanes"`
		} `json:"lanes"`
	} `json:"timing"`
}

// ---- checked values ----

func lane(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok && laneNameRe.MatchString(s)
}

func task(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok && taskIDRe.MatchString(s)
}

func optLane(v any) *string {
	if s, ok := lane(v); ok {
		return &s
	}
	return nil
}

func optTask(v any) *string {
	if s, ok := task(v); ok {
		return &s
	}
	return nil
}

func optWord(v any) *string {
	if s, ok := v.(string); ok && wordRe.MatchString(s) {
		return &s
	}
	return nil
}

func optEnum(v any, allowed ...string) *string {
	if s, ok := v.(string); ok {
		for _, a := range allowed {
			if s == a {
				return &s
			}
		}
	}
	return nil
}

func optCommit(v any) *string {
	if s, ok := v.(string); ok && commitRe.MatchString(s) {
		return &s
	}
	return nil
}

func optCode(v any) *string {
	if s, ok := redact.Label(v); ok && len(s) <= 60 {
		return &s
	}
	return nil
}

// optTime is a recorded moment, re-written in UTC to the second; anything else is null.
func optTime(v any) *string {
	s, ok := v.(string)
	if !ok || len(s) > 40 {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return nil
	}
	out := t.UTC().Format(time.RFC3339)
	return &out
}

func optSeconds(v any) *float64 {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > 1e9 {
		return nil
	}
	return &f
}

func optInt(v any) *int {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) || f < 0 || f > 1e6 {
		return nil
	}
	n := int(f)
	return &n
}

func optBool(v any) *bool {
	b, ok := v.(bool)
	if !ok {
		return nil
	}
	return &b
}

func taskList(list []any) []string {
	out := []string{}
	for _, v := range list {
		if s, ok := task(v); ok && len(out) < maxTasks {
			out = append(out, s)
		}
	}
	return out
}

func str(s string) *string { return &s }

// readOf names a read error with a fixed code.
func readOf(err error) FileRead {
	why := "unreadable"
	switch {
	case err == nil:
		return FileRead{Read: "read"}
	case errors.Is(err, ErrNotHeld):
		return FileRead{Read: "absent"}
	case errors.Is(err, ErrTooLarge):
		why = "larger than the observer reads"
	case errors.Is(err, ErrLink), errors.Is(err, ErrHardLink), errors.Is(err, ErrSwapped):
		why = "a link, which the observer never follows"
	case errors.Is(err, ErrNotFile):
		why = "not a regular file"
	case errors.Is(err, errNotJSON):
		why = "not the JSON the build station writes"
	case errors.Is(err, errTwice):
		why = "named twice in the cell's archive"
	}
	return FileRead{Read: "unreadable", Why: &why}
}

var errNotJSON = errors.New("not JSON")

// cellFiles reads named cell-relative files from the live folder or the archive.
type cellFiles interface {
	read(rel string, max int64) ([]byte, error)
}

type liveCell struct {
	root   *os.Root
	prefix string
}

func (c liveCell) read(rel string, max int64) ([]byte, error) {
	data, _, err := readFile(c.root, c.prefix+rel, max)
	return data, err
}

type archivedCell struct {
	members map[string][]byte
	bad     map[string]error // a member named twice, or too large to read
}

func (a archivedCell) read(rel string, max int64) ([]byte, error) {
	if err := a.bad[rel]; err != nil {
		return nil, err
	}
	data, ok := a.members[rel]
	if !ok {
		return nil, ErrNotHeld
	}
	if int64(len(data)) > max {
		return nil, ErrTooLarge
	}
	return data, nil
}

var errTwice = errors.New("the archive holds the name twice")

// laneFileWanted reports whether an archive member is one of the lane files read here.
func laneFileWanted(name string) bool {
	if name == "build.json" || name == "build-report.json" {
		return true
	}
	parts := strings.Split(name, "/")
	return len(parts) == 3 && parts[0] == "lanes" && laneNameRe.MatchString(parts[1]) && parts[2] == "lane.json"
}

func decode(src cellFiles, rel string, max int64, into any) FileRead {
	data, err := src.read(rel, max)
	if err == nil && json.Unmarshal(data, into) != nil {
		err = errNotJSON
	}
	return readOf(err)
}

// ReadLanes reads the lanes of a ticket's build in the project at root. It returns nil when the
// cell's build.json records no lanes, or when there is no cell folder or archive to read and
// expected is false. expected says the ticket's events show a build in lanes: then a build.json
// that cannot be read is reported (state "unreadable") instead of the lanes being left out.
func ReadLanes(root, ticket string, expected bool) *Lanes {
	if !ticketRe.MatchString(ticket) || len(ticket) > 128 {
		return nil
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return unreadable("", readOf(err), expected)
	}
	defer r.Close()
	var src cellFiles
	source := "cell"
	if isDir(r, ".factory/worktrees/"+ticket) {
		src = liveCell{root: r, prefix: ".factory/worktrees/" + ticket + "/"}
	} else {
		if !expected {
			return nil // an archive is read only for a build its events show in lanes: it is a large read
		}
		members, bad := map[string][]byte{}, map[string]error{}
		err := walkArchive(r, ".factory/archive/"+ticket+".tar.gz", ticket, func(name string, hdr *tar.Header, rd io.Reader) error {
			if !laneFileWanted(name) {
				return nil
			}
			if _, seen := members[name]; seen || bad[name] != nil {
				bad[name] = errTwice
				return nil
			}
			if hdr.Size > maxReportJSON {
				bad[name] = ErrTooLarge
				return nil
			}
			data, err := io.ReadAll(io.LimitReader(rd, maxReportJSON+1))
			if err != nil {
				return err
			}
			members[name] = data
			return nil
		})
		if err != nil {
			return unreadable("archive", readOf(err), expected)
		}
		src, source = archivedCell{members: members, bad: bad}, "archive"
	}
	var b rawBuild
	read := decode(src, "build.json", maxBuildJSON, &b)
	if read.Read != "read" || b.Lanes == nil || b.Lanes.Lanes == nil {
		if read.Read == "read" {
			return nil // a build without lanes: its reply is unchanged
		}
		return unreadable(source, read, expected)
	}
	out := &Lanes{Source: source, Build: read, Before: []string{}, After: []string{}, Lanes: []LaneView{}, Batches: []Batch{},
		Refusals: []JoinRefusal{}, Tasks: []TaskView{}, Commits: []CommitLink{}}
	rec := b.Lanes
	out.State = "unreadable"
	if s := optEnum(rec.State, "planned", "open", "sequential", "joined"); s != nil {
		out.State = *s
	}
	out.Setting, out.Fork, out.OpenedAt = optInt(rec.Setting), optCommit(rec.Fork), optTime(rec.OpenedAt)
	if rec.Plan != nil {
		out.Before, out.After = taskList(rec.Plan.Before), taskList(rec.Plan.After)
	}
	part := map[string]string{}
	for _, t := range out.Before {
		part[t] = "before"
	}
	for _, t := range out.After {
		part[t] = "after"
	}
	laneOfTask := map[string]string{}
	own := map[string]rawTask{} // a lane task as its lane's record has it
	for i, e := range rec.Lanes {
		name, ok := lane(e.Lane)
		if !ok || i >= maxLanes {
			continue
		}
		v := LaneView{Lane: name, Tasks: taskList(e.Tasks), Status: optEnum(e.Status, "planned", "open", "done", "joined", "set-aside", "sequential"),
			HandedAt: optTime(e.HandedAt), StartedAt: optTime(e.StartedAt), FinishedAt: optTime(e.FinishedAt),
			TestSeconds: optSeconds(e.TestSeconds), WorktreeSecs: optSeconds(e.WorktreeSeconds)}
		v.Total = len(v.Tasks)
		for _, t := range v.Tasks {
			laneOfTask[t], part[t] = name, "lane"
		}
		if out.State == "open" && v.Status != nil && *v.Status == "planned" {
			v.Waiting = str("free-place")
		}
		var l rawLane
		v.Record = decode(src, "lanes/"+name+"/lane.json", maxLaneJSON, &l)
		switch {
		case v.Record.Read == "absent" && v.Status != nil && (*v.Status == "planned" || *v.Status == "sequential"):
			// Not handed out yet: a lane has no record of its own until then, and has done nothing.
			zero := 0
			v.Done = &zero
		case v.Record.Read == "absent":
			why := "the lane's record is missing"
			v.Record.Why = &why
		case v.Record.Read == "read":
			if s := optEnum(l.Status, "open", "done"); s != nil && (v.Status == nil || *v.Status == "open" || *v.Status == "planned") {
				v.Status = s // an open lane marks itself done in its own record
			}
			v.HandedAt = firstOf(optTime(l.HandedAt), v.HandedAt)
			v.StartedAt = firstOf(optTime(l.StartedAt), v.StartedAt)
			v.LastStepAt = optTime(l.LastStepAt)
			v.FinishedAt = firstOf(optTime(l.FinishedAt), v.FinishedAt)
			if v.WorktreeSecs == nil {
				v.WorktreeSecs = optSeconds(l.Worktree)
			}
			done := 0
			status := map[string]string{}
			for _, t := range l.Tasks {
				id, ok := task(t.ID)
				if !ok {
					continue
				}
				own[id] = t
				if s, _ := t.Status.(string); s == "done" {
					status[id] = "done"
				}
			}
			for _, t := range v.Tasks {
				if status[t] == "done" {
					done++
				} else if v.Current == nil {
					v.Current = str(t)
				}
			}
			v.Done = &done
		}
		out.Lanes = append(out.Lanes, v)
	}
	for i, bt := range rec.Batches {
		if i >= 200 {
			break
		}
		names := []string{}
		for _, n := range bt.Lanes {
			if s, ok := lane(n); ok {
				names = append(names, s)
			}
		}
		out.Batches = append(out.Batches, Batch{At: optTime(bt.At), Lanes: names, Granted: optInt(bt.Granted)})
	}
	for i, jr := range rec.JoinRefusals {
		if i >= 100 {
			break
		}
		out.Refusals = append(out.Refusals, JoinRefusal{At: optTime(jr.At), ReasonCode: optCode(jr.Reason)})
	}
	landed := map[string]string{} // lane commit -> landed commit
	aside := map[string]bool{}
	if j := rec.Join; j != nil {
		jv := &JoinView{Status: optEnum(j.Status, "JOINED", "INTERACTION"), StartedAt: optTime(j.StartedAt), FinishedAt: optTime(j.FinishedAt),
			Tip: optCommit(j.Tip), LandingSecs: optSeconds(j.LandingSeconds), SetAside: []SetAside{}}
		for _, item := range j.Landed {
			if c, lc := optCommit(item.Commit), optCommit(item.LaneCommit); c != nil && lc != nil {
				landed[*lc] = *c
				jv.Landed++
			}
		}
		if j.Suite != nil {
			jv.SuitePassed, jv.SuiteSecs, jv.SuiteRanOn = optBool(j.Suite.Passed), optSeconds(j.Suite.Seconds), optCommit(j.Suite.RanOn)
		}
		for _, sa := range j.SetAside {
			name, ok := lane(sa.Lane)
			if !ok {
				continue
			}
			aside[name] = true
			item := SetAside{Lane: name, Tasks: taskList(sa.Tasks), Because: []AsideWhy{}}
			for _, why := range sa.Because {
				item.Because = append(item.Because, AsideWhy{Other: optLane(why.Other), Why: optEnum(why.Why, "same-file", "frozen-test")})
			}
			jv.SetAside = append(jv.SetAside, item)
		}
		if in := j.Interaction; in != nil && jv.Status != nil && *jv.Status == "INTERACTION" {
			named := []string{}
			for _, n := range in.LanesNamed {
				if s, ok := lane(n.Lane); ok {
					named = append(named, s)
				}
			}
			jv.Interaction = &Interaction{Failing: len(in.Failing), LanesNamed: named}
		}
		out.Join = jv
	}
	for i, t := range b.Tasks {
		id, ok := task(t.ID)
		if !ok || i >= maxTasks {
			continue
		}
		v := TaskView{Task: id, Kind: optEnum(t.Kind, "test", "impl", "contract", "refactor", "docs"), Status: optWord(t.Status),
			Commit: optCommit(t.Commit), LaneCommit: optCommit(t.LaneCommit), RanOn: optCommit(t.RanOn), At: optTime(t.At),
			Lane: optLane(t.Lane), SetAside: t.SetAside == true}
		if t.TestRun != nil {
			v.TestSeconds = optSeconds(t.TestRun.Seconds)
		}
		if p, ok := part[id]; ok {
			v.Part = str(p)
		} else if a, _ := t.AddedBy.(string); a == "join" {
			v.Part = str("join")
			if out.Join != nil && out.Join.Interaction != nil {
				out.Join.Interaction.Task = str(id)
			}
		}
		if name, ok := laneOfTask[id]; ok {
			v.Lane = str(name)
			l, has := own[id]
			// A set-aside lane's commits were never landed and build.json keeps none on its tasks: its
			// own record still names each, which is what the task's event named.
			if has && aside[name] && v.LaneCommit == nil {
				v.LaneCommit = optCommit(l.Commit)
			}
			// While its lane is open, build.json still has the task pending: the lane's own record says
			// how far it got. Its commit there is the lane commit; nothing has landed yet.
			if has && out.State != "joined" {
				v.Status, v.At, v.LaneCommit, v.Commit = optWord(l.Status), optTime(l.At), optCommit(l.Commit), nil
				v.RanOn = optCommit(l.RanOn)
				if l.TestRun != nil {
					v.TestSeconds = optSeconds(l.TestRun.Seconds)
				}
			}
		}
		out.Tasks = append(out.Tasks, v)
		if v.LaneCommit == nil || v.Lane == nil {
			continue
		}
		link := CommitLink{LaneCommit: *v.LaneCommit, Task: id, Lane: *v.Lane, State: "not-joined"}
		switch {
		case aside[*v.Lane]:
			link.State = "set-aside"
		case out.State == "joined":
			if c, ok := landed[*v.LaneCommit]; ok {
				link.State, link.Landed = "landed", str(c)
			} else if v.Commit != nil && *v.Commit != *v.LaneCommit {
				link.State, link.Landed = "landed", v.Commit
			}
		}
		out.Commits = append(out.Commits, link)
	}
	var rp rawReport
	out.Report = decode(src, "build-report.json", maxReportJSON, &rp)
	if out.Report.Read == "read" && rp.Timing != nil {
		tv := &ReportTiming{FinishedAt: optTime(rp.FinishedAt), ElapsedSeconds: optSeconds(rp.Timing.Elapsed), Steps: []ReportStep{}, Lanes: []ReportLane{}}
		for i, st := range rp.Timing.Steps {
			id, ok := task(st.Task)
			if !ok || i >= maxTasks {
				continue
			}
			tv.Steps = append(tv.Steps, ReportStep{Task: id, Lane: optLane(st.Lane), Seconds: optSeconds(st.Seconds), TestSeconds: optSeconds(st.TestSeconds)})
		}
		if lt := rp.Timing.Lanes; lt != nil {
			tv.WallSeconds, tv.SummedSeconds, tv.Ratio = optSeconds(lt.Wall), optSeconds(lt.Summed), optSeconds(lt.Ratio)
			tv.WorktreeSeconds, tv.LandingSeconds, tv.JoinedSuiteSecs = optSeconds(lt.Worktree), optSeconds(lt.Landing), optSeconds(lt.Joined)
			for _, l := range lt.Lanes {
				if name, ok := lane(l.Lane); ok {
					tv.Lanes = append(tv.Lanes, ReportLane{Lane: name, Elapsed: optSeconds(l.Elapsed), TestSeconds: optSeconds(l.TestSeconds)})
				}
			}
		}
		out.Timing = tv
	}
	return out
}

func firstOf(a, b *string) *string {
	if a != nil {
		return a
	}
	return b
}

// unreadable is the reply when build.json could not be read: only for a build the events show in
// lanes; otherwise nothing is said, as before.
func unreadable(source string, read FileRead, expected bool) *Lanes {
	if !expected {
		return nil
	}
	if read.Read == "absent" {
		why := "no cell folder or archive holds it"
		read = FileRead{Read: "absent", Why: &why}
	}
	return &Lanes{State: "unreadable", Source: source, Build: read, Report: FileRead{Read: "absent"}, Before: []string{}, After: []string{},
		Lanes: []LaneView{}, Batches: []Batch{}, Refusals: []JoinRefusal{}, Tasks: []TaskView{}, Commits: []CommitLink{}}
}
