#!/usr/bin/env python3
"""MACH build station: keep one cell's construction honest.

The builder (a model) writes the code. This script decides everything a script can decide:
whether building may start, which task is next, that a test was seen failing before the code
that satisfies it was written, that committed tests are not quietly edited to pass, that each
change stays inside the files its task declared, and that the cell is complete before it is
handed to verification.

    build.py start <ticket>            check the gates, read plan.md, record the baseline
    build.py next <ticket>             show the next task with the spec text it must satisfy
    build.py red <ticket> <task>       a [test] task: the suite must fail; commits the tests
    build.py green <ticket> <task>     an [impl] task: the suite must pass; commits the code
                                       (--already-done "<why>": an earlier task already implemented it and
                                        committed tests name every ID it carries; no commit, recorded)
    build.py done <ticket> <task>      a [contract], [refactor] or [docs] task; commits it
    build.py add-task <ticket> ...     add a task during a revision round
    build.py finish <ticket>           final gate; writes build-report.json
    build.py revise <ticket>           start a revision after a failed round; the third failed round escalates
    build.py set-commands <ticket> --test-cmd "<command>" [--lint-cmd "<command>"] --reason "<why>"
                                       give a build in progress its test (or lint) command, or change it, at any time; recorded
                                       as a deviation; nothing done is undone and the build carries on from where it is
    build.py status <ticket>

Lanes (M22): a plan whose author divided its tasks into parts (`### Before the lanes`, `### Lanes`, `### After the lanes`)
or marked a task `after Tnn` is built in lanes when build.max_lanes is above 1 (default 3): chains of tasks that share no
file and no requirement, each in its own sparse worktree under the cell, on its own branch, with its own state file and its
own builder, under the same gates. A plan without those additions is built one task at a time, exactly as before.

    build.py lanes <ticket>                              the lane plan and each lane's status; reads only
    build.py lanes-open <ticket> --holder H [--grant N] [--take-over]
                                                         make the lanes' worktrees and say which lanes to start now
    build.py next <ticket> --lane L                      a lane's next task, in the lane's own worktree
    build.py join <ticket>                               land every lane's commits on the ticket's branch, one per task in
                                                         plan order, and run the whole suite on the result
    build.py hand-back <ticket> --lane L --reason "<why>"
                                                         a lane that cannot finish: its finished tasks still land at the join,
                                                         its unfinished ones are built in the cell, one at a time, after it

Architecture decisions (adr.py, the intent station's shared helper): `start` lists the accepted ADRs the plan was made
under and refuses a High-risk ticket whose own proposed ADR no person has accepted; no step may change a file in the ADR
folder, and no override allows it; the build report lists the ADRs in force and every exception.

Secrets (scan.py, the intent station's shared helper): before each commit this station makes, the added lines of what is
about to be committed are scanned for credentials by their well-known shapes. A candidate refuses the step; red, green and
done accept --not-a-secret "<why>", recorded with the places it covered (file, line, kind; never the value) for the
reviewers. security.scan.enabled: false in .factory/config.json switches the gate off, and the build report says so.

Building on today's main (M13): `start` and `revise` first bring the ticket's branch up to date with the main checkout's
committed HEAD (one merge commit made by this station, recorded in build.json and the build report), and never at any other
step, so never inside a red-to-green pair. A conflict aborts the merge, changes nothing, records `main_conflict` in cell.json
for the routing sheet and refuses for a person. The merge is not a task: the scope, frozen-test and secrets gates judge only
what the builder changes after it, and the report's files and diff leave out what main brought. build.update_from_main:
false in .factory/config.json switches it off.

Standard library only. It runs the project's test and lint commands inside the cell.
"""

import argparse
import contextlib
import copy
import hashlib
import importlib.util
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
TASK_RE = re.compile(r"^\s*[-*+]\s+\[([ xX])\]\s+((?:R\d+-)?T\d+)\s+\[(test|impl|contract|refactor|docs)\]\s+(.*)$")
ID_RE = re.compile(r"\b(?:FR|INV|AC)-\d{2,}\b")
PATH_RE = re.compile(r"`([^`\s()<>]+)`")
# The plan template puts a task's files after an em dash, in backticks, before its ID list:
#   - [ ] T02 [impl] <what> — `<file>`, `<file>` (<FR-NN>)
# Backticked words earlier on the line are prose (an example e-mail address, a host name, a value).
FILES_SEPARATOR = " \u2014 "
PATH_TOKEN_RE = re.compile(r"^[\w.+\-\[\]]+(?:/[\w.+\-\[\]]+)*$")
KINDS = ("test", "impl", "contract", "refactor", "docs")
COMMIT_PREFIX = {"test": "test", "impl": "feat", "contract": "chore", "refactor": "refactor", "docs": "docs"}
STEP_FOR = {"test": "red", "impl": "green", "contract": "done", "refactor": "done", "docs": "done"}
HARDENING_LABEL = "repo-hardening"
# set-commands --by: where the person who named the command decided (--via).
SET_BY_VIA = {"terminal": "an agent, on the person's instruction in conversation", "floor": "a person, in the Factory Floor"}
# Lifecycle log: the gate each recorded override passes.
OVERRIDDEN_GATE = {"test-amended": "frozen-tests", "files-outside-plan": "scope", "test-passed-first-run": "red-before-green",
                   "red-not-attributed": "red-attribution", "test-written-early": "red-before-green", "no-baseline": "baseline",
                   "impl-already-done": "changed-no-files", "not-a-secret": "secrets"}
UI_FILE_RE = re.compile(r"\.(tsx|jsx|vue|svelte|html|astro)$")
INLINE_STYLE_RE = re.compile(r"style\s*=\s*(\"|'|\{\{)")
HEX_COLOR_RE = re.compile(r"(?<![\w&])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b")
EXCLUDE_LINE = ".factory/worktrees/"
# build.max_lanes when the project's settings give no usable value. cell.py's DEFAULT_MAX_LANES is the same number (a test
# checks that the two stay equal): the plan stage and this station read the setting the same way.
DEFAULT_MAX_LANES = 3
DEFAULT_MAX_PARALLEL = 3  # factory.max_parallel when the settings name none (intake.py, schedule.py)
DEFAULT_CLAIM_MINUTES = 90  # factory.claim_minutes when the settings name none (claim.py)
HOLDER_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
JOIN_TASK = "J-T01"
LANES_NEXT = "Stop here and report. The line starts one builder per lane."
LANE_DONE_NEXT = "Report and stop. The line joins the lanes."


def set_commands_hint(ticket_id: str) -> str:
    """The command that gives a build in progress its test command, or changes it."""
    return f'build.py set-commands {ticket_id} --test-cmd "<command>" --reason "<why>"'


def set_aside_hint(work: Path, ticket_id: str, what: str) -> str:
    """How a person sets uncommitted files aside without losing them, and brings them back."""
    return (f'sets them aside with: git -C "{work}" stash push --include-untracked -m "{ticket_id} {what}" '
            f'(nothing is lost: git -C "{work}" stash list shows them, and git -C "{work}" stash apply brings them back)')

try:
    import fcntl  # the lanes' lock; where there is none, lanes-open and join run without it
except ImportError:  # pragma: no cover - not POSIX
    fcntl = None  # type: ignore[assignment]


# Files that running a build or test suite leaves behind. They are never part of a change, so the
# gates ignore them even when the project forgot to git-ignore them.
BYPRODUCT_RE = re.compile(
    r"(^|/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|htmlcov|\.hypothesis|node_modules|\.gradle|\.next|\.turbo|coverage)(/|$)"
    r"|\.py[co]$|(^|/)\.coverage(\..*)?$|(^|/)\.DS_Store$|\.egg-info(/|$)|\.tsbuildinfo$"
)


def is_byproduct(name: str) -> bool:
    return bool(BYPRODUCT_RE.search(name))


class BuildError(Exception):
    """A gate refused. Printed without a traceback; exit code 1. `code` names the gate's reason for the lifecycle log."""

    def __init__(self, message: str = "", code: str = "not-recorded") -> None:
        super().__init__(message)
        self.code = code

# M6.1 station telemetry. The shared helper lives with the intent station. It is observational only: if it
# cannot be loaded, nothing is recorded and this station behaves exactly as before.
try:
    _SKILL = Path(__file__).resolve().parent.parent
    sys.path.append(str(_SKILL.parent / ("mach-intent" if _SKILL.name.startswith("mach-") else "intent") / "scripts"))
    import lifecycle  # noqa: E402
except Exception:  # noqa: BLE001
    lifecycle = None


def telemetry(*args: Any, **kwargs: Any) -> None:
    """Report what this station has just recorded to the cell's lifecycle log. Never raises."""
    if lifecycle is not None:
        lifecycle.record(*args, **kwargs)


# Architecture decisions: the shared helper, also with the intent station. Its rules are gates, so a build without it refuses.
try:
    import adr  # noqa: E402
except Exception:  # noqa: BLE001
    adr = None


# Whether the readiness audit must run again: the one rule, shared with run.py. Its rule is a gate, so a build without it refuses.
try:
    import audit_state  # noqa: E402
except Exception:  # noqa: BLE001
    audit_state = None


# The secrets and dependency scan: a shared helper with the intent station too. Its rule is a gate, so a build without it refuses.
try:
    import scan  # noqa: E402
except Exception:  # noqa: BLE001
    scan = None

# A ticket's workspace (the cell's sparse worktree, which never holds .claude/ or .mcp.json): shared with the intent station.
try:
    import workspace  # noqa: E402
except Exception:  # noqa: BLE001
    workspace = None

# The environment of the project's commands (command_env.py): shared with the intent station, and with the audit, verify
# and merge stations, which run commands by the same rule.
try:
    import command_env  # noqa: E402
except Exception:  # noqa: BLE001
    command_env = None


def command_env_module() -> Any:
    if command_env is None:
        raise BuildError("The intent station's command_env.py is not installed beside this skill, so the project's commands cannot be run.",
                         code="command-env-missing")
    return command_env

SECRET_REMEDY = ("Never commit a credential. Read it at run time from the environment or a secret store; in a test, build a fake one at run time "
                 "(for example by joining two strings) so that no file holds it. If what was found is not a secret at all, rerun with "
                 "--not-a-secret \"<why>\"; the reason and the places (never the value) go to the reviewers. Never use it for a real credential.")


def scan_enabled(config: Dict[str, Any]) -> bool:
    """security.scan.enabled in .factory/config.json; anything but an explicit false is on."""
    section = config.get("security") if isinstance(config.get("security"), dict) else {}
    settings = section.get("scan") if isinstance(section.get("scan"), dict) else {}
    return settings.get("enabled") is not False


def adr_module() -> Any:
    if adr is None:
        raise BuildError("The intent station's adr.py is not installed beside this skill, so the architecture-decision rules cannot be checked.", code="adr-helper-missing")
    return adr


def adr_folder(cell: "Cell") -> str:
    return adr_module().folder_of(cell.config)[0]


def adrs_in_force(cell: "Cell") -> Dict[str, Any]:
    """What the builder is held to: the accepted ADRs the plan was made under that apply to it, each with the copy of its text
    kept in the cell, the exceptions a person recorded, and this ticket's own proposals. There is no override for them."""
    A = adr_module()
    record = A.planned_record(cell.info)
    applied = set(record.get("applied") or [])
    apply = [{"id": item.get("id"), "title": item.get("title"), "read": str(cell.root / str(item.get("copy") or "")) if item.get("copy") else None,
              "file": item.get("file"), "digest": item.get("digest")}
             for item in record.get("planned_under") or [] if isinstance(item, dict) and (item.get("id") in applied or item.get("origin") == "ticket")]
    return {"apply": apply, "exceptions": [{key: item.get(key) for key in ("adr", "by", "reason", "at")} for item in A.exceptions(cell.info)],
            "proposed": [{key: item.get(key) for key in ("id", "file", "title")} for item in record.get("proposed") or [] if isinstance(item, dict)],
            "note": A.DATA_NOTE + " No gate override covers an ADR, and no task changes an ADR file."}



def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)


def find_project(start: Path) -> Path:
    start = start.resolve()
    parts = start.parts
    for index in range(len(parts) - 2, 0, -1):
        if parts[index] == "worktrees" and parts[index - 1] == ".factory":
            return Path(*parts[:index - 1])
    for marker in (".factory", ".git"):
        for folder in [start, *start.parents]:
            if (folder / marker).exists():
                return folder
    return start


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


