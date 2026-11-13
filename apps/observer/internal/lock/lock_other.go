//go:build !unix

package lock

import "errors"

// ErrHeld means another observer is running for this project.
var ErrHeld = errors.New("another observer is already running for this project")

// Lock is a no-op where advisory file locks are not available; the observer is built for macOS
// and Linux only.
type Lock struct{}

// Acquire always succeeds here.
func Acquire(string) (*Lock, error) { return &Lock{}, nil }

// Release does nothing.
func (*Lock) Release() error { return nil }
