#!/usr/bin/env python3
"""MACH Factory evals (M14 part B): past tickets kept as a suite, replayed when the Factory's own rules, skills or models change.

Reached through the run skill's script, never on its own:

    run.py eval collect [--ticket T]...                cases from merged tickets' archives, redacted
    run.py eval add --from-ticket T --reason WHY [--must-pass]
                                                       an escaped defect: the ticket's case, with the defect as a holdout check
    run.py eval add --spec FILE --base COMMIT --reason WHY [--intent FILE] [--title T] [--must-pass]
                                                       a case written by hand
    run.py eval add --case C --must-pass | --no-must-pass
    run.py eval status [--ticket T]                    cases, the last run, and what changed in the configuration since (digests)
    run.py eval run --plan --budget USD [--cases C...] [--limit n] [--ticket T] [--max-minutes M]
                                                       what would run, its ceiling, the boundary and a confirmation code; spends nothing
    run.py eval run --confirm CODE --accept-execution-risk [--keep]
                                                       run exactly what the plan named, on a person's yes
    run.py eval compare RUN RUN                        deterministic: pass rate, cases that changed outcome, cost and time
    run.py eval show CASE|RUN|COMPARISON

Where things are kept:

    .factory/evals/cases/<case-id>/   case.json, spec.md, spec.json, intent.md, holdout.md. Shareable: commit them, so a
                                      team keeps one suite. Redacted with the ticket station's shared rules; no evidence media.
    .factory/evals/runs/              <run-id>/run.json, compare-<a>-<b>.json, the pending plan. Git-ignored: machine-local results.

A replay goes from planning through verification (never review, never merge) in a throwaway clone outside the project:
a new folder under the system's temporary folder, filled by `git fetch` from the project's path with no remote ever
configured, `protocol.allow never` set after that one fetch, the local Markdown ticket queue, and the configuration
under test laid over the case's base commit. Each case is one execution through the supervisor's own executor
(executor.py): the same restricted mode, no MCP server, permission prompts refused, the default tool list (never a
machine's extra tools), a spending limit and a session ID. Nothing here reads the machine-local Factory authorization
(the policy file under .factory/local) or enables anything. The clone is removed afterwards unless --keep.

The configuration under test is: the rule files (CLAUDE.md, REVIEW.md, AGENTS.md), MACH's skills, agents and workflow,
and the model tiers in .factory/config.json. It comes from the main checkout's working tree, or with --ticket from that
cell's branch head (a factory-tuning change). Its digest is what `status` and `compare` speak of.

Standard library only.
"""

import contextlib
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

CASE_SCHEMA = 1
RUN_SCHEMA = 1
COMPARE_SCHEMA = 1
CASES = Path(".factory") / "evals" / "cases"
RUNS = Path(".factory") / "evals" / "runs"
RULE_FILES = ("CLAUDE.md", "REVIEW.md", "AGENTS.md")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
RUN_ID_RE = re.compile(r"^eval-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$")
SHA_RE = re.compile(r"^[0-9a-f]{40,64}$")
SLICE_NAME_RE = re.compile(r"^SLICE-[0-9]{3,}[A-Za-z0-9_.-]*\.md$")
# What a case keeps from an archive: the cell's own records, never evidence media, never the branch bundle.
ARCHIVE_MEMBERS = ("cell.json", "spec.md", "spec.json", "intent.md", "build.json", "build-report.json", "evidence/summary.json")
MEMBER_LIMIT = 2 * 1024 * 1024
SPEC_LIMIT = 256 * 1024
REASON_LIMIT = 2000
TITLE_LIMIT = 200
CONFIRM_MINUTES = 10
MIN_CASE_USD = 1.0
MAX_CASE_USD = 500.0          # the supervisor's own per-execution maximum (policy.LIMITS)
MINUTES = (120, 5, 720)       # default, lowest, highest: the supervisor's own bounds for one execution
STOP_BEFORE = "review"        # a replay ends before review: never review, never merge
VERDICTS = ("PASS", "FAIL_WITH_EVIDENCE", "INCOMPLETE_EVIDENCE")
PLANNED_STAGES = ("planned", "building", "built", "verified", "awaiting-human", "approved", "pr-open", "merged")
EXECUTION_ENV = "MACH_EXECUTION_ID"
CLONE_PREFIX = "mach-eval-"
NOT_EVALUATED = "not evaluated"
IDENTITY = (("user.name", "MACH eval"), ("user.email", "mach-eval@localhost.invalid"), ("commit.gpgsign", "false"))


class EvalError(Exception):
    """A refusal or a problem the caller can fix; printed without a traceback."""


def now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(moment: Optional[datetime] = None) -> str:
    return (moment or now()).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_stamp(value: Any) -> Optional[datetime]:
    try:
        return datetime.strptime(str(value), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def git(cwd: Path, *args: str, check: bool = False) -> subprocess.CompletedProcess:
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env["GIT_TERMINAL_PROMPT"] = "0"
    done = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, errors="replace", env=env)
    if check and done.returncode != 0:
        raise EvalError(f"git {args[0]} failed: {(done.stderr.strip().splitlines() or ['no message'])[-1][:300]}")
    return done


def load_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        if path.is_symlink() or path.stat().st_size > MEMBER_LIMIT:
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(str(temporary), str(path))


def number(value: Any) -> Optional[float]:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def whole(value: Any) -> Optional[int]:
    return value if type(value) is int else None


def inside(path: Path, folder: Path) -> bool:
    try:
        Path(path).resolve().relative_to(Path(folder).resolve())
        return True
    except ValueError:
        return False


def refuse_in_execution(what: str) -> None:
    """Eval work is a person's, in conversation. Inside a supervised Factory execution (or a replay itself) it is refused."""
    if os.environ.get(EXECUTION_ENV):
        raise EvalError(f"{what} is a person's command, in conversation; it is refused inside a supervised Factory execution, and a replay cannot start another.")


