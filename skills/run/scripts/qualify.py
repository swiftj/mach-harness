#!/usr/bin/env python3
"""MACH release qualification: does the integrated capability work, at one exact commit?

Each slice is verified and reviewed in its own cell. Nothing in the line says whether the slices
of one or more delivery waves work together once they are on the integration branch. This module
measures that and records a decision, reached as `run.py release ...`:

    status                       releases qualified so far, and what a new run would evaluate
    qualify <WAVE-ID>... [--release <id>] [--commit <sha>]
                                 evaluate the integration branch at one commit and write
                                 .factory/release/<release-id>/readiness.json
    show <release-id>            the snapshot, the exceptions and the run's metadata
    except --release <id> --check <check-id> --by <role> --reason <text>
                                 record a person's exception for one check at the snapshot's commit

The snapshot is deterministic: the same inputs give the same bytes (sorted keys, no wall-clock
inside it). When the run happened, how long it took and the suite's output sit beside it in
run.json and the logs, outside the decision.

What it reuses, and never reimplements: intake's reading of product definitions from Git objects,
its validators and its rule for what is integrated (a commit on the branch, checked in Git); the
cleanup station's run records and archives; the verification and review stations' recorded
verdicts; the audit station's detection and running of the test command.

What it never does: land, publish or label a commit, change any checkout, start a station, an
agent or a workflow, or read the machine-local Factory settings. Product acceptance is read from
the product files; it is never inferred from a merge or a passing suite.

Standard library only. Imported by run.py; not a command of its own.
"""

import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

