#!/usr/bin/env python3
"""The MACH Factory Supervisor: on a machine whose engineer has enabled it, keeps approved work moving.

Each pass ("tick") does the same things in the same order:

    1. read the machine-local policy; if the Factory is not enabled here, do nothing at all
    2. confirm this process still owns the project (a lease with a heartbeat)
    3. settle executions an earlier pass or an earlier supervisor left: still running, finished
       while nobody watched, or ended with nobody knowing how
    4. reconcile: M3's intake and recorded plan (intake.Factory.reconcile)
    5. in observe mode, or when paused, stop here
    6. dispatch what the plan marks dispatchable, through M3's guarded dispatch, with an
       authorization that re-reads the policy at that moment
    7. claim and start an execution for each runnable ticket this supervisor owns, within the
       limits: places, runs and money per day, attempts, risk

It decides nothing about order or eligibility. M3's scheduler says what is ready; run.py's state
machine says what a ticket's next station is; each station's own gates decide whether it passes.
The supervisor only starts the existing belt workflow for a ticket and reads the records afterwards.

Its own state (claims, executions, attempts) lives in the intake ledger, written under the same
lock and reported through the same event log, so there is one record and one order of events.
Nothing in a product file or in the project's tracked settings can enable it or widen its limits.

Standard library only. Imported by run.py; not a command of its own.
"""

import contextlib
import json
import os
import platform
import secrets
import signal
import subprocess
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import executor
import policy as policy_module

RISKS = ("Low", "Medium", "High")
LIVE = ("claimed", "started")
NEVER_RETRIED = ("merge", "cleanup")  # stations whose effects reach beyond the cell: an unknown outcome goes to a person
LEASE_SECONDS = 180
SUPERVISOR = "supervisor"


class SupervisorError(Exception):
    """A problem the caller can fix; run.py prints it as a refusal."""


