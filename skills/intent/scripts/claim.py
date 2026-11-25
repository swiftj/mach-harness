#!/usr/bin/env python3
"""One worker per ticket, and a person's word always wins: the claim on a cell's next step.

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

A person who names a ticket is never refused because another worker has it: the step is taken over at once and the
other holder is recorded as displaced (displaced.json). Each station refuses a displaced holder at its next call
(station_argv, station_stop), so two workers never go on in one cell. Only a supervised execution keeps the plain
one-worker rule and waits.

Standard library only.
"""

import json
import os
import re
import secrets
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

FILE = "claim.json"
DEFAULT_MINUTES = 90
STEPS = ("audit", "groom", "plan", "build", "build-lanes", "revise", "verify", "review", "merge", "cleanup")
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


def clock(value: Any, at: Optional[datetime] = None) -> str:
    """A claim's time the way a person reads it: "02:47 UTC" today, "2026-11-24 02:47 UTC" another day."""
    moment = parse(value)
    if moment is None:
        return str(value or "an unknown time")
    moment = moment.astimezone(timezone.utc)
    today = (at or now()).astimezone(timezone.utc).date()
    return moment.strftime("%H:%M UTC") if moment.date() == today else moment.strftime("%Y-%m-%d %H:%M UTC")


def taken_over_warning(claim: Dict[str, Any]) -> str:
    """What a person is told first when MACH took a step over for them from another worker's fresh claim."""
    return (f"Another worker was handed the {claim['step']} step for this ticket at {clock(claim.get('at'))} and may still be at work. "
            "You have taken it over; that worker is stopped at its next step.")


# ---- a person's request is carried out (the owner's rule, 2026-11-25) ----
#
# A person who names a ticket gets the work: another worker's fresh claim is taken over in the same call, and that worker is
# displaced. A displaced holder is recorded in the cell (displaced.json): every station refuses it at its next call (station_argv,
# stopped_words), and its own driver is told at its next `next` that its part stops here. A supervised execution is not a person:
# it keeps the one-worker rule and never takes a step over.

DISPLACED = "displaced.json"