class Cell:
    def __init__(self, project: Path, ticket_id: str) -> None:
        if not TICKET_ID_RE.match(ticket_id):
            raise BuildError(f"'{ticket_id}' is not a usable ticket ID.", code="bad-ticket-id")
        self.project = project
        self.ticket_id = ticket_id
        self.root = project / ".factory" / "worktrees" / ticket_id
        self.info = load_json(self.root / "cell.json")
        if not isinstance(self.info, dict):
            raise BuildError(f"No cell for {ticket_id}. Groom the ticket with the intent skill first.", code="no-cell")
        config = load_json(project / ".factory" / "config.json", {})
        self.config = config if isinstance(config, dict) else {}
        self.state_path = self.root / "build.json"
        self.state: Dict[str, Any] = load_json(self.state_path, {}) or {}

    @property
    def work(self) -> Path:
        return self.root / "repo" if self.info.get("isolation") == "worktree" else self.project

    def section(self, name: str) -> Dict[str, Any]:
        value = self.config.get(name)
        return value if isinstance(value, dict) else {}

    def save_info(self) -> None:
        self.info["updated_at"] = now()
        (self.root / "cell.json").write_text(json.dumps(self.info, indent=2) + "\n", encoding="utf-8")

    def save(self) -> None:
        self.state["updated_at"] = now()
        self.state_path.write_text(json.dumps(self.state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    lane: Optional[str] = None  # the lane a Lane works in; None for the cell's own checkout
    recovered: Optional[Dict[str, Any]] = None  # a task an interrupted step committed, recorded when this lane was opened

    def tick(self, task_id: str) -> None:
        """Mark the task done in plan.md. A lane never writes plan.md: the join ticks its tasks once."""
        tick_plan(self, task_id)

    def all_done_hint(self) -> str:
        return "All tasks are done. Run: build.py finish " + self.ticket_id

    def require_started(self) -> None:
        if not self.state.get("tasks"):
            raise BuildError(f"Building has not started for {self.ticket_id}. Run: build.py start {self.ticket_id}", code="not-started")

    def task(self, task_id: str) -> Dict[str, Any]:
        for task in self.state["tasks"]:
            if task["id"] == task_id:
                return task
        raise BuildError(f"{task_id} is not a task in this plan. Tasks: {', '.join(t['id'] for t in self.state['tasks'])}.", code="unknown-task")

    def next_task(self) -> Optional[Dict[str, Any]]:
        return next((task for task in self.state["tasks"] if task["status"] != "done"), None)

    def deviation(self, task_id: Optional[str], kind: str, detail: str) -> None:
        self.state.setdefault("deviations", []).append({"task": task_id, "type": kind, "detail": detail, "loop": self.state.get("loop", 0), "at": now()})

    def report_overrides(self, task_id: Optional[str]) -> None:
        """Lifecycle: each gate this step passed by a recorded override, once build.json holds it. The reason text stays in build.json."""
        try:
            for item in [d for d in self.state.get("deviations") or [] if d.get("task") == task_id and d.get("loop") == self.state.get("loop", 0)]:
                telemetry(self.root, "gate.evaluated", "build", lambda item=item: {
                    "gate": OVERRIDDEN_GATE.get(item.get("type"), item.get("type")), "outcome": "override", "reason_code": item.get("type"),
                    "overridden_by_reason": True, "task": task_id})
        except Exception:  # noqa: BLE001 - telemetry only
            pass


# ---------------------------------------------------------------- plan

def is_path_token(token: str) -> bool:
    """A relative file path as a plan writes one: no address, URL, absolute path or parent step."""
    if not PATH_TOKEN_RE.match(token) or token.startswith("-") or len(token) > 255:
        return False
    return not any(part in (".", "..") for part in token.split("/"))


def task_line_files(body: str) -> List[str]:
    """The files a task line names: the backticked paths after its last em dash, and nothing from the prose before it."""
    if FILES_SEPARATOR not in body:
        return []
    return [token for token in PATH_RE.findall(body.rsplit(FILES_SEPARATOR, 1)[1]) if is_path_token(token)]


def parse_plan(text: str) -> Tuple[List[Dict[str, Any]], Dict[str, List[str]]]:
    """Tasks in order, and the file touch map as {file: [task ids]}."""
    tasks: List[Dict[str, Any]] = []
    touch: Dict[str, List[str]] = {}
    section = ""
    for line in text.splitlines():
        heading = re.match(r"^##\s+(.+?)\s*$", line)
        if heading:
            section = heading.group(1).lower()
            continue
        if section == "tasks":
            match = TASK_RE.match(line)
            if match:
                body = match.group(4)
                tasks.append({
                    "id": match.group(2), "kind": match.group(3), "text": body.strip(),
                    "ids": sorted(set(ID_RE.findall(body))),
                    "line_files": task_line_files(body),
                    "status": "done" if match.group(1).lower() == "x" else "pending",
                })
        elif section == "file touch map" and line.strip().startswith("|"):
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if len(cells) >= 3 and "`" in cells[0]:
                name = cells[0].strip("`").strip()
                if is_path_token(name):
                    touch[name] = re.findall(r"(?:R\d+-)?T\d+", cells[-1])
    for task in tasks:
        mapped = [name for name, ids in touch.items() if task["id"] in ids]
        task["files"] = sorted(set(mapped) | set(task.pop("line_files")))
    return tasks, touch


def tick_plan(cell: Cell, task_id: str) -> None:
    path = cell.root / "plan.md"
    if not path.is_file():
        return
    pattern = re.compile(rf"^(\s*[-*+]\s+)\[ \](\s+{re.escape(task_id)}\s)", re.MULTILINE)
    text = path.read_text(encoding="utf-8")
    path.write_text(pattern.sub(r"\1[x]\2", text, count=1), encoding="utf-8")


# ---------------------------------------------------------------- gates and runs

def ticket_labels(cell: Cell) -> List[str]:
    inbox = load_json(cell.project / ".factory" / "inbox" / f"{cell.ticket_id}.json", {}) or {}
    labels = list(inbox.get("labels") or [])
    local = cell.project / ".factory" / "tickets" / f"{cell.ticket_id}.md"
    if local.is_file():
        front = re.match(r"^---\n(.*?)\n---", local.read_text(encoding="utf-8"), re.DOTALL)
        line = re.search(r"^labels:\s*(.*)$", front.group(1), re.MULTILINE) if front else None
        if line:
            labels += [a or b for a, b in re.findall(r'"([^"]*)"|([^\s,\[\]"]+)', line.group(1))]
    return labels


def audit_gate(cell: Cell) -> Dict[str, Any]:
    """Read the audit station's report through the shared rule (the intent station's audit_state.py, as run.py does).
    Bronze blocks everything except repository hardening."""
    if audit_state is None:
        raise BuildError("The intent station's audit_state.py is not installed beside this skill, so the audit gate cannot be read.", code="audit-helper-missing")
    judged = audit_state.state(cell.project, cell.config)
    if judged["state"] == "off":
        return {"tier": None, "human_review_required": False, "note": "The audit gate is switched off in .factory/config.json."}
    hardening = HARDENING_LABEL in ticket_labels(cell)
    if judged["state"] == "missing":
        raise BuildError("There is no audit report. Run the audit skill on the main checkout first; building is gated on it.", code="audit-missing")
    if judged["state"] == "stale":
        raise BuildError(judged["reason"] + " Run the audit skill on the main checkout, then start the build.", code="audit-stale")
    tier = judged.get("tier")
    if tier not in ("Gold", "Silver"):
        if not hardening:
            raise BuildError(
                "The repository's readiness tier is Bronze, so autonomous building is blocked: " + " ".join(judged.get("blockers") or [])
                + f" Only tickets labelled '{HARDENING_LABEL}' may be built until it is hardened.", code="audit-bronze"
            )
        return {"tier": tier, "human_review_required": True, "note": "Bronze repository: allowed because this is a hardening ticket. A person must review it."}
    return {"tier": tier, "human_review_required": tier == "Silver", "note": "Silver: a person must review before merge." if tier == "Silver" else "Gold."}


def mark_audit_due(cell: Cell, code: str) -> None:
    """The tests failed in the cell before any change: record that the audit is due again, so a main branch that broke
    since it ran is measured before the next build. Not for a hardening ticket, which may start from a failing suite."""
    if audit_state is not None and cell.section("build").get("require_audit") is not False:
        audit_state.mark_due(cell.project, code, cell.ticket_id, "A build's tests failed in its cell before any change.")


def find_command(cell: Cell, kind: str, given: Optional[str]) -> Optional[str]:
    if given:
        return given
    for section in ("build", "audit"):
        commands = cell.section(section).get("commands")
        if isinstance(commands, dict) and isinstance(commands.get(kind), str) and commands[kind].strip():
            return commands[kind]
    report = load_json(cell.project / ".factory" / "audit-report.json", {}) or {}
    command = ((report.get("commands") or {}).get(kind) or {}).get("command")
    return command if isinstance(command, str) and not command.startswith("builtin:") else None


def run_command(cell: Cell, command: str, timeout: int) -> Dict[str, Any]:
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        raise BuildError(f"Cannot parse the command '{command}': {exc}", code="command-unparsable")
    # One rule for every station's project commands (command_env.py): no Python byte code left in the checkout, a package
    # cache that cannot be written pointed into the project's .factory/cache/ (one for the cell and every lane), commands.env,
    # and a leading VAR=value of the command's own.
    env, argv = command_env_module().environment(cell.project, cell.work, argv)
    if not argv or (shutil.which(argv[0]) is None and not (cell.work / argv[0]).is_file()):
        raise BuildError(f"'{argv[0] if argv else command}' is not installed or not on PATH, so '{command}' cannot run in the cell.", code="command-missing")
    started = time.monotonic()
    try:
        done = subprocess.run(argv, cwd=str(cell.work), capture_output=True, text=True, errors="replace", timeout=timeout, stdin=subprocess.DEVNULL, env=env)
        code, out = done.returncode, done.stdout + ("\n" + done.stderr if done.stderr else "")
    except subprocess.TimeoutExpired:
        code, out = 124, f"Still running after {timeout} seconds; stopped."
    tail = out.strip()[-3000:]
    hint = command_env_module().network_hint(out) if code not in (0, 124) else None
    if hint:  # added to the failure output, which every caller shows from its end; no gate's outcome changes
        tail = tail[-(2998 - len(hint)):] + "\n\n" + hint
    return {"command": command, "exit_code": code, "passed": code == 0, "seconds": round(time.monotonic() - started, 1), "output_tail": tail, "output": out}


def run_tests(cell: Cell) -> Dict[str, Any]:
    command = cell.state.get("test_cmd")
    if not command:
        if cell.state.get("tasks"):
            raise BuildError("No test command is known for this build, so no step that runs the tests can be judged yet. Give it one, and the "
                             "build carries on from where it is, with nothing done undone: " + set_commands_hint(cell.ticket_id), code="no-test-command")
        raise BuildError(f'No test command is known. Pass one to the start: build.py start {cell.ticket_id} --test-cmd "<command>", or set '
                         "build.commands.test in .factory/config.json.", code="no-test-command")
    timeout = cell.section("audit").get("timeouts", {}).get("test", 300) if isinstance(cell.section("audit").get("timeouts"), dict) else 300
    return run_command(cell, command, timeout)


TEST_FILE_RE = re.compile(r"(?:^|/)(?:test_[^/]*\.py|[^/]*_test\.py)$")


def test_file_template(cell: Cell) -> Optional[str]:
    """How this project runs only some test files: a command with a {files} place, or None when it cannot be known.

    The project's own setting wins (build.commands.test_file or audit.commands.test_file, which must contain
    {files}). Otherwise it is worked out for runners whose command line is known: Python's unittest and pytest.
    For anything else (make, npm, go, cargo ...) there is no guess, and the whole suite is run as before."""
    for section in ("build", "audit"):
        commands = cell.section(section).get("commands")
        given = commands.get("test_file") if isinstance(commands, dict) else None
        if isinstance(given, str) and "{files}" in given:
            return given.strip()
    command = cell.state.get("test_cmd")
    try:
        argv = shlex.split(command) if isinstance(command, str) else []
    except ValueError:
        return None
    lead = []
    while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):
        lead.append(argv.pop(0))
    if not argv:
        return None
    program = Path(argv[0]).name
    quoted = [shlex.quote(part) for part in lead]
    if re.fullmatch(r"python[0-9.]*", program) and "-m" in argv:
        at = argv.index("-m")
        module = argv[at + 1] if at + 1 < len(argv) else ""
        if module in ("unittest", "pytest"):
            return " ".join(quoted + [shlex.quote(part) for part in argv[:at + 2]] + ["{files}"])
    if program in ("pytest", "py.test"):
        return " ".join(quoted + [shlex.quote(argv[0]), "{files}"])
    return None


def test_file_command(cell: Cell, files: Sequence[str]) -> Optional[str]:
    """The command that runs only these test files, when this cell has checked that such a run can be trusted."""
    template = cell.state.get("test_file_cmd")
    names = [name for name in files if TEST_FILE_RE.search(name) and (cell.work / name).is_file()]
    if not isinstance(template, str) or not names or len(names) != len([name for name in files if (cell.work / name).is_file()]):
        return None  # no trusted way, or the task also changed files that are not test files: run the whole suite
    return template.replace("{files}", " ".join(shlex.quote(name) for name in names))


def calibrate_test_file(cell: Cell) -> Dict[str, Any]:
    """Decide once, at the start, whether running one test file on its own can be trusted in this project.

    It is trusted only if a test file that is already committed, and passes in the whole suite, also passes when
    run on its own. Otherwise a new test could fail on its own for a reason that is not the test (the runner cannot
    load it that way), and be counted as seen failing. With no such proof the whole suite is run for every step."""
    listed = git(cell.work, "ls-files").stdout.split("\n")
    known = sorted(name for name in listed if TEST_FILE_RE.search(name) and (cell.work / name).is_file())  # not one a sparse cell leaves out
    if not known:
        return {"trusted": False, "why": "no Python test file is committed yet to check a single-file run against"}
    # The project's own way first; then, for a test command of another shape (make test, a script), the two usual
    # ways to run a Python test file. Each is only a candidate: it is trusted only if it passes the check below.
    own = test_file_template(cell)
    candidates = [own] if own else [f"{shlex.quote(sys.executable)} -m unittest {{files}}", f"{shlex.quote(sys.executable)} -m pytest {{files}}"]
    timeout = min(120, cell.section("audit").get("timeouts", {}).get("test", 300) if isinstance(cell.section("audit").get("timeouts"), dict) else 300)
    why = "no single-file command passed the check"
    for template in candidates:
        try:
            tried = run_command(cell, template.replace("{files}", shlex.quote(known[0])), timeout)
        except BuildError as exc:
            why = f"the single-file command could not run ({exc})"
            continue
        if tried["passed"]:
            cell.state["test_file_cmd"] = template
            check = {"trusted": True, "checked_with": known[0], "seconds": tried["seconds"], "command": template, "one_test_at_a_time": False}
            # Can one test be run on its own? Only for runners whose form is known, and only if a committed test passes that way.
            kind = "pytest" if re.search(r"(?:^|[\s/])(?:pytest|py\.test)(?:\s|$)", template) else "unittest" if "-m unittest" in template else None
            existing = tests_in((cell.work / known[0]).read_text(encoding="utf-8", errors="replace")) or {}
            first = next((test for test in sorted(existing) if kind == "pytest" or "." in test), None)
            if kind and first:
                cell.state["test_one"] = kind
                proof = run_one_test(cell, known[0], first, timeout)
                if proof is not None and proof["passed"]:
                    check["one_test_at_a_time"] = True
                else:
                    cell.state.pop("test_one", None)
            return check
        why = f"{known[0]} passes in the whole suite but not when run on its own, so single-file runs are not trusted here"
    return {"trusted": False, "why": why + "; set build.commands.test_file to name a command with {files}" if not own else why}


def tests_in(source: str) -> Optional[Dict[str, str]]:
    """Each test in a Python test file, as "Class.test_name" (or "test_name" at module level), with a fingerprint of its code."""
    import ast
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return None
    found: Dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test"):
            found[node.name] = ast.dump(node)
        elif isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name.startswith("test"):
                    found[f"{node.name}.{item.name}"] = ast.dump(item)
    return found


def tests_of_this_task(cell: Cell, files: Sequence[str]) -> Optional[List[Tuple[str, str]]]:
    """(file, test) for every test this task added or changed, or None when that cannot be read from the files.

    Several tasks often share one test file, and the suite may already be failing from an earlier task's tests. So the
    question "was this task's test seen failing?" is asked of this task's own tests, not of the file or the suite."""
    mine: List[Tuple[str, str]] = []
    for name in files:
        path = cell.work / name
        if not path.is_file():
            continue
        if not TEST_FILE_RE.search(name):
            return None  # the task changed something that is not a Python test file: judged the old way
        now_tests = tests_in(path.read_text(encoding="utf-8", errors="replace"))
        shown = git(cell.work, "show", f"HEAD:{name}")
        before = tests_in(shown.stdout) if shown.returncode == 0 else {}
        if now_tests is None or before is None:
            return None
        mine += [(name, test) for test, code in now_tests.items() if before.get(test) != code]
    return mine or None


def one_test_command(cell: Cell, name: str, test: str) -> Optional[str]:
    """The command that runs exactly one test, for the runners whose form is known; None otherwise."""
    template = cell.state.get("test_file_cmd")
    kind = cell.state.get("test_one")
    if not isinstance(template, str) or kind not in ("unittest", "pytest"):
        return None
    if kind == "pytest":
        return template.replace("{files}", shlex.quote(name + "::" + test.replace(".", "::")))
    if "." not in test:
        return None  # unittest does not collect a test function outside a class
    return template.replace("{files}", shlex.quote(name)) + " -k " + shlex.quote("*." + test)


NO_TESTS_RE = re.compile(r"\bRan 0 tests\b|NO TESTS RAN|no tests ran|collected 0 items", re.IGNORECASE)


def run_one_test(cell: Cell, name: str, test: str, timeout: int) -> Optional[Dict[str, Any]]:
    """One test run on its own: passed or failed, or None when the runner found no such test (so nothing is known)."""
    command = one_test_command(cell, name, test)
    if command is None:
        return None
    done = run_command(cell, command, timeout)
    if NO_TESTS_RE.search(done["output"]) or done["exit_code"] in (5, 124):
        return None
    return done


def run_this_tasks_tests(cell: Cell, files: Sequence[str]) -> Optional[Dict[str, Any]]:
    """Each of this task's tests run on its own: which fail and which already pass. None when that cannot be done."""
    mine = tests_of_this_task(cell, files)
    if not mine or len(mine) > 40 or cell.state.get("test_one") not in ("unittest", "pytest"):
        return None
    timeout = min(120, cell.section("audit").get("timeouts", {}).get("test", 300) if isinstance(cell.section("audit").get("timeouts"), dict) else 300)
    failed, passed, seconds, output = [], [], 0.0, []
    for name, test in mine:
        done = run_one_test(cell, name, test, timeout)
        if done is None:
            return None
        seconds += done["seconds"]
        (passed if done["passed"] else failed).append(test)
        if not done["passed"]:
            output.append(done["output"])
    return {"failed": failed, "passed": passed, "seconds": round(seconds, 1), "output": "\n".join(output)}


def changed_files(cell: Cell) -> List[str]:
    out = git(cell.work, "status", "--porcelain", "--untracked-files=all").stdout
    files = []
    for line in out.splitlines():
        name = line[3:]
        if " -> " in name:
            name = name.split(" -> ", 1)[1]
        files.append(name.strip().strip('"'))
    return sorted(name for name in set(files) if not is_byproduct(name))


def commit(cell: Cell, files: Sequence[str], message: str) -> str:
    if git(cell.work, "add", "-A", "--", *files).returncode != 0:
        raise BuildError("git could not stage the task's files.", code="git-stage-failed")
    done = git(cell.work, "commit", "-q", "-m", message)
    if done.returncode != 0:
        raise BuildError("git commit failed: " + (done.stderr.strip() or done.stdout.strip()), code="git-commit-failed")
    return git(cell.work, "rev-parse", "HEAD").stdout.strip()


def check_scope(cell: Cell, task: Dict[str, Any], files: Sequence[str], args: argparse.Namespace) -> None:
    """A task may change only the files the plan gave it, and never a committed test unless it says so. No task changes an
    architecture decision record, and no override allows it."""
    if not files:
        raise BuildError(f"{task['id']} changed no files. Do the task's work in {cell.work} first.", code="changed-no-files")
    config = [name for name in files if workspace is not None and workspace.protected(name)]
    if config:
        raise BuildError(f"{task['id']} writes Claude Code configuration ({', '.join(config[:3])}), which a ticket's workspace never holds. "
                         "Remove it; a person makes that change outside the factory. No override allows it.", code="claude-config")
    folder = adr_folder(cell)
    decisions = [name for name in files if adr_module().in_folder(name, folder)]
    if decisions:
        raise BuildError(f"{task['id']} changes architecture decision records ({', '.join(decisions[:3])}). Only people change an ADR, by pull request; "
                         "no override allows it. Undo those changes. If the code cannot follow an ADR, stop and report it.", code="adr-files")
    if cell.lane:
        foreign = sorted(set(files) & set(cell.foreign_files()))
        if foreign:
            raise BuildError(f"{task['id']} is in lane {cell.lane} but changes files the plan gives another lane: {', '.join(foreign[:5])}. "
                             "Lanes are built at the same time from the same starting point, so a lane never changes another lane's file, and "
                             "no override allows it (neither --allow-extra nor --amend-test). Undo those changes. If this lane cannot be built "
                             "without them, the plan's claim that its lanes are independent is wrong for it. Hand the lane's remaining tasks back "
                             f"to the cell, where they are built one at a time after the join and may change any file their plan gives them: "
                             f"build.py hand-back {cell.ticket_id} --lane {cell.lane} --reason \"<which file, and why>\". This lane's committed "
                             "work is kept and lands at the join. Report it too, naming the file, so the plan is put right.",
                             code="lane-scope")
    frozen =sorted(set(files) & set(cell.state.get("test_files", []))) if task["kind"] != "test" else []
    if frozen:
        if not args.amend_test:
            raise BuildError(
                f"{task['id']} is a [{task['kind']}] task but it changes tests that are already committed: {', '.join(frozen)}. "
                "Make the code satisfy the tests, not the reverse. If a test is genuinely wrong, rerun with --amend-test \"<why>\"; the reason goes to the reviewers.",
                code="frozen-tests"
            )
        cell.deviation(task["id"], "test-amended", f"{', '.join(frozen)}: {args.amend_test}")
    allowed = set(task.get("files") or [])
    extra = [name for name in files if allowed and name not in allowed and name not in frozen]
    if extra:
        if not args.allow_extra:
            raise BuildError(
                f"{task['id']} changed files the plan did not give it: {', '.join(extra)}. Its files are: {', '.join(sorted(allowed))}. "
                "Undo the extra changes, or if they are truly needed rerun with --allow-extra \"<why>\"; the reason goes to the reviewers.",
                code="scope"
            )
        cell.deviation(task["id"], "files-outside-plan", f"{', '.join(extra)}: {args.allow_extra}")
    check_secrets(cell, task, files, args)


def pending_diff(cell: Cell, files: Sequence[str]) -> str:
    """What is about to be committed, as a diff against HEAD: tracked files from git, new files as wholly added."""
    parts = []
    tracked = set(git(cell.work, "ls-files", "--", *files).stdout.splitlines()) if files else set()
    for name in files:
        path = cell.work / name
        if name in tracked:
            parts.append(git(cell.work, "diff", "--unified=0", "--no-color", "--no-ext-diff", "HEAD", "--", name).stdout)
        elif path.is_file() and not path.is_symlink():
            try:
                data = path.read_bytes()[:4_000_000]
            except OSError:
                continue
            if b"\0" in data:
                continue
            lines = data.decode("utf-8", errors="replace").splitlines()
            parts.append(f"diff --git a/{name} b/{name}\nnew file mode 100644\n--- /dev/null\n+++ b/{name}\n@@ -0,0 +1,{len(lines)} @@\n"
                         + "".join(f"+{line}\n" for line in lines))
    return "".join(parts)


def check_secrets(cell: Cell, task: Dict[str, Any], files: Sequence[str], args: argparse.Namespace) -> None:
    """No secret enters the branch: the added lines of what is about to be committed are scanned, and a candidate refuses
    the step unless the builder records why it is not a secret (--not-a-secret). The value is never printed or stored."""
    if not files or not scan_enabled(cell.config):
        return
    if scan is None:
        raise BuildError("The intent station's scan.py is not installed beside this skill, so the secrets gate cannot run.", code="scan-helper-missing")
    found = scan.secrets(pending_diff(cell, files))
    candidates = found["candidates"]
    if not candidates:
        return
    places = "; ".join(f"{item['file']}:{item['line']} ({item['kind']})" for item in candidates[:10]) + (f"; and {found['total'] - 10} more" if found["total"] > 10 else "")
    reason = getattr(args, "not_a_secret", None)
    if not reason:
        raise BuildError(f"{task['id']}: what is about to be committed looks like it holds a secret: {places}. Nothing was committed. " + SECRET_REMEDY,
                         code="secret-candidate")
    if scan.secrets_in_text(reason):
        raise BuildError("--not-a-secret: the reason itself looks like it holds a secret. Say why in words; never quote the value.", code="secret-in-reason")
    cell.deviation(task["id"], "not-a-secret", f"{places}: {reason}")
    cell.state["deviations"][-1]["candidates"] = [{key: item[key] for key in ("file", "line", "kind")} for item in candidates]


def take(cell: Cell, task_id: str, step: str) -> Dict[str, Any]:
    cell.require_started()
    if cell.info.get("stage") == "built":
        raise BuildError("This cell is already built. Start a revision round with 'revise' if review sent it back.", code="wrong-stage")
    task = cell.task(task_id)
    if task["status"] == "done":
        raise BuildError(f"{task_id} is already done.", code="task-already-done")
    first = cell.next_task()
    if first and first["id"] != task_id:
        raise BuildError(f"Tasks are done in plan order. The next task is {first['id']} [{first['kind']}], not {task_id}.", code="plan-order")
    if STEP_FOR[task["kind"]] != step:
        raise BuildError(f"{task_id} is a [{task['kind']}] task: complete it with '{STEP_FOR[task['kind']]}', not '{step}'.", code="wrong-step")
    return task


def task_message(cell: Cell, task: Dict[str, Any]) -> str:
    """The commit message this station gives a task's commit."""
    # Drop the trailing ID list, with any `after Tnn` mark in it.
    summary = re.sub(r"\s*\((?:(?:(?:FR|INV|AC)-\d+|(?i:after)\s+(?:R\d+-)?T\d+)[,\s]*)+\)\s*$", "", task["text"].replace("`", ""))
    summary = " ".join(summary.split())[:64].rstrip(" —-,;:")
    scope = cell.info.get("slice_id") or cell.ticket_id
    return f"{COMMIT_PREFIX[task['kind']]}({scope}): {task['id']} {summary} [{cell.ticket_id}]"


def recorded_commits(cell: Cell) -> Tuple[set, Optional[str]]:
    """The commits this checkout's chain is recorded at: every commit a task, a merge of main or the join recorded, and the
    starting point; and, for a lane, the one its chain ends at now (its last task's commit, or its fork point)."""
    found = {cell.state.get("baseline"), cell.state.get("fork")}
    last = cell.state.get("fork") if cell.lane else None
    for task in cell.state.get("tasks") or []:
        for key in ("commit", "lane_commit"):
            if task.get(key):
                found.add(task[key])
        if cell.lane and task.get("status") == "done" and task.get("commit"):
            last = task["commit"]
    for item in cell.state.get("main_merges") or []:
        if isinstance(item, dict):
            found.add(item.get("merge_commit"))
    join = ((cell.state.get("lanes") or {}).get("join") or {}) if isinstance(cell.state.get("lanes"), dict) else {}
    found |= {join.get("tip"), join.get("base"), join.get("fork")}
    found.discard(None)
    return found, last


def recover_interrupted(cell: Cell, step: str = "next") -> Optional[Dict[str, Any]]:
    """A step killed after its commit and before its state was written left the commit on the branch and the task pending: no
    gate could then go on (the task changed no files) and the join would find a commit no task recorded. When the checkout's
    HEAD is exactly one commit past the chain recorded, and that commit is this station's own commit for the next task (its
    message is the one the station gives it, and every file it changed is that task's), the task is recorded as done at that
    commit, with a deviation saying it was recovered after an interrupted step. Anything else is left as it is. The caller
    holds the lanes' lock for a lane. Returns the task recovered, or None."""
    if not cell.state.get("tasks") or not cell.work.is_dir():
        return None
    task = cell.next_task()
    if task is None:
        return None
    head = git(cell.work, "rev-parse", "--verify", "-q", "HEAD").stdout.strip()
    known, last = recorded_commits(cell)
    if not head or head in known:
        return None
    parents = git(cell.work, "rev-list", "--parents", "-n", "1", head).stdout.split()[1:]
    if len(parents) != 1 or (parents[0] != last if cell.lane else parents[0] not in known):
        return None
    if git(cell.work, "log", "-1", "--format=%B", head).stdout.strip() != task_message(cell, task):
        return None
    files = sorted(name for name in git(cell.work, "diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", head).stdout.splitlines() if name)
    allowed = set(task.get("files") or [])
    foreign = set(cell.foreign_files()) if cell.lane else set()
    if not files or (allowed and not set(files) <= allowed) or set(files) & foreign:
        return None
    at = now()
    task.update({"status": "done", "commit": head, "files_changed": files, "at": at, "loop": cell.state.get("loop", 0),
                 "note": "Recovered: the step committed this task's work and stopped before recording it; recorded at that commit.",
                 "recovered": {"at": at, "commit": head}})
    if cell.lane:
        task.update({"lane": cell.lane, "lane_commit": head, "ran_on": head})
    if task["kind"] == "test":
        cell.state["test_files"] = sorted(set(cell.state.get("test_files") or []) | set(files))
        cell.state["suite"] = "red"
    elif task["kind"] == "impl":
        cell.state["suite"] = "green"
    cell.deviation(task["id"], "step-recovered",
                   f"{task['id']} was committed ({head[:10]}) by a step that stopped before it recorded the task; the station found its own "
                   f"commit, one past the recorded chain, with this task's message and only this task's files, and recorded the task as "
                   f"done at it. Its test run was not recorded.")
    cell.state["deviations"][-1].update({"commit": head, "by": "build station", **({"lane": cell.lane} if cell.lane else {})})
    cell.tick(task["id"])
    cell.save()
    telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": f"build.{step}", "outcome": "pass", "reason_code": "step-recovered",
                                                             "overridden_by_reason": False, "task": task["id"],
                                                             **({"lane": cell.lane} if cell.lane else {})})
    telemetry(cell.root, "build.task_completed", "build", lambda: task_completed(cell, task, STEP_FOR[task["kind"]], None, lifecycle.short(head)))
    return task


def reached_by_recovery(cell: Cell, task_id: str, step: str) -> Optional[Dict[str, Any]]:
    """Before a step: recover an interrupted earlier step (a lane did so when it was opened for this command). The task, when it is
    the one this step was asked for; the step then has nothing left to do."""
    if isinstance(cell, Lane):
        found = cell.recovered
    else:
        found = recover_interrupted(cell, step) if cell.state.get("tasks") and cell.info.get("stage") == "building" else None
    return found if found is not None and found.get("id") == task_id else None


def recovered_answer(cell: Cell, task: Dict[str, Any]) -> int:
    """The answer to a step run again on a task its interrupted run had already committed: done, recovered."""
    following = cell.next_task()
    print(json.dumps({"status": "DONE", "task": task["id"], "commit": str(task.get("commit"))[:10], "recovered": True, "note": task.get("note"),
                      "suite": cell.state.get("suite"),
                      "next": f"{following['id']} [{following['kind']}]" if following else cell.all_done_hint()}, indent=2))
    return 0


def complete(cell: Cell, task: Dict[str, Any], files: Sequence[str], result: Optional[Dict[str, Any]], note: str) -> None:
    sha = commit(cell, files, task_message(cell, task))
    task.update({"status": "done", "commit": sha, "files_changed": list(files), "note": note, "at": now(), "loop": cell.state.get("loop", 0)})
    if result:
        task["test_run"] = {"exit_code": result["exit_code"], "seconds": result["seconds"], "scope": result.get("scope", "whole suite"),
                            "command": result.get("command") if result.get("scope", "whole suite") == "whole suite" else None}
    if cell.lane:
        # The lane commit is exactly the tree this task's test run saw: the station commits what it ran the tests on.
        task.update({"lane": cell.lane, "lane_commit": sha, "ran_on": sha})
    cell.tick(task["id"])
    cell.save()
    cell.report_overrides(task["id"])
    telemetry(cell.root, "build.task_completed", "build", lambda: task_completed(cell, task, STEP_FOR[task["kind"]], task.get("first_run"), lifecycle.short(sha)))
    following = cell.next_task()
    print(json.dumps({
        "status": "DONE", "task": task["id"], "commit": sha[:10], "note": note, "suite": cell.state["suite"],
        "next": f"{following['id']} [{following['kind']}]" if following else cell.all_done_hint(),
    }, indent=2))


def task_completed(cell: Cell, task: Dict[str, Any], step: str, first_run: Any, commit: Optional[str]) -> Dict[str, Any]:
    """The build.task_completed record. In a lane it also names the lane; its commit is the lane commit, made at that moment."""
    data = {"task": task["id"], "kind": task["kind"], "step": step, "first_run": first_run, "suite": cell.state.get("suite"), "commit": commit}
    if cell.lane:
        data["lane"] = cell.lane
    return data


# ---------------------------------------------------------------- commands

def ensure_isolated(cell: Cell) -> None:
    """A cell groomed before the repository had history gets its worktree now."""
    if cell.info.get("isolation") == "worktree":
        return
    if git(cell.project, "rev-parse", "--verify", "-q", "HEAD").returncode != 0:
        raise BuildError("The repository has no commits, so the cell cannot be isolated. Commit the project, including specs/slices/ and any contracts, then start the build.", code="no-history")
    spec = cell.info.get("spec_path")
    tracked = bool(spec) and git(cell.project, "ls-files", "--error-unmatch", "--", str(spec)).returncode == 0
    if not tracked or git(cell.project, "status", "--porcelain", "--", str(spec)).stdout.strip():
        raise BuildError(f"This cell was groomed before the repository had history. Commit {spec} and its contracts on the main branch, then start the build.", code="spec-uncommitted")
    if git(cell.project, "check-ignore", "-q", ".factory/worktrees/probe").returncode != 0:
        common = git(cell.project, "rev-parse", "--git-common-dir").stdout.strip()
        exclude = (cell.project / common).resolve() / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("a", encoding="utf-8") as handle:
            handle.write("\n" + EXCLUDE_LINE + "\n")
    branch = f"feature/{cell.ticket_id}"
    if workspace is None:
        raise BuildError("The intent station's workspace.py is not installed beside this skill, so the ticket's workspace cannot be made.", code="worktree-failed")
    try:  # the same sparse worktree cell.py open makes: it never holds .claude/ or .mcp.json
        workspace.create(cell.project, cell.root / "repo", branch)
    except workspace.WorkspaceError as exc:
        raise BuildError(f"The build did not start, and no work happens in the project root instead. {exc}", code="worktree-failed")
    cell.info.update({"isolation": "worktree", "branch": branch})
    cell.info.pop("note", None)
    cell.save_info()


def update_from_main_enabled(cell: Cell) -> bool:
    """build.update_from_main in .factory/config.json; anything but an explicit false is on."""
    return cell.section("build").get("update_from_main") is not False


def main_name(cell: Cell) -> str:
    return git(cell.project, "branch", "--show-current").stdout.strip() or "main"


def is_ancestor(cell: Cell, older: str, newer: str = "HEAD") -> bool:
    return bool(older) and git(cell.work, "merge-base", "--is-ancestor", older, newer).returncode == 0


def spec_unchanged(cell: Cell) -> bool:
    spec = cell.work / str(cell.info.get("spec_path"))
    return spec.is_file() and hashlib.sha256(spec.read_text(encoding="utf-8-sig").encode("utf-8")).hexdigest() == cell.info.get("spec_sha256")


