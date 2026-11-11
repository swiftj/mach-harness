#!/usr/bin/env python3
"""The Factory's execution adapter: start one unattended Claude Code run for a ticket, and read what happened.

One execution is one `claude -p` process that launches the existing MACH belt workflow for one
ticket. This module builds that command, starts it detached behind a small wrapper, and turns
its output into facts a supervisor can act on.

The command is fixed and explicit:

    claude -p "<a fixed prompt naming the workflow and the ticket>"
        --output-format stream-json --verbose     structured events and a final result
        --permission-mode default                 nothing is allowed unless it is listed
        --allowedTools <the list a person consented to>
        --max-budget-usd <limit>  --session-id <a new id>

`--permission-mode default` matters: a machine's own settings may run Claude in a more permissive
mode, and then the tool list would bound nothing. With it, a tool that is not listed is refused,
the refusal is in the output, and the supervisor raises it to a person. Nothing here ever passes a
flag that skips permission checks.

The wrapper exists so that an execution outlives the supervisor that started it and still leaves a
record: it writes started.json when the process is running and result.json when it ends, whatever
happened to the supervisor meanwhile. Its command line carries the execution ID, so a process ID
can be checked against the execution it is supposed to be.

What the ticket's state is afterwards is never taken from this output. It is read from the cell's
own records by run.py, as always.

Standard library only.
"""

import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
EXECUTION_ID_RE = re.compile(r"^x[0-9a-f]{12}$")
ENV = {"CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS": "0"}  # wait for the workflow however long it runs
GRACE_SECONDS = 20


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def folder(root: Path, execution_id: str) -> Path:
    if not EXECUTION_ID_RE.match(execution_id):
        raise ValueError(f"'{execution_id}' is not an execution ID.")
    return root / ".factory" / "local" / "executions" / execution_id


def prompt(workflow: str, tickets: Sequence[str], until: Optional[str]) -> str:
    """The whole instruction given to the unattended run. It contains ticket IDs and nothing a
    product manager or a ticket wrote."""
    for ticket in tickets:
        if not TICKET_ID_RE.match(ticket):
            raise ValueError(f"'{ticket}' is not a usable ticket ID.")
    args: Dict[str, Any] = {"tickets": list(tickets)}
    if until:
        args["until"] = until
    return (f"Run the workflow named {workflow} with args {json.dumps(args)}. Use the Workflow tool. "
            "When it has finished, reply with only the JSON it returned. If you are refused, say so and stop.")


def command(claude: str, workflow: str, tickets: Sequence[str], until: Optional[str], tools: Sequence[str], budget_usd: float, session_id: str) -> List[str]:
    for tool in tools:
        if tool.strip() in ("Bash", "Bash(*)", "*") or "dangerously" in tool:
            raise ValueError("The tool list may not allow every shell command.")
    return [claude, "-p", prompt(workflow, tickets, until), "--output-format", "stream-json", "--verbose", "--permission-mode", "default",
            "--max-budget-usd", str(budget_usd), "--session-id", session_id, "--allowedTools", *tools]


def write_json(path: Path, data: Dict[str, Any]) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(str(temporary), str(path))


def read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def prepare(root: Path, execution_id: str, argv: Sequence[str], timeout_minutes: float) -> Path:
    """Write what the wrapper will run. Kept on disk so a restart can see exactly what was asked."""
    home = folder(root, execution_id)
    home.mkdir(parents=True, exist_ok=True)
    os.chmod(str(home), 0o700)
    write_json(home / "spec.json", {"execution_id": execution_id, "argv": list(argv), "cwd": str(root), "timeout_seconds": int(timeout_minutes * 60), "prepared_at": now()})
    return home


