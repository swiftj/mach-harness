// Package interview bridges the app to a Claude Code interview (contract section 8.2).
//
// One Claude Code session per slice, resumed across interviews and host restarts; one `claude -p`
// process per reply. The raw stream from Claude Code stays inside this package: what leaves it is
// the small, fixed set of events below.
package interview

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Errors the server maps to envelope kinds.
var (
	ErrUnavailable = errors.New("interviews are not available here")
	ErrNotFound    = errors.New("no such interview")
)

// ConflictError: the slice's lock is held, a turn is running, or the interview has ended.
// InterviewID is set when this host itself is running the slice's interview: the app can attach
// to that interview instead of starting one. TakeOver is set when a live process elsewhere on this
// computer holds the lock: Message is the warning, and starting again with TakeOver continues here.
type ConflictError struct {
	Message     string
	InterviewID string
	TakeOver    bool
}

func (e *ConflictError) Error() string { return e.Message }

// Event is one server-sent event. Seq increases across an interview and is the SSE id.
type Event struct {
	Seq  int64  `json:"seq"`
	Name string `json:"event"`
	Data any    `json:"data"`
}

// StartRequest is what the server passes after checking the slice with the engine.
type StartRequest struct {
	SliceID string
	// IdeaID (M16): the Shape conversation for one idea instead of a slice's interview. Exactly one
	// of SliceID and IdeaID is set; EpicID, Idea and BuildersQuestion are for a slice only.
	IdeaID string
	// Needs (M17): the needs conversation for the product as a whole; nothing else is set with it.
	Needs bool
	// PrdID (M19): the PRD conversation for one imported PRD; nothing else is set with it.
	PrdID  string
	EpicID string
	Idea   string
	// TakeOver: continue here although another process holds the subject's lock. This host's own
	// interview is ended first and resumed here; another live process keeps writing too (the
	// warning said so). A lock whose process is gone is taken without it.
	TakeOver bool
	// BuildersQuestion is the builders' question the engine reports on the slice (slice show). The
	// host never sends its text to the interviewer: an opening turn says only that there is one,
	// and the interviewer reads it from `slice resume`, fenced as data.
	BuildersQuestion string
}

// Subject is the slice or idea the request is for.
func (r StartRequest) Subject() string {
	if r.Needs {
		return NeedsSubject
	}
	if r.IdeaID != "" {
		return r.IdeaID
	}
	if r.PrdID != "" {
		return r.PrdID
	}
	return r.SliceID
}

// Started answers POST /api/interview.
type Started struct {
	InterviewID string `json:"interview_id"`
	SliceID     string `json:"slice_id,omitempty"`
	IdeaID      string `json:"idea_id,omitempty"`
	Needs       bool   `json:"needs,omitempty"`
	PrdID       string `json:"prd_id,omitempty"`
	Resumed     bool   `json:"resumed"`
}

// Message is a final message the product manager answers.
type Message struct {
	MessageID string    `json:"message_id"`
	Text      string    `json:"text"`
	Kind      string    `json:"kind"`
	Question  *Question `json:"question"`
}

// Current answers GET /api/interview?slice_id=...: the live interview for a slice, or what is
// saved of the last one, so the app can resume after a reload or a host restart.
type Current struct {
	InterviewID     *string `json:"interview_id"` // null when no interview is live in this host
	SliceID         string  `json:"slice_id,omitempty"`
	IdeaID          string  `json:"idea_id,omitempty"` // M16: the Shape conversation's idea
	Needs           bool    `json:"needs,omitempty"`   // M17: the needs conversation
	PrdID           string  `json:"prd_id,omitempty"`  // M19: the PRD conversation's PRD
	Live            bool    `json:"live"`
	State           string  `json:"state"` // a state event's value, or "saved" when not live
	TurnRunning     bool    `json:"turn_running"`
	LockedElsewhere bool    `json:"locked_elsewhere"` // another host or terminal holds the slice
	// TakeOverWarning: while LockedElsewhere, the warning to show before the app offers to take it
	// over (POST /api/interview with take_over: true).
	TakeOverWarning string   `json:"take_over_warning,omitempty"`
	LastMessage     *Message `json:"last_message"`
	Turns           int      `json:"turns"`
	SessionCostUSD  float64  `json:"session_cost_usd"`
}

func (c *Current) setSubject(subject string) {
	if IsNeeds(subject) {
		c.Needs = true
	} else if IsIdea(subject) {
		c.IdeaID = subject
	} else if IsPrd(subject) {
		c.PrdID = subject
	} else {
		c.SliceID = subject
	}
}

