#!/usr/bin/env python3
"""The Factory's lifecycle on one machine: status, start (= enable), disable, pause, resume and stop, and the hand-over.

These are the operations behind `/mach:run factory ...` and behind `pull`'s hand-over:

    status    what is in force here and what the supervisor is doing (its lifetime). Changes nothing, ever.
    start     one step: the checks run, the authorization is written for this machine and folder, and a supervisor
              is started that runs in the background until stopped (lifetime "background"). Run again, it changes
              only what was asked for; a supervisor already running is not doubled, and one tied to a session is
              made a background one in place. `enable` is the same command.
    pause     no new work is dispatched or started. Work already running finishes its run.
    resume    readiness is checked again, dispatch continues, and the supervisor is started or woken.
    disable   automatic execution is revoked here; hooks and any persistent service are removed. A person's
              disable sticks: `pull` never turns it back on.
    stop      running executions are told to stop now, and the supervisor exits, whichever lifetime and from
              wherever asked. The authorization stays: the next pull or start starts it again.

    HandOver  what `pull` uses: whether this batch can go to the supervisor (design M23 2.2), writing the
              authorization the first time, the supervisor's authorization for the dispatch, and taking
              over in-line tickets no worker holds.
    carry_on  wake the live supervisor; with none, start one tied to this Claude Code session (lifetime
              "session": it pauses its work and exits when the session ends). `pull`, a recorded decision and
              `resume` call it. It never raises for an ordinary reason.

Nothing here runs because MACH was installed or a project cloned: a fresh clone has no authorization
until someone runs `pull` or `factory enable` there.

Standard library only. Imported by run.py; not a command of its own.
"""

import contextlib
import getpass
import json
import os
import platform
import secrets
import shutil
import signal
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import executor
import policy as policy_module
import service
import supervisor as supervisor_module
from supervisor import SUPERVISOR, Supervisor

LIVE = supervisor_module.LIVE
# What `factory enable` says about monitoring requests (M8 D7), in exactly these words.
MONITORING_STATEMENT = {
    False: "Does not take issues from monitoring accounts. Those wait for an engineer.",
    True: ("Also takes issues filed by the monitoring accounts this project lists (tickets.github.monitor_accounts) and grooms them without a person, "
           "at most 3 per pass. Each answer is recorded as decided without a product manager; anything about money, access, deletion or conflicting rules "
           "stops for a person. Builds only what grooming rates below High risk, and within this machine's risk limit. The issue text comes from outside "
           "the team; it is treated as data."),
}
PULL_REQUEST = {"autonomy": "supervised", "limits": {}, "allow_merge": True}  # what a pull writes the first time (M23 2.1)
STOP_COMMAND = "/mach stop"
ENABLE_COMMAND = "/mach factory start"
RESUME_COMMAND = "/mach resume"
NOT_THE_SUPERVISORS_CHECKS = ("ownership", "persistent_service")  # a live supervisor is woken; the service is the person's own choice


class ActivationError(Exception):
    """A problem the caller can fix; run.py prints it as a refusal."""


class Context:
    def __init__(self, root: Path, config: Dict[str, Any], line: Any, sup: Supervisor, git: Any, audit: Any, run_script: Path, workflow_installed: bool,
                 m3_problem: Optional[str]):
        self.root, self.config, self.line, self.sup, self.git, self.audit = root, config, line, sup, git, audit
        self.run_script, self.workflow_installed, self.m3_problem = run_script, workflow_installed, m3_problem


def local_state_ignored(ctx: Context) -> bool:
    """Machine-local authorization must be impossible to commit. Make it so, then check."""
    git = ctx.git
    if git(ctx.root, "rev-parse", "--is-inside-work-tree").returncode != 0:
        return False
    if git(ctx.root, "check-ignore", "-q", ".factory/local/probe").returncode != 0:
        common = git(ctx.root, "rev-parse", "--git-common-dir").stdout.strip()
        if common:
            exclude = (ctx.root / common).resolve() / "info" / "exclude"
            exclude.parent.mkdir(parents=True, exist_ok=True)
            existing = exclude.read_text(encoding="utf-8") if exclude.is_file() else ""
            if ".factory/local/" not in existing.splitlines():
                with exclude.open("a", encoding="utf-8") as handle:
                    handle.write(("" if existing.endswith("\n") or not existing else "\n") + ".factory/local/\n")
    return git(ctx.root, "check-ignore", "-q", ".factory/local/probe").returncode == 0


def describe(pol: Dict[str, Any]) -> Dict[str, Any]:
    return {"monitoring_requests": pol.get("monitoring_requests") is True,
            **{key: pol.get(key) for key in ("enabled", "paused", "autonomy", "auto_sync", "allow_merge", "persistent", "max_risk", "limits", "allowed_tools",
                                             "excluded_slices", "source_branch", "runner_id", "machine", "enabled_by", "enabled_at")}}


def turned_off_by_a_person(raw: Dict[str, Any]) -> bool:
    """A valid authorization that says enabled: false. Only a person's `factory disable` writes that."""
    return raw.get("source") == "local-file" and not raw.get("enabled")


