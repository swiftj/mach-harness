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
.factory/tmp/. It archives first, checks the archive, and only then deletes. The only refs it deletes
are the cell's own feature branch and the old branch tips a re-plan saved under
refs/mach/replan/<ticket>/ (cell.py replan); the commits those tips hold are kept in the archive
(replans.bundle) unless the default branch or the archived branch bundle already holds them. For a ticket built in lanes
(M22) it also removes the lane and join worktrees under lanes/, Git's records of them, and the branches under
mach-lane/<ticket>/; the lanes' state files are archived, never a lane's checked-out tree, the commits only the lane
branches hold go into lanes.bundle and each lane's uncommitted files under lanes-saved/<lane>/.

The merge station's change record (M13, docs/changes/<ticket>.md on the branch) is named in the run record with its
SHA-256. A team that keeps evidence elsewhere sets records.publish_command in .factory/config.json, a list of strings run
without a shell once the archive is written and checked ({archive} is its path, {ticket} the ticket ID; with no
{archive} the path is the last argument). Its outcome goes into the run record; a failure never stops cleanup.

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
        """Every file in the cell folder except the worktree and the lanes' worktrees, relative to the cell folder."""
        found = []
        for entry in sorted(self.root.iterdir()):
            if entry.name == "repo":
                continue
            if entry.name == LANES and entry.is_dir() and not entry.is_symlink():
                found += sorted(lane_state_files(self.root, entry))
            elif entry.is_dir() and not entry.is_symlink():
                found += [p.relative_to(self.root).as_posix() for p in sorted(entry.rglob("*")) if p.is_file() or p.is_symlink()]
            else:
                found.append(entry.name)
        return found


# ---------------------------------------------------------------- lanes (M22)
#
# A ticket built in lanes has, beside its own worktree, one worktree per lane at lanes/<L>/repo and the join's at
# lanes/join/repo, on branches mach-lane/<ticket>/<L> and mach-lane/<ticket>/join. The build station removes them when it
# joins the lanes; a ticket abandoned with its lanes open, or a join that left something behind, still has them. Cleanup
# archives each lane's state files (lane.json and the rest) but never a lane's checked-out tree, keeps every lane commit the
# default branch does not hold in lanes.bundle and every lane's uncommitted files under lanes-saved/<L>/, then removes the
# worktrees, Git's records of them and the branches.

LANES = "lanes"
LANE_BRANCH_PREFIX = "mach-lane/"
LANE_NAME_RE = re.compile(r"^(?:L\d{1,3}|join)$")
LANES_BUNDLE = "lanes.bundle"
LANES_SAVED = "lanes-saved"


def is_lane_tree(parts: Sequence[str]) -> bool:
    """Whether a path inside the cell folder (its parts) is a lane's checked-out tree, lanes/<L>/repo, or inside one."""
    return len(parts) >= 3 and parts[0] == LANES and parts[2] == "repo"


def lane_state_files(root: Path, folder: Path) -> List[str]:
    """Every file under lanes/ except inside a lane's checked-out tree, relative to the cell folder. The tree is never
    walked: it can be a whole working copy."""
    found: List[str] = []
    for child in sorted(folder.iterdir()):
        parts = child.relative_to(root).parts
        if is_lane_tree(parts):
            continue
        if child.is_dir() and not child.is_symlink():
            found += lane_state_files(root, child)
        elif child.is_file() or child.is_symlink():
            found.append("/".join(parts))
    return found


def lane_branch_refs(project: Path, ticket_id: str) -> List[Tuple[str, str]]:
    """Every branch under exactly mach-lane/<ticket>/, with the commit it points at. Another ticket's are never listed."""
    prefix = f"refs/heads/{LANE_BRANCH_PREFIX}{ticket_id}/"
    found = []
    for line in git(project, "for-each-ref", "--format=%(refname) %(objectname)", prefix).stdout.splitlines():
        name, _, sha = line.partition(" ")
        if name.startswith(prefix) and len(name) > len(prefix) and sha.strip():
            found.append((name[len("refs/heads/"):], sha.strip()))
    return found


def registered_worktrees(project: Path) -> List[Tuple[Path, Optional[str]]]:
    """Git's worktree records: each worktree's path and the branch it has checked out (None when detached)."""
    found: List[Tuple[Path, Optional[str]]] = []
    path: Optional[Path] = None
    for line in git(project, "worktree", "list", "--porcelain").stdout.splitlines():
        if line.startswith("worktree "):
            if path is not None:
                found.append((path, None))
            path = Path(line[len("worktree "):])
        elif line.startswith("branch ") and path is not None:
            found.append((path, line[len("branch refs/heads/"):] if line.startswith("branch refs/heads/") else None))
            path = None
    if path is not None:
        found.append((path, None))
    return found


def inside(path: Path, folder: Path) -> bool:
    try:
        resolved = path.resolve()
    except (OSError, RuntimeError):
        return False
    return folder.resolve() in resolved.parents


