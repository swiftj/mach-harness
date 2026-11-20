#!/usr/bin/env python3
"""MACH merge station: land exactly what was approved, or refuse.

    merge.py plan <ticket>     say what 'run' would do and whether it is allowed; changes nothing
    merge.py run <ticket>      revalidate and merge, locally or through a pull request
    merge.py status <ticket>

An approval covers one commit. Before anything lands, this script checks that the cell's branch
is still that commit; if someone has added to it, the approval is void and the ticket goes back
to verification. If the main branch has moved on since the approval, the branch is brought up
to date and the test suite is rerun on the result, the way a merge queue does, so two tickets
that were each approved alone cannot break main together.

Settings, in .factory/config.json under "merge":
    mode    "auto"   the line merges approved tickets itself
            "manual" (default) a person merges; this script still works when a person runs it
    method  "local"  (default) merge into the main checkout with a merge commit
            "pr"     push the branch and open a pull request, then merge it there
    into    the branch tickets land on (default: the remote's default branch, else main or master)
    auto    which risk tiers the line may merge on its own in auto mode,
            default {"low": true, "medium": true, "high": true}. A High ticket only reaches
            'approved' after a person signed off in review, unless the review settings say otherwise.
    pr.inline_findings
            with the pull request method, post the approving round's findings on the pull request
            once, as one review of type comment (default true; only an explicit false turns it off)

An approval that rests on a person's security exception (review.py except) is bound to the commit like any
approval, and once an exception's expiry has passed nothing is merged: the ticket waits for a person. The pull
request body lists each exception with who accepted it and why.

A pull request for a slice that came as a GitHub issue says "Refs #<n>" (never a closing keyword:
the Factory closes the slice's issue once it sees the merge on the integration branch). Posting findings never blocks or delays the merge.

Standard library only. It never force-pushes, never rewrites history, and never deletes a branch.
"""

import argparse
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
BYPRODUCT_RE = re.compile(
    r"(^|/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|htmlcov|\.hypothesis|node_modules|\.gradle|\.next|\.turbo|coverage)(/|$)"
    r"|\.py[co]$|(^|/)\.coverage(\..*)?$|(^|/)\.DS_Store$|\.egg-info(/|$)|\.tsbuildinfo$"
)
TIERS = ("High", "Medium", "Low")


class MergeError(Exception):
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
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, errors="replace")


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


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


class Cell:
    def __init__(self, project: Path, ticket_id: str) -> None:
        if not TICKET_ID_RE.match(ticket_id):
            raise MergeError(f"'{ticket_id}' is not a usable ticket ID.")
        self.project = project
        self.ticket_id = ticket_id
        self.root = project / ".factory" / "worktrees" / ticket_id
        self.info = load_json(self.root / "cell.json")
        if not isinstance(self.info, dict):
            raise MergeError(f"No cell for {ticket_id}.")
        if self.info.get("isolation") != "worktree" or not self.info.get("branch"):
            raise MergeError("This cell has no branch of its own, so there is nothing to merge: its work was done in the project folder.")
        self.work = self.root / "repo"
        self.branch = str(self.info["branch"])
        self.decision = load_json(self.root / "review" / "decision.json", {}) or {}
        self.build = load_json(self.root / "build-report.json", {}) or {}
        self.summary = load_json(self.root / "evidence" / "summary.json", {}) or {}
        config = load_json(project / ".factory" / "config.json", {})
        merge = config.get("merge") if isinstance(config, dict) and isinstance(config.get("merge"), dict) else {}
        self.mode = merge.get("mode") if merge.get("mode") in ("auto", "manual") else "manual"
        self.method = merge.get("method") if merge.get("method") in ("local", "pr") else "local"
        auto = merge.get("auto") if isinstance(merge.get("auto"), dict) else {}
        self.auto = {tier: auto.get(tier.lower(), True) is not False for tier in TIERS}
        pr = merge.get("pr") if isinstance(merge.get("pr"), dict) else {}
        self.inline_findings = pr.get("inline_findings") is not False

    def head(self) -> str:
        return git(self.work, "rev-parse", "HEAD").stdout.strip()

    def save_info(self) -> None:
        self.info["updated_at"] = now()
        write_json(self.root / "cell.json", self.info)