def bring_up_to_date(cell: Cell, when: str, loop: int, findings: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Bring the ticket's branch up to date with the main checkout's committed HEAD, at the start of a build and at the
    start of a revision, never between those (so never inside a red-to-green pair).

    Already up to date: nothing happens and None is returned (unless a person resolved an earlier conflict, which is
    recorded). A clean merge: one merge commit made by this station, returned as a record for build.json and the build
    report. A conflict, or a merge that would change the slice spec: the merge is aborted, the branch is left exactly as it
    was, and the step is refused for a person. The merge commit is not a task: its content came from main, so it is not
    judged by the scope, frozen-test or secrets gates, and later tasks are compared with the merged result."""
    if not update_from_main_enabled(cell) or cell.info.get("isolation") != "worktree":
        return None
    main_head = git(cell.project, "rev-parse", "--verify", "-q", "HEAD").stdout.strip()
    head = git(cell.work, "rev-parse", "HEAD").stdout.strip()
    main = main_name(cell)
    branch = cell.info.get("branch") or f"feature/{cell.ticket_id}"
    waiting = cell.info.get("main_conflict") if isinstance(cell.info.get("main_conflict"), dict) else None
    if not main_head or is_ancestor(cell, main_head):
        if waiting is None:
            return None
        cell.info.pop("main_conflict", None)
        cell.save_info()
        if head == waiting.get("branch_commit") or not is_ancestor(cell, str(waiting.get("branch_commit") or "")):
            return None
        # A person merged main into the branch and resolved the conflict; the revision or build starts from their commit.
        return {"when": when, "loop": loop, "by": "a person", "main": main, "main_commit": git(cell.work, "merge-base", "HEAD", main_head).stdout.strip() or None,
                "branch_commit": waiting.get("branch_commit"), "merge_commit": head, "behind": waiting.get("behind"), "at": now()}
    dirty = changed_files(cell)
    if dirty:
        then = "start the build again" if when == "start" else "start the revision again (build.py revise)"
        raise BuildError(f"The cell has uncommitted changes ({', '.join(dirty[:5])}), so it cannot be brought up to date with {main}. Nothing was "
                         f"changed. A person commits them on {branch} in {cell.work}, or " + set_aside_hint(cell.work, cell.ticket_id, f"before {when}")
                         + f"; then {then}.", code="uncommitted-changes")
    behind = int(git(cell.work, "rev-list", "--count", f"HEAD..{main_head}").stdout.strip() or 0)
    merged = git(cell.work, "merge", "--no-ff", "--no-commit", main_head)
    if merged.returncode != 0:
        conflicts = [name for name in git(cell.work, "diff", "--name-only", "--diff-filter=U").stdout.splitlines() if name.strip()]
        git(cell.work, "merge", "--abort")
        if not conflicts:
            raise BuildError(f"git could not merge {main} into {branch}, so nothing was changed: "
                             + (merged.stderr.strip() or merged.stdout.strip())[-600:], code="main-merge-failed")
        cell.info["main_conflict"] = {"during": when, "main": main, "main_commit": main_head, "branch_commit": head, "behind": behind,
                                      "files": conflicts[:50], "folder": str(cell.work), "findings": findings, "at": now()}
        cell.save_info()
        then = "then start the build again" if when == "start" else "then start the revision again (build.py revise)"
        raise BuildError(
            f"{main} has moved on since this ticket's branch was last brought up to date, and bringing the branch up to date conflicts in "
            f"{', '.join(conflicts[:10])}{f' and {len(conflicts) - 10} more' if len(conflicts) > 10 else ''}. Nothing was changed. "
            f"A person must merge {main} into {branch} in {cell.work} and resolve it; {then}. If the conflict is in the spec or a contract, "
            "the ticket needs regrooming.", code="main-conflict")
    if not spec_unchanged(cell):
        git(cell.work, "merge", "--abort")
        raise BuildError(f"Bringing the cell up to date with {main} would change its slice spec, so nothing was changed. "
                         "Regroom the ticket with the intent skill before building.", code="spec-changed")
    purpose = "before building" if when == "start" else f"before revision {loop}"
    done = git(cell.work, "commit", "-q", "--no-edit", "-m", f"Merge {main} into {branch} {purpose} [{cell.ticket_id}]")
    if done.returncode != 0:
        git(cell.work, "merge", "--abort")
        raise BuildError(f"git could not commit the merge of {main}, so nothing was changed: " + (done.stderr.strip() or done.stdout.strip())[-600:],
                         code="main-merge-failed")
    if waiting is not None:
        cell.info.pop("main_conflict", None)
        cell.save_info()
    return {"when": when, "loop": loop, "by": "build station", "main": main, "main_commit": main_head, "branch_commit": head,
            "merge_commit": git(cell.work, "rev-parse", "HEAD").stdout.strip(), "behind": behind, "at": now()}


def merge_note(record: Optional[Dict[str, Any]]) -> Optional[str]:
    if not record:
        return None
    if record.get("by") == "a person":
        return f"A person brought the branch up to date with {record.get('main')} and resolved the conflict; work continues from {str(record.get('merge_commit'))[:10]}."
    return (f"The branch was {record.get('behind')} commit(s) behind {record.get('main')} and has been brought up to date "
            f"({str(record.get('main_commit'))[:10]}, merge commit {str(record.get('merge_commit'))[:10]}).")


def no_test_command_at_start(cell: Cell) -> str:
    """Where the start looked for a test command, and both ways forward."""
    report = load_json(cell.project / ".factory" / "audit-report.json")
    named = ((report.get("commands") or {}).get("test") or {}).get("command") if isinstance(report, dict) else None
    audit = ("no .factory/audit-report.json" if not isinstance(report, dict) else
             f"only the audit's own check ({named}), which the build cannot run" if isinstance(named, str) and named.startswith("builtin:") else
             "no test command in .factory/audit-report.json")
    return (f"No test command is known for {cell.ticket_id}, so building cannot start: every step after the start runs the tests. Nothing was "
            "recorded and the cell stays planned. The start looked at --test-cmd (not given), build.commands.test and audit.commands.test in "
            f".factory/config.json (neither set), and found {audit}. Either pass one to the start: build.py start {cell.ticket_id} --test-cmd "
            "\"<command>\", or set build.commands.test in .factory/config.json and start again. Use the command the plan or the project documents, "
            "or choose one. For a hardening ticket that installs the test tool itself, name the command it will use once installed: it need "
            "not run yet. It can be changed later while the build carries on: " + set_commands_hint(cell.ticket_id))


def cmd_start(cell: Cell, args: argparse.Namespace) -> int:
    stage = cell.info.get("stage")
    if cell.state.get("tasks") and stage in ("building", "built"):
        raise BuildError(f"Building already started for {cell.ticket_id} (stage: {stage}). Use 'next' to continue, or 'revise' after a rejected review. "
                         "To give the build its test command, or change it, while it carries on: " + set_commands_hint(cell.ticket_id), code="already-started")
    if stage != "planned":
        raise BuildError(f"The cell's stage is '{stage}', not 'planned'. The intent skill must finish the spec, contracts and plan first.", code="wrong-stage")
    gate = audit_gate(cell)
    # The start never accepts a build it cannot carry on: every later step runs the tests. With no command known, nothing is
    # recorded and the cell stays planned.
    if not find_command(cell, "test", args.test_cmd):
        raise BuildError(no_test_command_at_start(cell), code="no-test-command")
    ensure_isolated(cell)
    spec = cell.work / str(cell.info.get("spec_path"))
    if not spec.is_file() or hashlib.sha256(spec.read_text(encoding="utf-8-sig").encode("utf-8")).hexdigest() != cell.info.get("spec_sha256"):
        raise BuildError("The slice spec changed after it was finalized. Regroom the ticket with the intent skill before building.", code="spec-changed")
    plan_path = cell.root / "plan.md"
    if not plan_path.is_file() or not (cell.root / "spec.json").is_file():
        raise BuildError("plan.md or spec.json is missing from the cell.", code="plan-missing")
    tasks, _ = parse_plan(plan_path.read_text(encoding="utf-8"))
    if not tasks:
        raise BuildError("plan.md has no tasks.", code="plan-empty")
    dirty = changed_files(cell)
    if dirty:
        raise BuildError(f"The cell has uncommitted changes ({', '.join(dirty[:5])}), and building starts from a clean checkout. Nothing was recorded. "
                         f"A person commits them on {cell.info.get('branch') or 'the cell branch'} in {cell.work}, or "
                         + set_aside_hint(cell.work, cell.ticket_id, "before the build") + "; then start again.", code="uncommitted-changes")
    waiting = adr_module().pending_acceptance(cell.info) if cell.info.get("risk") == "High" else []
    if waiting:
        raise BuildError(f"This High-risk ticket's plan proposes {', '.join(waiting)}, and no engineer has accepted it yet. The build waits for that "
                         "acceptance (cell.py adr-accept, on a person's word).", code="adr-not-accepted")
    if isinstance(cell.info.get("adr_conflict"), dict):
        raise BuildError(f"The plan cannot follow {cell.info['adr_conflict'].get('adr')}, and an engineer has not decided yet.", code="adr-conflict")
    for task in tasks:
        task["status"] = "pending"
    # A start refused after an earlier merge (a failing suite) keeps that merge on the branch: carry its record forward.
    merges = [item for item in cell.state.get("main_merges") or [] if isinstance(item, dict) and item.get("when") == "start"
              and is_ancestor(cell, str(item.get("merge_commit") or ""))] if cell.info.get("isolation") == "worktree" else []
    synced = bring_up_to_date(cell, "start", 0)
    if synced:
        merges.append(synced)
        cell.state["main_merges"] = merges
        cell.save()  # recorded at once: the merge stays on the branch even if the start is refused below
    hardening = HARDENING_LABEL in ticket_labels(cell)
    cell.state = {
        "ticket_id": cell.ticket_id, "slice_id": cell.info.get("slice_id"), "loop": 0, "started_at": now(),
        "baseline": git(cell.work, "rev-parse", "HEAD").stdout.strip(), "audit": gate, "hardening": hardening,
        "test_cmd": find_command(cell, "test", args.test_cmd), "lint_cmd": find_command(cell, "lint", args.lint_cmd),
        "suite": "unknown", "tasks": tasks, "test_files": [], "deviations": [], "main_merges": merges,
        "update_from_main": update_from_main_enabled(cell),
    }
    baseline: Dict[str, Any] = {"skipped": "Hardening ticket with no test command yet."}
    if hardening and not args.no_baseline and cell.state.get("test_cmd"):
        # A hardening ticket may start from a failing or missing suite; record what it started from.
        try:
            baseline = run_tests(cell)
            cell.state["suite"] = "green" if baseline["passed"] else "red"
            baseline["note"] = "Hardening ticket: started from a passing suite." if baseline["passed"] else "Hardening ticket: the suite was already failing at the start."
            baseline["failing_at_start"] = "" if baseline["passed"] else baseline["output_tail"][-800:]
        except BuildError as exc:
            baseline = {"skipped": f"Hardening ticket: the test command could not run at the start ({exc})."}
    elif args.no_baseline:
        if not hardening and gate["tier"] is not None:
            raise BuildError("--no-baseline is only for a project that has no test suite yet; this repository passed its audit, so its tests must pass in the cell.", code="no-baseline-not-allowed")
        baseline = {"skipped": args.no_baseline}
        cell.deviation(None, "no-baseline", args.no_baseline)
    elif not hardening:
        baseline = run_tests(cell)
        if not baseline["passed"]:
            # A reason to doubt the audit: the next ticket's route runs it again before another build (audit_state.py).
            mark_audit_due(cell, "baseline-red-after-main" if merges else "baseline-red")
        if not baseline["passed"] and merges:
            last = merges[-1]
            audited = (load_json(cell.project / ".factory" / "audit-report.json", {}) or {}).get("head") if gate.get("tier") else None
            raise BuildError(
                f"The tests fail in the cell now that {last.get('main')} ({str(last.get('main_commit'))[:10]}) is merged into the branch, so building cannot start. "
                "Nothing has been built for this ticket yet, so its own work is not the cause. "
                + ("The audit found the main checkout's tests passing at this commit, so the failure comes from what the branch held from grooming "
                   f"(its spec and contracts) together with the newer code on {last.get('main')}. "
                   if gate.get("tier") in ("Gold", "Silver") and audited and audited == last.get("main_commit") else
                   f"The audit found the main checkout's tests passing at {str(audited)[:10]}, and {last.get('main')} has moved since: either its newer "
                   "code fails its own tests, or what the branch held from grooming (its spec and contracts) does not fit it. The audit runs again "
                   "before the next build to tell. " if gate.get("tier") in ("Gold", "Silver") and audited else
                   f"Either {last.get('main')}'s own tests fail at this commit (run the audit), or what the branch held from grooming (its spec and "
                   f"contracts) does not fit the newer code on {last.get('main')}. ")
                + "Look at the output below. If the test command is wrong, start again with --test-cmd \"<command>\". If the contracts no longer "
                f"fit the newer code, a person has the ticket planned again, which keeps everything: cell.py replan {cell.ticket_id} --reason \"<why>\".\n"
                + baseline["output_tail"][-800:],
                code="baseline-red-after-main")
        if not baseline["passed"]:
            behind = cell.info.get("isolation") == "worktree" and not is_ancestor(cell, git(cell.project, "rev-parse", "HEAD").stdout.strip())
            where = ("The cell's branch was not brought up to date with the main checkout (build.update_from_main is off), so this is the branch's own state."
                     if behind else "The cell is up to date with the main checkout, so the main checkout's tests fail too: run the audit, and harden the repository first.")
            raise BuildError("The tests already fail in the cell before any change, so building cannot start. Nothing was recorded for this build; "
                             "the readiness audit is marked due, so it runs again before the next build. " + where
                             + f" If the test command itself is wrong ({cell.state.get('test_cmd')}), start again with --test-cmd \"<command>\".\n"
                             + baseline["output_tail"][-800:], code="baseline-red")
        cell.state["suite"] = "green"
        cell.state["test_file_check"] = calibrate_test_file(cell)
    planned = plan_lanes_at_start(cell, plan_path.read_text(encoding="utf-8"), args)
    if planned is not None:
        cell.state["lanes"] = planned
    cell.state["baseline_run"] = {k: v for k, v in baseline.items() if k not in ("output_tail", "output")}
    cell.info.update({"stage": "building", "human_review_required": bool(gate["human_review_required"]) or cell.info.get("risk") == "High"})
    cell.save()
    cell.save_info()
    telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.start", "outcome": "pass", "reason_code": None, "overridden_by_reason": False,
                                                             "audit_tier": gate.get("tier")})
    cell.report_overrides(None)
    telemetry(cell.root, "station.entered", "build", lambda: {"stage": "building", "tasks": len(tasks), "synced_with_main": bool(synced)})
    answer = {
        "status": "STARTED", "ticket_id": cell.ticket_id, "workdir": str(cell.work), "branch": cell.info.get("branch"),
        "tasks": len(tasks), "test_cmd": cell.state["test_cmd"], "lint_cmd": cell.state["lint_cmd"], "audit": gate,
        "new_tests_run_alone": cell.state.get("test_file_check") or {"trusted": False, "why": "no passing baseline run to check a single-file run against"},
        "adrs": adrs_in_force(cell),
        "synced_with_main": merge_note(synced),
        "next": f"{tasks[0]['id']} [{tasks[0]['kind']}]",
    }
    if planned is not None:
        answer["lanes"] = {"count": len(planned["lanes"]), "lanes": [{"lane": entry["lane"], "tasks": entry["tasks"]} for entry in planned["lanes"]],
                           "before": planned["plan"]["before"], "after": planned["plan"]["after"],
                           "note": "Do the tasks before the lanes here, in order. When 'next' answers LANES, stop and report: the line starts "
                                   "one builder per lane and joins them."}
    if command_env is not None and command_env.notices(cell.project):  # said once, and only when a cache was pointed elsewhere
        answer["caches"] = command_env.notices(cell.project)
    print(json.dumps(answer, indent=2))
    return 0


def spec_excerpt(cell: Cell, ids: Sequence[str]) -> Dict[str, Any]:
    spec = load_json(cell.root / "spec.json", {}) or {}
    wanted = set(ids)
    excerpt: Dict[str, Any] = {
        "requirements": [e for key in ("invariants", "functional_requirements") for e in spec.get(key) or [] if e.get("id") in wanted],
        "scenarios": [s for s in spec.get("scenarios") or [] if s.get("id") in wanted],
    }
    matrix = spec.get("decision_matrix") or {}
    rules = [rule for rule in matrix.get("rules") or [] if wanted & set(rule.get("covers") or [])]
    if rules:
        cases = [case for case in matrix.get("cases") or [] if case.get("rule") in {rule["id"] for rule in rules}]
        excerpt["matrix"] = {"rules": [rule["id"] for rule in rules], "cases": len(cases), "read": "decision_matrix.cases in spec.json"}
    return excerpt


def cmd_next(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    if getattr(args, "lane", None):
        return lane_next(cell, args.lane, getattr(args, "holder", None))
    record = lane_record(cell)
    if record is not None and record.get("state") == "open":
        raise BuildError(lanes_open_refusal(cell, record), code="lanes-open")
    if cell.info.get("stage") == "building":
        recover_interrupted(cell)
    task = cell.next_task()
    if record is not None and record.get("state") == "planned" and task is not None and lane_of(cell, task["id"]):
        print(json.dumps({"status": "LANES", "lanes": [entry["lane"] for entry in record["lanes"]], "next": LANES_NEXT}, indent=2))
        return 0
    if task is None:
        print(json.dumps({"status": "ALL_TASKS_DONE", "next": f"build.py finish {cell.ticket_id}"}, indent=2))
        return 0
    done = sum(1 for t in cell.state["tasks"] if t["status"] == "done")
    print(json.dumps({
        "task": task["id"], "kind": task["kind"], "complete_with": STEP_FOR[task["kind"]], "text": task["text"],
        "files": task["files"] or "The plan names no files for this task.", "progress": f"{done} of {len(cell.state['tasks'])} done",
        "suite": cell.state["suite"], "workdir": str(cell.work), "spec": spec_excerpt(cell, task["ids"]),
    }, indent=2, ensure_ascii=False))
    return 0


def failure_excerpt(output: str, stems: Sequence[str]) -> str:
    """The part of a failing run that concerns the test just written, not whatever failed last."""
    positions = [output.find(stem) for stem in stems if stem and output.find(stem) >= 0]
    if not positions:
        return output.strip()[-600:]
    start = max(0, min(positions) - 200)
    return output[start:start + 800].strip()


def cmd_red(cell: Cell, args: argparse.Namespace) -> int:
    cell = route(cell, args.task, getattr(args, "holder", None), "red")
    recovered = reached_by_recovery(cell, args.task, "red")
    if recovered is not None:
        return recovered_answer(cell, recovered)
    task = take(cell, args.task, "red")
    files = changed_files(cell)
    if args.written_early:
        # An earlier task committed this task's test along with its own. Nothing is left to write;
        # record the slip for the reviewers rather than strand the ticket or pad a file.
        if files:
            raise BuildError(f"--written-early is for a test that is already committed, but {task['id']} has uncommitted changes: {', '.join(files)}.", code="written-early-has-changes")
        if not cell.state.get("test_files"):
            raise BuildError("--written-early needs an earlier committed test; none has been committed yet.", code="written-early-no-test")
        cell.deviation(task["id"], "test-written-early", args.written_early)
        task.update({"status": "done", "commit": None, "files_changed": [], "first_run": "not-run", "at": now(), "loop": cell.state.get("loop", 0),
                     "note": "No change: its test was committed by an earlier task. " + args.written_early})
        if cell.lane:
            task["lane"] = cell.lane
        cell.tick(task["id"])
        cell.save()
        cell.report_overrides(task["id"])
        telemetry(cell.root, "build.task_completed", "build", lambda: task_completed(cell, task, "red", "not-run", None))
        following = cell.next_task()
        print(json.dumps({"status": "DONE", "task": task["id"], "commit": None, "note": task["note"], "suite": cell.state["suite"],
                          "next": f"{following['id']} [{following['kind']}]" if following else cell.all_done_hint()}, indent=2))
        return 0
    check_scope(cell, task, files, args)
    if task.get("ids") and not cell.state.get("hardening"):
        # The finish check needs every spec ID named by a test. Checked here too, while this test can still be
        # edited: once it is committed it is frozen, and a missing ID would strand the ticket at the end.
        missing, respelled = unnamed_ids(cell, task["ids"], [*cell.state.get("test_files", []), *files])
        if missing:
            raise BuildError(f"{task['id']}: the plan gives this test {', '.join(task['ids'])}, but no test names {', '.join(missing)}"
                             + (f" (found in another spelling: {', '.join(respelled)})" if respelled else "") + ". " + ID_SPELLING
                             + " Add it to the test you just wrote, then run this step again.", code="red-ids-not-named")
    # A test task asks one thing: does the new test fail? Where this cell has checked that a test file can be run on
    # its own, only the new test files are run. If they pass on their own, the whole suite is run and the rules are
    # exactly as before.
    mine = run_this_tasks_tests(cell, files)
    if mine is not None:
        # This task's own tests were each run alone. What the rest of the file or the suite does says nothing about them.
        task["tests_first_run"] = {"failed": mine["failed"], "passed": mine["passed"]}
        result = {"exit_code": 1 if mine["failed"] else 0, "seconds": mine["seconds"], "passed": not mine["failed"], "output": mine["output"],
                  "output_tail": mine["output"][-3000:], "scope": "new tests only", "one_at_a_time": True}
        note = "Seen failing before the implementation."
        if mine["passed"]:
            names = ", ".join(mine["passed"][:8]) + (f" and {len(mine['passed']) - 8} more" if len(mine["passed"]) > 8 else "")
            if not args.covered:
                raise BuildError(
                    f"{task['id']}: {len(mine['passed'])} of this task's {len(mine['passed']) + len(mine['failed'])} new test(s) already pass before any code is written "
                    f"({names}), so they were never seen failing. Either they do not exercise new behavior, or earlier work already satisfies them. If earlier "
                    "work satisfies them, rerun with --covered \"<which task and why>\"; the reviewers are told.", code="red-before-green")
            cell.deviation(task["id"], "test-passed-first-run", f"{args.covered} (passing on first run: {names})")
            note = ("Passed on its first run: " + args.covered) if not mine["failed"] else f"{len(mine['failed'])} seen failing; {len(mine['passed'])} passed on first run: {args.covered}"
        elif args.covered:
            note += " (--covered was given but not needed: every new test fails, so nothing was recorded for it.)"
        if mine["failed"]:
            cell.state["suite"] = "red"
        cell.state["test_files"] = sorted(set(cell.state.get("test_files", [])) | set(files))
        task["first_run"] = "fail" if mine["failed"] else "pass"
        task["failure_tail"] = failure_excerpt(result["output"], [Path(name).stem for name in files]) if mine["failed"] else ""
        complete(cell, task, files, result, note)
        return 0
    alone = test_file_command(cell, files)
    result = None
    if alone:
        timeout = cell.section("audit").get("timeouts", {}).get("test", 300) if isinstance(cell.section("audit").get("timeouts"), dict) else 300
        result = run_command(cell, alone, timeout)
        result["scope"] = "new tests only"
        if result["passed"]:
            result = None
    if result is None:
        result = run_tests(cell)
        result["scope"] = "whole suite"
    note = "Seen failing before the implementation."
    if result["passed"]:
        if not args.covered:
            raise BuildError(
                f"{task['id']}: the suite passes with the new test, so the test was never seen failing. Either it does not exercise new behavior "
                "(check that it runs and asserts what the task says), or earlier work already satisfies it. If earlier work satisfies it, "
                "rerun with --covered \"<which task and why>\"; the reviewers are told.", code="red-before-green"
            )
        cell.deviation(task["id"], "test-passed-first-run", args.covered)
        note = "Passed on its first run: " + args.covered
    else:
        # A red only counts if the new test took part in it. A suite that fails before reaching the test
        # (a broken command, a folder that cannot be loaded) says nothing about the behavior under test.
        stems = sorted({Path(name).stem for name in files if Path(name).suffix and Path(name).stem not in ("__init__", "conftest")})
        if stems and not any(stem in result["output"] for stem in stems):
            if not args.unrelated_failure:
                raise BuildError(
                    f"{task['id']}: the suite fails, but its output never mentions the test you wrote ({', '.join(stems)}), so it may be failing before it "
                    "reaches that test: a wrong test command, a folder the runner cannot load, or an unrelated error. Read the output below. If the test "
                    f"command is wrong, give the right one and run this step again ({set_commands_hint(cell.ticket_id)}); the test you wrote is kept. "
                    "If the project's layout is wrong, that is a plan defect to report. If the failure really is your test's, rerun with "
                    "--unrelated-failure \"<how you know>\"; the reviewers are told.\n" + result["output_tail"][-1200:], code="red-attribution"
                )
            cell.deviation(task["id"], "red-not-attributed", args.unrelated_failure)
        cell.state["suite"] = "red"
    cell.state["test_files"] = sorted(set(cell.state.get("test_files", [])) | set(files))
    task["first_run"] = "pass" if result["passed"] else "fail"
    task["failure_tail"] = "" if result["passed"] else failure_excerpt(result["output"], [Path(name).stem for name in files])
    complete(cell, task, files, result, note)
    return 0


def unnamed_ids(cell: Cell, wanted: Sequence[str], names: Sequence[str]) -> Tuple[List[str], List[str]]:
    """The spec IDs among `wanted` that none of the given test files names exactly as the spec writes them,
    and, of those, the ones that do appear in another spelling (fr02, FR_02, ac01): the usual slip, because a
    function name cannot hold a hyphen."""
    text = "".join((cell.work / name).read_text(encoding="utf-8", errors="replace") for name in sorted(set(names)) if (cell.work / name).is_file())
    missing = [identifier for identifier in wanted if not re.search(rf"\b{re.escape(identifier)}\b", text)]
    respelled = [identifier for identifier in missing
                 if re.search(rf"(?<![A-Za-z0-9]){identifier.split('-')[0]}[-_ ]?{identifier.split('-')[1]}(?![0-9])", text, re.IGNORECASE)]
    return missing, respelled


ID_SPELLING = ("Write each ID exactly as the spec does, with its capitals and hyphen (FR-02, not fr02 or FR_02), in the test's docstring or a comment: "
               "a function name cannot hold a hyphen, so an ID in a name alone is not counted.")


def committed_text(cell: Cell, names: Sequence[str]) -> str:
    """The committed (HEAD) contents of the given files, joined; files missing at HEAD add nothing."""
    parts = []
    for name in names:
        shown = git(cell.work, "show", f"HEAD:{name}")
        if shown.returncode == 0:
            parts.append(shown.stdout)
    return "\n".join(parts)


def green_already_done(cell: Cell, task: Dict[str, Any], files: Sequence[str], reason: str) -> int:
    """An [impl] task whose code an earlier task already wrote. Nothing is left to change, so there is
    nothing to commit; accepted only when the task changed nothing, every spec ID the plan gives it is
    already named by a committed test, and the whole suite passes. Recorded for the reviewers."""
    if files:
        raise BuildError(f"--already-done is for an [impl] task that has nothing left to change, but {task['id']} has uncommitted changes: "
                         f"{', '.join(files)}. Complete it with 'green' without the flag.", code="already-done-has-changes")
    ids = list(task.get("ids") or [])
    if not ids and task.get("added_by") not in ("join", "set-commands"):
        raise BuildError(f"--already-done needs the plan to give {task['id']} the spec IDs it implements, so that their tests can be checked; "
                         "it gives none. Do the task's work, or report a plan defect.", code="already-done-no-ids")
    tests = committed_text(cell, cell.state.get("test_files", []))
    untested = [identifier for identifier in ids if not re.search(rf"\b{re.escape(identifier)}\b", tests)]
    if untested:
        raise BuildError(f"--already-done is accepted only when committed tests already name every ID {task['id']} carries; none names "
                         f"{', '.join(untested)}. The work is not proven done: do the task's work.", code="already-done-not-covered")
    result = run_tests(cell)
    if not result["passed"]:
        raise BuildError(f"{task['id']}: the suite does not pass, so the task is not already done.\n{result['output_tail'][-1500:]}", code="suite-red")
    cell.state["suite"] = "green"
    cell.deviation(task["id"], "impl-already-done", reason)
    task.update({"status": "done", "commit": None, "files_changed": [], "at": now(), "loop": cell.state.get("loop", 0),
                 "test_run": {key: result[key] for key in ("exit_code", "seconds")},
                 "note": "No change: an earlier task already implemented it; suite green. " + reason})
    if cell.lane:
        task["lane"] = cell.lane
    cell.tick(task["id"])
    cell.save()
    cell.report_overrides(task["id"])
    telemetry(cell.root, "build.task_completed", "build", lambda: task_completed(cell, task, "green", None, None))
    following = cell.next_task()
    print(json.dumps({"status": "DONE", "task": task["id"], "commit": None, "note": task["note"], "suite": cell.state["suite"],
                      "next": f"{following['id']} [{following['kind']}]" if following else cell.all_done_hint()}, indent=2))
    return 0


def cmd_green(cell: Cell, args: argparse.Namespace) -> int:
    cell = route(cell, args.task, getattr(args, "holder", None), "green")
    recovered = reached_by_recovery(cell, args.task, "green")
    if recovered is not None:
        return recovered_answer(cell, recovered)
    task = take(cell, args.task, "green")
    files = changed_files(cell)
    if args.already_done:
        return green_already_done(cell, task, files, args.already_done)
    check_scope(cell, task, files, args)
    result = run_tests(cell)
    result["scope"] = "whole suite"
    if not result["passed"]:
        raise BuildError(f"{task['id']}: the suite does not pass yet, so nothing was committed.\n{result['output_tail'][-1500:]}", code="suite-red")
    cell.state["suite"] = "green"
    complete(cell, task, files, result, "Suite green.")
    return 0


def cmd_done(cell: Cell, args: argparse.Namespace) -> int:
    cell = route(cell, args.task, getattr(args, "holder", None), "done")
    recovered = reached_by_recovery(cell, args.task, "done")
    if recovered is not None:
        return recovered_answer(cell, recovered)
    task = take(cell, args.task, "done")
    files = changed_files(cell)
    check_scope(cell, task, files, args)
    result = None
    note = "Committed while tests are still red for the next implementation task."
    if cell.state["suite"] == "green":
        result = run_tests(cell)
        if not result["passed"]:
            raise BuildError(f"{task['id']}: the suite was green and this change broke it, so nothing was committed.\n{result['output_tail'][-1500:]}", code="suite-broken")
        note = "Suite still green."
    elif cell.state["suite"] == "unknown":
        note = "Committed before the suite exists."
    complete(cell, task, files, result, note)
    return 0


def cmd_add_task(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    loop = cell.state.get("loop", 0)
    if loop == 0 or cell.info.get("stage") != "building":
        raise BuildError("Tasks are added only during a revision round. The plan comes from the intent skill; if it is wrong, report a plan defect instead.", code="not-revising")
    folder = adr_folder(cell)
    decisions = [name for name in args.file if adr_module().in_folder(name[2:] if name.startswith("./") else name, folder)]
    if decisions:
        raise BuildError(f"A task may not change architecture decision records ({', '.join(decisions[:3])}): only people change an ADR.", code="adr-files")
    count = sum(1 for task in cell.state["tasks"] if task["id"].startswith(f"R{loop}-"))
    task_id = f"R{loop}-T{count + 1:02d}"
    text = " ".join(args.text.split())
    cell.state["tasks"].append({"id": task_id, "kind": args.kind, "text": text, "ids": sorted(set(ID_RE.findall(text))), "files": sorted(set(args.file)), "status": "pending"})
    plan = cell.root / "plan.md"
    if plan.is_file():
        body = plan.read_text(encoding="utf-8")
        line = f"- [ ] {task_id} [{args.kind}] {text}" + (" — " + ", ".join(f"`{name}`" for name in args.file) if args.file else "")
        marker = "\n## File touch map"
        body = body.replace(marker, f"{line}\n{marker}", 1) if marker in body else body.rstrip("\n") + "\n" + line + "\n"
        plan.write_text(body, encoding="utf-8")
    cell.save()
    print(json.dumps({"status": "ADDED", "task": task_id, "kind": args.kind}, indent=2))
    return 0


def own_changes(cell: Cell) -> Dict[str, Any]:
    """What this ticket's build changed, without what came in from main.

    With no merge of main since the build started, that is simply baseline..HEAD, as it always was. Once main has been
    merged in (at a revision, or by a person resolving a conflict), baseline..HEAD would also show every other ticket's
    work that main brought. Then the files are those the branch's own commits touched (first parent, merges left out), and
    each is compared with the main commit the branch was last brought up to date with (its merge base with main)."""
    baseline = cell.state["baseline"]
    if not git(cell.work, "rev-list", "--first-parent", "--merges", f"{baseline}..HEAD").stdout.strip():
        return {"base": baseline, "paths": None, "note": None}
    main_head = git(cell.project, "rev-parse", "HEAD").stdout.strip()
    base = (git(cell.work, "merge-base", "HEAD", main_head).stdout.strip() if main_head else "") or baseline
    touched = set()
    for sha in git(cell.work, "rev-list", "--first-parent", "--no-merges", f"{baseline}..HEAD").stdout.split():
        touched |= {name for name in git(cell.work, "diff-tree", "--no-commit-id", "--name-only", "-r", sha).stdout.splitlines() if name.strip()}
    paths = [name for name in git(cell.work, "diff", "--name-only", f"{base}..HEAD", "--", *sorted(touched)).stdout.splitlines() if name.strip()] if touched else []
    return {"base": base, "paths": paths,
            "note": f"Main was merged into the branch during the build, so this ticket's changes are its own commits' files compared with {base[:10]}."}


def diff_args(changes: Dict[str, Any]) -> List[str]:
    """git diff arguments for this ticket's own changes, from own_changes."""
    paths = changes.get("paths")
    if paths is None:
        return [f"{changes['base']}..HEAD"]
    return [f"{changes['base']}..HEAD", "--", *paths] if paths else [f"{changes['base']}..{changes['base']}"]


def ui_findings(cell: Cell, changes: Dict[str, Any]) -> List[str]:
    """Added lines in interface files that hard-code styling instead of using the design system."""
    diff = git(cell.work, "diff", "--unified=0", *diff_args(changes)).stdout
    findings: List[str] = []
    current = ""
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            current = line[6:]
        elif line.startswith("+") and not line.startswith("+++") and UI_FILE_RE.search(current):
            if INLINE_STYLE_RE.search(line):
                findings.append(f"{current}: inline style: {line[1:].strip()[:100]}")
            elif HEX_COLOR_RE.search(line):
                findings.append(f"{current}: hard-coded color: {line[1:].strip()[:100]}")
    return findings[:50]


def seconds_between(earlier: Any, later: Any) -> Optional[float]:
    try:
        a = datetime.fromisoformat(str(earlier).replace("Z", "+00:00"))
        b = datetime.fromisoformat(str(later).replace("Z", "+00:00"))
    except ValueError:
        return None
    return round(max((b - a).total_seconds(), 0.0), 1)


def timing(cell: Cell, final: Dict[str, Any]) -> Dict[str, Any]:
    """Where the build's time went, from what each step recorded. Test time is measured; the time since the previous
    step is the clock between two recorded moments, so it includes the builder's work and any time the build sat idle."""
    steps = []
    previous = cell.state.get("started_at")
    joined = joined_lanes(cell)
    chains: Dict[str, Any] = {}  # with lanes: the last recorded moment of each lane's own chain
    for task in cell.state["tasks"]:
        run = task.get("test_run") if isinstance(task.get("test_run"), dict) else {}
        if joined is None:
            steps.append({"task": task.get("id"), "kind": task.get("kind"), "loop": task.get("loop"), "tests": run.get("scope"), "test_seconds": run.get("seconds"),
                          "seconds_since_previous_step": seconds_between(previous, task.get("at")) if previous and task.get("at") else None})
            previous = task.get("at") or previous
            continue
        # With lanes, "since the previous step" is measured within each chain: a lane's from when it was handed to its builder,
        # the cell's own from its previous step, or from the join for the first step after it. Never across lanes.
        chain = task.get("lane") if task.get("lane") and not task.get("set_aside") and not task.get("handed_back") else None
        if chain:
            before = chains.get(chain) or lane_record_of(joined, chain).get("handed_at")
        else:
            before = previous
            join_at = (joined.get("join") or {}).get("finished_at")
            if join_at and task.get("at") and str(task.get("at")) >= str(join_at) and (not before or str(before) < str(join_at)):
                before = join_at
        step = {"task": task.get("id"), "kind": task.get("kind"), "loop": task.get("loop"), "tests": run.get("scope"), "test_seconds": run.get("seconds"),
                "seconds_since_previous_step": seconds_between(before, task.get("at")) if before and task.get("at") else None}
        if chain:
            step["lane"] = chain
            chains[chain] = task.get("at") or before
        else:
            previous = task.get("at") or previous
        steps.append(step)
    baseline = cell.state.get("baseline_run") if isinstance(cell.state.get("baseline_run"), dict) else {}
    measured = [step["test_seconds"] for step in steps if isinstance(step["test_seconds"], (int, float))]
    extra = [value for value in (baseline.get("seconds"), None if final.get("reused_from") else final.get("seconds")) if isinstance(value, (int, float))]
    measured_time = {
        "started_at": cell.state.get("started_at"), "finished_at": now(), "elapsed_seconds": seconds_between(cell.state.get("started_at"), now()),
        "test_seconds_total": round(sum(measured) + sum(extra), 1), "test_runs": len(measured) + len(extra),
        "whole_suite_runs": sum(1 for step in steps if step["tests"] == "whole suite") + len(extra),
        "new_tests_only_runs": sum(1 for step in steps if step["tests"] == "new tests only"),
        "baseline_test_seconds": baseline.get("seconds"), "final_test_seconds": None if final.get("reused_from") else final.get("seconds"),
        "final_run_reused_from": final.get("reused_from"),
        "new_tests_run_alone": cell.state.get("test_file_check") or {"trusted": False},
        "note": "Elapsed time is the clock from start to finish and includes any time the build sat idle or was resumed later.",
        "steps": steps,
    }
    if joined is not None:
        joined_run = ((joined.get("join") or {}).get("suite") or {}).get("seconds")
        if isinstance(joined_run, (int, float)):  # the joined suite run; a finish that reused it did not count it again
            measured_time["test_seconds_total"] = round(measured_time["test_seconds_total"] + joined_run, 1)
            measured_time["test_runs"] += 1
            measured_time["whole_suite_runs"] += 1
        measured_time["lanes"] = lanes_timing(joined)
    return measured_time


def reusable_suite_run(cell: Cell) -> Optional[Dict[str, Any]]:
    """The whole-suite run of the last step, when it is a run of exactly the code that is committed now.

    The last task's step ran the whole suite on its changes and then committed them. If that commit is still the
    branch's tip, the tree is clean and the test command is the same, running the suite again would run the same
    code and learn nothing. Anything else (a test task last, a different tip, a failed run) runs it again.

    A run is reused only if it ran on the commit that is the tip now (`ran_on`, where a task records it). A task built in a
    lane ran its suite on the lane's tree; after the join its landed commit is the tip, but that tree was never run as such.
    The join's own whole-suite run, on the landed tip, is reused instead when nothing came after it."""
    last = next((task for task in reversed(cell.state["tasks"]) if task.get("status") == "done" and task.get("commit")), None)
    run = last.get("test_run") if last else None
    if not isinstance(run, dict) or run.get("scope") != "whole suite" or run.get("exit_code") != 0 or run.get("command") != cell.state.get("test_cmd"):
        return joined_suite_run(cell)
    head = git(cell.work, "rev-parse", "HEAD").stdout.strip()
    if cell.state.get("suite") != "green" or cell.state["tasks"][-1] is not last or head != last["commit"]:
        return joined_suite_run(cell)
    if "ran_on" in last and last["ran_on"] != head:
        return joined_suite_run(cell)
    return {"command": run["command"], "exit_code": 0, "passed": True, "seconds": 0.0, "output_tail": "", "output": "",
            "scope": "whole suite", "reused_from": last["id"], "reused_run_seconds": run.get("seconds"),
            "note": f"Not run again: the whole suite passed on exactly this code when {last['id']} was completed."}


def cmd_finish(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    if cell.info.get("stage") == "built":
        raise BuildError("This cell is already built.", code="wrong-stage")
    record = lane_record(cell)
    if record is not None and record.get("state") == "open":
        raise BuildError(lanes_open_refusal(cell, record), code="lanes-open")
    problems: List[str] = []
    pending = [task["id"] for task in cell.state["tasks"] if task["status"] != "done"]
    if pending:
        problems.append(f"Tasks not done: {', '.join(pending)}.")
    dirty = changed_files(cell)
    if dirty:
        problems.append(f"Uncommitted changes in the cell: {', '.join(dirty[:8])}. Every change belongs to a task, and every task is committed. If "
                        "a task needs them, its step was not run: run it. If the plan left them out, report a plan defect (in a revision round, "
                        "build.py add-task gives them a task). Otherwise a person " + set_aside_hint(cell.work, cell.ticket_id, "after the tasks") + ".")
    tests = reusable_suite_run(cell) if not dirty and not pending else None
    if tests is None:
        tests = run_tests(cell)
        tests["scope"] = "whole suite"
    if not tests["passed"]:
        problems.append("The test suite does not pass:\n" + tests["output_tail"][-800:])
    lint: Dict[str, Any] = {"command": cell.state.get("lint_cmd"), "status": "none configured"}
    if cell.state.get("lint_cmd"):
        try:
            lint = run_command(cell, cell.state["lint_cmd"], 300)
            lint["status"] = "pass" if lint["passed"] else "fail"
            if not lint["passed"]:
                problems.append("The linter reports problems:\n" + lint["output_tail"][-800:])
        except BuildError as exc:
            lint = {"command": cell.state["lint_cmd"], "status": "unverified", "note": str(exc)}
    spec = load_json(cell.root / "spec.json", {}) or {}
    wanted = [e["id"] for key in ("invariants", "functional_requirements", "scenarios") for e in spec.get(key) or [] if e.get("id")]
    untraced, respelled = unnamed_ids(cell, wanted, cell.state.get("test_files", []))
    if untraced and not cell.state.get("hardening"):
        problems.append(f"No test names these spec IDs: {', '.join(untraced)}" + (f" (found in another spelling: {', '.join(respelled)})" if respelled else "") + ". " + ID_SPELLING)
    if problems:
        cell.save()
        telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.finish", "outcome": "refuse", "reason_code": "not-finished",
                                                                 "overridden_by_reason": False, "problems": len(problems), "tasks_pending": len(pending)})
        print("NOT FINISHED:\n- " + "\n- ".join(problems))
        return 1

    baseline = cell.state["baseline"]
    changes = own_changes(cell)
    stat = git(cell.work, "diff", "--shortstat", *diff_args(changes)).stdout.strip()
    files = [name for name in git(cell.work, "diff", "--name-only", *diff_args(changes)).stdout.splitlines() if name.strip()]
    styling = ui_findings(cell, changes)
    report = {
        "ticket_id": cell.ticket_id, "slice_id": cell.info.get("slice_id"), "status": "BUILT", "finished_at": now(),
        "branch": cell.info.get("branch"), "baseline": baseline, "head": git(cell.work, "rev-parse", "HEAD").stdout.strip(),
        "review_loop": cell.state.get("loop", 0), "risk": cell.info.get("risk"), "human_review_required": bool(cell.info.get("human_review_required")) or cell.info.get("risk") == "High",
        "tests": {k: v for k, v in tests.items() if k not in ("output_tail", "output")}, "lint": {k: v for k, v in lint.items() if k not in ("output_tail", "output")},
        "tasks": [{k: t.get(k) for k in ("id", "kind", "status", "commit", "note", "first_run", "loop")} for t in cell.state["tasks"]],
        "tests_seen_failing_first": sum(1 for t in cell.state["tasks"] if t.get("first_run") == "fail"),
        "new_tests_first_run": {"seen_failing": sum(len((t.get("tests_first_run") or {}).get("failed") or []) for t in cell.state["tasks"]),
                                "already_passing": {t["id"]: t["tests_first_run"]["passed"] for t in cell.state["tasks"] if (t.get("tests_first_run") or {}).get("passed")},
                                "tasks_checked_test_by_test": [t["id"] for t in cell.state["tasks"] if t.get("tests_first_run")]},
        "tests_passing_on_first_run": [t["id"] for t in cell.state["tasks"] if t.get("first_run") == "pass"],
        "tests_written_early": [t["id"] for t in cell.state["tasks"] if t.get("first_run") == "not-run"],
        "impls_already_done": sorted({d.get("task") for d in cell.state.get("deviations") or [] if d.get("type") == "impl-already-done" and d.get("task")}),
        "deviations": cell.state.get("deviations", []), "files_changed": files, "diff": stat, "compared_with": changes["base"],
        "main_merges": {"enabled": update_from_main_enabled(cell), "merges": cell.state.get("main_merges") or [],
                        "note": "Each merge brought the main checkout's committed HEAD into the branch at the start of the build or of a revision. "
                                "A merge is not a task: what it brought came from main, so it is not in files_changed or diff and was not "
                                "scanned for secrets as this ticket's added lines." + (" " + changes["note"] if changes["note"] else "")},
        "test_files": cell.state.get("test_files", []), "styling_findings": styling,
        "timing": timing(cell, tests),
        "adrs": adrs_report(cell),
        "secret_scan": {"enabled": scan_enabled(cell.config),
                        "not_a_secret": [{"task": d.get("task"), "reason": d.get("detail"), "candidates": d.get("candidates") or []}
                                         for d in cell.state.get("deviations") or [] if d.get("type") == "not-a-secret"]},
    }
    if cell.state.get("command_changes"):  # only when the commands changed while building, so a build without a change reports as before
        report["command_changes"] = cell.state["command_changes"]
    if lane_record(cell) is not None:
        report_lanes(cell, report)
    (cell.root / "build-report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    cell.info["stage"] = "built"
    cell.save()
    cell.save_info()
    telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.finish", "outcome": "pass", "reason_code": None, "overridden_by_reason": False})
    telemetry(cell.root, "station.exited", "build", lambda: {"outcome": "built", "stage": "built", "tasks": len(report["tasks"]), "head": lifecycle.short(report["head"]),
                                                             "deviations": len(report["deviations"]), "tests_seen_failing_first": report["tests_seen_failing_first"]})
    print(json.dumps({
        "status": "BUILT", "report": str(cell.root / "build-report.json"), "diff": stat, "tasks": len(report["tasks"]),
        "tests_seen_failing_first": report["tests_seen_failing_first"], "deviations": len(report["deviations"]),
        "styling_findings": len(styling), "lint": lint["status"], "human_review_required": report["human_review_required"],
        "next": "Hand the cell to the verify station. The builder does not verify or review its own work.",
    }, indent=2))
    return 0


def adrs_report(cell: Cell) -> Dict[str, Any]:
    """For verification and review: the ADRs in force for this build (id and digest of the text the plan was made under),
    every exception a person recorded, with their name and reason, and this ticket's own proposals."""
    A = adr_module()
    record = A.planned_record(cell.info)
    applied = set(record.get("applied") or [])
    return {"in_force": [{key: item.get(key) for key in ("id", "title", "digest", "origin")} for item in record.get("planned_under") or []
                         if isinstance(item, dict) and (item.get("id") in applied or item.get("origin") == "ticket")],
            "exceptions": [{key: item.get(key) for key in ("adr", "by", "reason", "at")} for item in A.exceptions(cell.info)],
            "proposed": [{key: item.get(key) for key in ("id", "file", "title")} for item in record.get("proposed") or [] if isinstance(item, dict)],
            "accepted_on_branch": [{key: item.get(key) for key in ("id", "by", "at")} for item in cell.info.get("adr_acceptances") or [] if isinstance(item, dict)]}


def cmd_revise(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    if cell.info.get("stage") != "built":
        raise BuildError("A revision round starts from a built cell that review or verification sent back.", code="wrong-stage")
    limit = cell.section("review").get("max_loops", 3)
    loop = cell.state.get("loop", 0) + 1
    if loop >= limit:  # the build just sent back was failed round number `limit`
        cell.info["stage"] = "blocked"
        cell.save_info()
        telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "round-limit", "outcome": "refuse", "reason_code": "round-limit",
                                                                 "overridden_by_reason": False, "rounds": limit})
        telemetry(cell.root, "station.entered", "build", lambda: {"stage": "blocked", "revision": loop})
        telemetry(cell.root, "station.exited", "build", lambda: {"outcome": "escalated", "stage": "blocked"})
        print(json.dumps({
            "status": "ESCALATE", "loops_used": limit,
            "action": f"This ticket has now failed {limit} rounds of verification or review, which is the limit. Do not build again. Label the ticket 'blocked-requires-sme', set its state to blocked, and report to a person.",
        }, indent=2))
        return 1
    findings = None
    if args.findings and not Path(args.findings).is_file():
        raise BuildError(f"{Path(args.findings)}: findings file not found.", code="findings-missing")
    # Bring the branch up to date with main before any revision work, so the revision is built, verified and reviewed on
    # the code that is really there. A conflict refuses here and changes nothing: no round is used, no findings copied.
    synced = bring_up_to_date(cell, "revise", loop, str(Path(args.findings).resolve()) if args.findings else None)
    after_merge = None
    if synced:
        if cell.state.get("test_cmd"):
            try:
                ran = run_tests(cell)
                synced["tests_after"] = {"passed": ran["passed"], "exit_code": ran["exit_code"], "seconds": ran["seconds"], "command": ran["command"]}
                cell.state["suite"] = "green" if ran["passed"] else "red"
                if not ran["passed"]:
                    after_merge = (f"The test suite passed when this ticket was last built and fails now that {synced['main']} is merged in: the newer code on "
                                   f"{synced['main']} and this ticket's work do not fit together yet. This revision must make the whole suite pass again.\n"
                                   + ran["output_tail"][-800:])
            except BuildError as exc:
                synced["tests_after"] = {"passed": None, "not_run": str(exc)}
        cell.state.setdefault("main_merges", []).append(synced)
    if args.findings:
        source = Path(args.findings)
        findings = cell.root / f"review-findings-{loop}.md"
        findings.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
    cell.state["loop"] = loop
    cell.info["stage"] = "building"
    cell.save()
    cell.save_info()
    telemetry(cell.root, "station.entered", "build", lambda: {"stage": "building", "revision": loop, "findings_copied": findings is not None,
                                                             "synced_with_main": bool(synced)})
    print(json.dumps({
        "status": "REVISING", "loop": loop, "round": loop + 1, "rounds_left": limit - loop - 1, "findings": str(findings) if findings else None,
        "synced_with_main": merge_note(synced), "suite": cell.state.get("suite"), "tests_after_merge": after_merge,
        "next": "Add one task per finding with 'add-task' (a [test] task first for any behavior that was wrong), then work them with red, green and done.",
    }, indent=2))
    return 0