def lane_survey(cell: "Cell", refs: List[str]) -> Optional[Dict[str, Any]]:
    """What the ticket's lanes left: worktrees (folders under lanes/ and Git's records of them), branches, the commits only
    the lane branches hold, and each lane checkout's uncommitted files. None when the ticket has no lanes at all, so
    everything else cleanup says and does is as before. `problems` are refusals: a folder cleanup cannot account for."""
    project, folder = cell.project, cell.root / LANES
    branches = lane_branch_refs(project, cell.ticket_id)
    records = [(path, branch) for path, branch in registered_worktrees(project) if inside(path, folder)]
    if not folder.is_dir() and not branches and not records:
        return None
    problems: List[str] = []
    trees: Dict[str, Dict[str, Any]] = {}
    for lane in sorted(folder.iterdir()) if folder.is_dir() and not folder.is_symlink() else []:
        repo = lane / "repo"
        if not (repo.exists() or repo.is_symlink()):
            continue
        name = lane.name
        if not LANE_NAME_RE.match(name) or repo.is_symlink() or not repo.is_dir():
            problems.append(f"{repo} is not a lane's worktree cleanup knows ({'a symbolic link' if repo.is_symlink() else 'an unexpected name or not a folder'}). "
                            f"Nothing was touched. Move it out of {cell.root} to keep what it holds, then run cleanup again.")
            continue
        top = git(repo, "rev-parse", "--show-toplevel") if (repo / ".git").exists() else None
        if top is None or top.returncode != 0 or Path(top.stdout.strip()).resolve() != repo.resolve():
            problems.append(f"{repo} is not a Git worktree, so nothing else holds what is in it. Nothing was touched. "
                            f"Move it out of {cell.root} to keep it, then run cleanup again.")
            continue
        names = [line[3:] for line in git(repo, "status", "--porcelain", "--untracked-files=all").stdout.splitlines() if line.strip()]
        trees[name] = {"repo": repo, "uncommitted": [item for item in names if not is_byproduct(item.strip('"'))],
                       "head": git(repo, "rev-parse", "--verify", "-q", "HEAD").stdout.strip() or None}
    known = {tree["repo"].resolve() for tree in trees.values()}
    gone = [str(path) for path, _ in records if path.resolve() not in known]  # Git still records it; its folder is gone or unknown
    bundle_refs = [f"refs/heads/{branch}" for branch, _ in branches]
    unkept = unkept_commits(project, bundle_refs, refs) if bundle_refs else 0
    return {"folder": str(folder), "worktrees": {name: str(tree["repo"]) for name, tree in trees.items()}, "stale_records": gone,
            "branches": dict(branches), "bundle_refs": bundle_refs, "unkept_commits": unkept, "bundle_excludes": list(refs),
            "uncommitted": {name: tree["uncommitted"] for name, tree in trees.items() if tree["uncommitted"]},
            "heads": {name: tree["head"] for name, tree in trees.items()}, "problems": problems}


def lanes_result(cell: "Cell", lanes: Dict[str, Any], done: Dict[str, Any], archive: str, default: Optional[str]) -> Dict[str, Any]:
    """What cleanup did with the ticket's lanes, where their work is kept, and how to get it back."""
    ticket, restore = cell.ticket_id, []
    bundle = f"{ticket}/{LANES_BUNDLE}" if lanes["unkept_commits"] else None
    if bundle:
        restore.append(f"The lane branches' {lanes['unkept_commits']} commit(s) that are not on {default or 'the default branch'} are saved in the archive. "
                       "To bring the branches back: "
                       f"tar -xzf {archive} {bundle} && git fetch {bundle} 'refs/heads/{LANE_BRANCH_PREFIX}{ticket}/*:refs/heads/{LANE_BRANCH_PREFIX}{ticket}/*'")
    saved = {}
    for lane in sorted(lanes["uncommitted"]):
        folder = f"{ticket}/{LANES_SAVED}/{lane}"
        saved[lane] = folder + "/"
        head = lanes["heads"].get(lane)
        restore.append(f"Lane {lane}'s uncommitted files are saved under {folder}/ in the archive, made against commit {head or '(not recorded)'}. "
                       f"To put them back{' (bring the branches back first)' if bundle else ''}: tar -xzf {archive} {folder}, then git worktree add <a folder> {head or '<that commit>'}, and in that folder "
                       f"git apply <the project>/{folder}/uncommitted.patch and copy in the files under {folder}/untracked/.")
    return {"worktrees_removed": [relative(cell.project, Path(repo)) for repo in sorted(lanes["worktrees"].values())],
            "worktree_records_dropped": lanes["stale_records"], "branches": lanes["branches"], "branches_deleted": done["branches_deleted"],
            "bundle": bundle, "uncommitted_saved": saved, "left": done["left"],
            "restore": restore or None,
            "note": (f"Every lane commit that is not on {default or 'the default branch'} and every lane's uncommitted file is in the archive; "
                     "no lane's checked-out tree is.")}


