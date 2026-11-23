package engine

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// The operations M13 and M14 added to the engine, for the M15 screens: product principles, policy
// packs, how an epic works today, Jira keys and the export, the PRD on-ramp, and design mocks.
// Each is one engine command with a fixed argument vector, as every other operation is.

// The engine's own patterns for these commands' identifiers.
var (
	// studio.py principles: PP-NN.
	PrincipleIDPattern = regexp.MustCompile(`^PP-[0-9]{2,}$`)
	// policies.STATEMENT_ID_RE: POL-<pack>-NN.
	PolicyStatementPattern = regexp.MustCompile(`^POL-[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-[0-9]{2,}$`)
	// issue_rules.JIRA_KEY_RE.
	JiraKeyPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,31}-[1-9][0-9]{0,8}$`)
	// prd.PRD_RE, MAP_KEY_RE, RANGE_RE.
	PRDIDPattern     = regexp.MustCompile(`^PRD-[0-9]{2,}$`)
	MapKeyPattern    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]{0,31}$`)
	lineRangePattern = regexp.MustCompile(`^[0-9]{1,6}(?:-[0-9]{1,6})?$`)
	// issue_rules.SCENARIO_ID_RE.
	ScenarioIDPattern = regexp.MustCompile(`^AC-[0-9]{2,}$`)
	// The start of a mock's SHA-256, as `slice mock list` shows it.
	mockHashPattern = regexp.MustCompile(`^[0-9a-f]{8,64}$`)
)

const (
	maxJiraKeyLength   = 42  // issue_rules.JIRA_KEY_LIMIT
	maxPolicyIDLength  = 80  // a pack's name is words; the statement ID is short
	maxMockNote        = 200 // issue_rules.MOCK_NOTE_LIMIT
	maxPrincipleText   = 1000
	maxOwnerWordsShort = 300
)

// ---- product principles (M13 part A) ----

type principleListArgs struct{ NoArgs }

func (principleListArgs) Argv() ([]string, error) { return []string{"principle", "list"}, nil }

type principlePublishArgs struct{ NoArgs }

func (principlePublishArgs) Argv() ([]string, error) { return []string{"principle", "publish"}, nil }

// PrincipleAddArgs: one sentence with an uppercase MUST, MUST NOT, SHALL, SHALL NOT or REQUIRED,
// a title and a reason. The engine checks the wording.
type PrincipleAddArgs struct {
	Title     string `json:"title"`
	Statement string `json:"statement"`
	Reason    string `json:"reason"`
}

func (a *PrincipleAddArgs) Argv() ([]string, error) {
	if err := checkOneLine("title", a.Title, maxShortText, true); err != nil {
		return nil, err
	}
	if err := checkOneLine("statement", a.Statement, maxPrincipleText, true); err != nil {
		return nil, err
	}
	if err := checkOneLine("reason", a.Reason, maxPrincipleText, true); err != nil {
		return nil, err
	}
	return []string{"principle", "add", flag("title", a.Title), flag("statement", a.Statement), flag("reason", a.Reason)}, nil
}

type PrincipleSetArgs struct {
	PrincipleID string  `json:"principle_id"`
	Title       *string `json:"title"`
	Statement   *string `json:"statement"`
	Reason      *string `json:"reason"`
}

func (a *PrincipleSetArgs) Argv() ([]string, error) {
	if err := checkID("principle_id", a.PrincipleID, PrincipleIDPattern, "PP-01"); err != nil {
		return nil, err
	}
	for _, field := range []struct {
		name  string
		value *string
		max   int
	}{{"title", a.Title, maxShortText}, {"statement", a.Statement, maxPrincipleText}, {"reason", a.Reason, maxPrincipleText}} {
		if field.value != nil {
			if err := checkOneLine(field.name, *field.value, field.max, true); err != nil {
				return nil, err
			}
		}
	}
	if a.Title == nil && a.Statement == nil && a.Reason == nil {
		return nil, invalid("Give at least one of title, statement or reason.")
	}
	argv := []string{"principle", "set", a.PrincipleID}
	argv = append(argv, optional("title", a.Title)...)
	argv = append(argv, optional("statement", a.Statement)...)
	return append(argv, optional("reason", a.Reason)...), nil
}

