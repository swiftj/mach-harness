package interview

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// MinimumVersion is the oldest Claude Code the interview was proven on (M5_INTERVIEW_POC.md).
var MinimumVersion = [3]int{2, 1, 322}

var versionPattern = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// Capability is the cached answer to "can an interview run here?".
type Capability struct {
	OK        bool
	Reason    string
	Version   string
	CheckedAt time.Time
}

func now() string { return nowTime().Format("2006-01-02T15:04:05Z") }

// probe runs a short, non-billing command with the interviewer's own environment.
func probe(ctx context.Context, claude, dir string, env []string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, claude, args...)
	cmd.Dir, cmd.Env = dir, env
	var out bytes.Buffer
	cmd.Stdout = &limited{buf: &out, max: 1 << 20}
	err := cmd.Run()
	return out.Bytes(), err
}

// CheckClaude decides whether interviews can run: claude exists, is at least MinimumVersion, its
// --help lists --restricted and --permission-prompts, and `claude auth status` says it is signed
// in. None of these calls the model or spends anything. Only the logged-in flag of the status is
// read; the rest (the account's address among it) is discarded unread.
func CheckClaude(ctx context.Context, claude, dir string, env []string) Capability {
	c := Capability{CheckedAt: time.Now()}
	if claude == "" {
		c.Reason = "Claude Code is not installed on this computer (the claude command was not found)."
		return c
	}
	out, err := probe(ctx, claude, dir, env, "--version")
	match := versionPattern.FindStringSubmatch(string(out))
	if err != nil || match == nil {
		c.Reason = "Claude Code did not report its version, so the interview cannot be started from here."
		return c
	}
	c.Version = match[0]
	for i := 0; i < 3; i++ {
		n, _ := strconv.Atoi(match[i+1])
		if n != MinimumVersion[i] {
			if n < MinimumVersion[i] {
				c.Reason = "Claude Code " + c.Version + " is too old for the interview here; it needs " +
					strconv.Itoa(MinimumVersion[0]) + "." + strconv.Itoa(MinimumVersion[1]) + "." + strconv.Itoa(MinimumVersion[2]) + " or later. Update Claude Code."
				return c
			}
			break
		}
	}
	help, err := probe(ctx, claude, dir, env, "--help")
	if err != nil || !bytes.Contains(help, []byte("--restricted")) || !bytes.Contains(help, []byte("--permission-prompts")) {
		c.Reason = "This Claude Code lacks the restricted mode the interview needs (--restricted, --permission-prompts)."
		return c
	}
	status, _ := probe(ctx, claude, dir, env, "auth", "status", "--json")
	var auth struct {
		LoggedIn bool `json:"loggedIn"`
	}
	if json.Unmarshal(bytes.TrimSpace(status), &auth) != nil || !auth.LoggedIn {
		c.Reason = "Claude Code is not signed in. Run claude in a terminal and sign in, then reload this page."
		return c
	}
	c.OK = true
	return c
}

// ContinueCommandFor is the Claude Code command for this install, without the slice ID.
func ContinueCommandFor(script string) string {
	if strings.Contains(script, "/.claude/skills/mach-product-studio/") {
		return "/mach-product-studio continue"
	}
	return "/mach:product-studio continue"
}

type limited struct {
	buf *bytes.Buffer
	max int
}

func (l *limited) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
		} else {
			l.buf.Write(p)
		}
	}
	return len(p), nil
}
