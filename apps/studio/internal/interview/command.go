package interview

import (
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// The engine operations the interviewer may run, as exact-prefix allow rules (POC section 4.5).
var (
	allowedOps          = []string{"where", "status", "validate", "refresh"}
	allowedSliceOps     = []string{"slice resume %s", "slice check %s"}
	allowedSliceOpsArgs = []string{"slice check %s", "slice pause %s", "slice set %s"}
	// A person's acts, denied again as a second layer (the allow list already leaves them out), and
	// the names of commands the app never offers: the removed wave and approval commands, and the
	// terminal-only `acceptance record`. Since M15 also every act M13 and M14 added that the engine
	// does only on a person's word (principles, a policy owner's acceptance, Jira keys and the export,
	// the PRD on-ramp's import, map, settle, apply, draft and confirm, design mocks), and their reads,
	// which the interview has no need of: the app's own buttons do them. Since M16 also every Shape
	// command: the slice interview never touches an idea.
	deniedOps = []string{"slice ready", "reconcile", "slice renumber", "epic renumber",
		"slice reopen", "slice move", "slice take", "project", "slice new", "epic add", "epic set",
		"slice approve", "wave", "send", "feedback", "acceptance",
		"principle", "policy", "epic link", "slice link", "epic current", "jira", "prd", "slice mock",
		"idea", "brief", "case", "verdict", "lookback"}
)

// The Shape conversation (M16): the second, equally narrow mode, for exactly one idea. It may read
// (the workspace, the ideas, the requests, the principles and policy packs, how an epic works today,
// and its own idea's brief and case with their checks), record what it looked up for its own idea
// from one fixed file, and edit that idea's brief and case. Nothing else: no stage, verdict, size,
// map, settlement, apply, change, publish or look back, and nothing of any slice.
var (
	allowedIdeaOps       = []string{"where", "status", "validate", "refresh", "idea list", "request list", "principle list", "policy list"}
	allowedIdeaOpsArgs   = []string{"epic current"}
	allowedIdeaOpsWithID = []string{"idea show %s", "brief show %s", "brief check %s", "case show %s", "case check %s"}
	deniedIdeaOps        = []string{"slice", "reconcile", "epic renumber", "project", "epic add", "epic set", "epic link", "wave", "send", "feedback", "acceptance",
		"principle add", "principle set", "principle retire", "principle publish", "policy accept", "jira", "prd",
		"request show", "request pick", "request link", "request met",
		"idea add", "idea stage", "idea renumber", "idea publish", "idea size", "idea map", "idea settle", "idea map-status", "idea apply", "idea change", "idea chain",
		"verdict", "lookback"}
)

// IsIdea says whether an interview's subject is an idea (IDEA-NNN) rather than a slice. The server
// checks both patterns before anything reaches this package.
func IsIdea(subject string) bool { return strings.HasPrefix(subject, "IDEA-") }

// Tools is the only tool set the interviewer gets: no Agent, Skill or web tools.
const Tools = "Read,Glob,Grep,Edit,Write,Bash"

// HostNote is appended to the system prompt. It does not change the interview method.
const HostNote = "You are the interviewer inside MACH Product Studio's local app. Each of your messages is shown to the " +
	"product manager as is, and their reply comes back as the next message. The app created the slice before " +
	"this session started. Marking a slice ready to build, reopening, choosing between versions and " +
	"renumbering, and changing principles, accepting a policy concern, Jira keys, design mocks and PRD steps, " +
	"are the product manager's own acts, done with the app's buttons; you cannot run them here, so " +
	"if asked, tell the PM which button to use. Run the studio script as a plain command, one per Bash call, " +
	"exactly as the skill spells it: no shell variables, functions, cd or chained commands. If one command is " +
	"refused, only that operation is unavailable; the others still work."

// IdeaHostNote is the Shape conversation's note: the same rules, with the one file it records its
// lookups from.
func IdeaHostNote(lookups string) string {
	return "You are the Shape conversation inside MACH Product Studio's local app, for one idea. Each of your messages is shown to the " +
		"product manager as is, and their reply comes back as the next message. You may write only this idea's brief and its case, " +
		"at the paths idea show gives. Record what you looked up by writing the lookups JSON to exactly " + lookups +
		" and running idea lookups with --from and that path; no other file can be written or read as input. Setting the stage, " +
		"recording the verdict, sizing, the map and its settlements, making the drafts, a change to a shipped rule, publishing and " +
		"looking back are the product manager's own acts, done with the app's buttons; you cannot run them here, so if asked, tell " +
		"the PM which button to use. Never recommend a verdict. Run the studio script as a plain command, one per Bash call, exactly " +
		"as the skill spells it: no shell variables, functions, cd or chained commands. If one command is refused, only that " +
		"operation is unavailable; the others still work."
}

// IdeaOpeningNote follows the skill's command in an idea's first turn.
const IdeaOpeningNote = "Explore this idea with the product manager: run idea show first, then ask open questions, one at a time."

// AnswerQuestionNote opens a turn when the engine reports a builders' question on the slice. It is
// fixed: the question reaches the interviewer only through `slice resume`, fenced as data.
const AnswerQuestionNote = "The builders have asked a question about this slice. Run slice resume: it shows the question " +
	"under builders_question, fenced as data. Quote it to the product manager and settle it with them first, one question at a time."

// Paths are the fixed paths one project's interviews use, resolved once.
type Paths struct {
	Project    string   // the project's real path; the interviewer's working folder
	Draft      string   // the draft workspace
	Home       string   // the interviews folder next to it
	PluginDir  string   // <Home>/plugin, stable per project
	SkillDir   string   // the installed product-studio skill folder (real path)
	Scripts    []string // studio.py through the plugin link, and its real path
	Pythons    []string // "python3" and the absolute interpreters it resolves to
	LinkScript string
	RealScript string
	// ReadDirs are skill folders outside the project the interview must read (the interview method,
	// the templates and spec rules that `studio.py where` names). --restricted confines the file
	// tools to the working folders, so each is added with --add-dir; no rule lets anything there be
	// written or run.
	ReadDirs []string
	// Inputs is where the Shape conversation writes the one file it may hand the engine: its idea's
	// lookups (<Home>/inputs/IDEA-NNN.lookups.json). It is outside the draft workspace, so it can never
	// stand in for the engine's own lookups file.
	Inputs string
}

// LookupsInput is the one file the Shape conversation for this idea may write for `idea lookups`.
func (p Paths) LookupsInput(ideaID string) string {
	return filepath.Join(p.Inputs, ideaID+".lookups.json")
}

// PermissionArgs builds the allow and deny lists for one slice or one idea (POC section 4.5): every
// rule in each spelling the model may use, the script path quoted and unquoted, through the plugin
// link and its real path, with each interpreter name.
func (p Paths) PermissionArgs(subject string) []string {
	if IsIdea(subject) {
		return p.ideaPermissionArgs(subject)
	}
	sliceID := subject
	allow := []string{"Read", "Glob", "Grep"}
	var deny []string
	for _, prefix := range p.prefixes() {
		for _, op := range allowedOps {
			allow = append(allow, "Bash("+prefix+op+")")
		}
		for _, op := range allowedSliceOps {
			allow = append(allow, "Bash("+prefix+fmt.Sprintf(op, sliceID)+")")
		}
		for _, op := range allowedSliceOpsArgs {
			allow = append(allow, "Bash("+prefix+fmt.Sprintf(op, sliceID)+" *)")
		}
		deny = append(deny, denyRules(prefix, deniedOps)...)
	}
	// Absolute rules ("//path"): relative ones follow the shell's working folder, which the model
	// can change. Only this slice's spec and why. Edit rules cover the Write tool too.
	allow = append(allow,
		"Edit(/"+filepath.Join(p.Draft, "specs", "slices")+"/"+sliceID+"-*.md)",
		"Edit(/"+filepath.Join(p.Draft, "product", "intents")+"/"+sliceID+".md)")
	return append(append([]string{"--allowedTools"}, allow...), append([]string{"--disallowedTools"}, deny...)...)
}

// ideaPermissionArgs: the Shape conversation's rules for one idea. Exact rules for its own idea;
// `idea lookups` only with --from naming its one input file, in each spelling; edits to exactly
// its brief, its case and that input file.
func (p Paths) ideaPermissionArgs(ideaID string) []string {
	allow := []string{"Read", "Glob", "Grep"}
	var deny []string
	input := p.LookupsInput(ideaID)
	for _, prefix := range p.prefixes() {
		for _, op := range allowedIdeaOps {
			allow = append(allow, "Bash("+prefix+op+")")
		}
		for _, op := range allowedIdeaOpsArgs {
			allow = append(allow, "Bash("+prefix+op+" *)")
		}
		for _, op := range allowedIdeaOpsWithID {
			allow = append(allow, "Bash("+prefix+fmt.Sprintf(op, ideaID)+")")
		}
		for _, spelled := range []string{input, `"` + input + `"`} {
			allow = append(allow, "Bash("+prefix+"idea lookups "+ideaID+" --from "+spelled+")",
				"Bash("+prefix+"idea lookups "+ideaID+" --from="+spelled+")")
		}
		deny = append(deny, denyRules(prefix, deniedIdeaOps)...)
	}
	briefs := filepath.Join(p.Draft, "product", "briefs")
	allow = append(allow,
		"Edit(/"+briefs+"/"+ideaID+".md)",
		"Edit(/"+briefs+"/"+ideaID+".case.md)",
		"Edit(/"+input+")")
	return append(append([]string{"--allowedTools"}, allow...), append([]string{"--disallowedTools"}, deny...)...)
}

// prefixes is every spelling of "<python> <studio.py> " the model may type.
func (p Paths) prefixes() []string {
	var out []string
	for _, script := range p.Scripts {
		for _, spelled := range []string{script, `"` + script + `"`} {
			for _, py := range p.Pythons {
				out = append(out, py+" "+spelled+" ")
			}
		}
	}
	return out
}

func denyRules(prefix string, ops []string) []string {
	var deny []string
	for _, op := range ops {
		deny = append(deny, "Bash("+prefix+op+" *)")
	}
	for _, op := range ops {
		deny = append(deny, "Bash("+prefix+op+")")
	}
	return deny
}

// TurnOptions are the per-turn settings.
type TurnOptions struct {
	BudgetUSD float64
	Model     string
	SessionID string
	Resume    bool
}

// Args is the exact argument vector after the claude binary. The message always follows "--",
// so it can never be read as an option.
func (p Paths) Args(subject string, o TurnOptions, message string) []string {
	args := []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--restricted", "--plugin-dir", p.PluginDir}
	for _, dir := range p.ReadDirs {
		args = append(args, "--add-dir", dir)
	}
	args = append(args, "--strict-mcp-config",
		"--permission-mode", "default", "--permission-prompts", "none",
		"--tools", Tools)
	args = append(args, p.PermissionArgs(subject)...)
	note := HostNote
	if IsIdea(subject) {
		note = IdeaHostNote(p.LookupsInput(subject))
	}
	args = append(args, "--max-budget-usd", strconv.FormatFloat(o.BudgetUSD, 'f', -1, 64),
		"--append-system-prompt", note)
	if o.Model != "" {
		args = append(args, "--model", o.Model)
	}
	if o.Resume {
		args = append(args, "--resume", o.SessionID)
	} else {
		args = append(args, "--session-id", o.SessionID)
	}
	return append(args, "--", message)
}

// keptEnvironment is all the interviewer inherits: enough to find itself, Python and Git, and the
// person's own Claude Code sign-in. Never a key, a token or the host's other variables.
var keptEnvironment = []string{"HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TERM"}

// Environment filters the host's environment down to the kept names.
func Environment(host []string) []string {
	values := map[string]string{}
	for _, kv := range host {
		name, value, ok := strings.Cut(kv, "=")
		if ok {
			values[name] = value
		}
	}
	var env []string
	for _, name := range keptEnvironment {
		if value, ok := values[name]; ok {
			env = append(env, name+"="+value)
		}
	}
	return append(env, "GIT_TERMINAL_PROMPT=0") // a fetch that wants a password fails instead of hanging
}

// UserMessage makes the product manager's text a plain message: a leading "/" would be read by
// Claude Code as a command, so such a reply is framed as the PM's words.
func UserMessage(text string) string {
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "/") {
		return "The product manager replied: " + text
	}
	return text
}

