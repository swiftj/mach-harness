#!/usr/bin/env python3
"""The Factory's lifecycle on one machine: status, enable, disable, pause, resume and stop.

These are the operations behind `/mach:run factory ...`. Each is deterministic and each is an
act of the engineer at this machine:

    status    what is in force here and what the supervisor is doing. Changes nothing, ever.
    enable    in two steps. The first runs the preflight, shows exactly what would be allowed and
              gives a short-lived code; nothing is enabled. The second, with that code, enables it.
    pause     no new work is dispatched or started. Work already running finishes its run.
    resume    readiness is checked again, then dispatch continues.
    disable   automatic execution is revoked here; hooks and any persistent service are removed.
    stop      running executions are told to stop now. What each had done is recorded as unknown.

Enabling is never a side effect. Running a ticket by hand, installing MACH, cloning the project,
or anything Product Studio does leaves the Factory exactly as it was: disabled, on a fresh clone.

Standard library only. Imported by run.py; not a command of its own.
"""

import contextlib
import getpass
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

import policy as policy_module
import service
import supervisor as supervisor_module
from supervisor import SUPERVISOR, Supervisor

LIVE = supervisor_module.LIVE


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


def backlog(ctx: Context) -> List[Dict[str, Any]]:
    """Product work that was already here before anyone enabled the Factory."""
    if ctx.line is None:
        return []
    found = ctx.line.discover()
    found.pop("_snapshot", None)
    plan = ctx.line.plan()
    rows: Dict[str, Dict[str, Any]] = {}
    for item in found.get("slices") or []:
        if item["status"] in ("new", "modified"):
            rows[item["slice_id"]] = {"slice_id": item["slice_id"], "title": item.get("title"), "why": "approved and merged, not yet taken in" if item["status"] == "new" else "changed since it was taken in"}
    for row in plan["slices"]:
        if row["state"] in ("ready", "blocked", "active"):
            rows.setdefault(row["slice_id"], {"slice_id": row["slice_id"], "title": row.get("title"),
                                              "why": {"ready": "waiting to be dispatched", "blocked": "waiting on something else", "active": "already in the line, moved by an engineer"}[row["state"]]})
    return [rows[key] for key in sorted(rows)]


def describe(pol: Dict[str, Any]) -> Dict[str, Any]:
    return {key: pol.get(key) for key in ("enabled", "paused", "autonomy", "auto_sync", "allow_merge", "persistent", "max_risk", "limits", "allowed_tools",
                                          "excluded_slices", "source_branch", "runner_id", "machine", "enabled_by", "enabled_at")}


def status(ctx: Context) -> Dict[str, Any]:
    """Everything about the Factory on this machine. Reads only: asking never enables, wakes or dispatches anything."""
    raw = policy_module.read(ctx.root)
    pol = policy_module.effective(raw, ctx.config)
    in_force = policy_module.running(pol)
    lease = ctx.sup.lease.read()
    alive = ctx.sup.lease.live(lease)
    ledger = ctx.line.ledger() if ctx.line is not None else {"supervisor": {"executions": {}, "parked": {}, "attempts": {}}}
    state = ledger["supervisor"]
    plan = ctx.line.plan() if ctx.line is not None else None
    mode = "disabled" if not in_force else "paused" if pol.get("paused") else pol.get("autonomy")
    return {
        "factory": mode,
        "enabled_here": in_force,
        "in_words": {"disabled": "The Factory is disabled on this machine. Nothing runs unless an engineer runs it.",
                     "paused": "The Factory is enabled but paused: nothing new is dispatched or started.",
                     "observe": "Observe: approved work is discovered, taken in and planned. No agent is started.",
                     "supervised": "Supervised autopilot: eligible approved work is run, and stops at every human gate."}[str(mode)],
        "policy": describe(pol) if raw.get("source") == "local-file" else None,
        "problems": raw.get("problems") or [],
        "restricted_by_project": pol.get("restricted_by_project") or [],
        "supervisor": {"running": bool(alive), "pid": (lease or {}).get("pid") if alive else None, "since": (lease or {}).get("started_at") if alive else None,
                       "last_heartbeat": (lease or {}).get("heartbeat_at") if alive else None, "last_pass": state.get("last_tick")},
        "executions": [{key: record.get(key) for key in ("execution_id", "ticket_id", "slice_id", "state", "started_at", "session_id", "attempt")}
                       for _, record in sorted(state["executions"].items()) if record["state"] in LIVE],
        "waiting_for_a_person": state["parked"],
        "plan": {key: plan[key] for key in ("counts", "dispatchable", "runnable", "needs_person", "intake_is_current", "limits")} if plan else None,
        "git_hooks": service.hooks_status(ctx.root),
        "persistent_service": service.agent_status(ctx.root),
        "pending_activation": policy_module.pending_path(ctx.root).is_file(),
        "factory_started": False,
    }