def cmd_status(cell: Cell, args: argparse.Namespace) -> int:
    tasks = cell.state.get("tasks") or []
    answer = {
        "ticket_id": cell.ticket_id, "stage": cell.info.get("stage"), "loop": cell.state.get("loop", 0), "suite": cell.state.get("suite"),
        "done": sum(1 for t in tasks if t["status"] == "done"), "tasks": len(tasks), "deviations": len(cell.state.get("deviations") or []),
        "next": (cell.next_task() or {}).get("id") if tasks else None, "workdir": str(cell.work),
        "adrs": adrs_in_force(cell) if adr is not None else None,
    }
    record = lane_record(cell)
    if record is not None:
        answer["lanes"] = {"state": record.get("state"), "lanes": [{"lane": entry["lane"], "status": lane_status(cell, entry)} for entry in record["lanes"]]}
    print(json.dumps(answer, indent=2, ensure_ascii=False))
    return 0


# The keys a change of test command makes stale: how one test file, and one test, are run. They are worked out again.
TEST_RUN_KEYS = ("test_file_cmd", "test_one", "test_file_check")
COMMAND_KEYS = ("test_cmd", "lint_cmd") + TEST_RUN_KEYS


def cmd_set_commands(cell: Cell, args: argparse.Namespace) -> int:
    """Give a build in progress its test command (or lint command), or change it, at any time while it is building: in its
    first build or a revision round, before, during or after its lanes. The builder chooses the command freely and says why;
    the change is recorded as a deviation (old, new, reason, when) for the reviewers and the change record. Nothing is
    restarted: done tasks stay done and the build carries on from where it is. A new test command is calibrated again (how a
    single test file runs) and, unless lanes are open, the whole suite is run once with it so the suite's state is the new
    command's. A suite run recorded under the old command is never reused at the finish (reusable_suite_run compares it).

    Open lanes: build.json is written under the lanes' lock and no lane's state file is touched (a lane's builder may be
    writing it). Each lane takes the commands from build.json whenever one of its commands runs (Lane.__init__), so every
    lane's next step uses the new command; a step already running finishes with the old one, and its run records which."""
    if not cell.state.get("tasks"):
        raise BuildError(f"Building has not started for {cell.ticket_id}, so there is no build to give a command to. Pass it to the start: "
                         f"build.py start {cell.ticket_id} --test-cmd \"<command>\"", code="not-started")
    reason = " ".join((args.reason or "").split())
    if not reason:
        raise BuildError("--reason is required: say truly why the build needs this command (where it comes from, or why the one recorded is wrong). "
                         "It goes to the reviewers.", code="no-reason")
    # A person may name the command (run.py decide do, or the run skill on their word): their name and where they decided are
    # recorded with it. Without --by it is the builder's own choice, recorded as before.
    person = " ".join((getattr(args, "by", None) or "").split())
    if getattr(args, "by", None) is not None and len(person) < 2:
        raise BuildError("--by must name the person who gave the command.", code="person-missing")
    decided = {"by": person, "recorded_by": SET_BY_VIA[getattr(args, "via", None) or "terminal"]} if person else {}
    given = {kind: value for kind, value in (("test", args.test_cmd), ("lint", args.lint_cmd)) if value is not None}
    if not given:
        raise BuildError(f"Name the command to set: --test-cmd \"<command>\", --lint-cmd \"<command>\", or both. {set_commands_hint(cell.ticket_id)}",
                         code="nothing-to-set")
    for kind, value in given.items():
        if not value.strip():
            raise BuildError(f"--{kind}-cmd is empty. Name the command the build runs.", code="command-empty")
        try:
            shlex.split(value)
        except ValueError as exc:
            raise BuildError(f"--{kind}-cmd cannot be read as a command ({exc}): check its quotes. Nothing was changed.", code="command-unparsable")
    stage = cell.info.get("stage")
    built = stage == "built"
    if stage != "building" and not built:
        raise BuildError(f"{cell.ticket_id} is not building (stage: {stage}), so there is no build in progress to change.", code="wrong-stage")
    if built:
        judged = judged_since_built(cell)
        if judged:
            raise BuildError(f"{cell.ticket_id} is built and {judged} has already judged this build under the commands its report names, so "
                             "changing them now would leave that judgement standing on a command it never ran. Its commands change while it is "
                             "building, which it is again in a revision round (build.py revise), when a round's findings send it back.",
                             code="wrong-stage")
        dirty = changed_files(cell)
        if dirty:
            raise BuildError(f"{cell.ticket_id} is built, and its checkout has uncommitted changes ({', '.join(dirty[:5])}), so the suite cannot be "
                             "run on exactly the code that was built. Nothing was changed. A person "
                             + set_aside_hint(cell.work, cell.ticket_id, "after the build") + f"; then run build.py set-commands {cell.ticket_id} again.",
                             code="uncommitted-changes")
    record = lane_record(cell)
    with (lanes_lock(cell) if record is not None else contextlib.ExitStack()):
        record = lane_record(cell)
        lanes_open = record is not None and record.get("state") == "open"
        at, changed, unchanged = now(), [], []
        for kind, value in given.items():
            key, new = f"{kind}_cmd", value.strip()
            old = cell.state.get(key)
            if old == new:
                unchanged.append(kind)
                continue
            cell.state[key] = new
            during = ("built, before verification" if built else f"revision round {cell.state.get('loop')}" if cell.state.get("loop")
                      else (f"lanes {record.get('state')}" if record else "first build"))
            cell.deviation(None, f"{kind}-command-set",
                           f"The {kind} command was {'set' if not old else 'changed'} while building ({during}): "
                           f"{json.dumps(old)} -> {json.dumps(new)}. Reason: {reason}")
            cell.state["deviations"][-1].update({"command": kind, "old": old, "new": new, "reason": reason, "during": during, "at": at, **decided})
            changed.append({"command": kind, "old": old, "new": new})
        calibration = suite = None
        if any(item["command"] == "test" for item in changed):
            for key in TEST_RUN_KEYS:
                cell.state.pop(key, None)
            calibration = calibrate_test_file(cell)
            cell.state["test_file_check"] = calibration
            if lanes_open:
                suite = {"not_run": "The lanes are open: each lane's next step runs its tests with the new command, in its own worktree."}
            else:
                try:
                    ran = run_tests(cell)
                    cell.state["suite"] = "green" if ran["passed"] else "red"
                    suite = {"passed": ran["passed"], "exit_code": ran["exit_code"], "seconds": ran["seconds"], "command": ran["command"],
                             "scope": "whole suite, on the checkout as it is now, uncommitted files included"}
                    if not ran["passed"]:
                        suite["output_tail"] = ran["output_tail"][-800:]
                except BuildError as exc:
                    cell.state["suite"] = "unknown"
                    suite = {"not_run": f"The new command cannot run yet ({exc}). That is fine for a build that installs its own test tool: each "
                                        "step that needs the tests runs them, and says so if they still cannot run."}
        lint = None
        if built and any(item["command"] == "lint" for item in changed) and cell.state.get("lint_cmd"):
            try:
                ran = run_command(cell, cell.state["lint_cmd"], 300)
                lint = {"status": "pass" if ran["passed"] else "fail", "command": ran.get("command"), "exit_code": ran.get("exit_code"),
                        "seconds": ran.get("seconds")}
                if not ran["passed"]:
                    lint["output_tail"] = ran["output_tail"][-800:]
            except BuildError as exc:
                lint = {"status": "unverified", "command": cell.state["lint_cmd"], "note": str(exc)}
        fix_task = outcome = None
        if changed:
            cell.state.setdefault("command_changes", []).append({"at": at, "changed": changed, "reason": reason, "loop": cell.state.get("loop", 0), **decided})
            tests_pass = suite is None or suite.get("passed") is True
            if built:
                outcome = finish_with_new_commands(cell, changed, reason, at, suite, lint) if tests_pass and (lint or {}).get("status") != "fail" \
                    else reopen_for_commands(cell, suite, lint)
            lint_failed = (lint or {}).get("status") == "fail"
            if not lanes_open and (lint_failed or (cell.state.get("suite") in ("red", "unknown") and any(item["command"] == "test" for item in changed))):
                fix_task = add_command_task(cell, lint_failed)
            if record is not None:
                save_shared(cell)
            else:
                cell.save()
            if outcome == "reopened":
                cell.save_info()
    if changed:
        telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.set-commands", "outcome": "pass", "reason_code": "commands-set",
                                                                 "overridden_by_reason": True, "commands": [item["command"] for item in changed]})
    if outcome == "reopened":
        telemetry(cell.root, "station.entered", "build", lambda: {"stage": "building", "reopened": "commands-changed", "tasks": len(cell.state["tasks"])})
    if fix_task:
        what = "the linter does not pass with the new lint command" if cell.state.get("suite") == "green" else "the whole suite does not pass with the new command"
        nxt = (f"Now {what}, and every task of the plan is done, so {fix_task} was added: make it pass, then complete it with build.py green "
               f"{cell.ticket_id} {fix_task} (it may change any file; committed tests "
               f"are frozen as always, and --amend-test \"<why>\" records a test that is truly wrong). If nothing needs to change once the command can "
               f"run, complete it with build.py green {cell.ticket_id} {fix_task} --already-done \"<why>\". Then build.py finish {cell.ticket_id}.")
    elif outcome == "stands":
        nxt = f"The build's finish stands. Hand the cell to the verify station, which runs the new command: verify.py start {cell.ticket_id}."
    else:
        nxt = (f"Carry on where the build is: each lane's builder from build.py next {cell.ticket_id} --lane <L>; the next step in every lane runs "
               "the tests with the new command." if lanes_open else
               f"Carry on from where the build is: build.py next {cell.ticket_id}. Nothing done is undone, and the next whole-suite run uses the new command.")
    answer = {
        "status": "COMMANDS_SET" if changed else "UNCHANGED", "ticket_id": cell.ticket_id,
        "test_cmd": cell.state.get("test_cmd"), "lint_cmd": cell.state.get("lint_cmd"), "changed": changed, "unchanged": unchanged,
        "recorded": "A deviation for the reviewers and the change record, with the old and the new command, the reason and when." if changed else
                    "Nothing was recorded: the command is already the one given.",
        "new_tests_run_alone": calibration, "suite": suite if changed else None, "next": nxt,
    }
    if built and changed:
        answer["build"] = (BUILT_STANDS if outcome == "stands" else BUILT_REOPENED)
        answer["stage"] = cell.info.get("stage")
        if lint is not None:
            answer["lint"] = lint
    if fix_task:
        answer["task_added"] = fix_task
    print(json.dumps(answer, indent=2, ensure_ascii=False))
    return 0


