#!/usr/bin/env python3
"""MACH conveyor belt: decide what happens next to a ticket.

Every station records where it left a ticket (the cell's stage, the audit report, the
verification and review decisions). This script reads those records and names the single next
step, who should do it, and on which model, so the order of the factory is decided by a script
and not by whoever is driving it.

    run.py next <ticket> [--headless]    the next step for one ticket
    run.py board [--headless]            the next step for every open ticket and cell
    run.py review-start <ticket>         start the review round; prints one ready prompt per reviewer seat
    run.py review-tally <ticket>         count the review votes

A step is either work ("action": audit, groom, plan, build, revise, verify, review, cleanup)
or a stop ("action": "stop") with the reason and what it is waiting for: a person's answers, a
person's approval, a merge, or a person to take over an escalated ticket.

Standard library only. It reads; the only commands it runs are git queries and the review
station's own script.
"""

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
HARDENING_LABEL = "repo-hardening"
SKILL_DIR = Path(__file__).resolve().parent.parent
# Installed into a project, skills are folders named mach-<station> and agents mach-<name>;
# as a plugin they are <station> and mach:<name>.
PROJECT_INSTALL = SKILL_DIR.name.startswith("mach-")


class RunError(Exception):
    """A problem the caller can fix; printed without a traceback."""


def skill(name: str) -> str:
    return f"/mach-{name}" if PROJECT_INSTALL else f"/mach:{name}"


def agent_type(name: str) -> str:
    return f"mach-{name}" if PROJECT_INSTALL else f"mach:{name}"


def sibling(name: str) -> Path:
    """Another station's skill folder, whichever way MACH is installed."""
    for candidate in (SKILL_DIR.parent / f"mach-{name}", SKILL_DIR.parent / name):
        if candidate.is_dir():
            return candidate
    raise RunError(f"The MACH {name} skill is not installed next to this one ({SKILL_DIR.parent}).")


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)


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


