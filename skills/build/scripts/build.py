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
    build.py status <ticket>

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
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
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
# Lifecycle log: the gate each recorded override passes.
OVERRIDDEN_GATE = {"test-amended": "frozen-tests", "files-outside-plan": "scope", "test-passed-first-run": "red-before-green",
                   "red-not-attributed": "red-attribution", "test-written-early": "red-before-green", "no-baseline": "baseline",
                   "impl-already-done": "changed-no-files", "not-a-secret": "secrets"}
UI_FILE_RE = re.compile(r"\.(tsx|jsx|vue|svelte|html|astro)$")
INLINE_STYLE_RE = re.compile(r"style\s*=\s*(\"|'|\{\{)")
HEX_COLOR_RE = re.compile(r"(?<![\w&])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b")
EXCLUDE_LINE = ".factory/worktrees/"


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

    def __init__(self, message: str = "", code: str = "refused") -> None:
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
    """Read the audit station's report. Bronze blocks everything except repository hardening."""
    if cell.section("build").get("require_audit") is False:
        return {"tier": None, "human_review_required": False, "note": "The audit gate is switched off in .factory/config.json."}
    hardening = HARDENING_LABEL in ticket_labels(cell)
    report = load_json(cell.project / ".factory" / "audit-report.json")
    if not isinstance(report, dict):
        raise BuildError("There is no audit report. Run the audit skill on the main checkout first; building is gated on it.", code="audit-missing")
    head = git(cell.project, "rev-parse", "HEAD").stdout.strip() or None
    limit = cell.section("audit").get("max_age_days", 7)
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(report["timestamp"])).total_seconds() / 86400
    except (KeyError, ValueError, TypeError):
        age = float("inf")
    if report.get("head") != head or age > limit:
        raise BuildError("The audit report is stale (a different commit, or too old). Run the audit skill again, then start the build.", code="audit-stale")
    tier = report.get("readiness_tier")
    if tier not in ("Gold", "Silver"):
        if not hardening:
            raise BuildError(
                "The repository's readiness tier is Bronze, so autonomous building is blocked: " + " ".join(report.get("blockers") or [])
                + f" Only tickets labelled '{HARDENING_LABEL}' may be built until it is hardened.", code="audit-bronze"
            )
        return {"tier": tier, "human_review_required": True, "note": "Bronze repository: allowed because this is a hardening ticket. A person must review it."}
    return {"tier": tier, "human_review_required": tier == "Silver", "note": "Silver: a person must review before merge." if tier == "Silver" else "Gold."}


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
    env = dict(os.environ)
    # The project's own commands never leave Python byte code in the checkout: a cached file can outlive the source it was
    # made from (rewritten at the same size within the same second), and a later run would then test the old code. A command
    # that needs byte code written says so itself, with a leading PYTHONDONTWRITEBYTECODE= of its own.
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):  # leading VAR=value, as in a shell
        key, value = argv.pop(0).split("=", 1)
        env[key] = value
    if not argv or (shutil.which(argv[0]) is None and not (cell.work / argv[0]).is_file()):
        raise BuildError(f"'{argv[0] if argv else command}' is not installed or not on PATH, so '{command}' cannot run in the cell.", code="command-missing")
    started = time.monotonic()
    try:
        done = subprocess.run(argv, cwd=str(cell.work), capture_output=True, text=True, errors="replace", timeout=timeout, stdin=subprocess.DEVNULL, env=env)
        code, out = done.returncode, done.stdout + ("\n" + done.stderr if done.stderr else "")
    except subprocess.TimeoutExpired:
        code, out = 124, f"Still running after {timeout} seconds; stopped."
    return {"command": command, "exit_code": code, "passed": code == 0, "seconds": round(time.monotonic() - started, 1), "output_tail": out.strip()[-3000:], "output": out}


def run_tests(cell: Cell) -> Dict[str, Any]:
    command = cell.state.get("test_cmd")
    if not command:
        raise BuildError("No test command is known. Start again with --test-cmd \"<command>\", using the command the plan or the project documents.", code="no-test-command")
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
    frozen = sorted(set(files) & set(cell.state.get("test_files", []))) if task["kind"] != "test" else []
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


