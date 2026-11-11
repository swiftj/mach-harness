//go:build unix

package engine

import (
	"os/exec"
	"syscall"
)

// prepare runs the engine in its own process group, so a time limit stops the Git processes it
// started as well.
func prepare(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
