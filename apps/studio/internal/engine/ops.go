package engine

import (
	"sort"
	"strconv"
	"time"
)

// Args is one operation's typed arguments. Argv validates them and returns the fixed argument
// vector that follows `studio.py --project <root>`.
type Args interface {
	Argv() ([]string, error)
}

// Operation is one row of the allowlist.
type Operation struct {
	Name string
	// New returns an empty argument struct for this operation.
	New func() Args
	// JSONOnFailure: the engine exits 1 with a JSON report on stdout when the thing it judged has
	// problems (slice check, validate). The call still succeeded; its result says what is wrong.
	JSONOnFailure bool
	// Network: the engine may reach the shared repository or GitHub, so it gets a longer time limit.
	Network bool
	// ReadOnly: the engine changes nothing on disk. Every call is still serialised (see Engine).
	ReadOnly bool
	// MaxBody is the largest JSON body the operation accepts; zero means MaxBodyBytes. Only the
	// operations that carry a file (FileArgs) need more.
	MaxBody int64
	// Download: the engine writes files the person must then get (jira export, project export). The
	// server records exactly those files after a successful call and serves only them
	// (server/downloads.go).
	Download bool
	// Timeout, when longer than the configured limit, is this operation's own time limit (M21 F:
	// exporting and bringing in a whole project).
	Timeout time.Duration
	// TooLarge is said instead of the general sentence when the body is larger than BodyLimit.
	TooLarge string
}

// BodyLimit is the largest request body this operation accepts.
func (op Operation) BodyLimit() int64 {
	if op.MaxBody > 0 {
		return op.MaxBody
	}
	return MaxBodyBytes
}

// ---- argument structs, named after the engine's own options in snake case ----

type NoArgs struct{}

func (NoArgs) Argv() ([]string, error) { return nil, nil }

type whereArgs struct{ NoArgs }

func (whereArgs) Argv() ([]string, error) { return []string{"where"}, nil }

type statusArgs struct{ NoArgs }

func (statusArgs) Argv() ([]string, error) { return []string{"status"}, nil }

type validateArgs struct{ NoArgs }

func (validateArgs) Argv() ([]string, error) { return []string{"validate"}, nil }

type refreshArgs struct{ NoArgs }

func (refreshArgs) Argv() ([]string, error) { return []string{"refresh"}, nil }

type ProjectInitArgs struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Vision  string   `json:"vision"`
	Outcome []string `json:"outcome"`
}

func (a *ProjectInitArgs) Argv() ([]string, error) {
	// MACH makes the project's ID from its name; one is checked only when a caller sends its own.
	if a.ID != "" {
		if err := checkID("id", a.ID, ProjectIDPattern, "campaign-platform"); err != nil {
			return nil, err
		}
	}
	if err := checkText("name", a.Name, maxShortText, true); err != nil {
		return nil, err
	}
	if err := checkText("vision", a.Vision, maxLongText, true); err != nil {
		return nil, err
	}
	if err := checkList("outcome", a.Outcome, maxLongText); err != nil {
		return nil, err
	}
	argv := []string{"project", "init"}
	if a.ID != "" {
		argv = append(argv, flag("id", a.ID))
	}
	argv = append(argv, flag("name", a.Name), flag("vision", a.Vision))
	return append(argv, repeated("outcome", a.Outcome)...), nil
}

type ProjectSetArgs struct {
	Name    *string  `json:"name"`
	Vision  *string  `json:"vision"`
	Outcome []string `json:"outcome"`
	Status  *string  `json:"status"`
}

func (a *ProjectSetArgs) Argv() ([]string, error) {
	if err := checkOptionalText("name", a.Name, maxShortText); err != nil {
		return nil, err
	}
	if err := checkOptionalText("vision", a.Vision, maxLongText); err != nil {
		return nil, err
	}
	if err := checkList("outcome", a.Outcome, maxLongText); err != nil {
		return nil, err
	}
	if err := checkOptionalText("status", a.Status, maxIDLength); err != nil {
		return nil, err
	}
	argv := []string{"project", "set"}
	argv = append(argv, optional("name", a.Name)...)
	argv = append(argv, optional("vision", a.Vision)...)
	argv = append(argv, repeated("outcome", a.Outcome)...)
	return append(argv, optional("status", a.Status)...), nil
}

