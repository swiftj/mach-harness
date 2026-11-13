//go:build !unix

package artifact

import (
	"errors"
	"os"
)

// The artifact reader relies on Unix file identities (device, inode, link count) and O_NOFOLLOW.
// Elsewhere it refuses every read rather than read without those checks.

var errUnsupported = errors.New("artifact content is served on Unix systems only")

var (
	ErrLink      = errUnsupported
	ErrNotFile   = errUnsupported
	ErrHardLink  = errUnsupported
	ErrSwapped   = errUnsupported
	ErrTooLarge  = errors.New("the file is larger than the cap")
	ErrBadPath   = errors.New("not a plain relative path")
	ErrNotHeld   = errors.New("no such file")
	ErrChanged   = errors.New("the file's contents changed since it was catalogued")
	ErrTypeMatch = errors.New("the file's contents do not match its type")
)

type fileID struct {
	Dev, Ino, Nlink uint64
	Size, ModNS     int64
}

func readFile(*os.Root, string, int64) ([]byte, fileID, error) { return nil, fileID{}, errUnsupported }
func openGuarded(*os.Root, string) (*os.File, error)           { return nil, errUnsupported }
func statFile(*os.Root, string) (fileID, error)                { return fileID{}, errUnsupported }
func isDir(*os.Root, string) bool                              { return false }
func listDir(*os.Root, string) []string                        { return nil }
