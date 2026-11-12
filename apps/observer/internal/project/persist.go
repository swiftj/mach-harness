package project

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// The saved projection lives in the observer's own folder (.factory/local/observer/projection/),
// never anywhere else. It is a cache: deleting it costs a replay, nothing more. Read with a size
// cap and without following a link; written to a temporary file in the same folder, synced, and
// renamed over the old one, so a crash leaves the old file or the new one, never half of either.

const projectionFile = "projection.json"

// maxSaved bounds what is read back.
const maxSaved = 256 << 20

func loadSaved(dir string) (*State, error) {
	if dir == "" {
		return nil, nil
	}
	path := filepath.Join(dir, projectionFile)
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxSaved {
		return nil, errors.New("the saved projection is not a regular file of a sane size")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxSaved+1))
	if err != nil {
		return nil, err
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, nil // unreadable: replay instead
	}
	s.fill()
	return &s, nil
}

func saveProjection(dir string, data []byte) error {
	tmp, err := os.CreateTemp(dir, "."+projectionFile+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(dir, projectionFile))
}
