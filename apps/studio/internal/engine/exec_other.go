//go:build !unix

package engine

import "os/exec"

// prepare: on other systems the default cancellation (kill the process) applies.
func prepare(cmd *exec.Cmd) {}
