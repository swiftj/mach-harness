package engine

import (
	"encoding/json"
	"regexp"
	"strconv"
)

// The operations M16 added to the engine, for the Shape screens: ideas, the brief and the case, the
// verdict, sizing and routing, the map and apply, change what exists, look back and the chain
// (skills/product-studio/scripts/shape.py and shape_route.py). Each is one engine command with a
// fixed argument vector, as every other operation is.

// The engine's own patterns for Shape's identifiers (shape.py).
var (
	// shape.IDEA_RE.
	IdeaIDPattern = regexp.MustCompile(`^IDEA-[0-9]{3,}$`)
	// shape.FAULT_RE: a self-healing fault ticket.
	FaultIDPattern = regexp.MustCompile(`^AUTO-[0-9]{8}T[0-9]{6}Z(?:-[0-9]{1,4})?$`)
	// shape.OUTCOME_RE and ASSUMPTION_RE.
	OutcomeIDPattern    = regexp.MustCompile(`^O-[1-9][0-9]{0,3}$`)
	AssumptionIDPattern = regexp.MustCompile(`^A-[1-9][0-9]{0,3}$`)
	// shape.SHIPPED_RULE_RE: SLICE-NNN/FR-NN, SLICE-NNN/INV-NN or SLICE-NNN/RN.
	ShippedRulePattern = regexp.MustCompile(`^SLICE-[0-9]{3,}/(?:INV-[0-9]{2,}|FR-[0-9]{2,}|R[0-9]+)$`)
)

const (
	maxIdeaTitle    = 120       // shape.TITLE_CHARS
	maxVerdictWords = 500       // shape.REASON_CHARS
	maxLookbackNote = 500       // shape_route.NOTE_CHARS
	maxSettleReason = 300       // prd.REASON_CHARS, which idea settle uses
	maxShapeInput   = 256 << 10 // shape.MAX_INPUT_BYTES: the most lookups or a map may be
	shapeInputBody  = maxShapeInput + 64<<10
)

// ShapeTarget is implemented by the Shape operations that name one idea, so the server can refuse
// an act on an idea while the guided conversation is writing that idea's brief or case.
type ShapeTarget interface {
	IdeaTarget() string
}

// IdeaIDArgs serves every Shape command that takes only the idea: idea show, renumber, publish,
// size, map-status, apply and chain; brief check and show; case show and check.
type IdeaIDArgs struct {
	IdeaID string `json:"idea_id"`
	words  []string
}

func (a *IdeaIDArgs) IdeaTarget() string { return a.IdeaID }

func (a *IdeaIDArgs) Argv() ([]string, error) {
	if err := checkID("idea_id", a.IdeaID, IdeaIDPattern, "IDEA-001"); err != nil {
		return nil, err
	}
	return append(append([]string{}, a.words...), a.IdeaID), nil
}

type ideaListArgs struct{ NoArgs }

func (ideaListArgs) Argv() ([]string, error) { return []string{"idea", "list"}, nil }

// IdeaAddArgs: a title in the product manager's words and at most one source, by its identifier
// only. The title is the engine's one positional value, so it always follows "--": a title that
// starts with a hyphen is still a title.
type IdeaAddArgs struct {
	Title       string  `json:"title"`
	FromRequest *int    `json:"from_request"`
	FromIssue   *int    `json:"from_issue"`
	FromFault   *string `json:"from_fault"`
}

