#!/usr/bin/env python3
"""How many judging rounds a ticket has, and a person carrying a stopped ticket on: the one rule, shared by the build, review
and run stations.

Round numbers never restart: build.json's `loop` counts every revision a ticket ever had, and file names (review/round-N,
review-findings-N.md) use it, so no record is ever written over. What a person's start resets is the allowance. cell.json
keeps `rounds_base`, the number of rounds that no longer count, and `extra_rounds`, the rounds a person granted by carrying
the ticket on. So:

    counted round   = the round's own number - rounds_base          (what a person reads: "round 1 of 3")
    limit           = review.max_loops + extra_rounds               (3 when max_loops is not set)
    last            = rounds_base + limit                           (the round number that, failed, stops the ticket)

    configured(config)  review.max_loops                 extra(cell)        the rounds people granted
    base(cell)          the rounds that no longer count  limit(config, cell) the allowance
    last(config, cell)  the last round's own number      used(cell, loop)   rounds counted so far, the current one included
    carried_on(cell)    the carry-on records             pending / current  the carry-on whose revision is to come / under way

Two writers, both a person's word, never a supervised execution's:

    carry_on(cellroot, config, by=, via=, guidance=, why="person-decision")
        a stopped ticket (stage blocked, an unknown stage once building started, or an approval whose security exception
        expired) gets one more round on the same branch: the person's guidance is kept as their words
        (person-guidance-<n>.md), the ticket goes back to 'built', and the line's next step is the build station's revision
        with the last findings and the guidance. Nothing already built is redone. It can be granted again, any number of times.
    start_afresh(cellroot, config, by=, via=)
        a person started the line (pull, factory start or resume, or named the ticket): the ticket's rounds count from zero
        again (rounds_base moves up, extra_rounds goes back to 0). A ticket stopped for its rounds is carried on as above.

Each writes one lifecycle record, station.exited for the build station (lifecycle.py), with
{"outcome": "carried-on-by-person" | "rounds-reset", "by": "person-decision" | "person-start", "round", "max_rounds",
"round_number", "rounds_base", "extra_rounds", "stopped_at", "guidance", "via"}.

Standard library only.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT = 3
GUIDANCE_LIMIT = 4000
EXECUTION_ENV = "MACH_EXECUTION_ID"
KNOWN_STAGES = ("interview", "spec-open", "spec-ready", "planned", "building", "built", "verified", "awaiting-human", "approved",
                "merged", "pr-open", "blocked")
VIA = {"terminal": "an agent, on the person's instruction in conversation", "floor": "a person, in the Factory Floor"}
STOPPED_BY = {"verify": "verification failed it", "review": "the review panel rejected it", "person": "a person sent it back",
              "merge": "the merge station sent it back"}


class RoundsError(Exception):
    """A carry-on that was not recorded, with why. `code` names the reason for the lifecycle log."""

    def __init__(self, message: str = "", code: str = "not-recorded") -> None:
        super().__init__(message)
        self.code = code


def whole(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def configured(config: Any) -> int:
    section = config.get("review") if isinstance(config, dict) else None
    value = whole(section.get("max_loops")) if isinstance(section, dict) else None
    return value if value is not None and value > 0 else DEFAULT


def extra(cell: Any) -> int:
    value = whole(cell.get("extra_rounds")) if isinstance(cell, dict) else None
    return value if value is not None and value > 0 else 0


def base(cell: Any) -> int:
    value = whole(cell.get("rounds_base")) if isinstance(cell, dict) else None
    return value if value is not None and value > 0 else 0


def limit(config: Any, cell: Any = None) -> int:
    return configured(config) + extra(cell)


def last(config: Any, cell: Any = None) -> int:
    return base(cell) + limit(config, cell)


def used(cell: Any, loop: Any) -> int:
    """Rounds counted so far, the round now being built or judged included: build.json's loop + 1, less rounds_base."""
    return max((whole(loop) or 0) + 1 - base(cell), 0)


def carried_on(cell: Any) -> List[Dict[str, Any]]:
    found = cell.get("carried_on") if isinstance(cell, dict) else None
    return [item for item in found if isinstance(item, dict)] if isinstance(found, list) else []


def pending(cell: Any, loop: Any) -> Optional[Dict[str, Any]]:
    """The latest carry-on, while its revision has not started: its round is the one after the next revision's. build.json's
    loop counts revisions; the round being judged is loop + 1, so the carried-on revision is round loop + 2 until it starts."""
    records = carried_on(cell)
    if records and whole(records[-1].get("round_number")) == (whole(loop) or 0) + 2:
        return records[-1]
    return None


def current(cell: Any, loop: Any) -> Optional[Dict[str, Any]]:
    """The latest carry-on, once its revision has started (the round being built and judged now is its round)."""
    records = carried_on(cell)
    if records and whole(records[-1].get("round_number")) == (whole(loop) or 0) + 1:
        return records[-1]
    return None


