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
    retry, run, revise nothing is recorded              answers        answers.json in the cell (design 3.2)
    wait               nothing changes

An option that needs an agent or a conversation (`do: false` in the list) is answered with the command to run, and
nothing changes. After a decision that moves the ticket, its parked entry and attempt count are removed from the intake
ledger under the intake lock (design 2.5), and the Factory supervisor is woken or started (activation.carry_on, through
the `carry_on` callable run.py passes in).

Entry point, wired in by run.py:

    act.main(ticket, key, root, *, report, by, reason, adrs, test_cmd, answers_file, via, station, line, carry_on,
             run_skill="/mach", now=None) -> dict

    report     callable(ticket) -> decide.main's report for that one ticket, computed now
    station    callable(name, argv) -> (exit code, stdout, stderr): runs one station script (see station_runner)
    line       callable() -> the product intake (intake.Factory) for the ledger and its lock, or raises
    carry_on   callable() -> {"supervisor": "started"|"woken"|"none", "pid", "why_not"}

It raises ActError, with a sentence that says what to do next, when it records nothing. A person's reason, answers and
name are passed on exactly as given: never written, shortened or improved here.

Standard library only.
"""

import json
import os
import re
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
}
NOTHING_RECORDED = ("retry", "run", "revise")
# Why an option is left to a conversation, said to the person with the command to run.
IN_CONVERSATION = {
    "interview": "The interview continues in a conversation, one question at a time.",
    "exception": "A security exception is a person's acceptance of a real finding, read with an agent in a conversation first.",
    "accept": "A policy owner's acceptance is checked against the pack's owner in a conversation.",
    "take-over": "Taking over another worker's step hands it to a new worker, which a conversation starts.",
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
                 answers_file: Optional[Path], option_adrs: List[str]) -> None:
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
        if path.stat().st_size > ANSWERS_FILE_LIMIT:
            raise ActError(f"The answers file is larger than {ANSWERS_FILE_LIMIT // 1024} KB; keep each answer to the point. Nothing was recorded.")
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ActError(f"The answers file cannot be read ({exc.strerror or exc}). Give the path of a JSON file with --answers-file. Nothing was recorded.")
    except ValueError:
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


def write_answers(cellroot: Path, ticket: str, answers: List[Dict[str, Any]], by: str, via: str, moment: Optional[datetime]) -> Path:
    cell = load_json(cellroot / "cell.json", {}) or {}
    path = cellroot / "answers.json"
    record = {"ticket_id": ticket, "by": by, "via": via, "at": now_text(moment), "spec_sha256": cell.get("spec_sha256"), "answers": answers,
              "note": "A person's answers to the spec's open questions. Data for the next grooming: each is that person's answer to its question."}
    temporary = path.with_name(f".answers.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)
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
            "then": f"Update the ticket by hand: ticket.py update {ticket} " + " ".join(argv[:2]) + "."}


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


def supervisor_carry_on(make_context: Callable[[], Any]) -> Callable[[], Dict[str, Any]]:
    """The one seam to the Factory's lifecycle: activation.carry_on(ctx) wakes the supervisor, or starts one, for this
    project. `make_context` builds the activation Context as `factory` does. Where this MACH has no carry_on, nothing starts."""
    def go() -> Dict[str, Any]:
        import activation  # loaded only once a decision is recorded
        carry_on = getattr(activation, "carry_on", None)
        if carry_on is None:
            return {"supervisor": "none", "pid": None, "why_not": "This MACH does not start the Factory supervisor after a decision."}
        return carry_on(make_context())
    return go


def carry(carry_on: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
    try:
        found = carry_on() or {}
    except Exception as exc:  # noqa: BLE001 - the decision is recorded; starting the supervisor is said, never undone
        return {"supervisor": "none", "pid": None, "why_not": str(exc) or exc.__class__.__name__}
    state = found.get("supervisor") if found.get("supervisor") in ("started", "woken", "none") else "none"
    return {"supervisor": state, "pid": found.get("pid") if type(found.get("pid")) is int else None, "why_not": found.get("why_not")}


def sentence(text: Any) -> str:
    text = " ".join(str(text or "").split())
    return text if not text or text.endswith((".", "!", "?")) else text + "."


def carried(ticket: str, run_skill: str, going: Dict[str, Any], what: str) -> str:
    if going["supervisor"] in ("started", "woken"):
        return f"The Factory carries it on in the background: {what}."
    why = sentence(going.get("why_not")) or "No Factory supervisor runs here."
    return f"{why} {run_skill} {ticket} carries it on in a conversation: {what}."


def in_conversation(ticket: str, key: str, item: Dict[str, Any], run_skill: str) -> Dict[str, Any]:
    command = item.get("decide_command") or f"{run_skill} decide {ticket}"
    return {"ticket_id": ticket, "option": key, "done": False, "in_conversation": True, "command": command,
            "why": IN_CONVERSATION.get(key, "This needs a conversation.") + f" Nothing was changed; run {command} in Claude Code."}


def main(ticket: str, key: str, root: Path, *, report: Callable[[str], Dict[str, Any]], by: Optional[str], reason: Optional[str] = None,
         adrs: Optional[List[str]] = None, test_cmd: Optional[str] = None, answers_file: Optional[Path] = None, via: str = "terminal",
         station: Callable[[str, Sequence[str]], Tuple[int, str, str]], line: Callable[[], Any], carry_on: Callable[[], Dict[str, Any]],
         run_skill: str = "/mach", now: Optional[datetime] = None) -> Dict[str, Any]:
    root = Path(root)
    if via not in VIA:
        raise ActError(f"--via is terminal or floor, not '{via}'.")
    adrs = list(dict.fromkeys(adrs or []))
    for ident in adrs:
        if not ADR_RE.match(ident):
            raise ActError(f"'{ident}' is not an ADR ID such as ADR-0007. Nothing was recorded.")
    item = find(report(ticket), ticket, run_skill)
    offered = {choice["key"]: choice for choice in item["options"]}
    if key not in offered:
        raise ActError(f"\"{key}\" is not on offer for {ticket} now, so nothing was recorded. On offer: {on_offer(item)}. "
                       f"{run_skill} decide {ticket} shows each one.")
    choice = offered[key]
    if not choice.get("do"):
        return in_conversation(ticket, key, item, run_skill)
    targets = option_adrs(item, key)
    check_inputs(choice, key, by, reason, adrs, test_cmd, answers_file, targets)
    name = " ".join((by or "").split())
    result: Dict[str, Any] = {"ticket_id": ticket, "option": key, "done": True, "by": name or None, "via": via, "station": None}
    if key == "wait":
        result.update({"unparked": False, "supervisor": "none", "pid": None, "why_not": None,
                       "now": f"Nothing changed: {ticket} waits as it is."})
        return result

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
            done = (f"{ticket} is sent back with {name}'s reason. It was the last round, so it is escalated, not built again: "
                    f"{run_skill} decide {ticket} shows what a person can do with it now.")
        else:
            done, what = f"{ticket} is sent back with {name}'s reason, which uses one of its rounds.", "the builder revises it"
    elif key == "merge":
        result["station"] = run_station(station, key, [ticket, "--by-person"], allowed=(0, 3))
        answer = result["station"]["answer"] or {}
        if result["station"]["exit_code"] == 3:
            done, what = (f"The pull request for {ticket} is open and not merged yet: {answer.get('pull_request') or 'see the merge result'}.",
                          "the merge is checked again until it lands")
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
        result["station"] = run_station(station, key, [ticket, f"--reason={reason}"])
        done, what = f"{ticket} goes back to be planned again, with {name}'s reason.", "the contract engineer writes a new plan"
    elif key == "set-test-command":
        result["station"] = run_station(station, key, [ticket, f"--test-cmd={test_cmd}", f"--reason={reason}", f"--by={name}", f"--via={via}"])
        done, what = f"The test command for {ticket} is set.", "the build carries on from where it is"
    elif key in NOTHING_RECORDED:
        done, what = f"{ticket} is released to run again.", "it runs from where it stopped"
    elif key == "answers":
        answers = read_answers(answers_file, item.get("questions") or [])
        path = write_answers(cellroot, ticket, answers, name, via, now)
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
        done = f"{ticket} is abandoned and its cell is removed." + (f" To get its work back: {sentence(restore)}" if restore else "")

    unparked, note = unpark(root, ticket, line, announce=key != "abandon", run_skill=run_skill)
    result["unparked"] = unparked
    if note:
        result["note"] = note
    escalated = key == "send-back" and (result["station"]["answer"] or {}).get("outcome") == "ESCALATE"
    if key == "abandon" or escalated:  # nothing is left for the Factory to run
        result.update({"supervisor": "none", "pid": None, "why_not": None, "now": done})
        return result
    going = carry(carry_on)
    result.update(going)
    result["now"] = f"{done} {carried(ticket, run_skill, going, what)}"
    return result


def human(result: Dict[str, Any]) -> str:
    if result.get("in_conversation"):
        return result["why"]
    lines = [result["now"]]
    for extra in (result.get("note"), (result.get("ticket") or {}).get("note")):
        if extra:
            lines.append(extra)
    return "\n".join(lines)
