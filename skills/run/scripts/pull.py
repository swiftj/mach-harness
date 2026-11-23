#!/usr/bin/env python3
"""MACH pull: run the Factory on whatever product work is ready.

Reached as `run.py pull [--limit n] [--sequential] [--dry-run] [--json]`, the engineer's one command for
"take in what is ready and start the next batch". It composes steps that already exist, in this order, under
the intake lock (one writer at a time):

    1. reconcile  take in every slice marked ready, with intake's acceptance checks, and record the plan
                  (intake.py). A slice that is not accepted is reported with its reason and never built.
    2. choose     the next batch with schedule.decide (schedule.py), over the tickets already in the line that
                  can move (in ticket order), then the slices the plan marks dispatchable (in the plan's order:
                  dependencies merged first, the product manager's order within an epic, oldest ready first).
    3. dispatch   the chosen slices, through intake.py's guarded dispatch. The engineer's explicit `pull` is the
                  explicit command dispatch requires; no other caller gains anything.

It adds no scheduling rule of its own: what is ready is the plan's, what may run together is the schedule's,
and each ticket's next station is run.py next's. A ticket whose next step is a stop is listed for a person
with the script's own sentence, whatever it waits for. It starts no agent and no workflow: it prints what
starts now, what waits and why, what was not accepted and what waits for a person, and the exact tickets to
run, which the run skill hands to the belt workflow (or drives in the conversation, for one ticket).

With --dry-run it changes nothing: no intake, no ledger write, no cell, no status write. Slices it would take
in are scheduled as if taken in; a slice from a ready folder has no ticket until it is.

Standard library only. Imported by run.py; not a command of its own.
"""

import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional

INTAKE_KEYS = ("created", "updated", "applied", "withdrawn", "needs_person", "notes", "refused")


class PullError(Exception):
    """A problem the caller can fix; run.py prints it as a refusal."""


