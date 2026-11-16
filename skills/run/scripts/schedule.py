#!/usr/bin/env python3
"""MACH schedule: which of several tickets may start now, and why the others wait.

Reached as `run.py schedule <ticket>... [--running <ticket>...] [--limit n] [--sequential] [--by-person] [--dry-run] [--holder H]`.
It reads; it starts nothing and writes nothing. The rule is one pure function, `decide`, used by three callers:
this command, the belt workflow (through its relay) and the supervisor (imported directly).

Facts per ticket, all read from what the stations and the intake ledger recorded:
    stage       the cell's cell.json; no cell means the ticket has not been groomed
    risk        cell.json; unknown counts as High once the ticket is in the line
    files       the plan's file touch map, read with the build station's own parse_plan (loaded, never copied);
                unknown means the ticket runs on its own among tickets in the line
    waits_for   tickets of the slices this ticket's slice depends on that are not integrated (Factory.plan, read
                only); a project with no intake ledger has no known dependencies
    phase       "prepare" before the plan exists (no cell, interview, spec-open, spec-ready), otherwise "line"

A ticket in "prepare" may start, under the ceiling, only as far as the build station (until "build"), and is
then scheduled again with its plan known.

Rules, applied in the order the tickets were given:
    1. a ticket already running is skipped; one another worker has a fresh claim on is held ("claimed", run.py
       schedule --holder H: a claim by another holder than H; without --holder, any fresh claim)
    2. ceiling: running plus started never exceeds the ceiling in force
    3. dependency: a ticket waits while a ticket it depends on is not integrated
    4. High risk: among tickets in the line, at most the High-risk ceiling run at once
    5. file overlap: a ticket in the line does not start while a running or just-started ticket in the line
       has a file in common with it

The same inputs always give the same answer. Standard library only.
"""

import importlib.util
import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

PREPARE_STAGES = (None, "interview", "spec-open", "spec-ready")
RISKS = ("Low", "Medium", "High")
DEFAULT_MAX_PARALLEL = 3  # intake.py's default, when the settings name none
DEFAULT_MAX_PARALLEL_HIGH = 1
MAX_BY_PERSON = 8  # the most a person may raise the ceiling to for one run; also the belt's own fixed maximum
FILES_NAMED = 5
_PARSERS: Dict[str, Any] = {}  # the build station's parse_plan, loaded once per script


class ScheduleError(Exception):
    """A problem the caller can fix; run.py prints it as a refusal."""


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------- the rule

def is_line(facts: Dict[str, Any]) -> bool:
    return facts.get("phase") == "line"


def is_high(facts: Dict[str, Any]) -> bool:
    return facts.get("risk") not in ("Low", "Medium")  # High, or not known: treated as High in the line


def listed(names: Sequence[str], most: int = FILES_NAMED) -> str:
    shown = ", ".join(names[:most])
    return shown + (f" and {len(names) - most} more" if len(names) > most else "")


