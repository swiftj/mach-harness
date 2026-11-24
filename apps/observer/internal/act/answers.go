package act

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// writeAnswers writes the person's answers, as act.py reads them ([{"n", "answer"} or {"n",
// "leave_open": true}]), to a new private file in the observer's own folder: created exclusively,
// mode 0600, never through a link. The returned function removes it; the caller runs it once
// run.py has read the file, whatever run.py answered.
func writeAnswers(dir string, answers []Answer) (string, func(), error) {
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() {
		return "", func() {}, errors.New("the observer's folder is not there")
	}
	data, err := json.Marshal(answers)
	if err != nil {
		return "", func() {}, err
	}
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", func() {}, err
	}
	path := filepath.Join(dir, "answers-"+hex.EncodeToString(b)+".json")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", func() {}, err
	}
	remove := func() { os.Remove(path) }
	if _, err := f.Write(data); err != nil {
		f.Close()
		remove()
		return "", func() {}, err
	}
	if err := f.Close(); err != nil {
		remove()
		return "", func() {}, err
	}
	return path, remove, nil
}
