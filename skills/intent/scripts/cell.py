#!/usr/bin/env python3
"""Manage a MACH cell: the isolated workspace where one ticket is groomed, built, and verified.

A cell lives at .factory/worktrees/<ticket_id>/ and holds the ticket's factory artifacts
(cell.json, intent.md, spec.md, spec.json, plan.md, evidence/). When the project is a git
repository with at least one commit, the cell also holds repo/, a git worktree on the branch
feature/<ticket_id>; all code, contracts, and the slice spec are written there, never on the
main checkout. Without git history the cell has no repo/ and work happens in the project root.

Standard library only. Deterministic: the mach-intent skill calls this for everything a script
can decide, so the model only makes the judgment calls.
"""

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_slice  # noqa: E402

TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
SLICE_FILE_RE = re.compile(r"^SLICE-(\d{3,})-.*\.md$")
SLICE_ID_RE = re.compile(r"SLICE-(\d{3,})")
FIELD_RE = re.compile(r"^[-*+]\s+\*\*([A-Za-z ]+):\*\*\s*(.*)$")
REQ_RE = re.compile(r"\b(?:FR|INV|AC)-\d{2,}\b")
INTENT_SECTIONS = ("Why", "Goal ancestry", "Constraints", "Risk", "Deferred work")
INTENT_FIELDS = ("Ticket", "Slice", "Mode", "Status")
PLAN_FIELDS = ("App type", "Risk tier", "Contracts")
PLAN_SECTIONS = ("Contracts", "Tasks", "File touch map", "Engineering decisions")
APP_TYPES = ("web", "cli", "api", "grpc", "rest", "desktop", "mobile", "library")
RISK_TIERS = ("High", "Medium", "Low")
STAGES = ("interview", "spec-open", "spec-ready", "planned")
EXCLUDE_LINE = ".factory/worktrees/"


class CellError(Exception):
    """A problem the caller can fix; printed without a traceback."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def git(args: Sequence[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)


def find_project(start: Path) -> Path:
    """The project root: the nearest folder holding .factory/ or .git, else `start`."""
    start = start.resolve()
    parts = start.parts
    for index in range(len(parts) - 2, 0, -1):
        # Inside a cell (.factory/worktrees/<id>/...), the project is the folder holding .factory.
        if parts[index] == "worktrees" and parts[index - 1] == ".factory":
            return Path(*parts[:index - 1])
    for folder in [start, *start.parents]:
        if (folder / ".factory").is_dir():
            return folder
    for folder in [start, *start.parents]:
        if (folder / ".git").exists():
            return folder
    return start


def load_config(project: Path) -> Dict[str, Any]:
    path = project / ".factory" / "config.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CellError(f"{path}: cannot read factory config: {exc}")
    return data if isinstance(data, dict) else {}


def check_ticket_id(ticket_id: str) -> str:
    if not TICKET_ID_RE.match(ticket_id) or ticket_id.endswith(".lock"):
        raise CellError(
            f"'{ticket_id}' is not a usable ticket ID. Use letters, digits, '-', '_' and '.', such as LOCAL-001 or GIT-1042."
        )
    return ticket_id


def cell_dir(project: Path, ticket_id: str) -> Path:
    return project / ".factory" / "worktrees" / check_ticket_id(ticket_id)


def read_cell(project: Path, ticket_id: str) -> Dict[str, Any]:
    path = cell_dir(project, ticket_id) / "cell.json"
    if not path.is_file():
        raise CellError(f"No cell for {ticket_id}. Run: cell.py open {ticket_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def write_cell(project: Path, cell: Dict[str, Any]) -> None:
    cell["updated_at"] = now()
    path = cell_dir(project, cell["ticket_id"]) / "cell.json"
    path.write_text(json.dumps(cell, indent=2) + "\n", encoding="utf-8")


def workdir(project: Path, cell: Dict[str, Any]) -> Path:
    """Where this cell's code, contracts and slice spec are written."""
    if cell.get("isolation") == "worktree":
        return cell_dir(project, cell["ticket_id"]) / "repo"
    return project


