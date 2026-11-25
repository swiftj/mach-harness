"""Whether the readiness audit's last report still lets building start, and if it must run again, why.

The one rule, shared by run.py (the routing sheet and status), build.py (the build's start gate) and audit.py
(gate). Loaded the way lifecycle.py, adr.py and claim.py are, never copied.

A Gold or Silver report stays good when the main branch moves: every build runs the project's tests in its own
cell before it starts and refuses if they fail, so a main branch broken since the audit is caught there. Such a
report is due again only when:

- it is older than audit.max_age_days (30 by default);
- a build's tests failed before any change since it ran (build.py records that in .factory/audit-due.json);
- a person asks for the audit (it always runs when asked; nothing here stops it).

A Bronze report is due again as soon as the main branch has moved past the commit it ran at, so a project that
merged its hardening work is never left stuck at Bronze.

The audit report records the commit it ran at and the commands it chose (and from where: an argument, the
settings, the Makefile or the language), but not the files it read to choose them, so a change to those files
is not a reason here.

Standard library only; Python 3.8.
"""

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

REPORT = ".factory/audit-report.json"
DUE = ".factory/audit-due.json"
DEFAULT_MAX_AGE_DAYS = 30
PASSING = ("Gold", "Silver")


def _load(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _when(value: Any) -> Optional[datetime]:
    try:
        moment = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def short(commit: Any) -> str:
    return str(commit)[:10] if commit else "no commit"


def max_age_days(config: Dict[str, Any], given: Optional[float] = None) -> float:
    """audit.max_age_days from the settings, or the one given, or 30."""
    if given is not None:
        return given
    section = config.get("audit") if isinstance(config.get("audit"), dict) else {}
    value = section.get("max_age_days", DEFAULT_MAX_AGE_DAYS)
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else DEFAULT_MAX_AGE_DAYS


def head_of(root: Path) -> Optional[str]:
    try:
        done = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, stdin=subprocess.DEVNULL)
    except OSError:
        return None
    return done.stdout.strip() or None


def mark_due(root: Path, code: str, ticket_id: str, words: str) -> None:
    """Record that something since the audit gives a reason to doubt it: a build's tests failed before any change.
    The next audit clears it, by running after it. Never raises."""
    try:
        path = root / DUE
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "code": code, "ticket_id": ticket_id, "words": words}
        path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass


def judge(report: Any, head: Optional[str], due: Any, limit: float, now: Optional[datetime] = None) -> Dict[str, Any]:
    """The rule itself, on what was read: missing, stale (with why and the words), bronze or ok."""
    if not isinstance(report, dict):
        return {"state": "missing", "why": "missing", "reason": "There is no readiness audit report yet."}
    ran = _when(report.get("timestamp"))
    at = report.get("head")
    tier = report.get("readiness_tier")
    facts: Dict[str, Any] = {"tier": tier, "ran_at": report.get("timestamp"), "ran_at_commit": at, "head": head}

    def stale(why: str, words: str) -> Dict[str, Any]:
        return {"state": "stale", "why": why, "reason": f"The readiness audit must run again: {words}.", **facts}

    moved = at != head
    if tier not in PASSING and moved:
        return stale("bronze-moved", f"the repository is at {tier or 'Bronze'} and the main branch has moved since the audit ran at {short(at)}, "
                                      "so it may be hardened now")
    age = ((now or datetime.now(timezone.utc)) - ran).total_seconds() / 86400 if ran else float("inf")
    if age > limit:
        if ran is None:
            return stale("too-old", "the report does not say when it ran, so it is taken as too old")
        return stale("too-old", f"it ran {int(age)} days ago, more than audit.max_age_days ({limit:g}) allows")
    doubted = _when(due.get("at")) if isinstance(due, dict) else None
    if doubted and (ran is None or doubted > ran):
        who = f" ({due.get('ticket_id')}, {due.get('at')})" if due.get("ticket_id") else f" ({due.get('at')})"
        return stale("baseline-failed", f"a build's tests failed before any change{who}, after the audit ran, so the main branch may have broken since")
    result = {"state": "ok" if tier in PASSING else "bronze", **facts, "blockers": report.get("blockers") or []}
    if moved:
        result["note"] = (f"The audit ran at {report.get('timestamp')} on commit {short(at)}; the main branch has moved since, to {short(head)}. "
                          f"A {tier} audit stays good until it is {limit:g} days old or a build's tests fail before any change.")
    return result


def state(root: Path, config: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    """Whether the readiness audit lets building start: off, missing, stale (with why), bronze or ok."""
    section = config.get("build") if isinstance(config.get("build"), dict) else {}
    if section.get("require_audit") is False:
        return {"state": "off"}
    return judge(_load(root / REPORT), head_of(root), _load(root / DUE), max_age_days(config), now)
