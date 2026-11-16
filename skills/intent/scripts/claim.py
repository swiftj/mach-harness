#!/usr/bin/env python3
"""One worker per ticket: the claim on a cell's next step.

A claim is a small file in the cell, .factory/worktrees/<ticket_id>/claim.json:

    {"step": "plan", "stage": "spec-ready", "holder": "<random hex>", "at": "...", "renewed_at": "..."}

It says that one driver (a conversation, a belt workflow run, a station that starts its own worker) was
handed this step and may be working on it. A claim is fresh while the cell's stage is still the stage it was
made at and it was made or renewed less than `factory.claim_minutes` ago (default 90); otherwise it is stale
and counts for nothing. Moving to a new stage makes the old claim stale; nothing needs releasing.

A holder is a random token a driver gets once and passes back. The claim is a guard against accidents between
honest drivers, not a security boundary.

Shared by run.py (next, status, schedule) and cell.py (claim), and loaded the way lifecycle.py is. The station
files stay authoritative: no station reads a claim, so recording one never changes a station's result.

Standard library only.
"""

import json
import os
import re
import secrets
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

FILE = "claim.json"
DEFAULT_MINUTES = 90
STEPS = ("audit", "groom", "plan", "build", "revise", "verify", "review", "merge", "cleanup")
HOLDER_RE = re.compile(r"^[0-9a-f]{8,64}$")
SKEW = timedelta(minutes=1)  # a time further ahead than this is not believed


class ClaimError(Exception):
    """A claim that cannot be made: no cell, an unusable step or holder."""


def now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds")


def parse(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def new_holder() -> str:
    """A fresh holder token: 32 hex characters."""
    return secrets.token_hex(16)


def valid_holder(value: Any) -> bool:
    return isinstance(value, str) and bool(HOLDER_RE.match(value))


def minutes(config: Any) -> int:
    """`factory.claim_minutes` from the project's settings: a whole number of at least 1, else the default."""
    section = config.get("factory") if isinstance(config, dict) else None
    value = section.get("claim_minutes") if isinstance(section, dict) else None
    return value if type(value) is int and value >= 1 else DEFAULT_MINUTES


def stage_of(cell_dir: Path) -> Optional[str]:
    """The cell's current stage, or None when there is no readable cell."""
    try:
        cell = json.loads((Path(cell_dir) / "cell.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    stage = cell.get("stage") if isinstance(cell, dict) else None
    return stage if isinstance(stage, str) and stage else None


def read(cell_dir: Path) -> Optional[Dict[str, Any]]:
    """The cell's claim if it is a well-formed one, else None (a malformed file counts for nothing)."""
    try:
        data = json.loads((Path(cell_dir) / FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    if data.get("step") not in STEPS or not isinstance(data.get("stage"), str) or not valid_holder(data.get("holder")):
        return None
    if parse(data.get("at")) is None:
        return None
    return {"step": data["step"], "stage": data["stage"], "holder": data["holder"], "at": data["at"],
            "renewed_at": data.get("renewed_at") if parse(data.get("renewed_at")) else data["at"]}


def write(cell_dir: Path, claim: Dict[str, Any]) -> None:
    """Write the claim atomically: a temporary file in the cell, flushed to disk, then renamed over claim.json.
    A reader sees the old claim or the new one, never part of one. Raises OSError on failure."""
    folder = Path(cell_dir)
    record = {key: claim[key] for key in ("step", "stage", "holder", "at", "renewed_at")}
    handle, temp = tempfile.mkstemp(prefix=".claim-", suffix=".tmp", dir=str(folder))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(json.dumps(record, indent=2) + "\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, folder / FILE)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def last_moment(claim: Dict[str, Any]) -> Optional[datetime]:
    moments = [moment for moment in (parse(claim.get("at")), parse(claim.get("renewed_at"))) if moment]
    return max(moments) if moments else None


def lapses_at(claim: Dict[str, Any], limit: int) -> Optional[str]:
    moment = last_moment(claim)
    return stamp(moment + timedelta(minutes=limit)) if moment else None


def fresh(claim: Optional[Dict[str, Any]], stage: Optional[str], limit: int, at: Optional[datetime] = None) -> bool:
    """Whether a claim still counts: the cell is at the stage it was made at, and it was made or renewed
    less than `limit` minutes ago. A time further in the future than a small allowance is not believed."""
    if not claim or not stage or claim.get("stage") != stage:
        return False
    moment = last_moment(claim)
    if moment is None:
        return False
    current = at or now()
    if moment > current + SKEW:
        return False
    return current - moment < timedelta(minutes=limit)


def current(cell_dir: Path, limit: int, at: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """The cell's claim if it is fresh, else None. Reads only."""
    claim = read(cell_dir)
    return claim if fresh(claim, stage_of(cell_dir), limit, at) else None


def public(claim: Dict[str, Any], limit: int) -> Dict[str, Any]:
    """What may be shown to anyone: the step, the stage and the times. Never the holder."""
    return {"step": claim["step"], "stage": claim["stage"], "at": claim["at"], "renewed_at": claim.get("renewed_at") or claim["at"],
            "lapses_at": lapses_at(claim, limit)}


def shown(claim: Dict[str, Any], limit: int) -> Dict[str, Any]:
    """What its own holder is shown: the public fields and the holder."""
    view = public(claim, limit)
    return {"step": view["step"], "stage": view["stage"], "holder": claim["holder"], "at": view["at"],
            "renewed_at": view["renewed_at"], "lapses_at": view["lapses_at"]}


def in_words(claim: Dict[str, Any], limit: int) -> str:
    """A plain sentence about someone else's fresh claim, without its holder."""
    view = public(claim, limit)
    renewed = f", last renewed {view['renewed_at']}" if view["renewed_at"] != view["at"] else ""
    return (f"Another worker was handed the {view['step']} step for this ticket at {view['at']}{renewed}. "
            f"The claim lapses at {view['lapses_at']}, or as soon as the ticket moves to a new stage.")


def take(cell_dir: Path, step: str, holder: str, limit: int, take_over: bool = False, at: Optional[datetime] = None) -> Dict[str, Any]:
    """Claim `step` for `holder` in this cell, or renew the holder's own claim.

    Returns {"claim": the claim now recorded or None, "refused": another holder's fresh claim or None,
    "replaced": the fresh claim a take-over replaced, or None}. Writes only when it is not refused.
    Raises ClaimError for no cell or an unusable step or holder, and OSError when the file cannot be written."""
    if step not in STEPS:
        raise ClaimError(f"'{step}' is not a step that can be claimed. Use one of: {', '.join(STEPS)}.")
    if not valid_holder(holder):
        raise ClaimError("The holder must be the hex token a claim command printed.")
    stage = stage_of(cell_dir)
    if stage is None:
        raise ClaimError("This ticket has no cell yet, so there is nothing to claim.")
    moment = at or now()
    existing = read(cell_dir)
    live = existing if fresh(existing, stage, limit, moment) else None
    if live and live["holder"] != holder and not take_over:
        return {"claim": None, "refused": live, "replaced": None}
    replaced = live if live and live["holder"] != holder else None
    if live and live["holder"] == holder and live["step"] == step:
        claim = dict(live, renewed_at=stamp(moment))
    else:
        claim = {"step": step, "stage": stage, "holder": holder, "at": stamp(moment), "renewed_at": stamp(moment)}
    write(cell_dir, claim)
    return {"claim": claim, "refused": None, "replaced": replaced}
