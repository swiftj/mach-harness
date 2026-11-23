//go:build unix

package hostdir

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

// Lock is a held lock on the host folder's lock file. The operating system lets go of it when the
// process ends, however it ends, so a host that crashed leaves no lock behind: the next start takes
// it and replaces the link file the crashed host left.
type Lock struct{ f *os.File }

// Acquire takes an exclusive, non-blocking lock. ErrHeld: another host holds it.
func (d *Dir) Acquire() (*Lock, error) {
	f, err := os.OpenFile(filepath.Join(d.Path, LockName), os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
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
