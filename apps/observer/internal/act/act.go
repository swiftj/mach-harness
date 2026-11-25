// Package act is the only place in the observer that starts a process. It runs MACH's own run.py
// with a fixed argument vector for each of four requests, and nothing else:
//
//	python3 -I -B <run.py> --project=<root> decide --json                     (Needs: reads only)
//	python3 -I -B <run.py> --project=<root> decide do <ticket> <option> ... --via=floor --json
//	python3 -I -B <run.py> --project=<root> factory status                      (Status: reads only)
//	python3 -I -B <run.py> --project=<root> factory stop                        (Stop)
//
// Every value a person gives is passed as --name=value, so none can be read as another option. Each
// run has its own process group (killed whole on a time limit), a capped stdout and stderr, no
// stdin, the project as its working folder, and the environment of the observer less Git's GIT_*
// variables and MACH_EXECUTION_ID (a decision is a person's, never a supervised execution's). One
// decision or stop runs at a time per project. A second decision waits a few seconds for the first
// (BusyWait); if the first is still running then, or run.py answers that another decision on the
// project holds its lock (`"busy": true`), the reply is "conflict" with BusyMessage, and the page
// asks again by itself, showing that it waits. Nothing of the second has run.
//
// The pattern is Product Studio's engine package (apps/studio/internal/engine: engine.go, args.go,
// locate.go, exec_unix.go), copied and narrowed rather than shared: the two programs are separate
// modules, as the observer's security package already is.
//
// The observer takes no MACH lock and writes nothing of MACH's: run.py's stations do, under their
// own locks. The only file this package writes is a person's answers to a spec's open questions,
// in a private temporary file under the observer's own folder (.factory/local/observer/), removed
// once run.py has read it.
package act

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// Reply kinds. "" is a JSON object from run.py.
const (
	KindRefused  = "refused"  // run.py refused (exit 1, "refused: <sentence>"): the sentence is for a person, as it came
	KindInvalid  = "invalid"  // the request was not accepted by the observer, or run.py's arguments by run.py (exit 2)
	KindConflict = "conflict" // another decision or stop for this project is still running: asked again, it is recorded after it
	KindFailed   = "failed"   // run.py could not be run, timed out, replied too much, or replied with something not JSON
)

// BusyMessage is the conflict's sentence for a decision: it is not refused, it waits its turn.
const BusyMessage = "Recording after another decision finishes."

// stopBusyMessage is the conflict's sentence for a stop asked for while a decision is recorded.
const stopBusyMessage = "A decision on this project is being recorded. The Factory can be stopped as soon as it has finished."

// Reply is what one run gave.
type Reply struct {
	Kind    string
	Message string
	Data    json.RawMessage // a JSON object, when Kind is ""
}

// OK reports whether run.py answered with a JSON object.
func (r Reply) OK() bool { return r.Kind == "" }

// Config fixes everything about how run.py is run. Resolved once, at start-up.
type Config struct {
	Python  string // absolute path to the interpreter
	Script  string // absolute path to run.py
	Project string // absolute project root
	// Scratch is the observer's own folder (.factory/local/observer), where an answers file is
	// written for the one run that reads it.
	Scratch string

	ReadTimeout time.Duration // decide --json, factory status; default 90 s
	ActTimeout  time.Duration // a decision; default 3 min
	LongTimeout time.Duration // merge, set-test-command, abandon, approve (they may run the project's tests); default 20 min
	StopTimeout time.Duration // factory stop; default 2 min
	BusyWait    time.Duration // how long a decision waits for another one in this observer; default 5 s
	MaxStdout   int           // default 4 MiB
	MaxStderr   int           // default 64 KiB
}

// Runner runs the four requests for one project.
type Runner struct {
	cfg   Config
	write chan struct{} // one decision or stop at a time
	read  chan struct{} // one read at a time (the server caches what it reads)
	// exec runs one argument vector; tests may replace it. It returns the exit code, stdout, stderr
	// and an error when the process could not be run to an exit (started, timed out, too much output).
	exec func(ctx context.Context, limit time.Duration, args []string) (int, []byte, []byte, error)
}