def launch(root: Path, execution_id: str, run_script: Path) -> int:
    """Start the wrapper detached, in its own session, and return its process ID."""
    home = folder(root, execution_id)
    with (home / "wrapper.log").open("ab") as log:
        process = subprocess.Popen([sys.executable, str(run_script), "--project", str(root), "factory", "exec", execution_id],
                                   cwd=str(root), stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    return process.pid


def wrapper(root: Path, execution_id: str) -> int:
    """Run one prepared execution to its end and record how it ended. This is the detached process."""
    home = folder(root, execution_id)
    spec = read_json(home / "spec.json")
    if not spec or (home / "result.json").exists() or (home / "started.json").exists():
        return 2  # nothing prepared, or this execution was already started once: never run it twice
    env = {**os.environ, **ENV}
    interrupted = {"signal": None}

    def stop(number: int, frame: Any) -> None:
        interrupted["signal"] = number

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    started = time.time()
    with (home / "stream.jsonl").open("wb") as out, (home / "stderr.log").open("wb") as err:
        try:
            child = subprocess.Popen(spec["argv"], cwd=spec["cwd"], env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err)
        except OSError as exc:
            write_json(home / "result.json", {"execution_id": execution_id, "ended": "could-not-start", "exit_code": None, "error": str(exc), "ended_at": now()})
            return 1
        write_json(home / "started.json", {"execution_id": execution_id, "wrapper_pid": os.getpid(), "child_pid": child.pid, "started_at": now()})
        ended = "exited"
        while True:
            try:
                code: Optional[int] = child.wait(timeout=1)
                break
            except subprocess.TimeoutExpired:
                pass
            too_long = time.time() - started > spec["timeout_seconds"]
            if interrupted["signal"] is not None or too_long:
                ended = "timed-out" if too_long and interrupted["signal"] is None else "interrupted"
                child.terminate()
                try:
                    code = child.wait(timeout=GRACE_SECONDS)
                except subprocess.TimeoutExpired:
                    child.kill()
                    code = child.wait()
                break
    write_json(home / "result.json", {"execution_id": execution_id, "ended": ended, "exit_code": code, "ended_at": now(), "seconds": int(time.time() - started)})
    return 0


def command_of(pid: int) -> str:
    try:
        return subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def alive(pid: Any, execution_id: str) -> bool:
    """Whether this process ID is still the wrapper of this execution, not some later process that reused the number."""
    return type(pid) is int and pid > 0 and execution_id in command_of(pid)


def stop(pid: Any, execution_id: str) -> bool:
    """Ask a running execution to stop. The wrapper ends its Claude process and records the interruption."""
    if not alive(pid, execution_id):
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    return True


def tool_summary(name: Any, tool_input: Any) -> str:
    """Enough of a refused request for a person to recognise it, and no more: the program a shell
    command would have run, and its subcommand if it has one. Never arguments, paths, variables or file contents."""
    if name == "Bash" and isinstance(tool_input, dict):
        words = str(tool_input.get("command") or "").split()
        while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
            words.pop(0)  # VAR=value prefixes can carry anything
        if not words:
            return "Bash"
        program = Path(words[0]).name[:30]
        sub = words[1] if len(words) > 1 and re.match(r"^[a-z][a-z-]{1,20}$", words[1]) and program in ("git", "gh", "npm", "pnpm", "yarn", "make", "cargo", "go", "docker", "pip", "uv") else ""
        return f"Bash: {program} {sub}".strip()
    return re.sub(r"[^A-Za-z0-9_:.-]", "", str(name))[:60]


def outcome(root: Path, execution_id: str) -> Dict[str, Any]:
    """What is known about an execution from the files it left: started or not, ended or not, and Claude's own report."""
    home = folder(root, execution_id)
    started = read_json(home / "started.json")
    result = read_json(home / "result.json")
    report: Dict[str, Any] = {"execution_id": execution_id, "started": started is not None, "ended": result is not None,
                              "wrapper_pid": (started or {}).get("wrapper_pid"), "started_at": (started or {}).get("started_at"),
                              "how": (result or {}).get("ended"), "exit_code": (result or {}).get("exit_code"), "ended_at": (result or {}).get("ended_at"),
                              "session_id": None, "is_error": None, "subtype": None, "cost_usd": None, "refused_tools": [], "workflow": None}
    stream = home / "stream.jsonl"
    if not stream.is_file():
        return report
    last: Optional[Dict[str, Any]] = None
    refused: List[str] = []
    try:
        with stream.open("r", encoding="utf-8", errors="replace") as lines:
            for line in lines:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                report["session_id"] = report["session_id"] or event.get("session_id")
                if event.get("type") == "system" and event.get("subtype") == "permission_denied":
                    refused.append(tool_summary(event.get("tool_name"), event.get("tool_input")))
                if event.get("type") == "result":
                    last = event
                    refused += [tool_summary(item.get("tool_name"), item.get("tool_input")) for item in event.get("permission_denials") or [] if isinstance(item, dict)]
    except OSError:
        return report
    report["refused_tools"] = sorted(set(refused))
    if last is not None:
        report.update({"is_error": bool(last.get("is_error")), "subtype": last.get("subtype"), "cost_usd": last.get("total_cost_usd")})
        text = last.get("result")
        if isinstance(text, str):
            try:
                parsed = json.loads(text[text.index("{"):text.rindex("}") + 1])
            except ValueError:
                parsed = None
            if isinstance(parsed, dict):
                # Only the workflow's own summary of where each ticket stopped; never free text.
                tickets = [{key: str(item.get(key))[:200] for key in ("ticket", "outcome", "stage", "waiting_for") if item.get(key) is not None}
                           for item in parsed.get("tickets") or [] if isinstance(item, dict)]
                report["workflow"] = {"tickets": tickets, "error": str(parsed["error"])[:300] if parsed.get("error") else None}
    return report
