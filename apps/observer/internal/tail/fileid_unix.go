//go:build unix

package tail

import (
	"errors"
	"io/fs"
	"os"
	"syscall"
)

func fileID(info fs.FileInfo) (uint64, uint64) {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Dev), uint64(st.Ino)
	}
	return 0, 0
}

// openReadOnly opens without following a final symbolic link and without blocking on a FIFO
// that was swapped in after the Lstat check. Opening for reading changes no timestamp but atime.
func openReadOnly(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
}

func isLinkRefusal(err error) bool {
	return errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.EMLINK)
}
