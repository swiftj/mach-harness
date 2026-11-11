package engine

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

// Config fixes everything about how the engine is run. It is resolved once, at start-up.
type Config struct {
	Python  string // absolute path to the interpreter
	Script  string // absolute path to studio.py
	Project string // absolute, symlink-free project root

	Timeout        time.Duration // per call; default 60s
	NetworkTimeout time.Duration // per call that may fetch; default 180s
	LockWait       time.Duration // how long a call waits for another to finish; default 30s
	MaxStdout      int           // default 8 MiB
	MaxStderr      int           // default 64 KiB
}

// Engine runs allowlisted operations, one at a time per project.
type Engine struct {
	cfg  Config
	lock chan struct{}
}

// New checks the configuration and returns an engine for one project.
func New(cfg Config) (*Engine, error) {
	for name, path := range map[string]string{"interpreter": cfg.Python, "engine script": cfg.Script, "project": cfg.Project} {
		if path == "" || !filepath.IsAbs(path) {
			return nil, fmt.Errorf("the %s path must be absolute", name)
		}
	}
	if info, err := os.Stat(cfg.Python); err != nil || info.IsDir() {
		return nil, fmt.Errorf("the interpreter %s cannot be used", cfg.Python)
	}
	if info, err := os.Stat(cfg.Script); err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("the engine script %s cannot be used", cfg.Script)
	}
	if info, err := os.Stat(cfg.Project); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("the project %s is not a folder", cfg.Project)
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 60 * time.Second
	}
	if cfg.NetworkTimeout <= 0 {
		cfg.NetworkTimeout = 180 * time.Second
	}
	if cfg.LockWait <= 0 {
		cfg.LockWait = 30 * time.Second
	}
	if cfg.MaxStdout <= 0 {
		cfg.MaxStdout = 8 << 20
	}
	if cfg.MaxStderr <= 0 {
		cfg.MaxStderr = 64 << 10
	}
	return &Engine{cfg: cfg, lock: make(chan struct{}, 1)}, nil
}

// Project is the project root this engine serves.
func (e *Engine) Project() string { return e.cfg.Project }

// Do runs one operation from an HTTP body: look it up, decode its arguments strictly, build the
// argument vector, then run it under the project lock.
func (e *Engine) Do(ctx context.Context, name string, body []byte) Envelope {
	op, ok := Lookup(name)
	if !ok {
		return Fail(KindInvalid, fmt.Sprintf("There is no operation called %q.", truncate(name, 64)))
	}
	args := op.New()
	if err := Decode(body, args); err != nil {
		return Fail(KindInvalid, err.Error())
	}
	return e.Transaction(ctx, func(tx *Tx) Envelope { return tx.Call(ctx, name, args) })
}

// Tx is the right to call the engine while holding the project lock.
type Tx struct{ e *Engine }

// Call runs one operation with already-typed arguments. Only valid inside Transaction.
func (tx *Tx) Call(ctx context.Context, name string, args Args) Envelope {
	op, ok := Lookup(name)
	if !ok {
		return Fail(KindInvalid, fmt.Sprintf("There is no operation called %q.", truncate(name, 64)))
	}
	argv, err := args.Argv()
	if err != nil {
		var bad *InvalidError
		if errors.As(err, &bad) {
			return Fail(KindInvalid, bad.Message)
		}
		return Fail(KindInternal, "The request could not be prepared.")
	}
	return tx.e.run(ctx, op, argv)
}

// Transaction holds the project lock for the whole of fn, so a sequence such as "show, write a
// draft, check" cannot interleave with another request. Every engine call goes through it: even
// reads such as status bring fetched work into the workspace, so they write too.
func (e *Engine) Transaction(ctx context.Context, fn func(tx *Tx) Envelope) Envelope {
	wait, cancel := context.WithTimeout(ctx, e.cfg.LockWait)
	defer cancel()
	select {
	case e.lock <- struct{}{}:
	case <-wait.Done():
		if ctx.Err() != nil {
			return Fail(KindConflict, "The request was cancelled while another change to this project was running.")
		}
		return Fail(KindConflict, "Another change to this project is still running. Try again in a moment.")
	}
	defer func() { <-e.lock }()
	return fn(&Tx{e: e})
}

