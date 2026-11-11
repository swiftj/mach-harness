package interview

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"mach/studio/internal/security"
)

// Config fixes how interviews run for one project. Everything is resolved at start-up.
type Config struct {
	Project     string        // the project's real path
	Python      string        // the host's interpreter (absolute)
	Script      string        // studio.py (absolute)
	Claude      string        // the claude binary (absolute); "" when not found
	Model       string        // "" for the person's own default
	BudgetUSD   float64       // spending cap per turn; default 2
	TurnTimeout time.Duration // time limit per turn; default 600 s
	KillGrace   time.Duration // between SIGTERM and SIGKILL; default 5 s
	HostEnv     []string      // the host's environment, filtered down by Environment
	ReadDirs    []string      // skill folders outside the project to read (ReadDirsFromWhere)
	Logger      *log.Logger
}

// Claude is the real bridge.
type Claude struct {
	cfg     Config
	paths   Paths
	env     []string
	command string

	capMu sync.Mutex
	cap   Capability

	mu       sync.Mutex
	sessions map[string]*session // by interview ID
	bySlice  map[string]*session // live ones only
	closing  bool
}

// New prepares the bridge: fixed paths and the interpreter names the allow rules need. It does
// not touch the project until an interview starts.
func New(cfg Config) (*Claude, error) {
	if cfg.BudgetUSD <= 0 {
		cfg.BudgetUSD = 2
	}
	if cfg.TurnTimeout <= 0 {
		cfg.TurnTimeout = 600 * time.Second
	}
	if cfg.KillGrace <= 0 {
		cfg.KillGrace = 5 * time.Second
	}
	if cfg.Logger == nil {
		cfg.Logger = log.New(io.Discard, "", 0)
	}
	realScript, err := filepath.EvalSymlinks(cfg.Script)
	if err != nil {
		return nil, fmt.Errorf("the engine script cannot be resolved: %w", err)
	}
	home := filepath.Join(cfg.Project, ".factory", "studio", "interviews")
	plugin := filepath.Join(home, "plugin")
	link := filepath.Join(plugin, "skills", "product-studio", "scripts", "studio.py")
	p := Paths{
		Project:    cfg.Project,
		Draft:      filepath.Join(cfg.Project, ".factory", "studio", "draft"),
		Home:       home,
		PluginDir:  plugin,
		SkillDir:   filepath.Dir(filepath.Dir(realScript)),
		LinkScript: link,
		RealScript: realScript,
		Pythons:    interpreters(cfg.Python),
	}
	p.Scripts = []string{link, realScript}
	p.ReadDirs = cfg.ReadDirs
	sort.Strings(p.Scripts)
	c := &Claude{cfg: cfg, paths: p, env: Environment(cfg.HostEnv), command: ContinueCommandFor(cfg.Script),
		sessions: map[string]*session{}, bySlice: map[string]*session{}}
	return c, nil
}

// ReadDirsFromWhere turns the engine's `where` report into the folders the interviewer must read:
// the folder of each file `where` names (the interview method, the templates, the spec rules),
// taken at the skill's level, that lies outside the project. The engine says where they are;
// the host does not name another skill.
func ReadDirsFromWhere(where json.RawMessage, project string) []string {
	var report struct {
		InterviewMethod string   `json:"interview_method"`
		SliceTemplate   string   `json:"slice_template"`
		SpecRules       []string `json:"spec_rules"`
		IntentTemplate  string   `json:"intent_template"`
	}
	if json.Unmarshal(where, &report) != nil {
		return nil
	}
	seen := map[string]bool{}
	var dirs []string
	for _, file := range append([]string{report.InterviewMethod, report.SliceTemplate, report.IntentTemplate}, report.SpecRules...) {
		if file == "" || !filepath.IsAbs(file) {
			continue
		}
		skill := filepath.Dir(filepath.Dir(file)) // <skill>/references/x.md or <skill>/assets/x.md
		if real, err := filepath.EvalSymlinks(skill); err == nil {
			skill = real
		}
		if seen[skill] || skill == project || strings.HasPrefix(skill, project+string(filepath.Separator)) {
			continue
		}
		seen[skill] = true
		dirs = append(dirs, skill)
	}
	sort.Strings(dirs)
	return dirs
}