BUILT_STANDS = ("The build's finish stands: the whole suite passed with the new command on exactly the code that was built. Its report now "
                "names the new command and the change, so verification runs the new command and review sees why it changed.")
BUILT_REOPENED = ("The build's finish no longer stands: the new command does not pass on the code that was built, so the cell is back to building "
                  "with the suite red (or not known, if the command cannot run yet), and its build report is marked reopened so nothing trusts "
                  "it. Nothing is lost: every task and commit stays as it was. The builder carries on from build.py next, makes the whole suite "
                  "pass with the new command, and finishes again. No review round is used.")


def judged_since_built(cell: Cell) -> Optional[str]:
    """Which later station has already judged this build (its report's head), or None: verification started on it (evidence/results.json)
    or reached a verdict (evidence/summary.json). Review needs a passing verification, so it is covered by these."""
    head = (load_json(cell.root / "build-report.json", {}) or {}).get("head")
    for name, who in (("summary.json", "verification"), ("results.json", "verification")):
        record = load_json(cell.root / "evidence" / name, {}) or {}
        if isinstance(record, dict) and head and record.get("head") == head:
            return who
    return None


def finish_with_new_commands(cell: Cell, changed: List[Dict[str, Any]], reason: str, at: str, suite: Optional[Dict[str, Any]],
                             lint: Optional[Dict[str, Any]]) -> str:
    """A built cell whose new commands pass on exactly the code that was built: the finish stands, and build-report.json is brought up to
    date (tests, lint, deviations, command changes), so verification runs the new command and no claim made under the old one remains."""
    path = cell.root / "build-report.json"
    report = load_json(path, {}) or {}
    if suite is not None and suite.get("passed"):
        report["tests"] = {"command": suite.get("command"), "exit_code": suite.get("exit_code"), "passed": True, "seconds": suite.get("seconds"),
                           "scope": "whole suite", "ran_on": git(cell.work, "rev-parse", "HEAD").stdout.strip(),
                           "note": "Run when the command was changed after the tasks were done, on exactly the code that was built."}
    if lint is not None:
        report["lint"] = {key: value for key, value in lint.items() if key != "output_tail"}
    report["deviations"] = cell.state.get("deviations", [])
    report["command_changes"] = cell.state.get("command_changes") or []
    report.setdefault("commands_changed_after_finish", []).append({"at": at, "changed": changed, "reason": reason, "outcome": "the finish stands"})
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return "stands"


def reopen_for_commands(cell: Cell, suite: Optional[Dict[str, Any]], lint: Optional[Dict[str, Any]]) -> str:
    """A built cell whose new commands do not pass: back to building. The report is marked reopened (verification accepts only a BUILT
    report, and the stage is building), so the old finish is never trusted; the next finish writes it anew."""
    path = cell.root / "build-report.json"
    report = load_json(path, {}) or {}
    if report:
        report["status"] = "REOPENED"
        report["reopened"] = {"at": now(), "why": "The test or lint command was changed after the tasks were done, and the new one does not pass "
                                                  "on the code that was built.",
                              "tests_passed": (suite or {}).get("passed"), "lint": (lint or {}).get("status")}
        path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    cell.info["stage"] = "building"
    return "reopened"


COMMAND_TASK_TEXT = "Make the whole suite pass with the new test command"
LINT_TASK_TEXT = "Make the linter pass with the new lint command"


def add_command_task(cell: Cell, lint_failed: bool = False) -> Optional[str]:
    """When the new test command leaves the suite red (or not runnable) and every task is done, an [impl] task so the builder can make it
    pass and commit that work: without one, nothing it changed could be committed and the finish would refuse the uncommitted files. It
    names no file, so the scope gate leaves it free; committed tests stay frozen. Like the join's J-T01, it uses no review round."""
    if cell.next_task() is not None:
        return None  # a task is still to do: its own gates run the new command
    count = sum(1 for task in cell.state["tasks"] if task.get("added_by") == "set-commands")
    task_id = f"C-T{count + 1:02d}"
    text = COMMAND_TASK_TEXT if cell.state.get("suite") != "green" else LINT_TASK_TEXT
    cell.state["tasks"].append({"id": task_id, "kind": "impl", "text": text, "ids": [], "files": [], "status": "pending",
                                "added_by": "set-commands", "loop": cell.state.get("loop", 0)})
    plan = cell.root / "plan.md"
    if plan.is_file():
        body = plan.read_text(encoding="utf-8")
        line = f"- [ ] {task_id} [impl] {text}"
        marker = "\n## File touch map"
        body = body.replace(marker, f"{line}\n{marker}", 1) if marker in body else body.rstrip("\n") + "\n" + line + "\n"
        plan.write_text(body, encoding="utf-8")
    return task_id


# ---------------------------------------------------------------- lanes (M22)
#
# Where state lives. build.json holds the lane plan and each lane's status under "lanes"; only lanes-open and join write
# it, whole and atomically, under the lock file lanes/.lock. Each lane has its own folder, lanes/<L>/, holding its sparse
# worktree (repo/, on the branch mach-lane/<ticket>/<L>, made from the fork point) and its own state file, lane.json, which
# only the commands run in that lane write. No lane writes build.json, cell.json or plan.md, so two lanes never share a
# checkout or a state file. Lifecycle records from every lane go to the cell's one lifecycle.jsonl (concurrent appends are
# safe there).

AGENT_TYPE = "mach-builder" if Path(__file__).resolve().parent.parent.name.startswith("mach-") else "mach:builder"
_SIBLINGS: Dict[str, Any] = {}


def sibling(name: str) -> Any:
    """lanes.py or landing.py, the scripts beside this one, loaded when first needed so that this script loads without
    them (a project's parse_plan readers never need either). A module already loaded under that name is used."""
    if name in sys.modules:
        return sys.modules[name]
    if name not in _SIBLINGS:
        script = Path(__file__).resolve().parent / f"{name}.py"
        if not script.is_file():
            raise BuildError(f"{script.name} is not installed beside this script, so lanes cannot be {'joined' if name == 'landing' else 'planned'}.",
                             code=f"{name}-missing")
        previous = sys.dont_write_bytecode
        sys.dont_write_bytecode = True
        try:
            spec = importlib.util.spec_from_file_location(f"mach_build_{name}", script)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)  # type: ignore[union-attr]
        finally:
            sys.dont_write_bytecode = previous
        _SIBLINGS[name] = module
    return _SIBLINGS[name]


def whole(value: Any) -> Optional[int]:
    return value if type(value) is int and value >= 1 else None


def max_lanes(config: Dict[str, Any]) -> int:
    """build.max_lanes: how many lanes one ticket may run at once. Only a whole number of at least 1 is taken as given (1 builds
    one task at a time, as before lanes); absent or anything else reads as DEFAULT_MAX_LANES."""
    section = config.get("build") if isinstance(config.get("build"), dict) else {}
    return whole(section.get("max_lanes")) or DEFAULT_MAX_LANES


def max_builders(config: Dict[str, Any]) -> int:
    """factory.max_builders: builders on this machine across tickets. Default: factory.max_parallel."""
    section = config.get("factory") if isinstance(config.get("factory"), dict) else {}
    return whole(section.get("max_builders")) or whole(section.get("max_parallel")) or DEFAULT_MAX_PARALLEL


def claim_limit(config: Dict[str, Any]) -> int:
    section = config.get("factory") if isinstance(config.get("factory"), dict) else {}
    return whole(section.get("claim_minutes")) or DEFAULT_CLAIM_MINUTES


def moment(value: Any) -> Optional[datetime]:
    try:
        when = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def fresh(value: Any, minutes: int) -> bool:
    """Whether a recorded moment is less than `minutes` ago (and not believably in the future)."""
    when = moment(value) if value else None
    current = datetime.now(timezone.utc)
    return when is not None and when <= current + timedelta(minutes=5) and current - when < timedelta(minutes=minutes)


def write_json(path: Path, data: Any) -> None:
    """Write a state file whole and atomically: a reader sees the old file or the new one, never part of one."""
    handle, temp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        os.replace(temp, str(path))
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        raise


_HELD: Dict[str, int] = {}  # the lock files this process holds now, and how deep: a lock taken again inside itself is not taken twice


@contextlib.contextmanager
def file_lock(path: Path) -> Any:
    """An exclusive lock on one lock file, for this process's whole stay inside; re-entered freely by the same process."""
    key = str(path)
    if _HELD.get(key):
        _HELD[key] += 1
        try:
            yield
        finally:
            _HELD[key] -= 1
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(key, "a", encoding="utf-8") as handle:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        _HELD[key] = 1
        try:
            yield
        finally:
            _HELD.pop(key, None)
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def lanes_lock_path(root: Path) -> Path:
    return root / "lanes" / ".lock"


@contextlib.contextmanager
def lanes_lock(cell: Cell) -> Any:
    """The lanes' lock. Every write of build.json while lanes exist and every write of a lane's lane.json happens under it, each
    after reading the file again: lanes-open, join, hand-back and set-commands read build.json again on taking it."""
    path = lanes_lock_path(cell.root)
    outermost = not _HELD.get(str(path))
    with file_lock(path):
        if outermost:
            cell.state = load_json(cell.state_path, {}) or {}
        yield


@contextlib.contextmanager
def builders_lock(project: Path) -> Any:
    """One lock for the whole project, across tickets: counting the builders' places other tickets use and recording this
    ticket's grant (its lanes handed out) are one step under it, so two tickets opening lanes at once never both take the
    last place."""
    with file_lock(project / ".factory" / "worktrees" / ".builders.lock"):
        yield


# What only lanes-open writes in a lane's state file (the handing out); a lane's own command keeps what is on disk for these.
HANDOUT_KEYS = ("holder", "handed_at", "earlier_holders", "branch", "worktree_seconds", "restarted", "remade", "opened_at", "build", "made_at")


def merge_lane_state(mine: Dict[str, Any], disk: Dict[str, Any]) -> Dict[str, Any]:
    """What a lane command writes, merged with what is on disk now: another command may have written the file since this one
    read it (lanes-open handing the lane to another holder, or a second step of the lane). The handing out is disk's; a task
    done on either side stays done; deviations and test files are the union; nothing another command recorded is dropped.
    A lane made fresh since (another `made_at`) keeps disk's state whole: this command's is of an earlier lane."""
    if not disk:
        return mine
    if disk.get("made_at") != mine.get("made_at"):
        return disk
    merged = dict(mine)
    for key in HANDOUT_KEYS:
        if key in disk:
            merged[key] = disk[key]
        else:
            merged.pop(key, None)
    theirs = {task.get("id"): task for task in disk.get("tasks") or [] if isinstance(task, dict)}
    tasks = []
    for task in mine.get("tasks") or []:
        other = theirs.get(task.get("id")) or {}
        tasks.append(other if other.get("status") == "done" and task.get("status") != "done" else task)
    merged["tasks"] = tasks
    seen = {json.dumps(item, sort_keys=True) for item in mine.get("deviations") or []}
    merged["deviations"] = list(mine.get("deviations") or []) + [item for item in disk.get("deviations") or []
                                                                 if json.dumps(item, sort_keys=True) not in seen]
    merged["test_files"] = sorted(set(mine.get("test_files") or []) | set(disk.get("test_files") or []))
    for key in ("last_step_at", "started_at"):
        values = [value for value in (mine.get(key), disk.get(key)) if value]
        if values:
            merged[key] = max(values) if key == "last_step_at" else min(values)
    return merged


def save_shared(cell: Cell) -> None:
    cell.state["updated_at"] = now()
    write_json(cell.state_path, cell.state)


def lane_record(cell: Cell) -> Optional[Dict[str, Any]]:
    """build.json's lane record, or None for a build without lanes (every build of a plan written without the parts)."""
    record = cell.state.get("lanes")
    return record if isinstance(record, dict) and isinstance(record.get("lanes"), list) else None


def joined_lanes(cell: Cell) -> Optional[Dict[str, Any]]:
    record = lane_record(cell)
    return record if record is not None and record.get("state") == "joined" else None


def lane_record_of(record: Dict[str, Any], name: str) -> Dict[str, Any]:
    return next((entry for entry in record.get("lanes") or [] if entry.get("lane") == name), {})


def lane_of(cell: Cell, task_id: str) -> Optional[str]:
    """The lane a task is built in, from build.json's lane plan; None for a task before or after the lanes, or no lanes."""
    record = lane_record(cell)
    if record is None or record.get("state") in ("sequential",):
        return None
    return next((entry["lane"] for entry in record["lanes"] if task_id in (entry.get("tasks") or [])), None)


def lanes_open_refusal(cell: Cell, record: Dict[str, Any]) -> str:
    names = ", ".join(entry["lane"] for entry in record["lanes"])
    return (f"The lanes of {cell.ticket_id} are open ({names}), so nothing is built in the cell's own checkout until they are joined. "
            f"A lane's builder runs: build.py next {cell.ticket_id} --lane <L>. A lane that cannot finish is handed back to the cell: build.py "
            f"hand-back {cell.ticket_id} --lane <L> --reason \"<why>\". When every lane is done or handed back, the line runs: build.py join {cell.ticket_id}.")


