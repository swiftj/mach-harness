#!/usr/bin/env python3
"""MACH conveyor belt: decide what happens next to a ticket.

Every station records where it left a ticket (the cell's stage, the audit report, the
verification and review decisions). This script reads those records and names the single next
step, who should do it, and on which model, so the order of the factory is decided by a script
and not by whoever is driving it.

    run.py next <ticket> [--headless] [--holder H|new] [--take-over]
                                         the next step for one ticket; with a holder, the step is claimed for it
    run.py status [--headless]            the next step for every open ticket and cell, and who is working on one now
    run.py explain <ticket> [--json]     why a ticket failed, was sent back or is waiting; reads only (explain.py)
    run.py decide [<ticket>...] [--json] each ticket waiting on a person, with the options it really has; reads only (decide.py)
    run.py doctor [--fix] [--json]       check the machine and the project; works before .factory exists (doctor.py)
    run.py schedule <ticket>... [--running <ticket>...] [--limit n] [--sequential] [--by-person] [--dry-run] [--holder H]
                                         which tickets may start now and why the others wait; reads only (schedule.py)
    run.py review-start <ticket>         start the review round; prints one ready prompt per reviewer seat
    run.py review-tally <ticket>         count the review votes
    run.py where                         where this script and the project are (used by the workflow)
    run.py product status                approved product work on the integration branch, against what was taken in
    run.py product intake [--dry-run]    take approved delivery waves in: one ticket per new slice, never twice
    run.py product plan                  the dependency-aware plan: what is ready, blocked, active or done, and why
    run.py product dispatch <slice>...   open the cells for chosen ready slices (or --ready); starts nothing
    run.py product events [--since N]    the intake ledger's transitions, for a supervisor or a dashboard
    run.py product resolve <slice> --supersede-in-work "<why>"
                                         a person's decision: the revision in work is superseded, the new one gets a ticket
    run.py product reconcile [--fetch]   intake and a recorded plan in one locked step; never dispatches
    run.py release status                release-readiness snapshots so far, and what a new one would evaluate
    run.py release qualify <WAVE>...     evaluate the integration branch at one commit; write .factory/release/<id>/readiness.json
    run.py release show <release-id>     a readiness snapshot, its exceptions and when it was taken
    run.py release except ...            a person's exception for one check at the snapshot's commit; only on their explicit word
    run.py factory status                what is in force on this machine and what the supervisor is doing; changes nothing
    run.py factory enable ...            preflight and a confirmation code; with --confirm, enable. Never a side effect
    run.py factory pause | resume | disable | stop
    run.py factory serve                 the supervisor: ticks until the Factory is disabled here
    run.py factory tick                  one supervisor pass

A step is either work ("action": audit, groom, plan, build, revise, verify, review, merge, cleanup)
or a stop ("action": "stop") with the reason and what it is waiting for: a person's answers, a
person's approval, a merge, or a person to take over an escalated ticket.

`next`, `status` and `explain` also carry a "digest": where the ticket stands, what a person must decide,
and time and cost. Time comes from the cell's own records; a cost appears only where one was recorded for
the ticket (the intake ledger's supervised executions), otherwise the text "not recorded". It is never estimated.

A ticket a person names may be a bare number: `4` or `104` resolves to the one known ticket with that
number (open cells, local tickets, the inbox, or the tracker's own numbering). The resolved ID is reported
as "resolved_from"; more than one match is refused with the candidates, and a full ID is never reinterpreted.

One worker per ticket: `next --holder H` claims the work step it names for H (claim.py, beside the intent
station's scripts), and answers `stop` with `needs: "worker-in-cell"` while another holder's claim is fresh.
Without a holder it writes nothing and is refused the same way. A stop is never claimed. `where` prints a new
holder each time. `--take-over` replaces a fresh claim, only on a person's explicit word.

Standard library only. It reads; the only commands it runs are git queries and the review
station's own script. The product commands are the exception and live in intake.py: on an
engineer's explicit command they file tickets and open cells through the ticket and intent
stations' own scripts. Nothing here starts an agent, and nothing runs in the background.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

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


_CLEANUP: List[Any] = []


def cleanup_station() -> Any:
    """The cleanup station's script, loaded once, whichever way MACH is installed."""
    if not _CLEANUP:
        import importlib.util
        spec = importlib.util.spec_from_file_location("mach_cleanup_station", sibling("cleanup") / "scripts" / "cleanup.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _CLEANUP.append(module)
    return _CLEANUP[0]


_CLAIMS: List[Any] = []


def claims() -> Any:
    """The shared claim helper (the intent station's claim.py), loaded once, whichever way MACH is installed."""
    if not _CLAIMS:
        import importlib.util
        spec = importlib.util.spec_from_file_location("mach_claim", sibling("intent") / "scripts" / "claim.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _CLAIMS.append(module)
    return _CLAIMS[0]


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

    def observe_status(self) -> Dict[str, Any]:
        """Whether an observe pass is due, as the cleanup station decides it: the one source for cleanup, the status command and the supervisor."""
        return cleanup_station().observe_due(self.root)

    def observe_due(self) -> bool:
        """Whether enough tickets have finished since the last observe pass for another one."""
        return bool(self.observe_status().get("due"))

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
            return step(ticket_id, stage, "revise", ("A person sent this build back." if decision.get("rejected_by") == "a person" else "The merge station sent this build back." if decision.get("rejected_by") else "Review rejected this build."), agent_type=agent_type("builder"), findings=decision.get("findings"),
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


NUMBERED_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*-0*(\d+)$")
NATIVE_NUMBER_PROVIDERS = ("github", "gitea")  # trackers whose own ticket ID is the issue number itself


def resolve_ticket(given: str, known: Iterable[str], native_numbers: bool = False) -> Tuple[str, Optional[str]]:
    """A bare number a person typed, resolved to the one known ticket with that number; anything else is returned unchanged.

    Returns (ticket ID, what was typed) when a number was resolved to a different ID, else (given, None). A full ID, or a
    number that is itself a known ID, is never reinterpreted. No match, or more than one, is refused: nothing is guessed."""
    if not re.fullmatch(r"\d+", given or ""):
        return given, None
    names = set(known)
    if given in names:
        return given, None
    number = int(given)
    matches = {name for name in names if (found := NUMBERED_ID_RE.match(name)) and int(found.group(1)) == number}
    if native_numbers:
        matches.add(str(number))
    if not matches:
        raise RunError(f"No known ticket has the number {given}: no open cell, local ticket or inbox record matches it. Use the ticket's full ID.")
    if len(matches) > 1:
        raise RunError(f"{given} could be more than one ticket: {', '.join(sorted(matches))}. Use the full ID; nothing was done.")
    found_id = matches.pop()
    return found_id, (given if found_id != given else None)


def known_tickets(project: Project) -> List[str]:
    """Every ticket ID this project knows locally: open cells, local tickets and inbox records."""
    factory = project.root / ".factory"
    names = [path.name for path in (factory / "worktrees").iterdir() if path.is_dir()] if (factory / "worktrees").is_dir() else []
    names += [path.stem for path in (factory / "tickets").glob("*.md")] if (factory / "tickets").is_dir() else []
    names += [path.stem for path in (factory / "inbox").glob("*.json")] if (factory / "inbox").is_dir() else []
    return sorted({name for name in names if TICKET_ID_RE.match(name)})


def resolve_args(project: Project, args: argparse.Namespace) -> Optional[str]:
    """Resolve the ticket a person named on a per-ticket command; returns what they typed when it was a bare number."""
    given = getattr(args, "ticket_id", None)
    if not isinstance(given, str):
        return None
    provider = os.environ.get("ISSUE_PROVIDER") or project.section("tickets").get("provider") or "local"
    args.ticket_id, resolved_from = resolve_ticket(given, known_tickets(project), provider in NATIVE_NUMBER_PROVIDERS)
    return resolved_from


NEEDS_TEXT = {
    "answers": "Answer the spec's open questions in the grooming interview.",
    "human-approval": "Approve the change, or not, after reading the review findings.",
    "merge": "Merge the approved branch; the project's settings keep merging for a person.",
    "person-to-take-over": "Take over the escalated ticket: it used all its judging rounds.",
    "repository-hardening": "Harden the repository first: its readiness tier is Bronze.",
    "person": "Dispatch this ticket on its own.",
    "worker-in-cell": "Another worker is already on this ticket's step: wait for it to finish, or say to take over.",
}


def parse_time(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def elapsed(project: Project, ticket_id: str) -> Optional[float]:
    """Seconds from the cell's first record to its last: the lifecycle log, else cell.json's own timestamps. None when neither exists."""
    cellroot = project.cell_dir(ticket_id)
    moments = []
    try:
        lines = (cellroot / "lifecycle.jsonl").read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        lines = []
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        moment = parse_time(record.get("at")) if isinstance(record, dict) else None
        if moment:
            moments.append(moment)
    if len(moments) < 2:
        cell = load_json(cellroot / "cell.json", {}) or {}
        moments = [moment for moment in (parse_time(cell.get("created_at")), parse_time(cell.get("updated_at"))) if moment] if isinstance(cell, dict) else []
    if len(moments) < 2:
        return None
    return max((max(moments) - min(moments)).total_seconds(), 0.0)


def duration_text(seconds: Optional[float]) -> str:
    if seconds is None:
        return "time not recorded"
    minutes = int(seconds // 60)
    if minutes < 1:
        return "under a minute recorded"
    hours, minutes = divmod(minutes, 60)
    days, hours = divmod(hours, 24)
    parts = ([f"{days} d"] if days else []) + ([f"{hours} h"] if hours else []) + ([f"{minutes} min"] if minutes else [])
    return " ".join(parts) + " recorded"


def recorded_cost(project: Project, ticket_ids: Sequence[str]) -> Dict[str, Any]:
    """Cost exactly as recorded for these tickets: the supervised executions in the intake ledger that report one.
    Nothing else is a record of cost here; work a person drove has none. Never estimated, never derived from tokens."""
    ledger = load_json(project.root / ".factory" / "intake" / "ledger.json", {}) or {}
    executions = ((ledger.get("supervisor") or {}).get("executions") or {}) if isinstance(ledger, dict) else {}
    total, counted, without = 0.0, 0, 0
    for record in executions.values() if isinstance(executions, dict) else []:
        if not isinstance(record, dict) or record.get("ticket_id") not in ticket_ids:
            continue
        cost = record.get("cost_usd")
        if isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost >= 0:
            total, counted = total + float(cost), counted + 1
        else:
            without += 1
    if not counted:
        return {"cost_usd": None, "text": "not recorded"}
    text = f"${total:.2f} recorded over {counted} execution{'s' if counted != 1 else ''}"
    if without:
        text += f" ({without} more with no cost recorded)"
    return {"cost_usd": round(total, 6), "text": text}


def digest(project: Project, info: Dict[str, Any]) -> Dict[str, Any]:
    """Three lines for the top of a ticket's status: where it is, what a person must decide, time and cost."""
    ticket_id, stage, action = info.get("ticket_id"), info.get("stage"), info.get("action")
    place = f"stage {stage}" if stage else "no cell yet"
    where = f"{ticket_id}: {place}; " + (f"stopped: {info.get('reason')}" if info.get("stop") else f"next: {action}. {info.get('reason')}")
    needs = info.get("needs") if info.get("stop") else None
    if needs and needs != "nothing":
        decide = NEEDS_TEXT.get(needs, f"A person is needed ({needs}).")
    elif info.get("interactive"):
        decide = "Answer the grooming interview, one question at a time."
    else:
        decide = "Nothing"
    seconds = elapsed(project, ticket_id) if isinstance(ticket_id, str) and TICKET_ID_RE.match(ticket_id) else None
    cost = recorded_cost(project, [ticket_id])
    return {"where": where, "needs_person": decide, "time_and_cost": f"{duration_text(seconds)}; cost {cost['text']}",
            "elapsed_seconds": seconds, "cost_usd": cost["cost_usd"]}


def status_digest(project: Project, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    ready = [row for row in rows if row["action"] != "stop" and "claim" not in row]
    worked = [row for row in rows if "claim" in row]
    waiting = [row for row in rows if row["action"] == "stop" and row.get("needs") not in (None, "nothing")]
    where = f"{len(rows)} ticket{'s' if len(rows) != 1 else ''}: {len(ready)} ready to run, {len(waiting)} waiting on a person"
    if worked:
        where += f", {len(worked)} with a worker on it now"
    decide = "; ".join(f"{row['ticket_id']}: {NEEDS_TEXT.get(row['needs'], row['needs'])}" for row in waiting) or "Nothing"
    cost = recorded_cost(project, [row["ticket_id"] for row in rows])
    return {"where": where, "needs_person": decide, "time_and_cost": f"time per ticket: see its next step; cost {cost['text']}",
            "elapsed_seconds": None, "cost_usd": cost["cost_usd"]}


def cmd_where(project: Project, args: argparse.Namespace) -> int:
    print(json.dumps({"run_script": str(Path(__file__).resolve()), "project": str(project.root), "python": sys.executable,
                      "is_mach_project": (project.root / ".factory").is_dir(), "holder": claims().new_holder()}, indent=2))
    return 0


EXECUTION_ENV = "MACH_EXECUTION_ID"  # set by the Factory's executor on every supervised run, inherited by its shell commands
EXECUTION_ID_RE = re.compile(r"^x[0-9a-f]{12}$")


def execution_scope(project: Project) -> Optional[str]:
    """Inside a supervised Factory execution, the one ticket it was started for; None when a person drives.

    The ticket is read from the intake ledger, where the supervisor recorded the execution when it claimed
    the work under the machine's authorization. An execution the ledger does not know may work on nothing."""
    value = os.environ.get(EXECUTION_ENV)
    if not value:
        return None
    record = None
    if EXECUTION_ID_RE.match(value):
        ledger = load_json(project.root / ".factory" / "intake" / "ledger.json", {}) or {}
        record = (((ledger.get("supervisor") or {}).get("executions") or {}).get(value) or {}) if isinstance(ledger, dict) else {}
    ticket = record.get("ticket_id") if isinstance(record, dict) else None
    if not isinstance(ticket, str) or not TICKET_ID_RE.match(ticket):
        raise RunError(f"This runs inside Factory execution '{value}', which the intake ledger does not record, so it may work on no ticket.")
    return ticket


def out_of_scope(project: Project, ticket_id: str) -> Optional[Dict[str, Any]]:
    """The refusal for a ticket outside the supervised execution's own, or None."""
    scope = execution_scope(project)
    if scope is None or scope == ticket_id:
        return None
    return {"ticket_id": ticket_id, "stage": None, "action": "stop", "stop": True, "needs": "person",
            "reason": f"This Factory execution was started for {scope} only. {ticket_id} needs its own dispatch; nothing was done to it."}


def cmd_next(project: Project, args: argparse.Namespace) -> int:
    refused = out_of_scope(project, args.ticket_id)
    if refused:
        print(json.dumps(refused, indent=2, ensure_ascii=False))
        return 1
    holder, made = getattr(args, "holder", None), False
    take_over = bool(getattr(args, "take_over", False))
    if holder == "new" or (holder is None and take_over):
        holder, made = claims().new_holder(), True
    elif holder is not None and not claims().valid_holder(holder):
        raise RunError("--holder takes 'new' or the holder token an earlier answer printed (hex).")
    found = next_step(project, args.ticket_id, args.headless)
    if found.get("action") == "cleanup" and execution_scope(project):
        found["prompt"] = (str(found.get("prompt") or "") + "\nThis is a supervised Factory execution for this ticket only: do not run the observe skill, "
                           "even if cleanup says an observe pass is due. The supervisor reports a due pass to a person.")
    found = claim_step(project, found, holder, take_over)
    if made:
        found["holder"] = holder
    shown = {"digest": digest(project, found), **found}  # the digest first; every field the belt reads is unchanged
    if getattr(args, "resolved_from", None):
        shown["resolved_from"] = args.resolved_from
    print(json.dumps(shown, indent=2, ensure_ascii=False))
    return 0


def claim_step(project: Project, found: Dict[str, Any], holder: Optional[str], take_over: bool) -> Dict[str, Any]:
    """One worker per ticket (claim.py). A work step is claimed for `holder`, or its own claim renewed; another
    holder's fresh claim turns the answer into a stop (`worker-in-cell`) that does not show that holder. With no
    holder nothing is written, and the answer is refused the same way while any claim is fresh. A stop is never
    claimed, and a ticket with no cell has nothing to claim. A claim that cannot be written is refused: the step
    is not handed out."""
    if found.get("stop"):
        return found
    ticket_id = found["ticket_id"]
    root = project.cell_dir(ticket_id)
    C = claims()
    if C.stage_of(root) is None:
        return found
    limit = C.minutes(project.config)

    def refused(other: Dict[str, Any]) -> Dict[str, Any]:
        return step(ticket_id, found.get("stage"), "stop", C.in_words(other, limit) + " Do not start another worker on it. A person can say to take over this step.",
                    needs="worker-in-cell", other_claim=C.public(other, limit))

    if holder is None:
        other = C.current(root, limit)
        return refused(other) if other else found
    try:
        result = C.take(root, found["action"], holder, limit, take_over=take_over)
    except (C.ClaimError, OSError) as exc:
        raise RunError(f"The claim on this step could not be recorded ({exc}), so the step was not handed out.")
    if result["refused"]:
        return refused(result["refused"])
    found = dict(found, claim=C.shown(result["claim"], limit))
    if result["replaced"]:
        before = C.public(result["replaced"], limit)
        found["took_over"] = before
        found["reason"] = (f"{found['reason']} Taken over, as a person asked: another worker had been handed the {before['step']} step "
                           f"at {before['at']}; its claim is replaced.")
    if found.get("action") == "plan" and found.get("prompt"):
        found["prompt"] += (f"\nThis step is claimed for holder {holder}: when the skill claims the plan step, pass --holder {holder}.")
    return found


def cmd_explain(project: Project, args: argparse.Namespace) -> int:
    """Why a ticket failed, was sent back or is waiting (explain.py). Reads only: writes, records and starts nothing."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import explain
    found = next_step(project, args.ticket_id, False)
    report, code = explain.explain(project.root, args.ticket_id, found, project.config)
    report = {"digest": digest(project, found), **report}
    if getattr(args, "resolved_from", None):
        report["resolved_from"] = args.resolved_from
    print(json.dumps(report, indent=2, ensure_ascii=False) if args.json else explain.human(report))
    return code


def cmd_decide(project: Project, args: argparse.Namespace) -> int:
    """Each ticket waiting on a person, with the options its stations really accept (decide.py). Reads only: writes,
    claims, records and starts nothing. It is a person's walkthrough, so it never runs inside a supervised execution."""
    scope = execution_scope(project)
    if scope is not None:
        raise RunError(f"This Factory execution was started for {scope} only, and nobody is here to decide: the walkthrough of decisions is for a person.")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import decide
    provider = os.environ.get("ISSUE_PROVIDER") or project.section("tickets").get("provider") or "local"
    known, resolved, ticket_ids = known_tickets(project), {}, []
    for given in args.ticket_ids:
        ticket_id, typed = resolve_ticket(given, known, provider in NATIVE_NUMBER_PROVIDERS)
        if not TICKET_ID_RE.match(ticket_id):
            raise RunError(f"'{given}' is not a usable ticket ID.")
        if typed:
            resolved[typed] = ticket_id
        ticket_ids.append(ticket_id)
    try:
        report = decide.main(ticket_ids, project.root, config=project.config, next_step=lambda ticket_id: next_step(project, ticket_id, False),
                             intent_skill=skill("intent"))
    except decide.DecideError as exc:
        raise RunError(str(exc))
    if resolved:
        report["resolved_from"] = {ticket_id: typed for typed, ticket_id in resolved.items()}
    print(json.dumps(report, indent=2, ensure_ascii=False) if args.json else decide.human(report))
    return 0


def cmd_doctor(root: Path, args: argparse.Namespace) -> int:
    """The doctor (doctor.py), loaded only when asked for. Reachable before the project has a .factory folder."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import doctor
    except ModuleNotFoundError as exc:
        if exc.name != "doctor":
            raise
        raise RunError(f"The doctor is not installed next to this script ({Path(__file__).resolve().parent / 'doctor.py'}).")
    return doctor.main([*(["--fix"] if args.fix else []), *(["--json"] if args.json else [])], project=root)


def cmd_schedule(project: Project, args: argparse.Namespace) -> int:
    """Which of several tickets may start now, and why the others wait (schedule.py). Reads only: starts and writes nothing."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import schedule
    provider = os.environ.get("ISSUE_PROVIDER") or project.section("tickets").get("provider") or "local"
    known, resolved = known_tickets(project), {}

    def resolve(names: Sequence[str]) -> List[str]:
        found = []
        for given in names:
            ticket_id, typed = resolve_ticket(given, known, provider in NATIVE_NUMBER_PROVIDERS)
            if not TICKET_ID_RE.match(ticket_id):
                raise RunError(f"'{given}' is not a usable ticket ID.")
            if typed:
                resolved[typed] = ticket_id
            found.append(ticket_id)
        return found

    args.ticket_ids, args.running = resolve(args.ticket_ids), resolve(args.running or [])
    if getattr(args, "holder", None) is not None and not claims().valid_holder(args.holder):
        raise RunError("--holder takes the holder token an earlier answer printed (hex).")
    scope = execution_scope(project)
    beside: List[str] = []
    if scope is not None:
        others = [ticket_id for ticket_id in args.ticket_ids if ticket_id != scope]
        if others:
            raise RunError(f"This Factory execution was started for {scope} only. {', '.join(others)} need(s) their own dispatch; nothing was scheduled.")
        # The supervisor's other executions run beside this one: the High-risk and file-overlap rules count them.
        ledger = load_json(project.root / ".factory" / "intake" / "ledger.json", {}) or {}
        records = ((ledger.get("supervisor") or {}).get("executions") or {}) if isinstance(ledger, dict) else {}
        beside = sorted({record.get("ticket_id") for record in records.values() if isinstance(record, dict) and record.get("state") in ("claimed", "started")
                         and isinstance(record.get("ticket_id"), str) and TICKET_ID_RE.match(record["ticket_id"]) and record["ticket_id"] != scope})
    try:
        report = schedule.main(args, project.root, config=project.config, sibling=sibling, factory=lambda: factory(project)[1],
                               workflow=workflow_name(), supervised=scope, resolved=resolved, beside=beside, claims=claims())
    except schedule.ScheduleError as exc:
        raise RunError(str(exc))
    if resolved:
        report["resolved_from"] = {ticket_id: typed for typed, ticket_id in resolved.items()}
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


def cmd_status(project: Project, args: argparse.Namespace) -> int:
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
    scope = execution_scope(project)
    if scope is not None:
        ids = [ticket_id for ticket_id in ids if ticket_id == scope]  # a supervised execution sees only its own ticket
    rows = []
    C = claims()
    limit = C.minutes(project.config)
    for ticket_id in ids:
        info = next_step(project, ticket_id, args.headless)
        row = {key: info[key] for key in ("ticket_id", "stage", "action", "needs", "reason")}
        held = C.current(project.cell_dir(ticket_id), limit)
        if held:
            row["claim"] = C.public(held, limit)  # someone is working on it: the step and since when, never the holder
        rows.append(row)
    tuning = [row["ticket_id"] for row in rows if row["action"] != "stop" and "claim" not in row and "factory-tuning" in project.ticket_labels(row["ticket_id"])]
    due = project.observe_due()
    if scope is not None:
        # The observe pass and any tuning ticket it files are separate work: the supervisor, which alone dispatches, reports them.
        tuning, due = [], False
    print(json.dumps({"digest": status_digest(project, rows), "audit": project.audit(), "observe_due": due, "factory_tuning_ready": tuning, "scoped_to": scope, "tickets": rows,
                      "ready_to_run": [row["ticket_id"] for row in rows if row["action"] != "stop" and "claim" not in row],
                      "being_worked_on": [row["ticket_id"] for row in rows if "claim" in row],
                      "waiting_on_a_person": [row["ticket_id"] for row in rows if row["action"] == "stop"]}, indent=2, ensure_ascii=False))
    return 0


def review_script(project: Project, *argv: str) -> subprocess.CompletedProcess:
    script = sibling("review") / "scripts" / "review.py"
    return subprocess.run([sys.executable, str(script), "--project", str(project.root), *argv], capture_output=True, text=True)


def cmd_review_start(project: Project, args: argparse.Namespace) -> int:
    refused = out_of_scope(project, args.ticket_id)
    if refused:
        raise RunError(refused["reason"])
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
    refused = out_of_scope(project, args.ticket_id)
    if refused:
        raise RunError(refused["reason"])
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
                      **line.request_status_summary(), "factory_started": False}
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
        elif args.action == "resolve":
            result = line.resolve(args.slice_id, args.supersede_in_work)
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


def cmd_release(project: Project, args: argparse.Namespace) -> int:
    """Release qualification (qualify.py). It reads and measures; it lands, publishes and starts nothing."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import qualify
    _, line = factory(project)
    try:
        release = qualify.Release(project.root, project.config, line, sibling)
        if args.action == "status":
            result = release.status()
        elif args.action == "qualify":
            result = release.qualify(args.wave_ids, release_id=args.release, commit=args.commit)
        elif args.action == "show":
            result = release.show(args.release_id)
        else:
            result = release.record_exception(args.release, args.check, args.by, args.reason)
    except qualify.QualifyError as exc:
        raise RunError(str(exc))
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


def cmd_requests(project: Project, args: argparse.Namespace) -> int:
    """Monitoring requests (M8 D7), on an engineer's explicit command: take issues in and report. Starts no agent."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import monitoring
    _, line = factory(project)
    try:
        result = monitoring.Monitoring(project.root, project.config, line, sibling).take_in(dry_run=args.dry_run)
    except monitoring.MonitoringError as exc:
        raise RunError(str(exc))
    except Exception as exc:
        if exc.__class__.__name__ == "IntakeError":
            raise RunError(str(exc))
        raise
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 1 if result.get("problem") else 0


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
                                       audit=project.audit, git=git, run_script=here, workflow=workflow_name(), observe_due=project.observe_status,
                                       sibling=sibling)
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
    p.add_argument("--holder", metavar="H", help="claim the step for this holder: 'new' for a new one, then the token it printed")
    p.add_argument("--take-over", action="store_true", help="replace another worker's fresh claim; only on a person's explicit word")
    p.set_defaults(func=cmd_next)
    p = sub.add_parser("where", help="print where this script and the project are, for the workflow")
    p.set_defaults(func=cmd_where)
    p = sub.add_parser("status", help="the next step for every open ticket and cell")
    p.add_argument("--headless", action="store_true")
    p.set_defaults(func=cmd_status)
    p = sub.add_parser("explain", help="why a ticket failed, was sent back or is waiting; reads only")
    p.add_argument("ticket_id")
    p.add_argument("--json", action="store_true", help="the facts as JSON instead of a short list")
    p.set_defaults(func=cmd_explain)
    p = sub.add_parser("decide", help="each ticket waiting on a person, with the options it really has; reads only")
    p.add_argument("ticket_ids", nargs="*", metavar="ticket", help="only these tickets (default: every open ticket)")
    p.add_argument("--json", action="store_true", help="the options as JSON, for the run skill's walkthrough")
    p.set_defaults(func=cmd_decide)

    p = sub.add_parser("doctor", help="check the machine and the project; --fix only creates missing MACH folders")
    p.add_argument("--fix", action="store_true", help="create missing MACH folders; never edits settings or enables anything")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=None)
    p = sub.add_parser("schedule", help="which of several tickets may start now, and why the others wait; reads only")
    p.add_argument("ticket_ids", nargs="+", metavar="ticket")
    p.add_argument("--running", nargs="+", action="extend", metavar="ticket", help="tickets already running")
    p.add_argument("--limit", type=int, help="at most this many at once; never above the settings ceiling without --by-person")
    p.add_argument("--sequential", action="store_true", help="one ticket at a time")
    p.add_argument("--by-person", action="store_true", help="with --limit: a person raised the limit for this run (at most 8); refused in a supervised execution")
    p.add_argument("--dry-run", action="store_true", help="say so in the report; the command never starts anything either way")
    p.add_argument("--holder", metavar="H", help="the caller's holder token: a ticket another holder has a fresh claim on is held")
    p.set_defaults(func=cmd_schedule)
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
    p = product.add_parser("resolve", help="settle a slice whose newer revision waits behind work in progress; only on a person's explicit instruction")
    p.add_argument("slice_id")
    p.add_argument("--supersede-in-work", required=True, metavar="WHY", help="supersede the revision in work, recording why; its cell and ticket are left untouched")
    p.set_defaults(func=cmd_product)
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

    req = sub.add_parser("requests", help="issues filed by monitoring accounts: take them in; starts no agent").add_subparsers(dest="action", required=True)
    p = req.add_parser("monitor", help="take in the issues the project's monitoring accounts filed and labelled; reports, starts nothing")
    p.add_argument("--dry-run", action="store_true", help="show what would be taken in; write nothing")
    p.set_defaults(func=cmd_requests)

    rel = sub.add_parser("release", help="release qualification: is the integrated capability ready, at one commit").add_subparsers(dest="action", required=True)
    rel.add_parser("status", help="readiness snapshots so far; changes nothing").set_defaults(func=cmd_release)
    p = rel.add_parser("qualify", help="evaluate approved waves at one commit of the integration branch")
    p.add_argument("wave_ids", nargs="+", metavar="WAVE-ID")
    p.add_argument("--release", help="the release ID (default: the waves and the commit)")
    p.add_argument("--commit", help="a commit on the integration branch (default: its local head)")
    p.set_defaults(func=cmd_release)
    p = rel.add_parser("show", help="one readiness snapshot; changes nothing")
    p.add_argument("release_id")
    p.set_defaults(func=cmd_release)
    p = rel.add_parser("except", help="record a person's exception for one check, at the snapshot's commit")
    p.add_argument("--release", required=True)
    p.add_argument("--check", required=True, help="the check ID, as the snapshot lists it")
    p.add_argument("--by", required=True, help="the role of the person who decided, such as release-manager")
    p.add_argument("--reason", required=True)
    p.set_defaults(func=cmd_release)

    fac = sub.add_parser("factory", help="the Factory on this machine: status, enable, pause, resume, disable").add_subparsers(dest="action", required=True)
    fac.add_parser("status", help="what is in force here; changes nothing").set_defaults(func=cmd_factory)
    p = fac.add_parser("enable", help="preflight and a confirmation code; with --confirm, enable")
    p.add_argument("--autonomy", choices=("observe", "supervised"), default="observe")
    p.add_argument("--confirm", metavar="CODE", help="the code the first enable printed, after a person has agreed")
    p.add_argument("--accept-execution-risk", action="store_true",
                   help="with --confirm, for a mode that starts agents: the person has read the execution risk (no sandbox) and accepts it")
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
    p.add_argument("--monitoring-requests", action="store_true",
                   help="supervised only: also groom and build issues the project's monitoring accounts filed (only on the engineer's explicit request)")
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
        if args.command == "doctor":
            return cmd_doctor(root, args)  # before the .factory check: the doctor is how a project without one is set right
        if args.command != "where" and not (root / ".factory").is_dir():
            raise RunError(f"{root} is not a MACH project (it has no .factory folder). Run this from the project's folder, or pass --project.")
        project = Project(root)
        args.resolved_from = resolve_args(project, args)
        return args.func(project, args)
    except RunError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