// interpreters: "python3" as the skill types it, plus the absolute interpreter it resolves to.
func interpreters(python string) []string {
	names := []string{"python3"}
	add := func(name string) {
		for _, n := range names {
			if n == name {
				return
			}
		}
		names = append(names, name)
	}
	if python != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, python, "-I", "-c", "import sys; print(sys.executable)").Output()
		if err == nil && strings.TrimSpace(string(out)) != "" {
			add(strings.TrimSpace(string(out)))
		}
	}
	return names
}

// Paths exposes the fixed paths (for tests and the README's examples).
func (c *Claude) Paths() Paths { return c.paths }

// Available is cached for five minutes; the checks spend nothing.
func (c *Claude) Available() (bool, string) {
	if !supported {
		return false, "The guided interview needs macOS or Linux. Continue the interview in Claude Code."
	}
	c.capMu.Lock()
	defer c.capMu.Unlock()
	if c.cap.CheckedAt.IsZero() || time.Since(c.cap.CheckedAt) > 5*time.Minute {
		c.cap = CheckClaude(context.Background(), c.cfg.Claude, c.cfg.Project, c.env)
	}
	if c.cap.OK {
		return true, ""
	}
	return false, c.cap.Reason + " You can continue the interview in Claude Code: " + c.command + " SLICE-NNN."
}

func (c *Claude) ContinueCommand() string { return c.command }

// ---- session state ----

type record struct {
	SliceID        string   `json:"slice_id"`
	SessionID      string   `json:"session_id"`
	Turns          int      `json:"turns"`
	SessionCostUSD float64  `json:"session_cost_usd"`
	Created        string   `json:"created"`
	Updated        string   `json:"updated,omitempty"`
	LastMessage    *Message `json:"last_message,omitempty"`
}

type session struct {
	c       *Claude
	id      string
	sliceID string
	lock    *os.File

	mu         sync.Mutex
	rec        record
	state      string
	seq        int64
	turnEvents []Event
	lastFinal  []Event
	pending    []Event // message and question of the turn in progress
	subs       map[int]chan Event
	nextSub    int
	running    *turnProc
	ended      bool
}

type turnProc struct {
	cmd         *exec.Cmd
	interrupted atomic.Bool
	timedOut    atomic.Bool
	done        chan struct{}
}

func (s *session) emit(name string, data any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.emitLocked(name, data)
}

func (s *session) emitLocked(name string, data any) {
	s.c.appendHistory(s.sliceID, s.id, name, data)
	s.seq++
	ev := Event{Seq: s.seq, Name: name, Data: data}
	s.turnEvents = append(s.turnEvents, ev)
	if name == "message" || name == "question" {
		s.pending = append(s.pending, ev)
	}
	if name == "state" {
		if m, ok := data.(map[string]any); ok {
			if state, ok := m["state"].(string); ok {
				s.state = state
			}
		}
	}
	for key, ch := range s.subs {
		select {
		case ch <- ev:
		default: // too far behind: it reconnects with its last id and is replayed
			close(ch)
			delete(s.subs, key)
		}
	}
}

// newTurn starts a fresh replay window: the last final message stays, the rest is this turn's.
func (s *session) newTurnLocked() {
	if len(s.pending) > 0 {
		s.lastFinal, s.pending = s.pending, nil
	}
	s.turnEvents = nil
}

func (c *Claude) recordPath(sliceID string) string {
	return filepath.Join(c.paths.Home, sliceID+".json")
}
func (c *Claude) lockPath(sliceID string) string { return filepath.Join(c.paths.Home, sliceID+".lock") }

func (c *Claude) loadRecord(sliceID string) *record {
	raw, err := os.ReadFile(c.recordPath(sliceID))
	if err != nil {
		return nil
	}
	var r record
	if json.Unmarshal(raw, &r) != nil || r.SessionID == "" || r.SliceID != sliceID {
		return nil
	}
	return &r
}

