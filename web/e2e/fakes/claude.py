#!/usr/bin/env python3
"""Scripted stand-in for `claude`, for the free and deterministic interview in the lifecycle suite.

It answers the host's capability probes (--version, --help, auth status) and, for each interview
turn, emits the stream-json shapes the host parses (the same shapes as
apps/studio/internal/testkit/fakeclaude.go, which were recorded from the real Claude Code). Turns
come from config.json beside this file; every call's argv and working folder are recorded in
calls/<n>.json so a test can assert the host launched it the documented way.

Turn kinds:
  question    a well-formed interview question (❓ **Qn** - **Title**: ... / ➡️ ...)
  write_spec  writes a complete, valid spec and why for the slice into the draft workspace (as the
              real interviewer would with its Write tool), runs `slice check`, then says so
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def read(name, default):
    try:
        with open(os.path.join(HERE, name)) as f:
            return f.read()
    except OSError:
        return default


args = sys.argv[1:]
if args == ["--version"]:
    print("2.1.322 (Claude Code)")
    sys.exit(0)
if args == ["--help"]:
    print("Usage: claude [options]\n  --restricted  Restricted mode\n  --permission-prompts <target>  Who answers permission prompts")
    sys.exit(0)
if args[:2] == ["auth", "status"]:
    print('{"loggedIn": true}')
    sys.exit(0)

config = json.loads(read("config.json", "{}"))
calls = os.path.join(HERE, "calls")
os.makedirs(calls, exist_ok=True)
n = len(os.listdir(calls))
with open(os.path.join(calls, "%03d.json" % n), "w") as f:
    json.dump({"argv": args, "cwd": os.getcwd(), "env_names": sorted(os.environ)}, f)

session = args[args.index("--resume") + 1] if "--resume" in args else args[args.index("--session-id") + 1]
message = args[args.index("--") + 1] if "--" in args else ""
found = re.findall(r"SLICE-\d{3,}", " ".join(args))
slice_id = found[0] if found else "SLICE-000"
draft = os.path.join(os.getcwd(), ".factory", "studio", "draft")
turns = config.get("turns", [])
turn = turns[n] if n < len(turns) else {"kind": "question", "title": "Anything else", "number": n + 1}


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def say(mid, text):
    out({"type": "stream_event", "event": {"type": "message_start", "message": {"id": mid, "role": "assistant"}}, "parent_tool_use_id": None})
    half = len(text) // 2
    for part in (text[:half], text[half:]):
        out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": part}},
             "parent_tool_use_id": None, "api_message_id": mid})


def tool(tid, name, inp, result="ok"):
    out({"type": "assistant", "message": {"id": "msg_t" + tid, "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}, "parent_tool_use_id": None})
    out({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": result}]}, "parent_tool_use_id": None})


def question(number, title, body, recommendation, preface="From the draft: an admin invites a teammate by email."):
    return f"{preface}\n\n❓ **Q{number}** - **{title}**: {body}\n\n➡️ {recommendation}"


def spec_text():
    fixture = open(config["fixture"]).read()
    lines = [line for line in fixture.splitlines() if "(Deferred to" not in line]
    at = lines.index("### Out of scope") + 2
    lines[at:at] = ["- None."]
    return "\n".join(lines).replace("SLICE-001", slice_id) + "\n"


def why_text():
    return f"""# Intent: Invite a teammate

- **Slice:** {slice_id} at specs/slices/{slice_id}-invite-teammate.md
- **Status:** Ready for approval

## Why

- **Problem:** An admin cannot bring a colleague in.
- **Who it is for:** A workspace admin.
- **Success looks like:** The colleague receives an invitation.

## Goal ancestry

- **Goal:** Teams can work together
- **Epic:** EPIC-001: Team membership
- **Slice:** {slice_id}: An admin invites one teammate.

## Constraints

- None.

## Risk

- **Tier:** High
- **Reason:** It grants access.

## Deferred work

- None.
"""


out({"type": "system", "subtype": "init", "cwd": os.getcwd(), "apiKeySource": "none", "session_id": session})
kind = turn.get("kind", "question")


def engine(*argv):
    """Runs the engine as the real interviewer does through its Bash tool (an allowed operation)."""
    done = subprocess.run([sys.executable, "-I", "-B", config["engine"], "--project", os.getcwd(), *argv], capture_output=True, text=True)
    return done.stdout or done.stderr


if n == 0:
    tool("toolu_s0", "Bash", {"command": f"python3 {config['engine']} slice resume {slice_id}"}, engine("slice", "resume", slice_id))
tool("toolu_r%d" % n, "Read", {"file_path": os.path.join(draft, "product", "slices", slice_id + ".json")})
if kind == "write_spec":
    spec_path = os.path.join(draft, "specs", "slices", f"{slice_id}-invite-teammate.md")
    why_path = os.path.join(draft, "product", "intents", f"{slice_id}.md")
    for path, text, tid in ((spec_path, spec_text(), "toolu_ws%d" % n), (why_path, why_text(), "toolu_ww%d" % n)):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
        tool(tid, "Write", {"file_path": path, "content": "(omitted)"})
    tool("toolu_c%d" % n, "Bash", {"command": f"python3 {config['engine']} slice check {slice_id} --ready"}, engine("slice", "check", slice_id, "--ready"))
    final = turn.get("text", "I wrote the specification and the why. The engine's check passes with no open questions, so it is ready for you to approve.")
else:
    final = question(turn.get("number", n + 1), turn.get("title", "Who it is for"),
                     turn.get("body", "Is this slice for a workspace admin who invites one teammate by email?"),
                     turn.get("recommendation", "Yes. The slice is done when the invitation is sent."))
say("msg_n%d" % n, "Let me look at the draft first.")
say("msg_f%d" % n, final)
out({"type": "result", "subtype": "success", "is_error": False, "total_cost_usd": round(0.01 * (n + 1), 4),
     "model_usage_since_last_result": {"claude-sonnet-5-5": {"costUSD": 0.01}}, "permission_denials": [], "session_id": session})