type PrincipleIDArgs struct {
	PrincipleID string `json:"principle_id"`
	verb        string
}

func (a *PrincipleIDArgs) Argv() ([]string, error) {
	if err := checkID("principle_id", a.PrincipleID, PrincipleIDPattern, "PP-01"); err != nil {
		return nil, err
	}
	return []string{"principle", a.verb, a.PrincipleID}, nil
}

// ReconcilePrinciplesArgs: another product manager published newer principles; keep mine or take theirs, whole.
type ReconcilePrinciplesArgs struct {
	Take string `json:"take"`
}

func (a *ReconcilePrinciplesArgs) Argv() ([]string, error) {
	if a.Take != "mine" && a.Take != "theirs" {
		return nil, invalid("take must be \"mine\" or \"theirs\".")
	}
	return []string{"reconcile", "principles", flag("take", a.Take)}, nil
}

// ---- policy packs (M14 part A) ----

type policyListArgs struct{ NoArgs }

func (policyListArgs) Argv() ([]string, error) { return []string{"policy", "list"}, nil }

// PolicyAcceptArgs: a policy owner accepts one open concern in a slice's spec, in their own words.
type PolicyAcceptArgs struct {
	SliceID  string `json:"slice_id"`
	PolicyID string `json:"policy_id"`
	By       string `json:"by"`
	Reason   string `json:"reason"`
}

func (a *PolicyAcceptArgs) Argv() ([]string, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	if a.PolicyID == "" {
		return nil, invalid("policy_id is required.")
	}
	if len(a.PolicyID) > maxPolicyIDLength || !PolicyStatementPattern.MatchString(a.PolicyID) {
		return nil, invalid("policy_id must be a statement ID such as POL-privacy-02.")
	}
	if err := checkOneLine("by", a.By, maxOwnerWordsShort, true); err != nil {
		return nil, err
	}
	if err := checkText("reason", a.Reason, maxLongText, true); err != nil {
		return nil, err
	}
	return []string{"policy", "accept", a.SliceID, a.PolicyID, flag("by", a.By), flag("reason", a.Reason)}, nil
}

// ---- how an epic works today (M13 part C) ----

// EpicCurrentArgs: the epic by its ID or its issue number, exactly one. Always `--json`.
type EpicCurrentArgs struct {
	EpicID *string `json:"epic_id"`
	Issue  *int    `json:"issue"`
}

func (a *EpicCurrentArgs) Argv() ([]string, error) {
	switch {
	case a.EpicID != nil && a.Issue == nil:
		if err := checkID("epic_id", *a.EpicID, EpicIDPattern, "EPIC-001"); err != nil {
			return nil, err
		}
		return []string{"epic", "current", *a.EpicID, "--json"}, nil
	case a.Issue != nil && a.EpicID == nil:
		if err := checkRequestNumber(*a.Issue); err != nil {
			return nil, invalid("issue must be an issue number such as 12.")
		}
		return []string{"epic", "current", strconv.Itoa(*a.Issue), "--json"}, nil
	}
	return nil, invalid("Give exactly one of epic_id or issue.")
}

// ---- Jira keys (M13 part E) ----

// EpicLinkArgs and SliceLinkArgs serve epic link and slice link: a key in Jira's form, or
// remove: true, exactly one.
type EpicLinkArgs struct {
	EpicID string  `json:"epic_id"`
	Jira   *string `json:"jira"`
	Remove bool    `json:"remove"`
}

func (a *EpicLinkArgs) Argv() ([]string, error) {
	if err := checkID("epic_id", a.EpicID, EpicIDPattern, "EPIC-001"); err != nil {
		return nil, err
	}
	return linkArgv("epic", a.EpicID, a.Jira, a.Remove)
}