def cells(root: Path) -> List[str]:
    """Every ticket with a cell: the tickets in the line."""
    folder = root / ".factory" / "worktrees"
    names = [path.parent.name for path in folder.glob("*/cell.json")] if folder.is_dir() else []
    return sorted(names, key=lambda name: [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", name)])


def pull(args: Any, root: Path, *, config: Dict[str, Any], line: Any, schedule: Any, claims: Any,
         next_step: Callable[[str], Dict[str, Any]], sibling: Optional[Callable[[str], Path]], workflow: str, run_one: str) -> Dict[str, Any]:
    """The whole pull: reconcile, choose, dispatch (each skipped or simulated with --dry-run). Returns the report."""
    factory_section = config.get("factory") if isinstance(config.get("factory"), dict) else {}
    try:
        ceiling = schedule.ceilings(factory_section, args.limit, args.sequential)
    except schedule.ScheduleError as exc:
        raise PullError(str(exc))
    if args.dry_run:
        taken, plan = simulated_intake(line)
        return choose(args, root, config, line, schedule, claims, next_step, sibling, workflow, run_one, ceiling, taken, plan, dispatch=None)
    with line.lock("pull"):
        reconciled = line.reconcile()
        return choose(args, root, config, line, schedule, claims, next_step, sibling, workflow, run_one, ceiling,
                      reconciled["intake"], reconciled["plan"], dispatch=line.dispatch)


def simulated_intake(line: Any):
    """What intake would take in, and the plan as if it had: read only. A new slice's entry lives in memory only."""
    ledger = line.ledger()
    found = line.discover(ledger, dry_run=True)
    rows = {row["slice_id"]: row for row in found.pop("_rows")}
    taken: Dict[str, Any] = {key: [] for key in INTAKE_KEYS}
    taken.update(notes=found["notes"], refused=found["refused"], withdrawn=found["withdrawn"])
    taken["not_accepted"] = found["not_accepted"] + [{key: row.get(key) for key in ("issue", "slice_id", "revision", "reason")}
                                                     for row in found["slices"] if row["status"] == "refused"]
    for row in found["slices"]:
        if row["status"] == "modified":
            taken["updated"].append({"slice_id": row["slice_id"], "from_revision": row.get("was_revision"), "to_revision": row["revision"], "effect": row["work"]})
        if row["status"] != "new":
            continue
        full = rows[row["slice_id"]]
        ticket = str(full["issue"]) if full["source"] == "github" else None
        taken["created"].append({"slice_id": row["slice_id"], "revision": row["revision"], "issue": row["issue"], "ticket_id": ticket})
        ledger["slices"][row["slice_id"]] = {
            "slice_id": row["slice_id"], "title": full.get("title"), "issue": full.get("issue"), "epic": dict(full.get("epic") or {}),
            "revision": full.get("revision"), "source": full["source"], "repository": full.get("repository"), "depends": list(full.get("depends") or []),
            "order": full.get("order"), "ready_at": full.get("ready_at") or "", "digest": full.get("digest"), "earlier_runs": 0, "history": [],
            # A folder's slice has no ticket until intake files one; its slice ID stands in for it here, and is never shown as a ticket.
            "ticket_id": ticket or row["slice_id"], "pending_ticket": False, "new_ticket": ticket is None}
    plan = line.plan(ledger=ledger)
    for item in plan["slices"]:
        if ledger["slices"][item["slice_id"]].get("new_ticket"):
            item["ticket_id"] = None
            item["stand_in"] = item["slice_id"]
    return taken, plan


def choose(args: Any, root: Path, config: Dict[str, Any], line: Any, schedule: Any, claims: Any, next_step: Callable[[str], Dict[str, Any]],
           sibling: Optional[Callable[[str], Path]], workflow: str, run_one: str, ceiling: Dict[str, Any], taken: Dict[str, Any],
           plan: Dict[str, Any], dispatch: Optional[Callable[..., Dict[str, Any]]]) -> Dict[str, Any]:
    rows = {row["slice_id"]: row for row in plan["slices"]}
    slice_of = {str(row["ticket_id"]): key for key, row in rows.items() if row.get("ticket_id")}
    ticket_of = {key: str(row.get("ticket_id") or row.get("stand_in")) for key, row in rows.items() if row.get("ticket_id") or row.get("stand_in")}

    # The line: every cell, by its next step. A stop is a person's, whatever it waits for; "nothing" is finished.
    movable: List[str] = []
    for_a_person: List[Dict[str, Any]] = []
    # A cell whose dispatch was cut short is not in the line yet: the plan offers its slice for dispatch again, which finishes it.
    cut_short = {str(row["ticket_id"]) for row in plan["slices"] if row.get("interrupted") and row.get("ticket_id")}
    for ticket_id in cells(root):
        if ticket_id in cut_short:
            continue
        found = next_step(ticket_id)
        if not found.get("stop"):
            movable.append(ticket_id)
        elif found.get("needs") not in (None, "nothing"):
            for_a_person.append({"ticket_id": ticket_id, "slice_id": slice_of.get(ticket_id), "stage": found.get("stage"),
                                 "needs": found.get("needs"), "why": found.get("reason")})
    stopped = {item["ticket_id"] for item in for_a_person}
    for key, row in rows.items():  # slices the plan says need a person and that have no stopped cell already listed
        if row.get("needs_person") and str(row.get("ticket_id")) not in stopped:
            reasons = [*row.get("stale", []), *([] if row["state"] == "active" else row.get("reasons", []))]
            for_a_person.append({"ticket_id": row.get("ticket_id"), "slice_id": key, "stage": row.get("stage"), "needs": row.get("waiting_for") or "person",
                                 "why": " ".join(reasons) or "A person is needed.", "still_moves": str(row.get("ticket_id")) in movable})

    # The candidates, in order: work already in the line first, then the slices the plan would dispatch.
    offered = [key for key in plan["dispatchable"] if key in ticket_of]
    candidates = movable + [ticket_of[key] for key in offered]
    decided = schedule.main(SimpleNamespace(ticket_ids=candidates, running=[], limit=args.limit, sequential=args.sequential, by_person=False,
                                            dry_run=args.dry_run, holder=None),
                            root, config=config, sibling=sibling, factory=lambda: line, workflow=workflow, claims=claims) if candidates else {"start": [], "held": []}
    slice_by_ticket = {ticket_of[key]: key for key in offered}

    start_now: List[Dict[str, Any]] = []
    waits: List[Dict[str, Any]] = []
    to_dispatch: List[str] = []
    for item in decided["start"]:
        if item["ticket_id"] in slice_by_ticket:
            to_dispatch.append(slice_by_ticket[item["ticket_id"]])
        else:
            start_now.append({"ticket_id": item["ticket_id"], "slice_id": slice_of.get(item["ticket_id"]), "how": "carried on", "until": item.get("until")})
    for item in decided["held"]:
        key = slice_by_ticket.get(item["ticket_id"])
        in_line = key is None
        waits.append({"ticket_id": public_ticket(rows, key, item["ticket_id"]), "slice_id": key or slice_of.get(item["ticket_id"]), "rule": item["rule"],
                      "why": item["why"], "after": item["after"],
                      # A held ticket in the line runs later in this same run when the schedule frees a place; a held slice waits for the next pull.
                      "in_this_run": in_line and item["rule"] != "claimed",
                      "then": ("left to the worker on it" if item["rule"] == "claimed" else
                               "starts in this run when the schedule allows" if in_line else "is dispatched by a later pull")})
    person_slices = {item["slice_id"] for item in for_a_person if item.get("slice_id")}
    for key in plan["order"]:  # ready, but the plan has no free place for it
        if key not in plan["dispatchable"]:
            waits.append({"ticket_id": public_ticket(rows, key, None), "slice_id": key, "rule": "ceiling", "why": rows[key]["reasons"][-1], "after": [],
                          "in_this_run": False, "then": "is dispatched by a later pull"})
    for key, row in rows.items():
        if row.get("held") and key not in person_slices:  # M20: another Factory is building it: skipped, and left to that Factory
            waits.append({"ticket_id": public_ticket(rows, key, None), "slice_id": key, "rule": "being-built-elsewhere", "why": row["held"].rstrip("."),
                          "after": [], "in_this_run": False,
                          "then": f"is left to that Factory (to build it here instead: product dispatch {key} --take-over, on your word)"})
        elif row["state"] == "blocked" and key not in person_slices:
            waits.append({"ticket_id": public_ticket(rows, key, None), "slice_id": key, "rule": "blocked", "why": " ".join(row["reasons"]),
                          "after": [dep.get("slice_id") or dep.get("name") for dep in row.get("depends_on") or [] if not dep.get("integrated")],
                          "in_this_run": False, "then": "is dispatched by a later pull once nothing holds it"})

    dispatched: Dict[str, Any] = {"dispatched": [], "refused": [], "problem": None}
    if to_dispatch and dispatch is None:
        start_now += [{"ticket_id": public_ticket(rows, key, None), "slice_id": key, "how": "would be dispatched", "until": "build"} for key in to_dispatch]
    elif to_dispatch:
        try:
            sent = dispatch(to_dispatch)
        except Exception as exc:  # intake's refusal (the checkout is not on the integration branch, a received copy changed)
            if exc.__class__.__name__ != "IntakeError":
                raise
            dispatched["problem"] = str(exc)
            sent = {"dispatched": [], "refused": []}
        # M20: a slice another Factory claimed a moment before is skipped, and the next slice nobody is building is taken in its place.
        tried = set(to_dispatch)
        for _ in range(3):
            lost = [item for item in sent["refused"] if item.get("state") == "being_built_elsewhere" and item["slice_id"] not in dispatched.get("replaced", [])]
            if not lost or dispatch is None:
                break
            dispatched.setdefault("replaced", []).extend(item["slice_id"] for item in lost)
            again = line.plan()
            more = [key for key in again["dispatchable"] if key not in tried][:len(lost)]
            if not more:
                break
            tried.update(more)
            try:
                extra = dispatch(more)
            except Exception as exc:
                if exc.__class__.__name__ != "IntakeError":
                    raise
                break
            sent = {"dispatched": sent["dispatched"] + extra["dispatched"], "refused": sent["refused"] + extra["refused"]}
        dispatched.update(dispatched=sent["dispatched"], refused=sent["refused"])
        for item in sent["dispatched"]:
            start_now.append({"ticket_id": item["ticket_id"], "slice_id": item["slice_id"], "how": "dispatched", "until": "build"})
        for item in sent["refused"]:
            elsewhere = item.get("state") == "being_built_elsewhere"
            waits.append({"ticket_id": public_ticket(rows, item["slice_id"], None), "slice_id": item["slice_id"],
                          "rule": "being-built-elsewhere" if elsewhere else "dispatch-refused",
                          "why": " ".join(item.get("why") or []).rstrip("."), "after": [], "in_this_run": False,
                          "then": "is left to that Factory" if elsewhere else "is dispatched by a later pull once nothing holds it"})
        if dispatched["problem"]:
            for key in to_dispatch:
                waits.append({"ticket_id": public_ticket(rows, key, None), "slice_id": key, "rule": "dispatch-refused", "why": dispatched["problem"],
                              "after": [], "in_this_run": False, "then": "is dispatched by a later pull once nothing holds it"})

    # Everything that starts now, then the tickets in the line that start later in this run. A dry run lists a new
    # folder slice without its ticket, which intake has not filed yet.
    run = list(dict.fromkeys([item["ticket_id"] for item in start_now if item["ticket_id"]] + [item["ticket_id"] for item in waits if item["in_this_run"]]))
    workflow_args: Dict[str, Any] = {"tickets": run}
    if args.sequential:
        workflow_args["sequential"] = True
    elif args.limit is not None:
        workflow_args["limit"] = args.limit
    report = {
        "dry_run": bool(args.dry_run), "ceiling": ceiling,
        "taken_in": {key: taken.get(key) or [] for key in INTAKE_KEYS},
        "not_accepted": taken.get("not_accepted") or [],
        "start_now": start_now, "waits": waits, "for_a_person": for_a_person, "dispatch": dispatched,
        "run": run, "workflow": workflow, "workflow_args": workflow_args,
        "run_one": f"{run_one} {run[0]}" if len(run) == 1 else None,
        "nothing_to_run": not run and not start_now,
        # M20: nothing starts, and what is ready is being built by other Factories.
        "all_ready_built_elsewhere": not start_now and (bool(plan.get("all_ready_built_elsewhere"))
                                                        or any(item["rule"] == "being-built-elsewhere" for item in waits)),
        "factory_started": False,
    }
    report["in_words"] = in_words(report)
    return report


def public_ticket(rows: Dict[str, Dict[str, Any]], key: Optional[str], fallback: Optional[str]) -> Optional[str]:
    """A slice's ticket as a person may see it: None for a ready folder's slice that has no ticket yet."""
    if key is None:
        return fallback
    ticket = rows.get(key, {}).get("ticket_id")
    return str(ticket) if ticket else None


def named(item: Dict[str, Any]) -> str:
    ticket, key = item.get("ticket_id"), item.get("slice_id")
    if ticket and key:
        return f"{ticket} ({key})"
    return str(ticket or (f"{key} (no ticket yet)" if key else "?"))


def in_words(report: Dict[str, Any]) -> List[str]:
    """The schedule in plain words, one line each: what was taken in, what starts now, what waits and why,
    what was not accepted, what waits for a person, and the tickets to run."""
    would = report["dry_run"]
    lines: List[str] = []
    ceiling = report["ceiling"]
    lines.append(f"At most {ceiling['in_force']} ticket(s) at once, {ceiling['high']} of them High-risk." + (f" {ceiling['note']}" if ceiling.get("note") else ""))
    taken = report["taken_in"]
    if taken["created"]:
        verb = "Would take in" if would else "Taken in"
        lines.append(f"{verb}: " + ", ".join(f"{item['slice_id']}" + (f" (ticket {item['ticket_id']})" if item.get("ticket_id") else "") for item in taken["created"]) + ".")
    for item in taken["updated"]:
        lines.append(f"{'Would update' if would else 'Updated'} {item['slice_id']} from revision {item.get('from_revision')} to {item.get('to_revision')}: {item.get('effect')}.")
    for item in taken["applied"]:
        lines.append(f"{item['slice_id']}: {item.get('effect')}.")
    for item in report["not_accepted"]:
        where = f"Issue #{item['issue']}" if item.get("issue") else item.get("folder") or item.get("slice_id")
        lines.append(f"Not accepted, never built: {where}: {item.get('reason')}")
    for problem in taken["refused"]:
        lines.append(f"Nothing could be read from the integration branch: {problem}")
    verb = {"carried on": "carries on", "dispatched": "is dispatched and starts", "would be dispatched": "would be dispatched and start"}
    for item in report["start_now"]:
        lines.append(f"Starts now: {named(item)} {verb[item['how']]}" + (", as far as the build station, then is scheduled again with its plan known." if item.get("until") == "build" else "."))
    for item in report["waits"]:
        lines.append(f"Waits: {named(item)}: {item['why']}; it {item['then']}.")
    for item in report["for_a_person"]:
        lines.append(f"Waits for a person: {named(item)}: {item['why']}" + (" Its work goes on meanwhile." if item.get("still_moves") else ""))
    if report["dispatch"]["problem"]:
        lines.append(f"Nothing was dispatched: {report['dispatch']['problem']}")
    if report.get("all_ready_built_elsewhere") and not report["start_now"]:
        lines.append("Everything ready is being built by other Factories, so nothing new starts here.")
    if report["run"]:
        lines.append(f"{'Would run' if would else 'To run'}: {', '.join(report['run'])}.")
    if would and any(item["how"] == "would be dispatched" and not item["ticket_id"] for item in report["start_now"]):
        lines.append("A slice from a ready folder gets its ticket when it is taken in.")
    if report["nothing_to_run"]:
        lines.append(nothing_text(report))
    if would:
        lines.append("Nothing was changed: this was a dry run.")
    return lines


def nothing_text(report: Dict[str, Any]) -> str:
    if report["for_a_person"]:
        return "Nothing can move until a person decides: see what waits for a person."
    if report["waits"]:
        return "Nothing can start now: everything ready is waiting for the reasons above."
    return ("Nothing is ready. A product manager marks a finished slice ready in Product Studio; "
            "once it is accepted here, pull takes it in. An engineer can see what is marked ready, and what was not accepted, with product status.")


def human(report: Dict[str, Any]) -> str:
    return "\n".join(report["in_words"])
