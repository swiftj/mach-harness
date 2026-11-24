#!/usr/bin/env python3
"""MACH lanes: which of a plan's tasks could be built at the same time, and what that would have saved.

    lanes.py show <plan.md> [--json]
    lanes.py measure --project <folder> [<ticket>...] [--json] [--worktree-seconds N] [--landing-seconds N]
    lanes.py measure <cell folder or archive .tar.gz>... [--json]

A lane is a chain of plan tasks that shares no file and no requirement with any other chain and does not depend
on one. Within the plan's lanes part, two tasks are in the same lane when any of these holds (M22 design, 4.1):

    1. they share a file (a file in either task's files: the task line and the file touch map);
    2. one is [test], the other [impl], and they name a common FR or AC ID (invariants are not counted);
    3. one names the other with `after Tnn` in its trailing brackets;
    4. a task in the lanes part names no file: it cannot be placed, so the whole lanes part is one lane.

The lanes are the connected groups this makes, numbered L1, L2, ... by the plan position of each one's first task;
inside a lane, tasks keep plan order. The same plan always gives the same lanes. Nothing here is decided by an agent.

The plan may divide its task list with the sub-headings `### Before the lanes`, `### Lanes` and `### After the lanes`
inside `## Tasks`. With none, the whole list is the lanes part.

This module takes the build station's parse_plan output and never imports build.py; its command line loads parse_plan
from build.py beside it by path, as schedule.py does. `measure` reads a ticket's plan.md and build-report.json from a
live cell (.factory/worktrees/<ticket>/) or from cleanup's archive (.factory/archive/<ticket>.tar.gz, read in memory,
never extracted), and prints what the build took and what lanes would have given, as estimates from recorded numbers.
It reads only. Standard library only.
"""

import argparse
import json
import re
import sys
import tarfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

PHASES = ("before", "lanes", "after")
HEADINGS = {"before": "Before the lanes", "lanes": "Lanes", "after": "After the lanes"}

# The same task line the build station reads (build.py TASK_RE); a test checks the two stay equal.
TASK_RE = re.compile(r"^\s*[-*+]\s+\[([ xX])\]\s+((?:R\d+-)?T\d+)\s+\[(test|impl|contract|refactor|docs)\]\s+(.*)$")
SECTION_RE = re.compile(r"^##\s+(.+?)\s*$")
SUBHEADING_RE = re.compile(r"^###\s+(.+?)\s*$")
TRAILING_RE = re.compile(r"\(([^()]*)\)\s*$")
AFTER_RE = re.compile(r"\bafter\s+((?:R\d+-)?T\d+)\b", re.IGNORECASE)
REQUIREMENT_RE = re.compile(r"^(?:FR|AC)-\d{2,}$")
TICKET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")

PREDICTION = "Estimate from recorded numbers, not a promise."
DEFAULT_AT_ONCE = (2, 3, 4)
ASSUMED_WORKTREE_SECONDS = 30.0
ASSUMED_LANDING_SECONDS = 30.0
MAX_MEMBER_BYTES = 20 * 1024 * 1024
MAX_MEMBERS = 100000


# ---------------------------------------------------------------- reading the plan's additions

def _task_lines(text: str) -> Tuple[List[Tuple[str, str, Optional[str]]], List[str]]:
    """Each task line in the Tasks section as (task id, body, phase heading key or None), and the sub-headings in order.

    The section is found exactly as parse_plan finds it: a line `## <name>` starts a section, and `###` does not."""
    found: List[Tuple[str, str, Optional[str]]] = []
    headings: List[str] = []
    section = ""
    current: Optional[str] = None
    for line in text.splitlines():
        heading = SECTION_RE.match(line)
        if heading:
            section = heading.group(1).lower()
            continue
        if section != "tasks":
            continue
        sub = SUBHEADING_RE.match(line)
        if sub:
            headings.append(sub.group(1))
            key = _heading_key(sub.group(1))
            if key is not None:
                current = key
            continue
        match = TASK_RE.match(line)
        if match:
            found.append((match.group(2), match.group(4), current))
    return found, headings


def _heading_key(title: str) -> Optional[str]:
    wanted = " ".join(title.split()).lower()
    for key in PHASES:
        if HEADINGS[key].lower() == wanted:
            return key
    return None


def _after_of(body: str) -> List[str]:
    """The tasks named with `after Tnn` in the task's trailing brackets, in the order written, without repeats."""
    trailing = TRAILING_RE.search(body)
    if not trailing:
        return []
    seen: List[str] = []
    for name in AFTER_RE.findall(trailing.group(1)):
        name = name.upper()
        if name not in seen:
            seen.append(name)
    return seen