// ProjectCloseIssueArgs: on the product manager's word, close one of this repository's project issues when
// it has more than one (`project close-issue <number>`).
type ProjectCloseIssueArgs struct {
	Number int `json:"number"`
}

func (a *ProjectCloseIssueArgs) Argv() ([]string, error) {
	if a.Number < 1 || a.Number > maxRequestNumber {
		return nil, invalid("number must be an issue number such as 9.")
	}
	return []string{"project", "close-issue", strconv.Itoa(a.Number)}, nil
}

type EpicAddArgs struct {
	Title     string   `json:"title"`
	Criterion []string `json:"criterion"`
}

func (a *EpicAddArgs) Argv() ([]string, error) {
	if err := checkText("title", a.Title, maxShortText, true); err != nil {
		return nil, err
	}
	if err := checkList("criterion", a.Criterion, maxLongText); err != nil {
		return nil, err
	}
	return append([]string{"epic", "add", flag("title", a.Title)}, repeated("criterion", a.Criterion)...), nil
}

type EpicSetArgs struct {
	EpicID    string   `json:"epic_id"`
	Title     *string  `json:"title"`
	Criterion []string `json:"criterion"`
	Status    *string  `json:"status"`
}

func (a *EpicSetArgs) Argv() ([]string, error) {
	if err := checkID("epic_id", a.EpicID, EpicIDPattern, "EPIC-001"); err != nil {
		return nil, err
	}
	if err := checkOptionalText("title", a.Title, maxShortText); err != nil {
		return nil, err
	}
	if err := checkList("criterion", a.Criterion, maxLongText); err != nil {
		return nil, err
	}
	if err := checkOptionalText("status", a.Status, maxIDLength); err != nil {
		return nil, err
	}
	argv := []string{"epic", "set", a.EpicID}
	argv = append(argv, optional("title", a.Title)...)
	argv = append(argv, repeated("criterion", a.Criterion)...)
	return append(argv, optional("status", a.Status)...), nil
}

// RenumberArgs serves epic and slice renumber; `identifier` is the engine's own name.
type RenumberArgs struct {
	Identifier string `json:"identifier"`
	kind       string
}

func (a *RenumberArgs) Argv() ([]string, error) {
	pattern, example := EpicIDPattern, "EPIC-001"
	if a.kind == "slice" {
		pattern, example = SliceIDPattern, "SLICE-001"
	}
	if err := checkID("identifier", a.Identifier, pattern, example); err != nil {
		return nil, err
	}
	return []string{a.kind, "renumber", a.Identifier}, nil
}

type SliceNewArgs struct {
	Epic      string   `json:"epic"`
	Title     string   `json:"title"`
	DependsOn []string `json:"depends_on"`
	ID        *string  `json:"id"`
	// Small starts a small change (M18); absent for a full slice.
	Small *SmallStart `json:"small"`
}

func (a *SliceNewArgs) Argv() ([]string, error) {
	if err := checkID("epic", a.Epic, EpicIDPattern, "EPIC-001"); err != nil {
		return nil, err
	}
	if err := checkText("title", a.Title, maxShortText, true); err != nil {
		return nil, err
	}
	if err := checkIDList("depends_on", a.DependsOn, SliceIDPattern, "SLICE-001", 0); err != nil {
		return nil, err
	}
	if err := checkOptionalID("id", a.ID, SliceIDPattern, "SLICE-004"); err != nil {
		return nil, err
	}
	small, err := smallFlags(a.Small)
	if err != nil {
		return nil, err
	}
	argv := []string{"slice", "new", flag("epic", a.Epic), flag("title", a.Title)}
	argv = append(argv, repeated("depends-on", a.DependsOn)...)
	argv = append(argv, optional("id", a.ID)...)
	return append(argv, small...), nil
}

