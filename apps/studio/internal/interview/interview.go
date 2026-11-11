// Package interview bridges the app to a Claude Code interview (contract section 8.2).
//
// One Claude Code session per slice, resumed across interviews and host restarts; one `claude -p`
// process per reply. The raw stream from Claude Code stays inside this package: what leaves it is
// the small, fixed set of events below.
package interview

import (
	"context"
	"errors"
)

// Errors the server maps to envelope kinds.
var (
	ErrUnavailable = errors.New("interviews are not available here")
	ErrNotFound    = errors.New("no such interview")
)

// ConflictError: the slice's lock is held, a turn is running, or the interview has ended.
// InterviewID is set when this host itself is running the slice's interview: the app can attach
// to that interview instead of starting one.
type ConflictError struct {
	Message     string
	InterviewID string
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
	EpicID  string
	Idea    string
}

// Started answers POST /api/interview.
type Started struct {
	InterviewID string `json:"interview_id"`
	SliceID     string `json:"slice_id"`
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
	InterviewID     *string  `json:"interview_id"` // null when no interview is live in this host
	SliceID         string   `json:"slice_id"`
	Live            bool     `json:"live"`
	State           string   `json:"state"` // a state event's value, or "saved" when not live
	TurnRunning     bool     `json:"turn_running"`
	LockedElsewhere bool     `json:"locked_elsewhere"` // another host or terminal holds the slice
	LastMessage     *Message `json:"last_message"`
	Turns           int      `json:"turns"`
	SessionCostUSD  float64  `json:"session_cost_usd"`
}

// Bridge is what the server talks to.
type Bridge interface {
	// Available says whether interviews can run here, and if not, why, in a person's words.
	Available() (bool, string)
	// ContinueCommand is the command that continues an interview in Claude Code, without the slice
	// ID: "/mach:product-studio continue" (plugin) or "/mach-product-studio continue" (project).
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
	// Busy: a turn is running for this slice, so its draft must not be written by anyone else.
	Busy(sliceID string) bool
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
	return "/mach:product-studio continue"
}

func (Unavailable) Start(context.Context, StartRequest) (Started, error) {
	return Started{}, ErrUnavailable
}
func (Unavailable) Current(string) (*Current, error) { return nil, ErrUnavailable }
func (Unavailable) Subscribe(string, int64) ([]Event, <-chan Event, func(), error) {
	return nil, nil, nil, ErrUnavailable
}
func (Unavailable) Reply(context.Context, string, string) error { return ErrUnavailable }
func (Unavailable) Interrupt(context.Context, string) error     { return ErrUnavailable }
func (Unavailable) Stop(context.Context, string) error          { return ErrUnavailable }
func (Unavailable) Busy(string) bool                            { return false }
func (Unavailable) History(string) ([]HistoryEvent, bool, error) {
	return []HistoryEvent{}, false, nil
}
func (Unavailable) Shutdown(context.Context) {}