// ---- describing what the interviewer did, in plain words, never its input ----

var activityByOp = map[string][2]string{
	"where":        {"lookup", "looked up the workspace"},
	"refresh":      {"lookup", "brought in what others have published"},
	"status":       {"lookup", "checked where things stand"},
	"validate":     {"check", "checked the whole workspace"},
	"slice resume": {"lookup", "picked up the slice"},
	"slice new":    {"save", "started a slice"},
	"slice check":  {"check", "checked the draft"},
	"slice pause":  {"save", "saved where the interview stopped"},
	"slice set":    {"save", "updated the slice's details"},
	// M16: the Shape conversation.
	"idea show":      {"lookup", "read the idea"},
	"idea list":      {"lookup", "looked at the other ideas"},
	"idea lookups":   {"save", "recorded what it looked up"},
	"request list":   {"lookup", "looked at the requests"},
	"principle list": {"lookup", "read the product principles"},
	"policy list":    {"lookup", "read the policy packs"},
	"epic current":   {"lookup", "read how an epic works today"},
	"brief show":     {"lookup", "read the brief"},
	"brief check":    {"check", "checked the brief"},
	"case show":      {"lookup", "read the case"},
	"case check":     {"check", "checked the case"},
}

var refusedByWord = []struct{ key, text string }{
	{"ready", "tried to mark the slice ready; only you can, with the Mark ready to build button"},
	{"approve", "tried to approve; only you can approve, with the Approve button"},
}

