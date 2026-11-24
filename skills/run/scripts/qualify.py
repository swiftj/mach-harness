#!/usr/bin/env python3
"""MACH release qualification: does the integrated capability work, at one exact commit?

Each slice is verified and reviewed in its own cell. Nothing in the line says whether the slices
of an epic, or of a named list of slices, work together once they are on the integration branch.
This module measures that and records a decision, reached as `run.py release ...`:

    status                       releases qualified so far, and what a new run would evaluate
    qualify --epic <EPIC-ID|issue number> | <SLICE-ID>... [--release <id>] [--commit <sha>]
                                 evaluate the integration branch at one commit and write
                                 .factory/release/<release-id>/readiness.json
    show <release-id>            the snapshot, the exceptions and the run's metadata
    except --release <id> --check <check-id> --by <role> --reason <text>
                                 record a person's exception for one check at the snapshot's commit

The snapshot is deterministic: the same inputs give the same bytes (sorted keys, no wall-clock
inside it). When the run happened, how long it took and the suite's output sit beside it in
run.json and the logs, outside the decision.

What a slice's execution is read from: the change record the merge station committed with the ticket
(version 2, change_record.py), on the integration branch at the release commit. So a machine that
built none of the slices reads what the machines that built them recorded. A record counts only
when it is bound: the last commit to touch it adds only the record, on top of the commit review
approved (or that commit brought up to date and tested again); that commit came in through a merge,
never as a commit made on the integration branch itself; and the spec on its branch, and the spec
at the release commit, both have the SHA-256 the record names. A record edited or replaced after it
landed is not bound, and its slice is blocked. The evidence files stay in the archive of the machine
that built the ticket, when its cleanup kept one (cleanup.archive): where this machine holds one, it is
checked against the recorded SHA-256; where it does not, the recorded hash stands, and run.json says how
many were held on another machine and how many were built here with no archive kept.

What it reuses, and never reimplements: intake's spec header, its validators and, for work still in
the line here, its ledger and its rule for what is integrated; the merge station's change record and
its rule for the record commit; the cleanup station's archives; the audit station's detection and
running of the test command; the ticket station's read of an epic's issue.

What it never does: land, publish or label a commit, change any checkout, write to GitHub, start a
station, an agent or a workflow, or read the machine-local Factory settings. Product acceptance is
read from the epic issue's acceptance comments, checked like an approval; it is never inferred from
a merge or a passing suite.

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
SCHEMA_VERSION = 3  # 3: each slice read from its committed change record; 2: an epic or a named list of slices, acceptance per epic
OUTCOMES = ("qualified", "qualified_with_exceptions", "blocked", "incomplete")
INCOMPLETE = ("missing", "not_run", "not_configured")  # a required check in one of these states was not shown to pass
RELEASE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
SLICE_RE = re.compile(r"^SLICE-[0-9]{3,}$")
EPIC_RE = re.compile(r"^EPIC-[0-9]{3,}$")
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


def review_exceptions(decision: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The security exceptions in force on the approving review decision (review.py except): the latest for each finding."""
    latest: Dict[str, Dict[str, Any]] = {}
    for item in decision.get("exceptions") or [] if isinstance(decision.get("exceptions"), list) else []:
        if isinstance(item, dict):
            latest[f"{item.get('round')}/{item.get('seat')}/{item.get('index')}"] = item
    return list(latest.values())


