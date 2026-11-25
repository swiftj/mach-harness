package security

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// IncomingDir is where a project file the person chose to bring in is kept between the plan and
// the import (M21 F), relative to the project root: inside Product Studio's own git-ignored folder,
// beside the draft workspace, never inside it. Unlike UploadDir it is not cleared when the host
// starts: "look first, then bring it in" must use the same bytes, and so must finishing an import
// that stopped part way. Each file lives in a folder named by its SHA-256, so it can only be found
// again by the hash of exactly those bytes.
var IncomingDir = []string{".factory", "studio", "incoming"}

// ErrNotKept: no file is kept under that hash, or what is kept there is no longer those bytes.
var ErrNotKept = errors.New("the file is not kept")

var incomingKey = regexp.MustCompile(`^[0-9a-f]{64}$`)

// IncomingKey is the hex SHA-256 under which data is kept.
func IncomingKey(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// ValidIncomingKey reports whether key has the form of a kept file's hash.
func ValidIncomingKey(key string) bool { return incomingKey.MatchString(key) }

// KeepIncoming writes data as IncomingDir/<sha256>/<name>, after checking every folder on the way
// (no symbolic link, nothing that is not a folder). A file already kept under the same hash is
// replaced, so the name is the one the person chose last. The file is created exclusively and
// without following links.
func KeepIncoming(root, name string, data []byte) (string, string, error) {
	if !UploadNamePattern.MatchString(name) || strings.Contains(name, "..") {
		return "", "", unsafe("the file name is not plain")
	}
	key := IncomingKey(data)
	parent, err := EnsureDir(root, IncomingDir...)
	if err != nil {
		return "", "", err
	}
	folder := filepath.Join(parent, key)
	if err := removeKept(folder); err != nil {
		return "", "", err
	}
	if err := os.Mkdir(folder, 0o700); err != nil {
		return "", "", fmt.Errorf("could not keep the file: %w", err)
	}
	target := filepath.Join(folder, name)
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL|noFollow, 0o600)
	if err != nil {
		os.RemoveAll(folder)
		return "", "", fmt.Errorf("could not keep the file: %w", err)
	}
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		os.RemoveAll(folder)
		return "", "", fmt.Errorf("could not keep the file: %w", err)
	}
	return target, key, nil
}

// FindIncoming returns the path, plain name and size of the file kept under key, after checking
// that every step is a real folder, that the folder holds exactly one regular file of at most
// maxBytes, and that its bytes still hash to key. Anything else is ErrNotKept (or an unsafe path).
func FindIncoming(root, key string, maxBytes int64) (string, string, int64, error) {
	if !ValidIncomingKey(key) {
		return "", "", 0, ErrNotKept
	}
	folder, err := existingDir(root, append(append([]string{}, IncomingDir...), key)...)
	if err != nil {
		return "", "", 0, err
	}
	entries, err := os.ReadDir(folder)
	if err != nil || len(entries) != 1 {
		return "", "", 0, ErrNotKept
	}
	name := entries[0].Name()
	if !UploadNamePattern.MatchString(name) {
		return "", "", 0, ErrNotKept
	}
	target := filepath.Join(folder, name)
	info, err := os.Lstat(target)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxBytes {
		return "", "", 0, ErrNotKept
	}
	file, err := os.OpenFile(target, os.O_RDONLY|noFollow, 0)
	if err != nil {
		return "", "", 0, ErrNotKept
	}
	defer file.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(file, maxBytes+1))
	if err != nil || n > maxBytes || hex.EncodeToString(hash.Sum(nil)) != key {
		return "", "", 0, ErrNotKept
	}
	return target, name, n, nil
}

// ForgetIncoming removes the file kept under key, if any.
func ForgetIncoming(root, key string) error {
	if !ValidIncomingKey(key) {
		return nil
	}
	parent, err := existingDir(root, IncomingDir...)
	if errors.Is(err, ErrNotKept) {
		return nil
	}
	if err != nil {
		return err
	}
	return removeKept(filepath.Join(parent, key))
}

// ForgetIncomingExcept removes every kept file but the one under key: only one project file is
// waiting to be brought in at a time.
func ForgetIncomingExcept(root, key string) error {
	parent, err := existingDir(root, IncomingDir...)
	if errors.Is(err, ErrNotKept) {
		return nil
	}
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		return err
	}
	var problems []error
	for _, entry := range entries {
		if entry.Name() == key {
			continue
		}
		problems = append(problems, removeKept(filepath.Join(parent, entry.Name())))
	}
	return errors.Join(problems...)
}

// removeKept removes one entry of the incoming folder: a folder and what it holds, or a stray link
// or file itself (never what a link points to).
func removeKept(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
		return os.Remove(path)
	}
	return os.RemoveAll(path)
}

// existingDir walks root/components... with Lstat, without making anything: ErrNotKept when a
// folder is missing, an unsafe path when one is a link or not a folder.
func existingDir(root string, components ...string) (string, error) {
	if !filepath.IsAbs(root) {
		return "", unsafe("the project root is not absolute")
	}
	current := root
	for i, part := range components {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			return "", ErrNotKept
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
			return "", unsafe("%s is a symbolic link or not a folder", strings.Join(components[:i+1], "/"))
		}
	}
	return current, nil
}
