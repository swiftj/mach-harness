#!/usr/bin/env python3
"""Proof of concept: drive a Product Studio interview through the installed Claude Code, turn by turn.

    bridge.py --project <dir> --slice SLICE-001
    bridge.py --project <dir> --epic EPIC-001 --title "Admin invites a teammate" --idea "let an admin invite a teammate by email"

Prints normalized interview events (M5_INTERVIEW_POC.md, section 7) as JSON lines on stdout and reads the
product manager's replies from stdin, one line per reply. "/stop" ends the interview; Ctrl-C during a turn
interrupts that turn only. The Claude session is saved per slice, so running the bridge again for the same
slice picks the conversation up where it stopped, even after the host or the machine restarted.

Each PM reply runs one `claude -p --resume <session>` process (mechanism b). The interviewer runs with:
  --restricted            no user/project/local settings (their allow rules, hooks, plugins), no other
                          code-running tools, file tools confined to the project
  --plugin-dir            a one-skill plugin, so the skill is /mach:product-studio and nothing else of MACH's
  --strict-mcp-config     no MCP servers
  --permission-mode default --permission-prompts none   anything not allowed below is refused
  --tools Read,Glob,Grep,Edit,Write,Bash                no Agent, no Skill, no web tools
  --allowedTools          read the project; edit only the draft spec and why; run only the engine's
                          non-approving operations, spelled exactly as the skill spells them
  --disallowedTools       the approving and publishing operations, as a second layer
It runs in a clean environment, so it uses the person's own Claude Code sign-in and nothing of the caller's.
A per-slice lock (flock, released when the process dies) prevents two interviews on one slice. The session
record, the lock and the one-skill plugin live in .factory/studio/interviews/ (git-ignored with the rest of
the Studio's local state); the plugin's path must be stable because a resumed session keeps using it.

Standard library only. Proof of concept: not the Go host.
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

SLICE_ID = re.compile(r"^SLICE-\d{3,}$")
EPIC_ID = re.compile(r"^EPIC-\d{3,}$")

# The engine operations the interviewer may run (non-approving). Each becomes an exact-prefix allow rule.
# Project-wide reads and bookkeeping:
ALLOWED_OPS_EXACT = ["where", "status", "validate", "refresh"]
# Operations on the interview's own slice only ("{slice}" is filled in); other slices are refused:
ALLOWED_SLICE_OPS_EXACT = ["slice resume {slice}", "slice check {slice}"]
ALLOWED_SLICE_OPS_WITH_ARGS = ["slice check {slice}", "slice pause {slice}", "slice set {slice}"]
# The operations that are a person's act, denied again explicitly (the allow list already excludes them).
DENIED_OPS = ["slice approve", "epic approve", "wave", "send", "reconcile", "slice renumber", "epic renumber",
              "slice reopen", "project", "feedback", "slice new", "epic add", "epic set"]

HOST_NOTE = (
    "You are the interviewer inside MACH Product Studio's local app. Each of your messages is shown to the "
    "product manager as is, and their reply comes back as the next message. The app created the slice before "
    "this session started. Approving, reopening, delivery waves, sending, reconciling and "
    "renumbering are the product manager's own acts, done with the app's buttons; you cannot run them here, so "
    "if asked, tell the PM which button to use. Run the studio script as a plain command, one per Bash call, "
    "exactly as the skill spells it: no shell variables, functions, cd or chained commands. If one command is "
    "refused, only that operation is unavailable; the others still work."
)

ACTIVITY = {  # engine operation -> plain description
    "where": ("lookup", "looked up the workspace"),
    "refresh": ("lookup", "brought in what others have published"),
    "status": ("lookup", "checked where things stand"),
    "validate": ("check", "checked the whole workspace"),
    "slice resume": ("lookup", "picked up the slice"),
    "slice new": ("save", "started a slice"),
    "slice check": ("check", "checked the draft"),
    "slice pause": ("save", "saved where the interview stopped"),
    "slice set": ("save", "updated the slice's details"),
}
REFUSED = {
    "approve": "tried to approve; only you can approve, with the Approve button",
    "send": "tried to send to engineering; only you can send, from the delivery wave",
    "wave": "tried to change a delivery wave; waves are yours to manage in the app",
}

QUESTION = re.compile(
    r"^(?P<preface>.*?)❓\s*\*\*Q(?P<number>\d+)\*\*\s*[-–—]\s*\*\*(?P<title>[^*\n]+?)\*\*\s*:?\s*(?P<body>.*?)"
    r"\n\s*➡️\s*(?P<recommendation>.+?)\s*$",
    re.S,
)


def parse_question(text):
    """A complete message is a question when it holds exactly one ❓ block followed by one ➡️ line."""
    if text.count("❓") != 1 or text.count("➡️") != 1:
        return None
    m = QUESTION.match(text.strip())
    if not m:
        return None
    return {
        "number": int(m["number"]),
        "title": m["title"].strip(),
        "body": m["body"].strip(),
        "recommendation": m["recommendation"].strip(),
        "preface": m["preface"].strip() or None,
    }


def classify_message(text):
    if parse_question(text):
        return "question"
    if "Does this capture the intent" in text:
        return "confirmation"
    return "other"


class Bridge:
    def __init__(self, project, skill_dir, slice_id, model, budget, turn_timeout=600, out=sys.stdout):
        self.project = project
        self.skill_dir = skill_dir
        self.studio = skill_dir / "scripts" / "studio.py"
        self.slice_id = slice_id
        self.model = model
        self.budget = budget
        self.turn_timeout = turn_timeout
        self.out = out
        self.seq = 0
        self.home = project / ".factory" / "studio" / "interviews"
        self.draft = project / ".factory" / "studio" / "draft"
        self.child = None
        self.plugin_dir = None
        self.lock_file = None

    # ---- output -------------------------------------------------------------------------------------
    def emit(self, event, **data):
        self.seq += 1
        self.out.write(json.dumps({"seq": self.seq, "event": event, "data": data}, ensure_ascii=False) + "\n")
        self.out.flush()

    # ---- lock and session record ---------------------------------------------------------------------
    def acquire(self):
        self.home.mkdir(parents=True, exist_ok=True)
        path = self.home / f"{self.slice_id}.lock"
        self.lock_file = open(path, "a+")
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock_file.seek(0)
            holder = self.lock_file.read().strip() or "another process"
            raise SystemExit(f"conflict: {self.slice_id} already has an interview running ({holder}).")
        self.lock_file.seek(0)
        self.lock_file.truncate()
        self.lock_file.write(json.dumps({"pid": os.getpid(), "since": now()}))
        self.lock_file.flush()

    def record_path(self):
        return self.home / f"{self.slice_id}.json"

    def load_record(self):
        try:
            return json.loads(self.record_path().read_text())
        except (OSError, ValueError):
            return None

    def save_record(self, record):
        tmp = self.record_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(record, indent=2))
        os.replace(tmp, self.record_path())

    # ---- the child process ---------------------------------------------------------------------------
    def make_plugin(self):
        """A one-skill plugin: the interviewer sees /mach:product-studio and nothing else of MACH's.

        Its path must stay the same across runs: the session transcript records the skill's folder, and a
        resumed interviewer keeps using that path, which the allow rules have to name."""
        self.plugin_dir = self.home / "plugin"
        manifest = self.plugin_dir / ".claude-plugin" / "plugin.json"
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps(
            {"name": "mach", "version": "0.0.0-interviewer", "description": "Product Studio interviewer"}))
        link = self.plugin_dir / "skills" / "product-studio"
        link.parent.mkdir(exist_ok=True)
        if link.is_symlink() and Path(os.readlink(link)) != self.skill_dir:
            link.unlink()
        if not link.is_symlink():
            if link.exists():
                raise SystemExit(f"internal: {link} is not the expected link; remove it.")
            link.symlink_to(self.skill_dir, target_is_directory=True)

    def interpreters(self):
        names = ["python3"]
        found = shutil.which("python3")
        if found:
            real = subprocess.run([found, "-c", "import sys; print(sys.executable)"], capture_output=True,
                                  text=True, timeout=20).stdout.strip()
            if real:
                names.append(real)
        return names

    def permission_args(self):
        scripts = {str(self.plugin_dir / "skills" / "product-studio" / "scripts" / "studio.py"), str(self.studio)}
        allow, deny = ["Read", "Glob", "Grep"], []
        for script in sorted(scripts):
            for spelled in (script, f'"{script}"'):
                for py in self.interpreters():
                    allow += [f"Bash({py} {spelled} {op})" for op in ALLOWED_OPS_EXACT]
                    allow += [f"Bash({py} {spelled} {op.format(slice=self.slice_id)})" for op in ALLOWED_SLICE_OPS_EXACT]
                    allow += [f"Bash({py} {spelled} {op.format(slice=self.slice_id)} *)" for op in ALLOWED_SLICE_OPS_WITH_ARGS]
                    deny += [f"Bash({py} {spelled} {op} *)" for op in DENIED_OPS]
                    deny += [f"Bash({py} {spelled} {op})" for op in DENIED_OPS]
        # Absolute rules ("//path"): relative ones follow the shell's cwd, which the model can change.
        # Only this slice's spec and why.
        allow.append(f"Edit(/{self.draft / 'specs' / 'slices'}/{self.slice_id}-*.md)")
        allow.append(f"Edit(/{self.draft / 'product' / 'intents'}/{self.slice_id}.md)")
        return ["--allowedTools", *allow, "--disallowedTools", *deny]

    def command(self, session_id, resume, message):
        cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
               "--restricted", "--plugin-dir", str(self.plugin_dir), "--strict-mcp-config",
               "--permission-mode", "default", "--permission-prompts", "none",
               "--tools", "Read,Glob,Grep,Edit,Write,Bash",
               *self.permission_args(),
               "--max-budget-usd", str(self.budget),
               "--append-system-prompt", HOST_NOTE]
        if self.model:
            cmd += ["--model", self.model]
        cmd += ["--resume", session_id] if resume else ["--session-id", session_id]
        return cmd + ["--", message]

    def environment(self):
        """Only what Claude Code needs to find itself and the person's own sign-in. Nothing of the caller's."""
        keep = ("HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TERM")
        env = {k: os.environ[k] for k in keep if k in os.environ}
        env["GIT_TERMINAL_PROMPT"] = "0"  # refresh must fail, not hang, when the remote wants a password
        return env

    # ---- draft change detection -----------------------------------------------------------------------
    def snapshot(self):
        state = {}
        if self.draft.is_dir():
            for path in self.draft.rglob("*"):
                if path.is_file() and not path.is_symlink():
                    state[str(path.relative_to(self.draft))] = hashlib.sha256(path.read_bytes()).hexdigest()
        return state

    @staticmethod
    def what_changed(paths):
        kinds = set()
        for p in paths:
            if p.startswith("specs/slices/"):
                kinds.add("spec")
            elif p.startswith("product/intents/"):
                kinds.add("why")
            elif p.startswith("product/slices/"):
                kinds.add("work_order")
            else:
                kinds.add("other")
        return sorted(kinds)

    # ---- describing what the interviewer did, never its raw input ---------------------------------------
    def studio_op(self, command):
        for script in (str(self.studio), str(self.plugin_dir / "skills" / "product-studio" / "scripts" / "studio.py")):
            for spelled in (f'"{script}"', script):  # quoted first: the skill quotes the path
                idx = command.find(spelled)
                if idx >= 0:
                    words = command[idx + len(spelled):].split()
                    words = [w for w in words if not w.startswith("--project")]
                    return " ".join(words[:2]) if len(words) > 1 and words[0] in ("slice", "epic", "wave", "project") else (words[0] if words else "")
        return None

    def describe(self, name, tool_input):
        if name == "Bash":
            op = self.studio_op(tool_input.get("command", ""))
            if op is not None:
                return ACTIVITY.get(op, ("other", "ran a Product Studio step"))
            return ("lookup", "looked through the project")
        if name in ("Read",):
            path = str(tool_input.get("file_path", ""))
            if "/skills/" in path:
                return ("lookup", "reread the interview guidance")
            if path.startswith(str(self.draft)):
                return ("lookup", "read the draft")
            return ("lookup", "read a project document")
        if name in ("Glob", "Grep"):
            return ("lookup", "searched the project")
        if name in ("Write", "Edit"):
            path = str(tool_input.get("file_path", ""))
            if "/specs/slices/" in path:
                return ("write", "wrote the spec")
            if "/product/intents/" in path:
                return ("write", "wrote the slice's why")
            return ("write", "tried to write a file")
        return ("other", "used " + name)

    def refused(self, name, tool_input):
        if name == "Bash":
            op = self.studio_op(tool_input.get("command", "")) or ""
            for key, text in REFUSED.items():
                if key in op:
                    return text
            if op:
                return "tried a Product Studio step that is not available here"
            return "tried a command that is not allowed here"
        if name in ("Write", "Edit"):
            return "tried to write outside the draft spec and why"
        return f"tried to use {name}, which is not allowed here"

    # ---- one turn ----------------------------------------------------------------------------------------
    def turn(self, record, message):
        resume = record["turns"] > 0
        self.emit("state", state="thinking")
        started = time.time()
        before = self.snapshot()
        tools = {}
        denied = set()
        texts = {}           # message id -> text of its text blocks, in order
        order = []
        result = None
        interrupted = False
        self.child = subprocess.Popen(self.command(record["session_id"], resume, message), cwd=self.project,
                                      env=self.environment(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True)
        timed_out = threading.Event()

        def expire(child=self.child):
            timed_out.set()
            os.killpg(child.pid, signal.SIGTERM)

        watchdog = threading.Timer(self.turn_timeout, expire)
        watchdog.start()
        try:
            for line in self.child.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get("parent_tool_use_id"):
                    continue  # sub-agent traffic (none expected: Agent is not available)
                kind = ev.get("type")
                if kind == "stream_event":
                    e = ev["event"]
                    if e.get("type") == "content_block_delta" and e["delta"].get("type") == "text_delta":
                        mid = ev.get("api_message_id") or "m"
                        if mid not in texts:
                            texts[mid] = ""
                            order.append(mid)
                        texts[mid] += e["delta"]["text"]
                        self.emit("text", message_id=mid, delta=e["delta"]["text"])
                elif kind == "assistant":
                    for block in ev["message"].get("content", []):
                        if block.get("type") == "tool_use":
                            tools[block["id"]] = (block["name"], block.get("input", {}))
                            self.emit("state", state="working")
                elif kind == "user":
                    content = ev.get("message", {}).get("content")
                    if isinstance(content, list) and any(b.get("type") == "tool_result" for b in content):
                        for b in content:  # described once it ran; a refused call was reported as refused
                            if b.get("type") == "tool_result" and b.get("tool_use_id") in tools \
                                    and b["tool_use_id"] not in denied:
                                k, text = self.describe(*tools[b["tool_use_id"]])
                                self.emit("activity", kind=k, text=text)
                        after = self.snapshot()
                        changed = sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p))
                        if changed:
                            self.emit("draft_changed", slice_id=self.slice_id, what=self.what_changed(changed))
                            before = after
                        self.emit("state", state="thinking")
                elif kind == "system" and ev.get("subtype") == "permission_denied":
                    denied.add(ev.get("tool_use_id"))
                    name, tool_input = tools.get(ev.get("tool_use_id"), (ev.get("tool_name", "a tool"), {}))
                    self.emit("activity", kind="refused", text=self.refused(name, tool_input))
                elif kind == "result":
                    result = ev
        except KeyboardInterrupt:
            interrupted = True
            os.killpg(self.child.pid, signal.SIGTERM)
        watchdog.cancel()
        self.child.wait()
        self.child = None

        record["turns"] += 1
        session_cost = (result or {}).get("total_cost_usd")
        turn_cost = None
        if session_cost is not None:
            # total_cost_usd is the session's running total, across processes; the per-model breakdown since
            # the last result is this turn's own spend when Claude Code reports it.
            since = (result or {}).get("model_usage_since_last_result") or {}
            costs = [m.get("costUSD") for m in since.values() if isinstance(m, dict) and m.get("costUSD") is not None]
            turn_cost = round(sum(costs) if costs else session_cost - record.get("session_cost_usd", 0.0), 6)
            record["session_cost_usd"] = session_cost
        record["updated"] = now()
        self.save_record(record)

        final = texts[order[-1]] if order else ""
        if interrupted or result is None:
            outcome = "interrupted" if interrupted else "failed"
            if timed_out.is_set():
                outcome = "timed_out"
                self.emit("error", kind="timed_out", message="The interviewer took too long and was stopped.")
            elif not interrupted:
                self.emit("error", kind="no_result", message="The interviewer stopped without finishing its reply.")
        elif result.get("is_error"):
            outcome = result.get("subtype", "error")
            message = {"error_max_budget_usd": "This turn reached its spending limit."}.get(outcome, "The interviewer could not finish this reply.")
            self.emit("error", kind=outcome, message=message)
        else:
            outcome = "replied"
            if final:
                kind = classify_message(final)
                self.emit("message", message_id=order[-1], text=final, kind=kind)
                if kind == "question":
                    self.emit("question", message_id=order[-1], **parse_question(final))
        self.emit("turn", outcome=outcome, seconds=round(time.time() - started, 1), cost_usd=turn_cost,
                  session_cost_usd=session_cost,
                  refused=len((result or {}).get("permission_denials") or []))
        return outcome

    # ---- the interview -----------------------------------------------------------------------------------
    def run(self, first_message, replies):
        self.acquire()
        self.make_plugin()
        try:
            record = self.load_record()
            if record is None:
                record = {"slice_id": self.slice_id, "session_id": str(uuid.uuid4()), "turns": 0,
                          "session_cost_usd": 0.0, "created": now()}
                self.save_record(record)
                message = first_message
            else:
                message = "I'm back. Let's continue."
            self.emit("state", state="starting", slice_id=self.slice_id, session_id=record["session_id"],
                      resumed=record["turns"] > 0)
            while True:
                self.turn(record, message)
                self.emit("state", state="waiting_for_reply")
                try:
                    message = replies()
                except (EOFError, KeyboardInterrupt):
                    message = None
                if message is None or message.strip() == "/stop":
                    self.emit("ended", reason="stopped")
                    self.emit("state", state="ended")
                    return
                message = message.strip()
                if not message:
                    message = "(no answer)"
        finally:
            if self.child and self.child.poll() is None:
                os.killpg(self.child.pid, signal.SIGTERM)
            if self.lock_file:
                self.lock_file.close()


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def find_skill(project):
    for candidate in (project / ".claude" / "skills" / "mach-product-studio",):
        if (candidate / "scripts" / "studio.py").is_file():
            return candidate.resolve()
    raise SystemExit("invalid: Product Studio is not installed in this project (pass --skill-dir).")


def studio(project, skill_dir, *args):
    """The host's own engine call: fixed interpreter, argument vector, no shell."""
    p = subprocess.run([sys.executable, str(skill_dir / "scripts" / "studio.py"), "--project", str(project), *args],
                       capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        raise SystemExit(p.stderr.strip() or f"studio.py {' '.join(args)} failed")
    return json.loads(p.stdout)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True, type=Path)
    ap.add_argument("--skill-dir", type=Path, help="the product-studio skill folder (default: the project's install)")
    ap.add_argument("--slice", help="interview this slice (new session, or the saved one)")
    ap.add_argument("--epic", help="with --title and --idea: create a slice in this epic first")
    ap.add_argument("--title")
    ap.add_argument("--idea")
    ap.add_argument("--model", help="model for the interviewer (default: the person's Claude Code default)")
    ap.add_argument("--budget-per-turn", type=float, default=2.0)
    ap.add_argument("--turn-timeout", type=int, default=600, help="seconds before a turn is stopped")
    ap.add_argument("--reply", action="append", default=[],
                    help="scripted PM replies, used in order before reading stdin (for captured runs)")
    args = ap.parse_args()

    project = args.project.resolve()
    skill_dir = args.skill_dir.resolve() if args.skill_dir else find_skill(project)
    if args.slice:
        if not SLICE_ID.match(args.slice):
            raise SystemExit("invalid: --slice must look like SLICE-001.")
        slice_id = args.slice
        first = f"/mach:product-studio continue {slice_id}"
    else:
        if not (args.epic and args.title and args.idea) or not EPIC_ID.match(args.epic):
            raise SystemExit("invalid: give --slice, or --epic EPIC-NNN with --title and --idea.")
        created = studio(project, skill_dir, "slice", "new", "--epic", args.epic, "--title", args.title)
        slice_id = (created.get("slice") or {}).get("slice_id")
        if not slice_id:
            raise SystemExit("internal: slice new did not report a slice ID.")
        first = (f"/mach:product-studio continue {slice_id}. The app just created it in {args.epic} "
                 f"for this idea from the product manager: {args.idea}")

    scripted = list(args.reply)

    def replies():
        if scripted:
            text = scripted.pop(0)
            sys.stderr.write(f"PM> {text}\n")
            return text
        sys.stderr.write("PM> ")
        sys.stderr.flush()
        line = sys.stdin.readline()
        if not line:
            raise EOFError
        return line

    Bridge(project, skill_dir, slice_id, args.model, args.budget_per_turn, args.turn_timeout).run(first, replies)


if __name__ == "__main__":
    main()
