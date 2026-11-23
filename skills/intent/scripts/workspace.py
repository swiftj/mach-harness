#!/usr/bin/env python3
"""A ticket's workspace: the cell's Git worktree, made so that it never holds Claude Code's configuration.

Claude Code's sandbox refuses writes to a project's Claude Code configuration (the `.claude/` folder and `.mcp.json`)
in the working directory and the folders above it, and no allow rule lifts that. A full checkout of a ticket's branch
re-creates those files in the cell, so every Git command that writes them there (creating the worktree, checkout,
merge, reset, stash) is refused. A cell is therefore a sparse worktree:

    git worktree add --no-checkout [-b <branch>] <cell>/repo [<branch>]
    git -C <cell>/repo sparse-checkout set --no-cone '/*' '!.claude/' '!.mcp.json'
    git -C <cell>/repo reset -q --hard HEAD

The patterns leave out every `.claude/` folder and every `.mcp.json` file, at any depth. They are kept in that
worktree's own configuration (Git turns on extensions.worktreeConfig and writes core.sparseCheckout to the worktree's
config.worktree), so the main checkout is never made sparse and stays a full checkout. The branch still carries those
files: commits, merges, the pull request and landing carry them unchanged, and Git never writes them into the cell.
Skip-worktree entries are not reported by `git status` or `git diff`, so the files left out never show as deleted.

Needs Git 2.36 or later (`sparse-checkout set --no-cone`, and Git setting up per-worktree configuration itself).

Shared by cell.py (open), build.py (a cell groomed before the repository had history) and the doctor (a throwaway
worktree made the same way). Standard library only.
"""

import re
import shutil
import subprocess
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

MIN_GIT = (2, 36)
PATTERNS = ("/*", "!.claude/", "!.mcp.json")
LEFT_OUT = "the .claude folder and .mcp.json"


class WorkspaceError(Exception):
    """A workspace that could not be made. The message says what Git said and what to do; nothing was left behind."""


def git(args: Sequence[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)


def protected(name: str) -> bool:
    """Whether a path, relative to the repository, is one a cell never holds: anything in a `.claude` folder, at any
    depth, and any file named `.mcp.json`."""
    text = str(name).strip().strip("`").replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    parts = [part for part in text.split("/") if part]
    return bool(parts) and (".claude" in parts or parts[-1] == ".mcp.json")


def git_version(cwd: Optional[Path] = None) -> Optional[Tuple[int, int, int]]:
    """Git's version as (major, minor, patch), or None when Git cannot be run or does not say."""
    try:
        done = subprocess.run(["git", "--version"], cwd=str(cwd) if cwd else None, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    found = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", done.stdout or "")
    if done.returncode != 0 or not found:
        return None
    return int(found.group(1)), int(found.group(2)), int(found.group(3) or 0)


def version_text(version: Optional[Tuple[int, int, int]]) -> str:
    return ".".join(str(part) for part in version) if version else "unknown"


def version_problem(version: Optional[Tuple[int, int, int]]) -> Optional[str]:
    """None when this Git can make a cell; otherwise the sentence that says why not."""
    wanted = ".".join(str(part) for part in MIN_GIT)
    if version is None:
        return f"MACH could not read Git's version, and a ticket's workspace needs Git {wanted} or later."
    if version[:2] < MIN_GIT:
        return f"A ticket's workspace needs Git {wanted} or later; this is Git {version_text(version)}."
    return None


def is_sparse(repo: Path) -> bool:
    """Whether a cell's worktree is made the sparse way (a cell made before it was is a full checkout)."""
    return git(["config", "--get", "core.sparseCheckout"], repo).stdout.strip().lower() == "true"


def _said(done: subprocess.CompletedProcess) -> str:
    lines = [line.strip() for line in (done.stderr or done.stdout or "").splitlines() if line.strip()]
    errors = [line for line in lines if line.lower().startswith(("fatal:", "error:"))]
    text = " ".join(errors or lines)
    return text[:600] or f"exit status {done.returncode}"


def _registered(project: Path, repo: Path) -> bool:
    target = str(repo.resolve()) if repo.exists() else str(repo)
    for line in git(["worktree", "list", "--porcelain"], project).stdout.splitlines():
        if line.startswith("worktree ") and line[len("worktree "):] in (target, str(repo)):
            return True
    return False


def _undo(project: Path, repo: Path, branch: Optional[str], made_branch: bool) -> List[str]:
    """Remove what a failed attempt made: the worktree's registration, its folder, and a branch it created."""
    left: List[str] = []
    if _registered(project, repo):
        done = git(["worktree", "remove", "--force", "--force", str(repo)], project)
        if done.returncode != 0 and _registered(project, repo):
            left.append(f"the worktree {repo} ({_said(done)})")
    if repo.exists():
        shutil.rmtree(str(repo), ignore_errors=True)
        if repo.exists():
            left.append(f"the folder {repo}")
    if made_branch and branch and git(["show-ref", "--verify", "-q", f"refs/heads/{branch}"], project).returncode == 0:
        done = git(["branch", "-D", branch], project)
        if done.returncode != 0:
            left.append(f"the branch {branch} ({_said(done)})")
    return left


def create(project: Path, repo: Path, branch: Optional[str]) -> None:
    """Make the cell's worktree at `repo` on `branch` (made from HEAD when it does not exist yet; detached at HEAD when
    `branch` is None), the sparse way. On any failure everything it made is removed and WorkspaceError says what Git
    said and what to do."""
    problem = version_problem(git_version(project))
    if problem:
        raise WorkspaceError(f"{problem} Nothing was made. Install a newer Git, then run this again; /mach doctor checks it.")
    if repo.exists():
        raise WorkspaceError(f"{repo} already exists, so Git cannot make the workspace there. Nothing was changed. "
                             "Move that folder aside (or finish its ticket with cleanup), then run this again.")
    made_branch = False
    if branch is None:
        add = ["worktree", "add", "--no-checkout", "--detach", str(repo), "HEAD"]
    elif git(["show-ref", "--verify", "-q", f"refs/heads/{branch}"], project).returncode == 0:
        add = ["worktree", "add", "--no-checkout", str(repo), branch]
    else:
        add = ["worktree", "add", "--no-checkout", "-b", branch, str(repo)]
        made_branch = True
    steps = [(add, project, "git worktree add"),
             (["sparse-checkout", "set", "--no-cone", *PATTERNS], repo, "git sparse-checkout set"),
             (["reset", "-q", "--hard", "HEAD"], repo, "git reset --hard")]
    for argv, cwd, label in steps:
        try:
            done = git(argv, cwd)
        except OSError as exc:
            done = subprocess.CompletedProcess(argv, 1, "", str(exc))
        if done.returncode != 0:
            left = _undo(project, repo, branch, made_branch)
            tail = (" Nothing was left behind." if not left else
                    " These could not be removed and need a person: " + "; ".join(left) + ".")
            raise WorkspaceError(f"Git could not make the ticket's workspace: {label} said: {_said(done)}.{tail} "
                                 "Fix what Git reports (run /mach doctor: it makes a throwaway workspace the same way), then run this again.")
