package main

import (
	"os"
	"strconv"
	"syscall"
	"unsafe"
)

// openPaths lists the paths of this process's open file descriptors (fcntl F_GETPATH).
func openPaths() []string {
	entries, _ := os.ReadDir("/dev/fd")
	var out []string
	for _, e := range entries {
		fd, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		buf := make([]byte, 1024)
		const fGetPath = 50
		if _, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), fGetPath, uintptr(unsafe.Pointer(&buf[0]))); errno != 0 {
			continue
		}
		for i, b := range buf {
			if b == 0 {
				out = append(out, string(buf[:i]))
				break
			}
		}
	}
	return out
}

const canListOpenPaths = true
