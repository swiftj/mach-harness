package act

import (
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"
)

// What the observer reads from run.py's answers to `factory status`, `factory stop` and `decide do`.
// All of it is here, read defensively: a field that is missing, of another type or not one of the
// known values is "not known" (nil), never guessed. Free text is never passed on from these
// answers except run.py's own sentences for a person (`now`, `why`, `note`), cut to a limit.
//
// factory status (activation.status):
//
//	supervisor.running         bool
//	supervisor.lifetime        "session" | "background"   (how it was started; absent before M23)
//	supervisor.since           time text                  (when it started)
//	supervisor.pid             int                        (read, never passed on)
//	executions[]               the running executions     (counted only)
//	factory                    "disabled" | "paused" | "observe" | "supervised"
//
// factory stop (activation.stop):
//
//	stopped[]                  the executions stopped      (counted only)
//	supervisor_stopped         bool                        (absent before M23)
//	note | in_words            run.py's sentence for a person
//
// decide do (act.py): ticket_id, option, done, now, in_conversation, command, why, supervisor,
// unparked, note, why_not, warnings (run.py's sentences: another worker may be on the ticket),
// already_decided and decided.at (another person's decision came first; `now` says what it was and
// what waits now), took_over.taken, by (the person's name: used only to take it out of `now`, never
// passed on). A `busy` answer never reaches here: Decide turns it into a conflict.

// Running is whether a Factory supervisor runs for this project, as `factory status` says.
type Running struct {
	Known      bool    `json:"known"`
	Running    *bool   `json:"running"`
	Lifetime   *string `json:"lifetime"`   // "session" | "background"
	Since      *string `json:"since"`      // as run.py wrote it (a time)
	Executions *int    `json:"executions"` // how many executions run now
	Mode       *string `json:"mode"`       // the Factory's mode here
	ReadAt     string  `json:"read_at"`
}

var lifetimes = map[string]bool{"session": true, "background": true}
var modes = map[string]bool{"disabled": true, "paused": true, "observe": true, "supervised": true}

func oneOf(v any, allowed map[string]bool) *string {
	s, ok := v.(string)
	if !ok || !allowed[s] {
		return nil
	}
	return &s
}

// ParseStatus reads `factory status`.
func ParseStatus(data []byte, now time.Time) Running {
	out := Running{ReadAt: now.UTC().Format(time.RFC3339)}
	var top map[string]any
	if json.Unmarshal(data, &top) != nil || top == nil {
		return out
	}
	sup, _ := top["supervisor"].(map[string]any)
	if r, ok := sup["running"].(bool); ok {
		out.Known, out.Running = true, &r
	}
	out.Lifetime = oneOf(sup["lifetime"], lifetimes)
	if s, ok := sup["since"].(string); ok && len(s) <= 40 && timeText(s) {
		out.Since = &s
	}
	if list, ok := top["executions"].([]any); ok {
		n := len(list)
		out.Executions = &n
	}
	out.Mode = oneOf(top["factory"], modes)
	return out
}

// timeText: a time as run.py writes one (digits, -, :, T, Z, ., +), nothing else.
func timeText(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || strings.ContainsRune("-:TZ.+ ", r)) {
			return false
		}
	}
	return true
}

// Stopped is what `factory stop` did.
type Stopped struct {
	Stopped           *int    `json:"stopped"`
	SupervisorStopped *bool   `json:"supervisor_stopped"`
	Note              *string `json:"note"`
}

// ParseStop reads `factory stop`.
func ParseStop(data []byte) Stopped {
	var out Stopped
	var top map[string]any
	if json.Unmarshal(data, &top) != nil || top == nil {
		return out
	}
	if list, ok := top["stopped"].([]any); ok {
		n := len(list)
		out.Stopped = &n
	}
	if b, ok := top["supervisor_stopped"].(bool); ok {
		out.SupervisorStopped = &b
	}
	for _, key := range []string{"in_words", "note"} {
		if s := sentenceOf(top[key], ""); s != nil {
			out.Note = s
			break
		}
	}
	return out
}

