#!/usr/bin/env python3
"""MACH verify station: turn "it works" into evidence someone else can inspect.

The verifier (a model, in a fresh context) runs the built slice the way its user would and
captures what happened. This script decides everything a script can decide: whether verification
may start, what must be proven, whether each claim has a real, fresh evidence file behind it,
and the verdict.

    verify.py start <ticket>     check the gates, rerun the suite and contract checks, print what to prove
    verify.py capture <ticket> <driver.py> --out FILE [--input FILE] [-- ARG...]
                                 run a Python driver from the evidence folder and save its transcript there
    verify.py record <ticket> <ID> --result pass|fail --evidence FILE --note "what was observed"
    verify.py record <ticket> --from FILE    record several checks from a JSON list, all or none
    verify.py finish <ticket>    verdict: PASS, FAIL_WITH_EVIDENCE or INCOMPLETE_EVIDENCE
    verify.py status <ticket>

Every form is one plain command: no shell redirect, pipe, heredoc or change of directory is ever
needed, so the station works inside the Factory's restricted tool list (M4 known issue 9, D22).
`capture` replaces `python3 driver.py > evidence/run.log 2>&1`; `record --from` replaces a series of
`record` calls chained in one shell command. Neither relaxes a check: `capture` runs only the
station's own Python on a script inside the evidence folder, which the tool list already allows,
and every record from a file passes exactly the checks of a single `record`.

What must be proven: every scenario (AC-NN) in spec.json with the scenario's own data, every
decision matrix rule (RN) with data the verifier chooses, and any holdout check a person left
in .factory/holdouts/<ticket>/. Matrix rules carry no example data in the spec, so the
verifier's own data is a holdout the builder never saw.

Standard library only. It runs the project's test command inside the cell.
"""

import argparse
import fnmatch
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
from typing import Any, Dict, List, Optional, Sequence

TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
AUTO_FILES = ("test-suite.log", "contract-check.log", "results.json", "summary.json", "findings.md")
RECORDS_FILE = "verify-records.json"  # in the cell folder, never in evidence/: an input to `record --from`, not evidence
CAPTURE_TIMEOUT = 600
IMAGE = ["*.png", "*.jpg", "*.jpeg"]
VIDEO = ["*.webm", "*.mp4", "*.mov", "*.gif", "*trace*.zip"]
# For each app type: the kinds of evidence a reviewer needs, each satisfied by any matching file.
REQUIRED_EVIDENCE: Dict[str, List[Dict[str, Any]]] = {
    "web": [{"kind": "screenshot", "match": IMAGE}, {"kind": "recording of the flow", "match": VIDEO}],
    "cli": [{"kind": "terminal session", "match": ["*.gif", "*.cast", "*.log", "*.txt"]}, {"kind": "exit codes", "match": ["exit-codes.json"]}],
    "api": [{"kind": "request and response dump", "match": ["*.json", "*.log", "*.txt", "*.http"]}],
    "rest": [{"kind": "request and response dump", "match": ["*.json", "*.log", "*.txt", "*.http"]}],
    "grpc": [{"kind": "request and response dump", "match": ["*.json", "*.log", "*.txt"]}],
    "desktop": [{"kind": "screenshot", "match": IMAGE}, {"kind": "recording of the interaction", "match": VIDEO}],
    "mobile": [{"kind": "screenshot", "match": IMAGE}, {"kind": "recording of the interaction", "match": VIDEO}],
    "library": [{"kind": "transcript of calling the library as a consumer", "match": ["*.log", "*.txt", "*.json"]}],
}
TOOLS = ("playwright", "cypress", "vhs", "asciinema", "ffmpeg", "curl", "grpcurl", "k6", "protoc", "buf", "xcrun", "adb", "cliclick", "xdotool", "screencapture", "node", "npx")


# Files that running a build or test suite leaves behind. They are never part of a change, so the
# gates ignore them even when the project forgot to git-ignore them.
BYPRODUCT_RE = re.compile(
    r"(^|/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|htmlcov|\.hypothesis|node_modules|\.gradle|\.next|\.turbo|coverage)(/|$)"
    r"|\.py[co]$|(^|/)\.coverage(\..*)?$|(^|/)\.DS_Store$|\.egg-info(/|$)|\.tsbuildinfo$"
)