def now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(moment: Optional[datetime] = None) -> str:
    return (moment or now()).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(value: Any) -> Optional[datetime]:
    try:
        return datetime.strptime(str(value), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def pid_alive(pid: Any) -> bool:
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


class Lease:
    """Ownership of one project by one supervisor process on this machine.

    The file names the runner, the process and when its claim runs out. A second supervisor is
    refused while the first is alive and its lease has not expired; a lease whose process is gone,
    or which has expired, is taken over. This coordinates processes on one machine. It does not,
    and cannot, coordinate two engineers' machines.
    """

    def __init__(self, root: Path, runner_id: Optional[str]):
        self.path = policy_module.local_dir(root) / "supervisor.json"
        self.runner_id = runner_id
        self.instance = uuid.uuid4().hex

    def read(self) -> Optional[Dict[str, Any]]:
        try:
            if self.path.is_symlink():
                return None
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    @staticmethod
    def live(data: Optional[Dict[str, Any]]) -> bool:
        if not data:
            return False
        expires = parse(data.get("expires_at"))
        if not expires or now() > expires:
            return False
        return data.get("host") != platform.node() or pid_alive(data.get("pid"))

    def holder(self) -> Optional[str]:
        """A description of another live owner, or None."""
        data = self.read()
        if self.live(data) and data.get("instance") != self.instance:
            return f"process {data.get('pid')} on {data.get('host')}, runner {data.get('runner_id')}, last heard from at {data.get('heartbeat_at')}"
        return None

    def acquire(self, seconds: int = LEASE_SECONDS) -> Optional[Dict[str, Any]]:
        """Take ownership. Returns the previous, dead owner's record if one was taken over."""
        other = self.holder()
        if other:
            raise SupervisorError(f"Another supervisor already owns this project: {other}.")
        previous = self.read()
        self.write(seconds, started=stamp())
        again = self.read()
        if not again or again.get("instance") != self.instance:  # two started at the same moment: one of them lost
            raise SupervisorError("Another supervisor took ownership of this project at the same moment.")
        return previous if previous and previous.get("instance") != self.instance else None

    def write(self, seconds: int, started: Optional[str] = None) -> None:
        current = self.read() or {}
        policy_module.write_private(self.path, json.dumps({
            "instance": self.instance, "runner_id": self.runner_id, "pid": os.getpid(), "host": platform.node(),
            "started_at": started or current.get("started_at") or stamp(), "heartbeat_at": stamp(),
            "expires_at": stamp(now() + timedelta(seconds=seconds))}, indent=2, sort_keys=True) + "\n")

    def owned(self) -> bool:
        data = self.read()
        return bool(data) and data.get("instance") == self.instance and self.live(data)

    def heartbeat(self, seconds: int = LEASE_SECONDS) -> None:
        if not self.owned():
            raise SupervisorError("This supervisor no longer owns the project; another took over. It stops here.")
        self.write(seconds)

    def release(self) -> None:
        data = self.read()
        if data and data.get("instance") == self.instance:
            with contextlib.suppress(OSError):
                self.path.unlink()


class Supervisor:
    def __init__(self, root: Path, config: Dict[str, Any], line: Any, *, next_step: Callable[[str], Dict[str, Any]],
                 audit: Callable[[], Dict[str, Any]], git: Callable[..., subprocess.CompletedProcess], run_script: Path, workflow: str):
        self.root = root
        self.config = config
        self.line = line
        self.next_step = next_step
        self.audit = audit
        self.git = git
        self.run_script = run_script
        self.workflow = workflow
        self.lease = Lease(root, policy_module.read(root).get("runner_id"))
        self.wake_path = policy_module.local_dir(root) / "wake"

    # ---- policy ----

    def policy(self) -> Dict[str, Any]:
        """The policy in force right now, read from disk every time it is needed."""
        return policy_module.effective(policy_module.read(self.root), self.config)

    def attach(self, pol: Dict[str, Any]) -> None:
        """Mark everything the ledger records from here on as this supervisor's doing."""
        self.line.runner_id = pol.get("runner_id")
        self.line.event_source = SUPERVISOR
        self.line.max_parallel = min(self.line.max_parallel, int(pol["limits"]["max_parallel"]))

    def authorize(self, plan: Dict[str, Any]) -> Tuple[bool, str]:
        """M3 asks this immediately before it dispatches. The answer comes from the disk, not from memory."""
        pol = self.policy()
        allowed, why = policy_module.may_execute(pol)
        if not allowed:
            return False, why
        if not self.lease.owned():
            return False, "this supervisor does not own the project"
        state = self.audit().get("state")
        if state not in ("ok", "off"):
            return False, f"the readiness audit is {state}"
        return True, why

    # ---- one pass ----

    def tick(self) -> Dict[str, Any]:
        pol = self.policy()
        report: Dict[str, Any] = {"at": stamp(), "state": "disabled", "autonomy": pol.get("autonomy"), "recovered": [], "dispatched": [], "started": [],
                                  "held": [], "running": [], "notes": [], "factory_started": False}
        if not policy_module.running(pol):
            report["why"] = (pol.get("problems") or pol.get("restricted_by_project") or ["The Factory is not enabled on this machine."])[0]
            return report
        self.lease.heartbeat()
        self.attach(pol)
        if pol.get("auto_sync"):
            fetched = self.git(self.root, "fetch", "origin")
            if fetched.returncode != 0:  # offline is not an error: work with what is here
                report["notes"].append("Could not reach the shared repository; using what was fetched before.")
        with self.line.lock("supervisor"):
            ledger = self.line.ledger()
            before = (ledger.get("source") or {}).get("commit")
            self.recover(ledger, pol, report)
            self.line.save(ledger)
        reconciled = self.line.reconcile()
        report["intake"] = {key: reconciled["intake"].get(key) for key in ("created", "updated", "superseded", "needs_person", "refused")}
        with self.line.lock("supervisor"):
            ledger = self.line.ledger()
            after = (ledger.get("source") or {}).get("commit")
            if after and after != before:
                self.line.emit(ledger, "revision.discovered", from_commit=before, commit=after, refs={"integration_branch": (ledger.get("source") or {}).get("branch")})
            plan = self.line.plan(ledger=ledger, record=True)
            self.observe(ledger, plan)
            self.line.save(ledger)  # dispatch below reads the ledger afresh: what was just recorded must be on disk first
            allowed, why = policy_module.may_execute(pol)
            if allowed:
                self.schedule(ledger, pol, plan, report)
                ledger = self.line.ledger()
                report["state"] = "supervised"
                report["factory_started"] = bool(report["started"])
            else:
                report["state"] = "paused" if pol.get("paused") else "observe"
                report["held"] = [{"slice_id": key, "why": why} for key in plan["dispatchable"]] + [{"ticket_id": item["ticket_id"], "why": why} for item in plan["runnable"]]
            self.decided(ledger, report)
            supervisor = ledger["supervisor"]
            supervisor["last_tick"] = report["at"]
            report["running"] = sorted(record["ticket_id"] for record in supervisor["executions"].values() if record["state"] in LIVE)
            report["needs_person"] = plan["needs_person"]
            report["parked"] = supervisor["parked"]
            self.line.save(ledger)
        return report

    def observe(self, ledger: Dict[str, Any], plan: Dict[str, Any]) -> None:
        """Record each change of a cell's stage, as the stations themselves recorded it."""
        seen = ledger["supervisor"]["observed"]
        for row in plan["slices"]:
            ticket, stage = row.get("ticket_id"), row.get("stage")
            if ticket and stage and seen.get(ticket) != stage:
                self.line.emit(ledger, "station.observed", slice_id=row["slice_id"], wave_id=row["wave_id"], revision=row["revision"], ticket_id=ticket,
                               from_stage=seen.get(ticket), stage=stage, refs={"cell": f".factory/worktrees/{ticket}/cell.json"})
                seen[ticket] = stage

    def decided(self, ledger: Dict[str, Any], report: Dict[str, Any]) -> None:
        """Say what was decided, once per distinct decision."""
        decision = {"state": report["state"], "dispatched": [item["slice_id"] for item in report["dispatched"]], "started": [item["ticket_id"] for item in report["started"]],
                    "held": report["held"]}
        supervisor = ledger["supervisor"]
        if supervisor.get("last_decision") != decision and (decision["dispatched"] or decision["started"] or decision["held"] or supervisor.get("last_decision")):
            supervisor["last_decision"] = decision
            self.line.emit(ledger, "scheduling.decided", **decision)

    # ---- recovery ----

    def recover(self, ledger: Dict[str, Any], pol: Dict[str, Any], report: Dict[str, Any]) -> None:
        """Settle every execution that is not known to have ended.

        Four cases, told apart by what is on disk and what is running: a claim that never started;
        an execution still running; one that ended, perhaps while no supervisor was watching; and
        one that is gone without a result. The ticket's own records decide what it means.
        """
        supervisor = ledger["supervisor"]
        for execution_id, record in sorted(supervisor["executions"].items()):
            if record["state"] not in LIVE:
                continue
            facts = executor.outcome(self.root, execution_id)
            adopted = record.get("instance") != self.lease.instance
            if facts["ended"]:
                if adopted:
                    self.line.emit(ledger, "recovery.started", ticket_id=record["ticket_id"], slice_id=record.get("slice_id"), execution_id=execution_id,
                                   kind="ended-while-unwatched")
                self.finish(ledger, pol, record, facts, known=True)
                report["recovered"].append({"execution_id": execution_id, "ticket_id": record["ticket_id"], "found": "ended"})
            elif executor.alive(record.get("wrapper_pid"), execution_id) or executor.alive(facts.get("wrapper_pid"), execution_id):
                if adopted:
                    record["instance"] = self.lease.instance
                    self.line.emit(ledger, "recovery.started", ticket_id=record["ticket_id"], slice_id=record.get("slice_id"), execution_id=execution_id, kind="still-running")
                    report["recovered"].append({"execution_id": execution_id, "ticket_id": record["ticket_id"], "found": "still running"})
            elif record["state"] == "claimed" and not facts["started"] and not record.get("wrapper_pid"):
                # Reserved, never launched: nothing ran, so nothing is uncertain. Give the place back.
                record.update({"state": "released", "ended_at": stamp()})
                self.line.emit(ledger, "recovery.started", ticket_id=record["ticket_id"], slice_id=record.get("slice_id"), execution_id=execution_id, kind="claim-never-started")
                report["recovered"].append({"execution_id": execution_id, "ticket_id": record["ticket_id"], "found": "claimed, never started"})
            else:
                self.line.emit(ledger, "recovery.started", ticket_id=record["ticket_id"], slice_id=record.get("slice_id"), execution_id=execution_id, kind="outcome-unknown")
                self.finish(ledger, pol, record, facts, known=False)
                report["recovered"].append({"execution_id": execution_id, "ticket_id": record["ticket_id"], "found": "outcome unknown"})

    def finish(self, ledger: Dict[str, Any], pol: Dict[str, Any], record: Dict[str, Any], facts: Dict[str, Any], known: bool) -> None:
        """Close an execution. Where the ticket now stands is read from its cell, never from the run's own account."""
        supervisor = ledger["supervisor"]
        ticket = record["ticket_id"]
        step = self.next_step(ticket)
        moved = (step.get("stage"), step.get("action")) != (record.get("stage_at_start"), record.get("action_at_start"))
        record.update({"state": "finished" if known else "unknown", "ended_at": facts.get("ended_at") or stamp(), "how": facts.get("how") if known else "unknown",
                       "exit_code": facts.get("exit_code"), "session_id": facts.get("session_id") or record.get("session_id"), "cost_usd": facts.get("cost_usd"),
                       "refused_tools": facts.get("refused_tools") or [], "stage_at_end": step.get("stage"), "next_at_end": step.get("action"), "moved": moved})
        common = {"ticket_id": ticket, "slice_id": record.get("slice_id"), "execution_id": record["execution_id"],
                  "refs": {"cell": f".factory/worktrees/{ticket}/cell.json", "execution": f".factory/local/executions/{record['execution_id']}/"}}
        if moved or (known and step.get("action") == "stop"):
            # Refusals that the workers got past are reported with the result. Nothing was granted.
            supervisor["attempts"].pop(ticket, None)
            self.line.emit(ledger, "execution.completed", stage=step.get("stage"), next=step.get("action"), waiting_for=step.get("needs"),
                           how=record["how"], seen_to_end=known, cost_usd=record["cost_usd"], session_id=record["session_id"],
                           refused_tools=record["refused_tools"], **common)
            return
        if record["refused_tools"]:
            # It got nowhere and was refused something: never granted quietly. A person sees what was asked for and decides.
            self.park(ledger, ticket, "It made no progress and needed tools that are not allowed: " + ", ".join(record["refused_tools"]) + ".", common)
        count = int((supervisor["attempts"].get(ticket) or {}).get("count") or 0) + 1
        supervisor["attempts"][ticket] = {"count": count, "at": f"{step.get('stage')}@{step.get('action')}"}
        self.line.emit(ledger, "execution.failed", stage=step.get("stage"), next=step.get("action"), how=record["how"], claude_error=facts.get("subtype") if facts.get("is_error") else None,
                       exit_code=record["exit_code"], attempt=count, session_id=record["session_id"], **common)
        if not known and record.get("action_at_start") in NEVER_RETRIED:
            self.park(ledger, ticket, f"The {record.get('action_at_start')} station was running when its execution was lost, and what it did is not known. It is never retried automatically.", common)
        elif count >= int(pol["limits"]["max_attempts"]):
            self.park(ledger, ticket, f"{count} execution(s) ended without moving it past '{step.get('stage')}'.", common)

    def park(self, ledger: Dict[str, Any], ticket: str, reason: str, common: Dict[str, Any]) -> None:
        """Take a ticket out of automatic execution until a person says to carry on."""
        if ticket not in ledger["supervisor"]["parked"]:
            ledger["supervisor"]["parked"][ticket] = {"reason": reason, "at": stamp()}
            self.line.emit(ledger, "human.required", reason=reason, **common)

    # ---- scheduling ----

    def budget(self, ledger: Dict[str, Any], pol: Dict[str, Any]) -> Optional[str]:
        """Why no more executions may start in this 24 hours, or None."""
        since = now() - timedelta(hours=24)
        recent = [record for record in ledger["supervisor"]["executions"].values() if (parse(record.get("started_at")) or since) > since and record.get("started_at")]
        if len(recent) >= pol["limits"]["max_runs_per_day"]:
            return f"the limit of {pol['limits']['max_runs_per_day']} executions in 24 hours is reached"
        spent = sum(float(record.get("cost_usd") or 0) for record in recent)
        if spent >= pol["limits"]["max_budget_usd_per_day"]:
            return f"the limit of ${pol['limits']['max_budget_usd_per_day']:g} in 24 hours is reached (${spent:.2f} spent)"
        return None

    def schedule(self, ledger: Dict[str, Any], pol: Dict[str, Any], plan: Dict[str, Any], report: Dict[str, Any]) -> None:
        intake = type(self.line)
        excluded = set(pol.get("excluded_slices") or [])
        # 1. Dispatch what M3's plan marks dispatchable. M3 rechecks eligibility and calls authorize() itself.
        for slice_id in plan["dispatchable"]:
            if slice_id in excluded:
                report["held"].append({"slice_id": slice_id, "why": "it was already waiting when the Factory was enabled, and was left to the engineer"})
                continue
            over = self.budget(self.line.ledger(), pol)
            if over:
                report["held"].append({"slice_id": slice_id, "why": over})
                continue
            try:
                done = self.line.dispatch([slice_id], by=SUPERVISOR, authorize=self.authorize)
            except Exception as exc:  # IntakeError: M3 refused, with its reason
                if exc.__class__.__name__ != "IntakeError":
                    raise
                report["held"].append({"slice_id": slice_id, "why": str(exc)})
                continue
            for item in done["dispatched"]:
                report["dispatched"].append({"slice_id": item["slice_id"], "ticket_id": item["ticket_id"]})
            for item in done["refused"]:
                report["held"].append({"slice_id": item["slice_id"], "why": " ".join(item.get("why") or [])})
        # 2. Start an execution for each runnable ticket this supervisor owns.
        ledger.clear()
        ledger.update(self.line.ledger())
        plan = self.line.plan(ledger=ledger, record=True)
        supervisor = ledger["supervisor"]
        by_ticket = {row["ticket_id"]: row for row in plan["slices"] if row.get("ticket_id")}
        for item in plan["runnable"]:
            ticket, slice_id = item["ticket_id"], item["slice_id"]
            entry = ledger["slices"][slice_id]
            live = [record for record in supervisor["executions"].values() if record["state"] in LIVE]
            reason = None
            if any(record["ticket_id"] == ticket for record in live):
                continue  # already running
            if entry.get("owner") != SUPERVISOR:
                reason = "an engineer is moving this ticket by hand"
            elif slice_id in excluded:
                reason = "it was left to the engineer when the Factory was enabled"
            elif ticket in supervisor["parked"]:
                reason = "waiting for a person: " + supervisor["parked"][ticket]["reason"]
            elif by_ticket.get(ticket, {}).get("needs_person"):
                reason = "the plan says a person is needed"
            elif len(live) >= pol["limits"]["max_parallel"]:
                reason = f"all {pol['limits']['max_parallel']} place(s) are in use"
            elif self.risk_of(ticket) and RISKS.index(self.risk_of(ticket)) > RISKS.index(pol["max_risk"]):
                reason = f"its risk tier is {self.risk_of(ticket)}, above the {pol['max_risk']} this machine allows unattended"
                self.park(ledger, ticket, f"Its risk tier ({self.risk_of(ticket)}) is above what this machine runs unattended ({pol['max_risk']}).", {"ticket_id": ticket, "slice_id": slice_id})
            else:
                reason = self.budget(ledger, pol)
            until = None if pol.get("allow_merge") else "merge"
            if not reason and until and item.get("next") == until:
                # Approved, and this machine does not merge unattended: say so once, claim nothing.
                reason = "it is approved and waits for a person to merge it"
                if supervisor.setdefault("told", {}).get(ticket) != until:
                    supervisor["told"][ticket] = until
                    self.line.emit(ledger, "human.required", ticket_id=ticket, slice_id=slice_id, reason="It is approved. This machine does not merge unattended, so a person merges it.",
                                   refs={"cell": f".factory/worktrees/{ticket}/cell.json"})
                    self.line.save(ledger)
            if reason:
                report["held"].append({"ticket_id": ticket, "slice_id": slice_id, "why": reason})
                continue
            started = self.start(ledger, pol, ticket, slice_id)
            (report["started"] if started.get("started") else report["held"]).append(started)

    def risk_of(self, ticket: str) -> Optional[str]:
        try:
            risk = json.loads((self.root / ".factory" / "worktrees" / ticket / "cell.json").read_text(encoding="utf-8")).get("risk")
        except (OSError, ValueError):
            return None
        return risk if risk in RISKS else None

    def start(self, ledger: Dict[str, Any], pol: Dict[str, Any], ticket: str, slice_id: str) -> Dict[str, Any]:
        """Claim, then check everything once more, then start. The claim is on disk before any process exists."""
        supervisor = ledger["supervisor"]
        step = self.next_step(ticket)
        execution_id = "x" + secrets.token_hex(6)
        until = None if pol.get("allow_merge") else "merge"
        record = {"execution_id": execution_id, "ticket_id": ticket, "slice_id": slice_id, "state": "claimed", "claimed_at": stamp(), "runner_id": pol["runner_id"],
                  "instance": self.lease.instance, "session_id": str(uuid.uuid4()), "stage_at_start": step.get("stage"), "action_at_start": step.get("action"),
                  "until": until, "attempt": int((supervisor["attempts"].get(ticket) or {}).get("count") or 0) + 1, "wrapper_pid": None, "started_at": None}
        supervisor["executions"][execution_id] = record
        common = {"ticket_id": ticket, "slice_id": slice_id, "execution_id": execution_id}
        self.line.emit(ledger, "work.claimed", stage=step.get("stage"), next=step.get("action"), attempt=record["attempt"], **common)
        self.line.save(ledger)
        allowed, why = self.authorize({})
        if allowed and (step.get("action") in (None, "stop") or (until and step.get("action") == until)):
            allowed, why = False, f"the line has stopped for this ticket ({step.get('reason') or step.get('action')})"
        if not allowed:
            record.update({"state": "released", "ended_at": stamp(), "how": "not-started"})
            self.line.save(ledger)
            return {"ticket_id": ticket, "slice_id": slice_id, "why": why}
        argv = executor.command(pol["claude"], self.workflow, [ticket], until, pol["allowed_tools"], pol["limits"]["max_budget_usd_per_run"], record["session_id"])
        executor.prepare(self.root, execution_id, argv, pol["limits"]["max_execution_minutes"])
        record["wrapper_pid"] = executor.launch(self.root, execution_id, self.run_script)
        record.update({"state": "started", "started_at": stamp()})
        self.line.emit(ledger, "execution.started", session_id=record["session_id"], until=until, workflow=self.workflow,
                       limits={"minutes": pol["limits"]["max_execution_minutes"], "budget_usd": pol["limits"]["max_budget_usd_per_run"]},
                       refs={"execution": f".factory/local/executions/{execution_id}/", "cell": f".factory/worktrees/{ticket}/cell.json"}, **common)
        self.line.save(ledger)
        return {"started": True, "ticket_id": ticket, "slice_id": slice_id, "execution_id": execution_id, "session_id": record["session_id"]}

    # ---- stopping ----

    def stop_executions(self, only: Optional[str] = None) -> List[Dict[str, Any]]:
        """Ask running executions to stop. What each had done by then is not known, and is recorded as such."""
        stopped = []
        with self.line.lock("supervisor"):
            ledger = self.line.ledger()
            for execution_id, record in sorted(ledger["supervisor"]["executions"].items()):
                if record["state"] not in LIVE or (only and execution_id != only):
                    continue
                signalled = executor.stop(record.get("wrapper_pid"), execution_id)
                record["stop_requested_at"] = stamp()
                self.park(ledger, record["ticket_id"], "Its execution was stopped by a person. What it had done by then is not known; check the ticket before resuming.",
                          {"ticket_id": record["ticket_id"], "slice_id": record.get("slice_id"), "execution_id": execution_id})
                stopped.append({"execution_id": execution_id, "ticket_id": record["ticket_id"], "signalled": signalled})
            self.line.save(ledger)
        return stopped

    # ---- running continuously ----

    def serve(self, interval: Optional[int] = None, max_ticks: Optional[int] = None) -> Dict[str, Any]:
        """Tick until the Factory is disabled here, the process is told to stop, or another supervisor takes over."""
        pol = self.policy()
        if not policy_module.running(pol):
            return {"served": 0, "stopped": "the Factory is not enabled on this machine"}
        self.lease.runner_id = pol.get("runner_id")
        wait = int(interval or pol["limits"]["poll_seconds"])
        taken_over = self.lease.acquire(max(LEASE_SECONDS, wait * 3))
        stopping = {"now": False}

        def stop(number: int, frame: Any) -> None:
            stopping["now"] = True

        previous = {number: signal.signal(number, stop) for number in (signal.SIGTERM, signal.SIGINT)}
        ticks, why = 0, "asked to stop"
        try:
            if taken_over:
                with self.line.lock("supervisor"):
                    ledger = self.line.ledger()
                    self.attach(pol)
                    self.line.emit(ledger, "recovery.started", kind="took-over-from-dead-supervisor", previous_pid=taken_over.get("pid"), previous_heartbeat=taken_over.get("heartbeat_at"))
                    self.line.save(ledger)
            while not stopping["now"]:
                report = self.tick()
                ticks += 1
                if report["state"] == "disabled":
                    why = "the Factory was disabled"
                    break
                if max_ticks and ticks >= max_ticks:
                    why = "the requested number of passes was made"
                    break
                woken = self.wake_path.stat().st_mtime if self.wake_path.exists() else 0
                deadline, beat = time.time() + wait, time.time()
                while time.time() < deadline and not stopping["now"]:
                    time.sleep(min(1.0, max(0.05, deadline - time.time())))
                    if (self.wake_path.stat().st_mtime if self.wake_path.exists() else 0) != woken:
                        break  # a Git hook or a person said to look now
                    if time.time() - beat >= 30:
                        self.lease.heartbeat(max(LEASE_SECONDS, wait * 3))
                        beat = time.time()
        except SupervisorError as exc:
            why = str(exc)
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)
            self.lease.release()
        return {"served": ticks, "stopped": why}

    def once(self) -> Dict[str, Any]:
        """A single pass by a process that owns the project only while it runs."""
        pol = self.policy()
        if not policy_module.running(pol):
            return self.tick()
        self.lease.runner_id = pol.get("runner_id")
        self.lease.acquire()
        try:
            return self.tick()
        finally:
            self.lease.release()


def wake(root: Path, event: str) -> bool:
    """Leave a note that something changed. Called by Git hooks; starts nothing and never fails loudly."""
    with contextlib.suppress(Exception):
        if not policy_module.running(policy_module.read(root)):
            return False
        policy_module.write_private(policy_module.local_dir(root) / "wake", json.dumps({"event": str(event)[:40], "at": stamp()}) + "\n")
        return True
    return False