SCHEMA = "mach.release-readiness"
SCHEMA_VERSION = 1
OUTCOMES = ("qualified", "qualified_with_exceptions", "blocked", "incomplete")
INCOMPLETE = ("missing", "not_run", "not_configured")  # a required check in one of these states was not shown to pass
RELEASE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
WAVE_RE = re.compile(r"^WAVE-[0-9]{3,}$")
ROLE_RE = re.compile(r"^[a-z][a-z0-9-]{1,39}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
AC_RE = re.compile(r"^AC-[0-9]+$")
SEVERE = ("critical", "high")
SUITE_TIMEOUT = 600


class QualifyError(Exception):
    """A problem the caller can fix; run.py prints it as a refusal."""


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(data: Any) -> str:
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def number(identifier: str) -> int:
    match = re.search(r"(\d+)$", identifier)
    return int(match.group(1)) if match else 0


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(str(temporary), str(path))


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


class Release:
    def __init__(self, root: Path, config: Dict[str, Any], line: Any, sibling: Callable[[str], Path]):
        self.root = root
        self.config = config
        self.line = line  # intake.Factory: product definitions from Git, validators, what is integrated
        self.sibling = sibling
        self.home = root / ".factory" / "release"
        if (root / ".factory").is_symlink() or self.home.is_symlink():
            raise QualifyError(f"{self.home} is a symbolic link. Release records must be a real folder inside the project.")
        section = config.get("release")
        self.settings = section if isinstance(section, dict) else {}

    # ---- Git, read only ----

    def _git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=str(self.root), capture_output=True, text=True, errors="replace")

    def _git_bytes(self, *args: str) -> Optional[bytes]:
        done = subprocess.run(["git", *args], cwd=str(self.root), capture_output=True)
        return done.stdout if done.returncode == 0 else None

    def contains(self, commit: Optional[str], release_commit: str) -> bool:
        return bool(commit) and self._git("merge-base", "--is-ancestor", str(commit), release_commit).returncode == 0

    def file_at(self, commit: str, relative: str) -> Optional[bytes]:
        return self._git_bytes("show", f"{commit}:{relative}")

    # ---- inputs ----

    def resolve(self, commit: Optional[str]) -> Tuple[Dict[str, Any], str]:
        source = self.line.integration()
        if source["problems"]:
            raise QualifyError(" ".join(source["problems"]))
        head = source["commit"]
        if commit:
            resolved = self._git("rev-parse", "--verify", "-q", f"{commit}^{{commit}}").stdout.strip()
            if not COMMIT_RE.match(resolved):
                raise QualifyError(f"'{commit}' is not a commit in this repository.")
            if not self.contains(resolved, head):
                raise QualifyError(f"{resolved[:12]} is not on the integration branch '{source['branch']}'. Only integrated work can be qualified.")
            return source, resolved
        return source, head

    def run_records(self) -> Dict[str, Dict[str, Any]]:
        """The newest run record per ticket, as the cleanup station wrote it."""
        found: Dict[str, Dict[str, Any]] = {}
        path = self.root / ".factory" / "archive" / "runs.jsonl"
        for line in path.read_text(encoding="utf-8").splitlines() if path.is_file() else []:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict) and isinstance(record.get("ticket_id"), str):
                found[record["ticket_id"]] = record
        return found

    def archive(self, ticket_id: str) -> Dict[str, bytes]:
        """Every file in a cleaned-up ticket's archive, by its path inside the cell folder."""
        path = self.root / ".factory" / "archive" / f"{ticket_id}.tar.gz"
        files: Dict[str, bytes] = {}
        try:
            with tarfile.open(str(path), "r:gz") as archive:
                for member in archive.getmembers():
                    if member.isfile():
                        name = member.name.split("/", 1)[1] if member.name.startswith(f"{ticket_id}/") else member.name
                        handle = archive.extractfile(member)
                        if handle is not None:
                            files[name] = handle.read()
        except (OSError, tarfile.TarError):
            pass
        return files

    @staticmethod
    def json_in(files: Dict[str, bytes], name: str) -> Dict[str, Any]:
        try:
            data = json.loads(files[name].decode("utf-8"))
        except (KeyError, ValueError, UnicodeDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def exceptions(self, release_id: str) -> List[Dict[str, Any]]:
        path = self.home / release_id / "exceptions.jsonl"
        found = []
        for line in path.read_text(encoding="utf-8").splitlines() if path.is_file() else []:
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if isinstance(item, dict):
                found.append(item)
        return found

    def scans(self, commit: str) -> Tuple[List[Dict[str, Any]], List[str]]:
        """Scanner reports left under .factory/release/scans/. Only a report for this commit counts."""
        reports, ignored = [], []
        folder = self.home / "scans"
        for path in sorted(folder.glob("*.json")) if folder.is_dir() and not folder.is_symlink() else []:
            data = load_json(path)
            if not isinstance(data, dict) or not isinstance(data.get("findings"), list) or not isinstance(data.get("tool"), str):
                ignored.append(f"{path.name}: not a scanner report (expected tool, commit and findings)")
                continue
            if data.get("commit") != commit:
                ignored.append(f"{path.name}: for commit {str(data.get('commit'))[:12]}, not this one")
                continue
            # A scanner that failed or scanned nothing has not shown anything: that is not a clean result.
            code, scanned, error = data.get("exit_code"), data.get("scanned"), data.get("error")
            reason = (f"the scanner reported an error: {' '.join(str(error).split())[:200]}" if error
                      else f"the scanner exited with code {code}" if type(code) is int and code not in (0, 1)
                      else "the scanner scanned no sources" if type(scanned) is int and scanned <= 0 else None)
            reports.append({"file": path.name, "sha256": sha(path.read_bytes()), "tool": data["tool"], "not_run": reason,
                            "exit_code": code if type(code) is int else None, "scanned": scanned if type(scanned) is int else None,
                            "findings": [{"id": str(f.get("id") or ""), "severity": str(f.get("severity") or "").lower(), "title": str(f.get("title") or "")}
                                         for f in data["findings"] if isinstance(f, dict)]})
        return reports, ignored

    # ---- running the project's own commands at the commit, on a clean tree ----

    def checkout(self, commit: str, folder: Path) -> None:
        """The tracked tree at exactly this commit, from Git's objects; no checkout is touched."""
        data = self._git_bytes("archive", "--format=tar", commit)
        if data is None:
            raise QualifyError(f"Could not read the tree at {commit[:12]}.")
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            members = []
            for member in tar.getmembers():
                parts = Path(member.name).parts
                if member.name.startswith("/") or ".." in parts or not (member.isfile() or member.isdir()):
                    continue
                members.append(member)
            safe = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}
            tar.extractall(str(folder), members=members, **safe)

    def run_command(self, folder: Path, command: Optional[str], source: Optional[str], timeout: int, log: Path) -> Dict[str, Any]:
        """Run one command with the audit station's runner. A command that cannot run is never a pass."""
        audit = self.audit_module()
        result: Dict[str, Any] = {"command": command, "source": source}
        if not command:
            return {**result, "status": "not_configured", "exit_code": None}
        try:
            repo = audit.Repo(folder)
            ran = audit.execute(repo, "test", command, {"test": timeout}, False)
        except Exception as exc:  # the project's own files decide whether its commands can run
            ran = {"status": "unavailable", "exit_code": None, "seconds": None, "output_tail": str(exc)}
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(f"$ {command}\nstatus: {ran.get('status')} exit code: {ran.get('exit_code')} seconds: {ran.get('seconds')}\n\n{ran.get('output_tail') or ''}\n", encoding="utf-8")
        status = {"pass": "pass", "fail": "fail", "timeout": "fail"}.get(str(ran.get("status")), "not_run")
        return {**result, "status": status, "exit_code": ran.get("exit_code"), "seconds": ran.get("seconds")}

    def audit_module(self):
        scripts = str(self.sibling("audit") / "scripts")
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        import audit  # the audit station: Repo, detect_commands, execute
        return audit

    def suite_command(self, folder: Path) -> Tuple[Optional[str], Optional[str]]:
        audit = self.audit_module()
        configured = ((self.config.get("audit") or {}).get("commands") or {}).get("test") if isinstance(self.config.get("audit"), dict) else None
        try:
            repo = audit.Repo(folder)
            found = audit.detect_commands(repo, {"test": configured if isinstance(configured, str) and configured.strip() else None})["test"]
        except Exception:
            return (configured if isinstance(configured, str) else None), ("config" if configured else None)
        return found["command"], ("config" if configured else found["source"])

    # ---- the evaluation ----

    def qualify(self, wave_ids: Sequence[str], release_id: Optional[str] = None, commit: Optional[str] = None) -> Dict[str, Any]:
        waves = sorted(dict.fromkeys(wave_ids), key=number)
        if not waves or any(not WAVE_RE.match(w) for w in waves):
            raise QualifyError("Name one or more delivery waves, such as WAVE-001.")
        source, commit = self.resolve(commit)
        release_id = release_id or f"{'-'.join(waves)}-{commit[:12]}"
        if not RELEASE_RE.match(release_id):
            raise QualifyError(f"'{release_id}' is not a usable release ID (letters, digits, '.', '_' and '-').")
        folder = self.home / release_id
        earlier = load_json(folder / "readiness.json")
        if isinstance(earlier, dict) and (earlier.get("release") or {}).get("commit") not in (None, commit):
            raise QualifyError(f"Release {release_id} was qualified at {earlier['release']['commit'][:12]}. A release ID names one commit; choose another ID for {commit[:12]}.")
        snap = self.line.snapshot(commit)
        missing = [w for w in waves if (snap.waves.get(w) or {}).get("status") != "approved_for_engineering"]
        if missing:
            raise QualifyError(f"Not an approved delivery wave at {commit[:12]}: {', '.join(missing)}. Only merged, approved waves can be qualified.")

        checks: Dict[str, Dict[str, Any]] = {}

        def check(check_id: str, kind: str, status: str, detail: str, required: bool = True, **extra: Any) -> None:
            checks[check_id] = {"id": check_id, "kind": kind, "status": status, "required": required, "detail": detail, **extra}

        whole, per_wave = self.line.verify(snap)
        check("product.definitions", "product", "fail" if whole else "pass", "; ".join(whole) or "The product definitions at this commit pass the structural validator.")
        for wave_id in waves:
            problems = per_wave.get(wave_id) or []
            check(f"product.{wave_id}", "product", "fail" if problems else "pass", "; ".join(problems) or "Approved, and every slice's spec and why pass the intent gates.")

        ledger = self.line.ledger()
        records = self.run_records()
        latest_commit = source.get("product_commit")
        latest = self.line.snapshot(latest_commit) if latest_commit and latest_commit != commit else snap
        in_scope: List[str] = []
        for wave_id in waves:
            in_scope += [s for s in snap.waves[wave_id].get("slices") or [] if s not in in_scope]
        integrated: Dict[str, bool] = {}
        slices_out, scenarios_out, approvals, open_blockers = [], [], [], []
        shared: Dict[str, List[Dict[str, Any]]] = {}

        for wave_id in waves:
            wave = snap.waves[wave_id]
            approval = wave.get("approval") or {}
            approvals.append({"kind": "product.wave_approval", "subject": wave_id, "by": approval.get("actor"), "at": approval.get("approved_at"),
                              "source": f"product/delivery-waves/{wave_id}.json at the release commit"})

        for slice_id in sorted(in_scope, key=number):
            work = snap.slices.get(slice_id) or {}
            digest = snap.slice_digest(slice_id)
            row: Dict[str, Any] = {"slice_id": slice_id, "wave_id": snap.wave_of(slice_id), "revision": work.get("revision"), "spec_path": work.get("spec_path"),
                                   "spec_sha256": work.get("spec_sha256"), "digest": digest, "dependencies": list(work.get("dependencies") or [])}
            entry = ledger["slices"].get(slice_id) or {}
            built = [entry] + [h for h in entry.get("history") or [] if isinstance(h, dict)]
            match = next((item for item in built if item.get("digest") == digest and item.get("ticket_id")), None)
            ticket_id = (match or {}).get("ticket_id")
            row["ticket_id"] = ticket_id
            if not entry:
                check(f"slice.{slice_id}.ticket", "slice", "missing", "This Factory never took the slice in (no intake ledger entry), so no execution of it is known.")
            elif not match:
                check(f"slice.{slice_id}.ticket", "slice", "fail", f"The ticket taken in is for revision {entry.get('revision')}; revision {work.get('revision')} approved at this commit was never built.")
            else:
                check(f"slice.{slice_id}.ticket", "slice", "pass", f"Ticket {ticket_id} was filed for revision {work.get('revision')}.")
            newer = latest.slice_digest(slice_id) if slice_id in latest.slices else None
            newer_waves = [w for w, data in latest.approved_waves().items() if slice_id in data["slices"]]
            if entry.get("state") == "superseded" and match is entry:
                check(f"slice.{slice_id}.current", "slice", "fail", "Product withdrew this slice after it was taken in.")
            elif newer and newer != digest and newer_waves and not self.contains(latest_commit, commit):
                check(f"slice.{slice_id}.current", "slice", "fail", f"A newer approved revision ({(latest.slices.get(slice_id) or {}).get('revision')}) is on the integration branch and is not part of this release.")
            else:
                check(f"slice.{slice_id}.current", "slice", "pass", "No newer approved revision supersedes this one.")

            facts = self.line.work(ticket_id, commit) if ticket_id else {"status": "unticketed"}
            integrated[slice_id] = facts.get("status") == "integrated"
            record = records.get(ticket_id or "") or {}
            row["integration"] = {"status": facts.get("status"), "commit": facts.get("commit"),
                                  "established_by": f"git merge-base --is-ancestor {facts.get('commit')} {commit}" if integrated[slice_id] else None,
                                  "recorded_in": "run record (integration)" if record.get("integration") else "the cell's merge record" if integrated[slice_id] else None}
            check(f"slice.{slice_id}.integrated", "slice", "pass" if integrated[slice_id] else "missing" if not ticket_id else "fail",
                  f"Its commit {str(facts.get('commit'))[:12]} is an ancestor of the release commit." if integrated[slice_id]
                  else f"Its work is not on the integration branch at this commit (now {facts.get('status')}).")

            files = self.archive(ticket_id) if ticket_id and record else {}
            cell = self.json_in(files, "cell.json")
            summary = self.json_in(files, "evidence/summary.json")
            decision = self.json_in(files, "review/decision.json")
            approved = ((record.get("integration") or {}).get("approved_commit")) or decision.get("head")
            where = f".factory/archive/{ticket_id}.tar.gz" if files else None
            row["verification"] = {"verdict": summary.get("status"), "head": summary.get("head"), "source": where and f"{where}:evidence/summary.json"}
            row["review"] = {"decision": decision.get("outcome"), "risk": decision.get("risk"), "round": decision.get("round"), "approved_commit": approved,
                             "human_approval_required": decision.get("human_approval_required"), "source": where and f"{where}:review/decision.json"}
            if not record:
                note = "No archived run record: the ticket has not been through cleanup, so its verdicts are not on record."
                for part in ("verification", "review"):
                    check(f"slice.{slice_id}.{part}", "slice", "missing", note)
            else:
                if record.get("outcome") != "merged":
                    check(f"slice.{slice_id}.run", "slice", "fail", f"The run record says the ticket was {record.get('outcome')}, not merged.")
                verdict = summary.get("status")
                if not summary:
                    check(f"slice.{slice_id}.verification", "slice", "missing", "The archive holds no verification summary.")
                elif verdict != "PASS":
                    check(f"slice.{slice_id}.verification", "slice", "fail", f"The last verification verdict is {verdict}.")
                elif approved and summary.get("head") != approved:
                    check(f"slice.{slice_id}.verification", "slice", "fail", f"Verification passed {str(summary.get('head'))[:12]}, but review approved {str(approved)[:12]}.")
                else:
                    check(f"slice.{slice_id}.verification", "slice", "pass", f"PASS at {str(summary.get('head'))[:12]}.")
                if not decision:
                    check(f"slice.{slice_id}.review", "slice", "missing", "The archive holds no review decision.")
                elif decision.get("outcome") != "APPROVED":
                    check(f"slice.{slice_id}.review", "slice", "fail", f"The last review decision is {decision.get('outcome')}.")
                elif decision.get("human_approval_required") and not decision.get("human_approval"):
                    check(f"slice.{slice_id}.review", "slice", "fail", "Review required a person's approval and none is recorded.")
                else:
                    check(f"slice.{slice_id}.review", "slice", "pass", f"APPROVED in round {decision.get('round')} ({decision.get('risk')} risk).")
                human = decision.get("human_approval")
                if isinstance(human, dict):
                    approvals.append({"kind": "review.human_approval", "subject": f"{slice_id} ({ticket_id})", "by": human.get("by"), "at": human.get("recorded_at"),
                                      "source": f"{where}:review/decision.json"})
                final_round = decision.get("round")
                stood = [b for b in record.get("blockers") or [] if isinstance(b, dict) and b.get("round") == final_round]
                if decision.get("outcome") == "APPROVED" and decision.get("blockers") and not stood:
                    stood = [{"round": final_round, "reviewer": None, "rule": None, "title": f"{decision.get('blockers')} blocker(s) outvoted; details not in the run record", "file": None}]
                for index, blocker in enumerate(stood, start=1):
                    blocker_id = f"blocker.{slice_id}.r{final_round}.{index}"
                    open_blockers.append({"check": blocker_id, "slice_id": slice_id, "ticket_id": ticket_id, "security": blocker.get("reviewer") == "security", **blocker})
                    check(blocker_id, "security" if blocker.get("reviewer") == "security" else "review", "fail",
                          f"Outvoted, still open: {blocker.get('title')} ({blocker.get('reviewer')}; breaks {blocker.get('rule')}).")

            # Required acceptance scenarios: every AC of the spec at this commit, with its recorded evidence.
            spec_text = snap.files.get(str(work.get("spec_path") or ""))
            ids: List[str] = []
            if spec_text is not None:
                _, model = self.line.validate_slice.analyze(spec_text.decode("utf-8-sig", errors="replace"), Path(str(work.get("spec_path"))).name, [], ready=False)
                ids = [s.get("id") for s in model.get("scenarios") or [] if isinstance(s, dict) and AC_RE.match(str(s.get("id")))]
            if not ids:
                check(f"scenario.{slice_id}", "scenario", "missing", "No acceptance scenarios could be read from the spec at this commit.")
            hashes = {e.get("file"): e.get("sha256") for e in summary.get("evidence_files") or [] if isinstance(e, dict)}
            for scenario_id in ids:
                recorded = (summary.get("checks") or {}).get(scenario_id) if isinstance(summary.get("checks"), dict) else None
                evidence = []
                for name in (recorded or {}).get("evidence") or []:
                    data = files.get(f"evidence/{name}")
                    evidence.append({"file": f"evidence/{name}", "sha256": sha(data) if data is not None else None,
                                     "matches_summary": data is not None and sha(data) == hashes.get(name)})
                if not recorded or not evidence:
                    status, detail = "missing", "No recorded evidence for this scenario."
                elif recorded.get("result") != "pass":
                    status, detail = "fail", f"Recorded as {recorded.get('result')}: {recorded.get('note')}"
                elif not all(e["matches_summary"] for e in evidence):
                    status, detail = "missing", "Its evidence file is missing from the archive or differs from the hash verification recorded."
                else:
                    status, detail = "pass", "Proven by the verifier with the evidence listed."
                scenarios_out.append({"slice_id": slice_id, "scenario_id": scenario_id, "status": status, "evidence": evidence})
                check(f"scenario.{slice_id}.{scenario_id}", "scenario", status, detail)

            # Contracts: gathered here, judged across the release below (a contract can be shared by slices).
            row["contracts"] = []
            for name in cell.get("contracts") or [] if isinstance(cell.get("contracts"), list) else []:
                shared.setdefault(str(name), []).append({"slice_id": slice_id, "ticket_id": ticket_id, "approved": approved,
                                                         "landed": facts.get("commit") if integrated[slice_id] else None, "row": row})
            slices_out.append(row)

        for name in sorted(shared):
            self.judge_contract(name, shared[name], commit, records, {row["ticket_id"] for row in slices_out}, check)

        for row in slices_out:
            for dep in row["dependencies"]:
                if dep in integrated:
                    ok = integrated[dep]
                    check(f"dependency.{row['slice_id']}.{dep}", "dependency", "pass" if ok else "fail",
                          f"{dep} is integrated at this commit." if ok else f"{dep} is not integrated at this commit.")
                else:
                    check(f"dependency.{row['slice_id']}.{dep}", "dependency", "pass" if self.dependency_integrated(dep, commit) else "fail",
                          f"{dep} is outside this release; whether it is integrated was checked the same way.")

        # Commands at exactly this commit, on a clean tree from Git's objects.
        logs = folder / "logs"
        commands: Dict[str, Dict[str, Any]] = {}
        with tempfile.TemporaryDirectory(prefix="mach-release-") as temporary:
            tree = Path(temporary) / "tree"
            tree.mkdir()
            self.checkout(commit, tree)
            command, origin = self.suite_command(tree)
            commands["test_suite"] = self.run_command(tree, command, origin, SUITE_TIMEOUT, logs / "test-suite.log")
            for key, setting in (("integration_tests", "integration_command"), ("performance", "performance_command")):
                value = self.settings.get(setting)
                value = value if isinstance(value, str) and value.strip() else None
                commands[key] = self.run_command(tree, value, "config" if value else None, SUITE_TIMEOUT, logs / f"{key.replace('_', '-')}.log")
        suite = commands["test_suite"]
        check("suite", "test", "not_run" if suite["status"] == "not_configured" else suite["status"],
              {"pass": "The whole suite passed at this commit.", "fail": f"The suite failed (exit code {suite['exit_code']})."}.get(suite["status"], "The suite could not be run, so it is not a pass."))
        check("integration_tests", "test", commands["integration_tests"]["status"],
              "No integration test command is declared (release.integration_command)." if commands["integration_tests"]["status"] == "not_configured"
              else f"Integration tests: {commands['integration_tests']['status']}.")
        perf = commands["performance"]
        check("performance", "test", perf["status"], "No performance command is declared; not assessed." if perf["status"] == "not_configured" else f"Performance: {perf['status']}.",
              required=perf["status"] != "not_configured")

        reports, ignored = self.scans(commit)
        if not reports:
            check("security.scan", "security", "not_run", "No scanner report for this commit under .factory/release/scans/.")
        for report in reports:
            if report["not_run"]:
                check(f"security.scan.{report['tool']}", "security", "not_run", f"Not a scan result: {report['not_run']}.")
                continue
            severe = [f for f in report["findings"] if f["severity"] in SEVERE]
            check(f"security.scan.{report['tool']}", "security", "fail" if severe else "pass",
                  f"{len(severe)} critical or high finding(s)." if severe else f"No critical or high findings ({len(report['findings'])} lower).")

        # Exceptions: a person's, for a check at exactly this commit. Any other is listed and ignored.
        applied, not_applied = [], []
        for item in self.exceptions(release_id):
            target = checks.get(str(item.get("check")))
            why = None
            if item.get("commit") != commit:
                why = "recorded for another commit"
            elif target is None:
                why = "no such check in this evaluation"
            elif target["status"] == "pass":
                why = "the check passes"
            if why:
                not_applied.append({**item, "not_applied_because": why})
            else:
                target["exception"] = {k: item.get(k) for k in ("by", "reason", "recorded_at", "commit")}
                applied.append(item)

        blocking = sorted(c["id"] for c in checks.values() if c["status"] == "fail" and not c.get("exception"))
        incomplete = sorted(c["id"] for c in checks.values() if c["required"] and c["status"] in INCOMPLETE and not c.get("exception"))
        excepted = sorted(c["id"] for c in checks.values() if c.get("exception"))
        outcome = "blocked" if blocking else "incomplete" if incomplete else "qualified_with_exceptions" if excepted else "qualified"
        unassessed = sorted(c["id"] for c in checks.values() if not c["required"] and c["status"] != "pass")
        words = {"not_configured": "not configured", "not_run": "not run", "missing": "missing", "fail": "failed"}
        summary_line = outcome + ("; not assessed: " + ", ".join(f"{key} ({words.get(checks[key]['status'], checks[key]['status'])})" for key in unassessed) if unassessed else "")

        project = snap.project
        body = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION,
            "release": {"release_id": release_id, "commit": commit, "integration_branch": source["branch"]},
            "product": {"project_id": project.get("project_id"), "name": project.get("name"), "revision": project.get("revision")},
            "waves": [{"wave_id": w, "revision": snap.waves[w].get("revision"), "sha256": sha(snap.files[f"product/delivery-waves/{w}.json"]),
                       "slices": list(snap.waves[w].get("slices") or [])} for w in waves],
            "slices": slices_out,
            "acceptance_scenarios": scenarios_out,
            "commands": {key: {k: v for k, v in value.items() if k != "seconds"} for key, value in commands.items()},
            "security": {"open_review_blockers": [b for b in open_blockers if b["security"]], "scanner_reports": reports, "scanner_reports_ignored": ignored},
            "unresolved_blockers": blocking,
            "incomplete": incomplete,
            "not_assessed": unassessed,
            "outcome_summary": summary_line,
            "checks": [checks[key] for key in sorted(checks)],
            "exceptions": applied, "exceptions_not_applied": not_applied,
            "human_approvals": approvals,
            "product_acceptance": self.acceptance(waves, release_id, commit, snap, latest),
            "outcome": outcome,
        }
        text = canonical(body)
        write_atomic(folder / "readiness.json", text)
        write_atomic(folder / "run.json", canonical({"release_id": release_id, "commit": commit, "evaluated_at": now(), "readiness_sha256": sha(text.encode("utf-8")),
                                                     "seconds": {key: value.get("seconds") for key, value in commands.items()},
                                                     "logs": sorted(p.relative_to(folder).as_posix() for p in logs.glob("*.log"))}))
        return {"release_id": release_id, "commit": commit, "outcome": outcome, "outcome_summary": summary_line, "not_assessed": unassessed, "readiness": str(folder / "readiness.json"),
                "unresolved_blockers": blocking, "incomplete": incomplete, "exceptions": excepted,
                "product_acceptance": body["product_acceptance"]["decision"], "released": False}

    def reviewed_change(self, name: str, approved: Optional[str], landed: Optional[str]) -> Tuple[Optional[bytes], bool]:
        """The contract as a review approved it, and whether that slice changed it: it differs from the slice's base,
        where its branch meets the integration branch as it was just before the slice landed."""
        then = self.file_at(approved, name) if approved else None
        if then is None or not landed:
            return then, False
        base = self._git("merge-base", approved, f"{landed}^1").stdout.strip()
        return then, (self.file_at(base, name) if base else None) != then

    def judge_contract(self, name: str, users: List[Dict[str, Any]], commit: str, records: Dict[str, Dict[str, Any]],
                       in_scope_tickets: set, check: Callable[..., None]) -> None:
        """A contract shared by slices must be, at the release, the version approved by the latest integrated
        review that changed it. An earlier slice's version is then superseded, not failed. It fails when no
        reviewed version matches (changed outside review); it is incomplete when the latest change came from a
        slice outside this release, whose review this release does not include."""
        now_bytes = self.file_at(commit, name)
        for user in users:
            user["then"], user["touched"] = self.reviewed_change(name, user["approved"], user["landed"])
        touchers = [u for u in users if u["landed"] and u["then"] is not None and u["touched"]]
        latest = None
        for user in touchers:
            if latest is None or self.contains(latest["landed"], user["landed"]):
                latest = user
        outside = self.outside_change(name, now_bytes, commit, records, in_scope_tickets) if now_bytes is not None and (latest is None or latest["then"] != now_bytes) else None
        for user in users:
            check_id = f"contract.{user['slice_id']}.{name}"
            item = {"path": name, "sha256_at_release": sha(now_bytes) if now_bytes is not None else None,
                    "sha256_approved": sha(user["then"]) if user["then"] is not None else None, "superseded_by": None}
            user["row"]["contracts"].append(item)
            if now_bytes is None:
                check(check_id, "contract", "fail", "The contract file does not exist at the release commit.")
            elif user["then"] is None:
                check(check_id, "contract", "missing", "The contract as this slice's review approved it cannot be read.")
            elif latest is not None and latest["then"] == now_bytes:
                if user is latest or user["then"] == now_bytes:
                    check(check_id, "contract", "pass", "Identical to the latest reviewed change to it in this release"
                          + ("." if user is latest else f" ({latest['slice_id']})."))
                else:
                    item["superseded_by"] = latest["slice_id"]
                    check(check_id, "contract", "pass", f"Superseded by {latest['slice_id']}'s reviewed change ({latest['ticket_id']}).")
            elif latest is None and user["then"] == now_bytes:
                check(check_id, "contract", "pass", "Unchanged since this slice's review approved it.")
            elif outside:
                check(check_id, "contract", "missing", f"The latest change to it came from {outside} outside this release, so the release would ship a contract "
                      "not reviewed within it. Qualify with that slice's wave included.")
            else:
                check(check_id, "contract", "fail", "The integrated file matches no version a review in this release approved: it was changed outside review.")

    def outside_change(self, name: str, now_bytes: bytes, commit: str, records: Dict[str, Dict[str, Any]], in_scope_tickets: set) -> Optional[str]:
        """An integrated ticket outside the release whose reviewed change made the contract what it is now."""
        for ticket_id, record in sorted(records.items()):
            if ticket_id in in_scope_tickets or record.get("outcome") != "merged":
                continue
            files = self.archive(ticket_id)
            cell = self.json_in(files, "cell.json")
            if name not in (cell.get("contracts") or []):
                continue
            approved = (record.get("integration") or {}).get("approved_commit") or self.json_in(files, "review/decision.json").get("head")
            facts = self.line.work(ticket_id, commit)
            if facts.get("status") != "integrated":
                continue
            then, touched = self.reviewed_change(name, approved, facts.get("commit"))
            if then == now_bytes and touched:
                return f"{cell.get('slice_id') or record.get('slice_id') or 'a slice'} ({ticket_id})"
        return None

    def dependency_integrated(self, slice_id: str, commit: str) -> bool:
        entry = self.line.ledger()["slices"].get(slice_id) or {}
        return bool(entry.get("ticket_id")) and self.line.work(entry["ticket_id"], commit).get("status") == "integrated"

    def acceptance(self, waves: Sequence[str], release_id: str, commit: str, snap: Any, latest: Any) -> Dict[str, Any]:
        """The product decision as recorded in the merged product files. Never inferred."""
        per_wave = []
        for wave_id in waves:
            relative = f"product/acceptance/{wave_id}.json"
            found, where = None, None
            for label, source in (("integration branch", latest), ("release commit", snap)):
                try:
                    data = json.loads(source.files[relative].decode("utf-8"))
                except (KeyError, ValueError, UnicodeDecodeError):
                    continue
                if isinstance(data, dict):
                    found, where = data, label
                    break
            wave_sha = sha(snap.files[f"product/delivery-waves/{wave_id}.json"])
            if found is None:
                per_wave.append({"wave_id": wave_id, "decision": "not_recorded", "reason": "No acceptance file in the merged product files."})
            elif found.get("release_commit") != commit or found.get("release_id") != release_id:
                per_wave.append({"wave_id": wave_id, "decision": "not_recorded", "reason": f"The recorded acceptance is for release {found.get('release_id')} at {str(found.get('release_commit'))[:12]}."})
            elif found.get("wave_sha256") != wave_sha:
                per_wave.append({"wave_id": wave_id, "decision": "not_recorded", "reason": "The recorded acceptance is for another revision of the wave."})
            elif found.get("decision") in ("accepted", "rejected"):
                per_wave.append({"wave_id": wave_id, "decision": found["decision"], "by": found.get("by"), "at": found.get("recorded_at"),
                                 "source": f"{relative} on the {where}"})
            else:
                per_wave.append({"wave_id": wave_id, "decision": "not_recorded", "reason": "The acceptance file holds no decision."})
        decisions = {item["decision"] for item in per_wave}
        overall = "rejected" if "rejected" in decisions else "accepted" if decisions == {"accepted"} else "not_recorded"
        return {"decision": overall, "waves": per_wave}

    # ---- reading and exceptions ----

    def status(self) -> Dict[str, Any]:
        releases = []
        for path in sorted(self.home.glob("*/readiness.json")) if self.home.is_dir() else []:
            data = load_json(path) or {}
            run = load_json(path.parent / "run.json") or {}
            releases.append({"release_id": path.parent.name, "commit": (data.get("release") or {}).get("commit"), "outcome": data.get("outcome"),
                             "waves": [w.get("wave_id") for w in data.get("waves") or []], "product_acceptance": (data.get("product_acceptance") or {}).get("decision"),
                             "evaluated_at": run.get("evaluated_at")})
        source = self.line.integration()
        snap = self.line.snapshot(source["commit"]) if source.get("commit") and not source["problems"] else None
        return {"releases": releases, "integration": {"branch": source.get("branch"), "commit": source.get("commit"), "problems": source["problems"]},
                "approved_waves": sorted(snap.approved_waves(), key=number) if snap else [], "released": False}

    def show(self, release_id: str) -> Dict[str, Any]:
        if not RELEASE_RE.match(release_id):
            raise QualifyError(f"'{release_id}' is not a usable release ID.")
        folder = self.home / release_id
        data = load_json(folder / "readiness.json")
        if not isinstance(data, dict):
            raise QualifyError(f"No readiness snapshot for release {release_id}. Run: release qualify <WAVE-ID>... --release {release_id}")
        return {"readiness": data, "run": load_json(folder / "run.json"), "exceptions_recorded": self.exceptions(release_id)}

    def record_exception(self, release_id: str, check_id: str, by: str, reason: str) -> Dict[str, Any]:
        data = self.show(release_id)["readiness"]
        if not ROLE_RE.match(by or ""):
            raise QualifyError("--by names a role, such as release-manager or security-lead: lowercase letters, digits and '-', never a person's name or address.")
        reason = " ".join((reason or "").split())
        if len(reason) < 10:
            raise QualifyError("--reason must say why this exception is acceptable.")
        target = next((c for c in data.get("checks") or [] if c.get("id") == check_id), None)
        if target is None:
            raise QualifyError(f"Release {release_id} has no check '{check_id}'.")
        if target.get("status") == "pass":
            raise QualifyError(f"'{check_id}' passes; there is nothing to except.")
        item = {"release_id": release_id, "check": check_id, "commit": data["release"]["commit"], "by": by, "reason": reason, "recorded_at": now(),
                "recorded_by": "an agent, on a person's explicit instruction in conversation"}
        path = self.home / release_id / "exceptions.jsonl"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(item, sort_keys=True, ensure_ascii=False) + "\n")
        return {"recorded": item, "next": f"Run release qualify again for {release_id}; the exception applies only at commit {item['commit'][:12]}.", "released": False}
