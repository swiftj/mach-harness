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
// names, task IDs, statuses, reason codes, commit IDs, timestamps, seconds and counts, and the refs
// the station keeps work under (refs/mach/lanes-set-aside/<ticket>/<L>/<n>, refs/mach/lane-files/...),
// which are names it makes from the ticket, the lane and a number. The files also hold prose (task
// text, notes, deviation details, a hand-back's reason, the failing suite's output, file paths,
// branch names, the holder's token, and the test and lint commands with the reason they changed,
// which a builder chooses freely); none of it is decoded, so none of it can be served. Of a changed
// command only which one changed (test or lint) and when are served. A file that cannot be read is
// named with why, never left out silently.

const (
	maxBuildJSON  = 8 << 20
	maxLaneJSON   = 2 << 20
	maxReportJSON = 16 << 20
	maxLanes      = 64
	maxTasks      = 2000
)

var (
	laneNameRe = regexp.MustCompile(`^L[1-9][0-9]{0,2}$`)
	// T01; R1-T01 (a revision round's); J-T01 (the join's, when lanes fail together); C-T01 (added when
	// a changed test or lint command leaves the suite or the linter failing).
	taskIDRe  = regexp.MustCompile(`^(?:(?:R[0-9]+|J|C)-)?T[0-9]{1,5}$`)
	keptRefRe = regexp.MustCompile(`^refs/mach/(?:lanes-set-aside|lane-files)/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})/(L[1-9][0-9]{0,2})/[1-9][0-9]{0,5}$`)
	wordRe    = regexp.MustCompile(`^[a-z][a-z-]{0,23}$`)
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
	// HandedBack is a lane handed back to the cell (status "handed-back"): which tasks it had finished
	// and which not then, and, after the join, which are built in the cell. Its reason is not served.
	HandedBack *HandedBack `json:"handed_back"`
	// MadeFresh lists each time the lane was made fresh because its folder, branch or record belonged
	// to another build, with the ref its earlier work is kept under.
	MadeFresh []MadeFresh `json:"made_fresh"`
	// Recovered lists the tasks of the lane whose step was interrupted and whose commit the station
	// found and recorded afterwards.
	Recovered []Recovered `json:"recovered"`
}

// HandedBack is a lane's hand-back to the cell.
type HandedBack struct {
	At          *string  `json:"at"`
	Finished    []string `json:"finished_then"`
	Unfinished  []string `json:"unfinished_then"`
	BuiltInCell []string `json:"built_in_cell"` // after the join: the tasks built in the cell, one at a time
}

// MadeFresh is one making-fresh of a lane. Why is the station's code when it is one; the ref is
// where the earlier work is kept (null when there was none to keep); StateFileKept says whether
// the earlier record was kept beside it in the cell (its path is not served).
type MadeFresh struct {
	At            *string `json:"at"`
	Why           *string `json:"why"`
	Ref           *string `json:"ref"`
	StateFileKept bool    `json:"state_file_kept"`
}

// Recovered is a task whose interrupted step the station recovered: its commit was found and recorded.
type Recovered struct {
	Task   string  `json:"task"`
	At     *string `json:"at"`
	Commit *string `json:"commit"`
}

// Deviation is one recorded deviation of the build about its lanes, its commands or a recovered
// step: its type, and the identifiers it names. Its detail (prose) is not served.
type Deviation struct {
	Type   string  `json:"type"`
	Lane   *string `json:"lane"`
	Task   *string `json:"task"`
	At     *string `json:"at"`
	Ref    *string `json:"ref"`
	Commit *string `json:"commit"`
	// Command is "test" or "lint" on a test-command-set or lint-command-set; the command itself is not served.
	Command *string `json:"command"`
}

// deviationTypes are the deviations served: the ones about lanes, changed commands and recovered steps.
var deviationTypes = map[string]bool{
	"lanes-sequential": true, "lane-files-set-aside": true, "lane-handed-back": true, "lane-handed-back-joined": true,
	"lane-set-aside": true, "lanes-interaction": true, "test-command-set": true, "lint-command-set": true,
	"step-recovered": true, "lane-made-fresh": true, "lane-worktree-remade": true, "lanes-landed-on-moved-branch": true,
}

