//go:build unix

package act

import (
	"os/exec"
	"syscall"
)

// prepare runs run.py in its own process group, so a time limit stops the stations, Git and test
// commands it started as well.
func prepare(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
