// Package factory reads a summary of the Factory's state straight from its files, read-only and
// without locks: whether the project has a Factory, what the machine-local policy says (never
// its secrets or who enabled it), whether a supervisor holds the lease, and how many cells,
// executions and archives exist. It runs no MACH command.
//
// The policy summary is a reading, not a decision. Whether execution is authorized is decided by
// run.py (policy.py) and nothing here should be read as overriding it.
package factory

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"mach/observer/internal/redact"
)

const maxSmallFile = 64 << 10

// Policy summarises .factory/local/runner.json.
type Policy struct {
	Present bool `json:"present"`
	// Usable is false when the file would read as disabled for a reason the observer can see:
	// a link, readable or writable by others, wrong version, malformed, another folder or machine.
	Usable     bool   `json:"usable"`
	Reason     string `json:"reason,omitempty"`
	Enabled    bool   `json:"enabled"`
	Paused     bool   `json:"paused"`
	Autonomy   string `json:"autonomy,omitempty"`
	AllowMerge bool   `json:"allow_merge"`
	MaxRisk    string `json:"max_risk,omitempty"`
	Persistent bool   `json:"persistent"`
	EnabledAt  string `json:"enabled_at,omitempty"`
	RunnerID   string `json:"runner_id,omitempty"`
	// Effective is the observer's reading: disabled, observe, supervised or paused.
	Effective string `json:"effective"`
	Note      string `json:"note"`
}

// Lease summarises .factory/local/supervisor.json.
type Lease struct {
	Present         bool    `json:"present"`
	RunnerID        string  `json:"runner_id,omitempty"`
	StartedAt       string  `json:"started_at,omitempty"`
	HeartbeatAt     string  `json:"heartbeat_at,omitempty"`
	ExpiresAt       string  `json:"expires_at,omitempty"`
	HeartbeatAgeSec float64 `json:"heartbeat_age_seconds,omitempty"`
	Expired         bool    `json:"expired"`
	SameHost        bool    `json:"same_host"`
	ProcessAlive    *bool   `json:"process_alive,omitempty"` // only known on the same host
	Live            bool    `json:"live"`
}

// Counts are what exists on disk.
type Counts struct {
	Cells              int   `json:"cells"`
	CellsWithLifecycle int   `json:"cells_with_lifecycle"`
	Executions         int   `json:"executions"`
	Archives           int   `json:"archives"`
	RunsLog            bool  `json:"runs_log"`
	Ledger             bool  `json:"ledger"`
	EventsLogBytes     int64 `json:"events_log_bytes"`
}

// Report is the factory part of /api/v1/factory/status.
type Report struct {
	Project struct {
		Folder string `json:"folder"`
		Path   string `json:"path"`
	} `json:"project"`
	FactoryPresent bool   `json:"factory_present"`
	Policy         Policy `json:"policy"`
	Lease          Lease  `json:"lease"`
	Counts         Counts `json:"counts"`
	ReadAt         string `json:"read_at"`
}

// Read builds the report.
func Read(root string, now time.Time) Report {
	var r Report
	r.Project.Folder = filepath.Base(root)
	r.Project.Path = root
	r.ReadAt = now.UTC().Format(time.RFC3339)
	r.FactoryPresent = realDir(filepath.Join(root, ".factory"))
	r.Policy = readPolicy(root)
	r.Lease = readLease(root, now)
	if r.FactoryPresent {
		r.Counts = count(root)
	}
	return r
}

func realDir(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir()
}

// readSmall reads a regular file of at most maxSmallFile bytes without following a link.
func readSmall(path string) ([]byte, fs.FileMode, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() {
		return nil, info.Mode(), errors.New("not a regular file")
	}
	f, err := openNoFollow(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxSmallFile+1))
	if err != nil {
		return nil, 0, err
	}
	if len(data) > maxSmallFile {
		return nil, 0, errors.New("too large")
	}
	return data, info.Mode(), nil
}