def decide(tickets: Sequence[Dict[str, Any]], running: Sequence[Dict[str, Any]], ceiling: int, ceiling_high: int) -> Dict[str, Any]:
    """Which tickets start now and which wait, with the reason and the tickets each waits for.

    `tickets` and `running` are fact records (ticket_id, phase, risk, files, waits_for). Pure: it reads nothing,
    and the same inputs always give the same answer."""
    ceiling = max(1, int(ceiling))
    ceiling_high = max(1, min(int(ceiling_high), ceiling))
    running_ids = [str(item["ticket_id"]) for item in running]
    busy: List[Dict[str, Any]] = list(running)  # running, then each ticket started here, in order
    start: List[Dict[str, Any]] = []
    held: List[Dict[str, Any]] = []
    seen = set()

    def hold(ticket_id: str, rule: str, why: str, after: Sequence[str]) -> None:
        held.append({"ticket_id": ticket_id, "rule": rule, "why": why, "after": list(after)})

    for facts in tickets:
        ticket_id = str(facts["ticket_id"])
        if ticket_id in running_ids or ticket_id in seen:
            continue  # rule 1, and a ticket named twice is decided once
        seen.add(ticket_id)
        claimed = facts.get("claimed")
        if claimed:  # another worker is on it now: checked before the ceiling, so the reason given is the true one
            hold(ticket_id, "claimed", f"another worker was handed its {claimed.get('step')} step at {claimed.get('at')}; "
                 f"the claim lapses at {claimed.get('lapses_at')}, or when the ticket moves to a new stage", [])
            continue
        if len(busy) >= ceiling:
            hold(ticket_id, "ceiling", f"all {ceiling} place(s) are in use", [str(item["ticket_id"]) for item in busy])
            continue
        waits = [str(name) for name in facts.get("waits_for") or []]
        if waits:
            hold(ticket_id, "dependency", f"it waits for {listed(waits)} to be integrated", waits)
            continue
        if is_line(facts):
            line = [item for item in busy if is_line(item)]
            if is_high(facts):
                high = [str(item["ticket_id"]) for item in line if is_high(item)]
                if len(high) >= ceiling_high:
                    known = "High" if facts.get("risk") == "High" else "not known, so it counts as High"
                    hold(ticket_id, "high-risk", f"its risk tier is {known}, and {listed(high)} already take(s) the {ceiling_high} place(s) for High-risk work", high)
                    continue
            overlap = overlapping(facts, line)
            if overlap:
                hold(ticket_id, "overlap", overlap[0], overlap[1])
                continue
        start.append({"ticket_id": ticket_id, "until": None if is_line(facts) else "build"})
        busy.append(facts)
    return {"start": start, "held": held, "running": running_ids}


def overlapping(facts: Dict[str, Any], line: Sequence[Dict[str, Any]]):
    """Why this line ticket may not run beside the line tickets already busy, and which ones; or None."""
    if not line:
        return None
    others = [str(item["ticket_id"]) for item in line]
    if facts.get("files") is None:
        return f"its plan has no file touch map that could be read, so it runs on its own; {listed(others)} is in the line", others
    mine = set(facts["files"])
    for item in line:
        if item.get("files") is None:
            return f"{item['ticket_id']} has no file touch map that could be read, so it runs on its own", [str(item["ticket_id"])]
        common = sorted(mine & set(item["files"]))
        if common:
            return f"it shares files with {item['ticket_id']}: {listed(common)}", [str(item["ticket_id"])]
    return None


def simulate(tickets: Sequence[Dict[str, Any]], running: Sequence[Dict[str, Any]], ceiling: int, ceiling_high: int) -> Dict[str, Any]:
    """The order the tickets would start in, assuming every batch finishes (and is integrated) before the next.
    Advisory: a prepared ticket is scheduled again once its plan is known, and real work stops for people."""
    pending = [dict(item) for item in tickets]
    busy = list(running)
    batches: List[List[str]] = []
    while pending:
        decided = decide(pending, busy, ceiling, ceiling_high)
        names = [item["ticket_id"] for item in decided["start"]]
        if not names and not busy:
            break
        if names:
            batches.append(names)
        done = set(names) | {str(item["ticket_id"]) for item in busy}  # this batch, and whatever was running, finish
        pending = [dict(item, waits_for=[name for name in item.get("waits_for") or [] if name not in done]) for item in pending if item["ticket_id"] not in names]
        busy = []
    return {"batches": batches, "never": [item["ticket_id"] for item in pending]}


# ---------------------------------------------------------------- ceilings

def whole(value: Any, least: int) -> Optional[int]:
    return value if type(value) is int and value >= least else None


