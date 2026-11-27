#!/usr/bin/env python3
"""MACH decide do: record one person's decision on one waiting ticket, then let the Factory carry it on.

Reached as `run.py decide do <ticket> <option> [--by NAME] [--reason WHY] [--adr ADR-NNNN ...] [--test-cmd CMD]
[--answers-file FILE] [--via terminal|floor] [--json]`. The terminal (the run skill, on the person's word) and the
Factory Floor both call it, so a decision is recorded one way wherever it is made (design M23 3.1).

It adds no power. It reads the list `run.py decide --json` gives for the ticket now (decide.py) and carries out only an
option that list offers, through the station that owns it, with that station's own gates:

    approve            review.py approve-human           send-back      review.py send-back
    merge              merge.py run --by-person         accept         cell.py adr-accept (a ticket's proposed ADRs)
    exception          cell.py adr-exception (an ADR)   replan         cell.py replan
    set-test-command   build.py set-commands            abandon        cleanup.py plan, then run, then the ticket is closed
    retry, run, revise nothing is recorded              answers        .factory/local/answers/<ticket>.json, its hash in the ledger (3.2)
    wait               nothing changes                  take-over      the step is taken from the other worker (the `take_over` seam)
    carry-on           build.py carry-on (--guidance: the person's words, optional): one more round for a stopped ticket

An option that needs an agent or a conversation (`do: false` in the list) is answered with the command to run, and
nothing changes. After a decision that moves the ticket, its parked entry and attempt count are removed from the intake
ledger under the intake lock (design 2.5), and the Factory supervisor is woken or started (activation.carry_on, through
the `carry_on` callable run.py passes in).

Another worker's claim on the ticket never stops a person's decision. The list offers what the ticket's state offers,
with the claim in its `warnings`, and the decision is recorded with those warnings in its answer. No station reads a
claim (claim.py), so none refuses because of one. A decision that hands the ticket to the Factory at the stage it is at
(an option marked `takes_over`) takes the step from the other worker as well, so the Factory is not held by its claim.

Two people deciding at once: the decision lock keeps two writes apart and is held for one station call. A second decision
waits for it (LOCK_WAIT_SECONDS from the terminal; LOCK_WAIT_FLOOR from the Factory Floor, which asks again by itself and
shows that it waits). If the lock is still held then, the answer is `busy` and nothing is recorded yet. Once it has the
lock, a decision that is still on offer is carried out. One that the first decision made moot is answered, not refused,
with what was decided, by whom and when, and what is on offer now (`already_decided`).

Entry point, wired in by run.py:

    act.main(ticket, key, root, *, report, by, reason, adrs, test_cmd, answers_file, via, station, line, carry_on,
             take_over=None, to_factory=False, run_skill="/mach", now=None, lock_wait=None) -> dict

    report     callable(ticket) -> decide.main's report for that one ticket, computed now
    station    callable(name, argv) -> (exit code, stdout, stderr): runs one station script (see station_runner)
    line       callable() -> the product intake (intake.Factory) for the ledger and its lock, or raises
    carry_on   callable() -> {"supervisor": "started"|"woken"|"none", "pid", "why_not"}
    take_over  callable(ticket, *, by, via, to_factory) -> {"taken", "step", "since", "factory_run", "other", "said"}: takes
               the ticket's step from the worker that holds it, for a person (run.py's decide_take_over; the seam below)
    to_factory the person said the Factory carries a taken-over ticket on (the Factory Floor always does). Otherwise "Take it
               over" leaves the ticket for /mach <ticket> in Claude Code and starts or wakes nothing

It raises ActError, with a sentence that says what to do next, when it records nothing. A person's reason, answers and
name are passed on exactly as given: never written, shortened or improved here.

Standard library only.
"""

import contextlib
import hashlib
import json
import os
import re
import stat
import time
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

VIA = ("terminal", "floor")
ADR_RE = re.compile(r"^ADR-\d{4}$")
ANSWERS_FILE_LIMIT = 256 * 1024
ANSWER_LIMIT = 4000
LEAVE_OPEN = "leave open"
# Where each option is carried out: (station, script, command).
STATIONS = {
    "approve": ("review", "review.py", "approve-human"),
    "send-back": ("review", "review.py", "send-back"),
    "merge": ("merge", "merge.py", "run"),
    "accept": ("intent", "cell.py", "adr-accept"),
    "exception": ("intent", "cell.py", "adr-exception"),
    "replan": ("intent", "cell.py", "replan"),
    "set-test-command": ("build", "build.py", "set-commands"),
    "carry-on": ("build", "build.py", "carry-on"),
}
GUIDANCE_LIMIT = 4000
NOTHING_RECORDED = ("retry", "run", "revise")
# Why an option is left to a conversation, said to the person with the command to run.
IN_CONVERSATION = {
    "interview": "The interview continues in a conversation, one question at a time.",
    "exception": "A security exception is a person's acceptance of a real finding, read with an agent in a conversation first.",
    "accept": "A policy owner's acceptance is checked against the pack's owner in a conversation.",
    "audit": "The audit station measures the repository with an agent, in a conversation.",
    "draft": "The baseline decisions are drafted and settled with an engineer, in a conversation.",
    "new": "A decision is written with an engineer, in a conversation.",
    "set-test-command": "The build has not started, and its first step is the builder's: a conversation starts it with the command.",
    "run": "Running it here goes station by station, in a conversation.",
}


class ActError(Exception):
    """A decision that was not recorded, with what to do next. run.py prints it as `refused: ...` and exits 1."""