func (c *Claude) saveRecord(r record) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	path := c.recordPath(r.SliceID)
	tmp := strings.TrimSuffix(path, ".json") + ".tmp"
	if err := os.WriteFile(tmp, data, 0o666); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// prepare makes the interviews folder and the stable one-skill plugin (POC section 4.4): its
// path never changes, because a resumed session keeps using the skill folder it recorded.
func (c *Claude) prepare() error {
	if _, err := security.EnsureDir(c.cfg.Project, ".factory", "studio", "interviews", "plugin", ".claude-plugin"); err != nil {
		return err
	}
	if _, err := security.EnsureDir(c.cfg.Project, ".factory", "studio", "interviews", "plugin", "skills"); err != nil {
		return err
	}
	manifest := filepath.Join(c.paths.PluginDir, ".claude-plugin", "plugin.json")
	want := []byte(`{"name": "mach", "version": "0.0.0-interviewer", "description": "Product Studio interviewer"}`)
	if have, err := os.ReadFile(manifest); err != nil || string(have) != string(want) {
		if info, err := os.Lstat(manifest); err == nil && !info.Mode().IsRegular() {
			return errors.New("the interviewer plugin's manifest is not a regular file")
		}
		if err := os.WriteFile(manifest, want, 0o666); err != nil {
			return err
		}
	}
	link := filepath.Join(c.paths.PluginDir, "skills", "product-studio")
	info, err := os.Lstat(link)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return err
	case info.Mode()&fs.ModeSymlink == 0:
		return errors.New("the interviewer plugin's skill entry is not a link; remove " + link)
	default:
		if target, _ := os.Readlink(link); target == c.paths.SkillDir {
			return nil
		}
		if err := os.Remove(link); err != nil {
			return err
		}
	}
	return os.Symlink(c.paths.SkillDir, link)
}

func randomID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func newUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// ---- the routes' operations ----

// Start takes the slice's lock for the whole interview, then either replays the saved last
// message (no turn, nothing spent) or runs the opening turn.
func (c *Claude) Start(ctx context.Context, req StartRequest) (Started, error) {
	if ok, reason := c.Available(); !ok {
		return Started{}, &unavailable{reason}
	}
	c.mu.Lock()
	if c.closing {
		c.mu.Unlock()
		return Started{}, &unavailable{"Product Studio is shutting down."}
	}
	if s := c.bySlice[req.SliceID]; s != nil {
		c.mu.Unlock()
		return Started{}, &ConflictError{Message: req.SliceID + " already has an interview running in this window. Open it instead."}
	}
	c.mu.Unlock()

	if err := c.prepare(); err != nil {
		return Started{}, err
	}
	lock, err := acquireLock(c.lockPath(req.SliceID), req.SliceID)
	if err != nil {
		return Started{}, err
	}
	rec := c.loadRecord(req.SliceID)
	resumed := rec != nil
	if rec == nil {
		rec = &record{SliceID: req.SliceID, SessionID: newUUID(), Created: now()}
		if err := c.saveRecord(*rec); err != nil {
			releaseLock(lock)
			return Started{}, err
		}
	}
	s := &session{c: c, id: randomID(), sliceID: req.SliceID, lock: lock, rec: *rec, subs: map[int]chan Event{}}
	c.mu.Lock()
	if c.closing || c.bySlice[req.SliceID] != nil {
		c.mu.Unlock()
		releaseLock(lock)
		return Started{}, &ConflictError{Message: req.SliceID + " already has an interview running."}
	}
	c.sessions[s.id], c.bySlice[req.SliceID] = s, s
	c.mu.Unlock()

	s.mu.Lock()
	s.newTurnLocked()
	s.emitLocked("state", map[string]any{"state": "starting", "slice_id": req.SliceID, "resumed": resumed})
	last := rec.LastMessage
	if resumed && last != nil && last.Text != "" {
		// Show the question the PM was answering; their reply resumes the same Claude session.
		s.emitMessageLocked(*last)
		s.lastFinal, s.pending = s.pending, nil
		s.emitLocked("state", map[string]any{"state": "waiting_for_reply"})
		s.mu.Unlock()
		return Started{InterviewID: s.id, SliceID: req.SliceID, Resumed: true}, nil
	}
	message := "I'm back. Let's continue."
	if rec.Turns == 0 {
		// Inside the interviewer the one-skill plugin is always named mach, whatever the install.
		message = "/mach:product-studio continue " + req.SliceID
		if req.Idea != "" {
			epic := req.EpicID
			if epic == "" {
				epic = "its epic"
			}
			message += ". The app just created it in " + epic + " for this idea from the product manager: " + req.Idea
		}
	}
	err = s.startTurnLocked(message)
	s.mu.Unlock()
	if err != nil {
		return Started{}, err
	}
	return Started{InterviewID: s.id, SliceID: req.SliceID, Resumed: resumed}, nil
}

