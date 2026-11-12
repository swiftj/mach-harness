#!/usr/bin/env python3
"""Station lifecycle telemetry (MACH Next M6.1): one append-only log per cell.

Every station script reports what it has just decided and recorded to
.factory/worktrees/<ticket_id>/lifecycle.jsonl, one JSON object per line:

    {"v": 1, "seq": 7, "at": "2026-11-12T10:15:03.412Z", "ticket_id": "LOCAL-001", "type": "station.entered",
     "station": "verify", "visit": "verify#2", "round": 2, "execution_id": null, "data": {"stage": "built"}}

The log is observational. The station's own files (cell.json, build.json, evidence/, review/) stay
authoritative; this log only says, in order, what those stations recorded. Call sites therefore come
after the station's state file is written, never before.

Guarantees the call sites rely on:
- record() never raises and returns None. A failure is swallowed after at most one line on stderr
  per process; it never changes an exit code, stdout, or a station's files.
- One record is one write of one whole line on a file opened with O_APPEND, then fsync.
- seq is allocated under a short advisory lock (fcntl.flock on the log itself). If the lock is not
  free within LOCK_WAIT seconds, the record is written with "seq": null instead of waiting. Readers
  order records by line position; seq is a check, not the order. A lost write leaves no gap in seq
  (the next record takes the next number), so seq continuity is never proof of completeness: a reader
  compares the log against cell.json and the station files, which win on any disagreement.
- The log is authoritative for what it records, and observational in effect: it never changes a
  station's result.
- A torn last line (a writer killed mid-write) is never extended: the next record starts on a new
  line, and readers skip any line that is not a whole JSON object.
- data holds identifiers, counts, outcomes, hashes, short commits and paths relative to the cell.
  safe() drops anything that looks like an absolute path and anything that is not a plain value.

Standard library only.
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

try:
    import fcntl
except ImportError:  # not POSIX: records are written with "seq": null
    fcntl = None  # type: ignore[assignment]

VERSION = 1
FILE = "lifecycle.jsonl"
ENV = "MACH_EXECUTION_ID"  # set by the Factory's executor for supervisor-run work; absent when a person drives
LOCK_WAIT = 0.2  # seconds; never longer, so a station is not slowed by its own telemetry
STATIONS = ("groom", "plan", "audit", "build", "verify", "review", "human-approval", "merge", "cleanup")
TYPES = ("station.entered", "station.exited", "gate.evaluated", "build.task_completed", "verify.check_recorded",
         "review.round_started", "review.verdict_submitted", "review.decided", "human.approval_recorded",
         "merge.completed", "cleanup.completed")
JUDGED = ("build", "verify", "review", "human-approval")  # stations whose work belongs to a judging round
TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
EXECUTION_ID_RE = re.compile(r"^x[0-9a-f]{12}$")
KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
ABSOLUTE_RE = re.compile(r"^(?:/|\\|~|[A-Za-z]:[\\/])")
RULE_ID_RE = re.compile(r"\b(?:(?:FR|INV|AC)-\d{2,}|R\d{1,3})\b")
MAX_TEXT = 120
MAX_ITEMS = 50

_warned = False


def _warn(exc: BaseException) -> None:
    global _warned
    if _warned:
        return
    _warned = True
    try:
        sys.stderr.write(f"mach lifecycle: not recorded ({type(exc).__name__})\n")
    except Exception:  # noqa: BLE001 - telemetry must never raise
        pass


def now() -> str:
    moment = datetime.now(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def short(commit: Any) -> Optional[str]:
    """A commit as a short, safe identifier."""
    return commit[:12] if isinstance(commit, str) and re.match(r"^[0-9a-f]{7,64}$", commit) else None


def rule_ids(text: Any) -> List[str]:
    """Spec and matrix IDs named in a reviewer's rule field: the IDs only, never the prose around them."""
    return sorted(set(RULE_ID_RE.findall(text))) if isinstance(text, str) else []


def safe(value: Any, depth: int = 0) -> Any:
    """What may be shown in a browser: plain values, short strings, no absolute paths."""
    if value is None or isinstance(value, bool) or isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if value == value and value not in (float("inf"), float("-inf")) else None
    if isinstance(value, str):
        return None if ABSOLUTE_RE.match(value) or "\n" in value else value[:MAX_TEXT]
    if depth >= 3:
        return None
    if isinstance(value, (list, tuple)):
        return [safe(item, depth + 1) for item in list(value)[:MAX_ITEMS]]
    if isinstance(value, dict):
        return {key: safe(item, depth + 1) for key, item in list(value.items())[:MAX_ITEMS] if isinstance(key, str) and KEY_RE.match(key)}
    return None


def parse(raw: bytes) -> List[Dict[str, Any]]:
    """Every whole record in file order. A torn or malformed line is skipped, never repaired."""
    records = []
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        try:
            item = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue
        if isinstance(item, dict) and item.get("v") == VERSION and isinstance(item.get("type"), str):
            records.append(item)
    return records


def read(cell_dir: Path) -> List[Dict[str, Any]]:
    """The cell's history, in file order. For readers and tests; never raises on a damaged file."""
    try:
        return parse((Path(cell_dir) / FILE).read_bytes())
    except OSError:
        return []