def why_not(raw: Dict[str, Any], pol: Dict[str, Any]) -> Optional[str]:
    """Why the Factory may not work here now, in one sentence that says what changes it; None when it may."""
    if raw.get("source") == "invalid-file":
        return (raw.get("problems") or ["The Factory's authorization on this machine cannot be used."])[0]
    if raw.get("source") != "local-file":
        return "The Factory has not been turned on here yet. /mach pull turns it on and hands it ready work."
    if turned_off_by_a_person(raw):
        return f"A person turned the Factory off on this machine. {ENABLE_COMMAND} turns it back on."
    section = pol.get("restricted_by_project") or []
    if not pol.get("enabled"):
        return ("This project does not allow a supervisor: factory.supervisor is false in .factory/config.json. "
                "Its tickets run in the conversation (/mach <ticket>, or /mach pull --here).") if any("factory.supervisor" in item for item in section) \
            else (section[0] if section else "The Factory is off on this machine.")
    if pol.get("paused"):
        return f"The Factory is paused on this machine. {RESUME_COMMAND} carries on."
    if pol.get("security_review_problems"):
        return pol["security_review_problems"][0]
    if pol.get("autonomy") != "supervised":
        if any("autonomy_ceiling" in item for item in section):
            return ("This project's settings keep the Factory to observing (factory.autonomy_ceiling is observe in .factory/config.json), so it "
                    "starts no work. Its tickets run in the conversation (/mach <ticket>, or /mach pull --here).")
        return f"The Factory is set to observe on this machine, so it starts no work. {ENABLE_COMMAND} --autonomy supervised lets it run work."
    return None


# A person's pull, start, resume or decision is their word that the work runs. When the only thing holding the supervisor is
# this machine's own setting to observe (an older authorization, or a person's earlier choice), that word sets it to supervised.
# The project's own restrictions (factory.supervisor, factory.autonomy_ceiling, a security-review problem), a person's pause and
# a person's disable still hold, and are said with the setting that changes them.
OBSERVE_LIFTED = "This machine was set to observe only; MACH set it to supervised, as you asked for the work to run."
PERSON_STARTS = ("pull", "decide", "resume", "factory start")


def held_only_by_machine_observe(raw: Dict[str, Any], config: Dict[str, Any]) -> bool:
    """Whether this machine's own autonomy setting (observe) is the one thing between a person and the supervisor starting."""
    if raw.get("source") != "local-file" or not raw.get("enabled") or raw.get("autonomy") != "observe":
        return False
    would = {**raw, "autonomy": "supervised"}
    return why_not(would, policy_module.effective(would, config)) is None


def lift_machine_observe(ctx: Context, via: str) -> Optional[str]:
    """On a person's start: set this machine's autonomy to supervised when observe is all that holds the Factory, record that
    it was done, and return the one sentence to say; None when nothing was changed."""
    raw = policy_module.read(ctx.root)
    if not held_only_by_machine_observe(raw, ctx.config):
        return None
    raw["autonomy"] = "supervised"
    policy_module.save(ctx.root, raw)
    if ctx.line is not None:
        with contextlib.suppress(Exception):  # the setting is changed either way; the event is the record of it
            with ctx.line.lock("activation"):
                ledger = ctx.line.ledger()
                ctx.line.runner_id = raw.get("runner_id")
                ctx.line.event_source = "engineer"
                ctx.line.emit(ledger, "factory.activated", autonomy="supervised", by=person(ctx), via=via, limits=raw.get("limits") or {},
                              allow_merge=bool(raw.get("allow_merge")), persistent=bool(raw.get("persistent")), backlog=None,
                              excluded_slices=list(raw.get("excluded_slices") or []))
                ctx.line.save(ledger)
    return OBSERVE_LIFTED