// CommandChange is one change of the build's test or lint command (build.json command_changes): when,
// which commands, and in which round. The commands and the reason are a builder's own words: not served.
type CommandChange struct {
	At       *string  `json:"at"`
	Commands []string `json:"commands"`
	Loop     *int     `json:"loop"`
}

// TaskView is one task of the plan, as build.json and, while its lane is open, the lane's own
// record say.
type TaskView struct {
	Task string  `json:"task"`
	Kind *string `json:"kind"`
	// Part: "before" or "after" the lanes, "lane", "join" (J-T01), or "commands" (C-T01, added when a
	// changed command left the suite or the linter failing); null for a task the lane plan does not
	// place (one a revision round added).
	Part     *string `json:"part"`
	Lane     *string `json:"lane"`
	Status   *string `json:"status"`
	SetAside bool    `json:"set_aside"`
	// HandedBack: a task of a lane handed back unfinished, built in the cell after the join.
	HandedBack bool `json:"handed_back"`
	// Recovered: its step was interrupted, and the station found its commit and recorded it afterwards.
	Recovered   *Recovered `json:"recovered"`
	Commit      *string    `json:"commit"`      // the task's commit on the ticket's branch: the landed copy for a lane task
	LaneCommit  *string    `json:"lane_commit"` // the commit its lane made; it no longer exists once landed
	RanOn       *string    `json:"ran_on"`
	At          *string    `json:"at"` // when it was done
	TestSeconds *float64   `json:"test_seconds"`
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
	// KeptAs is the ref its commits are kept under, so nothing is lost; null when none was recorded.
	KeptAs *string `json:"kept_as"`
}

// AsideWhys are the codes of why a lane was set aside at the join.
var AsideWhys = []string{"same-file", "frozen-test", "case-clash", "file-folder", "branch-moved", "did-not-apply", "unrecorded-commits", "lane-history"}

// AsideWhy is one reason a lane was set aside: the code, the earlier lane it clashed with when it
// names one, how many commits made on the ticket's branch changed its file (branch-moved), and the
// commit that did not apply (did-not-apply). The file is not served.
type AsideWhy struct {
	Other   *string `json:"other"`
	Why     *string `json:"why"`
	Commits *int    `json:"commits"`
	Commit  *string `json:"commit"`
}

// MovedBranch is the ticket's branch moving while the lanes were open: the lanes landed on its new
// head. The commits made there are served by ID; their files only as a count.
type MovedBranch struct {
	From    *string  `json:"from"`
	To      *string  `json:"to"`
	Commits []string `json:"commits"`
	Files   int      `json:"files"`
}

// Interaction is a whole suite that failed on the joined result of the lanes.
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
	MovedBranch *MovedBranch `json:"moved_branch"`
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
	State  string `json:"state"`
	Source string `json:"source"` // "cell" or "archive"; "none" with state "not-kept"
	// NotKept, with state "not-kept": the cell folder is gone and cleanup kept no archive of it, so
	// the lanes' files cannot be read; why, from the ticket's run record. Absent otherwise.
	NotKept  *NotKept      `json:"not_kept,omitempty"`
	Build    FileRead      `json:"build_json"`
	Report   FileRead      `json:"build_report"`
	Setting  *int          `json:"setting"`          // build.max_lanes when the lanes were planned
	Started  *string       `json:"build_started_at"` // when the build started (build.py start)
	Fork     *string       `json:"fork"`
	OpenedAt *string       `json:"opened_at"`
	Before   []string      `json:"before"`
	After    []string      `json:"after"`
	Lanes    []LaneView    `json:"lanes"`
	Batches  []Batch       `json:"batches"`
	Join     *JoinView     `json:"join"`
	Refusals []JoinRefusal `json:"join_refusals"`
	// JoinStartedAt is when the latest join started (build.json's join_started_at), recorded at the
	// moment it really started; null before any join started.
	JoinStartedAt *string `json:"join_started_at"`
	// Joining says whether a join that started has not reached its result yet: "running" (the process
	// doing it is alive on this machine), "interrupted" (that process is gone: the join never finished
	// and can be run again) or "unknown" (it cannot be checked from here); null when no join is under
	// way. The process is checked, never served.
	Joining *string       `json:"joining"`
	Tasks   []TaskView    `json:"tasks"`
	Commits []CommitLink  `json:"commits"`
	Timing  *ReportTiming `json:"report_timing"`
	// SequentialBecause, for a build decided to be built one task at a time: "free-places" (too few
	// builders' places were free) or "suite" (the cell's suite was not passing where the lanes would
	// open, SequentialSuite says how: "red" or "unknown"); null otherwise or when not recorded.
	SequentialBecause *string `json:"sequential_because"`
	SequentialSuite   *string `json:"sequential_suite"`
	// Deviations about the lanes, changed commands and recovered steps: build.json's, in its order,
	// then, while the lanes are not joined, each lane's own (the join copies them into build.json).
	Deviations     []Deviation     `json:"deviations"`
	CommandChanges []CommandChange `json:"command_changes"`
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
	HandedBack any `json:"handed_back"`
	Recovered  *struct {
		At     any `json:"at"`
		Commit any `json:"commit"`
	} `json:"recovered"`
	TestRun *struct {
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
	HandedBack      *struct {
		At             any   `json:"at"`
		FinishedThen   []any `json:"finished_then"`
		UnfinishedThen []any `json:"unfinished_then"`
		BuiltInCell    []any `json:"built_in_cell"`
	} `json:"handed_back"`
	MadeFresh []struct {
		At        any `json:"at"`
		Why       any `json:"why"`
		Ref       any `json:"ref"`
		StateFile any `json:"state_file"`
	} `json:"made_fresh"`
}