class Evals:
    """The eval suite of one project. `sibling` finds another station's skill folder; `executor`, `policy` and `provenance`
    are the run skill's own modules, passed in so the boundary is exactly the supervisor's."""

    def __init__(self, root: Path, config: Dict[str, Any], *, sibling: Callable[[str], Path], run_script: Path,
                 executor: Any = None, policy: Any = None, provenance: Any = None) -> None:
        self.root = Path(root).resolve()
        self.config = config if isinstance(config, dict) else {}
        self.sibling = sibling
        self.run_script = Path(run_script).resolve()
        self.executor, self.policy, self.provenance = executor, policy, provenance
        self._rules: Any = None

    # ---- shared pieces ----

    @property
    def cases_dir(self) -> Path:
        return self.root / CASES

    @property
    def runs_dir(self) -> Path:
        return self.root / RUNS

    def issue_rules(self) -> Any:
        """The ticket station's redaction and bounding, loaded from its folder, never copied."""
        if self._rules is None:
            import importlib.util
            path = self.sibling("ticket") / "scripts" / "issue_rules.py"
            spec = importlib.util.spec_from_file_location("mach_eval_issue_rules", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self._rules = module
        return self._rules

    def redact(self, text: str, limit: Optional[int] = None) -> Tuple[str, bool]:
        rules = self.issue_rules()
        cleaned = rules.redact(text)
        changed = cleaned != text
        if limit is not None:
            cleaned, cut = rules.bound_text(cleaned, limit)
            changed = changed or cut
        return cleaned, changed

    def redact_data(self, value: Any) -> Tuple[Any, bool]:
        if isinstance(value, str):
            return self.redact(value)
        if isinstance(value, list):
            pairs = [self.redact_data(item) for item in value]
            return [item for item, _ in pairs], any(flag for _, flag in pairs)
        if isinstance(value, dict):
            pairs = {key: self.redact_data(item) for key, item in value.items()}
            return {key: item for key, (item, _) in pairs.items()}, any(flag for _, flag in pairs.values())
        return value, False

    def install_kind(self) -> str:
        skill = self.run_script.parent.parent
        return "project" if skill.name == "mach" or skill.name.startswith("mach-") else "plugin"

    def plugin_folder(self) -> Path:
        return self.run_script.parent.parent.parent.parent

    # ---- cases ----

    def case_ids(self) -> List[str]:
        folder = self.cases_dir
        return sorted(path.name for path in folder.iterdir() if path.is_dir() and not path.is_symlink() and ID_RE.match(path.name)
                      and (path / "case.json").is_file()) if folder.is_dir() else []

    def case(self, case_id: str) -> Dict[str, Any]:
        if not ID_RE.match(case_id or ""):
            raise EvalError(f"'{case_id}' is not a case ID.")
        data = load_json(self.cases_dir / case_id / "case.json")
        if data is None or data.get("schema") != CASE_SCHEMA:
            raise EvalError(f"There is no readable case '{case_id}' (version {CASE_SCHEMA}) in {CASES}.")
        return data

    def runs_log(self) -> List[Dict[str, Any]]:
        try:
            lines = (self.root / ".factory" / "archive" / "runs.jsonl").read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return []
        found = []
        for line in lines:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict) and isinstance(record.get("ticket_id"), str) and ID_RE.match(record["ticket_id"]):
                found.append(record)
        return found

    def archive_path(self, record: Dict[str, Any]) -> Optional[Path]:
        folder = (self.root / ".factory" / "archive").resolve()
        named = record.get("archive")
        candidates = []
        if isinstance(named, str) and named:
            candidates.append(Path(named) if Path(named).is_absolute() else self.root / named)
        if "archive" not in record:  # an old record naming none; a null archive was not kept, and an older life's is not this one
            candidates.append(folder / f"{record['ticket_id']}.tar.gz")
        for path in candidates:
            if path.is_file() and not path.is_symlink() and inside(path, folder):
                return path
        return None

    def read_archive(self, path: Path, ticket_id: str) -> Dict[str, bytes]:
        """Only the cell's own records, read straight from the archive, never extracted to disk. Media, bundles and
        uncommitted work are never read."""
        found: Dict[str, bytes] = {}
        try:
            with tarfile.open(str(path), "r:gz") as tar:
                for member in tar:
                    if not member.isfile() or not member.name.startswith(ticket_id + "/"):
                        continue
                    name = member.name[len(ticket_id) + 1:]
                    if name in ARCHIVE_MEMBERS and member.size <= MEMBER_LIMIT:
                        handle = tar.extractfile(member)
                        if handle is not None:
                            found[name] = handle.read(MEMBER_LIMIT + 1)
        except (OSError, tarfile.TarError, EOFError) as exc:
            raise EvalError(f"The archive {path.name} could not be read: {exc}")
        return found

    def base_commit(self, cell: Dict[str, Any], record: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
        """Where the work started. With a merge commit: where the branch left the default branch (the merge-base of the
        spec commit and the merge's first parent). Otherwise the spec commit's parent. Never guessed beyond that."""

        def commit(ref: str) -> Optional[str]:
            done = git(self.root, "rev-parse", "--verify", "-q", "--end-of-options", ref + "^{commit}")
            value = done.stdout.strip()
            return value if done.returncode == 0 and SHA_RE.match(value) else None

        spec_commit = cell.get("spec_commit") if isinstance(cell.get("spec_commit"), str) and SHA_RE.match(cell["spec_commit"]) else None
        integration = record.get("integration") if isinstance(record.get("integration"), dict) else {}
        merge = integration.get("merge_commit") if isinstance(integration.get("merge_commit"), str) and SHA_RE.match(integration["merge_commit"]) else None
        start = spec_commit and commit(spec_commit)
        if merge and commit(merge) and commit(merge + "^2") and start:
            before = commit(merge + "^1")
            fork = git(self.root, "merge-base", start, before).stdout.strip() if before else ""
            if SHA_RE.match(fork) and fork != start:
                return fork, "where the branch left the default branch (merge-base of the spec commit and the merge's first parent)"
        if start and commit(start + "^1"):
            return commit(start + "^1"), "the parent of the commit that added the spec"
        return None, None

    def recorded(self, record: Dict[str, Any], members: Dict[str, bytes]) -> Dict[str, Any]:
        """What happened the first time, from the run record and the archived cell. A value not recorded is null."""

        def member(name: str) -> Dict[str, Any]:
            try:
                data = json.loads(members.get(name, b"").decode("utf-8"))
            except (UnicodeError, ValueError):
                return {}
            return data if isinstance(data, dict) else {}

        summary, build, report = member("evidence/summary.json"), member("build.json"), member("build-report.json")
        names = set()
        for task in build.get("tasks") or [] if isinstance(build.get("tasks"), list) else []:
            ran = task.get("tests_first_run") if isinstance(task, dict) and isinstance(task.get("tests_first_run"), dict) else {}
            for key in ("failed", "passed"):
                names.update(str(name)[:200] for name in ran.get(key) or [] if isinstance(name, str))
        files = report.get("test_files") if isinstance(report.get("test_files"), list) else build.get("test_files") if isinstance(build.get("test_files"), list) else None
        deviations = record.get("deviations") if isinstance(record.get("deviations"), list) else None
        return {
            "outcome": record.get("outcome") if isinstance(record.get("outcome"), str) else None,
            "verdict": summary.get("status") if summary.get("status") in VERDICTS else None,
            "rounds": whole(record.get("rounds")), "first_pass": record.get("first_pass") if isinstance(record.get("first_pass"), bool) else None,
            "verify_failures": whole(record.get("verify_failures")), "review_rejections": whole(record.get("review_rejections")),
            "deviations": None if deviations is None else [{"type": str(item.get("type") or "")[:60], "task": str(item.get("task"))[:20] if item.get("task") else None}
                                                           for item in deviations if isinstance(item, dict)],
            "tests": {"files": sorted(str(name)[:300] for name in files if isinstance(name, str)) if files is not None else None,
                      "names": sorted(names) if names else None},
        }

    def new_case_id(self, wanted: str) -> str:
        case_id, number_ = wanted, 1
        while (self.cases_dir / case_id).exists():
            number_ += 1
            case_id = f"{wanted}-{number_}"
        return case_id

    def write_case(self, case_id: str, case: Dict[str, Any], files: Dict[str, str]) -> None:
        folder = self.cases_dir / case_id
        if folder.is_symlink() or self.cases_dir.is_symlink():
            raise EvalError(f"{folder} is a symbolic link; no case is written through one.")
        folder.mkdir(parents=True, exist_ok=True)
        for name, text in files.items():
            (folder / name).write_text(text, encoding="utf-8")
        write_json(folder / "case.json", case)

    def case_from_archive(self, record: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, str]]:
        ticket_id = record["ticket_id"]
        path = self.archive_path(record)
        if path is None and "archive" in record and record.get("archive") is None:
            raise EvalError(f"{ticket_id}'s archive was not kept after cleanup (cleanup.archive), so no case can be made from it. "
                            "To keep the next one's, set cleanup.archive to \"all\" or clean it up with cleanup.py run --keep-archive.")
        if path is None:
            raise EvalError(f"{ticket_id} has no archive in .factory/archive, so no case can be made from it.")
        members = self.read_archive(path, ticket_id)
        if "cell.json" not in members or "spec.md" not in members:
            raise EvalError(f"The archive of {ticket_id} holds no cell.json or spec.md, so there is no spec to replay.")
        try:
            cell = json.loads(members["cell.json"].decode("utf-8"))
            spec_text = members["spec.md"].decode("utf-8")
        except (UnicodeError, ValueError):
            raise EvalError(f"The archive of {ticket_id} holds a cell.json or spec.md that cannot be read.")
        if not isinstance(cell, dict):
            raise EvalError(f"The archive of {ticket_id} holds a cell.json that is not an object.")
        if len(spec_text.encode("utf-8")) > SPEC_LIMIT:
            raise EvalError(f"The spec of {ticket_id} is larger than {SPEC_LIMIT // 1024} KB; it is not kept as a case.")
        redacted = False
        spec_text, flag = self.redact(spec_text)
        redacted |= flag
        files = {"spec.md": spec_text}
        spec_data = None
        if "spec.json" in members:
            try:
                spec_data = json.loads(members["spec.json"].decode("utf-8"))
            except (UnicodeError, ValueError):
                spec_data = None
        if spec_data is not None:
            spec_data, flag = self.redact_data(spec_data)
            redacted |= flag
            files["spec.json"] = json.dumps(spec_data, indent=2, ensure_ascii=False) + "\n"
        if "intent.md" in members:
            try:
                intent, flag = self.redact(members["intent.md"].decode("utf-8"), 20000)
                redacted |= flag
                files["intent.md"] = intent
            except UnicodeError:
                pass
        title, flag = self.redact(str(record.get("title") or cell.get("title") or ""), TITLE_LIMIT)
        redacted |= flag
        spec_path = cell.get("spec_path") if isinstance(cell.get("spec_path"), str) else ""
        name = Path(spec_path).name if SLICE_NAME_RE.match(Path(spec_path).name or "") else None
        slice_id = cell.get("slice_id") if isinstance(cell.get("slice_id"), str) and re.match(r"^SLICE-[0-9]{3,}$", cell["slice_id"]) else None
        base, how = self.base_commit(cell, record)
        case = {
            "schema": CASE_SCHEMA, "kind": "archive",
            "source": {"ticket_id": ticket_id, "archive": path.name, "archive_sha256": sha(path.read_bytes()), "slice_id": slice_id},
            "title": " ".join(title.split()),
            "risk": cell.get("risk") if cell.get("risk") in ("Low", "Medium", "High") else None,
            "app_type": cell.get("app_type") if isinstance(cell.get("app_type"), str) and re.match(r"^[a-z][a-z0-9_-]{0,31}$", cell["app_type"]) else None,
            "base_commit": base, "base_commit_from": how,
            "spec": {"file": "spec.md", "name": name or (f"{slice_id}-replay.md" if slice_id else None), "sha256": sha(spec_text.encode("utf-8")),
                     "data": "spec.json" if "spec.json" in files else None},
            "intent": "intent.md" if "intent.md" in files else None,
            "holdout": None,
            "recorded": self.recorded(record, members),
            "must_pass": False, "reason": None,
            "redaction": {"rules": "the ticket station's shared redaction (issue_rules.redact)", "changed_something": redacted},
            "collected_at": stamp(),
        }
        return case, files

    def collect(self, tickets: Sequence[str] = ()) -> Dict[str, Any]:
        refuse_in_execution("Collecting eval cases")
        wanted = set(tickets)
        made, kept, skipped = [], [], []
        seen = set()
        known = {(self.case_safely(case_id) or {}).get("source", {}).get("ticket_id"): case_id for case_id in self.case_ids()}
        for record in self.runs_log():
            ticket_id = record["ticket_id"]
            if wanted and ticket_id not in wanted:
                continue
            seen.add(ticket_id)
            if record.get("outcome") != "merged":
                skipped.append({"ticket_id": ticket_id, "why": f"its outcome was {record.get('outcome') or 'not recorded'}; only merged tickets become cases"})
                continue
            if ticket_id in known:
                kept.append({"ticket_id": ticket_id, "case_id": known[ticket_id]})
                continue
            try:
                case, files = self.case_from_archive(record)
            except EvalError as exc:
                skipped.append({"ticket_id": ticket_id, "why": str(exc)})
                continue
            case_id = self.new_case_id(ticket_id)
            case["case_id"] = case_id
            self.write_case(case_id, case, files)
            known[ticket_id] = case_id
            made.append({"case_id": case_id, "base_commit": case["base_commit"], "runnable": bool(case["base_commit"])})
        missing = sorted(wanted - seen)
        return {"collected": made, "already_cases": kept, "not_collected": skipped + [{"ticket_id": t, "why": "no run record for it in .factory/archive/runs.jsonl"} for t in missing],
                "cases": str(CASES), "note": "Cases are redacted and carry no evidence media. They are shareable: commit them so the team keeps one suite."}

    def case_safely(self, case_id: str) -> Optional[Dict[str, Any]]:
        try:
            return self.case(case_id)
        except EvalError:
            return None

    def add(self, *, from_ticket: Optional[str] = None, spec: Optional[Path] = None, base: Optional[str] = None, intent: Optional[Path] = None,
            title: Optional[str] = None, reason: Optional[str] = None, case_id: Optional[str] = None, must_pass: Optional[bool] = None) -> Dict[str, Any]:
        refuse_in_execution("Adding an eval case")
        chosen = [bool(from_ticket), bool(spec), bool(case_id)]
        if sum(chosen) != 1:
            raise EvalError("Give exactly one of --from-ticket TICKET, --spec FILE (with --base), or --case CASE.")
        if case_id:
            if must_pass is None:
                raise EvalError("With --case, say --must-pass or --no-must-pass.")
            case = self.case(case_id)
            case["must_pass"] = must_pass
            write_json(self.cases_dir / case_id / "case.json", case)
            return {"case_id": case_id, "must_pass": must_pass}
        if not reason or len(" ".join(reason.split())) < 10:
            raise EvalError("--reason needs the person's own words, at least 10 characters: why this case is kept.")
        words, _ = self.redact(" ".join(reason.split()), REASON_LIMIT)
        if from_ticket:
            if not ID_RE.match(from_ticket):
                raise EvalError(f"'{from_ticket}' is not a ticket ID.")
            record = next((item for item in reversed(self.runs_log()) if item["ticket_id"] == from_ticket), None)
            if record is None:
                raise EvalError(f"{from_ticket} has no run record in .factory/archive/runs.jsonl: only a finished ticket's archive can become a case.")
            if record.get("outcome") != "merged":
                raise EvalError(f"{from_ticket} was {record.get('outcome') or 'not merged'}; an escaped defect is in merged work.")
            existing = next((item for item in self.case_ids() if (self.case_safely(item) or {}).get("source", {}).get("ticket_id") == from_ticket), None)
            if existing:
                case = self.case(existing)
                files: Dict[str, str] = {}
            else:
                case, files = self.case_from_archive(record)
                existing = self.new_case_id(from_ticket)
                case["case_id"] = existing
            case.update({"kind": "escaped-defect", "reason": words, "holdout": "holdout.md"})
            if must_pass is not None:
                case["must_pass"] = must_pass
            files["holdout.md"] = ("# A defect that escaped this ticket\n\nA person reported, in their words:\n\n" + words + "\n\n"
                                   "Check, with data you choose yourself, that this defect does not occur in what was built. Report a failure if it does.\n")
            self.write_case(existing, case, files)
            return {"case_id": existing, "kind": "escaped-defect", "must_pass": case["must_pass"], "base_commit": case["base_commit"],
                    "note": "The reason becomes a holdout check the verifier carries out on the replay; the builder never sees it."}
        assert spec is not None
        if not base:
            raise EvalError("A case written by hand needs --base COMMIT: the commit the work starts from.")
        found = git(self.root, "rev-parse", "--verify", "-q", "--end-of-options", base + "^{commit}")
        if found.returncode != 0 or not SHA_RE.match(found.stdout.strip()):
            raise EvalError(f"--base '{base}' is not a commit in this repository.")
        try:
            text = Path(spec).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise EvalError(f"The spec file cannot be read: {exc}")
        if len(text.encode("utf-8")) > SPEC_LIMIT:
            raise EvalError(f"The spec is larger than {SPEC_LIMIT // 1024} KB.")
        match = re.match(r"^(SLICE-[0-9]{3,})", Path(spec).name)
        if not match or not SLICE_NAME_RE.match(Path(spec).name):
            raise EvalError("The spec file must be named like a slice spec: SLICE-NNN-name.md.")
        text, redacted = self.redact(text)
        files = {"spec.md": text}
        if intent:
            try:
                files["intent.md"], flag = self.redact(Path(intent).read_text(encoding="utf-8"), 20000)
                redacted |= flag
            except (OSError, UnicodeError) as exc:
                raise EvalError(f"The intent file cannot be read: {exc}")
        named, _ = self.redact(" ".join((title or match.group(1)).split()), TITLE_LIMIT)
        case_id = self.new_case_id("hand-" + match.group(1).lower())
        case = {"schema": CASE_SCHEMA, "case_id": case_id, "kind": "by-hand", "source": {"ticket_id": None, "archive": None, "archive_sha256": None, "slice_id": match.group(1)},
                "title": named, "risk": None, "app_type": None, "base_commit": found.stdout.strip(), "base_commit_from": "given by a person",
                "spec": {"file": "spec.md", "name": Path(spec).name, "sha256": sha(text.encode("utf-8")), "data": None},
                "intent": "intent.md" if intent else None, "holdout": None,
                "recorded": {"outcome": None, "verdict": None, "rounds": None, "first_pass": None, "verify_failures": None, "review_rejections": None,
                             "deviations": None, "tests": {"files": None, "names": None}},
                "must_pass": bool(must_pass), "reason": words,
                "redaction": {"rules": "the ticket station's shared redaction (issue_rules.redact)", "changed_something": redacted}, "collected_at": stamp()}
        self.write_case(case_id, case, files)
        return {"case_id": case_id, "kind": "by-hand", "must_pass": case["must_pass"], "base_commit": case["base_commit"],
                "note": "Nothing was recorded for a case written by hand, so it has no first outcome to compare with."}

    # ---- the configuration under test ----

    def wanted_project_paths(self, names: Sequence[str]) -> List[str]:
        """MACH's own files in a script install: .claude/skills/mach and mach-*, agents/mach-*.md, workflows/mach-*.js."""
        keep = []
        for name in names:
            parts = name.split("/")
            if len(parts) < 3 or parts[0] != ".claude" or "__pycache__" in parts or name.endswith(".pyc"):
                continue
            if parts[1] == "skills" and len(parts) >= 4 and (parts[2] == "mach" or parts[2].startswith("mach-")):
                keep.append(name)
            elif parts[1] == "agents" and len(parts) == 3 and parts[2].startswith("mach-") and parts[2].endswith(".md"):
                keep.append(name)
            elif parts[1] == "workflows" and len(parts) == 3 and parts[2].startswith("mach-") and parts[2].endswith(".js"):
                keep.append(name)
        return sorted(keep)

    def working_tree_files(self) -> List[str]:
        folder = self.root / ".claude"
        found = []
        if folder.is_dir() and not folder.is_symlink():
            for path in folder.rglob("*"):
                if path.is_file() and not path.is_symlink():
                    found.append(path.relative_to(self.root).as_posix())
        return self.wanted_project_paths(found)

    def materialize(self, ticket: Optional[str], into: Path) -> Dict[str, Any]:
        """Write the configuration under test into a folder: the rule files, .factory/config.json and, for a script install,
        MACH's files under .claude. From the main checkout's working tree, or with a ticket from its cell's branch head
        (a file that branch does not track comes from the working tree, and is listed)."""
        kind = self.install_kind()
        source: Dict[str, Any] = {"kind": "checkout", "ticket": None, "commit": git(self.root, "rev-parse", "--verify", "-q", "HEAD").stdout.strip() or None,
                                  "from_checkout": []}
        work, head = None, None
        if ticket:
            if not ID_RE.match(ticket):
                raise EvalError(f"'{ticket}' is not a ticket ID.")
            cell_dir = self.root / ".factory" / "worktrees" / ticket
            work = cell_dir / "repo"
            if cell_dir.is_symlink() or not (work / ".git").exists():
                raise EvalError(f"{ticket} has no isolated cell with a checkout, so its change cannot be evaluated.")
            head = git(work, "rev-parse", "--verify", "-q", "HEAD").stdout.strip()
            if not SHA_RE.match(head):
                raise EvalError(f"The branch of {ticket} has no commit.")
            source = {"kind": "ticket", "ticket": ticket, "commit": head, "from_checkout": []}
        tracked = set(git(work, "ls-tree", "-r", "--name-only", head).stdout.splitlines()) if work and head else set()

        def copy(name: str) -> bool:
            target = into / name
            if work and head and name in tracked:
                done = subprocess.run(["git", "show", f"{head}:{name}"], cwd=str(work), capture_output=True)
                if done.returncode != 0:
                    raise EvalError(f"{name} could not be read from the branch of {ticket}.")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(done.stdout)
                return True
            path = self.root / name
            if path.is_file() and not path.is_symlink():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(str(path), str(target))
                if work and name in RULE_FILES + (".factory/config.json",):
                    source["from_checkout"].append(name)
                return True
            return False

        for name in RULE_FILES + (".factory/config.json", ".factory/.mach-manifest.json"):
            copy(name)
        if kind == "project":
            names = self.wanted_project_paths(sorted(tracked)) if tracked else []
            if not names:
                names = self.working_tree_files()
                if work:
                    source["from_checkout"].append(".claude (MACH's files are not tracked on the branch)")
            for name in names:
                copy(name)
        source["from_checkout"] = sorted(set(source["from_checkout"]))
        return {"install": kind, "source": source}

    def configuration(self, ticket: Optional[str] = None) -> Dict[str, Any]:
        """The digests of the configuration under test: rule files, MACH's line (provenance.line) and the model tiers."""
        folder = Path(tempfile.mkdtemp(prefix=CLONE_PREFIX + "conf-"))
        try:
            made = self.materialize(ticket, folder)
            return self.describe(folder, made)
        finally:
            shutil.rmtree(str(folder), ignore_errors=True)

    def describe(self, folder: Path, made: Dict[str, Any]) -> Dict[str, Any]:
        rules = {}
        for name in RULE_FILES:
            path = folder / name
            rules[name] = sha(path.read_bytes()) if path.is_file() else None
        if made["install"] == "project":
            try:
                files = self.executor.project_files(folder)
            except self.executor.PluginError as exc:
                raise EvalError(f"MACH's files in .claude cannot be read as the run's plugin: {exc}")
            plugin = folder / ".eval-plugin"
            for name, data in files.items():
                path = plugin / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            try:
                line = self.provenance.line(plugin)
            except Exception as exc:  # noqa: BLE001  too many files, too slow, or unreadable: never a partial digest
                raise EvalError(f"MACH's files could not be measured for the configuration's digest ({type(exc).__name__}).")
            finally:
                shutil.rmtree(str(plugin), ignore_errors=True)
        else:
            try:
                line = self.provenance.line(self.plugin_folder())
            except Exception as exc:  # noqa: BLE001
                raise EvalError(f"MACH's plugin could not be measured for the configuration's digest ({type(exc).__name__}).")
        models = self.provenance.config(folder).get("models")
        digest = sha(canonical({"rules": rules, "line": line["digest"], "models": models}))
        return {"schema": 1, "install": made["install"], "source": made["source"], "rules": rules,
                "line": {"digest": line["digest"], "count": line["count"], "files": line["files"]}, "models": models, "digest": digest}

    @staticmethod
    def changes(before: Optional[Dict[str, Any]], after: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Which parts differ, by digest: rule files, skills, agents, workflows, model tiers."""
        if not isinstance(before, dict):
            return None
        rules = sorted(name for name in RULE_FILES if (before.get("rules") or {}).get(name) != (after.get("rules") or {}).get(name))
        old, new = (before.get("line") or {}).get("files") or {}, (after.get("line") or {}).get("files") or {}
        parts = sorted(key for key in set(old) | set(new) if old.get(key) != new.get(key))
        tiers = sorted(key for key in set((before.get("models") or {})) | set((after.get("models") or {}))
                       if (before.get("models") or {}).get(key) != (after.get("models") or {}).get(key))
        if (before.get("models") is None) != (after.get("models") is None):
            tiers = tiers or ["(model tiers recorded on one side only)"]
        found = {"rules": rules, "skills": [p[len("skill:"):] for p in parts if p.startswith("skill:")],
                 "agents": [p[len("agent:"):] for p in parts if p.startswith("agent:")],
                 "workflows": [p[len("workflow:"):] for p in parts if p.startswith("workflow:")],
                 "plugin_manifest": "plugin:manifest" in parts, "models": tiers}
        found["any"] = before.get("digest") != after.get("digest")
        return found

    # ---- runs on disk ----

    def run_ids(self) -> List[str]:
        folder = self.runs_dir
        return sorted(path.name for path in folder.iterdir() if path.is_dir() and RUN_ID_RE.match(path.name)) if folder.is_dir() else []

    def run_record(self, run_id: str) -> Dict[str, Any]:
        if not RUN_ID_RE.match(run_id or ""):
            raise EvalError(f"'{run_id}' is not a run ID (eval-YYYYMMDDTHHMMSSZ-xxxx).")
        data = load_json(self.runs_dir / run_id / "run.json")
        if data is None or data.get("schema") != RUN_SCHEMA:
            raise EvalError(f"There is no readable eval run '{run_id}'.")
        return data

    def last_run(self) -> Optional[Dict[str, Any]]:
        for run_id in reversed(self.run_ids()):
            data = load_json(self.runs_dir / run_id / "run.json")
            if data and data.get("ended_at"):
                return data
        return None

    # ---- status ----

    def status(self, ticket: Optional[str] = None) -> Dict[str, Any]:
        cases = [self.case_safely(case_id) for case_id in self.case_ids()]
        cases = [case for case in cases if case]
        known = {case["source"].get("ticket_id") for case in cases if isinstance(case.get("source"), dict)}
        collectable = sorted({record["ticket_id"] for record in self.runs_log() if record.get("outcome") == "merged" and record["ticket_id"] not in known})
        current = self.configuration(ticket)
        last = self.last_run()
        changed = self.changes(last.get("configuration") if last else None, current)
        pending = load_json(self.runs_dir / "pending.json")
        expires = parse_stamp((pending or {}).get("expires_at"))
        by_kind: Dict[str, int] = {}
        for case in cases:
            by_kind[str(case.get("kind"))] = by_kind.get(str(case.get("kind")), 0) + 1
        evaluated = bool(last) and (last.get("configuration") or {}).get("digest") == current["digest"]
        if not cases:
            advice = "There are no cases yet. Collect them from merged tickets' archives (eval collect)."
        elif evaluated:
            advice = "The configuration is the one the last run used; nothing has changed since it was evaluated."
        elif last is None:
            advice = "No eval run has been made. A run is a person's decision: plan one with eval run --plan --budget <USD>."
        else:
            advice = "The configuration changed since the last run. A new run is a person's decision: plan one with eval run --plan --budget <USD>."
        return {
            "cases": {"total": len(cases), "must_pass": sum(1 for case in cases if case.get("must_pass")), "runnable": sum(1 for case in cases if case.get("base_commit")),
                      "by_kind": by_kind},
            "collectable": collectable,
            "configuration": {"digest": current["digest"], "install": current["install"], "source": current["source"]},
            "last_run": {"run_id": last["run_id"], "ended_at": last.get("ended_at"), "configuration_digest": (last.get("configuration") or {}).get("digest"),
                         "cases": len(last.get("cases") or []), "passed": sum(1 for item in last.get("cases") or [] if outcome_of(item) == "passed")} if last else None,
            "changed_since_last_run": changed,
            "evaluated": evaluated,
            "planned_run_waiting": {"expires_at": pending.get("expires_at"), "cases": len((pending.get("plan") or {}).get("will_run") or [])}
            if pending and expires and expires > now() else None,
            "next": advice,
            "starts_nothing": True,
        }

    # ---- planning a run ----

    def select(self, chosen: Sequence[str], limit: Optional[int]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        ids = self.case_ids()
        unknown = [case_id for case_id in chosen if case_id not in ids]
        if unknown:
            raise EvalError("No such case: " + ", ".join(unknown[:5]) + ". eval status lists the cases.")
        cases = [self.case(case_id) for case_id in (list(dict.fromkeys(chosen)) if chosen else ids)]
        runnable = [case for case in cases if case.get("base_commit")]
        blocked = [{"case_id": case["case_id"], "why": "no base commit is recorded, so there is nothing to start from"} for case in cases if not case.get("base_commit")]
        runnable.sort(key=lambda case: (not case.get("must_pass"), case["case_id"]))
        if limit is not None:
            if limit < 1:
                raise EvalError("--limit must be at least 1.")
            runnable = runnable[:limit]
        return runnable, blocked

    def plan(self, *, budget: Optional[float], chosen: Sequence[str] = (), limit: Optional[int] = None, ticket: Optional[str] = None,
             max_minutes: Optional[int] = None) -> Dict[str, Any]:
        refuse_in_execution("An eval run")
        if budget is None or number(budget) is None or budget <= 0:
            raise EvalError("An eval run needs an explicit budget: --budget <US dollars> for the whole run.")
        minutes = MINUTES[0] if max_minutes is None else max_minutes
        if not MINUTES[1] <= minutes <= MINUTES[2]:
            raise EvalError(f"--max-minutes must be from {MINUTES[1]} to {MINUTES[2]}.")
        cases, blocked = self.select(chosen, limit)
        if not cases:
            raise EvalError("No case can run: " + ("; ".join(f"{item['case_id']}: {item['why']}" for item in blocked[:5]) or "there are no cases. Collect them first (eval collect)."))
        share = round(min(float(budget) / len(cases), MAX_CASE_USD), 2)
        if share < MIN_CASE_USD:
            raise EvalError(f"A budget of {budget:g} US dollars over {len(cases)} case(s) is less than {MIN_CASE_USD:g} per case. Raise it or run fewer cases (--limit).")
        configuration = self.configuration(ticket)
        tools = self.policy.default_tools()
        risk = self.policy.execution_risk(tools)
        plan = {
            "will_run": [{"case_id": case["case_id"], "base_commit": case["base_commit"], "must_pass": bool(case.get("must_pass")), "kind": case.get("kind")} for case in cases],
            "not_runnable": blocked,
            "budget_usd": float(budget), "per_case_usd": share, "ceiling_usd": round(min(float(budget), share * len(cases)), 2),
            "max_minutes_per_case": minutes, "time_ceiling_minutes": minutes * len(cases),
            "configuration": {"digest": configuration["digest"], "install": configuration["install"], "source": configuration["source"]},
            "ticket": ticket,
            "boundary": {"how": "the supervisor's executor (executor.py): one claude -p per case, the belt workflow stopped before review",
                         "permission_mode": "default", "permission_prompts": "none (refused, never asked)", "restricted": True, "mcp_servers": "none",
                         "tools": tools, "spending_limit_usd_per_case": share, "minutes_per_case": minutes,
                         "machine_authorization": "not read: the Factory's machine-local policy file is never used, and nothing is enabled"},
            "confinement": [
                "Each case runs in a new throwaway clone under the system's temporary folder, never in this checkout.",
                "The clone is filled by one git fetch from this folder; it has no remote, and git's transports are switched off in it afterwards (protocol.allow never), so nothing can be pushed or fetched.",
                "The clone's tickets use the local Markdown queue, its merge mode is manual and the supervisor and notifications are off in it; the replay stops before review, so nothing is reviewed or merged.",
                "The clone is removed when the case ends, unless --keep is given.",
            ],
            "execution_risk": risk["statement"],
        }
        pending = {"code": secrets.token_hex(3), "expires_at": stamp(now() + timedelta(minutes=CONFIRM_MINUTES)), "plan": plan}
        write_json(self.runs_dir / "pending.json", pending)
        return {**plan, "spends_nothing": True, "confirm_with": pending["code"], "expires_at": pending["expires_at"],
                "to_run": "Only after the person has read this, including execution_risk, and said yes: eval run --confirm <code> --accept-execution-risk. "
                          "The code is used once and expires in %d minutes." % CONFIRM_MINUTES}

    def take_pending(self, code: str) -> Dict[str, Any]:
        path = self.runs_dir / "pending.json"
        pending = load_json(path)
        if not pending:
            raise EvalError("No planned run is waiting for a yes. Plan one first: eval run --plan --budget <USD>.")
        expires = parse_stamp(pending.get("expires_at"))
        if not expires or now() > expires:
            with contextlib.suppress(OSError):
                path.unlink()
            raise EvalError("That plan has expired. Plan the run again and read what it shows.")
        if not isinstance(code, str) or not secrets.compare_digest(code.strip(), str(pending.get("code"))):
            raise EvalError("That is not the code of the planned run. Nothing was run.")
        with contextlib.suppress(OSError):
            path.unlink()
        return pending["plan"]

    # ---- running ----

    def run(self, *, code: str, accept_risk: bool, keep: bool = False, claude: Optional[str] = None) -> Dict[str, Any]:
        refuse_in_execution("An eval run")
        if not accept_risk:
            raise EvalError("An eval run starts model executions with no operating-system sandbox. Add --accept-execution-risk only when the person has read "
                            "the plan's execution_risk and accepts it.")
        plan = self.take_pending(code)
        configuration = self.configuration(plan.get("ticket"))
        if configuration["digest"] != (plan.get("configuration") or {}).get("digest"):
            raise EvalError("The configuration changed since the run was planned, so it is not the one the person agreed to. Plan it again.")
        if plan["boundary"]["tools"] != self.policy.default_tools():
            raise EvalError("The tool list is not the one the plan showed. Plan the run again.")
        program = claude or shutil.which("claude")
        if not program:
            raise EvalError("Claude Code (the 'claude' command) is not on the PATH.")
        missing, problem = self.policy.missing_flags(program, self.root)
        if missing is None or missing:
            raise EvalError(problem or ("This Claude Code lacks " + ", ".join(missing) + ", which the execution boundary depends on. Nothing was run."))
        lock = self.runs_dir / ".running"
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        try:
            handle = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            raise EvalError("Another eval run is under way in this project (.factory/evals/runs/.running). One at a time.")
        with os.fdopen(handle, "w") as out:
            out.write(str(os.getpid()))
        run_id = f"eval-{now().strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(2)}"
        record: Dict[str, Any] = {"schema": RUN_SCHEMA, "run_id": run_id, "started_at": stamp(), "ended_at": None, "by": "a person's explicit command, confirmed with a code",
                                  "budget_usd": plan["budget_usd"], "per_case_usd": plan["per_case_usd"], "max_minutes": plan["max_minutes_per_case"],
                                  "configuration": configuration, "provenance": None, "cases": [], "stopped_early": None, "kept": [],
                                  "replay": f"from planning through verification; stopped before {STOP_BEFORE}"}
        path = self.runs_dir / run_id / "run.json"
        write_json(path, record)
        spent = 0.0
        try:
            for item in plan["will_run"]:
                left = round(plan["budget_usd"] - spent, 2)
                if left < MIN_CASE_USD:
                    record["cases"].append({"case_id": item["case_id"], "must_pass": item["must_pass"], "not_run": "the run's budget was spent"})
                    record["stopped_early"] = "budget spent"
                    continue
                limit = round(min(plan["per_case_usd"], left), 2)
                case = self.case_safely(item["case_id"])
                if case is None or case.get("base_commit") != item.get("base_commit"):
                    record["cases"].append({"case_id": item["case_id"], "must_pass": item["must_pass"], "not_run": "the case was removed or changed after the run was planned"})
                    write_json(path, record)
                    continue
                result = self.replay(case, plan, limit, program, keep)
                result["must_pass"] = item["must_pass"]
                record["cases"].append(result)
                if record["provenance"] is None and result.get("provenance"):
                    record["provenance"] = result.pop("provenance")
                else:
                    result.pop("provenance", None)
                if result.get("kept"):
                    record["kept"].append(result["kept"])
                cost = number(result.get("cost_usd"))
                spent += cost if cost is not None else (limit if result.get("execution_id") else 0.0)  # an unrecorded cost counts as its whole limit
                write_json(path, record)
        finally:
            record["ended_at"] = stamp()
            costs = [number(item.get("cost_usd")) for item in record["cases"] if item.get("execution_id")]
            record["spent_usd_recorded"] = round(sum(cost for cost in costs if cost is not None), 6) if any(cost is not None for cost in costs) else None
            record["cases_without_cost"] = sum(1 for cost in costs if cost is None)
            write_json(path, record)
            with contextlib.suppress(OSError):
                lock.unlink()
        return {"run_id": run_id, "run": str(path.relative_to(self.root)), "cases": [summary_of(item) for item in record["cases"]],
                "passed": sum(1 for item in record["cases"] if outcome_of(item) == "passed"), "of": len(record["cases"]),
                "spent_usd_recorded": record["spent_usd_recorded"], "stopped_early": record["stopped_early"], "kept": record["kept"],
                "next": "Compare it with an earlier run: eval compare <earlier-run> " + run_id}

    def make_clone(self, base: str) -> Tuple[Path, Path]:
        """A new folder under the system's temporary folder, outside the project, with a repository fetched from it."""
        holder = Path(tempfile.mkdtemp(prefix=CLONE_PREFIX)).resolve()
        clone = holder / "project"
        if inside(holder, self.root) or inside(self.root, holder):
            shutil.rmtree(str(holder), ignore_errors=True)
            raise EvalError("The temporary folder is inside the project (or the other way round); a replay never runs there.")
        clone.mkdir()
        branch = git(self.root, "symbolic-ref", "--short", "-q", "HEAD").stdout.strip() or "main"
        branch = branch if re.match(r"^[A-Za-z0-9._/-]{1,100}$", branch) and ".." not in branch else "main"
        git(clone, "init", "-q", "-b", branch, check=True)
        for key, value in IDENTITY:
            git(clone, "config", key, value, check=True)
        git(clone, "fetch", "-q", "--no-tags", str(self.root), "+refs/heads/*:refs/eval-source/heads/*", "+refs/remotes/*:refs/eval-source/remotes/*", check=True)
        git(clone, "config", "protocol.allow", "never", check=True)  # no transport at all from here on: nothing is fetched or pushed
        if git(clone, "cat-file", "-e", base + "^{commit}").returncode != 0:
            shutil.rmtree(str(holder), ignore_errors=True)
            raise EvalError(f"The base commit {base[:12]} is not on any branch of this repository any more.")
        git(clone, "checkout", "-q", "-B", branch, base, check=True)
        for ref in git(clone, "for-each-ref", "--format=%(refname)", "refs/eval-source/").stdout.split():
            git(clone, "update-ref", "-d", ref)
        if git(clone, "remote").stdout.strip():
            shutil.rmtree(str(holder), ignore_errors=True)
            raise EvalError("The clone has a remote; a replay never runs with one.")
        return holder, clone

    def overlay(self, clone: Path, plan: Dict[str, Any]) -> Dict[str, Any]:
        """Lay the configuration under test over the case's base commit, with the eval's own safety settings, and commit it."""
        folder = Path(tempfile.mkdtemp(prefix=CLONE_PREFIX + "conf-"))
        try:
            made = self.materialize(plan.get("ticket"), folder)
            for name in RULE_FILES:
                source, target = folder / name, clone / name
                if source.is_file():
                    shutil.copyfile(str(source), str(target))
                elif target.is_file():
                    target.unlink()
            if made["install"] == "project":
                for path in sorted((clone / ".claude").rglob("*"), reverse=True) if (clone / ".claude").is_dir() else []:
                    relative = path.relative_to(clone).as_posix()
                    if path.is_file() and self.wanted_project_paths([relative]):
                        path.unlink()
                for path in sorted((folder / ".claude").rglob("*")) if (folder / ".claude").is_dir() else []:
                    if path.is_file():
                        target = clone / path.relative_to(folder)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(str(path), str(target))
            settings = load_json(folder / ".factory" / "config.json") or {}
            manifest = folder / ".factory" / ".mach-manifest.json"
            (clone / ".factory").mkdir(exist_ok=True)
            if manifest.is_file():
                shutil.copyfile(str(manifest), str(clone / ".factory" / ".mach-manifest.json"))
        finally:
            shutil.rmtree(str(folder), ignore_errors=True)
        overrides = eval_settings(settings)
        write_json(clone / ".factory" / "config.json", overrides)
        for name in (*RULE_FILES, ".claude", ".factory/config.json"):
            if git(clone, "check-ignore", "-q", name).returncode != 0:
                git(clone, "add", "-A", "--", name)
        if git(clone, "diff", "--cached", "--quiet").returncode == 1:
            git(clone, "commit", "-q", "-m", "MACH eval: the configuration under test", check=True)
        return {"install": made["install"]}

    def script(self, clone: Path, station: str, name: str, *argv: str) -> subprocess.CompletedProcess:
        path = self.sibling(station) / "scripts" / name
        env = {key: value for key, value in os.environ.items() if key != EXECUTION_ENV}
        return subprocess.run([sys.executable, str(path), "--project", str(clone), *argv], cwd=str(clone), capture_output=True, text=True, env=env)

    def seed(self, clone: Path, case: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
        """The case's ticket, its holdout check and its cell at spec-ready, through the ticket and intent stations' own scripts.
        Returns the ticket, or why it could not be made ready for planning (a gate that refuses the spec is an outcome)."""
        folder = self.cases_dir / case["case_id"]
        title = " ".join(f"Eval replay of {case['case_id']}: {case.get('title') or ''}".split())[:TITLE_LIMIT]
        made = self.script(clone, "ticket", "ticket.py", "--provider", "local", "create", "--title", title, "--label", "eval-replay", "--body", "Replayed by MACH eval.")
        try:
            ticket = json.loads(made.stdout)["ticket_id"]
        except (ValueError, KeyError, TypeError):
            return None, "the ticket station could not file the replay's ticket: " + (made.stderr.strip() or made.stdout.strip())[-300:]
        if not ID_RE.match(str(ticket)):
            return None, "the ticket station returned an unusable ticket ID"
        if case.get("holdout") and (folder / case["holdout"]).is_file():
            target = clone / ".factory" / "holdouts" / ticket / "escaped-defect.md"
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(folder / case["holdout"]), str(target))
        opened = self.script(clone, "intent", "cell.py", "open", ticket, "--title", title, "--headless")
        try:
            described = json.loads(opened.stdout)
            workdir, intent_path = Path(described["workdir"]), Path(described["intent_path"])
        except (ValueError, KeyError, TypeError):
            return ticket, "the intent station could not open the replay's cell: " + (opened.stderr.strip() or opened.stdout.strip())[-300:]
        name = (case.get("spec") or {}).get("name") or "SLICE-001-replay.md"
        if not SLICE_NAME_RE.match(name):
            return ticket, "the case's spec has no usable file name"
        target = workdir / "specs" / "slices" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(str(folder / "spec.md"), str(target))
        if case.get("intent") and (folder / case["intent"]).is_file():
            intent_path.write_text((folder / case["intent"]).read_text(encoding="utf-8"), encoding="utf-8")
        finalized = self.script(clone, "intent", "cell.py", "finalize", ticket, "--spec", str(target.relative_to(workdir)))
        if finalized.returncode != 0:
            return ticket, "the intent station's gate refused the case's spec today: " + finalized.stdout.strip()[-600:]
        return ticket, None

    def replay(self, case: Dict[str, Any], plan: Dict[str, Any], limit: float, program: str, keep: bool) -> Dict[str, Any]:
        result: Dict[str, Any] = {"case_id": case["case_id"], "base_commit": case["base_commit"], "ticket_id": None, "execution_id": None, "session_id": None,
                                  "planned": None, "built": None, "verdict": None, "rounds": None, "deviations": None, "deviation_types": None,
                                  "stage": None, "seconds": None, "cost_usd": None, "how": None, "refused_tools": [], "not_run": None, "spending_limit_usd": limit}
        holder: Optional[Path] = None
        try:
            holder, clone = self.make_clone(case["base_commit"])
            self.overlay(clone, plan)
            ticket, problem = self.seed(clone, case)
            result["ticket_id"] = ticket
            if problem:
                result.update({"not_run": problem, "planned": False, "built": False})
                return result
            boundary = self.executor.plugin(clone, self.run_script)
            execution_id = "x" + secrets.token_hex(6)
            session = str(uuid.uuid4())
            tools = self.policy.default_tools()
            argv = self.executor.command(program, boundary["workflow"], [ticket], STOP_BEFORE, tools, limit, session,
                                         boundary["plugin_dir"], boundary["add_dirs"], boundary["denied"])
            if any("dangerously" in part or part in ("bypassPermissions", "acceptEdits") for part in argv):
                raise EvalError("The command would skip permission checks; nothing was run.")
            # The clone's own ledger names this execution and its one ticket, so run.py scopes the replay to it exactly as it
            # scopes a supervised execution: no other ticket, no observe pass, no tuning ticket, and no eval command inside.
            write_json(clone / ".factory" / "intake" / "ledger.json",
                       {"schema_version": 2, "supervisor": {"executions": {execution_id: {"execution_id": execution_id, "ticket_id": ticket, "state": "started",
                                                                                           "eval_case": case["case_id"], "budget_usd": limit}}}})
            pol = {"autonomy": None, "max_risk": None, "allow_merge": False, "allowed_tools": tools, "limits": {}}
            result["provenance"] = self.provenance.capture(clone, boundary, pol, ticket, None, {}).get("provenance")
            self.executor.prepare(clone, execution_id, argv, plan["max_minutes_per_case"])
            result.update({"execution_id": execution_id, "session_id": session})
            handlers = {number_: signal.getsignal(number_) for number_ in (signal.SIGTERM, signal.SIGINT)}
            try:
                self.executor.wrapper(clone, execution_id)
            finally:
                for number_, handler in handlers.items():
                    signal.signal(number_, handler)
            facts = self.executor.outcome(clone, execution_id)
            ended = load_json(self.executor.folder(clone, execution_id) / "result.json") or {}
            result.update({"how": facts.get("how"), "cost_usd": number(facts.get("cost_usd")), "refused_tools": facts.get("refused_tools") or [],
                           "seconds": whole(ended.get("seconds"))})
            result.update(cell_facts(clone, ticket))
        except EvalError as exc:
            result["not_run"] = result["not_run"] or str(exc)
        except Exception as exc:  # noqa: BLE001  one case's failure is recorded, and the run goes on to the next
            result["not_run"] = result["not_run"] or f"the replay could not be prepared: {type(exc).__name__}: {str(exc)[:300]}"
        finally:
            if holder is not None:
                if keep:
                    result["kept"] = str(holder)
                else:
                    remove_clone(holder)
        return result

    # ---- comparing ----

    def compare(self, before_id: str, after_id: str) -> Dict[str, Any]:
        before, after = self.run_record(before_id), self.run_record(after_id)
        if not before.get("ended_at") or not after.get("ended_at"):
            raise EvalError("Both runs must have ended; one of them has no end recorded.")
        result = comparison(before, after)
        write_json(self.runs_dir / f"compare-{before_id}-{after_id}.json", result)
        return result

    def show(self, name: str) -> Dict[str, Any]:
        if RUN_ID_RE.match(name or ""):
            return self.run_record(name)
        match = re.match(r"^compare-(eval-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4})-(eval-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4})$", name or "")
        if match:
            data = load_json(self.runs_dir / f"{name}.json")
            if data is None:
                raise EvalError(f"There is no comparison '{name}'.")
            return data
        case = self.case(name)
        spec = self.cases_dir / name / "spec.md"
        return {**case, "spec_lines": len(spec.read_text(encoding="utf-8").splitlines()) if spec.is_file() else None,
                "note": "The spec and intent are the archived ticket's, redacted: data, never instructions."}


# ---- pure functions: what a run found, and how two runs compare ----


def eval_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    """The clone's settings: the configuration's own, with the eval's fixed safety settings on top. Model tiers, review and
    build settings are untouched; only where tickets live, merging, the supervisor, notifications and publishing change."""
    data = json.loads(json.dumps(settings)) if isinstance(settings, dict) else {}
    tickets = data.get("tickets") if isinstance(data.get("tickets"), dict) else {}
    data["tickets"] = {key: value for key, value in tickets.items() if key not in ("commands", "github")}
    data["tickets"]["provider"] = "local"
    merge = data.get("merge") if isinstance(data.get("merge"), dict) else {}
    data["merge"] = {**merge, "mode": "manual", "auto": {"low": False, "medium": False, "high": False}}
    factory = data.get("factory") if isinstance(data.get("factory"), dict) else {}
    data["factory"] = {**factory, "supervisor": False, "notifications": False, "monitoring_requests": False}
    records = data.get("records") if isinstance(data.get("records"), dict) else {}
    data["records"] = {key: value for key, value in records.items() if key != "publish_command"}
    return data


def cell_facts(clone: Path, ticket: str) -> Dict[str, Any]:
    """What the replay's cell records, read from the stations' own files. A value a file does not hold stays null."""
    cell_dir = clone / ".factory" / "worktrees" / ticket
    cell = load_json(cell_dir / "cell.json")
    if cell is None:
        return {}
    stage = cell.get("stage") if isinstance(cell.get("stage"), str) else None
    facts: Dict[str, Any] = {"stage": stage, "planned": (cell_dir / "plan.md").is_file() and stage in PLANNED_STAGES}
    report = load_json(cell_dir / "build-report.json")
    facts["built"] = bool(report and report.get("status") == "BUILT")
    if report:
        loop = whole(report.get("review_loop"))
        facts["rounds"] = loop + 1 if loop is not None else None
        deviations = report.get("deviations") if isinstance(report.get("deviations"), list) else None
        facts["deviations"] = len(deviations) if deviations is not None else None
        facts["deviation_types"] = sorted({str(item.get("type") or "")[:60] for item in deviations or [] if isinstance(item, dict)}) if deviations is not None else None
    summary = load_json(cell_dir / "evidence" / "summary.json")
    facts["verdict"] = summary.get("status") if summary and summary.get("status") in VERDICTS else None
    return facts


def remove_clone(holder: Path) -> None:
    """Remove a replay's folder: only one this module made, under the system's temporary folder."""
    temp = Path(tempfile.gettempdir()).resolve()
    if holder.name.startswith(CLONE_PREFIX) and inside(holder, temp) and holder.resolve() != temp:
        shutil.rmtree(str(holder), ignore_errors=True)


def outcome_of(item: Dict[str, Any]) -> str:
    """One word for a case's result. Only a recorded PASS verdict is a pass; anything missing is never one."""
    if item.get("not_run"):
        return "not run"
    if item.get("verdict") == "PASS":
        return "passed"
    if item.get("verdict") == "FAIL_WITH_EVIDENCE":
        return "verification failed"
    if item.get("verdict") == "INCOMPLETE_EVIDENCE":
        return "evidence incomplete"
    if item.get("built") is True:
        return "built, not verified"
    if item.get("planned") is True:
        return "planned, not built"
    if item.get("planned") is False:
        return "not planned"
    return "not recorded"


def summary_of(item: Dict[str, Any]) -> Dict[str, Any]:
    return {"case_id": item.get("case_id"), "outcome": outcome_of(item), "must_pass": bool(item.get("must_pass")),
            "cost_usd": item.get("cost_usd"), "seconds": item.get("seconds"), "not_run": item.get("not_run")}


def totals(run: Dict[str, Any]) -> Dict[str, Any]:
    cases = [item for item in run.get("cases") or [] if isinstance(item, dict)]
    passed = sum(1 for item in cases if outcome_of(item) == "passed")
    costs = [number(item.get("cost_usd")) for item in cases]
    seconds = [whole(item.get("seconds")) for item in cases]
    return {"passed": passed, "of": len(cases), "rate": round(passed / len(cases), 4) if cases else None,
            "cost_usd_recorded": round(sum(cost for cost in costs if cost is not None), 6) if any(cost is not None for cost in costs) else None,
            "cases_without_cost": sum(1 for cost in costs if cost is None),
            "seconds_recorded": sum(value for value in seconds if value is not None) if any(value is not None for value in seconds) else None,
            "cases_without_time": sum(1 for value in seconds if value is None)}


def comparison(before: Dict[str, Any], after: Dict[str, Any]) -> Dict[str, Any]:
    """Deterministic: the same two runs give the same result. A missing value is never a pass."""
    first = {item["case_id"]: item for item in before.get("cases") or [] if isinstance(item, dict) and isinstance(item.get("case_id"), str)}
    second = {item["case_id"]: item for item in after.get("cases") or [] if isinstance(item, dict) and isinstance(item.get("case_id"), str)}
    common = sorted(set(first) & set(second))
    changed = [{"case_id": case_id, "before": outcome_of(first[case_id]), "after": outcome_of(second[case_id])}
               for case_id in common if outcome_of(first[case_id]) != outcome_of(second[case_id])]
    configs = (before.get("configuration") or {}, after.get("configuration") or {})
    return {
        "schema": COMPARE_SCHEMA, "before": before.get("run_id"), "after": after.get("run_id"),
        "configurations": {"before": configs[0].get("digest"), "after": configs[1].get("digest"), "same": configs[0].get("digest") == configs[1].get("digest"),
                           "after_source": configs[1].get("source"), "changed": Evals.changes(configs[0], configs[1]) if configs[1] else None},
        "before_totals": totals(before), "after_totals": totals(after),
        "common_cases": len(common), "only_before": sorted(set(first) - set(second)), "only_after": sorted(set(second) - set(first)),
        "changed_outcome": changed,
        "now_passing": [item["case_id"] for item in changed if item["after"] == "passed"],
        "no_longer_passing": [item["case_id"] for item in changed if item["before"] == "passed"],
        "must_pass_not_passing": sorted(case_id for case_id, item in second.items() if item.get("must_pass") and outcome_of(item) != "passed"),
        "note": "Only a recorded PASS verdict counts as a pass; a case not run or with nothing recorded is not one. Costs are as recorded, never estimated. "
                "No threshold is enforced: the review panel decides as it always has.",
    }


def packet_entry(root: Path, ticket_id: str, head: str) -> Dict[str, Any]:
    """For a factory-tuning ticket's review packet: the latest comparison whose later run evaluated exactly this change (the ticket's
    branch at the commit under review), or "not evaluated". Reads files only; never raises into the caller's path."""
    runs = Path(root) / RUNS
    not_evaluated = {"evaluated": False, "note": NOT_EVALUATED,
                     "why": f"No eval comparison exists for this change at {str(head)[:12]}: no run of the configuration on this ticket's branch at that commit was compared with another."}
    try:
        exact = set()
        for folder in sorted(runs.iterdir()) if runs.is_dir() else []:
            data = load_json(folder / "run.json") if RUN_ID_RE.match(folder.name) else None
            source = ((data or {}).get("configuration") or {}).get("source") or {}
            if data and data.get("ended_at") and source.get("kind") == "ticket" and source.get("ticket") == ticket_id and source.get("commit") == head:
                exact.add(folder.name)
        found = []
        for path in sorted(runs.glob("compare-*.json")) if runs.is_dir() else []:
            data = load_json(path)
            if data and data.get("schema") == COMPARE_SCHEMA and data.get("after") in exact:
                found.append(data)
        if not found:
            if exact:
                not_evaluated["why"] = f"Run {sorted(exact)[-1]} evaluated this change at {str(head)[:12]} but was not compared with an earlier run."
            return not_evaluated
        latest = max(found, key=lambda data: (str(data.get("after")), str(data.get("before"))))
        return {"evaluated": True, "comparison": f"compare-{latest['before']}-{latest['after']}", "before": latest["before"], "after": latest["after"],
                "configurations": {key: latest["configurations"].get(key) for key in ("before", "after", "same", "changed")},
                "before_totals": latest["before_totals"], "after_totals": latest["after_totals"],
                "changed_outcome": latest["changed_outcome"][:50], "no_longer_passing": latest["no_longer_passing"][:50],
                "must_pass_not_passing": latest["must_pass_not_passing"][:50],
                "note": "Data for the panel, not a gate: no threshold is enforced. A missing value is never a pass."}
    except Exception:  # noqa: BLE001  the packet must be written whatever the eval records hold
        return {**not_evaluated, "why": "The eval records could not be read."}
