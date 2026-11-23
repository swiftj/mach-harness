// Package hostdir holds the host's own folder in a project: the lock that keeps one host per
// project, and the private file that keeps the next unused one-time link. The folder is the
// studio part of the project's machine-local folder, which MACH's installer git-ignores; it is
// private to the user and carries its own .gitignore of "*" as well. The host writes nothing else
// there and reads nothing it did not write. A project with no tool folder gets no host folder: the
// host then keeps nothing on disk and holds no lock, and its link is the printed one only.
package hostdir

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Rel is the host folder relative to the project root, for messages.
const Rel = ".factory/local/studio"

// LinkName is the file in the host folder that holds the next unused one-time link (mode 0600).
const LinkName = "link"

// LockName is the file in the host folder that the running host holds an exclusive lock on.
const LockName = "lock"

// ErrHeld means another host is running for this project.
var ErrHeld = errors.New("another Product Studio is already running for this project")

// Dir is a prepared host folder.
type Dir struct{ Path string }

// Prepare makes the machine-local folder (if missing) and the host folder in it, both private to
// this user, and refuses either if it is a symbolic link or not a folder. It returns nil, nil when
// the project has no tool folder, or it is not a plain folder: nothing is made then.
func Prepare(root string) (*Dir, error) {
	if !filepath.IsAbs(root) {
		return nil, errors.New("the project root is not absolute")
	}
	top := filepath.Join(root, ".factory")
	if info, err := os.Lstat(top); err != nil || !info.IsDir() {
		return nil, nil
	}
	dir := filepath.Join(root, filepath.FromSlash(Rel))
	for _, d := range []string{filepath.Dir(dir), dir} {
		if err := os.Mkdir(d, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("could not make %s: %w", d, err)
		}
		info, err := os.Lstat(d)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("%s is not a folder (a link is refused)", d)
		}
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, err
	}
	ignore := filepath.Join(dir, ".gitignore")
	if _, err := os.Lstat(ignore); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(ignore, []byte("# Product Studio's host: machine-local, never committed.\n*\n"), 0o600); err != nil {
			return nil, err
		}
	}
	return &Dir{Path: dir}, nil
}

// LinkPath is where the next unused link is kept.
func (d *Dir) LinkPath() string { return filepath.Join(d.Path, LinkName) }

// WriteLink replaces the kept link atomically, readable only by this user. Whatever was in its
// place, a link included, is replaced and never followed: the rename swaps the name itself.
func (d *Dir) WriteLink(url string) error {
	return writePrivate(d.LinkPath(), []byte(url+"\n"))
}

// RemoveLink removes the kept link: a link must not outlive the host that would accept it.
func (d *Dir) RemoveLink() { os.Remove(d.LinkPath()) }

// writePrivate writes data to path atomically, readable only by this user.
func writePrivate(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
