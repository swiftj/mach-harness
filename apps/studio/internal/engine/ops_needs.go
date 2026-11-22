package engine

import (
	"regexp"
	"strconv"
)

// The operations M17 added to the engine, for the Technical needs screens: technical needs and a
// design the team already has (skills/product-studio/scripts/needs.py and design.py). Each is one
// engine command with a fixed argument vector, as every other operation is. `design map` is not one
// of them: the needs conversation records a map (interview.Paths); no person's button does.

// The engine's own patterns for these commands' identifiers.
var (
	// issue_rules.NEED_ID_RE.
	NeedIDPattern = regexp.MustCompile(`^TN-[0-9]{2,}$`)
	// design.DES_RE.
	DesignIDPattern = regexp.MustCompile(`^DES-[0-9]{2,}$`)
	// issue_rules.SAID_ON_RE: a date such as 2026-11-21 (the engine also refuses one in the future).
	saidOnPattern = regexp.MustCompile(`^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$`)
)

// issue_rules.NEED_KINDS, in the engine's order.
var NeedKinds = []string{"people", "data", "connections", "never", "priority", "given"}

const (
	maxNeedStatement   = 400 // issue_rules.NEED_LIMITS["statement"]
	maxNeedWhy         = 300 // issue_rules.NEED_LIMITS["why"]
	maxNeedSaidBy      = 100 // issue_rules.SAID_BY_LIMIT
	maxDesignReason    = 300 // design.REASON_CHARS
	maxDesignBy        = 80  // design.BY_CHARS
	maxDesignConflicts = 40  // design.MAX_CONFLICTS
)

// NeedsTarget is implemented by every operation that changes the technical needs or a brought-in
// design, so the server can refuse it while the needs conversation is writing (WritesNeeds).
type NeedsTarget interface {
	needsTarget()
}

type needsAct struct{}

func (needsAct) needsTarget() {}

func checkKind(kind string) error {
	for _, k := range NeedKinds {
		if kind == k {
			return nil
		}
	}
	if kind == "" {
		return invalid("kind is required.")
	}
	return invalid("kind must be one of people, data, connections, never, priority or given.")
}

func checkSaid(saidBy, saidOn *string) error {
	if saidBy != nil {
		if err := checkOneLine("said_by", *saidBy, maxNeedSaidBy, true); err != nil {
			return err
		}
	}
	if saidOn != nil && !saidOnPattern.MatchString(*saidOn) {
		return invalid("said_on must be a date such as 2026-11-21.")
	}
	return nil
}

// ---- technical needs (M17 part A) ----

type needListArgs struct{ NoArgs }

func (needListArgs) Argv() ([]string, error) { return []string{"need", "list"}, nil }

// NeedListArgs is the arguments of need list, for starting the needs conversation.
func NeedListArgs() Args { return &needListArgs{} }

type needPublishArgs struct {
	NoArgs
	needsAct
}

func (needPublishArgs) Argv() ([]string, error) { return []string{"need", "publish"}, nil }

// NeedAddArgs: a need of one kind in the product manager's words. Only a given says who decided it
// and when, and a given must; the engine checks the statement for technology words.
type NeedAddArgs struct {
	Kind      string  `json:"kind"`
	Statement string  `json:"statement"`
	Why       string  `json:"why"`
	SaidBy    *string `json:"said_by"`
	SaidOn    *string `json:"said_on"`
	needsAct
}

func (a *NeedAddArgs) Argv() ([]string, error) {
	if err := checkKind(a.Kind); err != nil {
		return nil, err
	}
	if err := checkOneLine("statement", a.Statement, maxNeedStatement, true); err != nil {
		return nil, err
	}
	if err := checkOneLine("why", a.Why, maxNeedWhy, true); err != nil {
		return nil, err
	}
	if a.Kind == "given" {
		if a.SaidBy == nil || a.SaidOn == nil {
			return nil, invalid("A given says who decided it and when: give said_by and said_on.")
		}
	} else if a.SaidBy != nil || a.SaidOn != nil {
		return nil, invalid("Only a given says who decided it and when.")
	}
	if err := checkSaid(a.SaidBy, a.SaidOn); err != nil {
		return nil, err
	}
	argv := []string{"need", "add", flag("kind", a.Kind), flag("statement", a.Statement), flag("why", a.Why)}
	argv = append(argv, optional("said-by", a.SaidBy)...)
	return append(argv, optional("said-on", a.SaidOn)...), nil
}