// Decided is what `decide do` answered, without the person's name.
type Decided struct {
	TicketID       string  `json:"ticket_id"`
	Option         string  `json:"option"`
	Done           bool    `json:"done"`
	InConversation bool    `json:"in_conversation"`
	Now            *string `json:"now"`
	Command        *string `json:"command"`
	Why            *string `json:"why"`
	Note           *string `json:"note"`
	Supervisor     *string `json:"supervisor"` // "started" | "woken" | "none"
	WhyNot         *string `json:"why_not"`    // why no Factory carries it on now (run.py's sentence)
	Unparked       *bool   `json:"unparked"`
	// Warnings are run.py's sentences shown with the decision, such as another worker on the ticket.
	Warnings []string `json:"warnings"`
	// AlreadyDecided: another person's decision on this ticket came first and made this one moot.
	// Nothing was recorded; `now` says what was decided, when, and what the ticket waits for now.
	AlreadyDecided bool    `json:"already_decided"`
	DecidedAt      *string `json:"decided_at"`
	TookOver       bool    `json:"took_over"`
}

// maxWarnings: at most this many warnings are passed on.
const maxWarnings = 5

var supervisorStates = map[string]bool{"started": true, "woken": true, "none": true}

// ParseDecided reads `decide do`'s answer. The name it was recorded under (`by`) is taken out of
// its sentences: the person who decided reads "your" and "you" in its place, and the name is never
// sent back to the browser.
func ParseDecided(data []byte) Decided {
	var top map[string]any
	if json.Unmarshal(data, &top) != nil || top == nil {
		return Decided{}
	}
	name, _ := top["by"].(string)
	name = strings.Join(strings.Fields(name), " ")
	out := Decided{Done: top["done"] == true, InConversation: top["in_conversation"] == true}
	if s, ok := top["ticket_id"].(string); ok && TicketPattern.MatchString(s) && len(s) <= MaxTicket {
		out.TicketID = s
	}
	if s, ok := top["option"].(string); ok && OptionPattern.MatchString(s) {
		out.Option = s
	}
	out.Now = sentenceOf(top["now"], name)
	out.Why = sentenceOf(top["why"], name)
	out.Note = sentenceOf(top["note"], name)
	out.WhyNot = sentenceOf(top["why_not"], name)
	if s, ok := top["command"].(string); ok && len(s) <= 200 && plain(s) {
		out.Command = &s
	}
	out.Supervisor = oneOf(top["supervisor"], supervisorStates)
	if b, ok := top["unparked"].(bool); ok {
		out.Unparked = &b
	}
	out.Warnings = []string{}
	if list, ok := top["warnings"].([]any); ok {
		for _, w := range list {
			if s := sentenceOf(w, name); s != nil && len(out.Warnings) < maxWarnings {
				out.Warnings = append(out.Warnings, *s)
			}
		}
	}
	out.AlreadyDecided = top["already_decided"] == true && !out.Done
	if decided, ok := top["decided"].(map[string]any); ok && out.AlreadyDecided {
		if s, ok := decided["at"].(string); ok && len(s) <= 40 && timeText(s) {
			out.DecidedAt = &s
		}
	}
	if took, ok := top["took_over"].(map[string]any); ok {
		out.TookOver = took["taken"] == true
	}
	return out
}

// sentenceOf: run.py's sentence for a person, with the decider's name replaced, cut to 1,000
// characters; nil when it is not text.
func sentenceOf(v any, name string) *string {
	s, ok := v.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return nil
	}
	if name != "" {
		s = strings.ReplaceAll(s, name+"'s", "your")
		s = strings.ReplaceAll(s, name, "you")
		if strings.HasPrefix(s, "your") || strings.HasPrefix(s, "you ") {
			s = "Y" + s[1:]
		}
	}
	if !plain(s) {
		s = strings.Map(func(r rune) rune {
			if r < 0x20 && r != '\n' || r == 0x7f {
				return ' '
			}
			return r
		}, s)
	}
	s = truncate(strings.ToValidUTF8(s, "?"), 1000)
	if !utf8.ValidString(s) {
		return nil
	}
	return &s
}

func plain(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}
