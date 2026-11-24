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

When the plan's independence was false (two lanes changed one file, or a lane changed a test file another lane holds),
the later lane in plan order is set aside, never the earlier; nothing of it lands, and the result says which lane,
which file, which earlier lane and why, so the station can hand its tasks back to be redone in the cell. When every
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
        if clashes:
            found.extend(clashes)
        else:
            kept.append(lane)
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

def already_landed(cell_repo: Path, fork: str, commits_in_order: List[str], *, git: Optional[Runner] = None) -> Optional[List[Dict[str, Any]]]:
    """When the ticket's branch was already fast-forwarded by an earlier join that stopped before it finished: the landed
    commits (one per lane commit, in order, same change and message, no merge), else None."""
    git = git or run_git
    fork = _commit(git, cell_repo, fork)
    if git(["merge-base", "--is-ancestor", fork, "HEAD"], cell_repo).returncode != 0:
        return None
    since = _ok(git, ["rev-list", "--reverse", f"{fork}..HEAD"], cell_repo, "git-failed", "Git could not read the ticket's branch").split()
    if not commits_in_order or len(since) != len(commits_in_order):
        return None
    landed = []
    previous = fork
    for new, rev in zip(since, commits_in_order):
        sha = _commit(git, cell_repo, rev)
        if _parents(git, cell_repo, new) != [previous]:
            return None
        pid = patch_id(cell_repo, new, git)
        if pid != patch_id(cell_repo, sha, git) or _subject_and_body(git, cell_repo, new) != _subject_and_body(git, cell_repo, sha):
            return None
        landed.append({"lane_commit": sha, "commit": new, "patch_id": pid})
        previous = new
    return landed


def failing_tests(output: str) -> List[str]:
    """The failing tests a unittest or pytest run names, as it names them."""
    # unittest names a test "test_x (module.Class)" before Python 3.11 and "test_x (module.Class.test_x)" from it.
    found = [module if module.endswith("." + name) else f"{module}.{name}" for name, module in UNITTEST_FAIL_RE.findall(output or "")]
    found += [f"{path}::{name}" if name else path for path, name in PYTEST_FAIL_RE.findall(output or "")]
    return list(dict.fromkeys(found))


def _named_in(name: str, haystack: str) -> bool:
    stem = name[:-3] if name.endswith(".py") else name
    dotted = stem.replace("/", ".")
    return name in haystack or (dotted != stem and dotted in haystack) or (dotted == stem and re.search(r"(?<![\w.])" + re.escape(stem) + r"(?![\w])", haystack) is not None)