def default_branch(project: Path) -> str:
    """The branch tickets land on: merge.into if set, the remote's default, else main or master if they exist."""
    config = load_json(project / ".factory" / "config.json", {})
    named = (config.get("merge") or {}).get("into") if isinstance(config, dict) and isinstance(config.get("merge"), dict) else None
    if isinstance(named, str) and named.strip():
        return named.strip()
    remote = git(project, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").stdout.strip()
    if remote:
        return remote.split("/", 1)[-1]
    for name in ("main", "master"):
        if git(project, "show-ref", "--verify", "-q", f"refs/heads/{name}").returncode == 0:
            return name
    return git(project, "branch", "--show-current").stdout.strip() or "main"


def dirty(folder: Path) -> List[str]:
    """Uncommitted project work, ignoring the factory's own files and what test runs leave behind."""
    names = [line[3:].strip().strip('"') for line in git(folder, "status", "--porcelain", "--untracked-files=all").stdout.splitlines() if line.strip()]
    return [name for name in names if not name.startswith((".factory/", ".claude/")) and not BYPRODUCT_RE.search(name)]


def run_suite(cell: Cell) -> Dict[str, Any]:
    command = (cell.build.get("tests") or {}).get("command")
    if not isinstance(command, str) or not command.strip():
        raise MergeError("The build report records no test command, so the merged result cannot be checked.")
    argv = shlex.split(command)
    env = dict(os.environ)
    while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):
        key, value = argv.pop(0).split("=", 1)
        env[key] = value
    if not argv or (shutil.which(argv[0]) is None and not (cell.work / argv[0]).is_file()):
        raise MergeError(f"'{argv[0] if argv else command}' is not installed or not on PATH, so the merged result cannot be checked.")
    try:
        done = subprocess.run(argv, cwd=str(cell.work), capture_output=True, text=True, errors="replace", timeout=600, stdin=subprocess.DEVNULL, env=env)
        code, out = done.returncode, done.stdout + ("\n" + done.stderr if done.stderr else "")
    except subprocess.TimeoutExpired:
        code, out = 124, "Still running after 600 seconds; stopped."
    return {"command": command, "passed": code == 0, "exit_code": code, "output_tail": out.strip()[-1500:]}


def survey(cell: Cell, by_person: bool) -> Dict[str, Any]:
    """Everything 'run' would do and every reason it may not. Shared by plan and run so they cannot disagree."""
    refusals: List[str] = []
    stage = cell.info.get("stage")
    head = cell.head()
    risk = cell.info.get("risk") if cell.info.get("risk") in TIERS else "High"
    main = default_branch(cell.project)
    main_head = git(cell.project, "rev-parse", "HEAD").stdout.strip()
    plan: Dict[str, Any] = {
        "ticket_id": cell.ticket_id, "stage": stage, "branch": cell.branch, "into": main, "risk": risk, "mode": cell.mode, "method": cell.method,
        "approved_commit": cell.decision.get("head"), "branch_commit": head, "approval_valid": cell.decision.get("head") == head,
        "behind_main": git(cell.work, "merge-base", "--is-ancestor", main_head, "HEAD").returncode != 0,
        "pull_request": cell.info.get("pull_request"),
    }
    if stage == "merged":
        refusals.append("This ticket is already merged.")
    elif stage not in ("approved", "pr-open"):
        refusals.append(f"The cell's stage is '{stage}'. Only an approved ticket can be merged.")
    if cell.decision.get("outcome") != "APPROVED":
        refusals.append("There is no approval on record for this ticket (review/decision.json).")
    elif cell.decision.get("human_approval_required") and not cell.decision.get("human_approval"):
        refusals.append("The review requires a person's approval and none is recorded.")
    lapsed = expired_exceptions(cell.decision)
    if lapsed and stage in ("approved", "pr-open") and cell.decision.get("outcome") == "APPROVED":
        plan["exception_expired"] = [f"{item.get('round')}/{item.get('seat')}/{item.get('index')}" for item in lapsed]
        refusals.append(f"The security exception for {', '.join(plan['exception_expired'])} expired on {lapsed[0].get('expires')}, so the security veto stands "
                        "again and nothing is merged. A person decides: record a new exception (except) or abandon the ticket.")
    revalidated = cell.info.get("revalidated") or {}
    if stage in ("approved", "pr-open") and not plan["approval_valid"] and revalidated.get("head") != head:
        plan["approval_void"] = True
        refusals.append(f"The approval was for commit {str(cell.decision.get('head'))[:10]}, but the branch is now at {head[:10]}: something was added after review. "
                        "The approval no longer holds; the ticket must be verified and reviewed again.")
    if not by_person and cell.mode != "auto":
        refusals.append("Merging is set to manual in .factory/config.json (merge.mode), so a person merges this ticket. A person may run this with --by-person.")
    elif not by_person and not cell.auto[risk]:
        refusals.append(f"{risk}-risk tickets are merged by a person in this project (merge.auto.{risk.lower()} is false). A person may run this with --by-person.")
    if git(cell.project, "branch", "--show-current").stdout.strip() != main:
        refusals.append(f"The main checkout is not on {main}. Switch it to {main} before merging.")
    stray = dirty(cell.project)
    if stray and cell.method == "local":
        refusals.append(f"The main checkout has uncommitted changes ({', '.join(stray[:5])}). Commit or remove them before merging into it.")
    if dirty(cell.work):
        refusals.append("The cell has uncommitted changes. Everything in an approved cell is committed; look at what changed.")
    if cell.method == "pr":
        if not git(cell.project, "remote", "get-url", "origin").stdout.strip():
            refusals.append("merge.method is 'pr' but the repository has no 'origin' remote.")
        if shutil.which("gh") is None:
            refusals.append("merge.method is 'pr' but the gh tool is not installed.")
    plan["would"] = ([] if not plan["behind_main"] else [f"bring {cell.branch} up to date with {main} and rerun the test suite"]) + (
        [f"merge {cell.branch} into {main} with a merge commit"] if cell.method == "local"
        else [f"push {cell.branch}", f"open a pull request into {main}", "merge the pull request at the approved commit" if cell.mode == "auto" or by_person else "leave the pull request for a person to merge"])
    plan["allowed"] = not refusals
    plan["refusals"] = refusals
    return plan


