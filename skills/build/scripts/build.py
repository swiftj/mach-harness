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
    build.py done <ticket> <task>      a [contract], [refactor] or [docs] task; commits it
    build.py add-task <ticket> ...     add a task during a revision round
    build.py finish <ticket>           final gate; writes build-report.json
    build.py revise <ticket>           start a revision after a failed round; the third failed round escalates
    build.py status <ticket>

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
KINDS = ("test", "impl", "contract", "refactor", "docs")
COMMIT_PREFIX = {"test": "test", "impl": "feat", "contract": "chore", "refactor": "refactor", "docs": "docs"}
STEP_FOR = {"test": "red", "impl": "green", "contract": "done", "refactor": "done", "docs": "done"}
HARDENING_LABEL = "repo-hardening"
# Lifecycle log: the gate each recorded override passes.
OVERRIDDEN_GATE = {"test-amended": "frozen-tests", "files-outside-plan": "scope", "test-passed-first-run": "red-before-green",
                   "red-not-attributed": "red-attribution", "test-written-early": "red-before-green", "no-baseline": "baseline"}
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
            raise BuildError(f"'{ticket_id}' is not a usable ticket ID.")
        self.project = project
        self.ticket_id = ticket_id
        self.root = project / ".factory" / "worktrees" / ticket_id
        self.info = load_json(self.root / "cell.json")
        if not isinstance(self.info, dict):
            raise BuildError(f"No cell for {ticket_id}. Groom the ticket with the intent skill first.")
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
        raise BuildError(f"{task_id} is not a task in this plan. Tasks: {', '.join(t['id'] for t in self.state['tasks'])}.")

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
                    "line_files": [p for p in PATH_RE.findall(body) if "/" in p or re.search(r"\.[A-Za-z0-9]{1,6}$", p)],
                    "status": "done" if match.group(1).lower() == "x" else "pending",
                })
        elif section == "file touch map" and line.strip().startswith("|"):
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if len(cells) >= 3 and "`" in cells[0]:
                name = cells[0].strip("`").strip()
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
        raise BuildError(f"Cannot parse the command '{command}': {exc}")
    env = dict(os.environ)
    while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):  # leading VAR=value, as in a shell
        key, value = argv.pop(0).split("=", 1)
        env[key] = value
    if not argv or (shutil.which(argv[0]) is None and not (cell.work / argv[0]).is_file()):
        raise BuildError(f"'{argv[0] if argv else command}' is not installed or not on PATH, so '{command}' cannot run in the cell.")
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
        raise BuildError("No test command is known. Start again with --test-cmd \"<command>\", using the command the plan or the project documents.")
    timeout = cell.section("audit").get("timeouts", {}).get("test", 300) if isinstance(cell.section("audit").get("timeouts"), dict) else 300
    return run_command(cell, command, timeout)


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
        raise BuildError("git could not stage the task's files.")
    done = git(cell.work, "commit", "-q", "-m", message)
    if done.returncode != 0:
        raise BuildError("git commit failed: " + (done.stderr.strip() or done.stdout.strip()))
    return git(cell.work, "rev-parse", "HEAD").stdout.strip()


def check_scope(cell: Cell, task: Dict[str, Any], files: Sequence[str], args: argparse.Namespace) -> None:
    """A task may change only the files the plan gave it, and never a committed test unless it says so."""
    if not files:
        raise BuildError(f"{task['id']} changed no files. Do the task's work in {cell.work} first.")
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


def take(cell: Cell, task_id: str, step: str) -> Dict[str, Any]:
    cell.require_started()
    if cell.info.get("stage") == "built":
        raise BuildError("This cell is already built. Start a revision round with 'revise' if review sent it back.", code="wrong-stage")
    task = cell.task(task_id)
    if task["status"] == "done":
        raise BuildError(f"{task_id} is already done.")
    first = cell.next_task()
    if first and first["id"] != task_id:
        raise BuildError(f"Tasks are done in plan order. The next task is {first['id']} [{first['kind']}], not {task_id}.", code="plan-order")
    if STEP_FOR[task["kind"]] != step:
        raise BuildError(f"{task_id} is a [{task['kind']}] task: complete it with '{STEP_FOR[task['kind']]}', not '{step}'.")
    return task


