package security

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// UploadDir is where a file the person chose in the browser is staged for one engine call,
// relative to the project root: inside Product Studio's own git-ignored workspace, beside the
// draft workspace, never inside it. Each call gets its own random folder, removed afterwards.
var UploadDir = []string{".factory", "studio", "uploads"}

// UploadNamePattern is the only form a staged file's name may take: a plain name with no folder,
// no leading dot or hyphen, and one extension.
var UploadNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._ -]{0,98}\.[a-z0-9]{1,9}$`)

// StageUpload writes data to a new file named name inside a fresh random folder under
// UploadDir, after checking every folder on the way with Lstat (no symbolic link, nothing that is
// not a folder). The file is created exclusively and without following links. The returned
// cleanup removes the random folder and everything in it, and the uploads folder itself when it
// is empty; call it whatever the engine answered.
func StageUpload(root, name string, data []byte) (string, func(), error) {
	if !UploadNamePattern.MatchString(name) || strings.Contains(name, "..") {
		return "", func() {}, unsafe("the file name is not plain")
	}
	random, err := randomToken()
	if err != nil {
		return "", func() {}, err
	}
	folder, err := EnsureDir(root, append(append([]string{}, UploadDir...), random[:16])...)
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() {
		os.RemoveAll(folder)
		os.Remove(filepath.Dir(folder)) // only succeeds when nothing else is staged
	}
	target := filepath.Join(folder, name)
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL|noFollow, 0o600)
	if err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("could not stage the file: %w", err)
	}
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("could not stage the file: %w", err)
	}
	return target, cleanup, nil
}

// ClearUploads removes anything left in UploadDir by a host that stopped in the middle of a
// call. It refuses to follow a symbolic link at any level and touches nothing else.
func ClearUploads(root string) error {
	current := root
	for _, part := range UploadDir {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
			return unsafe("%s is a symbolic link or not a folder", strings.Join(UploadDir, "/"))
		}
	}
	return os.RemoveAll(current)
}