def join_lanes(project: Path, cell_repo: Path, join_repo: Path, join_branch: str, fork: str,
               tasks: Sequence[Dict[str, Any]], test_files: Dict[str, List[str]],
               run_suite: Callable[[Path], Dict[str, Any]],
               *, lane_folders: Optional[Dict[str, Path]] = None, lane_branches: Optional[Dict[str, str]] = None,
               move_on_red: bool = False, git: Optional[Runner] = None,
               clock: Callable[[], float] = time.monotonic) -> Dict[str, Any]:
    """Bring the lanes together, section 8.1: check, land in the join worktree, run the whole suite there, move the
    ticket's branch, clean up.

    `tasks`: every lanes-part task in plan order, {"task": "T03", "lane": "L1", "lane_commit": sha or None (a task done
    without a commit)}. The lanes' plan order is the order of their first task. `test_files`: each lane's frozen test
    files. `run_suite(folder)` runs the whole test suite in `folder` and returns at least {"passed", "exit_code",
    "seconds", "output_tail"} (and "command"). `lane_folders` and `lane_branches`: each lane's worktree and branch,
    checked (a lane branch must end at its last listed commit) and removed after a finished landing.

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
    result: Dict[str, Any] = {"status": "REFUSED", "fork": fork, "tip": None, "branch_moved": False, "ticket_head": None,
                              "lanes": order, "landed": [], "set_aside": [], "tasks_without_commit": [], "suite": None,
                              "interaction": None, "refused": None, "resumed": False, "removed": [], "left": [], "seconds": seconds}

    def refuse(code: str, reason: str, commit: Optional[str] = None, left: Optional[List[str]] = None) -> Dict[str, Any]:
        result.update({"status": "REFUSED", "refused": {"code": code, "reason": reason, "commit": commit}})
        result["left"] = list(left or []) + result["left"]
        head = git(["rev-parse", "HEAD"], cell_repo)
        result["ticket_head"] = head.stdout.strip() if head.returncode == 0 else None
        return result

    def timed(name: str, started: float) -> None:
        seconds[name] = round(clock() - started, 1)

    try:
        fork = _commit(git, project, fork)
        result["fork"] = fork
        if len(order) < 2 or "" in order:
            return refuse("one-lane", "Lanes are joined only when two or more were opened and every task names its lane; "
                                      "with one lane the build stays in order in the cell, and there is nothing to land.")
        started = clock()
        for lane in order:  # each lane's commits are a chain from the fork point, in its tasks' order, with nothing else on its branch
            previous = fork
            for rev in by_lane[lane]:
                sha = _commit(git, project, rev)
                if _parents(git, project, sha) != [previous]:
                    return refuse("lane-history", f"Lane {lane}'s commits are not one chain from the fork point in its tasks' order "
                                                  f"({sha[:10]} does not follow {previous[:10]}). Nothing was landed.", commit=sha)
                previous = sha
            branch = lane_branches.get(lane)
            if branch:
                tip = git(["rev-parse", "--verify", "-q", f"refs/heads/{branch}"], project).stdout.strip()
                if tip and tip != previous:
                    return refuse("lane-unrecorded-commits", f"Lane {lane}'s branch {branch} is at {tip[:10]}, not at its last task's commit "
                                                             f"{previous[:10]}: it holds work no task recorded. Nothing was landed.")
        clashes = overlaps(project, fork, {lane: by_lane[lane] for lane in order}, test_files, git=git)
        aside = list(dict.fromkeys(item["lane"] for item in clashes))
        for lane in aside:
            result["set_aside"].append({"lane": lane, "tasks": [str(t.get("task")) for t in tasks if t.get("lane") == lane],
                                        "lane_commits": list(by_lane[lane]),
                                        "because": [{k: item[k] for k in ("other", "file", "why")} for item in clashes if item["lane"] == lane]})
        landing_tasks = [t for t in tasks if t.get("lane") not in aside]
        result["tasks_without_commit"] = [str(t.get("task")) for t in landing_tasks if not t.get("lane_commit")]
        commits = [_commit(git, project, str(t["lane_commit"])) for t in landing_tasks if t.get("lane_commit")]
        timed("check", started)

        head = _commit(git, cell_repo, "HEAD")
        earlier = None if head == fork else already_landed(cell_repo, fork, commits, git=git)
        if head != fork and earlier is None:
            return refuse("branch-moved", f"The ticket's branch is at {head[:10]}, not at the fork point {fork[:10]} nor at the lanes' "
                                          "landed work, so it moved some other way while the lanes were open. Nothing was landed.")
        if _dirty(git, cell_repo, untracked=False):
            return refuse("cell-dirty", "The cell's own checkout has uncommitted changes, so nothing was landed.")

        task_of = {_commit(git, project, str(t["lane_commit"])): t for t in landing_tasks if t.get("lane_commit")}
        if earlier is not None:  # an earlier join moved the branch and stopped before it finished: finish it
            result["resumed"] = True
            landed, tip, where = earlier, head, cell_repo
        else:
            started = clock()
            made = land(project, join_repo, join_branch, fork, commits, git=git)
            timed("land", started)
            landed, tip, where = made["landed"], made["tip"], join_repo
        result["tip"] = tip
        result["landed"] = [{"task": str(task_of[item["lane_commit"]].get("task")), "lane": str(task_of[item["lane_commit"]].get("lane")), **item}
                            for item in landed]
    except LandingError as exc:
        return refuse(exc.code, str(exc), commit=exc.commit, left=exc.left)

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
            result["interaction"] = _interaction(git, where, run, result["landed"], [lane for lane in order if lane not in aside], order, test_files)
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
    # holds anything that has not landed stays, and is listed; a set-aside lane is removed as it is (8.2: its commits are named
    # in the result and not kept).
    started = clock()
    landed_lanes = [lane for lane in order if lane not in aside]
    folders = [Path(lane_folders[lane]) for lane in order if lane in lane_folders]
    branches = [lane_branches[lane] for lane in order if lane in lane_branches]
    left: List[str] = []
    try:
        left += remove(project, [join_repo], [join_branch], git=git)
        left += remove(project, [Path(lane_folders[lane]) for lane in landed_lanes if lane in lane_folders],
                       [lane_branches[lane] for lane in landed_lanes if lane in lane_branches], landed_on=tip, git=git)
        left += remove(project, [Path(lane_folders[lane]) for lane in aside if lane in lane_folders],
                       [lane_branches[lane] for lane in aside if lane in lane_branches], git=git)
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
