#!/usr/bin/env python3
"""Landing: bring a ticket's finished lanes together on its branch (M22 design, sections 8, 9 and 14 C2).

Each lane built some of the plan's tasks in its own sparse worktree, on its own branch, from one fork point, with one
commit per task. Landing copies those commits onto the ticket's branch so that the history looks exactly like a
sequential build's: one commit per task, in plan order, with the same messages and content, and no merge commit. The
build station's `own_changes` reads any merge commit as main having been merged in and would then lose every lane's
files, and review and the change record read the history task by task; so the lanes are joined by cherry-pick, never
by merge, and without `-x` (a "cherry picked from" line would name a commit that is removed afterwards).

    overlaps(repo, fork, lanes, test_files)       which later lanes must be set aside (read-only)
    land(project, join_repo, branch, fork, commits_in_order)
                                                  cherry-pick into a separate join worktree; patch IDs checked
    fast_forward(cell_repo, tip)                  move the ticket's branch, in one step, to the landed tip
    remove(project, folders, branches)            remove worktrees and lane branches; says what it could not
    join_lanes(...)                               all of the above in the order of section 8.1, with the suite run

Nothing is half-landed. The join happens in its own worktree on its own branch; the ticket's branch is fast-forwarded
only after every commit landed with the patch ID of its lane commit and the whole suite passed on the landed tip. If
anything fails, the ticket's branch is where it was. A join stopped at any point can be run again: it starts over from
the fork point in a fresh join worktree (discarding only an earlier attempt's copies of lane commits), and if the
ticket's branch was already moved it recognises the landed commits and finishes, so no commit is ever landed twice.

When the plan's independence was false (two lanes changed one file, a lane changed a test file another lane holds, two
lanes' file names differ only by letter case, or one lane's file is another's folder), the later lane in plan order is set
aside, never the earlier; nothing of it lands, and the result says which lane, which file, which earlier lane and why, so
the station can have its tasks built again in the cell. A lane is set aside the same way, never a reason to stop, when its
commits are not one chain from the fork point, when its branch holds commits no task recorded, when one of its commits does
not apply on the landed work, or when a commit made on the ticket's branch while the lanes were open changed its files. A
set-aside lane's tip is kept under a ref the station names before its branch is removed. A ticket's branch that moved while
the lanes were open is never undone: the lanes land on its head. When every
lane passed but the joined suite fails, landing does not guess: it reports the suite's output, the failing tests, the
lanes whose files they name and the files a fix may change, and leaves the ticket's branch where it was.

This module emits no telemetry and decides nothing about tasks beyond what it is given: the build station turns the
facts it returns into state, the report and the `build.join` gate event. Standard library only; Python 3.8.
"""

import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

# A ticket's workspace (the sparse worktree that never holds .claude/ or .mcp.json): shared with the intent station.
try:
    _SKILL = Path(__file__).resolve().parent.parent
    sys.path.append(str(_SKILL.parent / ("mach-intent" if _SKILL.name.startswith("mach-") else "intent") / "scripts"))
    import workspace  # noqa: E402
except Exception:  # noqa: BLE001
    workspace = None

LANE_BRANCH_PREFIX = "mach-lane/"
SAME_FILE = "same-file"
FROZEN_TEST = "frozen-test"
CASE_CLASH = "case-clash"  # two lanes' file names differ only by letter case
FILE_FOLDER = "file-folder"  # one lane's file is another lane's folder
BRANCH_MOVED = "branch-moved"  # a commit made on the ticket's branch while the lanes were open changed the lane's file
DID_NOT_APPLY = "did-not-apply"  # a lane commit did not apply on the landed work, or did not land as exactly itself
UNRECORDED = "unrecorded-commits"  # the lane's branch holds commits no task recorded
LANE_HISTORY = "lane-history"  # the lane's recorded commits are not one chain from the fork point
# Files that running a build or a test suite leaves behind (build.py's BYPRODUCT_RE): never work that has not landed.
BYPRODUCT_RE = re.compile(
    r"(^|/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|htmlcov|\.hypothesis|node_modules|\.gradle|\.next|\.turbo|coverage)(/|$)"
    r"|\.py[co]$|(^|/)\.coverage(\..*)?$|(^|/)\.DS_Store$|\.egg-info(/|$)|\.tsbuildinfo$"
)
SHA_RE = re.compile(r"^[0-9a-f]{7,64}$")
# Failing tests as unittest and pytest name them.
UNITTEST_FAIL_RE = re.compile(r"^(?:FAIL|ERROR): (\S+) \(([\w.]+)\)", re.M)
PYTEST_FAIL_RE = re.compile(r"^(?:FAILED|ERROR) ([\w./-]+\.py)(?:::(\S+))?", re.M)

Runner = Callable[..., subprocess.CompletedProcess]