def bundle_lanes(project: Path, refs: List[str], excludes: List[str], path: Path) -> None:
    """Save the commits only the lane branches hold as a git bundle, and check git can read it back."""
    done = git(project, "bundle", "create", str(path), *refs, *(["--not", *excludes] if excludes else []))
    if done.returncode != 0 or not path.is_file() or path.stat().st_size == 0:
        raise CleanupError(f"git could not bundle the lane branches {', '.join(refs)}: {done.stderr.strip()}")
    check = git(project, "bundle", "verify", str(path))
    if check.returncode != 0:
        raise CleanupError(f"The bundle of the lane branches does not verify: {check.stderr.strip()}")


def save_uncommitted(tar: tarfile.TarFile, repo: Path, prefix: str) -> List[str]:
    """A checkout's uncommitted changes as uncommitted.patch and its untracked files under untracked/, beneath `prefix` in the
    archive; what test runs leave behind is not saved. Returns the member names written."""
    written: List[str] = []
    patch = subprocess.run(["git", "diff", "HEAD", "--binary"], cwd=str(repo), capture_output=True)
    if patch.returncode != 0:
        raise CleanupError(f"git could not write the uncommitted changes of {repo} as a patch: " + patch.stderr.decode("utf-8", "replace").strip())
    if patch.stdout:
        add_bytes(tar, f"{prefix}/uncommitted.patch", patch.stdout)
        written.append(f"{prefix}/uncommitted.patch")
    listed = subprocess.run(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=str(repo), capture_output=True)
    for raw in listed.stdout.split(b"\0"):
        name = raw.decode("utf-8", "surrogateescape").rstrip("/")
        if name and not is_byproduct(name):
            tar.add(str(repo / name), arcname=f"{prefix}/untracked/{name}")
            written.append(f"{prefix}/untracked/{name}")
    return written


def remove_lane_worktrees(cell: "Cell", lanes: Dict[str, Any]) -> List[str]:
    """After the archive is written and checked: remove every lane worktree. A folder Git will not remove goes with the cell
    folder, deleted next, and Git's record of it is dropped by finish_lanes. Returns the folders, relative to the project."""
    for repo in sorted(lanes["worktrees"].values()):
        git(cell.project, "worktree", "remove", "--force", "--force", repo)
    return [relative(cell.project, Path(repo)) for repo in sorted(lanes["worktrees"].values())]


def finish_lanes(cell: "Cell", lanes: Dict[str, Any]) -> Dict[str, Any]:
    """Once the cell folder is gone: drop Git's records of the lane worktrees, then delete each lane branch, only if it still
    points where it did when the archive was made and no worktree elsewhere has it checked out. Never raises."""
    project, folder = cell.project, Path(lanes["folder"])
    git(project, "worktree", "prune")
    worktrees = registered_worktrees(project)
    left = [f"Git still records the worktree {path}; run git worktree prune once its folder is gone" for path, _ in worktrees if inside(path, folder)]
    checked_out = {branch: path for path, branch in worktrees if branch}
    deleted = []
    for branch, sha in sorted(lanes["branches"].items()):
        if not branch.startswith(f"{LANE_BRANCH_PREFIX}{cell.ticket_id}/"):
            continue
        if branch in checked_out:
            left.append(f"the branch {branch} was kept: {checked_out[branch]} has it checked out. Its commits are in the archive too; "
                        f"delete it with git branch -D {branch} once that worktree no longer needs it")
            continue
        if git(project, "update-ref", "-d", f"refs/heads/{branch}", sha).returncode == 0:
            deleted.append(branch)
        else:
            left.append(f"the branch {branch} was kept: it moved after the archive was made, so its newest commits are only on it. "
                        f"Look at them with git log {branch}")
    return {"branches_deleted": deleted, "left": left}


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


def replan_refs(project: Path, ticket_id: str) -> List[Tuple[str, str]]:
    """The old branch tips a re-plan saved for this ticket (cell.py replan): every ref under exactly
    refs/mach/replan/<ticket_id>/, with the commit it points at. Another ticket's refs are never listed."""
    prefix = f"refs/mach/replan/{ticket_id}/"
    found = []
    for line in git(project, "for-each-ref", "--format=%(refname) %(objectname)", prefix).stdout.splitlines():
        name, _, sha = line.partition(" ")
        if name.startswith(prefix) and len(name) > len(prefix) and sha.strip():
            found.append((name, sha.strip()))
    return found


def unkept_commits(project: Path, refs: List[str], excludes: List[str]) -> int:
    """How many commits the refs reach that none of the excludes do: what only a bundle would keep."""
    if not refs:
        return 0
    done = git(project, "rev-list", "--count", *refs, *(["--not", *excludes] if excludes else []))
    return int(done.stdout.strip()) if done.returncode == 0 and done.stdout.strip().isdigit() else len(refs)


