#!/usr/bin/env python3
"""MACH verify station: turn "it works" into evidence someone else can inspect.

The verifier (a model, in a fresh context) runs the built slice the way its user would and
captures what happened. This script decides everything a script can decide: whether verification
may start, what must be proven, whether each claim has a real, fresh evidence file behind it,
and the verdict.

    verify.py start <ticket>     check the gates, rerun the suite and contract checks, print what to prove
    verify.py record <ticket> <ID> --result pass|fail --evidence FILE --note "what was observed"
    verify.py finish <ticket>    verdict: PASS, FAIL_WITH_EVIDENCE or INCOMPLETE_EVIDENCE
    verify.py status <ticket>

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


class VerifyError(Exception):
    """A gate refused. Printed without a traceback; exit code 1."""


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
            raise VerifyError(f"Verification has not started for this build of {self.ticket_id}. Run: verify.py start {self.ticket_id}")

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


def changed_files(cell: Cell) -> List[str]:
    return [line[3:] for line in git(cell.work, "status", "--porcelain", "--untracked-files=all").stdout.splitlines() if line.strip()]


def cmd_start(cell: Cell, args: argparse.Namespace) -> int:
    stage = cell.info.get("stage")
    if stage not in ("built", "verified"):
        raise VerifyError(f"The cell's stage is '{stage}'. Only a built cell can be verified; the build station must finish first.")
    if not cell.build or cell.build.get("status") != "BUILT":
        raise VerifyError("build-report.json is missing from the cell, so there is nothing certified as built to verify.")
    head = cell.head()
    if cell.build.get("head") != head:
        raise VerifyError("The cell's code changed after the build finished. Finish the build again before verifying.")
    dirty = changed_files(cell)
    if dirty:
        raise VerifyError(f"The cell has uncommitted changes ({', '.join(dirty[:5])}). Verification runs exactly what was built.")
    app_type = cell.info.get("app_type")
    if app_type not in REQUIRED_EVIDENCE:
        raise VerifyError(f"The cell has no usable app type ('{app_type}'). The plan sets it; regroom the ticket.")
    command = test_command(cell)
    if not command:
        raise VerifyError("No test command is recorded for this cell.")

    cell.evidence.mkdir(exist_ok=True)
    stale = [p for p in cell.evidence.iterdir() if not p.name.startswith("previous-")]
    if stale:
        archive = cell.evidence / f"previous-{len(list(cell.evidence.glob('previous-*'))) + 1}"
        archive.mkdir()
        for path in stale:
            path.rename(archive / path.name)
    started = time.time()
    suite = run_logged(cell, command, cell.evidence / "test-suite.log")
    contracts = check_contracts(cell)
    targets = cell.targets()
    cell.results = {
        "ticket_id": cell.ticket_id, "slice_id": cell.info.get("slice_id"), "app_type": app_type, "head": head,
        "review_loop": cell.build.get("review_loop", 0), "started_at": now(), "started_epoch": started,
        "suite": suite, "contracts": contracts, "records": {},
    }
    cell.save()
    tools = [name for name in TOOLS if shutil.which(name)]
    if (cell.work / "node_modules" / ".bin" / "playwright").exists() and "playwright" not in tools:
        tools.append("playwright (project-local)")
    print(json.dumps({
        "status": "STARTED", "ticket_id": cell.ticket_id, "app_type": app_type, "workdir": str(cell.work), "evidence_dir": str(cell.evidence),
        "suite": suite, "contracts": contracts,
        "required_evidence": [item["kind"] + " (" + ", ".join(item["match"]) + ")" for item in cell.required_evidence()],
        "tools_available": tools,
        "builder_notes": {"deviations": cell.build.get("deviations", []), "tests_passing_on_first_run": cell.build.get("tests_passing_on_first_run", [])},
        "prove": targets,
        "next": "Prove each item yourself, save what you capture under evidence_dir, and record each with 'record'.",
    }, indent=2, ensure_ascii=False))
    return 0


def cmd_record(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    known = {target["id"]: target for target in cell.targets()}
    if args.target not in known:
        raise VerifyError(f"{args.target} is not something this verification must prove. Expected one of: {', '.join(known)}.")
    note = " ".join(args.note.split())
    if len(note) < 20:
        raise VerifyError("The note must say what you did and what you observed, in a sentence; for a failure, what was expected and what happened instead.")
    files = []
    for name in args.evidence:
        path = (cell.evidence / name).resolve()
        if cell.evidence.resolve() not in path.parents:
            raise VerifyError(f"'{name}' is outside the evidence folder. Save evidence under {cell.evidence} and name it relative to that folder.")
        if not path.is_file() or path.stat().st_size == 0:
            raise VerifyError(f"Evidence file '{name}' does not exist or is empty.")
        if path.stat().st_mtime < cell.results["started_epoch"] - 1:
            raise VerifyError(f"Evidence file '{name}' is older than this verification run. Capture it again; old evidence proves nothing about this build.")
        relative = path.relative_to(cell.evidence.resolve()).as_posix()
        if relative == "test-suite.log":
            raise VerifyError("The builder's own test run is not evidence for a check. Exercise the behavior yourself and capture that.")
        if relative in AUTO_FILES:
            raise VerifyError(f"'{relative}' is written by this script and cannot stand as your evidence.")
        files.append({"file": relative, "sha256": sha(path), "bytes": path.stat().st_size})
    cell.results["records"][args.target] = {"kind": known[args.target]["kind"], "result": args.result, "note": note, "evidence": files, "at": now()}
    cell.save()
    remaining = [target for target in known if target not in cell.results["records"]]
    print(json.dumps({"status": "RECORDED", "id": args.target, "result": args.result, "remaining": remaining or "none; run finish"}, indent=2))
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
    p = sub.add_parser("record", help="record one proven or failed check with its evidence")
    p.add_argument("ticket_id")
    p.add_argument("target", help="the scenario, rule or holdout ID, such as AC-03 or R2")
    p.add_argument("--result", choices=("pass", "fail"), required=True)
    p.add_argument("--evidence", action="append", required=True, help="evidence file, relative to the evidence folder (repeatable)")
    p.add_argument("--note", required=True, help="what you did and what you observed")
    p.set_defaults(func=cmd_record)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        project = args.project.resolve() if args.project else find_project(Path.cwd())
        return args.func(Cell(project, args.ticket_id), args)
    except VerifyError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