def lapsed(item: Dict[str, Any]) -> bool:
    """Whether a review exception's expiry (the last day it holds, UTC) has passed. None never lapses; an unreadable one has."""
    if not item.get("expires"):
        return False
    try:
        return datetime.strptime(str(item["expires"]), "%Y-%m-%d").date() < datetime.now(timezone.utc).date()
    except ValueError:
        return True


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

    @staticmethod
    def archive_file(path: Path, ticket_id: str) -> Dict[str, bytes]:
        """Every file in a cleaned-up ticket's archive, by its path inside the cell folder."""
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

    # ---- change records, read from the integration branch ----

    def record_module(self):
        scripts = str(self.sibling("merge") / "scripts")
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        import change_record  # the merge station: the record's facts and the rule for the record commit
        return change_record

    def committed_records(self, commit: str) -> List[Dict[str, Any]]:
        """Every version 2 change record in the records folder at the commit, with the facts it carries. A file that
        is not one (an earlier version, a person's note) is passed over, never parsed."""
        module = self.record_module()
        folder = module.settings(self.config)["dir"]
        found = []
        for path in sorted(self._git("ls-tree", "--name-only", commit, "--", folder + "/").stdout.splitlines()):
            data = self.file_at(commit, path) if module.PATH_RE.match(path) else None
            facts = module.read_facts(data.decode("utf-8", errors="replace")) if data is not None else None
            if facts is not None:
                found.append({"path": path, "sha256": sha(data), "facts": facts})
        return found

    def bind(self, record: Dict[str, Any], commit: str) -> Dict[str, Any]:
        """Whether a record at the release commit is the one the merge station landed, unchanged: `problem` says why not.
        `added` is its record commit and `landed_in` the commit on the integration branch that brought it in."""
        if "bound" in record:
            return record["bound"]
        module = self.record_module()
        facts, path = record["facts"], record["path"]
        commits, spec = facts["commits"], facts["spec"]
        base, approved = commits.get("base"), commits.get("approved")
        added = self._git("log", "-1", "--format=%H", commit, "--", path).stdout.strip()
        merge, problem = None, None
        if not COMMIT_RE.match(added) or not isinstance(base, str) or not isinstance(approved, str):
            problem = "it does not name the commits it was written for"
        elif base not in (approved, commits.get("revalidated")):
            problem = "it was not written on top of the commit review approved, or of that commit brought up to date and tested again"
        elif not module.holds(lambda work, *args: self._git(*args), self.root, {"commit": added, "parent": base, "path": path}, added, [base]):
            problem = (f"the last commit to touch it ({added[:12]}) is not the merge station's record commit, which adds only the record on top of "
                       f"{base[:12]}: the record was changed after it landed, or did not land with its ticket")
        else:
            # The commit on the integration branch's own line that first held the record commit: the merge of the ticket.
            line = self._git("rev-list", "--first-parent", "--ancestry-path", f"{added}..{commit}").stdout.split()
            merge = line[-1] if line else None
            then = self.file_at(added, spec["path"]) if isinstance(spec.get("path"), str) else None
            if merge is None or self._git("merge-base", "--is-ancestor", added, f"{merge}^1").returncode == 0:
                merge, problem = None, "its commit was made on the integration branch itself, not merged in with a ticket's branch"
            elif then is None or sha(self.line_module().without_header(then.decode("utf-8-sig", errors="replace"))[0].encode("utf-8")) != spec.get("sha256"):
                problem = "the spec on its branch is not the spec whose SHA-256 it names"
        record["bound"] = {"added": added if COMMIT_RE.match(added) else None, "landed_in": merge, "problem": problem}
        return record["bound"]

    def held_here(self, ticket_id: Optional[str], commits: Dict[str, Any]) -> Tuple[Dict[str, bytes], str]:
        """The files of this ticket's archive when this machine built it (the run record that names the same approved commit), and
        where its evidence is: "here" (its archive is read), "not_kept" (this machine built it and cleanup kept no archive,
        cleanup.archive) or "elsewhere" (another machine built it)."""
        for record in reversed(self.line.run_records(ticket_id) if ticket_id else []):
            if ((record.get("integration") or {}).get("approved_commit")) == commits.get("approved"):
                files = self.archive_of(record)
                return (files, "here") if files or isinstance(record.get("archive"), str) else (files, "not_kept")
        return {}, "elsewhere"

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
            # A report MACH cannot check is not evidence: it must say what ran, how it ended, what it read and when.
            lacking = [field for field, ok in (("version", isinstance(data.get("version"), str) and data["version"].strip()),
                                               ("exit_code", type(code) is int), ("scanned", type(scanned) is int),
                                               ("scanned_at", isinstance(data.get("scanned_at"), str) and data["scanned_at"].strip())) if not ok]
            reason = (f"report lacks {', '.join(lacking)}" if lacking
                      else f"the scanner reported an error: {' '.join(str(error).split())[:200]}" if error
                      else f"the scanner exited with code {code}" if code not in (0, 1)
                      else "the scanner scanned no sources" if scanned <= 0 else None)
            reports.append({"file": path.name, "sha256": sha(path.read_bytes()), "tool": data["tool"], "not_run": reason,
                            "version": data.get("version") if isinstance(data.get("version"), str) else None,
                            "scanned_at": data.get("scanned_at") if isinstance(data.get("scanned_at"), str) else None,
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

    # ---- the scope: an epic, or a named list of slices ----

    def specs_at(self, commit: str) -> Dict[str, Dict[str, Any]]:
        """Every slice spec at the commit: its path, the approved text (header taken off) and what the header names."""
        found: Dict[str, Dict[str, Any]] = {}
        listing = self._git("ls-tree", "--name-only", commit, "--", "specs/slices/").stdout.splitlines()
        for path in listing:
            match = re.match(r"^specs/slices/(SLICE-[0-9]{3,})-[a-z0-9-]+\.md$", path)
            data = self.file_at(commit, path) if match else None
            if data is None or match.group(1) in found:
                continue
            text, header = self.line_module().without_header(data.decode("utf-8-sig", errors="replace"))
            found[match.group(1)] = {"path": path, "text": text, "spec_sha256": sha(text.encode("utf-8")),
                                     "epic_id": header.group(2) if header else None, "epic_issue": int(header.group(3)) if header and header.group(3) else None,
                                     "issue": int(header.group(4)) if header and header.group(4) else None}
        return found

    def line_module(self):
        import intake  # beside this script: the spec header and its reading
        return intake

    def scope(self, epic: Optional[str], slice_ids: Sequence[str], specs: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        """Which slices the release holds. An epic's are every spec at the commit whose header names it, every slice this
        Factory took in for it, and, when GitHub can be read, every slice its issue lists; a named list is just that list."""
        entries = self.line.ledger()["slices"]
        if epic is None:
            names = sorted(dict.fromkeys(slice_ids), key=number)
            if not names or any(not SLICE_RE.match(name) for name in names):
                raise QualifyError("Name an epic (--epic EPIC-001, or its issue number) or one or more slices, such as SLICE-001.")
            return {"epic": None, "slices": names, "listed_issues": [], "github": None}
        if slice_ids:
            raise QualifyError("Name an epic or a list of slices, not both.")
        bare = epic.lstrip("#")
        if EPIC_RE.match(epic):
            epic_id, issue = epic, None
        elif bare.isdigit() and int(bare) > 0:
            epic_id, issue = None, int(bare)
        else:
            raise QualifyError(f"'{epic}' is not an epic: give its ID (EPIC-001) or its issue number.")
        for entry in entries.values():
            known = entry.get("epic") or {}
            if epic_id and known.get("epic_id") == epic_id and known.get("issue"):
                issue = issue or known["issue"]
            if issue and known.get("issue") == issue and known.get("epic_id"):
                epic_id = epic_id or known["epic_id"]
        for spec in specs.values():
            if epic_id and spec["epic_id"] == epic_id and spec["epic_issue"]:
                issue = issue or spec["epic_issue"]
            if issue and spec["epic_issue"] == issue:
                epic_id = epic_id or spec["epic_id"]
        github = None
        if issue:
            github = self.line.ticket_json("epic-check", str(issue)) or {"failure": {"kind": "other"}}
            listed_epic = github.get("epic") or {}
            if listed_epic.get("epic_id"):
                if epic_id and listed_epic["epic_id"] != epic_id:
                    raise QualifyError(f"Issue #{issue} is {listed_epic['epic_id']}, not {epic_id}.")
                epic_id = listed_epic["epic_id"]
        if not epic_id:
            raise QualifyError(f"Epic {epic} is not known here: no slice taken in or merged names it, and its issue could not be read.")
        names = {key for key, entry in entries.items() if (entry.get("epic") or {}).get("epic_id") == epic_id}
        names |= {key for key, spec in specs.items() if spec["epic_id"] == epic_id}
        listed = [n for n in ((github or {}).get("epic") or {}).get("order") or [] if type(n) is int]
        by_issue = {entry.get("issue"): key for key, entry in entries.items() if entry.get("issue")}
        by_issue.update({item.get("issue"): key for key, entry in entries.items() for item in entry.get("history") or [] if item.get("issue")})
        by_issue.update({spec["issue"]: key for key, spec in specs.items() if spec["issue"]})
        names |= {by_issue[n] for n in listed if n in by_issue}
        if not names and not listed:
            raise QualifyError(f"Epic {epic} is not known here: no slice taken in or merged names it" + ("." if issue else ", and it has no issue to read."))
        return {"epic": {"epic_id": epic_id, "issue": issue}, "slices": sorted(names, key=number), "github": github,
                "listed_issues": sorted(n for n in listed if n not in by_issue)}

    # ---- the evaluation ----

    def archive_of(self, record: Dict[str, Any]) -> Dict[str, bytes]:
        relative = record.get("archive") if isinstance(record.get("archive"), str) else None
        if not relative:
            return {}
        path = self.root / relative
        try:
            if not path.resolve().is_relative_to((self.root / ".factory" / "archive").resolve()):
                return {}
        except OSError:
            return {}
        return self.archive_file(path, str(record.get("ticket_id")))

    def qualify(self, slice_ids: Sequence[str] = (), epic: Optional[str] = None, release_id: Optional[str] = None, commit: Optional[str] = None) -> Dict[str, Any]:
        source, commit = self.resolve(commit)
        specs = self.specs_at(commit)
        scope = self.scope(epic, slice_ids, specs)
        label = scope["epic"]["epic_id"] if scope["epic"] else "-".join(scope["slices"][:3]) + ("-and-more" if len(scope["slices"]) > 3 else "")
        release_id = release_id or f"{label}-{commit[:12]}"
        if not RELEASE_RE.match(release_id):
            raise QualifyError(f"'{release_id}' is not a usable release ID (letters, digits, '.', '_' and '-').")
        folder = self.home / release_id
        earlier = load_json(folder / "readiness.json")
        if isinstance(earlier, dict) and (earlier.get("release") or {}).get("commit") not in (None, commit):
            raise QualifyError(f"Release {release_id} was qualified at {earlier['release']['commit'][:12]}. A release ID names one commit; choose another ID for {commit[:12]}.")

        checks: Dict[str, Dict[str, Any]] = {}

        def check(check_id: str, kind: str, status: str, detail: str, required: bool = True, **extra: Any) -> None:
            checks[check_id] = {"id": check_id, "kind": kind, "status": status, "required": required, "detail": detail, **extra}

        if not scope["slices"] and not scope["listed_issues"]:
            check("scope", "product", "missing", "The epic holds no slice this Factory knows of, and none is merged.")
        for issue in scope["listed_issues"]:
            check(f"issue.{issue}", "slice", "missing", f"The epic lists issue #{issue}, which this Factory never took in, and no spec at this commit names it.")
        github = scope.get("github")
        if scope["epic"] and scope["epic"]["issue"] and (github or {}).get("epic") is None:
            check("scope.github", "product", "missing", f"The epic's issue #{scope['epic']['issue']} could not be read, so slices it lists but this Factory never "
                  "took in may be missing from this release.", reason="its issue could not be read")

        ledger = self.line.ledger()
        entries = ledger["slices"]
        committed = self.committed_records(commit)
        integrated: Dict[str, bool] = {}
        slices_out, scenarios_out, approvals, open_blockers = [], [], [], []
        shared: Dict[str, List[Dict[str, Any]]] = {}
        in_scope_records: set = set()
        evidence_held, evidence_elsewhere, evidence_not_kept = 0, 0, 0

        for slice_id in scope["slices"]:
            entry = entries.get(slice_id) or {}
            spec = specs.get(slice_id)
            # The change record written for the spec at this commit, among those the branch holds for the slice.
            written = [item for item in committed if item["facts"].get("slice_id") == slice_id]
            record = next((item for item in reversed(written) if spec and item["facts"]["spec"].get("sha256") == spec["spec_sha256"]), None)
            bound = self.bind(record, commit) if record else {"added": None, "landed_in": None, "problem": None}
            facts = record["facts"] if record and not bound["problem"] else {}
            ticket_id = (record["facts"].get("ticket_id") if record else None)
            if record:
                in_scope_records.add(record["path"])
            # What this Factory's own ledger knows of the slice: a newer approved revision, who approved it, work still in the line.
            lives = [entry] + [item for item in reversed(entry.get("history") or []) if isinstance(item, dict)] if entry else []
            life = next((item for item in lives if spec and item.get("spec_sha256") == spec["spec_sha256"]), None)
            dependencies = list(facts.get("depends_on") or []) if facts else [dep.get("slice_id") or f"#{dep.get('issue')}" for dep in entry.get("depends") or []]
            row: Dict[str, Any] = {"slice_id": slice_id, "issue": (spec or {}).get("issue") or (record["facts"].get("issue") if record else None),
                                   "epic_id": (spec or {}).get("epic_id") or (record["facts"].get("epic_id") if record else None) or (entry.get("epic") or {}).get("epic_id"),
                                   "revision": record["facts"].get("revision") if record else None, "spec_path": (spec or {}).get("path"),
                                   "spec_sha256": (spec or {}).get("spec_sha256"), "ticket_id": ticket_id, "dependencies": dependencies,
                                   "change_record": {"path": record["path"], "sha256": record["sha256"], "commit": bound["added"]} if record else None}
            if spec is None:
                check(f"slice.{slice_id}.spec", "slice", "fail" if entry.get("dispatched_at") else "missing", "Its spec is not on the integration branch at this commit.")
            else:
                findings, model = self.line.validate_slice.analyze(spec["text"], Path(spec["path"]).name, [], ready=True)
                problems = [f"{f.message} [{f.rule}]" for f in findings if f.severity == "error"]
                check(f"slice.{slice_id}.spec", "slice", "fail" if problems else "pass", "; ".join(problems[:5]) or "Its spec at this commit passes the intent station's gates.")
            if record:
                check(f"slice.{slice_id}.ticket", "slice", "pass", f"Ticket {ticket_id} built revision {record['facts'].get('revision')}; its change record is {record['path']}.")
            elif written and spec:
                check(f"slice.{slice_id}.ticket", "slice", "fail", "The spec at this commit is not the one a change record on the branch was written for "
                      f"({written[-1]['path']}, revision {written[-1]['facts'].get('revision')}).")
            else:
                check(f"slice.{slice_id}.ticket", "slice", "missing", "No change record for this slice is on the integration branch at this commit, so no execution of it is known.")
            newer = entry.get("product_pending") or (entry if life is not None and life is not entry and entry.get("revision") != life.get("revision") else None)
            if newer and not (newer is entry and entry.get("integrated") and self.contains((entry.get("integrated") or {}).get("commit"), commit)):
                check(f"slice.{slice_id}.current", "slice", "fail", f"A newer revision ({newer.get('revision')}) was approved and is not part of this release.")
            else:
                check(f"slice.{slice_id}.current", "slice", "pass", "No newer approved revision supersedes this one.")

            integrated[slice_id] = bool(record) and not bound["problem"]
            landed = bound["landed_in"] if integrated[slice_id] else None
            row["integration"] = {"status": "integrated" if integrated[slice_id] else "not integrated", "commit": landed,
                                  "established_by": f"git merge-base --is-ancestor {bound['added']} {commit}" if integrated[slice_id] else None,
                                  "recorded_in": record["path"] if integrated[slice_id] else None}
            if integrated[slice_id]:
                check(f"slice.{slice_id}.integrated", "slice", "pass", f"Its change record was added by {bound['added'][:12]} and merged in {landed[:12]}, "
                      "and is unchanged at the release commit.")
            elif record:
                check(f"slice.{slice_id}.integrated", "slice", "fail", f"Its change record {record['path']} does not count: {bound['problem']}.")
            else:
                # Work still in the line on this machine is a fact to say, never "unticketed".
                worked = entry.get("ticket_id") if entry.get("dispatched_at") else None
                state = self.line.work(worked, commit, int(entry.get("earlier_runs") or 0)).get("status") if worked else None
                check(f"slice.{slice_id}.integrated", "slice", "fail" if worked else "missing",
                      f"Its work is not on the integration branch with a change record at this commit (here it is {state})." if worked
                      else "No change record binds its work to the integration branch at this commit.")

            verification = facts.get("verification") or {}
            decision = facts.get("review") or {}
            approved = (facts.get("commits") or {}).get("approved")
            where = record["path"] if facts else None
            row["verification"] = {"verdict": verification.get("status"), "head": verification.get("head"), "source": where}
            row["review"] = {"decision": decision.get("outcome"), "risk": decision.get("risk"), "round": decision.get("round"), "approved_commit": approved,
                             "human_approval_required": decision.get("human_approval_required"), "source": where}
            if not facts:
                note = ("Its change record does not count, so its verdicts are not shown." if record
                        else "No change record on the integration branch: its verdicts are not on record.")
                for part in ("verification", "review"):
                    check(f"slice.{slice_id}.{part}", "slice", "missing", note)
            else:
                verdict = verification.get("status")
                if not verdict:
                    check(f"slice.{slice_id}.verification", "slice", "missing", "The change record holds no verification verdict.")
                elif verdict != "PASS":
                    check(f"slice.{slice_id}.verification", "slice", "fail", f"The last verification verdict is {verdict}.")
                elif verification.get("head") != approved:
                    check(f"slice.{slice_id}.verification", "slice", "fail", f"Verification passed {str(verification.get('head'))[:12]}, but review approved {str(approved)[:12]}.")
                else:
                    check(f"slice.{slice_id}.verification", "slice", "pass", f"PASS at {str(verification.get('head'))[:12]}.")
                if not decision.get("outcome"):
                    check(f"slice.{slice_id}.review", "slice", "missing", "The change record holds no review decision.")
                elif decision.get("outcome") != "APPROVED":
                    check(f"slice.{slice_id}.review", "slice", "fail", f"The last review decision is {decision.get('outcome')}.")
                elif decision.get("head") != approved:
                    check(f"slice.{slice_id}.review", "slice", "fail", f"Review decided on {str(decision.get('head'))[:12]}, but the record was written for {str(approved)[:12]}.")
                elif decision.get("human_approval_required") and not decision.get("human_approval"):
                    check(f"slice.{slice_id}.review", "slice", "fail", "Review required a person's approval and none is recorded.")
                else:
                    check(f"slice.{slice_id}.review", "slice", "pass", f"APPROVED in round {decision.get('round')} ({decision.get('risk')} risk).")
                human = decision.get("human_approval")
                if isinstance(human, dict):
                    approvals.append({"kind": "review.human_approval", "subject": f"{slice_id} ({ticket_id})", "by": human.get("by"), "at": human.get("recorded_at"),
                                      "source": where})
                final_round = decision.get("round")
                stood = [b for b in facts.get("blockers") or [] if isinstance(b, dict)]
                if decision.get("outcome") == "APPROVED" and decision.get("blockers") and not stood:
                    stood = [{"round": final_round, "reviewer": None, "rule": None, "title": f"{decision.get('blockers')} blocker(s) outvoted; details not in the change record", "file": None}]
                excepted = review_exceptions(decision)
                for index, blocker in enumerate(stood, start=1):
                    blocker_id = f"blocker.{slice_id}.r{final_round}.{index}"
                    security = blocker.get("reviewer") == "security" or blocker.get("class") == "security"
                    given = next((item for item in excepted if item.get("seat") == blocker.get("reviewer") and item.get("title") == blocker.get("title")
                                  and item.get("rule") == blocker.get("rule") and item.get("file") == blocker.get("file")), None)
                    found = {"check": blocker_id, "slice_id": slice_id, "ticket_id": ticket_id, "security": security, **blocker}
                    what = f"{blocker.get('title')} ({blocker.get('reviewer')}; breaks {blocker.get('rule')})"
                    if given is None:
                        open_blockers.append(found)
                        check(blocker_id, "security" if security else "review", "fail", f"Outvoted, still open: {what}.")
                        continue
                    # A person's exception from review: listed with who and why, and counted as an exception (a gap a person accepted),
                    # never as a pass. It lapses at its expiry like the review approval it allowed.
                    exception = {"source": "review", "finding": f"{given.get('round')}/{given.get('seat')}/{given.get('index')}", "by": given.get("by"),
                                 "reason": given.get("reason"), "recorded_at": given.get("recorded_at"), "commit": given.get("head"), "expires": given.get("expires")}
                    if lapsed(given):
                        open_blockers.append({**found, "exception_expired": exception})
                        check(blocker_id, "security" if security else "review", "fail",
                              f"Still open: {what}. A person excepted it in review until {given.get('expires')}, and that has passed.")
                    else:
                        open_blockers.append({**found, "excepted": exception})
                        check(blocker_id, "security" if security else "review", "fail",
                              f"Excepted in review by a person, still open: {what}.", exception=exception)
            if life is not None and life.get("approved_by"):
                approvals.append({"kind": "product.slice_approval", "subject": f"{slice_id} revision {life.get('revision')}", "by": life.get("approved_by"),
                                  "at": life.get("ready_at"), "source": f"the approval comment on issue #{life.get('issue')}" if life.get("issue") else "the ready folder"})

            # Required acceptance scenarios: every AC of the spec at this commit, with its recorded evidence. The record names each
            # evidence file with its SHA-256; a file this machine holds is checked against it.
            ids: List[str] = []
            if spec is not None:
                _, model = self.line.validate_slice.analyze(spec["text"], Path(spec["path"]).name, [], ready=False)
                ids = [s.get("id") for s in model.get("scenarios") or [] if isinstance(s, dict) and AC_RE.match(str(s.get("id")))]
            if not ids:
                check(f"scenario.{slice_id}", "scenario", "missing", "No acceptance scenarios could be read from the spec at this commit.")
            files, kept = self.held_here(ticket_id, facts.get("commits") or {}) if facts else ({}, "elsewhere")
            hashes = {e.get("file"): e.get("sha256") for e in verification.get("evidence_files") or [] if isinstance(e, dict)}
            for scenario_id in ids:
                recorded = (verification.get("checks") or {}).get(scenario_id) if isinstance(verification.get("checks"), dict) else None
                evidence, differs = [], []
                for name in (recorded or {}).get("evidence") or []:
                    data = files.get(f"evidence/{name}")
                    evidence.append({"file": f"evidence/{name}", "sha256": hashes.get(name)})
                    if data is None and kept == "not_kept":
                        evidence_not_kept += 1  # built here; cleanup kept no archive (cleanup.archive): the recorded hash stands
                    elif data is None:
                        evidence_elsewhere += 1
                    else:
                        evidence_held += 1
                        if sha(data) != hashes.get(name):
                            differs.append(name)
                if not recorded or not evidence:
                    status, detail = "missing", "No recorded evidence for this scenario."
                elif recorded.get("result") != "pass":
                    status, detail = "fail", f"Recorded as {recorded.get('result')}: {recorded.get('note')}"
                elif not all(e["sha256"] for e in evidence):
                    status, detail = "missing", "The change record names an evidence file without its SHA-256."
                elif differs:
                    status, detail = "missing", f"An evidence file in this machine's archive differs from the SHA-256 the change record names ({', '.join(differs)})."
                else:
                    status, detail = "pass", "Proven by the verifier, with the evidence the change record names by SHA-256."
                scenarios_out.append({"slice_id": slice_id, "scenario_id": scenario_id, "status": status, "evidence": evidence})
                check(f"scenario.{slice_id}.{scenario_id}", "scenario", status, detail)

            # Contracts: gathered here, judged across the release below (a contract can be shared by slices).
            row["contracts"] = []
            for name in facts.get("contracts") or []:
                shared.setdefault(str(name), []).append({"slice_id": slice_id, "ticket_id": ticket_id, "approved": approved, "landed": landed, "row": row})
            slices_out.append(row)

        outside = [item for item in committed if item["path"] not in in_scope_records]
        for name in sorted(shared):
            self.judge_contract(name, shared[name], commit, outside, check)

        for row in slices_out:
            entry = entries.get(row["slice_id"]) or {}
            # The slices a change record says its ticket depended on; for a slice with no record that counts, what this Factory's ledger says.
            depends = [{"slice_id": name} for name in row["dependencies"]] if row["integration"]["commit"] else list(entry.get("depends") or [])
            for dep in depends:
                label, found = self.line.resolve_dep(dep, entries)
                found = found or dep.get("slice_id")
                if found in integrated:
                    ok = integrated[found]
                    detail = f"{label} is integrated at this commit." if ok else f"{label} is not integrated at this commit."
                else:
                    ok = self.dependency_integrated(dep, found, committed, specs, commit)
                    detail = f"{label} is outside this release; whether it is integrated was checked the same way."
                check(f"dependency.{row['slice_id']}.{found or label.lstrip('#')}", "dependency", "pass" if ok else "fail", detail)
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
            check("security.scan", "security", "not_run", "No scanner report for this commit under .factory/release/scans/.", reason="no scanner report for this commit")
        for report in reports:
            if report["not_run"]:
                check(f"security.scan.{report['tool']}", "security", "not_run", f"Not a scan result: {report['not_run']}.", reason=report["not_run"])
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
        # Every check that was not shown, required or not, excepted or not, is named on the outcome line with its reason.
        words = {"not_configured": "not configured", "not_run": "not run", "missing": "missing"}

        def gap(item: Dict[str, Any]) -> str:
            why = item.get("reason") or ("" if item["status"] == "not_configured" else item["detail"].rstrip("."))
            return f"{item['id']} ({words[item['status']]}{': ' + why if why else ''})"

        gaps = [checks[key] for key in sorted(checks) if checks[key]["status"] in INCOMPLETE]
        summary_line = outcome + ("; not assessed: " + ", ".join(gap(item) for item in gaps) if gaps else "")

        body = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION,
            "release": {"release_id": release_id, "commit": commit, "integration_branch": source["branch"]},
            "scope": {"epic": scope["epic"], "slices": list(scope["slices"]), "issues_not_taken_in": list(scope["listed_issues"])},
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
            "product_acceptance": self.acceptance(scope, release_id, commit),
            "outcome": outcome,
        }
        text = canonical(body)
        write_atomic(folder / "readiness.json", text)
        write_atomic(folder / "run.json", canonical({"release_id": release_id, "commit": commit, "evaluated_at": now(), "readiness_sha256": sha(text.encode("utf-8")),
                                                     "seconds": {key: value.get("seconds") for key, value in commands.items()},
                                                     "evidence_files": {"checked_in_this_machines_archive": evidence_held, "held_on_another_machine": evidence_elsewhere, "built_here_not_kept": evidence_not_kept},
                                                     "logs": sorted(p.relative_to(folder).as_posix() for p in logs.glob("*.log"))}))
        return {"release_id": release_id, "commit": commit, "outcome": outcome, "outcome_summary": summary_line, "not_assessed": unassessed, "readiness": str(folder / "readiness.json"),
                "unresolved_blockers": blocking, "incomplete": incomplete, "exceptions": excepted,
                "evidence_files": {"checked_in_this_machines_archive": evidence_held, "held_on_another_machine": evidence_elsewhere, "built_here_not_kept": evidence_not_kept},
                "product_acceptance": body["product_acceptance"]["decision"], "released": False}

    def reviewed_change(self, name: str, approved: Optional[str], landed: Optional[str]) -> Tuple[Optional[bytes], bool]:
        """The contract as a review approved it, and whether that slice changed it: it differs from the slice's base,
        where its branch meets the integration branch as it was just before the slice landed."""
        then = self.file_at(approved, name) if approved else None
        if then is None or not landed:
            return then, False
        base = self._git("merge-base", approved, f"{landed}^1").stdout.strip()
        return then, (self.file_at(base, name) if base else None) != then

    def judge_contract(self, name: str, users: List[Dict[str, Any]], commit: str, outside_records: List[Dict[str, Any]],
                       check: Callable[..., None]) -> None:
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
        outside = self.outside_change(name, now_bytes, commit, outside_records) if now_bytes is not None and (latest is None or latest["then"] != now_bytes) else None
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
                      "not reviewed within it. Qualify with that slice included.")
            else:
                check(check_id, "contract", "fail", "The integrated file matches no version a review in this release approved: it was changed outside review.")

    def outside_change(self, name: str, now_bytes: bytes, commit: str, outside_records: List[Dict[str, Any]]) -> Optional[str]:
        """An integrated ticket outside the release whose reviewed change made the contract what it is now, by its change record."""
        for record in outside_records:
            facts = record["facts"]
            if name not in facts["contracts"]:
                continue
            bound = self.bind(record, commit)
            if bound["problem"]:
                continue
            then, touched = self.reviewed_change(name, facts["commits"].get("approved"), bound["landed_in"])
            if then == now_bytes and touched:
                return f"{facts.get('slice_id') or 'a slice'} ({facts.get('ticket_id')})"
        return None

    def dependency_integrated(self, dep: Dict[str, Any], found: Optional[str], committed: List[Dict[str, Any]], specs: Dict[str, Dict[str, Any]], commit: str) -> bool:
        """A dependency outside the release: integrated at this commit when its spec is there with a change record that
        counts for it, or, for one built before records carried facts or named only by its issue, when its spec is there."""
        if found is not None:
            spec = specs.get(found)
            written = [item for item in committed if item["facts"].get("slice_id") == found]
            if written:
                return bool(spec) and any(item["facts"]["spec"].get("sha256") == spec["spec_sha256"] and not self.bind(item, commit)["problem"] for item in written)
            return bool(spec)
        return any(spec["issue"] == dep.get("issue") for spec in specs.values())

    def acceptance(self, scope: Dict[str, Any], release_id: str, commit: str) -> Dict[str, Any]:
        """Product's decision on this release of the epic, as an acceptance comment on the epic's issue records it, bound to this
        release ID and this commit, written by the account it names, unedited, by someone with the triage role or above.
        The latest such comment decides. Never inferred."""
        epic = scope.get("epic")
        if not epic:
            return {"decision": "not_recorded", "reason": "Product acceptance is recorded per epic; this release names slices.", "epic": None}
        if not epic.get("issue"):
            return {"decision": "not_recorded", "reason": "The epic has no issue to record a decision on.", "epic": epic}
        read = self.line.ticket_json("epic-check", str(epic["issue"]), "--release", release_id, "--commit", commit) or {}
        found = read.get("acceptances")
        if not isinstance(found, list):
            return {"decision": "not_recorded", "reason": f"The epic's issue #{epic['issue']} could not be read.", "epic": epic}
        valid = [item for item in found if isinstance(item, dict) and not item.get("problem") and item.get("decision") in ("accepted", "rejected")]
        ignored = [{"by": item.get("by"), "why": item.get("problem")} for item in found if isinstance(item, dict) and item.get("problem")]
        if not valid:
            return {"decision": "not_recorded", "reason": f"No acceptance comment for release {release_id} at {commit[:12]} on issue #{epic['issue']}.",
                    "epic": epic, "ignored": ignored}
        last = sorted(valid, key=lambda item: str(item.get("at") or ""))[-1]
        return {"decision": last["decision"], "by": last.get("by"), "at": last.get("at"), "readiness_sha256": last.get("readiness_sha256"),
                "source": f"an acceptance comment on issue #{epic['issue']}", "epic": epic, "ignored": ignored}

    # ---- reading and exceptions ----

    def status(self) -> Dict[str, Any]:
        releases = []
        for path in sorted(self.home.glob("*/readiness.json")) if self.home.is_dir() else []:
            data = load_json(path) or {}
            run = load_json(path.parent / "run.json") or {}
            releases.append({"release_id": path.parent.name, "commit": (data.get("release") or {}).get("commit"), "outcome": data.get("outcome"),
                             "scope": data.get("scope"), "product_acceptance": (data.get("product_acceptance") or {}).get("decision"),
                             "evaluated_at": run.get("evaluated_at")})
        source = self.line.integration()
        epics: Dict[str, Dict[str, Any]] = {}
        for slice_id, entry in sorted(self.line.ledger()["slices"].items(), key=lambda item: number(item[0])):
            epic = entry.get("epic") or {}
            if epic.get("epic_id"):
                known = epics.setdefault(epic["epic_id"], {"epic_id": epic["epic_id"], "issue": epic.get("issue"), "slices": [], "integrated": []})
                known["slices"].append(slice_id)
                if entry.get("integrated"):
                    known["integrated"].append(slice_id)
        return {"releases": releases, "integration": {"branch": source.get("branch"), "commit": source.get("commit"), "problems": source["problems"]},
                "epics": [epics[key] for key in sorted(epics, key=number)], "released": False}

    def show(self, release_id: str) -> Dict[str, Any]:
        if not RELEASE_RE.match(release_id):
            raise QualifyError(f"'{release_id}' is not a usable release ID.")
        folder = self.home / release_id
        data = load_json(folder / "readiness.json")
        if not isinstance(data, dict):
            raise QualifyError(f"No readiness snapshot for release {release_id}. Run: release qualify --epic <EPIC-ID> --release {release_id}")
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
