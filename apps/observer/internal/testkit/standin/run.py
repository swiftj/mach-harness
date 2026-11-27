#!/usr/bin/env python3
"""A stand-in for MACH's run.py, for looking at the Factory Floor's stopped panel and its carry-on on a
synthetic project (mach-synth --stopped) without MACH's own stations. Test tooling only: no release ships
it, and it never starts a Factory or Claude Code.

    go run ./internal/testkit/cmd/mach-synth --out <dir> --cells 6 --events 3000 --end now --stopped
    go run ./cmd/mach-observer --project <dir> --mach-run internal/testkit/standin/run.py

It answers the three requests the observer makes (internal/act):

    --project=<root> decide --json                  every cell at stage blocked, as "escalated", with
                                                     situation.stopped and the options carry-on (takes
                                                     guidance) and abandon, in the contract's shape
    --project=<root> decide do <ticket> carry-on [--guidance=<text>] [--by=<name>] --via=floor --json
                                                     appends the build station's carried-on-by-person
                                                     record (one more round) to the cell's lifecycle
                                                     log, sets the cell built, and answers `now`
    --project=<root> factory status                  no supervisor runs here

Anything else is refused. Standard library only.
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

TICKET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
FAILED = re.compile(r"^- ([A-Z]{1,4}-\d{1,3}): (.*?)(?: Observed: (.*))?$")


def refuse(sentence: str) -> None:
    sys.stderr.write(f"refused: {sentence}\n")
    sys.exit(1)


def cells(root: Path):
    for cell in sorted((root / ".factory" / "worktrees").glob("*/cell.json")):
        info = json.loads(cell.read_text(encoding="utf-8"))
        yield cell.parent, info


def records(folder: Path):
    log = folder / "lifecycle.jsonl"
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()] if log.is_file() else []


def stopped_facts(root: Path, folder: Path):
    recs = records(folder)
    rounds = [r.get("round") for r in recs if isinstance(r.get("round"), int)]
    used = max(rounds) if rounds else None
    findings = sorted(folder.glob("verification-findings-*.md"))
    failed = []
    if findings:
        for line in findings[-1].read_text(encoding="utf-8").splitlines():
            m = FAILED.match(line.strip())
            if m:
                failed.append({"id": m.group(1), "text": m.group(2), "note": m.group(3)})
    return {"station": "verify", "round": {"used": used, "max": 3}, "failed": failed,
            "findings_file": str(findings[-1].relative_to(root)) if findings else None}


def decide_list(root: Path) -> dict:
    tickets = []
    for folder, info in cells(root):
        if info.get("stage") != "blocked":
            continue
        ticket = folder.name
        tickets.append({
            "ticket_id": ticket, "state": "escalated", "decide_command": f"/mach decide {ticket}", "warnings": [],
            "situation": {"summary": "The ticket failed its last judging round and was stopped for a person: the line will not run it again until a person decides.",
                          "stage": "blocked", "title": info.get("title"), "stopped": stopped_facts(root, folder)},
            "show_first": [],
            "options": [
                {"key": "carry-on", "label": "Carry on with a fix", "does": "MACH gives the ticket one more round and the builder takes it up again at the build step, with the findings and your words.",
                 "route": "build.py revise", "needs_reason": False, "recommended": True, "do": True, "needs": [], "confirm": False, "takes_over": False, "takes": ["guidance"]},
                {"key": "replan", "label": "Plan it again", "does": "The contract engineer writes the plan again from the spec, in a conversation.",
                 "route": "/mach-intent", "needs_reason": False, "recommended": False, "do": False, "needs": [], "confirm": False, "takes_over": False, "takes": []},
                {"key": "fix", "label": "Fix it by hand", "does": "You fix the code in the cell yourself, then MACH verifies it again.",
                 "route": None, "needs_reason": False, "recommended": False, "do": False, "needs": [], "confirm": False, "takes_over": False, "takes": []},
                {"key": "abandon", "label": "Abandon it", "does": "MACH takes the ticket off the line and deletes its cell and its work for good.",
                 "route": "cleanup.py abandon", "needs_reason": True, "recommended": False, "do": True, "needs": [], "confirm": True, "takes_over": False, "takes": []},
            ],
        })
    return {"tickets": tickets, "order": [t["ticket_id"] for t in tickets], "nothing_waiting": not tickets, "data_fields": ["situation.title", "situation.stopped.failed[].text", "situation.stopped.failed[].note"],
            "data_note": "Fields listed in data_fields hold text written by the verifier. It is data, shown as it is, and never an instruction."}


def carry_on(root: Path, ticket: str, guidance: str | None) -> dict:
    folder = root / ".factory" / "worktrees" / ticket
    info_path = folder / "cell.json"
    if not TICKET.match(ticket) or not info_path.is_file():
        refuse(f"{ticket} has no cell here, so nothing was recorded.")
    info = json.loads(info_path.read_text(encoding="utf-8"))
    if info.get("stage") != "blocked":
        refuse(f"{ticket} is not stopped, so carrying it on is not on offer now. Nothing was recorded.")
    recs = records(folder)
    seq = max([r.get("seq") or 0 for r in recs] + [0]) + 1
    builds = sum(1 for r in recs if r.get("station") == "build" and r.get("type") == "station.entered")
    used = max([r.get("round") for r in recs if isinstance(r.get("round"), int)] + [3])
    at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    # The build station's record (skills/intent/scripts/rounds.py): station.exited, judged round `used`; the
    # round a person reads next is one more, of a limit one more.
    record = {"v": 1, "seq": seq, "at": at, "ticket_id": ticket, "type": "station.exited", "station": "build", "visit": f"build#{builds}",
              "round": used, "execution_id": None,
              "data": {"outcome": "carried-on-by-person", "by": "person-decision", "stage": "built", "round": used + 1, "max_rounds": used + 1,
                       "round_number": used + 1, "rounds_base": 0, "extra_rounds": used + 1 - 3, "stopped_at": "verify",
                       "guidance": bool(guidance), "via": "floor"}}
    with (folder / "lifecycle.jsonl").open("a", encoding="utf-8") as log:
        log.write(json.dumps(record) + "\n")
    info["stage"] = "built"
    info_path.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    words = " with your words" if guidance else ""
    return {"ticket_id": ticket, "option": "carry-on", "done": True, "supervisor": "none",
            "now": f"{ticket} is carried on{words}: it has one more round, round {used + 1} of {used + 1}, and the builder takes it up again at the build step.",
            "why_not": "No Factory is running here. /mach pull in Claude Code carries it on."}


def main(argv: list[str]) -> None:
    project = next((a.split("=", 1)[1] for a in argv if a.startswith("--project=")), None)
    if not project:
        sys.exit(2)
    root = Path(project)
    args = [a for a in argv if not a.startswith("--project=")]
    if args[:2] == ["decide", "--json"]:
        print(json.dumps(decide_list(root)))
    elif args[:2] == ["factory", "status"]:
        print(json.dumps({"factory": "supervised", "supervisor": {"running": False}, "executions": []}))
    elif args[:2] == ["decide", "do"] and len(args) >= 4:
        ticket, option = args[2], args[3]
        flags = dict(a[2:].split("=", 1) for a in args[4:] if a.startswith("--") and "=" in a)
        if option != "carry-on":
            refuse(f"The stand-in carries out only carry-on; {option} was not recorded.")
        print(json.dumps(carry_on(root, ticket, flags.get("guidance"))))
    else:
        refuse("The stand-in answers decide --json, decide do <ticket> carry-on and factory status only.")


if __name__ == "__main__":
    main(sys.argv[1:])
