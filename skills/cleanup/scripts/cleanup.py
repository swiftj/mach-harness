#!/usr/bin/env python3
"""MACH cleanup station: archive a finished cell, remove it, and leave a run record.

After a ticket's branch is merged, or the ticket is abandoned, this script archives the cell's
artifacts, removes the cell's worktree, folder and local branch, and appends one line to the run
log that the observe station learns from. It never merges, never pushes, never deletes a remote
branch, and never touches code on the main checkout.

    cleanup.py plan <ticket> [--merged-as <commit> | --abandon "<why>"]   dry run: what 'run' would do, and whether it may
    cleanup.py run <ticket> [--merged-as <commit> | --abandon "<why>"]    archive, verify the archive, then remove
    cleanup.py orphans [--prune]                   list cells that look finished or broken
    cleanup.py status                              every cell, its stage, and whether it is merged

The only paths it deletes are .factory/worktrees/<ticket>/ and its own partial files under
.factory/tmp/. It archives first, checks the archive, and only then deletes.

Standard library only.
"""

import argparse
import io
import json
import re
import shutil
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
DONE_STAGES = ("approved", "merged")
RISKS = ("High", "Medium", "Low")
MODES = ("interactive", "headless")
MIN_REASON = 10
RUN_LOG = "runs.jsonl"
LIFECYCLE_LOG = "lifecycle.jsonl"  # the cell's station history (M6.1); archived with the cell
# Files that running a build or test suite leaves behind. They are never part of a change, so the
# gates ignore them even when the project forgot to git-ignore them.
BYPRODUCT_RE = re.compile(
    r"(^|/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|htmlcov|\.hypothesis|node_modules|\.gradle|\.next|\.turbo|coverage)(/|$)"
    r"|\.py[co]$|(^|/)\.coverage(\..*)?$|(^|/)\.DS_Store$|\.egg-info(/|$)|\.tsbuildinfo$"
)


def is_byproduct(name: str) -> bool:
    return bool(BYPRODUCT_RE.search(name))


class CleanupError(Exception):
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


def load_dict(path: Path) -> Dict[str, Any]:
    value = load_json(path)
    return value if isinstance(value, dict) else {}


def relative(project: Path, path: Path) -> str:
    return path.relative_to(project).as_posix()


def locked_cell_path(project: Path, ticket_id: str) -> Path:
    """The one folder this script may delete for a ticket, or a refusal."""
    if not TICKET_ID_RE.match(ticket_id):
        raise CleanupError(f"'{ticket_id}' is not a usable ticket ID.")
    base = project / ".factory" / "worktrees"
    root = base / ticket_id
    if root.is_symlink():
        raise CleanupError(f"{root} is a symbolic link. Cleanup only removes real cell folders; look at where it points and remove the link yourself.")
    if base.resolve() != project.resolve() / ".factory" / "worktrees" or root.resolve().parent != base.resolve():
        raise CleanupError(f"{root} does not resolve to a folder inside {project / '.factory' / 'worktrees'}. Nothing was touched.")
    if (root / "repo").is_symlink():
        raise CleanupError(f"{root / 'repo'} is a symbolic link, not the cell's worktree. Nothing was touched.")
    return root


class Cell:
    def __init__(self, project: Path, ticket_id: str) -> None:
        self.project = project
        self.ticket_id = ticket_id
        self.root = locked_cell_path(project, ticket_id)
        self.info = load_json(self.root / "cell.json")
        if not isinstance(self.info, dict):
            if self.root.is_dir():
                raise CleanupError(f"The cell folder for {ticket_id} has no readable cell.json, so nothing about it can be checked. Inspect {self.root} yourself.")
            raise CleanupError(f"No cell for {ticket_id}.")
        self.repo = self.root / "repo"
        self.build = load_dict(self.root / "build-report.json")

    @property
    def isolated(self) -> bool:
        return self.info.get("isolation") == "worktree"

    @property
    def branch(self) -> Optional[str]:
        branch = self.info.get("branch")
        return branch if isinstance(branch, str) and branch else None

    def dirty(self) -> List[str]:
        """Uncommitted and untracked files in the cell's worktree, leaving out what test runs leave behind."""
        if not self.isolated or not self.repo.is_dir():
            return []
        names = [line[3:] for line in git(self.repo, "status", "--porcelain", "--untracked-files=all").stdout.splitlines() if line.strip()]
        return [name for name in names if not is_byproduct(name.strip('"'))]

    def members(self) -> List[str]:
        """Every file in the cell folder except the worktree, relative to the cell folder."""
        found = []
        for entry in sorted(self.root.iterdir()):
            if entry.name == "repo":
                continue
            if entry.is_dir() and not entry.is_symlink():
                found += [p.relative_to(self.root).as_posix() for p in sorted(entry.rglob("*")) if p.is_file() or p.is_symlink()]
            else:
                found.append(entry.name)
        return found