def registries(project: Path, own: Optional[Path] = None) -> List[Path]:
    """Every specs/slices folder that shares the slice ID space, except `own`."""
    folders = [project / "specs" / "slices"]
    worktrees = project / ".factory" / "worktrees"
    if worktrees.is_dir():
        folders.extend(sorted(p / "repo" / "specs" / "slices" for p in worktrees.iterdir() if p.is_dir()))
    own_resolved = own.resolve() if own else None
    return [f for f in folders if f.is_dir() and f.resolve() != own_resolved]


def ensure_ignored(project: Path) -> None:
    """Keep cells out of the main checkout's `git status` without editing project files."""
    if git(["check-ignore", "-q", ".factory/worktrees/probe"], project).returncode == 0:
        return
    common = git(["rev-parse", "--git-common-dir"], project).stdout.strip()
    if not common:
        return
    exclude = (project / common).resolve() / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    existing = exclude.read_text(encoding="utf-8") if exclude.is_file() else ""
    if EXCLUDE_LINE not in existing.splitlines():
        with exclude.open("a", encoding="utf-8") as handle:
            handle.write(("" if existing.endswith("\n") or not existing else "\n") + EXCLUDE_LINE + "\n")


def commit(project: Path, cell: Dict[str, Any], paths: Sequence[str], message: str, skip: bool) -> Optional[str]:
    """Commit the given paths on the cell's own branch. Never commits on the main checkout."""
    if skip or cell.get("isolation") != "worktree" or not paths:
        return None
    if load_config(project).get("git", {}).get("auto_commit") is False:
        return None
    work = workdir(project, cell)
    if git(["add", "--", *paths], work).returncode != 0:
        return "warning: could not stage the files; commit them on the cell's branch yourself."
    if git(["diff", "--cached", "--quiet", "--", *paths], work).returncode == 0:
        return None
    done = git(["commit", "-q", "-m", message, "--", *paths], work)
    if done.returncode != 0:
        return "warning: git commit failed, so the files are staged but not committed: " + (done.stderr.strip() or done.stdout.strip())
    return f"Committed on {cell.get('branch')}: {message}"


def report(message: Optional[str]) -> None:
    if message:
        print(message)


def find_ticket(project: Path, ticket_id: str) -> Dict[str, Optional[str]]:
    inbox = project / ".factory" / "inbox" / f"{ticket_id}.json"
    seeded = project / ".factory" / "inbox" / f"{ticket_id}-intent.md"
    local = project / ".factory" / "tickets" / f"{ticket_id}.md"
    return {
        "inbox_json": str(inbox) if inbox.is_file() else None,
        "seeded_intent": str(seeded) if seeded.is_file() else None,
        "local_ticket": str(local) if local.is_file() else None,
    }


def describe(project: Path, cell: Dict[str, Any]) -> Dict[str, Any]:
    root = cell_dir(project, cell["ticket_id"])
    work = workdir(project, cell)
    info = dict(cell)
    info.update({
        "project": str(project),
        "cell_dir": str(root),
        "workdir": str(work),
        "specs_dir": str(work / "specs" / "slices"),
        "intent_path": str(root / "intent.md"),
        "plan_path": str(root / "plan.md"),
        "spec_copy_path": str(root / "spec.md"),
        "spec_json_path": str(root / "spec.json"),
        "ticket": find_ticket(project, cell["ticket_id"]),
    })
    return info