def complete(cell: Cell, task: Dict[str, Any], files: Sequence[str], result: Optional[Dict[str, Any]], note: str) -> None:
    summary = re.sub(r"\s*\((?:(?:FR|INV|AC)-\d+[,\s]*)+\)\s*$", "", task["text"].replace("`", ""))  # drop the trailing ID list
    summary = " ".join(summary.split())[:64].rstrip(" —-,;:")
    scope = cell.info.get("slice_id") or cell.ticket_id
    sha = commit(cell, files, f"{COMMIT_PREFIX[task['kind']]}({scope}): {task['id']} {summary} [{cell.ticket_id}]")
    task.update({"status": "done", "commit": sha, "files_changed": list(files), "note": note, "at": now(), "loop": cell.state.get("loop", 0)})
    if result:
        task["test_run"] = {key: result[key] for key in ("exit_code", "seconds")}
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
        raise BuildError("The repository has no commits, so the cell cannot be isolated. Commit the project, including specs/slices/ and any contracts, then start the build.")
    spec = cell.info.get("spec_path")
    tracked = bool(spec) and git(cell.project, "ls-files", "--error-unmatch", "--", str(spec)).returncode == 0
    if not tracked or git(cell.project, "status", "--porcelain", "--", str(spec)).stdout.strip():
        raise BuildError(f"This cell was groomed before the repository had history. Commit {spec} and its contracts on the main branch, then start the build.")
    if git(cell.project, "check-ignore", "-q", ".factory/worktrees/probe").returncode != 0:
        common = git(cell.project, "rev-parse", "--git-common-dir").stdout.strip()
        exclude = (cell.project / common).resolve() / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("a", encoding="utf-8") as handle:
            handle.write("\n" + EXCLUDE_LINE + "\n")
    branch = f"feature/{cell.ticket_id}"
    exists = git(cell.project, "show-ref", "--verify", "-q", f"refs/heads/{branch}").returncode == 0
    added = git(cell.project, "worktree", "add", *([str(cell.root / "repo"), branch] if exists else ["-b", branch, str(cell.root / "repo")]))
    if added.returncode != 0:
        raise BuildError("git worktree add failed: " + added.stderr.strip())
    cell.info.update({"isolation": "worktree", "branch": branch})
    cell.info.pop("note", None)
    cell.save_info()


def sync_with_main(cell: Cell) -> Optional[str]:
    """A cell planned a while ago may be behind the main checkout. Bring it up to date before building,
    so the baseline it is measured against is today's code and not the code from when it was groomed."""
    if cell.info.get("isolation") != "worktree":
        return None
    main_head = git(cell.project, "rev-parse", "HEAD").stdout.strip()
    if not main_head or git(cell.work, "merge-base", "--is-ancestor", main_head, "HEAD").returncode == 0:
        return None
    merged = git(cell.work, "merge", "--no-edit", "-m", f"Merge main into {cell.info.get('branch')} before building [{cell.ticket_id}]", main_head)
    if merged.returncode != 0:
        conflicts = git(cell.work, "diff", "--name-only", "--diff-filter=U").stdout.split()
        git(cell.work, "merge", "--abort")
        raise BuildError(
            f"The cell's branch is behind the main checkout and cannot be brought up to date automatically: merging main conflicts in "
            f"{', '.join(conflicts) or 'some files'}. A person must merge main into {cell.info.get('branch')} in {cell.work} and resolve the conflict; "
            "if the conflict is in the spec or a contract, the ticket needs regrooming."
        )
    return main_head