def expired_exceptions(decision: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The security exceptions on the approving round whose expiry has passed (review.py's rule: one holds through its
    expiry day, UTC; one with no expiry holds for the commit reviewed). Only the latest for each finding counts."""
    latest: Dict[Tuple[Any, Any, Any], Dict[str, Any]] = {}
    for item in decision.get("exceptions") or []:
        if isinstance(item, dict):
            latest[(item.get("round"), item.get("seat"), item.get("index"))] = item
    today = datetime.now(timezone.utc).date()
    lapsed = []
    for item in latest.values():
        if not item.get("expires"):
            continue
        try:
            ended = datetime.strptime(str(item["expires"]), "%Y-%m-%d").date() < today
        except ValueError:
            ended = True  # an expiry that cannot be read is not trusted to be in the future
        if ended:
            lapsed.append(item)
    return lapsed


def void_approval(cell: Cell) -> None:
    """Something was added after review: send the ticket back to be verified and reviewed again."""
    cell.info.update({"stage": "built", "review": "VOID", "verification": None})
    cell.build["head"] = cell.head()
    write_json(cell.root / "build-report.json", cell.build)
    stale = cell.root / "review" / "decision.json"
    if stale.is_file():
        void = {"reason": "The branch changed after it was approved.", "voided_at": now(), "approved_commit": cell.decision.get("head"),
                "branch_commit": cell.build["head"], "by": "merge station"}
        cell.decision.update({"outcome": "VOID", "void_reason": void["reason"], "void": void})
        write_json(stale, cell.decision)
        # The round's own record keeps who approved, when and which commit, marked voided; the re-review opens a new folder.
        findings = Path(str(cell.decision.get("findings") or ""))
        folder = findings.parent if findings.name == "findings.md" and (cell.root / "review") in findings.parents else cell.root / "review" / f"round-{cell.decision.get('round')}"
        kept = load_json(folder / "decision.json") if (folder / "decision.json").is_file() else None
        if isinstance(kept, dict) and kept.get("head") == void["approved_commit"]:
            kept.update({"void": void, "outcome_before_void": kept.get("outcome"), "outcome": "VOID"})
            write_json(folder / "decision.json", kept)
    cell.save_info()


def send_back(cell: Cell, title: str, detail: str) -> Path:
    """The up-to-date branch no longer passes: hand it to the build station as findings for a revision."""
    path = cell.root / "review" / "merge-findings.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# Merge findings for {cell.ticket_id}\n\n1. **{title}** {detail}\n", encoding="utf-8")
    head = cell.head()
    cell.build["head"] = head
    write_json(cell.root / "build-report.json", cell.build)
    write_json(cell.root / "review" / "decision.json", {**cell.decision, "outcome": "REJECTED", "head": head, "findings": str(path), "rejected_by": "merge station"})
    cell.info.update({"stage": "built", "review": "REJECTED"})
    cell.save_info()
    return path


def revalidate(cell: Cell, main: str) -> Optional[Dict[str, Any]]:
    """Merge-queue step: put the approved work on top of today's main and prove the suite still passes."""
    main_head = git(cell.project, "rev-parse", "HEAD").stdout.strip()
    if git(cell.work, "merge-base", "--is-ancestor", main_head, "HEAD").returncode == 0:
        return None
    merged = git(cell.work, "merge", "--no-edit", "-m", f"Merge {main} into {cell.branch} before landing [{cell.ticket_id}]", main_head)
    if merged.returncode != 0:
        conflicts = git(cell.work, "diff", "--name-only", "--diff-filter=U").stdout.split()
        git(cell.work, "merge", "--abort")
        raise MergeError(f"{main} has moved on since this ticket was approved, and bringing the branch up to date conflicts in {', '.join(conflicts) or 'some files'}. "
                         f"A person must merge {main} into {cell.branch} in {cell.work} and resolve it; the ticket then needs verifying and reviewing again.",
                         code="revalidation-conflict")
    suite = run_suite(cell)
    if not suite["passed"]:
        path = send_back(cell, f"The test suite fails once {main} is merged in.",
                         f"The ticket passed on its own, but with the current {main} merged into it `{suite['command']}` fails:\n\n```\n{suite['output_tail']}\n```")
        raise MergeError(f"With the current {main} merged in, the test suite fails, so nothing was merged. The ticket goes back to the build station: findings are in {path}.",
                         code="sent-back")
    cell.info["revalidated"] = {"head": cell.head(), "onto": main_head, "at": now(), "tests": suite["command"]}
    cell.save_info()
    return cell.info["revalidated"]


# ---- text from the cell on the platform ----

# An issue or pull request reference GitHub would link (#12, owner/name#12, GH-12, .../issues/12). A zero-width
# space after the marker leaves the text readable but links nothing, so no text taken from the cell can close,
# or cross-reference, an issue.
REFERENCE_RE = re.compile(r"(#|\bGH-|/issues/|/pull/|/discussions/)(?=[0-9])", re.IGNORECASE)
MENTION_RE = re.compile(r"@(?=[A-Za-z0-9_])")
BREAK = "\u200b"  # a zero-width space, written as an escape so it can be seen


def inert(value: Any, limit: int = 200) -> str:
    """One line of text from the cell made safe for a pull request: printable, bounded, linking no issue."""
    text = "" if value is None else str(value)
    text = " ".join("".join(ch if ch.isprintable() else " " for ch in text[:limit * 4]).split())
    if len(text) > limit:
        text = text[:limit - 1].rstrip() + "…"
    return MENTION_RE.sub("@" + BREAK, REFERENCE_RE.sub(lambda m: m.group(1) + BREAK, text))


_ISSUE_RULES: List[Any] = []


def issue_rules() -> Any:
    """The ticket station's shared pure rules (redaction, repository and issue number checks), loaded from the
    sibling skill folder whichever way MACH is installed, never copied. None if it cannot be loaded."""
    if not _ISSUE_RULES:
        found = None
        skills = Path(__file__).resolve().parent.parent.parent
        for name in ("mach-ticket", "ticket"):
            path = skills / name / "scripts" / "issue_rules.py"
            if path.is_file():
                try:
                    spec = importlib.util.spec_from_file_location("mach_ticket_issue_rules", path)
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    found = module
                except Exception:  # noqa: BLE001
                    found = None
                break
        _ISSUE_RULES.append(found)
    return _ISSUE_RULES[0]


REMOTE_RE = re.compile(r"^(?:[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/\s]+@)?[^/\s]+/|[^@/\s:]+@[^:/\s]+:)([^/\s]+/[^/\s]+?)(?:\.git)?/?$")
PR_URL_RE = re.compile(r"^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/pull/([0-9]{1,9})$")


def origin_repository(project: Path) -> Optional[str]:
    """owner/name of the origin remote as configured (before any URL rewriting), or None."""
    rules = issue_rules()
    url = git(project, "config", "--get", "remote.origin.url").stdout.strip()
    found = REMOTE_RE.match(url)
    if rules is None or not found or not rules.is_repository(found.group(1)):
        return None
    return found.group(1)


def refs_line(cell: Cell) -> Optional[str]:
    """'Refs #<n>' for a slice whose issue is in this repository, 'Refs owner/name#<n>' otherwise; None if the cell
    names no slice issue or what it names is not a valid repository and issue number. Never a closing keyword: the
    Factory closes a slice's issue itself once the merge is seen on the integration branch."""
    rules = issue_rules()
    product = cell.info.get("product")
    issue = product.get("issue") if isinstance(product, dict) else None
    if rules is None or not isinstance(issue, dict):
        return None
    repository, number = issue.get("repository"), issue.get("number")
    if not rules.is_repository(repository) or not rules.is_issue_number(number):
        return None
    here = origin_repository(cell.project)
    return f"Refs #{number}" if here is not None and here.lower() == repository.lower() else f"Refs {repository}#{number}"


def pr_title(cell: Cell) -> str:
    return inert(f"{cell.ticket_id}: {cell.info.get('title') or cell.info.get('slice_id') or 'change'}", 240)


def pr_body(cell: Cell) -> str:
    checks = cell.summary.get("checks") or {}
    checks = checks if isinstance(checks, dict) else {}
    votes = cell.decision.get("votes") or {}
    votes = votes if isinstance(votes, dict) else {}
    human = cell.decision.get("human_approval") or {}
    evidence = [entry.get("file") for entry in cell.summary.get("evidence_files") or [] if isinstance(entry, dict)]
    passed = sum(1 for c in checks.values() if isinstance(c, dict) and c.get("result") == "pass")
    lines = [
        f"**Ticket:** {inert(cell.ticket_id)}  ",
        f"**Slice:** {inert(cell.info.get('slice_id'))} (`{inert(cell.info.get('spec_path'))}`)  ",
        f"**Risk tier:** {inert(cell.info.get('risk'))}",
        "",
        "## Verification",
        f"{inert(cell.summary.get('status', 'unknown'))}: {passed} of {len(checks)} checks passed, "
        "run by an independent verifier against the built slice.",
        "",
        "## Review",
        f"Round {inert(cell.decision.get('round'))}: " + ", ".join(f"{inert(seat, 40)} {inert(vote, 20)}" for seat, vote in votes.items())
        + f". Blockers: {inert(cell.decision.get('blockers', 0))}.",
        f"Approved by a person: {inert(human.get('by') if isinstance(human, dict) else human)}." if human else "No person's approval was required for this ticket.",
        "",
        *exceptions_section(cell),
        "## Build",
        f"{inert(cell.build.get('diff', ''), 400)}. Tests seen failing before their code was written: {inert(cell.build.get('tests_seen_failing_first', 0))}. "
        f"Gate overrides recorded: {len(cell.build.get('deviations') or [])}.",
        "",
        f"Approved commit: `{inert(cell.decision.get('head'), 64)}`. Evidence ({len(evidence)} files) and the reviewers' findings are kept with the ticket's cell and archived on cleanup.",
        "",
        "Opened by the MACH merge station.",
    ]
    refs = refs_line(cell)
    if refs:
        lines += ["", refs]
    return "\n".join(lines)


def exceptions_section(cell: Cell) -> List[str]:
    """Each security exception the approval rests on: the finding, who accepted it, their reason (redacted, bounded,
    linking nothing) and its expiry. Nothing when the approval needed none."""
    items = [item for item in cell.decision.get("exceptions") or [] if isinstance(item, dict)]
    if not items:
        return []
    rules = issue_rules()
    lines = ["## Security exceptions",
             "The review panel's security veto was excepted by a person for the approved commit. The finding stands: it was accepted, not fixed."]
    for item in items[:20]:
        reason = item.get("reason") if isinstance(item.get("reason"), str) else ""
        reason = rules.redact(reason) if rules is not None else reason
        impact = item.get("impact") if item.get("impact") in IMPACTS else "unstated"
        seat = inert(item.get("seat"), 40)
        lines.append(f"- {inert(item.get('round'), 10)}/{seat}/{inert(item.get('index'), 10)} ({seat} seat, {impact} impact): "
                     f"**{inert(item.get('title'), TITLE_LIMIT)}**, breaks {inert(item.get('rule'), RULE_LIMIT)}. Accepted by {inert(item.get('by'), 80)}"
                     + (f", until {inert(item.get('expires'), 10)}" if item.get("expires") else "") + f": \"{inert(reason, DETAIL_LIMIT)}\""
                     + (" (renews an expired one)" if item.get("renews") is not None else ""))
    return lines + [""]


def gh(cell: Cell, *args: str, stdin: Optional[str] = None, timeout: Optional[int] = None) -> subprocess.CompletedProcess:
    """Run gh in the main checkout. With a timeout, a hung or missing gh comes back as a failure, never an exception."""
    try:
        return subprocess.run(["gh", *args], cwd=str(cell.project), capture_output=True, text=True, errors="replace",
                              input=stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(["gh", *args], 124, "", f"gh did not answer within {timeout} seconds")
    except OSError as exc:
        if timeout is None:
            raise
        return subprocess.CompletedProcess(["gh", *args], 127, "", f"gh could not be started: {exc.strerror or exc}")


# ---- the approving round's findings on the pull request ----

GH_TIMEOUT = 60
MAX_POST_ATTEMPTS = 3
MAX_POSTED_FINDINGS = 60
DETAIL_LIMIT = 600
TITLE_LIMIT = 200
RULE_LIMIT = 120
SEAT_RE = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")
IMPACTS = ("critical", "high", "medium", "low")
PATH_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._+-]{1,255}$")
HUNK_RE = re.compile(r"^@@ -[0-9]+(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@")


def plain_path(value: Any) -> Optional[str]:
    """A file path that is a plain relative path inside the repository, or None."""
    if not isinstance(value, str) or not value or len(value) > 400:
        return None
    parts = value.split("/")
    if any(part in ("", ".", "..") or not PATH_SEGMENT_RE.match(part) for part in parts) or parts[0] == ".git":
        return None
    return value


def diff_lines(cell: Cell) -> Optional[Dict[str, Set[int]]]:
    """For each file, the right-side lines inside the pull request's diff: the branch against its merge base
    with the main branch, with Git's default three lines of context. None if Git cannot say."""
    main_head = git(cell.project, "rev-parse", "HEAD").stdout.strip()
    base = git(cell.work, "merge-base", main_head, "HEAD").stdout.strip() if main_head else ""
    if not re.fullmatch(r"[0-9a-f]{40,64}", base):
        return None
    done = git(cell.work, "-c", "core.quotePath=true", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3", "-M",
               "--src-prefix=a/", "--dst-prefix=b/", base, "HEAD")
    if done.returncode != 0:
        return None
    lines: Dict[str, Set[int]] = {}
    current: Optional[str] = None
    old_left = new_left = 0
    for line in done.stdout.splitlines():
        if old_left > 0 or new_left > 0:
            tag = line[:1]
            if tag == "\\":
                continue
            if tag in (" ", ""):
                old_left, new_left = old_left - 1, new_left - 1
            elif tag == "-":
                old_left -= 1
            elif tag == "+":
                new_left -= 1
            continue
        if line.startswith("diff --git "):
            current = None
        elif line.startswith("+++ "):
            name = line[4:]
            current = name[2:] if name.startswith("b/") else None  # a deleted file, or a quoted name: nothing inline
        elif line.startswith("@@"):
            found = HUNK_RE.match(line)
            if not found:
                continue
            old_left = int(found.group(1)) if found.group(1) is not None else 1
            start, count = int(found.group(2)), int(found.group(3)) if found.group(3) is not None else 1
            new_left = count
            if current is not None and count:
                lines.setdefault(current, set()).update(range(start, start + count))
    return lines


def approving_findings(cell: Cell) -> Tuple[Optional[int], List[Tuple[str, Dict[str, Any]]]]:
    """(round, [(seat, finding)]) from the approving round's votes, blockers first, seats in name order."""
    number = cell.decision.get("round")
    if type(number) is not int or number < 1:
        return None, []
    folder = cell.root / "review" / f"round-{number}" / "votes"
    found: List[Tuple[str, Dict[str, Any]]] = []
    for path in sorted(folder.glob("*.json")) if folder.is_dir() else []:
        seat = path.stem
        vote = load_json(path, {})
        if not SEAT_RE.match(seat) or not isinstance(vote, dict) or not isinstance(vote.get("findings"), list):
            continue
        found += [(seat, finding) for finding in vote["findings"] if isinstance(finding, dict)]
    found.sort(key=lambda pair: 0 if pair[1].get("severity") == "blocker" else 1)
    return number, found


def finding_text(rules: Any, seat: str, finding: Dict[str, Any]) -> Dict[str, Any]:
    """One finding as it may leave the machine: redacted by the ticket station's rules, bounded, mentions and
    issue references broken, control characters gone."""
    def safe(value: Any, limit: int, one_line: bool) -> str:
        text, _ = rules.bound_text(value if isinstance(value, str) else "", limit, one_line=one_line)
        return MENTION_RE.sub("@" + BREAK, REFERENCE_RE.sub(lambda m: m.group(1) + BREAK, text))

    severity = finding.get("severity") if finding.get("severity") in ("blocker", "note") else "note"
    label = f"**{seat}** · {severity}"
    if finding.get("class") == "security":
        impact = finding.get("impact") if finding.get("impact") in IMPACTS else "unstated"
        label += f" · security, {impact} impact"
    line = finding.get("line")
    return {"label": label, "title": safe(finding.get("title"), TITLE_LIMIT, True) or "(no title)",
            "detail": safe(finding.get("detail"), DETAIL_LIMIT, False), "rule": safe(finding.get("rule"), RULE_LIMIT, True),
            "path": plain_path(finding.get("file")), "had_file": bool(finding.get("file")),
            "line": line if type(line) is int and 0 < line < 10 ** 7 else None}


def comment_text(item: Dict[str, Any]) -> str:
    parts = [f"{item['label']}: **{item['title']}**"]
    if item["detail"]:
        parts.append(item["detail"])
    if item["rule"]:
        parts.append(f"Cites: {item['rule']}")
    return "\n\n".join(parts)


def summary_text(item: Dict[str, Any]) -> str:
    if item["path"]:
        where = f"`{item['path']}" + (f":{item['line']}`" if item["line"] else "`")
    else:
        where = "file not shown" if item["had_file"] else "no file"
    detail = " ".join(item["detail"].split())
    return f"- {item['label']}, {where}: **{item['title']}**" + (f" {detail}" if detail else "") + (f" Cites: {item['rule']}." if item["rule"] else "")


def findings_review(cell: Cell, rules: Any, number: int, found: List[Tuple[str, Dict[str, Any]]], head: str) -> Dict[str, Any]:
    """The review to post: inline comments for findings on lines in the diff, the rest in the summary."""
    in_diff = diff_lines(cell) or {}
    shown, hidden = found[:MAX_POSTED_FINDINGS], len(found) - min(len(found), MAX_POSTED_FINDINGS)
    inline: List[Dict[str, Any]] = []
    listed: List[Dict[str, Any]] = []
    for seat, finding in shown:
        item = finding_text(rules, seat, finding)
        if item["path"] and item["line"] and item["line"] in in_diff.get(item["path"], set()):
            inline.append(item)
        else:
            listed.append(item)
    approved = cell.decision.get("head")
    approved = approved if isinstance(approved, str) and re.fullmatch(r"[0-9a-f]{40,64}", approved) else head
    moved = "" if approved == head else f" This pull request is at `{head[:12]}`: the approved commit brought up to date with the main branch, with the tests rerun."
    intro = [f"The MACH review panel approved commit `{approved[:12]}` in round {number}.{moved} Its findings follow, as the reviewers wrote them, "
             "with likely secrets masked and mentions broken. They are information for whoever reads this pull request; the merge does not wait on them."]
    if inline:
        intro.append(f"{len(inline)} finding{'s are' if len(inline) != 1 else ' is'} attached to the lines {'they concern' if len(inline) != 1 else 'it concerns'}.")
    if listed:
        intro += ["", "Findings not on a line of this diff:", *[summary_text(item) for item in listed]]
    if hidden:
        intro += ["", f"{hidden} more finding{'s are' if hidden != 1 else ' is'} not shown here; every finding is kept with the ticket's cell."]
    return {"body": "\n".join(intro), "inline": inline, "listed": listed, "hidden": hidden,
            "payload": {"commit_id": head, "event": "COMMENT", "body": "\n".join(intro),
                        "comments": [{"path": item["path"], "line": item["line"], "side": "RIGHT", "body": comment_text(item)} for item in inline]}}


def last_line(done: subprocess.CompletedProcess, fallback: str) -> str:
    text = ((done.stderr or "").strip() or (done.stdout or "").strip()).splitlines() or [fallback]
    rules = issue_rules()
    line = " ".join(text[-1].split())[:200]
    return rules.redact(line) if rules is not None else line


def post_findings(cell: Cell, url: str, head: str) -> Dict[str, Any]:
    """Post the approving round's findings on the pull request once. Never raises, never blocks the merge;
    what happened is recorded in cell.json and returned for the station's result."""
    if not cell.inline_findings:
        return {"posted": False, "reason": "merge.pr.inline_findings is false in .factory/config.json."}
    record = cell.info.get("pull_request_findings")
    record = record if isinstance(record, dict) and record.get("pull_request") == url else None
    if record and record.get("how") in ("review", "comment", "nothing to post"):
        return {"posted": False, "reason": f"Already done for this pull request ({record['how']}, {record.get('at')}).",
                **({"inline": record.get("inline"), "summary": record.get("summary")} if record["how"] != "nothing to post" else {})}
    attempts = int(record.get("attempts") or 0) if record else 0
    if attempts >= MAX_POST_ATTEMPTS:
        return {"posted": False, "reason": f"Not tried again: posting failed {attempts} times. The findings are kept with the ticket's cell."}

    def keep(how: str, **fields: Any) -> Dict[str, Any]:
        entry = {"pull_request": url, "round": number, "head": head, "at": now(), "how": how, "attempts": attempts + 1, **fields}
        cell.info["pull_request_findings"] = entry
        cell.save_info()
        return entry

    number, found = approving_findings(cell)
    if not found:
        keep("nothing to post", inline=0, summary=0)
        return {"posted": False, "reason": "The approving round recorded no findings, so there was nothing to post."}
    rules = issue_rules()
    if rules is None:
        keep("failed", reason="the ticket station's shared rules could not be loaded")
        return {"posted": False, "reason": "The ticket station's shared rules could not be loaded, so reviewer text could not be redacted; nothing was posted."}
    from_url = PR_URL_RE.match(url)
    repository = origin_repository(cell.project) or (from_url.group(1) if from_url and rules.is_repository(from_url.group(1)) else None)
    if repository is None or not from_url:
        keep("failed", reason="the pull request's repository and number could not be established")
        return {"posted": False, "reason": "The pull request's repository and number could not be established, so nothing was posted."}
    pull = int(from_url.group(2))
    review = findings_review(cell, rules, number, found, head)
    counts = {"inline": len(review["inline"]), "summary": len(review["listed"]), "not_shown": review["hidden"]}
    made = gh(cell, "api", "--method", "POST", f"repos/{repository}/pulls/{pull}/reviews", "--input", "-",
              stdin=json.dumps(review["payload"]), timeout=GH_TIMEOUT)
    if made.returncode == 0:
        keep("review", **counts)
        return {"posted": True, "how": "review", **counts}
    why = last_line(made, "gh api failed")
    plain = review["body"] + ("\n\n" + "\n".join(summary_text(item) for item in review["inline"]) if review["inline"] else "")
    said = gh(cell, "pr", "comment", str(pull), "--repo", repository, "--body-file", "-", stdin=plain, timeout=GH_TIMEOUT)
    if said.returncode == 0:
        counts = {"inline": 0, "summary": counts["inline"] + counts["summary"], "not_shown": review["hidden"]}
        keep("comment", review_failed=why, **counts)
        return {"posted": True, "how": "comment", "review_failed": why, **counts}
    reason = f"The review could not be created ({why}), nor a plain comment ({last_line(said, 'gh pr comment failed')})."
    entry = keep("failed", reason=reason)
    return {"posted": False, "reason": reason + f" Attempt {entry['attempts']} of {MAX_POST_ATTEMPTS}; the merge went ahead."}


def land_by_pr(cell: Cell, main: str, merge_now: bool) -> Dict[str, Any]:
    head = cell.head()
    pushed = git(cell.work, "push", "-u", "origin", cell.branch)
    if pushed.returncode != 0:
        raise MergeError("The branch could not be pushed: " + (pushed.stderr.strip().splitlines() or ["git push failed"])[-1])
    url = cell.info.get("pull_request")
    if not url:
        made = gh(cell, "pr", "create", "--head", cell.branch, "--base", main, "--title", pr_title(cell), "--body", pr_body(cell))
        found = re.search(r"https?://\S+/pull/\d+", made.stdout + made.stderr)
        if not found:
            raise MergeError("The pull request could not be opened: " + ((made.stderr.strip() or made.stdout.strip()).splitlines() or ["gh pr create failed"])[-1])
        url = found.group(0)
        cell.info["pull_request"] = url
        cell.info["stage"] = "pr-open"
        cell.save_info()
    try:
        posted = post_findings(cell, url, head)
    except Exception as exc:  # noqa: BLE001  posting findings never stands in the merge's way
        posted = {"posted": False, "reason": f"Posting the findings failed unexpectedly ({type(exc).__name__}); the merge went ahead."}
    state = gh(cell, "pr", "view", url, "--json", "state,mergeCommit,headRefOid")
    view = load_text(state.stdout)
    if view.get("state") != "MERGED" and merge_now:
        done = gh(cell, "pr", "merge", url, "--merge", "--match-head-commit", head)
        if done.returncode != 0:
            return {"merged": False, "pull_request": url, "findings_posted": posted,
                    "note": "The pull request is open but could not be merged yet: " + ((done.stderr.strip() or done.stdout.strip()).splitlines() or ["gh pr merge failed"])[-1]}
        view = load_text(gh(cell, "pr", "view", url, "--json", "state,mergeCommit,headRefOid").stdout)
    if view.get("state") != "MERGED":
        return {"merged": False, "pull_request": url, "findings_posted": posted, "note": "The pull request is open and waiting to be merged."}
    git(cell.project, "fetch", "origin")
    # Keep the main checkout level with the platform, so the next ticket starts from what just landed.
    synced = False
    if git(cell.project, "branch", "--show-current").stdout.strip() == main and not dirty(cell.project):
        synced = git(cell.project, "merge", "--ff-only", f"origin/{main}").returncode == 0
    return {"merged": True, "pull_request": url, "merge_commit": (view.get("mergeCommit") or {}).get("oid"), "main_checkout_updated": synced,
            "findings_posted": posted}


def load_text(text: str) -> Dict[str, Any]:
    try:
        data = json.loads(text)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def cmd_plan(cell: Cell, args: argparse.Namespace) -> int:
    print(json.dumps(survey(cell, args.by_person), indent=2, ensure_ascii=False))
    return 0


def cmd_run(cell: Cell, args: argparse.Namespace) -> int:
    plan = survey(cell, args.by_person)
    if plan.get("approval_void"):
        void_approval(cell)
        raise MergeError(plan["refusals"][-1] if len(plan["refusals"]) == 1 else "\n- " + "\n- ".join(plan["refusals"]), code="approval-void")
    if plan["refusals"]:
        raise MergeError(plan["refusals"][0] if len(plan["refusals"]) == 1 else "\n- " + "\n- ".join(plan["refusals"]),
                         code="exception-expired" if plan.get("exception_expired") else "merge-refused")
    telemetry(cell.root, "gate.evaluated", "merge", lambda: {"gate": "merge.run", "outcome": "pass", "reason_code": None, "overridden_by_reason": False,
                                                             "by_person": bool(args.by_person)})
    telemetry(cell.root, "station.entered", "merge", lambda: {"stage": plan["stage"], "method": cell.method, "behind_main": bool(plan["behind_main"])})
    try:
        return land(cell, args, plan)
    except MergeError as exc:
        telemetry(cell.root, "gate.evaluated", "merge", lambda: {"gate": "merge.land", "outcome": "refuse", "reason_code": exc.code, "overridden_by_reason": False})
        telemetry(cell.root, "station.exited", "merge", lambda: {"outcome": exc.code, "stage": cell.info.get("stage")})
        exc.recorded = True
        raise


def land(cell: Cell, args: argparse.Namespace, plan: Dict[str, Any]) -> int:
    main = plan["into"]
    revalidated = revalidate(cell, main)
    head = cell.head()
    result: Dict[str, Any] = {"ticket_id": cell.ticket_id, "branch": cell.branch, "into": main, "method": cell.method,
                              "approved_commit": cell.decision.get("head"), "landed_commit": head, "revalidated": revalidated}
    if cell.method == "local":
        title = cell.info.get("title") or cell.info.get("slice_id") or "change"
        merged = git(cell.project, "merge", "--no-ff", "-m", f"Merge {cell.ticket_id}: {title}", cell.branch)
        if merged.returncode != 0:
            git(cell.project, "merge", "--abort")
            raise MergeError("git could not merge the branch into the main checkout: " + ((merged.stderr.strip() or merged.stdout.strip()).splitlines() or ["merge failed"])[-1],
                             code="merge-failed")
        result.update({"status": "MERGED", "merge_commit": git(cell.project, "rev-parse", "HEAD").stdout.strip()})
    else:
        landed = land_by_pr(cell, main, merge_now=cell.mode == "auto" or args.by_person)
        result.update(landed)
        result["status"] = "MERGED" if landed["merged"] else "PR_OPEN"
    if result["status"] == "MERGED":
        cell.info.update({"stage": "merged", "merged": {"commit": result.get("merge_commit"), "at": now(), "method": cell.method, "landed_commit": head}})
        cell.save_info()
        telemetry(cell.root, "merge.completed", "merge", lambda: {
            "method": cell.method, "approved_commit": lifecycle.short(result["approved_commit"]), "landed_commit": lifecycle.short(head),
            "merge_commit": lifecycle.short(result.get("merge_commit")), "revalidated": revalidated is not None,
            "pull_request": int(re.search(r"/pull/(\d+)", result["pull_request"]).group(1)) if result.get("pull_request") else None})
        telemetry(cell.root, "station.exited", "merge", lambda: {"outcome": "merged", "stage": "merged"})
        result["next"] = f"Merged. Clean up with the cleanup skill for {cell.ticket_id}."
    else:
        telemetry(cell.root, "station.exited", "merge", lambda: {"outcome": "pr-open", "stage": cell.info.get("stage"),
                                                                 "pull_request": int(re.search(r"/pull/(\d+)", result["pull_request"]).group(1))})
        result["next"] = "The pull request is open. Run this again once it can be merged, or merge it on the platform; then clean up."
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["status"] == "MERGED" else 3


def cmd_status(cell: Cell, args: argparse.Namespace) -> int:
    print(json.dumps({**{key: cell.info.get(key) for key in ("ticket_id", "stage", "branch", "risk", "pull_request", "pull_request_findings", "revalidated", "merged")},
                      "mode": cell.mode, "method": cell.method, "approved_commit": cell.decision.get("head"), "branch_commit": cell.head()}, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MACH merge station.")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, func, text in (("plan", cmd_plan, "say what run would do; changes nothing"), ("run", cmd_run, "revalidate and merge")):
        p = sub.add_parser(name, help=text)
        p.add_argument("ticket_id")
        p.add_argument("--by-person", action="store_true", help="a person is merging: allowed whatever merge.mode and merge.auto say")
        p.set_defaults(func=func)
    p = sub.add_parser("status", help="show the cell's merge state")
    p.add_argument("ticket_id")
    p.set_defaults(func=cmd_status)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    project = None
    try:
        project = args.project.resolve() if args.project else find_project(Path.cwd())
        return args.func(Cell(project, args.ticket_id), args)
    except MergeError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        if project is not None and args.command == "run" and not getattr(exc, "recorded", False):
            telemetry(project / ".factory" / "worktrees" / args.ticket_id, "gate.evaluated", "merge", lambda: {
                "gate": "merge.run", "outcome": "refuse", "reason_code": exc.code, "overridden_by_reason": False})
        return 1


if __name__ == "__main__":
    sys.exit(main())