def checks(ctx: Context, request: Dict[str, Any], probe: bool) -> List[Dict[str, Any]]:
    integration = ctx.line.integration() if ctx.line is not None else {"problems": ["Product intake is not available."], "branch": None}
    return policy_module.preflight(ctx.root, ctx.config, request, git=ctx.git, audit=ctx.audit(), integration=integration, m3_problem=ctx.m3_problem,
                                   workflow_installed=ctx.workflow_installed, lease_holder=ctx.sup.lease.holder(), ignored=local_state_ignored(ctx), probe=probe)


def failed(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [item for item in results if item["required"] and not item["ok"]]


def enable(ctx: Context, args: Any) -> Dict[str, Any]:
    if args.confirm:
        return confirm(ctx, args.confirm)
    if policy_module.running(policy_module.read(ctx.root)):
        raise ActivationError("The Factory is already enabled on this machine. To change how it runs, disable it and enable it again.")
    limits = {name: value for name, value in (("max_parallel", args.max_parallel), ("max_execution_minutes", args.max_minutes), ("max_runs_per_day", args.max_runs_per_day),
                                              ("max_budget_usd_per_run", args.budget_per_run), ("max_budget_usd_per_day", args.budget_per_day),
                                              ("max_attempts", args.max_attempts), ("poll_seconds", args.poll_seconds)) if value is not None}
    request = {"autonomy": args.autonomy, "limits": limits, "allow_merge": bool(args.allow_merge), "auto_sync": bool(args.auto_sync), "persistent": bool(args.persistent),
               "hooks": bool(args.hooks), "max_risk": args.max_risk, "extra_tools": list(args.allow_tool or []),
               "backlog": "include" if args.include_backlog else "exclude" if args.exclude_backlog else None}
    try:
        policy_module.build(ctx.root, request, "check", "claude", "main", [])  # reject a bad limit before anything else
    except policy_module.PolicyError as exc:
        raise ActivationError(str(exc))
    results = checks(ctx, request, probe=True)
    waiting = backlog(ctx) if not failed(results) else []
    summary = {
        "autonomy": request["autonomy"],
        "what_it_does": "Discovers, takes in and plans approved work. Starts no agent." if request["autonomy"] == "observe"
        else "Runs approved, eligible work through the line unattended, and stops at every human gate.",
        "merges": "Approved tickets are merged as this project's merge settings allow." if request["allow_merge"] else "Never merges: every ticket stops before the merge station for a person.",
        "limits": {name: limits.get(name, default) for name, (default, _, _) in policy_module.LIMITS.items()},
        "max_risk": request["max_risk"] or "High",
        "tools_each_execution_may_use": list(dict.fromkeys([*policy_module.default_tools(), *request["extra_tools"]])) if request["autonomy"] == "supervised" else [],
        "everything_else": "Refused, and raised to a person. Nothing is granted quietly.",
        "runs_repository_code": "Building and verifying run this repository's tests and build scripts on this machine, as you." if request["autonomy"] == "supervised" else None,
        "fetches": "Fetches from the shared repository on a timer. Never changes your checkout." if request["auto_sync"] else "Never fetches by itself.",
        "git_hooks": "Adds wake-up notes to post-merge, post-checkout and post-rewrite." if request["hooks"] else "No Git hooks.",
        "persistent": "Installs a per-user service that keeps the supervisor running without a Claude session." if request["persistent"] else "Runs only while you start it; no service is installed.",
        "work_already_here": waiting, "work_already_here_decision": request["backlog"],
    }
    if failed(results):
        return {"ready": False, "enabled": False, "why": "The preflight did not pass.", "failed": failed(results), "checks": results, "would_enable": summary}
    if waiting and request["backlog"] is None and request["autonomy"] == "supervised":
        return {"ready": False, "enabled": False, "checks": results, "would_enable": summary,
                "why": "Work was already here before the Factory was enabled. Say whether automatic execution should include it (--include-backlog) or leave it to you (--exclude-backlog)."}
    pending = policy_module.propose(ctx.root, request, summary)
    return {"ready": True, "enabled": False, "checks": results, "would_enable": summary, "confirm_with": pending["code"], "expires_at": pending["expires_at"],
            "next": "Nothing is enabled yet. Show the person exactly what would be enabled. Only on their explicit yes, run enable again with --confirm and this code."}


def confirm(ctx: Context, code: str) -> Dict[str, Any]:
    try:
        pending = policy_module.take_pending(ctx.root, code)
    except policy_module.PolicyError as exc:
        raise ActivationError(str(exc))
    request = pending["request"]
    results = checks(ctx, request, probe=False)  # Claude answered minutes ago; everything else is checked again now
    if failed(results):
        return {"ready": False, "enabled": False, "why": "Something changed since the preflight, so nothing was enabled.", "failed": failed(results), "checks": results}
    waiting = [item["slice_id"] for item in backlog(ctx)]
    integration = ctx.line.integration()
    name = ctx.git(ctx.root, "config", "user.name").stdout.strip() or getpass.getuser()
    pol = policy_module.build(ctx.root, request, name, shutil.which("claude") or "claude", str(integration.get("branch") or "main"),
                              waiting if request.get("backlog") == "exclude" else [])
    policy_module.save(ctx.root, pol)
    hooks = service.install_hooks(ctx.root, ctx.run_script) if request.get("hooks") else {"installed": [], "skipped": None}
    agent = None
    if request.get("persistent"):
        try:
            agent = service.install_agent(ctx.root, ctx.run_script)
        except service.ServiceError as exc:
            pol["persistent"] = False
            policy_module.save(ctx.root, pol)
            agent = {"error": str(exc)}
    with ctx.line.lock("activation"):
        ledger = ctx.line.ledger()
        if request.get("backlog") == "include":
            for slice_id in waiting:  # work an engineer was moving by hand is handed to the supervisor, because they said so
                if slice_id in ledger["slices"] and ledger["slices"][slice_id].get("dispatched_at"):
                    ledger["slices"][slice_id]["owner"] = SUPERVISOR
        ctx.line.runner_id = pol["runner_id"]
        ctx.line.event_source = "engineer"
        ctx.line.emit(ledger, "factory.activated", autonomy=pol["autonomy"], by=pol["enabled_by"], limits=pol["limits"], allow_merge=pol["allow_merge"],
                      persistent=pol["persistent"], backlog=request.get("backlog"), excluded_slices=pol["excluded_slices"])
        ctx.line.save(ledger)
    return {"enabled": True, "factory": pol["autonomy"], "policy": describe(pol), "git_hooks": hooks, "persistent_service": agent,
            "next": "The Factory is enabled on this machine only. A supervisor has to be running for anything to happen: the persistent service if you chose one, "
                    "or 'factory serve' started for this session.", "factory_started": False}


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
        raise ActivationError(f"The Factory is not enabled on this machine, so there is nothing to {action}.")
    return pol


def pause(ctx: Context) -> Dict[str, Any]:
    pol = enabled_policy(ctx, "pause")
    if not pol["paused"]:
        pol["paused"] = True
        policy_module.save(ctx.root, pol)
        change(ctx, "factory.paused", by="engineer")
    running = [item["ticket_id"] for item in status(ctx)["executions"]]
    return {"paused": True, "still_running": running,
            "note": "Nothing new will be dispatched or started. Work already running finishes its run and stops at its next gate." if running else "Nothing new will be dispatched or started."}


def resume(ctx: Context, args: Any) -> Dict[str, Any]:
    pol = enabled_policy(ctx, "resume")
    request = {"autonomy": pol["autonomy"], "limits": pol["limits"], "allow_merge": pol["allow_merge"], "persistent": False}
    results = [item for item in checks(ctx, request, probe=False) if item["check"] != "ownership"]
    if failed(results):
        return {"resumed": False, "why": "Readiness was checked again and did not pass, so the Factory stays as it was.", "failed": failed(results)}
    cleared: List[str] = []
    with ctx.line.lock("activation"):
        ledger = ctx.line.ledger()
        parked = ledger["supervisor"]["parked"]
        for ticket in (list(parked) if args.retry_all else args.retry or []):
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
    with contextlib.suppress(OSError):
        policy_module.write_private(policy_module.local_dir(ctx.root) / "wake", "resumed\n")
    return {"resumed": True, "retrying": cleared, "still_waiting_for_a_person": sorted(set(status(ctx)["waiting_for_a_person"]) - set(cleared))}


def disable(ctx: Context, args: Any) -> Dict[str, Any]:
    raw = policy_module.read(ctx.root)
    stopped = ctx.sup.stop_executions() if args.stop else []
    hooks = service.remove_hooks(ctx.root)
    agent = service.remove_agent(ctx.root)
    with contextlib.suppress(OSError):
        policy_module.pending_path(ctx.root).unlink()
    was_enabled = raw.get("source") == "local-file" and raw.get("enabled")
    if raw.get("source") == "local-file":
        raw.update({"enabled": False, "paused": False, "persistent": False})
        policy_module.save(ctx.root, raw)
    elif policy_module.policy_path(ctx.root).exists() and not policy_module.policy_path(ctx.root).is_symlink():
        policy_module.policy_path(ctx.root).unlink()  # an unusable file is removed, so nothing ambiguous is left behind
    if was_enabled:
        change(ctx, "factory.disabled", by="engineer", stopped=[item["execution_id"] for item in stopped])
    with contextlib.suppress(OSError):
        policy_module.write_private(policy_module.local_dir(ctx.root) / "wake", "disabled\n")  # a running supervisor notices and exits
    running = [item["ticket_id"] for item in status(ctx)["executions"]]
    return {"disabled": True, "was_enabled": bool(was_enabled), "stopped": stopped, "still_running": running, "git_hooks_removed": hooks, "persistent_service_removed": agent,
            "note": ("Automatic execution is revoked on this machine. " + ("Work already running finishes its run; nothing new starts." if running else "Nothing is running."))}


def stop(ctx: Context, args: Any) -> Dict[str, Any]:
    """The emergency stop. It also pauses, so nothing starts again until a person resumes."""
    pol = policy_module.read(ctx.root)
    if pol.get("source") == "local-file" and pol.get("enabled") and not pol.get("paused"):
        pol["paused"] = True
        policy_module.save(ctx.root, pol)
        change(ctx, "factory.paused", by="engineer", reason="emergency stop")
    stopped = ctx.sup.stop_executions(args.execution)
    return {"stopped": stopped, "paused": True,
            "note": "Each stopped ticket now waits for a person. What its execution had done is not known: check the ticket, then resume with --retry for the ones to continue."}