def default_branch(project: Path) -> Tuple[Optional[str], List[str]]:
    """The default branch's name and the refs that stand for it (local, and origin's when there is one)."""
    remote = git(project, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if remote.returncode == 0 and remote.stdout.strip():
        name = remote.stdout.strip().split("/", 1)[-1]
        candidates = [f"refs/heads/{name}", f"refs/remotes/origin/{name}"]
    else:
        head = git(project, "symbolic-ref", "--short", "HEAD")
        if head.returncode != 0 or not head.stdout.strip():
            return None, []
        name = head.stdout.strip()
        candidates = [f"refs/heads/{name}"]
    return name, [ref for ref in candidates if git(project, "rev-parse", "--verify", "-q", ref + "^{commit}").returncode == 0]


def branch_exists(project: Path, branch: str) -> bool:
    return git(project, "show-ref", "--verify", "-q", f"refs/heads/{branch}").returncode == 0


def merged_into(project: Path, branch: str, refs: List[str]) -> Optional[str]:
    for ref in refs:
        if git(project, "merge-base", "--is-ancestor", f"refs/heads/{branch}", ref).returncode == 0:
            return ref.replace("refs/heads/", "").replace("refs/remotes/", "")
    return None


def landed_commit(project: Path, branch: str, refs: List[str], value: str) -> Tuple[Optional[str], Optional[str]]:
    """Check a --merged-as claim: the commit must be on the default branch and newer than where the cell's branch started."""
    found = git(project, "rev-parse", "--verify", "-q", "--end-of-options", value + "^{commit}")
    sha = found.stdout.strip()
    if found.returncode != 0 or not sha:
        return None, f"--merged-as '{value}' is not a commit in this repository. Fetch the default branch if the merge happened on the remote; never guess a commit."
    on = [ref for ref in refs if git(project, "merge-base", "--is-ancestor", sha, ref).returncode == 0]
    if not on:
        return None, f"--merged-as {sha[:12]} is not on the default branch, so it cannot be where this ticket's work landed."
    for ref in on:
        base = git(project, "merge-base", f"refs/heads/{branch}", ref).stdout.strip()
        if base and base != sha and git(project, "merge-base", "--is-ancestor", base, sha).returncode == 0:
            return sha, None
    return None, (f"--merged-as {sha[:12]} is not newer than the point where {branch} started, so it cannot contain this ticket's work. "
                  "Give the commit the squash or rebase merge created.")


def unmerged_commits(project: Path, branch: str, refs: List[str]) -> int:
    done = git(project, "rev-list", "--count", f"refs/heads/{branch}", "--not", *refs)
    return int(done.stdout.strip()) if done.returncode == 0 and done.stdout.strip().isdigit() else 0


def next_archive(project: Path, ticket_id: str) -> Path:
    folder = project / ".factory" / "archive"
    path, number = folder / f"{ticket_id}.tar.gz", 1
    while path.exists() or path.is_symlink():
        number += 1
        path = folder / f"{ticket_id}-{number}.tar.gz"
    return path


def numbered(paths: Sequence[Path]) -> List[Tuple[int, Path]]:
    """Folders named like round-2 or previous-3, in numeric order."""
    found = []
    for path in paths:
        match = re.search(r"-(\d+)$", path.name)
        if match and path.is_dir():
            found.append((int(match.group(1)), path))
    return sorted(found)


def text_or_none(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


RECORD_VERSION = 2


def integration_record(cell: Cell, plan: Dict[str, Any], approved: Optional[str]) -> Optional[Dict[str, Any]]:
    """What landed, and where: the provenance of a merged ticket.

    Every commit named here was checked against the default branch by this station before the
    cell was removed. A reader should still check the commit in Git; the record says where to look.
    """
    if plan.get("outcome") != "merged":
        return None
    info = cell.info
    merged = info.get("merged") if isinstance(info.get("merged"), dict) else {}
    branch = text_or_none(info.get("branch"))
    tip = git(cell.project, "rev-parse", "--verify", "-q", f"refs/heads/{branch}").stdout.strip() if branch else ""
    squashed = text_or_none(plan.get("merged_as"))
    method = "squash-or-rebase" if squashed else text_or_none(merged.get("method")) or "manual"
    return {
        "branch": branch, "into": text_or_none(plan.get("merged_into")) or text_or_none(plan.get("default_branch")), "method": method,
        "approved_commit": approved,
        # The ticket's own last commit, or for a squash or rebase the commit that replaced it.
        "landed_commit": squashed or text_or_none(merged.get("landed_commit")) or (tip or None),
        "merge_commit": text_or_none(merged.get("commit")),
        "pull_request": text_or_none(info.get("pull_request")),
        "merged_at": text_or_none(merged.get("at")),
    }


def run_record(cell: Cell, outcome: str, reason: Optional[str], archive: str, plan: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """One line for the run log. Field names are read by the observe station; do not rename them."""
    info, build = cell.info, cell.build
    rounds = (build.get("review_loop") if isinstance(build.get("review_loop"), int) else 0) + 1 if build else 0

    evidence = cell.root / "evidence"
    summaries = [load_dict(path / "summary.json") for _, path in numbered(list(evidence.glob("previous-*")))] + [load_dict(evidence / "summary.json")]
    failed = [summary for summary in summaries if summary.get("status") == "FAIL_WITH_EVIDENCE"]

    decisions, blockers, notes = [], [], []
    for number, folder in numbered(list((cell.root / "review").glob("round-*"))):
        decisions.append(load_dict(folder / "decision.json"))
        for path in sorted((folder / "votes").glob("*.json")):
            vote = load_dict(path)
            for finding in vote.get("findings") if isinstance(vote.get("findings"), list) else []:
                if isinstance(finding, dict) and finding.get("severity") == "blocker":
                    blockers.append({"round": number, "reviewer": str(vote.get("reviewer") or path.stem), "rule": text_or_none(finding.get("rule")),
                                     "title": str(finding.get("title") or ""), "file": text_or_none(finding.get("file"))})
                elif isinstance(finding, dict) and finding.get("severity") == "note":
                    notes.append({"round": number, "reviewer": str(vote.get("reviewer") or path.stem),
                                  "title": str(finding.get("title") or ""), "file": text_or_none(finding.get("file"))})

    first_run = build.get("tests_passing_on_first_run")
    seen_failing = build.get("tests_seen_failing_first")
    approved = next((text_or_none(decision.get("head")) for decision in reversed(decisions) if decision.get("head")), None) \
        or text_or_none(load_dict(cell.root / "review" / "decision.json").get("head"))
    product = info.get("product") if isinstance(info.get("product"), dict) else None
    return {
        "record_version": RECORD_VERSION,
        "integration": integration_record(cell, plan, approved) if plan else None,
        "product": {key: product.get(key) for key in ("slice_id", "revision", "wave_id", "digest", "source_commit")} if product else None,
        "ticket_id": cell.ticket_id, "slice_id": text_or_none(info.get("slice_id")), "title": str(info.get("title") or ""),
        "risk": info.get("risk") if info.get("risk") in RISKS else None, "app_type": text_or_none(info.get("app_type")),
        "mode": info.get("mode") if info.get("mode") in MODES else None,
        "outcome": outcome, "abandon_reason": reason,
        "rounds": rounds, "first_pass": outcome == "merged" and rounds == 1,
        "verify_failures": len(failed),
        "review_rejections": sum(1 for decision in decisions if decision.get("outcome") in ("REJECTED", "ESCALATE")),
        "escalated": any(decision.get("outcome") == "ESCALATE" for decision in decisions) or info.get("stage") == "blocked",
        "human_approval": any(decision.get("human_approval") is not None for decision in decisions),
        "deviations": [{"type": str(d.get("type") or ""), "task": text_or_none(d.get("task")), "detail": str(d.get("detail") or "")}
                       for d in (build.get("deviations") if isinstance(build.get("deviations"), list) else []) if isinstance(d, dict)],
        "blockers": blockers,
        "notes": notes,
        "verify_findings": [str(item) for summary in failed for item in (summary.get("failures") if isinstance(summary.get("failures"), list) else [])],
        "tests_seen_failing_first": seen_failing if isinstance(seen_failing, int) else 0,
        "tests_passing_on_first_run": len(first_run) if isinstance(first_run, list) else 0,
        "created_at": text_or_none(info.get("created_at")), "closed_at": now(), "archive": archive,
    }


def observe_due(project: Path) -> Dict[str, Any]:
    """Whether enough tickets have finished since the last observe pass for another one."""
    every = load_dict(project / ".factory" / "config.json").get("observe")
    every = every.get("every") if isinstance(every, dict) and isinstance(every.get("every"), int) and every["every"] > 0 else 5
    log = project / ".factory" / "archive" / RUN_LOG
    total = sum(1 for line in log.read_text(encoding="utf-8").splitlines() if line.strip()) if log.is_file() else 0
    seen = load_dict(project / ".factory" / "observations" / "last-pass.json").get("runs_total")
    since = total - (seen if isinstance(seen, int) else 0)
    return {"due": since >= every, "finished_since_last_pass": since, "every": every}


def survey(cell: Cell, abandon: Optional[str], merged_as: Optional[str] = None) -> Dict[str, Any]:
    """Check every gate and describe what 'run' would do. Changes nothing; 'plan' prints it and 'run' obeys it."""
    project, ticket_id, stage = cell.project, cell.ticket_id, cell.info.get("stage")
    abandoning = abandon is not None
    reason = " ".join(abandon.split()) if abandoning else None
    refusals: List[str] = []
    if abandoning and len(reason or "") < MIN_REASON:
        refusals.append(f"--abandon needs the reason the ticket is being abandoned, in at least {MIN_REASON} characters. It is kept in the run record.")

    if abandoning and merged_as:
        refusals.append("--abandon and --merged-as contradict each other: a ticket's work either landed or is being given up.")

    name, refs = default_branch(project)
    branch, merged, target, landed = cell.branch, None, None, None
    has_branch, unmerged = False, 0
    if cell.isolated:
        if branch != f"feature/{ticket_id}":
            refusals.append(f"cell.json names the branch '{branch}', not 'feature/{ticket_id}'. Cleanup only deletes a cell's own feature branch; correct cell.json or remove the cell by hand.")
        else:
            has_branch = branch_exists(project, branch)
            if not has_branch:
                if not abandoning:
                    refusals.append(f"The branch {branch} no longer exists, so whether its work was merged cannot be checked.")
            elif not refs:
                if not abandoning:
                    refusals.append("The default branch cannot be determined (no origin/HEAD, and the main checkout is not on a branch), so the merge cannot be checked.")
            else:
                target = merged_into(project, branch, refs)
                merged = target is not None
                if merged_as and not abandoning:
                    landed, problem = landed_commit(project, branch, refs, merged_as)
                    if problem:
                        refusals.append(problem)
            if has_branch:
                unmerged = unmerged_commits(project, branch, refs)
        if not abandoning and merged is False and not merged_as:
            refusals.append(f"The branch {branch} is not merged into {name}. This station does not merge: merge the approved branch first, then run cleanup again. "
                            + ("If it was merged as a squash or a rebase, rerun with --merged-as <the commit it landed as>. " if stage in DONE_STAGES else "")
                            + "Only if the ticket is being given up, a person may ask for --abandon.")
        elif not abandoning and (merged or landed) and stage not in DONE_STAGES:
            refusals.append(f"The work of {branch} is already in {name}, but review has not approved this ticket (the cell's stage is '{stage}'): it was merged early. "
                            "Finish the review so the record is true, then run cleanup again. --abandon is not the fix.")
    elif merged_as:
        refusals.append("--merged-as applies only to a cell with its own branch; this cell has none.")
    elif not abandoning and stage not in DONE_STAGES:
        refusals.append(f"Review has not approved this ticket (the cell's stage is '{stage}'). Finish the review, then run cleanup again.")

    dirty = cell.dirty()
    if dirty and not abandoning:
        shown = ", ".join(dirty[:5]) + (f" and {len(dirty) - 5} more" if len(dirty) > 5 else "")
        refusals.append(f"The cell's worktree has uncommitted changes ({shown}). Removing it would lose them: commit or discard them in the cell first.")

    force = abandoning or bool(landed and not merged)
    bundle = abandoning and has_branch and unmerged > 0
    members = [f"{ticket_id}/{name_}" for name_ in cell.members()]
    if bundle:
        members.append(f"{ticket_id}/branch.bundle (the {unmerged} commit(s) of {branch} that are not on {name or 'any other branch'})")
    if dirty:
        members.append(f"{ticket_id}/uncommitted.patch and {ticket_id}/untracked/ (the uncommitted work)")
    return {
        "ticket_id": ticket_id, "allowed": not refusals, "refusals": refusals,
        "outcome": "abandoned" if abandoning else "merged", "abandon_reason": reason,
        "stage": stage, "isolation": cell.info.get("isolation"), "branch": branch, "default_branch": name,
        "merged": merged, "merged_into": target, "merged_as": landed, "unmerged_commits": unmerged, "uncommitted": dirty,
        "would": {
            "archive": relative(project, next_archive(project, ticket_id)), "archive_members": members,
            "remove_worktree": relative(project, cell.repo) if cell.isolated and cell.repo.exists() else None,
            "remove_folder": relative(project, cell.root),
            "bundle_branch": bundle,
            "delete_branch": f"git branch {'-D' if force else '-d'} {branch}" if cell.isolated and has_branch else None,
            "append_record": f".factory/archive/{RUN_LOG}",
        },
        "never": "No merge, no push, no remote branch deleted, nothing changed on the main checkout.",
    }


def add_bytes(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    member = tarfile.TarInfo(name)
    member.size, member.mtime = len(data), int(datetime.now().timestamp())
    tar.addfile(member, io.BytesIO(data))


def bundle_branch(cell: Cell, refs: List[str], path: Path) -> None:
    """Save the branch's commits that are on no default branch as a git bundle, and check git can read it back."""
    project, ref = cell.project, f"refs/heads/{cell.branch}"
    done = git(project, "bundle", "create", str(path), ref, "--not", *refs) if refs else None
    if done is None or done.returncode != 0:
        done = git(project, "bundle", "create", str(path), ref)
    if done.returncode != 0 or not path.is_file() or path.stat().st_size == 0:
        raise CleanupError(f"git could not bundle the branch {cell.branch}: {done.stderr.strip()}")
    check = git(project, "bundle", "verify", str(path))
    if check.returncode != 0:
        raise CleanupError(f"The bundle of {cell.branch} does not verify: {check.stderr.strip()}")


def write_archive(cell: Cell, target: Path, dirty: List[str], bundle_refs: Optional[List[str]] = None, merged_as: Optional[str] = None,
                  log: Optional[bytes] = None) -> List[str]:
    """Write the archive beside the others, check it, and return its member names. On any failure nothing is left behind.

    bundle_refs, when given, are the default branch refs: the cell's branch is bundled against them and added.
    log, when given, is the cell's lifecycle log with cleanup's own closing records appended; it is archived in
    place of the file on disk, which is never changed (the cell folder is deleted next). A cell with no lifecycle
    log (made before M6.1, or by hand) is archived exactly as before, with no log added.
    """
    project, prefix = cell.project, cell.ticket_id
    partial = project / ".factory" / "tmp" / f"cleanup-{target.name}.partial"
    bundle = project / ".factory" / "tmp" / f"cleanup-{target.name}.bundle"
    expected = [f"{prefix}/{name}" for name in cell.members()]
    try:
        partial.parent.mkdir(parents=True, exist_ok=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(str(partial), "w:gz") as tar:
            for entry in sorted(cell.root.iterdir()):
                if entry.name == "cell.json" and merged_as:
                    add_bytes(tar, f"{prefix}/cell.json", (json.dumps({**cell.info, "merged_as": merged_as}, indent=2) + "\n").encode("utf-8"))
                elif entry.name == LIFECYCLE_LOG and log is not None:
                    add_bytes(tar, f"{prefix}/{LIFECYCLE_LOG}", log)
                elif entry.name != "repo":
                    tar.add(str(entry), arcname=f"{prefix}/{entry.name}")
            if bundle_refs is not None:
                bundle_branch(cell, bundle_refs, bundle)
                tar.add(str(bundle), arcname=f"{prefix}/branch.bundle")
                expected.append(f"{prefix}/branch.bundle")
            if dirty:
                patch = subprocess.run(["git", "diff", "HEAD", "--binary"], cwd=str(cell.repo), capture_output=True)
                if patch.returncode != 0:
                    raise CleanupError("git could not write the uncommitted changes as a patch: " + patch.stderr.decode("utf-8", "replace").strip())
                if patch.stdout:
                    add_bytes(tar, f"{prefix}/uncommitted.patch", patch.stdout)
                    expected.append(f"{prefix}/uncommitted.patch")
                listed = subprocess.run(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=str(cell.repo), capture_output=True)
                for raw in listed.stdout.split(b"\0"):
                    name = raw.decode("utf-8", "surrogateescape").rstrip("/")
                    if name and not is_byproduct(name):
                        tar.add(str(cell.repo / name), arcname=f"{prefix}/untracked/{name}")
                        expected.append(f"{prefix}/untracked/{name}")
        with tarfile.open(str(partial), "r:gz") as tar:
            names = set(tar.getnames())
        missing = [name for name in expected if name not in names]
        if partial.stat().st_size == 0 or missing or f"{prefix}/cell.json" not in names:
            raise CleanupError(f"The archive did not come out complete (missing: {', '.join(missing[:5]) or 'cell.json'}).")
        if any(name == f"{prefix}/repo" or name.startswith(f"{prefix}/repo/") for name in names):
            raise CleanupError("The archive unexpectedly contains the worktree.")
        if target.exists():
            raise CleanupError(f"{target} appeared while archiving; refusing to overwrite it.")
        partial.replace(target)
    except (OSError, tarfile.TarError, CleanupError) as exc:
        if partial.exists():
            partial.unlink()
        raise CleanupError(f"Archiving failed, so nothing was deleted. {exc}", code="archive-failed")
    finally:
        if bundle.exists():
            bundle.unlink()
    if not target.is_file() or target.stat().st_size == 0:
        raise CleanupError(f"The archive {target} is missing or empty after writing, so nothing was deleted.")
    return sorted(names)


def cmd_plan(project: Path, args: argparse.Namespace) -> int:
    plan = survey(Cell(project, args.ticket_id), args.abandon, args.merged_as)
    plan["next"] = (f"Show the user what will be removed, then: cleanup.py run {args.ticket_id}" + (" --abandon \"<the same reason>\"" if args.abandon is not None else "")
                    + (f" --merged-as {plan['merged_as']}" if plan["merged_as"] else "")
                    if plan["allowed"] else "Not allowed yet. Resolve each refusal; do not work around it.")
    print(json.dumps(plan, indent=2, ensure_ascii=False))
    return 0


def cmd_run(project: Path, args: argparse.Namespace) -> int:
    cell = Cell(project, args.ticket_id)
    plan = survey(cell, args.abandon, args.merged_as)
    if plan["refusals"]:
        raise CleanupError(plan["refusals"][0] if len(plan["refusals"]) == 1 else "\n- " + "\n- ".join(plan["refusals"]), code="cleanup-refused")
    abandoning = args.abandon is not None
    target = next_archive(project, cell.ticket_id)
    archive = relative(project, target)
    record = run_record(cell, plan["outcome"], plan["abandon_reason"], archive, plan)
    bundled = plan["would"]["bundle_branch"]
    # The cell folder is about to be deleted, so cleanup's own lifecycle records go only into the archived copy of the log,
    # after closing any visit still open. If archiving fails nothing claims the cleanup happened; runs.jsonl carries the rest.
    log = None if lifecycle is None else lifecycle.closing(cell.root, [
        ("gate.evaluated", "cleanup", {"gate": "cleanup.run", "outcome": "pass", "reason_code": None, "overridden_by_reason": False}),
        ("station.entered", "cleanup", {"stage": plan["stage"]}),
        ("cleanup.completed", "cleanup", {"outcome": plan["outcome"], "archive": archive, "bundle": bool(bundled), "uncommitted_saved": bool(plan["uncommitted"])}),
        ("station.exited", "cleanup", {"outcome": plan["outcome"]}),
    ], "abandoned" if abandoning else "closed")
    members = write_archive(cell, target, plan["uncommitted"], default_branch(project)[1] if bundled else None, plan["merged_as"], log)

    kept = f"The archive is at {archive}; the run record is not written yet. Fix the cause and run cleanup again."
    root = locked_cell_path(project, cell.ticket_id)  # asked again, immediately before deleting
    removed: List[str] = []
    if cell.isolated:
        if cell.repo.exists():
            done = git(project, "worktree", "remove", "--force", str(cell.repo))
            if done.returncode != 0 or cell.repo.exists():
                raise CleanupError(f"git could not remove the worktree {cell.repo}: {done.stderr.strip() or done.stdout.strip()} {kept}")
            removed.append(relative(project, cell.repo))
        else:
            git(project, "worktree", "prune")  # the folder is already gone; drop git's stale record so the branch is free
    try:
        shutil.rmtree(str(root))
    except OSError as exc:
        raise CleanupError(f"Could not remove {root}: {exc}. {kept}")
    removed.append(relative(project, root))

    branch_deleted, note = False, None
    if plan["would"]["delete_branch"]:
        done = git(project, *plan["would"]["delete_branch"].split()[1:3], cell.branch)
        branch_deleted = done.returncode == 0
        if not branch_deleted:
            note = f"git kept the branch {cell.branch}: {done.stderr.strip()} Delete it yourself" + (" once the main checkout has the merge." if not abandoning else ".")

    with (target.parent / RUN_LOG).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    state = "closed, with the label 'abandoned'" if abandoning else "closed"
    observe = observe_due(project)
    print(json.dumps({
        "status": "CLEANED", "ticket_id": cell.ticket_id, "outcome": plan["outcome"], "merged_as": plan["merged_as"], "archive": archive, "archive_members": len(members),
        "bundle": f"{cell.ticket_id}/branch.bundle" if bundled else None,
        "restore": (f"The branch's {plan['unmerged_commits']} unmerged commit(s) are saved in the archive. To restore: tar -xzf {archive} {cell.ticket_id}/branch.bundle && "
                    f"git fetch {cell.ticket_id}/branch.bundle {cell.branch}:{cell.branch}") if bundled else None,
        "removed": removed, "branch": cell.branch, "branch_deleted": branch_deleted, "branch_note": note,
        "record": record, "run_log": relative(project, target.parent / RUN_LOG),
        "observe_due": observe["due"], "finished_since_last_observe_pass": observe["finished_since_last_pass"],
        "next": f"Set the ticket {cell.ticket_id} to {state}, using the ticket skill."
                + (f" Then an observe pass is due ({observe['finished_since_last_pass']} tickets have finished since the last one): run the observe skill with --auto." if observe["due"] else ""),
    }, indent=2, ensure_ascii=False))
    return 0


def cell_folders(project: Path) -> List[Path]:
    base = project / ".factory" / "worktrees"
    return sorted(p for p in base.iterdir() if (p.is_dir() or p.is_symlink()) and not p.name.startswith(".")) if base.is_dir() else []


def prunable_worktrees(project: Path) -> List[Dict[str, str]]:
    """Worktrees under .factory/worktrees/ that git still records but whose folder is gone."""
    base = (project / ".factory" / "worktrees").resolve()
    found, path = [], None
    for line in git(project, "worktree", "list", "--porcelain").stdout.splitlines():
        if line.startswith("worktree "):
            path = Path(line[len("worktree "):])
        elif line.startswith("prunable") and path is not None and base in path.resolve().parents:
            found.append({"path": str(path), "reason": line[len("prunable"):].strip() or "stale"})
    return found


def cmd_orphans(project: Path, args: argparse.Namespace) -> int:
    name, refs = default_branch(project)
    orphans = []
    for folder in cell_folders(project):
        entry: Dict[str, Any] = {"ticket_id": folder.name, "path": relative(project, folder), "stage": None, "reasons": []}
        info = load_json(folder / "cell.json")
        if folder.is_symlink():
            entry["reasons"].append("The cell folder is a symbolic link; cleanup will not touch it.")
        elif not TICKET_ID_RE.match(folder.name):
            entry["reasons"].append("The folder name is not a ticket ID.")
        elif not isinstance(info, dict):
            entry["reasons"].append("No readable cell.json: not a cell, or a broken one. Inspect it by hand.")
        else:
            entry["stage"] = info.get("stage")
            branch = info.get("branch")
            if info.get("isolation") == "worktree":
                if not (folder / "repo").is_dir():
                    entry["reasons"].append("cell.json says the cell has a worktree, but repo/ is missing.")
                if isinstance(branch, str) and branch_exists(project, branch) and merged_into(project, branch, refs):
                    entry["reasons"].append(f"The branch {branch} is merged into {name}." if info.get("stage") in DONE_STAGES
                                            else f"The branch {branch} has nothing that is not in {name}, but the stage is '{info.get('stage')}': merged before approval, or no work committed yet.")
            if info.get("stage") in DONE_STAGES and entry["reasons"]:
                entry["suggest"] = f"cleanup.py plan {folder.name}"
        if entry["reasons"]:
            orphans.append(entry)
    prunable = prunable_worktrees(project)
    result: Dict[str, Any] = {"default_branch": name, "orphans": orphans, "prunable_worktrees": prunable, "pruned": False}
    if args.prune:
        done = git(project, "worktree", "prune")
        if done.returncode != 0:
            raise CleanupError("git worktree prune failed: " + done.stderr.strip())
        result["pruned"] = True
        result["prunable_worktrees_left"] = prunable_worktrees(project)
    result["note"] = "Nothing was removed." + (" 'git worktree prune' dropped git's stale records; no files were touched." if args.prune else "")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


def cmd_status(project: Path, args: argparse.Namespace) -> int:
    name, refs = default_branch(project)
    cells = []
    for folder in cell_folders(project):
        info = load_json(folder / "cell.json")
        if folder.is_symlink() or not isinstance(info, dict):
            cells.append({"ticket_id": folder.name, "stage": None, "merged": None, "problem": "symbolic link" if folder.is_symlink() else "no readable cell.json"})
            continue
        branch = info.get("branch") if isinstance(info.get("branch"), str) else None
        merged = bool(merged_into(project, branch, refs)) if branch and refs and branch_exists(project, branch) else None
        cells.append({"ticket_id": folder.name, "slice_id": info.get("slice_id"), "title": info.get("title"), "stage": info.get("stage"),
                      "isolation": info.get("isolation"), "branch": branch, "merged": merged})
    print(json.dumps({"default_branch": name, "cells": cells}, indent=2, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MACH cleanup station: archive and remove finished cells.")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, func, text in (("plan", cmd_plan, "dry run: print what 'run' would do and whether it is allowed"),
                             ("run", cmd_run, "archive the cell, then remove its worktree, folder and local branch")):
        p = sub.add_parser(name, help=text)
        p.add_argument("ticket_id")
        p.add_argument("--abandon", metavar="WHY", help="give up an unmerged ticket: its commits are archived as a git bundle and its uncommitted work as a patch, then removed")
        p.add_argument("--merged-as", metavar="COMMIT", help="the commit on the default branch that a squash or rebase merge of this ticket created")
        p.set_defaults(func=func)
    p = sub.add_parser("orphans", help="list cells that look finished or broken; removes nothing")
    p.add_argument("--prune", action="store_true", help="also run 'git worktree prune' (drops git's stale records, never files)")
    p.set_defaults(func=cmd_orphans)
    p = sub.add_parser("status", help="list every cell with its stage and whether its branch is merged")
    p.set_defaults(func=cmd_status)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    project = None
    try:
        project = args.project.resolve() if args.project else find_project(Path.cwd())
        return args.func(project, args)
    except CleanupError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        if project is not None and args.command == "run":
            telemetry(project / ".factory" / "worktrees" / args.ticket_id, "gate.evaluated", "cleanup", lambda: {
                "gate": "cleanup.run", "outcome": "refuse", "reason_code": exc.code, "overridden_by_reason": False, "abandon": args.abandon is not None})
        return 1


if __name__ == "__main__":
    sys.exit(main())