def ceilings(factory: Dict[str, Any], limit: Optional[int] = None, sequential: bool = False, by_person: bool = False) -> Dict[str, Any]:
    """The ceiling in force for one run. A lower --limit is taken; a higher one is clamped to the settings
    ceiling, unless a person raised it for this run (--by-person), and never above MAX_BY_PERSON."""
    factory = factory if isinstance(factory, dict) else {}
    settings = whole(factory.get("max_parallel"), 1) or DEFAULT_MAX_PARALLEL
    high = whole(factory.get("max_parallel_high"), 1) or DEFAULT_MAX_PARALLEL_HIGH
    if limit is not None and (type(limit) is not int or limit < 1):
        raise ScheduleError(f"--limit must be a whole number of at least 1, not {limit}.")
    if by_person and limit is None:
        raise ScheduleError("--by-person raises the limit given with --limit for this run; pass --limit too.")
    in_force, clamped_from, raised, note = settings, None, False, None
    if sequential:
        in_force = 1
        note = "--sequential: one ticket at a time."
    elif limit is not None and by_person:
        in_force = min(limit, MAX_BY_PERSON)
        raised = in_force > settings
        if limit > MAX_BY_PERSON:
            clamped_from = limit
            note = f"--limit {limit} is above the most a person may set for one run ({MAX_BY_PERSON}); {MAX_BY_PERSON} is in force."
        elif raised:
            note = f"A person raised the limit to {in_force} for this run, above the settings ceiling of {settings}."
    elif limit is not None:
        in_force = min(limit, settings)
        if limit > settings:
            clamped_from = limit
            note = f"--limit {limit} is above the settings ceiling of {settings}; {settings} is in force. Only a person can raise it, for one run."
    return {"settings": settings, "high": min(high, in_force), "high_settings": high, "in_force": in_force,
            "raised_by_person": raised, "clamped_from": clamped_from, "note": note}


# ---------------------------------------------------------------- facts