type SliceSetArgs struct {
	SliceID string  `json:"slice_id"`
	Title   *string `json:"title"`
	Epic    *string `json:"epic"`
	// DependsOn: absent leaves the list alone; an empty list clears it (the engine's "none").
	DependsOn *[]string `json:"depends_on"`
}

func (a *SliceSetArgs) Argv() ([]string, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	if err := checkOptionalText("title", a.Title, maxShortText); err != nil {
		return nil, err
	}
	if err := checkOptionalID("epic", a.Epic, EpicIDPattern, "EPIC-001"); err != nil {
		return nil, err
	}
	argv := []string{"slice", "set", a.SliceID}
	argv = append(argv, optional("title", a.Title)...)
	argv = append(argv, optional("epic", a.Epic)...)
	if a.DependsOn != nil {
		if err := checkIDList("depends_on", *a.DependsOn, SliceIDPattern, "SLICE-001", 0); err != nil {
			return nil, err
		}
		if len(*a.DependsOn) == 0 {
			argv = append(argv, flag("depends-on", "none"))
		} else {
			argv = append(argv, repeated("depends-on", *a.DependsOn)...)
		}
	}
	return argv, nil
}

type SliceResumeArgs struct {
	SliceID *string `json:"slice_id"`
}

func (a *SliceResumeArgs) Argv() ([]string, error) {
	if err := checkOptionalID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	argv := []string{"slice", "resume"}
	if a.SliceID != nil {
		argv = append(argv, *a.SliceID)
	}
	return argv, nil
}

type SlicePauseArgs struct {
	SliceID string `json:"slice_id"`
	Note    string `json:"note"`
}

func (a *SlicePauseArgs) Argv() ([]string, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	if err := checkText("note", a.Note, maxLongText, true); err != nil {
		return nil, err
	}
	return []string{"slice", "pause", a.SliceID, flag("note", a.Note)}, nil
}

type SliceCheckArgs struct {
	SliceID string `json:"slice_id"`
	Ready   bool   `json:"ready"`
}

func (a *SliceCheckArgs) Argv() ([]string, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	argv := []string{"slice", "check", a.SliceID}
	if a.Ready {
		argv = append(argv, "--ready")
	}
	return argv, nil
}

// SliceIDArgs serves slice show, ready and reopen.
type SliceIDArgs struct {
	SliceID string `json:"slice_id"`
	verb    string
}

func (a *SliceIDArgs) Argv() ([]string, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	return []string{"slice", a.verb, a.SliceID}, nil
}

// SliceMoveArgs serves slice.move: exactly one of before, after, first or last.
type SliceMoveArgs struct {
	SliceID string  `json:"slice_id"`
	Before  *string `json:"before"`
	After   *string `json:"after"`
	First   bool    `json:"first"`
	Last    bool    `json:"last"`
}

func (a *SliceMoveArgs) Argv() ([]string, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	if err := checkOptionalID("before", a.Before, SliceIDPattern, "SLICE-002"); err != nil {
		return nil, err
	}
	if err := checkOptionalID("after", a.After, SliceIDPattern, "SLICE-002"); err != nil {
		return nil, err
	}
	var where []string
	if a.Before != nil {
		where = append(where, flag("before", *a.Before))
	}
	if a.After != nil {
		where = append(where, flag("after", *a.After))
	}
	if a.First {
		where = append(where, "--first")
	}
	if a.Last {
		where = append(where, "--last")
	}
	if len(where) != 1 {
		return nil, invalid("Give exactly one of before, after, first or last.")
	}
	return append([]string{"slice", "move", a.SliceID}, where...), nil
}

// SliceTakeArgs serves slice.take: the slice's issue number or its slice ID, exactly one.
type SliceTakeArgs struct {
	Issue   *int    `json:"issue"`
	SliceID *string `json:"slice_id"`
}