// New checks the configuration and returns a runner.
func New(cfg Config) (*Runner, error) {
	for name, path := range map[string]string{"interpreter": cfg.Python, "run.py": cfg.Script, "project": cfg.Project, "observer folder": cfg.Scratch} {
		if path == "" || !filepath.IsAbs(path) {
			return nil, fmt.Errorf("the %s path must be absolute", name)
		}
	}
	if info, err := os.Stat(cfg.Python); err != nil || info.IsDir() {
		return nil, fmt.Errorf("the interpreter %s cannot be used", cfg.Python)
	}
	if info, err := os.Stat(cfg.Script); err != nil || !info.Mode().IsRegular() || filepath.Base(cfg.Script) != "run.py" {
		return nil, fmt.Errorf("%s is not MACH's run.py", cfg.Script)
	}
	if info, err := os.Stat(cfg.Project); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("the project %s is not a folder", cfg.Project)
	}
	if cfg.ReadTimeout <= 0 {
		cfg.ReadTimeout = 90 * time.Second
	}
	if cfg.ActTimeout <= 0 {
		cfg.ActTimeout = 3 * time.Minute
	}
	if cfg.LongTimeout <= 0 {
		cfg.LongTimeout = 20 * time.Minute
	}
	if cfg.StopTimeout <= 0 {
		cfg.StopTimeout = 2 * time.Minute
	}
	if cfg.BusyWait <= 0 {
		cfg.BusyWait = 5 * time.Second
	}
	if cfg.MaxStdout <= 0 {
		cfg.MaxStdout = 4 << 20
	}
	if cfg.MaxStderr <= 0 {
		cfg.MaxStderr = 64 << 10
	}
	r := &Runner{cfg: cfg, write: make(chan struct{}, 1), read: make(chan struct{}, 1)}
	r.exec = r.start
	return r, nil
}

// Script is the run.py this runner uses.
func (r *Runner) Script() string { return r.cfg.Script }

// Needs runs `decide --json`: every ticket waiting on a person, with its options. It reads only.
func (r *Runner) Needs(ctx context.Context) Reply {
	return r.reading(ctx, []string{"decide", "--json"})
}

// Status runs `factory status`: what is in force here and whether a supervisor runs. It reads only.
func (r *Runner) Status(ctx context.Context) Reply {
	return r.reading(ctx, []string{"factory", "status"})
}

// Stop runs `factory stop`: the running executions and the supervisor stop.
func (r *Runner) Stop(ctx context.Context) Reply {
	release, busy := r.take(0, stopBusyMessage)
	if busy != nil {
		return *busy
	}
	defer release()
	return r.run(ctx, r.cfg.StopTimeout, []string{"factory", "stop"})
}

// Decide runs `decide do` for one checked decision. allowed reports whether an option key that is
// not in the fixed table is one `decide --json` offers for this ticket now with do: true.
func (r *Runner) Decide(ctx context.Context, d Decision, allowed func(ticket, option string) bool) Reply {
	if err := d.Check(allowed); err != nil {
		return Reply{Kind: KindInvalid, Message: err.Error()}
	}
	release, busy := r.take(r.cfg.BusyWait, BusyMessage)
	if busy != nil {
		return *busy
	}
	defer release()
	answers := ""
	if d.Option == "answers" {
		path, remove, err := writeAnswers(r.cfg.Scratch, d.Answers)
		if err != nil {
			return Reply{Kind: KindFailed, Message: "The answers could not be prepared for MACH, so nothing was recorded."}
		}
		defer remove()
		answers = path
	}
	limit := r.cfg.ActTimeout
	if LongOptions[d.Option] {
		limit = r.cfg.LongTimeout
	}
	reply := r.run(ctx, limit, d.Argv(answers))
	if reply.OK() && busyAnswer(reply.Data) {
		return Reply{Kind: KindConflict, Message: BusyMessage}
	}
	return reply
}

// busyAnswer: run.py waited for another decision on the project (a terminal's, say) and recorded
// nothing yet.
func busyAnswer(data []byte) bool {
	var top struct {
		Busy bool `json:"busy"`
		Done bool `json:"done"`
	}
	return json.Unmarshal(data, &top) == nil && top.Busy && !top.Done
}

// take holds this project's one place for a write, waiting up to `wait` for it.
func (r *Runner) take(wait time.Duration, busy string) (func(), *Reply) {
	release := func() { <-r.write }
	select {
	case r.write <- struct{}{}:
		return release, nil
	default:
	}
	if wait > 0 {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case r.write <- struct{}{}:
			return release, nil
		case <-timer.C:
		}
	}
	return nil, &Reply{Kind: KindConflict, Message: busy}
}

func (r *Runner) reading(ctx context.Context, argv []string) Reply {
	select {
	case r.read <- struct{}{}:
	case <-ctx.Done():
		return Reply{Kind: KindFailed, Message: "The request was cancelled before MACH answered."}
	}
	defer func() { <-r.read }()
	return r.run(ctx, r.cfg.ReadTimeout, argv)
}

// Argv is the whole vector after the interpreter for one request (exported for the tests that pin it).
func (r *Runner) Argv(argv []string) []string {
	return append([]string{"-I", "-B", r.cfg.Script, "--project=" + r.cfg.Project}, argv...)
}

func (r *Runner) run(ctx context.Context, limit time.Duration, argv []string) Reply {
	code, stdout, stderr, err := r.exec(ctx, limit, r.Argv(argv))
	if err != nil {
		return Reply{Kind: KindFailed, Message: err.Error()}
	}
	return mapResult(code, stdout, stderr)
}