class Lane(Cell):
    """One lane of a build (design 7.2): the cell with three things changed. `work` is the lane's own worktree, the state is
    lane.json, and saving writes only lane.json. Tasks are taken in the lane's own order; plan.md is not ticked (the join
    ticks it once) and cell.json is never written."""

    def __init__(self, cell: Cell, name: str) -> None:  # noqa: D107 - shares the cell's settings; never reads build.json again
        self.project, self.ticket_id, self.root, self.info, self.config = cell.project, cell.ticket_id, cell.root, cell.info, cell.config
        self.cell = cell
        self.lane = name
        self.folder = cell.root / "lanes" / name
        self.state_path = self.folder / "lane.json"
        self.state = load_json(self.state_path, {}) or {}
        if self.state and cell.state.get("command_changes"):
            # build.json holds the commands (set-commands writes only it, under the lanes' lock): a lane takes them from there each
            # time one of its commands runs, so a change reaches every lane without anyone else writing a lane's state file.
            for key in COMMAND_KEYS:
                if key in cell.state:
                    self.state[key] = cell.state[key]
                else:
                    self.state.pop(key, None)

    @property
    def work(self) -> Path:
        return self.folder / "repo"

    def save(self) -> None:
        """Write lane.json under the lanes' lock, merged with what is on disk now (merge_lane_state), so a command that started
        before a take-over, or finished a task while lanes-open was writing, never puts back what another command changed."""
        with file_lock(lanes_lock_path(self.root)):
            self.state = merge_lane_state(self.state, load_json(self.state_path, {}) or {})
            self.state["updated_at"] = now()
            tasks = self.state.get("tasks") or []
            if self.state.get("status") == "open" and tasks and all(task.get("status") == "done" for task in tasks):
                self.state["status"] = "done"
                self.state["finished_at"] = now()
                # The lane's own suite as its last step left it, recorded: what the join may say about the lanes' own suites.
                self.state["final_suite"] = self.state.get("suite")
            write_json(self.state_path, self.state)

    def save_info(self) -> None:
        raise BuildError("A lane never writes cell.json.", code="lane-state")

    def tick(self, task_id: str) -> None:
        return None

    def all_done_hint(self) -> str:
        return f"Lane {self.lane} is done. {LANE_DONE_NEXT}"

    def foreign_files(self) -> List[str]:
        """Every file the lane plan gives another lane."""
        record = lane_record(self.cell) or {}
        return sorted({name for entry in record.get("lanes") or [] if entry.get("lane") != self.lane for name in entry.get("files") or []})

    def touch(self) -> None:
        """Every build.py call in a lane records that the lane is alive."""
        self.state["last_step_at"] = now()
        if not self.state.get("started_at"):
            self.state["started_at"] = self.state["last_step_at"]
        self.save()


class Checkout(Cell):
    """The cell's settings and state with another checkout: the join's worktree, where the joined suite runs."""

    def __init__(self, cell: Cell, work: Path) -> None:  # noqa: D107
        self.project, self.ticket_id, self.root, self.info, self.config, self.state = cell.project, cell.ticket_id, cell.root, cell.info, cell.config, cell.state
        self.state_path = cell.state_path
        self._work = work

    @property
    def work(self) -> Path:
        return self._work


def check_holder(cell: Cell, lane: "Lane", holder: Optional[str]) -> None:
    """A lane's command given --holder runs only for the holder the lane is handed to now. Without --holder nothing is checked."""
    current = lane.state.get("holder")
    if holder and current and holder != current:
        raise BuildError(f"Lane {lane.lane} of {cell.ticket_id} has been taken over: it was handed to another holder at "
                         f"{lane.state.get('handed_at') or 'a later time'}, so this builder's work on it stops here. Stop and report, and leave the "
                         "lane's files as they are. Nothing is lost: every task this lane completed is committed on its branch and recorded, and "
                         f"the new holder's builder carries on from build.py next {cell.ticket_id} --lane {lane.lane}.", code="lane-taken-over")


def open_lane(cell: Cell, name: str, holder: Optional[str] = None, step: str = "next") -> Lane:
    """The lane a builder works in, refused unless it is open and handed out (to `holder`, when the call names one); records the call."""
    record = lane_record(cell)
    if record is None:
        raise BuildError(f"{cell.ticket_id} is not built in lanes; there is no lane {name}. Run: build.py next {cell.ticket_id}", code="no-lanes")
    entry = lane_record_of(record, name)
    if not entry:
        raise BuildError(f"{cell.ticket_id} has no lane {name}. Its lanes: {', '.join(e['lane'] for e in record['lanes'])}.", code="unknown-lane")
    if record.get("state") == "joined" or entry.get("status") in ("joined", "set-aside"):
        raise BuildError(f"Lane {name} of {cell.ticket_id} has been joined; nothing more is built in it. Run: build.py next {cell.ticket_id}", code="lane-joined")
    if entry.get("status") == "handed-back":
        why = (entry.get("handed_back") or {}).get("reason") or "it could not finish"
        raise BuildError(f"Lane {name} of {cell.ticket_id} was handed back to the cell ({why}), so nothing more is built in it. Stop and report. "
                         "Its finished tasks land at the join, and its other tasks are built in the cell, one at a time, after it.", code="lane-handed-back")
    if record.get("state") != "open" or entry.get("status") == "planned":
        raise BuildError(f"Lane {name} of {cell.ticket_id} is not open yet; the line opens it (build.py lanes-open).", code="lane-not-open")
    lane = Lane(cell, name)
    if not lane.state.get("tasks") or not lane.work.is_dir():
        raise BuildError(f"Lane {name} of {cell.ticket_id} has no worktree; the line makes it again with build.py lanes-open.", code="lane-not-open")
    check_holder(cell, lane, holder)
    with file_lock(lanes_lock_path(cell.root)):
        lane.state = merge_lane_state(lane.state, load_json(lane.state_path, {}) or {})
        lane.recovered = recover_interrupted(lane, step)
        lane.touch()
    return lane


def route(cell: Cell, task_id: str, holder: Optional[str] = None, step: str = "next") -> Cell:
    """Where red, green and done work on a task: its lane's worktree and lane.json while the lanes are open, else the cell.
    A builder cannot work a task in the wrong lane, nor any task in the cell's checkout while lanes are open."""
    if isinstance(cell, Lane):
        return cell
    record = lane_record(cell)
    if record is None:
        return cell
    name = lane_of(cell, task_id)
    if record.get("state") == "open":
        if name is None:
            if not any(task["id"] == task_id for task in cell.state.get("tasks") or []):
                return cell  # an unknown task is refused as before
            raise BuildError(lanes_open_refusal(cell, record), code="lanes-open")
        return open_lane(cell, name, holder, step)
    if record.get("state") == "planned" and name is not None:
        first = cell.next_task()
        if first is not None and first["id"] == task_id:
            raise BuildError(f"{task_id} is built in lane {name}, and the lanes are not open yet. {LANES_NEXT}", code="lanes-not-open")
    return cell


def lane_next(cell: Cell, name: str, holder: Optional[str] = None) -> int:
    lane = open_lane(cell, name, holder)
    task = lane.next_task()
    if task is None:
        print(json.dumps({"status": "LANE_DONE", "lane": name, "next": LANE_DONE_NEXT}, indent=2))
        return 0
    done = sum(1 for t in lane.state["tasks"] if t["status"] == "done")
    print(json.dumps({
        "task": task["id"], "kind": task["kind"], "complete_with": STEP_FOR[task["kind"]], "text": task["text"],
        "files": task["files"] or "The plan names no files for this task.", "progress": f"{done} of {len(lane.state['tasks'])} done in lane {name}",
        "suite": lane.state["suite"], "workdir": str(lane.work), "lane": name, "spec": spec_excerpt(cell, task["ids"]),
    }, indent=2, ensure_ascii=False))
    return 0


def plan_lanes_at_start(cell: Cell, text: str, args: argparse.Namespace) -> Optional[Dict[str, Any]]:
    """The lane plan `start` records, or None: then nothing about lanes is written and the build is as before (design 7.1).

    Lanes apply only when all hold: the plan's author used the parts or `after` marks (a plan without them is built one
    task at a time whatever the lane rule would compute: its independence was never claimed); build.max_lanes is above 1;
    the plan gives two lanes or more; the ticket is not a hardening ticket; and it started from a passing suite."""
    setting = max_lanes(cell.config)
    if setting < 2 or cell.state.get("hardening") or args.no_baseline or cell.state.get("suite") != "green":
        return None
    try:
        L = sibling("lanes")
    except BuildError:
        return None
    if not L.uses_additions(text):
        return None
    tasks, touch = parse_plan(text)
    if L.problems(text, copy.deepcopy(tasks), copy.deepcopy(touch)):
        return None  # check-plan refuses such a plan; one that reaches the build anyway is built one task at a time
    lane_plan = L.plan(text, copy.deepcopy(tasks), copy.deepcopy(touch))
    if len(lane_plan["lanes"]) < 2:
        return None
    return {"state": "planned", "setting": setting, "planned_at": now(), "fork": None,
            "plan": {key: lane_plan.get(key) for key in ("before", "after", "joined_because", "single_reason")},
            "lanes": [{"lane": entry["lane"], "tasks": entry["tasks"], "files": entry["files"], "status": "planned",
                       "branch": f"mach-lane/{cell.ticket_id}/{entry['lane']}"} for entry in lane_plan["lanes"]]}


def lanes_at_work(cell_root: Path, minutes: int) -> List[Dict[str, Any]]:
    """The lanes of a cell whose builder is at work: not done, and handed out or at a station step less than `minutes` ago. Each with
    its holder and times. Reads only. The routing sheet and the schedule decide who holds a ticket from this (schedule.lanes_held)."""
    found = []
    for path in sorted((cell_root / "lanes").glob("L*/lane.json")):
        data = load_json(path, {}) or {}
        last = data.get("last_step_at") or data.get("handed_at") if isinstance(data, dict) else None
        if isinstance(data, dict) and data.get("status") == "open" and fresh(last, minutes):
            found.append({"lane": path.parent.name, "holder": data.get("holder"), "handed_at": data.get("handed_at"), "last_step_at": last})
    return found


def live_lanes(cell_root: Path, minutes: int) -> List[str]:
    """The lanes of a cell whose builder called the station less than `minutes` ago and that are not done."""
    return [lane["lane"] for lane in lanes_at_work(cell_root, minutes)]


def others_using(cell: Cell, minutes: int) -> Tuple[int, List[Dict[str, Any]]]:
    """Builders the other tickets on this machine use (design 7.5): each other cell that is building with a fresh claim or a
    live lane counts one place, or one per live lane."""
    total, detail = 0, []
    base = cell.project / ".factory" / "worktrees"
    for folder in sorted(base.iterdir()) if base.is_dir() else []:
        if folder.name == cell.ticket_id or not folder.is_dir() or folder.is_symlink():
            continue
        info = load_json(folder / "cell.json", {})
        if not isinstance(info, dict) or info.get("stage") != "building":
            continue
        claim = load_json(folder / "claim.json", {})
        claimed = isinstance(claim, dict) and claim.get("stage") == "building" and any(
            fresh(claim.get(key), minutes) for key in ("renewed_at", "at") if claim.get(key))
        live = live_lanes(folder, minutes)
        if claimed or live:
            total += max(1, len(live))
            detail.append({"ticket": folder.name, "builders": max(1, len(live))})
    return total, detail


def registered_worktree(cell: Cell, repo: Path, branch: str) -> bool:
    listed = git(cell.project, "worktree", "list", "--porcelain").stdout.splitlines()
    paths = {Path(line[len("worktree "):]).resolve() for line in listed if line.startswith("worktree ")}
    return repo.resolve() in paths and git(repo, "symbolic-ref", "-q", "--short", "HEAD").stdout.strip() == branch


def lane_prompt(cell: Cell, name: str, work: Path, holder: str) -> str:
    return (f"Build lane {name} of MACH ticket {cell.ticket_id}. Follow the build skill's section 'Building one lane': run "
            f"build.py next {cell.ticket_id} --lane {name} --holder {holder}, give the same --holder {holder} to red, green, done and "
            f"hand-back, work only in {work}, and stop when it answers LANE_DONE.")


def cmd_lanes(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    record = lane_record(cell)
    if record is None:
        print(json.dumps({"ticket_id": cell.ticket_id, "state": "none", "lanes": [],
                          "why": "This build has no lanes: its plan is built one task at a time."}, indent=2))
        return 0
    minutes = claim_limit(cell.config)
    lanes = []
    for entry in record["lanes"]:
        lane = Lane(cell, entry["lane"])
        tasks = lane.state.get("tasks") or []
        lanes.append({"lane": entry["lane"], "tasks": entry["tasks"], "files": entry["files"], "status": lane_status(cell, entry),
                      "done": sum(1 for t in tasks if t.get("status") == "done"),
                      "workdir": str(lane.work) if lane.work.is_dir() else None, "branch": entry.get("branch"),
                      "live": lane.state.get("status") == "open" and fresh(lane.state.get("last_step_at") or lane.state.get("handed_at"), minutes),
                      "last_step_at": lane.state.get("last_step_at")})
    before_done = all(t["status"] == "done" for t in cell.state["tasks"] if t["id"] in (record["plan"].get("before") or []))
    state = record.get("state")
    if state == "planned":
        upcoming = f"build.py lanes-open {cell.ticket_id} --holder <holder>" if before_done else f"build.py next {cell.ticket_id}"
    elif state == "open":
        upcoming = (f"build.py join {cell.ticket_id}" if all(item["status"] in ("done", "handed-back") for item in lanes)
                    else f"build.py lanes-open {cell.ticket_id} --holder <holder>")
    else:
        upcoming = f"build.py next {cell.ticket_id}"
    print(json.dumps({"ticket_id": cell.ticket_id, "state": state, "setting": record.get("setting"), "fork": record.get("fork"),
                      "ready": state == "planned" and before_done, "before": record["plan"].get("before"), "after": record["plan"].get("after"),
                      "lanes": lanes, "why": record.get("why"), "next": upcoming}, indent=2))
    return 0


def lane_status(cell: Cell, entry: Dict[str, Any]) -> str:
    """A lane's status: build.json's, or, for an open lane, its own lane.json's (a lane marks itself done)."""
    if entry.get("status") in ("open",):
        own = (load_json(cell.root / "lanes" / entry["lane"] / "lane.json", {}) or {}).get("status")
        return own if own in ("open", "done") else "open"
    return str(entry.get("status"))


def next_ref(cell: Cell, prefix: str) -> str:
    """The next free numbered ref under `prefix` (no trailing slash): <prefix>/1, <prefix>/2, ..."""
    taken = git(cell.project, "for-each-ref", "--format=%(refname)", prefix + "/").stdout.split()
    number = len(taken) + 1
    while f"{prefix}/{number}" in taken:
        number += 1
    return f"{prefix}/{number}"


def set_aside_ref(cell: Cell, lane: str) -> str:
    """Where a set-aside lane's tip is kept: refs/mach/lanes-set-aside/<ticket>/<L>/<n>, a sibling of the lane-files refs."""
    return next_ref(cell, f"refs/mach/lanes-set-aside/{cell.ticket_id}/{lane}")


def bring_back_words(cell: Cell, ref: str, commits: Sequence[str]) -> str:
    """The exact commands that show what a kept ref holds and bring one of its commits back into the cell's checkout."""
    where = f'git -C "{cell.work}"'
    shown = ", ".join(str(sha)[:10] for sha in commits[:10]) + (f" and {len(commits) - 10} more" if len(commits) > 10 else "")
    return (f"{where} log {ref} shows them" + (f" ({shown})" if shown else "") + f"; {where} cherry-pick <commit> brings one back")


def not_this_build(cell: Cell, lane: "Lane", entry: Dict[str, Any], fork: str, branch: str) -> Optional[str]:
    """Why a lane's folder, branch or lane.json belongs to another build of this ticket (an earlier plan, or an earlier start),
    or None when it is this build's own (or there is nothing there)."""
    state = lane.state
    if state:
        if state.get("build") and state.get("build") != cell.state.get("started_at"):
            return f"its record was made for a build of {cell.ticket_id} started at {state.get('build')}, not this one ({cell.state.get('started_at')})"
        if state.get("fork") and state.get("fork") != fork:
            return f"its record starts from {str(state.get('fork'))[:10]}, not from this build's fork point {fork[:10]}"
        ids = [task.get("id") for task in state.get("tasks") or []]
        if ids and ids != list(entry.get("tasks") or []):
            return f"its record holds the tasks {', '.join(map(str, ids))}, not this build's {', '.join(entry.get('tasks') or [])}"
        planned = {task["id"]: task for task in cell.state.get("tasks") or []}
        for task in state.get("tasks") or []:
            mine = planned.get(task.get("id")) or {}
            if mine and (mine.get("text") != task.get("text") or sorted(mine.get("files") or []) != sorted(task.get("files") or [])):
                return f"its task {task.get('id')} is not the task of that name in this build's plan"
        return None
    tip = git(cell.project, "rev-parse", "--verify", "-q", f"refs/heads/{branch}").stdout.strip()
    if tip and tip != fork:
        return f"its branch {branch} is at {tip[:10]}, but this build has not handed the lane out yet and starts it from {fork[:10]}"
    return None


def make_lane_fresh(cell: Cell, landing: Any, lane: "Lane", entry: Dict[str, Any], branch: str, why: str) -> None:
    """A lane whose folder, branch or lane.json belongs to another build is never reused and never refused: what is there is set
    aside where it can be brought back, and the lane starts fresh for this build. Its uncommitted files go under a lane-files ref,
    its branch tip under refs/mach/lanes-set-aside/<ticket>/<L>/<n>, and its lane.json to lanes/<L>/set-aside/<n>/lane.json.
    Recorded on the lane's entry (`made_fresh`) and as a deviation, with the commands that bring it back."""
    name = entry["lane"]
    files_ref = None
    if lane.work.is_dir() and registered_worktree(cell, lane.work, branch):
        stray = changed_files(lane)
        if stray:
            saved = landing.set_aside_files(lane.work, stray, next_ref(cell, f"refs/mach/lane-files/{cell.ticket_id}/{name}"),
                                            f"Uncommitted files in lane {name}, set aside when the lane was made fresh [{cell.ticket_id}]")
            files_ref = saved["ref"]
    tip = git(cell.project, "rev-parse", "--verify", "-q", f"refs/heads/{branch}").stdout.strip()
    commits = git(cell.work, "rev-list", "--reverse", tip, "--not", "HEAD").stdout.split() if tip else []  # what the ticket's branch lacks
    ref = None
    if tip and commits:
        ref = set_aside_ref(cell, name)
        if git(cell.project, "update-ref", ref, tip).returncode != 0:
            raise BuildError(f"Lane {name}'s branch {branch} belongs to another build, and the station could not keep its tip {tip[:10]} under "
                             f"{ref}, so nothing was changed. Run build.py lanes-open {cell.ticket_id} again; if it fails the same way, the Git error "
                             "is in the project's repository.", code="lane-not-kept")
    # Only the lane's own registered worktree is removed; a folder Git does not know as it is left for lanes-open's refusal to name.
    ours = lane.work.exists() and registered_worktree(cell, lane.work, branch)
    left = landing.remove(cell.project, [lane.work] if ours else [], [branch] if tip else [])
    if left:
        raise BuildError(f"Lane {name} belongs to another build and could not be cleared for this one: {'; '.join(left)}. Its work is kept"
                         + (f" under {ref}" if ref else "") + f". Run build.py lanes-open {cell.ticket_id} again once that is put right.",
                         code="lane-not-cleared")
    state_file = None
    if lane.state_path.is_file():
        folder = lane.folder / "set-aside"
        number = 1
        while (folder / str(number)).exists():
            number += 1
        (folder / str(number)).mkdir(parents=True)
        target = folder / str(number) / "lane.json"
        os.replace(str(lane.state_path), str(target))
        state_file = str(target.relative_to(cell.root))
    lane.state = {}
    at = now()
    record = {"at": at, "why": "another-build", "detail": why, "ref": ref, "files_ref": files_ref, "state_file": state_file, "commits": commits}
    entry.setdefault("made_fresh", []).append(record)
    kept = []
    if ref:
        kept.append(f"its {len(commits)} commit(s) are kept under {ref}: {bring_back_words(cell, ref, commits)}")
    if files_ref:
        kept.append(f'its uncommitted files are kept under {files_ref}: git -C "{cell.work}" checkout {files_ref} -- <path> brings one back')
    if state_file:
        kept.append(f"its earlier record is kept at {state_file}")
    cell.deviation(None, "lane-made-fresh", f"Lane {name} was made fresh for this build, because {why}. Nothing was lost: "
                   + ("; ".join(kept) if kept else "there was nothing of its own to keep") + ".")
    cell.state["deviations"][-1].update({"lane": name, "ref": ref, "files_ref": files_ref, "state_file": state_file, "commits": commits,
                                         "by": "build station"})
    telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.lanes-open", "outcome": "pass", "reason_code": "lane-made-fresh",
                                                             "overridden_by_reason": False, "lane": name})


def checked_out_elsewhere(cell: Cell, branch: str, repo: Path) -> Optional[str]:
    """The folder of another worktree that has `branch` checked out, or None."""
    path = None
    for line in git(cell.project, "worktree", "list", "--porcelain").stdout.splitlines():
        if line.startswith("worktree "):
            path = line[len("worktree "):]
        elif line == f"branch refs/heads/{branch}" and path and Path(path).resolve() != repo.resolve():
            return path
    return None


def remake_worktree(cell: Cell, lane: "Lane", entry: Dict[str, Any], branch: str, fork: str) -> Tuple[str, bool]:
    """Make a lane's missing worktree again (its folder deleted or moved by hand), at its last recorded commit. Git's record of
    the old folder is dropped first (`git worktree prune`), so the folder can be made again. A lane branch that is checked out
    in another worktree (a person's) is left to it: the lane goes on, on a new branch made at its last recorded commit, recorded
    as a deviation. Returns (the branch, whether this call made it)."""
    git(cell.project, "worktree", "prune")
    name = entry["lane"]
    committed = [t["commit"] for t in lane.state.get("tasks") or [] if t.get("status") == "done" and t.get("commit")]
    has_branch = git(cell.project, "show-ref", "--verify", "-q", f"refs/heads/{branch}").returncode == 0
    elsewhere = checked_out_elsewhere(cell, branch, lane.work) if has_branch else None
    if elsewhere:
        start = committed[-1] if committed else fork
        base, number = f"mach-lane/{cell.ticket_id}/{name}", 2
        while git(cell.project, "show-ref", "--verify", "-q", f"refs/heads/{base}-{number}").returncode == 0:
            number += 1
        old, branch = branch, f"{base}-{number}"
        if git(cell.project, "branch", branch, start).returncode != 0:
            raise BuildError(f"Lane {name}'s branch {old} is checked out in {elsewhere}, and Git could not make a new branch for the lane, so "
                             f"nothing was changed. Run build.py lanes-open {cell.ticket_id} again.", code="lane-branch-failed")
        entry["branch"] = branch
        lane.state["branch"] = branch
        lane.state.setdefault("remade", []).append({"at": now(), "branch": branch, "old_branch": old, "why": "checked-out-elsewhere"})
        cell.deviation(None, "lane-worktree-remade", f"Lane {name}'s worktree was missing and its branch {old} is checked out in {elsewhere}, which "
                       f"is left as it is. The lane goes on on a new branch, {branch}, made at its last recorded commit {start[:10]}; anything "
                       f"committed on {old} since is kept there.")
        cell.state["deviations"][-1].update({"lane": name, "branch": branch, "old_branch": old, "by": "build station"})
        return branch, True
    if committed and not has_branch:
        # The branch is gone but the lane recorded its commits: put the branch back at the last one, so no work is lost.
        if git(cell.project, "cat-file", "-e", f"{committed[-1]}^{{commit}}").returncode == 0 \
                and git(cell.project, "branch", branch, committed[-1]).returncode == 0:
            has_branch = True
        else:  # the commits themselves are gone: the lane starts again from the fork point, and says so
            lane.state["restarted"] = {"at": now(), "why": f"its branch {branch} and its commits were gone"}
            for task in lane.state.get("tasks") or []:
                for key in [k for k in task if k not in ("id", "kind", "text", "ids", "files")]:
                    task.pop(key)
                task["status"] = "pending"
            lane.state.update({"status": "open", "deviations": [], "test_files": list(cell.state.get("test_files") or []), "suite": "green"})
    return branch, not has_branch