def is_byproduct(name: str) -> bool:
    return bool(BYPRODUCT_RE.search(name))


class VerifyError(Exception):
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


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class Cell:
    def __init__(self, project: Path, ticket_id: str) -> None:
        if not TICKET_ID_RE.match(ticket_id):
            raise VerifyError(f"'{ticket_id}' is not a usable ticket ID.")
        self.project = project
        self.ticket_id = ticket_id
        self.root = project / ".factory" / "worktrees" / ticket_id
        self.info = load_json(self.root / "cell.json")
        if not isinstance(self.info, dict):
            raise VerifyError(f"No cell for {ticket_id}.")
        self.evidence = self.root / "evidence"
        self.results_path = self.evidence / "results.json"
        self.results: Dict[str, Any] = load_json(self.results_path, {}) or {}
        self.spec = load_json(self.root / "spec.json", {}) or {}
        self.build = load_json(self.root / "build-report.json", {}) or {}
        config = load_json(project / ".factory" / "config.json", {})
        self.config = config if isinstance(config, dict) else {}

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
        self.results_path.write_text(json.dumps(self.results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    def require_started(self) -> None:
        if not self.results.get("started_at") or self.results.get("head") != self.head():
            raise VerifyError(f"Verification has not started for this build of {self.ticket_id}. Run: verify.py start {self.ticket_id}", code="not-started")

    def head(self) -> str:
        return git(self.work, "rev-parse", "HEAD").stdout.strip()

    def holdouts(self) -> List[Dict[str, str]]:
        folder = self.project / ".factory" / "holdouts" / self.ticket_id
        found = []
        for path in sorted(folder.glob("*")) if folder.is_dir() else []:
            if path.is_file() and not path.name.startswith("."):
                found.append({"id": "H-" + re.sub(r"[^A-Za-z0-9]+", "-", path.stem).strip("-"), "file": str(path)})
        return found

    def targets(self) -> List[Dict[str, Any]]:
        """Everything this verification must prove."""
        targets: List[Dict[str, Any]] = []
        for scenario in self.spec.get("scenarios") or []:
            if scenario.get("id"):
                targets.append({"id": scenario["id"], "kind": "scenario", "title": scenario.get("title"), "steps": scenario.get("steps"),
                                "prove": "Follow these steps with the scenario's own data."})
        for rule in (self.spec.get("decision_matrix") or {}).get("rules") or []:
            targets.append({"id": rule["id"], "kind": "matrix rule", "conditions": rule.get("conditions"), "expected_outcome": rule.get("expected_outcome"),
                            "side_effects": rule.get("side_effects"),
                            "prove": "Set up one case that matches these conditions, with data you choose yourself, and observe the outcome and side effects."})
        for holdout in self.holdouts():
            targets.append({"id": holdout["id"], "kind": "holdout", "file": holdout["file"], "prove": "Read the file and carry out the check it describes."})
        return targets

    def required_evidence(self) -> List[Dict[str, Any]]:
        override = self.section("verify").get("required_evidence")
        app_type = str(self.info.get("app_type") or "")
        if isinstance(override, dict) and isinstance(override.get(app_type), list):
            return [{"kind": pattern, "match": [pattern]} for pattern in override[app_type] if isinstance(pattern, str)]
        return REQUIRED_EVIDENCE.get(app_type, [])

    def evidence_files(self) -> List[str]:
        if not self.evidence.is_dir():
            return []
        return sorted(p.relative_to(self.evidence).as_posix() for p in self.evidence.rglob("*")
                      if p.is_file() and not p.relative_to(self.evidence).parts[0].startswith("previous-") and not p.name.startswith("."))


def test_command(cell: Cell) -> Optional[str]:
    command = (cell.build.get("tests") or {}).get("command")
    if isinstance(command, str) and command.strip():
        return command
    for section in ("build", "audit"):
        commands = cell.section(section).get("commands")
        if isinstance(commands, dict) and isinstance(commands.get("test"), str):
            return commands["test"]
    return None


def run_logged(cell: Cell, command: str, log: Path, timeout: int = 600) -> Dict[str, Any]:
    argv = shlex.split(command)
    env = dict(os.environ)
    while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):
        key, value = argv.pop(0).split("=", 1)
        env[key] = value
    started = time.monotonic()
    if not argv or (shutil.which(argv[0]) is None and not (cell.work / argv[0]).is_file()):
        code, out = 127, f"'{argv[0] if argv else command}' is not installed or not on PATH."
    else:
        try:
            done = subprocess.run(argv, cwd=str(cell.work), capture_output=True, text=True, errors="replace", timeout=timeout, stdin=subprocess.DEVNULL, env=env)
            code, out = done.returncode, done.stdout + ("\n" + done.stderr if done.stderr else "")
        except subprocess.TimeoutExpired:
            code, out = 124, f"Still running after {timeout} seconds; stopped."
    seconds = round(time.monotonic() - started, 1)
    log.write_text(f"$ {command}\n(in {cell.work}, at {now()})\n\n{out.rstrip()}\n\nexit code: {code}\nseconds: {seconds}\n", encoding="utf-8")
    return {"command": command, "exit_code": code, "passed": code == 0, "seconds": seconds, "log": log.name}


def check_contracts(cell: Cell) -> Dict[str, Any]:
    """Each contract the plan listed must exist and be well formed; compile it where a tool is at hand."""
    lines: List[str] = []
    valid = True
    contracts = cell.info.get("contracts") or []
    for name in contracts:
        path = cell.work / name
        if not path.is_file():
            valid = False
            lines.append(f"FAIL {name}: missing from the cell.")
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if not text.strip():
            valid = False
            lines.append(f"FAIL {name}: empty.")
        elif name.endswith(".json"):
            try:
                json.loads(text)
                lines.append(f"ok   {name}: valid JSON.")
            except ValueError as exc:
                valid = False
                lines.append(f"FAIL {name}: not valid JSON: {exc}")
        elif name.endswith(".proto") and shutil.which("protoc"):
            done = subprocess.run(["protoc", f"--proto_path={cell.work}", "--descriptor_set_out=" + os.devnull, name], cwd=str(cell.work), capture_output=True, text=True)
            valid = valid and done.returncode == 0
            lines.append(f"{'ok  ' if done.returncode == 0 else 'FAIL'} {name}: protoc {'compiled it' if done.returncode == 0 else 'rejected it: ' + done.stderr.strip()[:400]}")
        elif name.endswith(".py"):
            try:
                compile(text, name, "exec")
                lines.append(f"ok   {name}: compiles.")
            except SyntaxError as exc:
                valid = False
                lines.append(f"FAIL {name}: {exc}")
        else:
            lines.append(f"ok   {name}: present (no compiler for this format was available here).")
    if not contracts:
        lines.append("The plan lists no contract files for this slice.")
    (cell.evidence / "contract-check.log").write_text(f"Contract check at {now()}\n\n" + "\n".join(lines) + "\n", encoding="utf-8")
    return {"valid": valid, "files": contracts, "log": "contract-check.log"}


def check_exit_codes(cell: Cell, targets: Sequence[Dict[str, Any]]) -> List[str]:
    """A command-line slice's exit-codes.json must really list what was run, for every check."""
    path = next((cell.evidence / name for name in cell.evidence_files() if Path(name).name == "exit-codes.json"), None)
    if path is None:
        return []  # its absence is already reported as a missing kind of evidence
    data = load_json(path)
    shape = 'exit-codes.json must be a list of {"command": "<what was run>", "exit_code": <number>, "check": "<ID>"} entries.'
    if not isinstance(data, list) or not data:
        return [shape]
    covered = set()
    for entry in data:
        if not isinstance(entry, dict) or not isinstance(entry.get("command"), str) or not entry["command"].strip() \
                or not isinstance(entry.get("exit_code"), int) or isinstance(entry.get("exit_code"), bool):
            return [shape]
        check = entry.get("check")
        covered.update(str(item) for item in (check if isinstance(check, list) else [check]) if item)
    missing = [target["id"] for target in targets if target["id"] not in covered]
    return [f"exit-codes.json has no command for: {', '.join(missing)}. Every check needs the command that was run and its exit code."] if missing else []


def changed_files(cell: Cell) -> List[str]:
    names = [line[3:].strip().strip('"') for line in git(cell.work, "status", "--porcelain", "--untracked-files=all").stdout.splitlines() if line.strip()]
    return [name for name in names if not is_byproduct(name)]


def cmd_start(cell: Cell, args: argparse.Namespace) -> int:
    stage = cell.info.get("stage")
    if stage not in ("built", "verified"):
        raise VerifyError(f"The cell's stage is '{stage}'. Only a built cell can be verified; the build station must finish first.", code="wrong-stage")
    if not cell.build or cell.build.get("status") != "BUILT":
        raise VerifyError("build-report.json is missing from the cell, so there is nothing certified as built to verify.", code="not-built")
    head = cell.head()
    if cell.build.get("head") != head:
        raise VerifyError("The cell's code changed after the build finished. Finish the build again before verifying.", code="code-changed")
    dirty = changed_files(cell)
    if dirty:
        raise VerifyError(f"The cell has uncommitted changes ({', '.join(dirty[:5])}). Verification runs exactly what was built.", code="uncommitted-changes")
    app_type = cell.info.get("app_type")
    if app_type not in REQUIRED_EVIDENCE:
        raise VerifyError(f"The cell has no usable app type ('{app_type}'). The plan sets it; regroom the ticket.")
    command = test_command(cell)
    if not command:
        raise VerifyError("No test command is recorded for this cell.")

    cell.evidence.mkdir(exist_ok=True)
    stale = [p for p in cell.evidence.iterdir() if not p.name.startswith("previous-")]
    archive = None
    if stale:
        archive = cell.evidence / f"previous-{len(list(cell.evidence.glob('previous-*'))) + 1}"
        archive.mkdir()
        for path in stale:
            path.rename(archive / path.name)
    (cell.root / RECORDS_FILE).unlink(missing_ok=True)  # an input already applied to an earlier run's results
    started = time.time()
    suite = run_logged(cell, command, cell.evidence / "test-suite.log")
    contracts = check_contracts(cell)
    targets = cell.targets()
    tools = [name for name in TOOLS if shutil.which(name)]
    if (cell.work / "node_modules" / ".bin" / "playwright").exists() and "playwright" not in tools:
        tools.append("playwright (project-local)")
    cell.results = {
        "ticket_id": cell.ticket_id, "slice_id": cell.info.get("slice_id"), "app_type": app_type, "head": head, "tools_available": tools,
        "review_loop": cell.build.get("review_loop", 0), "started_at": now(), "started_epoch": started,
        "suite": suite, "contracts": contracts, "records": {},
    }
    cell.save()
    telemetry(cell.root, "gate.evaluated", "verify", lambda: {"gate": "verify.start", "outcome": "pass", "reason_code": None, "overridden_by_reason": False})
    telemetry(cell.root, "station.entered", "verify", lambda: {
        "stage": stage, "head": lifecycle.short(head), "items": len(targets), "suite_passed": bool(suite["passed"]), "contracts_valid": bool(contracts["valid"]),
        "previous_evidence": f"evidence/{archive.name}" if archive else None})
    print(json.dumps({
        "status": "STARTED", "ticket_id": cell.ticket_id, "app_type": app_type, "workdir": str(cell.work), "evidence_dir": str(cell.evidence),
        "suite": suite, "contracts": contracts,
        "required_evidence": [item["kind"] + " (" + ", ".join(item["match"]) + ")" for item in cell.required_evidence()],
        "tools_available": tools,
        "builder_notes": {"deviations": cell.build.get("deviations", []), "tests_passing_on_first_run": cell.build.get("tests_passing_on_first_run", [])},
        "prove": targets,
        "records_file": str(cell.root / RECORDS_FILE),
        "next": "Prove each item yourself: write a driver into evidence_dir, run it with 'capture', and record each item with 'record' "
                "(or all at once with 'record --from' and the records_file).",
    }, indent=2, ensure_ascii=False))
    return 0


def evidence_path(cell: Cell, name: str, what: str) -> Path:
    """A path named relative to the evidence folder, refused if it leaves it."""
    if not isinstance(name, str) or not name.strip() or Path(name).is_absolute():
        raise VerifyError(f"{what} must be named relative to the evidence folder ({cell.evidence}), such as 'consumer-run.log'.", code="outside-evidence")
    path = (cell.evidence / name).resolve()
    if cell.evidence.resolve() not in path.parents:
        raise VerifyError(f"'{name}' is outside the evidence folder. Save evidence under {cell.evidence} and name it relative to that folder.", code="outside-evidence")
    return path


def checked_record(cell: Cell, known: Dict[str, Dict[str, Any]], target: Any, result: Any, evidence: Any, note: Any) -> Dict[str, Any]:
    """One check, with every condition a record must meet. Raises VerifyError; changes nothing."""
    if target not in known:
        raise VerifyError(f"{target} is not something this verification must prove. Expected one of: {', '.join(known)}.", code="unknown-item")
    if result not in ("pass", "fail"):
        raise VerifyError(f"{target}: the result must be 'pass' or 'fail'.")
    note = " ".join(note.split()) if isinstance(note, str) else ""
    if len(note) < 20:
        raise VerifyError("The note must say what you did and what you observed, in a sentence; for a failure, what was expected and what happened instead.")
    names = [evidence] if isinstance(evidence, str) else evidence
    if not isinstance(names, list) or not names or not all(isinstance(name, str) for name in names):
        raise VerifyError(f"{target}: name at least one evidence file, relative to the evidence folder.")
    files = []
    for name in names:
        path = evidence_path(cell, name, "Evidence")
        if not path.is_file() or path.stat().st_size == 0:
            raise VerifyError(f"Evidence file '{name}' does not exist or is empty.")
        if path.stat().st_mtime < cell.results["started_epoch"] - 1:
            raise VerifyError(f"Evidence file '{name}' is older than this verification run. Capture it again; old evidence proves nothing about this build.", code="stale-evidence")
        relative = path.relative_to(cell.evidence.resolve()).as_posix()
        if relative == "test-suite.log":
            raise VerifyError("The builder's own test run is not evidence for a check. Exercise the behavior yourself and capture that.", code="builder-evidence")
        if relative in AUTO_FILES:
            raise VerifyError(f"'{relative}' is written by this script and cannot stand as your evidence.", code="station-file-as-evidence")
        files.append({"file": relative, "sha256": sha(path), "bytes": path.stat().st_size})
    return {"id": target, "kind": known[target]["kind"], "result": result, "note": note, "evidence": files}


def records_from(cell: Cell, source: Path) -> List[Any]:
    """The checks listed in a records file the verifier wrote with its file tools (no heredoc or chained commands)."""
    path = source if source.is_absolute() else Path.cwd() / source
    if not path.is_file() and not source.is_absolute() and (cell.root / source).is_file():
        path = cell.root / source
    resolved = path.resolve()
    if resolved == cell.evidence.resolve() or cell.evidence.resolve() in resolved.parents:
        raise VerifyError(f"The records file must not be in the evidence folder, where it would count as evidence. Write it to {cell.root / RECORDS_FILE}.",
                          code="records-in-evidence")
    data = load_json(path)
    if data is None:
        raise VerifyError(f"{source} is missing or is not valid JSON.", code="records-unreadable")
    if not isinstance(data, list) or not data or not all(isinstance(item, dict) for item in data):
        raise VerifyError('The records file must be a JSON list of {"id": "AC-01", "result": "pass" or "fail", "evidence": ["<file in the evidence folder>"], '
                          '"note": "<what you did and what you observed>"} objects.', code="records-invalid")
    ids = [item.get("id") for item in data]
    repeated = sorted({str(item) for item in ids if ids.count(item) > 1})
    if repeated:
        raise VerifyError(f"The records file lists {', '.join(repeated)} more than once.", code="records-invalid")
    return data


def cmd_record(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    known = {target["id"]: target for target in cell.targets()}
    if args.records_from is not None:
        if args.target or args.result or args.evidence or args.note:
            raise VerifyError("Give either --from with a records file, or one check (ID, --result, --evidence, --note), not both.")
        items = records_from(cell, args.records_from)
        # Every check is validated before any is recorded: a file with one bad entry records nothing.
        records = [checked_record(cell, known, item.get("id"), item.get("result"), item.get("evidence"), item.get("note")) for item in items]
    else:
        missing = [flag for flag, value in (("an item ID", args.target), ("--result", args.result), ("--evidence", args.evidence), ("--note", args.note)) if not value]
        if missing:
            raise VerifyError(f"record needs {', '.join(missing)} (or --from with a records file).")
        records = [checked_record(cell, known, args.target, args.result, args.evidence, args.note)]
    for record in records:
        cell.results["records"][record["id"]] = {"kind": record["kind"], "result": record["result"], "note": record["note"], "evidence": record["evidence"], "at": now()}
    cell.save()
    for record in records:
        telemetry(cell.root, "verify.check_recorded", "verify", lambda record=record: {
            "item": record["id"], "kind": record["kind"], "result": record["result"],
            "evidence": [{"path": f"evidence/{entry['file']}", "sha256": entry["sha256"]} for entry in record["evidence"]]})
    remaining = [target for target in known if target not in cell.results["records"]]
    if len(records) == 1:
        print(json.dumps({"status": "RECORDED", "id": records[0]["id"], "result": records[0]["result"], "remaining": remaining or "none; run finish"}, indent=2))
    else:
        print(json.dumps({"status": "RECORDED", "ids": [record["id"] for record in records], "results": {record["id"]: record["result"] for record in records},
                          "remaining": remaining or "none; run finish"}, indent=2))
    return 0


def cmd_capture(cell: Cell, args: argparse.Namespace) -> int:
    """Run the verifier's own Python driver from the evidence folder and save what it printed as evidence.

    It runs exactly `<this interpreter> -B <driver> <args>`, with the cell's workdir as the current directory
    and on the import path, and writes a transcript (the command, its output, its errors, exit code and time)
    to the named file. It replaces a shell redirect; it runs nothing the tool list did not already allow."""
    cell.require_started()
    if not 1 <= args.timeout <= 3600:
        raise VerifyError("--timeout is in seconds, from 1 to 3600.")
    driver = evidence_path(cell, args.driver, "The driver")
    if driver.suffix != ".py" or not driver.is_file():
        raise VerifyError(f"'{args.driver}' is not a Python script in the evidence folder. Write the driver there with your file tools first.", code="no-driver")
    out = evidence_path(cell, args.out, "The output file")
    relative = out.relative_to(cell.evidence.resolve()).as_posix()
    if relative in AUTO_FILES or relative.split("/")[0].startswith("previous-") or out == driver or out.suffix == ".py":
        raise VerifyError(f"'{relative}' cannot be written by capture: it is the driver, a script, an earlier run's evidence, or a file this station writes itself.",
                          code="reserved-file")
    stdin = None
    if args.input:
        stdin = evidence_path(cell, args.input, "The input file")
        if not stdin.is_file():
            raise VerifyError(f"Input file '{args.input}' does not exist in the evidence folder.", code="no-input")
    passed = list(args.args or [])
    if passed and passed[0] == "--":
        passed = passed[1:]
    argv = [sys.executable, "-B", str(driver), *passed]
    env = dict(os.environ)
    env.update({"PYTHONDONTWRITEBYTECODE": "1", "MACH_VERIFY_WORKDIR": str(cell.work), "MACH_VERIFY_EVIDENCE": str(cell.evidence),
                "PYTHONPATH": os.pathsep.join([str(cell.work), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])])})
    shown = " ".join(shlex.quote(part) for part in ["python3", "-B", f"evidence/{driver.relative_to(cell.evidence.resolve()).as_posix()}", *passed])
    started = time.monotonic()
    try:
        with (stdin.open("rb") if stdin else open(os.devnull, "rb")) as feed:
            done = subprocess.run(argv, cwd=str(cell.work), stdin=feed, capture_output=True, timeout=args.timeout, env=env)
        code = done.returncode
        output, errors = done.stdout.decode("utf-8", "replace"), done.stderr.decode("utf-8", "replace")
    except subprocess.TimeoutExpired as exc:
        code = 124
        output = (exc.stdout or b"").decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        errors = f"Still running after {args.timeout} seconds; stopped."
    seconds = round(time.monotonic() - started, 1)
    out.parent.mkdir(parents=True, exist_ok=True)
    text = (f"$ {shown}" + (f" < evidence/{args.input}" if args.input else "") + f"\n(in {cell.work}, at {now()})\n\n"
            f"--- standard output ---\n{output.rstrip()}\n\n--- standard error ---\n{errors.rstrip()}\n\nexit code: {code}\nseconds: {seconds}\n")
    out.write_text(text, encoding="utf-8")
    print(json.dumps({"status": "CAPTURED", "file": relative, "exit_code": code, "seconds": seconds, "bytes": out.stat().st_size,
                      "next": f"Read evidence/{relative}, then record what it shows."}, indent=2))
    return 0