// errTooMuch and the others are said to a person as they are.
var (
	errTooMuch   = errors.New("MACH's reply was larger than the Factory Floor accepts, so it was stopped.")
	errCancelled = errors.New("The request was cancelled before MACH finished.")
	errNotRun    = errors.New("MACH's run.py could not be started.")
)

// start runs the vector in its own process group, killed whole when the limit passes.
func (r *Runner) start(parent context.Context, limit time.Duration, args []string) (int, []byte, []byte, error) {
	ctx, cancel := context.WithTimeout(parent, limit)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.cfg.Python, args...)
	cmd.Dir = r.cfg.Project
	cmd.Env = childEnv(os.Environ())
	cmd.Stdin = nil
	stdout := &capped{max: r.cfg.MaxStdout, onOverflow: cancel}
	stderr := &capped{max: r.cfg.MaxStderr, onOverflow: cancel}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = 2 * time.Second
	prepare(cmd)
	err := cmd.Run()
	switch {
	case stdout.over || stderr.over:
		return 0, nil, nil, errTooMuch
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return 0, nil, nil, fmt.Errorf("MACH did not finish within %s, so it was stopped. What it had done by then is recorded by its stations.", words(limit))
	case parent.Err() != nil:
		return 0, nil, nil, errCancelled
	}
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return 0, nil, nil, errNotRun
		}
		return exit.ExitCode(), stdout.buf.Bytes(), stderr.buf.Bytes(), nil
	}
	return 0, stdout.buf.Bytes(), stderr.buf.Bytes(), nil
}

func words(d time.Duration) string {
	if d >= time.Minute && d%time.Minute == 0 {
		n := int(d / time.Minute)
		if n == 1 {
			return "1 minute"
		}
		return fmt.Sprintf("%d minutes", n)
	}
	return fmt.Sprintf("%d seconds", int(d.Seconds()))
}

// mapResult: exit 0 with a JSON object; exit 1 with run.py's "refused: <sentence>"; exit 2, the
// arguments were not accepted. Anything else is a failure, said plainly.
func mapResult(code int, stdout, stderr []byte) Reply {
	switch code {
	case 0:
		if trimmed := bytes.TrimSpace(stdout); isObject(trimmed) {
			return Reply{Data: json.RawMessage(trimmed)}
		}
		return Reply{Kind: KindFailed, Message: "MACH replied with something that is not JSON."}
	case 1:
		if message, ok := refusal(stderr); ok {
			return Reply{Kind: KindRefused, Message: message}
		}
	case 2:
		if reason, ok := usageError(stderr); ok {
			return Reply{Kind: KindInvalid, Message: "MACH did not accept the request: " + reason}
		}
		return Reply{Kind: KindInvalid, Message: "MACH did not accept the request."}
	}
	return Reply{Kind: KindFailed, Message: fmt.Sprintf("MACH stopped unexpectedly (exit code %d). /mach doctor says whether MACH's files are in place.", code)}
}

func isObject(out []byte) bool {
	return len(out) > 0 && out[0] == '{' && json.Valid(out)
}

// refusal extracts "refused: <sentence>" from stderr, whole, as run.py wrote it for a person.
func refusal(stderr []byte) (string, bool) {
	text := string(stderr)
	index := strings.Index(text, "refused: ")
	if index < 0 || (index > 0 && text[index-1] != '\n') {
		return "", false
	}
	message := strings.TrimSpace(text[index+len("refused: "):])
	if message == "" {
		return "", false
	}
	return truncate(strings.ToValidUTF8(message, "?"), 4096), true
}

func usageError(stderr []byte) (string, bool) {
	lines := strings.Split(strings.TrimSpace(string(stderr)), "\n")
	last := lines[len(lines)-1]
	if _, reason, found := strings.Cut(last, " error: "); found && reason != "" {
		return truncate(strings.ToValidUTF8(reason, "?"), 512), true
	}
	return "", false
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "..."
}

// childEnv passes the observer's environment through, as a terminal would, less every Git
// variable (GIT_*: none may point Git at another repository, index or identity than the
// project's own) and MACH_EXECUTION_ID (run.py refuses a person's decision inside a supervised
// execution; the Floor is a person, never an execution).
func childEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(name, "GIT_") || name == "MACH_EXECUTION_ID" {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// capped keeps at most max bytes; past that it stops the process and remembers it overflowed.
type capped struct {
	buf        bytes.Buffer
	max        int
	over       bool
	onOverflow func()
}

func (c *capped) Write(p []byte) (int, error) {
	if c.over {
		return len(p), nil
	}
	if c.buf.Len()+len(p) > c.max {
		c.over = true
		c.onOverflow()
		return len(p), nil
	}
	return c.buf.Write(p)
}
