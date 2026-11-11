package engine

import (
	"sort"
	"strings"
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
	// Network: the engine may fetch from the shared repository, so it gets a longer time limit.
	Network bool
	// ReadOnly: the engine changes nothing on disk. Every call is still serialised (see Engine).
	ReadOnly bool
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
	if err := checkID("id", a.ID, ProjectIDPattern, "campaign-platform"); err != nil {
		return nil, err
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
	argv := []string{"project", "init", flag("id", a.ID), flag("name", a.Name), flag("vision", a.Vision)}
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

// EpicIDArgs serves epic approve.
type EpicIDArgs struct {
	EpicID string `json:"epic_id"`
	verb   string
}

func (a *EpicIDArgs) Argv() ([]string, error) {
	if err := checkID("epic_id", a.EpicID, EpicIDPattern, "EPIC-001"); err != nil {
		return nil, err
	}
	return []string{"epic", a.verb, a.EpicID}, nil
}

// RenumberArgs serves epic, slice and wave renumber; `identifier` is the engine's own name.
type RenumberArgs struct {
	Identifier string `json:"identifier"`
	kind       string
}

func (a *RenumberArgs) Argv() ([]string, error) {
	pattern, example := EpicIDPattern, "EPIC-001"
	switch a.kind {
	case "slice":
		pattern, example = SliceIDPattern, "SLICE-001"
	case "wave":
		pattern, example = WaveIDPattern, "WAVE-001"
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
	argv := []string{"slice", "new", flag("epic", a.Epic), flag("title", a.Title)}
	argv = append(argv, repeated("depends-on", a.DependsOn)...)
	return append(argv, optional("id", a.ID)...), nil
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

// SliceIDArgs serves slice show, approve and reopen.
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

type WaveNewArgs struct {
	Slice []string `json:"slice"`
}

func (a *WaveNewArgs) Argv() ([]string, error) {
	if err := checkIDList("slice", a.Slice, SliceIDPattern, "SLICE-001", 0); err != nil {
		return nil, err
	}
	return append([]string{"wave", "new"}, repeated("slice", a.Slice)...), nil
}

// WaveSlicesArgs serves wave add and wave remove.
type WaveSlicesArgs struct {
	WaveID   string   `json:"wave_id"`
	SliceIDs []string `json:"slice_ids"`
	verb     string
}

func (a *WaveSlicesArgs) Argv() ([]string, error) {
	if err := checkID("wave_id", a.WaveID, WaveIDPattern, "WAVE-001"); err != nil {
		return nil, err
	}
	if err := checkIDList("slice_ids", a.SliceIDs, SliceIDPattern, "SLICE-001", 1); err != nil {
		return nil, err
	}
	return append([]string{"wave", a.verb, a.WaveID}, a.SliceIDs...), nil
}

type WaveApproveArgs struct {
	WaveID string  `json:"wave_id"`
	Actor  *string `json:"actor"`
}

func (a *WaveApproveArgs) Argv() ([]string, error) {
	if err := checkID("wave_id", a.WaveID, WaveIDPattern, "WAVE-001"); err != nil {
		return nil, err
	}
	if err := checkOptionalText("actor", a.Actor, maxShortText); err != nil {
		return nil, err
	}
	return append([]string{"wave", "approve", a.WaveID}, optional("actor", a.Actor)...), nil
}

type ReconcileArgs struct {
	Artifact string  `json:"artifact"`
	Take     string  `json:"take"`
	Field    *string `json:"field"`
}

func (a *ReconcileArgs) Argv() ([]string, error) {
	if a.Artifact == "" {
		return nil, invalid("artifact is required.")
	}
	if len(a.Artifact) > maxArtifactLen || !artifactPattern.MatchString(a.Artifact) || strings.Contains(a.Artifact, "..") {
		return nil, invalid("artifact must be a path or ID listed under needs_reconciling.")
	}
	if a.Take != "mine" && a.Take != "theirs" {
		return nil, invalid("take must be \"mine\" or \"theirs\".")
	}
	argv := []string{"reconcile", a.Artifact, flag("take", a.Take)}
	if a.Field != nil {
		if len(*a.Field) > 64 || !fieldPattern.MatchString(*a.Field) {
			return nil, invalid("field must be a field name such as acceptance_criteria.")
		}
		argv = append(argv, flag("field", *a.Field))
	}
	return argv, nil
}

// SendArgs serves send and send.preview (`send <wave> --dry-run`).
type SendArgs struct {
	WaveID string `json:"wave_id"`
	dryRun bool
}

func (a *SendArgs) Argv() ([]string, error) {
	if err := checkID("wave_id", a.WaveID, WaveIDPattern, "WAVE-001"); err != nil {
		return nil, err
	}
	argv := []string{"send", a.WaveID}
	if a.dryRun {
		argv = append(argv, "--dry-run")
	}
	return argv, nil
}

type FeedbackArgs struct {
	WaveID *string `json:"wave_id"`
}

func (a *FeedbackArgs) Argv() ([]string, error) {
	if err := checkOptionalID("wave_id", a.WaveID, WaveIDPattern, "WAVE-001"); err != nil {
		return nil, err
	}
	argv := []string{"feedback"}
	if a.WaveID != nil {
		argv = append(argv, *a.WaveID)
	}
	return argv, nil
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
	register(Operation{Name: "epic.add", New: func() Args { return &EpicAddArgs{} }})
	register(Operation{Name: "epic.set", New: func() Args { return &EpicSetArgs{} }})
	register(Operation{Name: "epic.approve", New: func() Args { return &EpicIDArgs{verb: "approve"} }})
	register(Operation{Name: "epic.renumber", New: func() Args { return &RenumberArgs{kind: "epic"} }})
	register(Operation{Name: "slice.new", New: func() Args { return &SliceNewArgs{} }})
	register(Operation{Name: "slice.set", New: func() Args { return &SliceSetArgs{} }})
	register(Operation{Name: "slice.resume", New: func() Args { return &SliceResumeArgs{} }})
	register(Operation{Name: "slice.pause", New: func() Args { return &SlicePauseArgs{} }})
	register(Operation{Name: "slice.check", New: func() Args { return &SliceCheckArgs{} }, JSONOnFailure: true})
	register(Operation{Name: "slice.show", New: func() Args { return &SliceIDArgs{verb: "show"} }, ReadOnly: true})
	register(Operation{Name: "slice.approve", New: func() Args { return &SliceIDArgs{verb: "approve"} }})
	register(Operation{Name: "slice.reopen", New: func() Args { return &SliceIDArgs{verb: "reopen"} }})
	register(Operation{Name: "slice.renumber", New: func() Args { return &RenumberArgs{kind: "slice"} }})
	register(Operation{Name: "wave.new", New: func() Args { return &WaveNewArgs{} }})
	register(Operation{Name: "wave.add", New: func() Args { return &WaveSlicesArgs{verb: "add"} }})
	register(Operation{Name: "wave.remove", New: func() Args { return &WaveSlicesArgs{verb: "remove"} }})
	register(Operation{Name: "wave.approve", New: func() Args { return &WaveApproveArgs{} }})
	register(Operation{Name: "wave.renumber", New: func() Args { return &RenumberArgs{kind: "wave"} }})
	register(Operation{Name: "reconcile", New: func() Args { return &ReconcileArgs{} }})
	register(Operation{Name: "send.preview", New: func() Args { return &SendArgs{dryRun: true} }, Network: true})
	register(Operation{Name: "send", New: func() Args { return &SendArgs{} }, Network: true})
	register(Operation{Name: "feedback", New: func() Args { return &FeedbackArgs{} }, Network: true})
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

// StatusArgs is the arguments of status, for the session route.
func StatusArgs() Args { return &statusArgs{} }