type SliceLinkArgs struct {
	SliceID string  `json:"slice_id"`
	Jira    *string `json:"jira"`
	Remove  bool    `json:"remove"`
}

func (a *SliceLinkArgs) Argv() ([]string, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	return linkArgv("slice", a.SliceID, a.Jira, a.Remove)
}

func linkArgv(kind, target string, jira *string, remove bool) ([]string, error) {
	switch {
	case jira != nil && !remove:
		if len(*jira) > maxJiraKeyLength || !JiraKeyPattern.MatchString(*jira) {
			return nil, invalid("jira must be a Jira issue key such as ABC-123.")
		}
		return []string{kind, "link", target, flag("jira", *jira)}, nil
	case jira == nil && remove:
		return []string{kind, "link", target, "--no-jira"}, nil
	}
	return nil, invalid("Give exactly one of jira or remove.")
}

// JiraExportArgs: what to export. The host never passes --out: the engine writes into its own
// folder inside the Studio workspace, and the host serves those files for download.
type JiraExportArgs struct {
	Epic    *string `json:"epic"`
	State   *string `json:"state"`
	Flavour *string `json:"flavour"`
}

func (a *JiraExportArgs) Argv() ([]string, error) {
	if err := checkOptionalID("epic", a.Epic, EpicIDPattern, "EPIC-001"); err != nil {
		return nil, err
	}
	if a.State != nil && *a.State != "ready" && *a.State != "all" {
		return nil, invalid("state must be \"ready\" or \"all\".")
	}
	if a.Flavour != nil && *a.Flavour != "cloud" && *a.Flavour != "data-center" {
		return nil, invalid("flavour must be \"cloud\" or \"data-center\".")
	}
	argv := []string{"jira", "export"}
	argv = append(argv, optional("epic", a.Epic)...)
	argv = append(argv, optional("state", a.State)...)
	return append(argv, optional("flavour", a.Flavour)...), nil
}

// JiraKeysArgs: the CSV a person exported from Jira after the import.
type JiraKeysArgs struct {
	File   *Upload `json:"file"`
	DryRun bool    `json:"dry_run"`
	stagedPath
}

func (a *JiraKeysArgs) Staged() (string, []byte, error) {
	return decodeUpload("file", a.File, jiraKeysFile)
}

func (a *JiraKeysArgs) Argv() ([]string, error) {
	path, err := a.staged()
	if err != nil {
		return nil, err
	}
	argv := []string{"jira", "keys", path}
	if a.DryRun {
		argv = append(argv, "--dry-run")
	}
	return argv, nil
}

// ---- the PRD on-ramp (M13 part D) ----

type prdListArgs struct{ NoArgs }

func (prdListArgs) Argv() ([]string, error) { return []string{"prd", "list"}, nil }

// PRDImportArgs: one Markdown or plain-text document.
type PRDImportArgs struct {
	File *Upload `json:"file"`
	stagedPath
}

func (a *PRDImportArgs) Staged() (string, []byte, error) {
	return decodeUpload("file", a.File, prdDocument)
}

func (a *PRDImportArgs) Argv() ([]string, error) {
	path, err := a.staged()
	if err != nil {
		return nil, err
	}
	return []string{"prd", "import", path}, nil
}

// PRDTarget is implemented by the PRD operations that change one PRD's map, its settlements or what
// is made from it (M19), so the server can refuse such an act while the PRD conversation is
// recording that PRD's map, as it does for an idea (ShapeTarget).
type PRDTarget interface {
	PRDTarget() string
}

// WritesPRD names the PRD an operation that changes something acts on, or "" for any other
// operation, a read, or a body that does not decode (Do refuses that one itself).
func WritesPRD(name string, body []byte) string {
	op, ok := Lookup(name)
	if !ok || op.ReadOnly {
		return ""
	}
	args := op.New()
	target, ok := args.(PRDTarget)
	if !ok || Decode(body, args) != nil || !PRDIDPattern.MatchString(target.PRDTarget()) {
		return ""
	}
	return target.PRDTarget()
}