class LandingError(Exception):
    """Landing stopped. `code` names why; `commit` is the lane commit that did not apply, when one did not; `left` lists
    what could not be removed afterwards (empty when everything landing made was removed)."""

    def __init__(self, message: str, code: str = "landing-failed", commit: Optional[str] = None,
                 left: Optional[List[str]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.commit = commit
        self.left = list(left or [])


def run_git(args: Sequence[str], cwd: Path, env: Optional[Dict[str, str]] = None,
            input: Optional[str] = None) -> subprocess.CompletedProcess:  # noqa: A002 - subprocess's own name
    """Run one Git command and capture what it says. Never prompts."""
    environment = dict(os.environ if env is None else env)
    environment["GIT_TERMINAL_PROMPT"] = "0"
    environment.setdefault("GIT_EDITOR", "true")
    try:
        return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, env=environment,
                              input=input, stdin=None if input is not None else subprocess.DEVNULL)
    except OSError as exc:
        return subprocess.CompletedProcess(["git", *args], 127, "", str(exc))


def _said(done: subprocess.CompletedProcess) -> str:
    lines = [line.strip() for line in (done.stderr or done.stdout or "").splitlines() if line.strip()]
    errors = [line for line in lines if line.lower().startswith(("fatal:", "error:"))]
    return (" ".join(errors or lines))[:600] or f"exit status {done.returncode}"


def _ok(git: Runner, args: Sequence[str], cwd: Path, code: str, what: str, **kwargs: Any) -> str:
    done = git(args, cwd, **kwargs)
    if done.returncode != 0:
        raise LandingError(f"{what}: Git said: {_said(done)}", code=code)
    return done.stdout


def _commit(git: Runner, repo: Path, rev: str) -> str:
    """The full ID of an existing commit, or LandingError."""
    if not rev or rev.startswith("-"):
        raise LandingError(f"'{rev}' is not a commit.", code="unknown-commit", commit=rev or None)
    done = git(["rev-parse", "--verify", "-q", rev + "^{commit}"], repo)
    sha = done.stdout.strip()
    if done.returncode != 0 or not SHA_RE.match(sha):
        raise LandingError(f"{rev} is not a commit in this repository.", code="unknown-commit", commit=rev)
    return sha


def _parents(git: Runner, repo: Path, sha: str) -> List[str]:
    return _ok(git, ["rev-list", "--parents", "-n", "1", sha], repo, "git-failed", f"Git could not read {sha[:10]}").split()[1:]


def changed_by(git: Runner, repo: Path, sha: str) -> List[str]:
    """The files one non-merge commit changed, renames read as a deletion and an addition (both paths count)."""
    out = _ok(git, ["diff-tree", "-r", "-z", "--no-commit-id", "--name-only", "--no-renames", "--root", sha], repo,
              "git-failed", f"Git could not list the files of {sha[:10]}")
    return sorted({name for name in out.split("\0") if name})


def patch_id(repo: Path, sha: str, git: Optional[Runner] = None) -> Optional[str]:
    """Git's stable patch ID of one commit's change (None for a commit that changes nothing)."""
    git = git or run_git
    diff = _ok(git, ["diff-tree", "-p", "--binary", "--no-color", "--no-ext-diff", "--full-index", "--no-renames", "--root", sha],
               repo, "git-failed", f"Git could not read the change of {sha[:10]}")
    if not diff.strip():
        return None
    out = _ok(git, ["patch-id", "--stable"], repo, "git-failed", f"Git could not compute the patch ID of {sha[:10]}", input=diff)
    return out.split()[0] if out.split() else None


def set_aside_files(repo: Path, paths: List[str], ref: str, message: str, *, git: Optional[Runner] = None) -> Dict[str, Any]:
    """Save a worktree's uncommitted files (tracked changes and untracked files, among `paths`) as one commit on top of its HEAD, kept under
    `ref`, then return the worktree to its HEAD for those paths. Done as the intent station's re-plan saves a cell's files
    (cell.py save_uncommitted): through a separate index, so the worktree's own index is not touched while saving. Nothing is lost: the ref
    keeps every file, and `git checkout <ref> -- <path>` in any worktree of the repository brings one back. Returns {"commit", "ref",
    "paths"}; raises LandingError with nothing changed when the files could not be saved."""
    git = git or run_git
    head = _commit(git, repo, "HEAD")
    index = Path(_ok(git, ["rev-parse", "--git-path", "index"], repo, "set-aside-failed", "Git could not find the worktree's index").strip())
    index = index if index.is_absolute() else repo / index
    scratch = index.with_name(index.name + ".mach-lane")
    env = dict(os.environ, GIT_INDEX_FILE=str(scratch))
    if git(["var", "GIT_COMMITTER_IDENT"], repo).returncode != 0:
        env.update({"GIT_AUTHOR_NAME": "MACH", "GIT_AUTHOR_EMAIL": "mach@localhost", "GIT_COMMITTER_NAME": "MACH", "GIT_COMMITTER_EMAIL": "mach@localhost"})
    try:
        if index.is_file():
            shutil.copyfile(str(index), str(scratch))
        _ok(git, ["add", "-A", "--sparse", "--", *paths], repo, "set-aside-failed", "Git could not take the uncommitted files", env=env)
        tree = _ok(git, ["write-tree"], repo, "set-aside-failed", "Git could not record the uncommitted files", env=env).strip()
        commit = _ok(git, ["commit-tree", tree, "-p", head, "-m", message], repo, "set-aside-failed", "Git could not save the uncommitted files",
                     env=env).strip()
    finally:
        if scratch.exists():
            scratch.unlink()
    _ok(git, ["update-ref", ref, commit], repo, "set-aside-failed", f"Git could not keep the saved files as {ref}")
    # Saved: now the worktree is put back to its HEAD for those paths, so the lane holds only what its tasks committed.
    git(["reset", "-q", "--", *paths], repo)  # anything staged goes back to HEAD's entry, or out of the index
    tracked = [name for name in paths if git(["cat-file", "-e", f"HEAD:{name}"], repo).returncode == 0]
    if tracked:
        git(["checkout", "-q", "HEAD", "--", *tracked], repo)
    for name in paths:
        if name in tracked:
            continue
        target = repo / name
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.is_dir():
            shutil.rmtree(str(target), ignore_errors=True)
    return {"commit": commit, "ref": ref, "paths": sorted(paths)}


def _subject_and_body(git: Runner, repo: Path, sha: str) -> str:
    return _ok(git, ["log", "-1", "--format=%B", sha], repo, "git-failed", f"Git could not read {sha[:10]}'s message")


# ---------------------------------------------------------------- 8.1 step 1: check, change nothing

def overlaps(repo: Path, fork: str, lanes: Dict[str, List[str]], test_files: Dict[str, List[str]],
             *, git: Optional[Runner] = None) -> List[Dict[str, Any]]:
    """Which lanes broke the plan's independence, read-only.

    `lanes` maps each lane to its commits, in plan order (the dict's order is the lanes' plan order: L1, L2, ... by the
    plan position of each lane's first task). `test_files` maps each lane to the test files it holds frozen: those the
    lane plan gives its [test] tasks and those it committed. Each lane is compared with every earlier lane that is kept:
    a file both changed is `same-file`; a file one changed that is the other's test file is `frozen-test`. The later lane
    is the one set aside, never the earlier, and a lane already set aside is not compared again (its work does not land).

    Returns one entry per lane set aside and file: {"lane": later, "other": earlier, "file": path, "why": ...}.
    """
    git = git or run_git
    fork = _commit(git, repo, fork)
    changed: Dict[str, Set[str]] = {}
    for lane, commits in lanes.items():
        files: Set[str] = set()
        for rev in commits:
            sha = _commit(git, repo, rev)
            if len(_parents(git, repo, sha)) > 1:
                raise LandingError(f"Lane {lane}'s commit {sha[:10]} is a merge commit; a lane holds one commit per task, never a merge.",
                                   code="lane-merge-commit", commit=sha)
            files.update(changed_by(git, repo, sha))
        changed[lane] = files
    # A lane's own test files: those it changed, and those the plan gives it that were not at the fork point. A test file
    # every lane inherited from the fork point and this lane left alone is nobody's in particular.
    held: Dict[str, Set[str]] = {}
    for lane in lanes:
        held[lane] = {name for name in test_files.get(lane) or []
                      if name in changed[lane] or git(["cat-file", "-e", f"{fork}:{name}"], repo).returncode != 0}
    found: List[Dict[str, Any]] = []
    kept: List[str] = []
    for lane in lanes:
        own_tests = held[lane]
        clashes: List[Dict[str, Any]] = []
        for other in kept:
            other_tests = held[other]
            for name in sorted((changed[lane] & changed[other]) | (changed[lane] & other_tests) | (changed[other] & own_tests)):
                why = FROZEN_TEST if name in own_tests or name in other_tests else SAME_FILE
                clashes.append({"lane": lane, "other": other, "file": name, "why": why})
            for name, why in unrepresentable(changed[lane], changed[other]):
                clashes.append({"lane": lane, "other": other, "file": name, "why": why})
        if clashes:
            found.extend(clashes)
        else:
            kept.append(lane)
    return found


def unrepresentable(mine: Set[str], theirs: Set[str]) -> List[Tuple[str, str]]:
    """Clashes Git can hold but a checkout cannot, between two sets of changed files: two names that differ only by letter
    case (one file on a case-insensitive disk), and a file of one set that is a folder of the other. Each as (path, why)."""
    found: List[Tuple[str, str]] = []
    folded: Dict[str, Set[str]] = {}
    for name in theirs:
        folded.setdefault(name.lower(), set()).add(name)
    for name in sorted(mine):
        if any(other != name for other in folded.get(name.lower(), ())):
            found.append((name, CASE_CLASH))
    def folders(names: Set[str]) -> Set[str]:
        return {"/".join(name.split("/")[:index]) for name in names for index in range(1, name.count("/") + 1)}
    for name in sorted((mine & folders(theirs)) | (theirs & folders(mine))):
        found.append((name, FILE_FOLDER))
    return found


# ---------------------------------------------------------------- 8.1 step 2: land in its own worktree

def _worktrees(git: Runner, project: Path) -> Dict[str, Optional[str]]:
    """Registered worktrees: path -> the branch it has checked out (None when detached)."""
    found: Dict[str, Optional[str]] = {}
    path: Optional[str] = None
    for line in git(["worktree", "list", "--porcelain"], project).stdout.splitlines():
        if line.startswith("worktree "):
            path = line[len("worktree "):]
            found[path] = None
        elif line.startswith("branch ") and path is not None:
            found[path] = line[len("branch "):].replace("refs/heads/", "", 1)
    return found


def _registered_as(git: Runner, project: Path, folder: Path) -> Tuple[bool, Optional[str]]:
    listed = _worktrees(git, project)
    for candidate in {str(folder), str(folder.resolve()) if folder.exists() else str(folder)}:
        if candidate in listed:
            return True, listed[candidate]
    return False, None


def _branch_exists(git: Runner, project: Path, branch: str) -> bool:
    return git(["show-ref", "--verify", "-q", f"refs/heads/{branch}"], project).returncode == 0


def _drop_worktree(git: Runner, project: Path, folder: Path) -> Optional[str]:
    """Remove one worktree folder and Git's record of it. Returns what could not be removed, or None."""
    registered, _ = _registered_as(git, project, folder)
    if registered:
        done = git(["worktree", "remove", "--force", "--force", str(folder)], project)
        if done.returncode != 0 and _registered_as(git, project, folder)[0] and folder.exists():
            return f"the worktree {folder} ({_said(done)})"
    if folder.exists():
        shutil.rmtree(str(folder), ignore_errors=True)
    git(["worktree", "prune"], project)
    if folder.exists():
        return f"the folder {folder}"
    if _registered_as(git, project, folder)[0]:
        return f"Git's record of the worktree {folder}"
    return None


def _clear_earlier_join(git: Runner, project: Path, join_repo: Path, branch: str, fork: str, lane_patches: Set[Optional[str]]) -> None:
    """An earlier join that stopped part way left its worktree or branch: discard them, but only when they hold nothing
    but copies of lane commits on the fork point. Anything else is for a person."""
    git(["worktree", "prune"], project)
    registered, on = _registered_as(git, project, join_repo)
    if registered and on not in (None, branch):
        raise LandingError(f"{join_repo} is a worktree on {on}, not on the join branch {branch}. Nothing was changed; a person must look at it.",
                           code="join-worktree-foreign")
    if _branch_exists(git, project, branch):
        if git(["merge-base", "--is-ancestor", fork, branch], project).returncode != 0:
            raise LandingError(f"The join branch {branch} exists and does not start at the fork point {fork[:10]}. Nothing was changed; "
                               "a person must look at it.", code="join-branch-foreign")
        extra = [sha for sha in _ok(git, ["rev-list", f"{fork}..{branch}"], project, "git-failed", "Git could not read the join branch").split()
                 if len(_parents(git, project, sha)) > 1 or patch_id(project, sha, git) not in lane_patches]
        if extra:
            raise LandingError(f"The join branch {branch} holds commits that are not copies of lane commits ({', '.join(s[:10] for s in extra[:5])}). "
                               "Nothing was changed; a person must look at them.", code="join-branch-foreign")
    if registered or join_repo.exists():
        left = _drop_worktree(git, project, join_repo)
        if left:
            raise LandingError(f"An earlier join's worktree could not be removed: {left}. Nothing was landed.", code="join-worktree-stuck", left=[left])
    if _branch_exists(git, project, branch):
        done = git(["branch", "-D", branch], project)
        if done.returncode != 0:
            raise LandingError(f"An earlier join's branch {branch} could not be removed: {_said(done)}. Nothing was landed.",
                               code="join-branch-stuck", left=[f"the branch {branch}"])


def land(project: Path, join_repo: Path, branch: str, fork: str, commits_in_order: List[str],
         *, git: Optional[Runner] = None) -> Dict[str, Any]:
    """Make the join worktree at `join_repo` on a new `branch` at `fork` (the sparse way, through workspace.create) and
    cherry-pick every commit of `commits_in_order` there, one by one, in that order. Each landed commit must carry the
    patch ID of its lane commit. An earlier attempt's join worktree and branch are discarded first (see
    _clear_earlier_join), so landing again never lands a commit twice.

    Returns {"landed": [{"lane_commit", "commit", "patch_id"}], "tip": sha}; the worktree and branch stay for the suite
    run. On any failure raises LandingError (naming the commit that did not apply, when one did not) after removing the
    worktree and branch it made. Nothing outside the join worktree and branch is touched."""
    git = git or run_git
    if not branch.startswith(LANE_BRANCH_PREFIX):
        raise LandingError(f"The join branch must be under {LANE_BRANCH_PREFIX}, not {branch}.", code="join-branch-name")
    fork = _commit(git, project, fork)
    commits = [_commit(git, project, rev) for rev in commits_in_order]
    if len(set(commits)) != len(commits):
        raise LandingError("A lane commit is listed twice; each task's commit lands once.", code="commit-listed-twice")
    expected: List[Tuple[str, Optional[str]]] = []
    for sha in commits:
        if len(_parents(git, project, sha)) != 1:
            raise LandingError(f"{sha[:10]} is not a single-parent commit; a lane holds one commit per task, never a merge.",
                               code="lane-merge-commit", commit=sha)
        expected.append((sha, patch_id(project, sha, git)))
    _clear_earlier_join(git, project, join_repo, branch, fork, {pid for _, pid in expected})
    if workspace is None:
        raise LandingError("The intent station's workspace.py is not installed beside this skill, so the join worktree cannot be made.",
                           code="workspace-missing")
    done = git(["branch", branch, fork], project)
    if done.returncode != 0:
        raise LandingError(f"Git could not make the join branch {branch}: {_said(done)}", code="join-branch-failed")
    try:
        workspace.create(project, join_repo, branch)
    except workspace.WorkspaceError as exc:
        left = _undo_join(git, project, join_repo, branch)
        raise LandingError(f"The join worktree could not be made. {exc}", code="join-worktree-failed", left=left)
    landed: List[Dict[str, Any]] = []
    try:
        for sha, expected_patch in expected:
            picked = git(["cherry-pick", "--allow-empty", "--no-rerere-autoupdate", sha], join_repo)
            if picked.returncode != 0:
                git(["cherry-pick", "--abort"], join_repo)
                raise LandingError(f"The lane commit {sha[:10]} did not apply on the landed work: Git said: {_said(picked)}. The lanes were "
                                   "planned to change separate files, so this needs a person. The ticket's branch was not changed.",
                                   code="cherry-pick-failed", commit=sha)
            new = _ok(git, ["rev-parse", "HEAD"], join_repo, "git-failed", "Git could not read the landed commit").strip()
            if _parents(git, join_repo, new) != [landed[-1]["commit"] if landed else fork]:
                raise LandingError(f"Landing {sha[:10]} did not make one new commit on the landed work.", code="landing-history", commit=sha)
            got_patch = patch_id(join_repo, new, git)
            if got_patch != expected_patch or _subject_and_body(git, join_repo, new) != _subject_and_body(git, join_repo, sha):
                raise LandingError(f"The landed copy of {sha[:10]} ({new[:10]}) does not carry exactly its change and message, so lines no gate "
                                   "scanned could enter. Nothing was landed on the ticket's branch.", code="patch-id-mismatch", commit=sha)
            landed.append({"lane_commit": sha, "commit": new, "patch_id": got_patch})
        tip = _ok(git, ["rev-parse", "HEAD"], join_repo, "git-failed", "Git could not read the landed tip").strip()
    except LandingError as exc:
        exc.left = _undo_join(git, project, join_repo, branch)
        raise
    return {"landed": landed, "tip": tip}


def _undo_join(git: Runner, project: Path, join_repo: Path, branch: str) -> List[str]:
    left: List[str] = []
    problem = _drop_worktree(git, project, join_repo)
    if problem:
        left.append(problem)
    if _branch_exists(git, project, branch):
        done = git(["branch", "-D", branch], project)
        if done.returncode != 0:
            left.append(f"the branch {branch} ({_said(done)})")
    return left


# ---------------------------------------------------------------- 8.1 step 4: move the ticket's branch

def _dirty(git: Runner, repo: Path, untracked: bool) -> List[str]:
    out = git(["status", "--porcelain", "-z", "--untracked-files=" + ("all" if untracked else "no")], repo).stdout
    names = []
    entries = out.split("\0")
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if len(entry) < 4:
            continue
        if entry[0] in "RC":  # a rename's source follows as its own entry
            index += 1
        names.append(entry[3:])
    return sorted(name for name in set(names) if not BYPRODUCT_RE.search(name))


def fast_forward(cell_repo: Path, tip: str, *, git: Optional[Runner] = None) -> None:
    """Move the branch checked out in the cell's own checkout to `tip`, in one step (`git merge --ff-only`). Does nothing
    when it is already there; raises LandingError, changing nothing, when the checkout has uncommitted changes to
    tracked files or the branch is not an ancestor of `tip`."""
    git = git or run_git
    tip = _commit(git, cell_repo, tip)
    head = _commit(git, cell_repo, "HEAD")
    if head == tip:
        return
    dirty = _dirty(git, cell_repo, untracked=False)
    if dirty:
        raise LandingError(f"The cell's checkout has uncommitted changes ({', '.join(dirty[:5])}), so its branch was not moved.", code="cell-dirty")
    if git(["merge-base", "--is-ancestor", head, tip], cell_repo).returncode != 0:
        raise LandingError(f"The ticket's branch ({head[:10]}) is not behind the landed tip {tip[:10]}, so it cannot be fast-forwarded. "
                           "It was not changed.", code="not-fast-forward")
    done = git(["merge", "--ff-only", "-q", tip], cell_repo)
    if done.returncode != 0:
        raise LandingError(f"Git could not fast-forward the ticket's branch to {tip[:10]}: {_said(done)}", code="fast-forward-failed")
    if _commit(git, cell_repo, "HEAD") != tip:
        raise LandingError(f"After the fast-forward the ticket's branch is not at {tip[:10]}.", code="fast-forward-failed")


# ---------------------------------------------------------------- cleanup

def remove(project: Path, folders: List[Path], branches: List[str], *, landed_on: Optional[str] = None,
           git: Optional[Runner] = None) -> List[str]:
    """Remove lane and join worktrees (each folder and Git's record of it) and lane branches. Returns what could not be
    removed, each with why; an empty list means everything named is gone.

    Only folders under `<project>/.factory/worktrees/` and branches under `mach-lane/` are ever removed. With
    `landed_on` (a commit, normally the ticket's new tip) nothing that holds work that has not landed is removed: a
    worktree with uncommitted changes (build and test byproducts aside), or a branch with a commit whose change has no
    equivalent on `landed_on` (by patch ID). Without it, what is named is removed as it is (a set-aside lane)."""
    git = git or run_git
    left: List[str] = []
    area = (project / ".factory" / "worktrees").resolve()
    guard = _commit(git, project, landed_on) if landed_on else None
    for folder in folders:
        folder = Path(folder)
        resolved = folder.resolve() if folder.exists() else folder.parent.resolve() / folder.name
        if area not in resolved.parents:
            left.append(f"the folder {folder} (not inside {area}, so it is never removed here)")
            continue
        if not folder.exists() and not _registered_as(git, project, folder)[0]:
            continue
        if guard and folder.exists() and (folder / ".git").exists():
            dirty = _dirty(git, folder, untracked=True)
            if dirty:
                left.append(f"the worktree {folder} (uncommitted work that has not landed: {', '.join(dirty[:5])})")
                continue
        problem = _drop_worktree(git, project, folder)
        if problem:
            left.append(problem)
    for branch in branches:
        if not branch.startswith(LANE_BRANCH_PREFIX):
            left.append(f"the branch {branch} (not under {LANE_BRANCH_PREFIX}, so it is never removed here)")
            continue
        if not _branch_exists(git, project, branch):
            continue
        if guard:
            cherry = git(["cherry", guard, f"refs/heads/{branch}"], project)
            unlanded = [line.split()[1] for line in cherry.stdout.splitlines() if line.startswith("+ ")]
            if cherry.returncode != 0 or unlanded:
                why = _said(cherry) if cherry.returncode != 0 else "commits that have not landed: " + ", ".join(s[:10] for s in unlanded[:5])
                left.append(f"the branch {branch} ({why})")
                continue
        done = git(["branch", "-D", branch], project)
        if done.returncode != 0:
            left.append(f"the branch {branch} ({_said(done)})")
    return left


# ---------------------------------------------------------------- the whole join, section 8.1

def already_landed(cell_repo: Path, fork: str, commits_in_order: List[str], *, git: Optional[Runner] = None) -> Optional[Dict[str, Any]]:
    """When the ticket's branch was already fast-forwarded by an earlier join that stopped before it finished: its last
    commits are one copy of each lane commit, in order (same change and message, one parent each), on the fork point or on
    a commit after it (an earlier join that landed on a branch that had moved). Returns {"landed", "base"}, else None."""
    git = git or run_git
    if not commits_in_order:
        return None
    since = list(reversed(_ok(git, ["rev-list", "--first-parent", "-n", str(len(commits_in_order)), "HEAD"], cell_repo, "git-failed",
                              "Git could not read the ticket's branch").split()))
    if len(since) != len(commits_in_order):
        return None
    first = _parents(git, cell_repo, since[0])
    if len(first) != 1:
        return None
    base = previous = first[0]
    if fork and base != _commit(git, cell_repo, fork) and git(["merge-base", "--is-ancestor", fork, base], cell_repo).returncode != 0:
        return None
    landed = []
    for new, rev in zip(since, commits_in_order):
        sha = _commit(git, cell_repo, rev)
        if _parents(git, cell_repo, new) != [previous]:
            return None
        pid = patch_id(cell_repo, new, git)
        if pid != patch_id(cell_repo, sha, git) or _subject_and_body(git, cell_repo, new) != _subject_and_body(git, cell_repo, sha):
            return None
        landed.append({"lane_commit": sha, "commit": new, "patch_id": pid})
        previous = new
    return {"landed": landed, "base": base}


def trailing_copies(cell_repo: Path, commits: List[str], *, git: Optional[Runner] = None) -> int:
    """How many of the branch's last commits are copies of lane commits (same change and message): what an earlier join
    landed on top of a branch that had moved. Only the commits below them are the ones made on the branch some other way."""
    git = git or run_git
    wanted = {(patch_id(cell_repo, sha, git), _subject_and_body(git, cell_repo, sha)) for sha in commits}
    count, rev = 0, "HEAD"
    while count < len(commits):
        sha = git(["rev-parse", "--verify", "-q", rev + "^{commit}"], cell_repo).stdout.strip()
        if not sha or len(_parents(git, cell_repo, sha)) != 1 \
                or (patch_id(cell_repo, sha, git), _subject_and_body(git, cell_repo, sha)) not in wanted:
            break
        count += 1
        rev = sha + "^"
    return count


def failing_tests(output: str) -> List[str]:
    """The failing tests a unittest or pytest run names, as it names them."""
    # unittest names a test "test_x (module.Class)" before Python 3.11 and "test_x (module.Class.test_x)" from it.
    found = [module if module.endswith("." + name) else f"{module}.{name}" for name, module in UNITTEST_FAIL_RE.findall(output or "")]
    found += [f"{path}::{name}" if name else path for path, name in PYTEST_FAIL_RE.findall(output or "")]
    return list(dict.fromkeys(found))


def _named_in(name: str, haystack: str) -> bool:
    stem = name[:-3] if name.endswith(".py") else name
    dotted = stem.replace("/", ".")
    if name in haystack or (dotted != stem and dotted in haystack) or (dotted == stem and re.search(r"(?<![\w.])" + re.escape(stem) + r"(?![\w])", haystack) is not None):
        return True
    # A test module run from inside its folder (`unittest discover -s tests`, or pytest's rootdir in it) is named without
    # the folder: tests/test_x.py fails as "test_x.T.test_a". Match the module by the end of its dotted path, only for a test
    # module's name, so that an ordinary word in the output never names a lane's file.
    parts = dotted.split(".")
    if not name.endswith(".py") or not (parts[-1].startswith("test") or parts[-1].endswith("_test")):
        return False
    for index in range(1, len(parts)):
        suffix = ".".join(parts[index:])
        if re.search(r"(?<![\w.])" + re.escape(suffix) + r"(?=\.|::|\s|$)", haystack, re.M):
            return True
    return False


def join_lanes(project: Path, cell_repo: Path, join_repo: Path, join_branch: str, fork: str,
               tasks: Sequence[Dict[str, Any]], test_files: Dict[str, List[str]],
               run_suite: Callable[[Path], Dict[str, Any]],
               *, lane_folders: Optional[Dict[str, Path]] = None, lane_branches: Optional[Dict[str, str]] = None,
               move_on_red: bool = False, keep_ref: Optional[Callable[[str], str]] = None, git: Optional[Runner] = None,
               clock: Callable[[], float] = time.monotonic) -> Dict[str, Any]:
    """Bring the lanes together, section 8.1: check, land in the join worktree, run the whole suite there, move the
    ticket's branch, clean up.

    `tasks`: every lanes-part task in plan order, {"task": "T03", "lane": "L1", "lane_commit": sha or None (a task done
    without a commit)}. The lanes' plan order is the order of their first task. `test_files`: each lane's frozen test
    files. `run_suite(folder)` runs the whole test suite in `folder` and returns at least {"passed", "exit_code",
    "seconds", "output_tail"} (and "command"). `lane_folders` and `lane_branches`: each lane's worktree and branch,
    checked (a lane branch must end at its last listed commit) and removed after a finished landing.

    A lane that cannot land as it is never stops the join: it is set aside, its tasks to be built again in the cell one at a
    time, and its work is kept. A lane is set aside when it clashes with an earlier lane (the same file, a test file of the
    other, two file names that differ only by letter case, a file that is the other's folder), when its recorded commits
    are not one chain from the fork point or its branch holds commits no task recorded, when a commit made on the ticket's
    branch while the lanes were open changed one of its files, or when one of its commits does not apply on the landed work.
    `keep_ref(lane)` names a ref of the station's own under which a set-aside lane's tip is kept before its branch is
    removed (`kept_as` in the result); without it, or when the ref cannot be made, the lane's branch is kept instead.

    A ticket's branch that moved while the lanes were open (a person committed in the cell) is not undone: the lanes land on
    its head, and `moved_branch` names the commits and files that were there.

    `move_on_red`: False (the default) leaves the ticket's branch where it was when the joined suite fails, and keeps the
    join worktree for the fix; True moves it to the landed tip anyway, as the design's section 8.3 words it.

    Returns a result (see the module's tests for each shape) with "status" one of JOINED, INTERACTION, REFUSED. A
    LandingError never escapes: a refusal is a result, with the ticket's branch unchanged."""
    git = git or run_git
    lane_folders = dict(lane_folders or {})
    lane_branches = dict(lane_branches or {})
    tasks = [dict(item, lane=str(item.get("lane") or ""), task=str(item.get("task") or "")) for item in tasks]
    order: List[str] = []
    by_lane: Dict[str, List[str]] = {}
    for item in tasks:
        lane = str(item.get("lane") or "")
        if lane not in by_lane:
            order.append(lane)
            by_lane[lane] = []
        if item.get("lane_commit"):
            by_lane[lane].append(str(item["lane_commit"]))
    seconds: Dict[str, float] = {}
    result: Dict[str, Any] = {"status": "REFUSED", "fork": fork, "base": None, "tip": None, "branch_moved": False, "ticket_head": None,
                              "lanes": order, "landed": [], "set_aside": [], "tasks_without_commit": [], "suite": None,
                              "interaction": None, "refused": None, "resumed": False, "moved_branch": None, "removed": [], "left": [],
                              "seconds": seconds}
    aside: Dict[str, Dict[str, Any]] = {}
    tips: Dict[str, Optional[str]] = {}  # each lane's branch tip, where it has a branch

    def refuse(code: str, reason: str, commit: Optional[str] = None, left: Optional[List[str]] = None) -> Dict[str, Any]:
        result.update({"status": "REFUSED", "refused": {"code": code, "reason": reason, "commit": commit}, "set_aside": []})
        result["left"] = list(left or []) + result["left"]
        head = git(["rev-parse", "HEAD"], cell_repo)
        result["ticket_head"] = head.stdout.strip() if head.returncode == 0 else None
        return result

    def timed(name: str, started: float) -> None:
        seconds[name] = round(clock() - started, 1)

    def set_aside(lane: str, because: List[Dict[str, Any]]) -> None:
        if lane in aside:
            aside[lane]["because"] += because
            return
        aside[lane] = {"lane": lane, "tasks": [str(t.get("task")) for t in tasks if t.get("lane") == lane],
                       "lane_commits": list(by_lane[lane]), "because": because}

    def kept() -> List[str]:
        return [lane for lane in order if lane not in aside]

    try:
        fork = _commit(git, project, fork)
        result["fork"] = fork
        if len(order) < 2 or "" in order:
            return refuse("one-lane", "Lanes are joined only when two or more were opened and every task names its lane; "
                                      "with one lane the build stays in order in the cell, and there is nothing to land.")
        started = clock()
        # Each lane's commits must be a chain from the fork point, in its tasks' order, with nothing else on its branch. A lane that
        # is not is set aside (its work kept), never a reason to stop: its tasks are built again in the cell.
        for lane in order:
            previous: Optional[str] = fork
            problem: Optional[Dict[str, Any]] = None
            for rev in by_lane[lane]:
                done = git(["rev-parse", "--verify", "-q", rev + "^{commit}"], project)
                sha = done.stdout.strip()
                if done.returncode != 0 or not SHA_RE.match(sha):
                    problem = {"why": LANE_HISTORY, "commit": rev, "detail": f"{rev[:10]} is not a commit in this repository"}
                    break
                if _parents(git, project, sha) != [previous]:
                    problem = {"why": LANE_HISTORY, "commit": sha, "detail": f"{sha[:10]} does not follow {str(previous)[:10]}"}
                    break
                previous = sha
            branch = lane_branches.get(lane)
            tip = git(["rev-parse", "--verify", "-q", f"refs/heads/{branch}"], project).stdout.strip() if branch else ""
            tips[lane] = tip or None
            if problem is None and tip and tip != previous:
                unrecorded = git(["rev-list", f"{previous}..{tip}"], project).stdout.split()
                problem = {"why": UNRECORDED, "commits": unrecorded,
                           "detail": f"its branch {branch} is at {tip[:10]}, not at its last task's commit {str(previous)[:10]}"}
            if problem is not None:
                set_aside(lane, [problem])
        timed("check", started)

        head = _commit(git, cell_repo, "HEAD")
        if _dirty(git, cell_repo, untracked=False):
            return refuse("cell-dirty", "The cell's own checkout has uncommitted changes to tracked files, so nothing was landed.")

        def landing_order() -> List[str]:
            clashes = overlaps(project, fork, {lane: by_lane[lane] for lane in kept()}, test_files, git=git)
            for item in clashes:
                set_aside(item["lane"], [{key: item[key] for key in ("other", "file", "why")}])
            return [_commit(git, project, str(t["lane_commit"])) for t in tasks if t.get("lane") not in aside and t.get("lane_commit")]

        earlier = None
        base = fork
        if head != fork:
            # An earlier join that moved the branch and stopped before it finished, on the fork point or on a moved branch.
            candidates = landing_order()
            earlier = already_landed(cell_repo, fork, candidates, git=git)
            if earlier is None:
                copies = trailing_copies(cell_repo, candidates, git=git) if candidates else 0
                base = _commit(git, cell_repo, f"HEAD~{copies}") if copies else head
                moved_files = sorted(name for name in _ok(git, ["diff", "--name-only", "--no-renames", fork, base], cell_repo, "git-failed",
                                                          "Git could not compare the ticket's branch with the fork point").splitlines() if name)
                moved_commits = _ok(git, ["rev-list", "--reverse", f"{fork}..{base}"], cell_repo, "git-failed",
                                    "Git could not read the ticket's branch").split()
                if base != fork:
                    result["moved_branch"] = {"from": fork, "to": base, "commits": moved_commits, "files": moved_files}
                    moved = set(moved_files)
                    for lane in kept():
                        files: Set[str] = set()
                        for rev in by_lane[lane]:
                            files.update(changed_by(git, project, rev))
                        hit = sorted(files & moved)
                        hit += [name for name, _ in unrepresentable(files, moved)]
                        if hit:
                            set_aside(lane, [{"why": BRANCH_MOVED, "file": name, "commits": moved_commits} for name in sorted(set(hit))])
                if copies:
                    earlier = already_landed(cell_repo, fork, landing_order(), git=git)
                    if earlier is None:  # the copies on top are not exactly this join's: land on the head, as on any moved branch
                        base = head
                        result["moved_branch"] = dict(result["moved_branch"] or {}, to=head)
        commits = landing_order()
        result["tasks_without_commit"] = [str(t.get("task")) for t in tasks if t.get("lane") not in aside and not t.get("lane_commit")]
        task_of = {_commit(git, project, str(t["lane_commit"])): t for t in tasks if t.get("lane_commit") and t.get("lane") not in aside}
        if earlier is not None:  # an earlier join moved the branch and stopped before it finished: finish it
            result["resumed"] = True
            landed, tip, where, base = earlier["landed"], head, cell_repo, earlier["base"]
        else:
            started = clock()
            while True:
                try:
                    made = land(project, join_repo, join_branch, base, commits, git=git)
                    break
                except LandingError as exc:
                    # A lane commit that does not apply, or does not land as exactly itself: that lane is set aside, and the others land.
                    lane = str((task_of.get(exc.commit or "") or {}).get("lane") or "")
                    if exc.code not in ("cherry-pick-failed", "patch-id-mismatch") or not lane or exc.left:
                        raise
                    set_aside(lane, [{"why": DID_NOT_APPLY, "commit": exc.commit, "detail": str(exc)[:600]}])
                    commits = [sha for sha in commits if (task_of.get(sha) or {}).get("lane") not in aside]
            timed("land", started)
            landed, tip, where = made["landed"], made["tip"], join_repo
        result["base"] = base
        result["tip"] = tip
        result["landed"] = [{"task": str(task_of[item["lane_commit"]].get("task")), "lane": str(task_of[item["lane_commit"]].get("lane")), **item}
                            for item in landed]
        result["tasks_without_commit"] = [str(t.get("task")) for t in tasks if t.get("lane") not in aside and not t.get("lane_commit")]
    except LandingError as exc:
        return refuse(exc.code, str(exc), commit=exc.commit, left=exc.left)
    result["set_aside"] = [aside[lane] for lane in order if lane in aside]

    # 8.1 step 3: the whole suite on the landed tip. Anything that stops here leaves the ticket's branch where it was.
    try:
        started = clock()
        run = dict(run_suite(where))
        timed("suite", started)
        ran_on = git(["rev-parse", "HEAD"], where).stdout.strip()
        suite = {key: run.get(key) for key in ("command", "exit_code", "passed", "seconds", "output_tail")}
        suite.update({"scope": "whole suite", "ran_on": ran_on, "where": "join worktree" if where == join_repo else "cell checkout"})
        result["suite"] = suite
        if ran_on != tip:
            left = _undo_join(git, project, join_repo, join_branch) if where == join_repo else []
            return refuse("suite-moved-head", f"The test command changed the checked-out commit ({ran_on[:10]}, not {tip[:10]}), so its "
                                              "result is not a run of the landed work. Nothing was landed.", left=left)
        if not run.get("passed"):
            result["status"] = "INTERACTION"
            result["interaction"] = _interaction(git, where, run, result["landed"], kept(), order, test_files)
            if not move_on_red:
                result["ticket_head"] = head
                result["branch_moved"] = head == tip and bool(landed)
                return result
        if where == join_repo:  # 8.1 step 4: move the ticket's branch in one step
            started = clock()
            fast_forward(cell_repo, tip, git=git)
            timed("fast_forward", started)
    except LandingError as exc:
        left = _undo_join(git, project, join_repo, join_branch) if where == join_repo else []
        return refuse(exc.code, str(exc), commit=exc.commit, left=left)

    result["ticket_head"] = _commit(git, cell_repo, "HEAD")
    result["branch_moved"] = result["ticket_head"] == tip and bool(landed)
    if result["status"] != "INTERACTION":
        result["status"] = "JOINED"

    # Clean up, only now that every landed commit is on the ticket's branch. A landed lane's worktree or branch that still
    # holds anything that has not landed stays, and is listed. A set-aside lane's tip is kept first under the station's own ref,
    # so that removing its branch loses nothing; where that ref cannot be made, its branch is kept instead.
    started = clock()
    landed_lanes = kept()
    left: List[str] = []
    removable_aside: List[str] = []
    for item in result["set_aside"]:
        lane = item["lane"]
        tip_of = tips.get(lane) or next((sha for sha in reversed(item["lane_commits"])
                                        if git(["cat-file", "-e", f"{sha}^{{commit}}"], project).returncode == 0), None)
        item["tip"] = tip_of
        item["kept_as"] = None
        if not tip_of:
            removable_aside.append(lane)
            continue
        ref = keep_ref(lane) if keep_ref is not None else None
        if ref and ref.startswith("refs/mach/") and git(["update-ref", ref, tip_of], project).returncode == 0:
            item["kept_as"] = ref
            removable_aside.append(lane)
        elif lane in lane_branches:
            left.append(f"the branch {lane_branches[lane]} (lane {lane} was set aside; its work is kept on it)")
    folders = [Path(lane_folders[lane]) for lane in order if lane in lane_folders]
    branches = [lane_branches[lane] for lane in order if lane in lane_branches]
    try:
        left += remove(project, [join_repo], [join_branch], git=git)
        left += remove(project, [Path(lane_folders[lane]) for lane in landed_lanes if lane in lane_folders],
                       [lane_branches[lane] for lane in landed_lanes if lane in lane_branches], landed_on=tip, git=git)
        left += remove(project, [Path(lane_folders[lane]) for lane in removable_aside if lane in lane_folders],
                       [lane_branches[lane] for lane in removable_aside if lane in lane_branches], git=git)
    except LandingError as exc:
        left.append(f"cleanup stopped: {exc}")
    timed("cleanup", started)
    result["left"] = left
    result["removed"] = [str(folder) for folder in [Path(join_repo), *folders]
                         if not folder.exists() and not _registered_as(git, project, folder)[0]] \
        + [branch for branch in [join_branch, *branches] if not _branch_exists(git, project, branch)]
    return result


def _interaction(git: Runner, where: Path, run: Dict[str, Any], landed: List[Dict[str, Any]], landed_lanes: List[str],
                 order: List[str], test_files: Dict[str, List[str]]) -> Dict[str, Any]:
    """What the joined suite's failure says (8.3): the failing tests, the lanes whose files they name, and the files a fix
    may change (every file the landed lanes changed that is no lane's test file). Nothing is guessed beyond that."""
    output = str(run.get("output") or run.get("output_tail") or "")
    failing = failing_tests(output)
    haystack = "\n".join(failing) or output
    changed: Dict[str, Set[str]] = {lane: set() for lane in landed_lanes}
    for item in landed:
        changed.setdefault(item["lane"], set()).update(changed_by(git, where, item["commit"]))
    frozen: Set[str] = set()
    for lane in order:
        frozen |= set(test_files.get(lane) or [])
    named = []
    for lane in landed_lanes:
        files = sorted(name for name in changed[lane] if _named_in(name, haystack))
        if files:
            named.append({"lane": lane, "files": files})
    every: Set[str] = set()
    for files in changed.values():
        every |= files
    return {"failing": failing, "lanes_named": named, "lanes": list(landed_lanes), "fix_files": sorted(every - frozen),
            "output_tail": str(run.get("output_tail") or output)[-3000:]}