func (s *session) emitMessageLocked(m Message) {
	s.emitLocked("message", map[string]any{"message_id": m.MessageID, "text": m.Text, "kind": m.Kind})
	if m.Kind == "question" {
		if q := ParseQuestion(m.Text); q != nil {
			q.MessageID = m.MessageID
			s.emitLocked("question", q)
		}
	}
}

type unavailable struct{ reason string }

func (u *unavailable) Error() string { return u.reason }
func (u *unavailable) Unwrap() error { return ErrUnavailable }

// UnavailableReason returns the plain reason behind an unavailable error.
func UnavailableReason(err error) string {
	var u *unavailable
	if errors.As(err, &u) {
		return u.reason
	}
	return ""
}

func (c *Claude) find(id string) (*session, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.sessions[id]
	if s == nil {
		return nil, ErrNotFound
	}
	return s, nil
}

func (c *Claude) Current(sliceID string) (*Current, error) {
	c.mu.Lock()
	s := c.bySlice[sliceID]
	c.mu.Unlock()
	if s != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		id := s.id
		return &Current{InterviewID: &id, SliceID: sliceID, Live: true, State: s.state, TurnRunning: s.running != nil,
			LastMessage: withQuestion(s.rec.LastMessage), Turns: s.rec.Turns, SessionCostUSD: s.rec.SessionCostUSD}, nil
	}
	rec := c.loadRecord(sliceID)
	held := lockHeld(c.lockPath(sliceID))
	if rec == nil && !held {
		return nil, nil
	}
	cur := &Current{SliceID: sliceID, State: "saved", LockedElsewhere: held}
	if rec != nil {
		cur.LastMessage, cur.Turns, cur.SessionCostUSD = withQuestion(rec.LastMessage), rec.Turns, rec.SessionCostUSD
	}
	return cur, nil
}

func withQuestion(m *Message) *Message {
	if m == nil || m.Kind != "question" || m.Question != nil {
		return m
	}
	copy := *m
	if q := ParseQuestion(m.Text); q != nil {
		q.MessageID = m.MessageID
		copy.Question = q
	}
	return &copy
}

func (c *Claude) Subscribe(id string, after int64) ([]Event, <-chan Event, func(), error) {
	s, err := c.find(id)
	if err != nil {
		return nil, nil, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := map[int64]bool{}
	var replay []Event
	for _, ev := range append(append([]Event{}, s.lastFinal...), s.turnEvents...) {
		if ev.Seq > after && !seen[ev.Seq] {
			seen[ev.Seq] = true
			replay = append(replay, ev)
		}
	}
	sort.Slice(replay, func(i, j int) bool { return replay[i].Seq < replay[j].Seq })
	ch := make(chan Event, 512)
	if s.ended {
		close(ch)
		return replay, ch, func() {}, nil
	}
	key := s.nextSub
	s.nextSub++
	s.subs[key] = ch
	cancel := func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if existing, ok := s.subs[key]; ok {
			delete(s.subs, key)
			close(existing)
		}
	}
	return replay, ch, cancel, nil
}

func (c *Claude) Reply(ctx context.Context, id, text string) error {
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.ended:
		return &ConflictError{Message: "This interview has ended. Start it again to continue."}
	case s.running != nil:
		return &ConflictError{Message: "The interviewer is still working on its reply. Wait for it, or interrupt it."}
	}
	s.newTurnLocked()
	s.emitLocked("reply", map[string]any{"text": text}) // the PM's own words, for the history and other windows
	return s.startTurnLocked(UserMessage(text))
}