def complete(cell: Cell, task: Dict[str, Any], files: Sequence[str], result: Optional[Dict[str, Any]], note: str) -> None:
    summary = re.sub(r"\s*\((?:(?:FR|INV|AC)-\d+[,\s]*)+\)\s*$", "", task["text"].replace("`", ""))  # drop the trailing ID list
    summary = " ".join(summary.split())[:64].rstrip(" —-,;:")
    scope = cell.info.get("slice_id") or cell.ticket_id
    sha = commit(cell, files, f"{COMMIT_PREFIX[task['kind']]}({scope}): {task['id']} {summary} [{cell.ticket_id}]")
    task.update({"status": "done", "commit": sha, "files_changed": list(files), "note": note, "at": now(), "loop": cell.state.get("loop", 0)})
    if result:
        task["test_run"] = {"exit_code": result["exit_code"], "seconds": result["seconds"], "scope": result.get("scope", "whole suite"),
                            "command": result.get("command") if result.get("scope", "whole suite") == "whole suite" else None}
    tick_plan(cell, task["id"])
    cell.save()
    cell.report_overrides(task["id"])
    telemetry(cell.root, "build.task_completed", "build", lambda: {"task": task["id"], "kind": task["kind"], "step": STEP_FOR[task["kind"]],
                                                                   "first_run": task.get("first_run"), "suite": cell.state.get("suite"), "commit": lifecycle.short(sha)})
    following = cell.next_task()
    print(json.dumps({
        "status": "DONE", "task": task["id"], "commit": sha[:10], "note": note, "suite": cell.state["suite"],
        "next": f"{following['id']} [{following['kind']}]" if following else "All tasks are done. Run: build.py finish " + cell.ticket_id,
    }, indent=2))


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
        raise BuildError(f"The cell has uncommitted changes ({', '.join(dirty[:5])}), so it cannot be brought up to date with {main}. "
                         "Commit or remove them first.", code="uncommitted-changes")
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


def cmd_start(cell: Cell, args: argparse.Namespace) -> int:
    stage = cell.info.get("stage")
    if cell.state.get("tasks") and stage in ("building", "built"):
        raise BuildError(f"Building already started for {cell.ticket_id} (stage: {stage}). Use 'next' to continue, or 'revise' after a rejected review.", code="already-started")
    if stage != "planned":
        raise BuildError(f"The cell's stage is '{stage}', not 'planned'. The intent skill must finish the spec, contracts and plan first.", code="wrong-stage")
    gate = audit_gate(cell)
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
        raise BuildError(f"The cell has uncommitted changes ({', '.join(dirty[:5])}). Commit or remove them before building starts.", code="uncommitted-changes")
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
        if not baseline["passed"] and merges:
            last = merges[-1]
            raise BuildError(
                f"The tests fail in the cell now that {last.get('main')} ({str(last.get('main_commit'))[:10]}) is merged into the branch, so building cannot start. "
                "Nothing has been built for this ticket yet, so its own work is not the cause. "
                + ("The audit found the main checkout's tests passing at this commit, so the failure comes from what the branch held from grooming "
                   f"(its spec and contracts) together with the newer code on {last.get('main')}. " if gate.get("tier") in ("Gold", "Silver") else
                   f"Either {last.get('main')}'s own tests fail at this commit (run the audit), or what the branch held from grooming (its spec and "
                   f"contracts) does not fit the newer code on {last.get('main')}. ")
                + "Look at the output below; plan the ticket again or abandon it if the contracts no longer fit.\n" + baseline["output_tail"][-800:],
                code="baseline-red-after-main")
        if not baseline["passed"]:
            behind = cell.info.get("isolation") == "worktree" and not is_ancestor(cell, git(cell.project, "rev-parse", "HEAD").stdout.strip())
            where = ("The cell's branch was not brought up to date with the main checkout (build.update_from_main is off), so this is the branch's own state."
                     if behind else "The cell is up to date with the main checkout, so the main checkout's tests fail too: run the audit, and harden the repository first.")
            raise BuildError("The tests already fail in the cell before any change, so building cannot start. " + where + "\n" + baseline["output_tail"][-800:],
                             code="baseline-red")
        cell.state["suite"] = "green"
        cell.state["test_file_check"] = calibrate_test_file(cell)
    cell.state["baseline_run"] = {k: v for k, v in baseline.items() if k not in ("output_tail", "output")}
    cell.info.update({"stage": "building", "human_review_required": bool(gate["human_review_required"]) or cell.info.get("risk") == "High"})
    cell.save()
    cell.save_info()
    telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.start", "outcome": "pass", "reason_code": None, "overridden_by_reason": False,
                                                             "audit_tier": gate.get("tier")})
    cell.report_overrides(None)
    telemetry(cell.root, "station.entered", "build", lambda: {"stage": "building", "tasks": len(tasks), "synced_with_main": bool(synced)})
    print(json.dumps({
        "status": "STARTED", "ticket_id": cell.ticket_id, "workdir": str(cell.work), "branch": cell.info.get("branch"),
        "tasks": len(tasks), "test_cmd": cell.state["test_cmd"], "lint_cmd": cell.state["lint_cmd"], "audit": gate,
        "new_tests_run_alone": cell.state.get("test_file_check") or {"trusted": False, "why": "no passing baseline run to check a single-file run against"},
        "adrs": adrs_in_force(cell),
        "synced_with_main": merge_note(synced),
        "next": f"{tasks[0]['id']} [{tasks[0]['kind']}]",
    }, indent=2))
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
    task = cell.next_task()
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
        tick_plan(cell, task["id"])
        cell.save()
        cell.report_overrides(task["id"])
        telemetry(cell.root, "build.task_completed", "build", lambda: {"task": task["id"], "kind": task["kind"], "step": "red", "first_run": "not-run",
                                                                       "suite": cell.state.get("suite"), "commit": None})
        following = cell.next_task()
        print(json.dumps({"status": "DONE", "task": task["id"], "commit": None, "note": task["note"], "suite": cell.state["suite"],
                          "next": f"{following['id']} [{following['kind']}]" if following else "All tasks are done. Run: build.py finish " + cell.ticket_id}, indent=2))
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
                    "command or layout is wrong, that is a plan defect to report. If the failure really is your test's, rerun with "
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
    if not ids:
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
    tick_plan(cell, task["id"])
    cell.save()
    cell.report_overrides(task["id"])
    telemetry(cell.root, "build.task_completed", "build", lambda: {"task": task["id"], "kind": task["kind"], "step": "green", "first_run": None,
                                                                   "suite": cell.state.get("suite"), "commit": None})
    following = cell.next_task()
    print(json.dumps({"status": "DONE", "task": task["id"], "commit": None, "note": task["note"], "suite": cell.state["suite"],
                      "next": f"{following['id']} [{following['kind']}]" if following else "All tasks are done. Run: build.py finish " + cell.ticket_id}, indent=2))
    return 0