def cmd_open(project: Path, args: argparse.Namespace) -> int:
    ticket_id = check_ticket_id(args.ticket_id)
    root = cell_dir(project, ticket_id)
    path = root / "cell.json"
    if path.is_file():
        cell = json.loads(path.read_text(encoding="utf-8"))
        mode = "headless" if args.headless else "interactive"
        if cell.get("mode") != mode:  # a person may resume a ticket that was groomed headless
            cell["mode"] = mode
            write_cell(project, cell)
        print(json.dumps(describe(project, cell), indent=2))
        return 0

    root.mkdir(parents=True, exist_ok=True)
    (root / "evidence").mkdir(exist_ok=True)
    branch = f"feature/{ticket_id}"
    isolation, note = "none", ""
    inside = git(["rev-parse", "--is-inside-work-tree"], project)
    if inside.returncode != 0:
        note = "The project is not a git repository, so the cell works in the project root."
    elif git(["rev-parse", "--verify", "-q", "HEAD"], project).returncode != 0:
        note = "The repository has no commits yet, so the cell works in the project root. Commit once to enable isolated cells."
    else:
        ensure_ignored(project)
        repo = root / "repo"
        exists = git(["show-ref", "--verify", "-q", f"refs/heads/{branch}"], project).returncode == 0
        added = git(["worktree", "add", str(repo), branch] if exists else ["worktree", "add", "-b", branch, str(repo)], project)
        if added.returncode == 0:
            isolation = "worktree"
        else:
            note = "git worktree add failed, so the cell works in the project root: " + added.stderr.strip()
    cell = {
        "ticket_id": ticket_id,
        "title": args.title or "",
        "mode": "headless" if args.headless else "interactive",
        "stage": "interview",
        "isolation": isolation,
        "branch": branch if isolation == "worktree" else None,
        "slice_id": None,
        "spec_path": None,
        "risk": None,
        "app_type": None,
        "contracts": [],
        "created_at": now(),
    }
    if note:
        cell["note"] = note
    write_cell(project, cell)
    (workdir(project, cell) / "specs" / "slices").mkdir(parents=True, exist_ok=True)
    print(json.dumps(describe(project, cell), indent=2))
    return 0


def scan_ids(folders: Sequence[Path]) -> Tuple[Dict[int, str], Dict[int, List[Dict[str, str]]]]:
    """Slice numbers that have a spec file, and numbers reserved by 'Deferred to' pointers."""
    used: Dict[int, str] = {}
    reserved: Dict[int, List[Dict[str, str]]] = {}
    seen = set()
    for folder in folders:
        for path in sorted(folder.glob("SLICE-*.md")):
            match = SLICE_FILE_RE.match(path.name)
            if not match or path.name in seen:
                continue
            seen.add(path.name)
            used.setdefault(int(match.group(1)), path.name)
            try:
                text = path.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeDecodeError):
                continue
            for line in text.splitlines():
                pointer = validate_slice.POINTER_LINE_RE.match(line)
                if pointer:
                    number = int(SLICE_ID_RE.match(pointer.group(2)).group(1))
                    entry = {"feature": pointer.group(1).strip(), "reserved_by": path.name}
                    if entry not in reserved.setdefault(number, []):
                        reserved[number].append(entry)
    return used, reserved


def cmd_next_id(project: Path, args: argparse.Namespace) -> int:
    used, reserved = scan_ids(registries(project))
    highest = max([0, *used, *reserved])
    result = {
        "next": [f"SLICE-{highest + offset:03d}" for offset in range(1, args.count + 1)],
        "reserved_without_spec": [
            {"id": f"SLICE-{number:03d}", **entry}
            for number in sorted(reserved) if number not in used for entry in reserved[number]
        ],
        "existing": [{"id": f"SLICE-{number:03d}", "file": used[number]} for number in sorted(used)],
    }
    print(json.dumps(result, indent=2))
    return 0