// run executes the fixed vector and maps the result to the envelope.
func (e *Engine) run(parent context.Context, op Operation, argv []string) Envelope {
	limit := e.cfg.Timeout
	if op.Network {
		limit = e.cfg.NetworkTimeout
	}
	ctx, cancel := context.WithTimeout(parent, limit)
	defer cancel()

	// -I: isolated (no PYTHON* variables, no user site, script folder only as studio.py adds it);
	// -B: write no bytecode next to the engine.
	// --app: the engine words what a person reads for the app (no terminal commands) and adds a
	// structured hint to a refusal. Decisions and artifacts are the same as in the terminal.
	full := append([]string{"-I", "-B", e.cfg.Script, "--project", e.cfg.Project, "--app"}, argv...)
	cmd := exec.CommandContext(ctx, e.cfg.Python, full...)
	cmd.Dir = e.cfg.Project
	cmd.Env = childEnv(os.Environ())
	cmd.Stdin = nil
	stdout := &capped{max: e.cfg.MaxStdout, onOverflow: cancel}
	stderr := &capped{max: e.cfg.MaxStderr, onOverflow: cancel}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = 2 * time.Second
	prepare(cmd)

	err := cmd.Run()
	switch {
	case stdout.over || stderr.over:
		return Fail(KindInternal, "The product engine's reply was larger than the host accepts.")
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return Fail(KindInternal, fmt.Sprintf("The product engine did not finish within %d seconds.", int(limit.Seconds())))
	case parent.Err() != nil:
		return Fail(KindInternal, "The request was cancelled before the product engine finished.")
	}
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return Fail(KindInternal, "The product engine could not be started.")
		}
		code = exit.ExitCode()
	}
	return mapResult(op, code, stdout.buf.Bytes(), stderr.buf.Bytes())
}

// mapResult is the contract's envelope mapping.
func mapResult(op Operation, code int, stdout, stderr []byte) Envelope {
	switch code {
	case 0:
		if isObject(stdout) {
			return OK(json.RawMessage(bytes.TrimSpace(stdout)))
		}
		return Fail(KindInternal, "The product engine replied with something that is not JSON.")
	case 1:
		if op.JSONOnFailure && isObject(stdout) {
			return OK(json.RawMessage(bytes.TrimSpace(stdout)))
		}
		if message, ok := refusal(stderr); ok {
			env := Fail(KindRefused, message)
			env.Error.Hint = refusalHint(stderr)
			return env
		}
	case 2:
		// argparse: the engine did not accept the arguments. Its own one-line reason, no usage text.
		if reason, ok := usageError(stderr); ok {
			return Fail(KindInvalid, "The product engine did not accept the arguments: "+reason)
		}
		return Fail(KindInvalid, "The product engine did not accept the arguments.")
	}
	return Fail(KindInternal, fmt.Sprintf("The product engine failed unexpectedly (exit code %d).", code))
}

func isObject(out []byte) bool {
	trimmed := bytes.TrimSpace(out)
	return len(trimmed) > 0 && trimmed[0] == '{' && json.Valid(trimmed)
}

// refusal extracts "refused: <message>" from stderr. The message is written for a person and is
// passed on whole, including its indented lines.
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
	return truncate(strings.ToValidUTF8(message, "?"), 8192), true
}

// refusalHint reads the engine's "refused-hint: {kind, target}" line, if there is one and it is a
// small JSON object.
func refusalHint(stderr []byte) json.RawMessage {
	for _, line := range strings.Split(string(stderr), "\n") {
		if raw, ok := strings.CutPrefix(line, "refused-hint: "); ok {
			raw = strings.TrimSpace(raw)
			if len(raw) <= 512 && isObject([]byte(raw)) {
				return json.RawMessage(raw)
			}
		}
	}
	return nil
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

// childEnv passes the environment through, as a terminal session would, except variables that
// would point Git at another repository than the project.
func childEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		switch name {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE":
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