// Bridge is what the server talks to. Every method that takes a slice ID takes an idea ID (M16)
// the same way: the two patterns never overlap.
type Bridge interface {
	// Available says whether interviews can run here, and if not, why, in a person's words.
	Available() (bool, string)
	// ContinueCommand is the command that continues an interview in Claude Code, without the slice
	// ID: "/mach:studio continue" (plugin) or "/mach-studio continue" (project).
	ContinueCommand() string
	Start(ctx context.Context, req StartRequest) (Started, error)
	Current(sliceID string) (*Current, error)
	// Subscribe returns the events to replay (those after `after`: the current turn so far and the
	// last final message), then a channel of new ones. The channel closes when the interview ends
	// or the subscriber falls too far behind (it then reconnects with its last id).
	Subscribe(id string, after int64) (replay []Event, events <-chan Event, cancel func(), err error)
	Reply(ctx context.Context, id, text string) error
	Interrupt(ctx context.Context, id string) error
	Stop(ctx context.Context, id string) error
	// History is the slice's saved interview events (HistoryEvent), oldest first, across
	// interviews and host restarts, and whether older ones were dropped.
	History(sliceID string) ([]HistoryEvent, bool, error)
	// Busy: a turn is running for this slice, so its draft is being written.
	Busy(sliceID string) bool
	// InterruptSubject stops the running turn of this slice's interview, if there is one, and
	// waits for it to end, so the product manager's own edit can be written.
	InterruptSubject(ctx context.Context, sliceID string) error
	// Shutdown stops every running turn and ends every interview with reason host_shutdown.
	Shutdown(ctx context.Context)
}

// Unavailable is the bridge when interviews cannot run (no Claude Code, a platform without
// process groups, or a test).
type Unavailable struct {
	Reason  string
	Command string
}

// DefaultReason is used when no reason was given.
const DefaultReason = "The guided interview is not available in this build of Product Studio. " +
	"Continue a slice's interview in Claude Code; the drafts it writes appear here."

func (u Unavailable) Available() (bool, string) {
	if u.Reason != "" {
		return false, u.Reason
	}
	return false, DefaultReason
}

func (u Unavailable) ContinueCommand() string {
	if u.Command != "" {
		return u.Command
	}
	return "/mach:studio continue"
}

func (Unavailable) Start(context.Context, StartRequest) (Started, error) {
	return Started{}, ErrUnavailable
}
func (Unavailable) Current(string) (*Current, error) { return nil, ErrUnavailable }
func (Unavailable) Subscribe(string, int64) ([]Event, <-chan Event, func(), error) {
	return nil, nil, nil, ErrUnavailable
}
func (Unavailable) Reply(context.Context, string, string) error    { return ErrUnavailable }
func (Unavailable) Interrupt(context.Context, string) error        { return ErrUnavailable }
func (Unavailable) Stop(context.Context, string) error             { return ErrUnavailable }
func (Unavailable) Busy(string) bool                               { return false }
func (Unavailable) InterruptSubject(context.Context, string) error { return nil }
func (Unavailable) History(string) ([]HistoryEvent, bool, error) {
	return []HistoryEvent{}, false, nil
}
func (Unavailable) Shutdown(context.Context) {}

// lockHolder is what a held lock file says about the process holding it. PID is 0 when it left no
// readable record; Alive is false only when that process is known to be gone.
type lockHolder struct {
	PID   int
	Since string
	Alive bool
}

// SubjectName is how the product manager knows the subject in a sentence.
func SubjectName(subject string) string {
	if IsNeeds(subject) {
		return "the technical needs"
	}
	return subject
}

// TakeOverWarning is said before a second writer starts on a subject another live process holds.
func TakeOverWarning(subject string, holder lockHolder) string {
	who := ""
	if holder.PID > 0 {
		who = fmt.Sprintf(" (process %d", holder.PID)
		if since := clockTime(holder.Since); since != "" {
			who += ", since " + since
		}
		who += ")"
	}
	return "Another window on this computer is writing " + SubjectName(subject) + " right now" + who + ". " +
		"Continuing here means two writers: the draft keeps whichever saves last, and the other's last turn stays in the history."
}

// clockTime shows a recorded time as the local clock time, with the date when it was not today.
func clockTime(recorded string) string {
	at, err := time.Parse(time.RFC3339, recorded)
	if err != nil {
		return ""
	}
	local, today := at.Local(), time.Now()
	if local.YearDay() == today.YearDay() && local.Year() == today.Year() {
		return local.Format("15:04")
	}
	return local.Format("2 Jan 15:04")
}