def resolve_spec(project: Path, cell: Dict[str, Any], given: Optional[str]) -> Path:
    work = workdir(project, cell)
    value = given or cell.get("spec_path")
    if not value:
        raise CellError("No spec recorded for this cell yet. Pass --spec specs/slices/SLICE-NNN-name.md.")
    path = Path(value)
    path = path if path.is_absolute() else work / path
    if not path.is_file():
        raise CellError(f"{path}: spec not found.")
    try:
        relative = path.resolve().relative_to(work.resolve())
    except ValueError:
        raise CellError(f"{path} is outside this cell's working folder ({work}). Write the spec under {work / 'specs' / 'slices'}.")
    if relative.parts[:2] != ("specs", "slices"):
        raise CellError(f"{path}: slice specs live in specs/slices/ inside the cell's working folder ({work}).")
    return path


def analyze_spec(project: Path, spec: Path, ready: bool) -> Tuple[List[Any], Dict[str, Any]]:
    text = spec.read_text(encoding="utf-8-sig")
    others = validate_slice.sibling_specs(spec, registries(project, own=spec.parent))
    return validate_slice.analyze(text, spec.name, others, ready=ready)


def print_findings(spec: Path, findings: Sequence[Any]) -> int:
    for finding in findings:
        location = f"{spec}:{finding.line}" if finding.line else str(spec)
        print(f"{location}: {finding.severity}: {finding.message} [{finding.rule}]")
    return sum(1 for f in findings if f.severity == "error")


def cmd_validate(project: Path, args: argparse.Namespace) -> int:
    cell = read_cell(project, args.ticket_id)
    spec = resolve_spec(project, cell, args.spec)
    findings, _ = analyze_spec(project, spec, args.ready)
    errors = print_findings(spec, findings)
    status = "FAILED" if errors else ("READY" if args.ready else "PASSED")
    print(f"{status}: {errors} error(s), {len(findings) - errors} warning(s)")
    if cell.get("spec_path") is None:
        cell["spec_path"] = str(spec.resolve().relative_to(workdir(project, cell).resolve()))
        write_cell(project, cell)
    return 1 if errors else 0


def markdown_sections(text: str) -> Dict[str, List[str]]:
    sections: Dict[str, List[str]] = {"": []}
    current = ""
    fenced = False
    for line in text.splitlines():
        if validate_slice.FENCE_RE.match(line):
            fenced = not fenced
        heading = None if fenced else re.match(r"^##\s+(.+?)\s*$", line)
        if heading:
            current = heading.group(1)
            sections.setdefault(current, [])
        else:
            sections[current].append(line)
    return sections


def fields(lines: Sequence[str]) -> Dict[str, str]:
    found: Dict[str, str] = {}
    for line in lines:
        match = FIELD_RE.match(line.strip())
        if match:
            found.setdefault(match.group(1), match.group(2).strip())
    return found


def leftover(text: str) -> List[str]:
    problems = []
    for number, line in enumerate(text.splitlines(), start=1):
        bare = validate_slice.strip_quotes(validate_slice.INLINE_CODE_RE.sub("", line))
        if "<!--" in line:
            problems.append(f"line {number}: remove the template comment")
        elif validate_slice.PLACEHOLDER_RE.search(bare):
            problems.append(f"line {number}: replace the placeholder {validate_slice.PLACEHOLDER_RE.search(bare).group(0)}")
    return problems


def check_intent(path: Path) -> Tuple[List[str], Dict[str, str]]:
    if not path.is_file():
        return [f"{path} is missing. Write it from assets/intent-template.md before finalizing."], {}
    text = path.read_text(encoding="utf-8")
    problems = leftover(text)
    if not re.search(r"^# Intent: \S", text, re.MULTILINE):
        problems.append("the first heading must read '# Intent: <title>'")
    sections = markdown_sections(text)
    for name in INTENT_SECTIONS:
        if name not in sections:
            problems.append(f"missing section '## {name}'")
        elif not any(line.strip() for line in sections[name]):
            problems.append(f"'## {name}' is empty; write '- None.' if nothing applies")
    header = fields(sections[""])
    for name in INTENT_FIELDS:
        if not header.get(name):
            problems.append(f"missing header line '- **{name}:** ...'")
    risk = fields(sections.get("Risk", []))
    tier = risk.get("Tier", "")
    if tier not in RISK_TIERS:
        problems.append("'## Risk' needs '- **Tier:** High', 'Medium' or 'Low'")
    if not risk.get("Reason"):
        problems.append("'## Risk' needs '- **Reason:** ...'")
    return [f"{path.name}: {p}" for p in problems], {"risk": tier}