func (a *IdeaAddArgs) Argv() ([]string, error) {
	if err := checkOneLine("title", a.Title, maxIdeaTitle, true); err != nil {
		return nil, err
	}
	argv := []string{"idea", "add"}
	given := 0
	if a.FromRequest != nil {
		if err := checkRequestNumber(*a.FromRequest); err != nil {
			return nil, invalid("from_request must be a request number such as 57.")
		}
		argv = append(argv, flag("from-request", strconv.Itoa(*a.FromRequest)))
		given++
	}
	if a.FromIssue != nil {
		if err := checkRequestNumber(*a.FromIssue); err != nil {
			return nil, invalid("from_issue must be an issue number such as 58.")
		}
		argv = append(argv, flag("from-issue", strconv.Itoa(*a.FromIssue)))
		given++
	}
	if a.FromFault != nil {
		if !FaultIDPattern.MatchString(*a.FromFault) {
			return nil, invalid("from_fault must be a fault ticket's ID such as AUTO-20261120T101500Z.")
		}
		argv = append(argv, flag("from-fault", *a.FromFault))
		given++
	}
	if given > 1 {
		return nil, invalid("Give at most one of from_request, from_issue or from_fault.")
	}
	return append(argv, "--", a.Title), nil
}

// IdeaStageArgs: the one stage a person sets by hand.
type IdeaStageArgs struct {
	IdeaID string `json:"idea_id"`
	Stage  string `json:"stage"`
}

func (a *IdeaStageArgs) IdeaTarget() string { return a.IdeaID }

func (a *IdeaStageArgs) Argv() ([]string, error) {
	if err := checkID("idea_id", a.IdeaID, IdeaIDPattern, "IDEA-001"); err != nil {
		return nil, err
	}
	if a.Stage != "exploring" {
		return nil, invalid("stage must be \"exploring\": the other stages follow from what is done.")
	}
	return []string{"idea", "stage", a.IdeaID, a.Stage}, nil
}

// IdeaLookupsArgs: what was looked up while exploring, as the JSON `idea lookups --from` reads.
type IdeaLookupsArgs struct {
	IdeaID  string          `json:"idea_id"`
	Lookups json.RawMessage `json:"lookups"`
	stagedPath
}

func (a *IdeaLookupsArgs) IdeaTarget() string { return a.IdeaID }

func (a *IdeaLookupsArgs) Staged() (string, []byte, error) {
	if err := checkID("idea_id", a.IdeaID, IdeaIDPattern, "IDEA-001"); err != nil {
		return "", nil, err
	}
	data, err := decodeJSONObject("lookups", a.Lookups, maxShapeInput)
	return "lookups.json", data, err
}

func (a *IdeaLookupsArgs) Argv() ([]string, error) {
	if err := checkID("idea_id", a.IdeaID, IdeaIDPattern, "IDEA-001"); err != nil {
		return nil, err
	}
	path, err := a.staged()
	if err != nil {
		return nil, err
	}
	return []string{"idea", "lookups", a.IdeaID, flag("from", path)}, nil
}

// IdeaMapArgs: the proposed epics and slices, as the JSON `idea map --from` reads.
type IdeaMapArgs struct {
	IdeaID string          `json:"idea_id"`
	Map    json.RawMessage `json:"map"`
	stagedPath
}

func (a *IdeaMapArgs) IdeaTarget() string { return a.IdeaID }

func (a *IdeaMapArgs) Staged() (string, []byte, error) {
	if err := checkID("idea_id", a.IdeaID, IdeaIDPattern, "IDEA-001"); err != nil {
		return "", nil, err
	}
	data, err := decodeJSONObject("map", a.Map, maxShapeInput)
	return "map.json", data, err
}

func (a *IdeaMapArgs) Argv() ([]string, error) {
	if err := checkID("idea_id", a.IdeaID, IdeaIDPattern, "IDEA-001"); err != nil {
		return nil, err
	}
	path, err := a.staged()
	if err != nil {
		return nil, err
	}
	return []string{"idea", "map", a.IdeaID, flag("from", path)}, nil
}

// IdeaSettleArgs: the product manager's word on an outcome no slice carries. `as` is "slice" (with
// the map slice's key in `slice`), "out-of-scope" or "later".
type IdeaSettleArgs struct {
	IdeaID  string  `json:"idea_id"`
	Outcome string  `json:"outcome"`
	As      string  `json:"as"`
	Slice   *string `json:"slice"`
	Reason  *string `json:"reason"`
}

func (a *IdeaSettleArgs) IdeaTarget() string { return a.IdeaID }

