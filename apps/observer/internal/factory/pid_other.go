//go:build !unix

package factory

import "os"

func pidAlive(int) bool { return false }

func openNoFollow(path string) (*os.File, error) { return os.Open(path) }
