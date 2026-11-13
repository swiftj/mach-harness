package main

import (
	"os"
	"path/filepath"
)

// openPaths lists the paths of this process's open file descriptors.
func openPaths() []string {
	entries, _ := os.ReadDir("/proc/self/fd")
	var out []string
	for _, e := range entries {
		if p, err := os.Readlink(filepath.Join("/proc/self/fd", e.Name())); err == nil {
			out = append(out, p)
		}
	}
	return out
}

const canListOpenPaths = true
