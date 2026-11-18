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
    run.py product status                slices marked ready (issues and folders) against what was taken in
    run.py product intake [--dry-run]    take ready slices in: each revision once; an issue is its own ticket
    run.py product import <folder>       take in a ready folder handed over outside Git (an engineer's command)
    run.py product plan                  the dependency-aware plan: what is ready, blocked, active or done, and why
    run.py product dispatch <slice>...   open the cells for chosen ready slices (or --ready); starts nothing
    run.py product events [--since N]    the intake ledger's transitions, for a supervisor or a dashboard
    run.py product reconcile [--fetch]   intake and a recorded plan in one locked step; never dispatches
    run.py pull [--limit n] [--sequential] [--dry-run] [--json]
                                         take in every slice marked ready, choose the next batch with the schedule and
                                         dispatch it; prints what starts, what waits and why, and the tickets to run (pull.py)
    run.py adr list                      every architecture decision: ID, title, status, applies-to, problems; reads only (adr.py)
    run.py adr new --title T --context C --decision D [--option O]... [--consequence X]... [--applies-to A]...
                                         write a new ADR as proposed in the main checkout's working tree; commits nothing
    run.py adr baseline                  the required topics, what covers them, and evidence from the committed files for each still
                                         to draft; recorded once in .factory/adr-baseline.json (baseline.py)
    run.py adr new ... --baseline TOPIC [--open-point P]...
                                         draft one of them as proposed, listing the recorded evidence; commits nothing
    run.py adr settle ADR-NNNN --point N --answer A [--decision D] [--not-decided]
                                         record the engineer's answer to one open point of a proposed draft; commits nothing
    run.py adr accept ADR-NNNN... --by NAME
                                         a person sets proposed ADRs in the working tree to accepted; commits nothing
    run.py release status                release-readiness snapshots so far, and what a new one would evaluate
    run.py release qualify --epic E | <SLICE>...
                                         evaluate an epic or named slices at one commit; write .factory/release/<id>/readiness.json
    run.py release show <release-id>     a readiness snapshot, its exceptions and when it was taken
    run.py release except ...            a person's exception for one check at the snapshot's commit; only on their explicit word
    run.py factory status                what is in force on this machine and what the supervisor is doing; changes nothing
    run.py factory enable ...            preflight and a confirmation code; with --confirm, enable. Never a side effect
    run.py factory pause | resume | disable | stop
    run.py factory serve                 the supervisor: ticks until the Factory is disabled here
    run.py factory tick                  one supervisor pass
    run.py notify [status]               whether a waiting ticket is announced to a channel from this machine; changes nothing
    run.py notify set --from-file PATH | --from-env NAME [--label WORDS]
                                         store the channel's address (never taken on the command line); sends nothing
    run.py notify banner on|off [--label WORDS]
                                         a macOS Notification Center banner on this Mac, beside or instead of the webhook
    run.py notify test | off             one test message on each channel that is on; remove the stored address (the banner stays)

`next <ticket> --headless` that stops for a person sends one message on each channel on for this machine (notify.py),
once per wait, and never inside a supervised execution. No other command here sends or reads the address.

A step is either work ("action": audit, groom, plan, build, revise, verify, review, merge, cleanup)
or a stop ("action": "stop") with the reason and what it is waiting for: a person's answers, a
person's approval, a merge, or a person to take over an escalated ticket; or an engineer's decision
about an architecture decision record (ADR): a plan that cannot follow one (adr-decision), a High-risk
ticket's own proposal waiting to be accepted (adr-acceptance), an ADR on main that cannot be read (adr-fix), or a
required topic (adr.required_topics) with no accepted ADR on main, so nothing is planned yet (adr-baseline).
ADRs accepted or changed after a ticket was planned are flagged in the digest and the status rows, never acted on.

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
# Installed into a project, skills are folders named mach-<station> (this one is plain mach, the command /mach)
# and agents mach-<name>; as a plugin they are <station> and mach:<name>.
PROJECT_INSTALL = SKILL_DIR.name == "mach" or SKILL_DIR.name.startswith("mach-")


class RunError(Exception):
    """A problem the caller can fix; printed without a traceback."""


def skill(name: str) -> str:
    if PROJECT_INSTALL:
        return "/mach" if name == "run" else f"/mach-{name}"
    return f"/mach:{name}"


def agent_type(name: str) -> str:
    return f"mach-{name}" if PROJECT_INSTALL else f"mach:{name}"


def sibling(name: str) -> Path:
    """Another station's skill folder, whichever way MACH is installed."""
    for candidate in (SKILL_DIR.parent / ("mach" if name == "run" else f"mach-{name}"), SKILL_DIR.parent / name):
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


_ADR: List[Any] = []


def adrs() -> Any:
    """The shared architecture-decision helper (the intent station's adr.py), loaded once, whichever way MACH is installed."""
    if not _ADR:
        import importlib.util
        spec = importlib.util.spec_from_file_location("mach_adr", sibling("intent") / "scripts" / "adr.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _ADR.append(module)
    return _ADR[0]


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
        waiting = handed_over(project, ticket_id)
        if waiting:
            return step(ticket_id, None, "stop", f"{waiting} was handed over by Product Studio and is not groomed again. It waits to be dispatched "
                        f"(product dispatch {waiting}), which the Factory does on an enabled machine.", needs="dispatch")
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
        question = cell.get("spec_question")
        if isinstance(question, dict):
            return step(ticket_id, stage, "stop", "The contract engineer found a defect in the spec that only the product manager can settle. "
                        "The question is on the slice's issue; their answer comes back as a new revision of the slice.", needs="product-answer")
        conflict = cell.get("adr_conflict")
        if isinstance(conflict, dict):
            return step(ticket_id, stage, "stop", f"The plan cannot follow {conflict.get('adr')}, an accepted architecture decision: {conflict.get('reason')}",
                        needs="adr-decision", adr=conflict.get("adr"))
        problems = adrs().main_listing(project.root, project.config)["problems"]
        if problems:
            return step(ticket_id, stage, "stop", f"An architecture decision record on the main branch cannot be read, so the ticket cannot be planned under it: {problems[0]}"
                        + (f" ({len(problems) - 1} more)" if len(problems) > 1 else ""), needs="adr-fix")
        baseline = adrs().baseline_stop(project.root, project.config, project.ticket_labels(ticket_id))
        if baseline:
            return step(ticket_id, stage, "stop", baseline["reason"], needs="adr-baseline", missing_topics=baseline["missing"], command=baseline["command"])
        return step(ticket_id, stage, "plan", "The spec is ready; contracts and the plan are not written yet.", model=project.model("contracts"),
                    prompt=f"Use the MACH intent skill to finish stage 2 (contracts and plan) for this ticket: {skill('intent')} {ticket_id}{flag}")

    if stage == "planned" and cell.get("risk") == "High":
        waiting = adrs().pending_acceptance(cell)
        if waiting:
            return step(ticket_id, stage, "stop", f"This High-risk ticket's plan proposes a new architecture decision ({', '.join(waiting)}); "
                        "the build waits until an engineer accepts it.", needs="adr-acceptance", adrs=waiting)
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


def handed_over(project: Project, ticket_id: str) -> Optional[str]:
    """The slice a ticket carries when the intake ledger took it in from Product Studio and it has no cell yet."""
    ledger = load_json(project.root / ".factory" / "intake" / "ledger.json", {}) or {}
    slices = ledger.get("slices") if isinstance(ledger, dict) and ledger.get("schema_version") == 2 else None
    for slice_id, entry in (slices or {}).items():
        if (isinstance(entry, dict) and str(entry.get("ticket_id")) == ticket_id and not entry.get("pending_ticket") and not entry.get("integrated")
                and not entry.get("dispatched_at")):
            return slice_id
    return None


def known_tickets(project: Project) -> List[str]:
    """Every ticket ID this project knows locally: open cells, local tickets, inbox records and the intake ledger's tickets."""
    factory = project.root / ".factory"
    ledger = load_json(factory / "intake" / "ledger.json", {}) or {}
    slices = ledger.get("slices") if isinstance(ledger, dict) and isinstance(ledger.get("slices"), dict) else {}
    names = [str(entry.get("ticket_id")) for entry in slices.values() if isinstance(entry, dict) and entry.get("ticket_id")]
    names += [path.name for path in (factory / "worktrees").iterdir() if path.is_dir()] if (factory / "worktrees").is_dir() else []
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
    "dispatch": "Dispatch this slice (product dispatch), or let the Factory do it on an enabled machine.",
    "product-answer": "The product manager answers the builders' question in Product Studio and marks the slice ready again.",
    "adr-decision": "Decide about an architecture decision the plan cannot follow: record an exception, or supersede the ADR and plan again.",
    "adr-acceptance": "Accept the architecture decision this High-risk ticket proposes, or not: the build waits for it.",
    "adr-fix": "Fix an architecture decision record the factory cannot read, by pull request.",
    "adr-baseline": "Write down the project's basic technical decisions as accepted ADRs (adr baseline drafts them); no ticket is planned until then.",
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
    shown = {"where": where, "needs_person": decide, "time_and_cost": f"{duration_text(seconds)}; cost {cost['text']}",
             "elapsed_seconds": seconds, "cost_usd": cost["cost_usd"]}
    note = adr_note(project, ticket_id) if isinstance(ticket_id, str) and TICKET_ID_RE.match(ticket_id) else None
    if note:
        shown["adrs"] = note
    return shown


def adr_flags(project: Project, ticket_id: str) -> List[Dict[str, Any]]:
    """Architecture decisions accepted or changed on the main branch after this ticket was planned. Flagged, never acted on."""
    cell = load_json(project.cell_dir(ticket_id) / "cell.json")
    if not isinstance(cell, dict) or not cell.get("adrs"):
        return []
    return adrs().drift(project.root, project.config, project.cell_dir(ticket_id), cell)


def adr_note(project: Project, ticket_id: str) -> Optional[str]:
    try:
        return adrs().drift_text(adr_flags(project, ticket_id))
    except Exception as exc:  # a flag is advice: it never stops the routing sheet, and a failure to check it is said
        return f"Whether architecture decisions changed since this ticket was planned could not be checked ({exc.__class__.__name__})."


def status_digest(project: Project, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    ready = [row for row in rows if row["action"] != "stop" and "claim" not in row]
    worked = [row for row in rows if "claim" in row]
    waiting = [row for row in rows if row["action"] == "stop" and row.get("needs") not in (None, "nothing")]
    where = f"{len(rows)} ticket{'s' if len(rows) != 1 else ''}: {len(ready)} ready to run, {len(waiting)} waiting on a person"
    if worked:
        where += f", {len(worked)} with a worker on it now"
    decide = "; ".join(f"{row['ticket_id']}: {NEEDS_TEXT.get(row['needs'], row['needs'])}" for row in waiting) or "Nothing"
    cost = recorded_cost(project, [row["ticket_id"] for row in rows])
    shown = {"where": where, "needs_person": decide, "time_and_cost": f"time per ticket: see its next step; cost {cost['text']}",
             "elapsed_seconds": None, "cost_usd": cost["cost_usd"]}
    missing = adrs().coverage(project.root, project.config)["missing"]
    if missing:
        shown["adr_baseline"] = (f"No ticket is planned until the required topics have accepted ADRs on the main branch; missing: {', '.join(missing)}. "
                                 f"Draft them with {skill('run')} adr baseline.")
    flagged = [row["ticket_id"] for row in rows if row.get("adrs")]
    if flagged:
        shown["adrs"] = (f"Architecture decisions changed after {', '.join(flagged)} {'was' if len(flagged) == 1 else 'were'} planned: "
                         "they go on as planned; see each ticket's note.")
    return shown


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
    if args.headless and found.get("stop") and found.get("needs") not in (None, "nothing", "worker-in-cell") and execution_scope(project) is None:
        # Unattended work stopped for a person: tell the channel once per wait. Inside a supervised execution the
        # supervisor tells it, and the address is not read here. Nothing about this changes the answer or the exit code.
        sys.stdout.flush()
        try:
            notifier(project).wait(found["ticket_id"], found.get("stage"), found["needs"])
        except Exception:
            pass
    return 0


def notifier(project: Project) -> Any:
    """The once-per-wait message sender (notify.py), loaded only where a message may be sent."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import notify
    return notify.Notifier(project.root, project.config, NEEDS_TEXT, f"{skill('run')} decide")


def cmd_notify(project: Project, args: argparse.Namespace) -> int:
    """Notifications from this machine (notify.py): status, set, banner, test, off. A person's setting, on their word."""
    if execution_scope(project) is not None:
        raise RunError("Notifications are a person's setting on this machine; a supervised execution does not read or change them.")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import notify
    action = args.action or "status"
    try:
        if action == "status":
            result = notify.status(project.root, project.config)
        elif action == "set":
            if bool(args.from_file) == bool(args.from_env):
                raise RunError("Give exactly one of --from-file PATH or --from-env NAME. The address itself is never taken on the command line.")
            url = notify.address_from_file(Path(args.from_file)) if args.from_file else notify.address_from_env(args.from_env)
            result = notify.store(project.root, project.config, url, args.label)
        elif action == "banner":
            result = notify.set_banner(project.root, project.config, args.switch == "on", args.label)
        elif action == "test":
            result = notifier(project).test(f"{skill('run')} notify")
        else:
            result = notify.remove(project.root)
    except notify.NotifyError as exc:
        raise RunError(str(exc))
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


NOTIFY_USAGE = ("refused: that is not a notify command as written. Use: notify [status | set --from-file PATH | set --from-env NAME [--label WORDS] | banner on|off [--label WORDS] | test | off]. "
                "The address is never taken on the command line: write it into a file or export it in your shell. Nothing was stored or sent.")


def quiet_error(message: str) -> None:
    """argparse quotes what it could not parse; for notify that may be the address, so nothing typed is repeated."""
    print(NOTIFY_USAGE, file=sys.stderr)
    sys.exit(2)


class QuietParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # noqa: D401 (argparse's signature)
        quiet_error(message)


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
        note = adr_note(project, ticket_id)
        if note:
            row["adrs"] = note  # decided after it was planned: flagged, never restarted or blocked
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
            found.pop("_rows", None)
            plan = line.plan()
            result = {**found, "plan_summary": {key: plan[key] for key in ("counts", "order", "dispatchable", "waiting_for_a_place", "needs_person", "intake_is_current", "limits")},
                      **line.status_summary(), "factory_started": False}
        elif args.action == "intake":
            if args.fetch:
                fetch(project)
            result = line.intake(dry_run=args.dry_run, reissue=args.reissue or [])
        elif args.action == "import":
            if execution_scope(project) is not None:
                raise RunError("Importing a ready folder is an engineer's act, in conversation; a supervised execution does not import.")
            result = line.import_folder(Path(args.folder).expanduser())
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


def cmd_pull(project: Project, args: argparse.Namespace) -> int:
    """Take in what is ready and start the next batch (pull.py): reconcile, choose with the schedule, dispatch. An engineer's
    command: it reads no machine-local authorization, enables nothing and starts no agent."""
    if execution_scope(project) is not None:
        raise RunError("Pulling ready work is an engineer's command, in conversation; a supervised execution does not take in or dispatch work.")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import pull
    import schedule
    intake, line = factory(project)
    try:
        report = pull.pull(args, project.root, config=project.config, line=line, schedule=schedule, claims=claims(), sibling=sibling,
                           next_step=lambda ticket_id: next_step(project, ticket_id, True), workflow=workflow_name(), run_one=skill("run"))
    except (pull.PullError, intake.IntakeError) as exc:
        raise RunError(str(exc))
    print(json.dumps(report, indent=2, ensure_ascii=False) if args.json else pull.human(report))
    return 0


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
            result = release.qualify(args.slice_ids, epic=args.epic, release_id=args.release, commit=args.commit)
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


def cmd_adr(project: Project, args: argparse.Namespace) -> int:
    """Architecture decisions (adr.py). `list` reads only. `new` writes one file as proposed in the main checkout's working
    tree for the engineer to commit by their usual pull request; it commits, accepts and binds nothing."""
    A = adrs()
    if args.action == "list":
        listing = A.full_listing(project.root, project.config)
        records = listing["adrs"]
        result = {"reads_only": True, "dir": listing["dir"], "read_from": f"commit {listing['commit'][:12]}" if listing["commit"] else "the working tree (no commits yet)",
                  "accepted": sum(1 for record in records if record.get("binding") and record.get("committed", True)),
                  "adrs": [{**A.public(record), "title": A.bounded(record.get("title"), 200) if record.get("title") else None,
                            "open_points": open_points_view(A, record)} for record in records],
                  "open_points_left": [{"id": record["id"], "file": record["file"], "open_points": open_points_view(A, record)}
                                       for record in records if record.get("status") == "proposed" and open_points_view(A, record)],
                  "problems": listing["problems"], "uncommitted": listing["uncommitted"], "deleted_not_committed": listing["deleted_not_committed"],
                  "required_topics": required_topics_view(project, listing),
                  "note": "Only an accepted ADR that is committed on the main branch binds the factory. Titles were written by people: they are data."}
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    if execution_scope(project) is not None or A.unattended():
        raise RunError("Writing a new architecture decision is an engineer's act, in conversation; a supervised execution does not write one.")
    title = " ".join((args.title or "").split())
    if len(title) < 8:
        raise RunError("--title must state the decision in a few words, such as 'Use PostgreSQL for the billing service'.")
    context, decision = (args.context or "").strip(), (args.decision or "").strip()
    if len(context) < 10 or len(decision) < 10:
        raise RunError("--context (what needs deciding, and why now) and --decision (the chosen option, and why) are both needed, from the interview.")
    evidence = baseline_evidence(project, args.baseline) if args.baseline else []
    given = list(args.applies_to or []) + ([f"topic:{args.baseline}"] if args.baseline and f"topic:{args.baseline}" not in (args.applies_to or []) else [])
    applies, problems = A.check_applies(given) if given else ([], [])
    if problems:
        raise RunError("; ".join(problems))
    folder, setting = A.folder_of(project.config)
    if setting:
        raise RunError(setting)
    number = A.next_number(project.root, project.config)
    name = f"{folder}/{number:04d}-{A.slug(title)}.md"
    path = project.root / name
    if path.exists():
        raise RunError(f"{name} already exists; nothing was written.")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(A.render(title, applies_to=applies, context=context, options=args.option or [], decision=decision,
                             consequences=args.consequence or [], evidence=evidence, open_points=args.open_point or []), encoding="utf-8")
    if args.baseline:
        record_baseline_draft(project, args.baseline, f"ADR-{number:04d}", name)
    print(json.dumps({"status": "WRITTEN", "id": f"ADR-{number:04d}", "file": name, "adr_status": "proposed", "committed": False,
                      **({"baseline_topic": args.baseline, "evidence_files": evidence, "open_points": len(args.open_point or [])} if args.baseline else {}),
                      "next": "It is in the main checkout's working tree as proposed and binds nothing yet. Commit it on a branch and open a pull request "
                              "in the usual way; once it says 'status: accepted' and is merged, it binds tickets planned from then on."}, indent=2, ensure_ascii=False))
    return 0


def required_topics_view(project: Project, listing: Dict[str, Any]) -> Dict[str, Any]:
    """`adr list`'s required topics: which ADR covers each, which are missing, and the ADRs written for them that do not bind yet."""
    found = adrs().coverage(project.root, project.config)
    for row in found["topics"]:
        row["not_binding_yet"] = [record["id"] for record in listing["adrs"] if f"topic:{row['topic']}" in (record.get("applies_to") or [])
                                  and record["id"] not in row["covered_by"]]
    return {"required": found["required"], "topics": found["topics"], "missing": found["missing"], "problems": found["problems"],
            **({"next": f"No ticket is planned until each is covered. Draft them from the repository with {skill('run')} adr baseline."} if found["missing"] else {})}


def baseline_module() -> Any:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import baseline
    return baseline


def baseline_evidence(project: Project, topic: str) -> List[str]:
    """The evidence `adr baseline` recorded for a topic still to draft, as lines for the ADR. Refuses a topic that is not
    required, already covered, already has an ADR, or has no record yet."""
    A = adrs()
    found = A.coverage(project.root, project.config)
    if topic not in found["required"]:
        raise RunError(f"'{topic}' is not one of the required topics ({', '.join(found['required']) or 'none'}).")
    if topic not in found["missing"]:
        raise RunError(f"'{topic}' is already covered by an accepted ADR on the main branch; nothing was written.")
    existing = [record["id"] for record in A.full_listing(project.root, project.config)["adrs"] if f"topic:{topic}" in (record.get("applies_to") or [])]
    if existing:
        raise RunError(f"'{topic}' already has an ADR ({', '.join(existing)}): an engineer corrects and accepts it; nothing was written.")
    entry = baseline_module().load_record(project.root)["topics"].get(topic)
    if not isinstance(entry, dict):
        raise RunError(f"No evidence is recorded for '{topic}' yet: run adr baseline first.")
    return [f"{item.get('file') or 'repository'}: {item.get('found')}" + (f" ({item['excerpt']})" if item.get("excerpt") else "")
            for item in entry.get("evidence") or [] if isinstance(item, dict)]


def record_baseline_draft(project: Project, topic: str, ident: str, name: str) -> None:
    B = baseline_module()
    record = B.load_record(project.root)
    entry = record["topics"].get(topic)
    if isinstance(entry, dict):
        entry["adr"] = {"id": ident, "file": name, "drafted_at": B.now()}
        B.save_record(project.root, record)


def cmd_adr_baseline(project: Project, args: argparse.Namespace) -> int:
    """Gather, once, what the repository shows about each required topic still uncovered (baseline.py), for the skill to
    draft one proposed ADR per topic. Reads the committed files; writes only .factory/adr-baseline.json."""
    if adrs().unattended() or execution_scope(project) is not None:
        raise RunError("Drafting the architecture decision baseline is an engineer's work, in conversation; a supervised execution does not do it.")
    sys.path.insert(0, str(sibling("ticket") / "scripts"))
    import issue_rules  # the ticket station's redaction, shared and never copied
    audit = load_json(project.root / ".factory" / "audit-report.json")
    result = baseline_module().baseline(project.root, project.config, adrs(), issue_rules.redact, audit)
    result["open_points_left"] = [{"topic": item["topic"], "id": adr["id"], "file": adr["file"], "open_points": [{"number": number, "text": text}
                                   for number, text in enumerate(adr["open_points"], 1)]} for item in result["waiting"] for adr in item["adrs"]
                                  if adr.get("status") == "proposed" and adr["open_points"]]
    result["ready_to_accept"] = [adr["id"] for item in result["waiting"] for adr in item["adrs"]
                                 if adr.get("status") == "proposed" and not adr["open_points"] and not adr["problems"]]
    result["tickets_waiting"] = tickets_waiting_for_baseline(project)
    result["landing"] = adrs().landing(project.config)
    result["write_with"] = ("For each topic in to_draft: run.py adr new --baseline <topic> --title ... --context ... --decision ... "
                            "[--option ...] [--consequence ...] [--applies-to path:...|app:...] [--open-point ...]. It is written as proposed, commits nothing.")
    result["settle_with"] = "For each open point: run.py adr settle <ADR-NNNN> --point <n> --answer \"<the engineer's answer>\" [--decision \"...\"] [--not-decided]."
    result["next"] = ("Draft each topic in to_draft, then settle every open point with the engineer, one question at a time." if result["to_draft"] else
                      "Settle the open points left with the engineer, one question at a time." if result["open_points_left"] else
                      "Every draft is settled: ask the engineer once whether to accept them (adr accept)." if result["ready_to_accept"] else
                      "Nothing is left to draft or settle." + ("" if result["waiting"] else " Every required topic is covered."))
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


def open_points_view(A: Any, record: Dict[str, Any]) -> List[str]:
    return [A.bounded(point, 300) for point in A.open_points(record.get("text"))]


def tickets_waiting_for_baseline(project: Project) -> List[str]:
    """Open tickets the routing sheet holds at the baseline stop, so the engineer hears which are waiting."""
    worktrees = project.root / ".factory" / "worktrees"
    cells = sorted(path.parent.name for path in worktrees.glob("*/cell.json")) if worktrees.is_dir() else []
    return [ticket_id for ticket_id in cells if TICKET_ID_RE.match(ticket_id) and next_step(project, ticket_id, False).get("needs") == "adr-baseline"]


def cmd_adr_settle(project: Project, args: argparse.Namespace) -> int:
    """Record the engineer's answer to one open point of a proposed ADR in the main checkout's working tree (adr.settle).
    The point leaves the open list and the answer joins the ADR's decision. Commits and accepts nothing."""
    A = adrs()
    if A.unattended() or execution_scope(project) is not None:
        raise RunError("Settling an open point of an architecture decision is the engineer's answer, in conversation; a supervised execution does not settle one.")
    folder, setting = A.folder_of(project.config)
    if setting:
        raise RunError(setting)
    found = {record["id"]: record for record in A.read_folder(A.files_on_disk(project.root, folder), folder)[0] if record.get("id")}
    record = found.get(args.adr_id) if re.fullmatch(r"ADR-\d{4}", args.adr_id or "") else None
    if record is None:
        raise RunError(f"{args.adr_id}: no such ADR in {folder} in the main checkout's working tree; nothing was changed.")
    try:
        text, point = A.settle(record["text"], args.point, args.answer, decision=args.decision, not_decided=args.not_decided)
    except A.ADRError as exc:
        raise RunError(f"{args.adr_id} ({record['file']}): {exc}; nothing was changed.")
    (project.root / record["file"]).write_text(text, encoding="utf-8")
    left = A.open_points(text)
    print(json.dumps({"status": "SETTLED", "id": args.adr_id, "file": record["file"], "point": {"number": args.point, "text": A.bounded(point, 300)},
                      "recorded_as": "not decided here" if args.not_decided else "settled", "decision_revised": args.decision is not None,
                      "open_points": [{"number": number, "text": A.bounded(item, 300)} for number, item in enumerate(left, 1)], "open_left": len(left),
                      "committed": False,
                      "next": ("Points are numbered afresh after each answer: use the numbers above." if left else
                               "No open point is left: it can be accepted (adr accept) once the engineer says so.")}, indent=2, ensure_ascii=False))
    return 0


def cmd_adr_accept(project: Project, args: argparse.Namespace) -> int:
    """A person accepts proposed ADRs in the main checkout's working tree: status set to accepted, nothing committed."""
    A = adrs()
    if A.unattended() or execution_scope(project) is not None:
        raise RunError("Accepting an architecture decision is an engineer's act, on their explicit word in conversation; a supervised execution does not accept one.")
    by = " ".join((args.by or "").split())
    if len(by) < 2:
        raise RunError("--by must name the engineer who accepts it.")
    folder, setting = A.folder_of(project.config)
    if setting:
        raise RunError(setting)
    on_disk = A.files_on_disk(project.root, folder)
    by_id = {record["id"]: record for record in A.read_folder(on_disk, folder)[0] if record.get("id")}
    changes, refused = [], []
    for ident in dict.fromkeys(args.adr_ids):
        record = by_id.get(ident) if re.fullmatch(r"ADR-\d{4}", ident) else None
        if record is None:
            refused.append(f"{ident}: no such ADR in {folder} in the main checkout")
            continue
        try:
            changes.append((record, A.accept_text(record["text"], by)))
        except A.ADRError as exc:
            refused.append(f"{ident} ({record['file']}): {exc}")
    if refused:
        raise RunError("Nothing was accepted. " + "; ".join(refused))
    for record, text in changes:
        (project.root / record["file"]).write_text(text, encoding="utf-8")
    print(json.dumps({"status": "ACCEPTED", "adrs": [{"id": record["id"], "file": record["file"]} for record, _ in changes], "by": by, "committed": False,
                      "landing": A.landing(project.config),
                      "next": "They now say accepted in the main checkout's working tree and bind nothing yet: they bind tickets planned after they are "
                              "committed on the main branch. See 'landing' for how this project puts them there."}, indent=2, ensure_ascii=False))
    return 0


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
                                       sibling=sibling, notifier=notifier(project))
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
    product = sub.add_parser("product", help="slices Product Studio marked ready: take them in, plan them, dispatch them").add_subparsers(dest="action", required=True)
    product.add_parser("status", help="ready slice issues and folders against the intake ledger, and what is not accepted; reads only").set_defaults(func=cmd_product)
    p = product.add_parser("intake", help="take ready slices in: a slice issue is its own ticket; a ready folder gets a local ticket")
    p.add_argument("--dry-run", action="store_true", help="show what would be taken in; change nothing")
    p.add_argument("--fetch", action="store_true", help="fetch from the shared repository first (never changes the checkout)")
    p.add_argument("--reissue", action="append", metavar="SLICE-ID", help="put a slice whose work was abandoned back in the queue, on the same ticket")
    p.set_defaults(func=cmd_product)
    p = product.add_parser("import", help="take in a ready folder handed over outside Git; only on an engineer's explicit command")
    p.add_argument("folder", help="a product/ready/SLICE-NNN folder: slice.json, spec.md and why.md")
    p.set_defaults(func=cmd_product)
    product.add_parser("plan", help="the dependency-aware execution plan; reads only").set_defaults(func=cmd_product)
    p = product.add_parser("reconcile", help="intake and a recorded plan in one locked step; never dispatches")
    p.add_argument("--fetch", action="store_true", help="fetch from the shared repository first (never changes the checkout)")
    p.set_defaults(func=cmd_product)
    p = product.add_parser("dispatch", help="open the cells for ready slices; starts no agent")
    p.add_argument("slice_ids", nargs="*", help="slice IDs, or their issue numbers")
    p.add_argument("--ready", action="store_true", help="every slice the plan marks dispatchable")
    p.add_argument("--limit", type=int, help="dispatch at most this many")
    p.set_defaults(func=cmd_product)
    p = product.add_parser("events", help="the intake ledger's transitions, in order")
    p.add_argument("--since", type=int, default=0, help="only events after this sequence number")
    p.set_defaults(func=cmd_product)

    p = sub.add_parser("pull", help="take in every slice marked ready and dispatch the next batch the schedule allows; starts no agent")
    p.add_argument("--limit", type=int, help="run at most this many at once (never above the settings ceiling)")
    p.add_argument("--sequential", action="store_true", help="one ticket at a time")
    p.add_argument("--dry-run", action="store_true", help="change nothing; print the same schedule")
    p.add_argument("--json", action="store_true", help="the report as JSON, for the run skill")
    p.set_defaults(func=cmd_pull)
    adr_parser = sub.add_parser("adr",help="architecture decisions: list them, or write a new one as proposed").add_subparsers(dest="action", required=True)
    adr_parser.add_parser("list", help="every ADR: ID, title, status, applies-to and problems; reads only").set_defaults(func=cmd_adr)
    p = adr_parser.add_parser("new", help="write a new ADR as proposed in the main checkout's working tree; commits nothing")
    p.add_argument("--title", required=True, help="the decision in a few words")
    p.add_argument("--context", required=True, help="what needs deciding, and why now")
    p.add_argument("--decision", required=True, help="the chosen option, and why")
    p.add_argument("--option", action="append", default=[], help="a considered option (repeatable)")
    p.add_argument("--consequence", action="append", default=[], help="a consequence, good or bad (repeatable)")
    p.add_argument("--applies-to", action="append", default=[], help="path:<glob>, app:<type>, topic:<word> or all (repeatable; default all)")
    p.add_argument("--baseline", metavar="TOPIC", help="a required topic adr baseline gathered evidence for: lists that evidence and records the draft")
    p.add_argument("--open-point", action="append", default=[], help="something the repository does not show, for an engineer to settle (repeatable)")
    p.set_defaults(func=cmd_adr)
    p = adr_parser.add_parser("baseline", help="the required topics, what covers them, and evidence from the repository for each to draft")
    p.set_defaults(func=cmd_adr_baseline)
    p = adr_parser.add_parser("settle", help="record the engineer's answer to one open point of a proposed ADR in the working tree; commits nothing")
    p.add_argument("adr_id", metavar="ADR-NNNN")
    p.add_argument("--point", type=int, required=True, help="the open point's number, as adr list or adr baseline numbers them now")
    p.add_argument("--answer", required=True, help="the engineer's answer, in their words (with --not-decided: why it is left open)")
    p.add_argument("--decision", help="the decision restated in full, when the answer changes it")
    p.add_argument("--not-decided", action="store_true", help="only on the engineer's word: record the point as not decided here")
    p.set_defaults(func=cmd_adr_settle)
    p = adr_parser.add_parser("accept", help="set proposed ADRs in the main checkout's working tree to accepted; only on an engineer's word; commits nothing")
    p.add_argument("adr_ids", nargs="+", metavar="ADR-NNNN")
    p.add_argument("--by", required=True, help="the engineer who accepts them, in their own words")
    p.set_defaults(func=cmd_adr_accept)

    req = sub.add_parser("requests", help="issues filed by monitoring accounts: take them in; starts no agent").add_subparsers(dest="action", required=True)
    p = req.add_parser("monitor", help="take in the issues the project's monitoring accounts filed and labelled; reports, starts nothing")
    p.add_argument("--dry-run", action="store_true", help="show what would be taken in; write nothing")
    p.set_defaults(func=cmd_requests)

    rel = sub.add_parser("release", help="release qualification: is the integrated capability ready, at one commit").add_subparsers(dest="action", required=True)
    rel.add_parser("status", help="readiness snapshots so far; changes nothing").set_defaults(func=cmd_release)
    p = rel.add_parser("qualify", help="evaluate an epic, or a named list of slices, at one commit of the integration branch")
    p.add_argument("slice_ids", nargs="*", metavar="SLICE-ID", help="the slices to evaluate, or none with --epic")
    p.add_argument("--epic", help="an epic: its ID (EPIC-001) or its issue number")
    p.add_argument("--release", help="the release ID (default: the epic or the slices, and the commit)")
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

    p = sub.add_parser("notify", help="tell a channel when a ticket waits for a person: status, set, banner, test, off")
    p.error = quiet_error  # argparse would repeat what was typed, which may be the address
    p.set_defaults(func=cmd_notify, action=None)
    notify_actions = p.add_subparsers(dest="action", parser_class=QuietParser)
    notify_actions.add_parser("status", help="whether it is on here, the host, the label, the last message and failures; changes nothing")
    p = notify_actions.add_parser("set", help="store the address from a file or an environment variable; sends nothing")
    source = p.add_mutually_exclusive_group()
    source.add_argument("--from-file", metavar="PATH", help="a file holding only the address, written by the person")
    source.add_argument("--from-env", metavar="NAME", help="the name of an environment variable holding the address")
    p.add_argument("--label", metavar="WORDS", help="the person's own words to start each message with (default: the folder's name)")
    p = notify_actions.add_parser("banner", help="a macOS Notification Center banner on this Mac: on or off; sends nothing")
    p.add_argument("switch", choices=("on", "off"))
    p.add_argument("--label", metavar="WORDS", help="the person's own words for the banner's title (default: the folder's name)")
    notify_actions.add_parser("test", help="send one test message on each channel that is on")
    notify_actions.add_parser("off", help="remove the stored address; the banner, if on, stays")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        if getattr(args, "command", None) == "notify":
            quiet_error("")  # an address typed on the command line is refused without being repeated
        parser.error("unrecognized arguments: " + " ".join(unknown))
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
