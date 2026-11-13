//go:build unix

package normalize

import (
	"os"
	"syscall"
)

// openNoFollow opens a file read-only without following a final link and without blocking on a FIFO.
func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
}