def next_archive(project: Path, ticket_id: str) -> Path:
    folder = project / ".factory" / "archive"
    path, number = folder / f"{ticket_id}.tar.gz", 1
    while path.exists() or path.is_symlink():
        number += 1
        path = folder / f"{ticket_id}-{number}.tar.gz"
    return path


def numbered(paths: Sequence[Path]) -> List[Tuple[int, Path]]:
    """Folders named like round-2 or previous-3, in numeric order. A repeat of a round (round-2.1, a re-review
    after the merge station voided an approval) carries its round's number and sorts after it."""
    found = []
    for path in paths:
        match = re.search(r"-(\d+)(?:\.(\d+))?$", path.name)
        if match and path.is_dir():
            found.append(((int(match.group(1)), int(match.group(2) or 0)), path))
    return [(key[0], path) for key, path in sorted(found)]


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


def product_record(product: Dict[str, Any]) -> Dict[str, Any]:
    """The product block of a run record (M11): the slice, its revision, its epic, where it came from, and its
    issue (identifiers only) when it came as a GitHub issue."""
    block = {key: product.get(key) for key in ("slice_id", "revision", "epic_id", "digest", "source", "source_commit")}
    issue = product.get("issue")
    if isinstance(issue, dict) and isinstance(issue.get("repository"), str) and type(issue.get("number")) is int:
        block["issue"] = {"repository": issue["repository"], "number": issue["number"]}
    return block