def _visits(records: Iterable[Dict[str, Any]]) -> Tuple[Dict[str, int], Dict[str, bool], int]:
    entered: Dict[str, int] = {}
    open_: Dict[str, bool] = {}
    last_seq = 0
    for item in records:
        station = item.get("station")
        if item.get("type") == "station.entered":
            entered[station] = entered.get(station, 0) + 1
            open_[station] = True
        elif item.get("type") == "station.exited":
            open_[station] = False
        seq = item.get("seq")
        if type(seq) is int and seq > last_seq:
            last_seq = seq
    return entered, open_, last_seq


def _judging_round(cell_dir: Path, station: str) -> Optional[int]:
    """The judging round, from the build station's own state: round 1 until the first revision."""
    if station not in JUDGED:
        return None
    try:
        loop = json.loads((cell_dir / "build.json").read_text(encoding="utf-8")).get("loop")
    except (OSError, ValueError, AttributeError):
        loop = 0
    return loop + 1 if type(loop) is int and loop >= 0 else 1


def _cell(cell_dir: Any) -> Optional[Path]:
    """The cell folder if it is a real, existing cell; telemetry never creates one."""
    root = Path(cell_dir)
    if not TICKET_ID_RE.match(root.name) or ".." in root.parts or root.parent.name != "worktrees" or root.is_symlink() \
            or not (root / "cell.json").is_file():
        return None
    return root


def _render(records: List[Dict[str, Any]], ticket_id: str, type_: str, station: str, data: Any,
            judging_round: Optional[int], locked: bool, once: bool) -> Optional[Dict[str, Any]]:
    if type_ not in TYPES or station not in STATIONS:
        raise ValueError(f"unknown lifecycle record {type_} for {station}")
    entered, open_, last_seq = _visits(records)
    count, is_open = entered.get(station, 0), open_.get(station, False)
    if type_ == "station.entered":
        if once and is_open:
            return None
        number = count + 1
    elif type_ == "station.exited":
        number = max(count, 1)
    else:
        number = count if is_open else count + 1  # a refusal at the door belongs to the visit it would have opened
    execution = os.environ.get(ENV, "")
    payload = data() if callable(data) else data  # a call site's payload is built here, inside the guard
    if type_ == "station.entered" and is_open and isinstance(payload, dict):
        payload = {**payload, "unclosed_visit": f"{station}#{count}"}  # restarted without an exit: say so, invent no exit
    return {
        "v": VERSION, "seq": last_seq + 1 if locked else None, "at": now(), "ticket_id": ticket_id, "type": type_,
        "station": station, "visit": f"{station}#{number}", "round": judging_round if type(judging_round) is int and judging_round > 0 else None,
        "execution_id": execution if EXECUTION_ID_RE.match(execution) else None, "data": safe(payload if isinstance(payload, dict) else {}),
    }


def _line(item: Dict[str, Any], existing: bytes) -> bytes:
    body = json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    return (b"\n" if existing and not existing.endswith(b"\n") else b"") + body


def _lock(fd: int) -> bool:
    if fcntl is None:
        return False
    deadline = time.monotonic() + LOCK_WAIT
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)


def _existing(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(str(path), flags)
    except FileNotFoundError:
        return b""
    try:
        chunks = []
        while True:
            block = os.read(fd, 1 << 16)
            if not block:
                return b"".join(chunks)
            chunks.append(block)
    finally:
        os.close(fd)


def _write_all(fd: int, data: bytes) -> None:
    """One write call for one whole line. Separate so tests can simulate a full disk."""
    os.write(fd, data)


def record(cell_dir: Any, type_: str, station: str, data: Any = None, *,
           judging_round: Any = "auto", once: bool = False) -> None:
    """Append one lifecycle record to the cell's log. Never raises; never creates a cell.

    data: a dict, or a function returning one. Call sites pass a lambda, so that building the payload
    from a station's state can never raise into the station itself.
    judging_round: the record's "round"; "auto" reads it from build.json for build, verify, review and
    human-approval, and leaves it null elsewhere. once: for station.entered, write nothing when that
    station's latest visit is still open (a resumed session is the same visit).
    """
    try:
        root = _cell(cell_dir)
        if root is None:
            return
        path = root / FILE
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        fd = os.open(str(path), flags, 0o644)
        try:
            locked = _lock(fd)
            existing = _existing(path)
            item = _render(parse(existing), root.name, type_, station, data,
                           _judging_round(root, station) if judging_round == "auto" else judging_round, locked, once)
            if item is not None:
                _write_all(fd, _line(item, existing))
                os.fsync(fd)
        finally:
            os.close(fd)  # closing releases the lock
    except Exception as exc:  # noqa: BLE001 - telemetry is observational and must never change a station's result
        _warn(exc)


def closing(cell_dir: Any, events: Sequence[Tuple[str, str, Any]], outcome: str) -> Optional[bytes]:
    """The log as the archive should keep it: what is on disk, every still-open visit exited with
    `outcome`, then `events` (type, station, data). Nothing is written to the cell. None on any failure,
    in which case the archive keeps the file as it is.

    Cleanup uses this because it deletes the cell folder: its own records exist only in the archive.
    """
    try:
        root = _cell(cell_dir)
        if root is None:
            return None
        existing = _existing(root / FILE)
        records = parse(existing)
        _, open_, _ = _visits(records)
        pending = [("station.exited", station, {"outcome": outcome, "closed_by": "cleanup"}) for station in STATIONS if open_.get(station)]
        out = existing
        for type_, station, data in [*pending, *events]:
            item = _render(records, root.name, type_, station, data, _judging_round(root, station), True, False)
            if item is not None:
                out += _line(item, out)
                records.append(item)
        return out
    except Exception as exc:  # noqa: BLE001
        _warn(exc)
        return None