func (a *SliceTakeArgs) Argv() ([]string, error) {
	switch {
	case a.Issue != nil && a.SliceID == nil:
		if err := checkRequestNumber(*a.Issue); err != nil {
			return nil, invalid("issue must be an issue number such as 41.")
		}
		return []string{"slice", "take", strconv.Itoa(*a.Issue)}, nil
	case a.SliceID != nil && a.Issue == nil:
		if err := checkID("slice_id", *a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
			return nil, err
		}
		return []string{"slice", "take", *a.SliceID}, nil
	}
	return nil, invalid("Give exactly one of issue or slice_id.")
}

// ReconcileArgs serves reconcile: the product manager keeps their version or takes the other, whole. Exactly one of
// slice_id (a slice someone else saved a newer version of on GitHub) or, M20, target: "project" or an epic's ID
// (EPIC-001), whose own text someone else changed on GitHub while this workspace changed it too.
type ReconcileArgs struct {
	SliceID string `json:"slice_id"`
	Target  string `json:"target"`
	Take    string `json:"take"`
}

func (a *ReconcileArgs) Argv() ([]string, error) {
	var subject string
	switch {
	case a.SliceID != "" && a.Target != "":
		return nil, invalid("Give slice_id or target, not both.")
	case a.Target != "":
		if a.Target != "project" && (len(a.Target) > maxIDLength || !EpicIDPattern.MatchString(a.Target)) {
			return nil, invalid("target must be \"project\" or an epic's ID such as EPIC-001.")
		}
		subject = a.Target
	default:
		if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
			return nil, err
		}
		subject = a.SliceID
	}
	if a.Take != "mine" && a.Take != "theirs" {
		return nil, invalid("take must be \"mine\" or \"theirs\".")
	}
	return []string{"reconcile", subject, flag("take", a.Take)}, nil
}

// ---- requests: GitHub issues labelled as requests (M8) ----

// maxRequestNumber is the engine's own bound (`request_number`: below 10^9).
const maxRequestNumber = 999_999_999

// checkRequestNumber accepts a positive whole number. A string, a fraction or a negative number
// never reaches this point as a number: Decode refuses the wrong type.
func checkRequestNumber(n int) error {
	if n < 1 || n > maxRequestNumber {
		return invalid("number must be a request number such as 42.")
	}
	return nil
}

type requestListArgs struct{ NoArgs }

func (requestListArgs) Argv() ([]string, error) { return []string{"request", "list"}, nil }

// RequestNumberArgs serves request show and request met.
type RequestNumberArgs struct {
	Number int `json:"number"`
	verb   string
}

func (a *RequestNumberArgs) Argv() ([]string, error) {
	if err := checkRequestNumber(a.Number); err != nil {
		return nil, err
	}
	return []string{"request", a.verb, strconv.Itoa(a.Number)}, nil
}

type RequestPickArgs struct {
	Number int    `json:"number"`
	Epic   string `json:"epic"`
	Title  string `json:"title"`
	// Also picks the request up even though another product manager already has.
	Also bool `json:"also"`
	// Small picks the request up as a small change (M18); absent for a full slice.
	Small *SmallStart `json:"small"`
}

func (a *RequestPickArgs) Argv() ([]string, error) {
	if err := checkRequestNumber(a.Number); err != nil {
		return nil, err
	}
	if err := checkID("epic", a.Epic, EpicIDPattern, "EPIC-001"); err != nil {
		return nil, err
	}
	if err := checkText("title", a.Title, maxShortText, true); err != nil {
		return nil, err
	}
	small, err := smallFlags(a.Small)
	if err != nil {
		return nil, err
	}
	argv := []string{"request", "pick", strconv.Itoa(a.Number), flag("epic", a.Epic), flag("title", a.Title)}
	if a.Also {
		argv = append(argv, "--also")
	}
	return append(argv, small...), nil
}

type RequestLinkArgs struct {
	Number  int    `json:"number"`
	SliceID string `json:"slice_id"`
}

func (a *RequestLinkArgs) Argv() ([]string, error) {
	if err := checkRequestNumber(a.Number); err != nil {
		return nil, err
	}
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	return []string{"request", "link", strconv.Itoa(a.Number), a.SliceID}, nil
}

// ---- the allowlist ----

var operations = map[string]Operation{}

