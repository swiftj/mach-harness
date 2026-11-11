package interview

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// MaxHistoryBytes caps one slice's saved history. Past it, the oldest half is dropped and the
// history says it was shortened.
var MaxHistoryBytes = 1 << 20

// HistoryEvent is one saved interview event: the same normalised event the browser receives,
// never Claude Code's own stream. Streamed text and thinking/working states are not kept; the
// final message of every turn is.
type HistoryEvent struct {
	At          string          `json:"at"`
	InterviewID string          `json:"interview_id"`
	Name        string          `json:"event"`
	Data        json.RawMessage `json:"data"`
}

const truncatedMarker = "history_truncated"

// kept says whether an event belongs in the saved history.
func kept(name string, data any) bool {
	switch name {
	case "text":
		return false
	case "state":
		if m, ok := data.(map[string]any); ok {
			switch m["state"] {
			case "starting", "waiting_for_reply", "ended":
				return true
			}
		}
		return false
	}
	return true
}

func (c *Claude) historyPath(sliceID string) string {
	return filepath.Join(c.paths.Home, sliceID+".events.jsonl")
}

// appendHistory adds one event to the slice's history file, without following links.
func (c *Claude) appendHistory(sliceID, interviewID, name string, data any) {
	if !kept(name, data) {
		return
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return
	}
	line, _ := json.Marshal(HistoryEvent{At: now(), InterviewID: interviewID, Name: name, Data: raw})
	path := c.historyPath(sliceID)
	if info, err := os.Lstat(path); err == nil && info.Mode()&fs.ModeSymlink != 0 {
		return
	} else if err == nil && info.Size()+int64(len(line)) > int64(MaxHistoryBytes) {
		c.trimHistory(path)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE|syscall.O_NOFOLLOW, 0o666)
	if err != nil {
		return
	}
	file.Write(append(line, '\n'))
	file.Close()
}

// trimHistory keeps the newest lines that fit in half the cap, after a marker.
func (c *Claude) trimHistory(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	lines := bytes.Split(bytes.TrimRight(data, "\n"), []byte("\n"))
	size, start := 0, len(lines)
	for start > 0 && size+len(lines[start-1])+1 <= MaxHistoryBytes/2 {
		start--
		size += len(lines[start]) + 1
	}
	marker, _ := json.Marshal(HistoryEvent{At: now(), Name: truncatedMarker, Data: json.RawMessage("{}")})
	out := append(append(marker, '\n'), bytes.Join(lines[start:], []byte("\n"))...)
	tmp := path + ".tmp"
	if os.WriteFile(tmp, append(out, '\n'), 0o666) == nil {
		os.Rename(tmp, path)
	}
}

// History reads a slice's saved interview events, oldest first, and whether older ones were
// dropped to keep it within MaxHistoryBytes.
func (c *Claude) History(sliceID string) ([]HistoryEvent, bool, error) {
	path := c.historyPath(sliceID)
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return []HistoryEvent{}, false, nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return nil, false, errors.New("the interview history cannot be read")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, false, err
	}
	defer file.Close()
	events := []HistoryEvent{}
	truncated := false
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), MaxHistoryBytes+1<<20)
	for scanner.Scan() {
		var ev HistoryEvent
		if json.Unmarshal(scanner.Bytes(), &ev) != nil || ev.Name == "" {
			continue
		}
		if ev.Name == truncatedMarker {
			truncated = true
			continue
		}
		events = append(events, ev)
	}
	return events, truncated, nil
}
