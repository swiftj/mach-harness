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
    run.py where                         where this script and the project are (used by the workflow)
    run.py product status                approved product work on the integration branch, against what was taken in
    run.py product intake [--dry-run]    take approved delivery waves in: one ticket per new slice, never twice
    run.py product plan                  the dependency-aware plan: what is ready, blocked, active or done, and why
    run.py product dispatch <slice>...   open the cells for chosen ready slices (or --ready); starts nothing
    run.py product events [--since N]    the intake ledger's transitions, for a supervisor or a dashboard
    run.py product reconcile [--fetch]   intake and a recorded plan in one locked step; never dispatches
    run.py factory status                what is in force on this machine and what the supervisor is doing; changes nothing
    run.py factory enable ...            preflight and a confirmation code; with --confirm, enable. Never a side effect
    run.py factory pause | resume | disable | stop
    run.py factory serve                 the supervisor: ticks until the Factory is disabled here
    run.py factory tick                  one supervisor pass

A step is either work ("action": audit, groom, plan, build, revise, verify, review, merge, cleanup)
or a stop ("action": "stop") with the reason and what it is waiting for: a person's answers, a
person's approval, a merge, or a person to take over an escalated ticket.

Standard library only. It reads; the only commands it runs are git queries and the review
station's own script. The product commands are the exception and live in intake.py: on an
engineer's explicit command they file tickets and open cells through the ticket and intent
stations' own scripts. Nothing here starts an agent, and nothing runs in the background.
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

    def finished(self, ticket_id: str) -> Optional[str]:
        """Why a ticket with no cell needs nothing more: it was cleaned up, or its ticket is closed."""
        runs = self.root / ".factory" / "archive" / "runs.jsonl"
        if runs.is_file():
            for line in reversed(runs.read_text(encoding="utf-8").splitlines()):
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record, dict) and record.get("ticket_id") == ticket_id:
                    return f"This ticket is finished: it was {record.get('outcome', 'closed')} and cleaned up ({record.get('archive')})."
        local = self.root / ".factory" / "tickets" / f"{ticket_id}.md"
        if local.is_file():
            front = re.match(r"^---\n(.*?)\n---", local.read_text(encoding="utf-8"), re.DOTALL)
            if front and re.search(r"^state:\s*closed\s*$", front.group(1), re.MULTILINE):
                return "This ticket is closed."
        return None

    def observe_due(self) -> bool:
        """Whether enough tickets have finished since the last observe pass for another one."""
        every = self.section("observe").get("every")
        every = every if isinstance(every, int) and every > 0 else 5
        log = self.root / ".factory" / "archive" / "runs.jsonl"
        total = sum(1 for line in log.read_text(encoding="utf-8").splitlines() if line.strip()) if log.is_file() else 0
        seen = (load_json(self.root / ".factory" / "observations" / "last-pass.json", {}) or {}).get("runs_total")
        return total - (seen if isinstance(seen, int) else 0) >= every

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
        finished = project.finished(ticket_id)
        if finished:
            return step(ticket_id, None, "stop", finished, needs="nothing")
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
            return step(ticket_id, stage, "revise", "The merge station sent this build back." if decision.get("rejected_by") else "Review rejected this build.", agent_type=agent_type("builder"), findings=decision.get("findings"),
                        prompt=f"Revise MACH ticket {ticket_id} after a rejected review. Findings: {decision.get('findings')}")
        if summary.get("status") == "FAIL_WITH_EVIDENCE" and summary.get("head") == head:
            findings = str(root / "evidence" / "findings.md")
            return step(ticket_id, stage, "revise", "Verification failed this build.", agent_type=agent_type("builder"), findings=findings,
                        prompt=f"Revise MACH ticket {ticket_id} after a failed verification. Findings: {findings}")
        return step(ticket_id, stage, "verify", "Built; not yet verified.", agent_type=agent_type("verifier"), prompt=f"Verify MACH ticket {ticket_id}.")

    if stage == "verified":
        return step(ticket_id, stage, "review", "Verified; ready for the review panel.", risk=cell.get("risk"))
    if stage == "awaiting-human":
        decided = load_json(root / "review" / "decision.json", {}) or {}
        why = " and ".join(decided.get("human_approval_reasons") or [])
        return step(ticket_id, stage, "stop", "The review panel approved, and a person must approve before merge" + (f" because {why}." if why else "."),
                    needs="human-approval", findings=decided.get("findings"))
    if stage == "merged":
        return step(ticket_id, stage, "cleanup", "Merged.", model=project.model("utility"), prompt=f"Use the MACH cleanup skill: {skill('cleanup')} {ticket_id}")
    if stage == "pr-open":
        return step(ticket_id, stage, "merge", f"A pull request is open for this ticket ({cell.get('pull_request')}); the merge station checks whether it can land.",
                    model=project.model("utility"), prompt=f"Use the MACH merge skill: {skill('merge')} {ticket_id}")
    if stage == "approved":
        decided = load_json(root / "review" / "decision.json", {}) or {}
        risk = cell.get("risk") if cell.get("risk") in ("High", "Medium", "Low") else "High"
        merging = project.section("merge")
        tiers = merging.get("auto") if isinstance(merging.get("auto"), dict) else {}
        revalidated = (cell.get("revalidated") or {}).get("head")
        if decided.get("head") not in (head, None) and revalidated != head and not project.merged(cell.get("branch")):
            return step(ticket_id, stage, "merge", "The branch changed after it was approved; the merge station will void the approval and return it to verification.",
                        model=project.model("utility"), prompt=f"Use the MACH merge skill: {skill('merge')} {ticket_id}")
        if not project.merged(cell.get("branch")) and merging.get("mode") == "auto" and tiers.get(risk.lower(), True) is not False:
            return step(ticket_id, stage, "merge", "Approved; the project's settings let the line merge it.", model=project.model("utility"),
                        prompt=f"Use the MACH merge skill: {skill('merge')} {ticket_id}")
        if project.merged(cell.get("branch")):
            return step(ticket_id, stage, "cleanup", "Approved and merged.", model=project.model("utility"),
                        prompt=f"Use the MACH cleanup skill: {skill('cleanup')} {ticket_id}")
        return step(ticket_id, stage, "stop", f"Approved. The branch {cell.get('branch')} is ready to merge; MACH does not merge.", needs="merge")
    if stage == "blocked":
        return step(ticket_id, stage, "stop", "The ticket failed its third round and was escalated.", needs="person-to-take-over")
    return step(ticket_id, stage, "stop", f"The cell is in an unknown stage ('{stage}').", needs="person-to-take-over")