def cmd_finish(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    records = cell.results["records"]
    targets = cell.targets()
    suite, contracts = cell.results["suite"], cell.results["contracts"]
    incomplete: List[str] = []
    if changed_files(cell):
        incomplete.append("The cell's code has uncommitted changes. A verifier never edits the cell's code; discard them and start again.")
    missing = [target["id"] for target in targets if target["id"] not in records]
    if missing:
        incomplete.append(f"Not proven yet: {', '.join(missing)}.")
    files = cell.evidence_files()
    captured = [name for name in files if name not in AUTO_FILES]
    for item in cell.required_evidence():
        if not any(fnmatch.fnmatch(Path(name).name.lower(), pattern.lower()) for name in captured for pattern in item["match"]):
            incomplete.append(f"No {item['kind']} was captured (expected a file like {', '.join(item['match'])}).")
    if cell.results["app_type"] == "cli":
        incomplete += check_exit_codes(cell, targets)
    for target_id, record in records.items():
        for entry in record["evidence"]:
            path = cell.evidence / entry["file"]
            if not path.is_file() or sha(path) != entry["sha256"]:
                incomplete.append(f"Evidence for {target_id} changed or disappeared after it was recorded: {entry['file']}. Record it again.")

    failures = [f"{target_id} ({record['kind']}): {record['note']}" for target_id, record in records.items() if record["result"] == "fail"]
    if not suite["passed"]:
        failures.append(f"The test suite fails when rerun in the cell (exit code {suite['exit_code']}); see evidence/{suite['log']}.")
    if not contracts["valid"]:
        failures.append(f"A contract file is missing or malformed; see evidence/{contracts['log']}.")

    status = "FAIL_WITH_EVIDENCE" if failures else "INCOMPLETE_EVIDENCE" if incomplete else "PASS"
    if status == "INCOMPLETE_EVIDENCE":
        telemetry(cell.root, "gate.evaluated", "verify", lambda: {"gate": "verify.finish", "outcome": "refuse", "reason_code": "incomplete-evidence",
                                                                  "overridden_by_reason": False, "problems": len(incomplete), "unproven": missing})
        print("INCOMPLETE_EVIDENCE:\n- " + "\n- ".join(incomplete))
        return 1

    holdout_kinds = ("matrix rule", "holdout")
    summary = {
        "ticket_id": cell.ticket_id, "slice_id": cell.info.get("slice_id"), "app_type": cell.results["app_type"], "status": status,
        "contract_valid": contracts["valid"],
        "holdout_tests_passed": all(r["result"] == "pass" for r in records.values() if r["kind"] in holdout_kinds) and not missing,
        "head": cell.results["head"], "review_loop": cell.results["review_loop"], "suite": suite,
        "checks": {target_id: {"kind": r["kind"], "result": r["result"], "note": r["note"], "evidence": [e["file"] for e in r["evidence"]]} for target_id, r in records.items()},
        "unproven": missing,
        "evidence_files": [{"file": name, "sha256": sha(cell.evidence / name)} for name in files if name not in ("summary.json", "results.json")],
        "evidence_kinds": {item["kind"]: [name for name in captured if any(fnmatch.fnmatch(Path(name).name.lower(), p.lower()) for p in item["match"])]
                           for item in cell.required_evidence()},
        "tools_available": cell.results.get("tools_available", []),
        "failures": failures, "timestamp": now(),
    }
    if failures:
        findings = [f"# Verification findings for {cell.ticket_id} (review loop {cell.results['review_loop']})", "",
                    "Each item is a behavior that does not match the spec. Evidence is in the cell's evidence/ folder.", ""]
        findings += [f"{index}. {failure}" for index, failure in enumerate(failures, start=1)]
        (cell.evidence / "findings.md").write_text("\n".join(findings) + "\n", encoding="utf-8")
        summary["evidence_files"].append({"file": "findings.md", "sha256": sha(cell.evidence / "findings.md")})
    (cell.evidence / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    cell.info["stage"] = "verified" if status == "PASS" else "built"
    cell.info["verification"] = status
    cell.save_info()
    telemetry(cell.root, "gate.evaluated", "verify", lambda: {"gate": "verify.verdict", "outcome": "pass" if status == "PASS" else "refuse",
                                                              "reason_code": status, "overridden_by_reason": False})
    telemetry(cell.root, "station.exited", "verify", lambda: {
        "outcome": status, "stage": cell.info["stage"], "checks_passed": sum(1 for r in records.values() if r["result"] == "pass"),
        "checks_failed": sum(1 for r in records.values() if r["result"] == "fail"), "suite_passed": bool(suite["passed"]), "contracts_valid": bool(contracts["valid"])})
    passed = sum(1 for r in records.values() if r["result"] == "pass")
    print(json.dumps({
        "status": status, "summary": str(cell.evidence / "summary.json"), "checks_passed": passed, "checks_failed": len(records) - passed,
        "evidence_files": len(summary["evidence_files"]), "failures": failures,
        "next": "Ready for the review station." if status == "PASS"
        else f"Return the ticket to the build station: build revise {cell.ticket_id} --findings {cell.evidence / 'findings.md'}",
    }, indent=2, ensure_ascii=False))
    return 0 if status == "PASS" else 1


def cmd_status(cell: Cell, args: argparse.Namespace) -> int:
    targets = cell.targets()
    records = cell.results.get("records") or {}
    print(json.dumps({
        "ticket_id": cell.ticket_id, "stage": cell.info.get("stage"), "verification": cell.info.get("verification"),
        "started": bool(cell.results.get("started_at")) and cell.results.get("head") == cell.head(),
        "proven": [t["id"] for t in targets if records.get(t["id"], {}).get("result") == "pass"],
        "failed": [t["id"] for t in targets if records.get(t["id"], {}).get("result") == "fail"],
        "remaining": [t["id"] for t in targets if t["id"] not in records],
    }, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MACH verify station gates.")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, func, text in (("start", cmd_start, "check the gates and print what must be proven"), ("finish", cmd_finish, "give the verdict and write summary.json"),
                             ("status", cmd_status, "show what is proven, failed and remaining")):
        p = sub.add_parser(name, help=text)
        p.add_argument("ticket_id")
        p.set_defaults(func=func)
    p = sub.add_parser("record", help="record one proven or failed check with its evidence, or several from a file")
    p.add_argument("ticket_id")
    p.add_argument("target", nargs="?", help="the scenario, rule or holdout ID, such as AC-03 or R2")
    p.add_argument("--result", choices=("pass", "fail"))
    p.add_argument("--evidence", action="append", help="evidence file, relative to the evidence folder (repeatable)")
    p.add_argument("--note", help="what you did and what you observed")
    p.add_argument("--from", dest="records_from", type=Path, metavar="FILE",
                   help=f"a JSON list of checks, each {{id, result, evidence, note}}, written outside the evidence folder (start prints the path: {RECORDS_FILE} in the cell)")
    p.set_defaults(func=cmd_record)
    p = sub.add_parser("capture", help="run a Python driver from the evidence folder and save its transcript as evidence")
    p.add_argument("ticket_id")
    p.add_argument("driver", help="the driver script, relative to the evidence folder, such as driver.py")
    p.add_argument("--out", required=True, help="the transcript file to write, relative to the evidence folder, such as consumer-run.log")
    p.add_argument("--input", help="a file in the evidence folder to feed the driver as its standard input")
    p.add_argument("--timeout", type=int, default=CAPTURE_TIMEOUT, help="seconds before the driver is stopped")
    p.add_argument("args", nargs="*", help="after --: arguments passed to the driver")
    p.set_defaults(func=cmd_capture)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    project = None
    try:
        project = args.project.resolve() if args.project else find_project(Path.cwd())
        return args.func(Cell(project, args.ticket_id), args)
    except VerifyError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        if project is not None and args.command != "status":
            telemetry(project / ".factory" / "worktrees" / args.ticket_id, "gate.evaluated", "verify", lambda: {
                "gate": f"verify.{args.command}", "outcome": "refuse", "reason_code": exc.code, "overridden_by_reason": False, "item": getattr(args, "target", None)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