def status(ctx: Context) -> Dict[str, Any]:
    """Everything about the Factory on this machine. Reads only: asking never enables, wakes or dispatches anything."""
    raw = policy_module.read(ctx.root)
    pol = policy_module.effective(raw, ctx.config)
    in_force = policy_module.running(pol)
    lease = ctx.sup.lease.read()
    alive = ctx.sup.lease.live(lease)
    ledger = ctx.line.ledger() if ctx.line is not None else {"supervisor": {"executions": {}, "parked": {}, "attempts": {}}}
    state = ledger["supervisor"]
    limit = ctx.sup.cap(pol) if ctx.line is not None else None  # the plan below shows the limit in force here, not only the project's
    plan = ctx.line.plan() if ctx.line is not None else None
    mode = "disabled" if not in_force else "paused" if pol.get("paused") else pol.get("autonomy")
    # A parked ticket whose work has since left the line (abandoned or merged, with no cell open) is
    # waiting for nobody (recorded facts: the run record), so it is listed apart.
    settled = ctx.line.settled(ledger, sorted(state["parked"])) if ctx.line is not None else {}
    disabled_words = (f"A person turned the Factory off on this machine. Nothing runs unless an engineer runs it; {ENABLE_COMMAND} turns it back on."
                      if turned_off_by_a_person(raw) else
                      "The Factory is off on this machine. Nothing runs unless an engineer runs it; /mach pull turns it on and hands it ready work.")
    return {
        "factory": mode,
        "enabled_here": in_force,
        "turned_off_by_a_person": turned_off_by_a_person(raw),
        "in_words": {"disabled": disabled_words,
                     "paused": f"The Factory is on but paused: nothing new is dispatched or started. {RESUME_COMMAND} carries on.",
                     "observe": "Observe: slices marked ready are discovered, taken in and planned. No agent is started.",
                     "supervised": ("Supervised: the Factory runs ready work in the background and stops wherever a person is needed. "
                                    f"{STOP_COMMAND} stops it.")}[str(mode)],
        "why_not": why_not(raw, pol),
        "policy": describe(pol) if raw.get("source") == "local-file" else None,
        "problems": raw.get("problems") or [],
        "restricted_by_project": pol.get("restricted_by_project") or [],
        "supervisor": {"running": bool(alive), "pid": (lease or {}).get("pid") if alive else None, "since": (lease or {}).get("started_at") if alive else None,
                       "last_heartbeat": (lease or {}).get("heartbeat_at") if alive else None, "last_pass": state.get("last_tick"),
                       # session: tied to the Claude Code session that started it (pull); background: runs until stopped (factory start)
                       "lifetime": ((lease or {}).get("lifetime") or "background") if alive else None,
                       "session_pid": (lease or {}).get("session_pid") if alive else None,
                       "started_by": (lease or {}).get("started_by") if alive else None,
                       "log": ".factory/local/supervisor.log"},
        "executions": [{key: record.get(key) for key in ("execution_id", "ticket_id", "slice_id", "state", "started_at", "session_id", "attempt")}
                       for _, record in sorted(state["executions"].items()) if record["state"] in LIVE],
        "waiting_for_a_person": {ticket: record for ticket, record in state["parked"].items() if ticket not in settled},
        "no_longer_waiting": [{**settled[ticket], "parked_reason": state["parked"][ticket].get("reason"),
                               "in_words": f"{ticket}'s work left the line: it was {settled[ticket]['outcome']}."}
                              for ticket in sorted(settled)],
        "plan": {**{key: plan[key] for key in ("counts", "dispatchable", "waiting_for_a_place", "runnable", "needs_person", "intake_is_current", "limits")},
                 "max_parallel_from": limit} if plan else None,
        "git_hooks": service.hooks_status(ctx.root),
        "persistent_service": service.agent_status(ctx.root),
        "factory_started": False,
    }


def checks(ctx: Context, request: Dict[str, Any], probe: bool) -> List[Dict[str, Any]]:
    integration = ctx.line.integration() if ctx.line is not None else {"problems": ["Product intake is not available."], "branch": None}
    return policy_module.preflight(ctx.root, ctx.config, request, git=ctx.git, audit=ctx.audit(), integration=integration, m3_problem=ctx.m3_problem,
                                   workflow_installed=ctx.workflow_installed, lease_holder=ctx.sup.lease.holder(), ignored=local_state_ignored(ctx), probe=probe,
                                   boundary=lambda: executor.plugin(ctx.root, ctx.run_script))


