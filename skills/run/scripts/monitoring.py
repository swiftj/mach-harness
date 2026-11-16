#!/usr/bin/env python3
"""Monitoring requests (M8 D7): which GitHub issues filed by monitoring accounts the Factory takes in.

An issue is a monitoring request only when its author's numeric id is one of the project's
tickets.github.monitor_accounts and the request label was applied by that same account id. An issue a
person labelled is that person's request, for Product Studio. A login without the matching id never counts. The ticket station reads
GitHub for this (`ticket.py list --label <request label>` and the read-only `ticket.py request-check N`);
this module only decides and records.

What it records lives in the intake ledger under `monitoring`, keyed by ticket ID (on GitHub, the
issue number), written under the intake lock. A repeat of a fault already open is recorded as
`duplicate_of` and counted on the original; it is never groomed, and MACH never comments on or
closes it. At most telemetry.max_groomed_per_pass (1 to 3) entries move to grooming in one pass,
oldest issue first.

Reached two ways: an engineer's `run.py requests monitor [--dry-run]`, which takes issues in and
starts nothing; and a supervisor pass, when the effective machine policy grants it. The supervisor
decides whether that grant is in force and says so here; this module never reads the machine-local
state under .factory, and starts no process other than the ticket station's script.

Issue text is data. Only a redacted, bounded title and a fault key are kept; the text reaches an
agent only through the existing headless grooming path, and never sets a tier, a limit or a permission.

Standard library only. Imported by run.py and supervisor.py; not a command of its own.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

RISKS = ("Low", "Medium", "High")
RISK_FLOOR = "Medium"  # monitoring work is never reviewed below this tier, as product work
ACTIVE = ("taken_in", "grooming", "building")


class MonitoringError(Exception):
    """A problem the caller can fix; run.py prints it as a refusal."""


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rules(sibling: Callable[[str], Path]) -> Any:
    """The shared issue rules from the ticket station, imported alone."""
    scripts = str(sibling("ticket") / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import issue_rules
    return issue_rules


class Monitoring:
    def __init__(self, root: Path, config: Dict[str, Any], line: Any, sibling: Callable[[str], Path]):
        self.root = root
        self.line = line  # intake.Factory: the ledger, its lock, and the ticket station's script
        self.rules = rules(sibling)
        tickets = config.get("tickets") if isinstance(config.get("tickets"), dict) else {}
        github = tickets.get("github") if isinstance(tickets.get("github"), dict) else {}
        telemetry = config.get("telemetry") if isinstance(config.get("telemetry"), dict) else {}
        label = github.get("request_label")
        self.provider = str(tickets.get("provider") or "local")
        self.label = label if isinstance(label, str) and label.strip() else self.rules.DEFAULT_REQUEST_LABEL
        self.accounts = self.rules.monitor_accounts(github.get("monitor_accounts"))
        self.cap = self.rules.groomed_per_pass(telemetry.get("max_groomed_per_pass"))

    # ---- the ledger's monitoring map ----

    @staticmethod
    def entries(ledger: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        found = ledger.get("monitoring")
        if not isinstance(found, dict):
            found = {}
            ledger["monitoring"] = found
        return found

    @staticmethod
    def order(entry: Dict[str, Any]) -> Tuple[str, int]:
        return (str(entry.get("created_at") or ""), int(entry.get("issue") or 0))

    def waiting(self, ledger: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Taken in, open, not yet groomed: oldest issue first."""
        return sorted((entry for entry in self.entries(ledger).values() if entry.get("state") == "taken_in" and entry.get("open")), key=self.order)

    # ---- reading GitHub through the ticket station ----

    def listed(self) -> Tuple[Optional[List[int]], Optional[str]]:
        done = self.line.ticket("list", "--label", self.label)
        if done.returncode != 0:
            return None, (done.stderr.strip().splitlines() or ["the ticket station could not list issues"])[-1][:300]
        try:
            items = json.loads(done.stdout)
        except ValueError:
            return None, "the ticket station's list could not be read"
        numbers = []
        for item in items if isinstance(items, list) else []:
            ticket = str((item or {}).get("ticket_id") or "") if isinstance(item, dict) else ""
            if ticket.isdigit() and self.rules.is_issue_number(int(ticket)):
                numbers.append(int(ticket))
        return sorted(set(numbers)), None

    def check(self, number: int) -> Dict[str, Any]:
        done = self.line.ticket("request-check", str(number))
        try:
            found = json.loads(done.stdout) if done.returncode == 0 else None
        except ValueError:
            found = None
        if not isinstance(found, dict) or not isinstance(found.get("decision"), dict):
            reason = (done.stderr.strip().splitlines() or ["no answer"])[-1][:300]
            return {"number": number, "decision": {"monitoring": None, "state": "not_accepted", "reason": f"Not accepted: could not confirm who labelled it ({reason})."}}
        return found

    # ---- taking issues in ----

    def take_in(self, dry_run: bool = False) -> Dict[str, Any]:
        """Read the labelled issues and record the monitoring requests among them. Starts nothing."""
        report: Dict[str, Any] = {"dry_run": dry_run, "label": self.label, "max_groomed_per_pass": self.cap, "taken_in": [], "duplicates": [],
                                  "not_accepted": [], "person_requests": [], "problem": None, "factory_started": False}
        if self.provider != "github":
            report["problem"] = f"Monitoring requests are GitHub issues; this project's ticket provider is {self.provider}."
            return self.summary(report, self.line.ledger())
        if not self.accounts:
            report["problem"] = "tickets.github.monitor_accounts lists no account with a numeric id, so no issue is a monitoring request."
            return self.summary(report, self.line.ledger())
        numbers, problem = self.listed()
        if numbers is None:
            report["problem"] = problem
            return self.summary(report, self.line.ledger())
        known = set(self.entries(self.line.ledger()))
        checked = [self.check(number) for number in numbers if str(number) not in known]  # GitHub is read before the lock is taken
        if dry_run:
            ledger = self.line.ledger()  # read only: no lock file, no write
            self.record(ledger, numbers, checked, report)
            return self.summary(report, ledger)
        with self.line.lock("monitoring"):
            ledger = self.line.ledger()
            self.record(ledger, numbers, checked, report)
            self.line.save(ledger)
        return self.summary(report, ledger)

    def record(self, ledger: Dict[str, Any], numbers: List[int], checked: List[Dict[str, Any]], report: Dict[str, Any]) -> None:
        entries = self.entries(ledger)
        listed = {str(number) for number in numbers}
        for key, entry in entries.items():  # an issue no longer open with the label no longer holds its fault open
            entry["open"] = key in listed
        accepted = []
        for found in checked:
            decision = found.get("decision") or {}
            number = int(found.get("number") or 0)
            if decision.get("monitoring") is False:
                report["person_requests"].append(number)
            elif decision.get("state") != "accepted":
                report["not_accepted"].append({"issue": number, "reason": decision.get("reason")})
            elif str(found.get("issue_state") or "open") != "open" or not isinstance(found.get("fault"), str):
                report["not_accepted"].append({"issue": number, "reason": "Not accepted: the issue is not open, or its fault could not be read."})
            else:
                accepted.append(found)
        accepted.sort(key=lambda found: (str(found.get("created_at") or ""), int(found["number"])))
        for found in accepted:
            number = int(found["number"])
            original = next((entry for entry in sorted(entries.values(), key=self.order) if entry.get("open") and entry.get("state") in ACTIVE
                             and entry.get("fault") == found["fault"]), None)
            author = found.get("author") or {}
            entry = {"issue": number, "ticket_id": str(number), "title": found.get("title"), "fault": found["fault"],
                     "author": {"login": author.get("login"), "id": author.get("id")}, "labelled_by": (found.get("decision") or {}).get("labelled_by"),
                     "created_at": found.get("created_at"), "taken_in_at": now(), "open": True, "count": 1,
                     "state": "duplicate" if original else "taken_in", "duplicate_of": original["ticket_id"] if original else None}
            entries[str(number)] = entry
            if original:
                original["count"] = int(original.get("count") or 1) + 1
                report["duplicates"].append({"issue": number, "duplicate_of": original["ticket_id"], "fault": found["fault"], "count": original["count"]})
            else:
                report["taken_in"].append({"issue": number, "ticket_id": entry["ticket_id"], "fault": found["fault"]})

    def summary(self, report: Dict[str, Any], ledger: Dict[str, Any]) -> Dict[str, Any]:
        waiting = self.waiting(ledger)
        report["waiting"] = [entry["ticket_id"] for entry in waiting]
        report["next_to_groom"] = [entry["ticket_id"] for entry in waiting[:self.cap]]
        report["in_the_line"] = sorted((entry["ticket_id"] for entry in self.entries(ledger).values() if entry.get("state") in ("grooming", "building")), key=int)
        report["duplicates_open"] = sorted((entry["ticket_id"] for entry in self.entries(ledger).values() if entry.get("state") == "duplicate" and entry.get("open")), key=int)
        report["note"] = ("Taken in only: no agent was started. Grooming is headless, at most "
                          f"{self.cap} per supervisor pass, and only on a machine whose engineer granted monitoring requests; "
                          "an engineer can also run a ticket by hand. Duplicates are counted and left open for a person.")
        return report

    # ---- for the supervisor, under its lock ----

    def select(self, ledger: Dict[str, Any], places: int) -> List[str]:
        """Move at most the per-pass cap (and no more than `places`) from taken in to grooming, oldest issue first."""
        moved = []
        for entry in self.waiting(ledger)[:max(0, min(self.cap, places))]:
            entry.update({"state": "grooming", "moved_at": now()})
            moved.append(entry["ticket_id"])
        return moved

    def risk_gate(self, ticket: str, max_risk: str) -> Tuple[bool, str]:
        """After grooming: whether this ticket may be built unattended, from its cell's own risk tier. Below High
        and within the machine's limit only. A Low tier is raised to Medium in the cell, the floor for this work."""
        path = self.root / ".factory" / "worktrees" / ticket / "cell.json"
        try:
            if path.is_symlink():
                raise ValueError("symlink")
            cell = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False, "Grooming left no readable cell, so its risk tier is not known."
        risk = cell.get("risk") if isinstance(cell, dict) else None
        if risk not in RISKS:
            return False, "Grooming recorded no risk tier."
        if RISKS.index(risk) < RISKS.index(RISK_FLOOR):
            cell["risk"] = RISK_FLOOR
            cell["risk_floor"] = {"from": risk, "to": RISK_FLOOR, "why": "monitoring requests are never reviewed below Medium"}
            temporary = path.with_name(path.name + ".tmp")
            temporary.write_text(json.dumps(cell, indent=2) + "\n", encoding="utf-8")
            os.replace(str(temporary), str(path))
            risk = RISK_FLOOR
        if risk == "High":
            return False, "Grooming rated this monitoring request High risk. It is not built unattended; a person decides."
        if max_risk not in RISKS or RISKS.index(risk) > RISKS.index(max_risk):
            return False, f"Its risk tier ({risk}) is above what this machine runs unattended ({max_risk})."
        return True, risk