func (a *IdeaSettleArgs) Argv() ([]string, error) {
	if err := checkID("idea_id", a.IdeaID, IdeaIDPattern, "IDEA-001"); err != nil {
		return nil, err
	}
	if err := checkID("outcome", a.Outcome, OutcomeIDPattern, "O-2"); err != nil {
		return nil, err
	}
	var how string
	switch a.As {
	case "slice":
		if a.Slice == nil || !MapKeyPattern.MatchString(*a.Slice) {
			return nil, invalid("slice must be the map slice's key, such as S2.")
		}
		how = "slice:" + *a.Slice
	case "out-of-scope", "later":
		if a.Slice != nil {
			return nil, invalid("slice is given only when as is \"slice\".")
		}
		how = a.As
	default:
		return nil, invalid("as must be \"slice\", \"out-of-scope\" or \"later\".")
	}
	if a.Reason != nil {
		if err := checkOneLine("reason", *a.Reason, maxSettleReason, true); err != nil {
			return nil, err
		}
	}
	argv := []string{"idea", "settle", a.IdeaID, flag("outcome", a.Outcome), flag("as", how)}
	return append(argv, optional("reason", a.Reason)...), nil
}

// IdeaChangeArgs: the second way in, from one shipped rule.
type IdeaChangeArgs struct {
	Rule  string  `json:"rule"`
	Title *string `json:"title"`
}

func (a *IdeaChangeArgs) Argv() ([]string, error) {
	if err := checkID("rule", a.Rule, ShippedRulePattern, "SLICE-007/INV-01"); err != nil {
		return nil, err
	}
	argv := []string{"idea", "change", a.Rule}
	if a.Title != nil {
		if err := checkOneLine("title", *a.Title, maxIdeaTitle, true); err != nil {
			return nil, err
		}
		argv = append(argv, flag("title", *a.Title))
	}
	return argv, nil
}