def failed(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [item for item in results if item["required"] and not item["ok"] and item["check"] not in NOT_THE_SUPERVISORS_CHECKS]


def person(ctx: Context) -> str:
    return ctx.git(ctx.root, "config", "user.name").stdout.strip() or getpass.getuser()


def summarize(request: Dict[str, Any]) -> Dict[str, Any]:
    """What the authorization lets the Factory do, in plain words."""
    supervised = request["autonomy"] == "supervised"
    tools = list(dict.fromkeys([*policy_module.default_tools(), *request.get("extra_tools", [])]))
    limits = {name: (request.get("limits") or {}).get(name, default) for name, (default, _, _) in policy_module.LIMITS.items()}
    return {
        "autonomy": request["autonomy"],
        "what_it_does": "Discovers, takes in and plans approved work. Starts no agent." if not supervised
        else "Runs approved, eligible work through the line in the background, and stops wherever a person is needed.",
        "merges": ("Low and Medium risk merge once review approves, as this project's merge settings allow; High risk, and anything review "
                   "sends to a person, waits for a person.") if request.get("allow_merge") is not False
        else "Never merges: every ticket stops before the merge station for a person.",
        "limits": limits,
        "spending": "No spending limit unless one is set here or in the project's settings." if limits["max_budget_usd_per_run"] is None
        and limits["max_budget_usd_per_day"] is None else "Spending is limited as set.",
        "max_risk": request.get("max_risk") or "High",
        "tools_each_execution_may_use": tools if supervised else [],
        "everything_else": "Refused, and raised to a person. Nothing is granted quietly.",
        "execution_boundary": ("Each execution runs Claude Code in restricted mode, signed in with your own Claude Code login. Your own Claude settings and their "
                               "allow rules, your plugins, MCP servers, agents and hooks are not loaded; MACH is its only plugin. Only the built-in tools in the "
                               "list above exist in the run, the file tools stay inside this project, and anything that would need your approval is refused. "
                               "No API key, token or other credential from the supervisor's environment is passed to it. This bounds Claude's tools; it is not "
                               "a sandbox: allowed commands, including any Python command, run as you.") if supervised else None,
        "runs_repository_code": "Building and verifying run this repository's tests and build scripts on this machine, as you." if supervised else None,
        "what_an_execution_can_do": policy_module.execution_risk(tools)["statement"] if supervised else None,
        "fetches": "Fetches from the shared repository on a timer. Never changes your checkout." if request.get("auto_sync") else "Never fetches by itself.",
        "git_hooks": "Adds wake-up notes to post-merge, post-checkout and post-rewrite." if request.get("hooks") else "No Git hooks.",
        "persistent": "Installs a per-user service that keeps the supervisor running without a Claude session." if request.get("persistent")
        else "The supervisor runs in the background until stopped; no service is installed.",
        "monitoring_requests": MONITORING_STATEMENT[request.get("monitoring_requests") is True],
        "stop": f"{STOP_COMMAND} ends the Factory: running work stops where it is. /mach pull or /mach factory start starts it again.",
    }


def write_authorization(ctx: Context, request: Dict[str, Any], enabled_by: str, via: str, runner_id: Optional[str] = None) -> Dict[str, Any]:
    """Write the authorization for this machine and folder, and record that it was written."""
    integration = ctx.line.integration()
    pol = policy_module.build(ctx.root, request, enabled_by, shutil.which("claude") or "claude", str(integration.get("branch") or "main"), [], runner_id=runner_id)
    policy_module.save(ctx.root, pol)
    policy_module.forget_pending(ctx.root)
    with ctx.line.lock("activation"):
        ledger = ctx.line.ledger()
        ctx.line.runner_id = pol["runner_id"]
        ctx.line.event_source = "engineer"
        ctx.line.emit(ledger, "factory.activated", autonomy=pol["autonomy"], by=pol["enabled_by"], via=via, limits=pol["limits"], allow_merge=pol["allow_merge"],
                      persistent=pol["persistent"], backlog=None, excluded_slices=pol["excluded_slices"])
        ctx.line.save(ledger)
    return pol


def enable(ctx: Context, args: Any) -> Dict[str, Any]:
    """One step. Run again while enabled, only what is asked for changes; after a disable it starts afresh."""
    raw = policy_module.read(ctx.root)
    previous = raw if raw.get("source") == "local-file" and raw.get("enabled") else None
    asked = {name: value for name, value in (("max_parallel", args.max_parallel), ("max_execution_minutes", args.max_minutes), ("max_runs_per_day", args.max_runs_per_day),
                                             ("max_budget_usd_per_run", args.budget_per_run), ("max_budget_usd_per_day", args.budget_per_day),
                                             ("max_attempts", args.max_attempts), ("poll_seconds", args.poll_seconds)) if value is not None}
    base = previous or {}
    # A person's start runs work: without --autonomy it is supervised, even where this machine was set to observe before.
    lifted = OBSERVE_LIFTED if not args.autonomy and base.get("autonomy") == "observe" else None
    request = {"autonomy": args.autonomy or "supervised",
               "limits": {**(base.get("limits") or {}), **asked},
               "allow_merge": False if args.no_merge else base.get("allow_merge", True),
               "auto_sync": bool(args.auto_sync or base.get("auto_sync")), "persistent": bool(args.persistent or base.get("persistent")),
               "hooks": bool(args.hooks), "max_risk": args.max_risk or base.get("max_risk") or "High",
               "extra_tools": [tool for tool in (base.get("allowed_tools") or []) if tool not in policy_module.default_tools()] + list(args.allow_tool or [])}
    if getattr(args, "monitoring_requests", False) or base.get("monitoring_requests") is True:  # only on the engineer's explicit request, and only for supervised work
        if request["autonomy"] != "supervised":
            raise ActivationError("--monitoring-requests needs --autonomy supervised: monitoring requests are groomed and built by executions. Nothing was changed.")
        request["monitoring_requests"] = True
    try:
        policy_module.build(ctx.root, request, "check", "claude", "main", [])  # reject a bad limit before anything else
    except policy_module.PolicyError as exc:
        raise ActivationError(str(exc) + " Nothing was changed.")
    results = checks(ctx, request, probe=True)
    summary = summarize(request)
    if failed(results):
        return {"ready": False, "enabled": False, "why": failed(results)[0]["detail"], "failed": failed(results), "checks": results, "summary": summary,
                "factory_started": False}
    pol = write_authorization(ctx, request, person(ctx), "enable", runner_id=(previous or {}).get("runner_id"))
    hooks = service.install_hooks(ctx.root, ctx.run_script) if request.get("hooks") else {"installed": service.hooks_status(ctx.root), "skipped": None}
    agent = None
    if request.get("persistent") and not service.agent_status(ctx.root)["installed"]:
        try:
            agent = service.install_agent(ctx.root, ctx.run_script)
        except service.ServiceError as exc:
            pol["persistent"] = False
            policy_module.save(ctx.root, pol)
            agent = {"error": str(exc)}
    started = start_background(ctx)  # factory start (= enable): a supervisor that outlives the session
    return {"ready": True, "enabled": True, "updated": previous is not None, "factory": pol["autonomy"], "policy": describe(pol), "summary": summary, "checks": results,
            "git_hooks": hooks, "persistent_service": agent,
            "supervisor": started["supervisor"], "pid": started.get("pid"), "why_not": started.get("why_not"),
            **({"already_running": started["already_running"]} if started.get("already_running") else {}),
            "in_words": " ".join(part for part in (lifted, started.get("in_words") or started.get("why_not")) if part),
            **({"observe_lifted": lifted} if lifted else {}),
            "next": ("The Factory is on for this machine only, and runs in the background until stopped. /mach pull hands it ready work; "
                     "/mach factory stop stops it."),
            "factory_started": started["supervisor"] in ("started", "converted", "already-running", "service")}


# ---- starting or waking the supervisor ----


def wake_note(root: Path, why: str) -> None:
    """Tell a live supervisor to look again now. Unique each time, so two wakes in one second are both seen."""
    policy_module.write_private(policy_module.local_dir(root) / "wake",
                                json.dumps({"event": str(why)[:40], "at": policy_module.stamp(), "n": secrets.token_hex(4)}) + "\n")


def give_to_supervisor(ctx: Context, tickets: Sequence[str]) -> Tuple[List[str], List[Dict[str, str]]]:
    """Give the supervisor these tickets' slices in the line (owner "supervisor"), under the intake lock, whoever dispatched
    them: a person's decision released them. Returns (given, kept): a ticket is kept where it is, with why, when a worker in a
    conversation holds a fresh claim on it (ctx.held_by, from run.py), or when it is not from a slice (an engineer's own
    ticket, which the supervisor never runs): /mach <ticket> carries those on."""
    wanted = list(dict.fromkeys(str(ticket) for ticket in tickets))
    given: List[str] = []
    kept: List[Dict[str, str]] = []
    if not wanted or ctx.line is None:
        return given, kept
    held_by: Callable[[str], Optional[str]] = getattr(ctx, "held_by", None) or (lambda ticket: None)
    with ctx.line.lock("activation"):
        ledger = ctx.line.ledger()
        entries = {str(entry.get("ticket_id")): entry for entry in ledger["slices"].values() if entry.get("dispatched_at")}
        for ticket in wanted:
            entry = entries.get(ticket)
            if entry is None:
                kept.append({"ticket_id": ticket, "why": f"it is an engineer's own ticket, which the Factory does not run: /mach {ticket} carries it on"})
                continue
            holder = held_by(ticket)
            if holder:
                kept.append({"ticket_id": ticket, "why": f"{holder}; it is not given to the Factory while that worker has it. Say /mach {ticket} "
                             "and MACH takes it over and builds it here"})
                continue
            if entry.get("owner") != SUPERVISOR:
                entry["owner"] = SUPERVISOR
            given.append(ticket)
        if any(entries[ticket].get("owner") == SUPERVISOR for ticket in given):
            ctx.line.save(ledger)
    return given, kept


NO_SESSION = ("MACH could not find the Claude Code session this runs in, so it cannot tie the Factory to it. "
              "/mach factory start runs the Factory in the background instead.")
NONE_RUNNING = "No Factory is running here. /mach pull in Claude Code carries it on."


def running_words(already: Dict[str, Any], took: bool = True) -> str:
    """One line about a supervisor that was already running when a pull or a start found it."""
    since = already.get("since") or "earlier"
    taken = " It has taken this batch." if took else ""
    if already.get("lifetime") == "session":
        return (f"A Factory started from a Claude Code session is already running here (started {since}).{taken} "
                "It stops when that session ends; /mach factory start keeps it running in the background.")
    return f"A Factory is already running here in the background (started {since}).{taken} /mach factory stop stops it."


def carry_on(ctx: Context, tickets: Sequence[str] = (), start: bool = True, started_by: str = "pull") -> Dict[str, Any]:
    """Wake the live supervisor; with none live, start one tied to this Claude Code session (start=True, from a terminal), or,
    with start=False (the browser app's process, which has no session), start nothing.

    `tickets`: tickets a person's decision just released (decide do). Only when a supervisor is running here or is about to be
    started do they become the supervisor's (give_to_supervisor), even if an engineer dispatched them; a ticket a worker in a
    conversation holds, or an engineer's own ticket, is kept where it is.

    Returns {"supervisor": "started"|"woken"|"none", "pid": int|None, "why_not": str|None}; with "woken", also "already_running"
    ({"lifetime", "since", "pid", "started_by"}); with `tickets`, also "given": [tickets] and "not_given": [{"ticket_id", "why"}].
    Never raises for an ordinary reason (not on, turned off, paused, forbidden by the project, no session found): it answers
    "none" with the reason and what changes it."""
    try:
        raw = policy_module.read(ctx.root)
        pol = policy_module.effective(raw, ctx.config)
        reason = why_not(raw, pol)
        lifted = None
        if reason and started_by in PERSON_STARTS and held_only_by_machine_observe(raw, ctx.config):
            lifted = lift_machine_observe(ctx, started_by)  # a person's word that the work runs: observe on this machine was all that held it
            reason = None if lifted else reason
        if reason:
            return {"supervisor": "none", "pid": None, "why_not": reason, **({"given": [], "not_given": []} if tickets else {})}
        if lifted:
            return {**carry_on(ctx, tickets=tickets, start=start, started_by=started_by), "observe_lifted": lifted}
        if tickets:
            will_take = bool(ctx.sup.lease.running()) or (start and bool(service.find_session_pid()))
            given, kept = give_to_supervisor(ctx, tickets) if will_take else ([], [])
            if kept and not given:  # each stays where it is driven: no supervisor is started just for it
                return {"supervisor": "none", "pid": None, "why_not": None, "given": [], "not_given": kept}
            # Should the start fail after all, the tickets given stay the supervisor's: the next pull or decision carries them on.
            result = carry_on(ctx, start=start, started_by=started_by)
            return {**result, "given": given, "not_given": kept}
        wake_note(ctx.root, "carry-on")
        already = ctx.sup.lease.running()
        if already:
            return {"supervisor": "woken", "pid": already["pid"], "why_not": None, "already_running": already}
        if not start:
            return {"supervisor": "none", "pid": None, "why_not": NONE_RUNNING}
        session = service.find_session_pid()
        if not session:
            return {"supervisor": "none", "pid": None, "why_not": NO_SESSION}
        pid = service.start_detached(ctx.root, ctx.run_script, lifetime="session", session_pid=session, started_by=started_by)
        return {"supervisor": "started", "pid": pid, "why_not": None, "lifetime": "session"}
    except Exception as exc:  # noqa: BLE001  the caller's work is done either way; say what happened and what to do
        return {"supervisor": "none", "pid": None,
                "why_not": f"MACH could not start the supervisor ({exc.__class__.__name__}: {str(exc)[:200]}). /mach pull tries again; "
                           "the work handed to the Factory waits for it."}


def start_background(ctx: Context, started_by: str = "factory start") -> Dict[str, Any]:
    """`factory start` after the authorization is written: a supervisor that outlives the session. One already running is not
    doubled: a background one is reported; a session one is made a background one in place (lifetime.json, which it and the
    runs it started read within a second)."""
    already = ctx.sup.lease.running()
    if already:
        converted = False
        if already["lifetime"] == "session":
            policy_module.write_private(policy_module.local_dir(ctx.root) / "lifetime.json",
                                        json.dumps({"lifetime": "background", "by": started_by, "at": policy_module.stamp()}) + "\n")
            wake_note(ctx.root, "background")
            converted = True
        return {"supervisor": "converted" if converted else "already-running", "pid": already["pid"], "why_not": None,
                "already_running": already,
                "in_words": ("The Factory that was running with a Claude Code session now runs in the background: it no longer stops when that "
                             "session ends. /mach factory stop stops it.") if converted else
                running_words(already, took=False)}
    if service.agent_status(ctx.root)["installed"]:
        return {"supervisor": "service", "pid": None, "why_not": None,
                "in_words": "The persistent service runs the Factory in the background. /mach factory stop stops it."}
    try:
        pid = service.start_detached(ctx.root, ctx.run_script, lifetime="background", started_by=started_by)
    except (service.ServiceError, OSError) as exc:
        return {"supervisor": "none", "pid": None, "why_not": f"MACH could not start the supervisor: {exc} /mach factory start tries again."}
    return {"supervisor": "started", "pid": pid, "why_not": None, "lifetime": "background",
            "in_words": "The Factory runs in the background on this machine, also after Claude Code closes. /mach factory stop stops it."}


class HandOver:
    """`pull`'s hand-over (M23 2): whether this batch goes to the supervisor, and the steps that give it to it.

    ready()      None when the batch may be handed over, or the one reason it is not (2.2) in the failing check's own sentence.
    take()       write the authorization here the first time (enabled_by "pull"); sets first_time.
    authorize()  the supervisor's authorization for intake's guarded dispatch, read from disk at that moment.
    reown()      give in-line tickets the supervisor's ownership.
    carry_on()   start or wake the supervisor, once the intake lock is released."""

    owner = SUPERVISOR

    def __init__(self, ctx: Context, here: bool = False):
        self.ctx, self.here = ctx, here
        self.first_time = False
        self.lift_observe = False  # observe on this machine is all that holds the batch: take() sets it to supervised
        self.lifted: Optional[str] = None
        self._ready: Any = ()

    def ready(self) -> Optional[str]:
        if self._ready == ():
            self._ready = self._check()
        return self._ready

    def _check(self) -> Optional[str]:
        ctx = self.ctx
        if self.here:
            return "You asked for this batch to run here (--here)."
        raw = policy_module.read(ctx.root)
        pol = policy_module.effective(raw, ctx.config)
        section = ctx.config.get("factory") if isinstance(ctx.config.get("factory"), dict) else {}
        if section.get("supervisor") is False:
            return ("This project does not allow a supervisor: factory.supervisor is false in .factory/config.json. "
                    "MACH runs the batch here instead.")
        if raw.get("source") == "local-file":
            reason = why_not(raw, pol)
            if reason and held_only_by_machine_observe(raw, ctx.config):
                self.lift_observe, reason = True, None  # a person's pull: the work runs, and take() says so
            if reason:
                return reason
        elif raw.get("source") == "invalid-file":
            return why_not(raw, pol)
        else:
            # Nothing written yet: judge the authorization take() would write, through this project's own restrictions, before
            # anything is written or any ticket changes hands.
            would = {**policy_module.build(ctx.root, PULL_REQUEST, "pull", "claude", "main"), "source": "local-file", "problems": []}
            reason = why_not(would, policy_module.effective(would, ctx.config))
            if reason:
                return reason
        request = {"autonomy": "supervised", "limits": {}, "allow_merge": True, "persistent": False}
        problem = next(iter(failed(checks(self.ctx, request, probe=False))), None)
        if problem:
            return problem["detail"]
        if not ctx.sup.lease.running() and not service.find_session_pid():
            return NO_SESSION  # a supervisor started here is tied to this session, and none can be found
        return None

    def take(self) -> None:
        """The authorization, written the first time a pull hands work over here. Never over a person's disable."""
        raw = policy_module.read(self.ctx.root)
        if raw.get("source") == "local-file":
            if self.lift_observe:
                self.lifted = lift_machine_observe(self.ctx, "pull")
            return
        write_authorization(self.ctx, PULL_REQUEST, "pull", "pull")
        self.first_time = True

    def authorize(self, plan: Dict[str, Any]) -> Tuple[bool, str]:
        """Asked by intake immediately before it dispatches. The answer comes from the disk, as the supervisor's own does."""
        pol = policy_module.effective(policy_module.read(self.ctx.root), self.ctx.config)
        allowed, why = policy_module.may_execute(pol)
        if not allowed:
            return False, why
        audit = self.ctx.audit()
        if audit.get("state") not in ("ok", "off"):
            return False, f"the readiness audit is {audit.get('state')}"
        return True, f"a person's pull on this machine, for the supervisor ({why})"

    def reown(self, slice_ids: Sequence[str]) -> List[str]:
        """Give these slices' tickets in the line to the supervisor. The caller holds the intake lock."""
        line = self.ctx.line
        ledger = line.ledger()
        given = []
        for key in slice_ids:
            entry = ledger["slices"].get(key)
            if entry and entry.get("dispatched_at") and entry.get("owner") != SUPERVISOR:
                entry["owner"] = SUPERVISOR
                given.append(key)
        if given:
            line.save(ledger)
        return given

    def running(self) -> Optional[Dict[str, Any]]:
        """The supervisor running here now, with the line that says so (took=False: nothing was handed to it); None when none is."""
        already = self.ctx.sup.lease.running()
        return {"already_running": already, "running_words": running_words(already, took=False)} if already else None

    def carry_on(self) -> Dict[str, Any]:
        """Wake the live supervisor, or start one tied to this session; say which, and what was already running."""
        result = carry_on(self.ctx, started_by="pull")
        if result.get("already_running"):
            result["in_words"] = running_words(result["already_running"])
        return result


# ---- the person's switches ----


def change(ctx: Context, kind: str, **fields: Any) -> None:
    with ctx.line.lock("activation"):
        ledger = ctx.line.ledger()
        ctx.line.runner_id = policy_module.read(ctx.root).get("runner_id")
        ctx.line.event_source = "engineer"
        ctx.line.emit(ledger, kind, **fields)
        ctx.line.save(ledger)


def enabled_policy(ctx: Context, action: str) -> Dict[str, Any]:
    pol = policy_module.read(ctx.root)
    if pol.get("source") != "local-file" or not pol.get("enabled"):
        if turned_off_by_a_person(pol):
            raise ActivationError(f"A person turned the Factory off on this machine, so there is nothing to {action}. {ENABLE_COMMAND} turns it back on.")
        raise ActivationError(f"The Factory is off on this machine, so there is nothing to {action}. /mach pull turns it on and hands it ready work.")
    return pol


def pause(ctx: Context) -> Dict[str, Any]:
    pol = enabled_policy(ctx, "pause")
    if not pol["paused"]:
        pol["paused"] = True
        policy_module.save(ctx.root, pol)
        change(ctx, "factory.paused", by="engineer")
    running = [item["ticket_id"] for item in status(ctx)["executions"]]
    return {"paused": True, "still_running": running,
            "note": ("Nothing new will be dispatched or started. Work already running finishes its run and stops at its next gate." if running
                     else "Nothing new will be dispatched or started.") + f" {RESUME_COMMAND} carries on."}


def resume(ctx: Context, args: Any) -> Dict[str, Any]:
    pol = enabled_policy(ctx, "resume")
    request = {"autonomy": pol["autonomy"], "limits": pol["limits"], "allow_merge": pol["allow_merge"], "persistent": False}
    results = checks(ctx, request, probe=False)
    if failed(results):
        return {"resumed": False, "why": "Readiness was checked again and did not pass, so the Factory stays as it was: " + failed(results)[0]["detail"],
                "failed": failed(results), "supervisor": "none"}
    cleared: List[str] = []
    with ctx.line.lock("activation"):
        ledger = ctx.line.ledger()
        parked = ledger["supervisor"]["parked"]
        for ticket in (list(parked) if getattr(args, "retry_all", False) else getattr(args, "retry", None) or []):
            if ticket in parked:
                parked.pop(ticket)
                ledger["supervisor"]["attempts"].pop(ticket, None)
                cleared.append(ticket)
        ctx.line.save(ledger)
    was_paused = pol["paused"]
    pol["paused"] = False
    policy_module.save(ctx.root, pol)
    if was_paused or cleared:
        change(ctx, "factory.resumed", by="engineer", retrying=cleared)
    started = carry_on(ctx, started_by="resume")
    return {"resumed": True, "retrying": cleared, "still_waiting_for_a_person": sorted(set(status(ctx)["waiting_for_a_person"]) - set(cleared)), **started}


def disable(ctx: Context, args: Any) -> Dict[str, Any]:
    raw = policy_module.read(ctx.root)
    stopped = ctx.sup.stop_executions() if args.stop else []
    hooks = service.remove_hooks(ctx.root)
    agent = service.remove_agent(ctx.root)
    policy_module.forget_pending(ctx.root)
    was_enabled = raw.get("source") == "local-file" and raw.get("enabled")
    kept_off = True
    if raw.get("source") == "local-file":
        raw.update({"enabled": False, "paused": False, "persistent": False})
        policy_module.save(ctx.root, raw)  # enabled: false sticks; a pull never turns it back on
    else:
        # No file, or one that cannot be used: a valid one saying off is written, so the person's word sticks here too.
        path = policy_module.policy_path(ctx.root)
        with contextlib.suppress(OSError):
            if path.is_symlink():
                path.unlink()  # the link itself, never what it points to
        try:
            off = policy_module.build(ctx.root, {"autonomy": "supervised"}, person(ctx), shutil.which("claude") or "claude",
                                      str((ctx.line.integration() if ctx.line is not None else {}).get("branch") or "main"))
            off.update({"enabled": False, "paused": False, "persistent": False})
            policy_module.save(ctx.root, off)
        except (policy_module.PolicyError, OSError):
            kept_off = False  # tracked by Git, or the folder cannot be written: nothing here can turn the Factory on either
    if was_enabled:
        change(ctx, "factory.disabled", by="engineer", stopped=[item["execution_id"] for item in stopped])
    with contextlib.suppress(OSError):
        policy_module.write_private(policy_module.local_dir(ctx.root) / "wake", "disabled\n")  # a running supervisor notices and exits
    running = [item["ticket_id"] for item in status(ctx)["executions"]]
    return {"disabled": True, "was_enabled": bool(was_enabled), "recorded_off": kept_off, "stopped": stopped, "still_running": running, "git_hooks_removed": hooks, "persistent_service_removed": agent,
            "note": ("Automatic execution is revoked on this machine, and stays off: /mach pull runs batches in the conversation until "
                     f"{ENABLE_COMMAND} turns it back on. " + ("Work already running finishes its run; nothing new starts." if running else "Nothing is running."))}


def end_supervisor(ctx: Context) -> Dict[str, Any]:
    """Make the running supervisor exit, whichever lifetime and whoever started it: a stop note it reads within a second, and,
    when it runs on this machine as `factory serve` for this project, a SIGTERM too. Returns what was running, or None."""
    running = ctx.sup.lease.running()
    with contextlib.suppress(OSError):
        policy_module.write_private(policy_module.local_dir(ctx.root) / "stop", json.dumps({"at": policy_module.stamp()}) + "\n")
    signalled = False
    lease = ctx.sup.lease.read() or {}
    pid = lease.get("pid")
    if running and lease.get("host") == platform.node() and type(pid) is int and pid != os.getpid():
        command = executor.command_of(pid)
        if "factory serve" in command and str(ctx.root) in command:
            with contextlib.suppress(OSError):
                os.kill(pid, signal.SIGTERM)
                signalled = True
    return {"was_running": running, "signalled": signalled}


def stop(ctx: Context, args: Any) -> Dict[str, Any]:
    """The emergency stop, from any session or the browser app: running executions end now, and the Factory is not running
    afterwards. The authorization stays: the next /mach pull or /mach factory start starts it again, with no other step.
    With --execution, only that execution ends and the supervisor goes on."""
    only = getattr(args, "execution", None)
    stopped = ctx.sup.stop_executions(only)
    ended = end_supervisor(ctx) if not only else {"was_running": None, "signalled": False}
    return {"stopped": stopped, "supervisor_stopped": bool(ended["was_running"]), "was_running": ended["was_running"],
            "note": ("The Factory is stopped. Its work is paused where it was: /mach pull or /mach factory start starts the Factory again, "
                     "and it carries each ticket on from there (a run stopped while merging or cleaning up waits for a person)." if not only else
                     "That execution is stopped, and its ticket waits for a person while the Factory goes on with the rest: check it, then "
                     f"{RESUME_COMMAND} --retry <ticket> lets it run again.")}