def cmd_lanes_open(cell: Cell, args: argparse.Namespace) -> int:
    """Make any missing lane worktree and say which lanes to start now (design 6.2, 7.1, 7.5)."""
    cell.require_started()
    landing = None
    with lanes_lock(cell):
        record = lane_record(cell)
        if record is None:
            print(json.dumps({"status": "NONE_LEFT", "lanes": [], "why": "This build has no lanes: its plan is built one task at a time.",
                              "next": f"build.py next {cell.ticket_id}"}, indent=2))
            return 0
        if record.get("state") == "sequential":
            print(json.dumps({"status": "SEQUENTIAL", "lanes": [], "why": record.get("why"), "next": f"build.py next {cell.ticket_id}"}, indent=2))
            return 0
        if record.get("state") == "joined":
            print(json.dumps({"status": "NONE_LEFT", "lanes": [], "why": "The lanes are joined.", "next": f"build.py next {cell.ticket_id}"}, indent=2))
            return 0
        if not HOLDER_RE.match(str(args.holder or "")):
            raise BuildError("--holder must be the driver's holder token: 8 to 64 letters, digits, '-' or '_'.", code="bad-holder")
        if cell.info.get("stage") != "building" or cell.state.get("loop", 0):
            raise BuildError("Lanes open only in a ticket's first build, never in a revision round.", code="wrong-stage")
        before = [t["id"] for t in cell.state["tasks"] if t["id"] in (record["plan"].get("before") or []) and t["status"] != "done"]
        if before:
            raise BuildError(f"The tasks before the lanes are not done yet ({', '.join(before)}). The cell's builder does them first: "
                             f"build.py next {cell.ticket_id}", code="lanes-not-ready")
        if args.grant is not None and args.grant < 0:
            raise BuildError("--grant must be a whole number, 0 or more.", code="bad-grant")
        first = record.get("state") == "planned"
        if first:
            recover_interrupted(cell, "lanes-open")  # a task before the lanes whose step stopped before it was recorded
            suite = cell.state.get("suite")
            if suite != "green":
                # Not a stop for a person: a builder can make a suite pass. Lanes need a passing fork point, so the plan is built one task
                # at a time in the cell instead, where the next step's gates see the suite as it is. Recorded for the reviewers.
                why = (f"The cell's suite is {suite} where the lanes would open, so no lane could start from a passing suite. The plan is "
                       f"built one task at a time in the cell instead, as without lanes, and the cell's builder makes the suite pass on the way: "
                       f"build.py next {cell.ticket_id} names the step."
                       + (f" If the suite is not known because the test command is missing or wrong: {set_commands_hint(cell.ticket_id)}."
                          if suite != "red" else ""))
                return go_sequential(cell, record, why, 0, {"suite": suite, "cause": "suite-not-green"})
            dirty = changed_files(cell)
            if dirty:
                raise BuildError(f"The cell has uncommitted changes ({', '.join(dirty[:5])}), so the lanes cannot start from its last commit. Nothing "
                                 "was opened. Every change belongs to a task: if a task before the lanes needs them, run its step "
                                 f"(build.py next {cell.ticket_id}); otherwise a person " + set_aside_hint(cell.work, cell.ticket_id, "before the lanes")
                                 + ".", code="uncommitted-changes")
        fork = record.get("fork") or git(cell.work, "rev-parse", "HEAD").stdout.strip()
        minutes = claim_limit(cell.config)
        held, candidates, done, made_fresh = [], [], [], []
        for entry in record["lanes"]:
            if entry.get("status") in ("joined", "set-aside", "handed-back"):
                continue
            lane = Lane(cell, entry["lane"])
            branch = entry.get("branch") or f"mach-lane/{cell.ticket_id}/{entry['lane']}"
            stale = not_this_build(cell, lane, entry, fork, branch)
            if stale:
                landing = landing or sibling("landing")
                make_lane_fresh(cell, landing, lane, entry, branch, stale)
                made_fresh.append(entry["lane"])
            elif lane.state.get("tasks") and lane.work.is_dir():
                with file_lock(lanes_lock_path(cell.root)):
                    recover_interrupted(lane, "lanes-open")
            if lane.state.get("status") == "done":
                done.append(entry["lane"])
            elif (lane.state and lane.state.get("holder") != args.holder and not args.take_over
                  and lane.state.get("holder") not in (getattr(args, "carry_on_from", None) or [])
                  and fresh(lane.state.get("last_step_at") or lane.state.get("handed_at"), minutes)):
                held.append(entry["lane"])
            else:
                candidates.append(entry)
        if not candidates:
            if held:
                raise BuildError(f"Every lane left ({', '.join(held)}) is being built by another holder, whose builder called the station less "
                                 f"than factory.claim_minutes ({minutes}) ago. Wait for it, or a person takes it over with --take-over.",
                                 code="lane-held")
            save_shared(cell)
            print(json.dumps({"status": "NONE_LEFT", "lanes": [], "why": f"Every lane is done ({', '.join(done)}).",
                              "next": f"build.py join {cell.ticket_id}"}, indent=2))
            return 0
        # Counting the places other tickets use and recording this ticket's grant (its lanes handed out, which is what other tickets
        # count) are one step under one lock for the whole project, so two tickets opening lanes at once never exceed the cap.
        with builders_lock(cell.project):
            used, others = others_using(cell, minutes)
            free = max_builders(cell.config) - used
            limits = [max_lanes(cell.config), free] + ([args.grant] if args.grant is not None else [])
            room = min(limits) - len(held)
            limited_by = (f"build.max_lanes {max_lanes(cell.config)}; factory.max_builders {max_builders(cell.config)}, of which other tickets use {used}"
                          + (f"; the line granted {args.grant}" if args.grant is not None else "")
                          + (f"; {len(held)} of this ticket's lanes are at work for another holder" if held else ""))
            # The ticket's own place: a ticket whose lanes are open always keeps one builder at work, though other tickets hold every place
            # under factory.max_builders. So the machine runs at most one builder more than the cap, and only this ticket's own one.
            own_place = room < 1 and not held
            if own_place:
                room = 1
            if first and min(room, len(candidates)) < 2:
                why = (f"Only {max(room, 0)} builder(s) may run for this ticket now ({limited_by}), so its plan is built one task at a time in the "
                       "cell, as without lanes.")
                return go_sequential(cell, record, why, max(room, 0), {"free_places": free, "others": others, "cause": "no-free-places"})
            if room < 1:
                save_shared(cell)
                raise BuildError(f"Every lane left that may start now waits for a place, and this ticket already has builders at work: lane(s) "
                                 f"{', '.join(held)}, for another holder ({limited_by}). Nothing is lost. Ask again when one is done or a place is free.",
                                 code="no-free-place")
            chosen = candidates[:room]
            made: List[Tuple[Lane, str, bool]] = []
            handed = []
            for entry in chosen:
                lane = Lane(cell, entry["lane"])
                branch = entry.get("branch") or f"mach-lane/{cell.ticket_id}/{entry['lane']}"
                seconds = None
                if lane.work.exists():
                    if not registered_worktree(cell, lane.work, branch):
                        raise BuildError(f"{lane.work} exists but is not this lane's worktree on {branch}. Nothing was changed. Move that folder aside "
                                         f"(nothing in it is touched by the station), then run build.py lanes-open {cell.ticket_id} again: the lane's "
                                         "worktree is made again on its committed work.",
                                         code="lane-folder-unknown")
                else:
                    if workspace is None:
                        raise BuildError("The intent station's workspace.py is not installed beside this skill, so a lane's worktree cannot be made.",
                                         code="worktree-failed")
                    branch, new_branch = remake_worktree(cell, lane, entry, branch, fork)
                    lane.folder.mkdir(parents=True, exist_ok=True)
                    started = time.monotonic()
                    try:  # sparse like the cell's own: never .claude/ or .mcp.json
                        workspace.create(cell.project, lane.work, branch, start=fork)
                    except workspace.WorkspaceError as exc:
                        for other, other_branch, new in made:  # only what this call made
                            workspace._undo(cell.project, other.work, other_branch, new)  # noqa: SLF001
                        raise BuildError(f"Lane {entry['lane']}'s worktree could not be made, so no lane was opened. {exc}", code="worktree-failed")
                    seconds = round(time.monotonic() - started, 1)
                    made.append((lane, branch, new_branch))
                    if lane.state.get("tasks"):
                        with file_lock(lanes_lock_path(cell.root)):
                            recover_interrupted(lane, "lanes-open")  # its branch may hold a step's commit its record lacks
                handed.append((entry, lane, branch, seconds))
            at = now()
            for entry, lane, branch, seconds in handed:
                if not lane.state.get("tasks"):
                    wanted = set(entry["tasks"])
                    lane.state = {
                        "ticket_id": cell.ticket_id, "lane": entry["lane"], "branch": branch, "fork": fork, "status": "open",
                        "opened_at": at, "made_at": at, "build": cell.state.get("started_at"), "loop": 0, "hardening": False, "baseline": fork,
                        "test_cmd": cell.state.get("test_cmd"), "lint_cmd": cell.state.get("lint_cmd"),
                        **{key: cell.state[key] for key in ("test_file_cmd", "test_one", "test_file_check") if key in cell.state},
                        "suite": "green", "test_files": list(cell.state.get("test_files") or []), "deviations": [],
                        "tasks": [copy.deepcopy(t) for t in cell.state["tasks"] if t["id"] in wanted],
                        "worktree_seconds": seconds, "started_at": None, "last_step_at": None,
                    }
                elif seconds is not None:
                    lane.state["worktree_seconds"] = round((lane.state.get("worktree_seconds") or 0) + seconds, 1)
                if lane.state.get("holder") and lane.state.get("holder") != args.holder:
                    # Taken over: the earlier holder's builder is refused from now on when it names its holder (check_holder).
                    earlier = {"holder": lane.state.get("holder"), "until": at}
                    if lane.state.get("holder") in (getattr(args, "carry_on_from", None) or []):
                        earlier["why"] = "carried on from a run known to have ended"
                    lane.state.setdefault("earlier_holders", []).append(earlier)
                lane.state.update({"holder": args.holder, "handed_at": at, "branch": branch,
                                   "status": "done" if lane.state.get("status") == "done" else "open"})
                # Under the lanes' lock, held here: a lane command saving now waits, and merges onto this (merge_lane_state).
                write_json(lane.state_path, lane.state)
                entry["status"] = "open"
                entry["branch"] = branch
            if first:
                record.update({"state": "open", "fork": fork, "opened_at": at})
            record.setdefault("batches", []).append({"at": at, "lanes": [entry["lane"] for entry, _, _, _ in handed], "granted": room,
                                                     "free_places": free, "others": others})
            save_shared(cell)
    telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.lanes-open", "outcome": "pass", "reason_code": None, "overridden_by_reason": False,
                                                             "lanes": [entry["lane"] for entry, _, _, _ in handed], "granted": room, "first": first})
    model = cell.section("models").get("build") if isinstance(cell.section("models").get("build"), str) and cell.section("models").get("build") else "sonnet"
    print(json.dumps({
        "status": "OPEN",
        "lanes": [{"lane": entry["lane"], "tasks": entry["tasks"], "workdir": str(lane.work), "branch": branch, "agent_type": AGENT_TYPE,
                   "model": model, "prompt": lane_prompt(cell, entry["lane"], lane.work, args.holder)} for entry, lane, branch, _ in handed],
        "why": f"{len(handed)} lane(s) to start now, at once; " + (f"{len(candidates) - len(handed)} more after them. " if len(candidates) > len(handed) else "")
               + (fewer_words(len(handed), len(candidates), limited_by, own_place) if len(candidates) > len(handed) else "")
               + f"Each builder stops at LANE_DONE. When every lane is done: build.py join {cell.ticket_id}.",
        "fork": fork,
        **({"made_fresh": made_fresh} if made_fresh else {}),
    }, indent=2))
    return 0


def fewer_words(started: int, left: int, limited_by: str, own_place: bool) -> str:
    """Why fewer lanes were started now than are left to build."""
    if own_place:
        return (f"Only {started} started because every builder's place on this machine is in use ({limited_by}): this ticket keeps its own "
                "place, so one lane runs now and the others follow as places come free. ")
    return f"Only {started} of the {left} started now, because of the limits in force ({limited_by}); the others follow as places come free. "


def go_sequential(cell: Cell, record: Dict[str, Any], why: str, granted: int, extra: Dict[str, Any]) -> int:
    """The lanes are not opened: the plan is built one task at a time in the cell, as without lanes (design 7.1). Recorded under the
    lanes' record and as a deviation for the reviewers; build.json is written under the lanes' lock (the caller holds it)."""
    record.update({"state": "sequential", "why": why, "decided_at": now(), **extra})
    for entry in record["lanes"]:
        entry["status"] = "sequential"
    cell.deviation(None, "lanes-sequential", why)
    cell.state["deviations"][-1].update({"by": "build station", "lanes": len(record["lanes"]), "granted": granted, "cause": extra.get("cause")})
    save_shared(cell)
    telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.lanes-open", "outcome": "refuse", "reason_code": "sequential",
                                                             "overridden_by_reason": False, "lanes": len(record["lanes"]), "granted": granted})
    print(json.dumps({"status": "SEQUENTIAL", "lanes": [], "why": why, "recorded": "A deviation for the reviewers, with this reason.",
                      "next": f"build.py next {cell.ticket_id}"}, indent=2))
    return 0


def cmd_hand_back(cell: Cell, args: argparse.Namespace) -> int:
    """A lane that cannot finish (it truly needs a file another lane owns, or anything else its builder or the driver says)
    hands its remaining tasks back to the cell. Nothing is lost and nothing is undone: the lane's finished tasks still land
    at the join, and its unfinished ones become pending in the cell, built one at a time after the join under the cell's
    gates, where every landed file is in reach. Recorded as a deviation with the reason. Only build.json is written, under
    the lanes' lock; from then on the lane's own commands refuse and say so."""
    cell.require_started()
    reason = " ".join((args.reason or "").split())
    if not reason:
        raise BuildError("--reason is required: say why this lane cannot finish (for example, the file of another lane it needs). It goes to the "
                         "reviewers.", code="no-reason")
    name = args.lane
    if lane_record(cell) is None:
        raise BuildError(f"{cell.ticket_id} is not built in lanes; there is no lane to hand back. Its tasks are built in the cell: "
                         f"build.py next {cell.ticket_id}", code="no-lanes")
    with lanes_lock(cell):
        record = lane_record(cell)
        if record is None:
            raise BuildError(f"{cell.ticket_id} is not built in lanes; there is no lane to hand back. Its tasks are built in the cell: "
                             f"build.py next {cell.ticket_id}", code="no-lanes")
        entry = lane_record_of(record, name)
        if not entry:
            raise BuildError(f"{cell.ticket_id} has no lane {name}. Its lanes: {', '.join(e['lane'] for e in record['lanes'])}.", code="unknown-lane")
        state = record.get("state")
        if state == "joined":
            raise BuildError(f"The lanes of {cell.ticket_id} are already joined, so every task left is built in the cell: build.py next {cell.ticket_id}",
                             code="already-joined")
        if state == "sequential":
            raise BuildError(f"The plan of {cell.ticket_id} is built one task at a time in the cell already; there is no lane to hand back. "
                             f"build.py next {cell.ticket_id}", code="no-lanes")
        if state != "open":
            raise BuildError(f"The lanes of {cell.ticket_id} are not open yet, so nothing has been built in lane {name}. To build the whole plan one "
                             f"task at a time in the cell instead, the line opens the lanes with a grant of one: build.py lanes-open {cell.ticket_id} "
                             "--holder <holder> --grant 1.", code="lanes-not-open")
        if entry.get("status") in ("handed-back", "joined", "set-aside"):
            raise BuildError(f"Lane {name} of {cell.ticket_id} was already handed back ({(entry.get('handed_back') or {}).get('reason')}). When every "
                             f"other lane is done: build.py join {cell.ticket_id}", code="already-handed-back")
        lane = Lane(cell, name)
        check_holder(cell, lane, args.holder)
        tasks = lane.state.get("tasks") or [{"id": task_id, "status": "pending"} for task_id in entry.get("tasks") or []]
        finished = [task["id"] for task in tasks if task.get("status") == "done"]
        unfinished = [task["id"] for task in tasks if task.get("status") != "done"]
        if not unfinished:
            raise BuildError(f"Lane {name} of {cell.ticket_id} is done: every one of its tasks is built, so nothing is left to hand back. When every "
                             f"lane is done: build.py join {cell.ticket_id}", code="lane-done")
        at = now()
        entry["status"] = "handed-back"
        entry["handed_back"] = {"at": at, "reason": reason, "holder": args.holder, "finished_then": finished, "unfinished_then": unfinished,
                                "suite_then": lane.state.get("suite")}  # the lane's own suite when it was handed back, as its last step left it
        cell.deviation(None, "lane-handed-back", f"Lane {name} handed its remaining tasks ({', '.join(unfinished)}) back to the cell, to be built one "
                       f"at a time after the join: {reason}" + (f". Its finished tasks ({', '.join(finished)}) land at the join." if finished else "."))
        cell.state["deviations"][-1].update({"lane": name, "tasks": unfinished, "finished": finished, "reason": reason, "holder": args.holder})
        save_shared(cell)
        ready = all(other.get("status") == "handed-back" or Lane(cell, other["lane"]).state.get("status") == "done" for other in record["lanes"])
    telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.hand-back", "outcome": "pass", "reason_code": "lane-handed-back",
                                                             "overridden_by_reason": True, "lane": name})
    print(json.dumps({
        "status": "HANDED_BACK", "lane": name, "finished": finished, "handed_back": unfinished,
        "recorded": "A deviation for the reviewers, with the reason.",
        "next": (f"Every lane is done or handed back: build.py join {cell.ticket_id}. The handed-back tasks are then built in the cell: build.py next "
                 f"{cell.ticket_id}" if ready else
                 f"A lane builder stops here and reports. The other lanes carry on; when every lane is done or handed back: build.py join {cell.ticket_id}."),
    }, indent=2))
    return 0


# ---------------------------------------------------------------- the join (design 8)

def cmd_join(cell: Cell, args: argparse.Namespace) -> int:
    """Land every lane's commits on the ticket's branch, one per task in plan order, and run the whole suite on the result.
    The landing itself is landing.join_lanes (piece C2); this station turns the facts it returns into state, the report and
    the build.join gate event. Run again after any interruption: landing starts over or finishes what an earlier run did."""
    cell.require_started()
    landing = sibling("landing")
    with lanes_lock(cell):
        record = lane_record(cell)
        if record is None or record.get("state") != "open":
            state = (record or {}).get("state", "none")
            if state == "joined":
                raise BuildError(f"The lanes of {cell.ticket_id} are already joined. The build goes on in the cell: build.py next {cell.ticket_id}",
                                 code="already-joined")
            raise BuildError(f"There are no open lanes to join for {cell.ticket_id} (lanes: {state}). The build goes on in the cell: "
                             f"build.py next {cell.ticket_id}", code="lanes-not-open")
        views = {entry["lane"]: Lane(cell, entry["lane"]) for entry in record["lanes"]}
        handed_back = {entry["lane"] for entry in record["lanes"] if entry.get("status") == "handed-back"}
        unfinished = [name for name, lane in views.items() if lane.state.get("status") != "done" and name not in handed_back]
        if unfinished:
            raise BuildError(f"Not every lane is done ({', '.join(unfinished)} still open), so the lanes cannot be joined yet. The line starts "
                             f"a builder for each again: build.py lanes-open {cell.ticket_id} --holder <holder>. A lane that cannot finish is handed "
                             f"back to the cell instead: build.py hand-back {cell.ticket_id} --lane <L> --reason \"<why>\".", code="lanes-not-done")
        edited = [name for name in git(cell.work, "diff", "--name-only", "HEAD").stdout.splitlines() if name.strip() and not is_byproduct(name)]
        if edited:
            raise BuildError(f"The cell's own checkout has uncommitted changes to tracked files ({', '.join(edited[:5])}), so the ticket's branch "
                             "cannot be moved to the landed work. Nothing was landed, and every lane's work is kept. A person either commits them "
                             f"on {cell.info.get('branch') or 'the cell branch'} in {cell.work} (the join then lands the lanes on top of that commit, "
                             "and sets aside any lane that changed the same file) or " + set_aside_hint(cell.work, cell.ticket_id, "before the join")
                             + f"; then run build.py join {cell.ticket_id} again.", code="cell-dirty")
        # The join starts here: every lane is done or handed back. The moment is recorded first, then said (design 13.2), so a reader can tell
        # a join under way from one that is stuck. join_running names the process doing it; it is removed when the join has its result.
        started_at = now()
        record["join_started_at"] = started_at
        record["join_running"] = {"since": started_at, "pid": os.getpid(), "host": platform.node()}
        save_shared(cell)
        telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.join", "outcome": "pass", "reason_code": "join-started",
                                                                 "overridden_by_reason": False, "lanes": len(views)})
        stray_saved: List[Dict[str, Any]] = []
        try:
            for name, lane in views.items():
                stray = changed_files(lane) if lane.work.is_dir() else []
                if stray:
                    stray_saved.append(set_aside_lane_files(cell, landing, name, lane, stray))
        except BuildError as exc:
            return join_refused(cell, record, {"status": "REFUSED", "refused": {"code": exc.code, "reason": str(exc)}, "left": []})
        own = {t["id"]: t for lane in views.values() for t in lane.state.get("tasks") or []}
        # Every task of the lanes part, in plan order. A handed-back lane's unfinished task lands nothing (no commit): it is built
        # in the cell after the join. Its lane stays in the order, so a lane with nothing finished is still joined as a lane.
        tasks = [{"task": task["id"], "lane": lane_of(cell, task["id"]),
                  "lane_commit": (own.get(task["id"]) or {}).get("commit") if (own.get(task["id"]) or {}).get("status") == "done" else None}
                 for task in cell.state["tasks"] if lane_of(cell, task["id"])]
        join_repo = cell.root / "lanes" / "join" / "repo"
        join_repo.parent.mkdir(parents=True, exist_ok=True)

        def run_suite(folder: Path) -> Dict[str, Any]:
            return run_tests(Checkout(cell, Path(folder)))

        result = landing.join_lanes(
            cell.project, cell.work, join_repo, f"mach-lane/{cell.ticket_id}/join", str(record.get("fork") or ""), tasks,
            {name: list(lane.state.get("test_files") or []) for name, lane in views.items()}, run_suite,
            lane_folders={name: lane.work for name, lane in views.items()},
            lane_branches={entry["lane"]: entry.get("branch") or f"mach-lane/{cell.ticket_id}/{entry['lane']}" for entry in record["lanes"]},
            move_on_red=True, keep_ref=lambda name: set_aside_ref(cell, name))
        if result.get("status") == "REFUSED":
            return join_refused(cell, record, result, stray_saved)
        return join_record(cell, record, views, result, started_at, stray_saved)


def set_aside_lane_files(cell: Cell, landing: Any, name: str, lane: "Lane", stray: List[str]) -> Dict[str, Any]:
    """A lane's uncommitted files that no task holds, saved by the station itself at the join and kept under a ref, never landed: the join lands
    only what the lane's tasks committed. Recorded as a deviation with the ref and the exact command that brings a file back."""
    prefix = f"refs/mach/lane-files/{cell.ticket_id}/{name}"
    taken = git(lane.work, "for-each-ref", "--format=%(refname)", prefix + "/").stdout.split()
    ref = f"{prefix}/{len(taken) + 1}"
    try:
        saved = landing.set_aside_files(lane.work, stray, ref, f"Uncommitted files in lane {name}, set aside at the join [{cell.ticket_id}]")
    except landing.LandingError as exc:
        raise BuildError(f"Lane {name} has uncommitted files no task holds ({', '.join(stray[:5])}), and the station could not save them, so the "
                         f"join did not go on and nothing was changed: {exc}. Run build.py join {cell.ticket_id} again; if it fails the same way, "
                         "the Git error is in the lane's checkout at " + str(lane.work) + ".", code="lane-files-not-saved")
    where = f'git -C "{cell.work}"'
    item = {"lane": name, "ref": saved["ref"], "commit": saved["commit"], "paths": saved["paths"],
            "bring_back": f"{where} checkout {saved['ref']} -- <path>", "see": f"{where} show --stat {saved['ref']}"}
    cell.deviation(None, "lane-files-set-aside",
                   f"Lane {name} had uncommitted files that no task held ({', '.join(saved['paths'][:10])}"
                   + (f" and {len(saved['paths']) - 10} more" if len(saved["paths"]) > 10 else "") + "). The station saved them under "
                   f"{saved['ref']} (commit {saved['commit'][:10]}) and the join went on without them: they are not part of what landed. "
                   f"To bring one back in the cell's checkout: {item['bring_back']}.")
    cell.state["deviations"][-1].update({**item, "by": "build station"})
    return item


def join_refused(cell: Cell, record: Dict[str, Any], result: Dict[str, Any], stray_saved: Optional[List[Dict[str, Any]]] = None) -> int:
    refused = result.get("refused") or {}
    code = str(refused.get("code") or "landing-failed")
    record.setdefault("join_refusals", []).append({"at": now(), "reason": code, "why": refused.get("reason"), "commit": refused.get("commit"),
                                                   "left": result.get("left") or []})
    record.pop("join_running", None)
    save_shared(cell)
    telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.join", "outcome": "refuse", "reason_code": code, "overridden_by_reason": False})
    print(json.dumps({"status": "REFUSED", "landed": 0, "set_aside": [], "suite": result.get("suite"), "refused": refused, "left": result.get("left") or [],
                      "files_set_aside": stray_saved or [],
                      "next": f"Nothing was landed: the ticket's branch is where it was, and every lane and its work is kept. Put right what the "
                              f"reason names, then run build.py join {cell.ticket_id} again; the join starts over from the fork point."}, indent=2))
    return 1