func (c *Claude) Interrupt(ctx context.Context, id string) error {
	s, err := c.find(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	tp := s.running
	s.mu.Unlock()
	if tp == nil {
		return &ConflictError{Message: "The interviewer is not working on anything to interrupt."}
	}
	c.stopTurn(tp, true)
	select {
	case <-tp.done:
	case <-ctx.Done():
	}
	return nil
}

func (c *Claude) Stop(ctx context.Context, id string) error {
	s, err := c.find(id)
	if err != nil {
		return err
	}
	c.end(ctx, s, "stopped")
	return nil
}

func (c *Claude) Busy(sliceID string) bool {
	c.mu.Lock()
	s := c.bySlice[sliceID]
	c.mu.Unlock()
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running != nil
}

// Shutdown ends every live interview with reason host_shutdown, stopping running turns first.
func (c *Claude) Shutdown(ctx context.Context) {
	c.mu.Lock()
	c.closing = true
	live := make([]*session, 0, len(c.bySlice))
	for _, s := range c.bySlice {
		live = append(live, s)
	}
	c.mu.Unlock()
	var wg sync.WaitGroup
	for _, s := range live {
		wg.Add(1)
		go func(s *session) { defer wg.Done(); c.end(ctx, s, "host_shutdown") }(s)
	}
	wg.Wait()
}

func (c *Claude) end(ctx context.Context, s *session, reason string) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return
	}
	s.ended = true // no new turn can start
	tp := s.running
	s.mu.Unlock()
	if tp != nil {
		c.stopTurn(tp, true)
		select {
		case <-tp.done:
		case <-ctx.Done():
			killGroup(tp.cmd.Process.Pid, sigKill)
			<-tp.done
		}
	}
	s.mu.Lock()
	s.emitLocked("ended", map[string]any{"reason": reason})
	s.emitLocked("state", map[string]any{"state": "ended"})
	for key, ch := range s.subs {
		close(ch)
		delete(s.subs, key)
	}
	releaseLock(s.lock)
	s.lock = nil
	s.mu.Unlock()
	c.mu.Lock()
	if c.bySlice[s.sliceID] == s {
		delete(c.bySlice, s.sliceID)
	}
	c.mu.Unlock()
}

// stopTurn sends SIGTERM to the turn's process group, then SIGKILL after the grace period.
func (c *Claude) stopTurn(tp *turnProc, interrupted bool) {
	if interrupted {
		tp.interrupted.Store(true)
	}
	pid := tp.cmd.Process.Pid
	killGroup(pid, sigTerm)
	go func() {
		select {
		case <-tp.done:
		case <-time.After(c.cfg.KillGrace):
			killGroup(pid, sigKill)
		}
	}()
}

// ---- one turn ----

// snapshot hashes every regular file in the draft workspace.
func (c *Claude) snapshot() map[string]string {
	state := map[string]string{}
	filepath.WalkDir(c.paths.Draft, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Type()&fs.ModeSymlink != 0 || !d.Type().IsRegular() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(c.paths.Draft, path)
		sum := sha256.Sum256(data)
		state[filepath.ToSlash(rel)] = hex.EncodeToString(sum[:])
		return nil
	})
	return state
}

// startTurnLocked spawns one `claude -p` process and reads its stream in the background.
func (s *session) startTurnLocked(message string) error {
	c := s.c
	resume := s.rec.Turns > 0
	args := c.paths.Args(s.sliceID, TurnOptions{BudgetUSD: c.cfg.BudgetUSD, Model: c.cfg.Model, SessionID: s.rec.SessionID, Resume: resume}, message)
	cmd := exec.Command(c.cfg.Claude, args...)
	cmd.Dir = c.cfg.Project
	cmd.Env = c.env
	cmd.Stdin = nil
	cmd.Stderr = nil // discarded: it can hold anything, and nothing of it is shown or logged
	cmd.SysProcAttr = newProcessGroup()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	s.emitLocked("state", map[string]any{"state": "thinking"})
	if err := cmd.Start(); err != nil {
		s.emitLocked("error", map[string]any{"kind": "no_result", "message": "Claude Code could not be started."})
		s.emitLocked("turn", map[string]any{"outcome": "failed", "seconds": 0.0, "cost_usd": nil, "session_cost_usd": nil, "refused": 0})
		s.emitLocked("state", map[string]any{"state": "waiting_for_reply"})
		c.cfg.Logger.Printf("interview %s: claude could not be started", s.sliceID)
		return nil
	}
	tp := &turnProc{cmd: cmd, done: make(chan struct{})}
	s.running = tp
	go s.readTurn(tp, stdout)
	return nil
}