func readPolicy(root string) Policy {
	p := Policy{Effective: "disabled", Note: "A summary read from the file. Whether execution is authorized is decided by MACH's run skill, not by the observer."}
	path := filepath.Join(root, ".factory", "local", "runner.json")
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		p.Reason = "missing"
		return p
	}
	p.Present = true
	if err != nil {
		p.Reason = "unreadable"
		return p
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		p.Reason = "symlink"
		return p
	}
	data, mode, err := readSmall(path)
	if err != nil {
		p.Reason = "unreadable"
		return p
	}
	if mode.Perm()&0o077 != 0 {
		p.Reason = "shared-permissions"
		return p
	}
	var raw struct {
		SchemaVersion int    `json:"schema_version"`
		Enabled       bool   `json:"enabled"`
		Paused        bool   `json:"paused"`
		Autonomy      string `json:"autonomy"`
		AllowMerge    bool   `json:"allow_merge"`
		MaxRisk       string `json:"max_risk"`
		Persistent    bool   `json:"persistent"`
		EnabledAt     string `json:"enabled_at"`
		RunnerID      string `json:"runner_id"`
		ProjectRoot   string `json:"project_root"`
		Machine       any    `json:"machine"`
	}
	if json.Unmarshal(data, &raw) != nil {
		p.Reason = "malformed"
		return p
	}
	if raw.SchemaVersion != 2 {
		p.Reason = "wrong-version"
		return p
	}
	if raw.ProjectRoot == "" || !samePath(raw.ProjectRoot, root) {
		p.Reason = "another-folder"
		return p
	}
	if host, err := os.Hostname(); err == nil && !machineMatches(raw.Machine, host) {
		p.Reason = "another-machine"
		return p
	}
	p.Usable = true
	p.Enabled, p.Paused, p.AllowMerge, p.Persistent = raw.Enabled, raw.Paused, raw.AllowMerge, raw.Persistent
	p.Autonomy, _ = redact.Token(raw.Autonomy)
	p.MaxRisk, _ = redact.ID(raw.MaxRisk)
	p.RunnerID, _ = redact.ID(raw.RunnerID)
	if _, err := time.Parse(time.RFC3339, raw.EnabledAt); err == nil {
		p.EnabledAt = raw.EnabledAt
	}
	switch {
	case !p.Enabled:
		p.Effective = "disabled"
	case p.Paused:
		p.Effective = "paused"
	case p.Autonomy == "supervised":
		p.Effective = "supervised"
	default:
		p.Effective = "observe"
	}
	return p
}

// machineMatches: the policy names the machine by its node name (platform.node() in policy.py).
func machineMatches(machine any, host string) bool {
	m, ok := machine.(string)
	return ok && m == host
}

// samePath compares two folders after resolving links (macOS's /tmp is /private/tmp).
func samePath(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	return errA == nil && errB == nil && ra == rb
}

func readLease(root string, now time.Time) Lease {
	var l Lease
	data, _, err := readSmall(filepath.Join(root, ".factory", "local", "supervisor.json"))
	if err != nil {
		return l
	}
	var raw struct {
		RunnerID    string `json:"runner_id"`
		PID         int    `json:"pid"`
		Host        string `json:"host"`
		StartedAt   string `json:"started_at"`
		HeartbeatAt string `json:"heartbeat_at"`
		ExpiresAt   string `json:"expires_at"`
	}
	if json.Unmarshal(data, &raw) != nil {
		return l
	}
	l.Present = true
	l.RunnerID, _ = redact.ID(raw.RunnerID)
	if t, ok := parseStamp(raw.StartedAt); ok {
		l.StartedAt = t.Format(time.RFC3339)
	}
	if t, ok := parseStamp(raw.HeartbeatAt); ok {
		l.HeartbeatAt = t.Format(time.RFC3339)
		l.HeartbeatAgeSec = now.Sub(t).Seconds()
	}
	expires, ok := parseStamp(raw.ExpiresAt)
	if ok {
		l.ExpiresAt = expires.Format(time.RFC3339)
	}
	l.Expired = !ok || now.After(expires)
	host, _ := os.Hostname()
	l.SameHost = raw.Host != "" && raw.Host == host
	if l.SameHost && raw.PID > 0 {
		alive := pidAlive(raw.PID)
		l.ProcessAlive = &alive
	}
	l.Live = !l.Expired && (!l.SameHost || (l.ProcessAlive != nil && *l.ProcessAlive))
	return l
}

func parseStamp(s string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

func count(root string) Counts {
	var c Counts
	if entries, err := readDirIfReal(filepath.Join(root, ".factory", "worktrees")); err == nil {
		for _, e := range entries {
			if !e.IsDir() || e.Type()&fs.ModeSymlink != 0 {
				continue
			}
			if _, ok := redact.ID(e.Name()); !ok {
				continue
			}
			c.Cells++
			if info, err := os.Lstat(filepath.Join(root, ".factory", "worktrees", e.Name(), "lifecycle.jsonl")); err == nil && info.Mode().IsRegular() {
				c.CellsWithLifecycle++
			}
		}
	}
	if entries, err := readDirIfReal(filepath.Join(root, ".factory", "local", "executions")); err == nil {
		for _, e := range entries {
			if e.IsDir() && e.Type()&fs.ModeSymlink == 0 {
				c.Executions++
			}
		}
	}
	if entries, err := readDirIfReal(filepath.Join(root, ".factory", "archive")); err == nil {
		for _, e := range entries {
			switch {
			case e.Type().IsRegular() && strings.HasSuffix(e.Name(), ".tar.gz"):
				c.Archives++
			case e.Type().IsRegular() && e.Name() == "runs.jsonl":
				c.RunsLog = true
			}
		}
	}
	if info, err := os.Lstat(filepath.Join(root, ".factory", "intake", "ledger.json")); err == nil && info.Mode().IsRegular() {
		c.Ledger = true
	}
	if info, err := os.Lstat(filepath.Join(root, ".factory", "intake", "events.jsonl")); err == nil && info.Mode().IsRegular() {
		c.EventsLogBytes = info.Size()
	}
	return c
}

func readDirIfReal(path string) ([]os.DirEntry, error) {
	if !realDir(path) {
		return nil, fs.ErrNotExist
	}
	return os.ReadDir(path)
}