// PRDStatus is the arguments of prd.status, for the PRD conversation's start route (M19).
func PRDStatus(prdID string) Args { return &PRDIDArgs{PRDID: prdID, verb: "status"} }

// PRDIDArgs serves prd status and prd apply.
type PRDIDArgs struct {
	PRDID string `json:"prd_id"`
	verb  string
}

func (a *PRDIDArgs) PRDTarget() string { return a.PRDID }

func (a *PRDIDArgs) Argv() ([]string, error) {
	if err := checkID("prd_id", a.PRDID, PRDIDPattern, "PRD-01"); err != nil {
		return nil, err
	}
	return []string{"prd", a.verb, a.PRDID}, nil
}

type PRDShowArgs struct {
	PRDID string  `json:"prd_id"`
	Lines *string `json:"lines"`
}

func (a *PRDShowArgs) Argv() ([]string, error) {
	if err := checkID("prd_id", a.PRDID, PRDIDPattern, "PRD-01"); err != nil {
		return nil, err
	}
	argv := []string{"prd", "show", a.PRDID}
	if a.Lines != nil {
		if !lineRangePattern.MatchString(*a.Lines) {
			return nil, invalid("lines must be a line or a range such as 40-80.")
		}
		argv = append(argv, flag("lines", *a.Lines))
	}
	return argv, nil
}

// PRDMapArgs: the proposed map, as the JSON object `prd map --from` reads.
type PRDMapArgs struct {
	PRDID string          `json:"prd_id"`
	Map   json.RawMessage `json:"map"`
	stagedPath
}

func (a *PRDMapArgs) PRDTarget() string { return a.PRDID }

func (a *PRDMapArgs) Staged() (string, []byte, error) {
	if err := checkID("prd_id", a.PRDID, PRDIDPattern, "PRD-01"); err != nil {
		return "", nil, err
	}
	data, err := decodeJSONInput("map", a.Map)
	return "map.json", data, err
}

func (a *PRDMapArgs) Argv() ([]string, error) {
	if err := checkID("prd_id", a.PRDID, PRDIDPattern, "PRD-01"); err != nil {
		return nil, err
	}
	path, err := a.staged()
	if err != nil {
		return nil, err
	}
	return []string{"prd", "map", a.PRDID, flag("from", path)}, nil
}

// PRDSettleArgs: the product manager's word on a section no slice cites. `as` is "slice" (with
// the map slice's key in `slice`), "out-of-scope" or "later".
type PRDSettleArgs struct {
	PRDID   string  `json:"prd_id"`
	Section int     `json:"section"`
	As      string  `json:"as"`
	Slice   *string `json:"slice"`
	Reason  *string `json:"reason"`
}

func (a *PRDSettleArgs) PRDTarget() string { return a.PRDID }

func (a *PRDSettleArgs) Argv() ([]string, error) {
	if err := checkID("prd_id", a.PRDID, PRDIDPattern, "PRD-01"); err != nil {
		return nil, err
	}
	if a.Section < 1 || a.Section > 100000 {
		return nil, invalid("section must be a section number such as 3.")
	}
	var how string
	switch a.As {
	case "slice":
		if a.Slice == nil || !MapKeyPattern.MatchString(*a.Slice) {
			return nil, invalid("slice must be the map slice's key, such as M2.")
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
		if err := checkOneLine("reason", *a.Reason, maxShortText, true); err != nil {
			return nil, err
		}
	}
	argv := []string{"prd", "settle", a.PRDID, flag("section", strconv.Itoa(a.Section)), flag("as", how)}
	return append(argv, optional("reason", a.Reason)...), nil
}

// PRDDraftArgs: answers drafted from a slice's cited PRD lines, as the JSON `prd draft --from` reads.
type PRDDraftArgs struct {
	SliceID string          `json:"slice_id"`
	Answers json.RawMessage `json:"answers"`
	stagedPath
}

func (a *PRDDraftArgs) Staged() (string, []byte, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return "", nil, err
	}
	data, err := decodeJSONInput("answers", a.Answers)
	return "answers.json", data, err
}