def plan_parser(sibling: Optional[Callable[[str], Path]]) -> Optional[Callable[[str], Any]]:
    """The build station's own parse_plan, loaded from its script whichever way MACH is installed; None if absent."""
    if sibling is None:
        return None
    try:
        script = sibling("build") / "scripts" / "build.py"
    except Exception:
        return None
    if not script.is_file():
        return None
    key = str(script.resolve())
    if key not in _PARSERS:
        spec = importlib.util.spec_from_file_location("mach_build_station", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _PARSERS[key] = getattr(module, "parse_plan", None)
    return _PARSERS[key]


def plan_files(cell_dir: Path, parse_plan: Optional[Callable[[str], Any]]) -> Optional[List[str]]:
    """Every file the plan says it touches, or None when there is no plan or it names no file."""
    if parse_plan is None:
        return None
    try:
        text = (cell_dir / "plan.md").read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None
    try:
        tasks, touch = parse_plan(text)
    except Exception:
        return None
    names = set(touch) | {name for task in tasks for name in task.get("files") or []}
    names = {name[2:] if name.startswith("./") else name for name in names if isinstance(name, str) and name}
    return sorted(names) or None


def ticket_facts(root: Path, ticket_id: str, parse_plan: Optional[Callable[[str], Any]], waits_for: Sequence[str] = ()) -> Dict[str, Any]:
    cell_dir = root / ".factory" / "worktrees" / ticket_id
    cell = load_json(cell_dir / "cell.json")
    cell = cell if isinstance(cell, dict) else {}
    stage = cell.get("stage") if isinstance(cell.get("stage"), str) else None
    phase = "prepare" if stage in PREPARE_STAGES else "line"
    return {"ticket_id": ticket_id, "stage": stage, "risk": cell.get("risk") if cell.get("risk") in RISKS else None,
            "files": plan_files(cell_dir, parse_plan) if phase == "line" else None, "waits_for": list(waits_for), "phase": phase}


def dependencies(root: Path, factory: Optional[Callable[[], Any]]) -> Dict[str, List[str]]:
    """For each ticket the intake ledger knows: the tickets (or, with no ticket yet, the slices) it waits for.
    Read with Factory.plan, which reads only; with no ledger there is nothing to read and nothing is created."""
    if factory is None or not (root / ".factory" / "intake" / "ledger.json").is_file():
        return {}
    plan = factory().plan(record=False)
    ticket_of = {row["slice_id"]: row.get("ticket_id") for row in plan["slices"]}
    waits: Dict[str, List[str]] = {}
    for row in plan["slices"]:
        if row.get("state") in ("superseded", "completed") or not row.get("ticket_id"):
            continue
        waits[row["ticket_id"]] = [ticket_of.get(dep["slice_id"]) or dep["slice_id"] for dep in row.get("depends_on") or [] if not dep.get("integrated")]
    return waits


# ---------------------------------------------------------------- the command

def main(args: Any, project: Path, *, config: Dict[str, Any], sibling: Optional[Callable[[str], Path]] = None,
         factory: Optional[Callable[[], Any]] = None, workflow: str = "mach:belt", supervised: Optional[str] = None,
         resolved: Optional[Dict[str, str]] = None, beside: Sequence[str] = (), claims: Any = None) -> Dict[str, Any]:
    """The schedule for the tickets in `args` (ticket_ids, running, limit, sequential, by_person, dry_run).

    run.py resolves bare numbers first and passes what was typed for each resolved ticket in `resolved`, and the
    supervised execution this runs inside, if any, in `supervised`. `beside` names the tickets of the supervisor's
    other live executions: they take no place here (the supervisor keeps its own ceiling), but the High-risk and
    file-overlap rules count them, and one whose plan is not written yet holds a ticket in the line, because its
    files are not known. `claims` is the shared claim helper (claim.py): a pending ticket with a fresh claim by a
    holder other than `args.holder` (any fresh claim, with no holder) is held. Returns the report; prints and
    writes nothing."""
    if args.by_person and supervised:
        raise ScheduleError(f"--by-person is a person's word, and this runs inside a supervised Factory execution (for {supervised}); the settings ceiling applies.")
    factory_section = config.get("factory") if isinstance(config.get("factory"), dict) else {}
    ceiling = ceilings(factory_section, args.limit, args.sequential, args.by_person)
    tickets = list(dict.fromkeys(args.ticket_ids))
    running = list(dict.fromkeys(args.running or []))
    parse = plan_parser(sibling)
    waits = dependencies(project, factory)
    facts = [ticket_facts(project, name, parse, waits.get(name, [])) for name in tickets]
    if claims is not None:
        limit, mine = claims.minutes(config), getattr(args, "holder", None)
        for item in facts:
            if item["ticket_id"] in running:
                continue
            held = claims.current(project / ".factory" / "worktrees" / item["ticket_id"], limit)
            if held and held["holder"] != mine:
                item["claimed"] = claims.public(held, limit)
    busy = [ticket_facts(project, name, parse, waits.get(name, [])) for name in running]
    peers = [dict(ticket_facts(project, name, parse), waits_for=[]) for name in dict.fromkeys(beside) if name not in tickets and name not in running]
    peers = [dict(item, phase="line", files=None) if item["phase"] == "prepare" else item for item in peers]  # no plan yet: files not known
    decided = decide(facts, busy + peers, ceiling["in_force"] + len(peers), ceiling["high"])
    decided["running"] = [name for name in decided["running"] if name in running]
    given = {ticket: typed for typed, ticket in (resolved or {}).items()}
    for item in decided["start"] + decided["held"]:
        if item["ticket_id"] in given:
            item["given"] = given[item["ticket_id"]]
    skipped = [name for name in tickets if name in running]
    # The advisory order leaves claims out: a claim lapses or ends with its stage, and the simulation assumes work finishes.
    simulated = simulate([dict(item, claimed=None) for item in facts if item["ticket_id"] not in running], busy, ceiling["in_force"], ceiling["high"])
    workflow_args: Dict[str, Any] = {"tickets": [name for name in tickets if name not in decided["running"]]}
    if args.sequential:
        workflow_args["sequential"] = True
    elif args.limit is not None:
        workflow_args["limit"] = args.limit
        if args.by_person:
            workflow_args["by_person"] = True
    return {
        "ceiling": ceiling,
        "tickets": [{key: item[key] for key in ("ticket_id", "stage", "phase", "risk", "files", "waits_for")} for item in facts],
        "start": decided["start"], "held": decided["held"], "running": decided["running"], "skipped_as_running": skipped,
        "batches": simulated["batches"], "never_starts": simulated["never"],
        "batches_note": "Advisory: the order if each batch finished and was integrated before the next. A prepared ticket is scheduled again once its plan is known.",
        "beside": [item["ticket_id"] for item in peers], "dependencies_known": (project / ".factory" / "intake" / "ledger.json").is_file(),
        "workflow": workflow, "workflow_args": workflow_args, "dry_run": bool(args.dry_run), "started": False,
    }
