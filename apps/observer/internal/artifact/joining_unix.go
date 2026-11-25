//go:build unix

package artifact

import (
	"errors"
	"syscall"
)

// aliveOnThisSystem asks the kernel whether a process with this ID exists (signal 0 sends nothing).
func aliveOnThisSystem(pid int) (alive, known bool) {
	err := syscall.Kill(pid, 0)
	switch {
	case err == nil, errors.Is(err, syscall.EPERM):
		return true, true
	case errors.Is(err, syscall.ESRCH):
		return false, true
	default:
		return false, false
	}
}