def displaced_all(cell_dir: Path) -> Dict[str, Dict[str, Any]]:
    """Every holder a person's take-over displaced in this cell: {holder: {"at", "step", "by"}}. Empty when none or unreadable."""
    try:
        data = json.loads((Path(cell_dir) / DISPLACED).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    holders = data.get("holders") if isinstance(data, dict) else None
    return {key: value for key, value in holders.items() if valid_holder(key) and isinstance(value, dict)} if isinstance(holders, dict) else {}


def displaced(cell_dir: Path, holder: Optional[str]) -> Optional[Dict[str, Any]]:
    """The record of this holder's displacement, or None when it was never displaced (or no holder is given)."""
    if not valid_holder(holder):
        return None
    return displaced_all(cell_dir).get(str(holder))


def _write_displaced(cell_dir: Path, holders: Dict[str, Dict[str, Any]]) -> None:
    folder = Path(cell_dir)
    handle, temp = tempfile.mkstemp(prefix=".displaced-", suffix=".tmp", dir=str(folder))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(json.dumps({"holders": holders}, indent=2) + "\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, folder / DISPLACED)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


TAKEOVER = "takeover.json"  # the latest take-over: who took it, and the branch's commit then, for the sweep at the taker's first call


def displace(cell_dir: Path, holders: Any, step: str, by: str = "person", at: Optional[datetime] = None,
             head: Optional[str] = None, taker: Optional[str] = None) -> None:
    """Record that a person took this cell's work over from these holders, and (with `head` and `taker`) the cell's branch commit at that
    moment, so the taker's first build or verify call sets aside anything the displaced workers did after it (sweep). Raises OSError
    when it cannot be written."""
    names = [name for name in dict.fromkeys(holders or []) if valid_holder(name)]
    if not names:
        return
    known = displaced_all(cell_dir)
    for name in names:
        known[name] = {"at": stamp(at or now()), "step": step, "by": by}
    _write_displaced(cell_dir, known)
    if valid_holder(taker):
        record = {"taker": taker, "head": head if isinstance(head, str) and re.fullmatch(r"[0-9a-f]{40}", head or "") else None,
                  "at": stamp(at or now()), "swept": False}
        folder = Path(cell_dir)
        handle, temp = tempfile.mkstemp(prefix=".takeover-", suffix=".tmp", dir=str(folder))
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(json.dumps(record, indent=2) + "\n")
        os.replace(temp, folder / TAKEOVER)


def open_takeover(cell_dir: Path) -> None:
    """The take-over was made for whoever carries the ticket on next (a decision recorded outside a run): the first holder that is not
    displaced sweeps the cell."""
    path = Path(cell_dir) / TAKEOVER
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if isinstance(record, dict):
        record["taker"] = None
        path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")


def head_of(work: Path) -> Optional[str]:
    """The commit a checkout is at, or None when it is not a Git checkout."""
    import subprocess
    if not Path(work).is_dir():
        return None
    done = subprocess.run(["git", "rev-parse", "--verify", "-q", "HEAD"], cwd=str(work), capture_output=True, text=True)
    return done.stdout.strip() if done.returncode == 0 and done.stdout.strip() else None


def sweep(cell_dir: Path, holder: Optional[str], ticket_id: str) -> Optional[str]:
    """At the taker's first build or verify call after a take-over: whatever the displaced workers did to the cell's checkout after it
    (uncommitted files, and commits no station of the taker made, since the branch's commit at the take-over) is kept under refs and the
    checkout goes back to that commit, so none of it is used. Returns the sentence to say, or None when there was nothing (or this is not
    the taker, or it was swept already). Never raises: a sweep that fails leaves everything as it was and says so."""
    import subprocess
    folder = Path(cell_dir)
    try:
        record = json.loads((folder / TAKEOVER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict) or record.get("swept") or not valid_holder(holder) or displaced(folder, holder):
        return None
    if record.get("taker") and record.get("taker") != holder:
        return None
    work = folder / "repo"
    said: List[str] = []

    def git(*args: str) -> Any:
        return subprocess.run(["git", *args], cwd=str(work), capture_output=True, text=True)

    def free_ref(prefix: str) -> str:
        taken = git("for-each-ref", "--format=%(refname)", prefix.rsplit("/", 1)[0] + "/").stdout.split()
        return f"{prefix}{1 + sum(1 for name in taken if name.startswith(prefix))}"

    try:
        if work.is_dir() and head_of(work):
            kept = set_aside(work, free_ref(f"refs/mach/cell-files/{ticket_id}/after-take-over-"),
                             f"Uncommitted files left in the cell after {ticket_id} was taken over [{ticket_id}]")
            if kept:
                said.append(f"{len(kept['paths'])} uncommitted file(s) left in the cell after the take-over are kept under {kept['ref']} and not used "
                            f"(git checkout {kept['ref']} -- <file> brings one back).")
            base = record.get("head")
            tip = head_of(work)
            if base and tip and tip != base:
                ref = free_ref(f"refs/mach/taken-over/{ticket_id}/")
                count = git("rev-list", "--count", f"{base}..{tip}").stdout.strip() or "some"
                if git("update-ref", ref, tip).returncode == 0 and git("reset", "-q", "--hard", base).returncode == 0:
                    said.append(f"{count} commit(s) made on the branch after the take-over, by no station of this worker, are kept under {ref} "
                                f"and not used: the branch is back at {base[:12]} (git log {ref} shows them).")
    except OSError as exc:
        said.append(f"MACH could not set aside what was left in the cell after the take-over ({str(exc)[:160]}); look at the cell's checkout.")
    record.update({"swept": True, "swept_at": stamp(now()), "said": said})
    try:
        (folder / TAKEOVER).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass
    return " ".join(said) or None


def reinstate(cell_dir: Path, holder: Optional[str]) -> None:
    """A person named the ticket again for a holder that was displaced before: it holds the work again."""
    known = displaced_all(cell_dir)
    if holder in known:
        known.pop(str(holder))
        _write_displaced(cell_dir, known)


def stopped_words(record: Dict[str, Any]) -> str:
    """What a displaced worker is told at its next station call or its next `next`."""
    return (f"This ticket was taken over by a person at {clock(record.get('at'))}. This worker's part stops here; nothing it had not "
            "committed is used. Stop now and report that the ticket was taken over.")


def station_argv(parser: Any, argv: Sequence[str]) -> Tuple[List[str], Optional[str]]:
    """For a station's command line: (the arguments to parse, the --holder given or None). A station command whose own parser takes
    --holder (a lane's build.py commands, cell.py claim) keeps it; for every other command it is taken out here, so any worker can pass
    the holder its step was claimed for to every station command it runs."""
    items = list(argv)
    holder: Optional[str] = None
    keeps = False
    choices: Dict[str, Any] = {}
    for action in getattr(parser, "_actions", []):
        if action.__class__.__name__ == "_SubParsersAction":
            choices = dict(action.choices)
    command = next((item for item in items if item in choices), None)
    if command is not None:
        keeps = "--holder" in getattr(choices[command], "_option_string_actions", {})
    out: List[str] = []
    index = 0
    while index < len(items):
        item = items[index]
        if item == "--holder" and index + 1 < len(items):
            holder = items[index + 1]
            if keeps:
                out += items[index:index + 2]
            index += 2
            continue
        if item.startswith("--holder="):
            holder = item.split("=", 1)[1]
            if keeps:
                out.append(item)
            index += 1
            continue
        out.append(item)
        index += 1
    return out, holder


def config_minutes(project: Path) -> int:
    try:
        config = json.loads((Path(project) / ".factory" / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        config = {}
    return minutes(config)


def station_stop(project: Optional[Path], ticket_id: Any, holder: Optional[str], command: Optional[str] = None,
                 reads: Sequence[str] = ()) -> Optional[str]:
    """The refusal for a worker whose holder a person's take-over displaced, or None. Shared by every station's command line.

    A call with no holder cannot be told apart from the worker taken over, so while a take-over stands (some holder is displaced in the
    cell, and someone's claim on its step is fresh) a holderless call of a command that changes something (`command` not in `reads`)
    is refused too, with how a caller says who it is."""
    if project is None or not isinstance(ticket_id, str):
        return None
    cell_dir = Path(project) / ".factory" / "worktrees" / ticket_id
    if valid_holder(holder):
        record = displaced(cell_dir, holder)
        return stopped_words(record) if record else None
    if holder is not None or command is None or command in reads:
        return None
    gone = displaced_all(cell_dir)
    if not gone or current(cell_dir, config_minutes(Path(project))) is None:
        return None
    latest = max(gone.values(), key=lambda item: str(item.get("at")))
    return (f"This ticket was taken over by a person at {clock(latest.get('at'))}, and this call names no holder, so MACH cannot tell it from "
            "the worker taken over. Pass --holder <the holder your step's prompt names>. A person running a station by hand takes the ticket "
            f"first with run.py next {ticket_id} --by-person --holder new and passes the holder it prints.")


def set_aside(work: Path, ref: str, message: str) -> Optional[Dict[str, Any]]:
    """Keep a checkout's uncommitted files (tracked and untracked, not ignored) as one commit on top of its HEAD under `ref`, through a
    separate index, then put those files back to HEAD. None when the checkout is clean or is not a Git checkout. Raises OSError with
    nothing changed when Git cannot save them. `git checkout <ref> -- <path>` brings a file back."""
    import shutil
    import subprocess

    def git(*args: str, env: Optional[Dict[str, str]] = None) -> Any:
        return subprocess.run(["git", *args], cwd=str(work), capture_output=True, text=True, env=env)

    if not Path(work).is_dir() or git("rev-parse", "--verify", "-q", "HEAD").returncode != 0:
        return None
    listed = git("status", "--porcelain", "-z", "--untracked-files=all").stdout.split("\0")
    paths: List[str] = []
    skip = False
    for entry in listed:
        if skip:
            skip = False
            continue
        if len(entry) > 3:
            paths.append(entry[3:])
            skip = entry[0] in "RC"
    if not paths:
        return None
    head = git("rev-parse", "HEAD").stdout.strip()
    index = Path(git("rev-parse", "--git-path", "index").stdout.strip())
    index = index if index.is_absolute() else Path(work) / index
    scratch = index.with_name(index.name + ".mach-takeover")
    env = dict(os.environ, GIT_INDEX_FILE=str(scratch))
    if git("var", "GIT_COMMITTER_IDENT").returncode != 0:
        env.update({"GIT_AUTHOR_NAME": "MACH", "GIT_AUTHOR_EMAIL": "mach@localhost", "GIT_COMMITTER_NAME": "MACH", "GIT_COMMITTER_EMAIL": "mach@localhost"})
    try:
        if index.is_file():
            shutil.copyfile(str(index), str(scratch))
        added = git("add", "-A", "--sparse", env=env)
        tree = git("write-tree", env=env) if added.returncode == 0 else added
        made = git("commit-tree", tree.stdout.strip(), "-p", head, "-m", message, env=env) if tree.returncode == 0 else tree
    finally:
        if scratch.exists():
            scratch.unlink()
    if made.returncode != 0 or git("update-ref", ref, made.stdout.strip()).returncode != 0:
        raise OSError((made.stderr or made.stdout or "git could not save the files").strip()[:300])
    git("reset", "-q", "--", *paths)
    tracked = [name for name in paths if git("cat-file", "-e", f"HEAD:{name}").returncode == 0]
    if tracked:
        git("checkout", "-q", "HEAD", "--", *tracked)
    for name in paths:
        if name in tracked:
            continue
        target = Path(work) / name
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.is_dir():
            shutil.rmtree(str(target), ignore_errors=True)
    return {"commit": made.stdout.strip(), "ref": ref, "paths": sorted(paths)}


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