func (s *session) readTurn(tp *turnProc, stdout io.Reader) {
	c := s.c
	started := time.Now()
	watchdog := time.AfterFunc(c.cfg.TurnTimeout, func() {
		tp.timedOut.Store(true)
		c.stopTurn(tp, false)
	})
	parser := newTurnParser(c.paths, s.sliceID, s.emit, c.snapshot)
	reader := bufio.NewReaderSize(stdout, 64<<10)
	for {
		line, err := readLine(reader, 64<<20)
		if len(line) > 0 {
			parser.line(line)
		}
		if err != nil {
			break
		}
	}
	io.Copy(io.Discard, stdout)
	tp.cmd.Wait()
	watchdog.Stop()

	s.mu.Lock()
	defer s.mu.Unlock()
	s.rec.Turns++
	turnCost, sessionCost := parser.costs(s.rec.SessionCostUSD)
	if sessionCost != nil {
		s.rec.SessionCostUSD = *sessionCost
	}
	s.rec.Updated = now()

	res := parser.result
	id, final := parser.final()
	outcome := "replied"
	interrupted := tp.interrupted.Load()
	switch {
	case tp.timedOut.Load():
		outcome = "timed_out"
		s.emitLocked("error", map[string]any{"kind": "timed_out", "message": "The interviewer took too long and was stopped."})
	case interrupted:
		outcome = "interrupted"
	case res == nil:
		outcome = "failed"
		s.emitLocked("error", map[string]any{"kind": "no_result", "message": "The interviewer stopped without finishing its reply."})
	case res.IsError:
		outcome = res.Subtype
		if outcome == "" {
			outcome = "error"
		}
		message := "The interviewer could not finish this reply."
		if outcome == "error_max_budget_usd" {
			message = "This turn reached its spending limit."
		}
		s.emitLocked("error", map[string]any{"kind": outcome, "message": message})
	default:
		if final != "" {
			m := Message{MessageID: id, Text: final, Kind: ClassifyMessage(final)}
			s.emitMessageLocked(m)
			s.rec.LastMessage = &Message{MessageID: id, Text: final, Kind: m.Kind}
		}
	}
	if err := c.saveRecord(s.rec); err != nil {
		c.cfg.Logger.Printf("interview %s: the session record could not be saved", s.sliceID)
	}
	refused := 0
	if res != nil {
		refused = len(res.Denials)
	}
	s.emitLocked("turn", map[string]any{"outcome": outcome, "seconds": float64(time.Since(started).Round(100*time.Millisecond).Milliseconds()) / 1000,
		"cost_usd": turnCost, "session_cost_usd": sessionCost, "refused": refused})
	c.cfg.Logger.Printf("interview %s: turn %d %s", s.sliceID, s.rec.Turns, outcome)
	s.running = nil
	close(tp.done)
	if !s.ended {
		s.emitLocked("state", map[string]any{"state": "waiting_for_reply"})
	}
}

// readLine reads one line; a line longer than max is skipped whole (file contents echoed back can
// be large, and the host does not need them).
func readLine(r *bufio.Reader, max int) ([]byte, error) {
	var line []byte
	tooLong := false
	for {
		chunk, isPrefix, err := r.ReadLine()
		if !tooLong {
			if len(line)+len(chunk) > max {
				tooLong, line = true, nil
			} else {
				line = append(line, chunk...)
			}
		}
		if err != nil {
			return line, err
		}
		if !isPrefix {
			if tooLong {
				return nil, nil
			}
			return line, nil
		}
	}
}
