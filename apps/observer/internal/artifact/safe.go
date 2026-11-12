//go:build unix

package artifact

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"strings"
	"syscall"
)

// Reading a file the catalog names, without letting the project steer the read anywhere else.
//
// Every path is resolved under an os.Root opened at the project folder, so no component, link or
// "..", however it changes during the read, can reach outside the project. Inside the project the
// rules are stricter: no component may be a link, the file must be a regular file with exactly one
// link (a hard link to a file elsewhere would share its inode, so it is refused), and the file
// opened must be the one checked. The checks run after the open, so a component swapped for a link
// and back during the read is caught: the opened file's device and inode must equal what the path
// names once the open is done.

// Refusal reasons.
var (
	ErrLink      = errors.New("a component of the path is a link")
	ErrNotFile   = errors.New("not a regular file")
	ErrHardLink  = errors.New("the file has more than one link")
	ErrSwapped   = errors.New("the file changed while it was being opened")
	ErrTooLarge  = errors.New("the file is larger than the cap")
	ErrBadPath   = errors.New("not a plain relative path")
	ErrNotHeld   = errors.New("no such file")
	ErrChanged   = errors.New("the file's contents changed since it was catalogued")
	ErrTypeMatch = errors.New("the file's contents do not match its type")
)

// fileID is a file's identity.
type fileID struct {
	Dev, Ino uint64
	Nlink    uint64
	Size     int64
	ModNS    int64
}

func idOf(info fs.FileInfo) (fileID, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileID{}, false
	}
	return fileID{Dev: uint64(st.Dev), Ino: uint64(st.Ino), Nlink: uint64(st.Nlink), Size: info.Size(), ModNS: info.ModTime().UnixNano()}, true
}

// checkPath lstats every component of rel under root: folders must be folders, the last must be
// a regular file with one link. It returns the last component's identity.
func checkPath(root *os.Root, rel string) (fileID, error) {
	parts := strings.Split(rel, "/")
	for i := range parts {
		prefix := strings.Join(parts[:i+1], "/")
		info, err := root.Lstat(prefix)
		if errors.Is(err, fs.ErrNotExist) {
			return fileID{}, ErrNotHeld
		}
		if err != nil {
			return fileID{}, err
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			return fileID{}, ErrLink
		}
		last := i == len(parts)-1
		if !last && !info.IsDir() {
			return fileID{}, ErrNotFile
		}
		if last {
			if !info.Mode().IsRegular() {
				return fileID{}, ErrNotFile
			}
			id, ok := idOf(info)
			if !ok {
				return fileID{}, ErrNotFile
			}
			if id.Nlink != 1 {
				return fileID{}, ErrHardLink
			}
			return id, nil
		}
	}
	return fileID{}, ErrBadPath
}

// openGuarded opens rel (project-relative) under root for reading, with every check above.
func openGuarded(root *os.Root, rel string) (*os.File, error) {
	if !cleanRel(rel) {
		return nil, ErrBadPath
	}
	if _, err := checkPath(root, rel); err != nil {
		return nil, err
	}
	// Read-only, never following a final link, never blocking on a FIFO swapped in.
	f, err := root.OpenFile(rel, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotHeld
		}
		return nil, ErrLink
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	opened, ok := idOf(info)
	if !ok || !info.Mode().IsRegular() {
		f.Close()
		return nil, ErrNotFile
	}
	if opened.Nlink != 1 {
		f.Close()
		return nil, ErrHardLink
	}
	after, err := checkPath(root, rel) // after the open: the path must still name this very file
	if err != nil {
		f.Close()
		return nil, err
	}
	if after.Dev != opened.Dev || after.Ino != opened.Ino {
		f.Close()
		return nil, ErrSwapped
	}
	return f, nil
}

// readFile reads rel (project-relative) under root, at most max bytes; more is ErrTooLarge.
func readFile(root *os.Root, rel string, max int64) ([]byte, fileID, error) {
	f, err := openGuarded(root, rel)
	if err != nil {
		return nil, fileID{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, fileID{}, err
	}
	opened, _ := idOf(info)
	if opened.Size > max {
		return nil, opened, ErrTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, opened, err
	}
	if int64(len(data)) > max {
		return nil, opened, ErrTooLarge
	}
	return data, opened, nil
}

// statFile is checkPath for a plain path, used to decide whether a cached hash is still good.
func statFile(root *os.Root, rel string) (fileID, error) {
	if !cleanRel(rel) {
		return fileID{}, ErrBadPath
	}
	return checkPath(root, rel)
}

// isDir reports whether rel is a real folder (not a link) under root.
func isDir(root *os.Root, rel string) bool {
	if !cleanRel(rel) {
		return false
	}
	parts := strings.Split(rel, "/")
	for i := range parts {
		info, err := root.Lstat(strings.Join(parts[:i+1], "/"))
		if err != nil || info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
			return false
		}
	}
	return true
}

// listDir lists a real folder's entry names (no links followed; entries are checked when used).
func listDir(root *os.Root, rel string) []string {
	if !isDir(root, rel) {
		return nil
	}
	f, err := root.Open(rel)
	if err != nil {
		return nil
	}
	defer f.Close()
	names, err := f.Readdirnames(10000)
	if err != nil && len(names) == 0 {
		return nil
	}
	return names
}
