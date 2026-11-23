//go:build !unix

package hostdir

// Lock is a no-op where advisory file locks are not available; the host is built for macOS and
// Linux only.
type Lock struct{}

// Acquire always succeeds here.
func (d *Dir) Acquire() (*Lock, error) { return &Lock{}, nil }

// Release does nothing.
func (*Lock) Release() error { return nil }