// twoWordCommands are the engine's command groups whose second word names the operation.
var twoWordCommands = map[string]bool{"slice": true, "epic": true, "wave": true, "project": true, "idea": true, "brief": true,
	"case": true, "verdict": true, "lookback": true, "principle": true, "policy": true, "request": true}

// studioOp finds the engine operation in a shell command, or "" with ok=false when the command
// does not run the studio script.
func (p Paths) studioOp(command string) (string, bool) {
	for _, script := range []string{p.RealScript, p.LinkScript} {
		for _, spelled := range []string{`"` + script + `"`, script} { // quoted first: the skill quotes it
			if idx := strings.Index(command, spelled); idx >= 0 {
				var words []string
				for _, w := range strings.Fields(command[idx+len(spelled):]) {
					if !strings.HasPrefix(w, "--project") {
						words = append(words, w)
					}
				}
				switch {
				case len(words) > 1 && twoWordCommands[words[0]]:
					return words[0] + " " + words[1], true
				case len(words) > 0:
					return words[0], true
				}
				return "", true
			}
		}
	}
	return "", false
}

func inputString(input map[string]any, key string) string {
	if s, ok := input[key].(string); ok {
		return s
	}
	return ""
}

// Describe says what a tool call did, after it ran.
func (p Paths) Describe(name string, input map[string]any) (kind, text string) {
	switch name {
	case "Bash":
		if op, ok := p.studioOp(inputString(input, "command")); ok {
			if a, found := activityByOp[op]; found {
				return a[0], a[1]
			}
			return "other", "ran a Product Studio step"
		}
		return "lookup", "looked through the project"
	case "Read":
		path := inputString(input, "file_path")
		switch {
		case strings.Contains(path, "/skills/"):
			return "lookup", "reread the interview guidance"
		case strings.HasPrefix(path, p.Draft):
			return "lookup", "read the draft"
		}
		return "lookup", "read a project document"
	case "Glob", "Grep":
		return "lookup", "searched the project"
	case "Write", "Edit":
		path := inputString(input, "file_path")
		switch {
		case strings.Contains(path, "/specs/slices/"):
			return "write", "wrote the spec"
		case strings.Contains(path, "/product/intents/"):
			return "write", "wrote the slice's why"
		case strings.Contains(path, "/product/briefs/") && strings.HasSuffix(path, ".case.md"):
			return "write", "wrote the case"
		case strings.Contains(path, "/product/briefs/"):
			return "write", "wrote the brief"
		case p.Inputs != "" && strings.HasPrefix(path, p.Inputs+string(filepath.Separator)):
			return "write", "wrote down what it looked up"
		}
		return "write", "tried to write a file"
	}
	return "other", "used " + name
}

