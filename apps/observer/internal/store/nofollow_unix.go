//go:build unix

package store

import "syscall"

// oNoFollow makes an open fail on a final link instead of following it.
const oNoFollow = syscall.O_NOFOLLOW
