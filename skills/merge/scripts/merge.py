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

Standard library only. It never force-pushes, never rewrites history, and never deletes a branch.
"""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

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


def void_approval(cell: Cell) -> None:
    """Something was added after review: send the ticket back to be verified and reviewed again."""
    cell.info.update({"stage": "built", "review": "VOID", "verification": None})
    cell.build["head"] = cell.head()
    write_json(cell.root / "build-report.json", cell.build)
    stale = cell.root / "review" / "decision.json"
    if stale.is_file():
        cell.decision["outcome"] = "VOID"
        cell.decision["void_reason"] = "The branch changed after it was approved."
        write_json(stale, cell.decision)
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


def pr_body(cell: Cell) -> str:
    checks = cell.summary.get("checks") or {}
    votes = cell.decision.get("votes") or {}
    human = cell.decision.get("human_approval") or {}
    evidence = [entry.get("file") for entry in cell.summary.get("evidence_files") or [] if isinstance(entry, dict)]
    lines = [
        f"**Ticket:** {cell.ticket_id}  ",
        f"**Slice:** {cell.info.get('slice_id')} (`{cell.info.get('spec_path')}`)  ",
        f"**Risk tier:** {cell.info.get('risk')}",
        "",
        "## Verification",
        f"{cell.summary.get('status', 'unknown')}: {sum(1 for c in checks.values() if c.get('result') == 'pass')} of {len(checks)} checks passed, "
        "run by an independent verifier against the built slice.",
        "",
        "## Review",
        f"Round {cell.decision.get('round')}: " + ", ".join(f"{seat} {vote}" for seat, vote in votes.items()) + f". Blockers: {cell.decision.get('blockers', 0)}.",
        f"Approved by a person: {human.get('by')}." if human else "No person's approval was required for this ticket.",
        "",
        "## Build",
        f"{cell.build.get('diff', '')}. Tests seen failing before their code was written: {cell.build.get('tests_seen_failing_first', 0)}. "
        f"Gate overrides recorded: {len(cell.build.get('deviations') or [])}.",
        "",
        f"Approved commit: `{cell.decision.get('head')}`. Evidence ({len(evidence)} files) and the reviewers' findings are kept with the ticket's cell and archived on cleanup.",
        "",
        "Opened by the MACH merge station.",
    ]
    return "\n".join(lines)


def gh(cell: Cell, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["gh", *args], cwd=str(cell.project), capture_output=True, text=True, errors="replace")


def land_by_pr(cell: Cell, main: str, merge_now: bool) -> Dict[str, Any]:
    head = cell.head()
    pushed = git(cell.work, "push", "-u", "origin", cell.branch)
    if pushed.returncode != 0:
        raise MergeError("The branch could not be pushed: " + (pushed.stderr.strip().splitlines() or ["git push failed"])[-1])
    url = cell.info.get("pull_request")
    if not url:
        title = f"{cell.ticket_id}: {cell.info.get('title') or cell.info.get('slice_id') or 'change'}"
        made = gh(cell, "pr", "create", "--head", cell.branch, "--base", main, "--title", title, "--body", pr_body(cell))
        found = re.search(r"https?://\S+/pull/\d+", made.stdout + made.stderr)
        if not found:
            raise MergeError("The pull request could not be opened: " + ((made.stderr.strip() or made.stdout.strip()).splitlines() or ["gh pr create failed"])[-1])
        url = found.group(0)
        cell.info["pull_request"] = url
        cell.info["stage"] = "pr-open"
        cell.save_info()
    state = gh(cell, "pr", "view", url, "--json", "state,mergeCommit,headRefOid")
    view = load_text(state.stdout)
    if view.get("state") != "MERGED" and merge_now:
        done = gh(cell, "pr", "merge", url, "--merge", "--match-head-commit", head)
        if done.returncode != 0:
            return {"merged": False, "pull_request": url,
                    "note": "The pull request is open but could not be merged yet: " + ((done.stderr.strip() or done.stdout.strip()).splitlines() or ["gh pr merge failed"])[-1]}
        view = load_text(gh(cell, "pr", "view", url, "--json", "state,mergeCommit,headRefOid").stdout)
    if view.get("state") != "MERGED":
        return {"merged": False, "pull_request": url, "note": "The pull request is open and waiting to be merged."}
    git(cell.project, "fetch", "origin")
    # Keep the main checkout level with the platform, so the next ticket starts from what just landed.
    synced = False
    if git(cell.project, "branch", "--show-current").stdout.strip() == main and not dirty(cell.project):
        synced = git(cell.project, "merge", "--ff-only", f"origin/{main}").returncode == 0
    return {"merged": True, "pull_request": url, "merge_commit": (view.get("mergeCommit") or {}).get("oid"), "main_checkout_updated": synced}


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
        raise MergeError(plan["refusals"][0] if len(plan["refusals"]) == 1 else "\n- " + "\n- ".join(plan["refusals"]), code="merge-refused")
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
    print(json.dumps({**{key: cell.info.get(key) for key in ("ticket_id", "stage", "branch", "risk", "pull_request", "revalidated", "merged")},
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