// NeedSetArgs: change a need. A changed statement is the need's next revision (the engine counts it).
type NeedSetArgs struct {
	NeedID    string  `json:"need_id"`
	Statement *string `json:"statement"`
	Why       *string `json:"why"`
	SaidBy    *string `json:"said_by"`
	SaidOn    *string `json:"said_on"`
	needsAct
}

func (a *NeedSetArgs) Argv() ([]string, error) {
	if err := checkID("need_id", a.NeedID, NeedIDPattern, "TN-01"); err != nil {
		return nil, err
	}
	if a.Statement != nil {
		if err := checkOneLine("statement", *a.Statement, maxNeedStatement, true); err != nil {
			return nil, err
		}
	}
	if a.Why != nil {
		if err := checkOneLine("why", *a.Why, maxNeedWhy, true); err != nil {
			return nil, err
		}
	}
	if err := checkSaid(a.SaidBy, a.SaidOn); err != nil {
		return nil, err
	}
	if a.Statement == nil && a.Why == nil && a.SaidBy == nil && a.SaidOn == nil {
		return nil, invalid("Give at least one of statement, why, said_by or said_on.")
	}
	argv := []string{"need", "set", a.NeedID}
	argv = append(argv, optional("statement", a.Statement)...)
	argv = append(argv, optional("why", a.Why)...)
	argv = append(argv, optional("said-by", a.SaidBy)...)
	return append(argv, optional("said-on", a.SaidOn)...), nil
}

// NeedRetireArgs: retire a need; it is never brought back.
type NeedRetireArgs struct {
	NeedID string `json:"need_id"`
	needsAct
}

func (a *NeedRetireArgs) Argv() ([]string, error) {
	if err := checkID("need_id", a.NeedID, NeedIDPattern, "TN-01"); err != nil {
		return nil, err
	}
	return []string{"need", "retire", a.NeedID}, nil
}

// NeedNoneArgs: "nothing to say" about one kind, so the conversation does not ask about it again.
type NeedNoneArgs struct {
	Kind string `json:"kind"`
	needsAct
}

func (a *NeedNoneArgs) Argv() ([]string, error) {
	if err := checkKind(a.Kind); err != nil {
		return nil, err
	}
	return []string{"need", "none", flag("kind", a.Kind)}, nil
}

// ReconcileNeedsArgs: another product manager published newer needs; keep mine or take theirs, whole.
type ReconcileNeedsArgs struct {
	Take string `json:"take"`
	needsAct
}

func (a *ReconcileNeedsArgs) Argv() ([]string, error) {
	if a.Take != "mine" && a.Take != "theirs" {
		return nil, invalid("take must be \"mine\" or \"theirs\".")
	}
	return []string{"reconcile", "needs", flag("take", a.Take)}, nil
}

// ---- a design you already have (M17 part B) ----

type designListArgs struct{ NoArgs }

func (designListArgs) Argv() ([]string, error) { return []string{"design", "list"}, nil }

// DesignImportArgs: one Markdown or plain-text document, sent from the browser as the PRD on-ramp's
// is (Upload, staged for the one call). The engine bounds and checks the content (prd.Imported).
type DesignImportArgs struct {
	File *Upload `json:"file"`
	stagedPath
	needsAct
}

func (a *DesignImportArgs) Staged() (string, []byte, error) {
	return decodeUpload("file", a.File, prdDocument)
}

func (a *DesignImportArgs) Argv() ([]string, error) {
	path, err := a.staged()
	if err != nil {
		return nil, err
	}
	return []string{"design", "import", path}, nil
}

// DesignShowArgs: the design's text, numbered, redacted and fenced, with its topics and map.
type DesignShowArgs struct {
	DesignID string  `json:"design_id"`
	Lines    *string `json:"lines"`
}