// VerdictRecordArgs: one person's verdict, in their own words. MACH never recommends one.
type VerdictRecordArgs struct {
	IdeaID   string `json:"idea_id"`
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

func (a *VerdictRecordArgs) IdeaTarget() string { return a.IdeaID }

func (a *VerdictRecordArgs) Argv() ([]string, error) {
	if err := checkID("idea_id", a.IdeaID, IdeaIDPattern, "IDEA-001"); err != nil {
		return nil, err
	}
	switch a.Decision {
	case "go", "not-now", "no":
	default:
		return nil, invalid("decision must be \"go\", \"not-now\" or \"no\".")
	}
	if err := checkOneLine("reason", a.Reason, maxVerdictWords, true); err != nil {
		return nil, err
	}
	return []string{"verdict", "record", a.IdeaID, flag("decision", a.Decision), flag("reason", a.Reason)}, nil
}

// LookbackRecordArgs: the product manager's look back on one outcome or one assumption, exactly one.
type LookbackRecordArgs struct {
	IdeaID     string  `json:"idea_id"`
	Outcome    *string `json:"outcome"`
	Assumption *string `json:"assumption"`
	Result     string  `json:"result"`
	Note       string  `json:"note"`
}

func (a *LookbackRecordArgs) IdeaTarget() string { return a.IdeaID }

func (a *LookbackRecordArgs) Argv() ([]string, error) {
	if err := checkID("idea_id", a.IdeaID, IdeaIDPattern, "IDEA-001"); err != nil {
		return nil, err
	}
	argv := []string{"lookback", "record", a.IdeaID}
	switch {
	case a.Outcome != nil && a.Assumption == nil:
		if err := checkID("outcome", *a.Outcome, OutcomeIDPattern, "O-1"); err != nil {
			return nil, err
		}
		if a.Result != "met" && a.Result != "not-met" && a.Result != "too-early" {
			return nil, invalid("An outcome's result must be \"met\", \"not-met\" or \"too-early\".")
		}
		argv = append(argv, flag("outcome", *a.Outcome))
	case a.Assumption != nil && a.Outcome == nil:
		if err := checkID("assumption", *a.Assumption, AssumptionIDPattern, "A-1"); err != nil {
			return nil, err
		}
		if a.Result != "confirmed" && a.Result != "wrong" && a.Result != "unknown" {
			return nil, invalid("An assumption's result must be \"confirmed\", \"wrong\" or \"unknown\".")
		}
		argv = append(argv, flag("assumption", *a.Assumption))
	default:
		return nil, invalid("Give exactly one of outcome or assumption.")
	}
	if err := checkOneLine("note", a.Note, maxLookbackNote, true); err != nil {
		return nil, err
	}
	return append(argv, flag("result", a.Result), flag("note", a.Note)), nil
}

// decodeJSONObject is decodeJSONInput for an input the engine reads as one JSON object, with the
// engine's own size limit for it.
func decodeJSONObject(field string, raw json.RawMessage, max int) ([]byte, error) {
	data, err := decodeJSONInput(field, raw)
	if err != nil {
		return nil, err
	}
	if data[0] != '{' {
		return nil, invalid("%s must be a JSON object.", field)
	}
	if len(data) > max {
		return nil, invalid("%s is larger than %s.", field, sizeWords(max))
	}
	return data, nil
}

// WritesIdea names the idea a Shape operation that changes something acts on, or "" for any other
// operation, a read, or a body that does not decode (Do refuses that one itself).
func WritesIdea(name string, body []byte) string {
	op, ok := Lookup(name)
	if !ok || op.ReadOnly {
		return ""
	}
	args := op.New()
	target, ok := args.(ShapeTarget)
	if !ok || Decode(body, args) != nil || !IdeaIDPattern.MatchString(target.IdeaTarget()) {
		return ""
	}
	return target.IdeaTarget()
}

func ideaOp(words ...string) func() Args {
	return func() Args { return &IdeaIDArgs{words: words} }
}

func init() {
	register(Operation{Name: "idea.add", New: func() Args { return &IdeaAddArgs{} }})
	register(Operation{Name: "idea.list", New: func() Args { return &ideaListArgs{} }, ReadOnly: true})
	register(Operation{Name: "idea.show", New: ideaOp("idea", "show"), ReadOnly: true})
	register(Operation{Name: "idea.stage", New: func() Args { return &IdeaStageArgs{} }})
	register(Operation{Name: "idea.lookups", New: func() Args { return &IdeaLookupsArgs{} }, MaxBody: shapeInputBody})
	register(Operation{Name: "idea.renumber", New: ideaOp("idea", "renumber")})
	register(Operation{Name: "idea.publish", New: ideaOp("idea", "publish"), Network: true})
	register(Operation{Name: "idea.size", New: ideaOp("idea", "size")})
	register(Operation{Name: "idea.map", New: func() Args { return &IdeaMapArgs{} }, MaxBody: shapeInputBody})
	register(Operation{Name: "idea.settle", New: func() Args { return &IdeaSettleArgs{} }})
	register(Operation{Name: "idea.map-status", New: ideaOp("idea", "map-status"), ReadOnly: true})
	register(Operation{Name: "idea.apply", New: ideaOp("idea", "apply")})
	register(Operation{Name: "idea.change", New: func() Args { return &IdeaChangeArgs{} }})
	register(Operation{Name: "idea.chain", New: ideaOp("idea", "chain"), ReadOnly: true})
	register(Operation{Name: "brief.check", New: ideaOp("brief", "check")})
	register(Operation{Name: "brief.show", New: ideaOp("brief", "show"), ReadOnly: true})
	register(Operation{Name: "case.show", New: ideaOp("case", "show"), ReadOnly: true})
	register(Operation{Name: "case.check", New: ideaOp("case", "check"), ReadOnly: true})
	register(Operation{Name: "verdict.record", New: func() Args { return &VerdictRecordArgs{} }, Network: true})
	register(Operation{Name: "lookback.record", New: func() Args { return &LookbackRecordArgs{} }, Network: true})
}