// rawDeviation is a deviation's identifiers; its detail, reason and the commands are never decoded.
type rawDeviation struct {
	Type    any `json:"type"`
	Task    any `json:"task"`
	Lane    any `json:"lane"`
	At      any `json:"at"`
	Ref     any `json:"ref"`
	Commit  any `json:"commit"`
	Command any `json:"command"`
}

type rawBuild struct {
	StartedAt      any            `json:"started_at"`
	Tasks          []rawTask      `json:"tasks"`
	Deviations     []rawDeviation `json:"deviations"`
	CommandChanges []struct {
		At      any `json:"at"`
		Changed []struct {
			Command any `json:"command"`
		} `json:"changed"`
		Loop any `json:"loop"`
	} `json:"command_changes"`
	Lanes *struct {
		State      any `json:"state"`
		Setting    any `json:"setting"`
		Fork       any `json:"fork"`
		OpenedAt   any `json:"opened_at"`
		Suite      any `json:"suite"`       // go_sequential: the suite was not green where the lanes would open
		FreePlaces any `json:"free_places"` // go_sequential: too few builders' places were free
		Plan       *struct {
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
				KeptAs  any   `json:"kept_as"`
				Because []struct {
					Other   any   `json:"other"`
					Why     any   `json:"why"`
					Commits []any `json:"commits"`
					Commit  any   `json:"commit"`
				} `json:"because"`
			} `json:"set_aside"`
			MovedBranch *struct {
				From    any   `json:"from"`
				To      any   `json:"to"`
				Commits []any `json:"commits"`
				Files   []any `json:"files"`
			} `json:"moved_branch"`
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
		JoinStartedAt any `json:"join_started_at"`
		JoinRunning   *struct {
			Pid  any `json:"pid"`
			Host any `json:"host"`
		} `json:"join_running"`
	} `json:"lanes"`
}

