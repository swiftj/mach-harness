//go:build unix

package security

import "syscall"

const noFollow = syscall.O_NOFOLLOW
