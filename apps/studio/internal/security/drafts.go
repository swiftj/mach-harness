package security

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// DraftDir is the draft workspace, relative to the project root. No other folder is ever written.
const DraftDir = ".factory/studio/draft"

// ErrUnsafePath is any draft path that could leave the workspace or follow a link.
var ErrUnsafePath = errors.New("unsafe draft path")

func unsafe(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrUnsafePath, fmt.Sprintf(format, args...))
}

// cleanRelative accepts only a plain relative path: no absolute path, no backslash, no empty,
// "." or ".." component, no NUL.
func cleanRelative(rel string) ([]string, error) {
	if rel == "" || strings.HasPrefix(rel, "/") || strings.ContainsAny(rel, "\\\x00") || filepath.IsAbs(rel) {
		return nil, unsafe("not a plain relative path")
	}
	parts := strings.Split(rel, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return nil, unsafe("a path component is empty, '.', '..' or too long")
		}
	}
	return parts, nil
}

// ResolveDraft returns the absolute path of rel inside the project's draft workspace after
// checking every component from the project root down with Lstat: none may be a symbolic link,
// every folder must be a folder, and the file, if it exists, must be a regular file. With create,
// missing folders are made one at a time (each checked again after it is made).
func ResolveDraft(root, rel string, create bool) (string, error) {
	if !filepath.IsAbs(root) {
		return "", unsafe("the project root is not absolute")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() {
		return "", unsafe("the project root is not a folder")
	}
	parts, err := cleanRelative(rel)
	if err != nil {
		return "", err
	}
	all := append(strings.Split(DraftDir, "/"), parts...)
	current := root
	for i, part := range all {
		current = filepath.Join(current, part)
		last := i == len(all)-1
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			if last {
				return current, nil
			}
			if !create {
				return "", unsafe("%s does not exist", strings.Join(all[:i+1], "/"))
			}
			if err := os.Mkdir(current, 0o777); err != nil && !errors.Is(err, fs.ErrExist) {
				return "", fmt.Errorf("could not make a draft folder: %w", err)
			}
			if info, err = os.Lstat(current); err != nil {
				return "", fmt.Errorf("could not check a draft folder: %w", err)
			}
		} else if err != nil {
			return "", fmt.Errorf("could not check a draft path: %w", err)
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			return "", unsafe("%s is a symbolic link", strings.Join(all[:i+1], "/"))
		}
		if last {
			if !info.Mode().IsRegular() {
				return "", unsafe("%s is not a regular file", strings.Join(all[:i+1], "/"))
			}
		} else if !info.IsDir() {
			return "", unsafe("%s is not a folder", strings.Join(all[:i+1], "/"))
		}
	}
	return current, nil
}

// WriteDraft replaces rel inside the draft workspace with data: a new temporary file opened
// without following links and created exclusively, then renamed over the target.
func WriteDraft(root, rel string, data []byte) (string, error) {
	target, err := ResolveDraft(root, rel, true)
	if err != nil {
		return "", err
	}
	random, err := randomToken()
	if err != nil {
		return "", err
	}
	temporary := filepath.Join(filepath.Dir(target), "."+filepath.Base(target)+"."+random[:12]+".tmp")
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL|noFollow, 0o666)
	if err != nil {
		return "", fmt.Errorf("could not write the draft: %w", err)
	}
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		os.Remove(temporary)
		return "", fmt.Errorf("could not write the draft: %w", err)
	}
	// Check the path once more right before the rename: nothing on it may have become a link.
	if again, err := ResolveDraft(root, rel, false); err != nil || again != target {
		os.Remove(temporary)
		if err == nil {
			err = unsafe("the draft path changed while it was being written")
		}
		return "", err
	}
	if err := os.Rename(temporary, target); err != nil {
		os.Remove(temporary)
		return "", fmt.Errorf("could not replace the draft: %w", err)
	}
	return target, nil
}

// EnsureDir makes (or checks) the folder root/components... one level at a time, refusing any
// component that is a symbolic link or not a folder. It is used for the host's own local state
// next to the draft workspace.
func EnsureDir(root string, components ...string) (string, error) {
	if !filepath.IsAbs(root) {
		return "", unsafe("the project root is not absolute")
	}
	current := root
	for i, part := range components {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "/\\\x00") {
			return "", unsafe("a folder name is not plain")
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			if err := os.Mkdir(current, 0o777); err != nil && !errors.Is(err, fs.ErrExist) {
				return "", fmt.Errorf("could not make a folder: %w", err)
			}
			info, err = os.Lstat(current)
		}
		if err != nil {
			return "", fmt.Errorf("could not check a folder: %w", err)
		}
		if info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
			return "", unsafe("%s is a symbolic link or not a folder", strings.Join(components[:i+1], "/"))
		}
	}
	return current, nil
}
