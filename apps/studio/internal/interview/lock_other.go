//go:build !unix

package interview

import (
	"errors"
	"os"
	"syscall"
	"time"
)

// supported: without flock and process groups the host offers no interview here.
const supported = false

func acquireLock(path string) (*os.File, *lockHolder, error) {
	return nil, nil, errors.New("interviews need a Unix system")
}
func markLock(path string)                    {}
func releaseLock(file *os.File)               {}
func lockHeld(path string) (bool, lockHolder) { return false, lockHolder{} }
func killGroup(pid int, sig syscall.Signal)   {}
func newProcessGroup() *syscall.SysProcAttr   { return nil }
func nowTime() time.Time                      { return time.Now().UTC() }

var (
	sigTerm = syscall.Signal(15)
	sigKill = syscall.Signal(9)
)
