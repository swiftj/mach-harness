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
	// A person's acts, denied again as a second layer (the allow list already leaves them out).
	deniedOps = []string{"slice approve", "epic approve", "wave", "send", "reconcile", "slice renumber", "epic renumber",
		"slice reopen", "project", "feedback", "slice new", "epic add", "epic set"}
)

// Tools is the only tool set the interviewer gets: no Agent, Skill or web tools.
const Tools = "Read,Glob,Grep,Edit,Write,Bash"

// HostNote is appended to the system prompt. It does not change the interview method.
const HostNote = "You are the interviewer inside MACH Product Studio's local app. Each of your messages is shown to the " +
	"product manager as is, and their reply comes back as the next message. The app created the slice before " +
	"this session started. Approving, reopening, delivery waves, sending, reconciling and " +
	"renumbering are the product manager's own acts, done with the app's buttons; you cannot run them here, so " +
	"if asked, tell the PM which button to use. Run the studio script as a plain command, one per Bash call, " +
	"exactly as the skill spells it: no shell variables, functions, cd or chained commands. If one command is " +
	"refused, only that operation is unavailable; the others still work."

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
}

// PermissionArgs builds the allow and deny lists for one slice (POC section 4.5): every rule in
// each spelling the model may use, the script path quoted and unquoted, through the plugin link
// and its real path, with each interpreter name.
func (p Paths) PermissionArgs(sliceID string) []string {
	allow := []string{"Read", "Glob", "Grep"}
	var deny []string
	for _, script := range p.Scripts {
		for _, spelled := range []string{script, `"` + script + `"`} {
			for _, py := range p.Pythons {
				prefix := py + " " + spelled + " "
				for _, op := range allowedOps {
					allow = append(allow, "Bash("+prefix+op+")")
				}
				for _, op := range allowedSliceOps {
					allow = append(allow, "Bash("+prefix+fmt.Sprintf(op, sliceID)+")")
				}
				for _, op := range allowedSliceOpsArgs {
					allow = append(allow, "Bash("+prefix+fmt.Sprintf(op, sliceID)+" *)")
				}
				for _, op := range deniedOps {
					deny = append(deny, "Bash("+prefix+op+" *)")
				}
				for _, op := range deniedOps {
					deny = append(deny, "Bash("+prefix+op+")")
				}
			}
		}
	}
	// Absolute rules ("//path"): relative ones follow the shell's working folder, which the model
	// can change. Only this slice's spec and why. Edit rules cover the Write tool too.
	allow = append(allow,
		"Edit(/"+filepath.Join(p.Draft, "specs", "slices")+"/"+sliceID+"-*.md)",
		"Edit(/"+filepath.Join(p.Draft, "product", "intents")+"/"+sliceID+".md)")
	return append(append([]string{"--allowedTools"}, allow...), append([]string{"--disallowedTools"}, deny...)...)
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
func (p Paths) Args(sliceID string, o TurnOptions, message string) []string {
	args := []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--restricted", "--plugin-dir", p.PluginDir}
	for _, dir := range p.ReadDirs {
		args = append(args, "--add-dir", dir)
	}
	args = append(args, "--strict-mcp-config",
		"--permission-mode", "default", "--permission-prompts", "none",
		"--tools", Tools)
	args = append(args, p.PermissionArgs(sliceID)...)
	args = append(args, "--max-budget-usd", strconv.FormatFloat(o.BudgetUSD, 'f', -1, 64),
		"--append-system-prompt", HostNote)
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
}

var refusedByWord = []struct{ key, text string }{
	{"approve", "tried to approve; only you can approve, with the Approve button"},
	{"send", "tried to send to engineering; only you can send, from the delivery wave"},
	{"wave", "tried to change a delivery wave; waves are yours to manage in the app"},
}

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
				case len(words) > 1 && (words[0] == "slice" || words[0] == "epic" || words[0] == "wave" || words[0] == "project"):
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