func (a *DesignShowArgs) Argv() ([]string, error) {
	if err := checkID("design_id", a.DesignID, DesignIDPattern, "DES-01"); err != nil {
		return nil, err
	}
	argv := []string{"design", "show", a.DesignID}
	if a.Lines != nil {
		if !lineRangePattern.MatchString(*a.Lines) {
			return nil, invalid("lines must be a line or a range such as 40-80.")
		}
		argv = append(argv, flag("lines", *a.Lines))
	}
	return argv, nil
}

// DesignSettleArgs: the product manager's word on one conflict, with their reason. Never a model's.
type DesignSettleArgs struct {
	DesignID string  `json:"design_id"`
	Conflict int     `json:"conflict"`
	As       string  `json:"as"`
	Reason   string  `json:"reason"`
	By       *string `json:"by"`
	needsAct
}

func (a *DesignSettleArgs) Argv() ([]string, error) {
	if err := checkID("design_id", a.DesignID, DesignIDPattern, "DES-01"); err != nil {
		return nil, err
	}
	if a.Conflict < 1 || a.Conflict > maxDesignConflicts {
		return nil, invalid("conflict must be the conflict's number in the map, such as 1.")
	}
	switch a.As {
	case "stands", "design-is-wrong", "ask-engineer":
	default:
		return nil, invalid("as must be \"stands\", \"design-is-wrong\" or \"ask-engineer\".")
	}
	if err := checkOneLine("reason", a.Reason, maxDesignReason, true); err != nil {
		return nil, err
	}
	if a.By != nil {
		if err := checkOneLine("by", *a.By, maxDesignBy, true); err != nil {
			return nil, err
		}
	}
	argv := []string{"design", "settle", a.DesignID, flag("conflict", strconv.Itoa(a.Conflict)), flag("as", a.As), flag("reason", a.Reason)}
	return append(argv, optional("by", a.By)...), nil
}

// DesignPublishArgs: product/ready/DESIGN/DES-NN/ for the product manager to commit.
type DesignPublishArgs struct {
	DesignID string `json:"design_id"`
	needsAct
}

func (a *DesignPublishArgs) Argv() ([]string, error) {
	if err := checkID("design_id", a.DesignID, DesignIDPattern, "DES-01"); err != nil {
		return nil, err
	}
	return []string{"design", "publish", a.DesignID}, nil
}

// WritesNeeds says whether an operation changes the technical needs or a brought-in design: the
// server refuses it while the needs conversation's turn is running. False for a read, any other
// operation, or a body that does not decode (Do refuses that one itself).
func WritesNeeds(name string, body []byte) bool {
	op, ok := Lookup(name)
	if !ok || op.ReadOnly {
		return false
	}
	args := op.New()
	if _, ok := args.(NeedsTarget); !ok {
		return false
	}
	return Decode(body, args) == nil
}

func init() {
	register(Operation{Name: "need.list", New: func() Args { return &needListArgs{} }, ReadOnly: true})
	register(Operation{Name: "need.add", New: func() Args { return &NeedAddArgs{} }})
	register(Operation{Name: "need.set", New: func() Args { return &NeedSetArgs{} }})
	register(Operation{Name: "need.retire", New: func() Args { return &NeedRetireArgs{} }})
	register(Operation{Name: "need.none", New: func() Args { return &NeedNoneArgs{} }})
	register(Operation{Name: "need.publish", New: func() Args { return &needPublishArgs{} }, Network: true})
	register(Operation{Name: "reconcile.needs", New: func() Args { return &ReconcileNeedsArgs{} }, Network: true})
	register(Operation{Name: "design.list", New: func() Args { return &designListArgs{} }, ReadOnly: true})
	register(Operation{Name: "design.import", New: func() Args { return &DesignImportArgs{} }, MaxBody: bodyFor(prdDocument.maxBytes)})
	register(Operation{Name: "design.show", New: func() Args { return &DesignShowArgs{} }, ReadOnly: true})
	register(Operation{Name: "design.settle", New: func() Args { return &DesignSettleArgs{} }})
	register(Operation{Name: "design.publish", New: func() Args { return &DesignPublishArgs{} }})
}