func (a *PRDDraftArgs) Argv() ([]string, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	path, err := a.staged()
	if err != nil {
		return nil, err
	}
	return []string{"prd", "draft", a.SliceID, flag("from", path)}, nil
}

// PRDConfirmArgs: which drafted answers the product manager accepts ("all" or numbers) and which to
// discuss. At least one of the two.
type PRDConfirmArgs struct {
	SliceID string          `json:"slice_id"`
	Accept  json.RawMessage `json:"accept"`
	Discuss []int           `json:"discuss"`
}

func (a *PRDConfirmArgs) Argv() ([]string, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	argv := []string{"prd", "confirm", a.SliceID}
	given := false
	if raw := strings.TrimSpace(string(a.Accept)); raw != "" && raw != "null" {
		var all string
		var numbers []int
		switch {
		case json.Unmarshal(a.Accept, &all) == nil:
			if all != "all" {
				return nil, invalid("accept must be \"all\" or a list of answer numbers.")
			}
			argv = append(argv, flag("accept", "all"))
		case json.Unmarshal(a.Accept, &numbers) == nil:
			list, err := numberList("accept", numbers)
			if err != nil {
				return nil, err
			}
			argv = append(argv, flag("accept", list))
		default:
			return nil, invalid("accept must be \"all\" or a list of answer numbers.")
		}
		given = true
	}
	if a.Discuss != nil {
		list, err := numberList("discuss", a.Discuss)
		if err != nil {
			return nil, err
		}
		argv = append(argv, flag("discuss", list))
		given = true
	}
	if !given {
		return nil, invalid("Give accept, discuss or both.")
	}
	return argv, nil
}

func numberList(field string, numbers []int) (string, error) {
	if len(numbers) == 0 || len(numbers) > 80 { // prd.py: at most 80 drafted answers per slice
		return "", invalid("%s must list between 1 and 80 answer numbers.", field)
	}
	words := make([]string, 0, len(numbers))
	for _, n := range numbers {
		if n < 1 || n > 999 {
			return "", invalid("%s must list answer numbers such as 1 and 3.", field)
		}
		words = append(words, strconv.Itoa(n))
	}
	return strings.Join(words, ","), nil
}

// ---- design mocks (M14 part C) ----

// MockAddArgs: a PNG or JPEG picture for a slice, for one scenario or the slice as a whole.
type MockAddArgs struct {
	SliceID string  `json:"slice_id"`
	File    *Upload `json:"file"`
	For     *string `json:"for"`
	Binding bool    `json:"binding"`
	Note    *string `json:"note"`
	stagedPath
}

func (a *MockAddArgs) check() error {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return err
	}
	if err := checkOptionalID("for", a.For, ScenarioIDPattern, "AC-01"); err != nil {
		return err
	}
	if a.Binding && a.For == nil {
		return invalid("A binding mock is binding for one scenario: give for, such as AC-01.")
	}
	if a.Note != nil {
		if err := checkOneLine("note", *a.Note, maxMockNote, true); err != nil {
			return err
		}
	}
	return nil
}

func (a *MockAddArgs) Staged() (string, []byte, error) {
	if err := a.check(); err != nil {
		return "", nil, err
	}
	return decodeUpload("file", a.File, mockPicture)
}

func (a *MockAddArgs) Argv() ([]string, error) {
	if err := a.check(); err != nil {
		return nil, err
	}
	path, err := a.staged()
	if err != nil {
		return nil, err
	}
	argv := []string{"slice", "mock", "add", a.SliceID, path}
	argv = append(argv, optional("for", a.For)...)
	if a.Binding {
		argv = append(argv, "--binding")
	}
	return append(argv, optional("note", a.Note)...), nil
}

type MockRemoveArgs struct {
	SliceID string `json:"slice_id"`
	Mock    string `json:"mock"`
}