def cmd_where(project: Project, args: argparse.Namespace) -> int:
    print(json.dumps({"run_script": str(Path(__file__).resolve()), "project": str(project.root), "python": sys.executable,
                      "is_mach_project": (project.root / ".factory").is_dir()}, indent=2))
    return 0


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
    tuning = [row["ticket_id"] for row in rows if row["action"] != "stop" and "factory-tuning" in project.ticket_labels(row["ticket_id"])]
    print(json.dumps({"audit": project.audit(), "observe_due": project.observe_due(), "factory_tuning_ready": tuning, "tickets": rows,
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


def factory(project: Project):
    """The product intake and scheduler, loaded only when a product command is used."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import intake
    try:
        return intake, intake.Factory(project.root, project.config, sibling=sibling, git=git,
                                      next_step=lambda ticket_id: next_step(project, ticket_id, True))
    except intake.IntakeError as exc:
        raise RunError(str(exc))


def fetch(project: Project) -> None:
    """Fetch from the shared repository. Only ever behind an explicit --fetch; it never changes a checkout."""
    fetched = git(project.root, "fetch", "origin")
    if fetched.returncode != 0:
        raise RunError("Could not fetch from the shared repository: " + (fetched.stderr.strip().splitlines() or ["no message"])[-1])


def cmd_product(project: Project, args: argparse.Namespace) -> int:
    intake, line = factory(project)
    try:
        if args.action == "status":
            found = line.discover()
            found.pop("_snapshot", None)
            plan = line.plan()
            result = {**found, "plan_summary": {key: plan[key] for key in ("counts", "dispatchable", "waiting_for_a_place", "needs_person", "intake_is_current", "limits")},
                      "factory_started": False}
        elif args.action == "intake":
            if args.fetch:
                fetch(project)
            adopt = {}
            for pair in args.adopt or []:
                slice_id, _, ticket_id = pair.partition("=")
                if not slice_id or not TICKET_ID_RE.match(ticket_id):
                    raise RunError(f"'{pair}' is not SLICE-ID=TICKET-ID.")
                adopt[slice_id] = ticket_id
            result = line.intake(dry_run=args.dry_run, adopt=adopt, reissue=args.reissue or [])
        elif args.action == "plan":
            result = line.plan()
        elif args.action == "reconcile":
            if args.fetch:
                fetch(project)
            result = line.reconcile()
        elif args.action == "dispatch":
            result = line.dispatch(args.slice_ids, all_ready=args.ready, limit=args.limit)
            result["workflow"] = "mach-belt" if PROJECT_INSTALL else "mach:belt"
            result["run_one"] = [f"{skill('run')} {ticket_id}" for ticket_id in result["tickets"]]
        else:
            result = {"events": line.events(since=args.since), "event_types": list(intake.EVENT_TYPES), "schema_version": intake.EVENT_VERSION}
    except intake.IntakeError as exc:
        raise RunError(str(exc))
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 1 if args.action == "intake" and result.get("refused") and not result.get("created") and not result.get("unchanged") else 0


def workflow_name() -> str:
    return "mach-belt" if PROJECT_INSTALL else "mach:belt"


def workflow_installed(project: Project) -> bool:
    if PROJECT_INSTALL:
        return (project.root / ".claude" / "workflows" / "mach-belt.js").is_file()
    return (SKILL_DIR.parent.parent / "workflows" / "belt.js").is_file()


def cmd_factory(project: Project, args: argparse.Namespace) -> int:
    """The Factory's lifecycle on this machine. Loaded only for these commands; nothing else touches it."""
    here = Path(__file__).resolve()
    sys.path.insert(0, str(here.parent))
    import activation
    import executor
    import supervisor as supervisor_module
    if args.action == "exec":  # the detached wrapper of one execution; internal
        return executor.wrapper(project.root, args.execution_id)
    if args.action == "wake":  # called by Git hooks; must never fail or print
        supervisor_module.wake(project.root, args.event)
        return 0
    problem, line = None, None
    try:
        _, line = factory(project)
    except RunError as exc:
        problem = str(exc)
    if line is None and args.action != "status":
        raise RunError(problem or "Product intake is not available.")
    sup = supervisor_module.Supervisor(project.root, project.config, line, next_step=lambda ticket_id: next_step(project, ticket_id, True),
                                       audit=project.audit, git=git, run_script=here, workflow=workflow_name())
    ctx = activation.Context(project.root, project.config, line, sup, git, project.audit, here, workflow_installed(project), problem)
    try:
        if args.action == "status":
            result = activation.status(ctx)
        elif args.action == "enable":
            result = activation.enable(ctx, args)
        elif args.action == "pause":
            result = activation.pause(ctx)
        elif args.action == "resume":
            result = activation.resume(ctx, args)
        elif args.action == "disable":
            result = activation.disable(ctx, args)
        elif args.action == "stop":
            result = activation.stop(ctx, args)
        elif args.action == "tick":
            result = sup.once()
        else:
            result = sup.serve(interval=args.interval, max_ticks=args.max_ticks)
    except (activation.ActivationError, supervisor_module.SupervisorError) as exc:
        raise RunError(str(exc))
    except Exception as exc:
        if exc.__class__.__name__ in ("IntakeError", "PolicyError", "ServiceError"):
            raise RunError(str(exc))
        raise
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 1 if args.action == "enable" and not result.get("ready", True) and not result.get("enabled") else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MACH conveyor belt: what happens next to a ticket.")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("next", help="the next step for one ticket")
    p.add_argument("ticket_id")
    p.add_argument("--headless", action="store_true", help="no person is available to answer questions")
    p.set_defaults(func=cmd_next)
    p = sub.add_parser("where", help="print where this script and the project are, for the workflow")
    p.set_defaults(func=cmd_where)
    p = sub.add_parser("board", help="the next step for every open ticket and cell")
    p.add_argument("--headless", action="store_true")
    p.set_defaults(func=cmd_board)
    for name, func, text in (("review-start", cmd_review_start, "start the review round and print one prompt per seat"),
                             ("review-tally", cmd_review_tally, "count the review votes")):
        p = sub.add_parser(name, help=text)
        p.add_argument("ticket_id")
        p.set_defaults(func=func)
    product = sub.add_parser("product", help="approved product work: take it in, plan it, dispatch it").add_subparsers(dest="action", required=True)
    product.add_parser("status", help="approved waves on the integration branch against the intake ledger; reads only").set_defaults(func=cmd_product)
    p = product.add_parser("intake", help="take approved delivery waves in: one ticket per new slice")
    p.add_argument("--dry-run", action="store_true", help="show what would be taken in; change nothing")
    p.add_argument("--fetch", action="store_true", help="fetch from the shared repository first (never changes the checkout)")
    p.add_argument("--adopt", action="append", metavar="SLICE-ID=TICKET-ID", help="use an existing ticket for a slice instead of filing one")
    p.add_argument("--reissue", action="append", metavar="SLICE-ID", help="file a fresh ticket for a slice whose ticket was abandoned")
    p.set_defaults(func=cmd_product)
    product.add_parser("plan", help="the dependency-aware execution plan; reads only").set_defaults(func=cmd_product)
    p = product.add_parser("reconcile", help="intake and a recorded plan in one locked step; never dispatches")
    p.add_argument("--fetch", action="store_true", help="fetch from the shared repository first (never changes the checkout)")
    p.set_defaults(func=cmd_product)
    p = product.add_parser("dispatch", help="open the cells for ready slices; starts no agent")
    p.add_argument("slice_ids", nargs="*")
    p.add_argument("--ready", action="store_true", help="every slice the plan marks dispatchable")
    p.add_argument("--limit", type=int, help="dispatch at most this many")
    p.set_defaults(func=cmd_product)
    p = product.add_parser("events", help="the intake ledger's transitions, in order")
    p.add_argument("--since", type=int, default=0, help="only events after this sequence number")
    p.set_defaults(func=cmd_product)

    fac = sub.add_parser("factory", help="the Factory on this machine: status, enable, pause, resume, disable").add_subparsers(dest="action", required=True)
    fac.add_parser("status", help="what is in force here; changes nothing").set_defaults(func=cmd_factory)
    p = fac.add_parser("enable", help="preflight and a confirmation code; with --confirm, enable")
    p.add_argument("--autonomy", choices=("observe", "supervised"), default="observe")
    p.add_argument("--confirm", metavar="CODE", help="the code the first enable printed, after a person has agreed")
    p.add_argument("--max-parallel", type=int)
    p.add_argument("--max-minutes", type=int, help="stop one execution after this many minutes")
    p.add_argument("--max-runs-per-day", type=int)
    p.add_argument("--budget-per-run", type=float, help="spending limit for one execution, in US dollars")
    p.add_argument("--budget-per-day", type=float)
    p.add_argument("--max-attempts", type=int)
    p.add_argument("--poll-seconds", type=int)
    p.add_argument("--max-risk", choices=("Low", "Medium", "High"), help="tickets above this risk tier wait for a person")
    p.add_argument("--allow-merge", action="store_true", help="let unattended runs reach the merge station (the project's merge settings still apply)")
    p.add_argument("--allow-tool", action="append", metavar="TOOL", help="one more tool an execution may use, such as 'Bash(make test)'")
    p.add_argument("--auto-sync", action="store_true", help="fetch from the shared repository on a timer")
    p.add_argument("--hooks", action="store_true", help="add advisory wake-up notes to this repository's Git hooks")
    p.add_argument("--persistent", action="store_true", help="install a per-user service that runs the supervisor without a Claude session (macOS)")
    backlog = p.add_mutually_exclusive_group()
    backlog.add_argument("--include-backlog", action="store_true", help="automatic execution includes work that was already here")
    backlog.add_argument("--exclude-backlog", action="store_true", help="work that was already here is left to the engineer")
    p.set_defaults(func=cmd_factory)
    fac.add_parser("pause", help="dispatch and start nothing new").set_defaults(func=cmd_factory)
    p = fac.add_parser("resume", help="check readiness again, then continue")
    p.add_argument("--retry", action="append", metavar="TICKET", help="a ticket waiting for a person that may be run again")
    p.add_argument("--retry-all", action="store_true")
    p.set_defaults(func=cmd_factory)
    p = fac.add_parser("disable", help="revoke automatic execution on this machine")
    p.add_argument("--stop", action="store_true", help="also stop executions that are running now")
    p.set_defaults(func=cmd_factory)
    p = fac.add_parser("stop", help="emergency stop: end running executions now, and pause")
    p.add_argument("--execution", help="only this execution")
    p.set_defaults(func=cmd_factory)
    fac.add_parser("tick", help="one supervisor pass").set_defaults(func=cmd_factory)
    p = fac.add_parser("serve", help="run the supervisor until the Factory is disabled here")
    p.add_argument("--interval", type=int, help="seconds between passes (default: the policy's poll_seconds)")
    p.add_argument("--max-ticks", type=int, help=argparse.SUPPRESS)
    p.set_defaults(func=cmd_factory)
    p = fac.add_parser("exec", help=argparse.SUPPRESS)
    p.add_argument("execution_id")
    p.set_defaults(func=cmd_factory)
    p = fac.add_parser("wake", help=argparse.SUPPRESS)
    p.add_argument("--event", default="manual")
    p.set_defaults(func=cmd_factory)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        root = args.project.resolve() if args.project else find_project(Path.cwd())
        if args.command == "factory" and getattr(args, "action", None) == "wake" and not (root / ".factory").is_dir():
            return 0  # a hook fired somewhere MACH is not: stay silent
        if args.command != "where" and not (root / ".factory").is_dir():
            raise RunError(f"{root} is not a MACH project (it has no .factory folder). Run this from the project's folder, or pass --project.")
        return args.func(Project(root), args)
    except RunError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
