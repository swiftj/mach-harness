package engine

// M18: a small change (docs/mach-next/M18_DESIGN.md part C). Starting one is slice.new or
// request.pick with a `small` object; leaving the light path on the product manager's word is
// slice.widen. Both are the engine's own commands (`--small --change= [--rule=]`, `slice widen
// SLICE --why=`); whether a change is small is decided by the engine, never here.

// SmallChanges are the engine's two kinds of small change (small.CHANGES), in its order.
var SmallChanges = []string{"fix", "adjustment"}

// MaxWidenReason bounds the product manager's reason for leaving the light path: one or two
// sentences, like every other reason a person gives the engine (need why, a settlement's reason).
const MaxWidenReason = 300

// SmallStart is a small change's kind and, for a fix, the shipped rule that is not holding (in
// force on the product manager's copy of main; the engine checks that). An adjustment names none.
type SmallStart struct {
	Change string  `json:"change"`
	Rule   *string `json:"rule"`
}

func (s *SmallStart) argv() ([]string, error) {
	switch s.Change {
	case "fix":
		if s.Rule == nil {
			return nil, invalid("A fix names the shipped rule that is not holding (small.rule), such as SLICE-003/FR-02.")
		}
		if err := checkID("small.rule", *s.Rule, ShippedRulePattern, "SLICE-003/FR-02"); err != nil {
			return nil, err
		}
		return []string{"--small", flag("change", "fix"), flag("rule", *s.Rule)}, nil
	case "adjustment":
		if s.Rule != nil {
			return nil, invalid("An adjustment names no shipped rule; only a fix does (leave out small.rule).")
		}
		return []string{"--small", flag("change", "adjustment")}, nil
	case "":
		return nil, invalid("small.change is required: \"fix\" or \"adjustment\".")
	}
	return nil, invalid("small.change must be \"fix\" or \"adjustment\".")
}

// smallFlags is nothing for a full slice, and the engine's start flags for a small change.
func smallFlags(s *SmallStart) ([]string, error) {
	if s == nil {
		return nil, nil
	}
	return s.argv()
}

// SliceWidenArgs serves slice.widen: the product manager's own reason, in their words. The
// conversation's `--by-rule` is not an operation: no person's button names a rule.
type SliceWidenArgs struct {
	SliceID string `json:"slice_id"`
	Why     string `json:"why"`
}

func (a *SliceWidenArgs) Argv() ([]string, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	if err := checkText("why", a.Why, MaxWidenReason, true); err != nil {
		return nil, err
	}
	return []string{"slice", "widen", a.SliceID, flag("why", a.Why)}, nil
}

func init() {
	// A change to the work order on this computer: no GitHub, as the engine's commit_or_restore.
	register(Operation{Name: "slice.widen", New: func() Args { return &SliceWidenArgs{} }})
}