def run_record(cell: Cell, outcome: str, reason: Optional[str], archive: str, plan: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """One line for the run log. Field names are read by the observe station; do not rename them."""
    info, build = cell.info, cell.build
    rounds = (build.get("review_loop") if isinstance(build.get("review_loop"), int) else 0) + 1 if build else 0

    evidence = cell.root / "evidence"
    summaries = [load_dict(path / "summary.json") for _, path in numbered(list(evidence.glob("previous-*")))] + [load_dict(evidence / "summary.json")]
    failed = [summary for summary in summaries if summary.get("status") == "FAIL_WITH_EVIDENCE"]

    decisions, blockers, notes, exceptions, ratings, nits_dropped = [], [], [], [], [], 0
    for number, folder in numbered(list((cell.root / "review").glob("round-*"))):
        decision = load_dict(folder / "decision.json")
        decisions.append(decision)
        label = folder.name[len("round-"):]
        # A person's exceptions to a security blocker (review.py except): identifiers and codes for observe to count.
        # Who decided and why stay in the archived decision.json, never in the run log.
        recorded = [item for item in decision.get("exceptions") or [] if isinstance(item, dict)] if isinstance(decision.get("exceptions"), list) else []
        excepted = {f"{item.get('round')}/{item.get('seat')}/{item.get('index')}" for item in recorded}
        for item in recorded:
            exceptions.append({"round": number, "seat": text_or_none(item.get("seat")), "index": item.get("index") if isinstance(item.get("index"), int) else None,
                               "title": str(item.get("title") or ""), "rule": text_or_none(item.get("rule")), "file": text_or_none(item.get("file")),
                               "class": text_or_none(item.get("class")), "impact": text_or_none(item.get("impact")), "head": text_or_none(item.get("head")),
                               "expires": text_or_none(item.get("expires")), "renewal": item.get("renews") is not None,
                               "recorded_at": text_or_none(item.get("recorded_at"))})
        for path in sorted((folder / "votes").glob("*.json")):
            vote = load_dict(path)
            for index, finding in enumerate(vote.get("findings") if isinstance(vote.get("findings"), list) else [], start=1):
                if isinstance(finding, dict) and finding.get("severity") == "blocker":
                    entry = {"round": number, "reviewer": str(vote.get("reviewer") or path.stem), "rule": text_or_none(finding.get("rule")),
                             "title": str(finding.get("title") or ""), "file": text_or_none(finding.get("file"))}
                    entry.update({key: finding[key] for key in ("class", "impact") if isinstance(finding.get(key), str)})
                    if f"{label}/{path.stem}/{index}" in excepted:
                        entry["excepted"] = True
                    blockers.append(entry)
                elif isinstance(finding, dict) and finding.get("severity") == "note":
                    notes.append({"round": number, "reviewer": str(vote.get("reviewer") or path.stem),
                                  "title": str(finding.get("title") or ""), "file": text_or_none(finding.get("file")),
                                  **({"weight": finding["weight"]} if finding.get("weight") in ("important", "nit") else {})})  # M15
            nits_dropped += vote["nits_dropped"] if type(vote.get("nits_dropped")) is int else 0
        # M15: people's ratings of findings (review.py rate), identifiers and codes only, never who rated: for the observe station later.
        ratings += [{"round": number, **{key: text_or_none(item.get(key)) for key in ("finding", "rating", "seat", "severity", "weight", "rule")}}
                    for item in (load_dict(folder / "ratings.json").get("ratings") or []) if isinstance(item, dict)]

    first_run = build.get("tests_passing_on_first_run")
    seen_failing = build.get("tests_seen_failing_first")
    approved = next((text_or_none(decision.get("head")) for decision in reversed(decisions) if decision.get("head")), None) \
        or text_or_none(load_dict(cell.root / "review" / "decision.json").get("head"))
    product = info.get("product") if isinstance(info.get("product"), dict) else None
    record = {
        "record_version": RECORD_VERSION,
        "integration": integration_record(cell, plan, approved) if plan else None,
        "product": product_record(product) if product else None,
        "ticket_id": cell.ticket_id, "slice_id": text_or_none(info.get("slice_id")), "title": str(info.get("title") or ""),
        "risk": info.get("risk") if info.get("risk") in RISKS else None, "app_type": text_or_none(info.get("app_type")),
        "mode": info.get("mode") if info.get("mode") in MODES else None,
        "outcome": outcome, "abandon_reason": reason,
        "rounds": rounds, "first_pass": outcome == "merged" and rounds == 1,
        "verify_failures": len(failed),
        "review_rejections": sum(1 for decision in decisions if decision.get("outcome") in ("REJECTED", "ESCALATE")),
        "escalated": any(decision.get("outcome") == "ESCALATE" for decision in decisions) or info.get("stage") == "blocked",
        "human_approval": any(decision.get("human_approval") is not None for decision in decisions),
        "sent_back_by_person": sum(1 for decision in decisions if decision.get("rejected_by") == "a person"),
        "deviations": [{"type": str(d.get("type") or ""), "task": text_or_none(d.get("task")), "detail": str(d.get("detail") or "")}
                       for d in (build.get("deviations") if isinstance(build.get("deviations"), list) else []) if isinstance(d, dict)],
        "blockers": blockers,
        "notes": notes,
        "verify_findings": [str(item) for summary in failed for item in (summary.get("failures") if isinstance(summary.get("failures"), list) else [])],
        "tests_seen_failing_first": seen_failing if isinstance(seen_failing, int) else 0,
        "tests_passing_on_first_run": len(first_run) if isinstance(first_run, list) else 0,
        "created_at": text_or_none(info.get("created_at")), "closed_at": now(), "archive": archive,
    }
    if exceptions:  # optional: present only for a ticket that had one, so every other record keeps its shape (record_version stays 2)
        record["security_exceptions"] = exceptions
    if ratings:  # M15, optional the same way: present only when a person rated a finding
        record["finding_ratings"] = ratings
    if nits_dropped:  # M15, optional: nits the review station did not keep (review.nit_cap)
        record["nits_dropped"] = nits_dropped
    scanned = scan_record(decisions)
    if scanned:  # optional, the same way: present only when the scan flagged something or was switched off
        record["security_scan"] = scanned
    written = change_record_entry(info)
    if written and outcome == "merged":  # optional, the same way: present only when the merge station wrote a change record (M13)
        record["change_record"] = written
    rules = issue_rules()
    jira = (product or {}).get("jira")
    if jira is not None and rules is not None and rules.is_jira_key(jira):  # optional, the same way: the slice's Jira key (M13), checked again
        record["jira"] = jira
    return record


def change_record_entry(info: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Where the merge station's change record is, its SHA-256 and the commit that added it: identifiers only."""
    entry = info.get("change_record") if isinstance(info.get("change_record"), dict) else None
    if not entry or not isinstance(entry.get("path"), str) or not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
        return None
    commit = entry.get("commit") if isinstance(entry.get("commit"), str) and re.fullmatch(r"[0-9a-f]{40,64}", entry["commit"]) else None
    return {"path": entry["path"], "sha256": entry["sha256"], "commit": commit}


PUBLISH_TIMEOUT = 300


def publish_command(project: Path) -> Tuple[Optional[List[str]], Optional[str]]:
    """records.publish_command in .factory/config.json: a list of strings, run without a shell. {archive} is replaced by the
    archive's path and {ticket} by the ticket ID; with no {archive} the path is added as the last argument."""
    records = load_dict(project / ".factory" / "config.json").get("records")
    value = records.get("publish_command") if isinstance(records, dict) else None
    if value is None:
        return None, None
    if not isinstance(value, list) or not value or not all(isinstance(part, str) and part for part in value):
        return None, "records.publish_command in .factory/config.json must be a list of strings, such as [\"tool\", \"{archive}\"]."
    return value, None


def publish(project: Path, ticket_id: str, archive: Path) -> Optional[Dict[str, Any]]:
    """Hand the written and checked archive to the team's own command. Never raises and never blocks cleanup: what happened
    is returned for the run record. None when no command is set."""
    template, problem = publish_command(project)
    if problem:
        return {"ran": False, "ok": False, "note": problem}
    if template is None:
        return None
    path = str(archive)
    argv = [part.replace("{archive}", path).replace("{ticket}", ticket_id) if "{" in part else part for part in template]
    if not any("{archive}" in part for part in template):
        argv.append(path)
    if shutil.which(argv[0]) is None and not (project / argv[0]).is_file():
        return {"ran": False, "ok": False, "note": f"'{argv[0][:80]}' is not installed or not on PATH, so the archive was not published."}
    try:
        done = subprocess.run(argv, cwd=str(project), capture_output=True, text=True, errors="replace", timeout=PUBLISH_TIMEOUT, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return {"ran": True, "ok": False, "exit_code": None, "note": f"Still running after {PUBLISH_TIMEOUT} seconds; stopped."}
    except OSError as exc:
        return {"ran": False, "ok": False, "note": f"The command could not be started: {exc.strerror or type(exc).__name__}."}
    last = ((done.stderr or "").strip() or (done.stdout or "").strip()).splitlines()
    note = " ".join(last[-1].split())[:200] if last else ""
    rules = issue_rules()
    return {"ran": True, "ok": done.returncode == 0, "exit_code": done.returncode, "note": (rules.redact(note) if rules is not None else None) or None}


_ISSUE_RULES: List[Any] = []


def issue_rules() -> Any:
    """The ticket station's shared rules (redaction), loaded from the sibling skill folder, never copied. None if not found."""
    if not _ISSUE_RULES:
        found = None
        skills = Path(__file__).resolve().parent.parent.parent
        for name in ("mach-ticket", "ticket"):
            path = skills / name / "scripts" / "issue_rules.py"
            if path.is_file():
                try:
                    import importlib.util
                    spec = importlib.util.spec_from_file_location("mach_ticket_issue_rules", path)
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    found = module
                except Exception:  # noqa: BLE001
                    found = None
                break
        _ISSUE_RULES.append(found)
    return _ISSUE_RULES[0]


def scan_record(decisions: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Counts from the security scan of the last decided round that has one: candidates, how many were real, dependencies
    added, concerns. Counts only; the items and the reasons stay in the archived decision.json."""
    summary = next((decision.get("security_scan") for decision in reversed(decisions) if isinstance(decision.get("security_scan"), dict)), None)
    if summary is None:
        return None
    if summary.get("enabled") is False:
        return {"enabled": False}
    counts = summary.get("counts") if isinstance(summary.get("counts"), dict) else {}
    whole = {key: counts.get(key) if isinstance(counts.get(key), int) and not isinstance(counts.get(key), bool) else 0
             for key in ("secret_candidates", "real", "dependencies_added", "concerns")}
    if not any(whole.values()) and not counts.get("dependencies"):
        return None
    return dict(whole, enabled=True)


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
    tips = replan_refs(project, ticket_id)
    replans = [ref for ref, _ in tips]
    # A re-plan's old tips are held already when the default branch reaches them, or the branch bundle archived beside them does.
    replan_excludes = refs + ([f"refs/heads/{branch}"] if bundle else [])
    replan_unkept = unkept_commits(project, replans, replan_excludes)
    members = [f"{ticket_id}/{name_}" for name_ in cell.members()]
    if bundle:
        members.append(f"{ticket_id}/branch.bundle (the {unmerged} commit(s) of {branch} that are not on {name or 'any other branch'})")
    if replan_unkept:
        members.append(f"{ticket_id}/replans.bundle (the {replan_unkept} commit(s) the re-plans set aside, under {', '.join(replans)})")
    if dirty:
        members.append(f"{ticket_id}/uncommitted.patch and {ticket_id}/untracked/ (the uncommitted work)")
    lanes = lane_survey(cell, refs)  # M22: None for a ticket without lanes, which leaves everything below as before
    if lanes is not None:
        refusals += lanes["problems"]
        if lanes["unkept_commits"]:
            members.append(f"{ticket_id}/{LANES_BUNDLE} (the {lanes['unkept_commits']} commit(s) of the lane branches that are not on {name or 'any other branch'})")
        for lane in sorted(lanes["uncommitted"]):
            members.append(f"{ticket_id}/{LANES_SAVED}/{lane}/uncommitted.patch and {ticket_id}/{LANES_SAVED}/{lane}/untracked/ (lane {lane}'s uncommitted work)")
    plan = {
        "ticket_id": ticket_id, "allowed": not refusals, "refusals": refusals,
        "outcome": "abandoned" if abandoning else "merged", "abandon_reason": reason,
        "stage": stage, "isolation": cell.info.get("isolation"), "branch": branch, "default_branch": name,
        "merged": merged, "merged_into": target, "merged_as": landed, "unmerged_commits": unmerged, "uncommitted": dirty,
        "replan_refs": replans, "replan_tips": dict(tips), "replan_commits_to_bundle": replan_unkept, "replan_bundle_excludes": replan_excludes,
        "would": {
            "archive": relative(project, next_archive(project, ticket_id)), "archive_members": members,
            "remove_worktree": relative(project, cell.repo) if cell.isolated and cell.repo.exists() else None,
            "remove_folder": relative(project, cell.root),
            "bundle_branch": bundle,
            "delete_branch": f"git branch {'-D' if force else '-d'} {branch}" if cell.isolated and has_branch else None,
            "bundle_replans": replan_unkept > 0,
            "delete_replan_refs": replans,
            "append_record": f".factory/archive/{RUN_LOG}",
        },
        "never": "No merge, no push, no remote branch deleted, nothing changed on the main checkout.",
    }
    if lanes is not None:
        plan["lanes"] = lanes
        plan["would"].update({"remove_lane_worktrees": [relative(project, Path(repo)) for repo in sorted(lanes["worktrees"].values())],
                              "drop_lane_worktree_records": lanes["stale_records"],
                              "bundle_lanes": lanes["unkept_commits"] > 0, "delete_lane_branches": sorted(lanes["branches"]),
                              "save_lane_uncommitted": sorted(lanes["uncommitted"])})
    return plan


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


def bundle_replans(project: Path, refs: List[str], excludes: List[str], path: Path) -> None:
    """Save the commits a re-plan set aside (the refs under refs/mach/replan/<ticket>/) as a git bundle, and check git can read it back."""
    done = git(project, "bundle", "create", str(path), *refs, *(["--not", *excludes] if excludes else []))
    if done.returncode != 0 or not path.is_file() or path.stat().st_size == 0:
        raise CleanupError(f"git could not bundle the re-plan refs {', '.join(refs)}: {done.stderr.strip()}")
    check = git(project, "bundle", "verify", str(path))
    if check.returncode != 0:
        raise CleanupError(f"The bundle of the re-plan refs does not verify: {check.stderr.strip()}")


def write_archive(cell: Cell, target: Path, dirty: List[str], bundle_refs: Optional[List[str]] = None, merged_as: Optional[str] = None,
                  log: Optional[bytes] = None, replans: Optional[Tuple[List[str], List[str]]] = None,
                  lanes: Optional[Dict[str, Any]] = None) -> List[str]:
    """Write the archive beside the others, check it, and return its member names. On any failure nothing is left behind.

    bundle_refs, when given, are the default branch refs: the cell's branch is bundled against them and added.
    log, when given, is the cell's lifecycle log with cleanup's own closing records appended; it is archived in
    place of the file on disk, which is never changed (the cell folder is deleted next). A cell with no lifecycle
    log (made before M6.1, or by hand) is archived exactly as before, with no log added.
    replans, when given, is (the re-plan refs, the refs whose commits are held already): the commits only the
    re-plan refs reach are bundled and added as replans.bundle.
    lanes, when given, is lane_survey's answer (M22): lanes/ is archived without any lane's checked-out tree, the commits only
    the lane branches hold are added as lanes.bundle, and each lane checkout's uncommitted work under lanes-saved/<L>/.
    """
    project, prefix = cell.project, cell.ticket_id
    partial = project / ".factory" / "tmp" / f"cleanup-{target.name}.partial"
    bundle = project / ".factory" / "tmp" / f"cleanup-{target.name}.bundle"
    replan_bundle = project / ".factory" / "tmp" / f"cleanup-{target.name}.replans.bundle"
    lane_bundle = project / ".factory" / "tmp" / f"cleanup-{target.name}.lanes.bundle"
    expected = [f"{prefix}/{name}" for name in cell.members()]

    def no_lane_tree(member: tarfile.TarInfo) -> Optional[tarfile.TarInfo]:
        return None if is_lane_tree(member.name.split("/")[1:]) else member
    try:
        partial.parent.mkdir(parents=True, exist_ok=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(str(partial), "w:gz") as tar:
            for entry in sorted(cell.root.iterdir()):
                if entry.name == "cell.json" and merged_as:
                    add_bytes(tar, f"{prefix}/cell.json", (json.dumps({**cell.info, "merged_as": merged_as}, indent=2) + "\n").encode("utf-8"))
                elif entry.name == LIFECYCLE_LOG and log is not None:
                    add_bytes(tar, f"{prefix}/{LIFECYCLE_LOG}", log)
                elif entry.name == LANES:  # every lane's state files, never a lane's checked-out tree
                    tar.add(str(entry), arcname=f"{prefix}/{entry.name}", filter=no_lane_tree)
                elif entry.name != "repo":
                    tar.add(str(entry), arcname=f"{prefix}/{entry.name}")
            if bundle_refs is not None:
                bundle_branch(cell, bundle_refs, bundle)
                tar.add(str(bundle), arcname=f"{prefix}/branch.bundle")
                expected.append(f"{prefix}/branch.bundle")
            if replans is not None:
                bundle_replans(project, replans[0], replans[1], replan_bundle)
                tar.add(str(replan_bundle), arcname=f"{prefix}/replans.bundle")
                expected.append(f"{prefix}/replans.bundle")
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
            if lanes is not None and lanes["unkept_commits"]:
                bundle_lanes(project, lanes["bundle_refs"], lanes["bundle_excludes"], lane_bundle)
                tar.add(str(lane_bundle), arcname=f"{prefix}/{LANES_BUNDLE}")
                expected.append(f"{prefix}/{LANES_BUNDLE}")
            for lane in sorted((lanes or {}).get("uncommitted") or {}):
                expected += save_uncommitted(tar, Path(lanes["worktrees"][lane]), f"{prefix}/{LANES_SAVED}/{lane}")
        with tarfile.open(str(partial), "r:gz") as tar:
            names = set(tar.getnames())
        missing = [name for name in expected if name not in names]
        if partial.stat().st_size == 0 or missing or f"{prefix}/cell.json" not in names:
            raise CleanupError(f"The archive did not come out complete (missing: {', '.join(missing[:5]) or 'cell.json'}).")
        if any(name == f"{prefix}/repo" or name.startswith(f"{prefix}/repo/") for name in names):
            raise CleanupError("The archive unexpectedly contains the worktree.")
        if any(is_lane_tree(name.split("/")[1:]) for name in names):
            raise CleanupError("The archive unexpectedly contains a lane's worktree.")
        if target.exists():
            raise CleanupError(f"{target} appeared while archiving; refusing to overwrite it.")
        partial.replace(target)
    except (OSError, tarfile.TarError, CleanupError) as exc:
        if partial.exists():
            partial.unlink()
        raise CleanupError(f"Archiving failed, so nothing was deleted. {exc}", code="archive-failed")
    finally:
        for leftover in (bundle, replan_bundle, lane_bundle):
            if leftover.exists():
                leftover.unlink()
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
    replans = (plan["replan_refs"], plan["replan_bundle_excludes"]) if plan["would"]["bundle_replans"] else None
    lanes = plan.get("lanes")
    members = write_archive(cell, target, plan["uncommitted"], default_branch(project)[1] if bundled else None, plan["merged_as"], log, replans, lanes)
    # The archive is written and checked: a team that keeps its evidence elsewhere gets it now (records.publish_command, M13).
    # The outcome is recorded; a failure never stops cleanup.
    published = publish(project, cell.ticket_id, target)
    if published is not None:  # optional: present only when a publish command is set
        record["records_publish"] = published

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
    if lanes is not None:
        removed += remove_lane_worktrees(cell, lanes)
    try:
        shutil.rmtree(str(root))
    except OSError as exc:
        raise CleanupError(f"Could not remove {root}: {exc}. {kept}")
    removed.append(relative(project, root))
    lanes_done = finish_lanes(cell, lanes) if lanes is not None else None

    branch_deleted, note = False, None
    if plan["would"]["delete_branch"]:
        done = git(project, *plan["would"]["delete_branch"].split()[1:3], cell.branch)
        branch_deleted = done.returncode == 0
        if not branch_deleted:
            note = f"git kept the branch {cell.branch}: {done.stderr.strip()} Delete it yourself" + (" once the main checkout has the merge." if not abandoning else ".")

    # The archive is written and checked: only now are the re-plan refs deleted, each only if it still points where it did when planned.
    planned = plan["replan_tips"]
    replans_deleted, replan_note = [], None
    for ref in plan["would"]["delete_replan_refs"]:
        sha = planned.get(ref)
        if sha and ref.startswith(f"refs/mach/replan/{cell.ticket_id}/") and git(project, "update-ref", "-d", ref, sha).returncode == 0:
            replans_deleted.append(ref)
    kept_refs = [ref for ref in plan["would"]["delete_replan_refs"] if ref not in replans_deleted]
    if kept_refs:
        replan_note = f"git kept the re-plan refs {', '.join(kept_refs)}; their commits are in the archive. Delete them yourself with git update-ref -d."

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
        "replans_bundle": f"{cell.ticket_id}/replans.bundle" if replans else None, "replan_refs_deleted": replans_deleted, "replan_note": replan_note,
        "record": record, "run_log": relative(project, target.parent / RUN_LOG), "published": published,
        "observe_due": observe["due"], "finished_since_last_observe_pass": observe["finished_since_last_pass"],
        "next": f"Set the ticket {cell.ticket_id} to {state}, using the ticket skill."
                + (f" Then an observe pass is due ({observe['finished_since_last_pass']} tickets have finished since the last one): run the observe skill with --auto." if observe["due"] else ""),
        **({"lanes": lanes_result(cell, lanes, lanes_done, archive, plan["default_branch"])} if lanes is not None and lanes_done is not None else {}),
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
    import contextlib as _c, os as _o, runpy as _r  # MACH records an internal error for /mach report (skills/intent/scripts/faults.py)
    with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if _o.path.isfile(p)))["install"](__file__)
    sys.exit(main())