func (a *MockRemoveArgs) Argv() ([]string, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	if !mockHashPattern.MatchString(a.Mock) {
		return nil, invalid("mock must be the start of the picture's SHA-256, at least 8 characters.")
	}
	return []string{"slice", "mock", "remove", a.SliceID, a.Mock}, nil
}

type MockListArgs struct {
	SliceID string `json:"slice_id"`
}

func (a *MockListArgs) Argv() ([]string, error) {
	if err := checkID("slice_id", a.SliceID, SliceIDPattern, "SLICE-001"); err != nil {
		return nil, err
	}
	return []string{"slice", "mock", "list", a.SliceID}, nil
}

// checkOneLine is checkText without newlines or tabs: the engine keeps these values on one line.
func checkOneLine(field, value string, max int, required bool) error {
	if err := checkText(field, value, max, required); err != nil {
		return err
	}
	if strings.ContainsAny(value, "\n\t") {
		return invalid("%s must be one line.", field)
	}
	return nil
}

func init() {
	register(Operation{Name: "principle.list", New: func() Args { return &principleListArgs{} }})
	register(Operation{Name: "principle.add", New: func() Args { return &PrincipleAddArgs{} }})
	register(Operation{Name: "principle.set", New: func() Args { return &PrincipleSetArgs{} }})
	register(Operation{Name: "principle.retire", New: func() Args { return &PrincipleIDArgs{verb: "retire"} }})
	register(Operation{Name: "principle.publish", New: func() Args { return &principlePublishArgs{} }, Network: true})
	register(Operation{Name: "reconcile.principles", New: func() Args { return &ReconcilePrinciplesArgs{} }, Network: true})
	register(Operation{Name: "policy.list", New: func() Args { return &policyListArgs{} }, ReadOnly: true})
	register(Operation{Name: "policy.accept", New: func() Args { return &PolicyAcceptArgs{} }})
	register(Operation{Name: "epic.current", New: func() Args { return &EpicCurrentArgs{} }, ReadOnly: true})
	register(Operation{Name: "epic.link", New: func() Args { return &EpicLinkArgs{} }})
	register(Operation{Name: "slice.link", New: func() Args { return &SliceLinkArgs{} }})
	register(Operation{Name: "jira.export", New: func() Args { return &JiraExportArgs{} }, Download: true})
	register(Operation{Name: "jira.keys", New: func() Args { return &JiraKeysArgs{} }, MaxBody: bodyFor(jiraKeysFile.maxBytes)})
	register(Operation{Name: "prd.import", New: func() Args { return &PRDImportArgs{} }, MaxBody: bodyFor(prdDocument.maxBytes)})
	register(Operation{Name: "prd.list", New: func() Args { return &prdListArgs{} }, ReadOnly: true})
	register(Operation{Name: "prd.show", New: func() Args { return &PRDShowArgs{} }, ReadOnly: true})
	register(Operation{Name: "prd.map", New: func() Args { return &PRDMapArgs{} }, MaxBody: maxJSONInput + 64<<10})
	register(Operation{Name: "prd.settle", New: func() Args { return &PRDSettleArgs{} }})
	register(Operation{Name: "prd.status", New: func() Args { return &PRDIDArgs{verb: "status"} }, ReadOnly: true})
	register(Operation{Name: "prd.apply", New: func() Args { return &PRDIDArgs{verb: "apply"} }})
	register(Operation{Name: "prd.draft", New: func() Args { return &PRDDraftArgs{} }, MaxBody: maxJSONInput + 64<<10})
	register(Operation{Name: "prd.confirm", New: func() Args { return &PRDConfirmArgs{} }})
	register(Operation{Name: "slice.mock.add", New: func() Args { return &MockAddArgs{} }, MaxBody: bodyFor(mockPicture.maxBytes)})
	register(Operation{Name: "slice.mock.remove", New: func() Args { return &MockRemoveArgs{} }})
	register(Operation{Name: "slice.mock.list", New: func() Args { return &MockListArgs{} }, ReadOnly: true})
}