def cmd_green(cell: Cell, args: argparse.Namespace) -> int:
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
    for task in cell.state["tasks"]:
        run = task.get("test_run") if isinstance(task.get("test_run"), dict) else {}
        steps.append({"task": task.get("id"), "kind": task.get("kind"), "loop": task.get("loop"), "tests": run.get("scope"), "test_seconds": run.get("seconds"),
                      "seconds_since_previous_step": seconds_between(previous, task.get("at")) if previous and task.get("at") else None})
        previous = task.get("at") or previous
    baseline = cell.state.get("baseline_run") if isinstance(cell.state.get("baseline_run"), dict) else {}
    measured = [step["test_seconds"] for step in steps if isinstance(step["test_seconds"], (int, float))]
    extra = [value for value in (baseline.get("seconds"), None if final.get("reused_from") else final.get("seconds")) if isinstance(value, (int, float))]
    return {
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


def reusable_suite_run(cell: Cell) -> Optional[Dict[str, Any]]:
    """The whole-suite run of the last step, when it is a run of exactly the code that is committed now.

    The last task's step ran the whole suite on its changes and then committed them. If that commit is still the
    branch's tip, the tree is clean and the test command is the same, running the suite again would run the same
    code and learn nothing. Anything else (a test task last, a different tip, a failed run) runs it again."""
    last = next((task for task in reversed(cell.state["tasks"]) if task.get("status") == "done" and task.get("commit")), None)
    run = last.get("test_run") if last else None
    if not isinstance(run, dict) or run.get("scope") != "whole suite" or run.get("exit_code") != 0 or run.get("command") != cell.state.get("test_cmd"):
        return None
    if cell.state.get("suite") != "green" or cell.state["tasks"][-1] is not last or git(cell.work, "rev-parse", "HEAD").stdout.strip() != last["commit"]:
        return None
    return {"command": run["command"], "exit_code": 0, "passed": True, "seconds": 0.0, "output_tail": "", "output": "",
            "scope": "whole suite", "reused_from": last["id"], "reused_run_seconds": run.get("seconds"),
            "note": f"Not run again: the whole suite passed on exactly this code when {last['id']} was completed."}


def cmd_finish(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    if cell.info.get("stage") == "built":
        raise BuildError("This cell is already built.", code="wrong-stage")
    problems: List[str] = []
    pending = [task["id"] for task in cell.state["tasks"] if task["status"] != "done"]
    if pending:
        problems.append(f"Tasks not done: {', '.join(pending)}.")
    dirty = changed_files(cell)
    if dirty:
        problems.append(f"Uncommitted changes in the cell: {', '.join(dirty[:8])}. Every change belongs to a task.")
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
    print(json.dumps({
        "ticket_id": cell.ticket_id, "stage": cell.info.get("stage"), "loop": cell.state.get("loop", 0), "suite": cell.state.get("suite"),
        "done": sum(1 for t in tasks if t["status"] == "done"), "tasks": len(tasks), "deviations": len(cell.state.get("deviations") or []),
        "next": (cell.next_task() or {}).get("id") if tasks else None, "workdir": str(cell.work),
        "adrs": adrs_in_force(cell) if adr is not None else None,
    }, indent=2, ensure_ascii=False))
    return 0


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
                             ("status", cmd_status, "show progress")):
        p = sub.add_parser(name, help=text)
        p.add_argument("ticket_id")
        p.set_defaults(func=func)
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
        if project is not None and args.command not in ("next", "status"):
            telemetry(project / ".factory" / "worktrees" / args.ticket_id, "gate.evaluated", "build", lambda: {
                "gate": f"build.{args.command}", "outcome": "refuse", "reason_code": exc.code, "overridden_by_reason": False, "task": getattr(args, "task", None)})
        return 1


if __name__ == "__main__":
    import contextlib as _c, os as _o, runpy as _r  # MACH records an internal error for /mach report (skills/intent/scripts/faults.py)
    with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if _o.path.isfile(p)))["install"](__file__)
    sys.exit(main())