def annotate(text: str, tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Each task (as parse_plan returns it) with `phase` ("before", "lanes" or "after") and `after` (task ids).

    With no known sub-heading the whole list is the lanes part. With sub-headings, a task above the first of them is
    counted before the lanes (problems() reports it). The input list is not changed."""
    lines, _ = _task_lines(text)
    any_heading = any(phase is not None for _, _, phase in lines)
    by_position = len(lines) == len(tasks) and all(lines[i][0] == tasks[i].get("id") for i in range(len(tasks)))
    by_id: Dict[str, Tuple[str, str, Optional[str]]] = {}
    for entry in lines:
        by_id.setdefault(entry[0], entry)
    out: List[Dict[str, Any]] = []
    for index, task in enumerate(tasks):
        entry = lines[index] if by_position else by_id.get(str(task.get("id")))
        if entry is None:
            phase, after = "lanes" if not any_heading else "after", []
        else:
            phase = (entry[2] or "before") if any_heading else "lanes"
            after = _after_of(entry[1])
        copy = dict(task)
        copy["phase"] = phase
        copy["after"] = after
        out.append(copy)
    return out


# ---------------------------------------------------------------- the rule

def _requirements(task: Dict[str, Any]) -> List[str]:
    return sorted({i for i in task.get("ids") or [] if isinstance(i, str) and REQUIREMENT_RE.match(i)})


def _reason(a: Dict[str, Any], b: Dict[str, Any]) -> Optional[str]:
    """The first rule that puts tasks a and b (a earlier in the plan) in one lane, as a sentence; None if none does."""
    shared = sorted(set(a.get("files") or []) & set(b.get("files") or []))
    if shared:
        return f"{a['id']} and {b['id']} share {shared[0]}"
    if {a.get("kind"), b.get("kind")} == {"test", "impl"}:
        common = sorted(set(_requirements(a)) & set(_requirements(b)))
        if common:
            first, second = (a, b)
            return f"{first['id']} [{first['kind']}] and {second['id']} [{second['kind']}] both name {common[0]}"
    if a["id"] in (b.get("after") or []):
        return f"{b['id']} is after {a['id']}"
    if b["id"] in (a.get("after") or []):
        return f"{a['id']} is after {b['id']}"
    return None


def plan(text: str, tasks: List[Dict[str, Any]], touch: Dict[str, List[str]]) -> Dict[str, Any]:
    """The lane plan: tasks before the lanes, the lanes, tasks after the lanes, and why tasks were joined.

    {"before": [ids], "lanes": [{"lane": "L1", "tasks": [ids], "files": [...]}], "after": [ids],
     "joined_because": [{"tasks": [a, b], "why": str}], "single_reason": Optional[str],
     "ties": [{"file": str, "tasks": [ids]}]}

    joined_because holds one entry for each join that brought two groups together, in the order the rule meets them
    (tasks in plan order, each against every earlier task), so it explains every lane in the fewest sentences.
    single_reason is set only when rule 4 made the lanes part one lane. ties lists every file two or more tasks of the
    lanes part touch, most-shared first, then by name."""
    del touch  # every task's files already include the touch map's rows (parse_plan)
    annotated = annotate(text, tasks)
    before = [t["id"] for t in annotated if t["phase"] == "before"]
    after = [t["id"] for t in annotated if t["phase"] == "after"]
    part = [t for t in annotated if t["phase"] == "lanes"]

    parent = list(range(len(part)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> bool:
        a, b = find(i), find(j)
        if a == b:
            return False
        parent[max(a, b)] = min(a, b)
        return True

    joined: List[Dict[str, Any]] = []
    for j in range(len(part)):
        for i in range(j):
            if find(i) == find(j):
                continue
            why = _reason(part[i], part[j])
            if why is not None and union(i, j):
                joined.append({"tasks": [part[i]["id"], part[j]["id"]], "why": why})

    single_reason: Optional[str] = None
    fileless = [t["id"] for t in part if not t.get("files")]
    if fileless and len(part) > 1:
        names = ", ".join(fileless[:5]) + (f" and {len(fileless) - 5} more" if len(fileless) > 5 else "")
        verb, pronoun = ("names", "it") if len(fileless) == 1 else ("name", "they")
        single_reason = f"{names} {verb} no file, so {pronoun} cannot be placed and the lanes part is one lane."
        anchor = part.index(next(t for t in part if t["id"] == fileless[0]))
        for k in range(len(part)):
            if union(anchor, k):
                joined.append({"tasks": sorted([part[anchor]["id"], part[k]["id"]], key=lambda x: _position(part, x)),
                               "why": f"{fileless[0]} names no file"})

    groups: Dict[int, List[int]] = {}
    for k in range(len(part)):
        groups.setdefault(find(k), []).append(k)
    ordered = sorted(groups.values(), key=lambda members: members[0])
    lanes = [{"lane": f"L{n}", "tasks": [part[k]["id"] for k in members],
              "files": sorted({name for k in members for name in part[k].get("files") or []})}
             for n, members in enumerate(ordered, 1)]

    counts: Dict[str, List[str]] = {}
    for task in part:
        for name in task.get("files") or []:
            counts.setdefault(name, []).append(task["id"])
    ties = [{"file": name, "tasks": ids} for name, ids in sorted(counts.items(), key=lambda kv: (-len(kv[1]), kv[0])) if len(ids) > 1]
    return {"before": before, "lanes": lanes, "after": after, "joined_because": joined, "single_reason": single_reason, "ties": ties}


def _position(part: Sequence[Dict[str, Any]], task_id: str) -> int:
    return next(k for k, t in enumerate(part) if t["id"] == task_id)


# ---------------------------------------------------------------- what check-plan verifies

def _unreachable(sequence: Sequence[Dict[str, Any]]) -> List[str]:
    """The [impl] tasks of one sequence the build station could never complete: the rule of cell.py's unreachable_green,
    over task dicts. A later [impl] J naming an FR or AC whose [test] tasks all come before an earlier [impl] I."""
    found = []
    for j, task in enumerate(sequence):
        if task.get("kind") != "impl":
            continue
        stranded: Dict[str, List[str]] = {}
        for identifier in _requirements(task):
            tested = [k for k in range(j) if sequence[k].get("kind") == "test" and identifier in _requirements(sequence[k])]
            if not tested:
                continue
            between = [sequence[k]["id"] for k in range(tested[-1] + 1, j) if sequence[k].get("kind") == "impl"]
            if between:
                stranded.setdefault(between[0], []).append(identifier)
        for earlier, identifiers in stranded.items():
            found.append(f"{task['id']} [impl] implements {', '.join(identifiers)}, but every [test] task for them in its lane comes before "
                         f"{earlier} [impl], which could then never go green.")
    return found


def problems(text: str, tasks: List[Dict[str, Any]], touch: Dict[str, List[str]]) -> List[str]:
    """What is wrong with the plan's lanes additions, as sentences for check-plan. An empty list when nothing is.
    A plan without sub-headings or `after` gives none. Being one lane is never a problem."""
    found: List[str] = []
    lines, headings = _task_lines(text)
    seen: List[str] = []
    for title in headings:
        key = _heading_key(title)
        if key is None:
            found.append(f"The Tasks section has the sub-heading '### {title}'. The only sub-headings it may have are "
                         + ", ".join(f"'### {HEADINGS[k]}'" for k in PHASES) + ", in that order.")
            continue
        if key in seen:
            found.append(f"The sub-heading '### {HEADINGS[key]}' appears more than once in the Tasks section.")
        elif seen and PHASES.index(key) < PHASES.index(seen[-1]):
            found.append(f"The sub-heading '### {HEADINGS[key]}' comes after '### {HEADINGS[seen[-1]]}'. They go in the order "
                         + ", ".join(f"'### {HEADINGS[k]}'" for k in PHASES) + ".")
        seen.append(key)
    if seen:
        loose = [task_id for task_id, _, phase in lines if phase is None]
        if loose:
            found.append(f"{', '.join(loose)} {'comes' if len(loose) == 1 else 'come'} before the first sub-heading of the Tasks section. "
                         "Put every task under one of them.")

    annotated = annotate(text, tasks)
    order = {t["id"]: k for k, t in enumerate(annotated)}
    phase_of = {t["id"]: t["phase"] for t in annotated}
    for task in annotated:
        for name in task["after"]:
            if name not in order:
                found.append(f"{task['id']} is after {name}, but the plan has no task {name}.")
            elif name == task["id"]:
                found.append(f"{task['id']} names itself with 'after'.")
            elif order[name] > order[task["id"]]:
                found.append(f"{task['id']} is after {name}, but {name} comes later in the plan. 'after' names an earlier task.")
            elif phase_of[name] == "after":
                found.append(f"{task['id']} is after {name}, which is after the lanes. 'after' may name only a task before the lanes or in them.")

    before = [t for t in annotated if t["phase"] == "before"]
    tested = sorted({i for t in before if t.get("kind") == "test" for i in _requirements(t)})
    built = {i for t in before if t.get("kind") == "impl" for i in _requirements(t)}
    open_ids = [i for i in tested if i not in built]
    if open_ids:
        found.append(f"The tasks before the lanes test {', '.join(open_ids)} but no [impl] task before the lanes names "
                     f"{'it' if len(open_ids) == 1 else 'them'}, so the suite would be red where the lanes start and no lane could go green. "
                     "Move the [impl] task before the lanes, or the test into the lanes.")

    lane_plan = plan(text, tasks, touch)
    by_id = {t["id"]: t for t in annotated}
    for lane in lane_plan["lanes"]:
        for sentence in _unreachable([by_id[i] for i in lane["tasks"]]):
            found.append(f"In lane {lane['lane']}: {sentence}")
    return found


# ---------------------------------------------------------------- the arithmetic (design 11.2)

def lanes_wall(lanes: Sequence[Sequence[Tuple[float, float]]], shared_tests: bool) -> float:
    """Wall time of lanes that start together: each lane is its tasks as (writing seconds, test seconds), in order.

    With shared_tests False a test run takes its recorded time (c = 1). With shared_tests True a test run is slowed by
    the number of lanes still running at that moment (c = lanes running), so once the short lanes are done the long
    one runs alone at c = 1. Writing time is never slowed."""
    queues = [[(max(float(m), 0.0), max(float(s), 0.0)) for m, s in lane] for lane in lanes if lane]
    # Each running lane: [index of its task, remaining writing, remaining testing (in uncontended seconds)].
    running = [[0, q[0][0], q[0][1]] for q in queues]
    live = list(range(len(queues)))
    clock = 0.0
    eps = 1e-9
    while live:
        # Finish zero-length phases and tasks before measuring a step.
        for k in list(live):
            state = running[k]
            while state[1] <= eps and state[2] <= eps:
                state[0] += 1
                if state[0] >= len(queues[k]):
                    live.remove(k)
                    break
                state[1], state[2] = queues[k][state[0]]
        if not live:
            break
        c = float(len(live)) if shared_tests else 1.0
        steps = [running[k][1] if running[k][1] > eps else running[k][2] * c for k in live]
        dt = min(steps)
        clock += dt
        for k in live:
            state = running[k]
            if state[1] > eps:
                state[1] = max(state[1] - dt, 0.0)
            else:
                state[2] = max(state[2] - dt / c, 0.0)
    return clock


def estimate(fixed_seconds: float, lanes: Sequence[Sequence[Tuple[float, float]]], at_once: int, shared_tests: bool,
             ground: float, worktree: float, landing: float, suite: float) -> Dict[str, Any]:
    """The design's formula for one build in lanes:

        fixed + per batch (W + G + the batch's wall time) + J + S

    fixed is everything that stays sequential (the first reading of the ground, the tasks before and after the lanes,
    the start and the finish). Lanes run at most at_once together, in batches in lane order, each batch waited for
    before the next (the driver's lanes-start loop). Each batch makes its worktrees (W) and its builders read the
    ground again (G), at the same time."""
    at_once = max(int(at_once), 1)
    batches = [list(lanes[k:k + at_once]) for k in range(0, len(lanes), at_once)]
    walls = [lanes_wall(batch, shared_tests) for batch in batches]
    total = fixed_seconds + sum(walls) + len(batches) * (worktree + ground) + landing + suite
    return {"seconds": round(total, 1), "batches": len(batches), "lanes_wall_seconds": round(sum(walls), 1)}


def _number(value: Any) -> Optional[float]:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None


def _median(values: Sequence[float]) -> Optional[float]:
    ordered = sorted(values)
    if not ordered:
        return None
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def _first_round(step: Dict[str, Any]) -> bool:
    return not str(step.get("task") or "").startswith("R") and step.get("loop") in (None, 0)


def predict(lane_plan: Dict[str, Any], report: Dict[str, Any], *, worktree_seconds: Optional[float] = None,
            landing_seconds: Optional[float] = None, at_once: Sequence[int] = DEFAULT_AT_ONCE) -> Dict[str, Any]:
    """What the build in the report took, and what the same build would have taken in lanes, from its recorded steps.

    Recorded: the build's elapsed time, its test time, and each task's time (timing.steps: the clock since the previous
    step, and the test run's seconds). A task's writing time is its time less its test time. Taken from those numbers:
    S, one whole-suite run (the median of the recorded whole-suite runs), and G, one reading of the ground (the first
    task's time, less the start's baseline run, beyond the median of the other first-round tasks). Not recorded by any
    build, so assumed and labelled: W, making the worktrees of one batch, and J, landing. Every result is labelled a
    prediction. Anything missing is reported as not recorded, and nothing is estimated from it."""
    worktree = ASSUMED_WORKTREE_SECONDS if worktree_seconds is None else float(worktree_seconds)
    landing = ASSUMED_LANDING_SECONDS if landing_seconds is None else float(landing_seconds)
    lanes = lane_plan.get("lanes") or []
    part_ids = [i for lane in lanes for i in lane["tasks"]]
    lane_of = {i: lane["lane"] for lane in lanes for i in lane["tasks"]}
    phase_of = {**{i: "before" for i in lane_plan.get("before") or []}, **{i: "after" for i in lane_plan.get("after") or []},
                **{i: "lanes" for i in part_ids}}
    result: Dict[str, Any] = {"label": PREDICTION, "one_lane": len(lanes) <= 1, "lanes": len(lanes),
                              "longest_lane_tasks": max((len(lane["tasks"]) for lane in lanes), default=0),
                              "recorded": {}, "inputs": {}, "estimates": [], "not_recorded": []}
    timing = report.get("timing") if isinstance(report, dict) else None
    if not isinstance(timing, dict):
        result["not_recorded"].append("The build report has no timing, so the build's time is not recorded.")
        return result
    steps = [s for s in timing.get("steps") or [] if isinstance(s, dict)]
    elapsed = _number(timing.get("elapsed_seconds"))
    tests_total = _number(timing.get("test_seconds_total"))
    revisions = any(not _first_round(s) for s in steps)
    per_task: List[Dict[str, Any]] = []
    by_task: Dict[str, Dict[str, Any]] = {}
    for step in steps:
        task_id = str(step.get("task") or "")
        seconds = _number(step.get("seconds_since_previous_step"))
        test_seconds = _number(step.get("test_seconds"))
        if test_seconds is None and step.get("tests") is None and step.get("test_seconds") is None:
            test_seconds = 0.0  # no test run at this step
        entry = {"task": task_id, "kind": step.get("kind"), "phase": phase_of.get(task_id), "lane": lane_of.get(task_id),
                 "first_round": _first_round(step), "seconds": seconds, "test_seconds": test_seconds,
                 "writing_seconds": round(max(seconds - test_seconds, 0.0), 1) if seconds is not None and test_seconds is not None else None}
        per_task.append(entry)
        by_task.setdefault(task_id, entry)
    first_round = [e for e in per_task if e["first_round"]]
    first_round_total = sum(e["seconds"] for e in first_round) if first_round and all(e["seconds"] is not None for e in first_round) else None
    if revisions:
        base, base_is = first_round_total, "first round"
    else:
        base, base_is = elapsed, "elapsed"
    result["recorded"] = {
        "elapsed_seconds": elapsed, "test_seconds_total": tests_total,
        "test_share": round(tests_total / elapsed, 3) if elapsed and tests_total is not None else None,
        "test_runs": timing.get("test_runs") if isinstance(timing.get("test_runs"), int) else None,
        "revision_rounds_left_out": revisions, "first_round_seconds": first_round_total,
        "base_seconds": base, "base_is": base_is, "tasks": per_task,
    }
    if elapsed is None:
        result["not_recorded"].append("The build's elapsed time is not recorded.")
    if tests_total is None:
        result["not_recorded"].append("The build's total test time is not recorded.")
    if result["one_lane"]:
        return result

    missing = [i for i in part_ids if i not in by_task or by_task[i]["seconds"] is None or by_task[i]["test_seconds"] is None]
    if missing:
        result["not_recorded"].append(f"Task times are not recorded for {', '.join(missing[:8])}" + (f" and {len(missing) - 8} more" if len(missing) > 8 else "")
                                      + ", so no estimate is made.")
    if base is None:
        result["not_recorded"].append("The build's time is not recorded" + (" for its first round" if revisions else "") + ", so no estimate is made.")

    suites = [e["test_seconds"] for e, s in zip(per_task, steps) if s.get("tests") == "whole suite" and e["test_seconds"]]
    suite = _median(suites)
    suite_from = "the median of the build's recorded whole-suite runs"
    if suite is None:
        for key, label in (("final_test_seconds", "the finish's recorded suite run"), ("baseline_test_seconds", "the start's recorded suite run")):
            if _number(timing.get(key)) is not None:
                suite, suite_from = _number(timing.get(key)), label
                break
    if suite is None:
        result["not_recorded"].append("No whole-suite run time is recorded, so the joined suite run cannot be estimated.")

    ground: Optional[float] = None
    ground_from = "not recorded"
    rest = [e["seconds"] for e in first_round[1:] if e["seconds"] is not None]
    if first_round and first_round[0]["seconds"] is not None and rest:
        baseline = _number(timing.get("baseline_test_seconds")) or 0.0
        ground = round(max(first_round[0]["seconds"] - baseline - (_median(rest) or 0.0), 0.0), 1)
        ground_from = "the first task's time, less the start's baseline run, beyond the median task"
    else:
        result["not_recorded"].append("The time to read the ground cannot be told apart from the first task, so no estimate is made.")
    result["inputs"] = {"ground_seconds": ground, "ground_from": ground_from, "suite_seconds": suite, "suite_from": suite_from if suite is not None else "not recorded",
                        "worktree_seconds": worktree, "worktree_from": "assumed per batch of lanes; no build has recorded it" if worktree_seconds is None else "given",
                        "landing_seconds": landing, "landing_from": "assumed; no build has recorded it" if landing_seconds is None else "given",
                        "not_counted": "Anything the test command needs that Git does not hold (installed packages, node_modules) made again in each lane."}
    if missing or base is None or suite is None or ground is None:
        return result

    fixed = base - sum(by_task[i]["seconds"] for i in part_ids)
    chains = [[(by_task[i]["writing_seconds"], by_task[i]["test_seconds"]) for i in lane["tasks"]] for lane in lanes]
    for k in at_once:
        used = min(int(k), len(lanes))
        low = estimate(fixed, chains, used, False, ground, worktree, landing, suite)
        high = estimate(fixed, chains, used, True, ground, worktree, landing, suite)
        result["estimates"].append({"lanes_at_once": int(k), "lanes_used": used, "batches": low["batches"],
                                    "seconds_tests_alone": low["seconds"], "seconds_tests_shared": high["seconds"],
                                    "saving_seconds_tests_alone": round(base - low["seconds"], 1),
                                    "saving_seconds_tests_shared": round(base - high["seconds"], 1)})
    return result


# ---------------------------------------------------------------- reading past builds

class MeasureError(Exception):
    """A cell or archive that cannot be read safely; reported, never fatal to the other tickets."""


def _read_member(tar: tarfile.TarFile, member: tarfile.TarInfo) -> bytes:
    if member.size > MAX_MEMBER_BYTES:
        raise MeasureError(f"{member.name} is larger than {MAX_MEMBER_BYTES // (1024 * 1024)} MB.")
    handle = tar.extractfile(member)
    if handle is None:
        raise MeasureError(f"{member.name} cannot be read.")
    return handle.read(MAX_MEMBER_BYTES + 1)


def read_archive(path: Path) -> Dict[str, Optional[str]]:
    """plan.md and build-report.json from a cleanup archive, read in memory. Nothing is written to disk.

    The whole archive is refused when any member's name is absolute or steps out of its folder, or any member is a
    link, a device or anything but a file or a folder: an archive cleanup wrote never holds one."""
    found: Dict[str, Optional[str]] = {"plan.md": None, "build-report.json": None, "ticket": None}
    try:
        with tarfile.open(str(path), "r:gz") as tar:
            members = []
            for count, member in enumerate(tar, 1):
                if count > MAX_MEMBERS:
                    raise MeasureError("The archive holds too many members to be a cell's archive.")
                name = member.name
                parts = name.replace("\\", "/").split("/")
                if name.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", name) or ".." in parts:
                    raise MeasureError(f"The archive holds {name!r}, which points outside its folder; it was not read.")
                if not (member.isfile() or member.isdir()):
                    raise MeasureError(f"The archive holds {name!r}, which is a link or a special file; it was not read.")
                members.append(member)
            tops = {m.name.split("/", 1)[0] for m in members if m.name}
            if len(tops) != 1:
                raise MeasureError("The archive does not hold exactly one cell folder.")
            top = tops.pop()
            found["ticket"] = top
            for member in members:
                for wanted in ("plan.md", "build-report.json"):
                    if member.isfile() and member.name == f"{top}/{wanted}":
                        found[wanted] = _read_member(tar, member).decode("utf-8", "replace")
    except (OSError, tarfile.TarError, EOFError) as exc:
        raise MeasureError(f"The archive cannot be read: {exc}")
    return found


def read_cell(folder: Path) -> Dict[str, Optional[str]]:
    """plan.md and build-report.json from a live cell folder. A file that is a link is not followed."""
    found: Dict[str, Optional[str]] = {"plan.md": None, "build-report.json": None, "ticket": folder.name}
    for wanted in ("plan.md", "build-report.json"):
        path = folder / wanted
        if path.is_symlink():
            raise MeasureError(f"{path} is a link; it was not followed.")
        if path.is_file():
            if path.stat().st_size > MAX_MEMBER_BYTES:
                raise MeasureError(f"{path} is larger than {MAX_MEMBER_BYTES // (1024 * 1024)} MB.")
            found[wanted] = path.read_text(encoding="utf-8", errors="replace")
    return found


def archive_ticket(path: Path) -> Optional[str]:
    """The ticket an archive holds: the folder its first member is in (cleanup writes every member under <ticket>/).
    None when that cannot be read; read_archive says why when the archive is measured."""
    try:
        with tarfile.open(str(path), "r:gz") as tar:
            member = tar.next()
    except (OSError, tarfile.TarError, EOFError):
        return None
    if member is None:
        return None
    top = member.name.replace("\\", "/").split("/", 1)[0]
    return top if TICKET_RE.match(top) else None


def project_sources(project: Path, tickets: Sequence[str]) -> List[Tuple[str, Optional[Path], Optional[str]]]:
    """(ticket, source, problem) for each ticket asked for, or every ticket with a cell or an archive, in ticket order.

    A live cell is read in preference to an archive. Archives are matched by the ticket folder inside them, not by
    their file name alone; of one ticket's archives, the newest (cleanup names repeats <ticket>-2, <ticket>-3, ...)."""
    cells = project / ".factory" / "worktrees"
    archives = project / ".factory" / "archive"
    held: Dict[str, List[Tuple[int, str, Path]]] = {}
    unreadable: List[Path] = []
    if archives.is_dir():
        for path in sorted(archives.iterdir()):
            if not path.name.endswith(".tar.gz") or path.is_symlink() or not path.is_file():
                continue
            ticket = archive_ticket(path)
            if ticket is None:
                unreadable.append(path)
                continue
            repeat = re.match(rf"^{re.escape(ticket)}-(\d+)\.tar\.gz$", path.name)
            number = 1 if path.name == f"{ticket}.tar.gz" else int(repeat.group(1)) if repeat else 0
            held.setdefault(ticket, []).append((number, path.name, path))

    def cell_of(ticket: str) -> Optional[Path]:
        folder = cells / ticket
        return folder if folder.is_dir() and not folder.is_symlink() and (folder / "plan.md").exists() else None

    def archive_of(ticket: str) -> Optional[Path]:
        found = sorted(held.get(ticket) or [])
        return found[-1][2] if found else None

    out: List[Tuple[str, Optional[Path], Optional[str]]] = []
    wanted = list(tickets)
    if not wanted:
        names = set(held)
        if cells.is_dir():
            names |= {p.name for p in cells.iterdir() if TICKET_RE.match(p.name) and cell_of(p.name)}
        wanted = sorted(names)
        out += [(path.name, None, "the archive cannot be read") for path in unreadable]
    for ticket in wanted:
        if not TICKET_RE.match(ticket):
            out.append((ticket, None, "not a ticket ID"))
            continue
        source = cell_of(ticket) or archive_of(ticket)
        out.append((ticket, source, None if source else "no cell and no archive"))
    return out


def measure_one(source: Path, parse_plan: Callable[[str], Any], *, worktree_seconds: Optional[float] = None,
                landing_seconds: Optional[float] = None) -> Dict[str, Any]:
    """Everything measure says about one past build, as data."""
    is_archive = source.name.endswith(".tar.gz")
    files = read_archive(source) if is_archive else read_cell(source)
    record: Dict[str, Any] = {"ticket": files.get("ticket"), "source": str(source), "from": "archive" if is_archive else "cell"}
    text = files.get("plan.md")
    if text is None:
        raise MeasureError("It has no plan.md.")
    tasks, touch = parse_plan(text)
    first = [t for t in tasks if not str(t.get("id")).startswith("R")]
    record["revision_tasks_left_out"] = [t["id"] for t in tasks if str(t.get("id")).startswith("R")]
    lane_plan = plan(text, first, touch)
    record["plan"] = lane_plan
    record["tasks"] = len(first)
    report: Dict[str, Any] = {}
    raw = files.get("build-report.json")
    problem: Optional[str] = None
    if raw is None:
        record["report"] = "none"
        problem = "There is no build report: the build has not finished, so its time is not recorded."
    else:
        try:
            loaded = json.loads(raw)
        except ValueError:
            loaded = None
        report = loaded if isinstance(loaded, dict) else {}
        record["report"] = "read" if report else "unreadable"
        if not report:
            problem = "The build report is not a JSON object, so the build's time is not recorded."
    record["prediction"] = predict(lane_plan, report, worktree_seconds=worktree_seconds, landing_seconds=landing_seconds)
    if problem:
        record["prediction"]["not_recorded"] = [problem]
    return record


# ---------------------------------------------------------------- words

def duration(seconds: Optional[float]) -> str:
    if seconds is None:
        return "not recorded"
    total = int(round(seconds))
    if total < 60:
        return f"{total} s"
    minutes, secs = divmod(total, 60)
    if minutes < 60:
        return f"{minutes} min {secs:02d} s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} h {minutes:02d} min"


def _ratio(base: Optional[float], value: float) -> str:
    return f"{base / value:.1f}x" if base and value > 0 else "-"


def describe_plan(lane_plan: Dict[str, Any], tasks_count: int) -> List[str]:
    lines = []
    lanes = lane_plan["lanes"]
    part = sum(len(lane["tasks"]) for lane in lanes)
    lines.append(f"  Tasks: {tasks_count} ({len(lane_plan['before'])} before the lanes, {part} in the lanes part, {len(lane_plan['after'])} after).")
    longest = max((len(lane["tasks"]) for lane in lanes), default=0)
    lines.append(f"  Lanes: {len(lanes)}. Longest lane: {longest} task{'s' if longest != 1 else ''}.")
    if len(lanes) <= 1:
        if part > 1:
            lines.append(f"  One lane: {lane_plan['single_reason']}" if lane_plan.get("single_reason") else "  One lane.")
            if lane_plan["ties"]:
                lines.append("  The files that tie the tasks together, most-shared first:")
                for tie in lane_plan["ties"][:10]:
                    lines.append(f"    {tie['file']}: {len(tie['tasks'])} tasks ({', '.join(tie['tasks'][:12])}{', ...' if len(tie['tasks']) > 12 else ''})")
                if len(lane_plan["ties"]) > 10:
                    lines.append(f"    and {len(lane_plan['ties']) - 10} more files")
            elif not lane_plan.get("single_reason"):
                lines.append("  No file ties the tasks together; requirements or 'after' do, listed below.")
    else:
        for lane in lanes:
            n, f = len(lane["tasks"]), len(lane["files"])
            lines.append(f"    {lane['lane']}: {', '.join(lane['tasks'])} ({n} task{'s' if n != 1 else ''}; {f} file{'s' if f != 1 else ''})")
    joined = lane_plan["joined_because"]
    if joined:
        lines.append("  Why tasks were joined:")
        for entry in joined[:40]:
            lines.append(f"    {entry['why']}")
        if len(joined) > 40:
            lines.append(f"    and {len(joined) - 40} more")
    return lines


def describe(record: Dict[str, Any]) -> List[str]:
    lines = [f"{record['ticket']} (from the {record['from']} {record['source']})"]
    lines += describe_plan(record["plan"], record["tasks"])
    if record.get("revision_tasks_left_out"):
        lines.append(f"  Revision tasks left out: {', '.join(record['revision_tasks_left_out'])} (revisions never run in lanes).")
    prediction = record["prediction"]
    recorded = prediction.get("recorded") or {}
    if recorded:
        elapsed, tests = recorded.get("elapsed_seconds"), recorded.get("test_seconds_total")
        share = recorded.get("test_share")
        lines.append(f"  Build time recorded: {duration(elapsed)} elapsed, from start to finish (it includes any time the build sat idle).")
        lines.append(f"  Test runs: {duration(tests)}" + (f", {share * 100:.0f}% of it" if share is not None else "")
                     + (f", in {recorded['test_runs']} runs." if recorded.get("test_runs") is not None else "."))
        if recorded.get("revision_rounds_left_out"):
            lines.append(f"  First round, start to its last task: {duration(recorded.get('first_round_seconds'))}. Revision rounds are left out of the estimates.")
        tasks = recorded.get("tasks") or []
        if tasks:
            lines.append("  Per task (time since the previous step, of which test runs):")
            for entry in tasks:
                where = entry["lane"] or entry["phase"] or ("revision" if not entry["first_round"] else "-")
                lines.append(f"    {entry['task']:<8} {str(entry['kind'] or ''):<8} {where:<7} {duration(entry['seconds']):>14}   tests {duration(entry['test_seconds'])}")
    for note in prediction.get("not_recorded") or []:
        lines.append(f"  Not recorded: {note}")
    if prediction.get("one_lane"):
        lines.append("  Lanes would not change this build: the plan as written is one lane.")
    elif prediction.get("estimates"):
        inputs = prediction["inputs"]
        lines.append(f"  {PREDICTION} The same build in lanes, from these numbers:")
        lines.append(f"    reading the ground again (G): {duration(inputs['ground_seconds'])}, from {inputs['ground_from']}")
        lines.append(f"    the joined suite run (S): {duration(inputs['suite_seconds'])}, from {inputs['suite_from']}")
        lines.append(f"    making the worktrees (W): {duration(inputs['worktree_seconds'])} per batch, {inputs['worktree_from']}")
        lines.append(f"    landing (J): {duration(inputs['landing_seconds'])}, {inputs['landing_from']}")
        lines.append(f"    not counted: {inputs['not_counted']}")
        base = recorded.get("base_seconds")
        for entry in prediction["estimates"]:
            if entry["lanes_used"] < entry["lanes_at_once"]:
                lines.append(f"    {entry['lanes_at_once']} lanes at once: the same as {entry['lanes_used']}, as the plan has {entry['lanes_used']} lanes.")
                continue
            low, high = _ratio(base, entry["seconds_tests_alone"]), _ratio(base, entry["seconds_tests_shared"])
            lines.append(f"    {entry['lanes_at_once']} lanes at once: about {duration(entry['seconds_tests_alone'])} if test runs do not slow each other, "
                         f"about {duration(entry['seconds_tests_shared'])} if they share the machine "
                         f"({low if low == high else f'{low} to {high}'} as fast as the {duration(base)} recorded)"
                         + (f", in {entry['batches']} batches" if entry["batches"] > 1 else "") + ".")
    return lines


def table(records: Sequence[Dict[str, Any]], failures: Sequence[Tuple[str, str]]) -> List[str]:
    header = f"{'ticket':<18} {'tasks':>5} {'lanes':>5} {'longest':>7} {'recorded':>14} {'tests':>5}   {'2 at once':<24} {'3 at once':<24} {'4 at once':<24}"
    lines = [header]
    for record in records:
        prediction = record["prediction"]
        recorded = prediction.get("recorded") or {}
        share = recorded.get("test_share")
        cells = []
        by_k = {e["lanes_at_once"]: e for e in prediction.get("estimates") or []}
        for k in DEFAULT_AT_ONCE:
            entry = by_k.get(k)
            if prediction.get("one_lane"):
                cells.append("one lane: no change")
            elif entry is None:
                cells.append("not recorded")
            else:
                cells.append(f"{duration(entry['seconds_tests_alone'])} - {duration(entry['seconds_tests_shared'])}")
        lines.append(f"{str(record['ticket'])[:18]:<18} {record['tasks']:>5} {prediction['lanes']:>5} {prediction['longest_lane_tasks']:>7} "
                     f"{duration(recorded.get('base_seconds')):>14} {(f'{share * 100:.0f}%' if share is not None else '-'):>5}   "
                     + " ".join(f"{c:<24}" for c in cells))
    for ticket, why in failures:
        lines.append(f"{str(ticket)[:18]:<18} not read: {why}")
    lines.append(f"Recorded is the build's elapsed time (its first round when it had revisions). Each 'at once' column is an estimate from recorded "
                 "numbers, not a promise: test runs not slowing each other - sharing the machine.")
    return lines


# ---------------------------------------------------------------- command line

def load_parse_plan() -> Callable[[str], Any]:
    """The build station's own parse_plan, loaded from build.py beside this script, as schedule.py loads it. No
    bytecode is written, so reading a project leaves nothing in it."""
    import importlib.util
    script = Path(__file__).resolve().parent / "build.py"
    if not script.is_file():
        raise MeasureError(f"The build station's script is not beside this one ({script}), so plans cannot be read.")
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec = importlib.util.spec_from_file_location("mach_build_station_for_lanes", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]
    finally:
        sys.dont_write_bytecode = previous
    return module.parse_plan


def main(argv: Optional[Sequence[str]] = None, parse_plan: Optional[Callable[[str], Any]] = None) -> int:
    parser = argparse.ArgumentParser(prog="lanes.py", description="Which plan tasks could be built at the same time, and what that would have saved.")
    sub = parser.add_subparsers(dest="command")
    show = sub.add_parser("show", help="the lanes a plan gives")
    show.add_argument("plan")
    show.add_argument("--json", action="store_true")
    measure = sub.add_parser("measure", help="past builds: what they took and what lanes would have given (reads only)")
    measure.add_argument("paths", nargs="*", help="tickets with --project; otherwise cell folders or archive .tar.gz files")
    measure.add_argument("--project", help="the project folder: reads every ticket's cell or archive, or the tickets named")
    measure.add_argument("--json", action="store_true")
    measure.add_argument("--worktree-seconds", type=float, default=None, help=f"time to make one batch's worktrees (assumed {ASSUMED_WORKTREE_SECONDS:.0f})")
    measure.add_argument("--landing-seconds", type=float, default=None, help=f"time to land the lanes (assumed {ASSUMED_LANDING_SECONDS:.0f})")
    args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))
    if args.command is None:
        parser.print_help()
        return 2
    try:
        parse = parse_plan or load_parse_plan()
    except MeasureError as exc:
        print(f"REFUSED: {exc}")
        return 1

    if args.command == "show":
        path = Path(args.plan)
        if not path.is_file():
            print(f"REFUSED: {path} is not a file.")
            return 1
        text = path.read_text(encoding="utf-8", errors="replace")
        tasks, touch = parse(text)
        lane_plan = plan(text, tasks, touch)
        found = problems(text, tasks, touch)
        if args.json:
            print(json.dumps({**lane_plan, "problems": found}, indent=2))
        else:
            print("\n".join(describe_plan(lane_plan, len(tasks)) + [f"  Problem: {p}" for p in found]))
        return 0

    sources: List[Tuple[str, Optional[Path], Optional[str]]] = []
    if args.project:
        project = Path(args.project)
        if not (project / ".factory").is_dir():
            print(f"REFUSED: {project} has no .factory folder, so it is not a project where MACH has run.")
            return 1
        sources = project_sources(project, args.paths)
    else:
        if not args.paths:
            print("REFUSED: name a project with --project, or cell folders or archives.")
            return 1
        for raw in args.paths:
            path = Path(raw)
            sources.append((path.name, path if path.exists() else None, None if path.exists() else "no such file or folder"))
    if not sources:
        print("No ticket in this project has a cell with a plan or an archive.")
        return 0
    records: List[Dict[str, Any]] = []
    failures: List[Tuple[str, str]] = []
    for ticket, source, problem in sources:
        if source is None:
            failures.append((ticket, problem or "not found"))
            continue
        try:
            record = measure_one(source, parse, worktree_seconds=args.worktree_seconds, landing_seconds=args.landing_seconds)
        except MeasureError as exc:
            failures.append((ticket, str(exc)))
            continue
        if args.project:
            record["ticket"] = ticket
        records.append(record)
    if args.json:
        print(json.dumps({"label": PREDICTION, "builds": records, "not_read": [{"ticket": t, "why": w} for t, w in failures]}, indent=2))
        return 0
    out: List[str] = []
    for record in records:
        out += describe(record) + [""]
    out += table(records, failures)
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    import contextlib as _c, os as _o, runpy as _r  # MACH records an internal error for /mach report (skills/intent/scripts/faults.py)
    with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if _o.path.isfile(p)))["install"](__file__)
    sys.exit(main())