class Project:
    def __init__(self, root: Path) -> None:
        self.root = root
        config = load_json(root / ".factory" / "config.json", {})
        self.config = config if isinstance(config, dict) else {}

    def section(self, name: str) -> Dict[str, Any]:
        value = self.config.get(name)
        return value if isinstance(value, dict) else {}

    def model(self, tier: str) -> str:
        defaults = {"planning": "fable", "contracts": "opus", "build": "sonnet", "utility": "haiku"}
        value = self.section("models").get(tier)
        return value if isinstance(value, str) and value else defaults[tier]

    def cell_dir(self, ticket_id: str) -> Path:
        return self.root / ".factory" / "worktrees" / ticket_id

    def ticket_labels(self, ticket_id: str) -> List[str]:
        labels = list((load_json(self.root / ".factory" / "inbox" / f"{ticket_id}.json", {}) or {}).get("labels") or [])
        local = self.root / ".factory" / "tickets" / f"{ticket_id}.md"
        if local.is_file():
            front = re.match(r"^---\n(.*?)\n---", local.read_text(encoding="utf-8"), re.DOTALL)
            line = re.search(r"^labels:\s*(.*)$", front.group(1), re.MULTILINE) if front else None
            if line:
                labels += [a or b for a, b in re.findall(r'"([^"]*)"|([^\s,\[\]"]+)', line.group(1))]
        return labels

    def audit(self) -> Dict[str, Any]:
        """Whether the readiness audit lets building start: ok, or why not."""
        if self.section("build").get("require_audit") is False:
            return {"state": "off"}
        report = load_json(self.root / ".factory" / "audit-report.json")
        if not isinstance(report, dict):
            return {"state": "missing"}
        head = git(self.root, "rev-parse", "HEAD").stdout.strip() or None
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(report["timestamp"])).total_seconds() / 86400
        except (KeyError, ValueError, TypeError):
            age = float("inf")
        if report.get("head") != head or age > self.section("audit").get("max_age_days", 7):
            return {"state": "stale"}
        tier = report.get("readiness_tier")
        return {"state": "ok" if tier in ("Gold", "Silver") else "bronze", "tier": tier, "blockers": report.get("blockers") or []}

    def default_branch(self) -> str:
        remote = git(self.root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").stdout.strip()
        return remote.split("/", 1)[-1] if remote else git(self.root, "branch", "--show-current").stdout.strip() or "main"

    def merged(self, branch: Optional[str]) -> bool:
        """Whether an approved cell's branch has reached the default branch (a true merge or fast-forward)."""
        if not branch or git(self.root, "show-ref", "--verify", "-q", f"refs/heads/{branch}").returncode != 0:
            return False
        default = self.default_branch()
        return any(git(self.root, "merge-base", "--is-ancestor", branch, ref).returncode == 0 for ref in (default, f"origin/{default}"))


def step(ticket_id: str, stage: Optional[str], action: str, reason: str, **extra: Any) -> Dict[str, Any]:
    result: Dict[str, Any] = {"ticket_id": ticket_id, "stage": stage, "action": action, "stop": action == "stop", "reason": reason,
                              "needs": None, "agent_type": None, "model": None, "prompt": None, "interactive": False}
    result.update(extra)
    return result


def next_step(project: Project, ticket_id: str, headless: bool) -> Dict[str, Any]:
    if not TICKET_ID_RE.match(ticket_id):
        raise RunError(f"'{ticket_id}' is not a usable ticket ID.")
    root = project.cell_dir(ticket_id)
    cell = load_json(root / "cell.json")
    flag = " --headless" if headless else ""
    groom_prompt = f"Use the MACH intent skill: {skill('intent')} {ticket_id}{flag}"
    if not isinstance(cell, dict):
        known = (project.root / ".factory" / "tickets" / f"{ticket_id}.md").is_file() or (project.root / ".factory" / "inbox" / f"{ticket_id}.json").is_file()
        note = "The ticket has not been groomed yet." if known else "No cell exists for this ticket; grooming will look the ticket up in the tracker."
        return step(ticket_id, None, "groom", note, model=project.model("planning"), prompt=groom_prompt, interactive=not headless)
    stage = cell.get("stage")
    work = root / "repo" if cell.get("isolation") == "worktree" else project.root
    head = git(work, "rev-parse", "HEAD").stdout.strip()

    if stage == "interview":
        return step(ticket_id, stage, "groom", "Grooming has started but the spec is not written.", model=project.model("planning"), prompt=groom_prompt, interactive=not headless)
    if stage == "spec-open":
        if headless:
            return step(ticket_id, stage, "stop", "The spec has open questions that only a person can answer.", needs="answers",
                        prompt=f"A person continues the interview with: {skill('intent')} {ticket_id}")
        return step(ticket_id, stage, "groom", "The spec has open questions; the interview continues with a person.", model=project.model("planning"),
                    prompt=groom_prompt, interactive=True)
    if stage == "spec-ready":
        return step(ticket_id, stage, "plan", "The spec is ready; contracts and the plan are not written yet.", model=project.model("contracts"),
                    prompt=f"Use the MACH intent skill to finish stage 2 (contracts and plan) for this ticket: {skill('intent')} {ticket_id}{flag}")

    if stage == "planned":
        audit = project.audit()
        if audit["state"] in ("missing", "stale"):
            return step(ticket_id, stage, "audit", f"The readiness audit report is {audit['state']}; building is gated on it.", model=project.model("build"),
                        prompt=f"Use the MACH audit skill on the main checkout: {skill('audit')}")
        if audit["state"] == "bronze" and HARDENING_LABEL not in project.ticket_labels(ticket_id):
            return step(ticket_id, stage, "stop", "The repository's readiness tier is Bronze: " + " ".join(audit["blockers"])
                        + f" Only tickets labelled '{HARDENING_LABEL}' may be built until it is hardened.", needs="repository-hardening")
        return step(ticket_id, stage, "build", "Groomed and cleared to build.", agent_type=agent_type("builder"), prompt=f"Build MACH ticket {ticket_id}.")
    if stage == "building":
        state = load_json(root / "build.json", {}) or {}
        loop = int(state.get("loop") or 0)
        note = f"The build is in progress (revision {loop})." if loop else "The build is in progress."
        return step(ticket_id, stage, "build", note, agent_type=agent_type("builder"),
                    prompt=f"Continue building MACH ticket {ticket_id}. Building has already started: continue from the next task."
                    + (f" This is revision {loop}; the findings to address are in the cell's review-findings-{loop}.md." if loop else ""))

    if stage == "built":
        decision = load_json(root / "review" / "decision.json", {}) or {}
        summary = load_json(root / "evidence" / "summary.json", {}) or {}
        if decision.get("outcome") == "REJECTED" and decision.get("head") == head:
            return step(ticket_id, stage, "revise", "Review rejected this build.", agent_type=agent_type("builder"), findings=decision.get("findings"),
                        prompt=f"Revise MACH ticket {ticket_id} after a rejected review. Findings: {decision.get('findings')}")
        if summary.get("status") == "FAIL_WITH_EVIDENCE" and summary.get("head") == head:
            findings = str(root / "evidence" / "findings.md")
            return step(ticket_id, stage, "revise", "Verification failed this build.", agent_type=agent_type("builder"), findings=findings,
                        prompt=f"Revise MACH ticket {ticket_id} after a failed verification. Findings: {findings}")
        return step(ticket_id, stage, "verify", "Built; not yet verified.", agent_type=agent_type("verifier"), prompt=f"Verify MACH ticket {ticket_id}.")

    if stage == "verified":
        return step(ticket_id, stage, "review", "Verified; ready for the review panel.", risk=cell.get("risk"))
    if stage == "awaiting-human":
        return step(ticket_id, stage, "stop", "The review panel approved, and a person must approve before merge.", needs="human-approval",
                    findings=(load_json(root / "review" / "decision.json", {}) or {}).get("findings"))
    if stage == "approved":
        if project.merged(cell.get("branch")):
            return step(ticket_id, stage, "cleanup", "Approved and merged.", model=project.model("utility"),
                        prompt=f"Use the MACH cleanup skill: {skill('cleanup')} {ticket_id}")
        return step(ticket_id, stage, "stop", f"Approved. The branch {cell.get('branch')} is ready to merge; MACH does not merge.", needs="merge")
    if stage == "blocked":
        return step(ticket_id, stage, "stop", "The ticket failed its third round and was escalated.", needs="person-to-take-over")
    return step(ticket_id, stage, "stop", f"The cell is in an unknown stage ('{stage}').", needs="person-to-take-over")


def cmd_next(project: Project, args: argparse.Namespace) -> int:
    print(json.dumps(next_step(project, args.ticket_id, args.headless), indent=2, ensure_ascii=False))
    return 0


def cmd_board(project: Project, args: argparse.Namespace) -> int:
    ids: List[str] = []
    worktrees = project.root / ".factory" / "worktrees"
    for path in sorted(worktrees.glob("*/cell.json")) if worktrees.is_dir() else []:
        ids.append(path.parent.name)
    tickets = project.root / ".factory" / "tickets"
    for path in sorted(tickets.glob("*.md")) if tickets.is_dir() else []:
        front = re.match(r"^---\n(.*?)\n---", path.read_text(encoding="utf-8"), re.DOTALL)
        state = re.search(r"^state:\s*(\S+)", front.group(1), re.MULTILINE) if front else None
        if path.stem not in ids and TICKET_ID_RE.match(path.stem) and (not state or state.group(1) != "closed"):
            ids.append(path.stem)
    rows = []
    for ticket_id in ids:
        info = next_step(project, ticket_id, args.headless)
        rows.append({key: info[key] for key in ("ticket_id", "stage", "action", "needs", "reason")})
    print(json.dumps({"audit": project.audit(), "tickets": rows,
                      "ready_to_run": [row["ticket_id"] for row in rows if row["action"] != "stop"],
                      "waiting_on_a_person": [row["ticket_id"] for row in rows if row["action"] == "stop"]}, indent=2, ensure_ascii=False))
    return 0


def review_script(project: Project, *argv: str) -> subprocess.CompletedProcess:
    script = sibling("review") / "scripts" / "review.py"
    return subprocess.run([sys.executable, str(script), "--project", str(project.root), *argv], capture_output=True, text=True)


def cmd_review_start(project: Project, args: argparse.Namespace) -> int:
    done = review_script(project, "start", args.ticket_id)
    if done.returncode != 0:
        raise RunError(done.stderr.strip().replace("refused: ", "", 1) or "The review station refused to start.")
    started = json.loads(done.stdout)
    review = sibling("review")
    seats = []
    for seat in started["panel"]:
        roles = ["architecture", "security", "product"] if seat["role"] == "general" else [seat["role"]]
        seats.append({
            "role": seat["role"], "model": seat["model"], "agent_type": agent_type("reviewer"),
            "prompt": "\n".join([
                f"You are the {seat['role']} reviewer for MACH ticket {args.ticket_id}.",
                f"Brief (read first, follow exactly): {review / 'references' / 'reviewer-brief.md'}",
                "Your checklist: " + ", ".join(str(review / "references" / f"{role}.md") for role in roles),
                f"Review packet: {started['packet']}",
                f"Review script: {review / 'scripts' / 'review.py'}",
            ]),
        })
    print(json.dumps({**{k: started[k] for k in ("round", "max_rounds", "risk", "approvals_needed", "human_approval_required", "diff_stat")},
                      "seats": seats, "next": "Start every seat at once, each a fresh sub-agent on its model, with exactly its prompt. Then run review-tally."},
                     indent=2, ensure_ascii=False))
    return 0


def cmd_review_tally(project: Project, args: argparse.Namespace) -> int:
    done = review_script(project, "tally", args.ticket_id)
    if not done.stdout.strip():
        raise RunError(done.stderr.strip().replace("refused: ", "", 1) or "The review station could not tally.")
    print(done.stdout.rstrip())
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MACH conveyor belt: what happens next to a ticket.")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("next", help="the next step for one ticket")
    p.add_argument("ticket_id")
    p.add_argument("--headless", action="store_true", help="no person is available to answer questions")
    p.set_defaults(func=cmd_next)
    p = sub.add_parser("board", help="the next step for every open ticket and cell")
    p.add_argument("--headless", action="store_true")
    p.set_defaults(func=cmd_board)
    for name, func, text in (("review-start", cmd_review_start, "start the review round and print one prompt per seat"),
                             ("review-tally", cmd_review_tally, "count the review votes")):
        p = sub.add_parser(name, help=text)
        p.add_argument("ticket_id")
        p.set_defaults(func=func)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        root = args.project.resolve() if args.project else find_project(Path.cwd())
        return args.func(Project(root), args)
    except RunError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
