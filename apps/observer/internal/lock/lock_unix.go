//go:build unix

// Package lock keeps one observer per project. It locks a file in the observer's own folder and
// nothing else: the observer never takes, waits for or tests a lock MACH uses.
package lock

import (
	"errors"
	"os"
	"syscall"
)

// ErrHeld means another observer is running for this project.
var ErrHeld = errors.New("another observer is already running for this project")

// Lock is a held lock.
type Lock struct{ f *os.File }

// Acquire takes an exclusive, non-blocking lock on path. The lock ends with the process.
func Acquire(path string) (*Lock, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrHeld
		}
		return nil, err
	}
	return &Lock{f: f}, nil
}

// Release lets go of the lock.
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	return l.f.Close()
}