def cmd_finalize(project: Path, args: argparse.Namespace) -> int:
    cell = read_cell(project, args.ticket_id)
    root = cell_dir(project, args.ticket_id)
    spec = resolve_spec(project, cell, args.spec)
    findings, model = analyze_spec(project, spec, ready=True)
    hard = [f for f in findings if f.severity == "error" and f.rule != "open-questions"]
    open_items = [f for f in findings if f.rule == "open-questions"]
    print_findings(spec, findings)
    intent_problems, intent = check_intent(root / "intent.md")
    for problem in intent_problems:
        print(f"error: {problem}")
    if hard or intent_problems:
        print(f"FAILED: {len(hard) + len(intent_problems)} error(s). Nothing was finalized.")
        return 1

    text = spec.read_text(encoding="utf-8-sig")
    (root / "spec.md").write_text(text, encoding="utf-8")
    cell["spec_path"] = str(spec.resolve().relative_to(workdir(project, cell).resolve()))
    cell["slice_id"] = model.get("slice_id")
    cell["title"] = cell.get("title") or model.get("title") or ""
    cell["risk"] = intent["risk"]
    cell["spec_sha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
    spec_json = root / "spec.json"
    counts = {
        "invariants": len(model.get("invariants") or []),
        "functional_requirements": len(model.get("functional_requirements") or []),
        "matrix_rules": len((model.get("decision_matrix") or {}).get("rules") or []),
        "matrix_cases": len((model.get("decision_matrix") or {}).get("cases") or []),
        "scenarios": len(model.get("scenarios") or []),
        "open_questions": len(model.get("open_questions") or []),
    }
    if open_items:
        cell["stage"] = "spec-open"
        if spec_json.exists():
            spec_json.unlink()
        write_cell(project, cell)
        report(commit(project, cell, [cell["spec_path"]], f"spec({cell['slice_id']}): save draft with open questions [{cell['ticket_id']}]", args.no_commit))
        print(json.dumps({"status": "SAVED_NOT_READY", "slice_id": cell["slice_id"], **counts}, indent=2))
        print("SAVED: the spec is valid but open questions remain, so it is not ready for contracts or building.")
        return 0 if args.allow_open else 1

    export = {"ticket_id": cell["ticket_id"], "risk": cell["risk"], "spec_path": cell["spec_path"], **model}
    spec_json.write_text(json.dumps(export, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    cell["stage"] = "spec-ready"
    write_cell(project, cell)
    report(commit(project, cell, [cell["spec_path"]], f"spec({cell['slice_id']}): {cell['title']} [{cell['ticket_id']}]", args.no_commit))
    print(json.dumps({"status": "READY", "slice_id": cell["slice_id"], "risk": cell["risk"], **counts}, indent=2))
    print(f"READY: wrote {root / 'spec.md'} and {spec_json}.")
    return 0


def cmd_check_plan(project: Path, args: argparse.Namespace) -> int:
    cell = read_cell(project, args.ticket_id)
    root = cell_dir(project, args.ticket_id)
    work = workdir(project, cell)
    spec_json = root / "spec.json"
    if not spec_json.is_file():
        raise CellError("spec.json is missing: the spec is not ready. Run 'cell.py finalize' first.")
    spec_path = work / str(cell.get("spec_path"))
    if not spec_path.is_file() or hashlib.sha256(spec_path.read_text(encoding="utf-8-sig").encode("utf-8")).hexdigest() != cell.get("spec_sha256"):
        raise CellError("The slice spec changed after it was finalized. Run 'cell.py finalize' again, then redo the plan.")
    model = json.loads(spec_json.read_text(encoding="utf-8"))
    plan = root / "plan.md"
    if not plan.is_file():
        raise CellError(f"{plan} is missing.")
    text = plan.read_text(encoding="utf-8")
    problems = leftover(text)
    sections = markdown_sections(text)
    header = fields(sections[""])
    for name in PLAN_FIELDS:
        if not header.get(name):
            problems.append(f"missing header line '- **{name}:** ...'")
    for name in PLAN_SECTIONS:
        if name not in sections:
            problems.append(f"missing section '## {name}'")
        elif not any(line.strip() for line in sections[name]):
            problems.append(f"'## {name}' is empty; write '- None.' if nothing applies")
    app_type = header.get("App type", "").strip("`").lower()
    if header.get("App type") and app_type not in APP_TYPES:
        problems.append("'App type' must be one of: " + ", ".join(APP_TYPES))
    risk = header.get("Risk tier", "")
    if header.get("Risk tier") and risk not in RISK_TIERS:
        problems.append("'Risk tier' must be High, Medium or Low")
    elif risk and cell.get("risk") and RISK_TIERS.index(risk) > RISK_TIERS.index(cell["risk"]):
        problems.append(f"'Risk tier' is {risk} but intent.md says {cell['risk']}; a plan may raise the tier, never lower it")
    contracts: List[str] = []
    raw = header.get("Contracts", "")
    if raw and not raw.lower().startswith("none"):
        contracts = [item.strip().strip("`") for item in raw.split(",") if item.strip()]
        for item in contracts:
            target = (work / item).resolve()
            if work.resolve() not in target.parents:
                problems.append(f"contract '{item}' must be a path inside the cell's working folder")
            elif not target.is_file():
                problems.append(f"contract '{item}' is listed but does not exist under {work}")
            elif cell.get("isolation") == "worktree" and risk in RISK_TIERS and risk != "High":
                # A contract that is already on the main checkout is something other work depends on.
                main_head = git(["rev-parse", "HEAD"], project).stdout.strip()
                if main_head and git(["cat-file", "-e", f"{main_head}:{item}"], work).returncode == 0:
                    problems.append(f"contract '{item}' already exists on the main checkout; changing an existing contract makes the ticket High risk, so 'Risk tier' must be High")
    elif raw.rstrip(".").strip().lower() == "none":
        problems.append("'Contracts: None.' needs a reason, such as 'None. This slice changes no boundary.'")

    tasks = "\n".join(sections.get("Tasks", []))
    mentioned = set(REQ_RE.findall(tasks))
    wanted = [entry["id"] for key in ("invariants", "functional_requirements", "scenarios") for entry in model.get(key) or [] if entry.get("id")]
    missing = [identifier for identifier in wanted if identifier not in mentioned]
    if missing:
        problems.append("these IDs from the spec appear in no task: " + ", ".join(missing))
    unknown = sorted(mentioned - set(wanted))
    if unknown:
        problems.append("tasks name IDs the spec does not define: " + ", ".join(unknown))
    task_lines = [line for line in sections.get("Tasks", []) if re.match(r"^\s*[-*+]\s+\[[ xX]\]\s+\S", line)]
    if not task_lines:
        problems.append("'## Tasks' needs at least one checklist item, such as '- [ ] T01 [test] ...'")
    elif not re.search(r"\[test\]", task_lines[0]):
        problems.append("the first task must be a [test] task: tests are written before implementation")

    if problems:
        for problem in problems:
            print(f"error: plan.md: {problem}")
        print(f"FAILED: {len(problems)} error(s)")
        return 1
    cell.update({"app_type": app_type, "risk": risk, "contracts": contracts, "stage": "planned"})
    if model.get("risk") != risk or model.get("app_type") != app_type:
        # Keep the exported spec in step with the plan, so every reader sees one risk tier and app type.
        model.update({"risk": risk, "app_type": app_type})
        spec_json.write_text(json.dumps(model, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write_cell(project, cell)
    report(commit(project, cell, contracts, f"contract({cell.get('slice_id')}): boundary contracts [{cell['ticket_id']}]", args.no_commit))
    print(json.dumps({"status": "PLANNED", "app_type": app_type, "risk": risk, "contracts": contracts, "tasks": len(task_lines)}, indent=2))
    return 0


def cmd_status(project: Path, args: argparse.Namespace) -> int:
    if args.ticket_id:
        print(json.dumps(describe(project, read_cell(project, args.ticket_id)), indent=2))
        return 0
    worktrees = project / ".factory" / "worktrees"
    cells = []
    if worktrees.is_dir():
        for path in sorted(worktrees.glob("*/cell.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            cells.append({key: data.get(key) for key in ("ticket_id", "slice_id", "title", "stage", "mode", "risk", "isolation")})
    print(json.dumps(cells, indent=2))
    return 0


def local_ticket_path(project: Path, ticket_id: str) -> Path:
    return project / ".factory" / "tickets" / f"{check_ticket_id(ticket_id)}.md"


def cmd_ticket_new(project: Path, args: argparse.Namespace) -> int:
    folder = project / ".factory" / "tickets"
    folder.mkdir(parents=True, exist_ok=True)
    prefix = str(load_config(project).get("tickets", {}).get("local_prefix") or "LOCAL")
    pattern = re.compile(rf"^{re.escape(prefix)}-(\d+)$")
    factory = project / ".factory"
    # Never reuse a number: count open and closed tickets, cells, inbox records, and finished tickets in the run log.
    names = [p.stem for p in folder.glob(f"{prefix}-*.md")] + [p.stem for p in (factory / "inbox").glob(f"{prefix}-*.json")]
    names += [p.name for p in (factory / "worktrees").glob(f"{prefix}-*") if p.is_dir()]
    log = factory / "archive" / "runs.jsonl"
    for line in log.read_text(encoding="utf-8").splitlines() if log.is_file() else []:
        try:
            names.append(str(json.loads(line).get("ticket_id") or ""))
        except (ValueError, AttributeError):
            continue
    numbers = [int(m.group(1)) for name in names for m in [pattern.match(name)] if m]
    ticket_id = f"{prefix}-{max([0, *numbers]) + 1:03d}"
    title = " ".join(args.title.split())
    labels = ", ".join(json.dumps(label) for label in args.label)
    body = (args.body or "").strip()
    text = (
        f"---\nid: {ticket_id}\ntitle: {json.dumps(title)}\nstate: open\nlabels: [{labels}]\ncreated: {now()}\n---\n\n"
        f"# {title}\n\n{body + chr(10) + chr(10) if body else ''}## Activity Log\n\n- {now()} Created.\n"
    )
    local_ticket_path(project, ticket_id).write_text(text, encoding="utf-8")
    print(json.dumps({"ticket_id": ticket_id, "path": str(local_ticket_path(project, ticket_id))}, indent=2))
    return 0


def cmd_ticket_note(project: Path, args: argparse.Namespace) -> int:
    path = local_ticket_path(project, args.ticket_id)
    if not path.is_file():
        raise CellError(f"{path} does not exist. This command only updates local Markdown tickets; use the ticket skill for other trackers.")
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not match:
        raise CellError(f"{path} has no YAML front matter.")
    front, rest = match.group(1).splitlines(), text[match.end():]
    changes = []
    if args.state:
        front = [f"state: {args.state}" if line.startswith("state:") else line for line in front]
        if not any(line.startswith("state:") for line in front):
            front.append(f"state: {args.state}")
        changes.append(f"State set to {args.state}.")
    for label in args.label:
        index = next((i for i, line in enumerate(front) if line.startswith("labels:")), None)
        current = re.findall(r'"([^"]*)"|([^\s,\[\]"]+)', front[index].split(":", 1)[1]) if index is not None else []
        labels = [a or b for a, b in current]
        if label not in labels:
            labels.append(label)
            line = "labels: [" + ", ".join(json.dumps(item) for item in labels) + "]"
            if index is None:
                front.append(line)
            else:
                front[index] = line
            changes.append(f"Label added: {label}.")
    for label in args.remove_label:
        index = next((i for i, line in enumerate(front) if line.startswith("labels:")), None)
        current = re.findall(r'"([^"]*)"|([^\s,\[\]"]+)', front[index].split(":", 1)[1]) if index is not None else []
        labels = [a or b for a, b in current]
        if label in labels:
            labels.remove(label)
            front[index] = "labels: [" + ", ".join(json.dumps(item) for item in labels) + "]"
            changes.append(f"Label removed: {label}.")
    if args.comment:
        changes.append(args.comment.strip())
    if not changes:
        raise CellError("Nothing to record. Pass --state, --label, --remove-label or --comment.")
    if "## Activity Log" not in rest:
        rest = rest.rstrip("\n") + "\n\n## Activity Log\n"
    entry = "\n".join(f"- {now()} {line}" if i == 0 else f"  {line}" for i, line in enumerate(" ".join(changes).splitlines()))
    rest = rest.rstrip("\n") + "\n" + entry + "\n"
    path.write_text("---\n" + "\n".join(front) + "\n---\n" + rest, encoding="utf-8")
    print(f"Updated {path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage MACH cells for the mach-intent skill.")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("open", help="create the cell for a ticket, or show it if it exists")
    p.add_argument("ticket_id")
    p.add_argument("--title")
    p.add_argument("--headless", action="store_true", help="record that no person is answering questions")
    p.set_defaults(func=cmd_open)

    p = sub.add_parser("next-id", help="list the next free slice IDs and the IDs earlier specs reserved")
    p.add_argument("--count", type=int, default=6)
    p.set_defaults(func=cmd_next_id)

    p = sub.add_parser("validate", help="validate the cell's slice spec against every open cell")
    p.add_argument("ticket_id")
    p.add_argument("--spec", help="spec path, relative to the cell's working folder (needed the first time)")
    p.add_argument("--ready", action="store_true")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("finalize", help="gate stage 1: validate with --ready, check intent.md, write spec.md and spec.json")
    p.add_argument("ticket_id")
    p.add_argument("--spec")
    p.add_argument("--allow-open", action="store_true", help="exit 0 when the only problem is open questions (a paused spec)")
    p.add_argument("--no-commit", action="store_true", help="do not commit the spec on the cell's branch")
    p.set_defaults(func=cmd_finalize)

    p = sub.add_parser("check-plan", help="gate stage 2: check plan.md and contracts against spec.json")
    p.add_argument("ticket_id")
    p.add_argument("--no-commit", action="store_true", help="do not commit the contracts on the cell's branch")
    p.set_defaults(func=cmd_check_plan)

    p = sub.add_parser("status", help="show one cell, or list all cells")
    p.add_argument("ticket_id", nargs="?")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("ticket-new", help="create a local Markdown ticket in .factory/tickets/")
    p.add_argument("--title", required=True)
    p.add_argument("--body")
    p.add_argument("--label", action="append", default=[])
    p.set_defaults(func=cmd_ticket_new)

    p = sub.add_parser("ticket-note", help="update a local Markdown ticket's state, labels or activity log")
    p.add_argument("ticket_id")
    p.add_argument("--state")
    p.add_argument("--label", action="append", default=[])
    p.add_argument("--remove-label", action="append", default=[])
    p.add_argument("--comment")
    p.set_defaults(func=cmd_ticket_note)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    project = args.project.resolve() if args.project else find_project(Path.cwd())
    try:
        return args.func(project, args)
    except CellError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
