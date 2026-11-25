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

// acquireLock takes the slice's lock for the whole interview: flock on <SLICE>.lock, so another
// host on this computer knows the slice is being written. The operating system releases it when
// the process dies, so a crash never leaves it held. When another process holds it, the file is
// nil and the holder says who, from the record that process wrote.
func acquireLock(path string) (*os.File, *lockHolder, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o666)
	if err != nil {
		return nil, nil, fmt.Errorf("could not open the interview lock: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		raw, _ := io.ReadAll(io.LimitReader(file, 512))
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			holder := readHolder(raw)
			return nil, &holder, nil
		}
		return nil, nil, fmt.Errorf("could not take the interview lock: %w", err)
	}
	writeHolder(file)
	return file, nil, nil
}

// markLock writes this host into the lock file without holding the lock: after a take-over, the
// next window that looks finds this host as the writer.
func markLock(path string) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o666)
	if err != nil {
		return
	}
	defer file.Close()
	writeHolder(file)
}

func writeHolder(file *os.File) {
	file.Truncate(0)
	file.Seek(0, io.SeekStart)
	record, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "since": now()})
	file.Write(record)
	file.Sync()
}

func readHolder(raw []byte) lockHolder {
	var record struct {
		PID   int    `json:"pid"`
		Since string `json:"since"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(string(raw))), &record) != nil || record.PID <= 0 {
		// Held, by a process that left no readable record: alive, as far as anyone can tell.
		return lockHolder{Alive: true}
	}
	return lockHolder{PID: record.PID, Since: record.Since, Alive: processAlive(record.PID)}
}

// processAlive: signal 0 checks that the process exists without touching it.
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func releaseLock(file *os.File) {
	if file != nil {
		syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		file.Close()
	}
}

// lockHeld reports whether some process holds the slice's lock, without keeping it, and who.
func lockHeld(path string) (bool, lockHolder) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return false, lockHolder{}
	}
	defer file.Close()
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		raw, _ := io.ReadAll(io.LimitReader(file, 512))
		return true, readHolder(raw)
	}
	syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	return false, lockHolder{}
}

// killGroup signals the turn's whole process group.
func killGroup(pid int, sig syscall.Signal) { syscall.Kill(-pid, sig) }

func newProcessGroup() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }

var (
	sigTerm = syscall.SIGTERM
	sigKill = syscall.SIGKILL
)

func nowTime() time.Time { return time.Now().UTC() }