# ---- writing: a person's carry-on and a person's start ----


def load(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def record(cellroot: Path, data: Dict[str, Any]) -> None:
    """The lifecycle record the Factory Floor reads. Never raises."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import lifecycle
        lifecycle.record(cellroot, "station.exited", "build", data)
    except Exception:  # noqa: BLE001 - telemetry is observational
        pass


def lapsed_exception(decision: Dict[str, Any]) -> bool:
    """Whether the approving decision holds a security exception whose expiry has passed (review.py's rule: through its day, UTC)."""
    if not isinstance(decision, dict) or decision.get("outcome") not in ("APPROVED", "AWAITING_HUMAN"):
        return False
    today = datetime.now(timezone.utc).date().isoformat()
    latest: Dict[str, Dict[str, Any]] = {}
    for item in decision.get("exceptions") or [] if isinstance(decision.get("exceptions"), list) else []:
        if isinstance(item, dict):
            latest[f"{item.get('round')}/{item.get('seat')}/{item.get('index')}"] = item
    return any(isinstance(item.get("expires"), str) and item["expires"] < today for item in latest.values())


def last_failure(cellroot: Path) -> Dict[str, Any]:
    """What stopped the ticket last, from the stations' own files: which station, the round it failed and its findings file."""
    summary = load(cellroot / "evidence" / "summary.json", {}) or {}
    decision = load(cellroot / "review" / "decision.json", {}) or {}
    found = []  # (round, order within a round, station, findings)
    if isinstance(summary, dict) and summary.get("status") == "FAIL_WITH_EVIDENCE":
        number = whole(summary.get("review_loop")) or 0
        found.append((number + 1, 0, "verify", cellroot / "evidence" / "findings.md"))
    if isinstance(decision, dict) and (decision.get("outcome") in ("REJECTED", "ESCALATE") or lapsed_exception(decision)):
        station = "person" if decision.get("rejected_by") == "a person" else "merge" if decision.get("rejected_by") else "review"
        path = Path(decision["findings"]) if isinstance(decision.get("findings"), str) and decision.get("findings") else None
        found.append((whole(decision.get("round")) or 0, 1, station, path))
    if not found:
        return {"station": None, "round": None, "findings": None}
    number, _, station, path = sorted(found, key=lambda item: (item[0], item[1]))[-1]
    inside = False
    if path is not None:
        try:
            inside = cellroot.resolve() in path.resolve().parents and path.is_file()
        except (OSError, RuntimeError):
            inside = False
    return {"station": station, "round": number, "findings": path if inside else None}


def save(cellroot: Path, cell: Dict[str, Any]) -> None:
    cell["updated_at"] = now()
    (cellroot / "cell.json").write_text(json.dumps(cell, indent=2) + "\n", encoding="utf-8")


def stopped_for_rounds(cellroot: Path, cell: Dict[str, Any]) -> bool:
    """A ticket the line stopped for a person at its last round (stage blocked), as opposed to any other stop."""
    return cell.get("stage") == "blocked"


def carry_on(cellroot: Path, config: Any, *, by: str, via: str = "terminal", guidance: Optional[str] = None,
             why: str = "person-decision", fresh: bool = False) -> Dict[str, Any]:
    """A person's carry-on of a stopped ticket; with `fresh` (a person's start), its rounds also count from zero again.
    Returns what was recorded; raises RoundsError, with nothing changed, when it cannot be carried on."""
    if os.environ.get(EXECUTION_ENV):
        raise RoundsError("Carrying a stopped ticket on is a person's word, and this runs inside a supervised Factory execution. "
                          "A person carries it on with run.py decide do, or from the Factory Floor.", code="unattended")
    name = " ".join((by or "").split())
    if len(name) < 2:
        raise RoundsError("--by must name the person who carries the ticket on.", code="by-missing")
    if via not in VIA:
        raise RoundsError(f"--via is terminal or floor, not '{via}'.", code="bad-via")
    words = (guidance or "").strip()
    if "\x00" in words or len(words) > GUIDANCE_LIMIT:
        raise RoundsError(f"The guidance must be plain text of at most {GUIDANCE_LIMIT} characters. Nothing was changed.", code="guidance-too-long")
    cell = load(cellroot / "cell.json")
    if not isinstance(cell, dict):
        raise RoundsError(f"No cell for {cellroot.name}.", code="no-cell")
    ticket = cellroot.name
    stage = cell.get("stage")
    decision = load(cellroot / "review" / "decision.json", {}) or {}
    expired = stage in ("approved", "awaiting-human") and lapsed_exception(decision)
    stuck = stage not in KNOWN_STAGES
    if stage != "blocked" and not stuck and not expired:
        raise RoundsError(f"{ticket} has not stopped for a person (its stage is '{stage}'), so there is nothing to carry on: "
                          "the line carries it on by itself. Nothing was changed.", code="not-stopped")
    state = load(cellroot / "build.json", {}) or {}
    if not isinstance(state, dict) or not state.get("tasks"):
        raise RoundsError(f"Building has not started for {ticket}, so there is no build to carry on. Nothing was changed.", code="not-started")
    failure = last_failure(cellroot)
    loop = whole(state.get("loop")) or 0
    number = loop + 2  # the carried-on revision's own round number
    if fresh:
        cell["rounds_base"] = loop + 1  # the rounds so far no longer count: the carried-on round is round 1
        cell["extra_rounds"] = 0
    grant = max(number - last(config, cell), 0)
    cell["extra_rounds"] = extra(cell) + grant
    records = carried_on(cell)
    count = len(records) + 1
    path = None
    if words:
        path = cellroot / f"person-guidance-{count}.md"
        path.write_text(f"# A person's guidance for {ticket}, round {number - base(cell)}\n\n"
                        f"{name} carried this ticket on after {STOPPED_BY.get(failure['station'] or '', 'it stopped')}. Below are their words, as they "
                        "gave them: what the builder should do differently in this round. They are about this ticket only.\n\n"
                        + "\n".join("> " + line if line else ">" for line in words.splitlines()) + "\n", encoding="utf-8")
    shown, allowance = number - base(cell), limit(config, cell)
    entry = {"n": count, "by": name, "via": via, "recorded_by": VIA[via], "why": why, "at": now(), "stage_was": stage,
             "stopped_at": failure["station"], "failed_round_number": failure["round"] or loop + 1, "round": shown, "max_rounds": allowance,
             "round_number": number, "rounds_base": base(cell), "granted": grant,
             "findings": failure["findings"].relative_to(cellroot).as_posix() if failure["findings"] else None,
             "guidance": path.name if path else None}
    cell["carried_on"] = records + [entry]
    cell["stage"] = "built"
    save(cellroot, cell)
    record(cellroot, {"outcome": "carried-on-by-person", "by": why, "stage": "built", "round": shown, "max_rounds": allowance, "round_number": number,
                      "rounds_base": base(cell), "extra_rounds": extra(cell), "stopped_at": failure["station"], "guidance": path is not None, "via": via})
    return {"ticket_id": ticket, "status": "CARRIED_ON", "by": name, "why": why, "round": shown, "max_rounds": allowance, "round_number": number,
            "granted": grant, "stopped_at": failure["station"], "findings": str(failure["findings"]) if failure["findings"] else None,
            "guidance": str(path) if path else None}


def start_afresh(cellroot: Path, config: Any, *, by: str, via: str = "terminal") -> Optional[Dict[str, Any]]:
    """A person started the line: this ticket's rounds count from zero again. A ticket stopped for its rounds is carried on from
    the build station's revision with its last findings. Nothing built is redone and no record is changed: rounds_base moves up.
    None when there is nothing to reset (no build yet, or the count is already fresh). Never inside a supervised execution."""
    if os.environ.get(EXECUTION_ENV):
        return None
    cell = load(cellroot / "cell.json")
    state = load(cellroot / "build.json", {}) or {}
    if not isinstance(cell, dict) or not isinstance(state, dict) or not state.get("tasks"):
        return None
    if stopped_for_rounds(cellroot, cell):
        try:
            return carry_on(cellroot, config, by=by, via=via, why="person-start", fresh=True)
        except RoundsError:
            return None
    stage = cell.get("stage")
    if stage not in KNOWN_STAGES:
        return None  # not a stop about rounds: a person decides it (decide)
    loop = whole(state.get("loop")) or 0
    failure = last_failure(cellroot)
    # A failed round waiting for its revision: the revision to come is round 1. Otherwise the round now under way is.
    waiting = stage == "built" and failure["round"] == loop + 1 and pending(cell, loop) is None
    new_base = loop + 1 if waiting else loop
    if pending(cell, loop) is not None:
        new_base = loop + 1  # a carry-on's revision to come is round 1
    if new_base == base(cell) and extra(cell) == 0:
        return None
    cell["rounds_base"] = new_base
    cell["extra_rounds"] = 0
    records = carried_on(cell)
    if records and pending(cell, loop) is records[-1]:
        records[-1].update({"round": loop + 2 - new_base, "max_rounds": limit(config, cell), "rounds_base": new_base})
    save(cellroot, cell)
    shown = (loop + 2 if waiting or pending(cell, loop) else loop + 1) - new_base
    record(cellroot, {"outcome": "rounds-reset", "by": "person-start", "stage": stage, "round": shown, "max_rounds": limit(config, cell),
                      "round_number": shown + new_base, "rounds_base": new_base, "extra_rounds": 0, "stopped_at": None, "guidance": False, "via": via})
    return {"ticket_id": cellroot.name, "status": "RESET", "by": " ".join((by or "").split()), "why": "person-start", "round": shown,
            "max_rounds": limit(config, cell), "round_number": shown + new_base}