def now_text(moment: Optional[datetime] = None) -> str:
    return (moment or datetime.now(timezone.utc)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def first_json(text: str) -> Optional[Dict[str, Any]]:
    """The station's own answer: the first JSON object it printed (some print a line of text after it)."""
    start = text.find("{")
    if start < 0:
        return None
    try:
        found, _ = json.JSONDecoder().raw_decode(text[start:])
    except ValueError:
        return None
    return found if isinstance(found, dict) else None


def refusal_text(code: int, out: str, err: str) -> str:
    """The station's own refusal sentence, without its `refused:` or `error:` prefix."""
    for line in (err or "").splitlines():
        line = line.strip()
        for prefix in ("refused: ", "error: "):
            if line.startswith(prefix):
                return line[len(prefix):]
    lines = [line.strip() for line in ((err or "") + "\n" + (out or "")).splitlines() if line.strip()]
    return lines[-1] if lines else f"it stopped with exit code {code} and said nothing"


def station_runner(root: Path, sibling: Callable[[str], Path]) -> Callable[[str, Sequence[str]], Tuple[int, str, str]]:
    """Runs one station script as the run skill would: this Python, the station's script beside this one (whichever way MACH
    is installed), an argument list (never a shell), every value given as --name=value so none is read as an option."""
    def run(name: str, argv: Sequence[str]) -> Tuple[int, str, str]:
        script = {"review": "review.py", "merge": "merge.py", "intent": "cell.py", "build": "build.py", "cleanup": "cleanup.py",
                  "ticket": "ticket.py"}[name]
        path = sibling(name) / "scripts" / script
        if not path.is_file():
            raise ActError(f"The {name} station is not installed here ({path}), so nothing was recorded. Install MACH again, then decide again.")
        done = subprocess.run([sys.executable, "-B", str(path), "--project", str(root), *argv], cwd=str(root), capture_output=True, text=True,
                              errors="replace", stdin=subprocess.DEVNULL)
        return done.returncode, done.stdout, done.stderr
    return run


def find(report: Dict[str, Any], ticket: str, run_skill: str) -> Dict[str, Any]:
    for item in report.get("tickets") or []:
        if item.get("ticket_id") == ticket:
            return item
    for answer in report.get("not_waiting") or []:
        if answer.get("ticket_id") == ticket:
            raise ActError(f"{answer.get('answer')} Nothing was recorded. {run_skill} decide lists what is waiting for a person.")
    raise ActError(f"{ticket} is not waiting for a person now, so nothing was recorded. {run_skill} decide lists what is waiting.")


def on_offer(item: Dict[str, Any]) -> str:
    return "; ".join(f"{choice['key']} ({choice['label']})" for choice in item["options"]) or "nothing"


def check_inputs(choice: Dict[str, Any], key: str, by: Optional[str], reason: Optional[str], adrs: List[str], test_cmd: Optional[str],
                 answers_file: Optional[Path], option_adrs: List[str], guidance: Optional[str] = None) -> None:
    label = choice["label"]
    if key != "wait" and not (by or "").strip():
        raise ActError("No name to record the decision under: git config user.name is not set here. Give the person's name with "
                       "--by \"<name>\", or set it once with git config user.name \"<name>\". Nothing was recorded.")
    if choice.get("needs_reason") and not (reason or "").strip():
        raise ActError(f"\"{label}\" needs the person's reason, in their own words: give it with --reason \"<their words>\". Nothing was recorded.")
    if reason and not choice.get("needs_reason") and key != "approve":
        raise ActError(f"\"{label}\" records no reason, so --reason would be lost: leave it out. Nothing was recorded.")
    if "test_cmd" in choice.get("needs", []) and not (test_cmd or "").strip():
        raise ActError(f"\"{label}\" needs the command that runs the tests: give it with --test-cmd \"<command>\". Nothing was recorded.")
    if test_cmd and "test_cmd" not in choice.get("needs", []):
        raise ActError(f"\"{label}\" takes no test command: leave --test-cmd out. Nothing was recorded.")
    if "answers" in choice.get("needs", []) and answers_file is None:
        raise ActError(f"\"{label}\" needs the answers: give a JSON file with --answers-file, [{{\"n\": 1, \"answer\": \"...\"}}, ...], one "
                       "entry per question, each answered or marked leave open. Nothing was recorded.")
    if answers_file is not None and "answers" not in choice.get("needs", []):
        raise ActError(f"\"{label}\" takes no answers: leave --answers-file out. Nothing was recorded.")
    if guidance is not None and "guidance" not in choice.get("takes", []):
        raise ActError(f"\"{label}\" takes no guidance: leave --guidance out. Nothing was recorded.")
    if guidance and ("\x00" in guidance or len(guidance) > GUIDANCE_LIMIT):
        raise ActError(f"The guidance must be plain text of at most {GUIDANCE_LIMIT} characters. Nothing was recorded.")
    if adrs:
        if not option_adrs:
            raise ActError(f"\"{label}\" is not about an architecture decision: leave --adr out. Nothing was recorded.")
        stray = [ident for ident in adrs if ident not in option_adrs]
        if stray:
            raise ActError(f"{', '.join(stray)} {'is' if len(stray) == 1 else 'are'} not what \"{label}\" is about now: it is about "
                           f"{', '.join(option_adrs)}. Nothing was recorded.")


def option_adrs(item: Dict[str, Any], key: str) -> List[str]:
    """The ADRs an option acts on, from the ticket's facts in the list: a proposed ADR to accept, or the ADR an exception is to."""
    facts = item.get("situation") or {}
    if key == "accept" and item.get("state") == "adr-acceptance":
        return [entry["id"] for entry in facts.get("proposed") or [] if isinstance(entry, dict) and isinstance(entry.get("id"), str) and ADR_RE.match(entry["id"])]
    if key == "exception" and item.get("state") == "adr-conflict":
        ident = (facts.get("adr") or {}).get("id")
        return [ident] if isinstance(ident, str) and ADR_RE.match(ident) else []
    return []


def read_answers(path: Path, questions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The person's answers, one per question, exactly as written. Refused, with what to change, unless every question is
    answered or left open and at least one is answered."""
    try:
        info = path.stat()
        if not stat.S_ISREG(info.st_mode):  # a FIFO or a device would hang the read, or never end
            raise ActError("The answers file is not a regular file. Give the path of a JSON file with --answers-file. Nothing was recorded.")
        if info.st_size > ANSWERS_FILE_LIMIT:
            raise ActError(f"The answers file is larger than {ANSWERS_FILE_LIMIT // 1024} KB; keep each answer to the point. Nothing was recorded.")
        with path.open("rb") as handle:
            raw = handle.read(ANSWERS_FILE_LIMIT + 1)
        if len(raw) > ANSWERS_FILE_LIMIT:
            raise ActError(f"The answers file is larger than {ANSWERS_FILE_LIMIT // 1024} KB; keep each answer to the point. Nothing was recorded.")
        data = json.loads(raw.decode("utf-8"))
    except OSError as exc:
        raise ActError(f"The answers file cannot be read ({exc.strerror or exc}). Give the path of a JSON file with --answers-file. Nothing was recorded.")
    except (ValueError, UnicodeError):
        raise ActError("The answers file is not JSON. It holds [{\"n\": 1, \"answer\": \"...\"}, {\"n\": 2, \"leave_open\": true}]. Nothing was recorded.")
    if isinstance(data, dict):
        data = data.get("answers")
    if not isinstance(data, list):
        raise ActError("The answers file holds a list: [{\"n\": 1, \"answer\": \"...\"}, {\"n\": 2, \"leave_open\": true}]. Nothing was recorded.")
    by_number = {question["n"]: question for question in questions}
    given: Dict[int, Dict[str, Any]] = {}
    for entry in data:
        number = entry.get("n") if isinstance(entry, dict) else None
        if type(number) is not int or number not in by_number:
            raise ActError(f"Each answer names its question by number, 1 to {len(questions)}; one does not ({json.dumps(number)}). Nothing was recorded.")
        if number in given:
            raise ActError(f"Question {number} is answered twice: keep one answer. Nothing was recorded.")
        answer = entry.get("answer")
        leave = entry.get("leave_open") is True or (isinstance(answer, str) and answer.strip().lower() == LEAVE_OPEN)
        if leave:
            given[number] = {"n": number, "question": by_number[number]["text"], "leave_open": True}
            continue
        if not isinstance(answer, str) or not answer.strip():
            raise ActError(f"Question {number} has no answer: answer it, or mark it leave open. Nothing was recorded.")
        if len(answer) > ANSWER_LIMIT or "\x00" in answer:
            raise ActError(f"The answer to question {number} is longer than {ANSWER_LIMIT} characters or not plain text. Nothing was recorded.")
        given[number] = {"n": number, "question": by_number[number]["text"], "answer": answer.strip()}
    missing = [str(number) for number in by_number if number not in given]
    if missing:
        raise ActError(f"Question{'s' if len(missing) > 1 else ''} {', '.join(missing)} {'have' if len(missing) > 1 else 'has'} no answer: answer "
                       "each, or mark it leave open. Nothing was recorded.")
    if all(entry.get("leave_open") for entry in given.values()):
        raise ActError("Every question is left open, so nothing would change. Answer at least one, or skip this ticket for now. Nothing was recorded.")
    return [given[number] for number in sorted(given)]


def answers_path(root: Path, ticket: str) -> Path:
    """Where a person's answers for a ticket are kept: the Factory's machine-local state, which no run may edit (executor.protected)."""
    return Path(root) / ".factory" / "local" / "answers" / f"{ticket}.json"


def recorded_answers_hash(root: Path, ticket: str) -> Optional[str]:
    ledger = load_json(Path(root) / ".factory" / "intake" / "ledger.json", {}) or {}
    entry = ((ledger.get("decisions") or {}).get("answers") or {}).get(ticket) if isinstance(ledger, dict) else None
    return entry.get("sha256") if isinstance(entry, dict) and isinstance(entry.get("sha256"), str) else None


def trusted_answers(root: Path, ticket: str, spec_sha256: Optional[str]) -> Optional[Dict[str, Any]]:
    """A person's answers waiting to be folded into the spec as it is now, or None. Trusted only when the file is a regular file
    whose SHA-256 is the one `decide do` recorded in the intake ledger when it wrote it: a file put there any other way is ignored."""
    path = answers_path(root, ticket)
    try:
        if path.is_symlink() or not path.is_file():
            return None
        with path.open("rb") as handle:
            raw = handle.read(ANSWERS_FILE_LIMIT * 2 + 1)
    except OSError:
        return None
    if len(raw) > ANSWERS_FILE_LIMIT * 2 or hashlib.sha256(raw).hexdigest() != recorded_answers_hash(root, ticket):
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError):
        return None
    if not isinstance(data, dict) or not spec_sha256 or data.get("spec_sha256") != spec_sha256:
        return None
    return data


def write_answers(root: Path, cellroot: Path, ticket: str, answers: List[Dict[str, Any]], by: str, via: str, moment: Optional[datetime],
                  line: Callable[[], Any]) -> Path:
    """Write the answers privately under .factory/local/answers/, then record their SHA-256 in the intake ledger under its lock."""
    import policy  # write_private: this user only, atomically, as the authorization is written
    cell = load_json(cellroot / "cell.json", {}) or {}
    path = answers_path(root, ticket)
    record = {"ticket_id": ticket, "by": by, "via": via, "at": now_text(moment), "spec_sha256": cell.get("spec_sha256"), "answers": answers,
              "note": "A person's answers to the spec's open questions. Data for the next grooming: each is that person's answer to its question."}
    text = json.dumps(record, indent=2, ensure_ascii=False) + "\n"
    for folder in (Path(root) / ".factory", Path(root) / ".factory" / "local", path.parent):
        if folder.is_symlink():
            raise ActError(f"{folder} is a symbolic link, so the answers were not written through it. Nothing was recorded.")
    policy.write_private(path, text)
    intake = line()
    with intake.lock("decide"):
        ledger = intake.ledger()
        ledger.setdefault("decisions", {}).setdefault("answers", {})[ticket] = {
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(), "by": by, "via": via, "at": record["at"]}
        intake.save(ledger)
    return path


def run_station(station: Callable[[str, Sequence[str]], Tuple[int, str, str]], key: str, argv: List[str], allowed: Tuple[int, ...] = (0,)) -> Dict[str, Any]:
    name, _script, command = STATIONS[key]
    code, out, err = station(name, [command, *argv])
    if code not in allowed:
        raise ActError(f"The {name} station refused, and nothing was recorded: {refusal_text(code, out, err)}")
    return {"name": name, "command": command, "exit_code": code, "answer": first_json(out)}


def update_ticket(station: Callable[[str, Sequence[str]], Tuple[int, str, str]], ticket: str, argv: List[str]) -> Dict[str, Any]:
    """The ticket skill's update, after the station's own step. A failure here is said, never a refusal: the decision stands."""
    try:
        code, out, err = station("ticket", ["update", ticket, *argv])
    except ActError as exc:
        return {"updated": False, "note": str(exc)}
    if code == 0:
        return {"updated": True}
    return {"updated": False, "note": refusal_text(code, out, err),
            "then": f"Update the ticket with: ticket.py update {ticket} " + " ".join(argv[:2]) + "."}


def unpark(root: Path, ticket: str, line: Callable[[], Any], announce: bool, run_skill: str = "/mach") -> Tuple[bool, Optional[str]]:
    """Remove the ticket's parked entry and attempt count under the intake lock (design 2.5). The event is the one
    `factory resume --retry` writes, so a reader closes the parked row the same way. Returns (removed, note)."""
    ledger = load_json(root / ".factory" / "intake" / "ledger.json", {})
    held = (ledger.get("supervisor") or {}) if isinstance(ledger, dict) else {}
    if ticket not in (held.get("parked") or {}) and ticket not in (held.get("attempts") or {}):
        return False, None
    try:
        intake = line()
        with intake.lock("decide"):
            fresh = intake.ledger()
            supervisor = fresh.setdefault("supervisor", {})
            removed = supervisor.setdefault("parked", {}).pop(ticket, None) is not None
            supervisor.setdefault("attempts", {}).pop(ticket, None)
            if removed and announce:
                intake.event_source = "engineer"
                intake.emit(fresh, "factory.resumed", by="engineer", retrying=[ticket])
            intake.save(fresh)
        return removed, None
    except Exception as exc:  # noqa: BLE001 - the decision stands; the hold is said, with how to lift it
        return False, (f"The Factory still holds {ticket} from earlier ({exc}). {run_skill} factory resume --retry {ticket} lets it run again.")


def clock(moment_text: Any, now: Optional[datetime] = None) -> str:
    """A recorded time as a person reads it: 14:02 UTC on the day it is now, else with its date."""
    try:
        moment = datetime.fromisoformat(str(moment_text).replace("Z", "+00:00"))
    except ValueError:
        return "an earlier time"
    moment = (moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    today = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).date()
    return moment.strftime("%H:%M UTC" if moment.date() == today else "%Y-%m-%d %H:%M UTC")


# ---- The take-over seam ----
#
# take_over(ticket, *, by, via, to_factory) -> {"taken": bool, "step", "since", "factory_run": bool, "other": str, "said": [str]}
#
# run.py's decide_take_over: the same take-over `run.py next` makes when a person names a ticket. It displaces the worker that
# holds the ticket's step (every station refuses it at its next call), ends a live Factory run on it, keeps a build step's
# uncommitted files aside, and leaves the step free for whoever carries the ticket on next. `to_factory`: the person said the
# Factory carries it on, so the ticket is the supervisor's again. `other` is one plain sentence about what happened to the other
# worker and `said` any further sentences (the files kept aside); act.py puts them in the decision's `now` as they are. `taken`
# is false when no other worker held the step (`other` then says so). It raises ActError when the step could not be taken;
# nothing has changed then.
#
# TAKE_OVER_EFFECT (TAKE_OVER_EFFECT_FACTORY for a Factory run) says, as the end of one sentence, what it means for the other
# worker; decide.py puts it in "Take it over"'s `does`, and the Factory Floor's confirm shows that.

TAKE_OVER_EFFECT = "the other worker stops at its next step."
TAKE_OVER_EFFECT_FACTORY = "the Factory's run on it is ended, and the other worker stops at its next step."


# ---- What was decided last, for the next person ----

DECIDED_FILE = Path(".factory") / "local" / "decided.json"
DECIDED_WITHIN_SECONDS = 3600  # a decision this recent is said to a second person whose decision it made moot
DECIDED_WORDS = {
    "approve": "Approved", "send-back": "Sent back", "merge": "Merged", "abandon": "Abandoned", "replan": "Sent back to be planned again",
    "accept": "Its ADR was accepted", "exception": "An exception to its ADR was recorded", "set-test-command": "Its test command was set",
    "retry": "Released to run again", "run": "Released to run again", "revise": "Released to be revised", "answers": "Its open questions were answered",
    "take-over": "Taken over", "carry-on": "Carried on with a fix",
}
WAITING_FOR = {
    "approval": "a person's approval", "merge": "the merge", "pull-request": "its pull request to land",
    "merge-stopped": "a person to decide on the stopped merge", "answers": "answers to its open questions",
    "build-gate": "a person to decide on the stopped build", "parked": "a person to say it may run again",
    "worker-in-cell": "the other worker, or for someone to take it over", "main-conflict": "the conflict with the main branch to be resolved",
    "escalated": "a person to carry it on with a fix", "stuck": "a person to carry it on", "landed-elsewhere": "a person's merge of this copy",
    "already-on-main": "this copy to be closed out", "security-veto": "a person to decide on the security finding",
}


def remember(root: Path, ticket: str, key: str, by: str, via: str, moment: Optional[datetime]) -> None:
    """Keep this decision as the ticket's last, on this machine, so a second person deciding at once is told of it. Private to
    this user; at most one entry per ticket, and none older than a day."""
    import policy
    path = Path(root) / DECIDED_FILE
    data = load_json(path, {}) or {}
    data = data if isinstance(data, dict) else {}
    at = moment or datetime.now(timezone.utc)
    kept = {}
    for name, entry in data.items():
        when = entry.get("at") if isinstance(entry, dict) else None
        try:
            then = datetime.fromisoformat(str(when).replace("Z", "+00:00"))
        except ValueError:
            continue
        if (at - then).total_seconds() < 86400:
            kept[name] = entry
    kept[ticket] = {"option": key, "by": by, "via": via, "at": now_text(at)}
    with contextlib.suppress(OSError):
        if not path.parent.is_symlink():
            policy.write_private(path, json.dumps(kept, indent=2, ensure_ascii=False) + "\n")


def last_decided(root: Path, ticket: str, moment: Optional[datetime]) -> Optional[Dict[str, Any]]:
    """The decision recorded on this ticket in the last hour, if any."""
    data = load_json(Path(root) / DECIDED_FILE, {}) or {}
    entry = data.get(ticket) if isinstance(data, dict) else None
    if not isinstance(entry, dict) or entry.get("option") not in DECIDED_WORDS:
        return None
    try:
        then = datetime.fromisoformat(str(entry.get("at")).replace("Z", "+00:00"))
    except ValueError:
        return None
    age = ((moment or datetime.now(timezone.utc)) - then).total_seconds()
    return entry if -60 <= age < DECIDED_WITHIN_SECONDS else None


def already_decided(ticket: str, key: str, name: str, earlier: Dict[str, Any], item: Optional[Dict[str, Any]], listing: Dict[str, Any],
                    moment: Optional[datetime], run_skill: str) -> Dict[str, Any]:
    """The answer to a person whose decision another person's, recorded first, made moot: what was decided, by whom and when,
    and what the ticket waits for now, with what is on offer. Nothing is recorded; it is not a refusal."""
    who = " ".join(str(earlier.get("by") or "").split()) or "a person"
    said = f"{DECIDED_WORDS[earlier['option']]} by {who} at {clock(earlier.get('at'), moment)}."
    if item is None:
        answer = next((entry.get("answer") for entry in listing.get("not_waiting") or [] if entry.get("ticket_id") == ticket), None)
        said += f" {sentence(answer) or f'{ticket} is not waiting for a person now.'}"
    else:
        waits = WAITING_FOR.get(item.get("state"))
        said += f" It is now waiting for {waits}." if waits else f" Now: {sentence((item.get('situation') or {}).get('summary'))}"
    options = [{"key": choice["key"], "label": choice["label"], "do": bool(choice.get("do"))} for choice in (item or {}).get("options") or []]
    return {"ticket_id": ticket, "option": key, "done": False, "by": name or None, "already_decided": True,
            "decided": {"option": earlier["option"], "at": earlier.get("at"), "via": earlier.get("via")},
            "state": (item or {}).get("state"), "on_offer": options, "warnings": list((item or {}).get("warnings") or []),
            "unparked": False, "supervisor": "none", "pid": None, "why_not": None,
            "now": said + (f" On offer now: {on_offer(item)}." if options else ""),
            "command": f"{run_skill} decide {ticket}"}


def supervisor_carry_on(make_context: Callable[[], Any], tickets: Sequence[str] = (), start: bool = True) -> Callable[[], Dict[str, Any]]:
    """The one seam to the Factory's lifecycle: activation.carry_on(ctx) wakes the supervisor, or starts one, for this
    project, and gives it the ticket the person just released. `make_context` builds the activation Context as `factory` does.
    With `start` false (a decision made outside a Claude Code session) a running supervisor is woken and none is started."""
    def go() -> Dict[str, Any]:
        import activation  # loaded only once a decision is recorded
        carry_on = getattr(activation, "carry_on", None)
        if carry_on is None:
            return {"supervisor": "none", "pid": None, "why_not": "This MACH does not start the Factory supervisor after a decision."}
        return carry_on(make_context(), tickets=tuple(tickets), start=start, started_by="decide")
    return go


def carry(carry_on: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
    try:
        found = carry_on() or {}
    except Exception as exc:  # noqa: BLE001 - the decision is recorded; starting the supervisor is said, never undone
        return {"supervisor": "none", "pid": None, "why_not": str(exc) or exc.__class__.__name__}
    state = found.get("supervisor") if found.get("supervisor") in ("started", "woken", "none") else "none"
    lifetime = found.get("lifetime") or (found.get("already_running") or {}).get("lifetime")
    going = {"supervisor": state, "pid": found.get("pid") if type(found.get("pid")) is int else None, "why_not": found.get("why_not"),
             "lifetime": lifetime if state != "none" else None}
    for field in ("given", "not_given", "already_running"):
        if field in found:
            going[field] = found[field]
    return going


def sentence(text: Any) -> str:
    text = " ".join(str(text or "").split())
    return text if not text or text.endswith((".", "!", "?")) else text + "."


def carried(ticket: str, run_skill: str, going: Dict[str, Any], what: str) -> str:
    """What happens to the ticket now, as it really is: the Factory's (and how long it runs), kept where it is driven, or nobody's yet."""
    kept = next((entry for entry in going.get("not_given") or [] if entry.get("ticket_id") == ticket), None)
    if kept:
        return f"It is not given to the Factory: {sentence(kept.get('why'))} Next: {what}."
    given = going.get("given")
    if going["supervisor"] in ("started", "woken") and (given is None or ticket in given):
        while_open = "while Claude Code is open" if going.get("lifetime") == "session" else "in the background"
        return f"The Factory carries it on {while_open}: {what}."
    why = sentence(going.get("why_not")) or "No Factory supervisor runs here."
    return f"{why} {run_skill} {ticket} in Claude Code carries it on: {what}."


def in_conversation(ticket: str, key: str, item: Dict[str, Any], run_skill: str) -> Dict[str, Any]:
    command = item.get("decide_command") or f"{run_skill} decide {ticket}"
    return {"ticket_id": ticket, "option": key, "done": False, "in_conversation": True, "command": command,
            "why": IN_CONVERSATION.get(key, "This needs a conversation.") + f" Nothing was changed; run {command} in Claude Code."}


# How long a decision waits for another one to finish. The lock is held for one station call, and a merge (with the project's
# tests) is the longest of those. From the terminal: nine minutes, inside the longest command Claude Code runs. From the
# Factory Floor: a few seconds, because the page asks again by itself and shows that it waits.
LOCK_WAIT_SECONDS = 540.0
LOCK_WAIT_FLOOR = 5.0
BUSY_NOW = "Recording after another decision finishes."


@contextlib.contextmanager
def deciding(root: Path, wait: float = LOCK_WAIT_SECONDS, on_wait: Optional[Callable[[], None]] = None):
    """One decision at a time on this project: an exclusive lock on .factory/local/decide.lock, held from reading what is on
    offer until the station has answered. Not the intake lock, which the stations take themselves. Yields True when held;
    False when another decision held it for longer than `wait`. `on_wait` is called once, when it has to wait."""
    try:
        import fcntl
    except ImportError:  # not POSIX: one decider is not enforced; the stations' own checks still hold
        yield True
        return
    path = Path(root) / ".factory" / "local" / "decide.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = os.open(str(path), os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        deadline = time.monotonic() + wait
        told = False
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if not told and on_wait is not None:
                    told = True
                    with contextlib.suppress(Exception):
                        on_wait()
                if time.monotonic() >= deadline:
                    yield False
                    return
                time.sleep(0.1)
        try:
            yield True
        finally:
            with contextlib.suppress(OSError):
                fcntl.flock(handle, fcntl.LOCK_UN)
    finally:
        os.close(handle)


def main(ticket: str, key: str, root: Path, *, report: Callable[[str], Dict[str, Any]], by: Optional[str], reason: Optional[str] = None,
         adrs: Optional[List[str]] = None, test_cmd: Optional[str] = None, answers_file: Optional[Path] = None, via: str = "terminal", guidance: Optional[str] = None,
         station: Callable[[str, Sequence[str]], Tuple[int, str, str]], line: Callable[[], Any], carry_on: Callable[[], Dict[str, Any]],
         take_over: Optional[Callable[..., Dict[str, Any]]] = None, to_factory: bool = False, run_skill: str = "/mach",
         now: Optional[datetime] = None, lock_wait: Optional[float] = None, on_wait: Optional[Callable[[], None]] = None) -> Dict[str, Any]:
    """Record one decision under the decision lock, then carry the ticket on (outside the lock: starting a supervisor may take a moment).
    While another decision holds the lock it waits; if that one is still going when the wait ends, the answer is `busy` and
    nothing is recorded yet: the caller (the Factory Floor, or the run skill) asks again with the same decision."""
    root = Path(root)
    wait = lock_wait if lock_wait is not None else (LOCK_WAIT_FLOOR if via == "floor" else LOCK_WAIT_SECONDS)
    with deciding(root, wait, on_wait=on_wait) as held:
        if not held:
            return {"ticket_id": ticket, "option": key, "done": False, "busy": True, "by": " ".join((by or "").split()) or None, "via": via,
                    "unparked": False, "supervisor": "none", "pid": None, "why_not": None, "now": BUSY_NOW,
                    "then": "Nothing is recorded yet. The same decide do records it once the other decision has finished."}
        result, after = record(ticket, key, root, report=report, by=by, reason=reason, adrs=adrs, test_cmd=test_cmd, answers_file=answers_file, guidance=guidance,
                               via=via, station=station, line=line, take_over=take_over, to_factory=to_factory, run_skill=run_skill, now=now)
    if after is None:
        return result
    done, what = after
    if result.pop("keep_here", False):
        # "Take it over" from the terminal, without the Factory: the ticket is the person's, carried on in Claude Code.
        result.update({"supervisor": "none", "pid": None, "why_not": None, "now": f"{done} {run_skill} {ticket} in Claude Code carries it on: {what}."})
        return result
    going = carry(carry_on)
    result.update(going)
    result["now"] = f"{done} {carried(ticket, run_skill, going, what)}"
    return result


def record(ticket: str, key: str, root: Path, *, report: Callable[[str], Dict[str, Any]], by: Optional[str], reason: Optional[str] = None,
         adrs: Optional[List[str]] = None, test_cmd: Optional[str] = None, answers_file: Optional[Path] = None, via: str = "terminal", guidance: Optional[str] = None,
         station: Callable[[str, Sequence[str]], Tuple[int, str, str]], line: Callable[[], Any],
         take_over: Optional[Callable[..., Dict[str, Any]]] = None, to_factory: bool = False,
         run_skill: str = "/mach", now: Optional[datetime] = None) -> Tuple[Dict[str, Any], Optional[Tuple[str, str]]]:
    """The decision itself: (the result, (what was done, what happens next)), or (the result, None) when nothing is left to carry on."""
    if via not in VIA:
        raise ActError(f"--via is terminal or floor, not '{via}'.")
    adrs = list(dict.fromkeys(adrs or []))
    for ident in adrs:
        if not ADR_RE.match(ident):
            raise ActError(f"'{ident}' is not an ADR ID such as ADR-0007. Nothing was recorded.")
    name = " ".join((by or "").split())
    listing = report(ticket)
    item = next((entry for entry in listing.get("tickets") or [] if entry.get("ticket_id") == ticket), None)
    if item is None or key not in {choice["key"] for choice in item["options"]}:
        # Another person's decision, recorded first, may have made this one moot: say what they decided, not "refused".
        earlier = last_decided(root, ticket, now)
        if earlier is not None:
            return already_decided(ticket, key, name, earlier, item, listing, now, run_skill), None
    item = find(listing, ticket, run_skill)
    offered = {choice["key"]: choice for choice in item["options"]}
    if key not in offered:
        raise ActError(f"\"{key}\" is not on offer for {ticket} now, so nothing was recorded. On offer: {on_offer(item)}. "
                       f"{run_skill} decide {ticket} shows each one.")
    choice = offered[key]
    if not choice.get("do"):
        return in_conversation(ticket, key, item, run_skill), None
    targets = option_adrs(item, key)
    check_inputs(choice, key, by, reason, adrs, test_cmd, answers_file, targets, guidance)
    result: Dict[str, Any] = {"ticket_id": ticket, "option": key, "done": True, "by": name or None, "via": via, "station": None,
                              "warnings": list(item.get("warnings") or [])}
    if key == "wait":
        result.update({"unparked": False, "supervisor": "none", "pid": None, "why_not": None,
                       "now": (f"Nothing changed: the other worker carries on with {ticket}." if item.get("state") == "worker-in-cell"
                               else f"Nothing changed: {ticket} waits as it is.")})
        return result, None
    if (key == "take-over" or choice.get("takes_over")) and take_over is None:
        raise ActError(f"This MACH cannot take a step over from here, so nothing was recorded. /mach {ticket} in Claude Code takes it over there.")

    cellroot = root / ".factory" / "worktrees" / ticket
    cell = load_json(cellroot / "cell.json", {}) or {}
    what = "the next step the line names"
    done = ""
    if key == "approve":
        result["station"] = run_station(station, key, [ticket, f"--by={name}", f"--via={via}"] + ([f"--note={reason}"] if reason else []))
        done, what = f"{name}'s approval of {ticket} is recorded.", "it merges or waits, as the project's merge settings say"
    elif key == "send-back":
        result["station"] = run_station(station, key, [ticket, f"--by={name}", f"--reason={reason}", f"--via={via}"])
        if (result["station"]["answer"] or {}).get("outcome") == "ESCALATE":
            result["ticket"] = update_ticket(station, ticket, ["--state=blocked", "--label=blocked-requires-sme"])
            done = (f"{ticket} is sent back with {name}'s reason. It was its last round, so it stops for a person: {run_skill} decide do {ticket} "
                    "carry-on gives the builder one more round, with that reason as the finding.")
        elif isinstance((result["station"]["answer"] or {}).get("carried_on"), dict):
            # The last round: a person's send-back never stops the ticket. Their reason is the guidance for one more round.
            more = result["station"]["answer"]["carried_on"]
            done, what = (f"{ticket} is sent back with {name}'s reason. It was its last round, so the builder gets one more, round {more.get('round')} "
                          f"of {more.get('max_rounds')}, with that reason as the finding.", "the builder revises it")
        else:
            done, what = f"{ticket} is sent back with {name}'s reason, which uses one of its rounds.", "the builder revises it"
    elif key == "merge":
        if take_over is not None and (cellroot / "displaced.json").is_file() and (cellroot / "claim.json").is_file():
            # A person's take-over of this ticket stands: a holderless merge would be taken for the worker taken over. The person
            # deciding takes the ticket first, in the same act, as `next --by-person` would.
            take_over(ticket, by=name, via=via, to_factory=False)
        result["station"] = run_station(station, key, [ticket, "--by-person"], allowed=(0, 3))
        answer = result["station"]["answer"] or {}
        if answer.get("status") == "ALREADY_ON_MAIN":
            # A second copy of a slice that landed first, with nothing of its own left: closed out as merged, never abandoned.
            done, what = (f"Everything in {ticket} is already on the main branch: another copy of its slice landed first, so MACH closes "
                          "this copy out as merged.", "cleanup removes its cell")
        elif answer.get("status") == "RENUMBERED":
            done, what = (f"{ticket} is not merged yet. {sentence(answer.get('reason'))}",
                          "it is verified and reviewed again on the renamed spec, then merged")
        elif answer.get("status") == "RECHECK":
            done, what = (f"{ticket} is not merged yet. Another copy of this slice landed first, so MACH brought main in and sent this copy to be "
                          "verified and reviewed again before it lands.", "it is verified and reviewed against main, then merged on top")
        elif answer.get("status") == "PR_OPEN":
            done, what = (f"The pull request for {ticket} is open and not merged yet: {answer.get('pull_request') or 'see the merge result'}.",
                          "the merge is checked again until it lands")
        elif result["station"]["exit_code"] == 3:
            done, what = (f"{ticket} is not merged yet: {sentence(answer.get('reason') or answer.get('next') or 'the merge station said why')}",
                          "the routing sheet says what comes next")
        else:
            done, what = f"{ticket} is merged.", "cleanup follows"
    elif key == "accept":
        chosen = adrs or targets
        result["station"] = run_station(station, key, [ticket, *[f"--adr={ident}" for ident in chosen], f"--by={name}", f"--via={via}"])
        done, what = f"{', '.join(chosen)} accepted by {name} on {ticket}'s branch.", "the build may start"
    elif key == "exception":
        result["station"] = run_station(station, key, [ticket, f"--adr={targets[0]}", f"--by={name}", f"--reason={reason}", f"--via={via}"])
        done, what = f"{name}'s exception to {targets[0]} is recorded for {ticket}.", "the contract engineer plans it with the exception"
    elif key == "replan":
        result["station"] = run_station(station, key, [ticket, f"--reason={reason}", f"--by={name}", f"--via={via}"])
        done, what = f"{ticket} goes back to be planned again, with {name}'s reason.", "the contract engineer writes a new plan"
    elif key == "carry-on":
        words = (guidance or "").strip()
        result["station"] = run_station(station, key, [ticket, f"--by={name}", f"--via={via}"] + ([f"--guidance={words}"] if words else []))
        answer = result["station"]["answer"] or {}
        result["ticket"] = update_ticket(station, ticket, ["--state=in_progress", "--remove-label=blocked-requires-sme"])
        done = (f"{name} carried {ticket} on: round {answer.get('round')} of {answer.get('max_rounds')}, on the same branch, with the last findings"
                + (" and their guidance." if words else "."))
        what = "the builder revises it, then verification and review run again"
    elif key == "set-test-command":
        result["station"] = run_station(station, key, [ticket, f"--test-cmd={test_cmd}", f"--reason={reason}", f"--by={name}", f"--via={via}"])
        done, what = f"The test command for {ticket} is set.", "the build carries on from where it is"
    elif key == "take-over":
        factory = to_factory or via == "floor"
        took = take_over(ticket, by=name, via=via, to_factory=factory)
        result["took_over"] = took
        step = took.get("step")
        done = (f"{name} took over {ticket}'s {step} step. {sentence(took.get('other'))}" if took.get("taken")
                else f"{sentence(took.get('other'))} {ticket} is free to carry on.")
        done += "".join(f" {sentence(extra)}" for extra in took.get("said") or [])
        what = "it goes on from where the other worker left it"
        result["keep_here"] = not factory
    elif key in NOTHING_RECORDED:
        done, what = f"{ticket} is released to run again.", "it runs from where it stopped"
    elif key == "answers":
        answers = read_answers(answers_file, item.get("questions") or [])
        path = write_answers(root, cellroot, ticket, answers, name, via, now, line)
        result["answers_file"] = str(path.relative_to(root))
        answered = sum(1 for entry in answers if not entry.get("leave_open"))
        done, what = (f"{name}'s answers to {answered} of {len(answers)} open question{'s' if len(answers) != 1 else ''} on {ticket} are recorded.",
                      "grooming folds them into the spec")
    elif key == "abandon":
        code, out, err = station("cleanup", ["plan", ticket, f"--abandon={reason}"])
        plan = first_json(out) or {}
        if code != 0 or not plan.get("allowed"):
            refusals = [str(text) for text in plan.get("refusals") or []] or [refusal_text(code, out, err)]
            raise ActError(f"The cleanup station will not abandon {ticket} now, and nothing was recorded: {' '.join(sentence(text) for text in refusals)}")
        code, out, err = station("cleanup", ["run", ticket, f"--abandon={reason}"])
        if code != 0:
            raise ActError(f"The cleanup station stopped, and says what it kept: {refusal_text(code, out, err)}")
        answer = first_json(out) or {}
        result["station"] = {"name": "cleanup", "command": "run", "exit_code": code, "answer": answer, "plan": plan.get("would")}
        product = cell.get("product") if isinstance(cell, dict) else None
        if isinstance(product, dict) and product.get("issue"):
            result["ticket"] = {"updated": False, "note": "A slice from Product Studio stays open on its issue, so its slice can be built again."}
        else:
            result["ticket"] = update_ticket(station, ticket, ["--state=closed", "--label=abandoned", f"--comment={reason}"])
        restore = answer.get("restore")
        done = (f"{ticket} is abandoned: its work is deleted from this machine." if not restore else
                f"{ticket} is abandoned and its cell is removed. Its archive is kept, as asked: {sentence(restore)}")

    if key != "take-over" and choice.get("takes_over"):
        # The Factory is handed the ticket at the stage another worker holds: the step is taken from it, as the person asked
        # for the ticket to run. The decision above is recorded either way.
        try:
            took = take_over(ticket, by=name, via=via, to_factory=True)
        except Exception as exc:  # noqa: BLE001 - the decision stands; the claim is said, with how to take it over
            result["note"] = f"{sentence(str(exc))} The other worker's claim may hold the Factory until it lapses."
        else:
            result["took_over"] = took
            if took.get("taken"):
                done += f" {name} took over its {took.get('step')} step. {sentence(took.get('other'))}"
                done += "".join(f" {sentence(extra)}" for extra in took.get("said") or [])
    remember(root, ticket, key, name, via, now)
    unparked, note = unpark(root, ticket, line, announce=key != "abandon", run_skill=run_skill)
    result["unparked"] = unparked
    if note:
        result["note"] = f"{result['note']} {note}" if result.get("note") else note
    escalated = key == "send-back" and (result["station"]["answer"] or {}).get("outcome") == "ESCALATE"
    if key == "abandon" or escalated:  # nothing is left for the Factory to run
        result.update({"supervisor": "none", "pid": None, "why_not": None, "now": done})
        return result, None
    return result, (done, what)


def human(result: Dict[str, Any]) -> str:
    if result.get("in_conversation"):
        return result["why"]
    if result.get("busy"):
        return f"{result['now']} {result['then']}"
    lines = [f"Warning: {warning}" for warning in result.get("warnings") or [] if result.get("done")] + [result["now"]]
    for extra in (result.get("note"), (result.get("ticket") or {}).get("note")):
        if extra:
            lines.append(extra)
    return "\n".join(lines)
