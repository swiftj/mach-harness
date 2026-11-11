//go:build unix

package interview

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"
)

// supported: process groups and flock exist here.
const supported = true

// acquireLock takes the slice's lock for the whole interview: flock on <SLICE>.lock, the same
// lock the terminal prototype takes, so another host or a terminal interview is refused too. The
// operating system releases it when the process dies, so a crash never leaves it held.
func acquireLock(path, sliceID string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o666)
	if err != nil {
		return nil, fmt.Errorf("could not open the interview lock: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		holder, _ := io.ReadAll(io.LimitReader(file, 512))
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, &ConflictError{Message: sliceID + " already has an interview running" + describeHolder(holder) + "."}
		}
		return nil, fmt.Errorf("could not take the interview lock: %w", err)
	}
	file.Truncate(0)
	file.Seek(0, io.SeekStart)
	record, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "since": now()})
	file.Write(record)
	file.Sync()
	return file, nil
}

func describeHolder(raw []byte) string {
	var holder struct {
		PID   int    `json:"pid"`
		Since string `json:"since"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(string(raw))), &holder) == nil && holder.PID > 0 {
		return fmt.Sprintf(" (process %d, since %s)", holder.PID, holder.Since)
	}
	return ""
}

func releaseLock(file *os.File) {
	if file != nil {
		syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		file.Close()
	}
}

// lockHeld reports whether some process holds the slice's lock, without keeping it.
func lockHeld(path string) bool {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return false
	}
	defer file.Close()
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return true
	}
	syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	return false
}

// killGroup signals the turn's whole process group.
func killGroup(pid int, sig syscall.Signal) { syscall.Kill(-pid, sig) }

func newProcessGroup() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }

var (
	sigTerm = syscall.SIGTERM
	sigKill = syscall.SIGKILL
)

func nowTime() time.Time { return time.Now().UTC() }