type rawLane struct {
	Status     any            `json:"status"`
	HandedAt   any            `json:"handed_at"`
	StartedAt  any            `json:"started_at"`
	LastStepAt any            `json:"last_step_at"`
	FinishedAt any            `json:"finished_at"`
	Tasks      []rawTask      `json:"tasks"`
	Worktree   any            `json:"worktree_seconds"`
	Deviations []rawDeviation `json:"deviations"`
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

// optRef is a ref the station keeps a lane's work under, for this ticket only.
func optRef(v any, ticket string) *string {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	if m := keptRefRe.FindStringSubmatch(s); m != nil && m[1] == ticket {
		return &s
	}
	return nil
}

func recoveredOf(id string, t rawTask) *Recovered {
	if t.Recovered == nil {
		return nil
	}
	return &Recovered{Task: id, At: optTime(t.Recovered.At), Commit: optCommit(t.Recovered.Commit)}
}

// deviationsOf keeps the served deviations' identifiers; lane names the lane whose own record they
// come from ("" for build.json's, which name their lane themselves).
func deviationsOf(list []rawDeviation, lane, ticket string) []Deviation {
	out := []Deviation{}
	for i, d := range list {
		if i >= 1000 {
			break
		}
		typ, _ := d.Type.(string)
		if !deviationTypes[typ] {
			continue
		}
		item := Deviation{Type: typ, Lane: optLane(d.Lane), Task: optTask(d.Task), At: optTime(d.At), Ref: optRef(d.Ref, ticket), Commit: optCommit(d.Commit)}
		if lane != "" {
			item.Lane = str(lane)
		}
		if typ == "test-command-set" || typ == "lint-command-set" {
			item.Command = optEnum(d.Command, "test", "lint")
			item.Ref, item.Commit = nil, nil
		}
		out = append(out, item)
	}
	return out
}

func commandChangesOf(b *rawBuild) []CommandChange {
	out := []CommandChange{}
	for i, c := range b.CommandChanges {
		if i >= 200 {
			break
		}
		cmds := []string{}
		for _, ch := range c.Changed {
			if k := optEnum(ch.Command, "test", "lint"); k != nil {
				cmds = append(cmds, *k)
			}
		}
		if len(cmds) == 0 {
			continue
		}
		out = append(out, CommandChange{At: optTime(c.At), Commands: cmds, Loop: optInt(c.Loop)})
	}
	return out
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
	ln, _ := ReadBuild(root, ticket, expected, false)
	return ln
}

// ReadBuild reads a ticket's build.json once for both its lanes (as ReadLanes) and its command
// changes (build.json command_changes: which command changed and when, for any build, in lanes or
// not; empty when none). commandsExpected says the ticket's events show a command changed: then
// the cell's archive is read for it too.
func ReadBuild(root, ticket string, expected, commandsExpected bool) (*Lanes, []CommandChange) {
	if !ticketRe.MatchString(ticket) || len(ticket) > 128 {
		return nil, nil
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return unreadable("", readOf(err), expected), nil
	}
	defer r.Close()
	var src cellFiles
	source := "cell"
	if isDir(r, ".factory/worktrees/"+ticket) {
		src = liveCell{root: r, prefix: ".factory/worktrees/" + ticket + "/"}
	} else {
		if !expected && !commandsExpected {
			return nil, nil // an archive is read only for a build its events show in lanes or with a changed command: it is a large read
		}
		if nk := ArchiveNotKept(r, ticket); nk != nil {
			return notKept(nk, expected), nil // no archive was kept: said plainly, not as a file that cannot be read
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
			return unreadable("archive", readOf(err), expected), nil
		}
		src, source = archivedCell{members: members, bad: bad}, "archive"
	}
	var b rawBuild
	read := decode(src, "build.json", maxBuildJSON, &b)
	var commands []CommandChange
	if read.Read == "read" {
		commands = commandChangesOf(&b)
	}
	if read.Read != "read" || b.Lanes == nil || b.Lanes.Lanes == nil {
		if read.Read == "read" {
			return nil, commands // a build without lanes: its reply is unchanged
		}
		return unreadable(source, read, expected), nil
	}
	out := &Lanes{Source: source, Build: read, Before: []string{}, After: []string{}, Lanes: []LaneView{}, Batches: []Batch{},
		Refusals: []JoinRefusal{}, Tasks: []TaskView{}, Commits: []CommitLink{}, Deviations: deviationsOf(b.Deviations, "", ticket), CommandChanges: commands}
	rec := b.Lanes
	out.State = "unreadable"
	if s := optEnum(rec.State, "planned", "open", "sequential", "joined"); s != nil {
		out.State = *s
	}
	if out.State == "sequential" {
		if s := optEnum(rec.Suite, "red", "unknown"); s != nil {
			out.SequentialBecause, out.SequentialSuite = str("suite"), s
		} else if rec.FreePlaces != nil {
			out.SequentialBecause = str("free-places")
		}
	}
	out.Setting, out.Fork, out.OpenedAt, out.Started = optInt(rec.Setting), optCommit(rec.Fork), optTime(rec.OpenedAt), optTime(b.StartedAt)
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
		v := LaneView{Lane: name, Tasks: taskList(e.Tasks), Status: optEnum(e.Status, "planned", "open", "done", "joined", "set-aside", "sequential", "handed-back"),
			HandedAt: optTime(e.HandedAt), StartedAt: optTime(e.StartedAt), FinishedAt: optTime(e.FinishedAt),
			TestSeconds: optSeconds(e.TestSeconds), WorktreeSecs: optSeconds(e.WorktreeSeconds), MadeFresh: []MadeFresh{}, Recovered: []Recovered{}}
		v.Total = len(v.Tasks)
		if hb := e.HandedBack; hb != nil {
			v.HandedBack = &HandedBack{At: optTime(hb.At), Finished: taskList(hb.FinishedThen), Unfinished: taskList(hb.UnfinishedThen), BuiltInCell: taskList(hb.BuiltInCell)}
		}
		for j, mf := range e.MadeFresh {
			if j >= 50 {
				break
			}
			kept := false
			if s, ok := mf.StateFile.(string); ok && s != "" {
				kept = true
			}
			v.MadeFresh = append(v.MadeFresh, MadeFresh{At: optTime(mf.At), Why: optWord(mf.Why), Ref: optRef(mf.Ref, ticket), StateFileKept: kept})
		}
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
				if rv := recoveredOf(id, t); rv != nil && len(v.Recovered) < maxTasks {
					v.Recovered = append(v.Recovered, *rv)
				}
			}
			// A lane's own deviations (a recovered step) are copied into build.json at the join, with the lane.
			if out.State != "joined" {
				out.Deviations = append(out.Deviations, deviationsOf(l.Deviations, name, ticket)...)
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
	out.JoinStartedAt = optTime(rec.JoinStartedAt)
	if run := rec.JoinRunning; run != nil && out.State == "open" && source == "cell" {
		out.Joining = str(joinState(run.Pid, run.Host))
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
			item := SetAside{Lane: name, Tasks: taskList(sa.Tasks), Because: []AsideWhy{}, KeptAs: optRef(sa.KeptAs, ticket)}
			for k, why := range sa.Because {
				if k >= 50 {
					break
				}
				w := AsideWhy{Other: optLane(why.Other), Why: optEnum(why.Why, AsideWhys...), Commit: optCommit(why.Commit)}
				if why.Commits != nil {
					n := len(why.Commits)
					w.Commits = &n
				}
				item.Because = append(item.Because, w)
			}
			jv.SetAside = append(jv.SetAside, item)
		}
		if mb := j.MovedBranch; mb != nil {
			m := &MovedBranch{From: optCommit(mb.From), To: optCommit(mb.To), Commits: []string{}, Files: len(mb.Files)}
			for _, c := range mb.Commits {
				if s := optCommit(c); s != nil && len(m.Commits) < 200 {
					m.Commits = append(m.Commits, *s)
				}
			}
			jv.MovedBranch = m
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
			Lane: optLane(t.Lane), SetAside: t.SetAside == true, HandedBack: t.HandedBack == true, Recovered: recoveredOf(id, t)}
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
		} else if a == "set-commands" {
			v.Part = str("commands")
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
				v.RanOn, v.Recovered = optCommit(l.RanOn), recoveredOf(id, l)
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
	return out, commands
}

func firstOf(a, b *string) *string {
	if a != nil {
		return a
	}
	return b
}

// notKept is the reply for a build in lanes whose cell folder is gone with no archive kept.
func notKept(nk *NotKept, expected bool) *Lanes {
	if !expected {
		return nil
	}
	why := nk.Reason
	ln := unreadable("none", FileRead{Read: "absent"}, true)
	ln.State, ln.NotKept, ln.Build = "not-kept", nk, FileRead{Read: "absent", Why: &why}
	return ln
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
		Lanes: []LaneView{}, Batches: []Batch{}, Refusals: []JoinRefusal{}, Tasks: []TaskView{}, Commits: []CommitLink{},
		Deviations: []Deviation{}, CommandChanges: []CommandChange{}}
}