func register(op Operation) { operations[op.Name] = op }

func init() {
	register(Operation{Name: "where", New: func() Args { return &whereArgs{} }, ReadOnly: true})
	register(Operation{Name: "status", New: func() Args { return &statusArgs{} }})
	register(Operation{Name: "validate", New: func() Args { return &validateArgs{} }, JSONOnFailure: true})
	register(Operation{Name: "refresh", New: func() Args { return &refreshArgs{} }, Network: true})
	register(Operation{Name: "project.init", New: func() Args { return &ProjectInitArgs{} }})
	register(Operation{Name: "project.set", New: func() Args { return &ProjectSetArgs{} }})
	register(Operation{Name: "project.close-issue", New: func() Args { return &ProjectCloseIssueArgs{} }, Network: true})
	register(Operation{Name: "epic.add", New: func() Args { return &EpicAddArgs{} }})
	register(Operation{Name: "epic.set", New: func() Args { return &EpicSetArgs{} }})
	register(Operation{Name: "epic.renumber", New: func() Args { return &RenumberArgs{kind: "epic"} }})
	register(Operation{Name: "slice.new", New: func() Args { return &SliceNewArgs{} }})
	register(Operation{Name: "slice.set", New: func() Args { return &SliceSetArgs{} }})
	register(Operation{Name: "slice.resume", New: func() Args { return &SliceResumeArgs{} }})
	register(Operation{Name: "slice.pause", New: func() Args { return &SlicePauseArgs{} }})
	register(Operation{Name: "slice.check", New: func() Args { return &SliceCheckArgs{} }, JSONOnFailure: true})
	register(Operation{Name: "slice.show", New: func() Args { return &SliceIDArgs{verb: "show"} }, ReadOnly: true})
	register(Operation{Name: "slice.ready", New: func() Args { return &SliceIDArgs{verb: "ready"} }, Network: true})
	register(Operation{Name: "slice.reopen", New: func() Args { return &SliceIDArgs{verb: "reopen"} }, Network: true})
	register(Operation{Name: "slice.move", New: func() Args { return &SliceMoveArgs{} }, Network: true})
	register(Operation{Name: "slice.take", New: func() Args { return &SliceTakeArgs{} }, Network: true})
	register(Operation{Name: "slice.renumber", New: func() Args { return &RenumberArgs{kind: "slice"} }})
	register(Operation{Name: "reconcile", New: func() Args { return &ReconcileArgs{} }, Network: true})
	register(Operation{Name: "request.list", New: func() Args { return &requestListArgs{} }, ReadOnly: true})
	register(Operation{Name: "request.show", New: func() Args { return &RequestNumberArgs{verb: "show"} }, ReadOnly: true})
	register(Operation{Name: "request.pick", New: func() Args { return &RequestPickArgs{} }, Network: true})
	register(Operation{Name: "request.link", New: func() Args { return &RequestLinkArgs{} }})
	register(Operation{Name: "request.met", New: func() Args { return &RequestNumberArgs{verb: "met"} }, Network: true})
}

// Lookup returns the allowlisted operation with this name.
func Lookup(name string) (Operation, bool) {
	op, ok := operations[name]
	return op, ok
}

// Names lists every allowlisted operation, sorted.
func Names() []string {
	names := make([]string, 0, len(operations))
	for name := range operations {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ShowSlice is the arguments of slice.show, for the host's own draft routes.
func ShowSlice(sliceID string) Args { return &SliceIDArgs{SliceID: sliceID, verb: "show"} }

// CheckSlice is the arguments of slice.check (without --ready), for the host's own draft routes.
func CheckSlice(sliceID string) Args { return &SliceCheckArgs{SliceID: sliceID} }

// ShowIdea is the arguments of idea.show, for the Shape conversation's start route (M16).
func ShowIdea(ideaID string) Args {
	return &IdeaIDArgs{IdeaID: ideaID, words: []string{"idea", "show"}}
}

// StatusArgs is the arguments of status, for the session route.
func StatusArgs() Args { return &statusArgs{} }