def cmd_start(cell: Cell, args: argparse.Namespace) -> int:
    stage = cell.info.get("stage")
    if cell.state.get("tasks") and stage in ("building", "built"):
        raise BuildError(f"Building already started for {cell.ticket_id} (stage: {stage}). Use 'next' to continue, or 'revise' after a rejected review.")
    if stage != "planned":
        raise BuildError(f"The cell's stage is '{stage}', not 'planned'. The intent skill must finish the spec, contracts and plan first.", code="wrong-stage")
    gate = audit_gate(cell)
    ensure_isolated(cell)
    spec = cell.work / str(cell.info.get("spec_path"))
    if not spec.is_file() or hashlib.sha256(spec.read_text(encoding="utf-8-sig").encode("utf-8")).hexdigest() != cell.info.get("spec_sha256"):
        raise BuildError("The slice spec changed after it was finalized. Regroom the ticket with the intent skill before building.", code="spec-changed")
    plan_path = cell.root / "plan.md"
    if not plan_path.is_file() or not (cell.root / "spec.json").is_file():
        raise BuildError("plan.md or spec.json is missing from the cell.")
    tasks, _ = parse_plan(plan_path.read_text(encoding="utf-8"))
    if not tasks:
        raise BuildError("plan.md has no tasks.")
    dirty = changed_files(cell)
    if dirty:
        raise BuildError(f"The cell has uncommitted changes ({', '.join(dirty[:5])}). Commit or remove them before building starts.", code="uncommitted-changes")
    for task in tasks:
        task["status"] = "pending"
    synced = sync_with_main(cell)
    if synced:
        spec_now = cell.work / str(cell.info.get("spec_path"))
        if hashlib.sha256(spec_now.read_text(encoding="utf-8-sig").encode("utf-8")).hexdigest() != cell.info.get("spec_sha256"):
            raise BuildError("Bringing the cell up to date with main changed its slice spec. Regroom the ticket with the intent skill before building.")
    hardening = HARDENING_LABEL in ticket_labels(cell)
    cell.state = {
        "ticket_id": cell.ticket_id, "slice_id": cell.info.get("slice_id"), "loop": 0, "started_at": now(),
        "baseline": git(cell.work, "rev-parse", "HEAD").stdout.strip(), "audit": gate, "hardening": hardening,
        "test_cmd": find_command(cell, "test", args.test_cmd), "lint_cmd": find_command(cell, "lint", args.lint_cmd),
        "suite": "unknown", "tasks": tasks, "test_files": [], "deviations": [], "synced_with_main": synced,
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
            raise BuildError("--no-baseline is only for a project that has no test suite yet; this repository passed its audit, so its tests must pass in the cell.")
        baseline = {"skipped": args.no_baseline}
        cell.deviation(None, "no-baseline", args.no_baseline)
    elif not hardening:
        baseline = run_tests(cell)
        if not baseline["passed"]:
            raise BuildError("The tests already fail in the cell before any change, so building cannot start. The cell is up to date with the main checkout, "
                             "so the main checkout's tests fail too: run the audit, and harden the repository first.\n" + baseline["output_tail"][-800:],
                             code="baseline-red")
        cell.state["suite"] = "green"
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
        "synced_with_main": f"The cell was behind main and has been brought up to date ({synced[:10]})." if synced else None,
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
            raise BuildError(f"--written-early is for a test that is already committed, but {task['id']} has uncommitted changes: {', '.join(files)}.")
        if not cell.state.get("test_files"):
            raise BuildError("--written-early needs an earlier committed test; none has been committed yet.")
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
    result = run_tests(cell)
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


def cmd_green(cell: Cell, args: argparse.Namespace) -> int:
    task = take(cell, args.task, "green")
    files = changed_files(cell)
    check_scope(cell, task, files, args)
    result = run_tests(cell)
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
        raise BuildError("Tasks are added only during a revision round. The plan comes from the intent skill; if it is wrong, report a plan defect instead.")
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


def ui_findings(cell: Cell, baseline: str) -> List[str]:
    """Added lines in interface files that hard-code styling instead of using the design system."""
    diff = git(cell.work, "diff", "--unified=0", f"{baseline}..HEAD").stdout
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


def cmd_finish(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    if cell.info.get("stage") == "built":
        raise BuildError("This cell is already built.")
    problems: List[str] = []
    pending = [task["id"] for task in cell.state["tasks"] if task["status"] != "done"]
    if pending:
        problems.append(f"Tasks not done: {', '.join(pending)}.")
    dirty = changed_files(cell)
    if dirty:
        problems.append(f"Uncommitted changes in the cell: {', '.join(dirty[:8])}. Every change belongs to a task.")
    tests = run_tests(cell)
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
    test_text = "".join((cell.work / name).read_text(encoding="utf-8", errors="replace") for name in cell.state.get("test_files", []) if (cell.work / name).is_file())
    untraced = [identifier for identifier in wanted if not re.search(rf"\b{re.escape(identifier)}\b", test_text)]
    if untraced and not cell.state.get("hardening"):
        problems.append(f"No test names these spec IDs: {', '.join(untraced)}. Name the ID each test proves in the test's name, docstring or a comment.")
    if problems:
        cell.save()
        telemetry(cell.root, "gate.evaluated", "build", lambda: {"gate": "build.finish", "outcome": "refuse", "reason_code": "not-finished",
                                                                 "overridden_by_reason": False, "problems": len(problems), "tasks_pending": len(pending)})
        print("NOT FINISHED:\n- " + "\n- ".join(problems))
        return 1

    baseline = cell.state["baseline"]
    stat = git(cell.work, "diff", "--shortstat", f"{baseline}..HEAD").stdout.strip()
    files = git(cell.work, "diff", "--name-only", f"{baseline}..HEAD").stdout.split()
    styling = ui_findings(cell, baseline)
    report = {
        "ticket_id": cell.ticket_id, "slice_id": cell.info.get("slice_id"), "status": "BUILT", "finished_at": now(),
        "branch": cell.info.get("branch"), "baseline": baseline, "head": git(cell.work, "rev-parse", "HEAD").stdout.strip(),
        "review_loop": cell.state.get("loop", 0), "risk": cell.info.get("risk"), "human_review_required": bool(cell.info.get("human_review_required")) or cell.info.get("risk") == "High",
        "tests": {k: v for k, v in tests.items() if k not in ("output_tail", "output")}, "lint": {k: v for k, v in lint.items() if k not in ("output_tail", "output")},
        "tasks": [{k: t.get(k) for k in ("id", "kind", "status", "commit", "note", "first_run", "loop")} for t in cell.state["tasks"]],
        "tests_seen_failing_first": sum(1 for t in cell.state["tasks"] if t.get("first_run") == "fail"),
        "tests_passing_on_first_run": [t["id"] for t in cell.state["tasks"] if t.get("first_run") == "pass"],
        "tests_written_early": [t["id"] for t in cell.state["tasks"] if t.get("first_run") == "not-run"],
        "deviations": cell.state.get("deviations", []), "files_changed": files, "diff": stat,
        "test_files": cell.state.get("test_files", []), "styling_findings": styling,
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


def cmd_revise(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    if cell.info.get("stage") != "built":
        raise BuildError("A revision round starts from a built cell that review or verification sent back.")
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
    if args.findings:
        source = Path(args.findings)
        if not source.is_file():
            raise BuildError(f"{source}: findings file not found.")
        findings = cell.root / f"review-findings-{loop}.md"
        findings.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
    cell.state["loop"] = loop
    cell.info["stage"] = "building"
    cell.save()
    cell.save_info()
    telemetry(cell.root, "station.entered", "build", lambda: {"stage": "building", "revision": loop, "findings_copied": findings is not None})
    print(json.dumps({
        "status": "REVISING", "loop": loop, "round": loop + 1, "rounds_left": limit - loop - 1, "findings": str(findings) if findings else None,
        "next": "Add one task per finding with 'add-task' (a [test] task first for any behavior that was wrong), then work them with red, green and done.",
    }, indent=2))
    return 0


def cmd_status(cell: Cell, args: argparse.Namespace) -> int:
    tasks = cell.state.get("tasks") or []
    print(json.dumps({
        "ticket_id": cell.ticket_id, "stage": cell.info.get("stage"), "loop": cell.state.get("loop", 0), "suite": cell.state.get("suite"),
        "done": sum(1 for t in tasks if t["status"] == "done"), "tasks": len(tasks), "deviations": len(cell.state.get("deviations") or []),
        "next": (cell.next_task() or {}).get("id") if tasks else None, "workdir": str(cell.work),
    }, indent=2))
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
        if name == "red":
            p.add_argument("--covered", metavar="WHY", help="accept a test that passes on its first run because earlier work satisfies it; recorded for review")
            p.add_argument("--unrelated-failure", metavar="WHY", help="accept a red whose output does not name the new test; recorded for review")
            p.add_argument("--written-early", metavar="WHY", help="complete a test task whose test an earlier task already committed; recorded for review")
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
    for name in ("allow_extra", "amend_test", "covered", "no_baseline", "written_early", "unrelated_failure"):
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
    sys.exit(main())