def join_record(cell: Cell, record: Dict[str, Any], views: Dict[str, "Lane"], result: Dict[str, Any], started_at: str,
                stray_saved: Optional[List[Dict[str, Any]]] = None) -> int:
    """Design 8.1 step 5, from what landing returned: the tasks take their landed commits (keeping the lane commit), lane
    deviations are copied in with their lane, plan.md is ticked, the lanes are joined. A set-aside lane's tasks are pending
    again, to be built in the cell one at a time; on a joined suite that fails, J-T01 is added (design 8.2, 8.3)."""
    aside = {item["lane"]: item for item in result.get("set_aside") or []}
    landed = {item["task"]: item for item in result.get("landed") or []}
    own = {t["id"]: t for lane in views.values() for t in lane.state.get("tasks") or []}
    test_files = set(cell.state.get("test_files") or [])
    handed: Dict[str, List[str]] = {}
    for task in cell.state["tasks"]:
        name = lane_of(cell, task["id"])
        if name is None:
            continue
        if name in aside:
            task.update({"lane": name, "set_aside": True})
            continue
        built = own.get(task["id"]) or {}
        if lane_record_of(record, name).get("status") == "handed-back" and built.get("status") != "done":
            # Handed back unfinished: built in the cell after the join, one at a time, under the cell's gates.
            task.update({"lane": name, "handed_back": True, "status": "pending"})
            handed.setdefault(name, []).append(task["id"])
            continue
        task.update({key: value for key, value in built.items() if key != "commit"})
        task["lane"] = name
        if built.get("commit"):
            task["lane_commit"] = built["commit"]
            task["commit"] = (landed.get(task["id"]) or {}).get("commit")
        else:
            task["commit"] = None
        cell.tick(task["id"])
    for entry in record["lanes"]:
        name = entry["lane"]
        state = views[name].state
        if name not in aside:
            for item in state.get("deviations") or []:
                cell.state.setdefault("deviations", []).append({**item, "lane": name})
            test_files |= set(state.get("test_files") or [])
        runs = [t.get("test_run", {}).get("seconds") for t in state.get("tasks") or [] if isinstance(t.get("test_run"), dict)]
        status = "set-aside" if name in aside else "handed-back" if entry.get("status") == "handed-back" else "joined"
        entry.update({"status": status, "handed_at": state.get("handed_at"), "opened_at": state.get("opened_at"),
                      "started_at": state.get("started_at"), "finished_at": state.get("finished_at"), "worktree_seconds": state.get("worktree_seconds"),
                      "test_seconds": round(sum(r for r in runs if isinstance(r, (int, float))), 1),
                      "files_changed": sorted({f for t in state.get("tasks") or [] for f in t.get("files_changed") or []}),
                      "commits": [{"task": t["id"], "lane_commit": t.get("commit"), "files": t.get("files_changed") or []} for t in state.get("tasks") or []]})
    for name, item in aside.items():
        because = item.get("because") or []
        words = "; ".join(dict.fromkeys(aside_words(b) for b in because)) or "it could not land as it was"
        commits = list(item.get("lane_commits") or [])
        if item.get("kept_as"):
            kept = (f"Nothing is lost: its work is kept under {item['kept_as']} (at {str(item.get('tip'))[:10]}); "
                    + bring_back_words(cell, item["kept_as"], commits or [item.get("tip")]) + ".")
            item["bring_back"] = f'git -C "{cell.work}" cherry-pick <commit>'
        elif item.get("tip"):
            kept = f"Nothing is lost: its branch {lane_record_of(record, name).get('branch')} is kept as it is, at {str(item.get('tip'))[:10]}."
        else:
            kept = "It had no commits to keep."
        cell.deviation(None, "lane-set-aside", f"Lane {name} was set aside: {words}. Its tasks ({', '.join(item.get('tasks') or [])}) are built "
                       f"again in the cell, one at a time, on top of what landed, where every gate sees it. {kept}")
        cell.state["deviations"][-1].update({"lane": name, "because": because, "kept_as": item.get("kept_as"), "tip": item.get("tip"),
                                             "lane_commits": commits, "by": "build station"})
    moved = result.get("moved_branch") if isinstance(result.get("moved_branch"), dict) else None
    if moved:
        hit = sorted(name for name, item in aside.items() if any(b.get("why") == "branch-moved" for b in item.get("because") or []))
        shas = list(moved.get("commits") or [])
        cell.deviation(None, "lanes-landed-on-moved-branch",
                       f"The ticket's branch moved while the lanes were open: {len(shas)} commit(s) were made on it ({', '.join(s[:10] for s in shas[:10])}"
                       + (f" and {len(shas) - 10} more" if len(shas) > 10 else "") + "), changing "
                       + (", ".join(list(moved.get("files") or [])[:10]) or "no file") + ". They are kept as they are, and the lanes landed on top "
                       "of them, on " + str(moved.get("to"))[:10] + "; the whole suite ran on the result."
                       + (f" Lane(s) {', '.join(hit)} changed a file those commits changed, so they were set aside and their tasks are built "
                          "again in the cell, on top of those commits." if hit else " No lane changed a file those commits changed."))
        cell.state["deviations"][-1].update({"commits": shas, "files": list(moved.get("files") or []), "from": moved.get("from"),
                                             "to": moved.get("to"), "lanes_set_aside": hit, "by": "build station"})
    for name, ids in handed.items():
        entry = lane_record_of(record, name)
        entry.setdefault("handed_back", {})["built_in_cell"] = ids
        cell.deviation(None, "lane-handed-back-joined", f"Lane {name} was handed back: its finished tasks landed at the join, and "
                       f"{', '.join(ids)} are built in the cell, one at a time, after it.")
        cell.state["deviations"][-1].update({"lane": name, "tasks": ids, "by": "build station"})
    cell.state["test_files"] = sorted(test_files)
    suite = dict(result.get("suite") or {})
    interaction = result.get("interaction")
    if result.get("status") == "JOINED":
        cell.state["suite"] = "green"
    else:
        cell.state["suite"] = "red"
        named = interaction.get("lanes_named") or [] if isinstance(interaction, dict) else []
        involved = [item.get("lane") for item in named] or list((interaction or {}).get("lanes") or [])
        files = list((interaction or {}).get("fix_files") or [])
        add_join_task(cell, record, files)
        failing = list((interaction or {}).get("failing") or [])
        waiting = [task_id for ids in handed.values() for task_id in ids]
        landed_lanes = [entry["lane"] for entry in record["lanes"] if entry["lane"] not in aside]
        alone = lanes_passed_alone(views, record, landed_lanes)
        opening = ("Every landed lane's own suite was passing at its end, but the whole suite fails on the joined result" if alone and not waiting
                   else "The lanes' finished work landed, but the whole suite fails on the joined result")
        cell.deviation(JOIN_TASK, "lanes-interaction", opening
                       + (f": {', '.join(failing[:10])}" if failing else "") + f". Lanes involved: {', '.join(involved) or 'not named by the output'}. "
                       + (f"Tasks handed back to the cell ({', '.join(waiting)}) come before {JOIN_TASK} and may be what is missing; if {JOIN_TASK} has "
                          f"nothing left to change when it is reached, complete it with build.py green {cell.ticket_id} {JOIN_TASK} --already-done "
                          "\"<which task made the suite pass>\". " if waiting else "")
                       + f"{JOIN_TASK} makes them pass together; every test is committed and frozen.")
        cell.state["deviations"][-1].update({"failing": failing, "lanes": involved, "lanes_named": named, "lanes_passed_alone": alone,
                                             "output_tail": str((interaction or {}).get("output_tail") or "")[-800:], "by": "build station"})
    record["join"] = {"state": "joined", "started_at": started_at, "finished_at": now(), "status": result.get("status"), "fork": result.get("fork"),
                      "base": result.get("base"), "moved_branch": result.get("moved_branch"),
                      "tip": result.get("tip"), "branch_moved": result.get("branch_moved"), "resumed": result.get("resumed"),
                      "order": [item["task"] for item in result.get("landed") or []], "landed": result.get("landed") or [],
                      "tasks_without_commit": [t for t in result.get("tasks_without_commit") or [] if t not in {i for ids in handed.values() for i in ids}],
                      "set_aside": result.get("set_aside") or [], "handed_back": handed,
                      "suite": suite, "interaction": interaction, "removed": result.get("removed") or [], "left": result.get("left") or [],
                      "seconds": result.get("seconds") or {},
                      "landing_seconds": (result.get("seconds") or {}).get("land")}
    if stray_saved:
        record["join"]["files_set_aside"] = [{key: item[key] for key in ("lane", "ref", "commit", "paths")} for item in stray_saved]
    record["state"] = "joined"
    record.pop("join_running", None)
    save_shared(cell)
    for name, item in aside.items():
        telemetry(cell.root, "gate.evaluated", "build", lambda name=name, item=item: {
            "gate": "build.join", "outcome": "refuse", "reason_code": "lane-set-aside", "overridden_by_reason": False, "lane": name,
            "why": ((item.get("because") or [{}])[0]).get("why")})
    if moved:
        telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.join", "outcome": "pass", "reason_code": "landed-on-moved-branch",
                                                                 "overridden_by_reason": False, "commits": len(moved.get("commits") or [])})
    passed = result.get("status") == "JOINED"
    telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.join", "outcome": "pass" if passed else "refuse",
                                                             "reason_code": None if passed else "lanes-interaction", "overridden_by_reason": False,
                                                             "landed": len(result.get("landed") or []), "set_aside": len(aside)})
    following = cell.next_task()
    print(json.dumps({
        "status": "JOINED" if passed else "INTERACTION", "landed": len(result.get("landed") or []),
        "set_aside": [{"lane": name, "tasks": item.get("tasks"), "because": item.get("because"),
                       **({"kept_as": item["kept_as"], "lane_commits": item.get("lane_commits") or [], "tip": item.get("tip"),
                           "bring_back": item.get("bring_back")} if item.get("kept_as") else {})} for name, item in aside.items()],
        **({"moved_branch": moved} if moved else {}),
        "handed_back": [{"lane": name, "tasks": ids} for name, ids in handed.items()],
        "suite": {key: suite.get(key) for key in ("passed", "exit_code", "seconds", "command", "ran_on")},
        "interaction": ({"failing": (interaction or {}).get("failing"), "lanes_named": (interaction or {}).get("lanes_named"), "task": JOIN_TASK,
                         "files": (interaction or {}).get("fix_files"), "output_tail": str((interaction or {}).get("output_tail") or "")[-1200:]}
                        if not passed else None),
        "left": result.get("left") or [],
        "files_set_aside": stray_saved or [],
        "next": (f"The ticket's build goes on in the cell: build.py next {cell.ticket_id}" if following else f"build.py finish {cell.ticket_id}"),
    }, indent=2))
    return 0


def aside_words(because: Dict[str, Any]) -> str:
    """Why a lane was set aside, in words, from one of landing's reasons."""
    why, other, name = because.get("why"), because.get("other"), because.get("file")
    if why == "same-file":
        return f"it and lane {other} both changed {name}, so the plan's claim that they are independent was false"
    if why == "frozen-test":
        return f"it and lane {other} both touched {name}, a test file one of them holds, so the plan's claim that they are independent was false"
    if why == "case-clash":
        return f"its file {name} and a file of lane {other} differ only by letter case, which one checkout cannot hold"
    if why == "file-folder":
        return f"{name} is a file in one of it and lane {other} and a folder in the other, which one checkout cannot hold"
    if why == "branch-moved":
        commits = because.get("commits") or []
        return (f"a commit made on the ticket's branch while the lanes were open ({', '.join(str(c)[:10] for c in commits[:5])}) also changed "
                f"{name}, and that commit is kept")
    if why == "did-not-apply":
        return f"its commit {str(because.get('commit'))[:10]} did not apply on the landed work as exactly itself"
    if why == "unrecorded-commits":
        return f"its branch held commits no task recorded ({', '.join(str(c)[:10] for c in (because.get('commits') or [])[:5])})"
    if why == "lane-history":
        return f"its recorded commits were not one chain from the fork point ({because.get('detail')})"
    return str(because.get("detail") or why or "it could not land as it was")


def lanes_passed_alone(views: Dict[str, "Lane"], record: Dict[str, Any], landed_lanes: Sequence[str]) -> Optional[bool]:
    """Whether each landed lane's own suite was recorded passing at its end (lane.json final_suite, or the suite when it was handed
    back): True when every one was, False when one was not, None when that was not recorded for every lane."""
    states = []
    for name in landed_lanes:
        entry = lane_record_of(record, name)
        own = views[name].state if name in views else {}
        state = (entry.get("handed_back") or {}).get("suite_then") if entry.get("status") == "handed-back" else own.get("final_suite")
        states.append(state)
    if any(state is None for state in states):
        return None
    return all(state == "green" for state in states)


def add_join_task(cell: Cell, record: Dict[str, Any], files: List[str]) -> None:
    """J-T01 [impl], after the last task of the lanes part and before the tasks after the lanes (design 8.3)."""
    if any(task["id"] == JOIN_TASK for task in cell.state["tasks"]):
        return
    lane_ids = {task_id for entry in record["lanes"] for task_id in entry.get("tasks") or []}
    last = max((index for index, task in enumerate(cell.state["tasks"]) if task["id"] in lane_ids), default=len(cell.state["tasks"]) - 1)
    text = "Make the lanes pass together" + (" — " + ", ".join(f"`{name}`" for name in files) if files else "")
    cell.state["tasks"].insert(last + 1, {"id": JOIN_TASK, "kind": "impl", "text": text, "ids": [], "files": files, "status": "pending", "added_by": "join"})
    plan = cell.root / "plan.md"
    if plan.is_file():
        lines = plan.read_text(encoding="utf-8").split("\n")
        previous = cell.state["tasks"][last]["id"]
        at = next((index for index, line in enumerate(lines) if TASK_RE.match(line) and TASK_RE.match(line).group(2) == previous), None)
        line = f"- [ ] {JOIN_TASK} [impl] {text}"
        if at is None:
            lines.append(line)
        else:
            lines.insert(at + 1, line)
        plan.write_text("\n".join(lines), encoding="utf-8")


def joined_suite_run(cell: Cell) -> Optional[Dict[str, Any]]:
    """The join's whole-suite run, when it ran on exactly the code that is the tip now and passed."""
    record = joined_lanes(cell)
    suite = ((record or {}).get("join") or {}).get("suite") or {}
    if not suite.get("passed") or suite.get("command") != cell.state.get("test_cmd") or cell.state.get("suite") != "green":
        return None
    if suite.get("ran_on") != git(cell.work, "rev-parse", "HEAD").stdout.strip():
        return None
    return {"command": suite["command"], "exit_code": 0, "passed": True, "seconds": 0.0, "output_tail": "", "output": "",
            "scope": "whole suite", "reused_from": "join", "reused_run_seconds": suite.get("seconds"),
            "note": "Not run again: the whole suite passed on exactly this code when the lanes were joined."}


def lanes_timing(record: Dict[str, Any]) -> Dict[str, Any]:
    """design 13.1: the lanes part's wall time against the sum of its lanes' times, and the fixed costs, each measured."""
    per_lane = []
    for entry in record["lanes"]:
        start = entry.get("started_at") or entry.get("handed_at")
        per_lane.append({"lane": entry["lane"], "status": entry.get("status"), "started_at": start, "finished_at": entry.get("finished_at"),
                         "elapsed_seconds": seconds_between(start, entry.get("finished_at")) if start and entry.get("finished_at") else None,
                         "test_seconds": entry.get("test_seconds"), "worktree_seconds": entry.get("worktree_seconds")})
    ends = [item["finished_at"] for item in per_lane if item["finished_at"]]
    wall = seconds_between(record.get("opened_at"), max(ends)) if record.get("opened_at") and ends else None
    summed = round(sum(item["elapsed_seconds"] for item in per_lane if isinstance(item["elapsed_seconds"], (int, float))), 1)
    join = record.get("join") or {}
    return {"wall_seconds": wall, "summed_lane_seconds": summed, "ratio": round(summed / wall, 2) if wall else None,
            "worktree_seconds": round(sum(item["worktree_seconds"] or 0 for item in per_lane), 1),
            "landing_seconds": join.get("landing_seconds"), "joined_suite_seconds": (join.get("suite") or {}).get("seconds"),
            "lanes": per_lane,
            "note": "Wall time is from opening the lanes to the last lane done; the summed time adds each lane's own time, first to last "
                    "station call. The summed time is not what a build one task at a time would have taken, which was not run (it would "
                    "have read the ground once and run its tests alone). The measured facts are this ratio for the lanes part and the "
                    "build's elapsed time; nothing is claimed beyond them."}


def report_lanes(cell: Cell, report: Dict[str, Any]) -> None:
    """design 13.1: only when lanes were planned. Each task built in a lane gains its lane, lane commit and the commit its
    tests ran on; the report gains the lane plan, each lane, and the join."""
    record = lane_record(cell) or {}
    if record.get("state") != "joined":
        report["lanes"] = {"state": record.get("state"), "setting": record.get("setting"), "why": record.get("why"),
                           "note": "Lanes were planned but did not run: the plan was built one task at a time in the cell."}
        return
    by_id = {t["id"]: t for t in cell.state["tasks"]}
    for item in report["tasks"]:
        task = by_id.get(item["id"]) or {}
        if task.get("lane"):
            item.update({"lane": task.get("lane"), "lane_commit": task.get("lane_commit"), "ran_on": task.get("ran_on"),
                         "set_aside": bool(task.get("set_aside")), "handed_back": bool(task.get("handed_back"))})
    join = dict(record.get("join") or {})
    report["lanes"] = {
        "state": "joined", "setting": record.get("setting"), "granted": [batch.get("granted") for batch in record.get("batches") or []],
        "fork": record.get("fork"), "opened_at": record.get("opened_at"), "batches": record.get("batches") or [],
        "plan": {"before": record["plan"].get("before"), "after": record["plan"].get("after"), "joined_because": record["plan"].get("joined_because"),
                 "lanes": [{"lane": e["lane"], "tasks": e["tasks"], "files": e["files"]} for e in record["lanes"]]},
        "lanes": [{key: entry.get(key) for key in ("lane", "branch", "status", "tasks", "handed_at", "started_at", "finished_at", "test_seconds",
                                                   "worktree_seconds", "files_changed", "commits", "handed_back") if key in entry or key != "handed_back"}
                  for entry in record["lanes"]],
        "join": join,
        "reds": [{"task": t["id"], "lane": t.get("lane"), "seen_failing_on": t.get("ran_on"), "first_run": t.get("first_run")}
                 for t in cell.state["tasks"] if t.get("kind") == "test" and t.get("lane") and not t.get("set_aside") and not t.get("handed_back")],
        "note": "Each lane's tests ran in its own worktree: the fork point plus that lane's earlier tasks. Each red was seen on the lane commit "
                "named. The joined tip was run as a whole at the join; the commits between the fork point and the tip, landed in plan order "
                "across lanes, were never run as such.",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MACH build station gates.")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("start", help="check the gates, read the plan, record the baseline")
    p.add_argument("ticket_id")
    p.add_argument("--test-cmd", help="the test command, if the project has none configured yet")
    p.add_argument("--lint-cmd")
    p.add_argument("--no-baseline", metavar="WHY", help="start without a passing baseline, for a project with no test suite yet; recorded for review")
    p.set_defaults(func=cmd_start)

    for name, func, text in (("red", cmd_red, "complete a [test] task: the suite must fail"), ("green", cmd_green, "complete an [impl] task: the suite must pass"),
                             ("done", cmd_done, "complete a [contract], [refactor] or [docs] task")):
        p = sub.add_parser(name, help=text)
        p.add_argument("ticket_id")
        p.add_argument("task")
        p.add_argument("--allow-extra", metavar="WHY", help="accept changes to files the plan did not give this task; recorded for review")
        p.add_argument("--amend-test", metavar="WHY", help="accept a change to an already committed test; recorded for review")
        p.add_argument("--not-a-secret", metavar="WHY", help="accept what the secrets gate found because it is not a secret (never for a real credential); "
                       "recorded for review with the places, never the value")
        if name == "red":
            p.add_argument("--covered", metavar="WHY", help="accept a test that passes on its first run because earlier work satisfies it; recorded for review")
            p.add_argument("--unrelated-failure", metavar="WHY", help="accept a red whose output does not name the new test; recorded for review")
            p.add_argument("--written-early", metavar="WHY", help="complete a test task whose test an earlier task already committed; recorded for review")
        if name == "green":
            p.add_argument("--already-done", metavar="WHY", help="complete an [impl] task an earlier task already implemented: no change, committed tests "
                           "name its IDs, suite green; recorded for review")
        p.add_argument("--holder", metavar="H", help="in a lane: the holder the lane was handed to (the lane prompt names it); refused once another holder has taken the lane over")
        p.set_defaults(func=func)

    p = sub.add_parser("add-task", help="add a task during a revision round")
    p.add_argument("ticket_id")
    p.add_argument("--kind", choices=KINDS, required=True)
    p.add_argument("--text", required=True)
    p.add_argument("--file", action="append", default=[], help="a file the task may change (repeatable)")
    p.set_defaults(func=cmd_add_task)

    p = sub.add_parser("revise", help="start a revision round after a rejected review")
    p.add_argument("ticket_id")
    p.add_argument("--findings", help="file holding the reviewers' findings; copied into the cell")
    p.set_defaults(func=cmd_revise)

    for name, func, text in (("next", cmd_next, "show the next task and the spec text it must satisfy"), ("finish", cmd_finish, "final gate; writes build-report.json"),
                             ("status", cmd_status, "show progress"), ("lanes", cmd_lanes, "the lane plan and each lane's status; reads only"),
                             ("join", cmd_join, "land every lane's commits on the ticket's branch and run the whole suite on the result")):
        p = sub.add_parser(name, help=text)
        p.add_argument("ticket_id")
        if name == "next":
            p.add_argument("--lane", metavar="L", help="the next task of this lane, in the lane's own worktree")
            p.add_argument("--holder", metavar="H", help="in a lane: the holder the lane was handed to (the lane prompt names it); refused once another holder has taken the lane over")
        p.set_defaults(func=func)

    p = sub.add_parser("set-commands", help="give a build in progress its test or lint command, or change it; recorded for review, nothing undone")
    p.add_argument("ticket_id")
    p.add_argument("--test-cmd", help="the test command the build runs from now on (free text)")
    p.add_argument("--lint-cmd", help="the lint command the finish runs from now on (free text)")
    p.add_argument("--reason", required=True, metavar="WHY", help="why: where the command comes from, or why the one recorded is wrong; recorded for review")
    p.add_argument("--by", help="the person who gave the command, when a person did (recorded with it)")
    p.add_argument("--via", choices=sorted(SET_BY_VIA), default="terminal", help="with --by: where the person decided, in conversation (default) or in the Factory Floor")
    p.set_defaults(func=cmd_set_commands)

    p = sub.add_parser("hand-back", help="a lane that cannot finish hands its remaining tasks back to the cell, built one at a time after the join")
    p.add_argument("ticket_id")
    p.add_argument("--lane", required=True, metavar="L")
    p.add_argument("--reason", required=True, metavar="WHY", help="why the lane cannot finish; recorded for review")
    p.add_argument("--holder", metavar="H", help="in a lane: the holder the lane was handed to (the lane prompt names it); refused once another holder has taken the lane over")
    p.set_defaults(func=cmd_hand_back)

    p = sub.add_parser("lanes-open", help="make the lanes' worktrees and say which lanes to start now")
    p.add_argument("ticket_id")
    p.add_argument("--holder", required=True, help="the driver's holder token (the ticket's claim); a lane is handed only to the holder that opened it")
    p.add_argument("--grant", type=int, help="at most this many lanes at once (the line's count of free places)")
    p.add_argument("--take-over", action="store_true", help="hand over lanes another holder still holds (a person's decision)")
    p.add_argument("--carry-on-from", action="append", metavar="H", help="a holder whose run is known to have ended (an earlier supervised "
                   "execution of this ticket): its lanes are handed to --holder at once, each from where it stopped (repeatable)")
    p.set_defaults(func=cmd_lanes_open)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    for name in ("allow_extra", "amend_test", "covered", "no_baseline", "written_early", "unrelated_failure", "already_done", "not_a_secret"):
        if not hasattr(args, name):
            setattr(args, name, None)
    project = None
    try:
        project = args.project.resolve() if args.project else find_project(Path.cwd())
        return args.func(Cell(project, args.ticket_id), args)
    except BuildError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        if project is not None and args.command not in ("next", "status", "lanes"):
            telemetry(project / ".factory" / "worktrees" / args.ticket_id, "gate.evaluated", "build", lambda: {
                "gate": f"build.{args.command}", "outcome": "refuse", "reason_code": exc.code, "overridden_by_reason": False, "task": getattr(args, "task", None)})
        return 1


if __name__ == "__main__":
    import contextlib as _c, os as _o, runpy as _r  # MACH records an internal error for /mach report (skills/intent/scripts/faults.py)
    with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if _o.path.isfile(p)))["install"](__file__)
    sys.exit(main())