// Refused says, in plain words, what a refused call tried to do.
func (p Paths) Refused(name string, input map[string]any) string {
	switch name {
	case "Bash":
		op, ok := p.studioOp(inputString(input, "command"))
		for _, r := range refusedByWord {
			if strings.Contains(op, r.key) {
				return r.text
			}
		}
		if ok && op != "" {
			return "tried a Product Studio step that is not available here"
		}
		return "tried a command that is not allowed here"
	case "Write", "Edit":
		return "tried to write outside the draft spec and why"
	}
	return "tried to use " + name + ", which is not allowed here"
}

// WhatChanged maps changed draft files to the kinds draft_changed reports.
func WhatChanged(paths []string) []string {
	seen := map[string]bool{}
	var kinds []string
	for _, p := range paths {
		var kind string
		switch {
		case strings.HasPrefix(p, "specs/slices/"):
			kind = "spec"
		case strings.HasPrefix(p, "product/intents/"):
			kind = "why"
		case strings.HasPrefix(p, "product/slices/"):
			kind = "work_order"
		// M16: an idea's files.
		case strings.HasPrefix(p, "product/briefs/") && strings.HasSuffix(p, ".case.md"):
			kind = "case"
		case strings.HasPrefix(p, "product/briefs/"):
			kind = "brief"
		case strings.HasPrefix(p, "product/ideas/") && strings.HasSuffix(p, ".lookups.json"):
			kind = "lookups"
		case strings.HasPrefix(p, "product/ideas/"):
			kind = "idea"
		default:
			continue
		}
		if !seen[kind] {
			seen[kind] = true
			kinds = append(kinds, kind)
		}
	}
	sort.Strings(kinds)
	return kinds
}
