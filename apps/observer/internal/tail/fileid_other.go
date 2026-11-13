//go:build !unix

package tail

import (
	"io/fs"
	"os"
)

// Without inode identity, replacement is recognised by truncation and by the first line's hash.
func fileID(fs.FileInfo) (uint64, uint64) { return 0, 0 }

func openReadOnly(path string) (*os.File, error) { return os.Open(path) }

func isLinkRefusal(error) bool { return false }
