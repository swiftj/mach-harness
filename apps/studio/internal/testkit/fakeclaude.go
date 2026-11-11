package testkit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
)

// fakeClaude is a stand-in for the claude command. It answers --version, --help and auth status,
// and for a turn it plays the next scripted turn from scenario.json as recorded stream-json,
// recording its arguments, environment and working folder in calls/<n>.json.
const fakeClaude = `#!/usr/bin/env python3
import json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
def read(name, default):
    try:
        with open(os.path.join(HERE, name)) as f:
            return f.read()
    except OSError:
        return default
args = sys.argv[1:]
if args == ["--version"]:
    print(read("version.txt", "2.1.322 (Claude Code)").strip()); sys.exit(0)
if args == ["--help"]:
    print(read("help.txt", "Usage: claude [options]\n  --restricted  Restricted mode\n  --permission-prompts <target>  Who answers")); sys.exit(0)
if args[:2] == ["auth", "status"]:
    print(read("auth.json", '{"loggedIn": true, "email": "someone@example.com"}')); sys.exit(0)
os.makedirs(os.path.join(HERE, "calls"), exist_ok=True)
n = len(os.listdir(os.path.join(HERE, "calls")))
with open(os.path.join(HERE, "calls", "%03d.json" % n), "w") as f:
    json.dump({"argv": args, "env": dict(os.environ), "cwd": os.getcwd()}, f)
turns = json.loads(read("scenario.json", "[]"))
turn = turns[n] if n < len(turns) else {"kind": "question"}
session = args[args.index("--resume") + 1] if "--resume" in args else args[args.index("--session-id") + 1]
def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()
def say(mid, text):
    out({"type": "stream_event", "event": {"type": "message_start", "message": {"id": mid, "role": "assistant"}}, "parent_tool_use_id": None})
    half = len(text) // 2
    for part in (text[:half], text[half:]):
        out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": part}}, "parent_tool_use_id": None, "api_message_id": mid})
def tool(tid, name, inp, denied=False, write=None, error=None):
    out({"type": "assistant", "message": {"id": "msg_t" + tid, "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}, "parent_tool_use_id": None})
    if denied:
        out({"type": "system", "subtype": "permission_denied", "tool_name": name, "tool_use_id": tid, "decision_reason": "denied"})
    if write:
        path = os.path.join(os.getcwd(), write)
        with open(path, "w") as f:
            f.write("# changed at %f\n" % time.time())
    result = {"type": "tool_result", "tool_use_id": tid, "content": error or "SECRET FILE CONTENT"}
    if error:
        result["is_error"] = True
    out({"type": "user", "message": {"role": "user", "content": [result]}, "tool_use_result": {"originalFile": "SECRET FILE CONTENT"}, "parent_tool_use_id": None})
out({"type": "system", "subtype": "init", "cwd": os.getcwd(), "apiKeySource": "none", "session_id": session})
out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "sub-agent text"}}, "parent_tool_use_id": "toolu_sub", "api_message_id": "msg_sub"})
kind = turn.get("kind", "question")
denials = []
for t in turn.get("tools", []):
    tool(t["id"], t["name"], t["input"], t.get("denied", False), t.get("write"), t.get("error"))
    if t.get("denied"):
        denials.append({"tool_name": t["name"], "tool_input": t["input"]})
if kind == "slow":
    say("msg_slow", "Let me think about ")
    time.sleep(turn.get("sleep", 60)); sys.exit(0)
if kind == "crash":
    say("msg_crash", "I was saying something")
    sys.exit(1)
say("msg_n%d" % n, "Let me look first.")
say("msg_f%d" % n, turn.get("text", "Q?"))
result = {"type": "result", "subtype": "success", "is_error": False, "total_cost_usd": turn.get("session_cost", 0.1 * (n + 1)),
          "model_usage_since_last_result": {"claude-sonnet-5-5": {"costUSD": turn.get("cost", 0.01)}},
          "permission_denials": denials, "session_id": session}
if kind == "budget":
    result.update(subtype="error_max_budget_usd", is_error=True)
out(result)
`

// Turn is one scripted turn for the stand-in.
type Turn struct {
	Kind        string     `json:"kind,omitempty"` // question (default), slow, crash, budget
	Text        string     `json:"text,omitempty"`
	Tools       []FakeTool `json:"tools,omitempty"`
	Sleep       float64    `json:"sleep,omitempty"`
	Cost        float64    `json:"cost,omitempty"`
	SessionCost float64    `json:"session_cost,omitempty"`
}

// FakeTool is one tool call in a scripted turn.
type FakeTool struct {
	ID     string         `json:"id"`
	Name   string         `json:"name"`
	Input  map[string]any `json:"input"`
	Denied bool           `json:"denied,omitempty"`
	Write  string         `json:"write,omitempty"` // a file the stand-in writes, relative to its working folder
	Error  string         `json:"error,omitempty"` // the tool fails with this text (is_error)
}

// FakeClaude writes the stand-in to a fresh folder and returns its path.
func FakeClaude(t testing.TB, turns ...Turn) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "claude")
	if err := os.WriteFile(path, []byte(fakeClaude), 0o755); err != nil {
		t.Fatal(err)
	}
	SetScenario(t, path, turns...)
	return path
}

// SetScenario replaces the stand-in's scripted turns (counted from its first recorded call).
func SetScenario(t testing.TB, claude string, turns ...Turn) {
	t.Helper()
	data, _ := json.Marshal(turns)
	if err := os.WriteFile(filepath.Join(filepath.Dir(claude), "scenario.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// SetFakeFile overrides version.txt, help.txt or auth.json for the stand-in.
func SetFakeFile(t testing.TB, claude, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(filepath.Dir(claude), name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Call is one recorded turn process.
type Call struct {
	Argv []string          `json:"argv"`
	Env  map[string]string `json:"env"`
	Cwd  string            `json:"cwd"`
}

// Calls returns the stand-in's recorded turn processes, in order.
func Calls(t testing.TB, claude string) []Call {
	t.Helper()
	dir := filepath.Join(filepath.Dir(claude), "calls")
	entries, _ := os.ReadDir(dir)
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	var calls []Call
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		var c Call
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatalf("call %s: %v", name, err)
		}
		calls = append(calls, c)
	}
	return calls
}

// QuestionText is a well-formed interview question with a preface.
func QuestionText(n int, title string) string {
	return "Facts from your notes: seats are limited by plan.\n\n❓ **Q" + strconv.Itoa(n) + "** - **" + title +
		"**: Is this slice for a workspace admin who invites one teammate by email?\n\n➡️ Yes. The slice is done when the invitation is sent."
}
