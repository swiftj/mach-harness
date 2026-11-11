// Package interview is where the bridge to a Claude Code interview session plugs in.
//
// The bridge depends on a proof of concept that has not reported yet, so the only implementation
// here is Unavailable. The server talks to the Bridge interface alone; the real bridge replaces
// Unavailable in main without any change to the routes.
package interview

import (
	"context"
	"errors"
	"net/http"
)

// ErrUnavailable is returned by every call while interviews cannot run.
var ErrUnavailable = errors.New("interviews are not available in this version of the host")

// ErrConflict: that slice already has an interview running.
var ErrConflict = errors.New("that slice already has an interview running")

// ErrNotFound: no interview with that ID.
var ErrNotFound = errors.New("no such interview")

// Bridge runs at most one interview per slice and re-emits its events (contract section 6).
type Bridge interface {
	// Available says whether interviews can run, and if not, why, in a person's words.
	Available() (bool, string)
	// Start starts or resumes the interview for a slice and returns its ID.
	Start(ctx context.Context, sliceID string) (string, error)
	// Events streams server-sent events for the interview until it ends or ctx is done.
	Events(ctx context.Context, id string, w http.ResponseWriter) error
	// Reply passes the product manager's answer to the interviewer.
	Reply(ctx context.Context, id, text string) error
	// Stop ends the interview; the draft and the saved note remain.
	Stop(ctx context.Context, id string) error
}

// Unavailable is the bridge until the proof of concept lands.
type Unavailable struct{ Reason string }

// DefaultReason is shown in GET /api/session and in every interview route's error.
const DefaultReason = "The guided interview is not connected in this build of Product Studio yet. " +
	"Continue a slice's interview in Claude Code with /mach:product-studio; the drafts it writes appear here."

func (u Unavailable) reason() string {
	if u.Reason != "" {
		return u.Reason
	}
	return DefaultReason
}

func (u Unavailable) Available() (bool, string)                               { return false, u.reason() }
func (Unavailable) Start(context.Context, string) (string, error)             { return "", ErrUnavailable }
func (Unavailable) Events(context.Context, string, http.ResponseWriter) error { return ErrUnavailable }
func (Unavailable) Reply(context.Context, string, string) error               { return ErrUnavailable }
func (Unavailable) Stop(context.Context, string) error                        { return ErrUnavailable }
