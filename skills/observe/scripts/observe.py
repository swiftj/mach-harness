#!/usr/bin/env python3
"""MACH observe station: measure finished tickets so recurring problems can be named with evidence.

    observe.py collect [--history-depth N] [--min-tickets M] [--min-share S] [--min-tickets-per-pattern K]
    observe.py report  --file <markdown>
    observe.py status

'collect' reads .factory/archive/runs.jsonl (one line per finished ticket, appended by the cleanup
station), the open cells and the last audit report, computes a scorecard and the recurring
patterns over the most recent N finished tickets, and writes .factory/observations/metrics.json.

'report' checks the observer's written report against those metrics and files it as
.factory/observations/observation-<YYYYMMDD>.md. It refuses a report whose metrics are missing or
out of date, that lacks a required heading, or whose proposed changes lack a target, evidence or
change text, cite tickets outside the analyzed sample, target a file that is not a rule file, or
number more than five. With too few tickets it refuses any proposal at all.

'status' prints the latest metrics summary and the reports filed so far.

'bands' (M15) watches each scorecard measure with a control band: a rolling baseline over the finished
tickets before the most recent ones (mean and standard deviation), and four Western Electric rules
applied to the most recent tickets, so a slow drift is caught as well as a spike. Its tiers come from
observe.bands in .factory/config.json: tier 1 records, tier 2 says so in one fixed line, tier 3 also
makes an observe pass due. 'bands dismiss <measure> --reason R' records a person's dismissal of the
current breach. Bands never start an agent, file a ticket, or change a rule or a threshold.

This script measures and files. It never edits REVIEW.md, CLAUDE.md, AGENTS.md or any skill:
a proposed change becomes a ticket and goes through the factory like any other work.

Standard library only. It reads files and writes only under .factory/observations/.
"""

import argparse
import hashlib
import json
import os
import re
import statistics
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

RUNS = ".factory/archive/runs.jsonl"
OBSERVATIONS = ".factory/observations"
METRICS = OBSERVATIONS + "/metrics.json"
AUDIT_REPORT = ".factory/audit-report.json"
HISTORY_DEPTH = 20
MIN_TICKETS = 5
# A group of findings is a pattern only if it meets both of these.
MIN_TICKETS_PER_PATTERN = 2
MIN_SHARE = 0.15
MAX_EXAMPLES = 3
MAX_PROPOSALS = 5
MAX_NOTE_SAMPLES = 60
TUNING_LABEL = "factory-tuning"
SKILL_DIR = Path(__file__).resolve().parent.parent
TARGETS = {"rounds": 1.3, "first_pass": 0.85, "escalation": 0.05, "tests_failing_first": 0.9}
REQUIRED_HEADINGS = ("Analyzed data", "Patterns", "Proposed changes", "Not proposed")
REQUIRED_FIELDS = ("Target", "Evidence", "Change")
RULE_FILES = ("REVIEW.md", "CLAUDE.md", "AGENTS.md")
REFERENCE_RE = re.compile(r"(^|/)skills/[^/]+/references/[^/]")
FIELD_RE = re.compile(r"^- \*\*([A-Za-z][A-Za-z ]*):\*\*\s*(.*)$")
FINDING_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_.-]*)\s*(?:\(([^)]*)\))?\s*:")
FINDING_KINDS = ("scenario", "matrix rule", "holdout")
EARLIEST = datetime.min.replace(tzinfo=timezone.utc)


class ObserveError(Exception):
    """A refusal or a problem the caller can fix; printed without a traceback."""

    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d")


def find_project(start: Path) -> Path:
    start = start.resolve()
    parts = start.parts
    for index in range(len(parts) - 2, 0, -1):
        if parts[index] == "worktrees" and parts[index - 1] == ".factory":
            return Path(*parts[:index - 1])
    for marker in (".factory", ".git"):
        for folder in [start, *start.parents]:
            if (folder / marker).exists():
                return folder
    return start


def load_json(path: Path) -> Optional[Dict[str, Any]]:
    """The JSON object in a file, or None if the file is missing, unreadable or not an object."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def parse_time(value: Any) -> datetime:
    """A timestamp for sorting. Anything unreadable sorts as the oldest."""
    if not isinstance(value, str) or not value.strip():
        return EARLIEST
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return EARLIEST
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def number(value: Any) -> Optional[float]:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def items(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


def text_of(value: Any) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def short(value: str, limit: int = 160) -> str:
    return value if len(value) <= limit else value[:limit - 3].rstrip() + "..."


# ---------------------------------------------------------------- reading the data

def read_runs(project: Path) -> Tuple[List[Tuple[str, Dict[str, Any]]], int]:
    """Every finished ticket on record as (raw line, record), in file order, and the number of lines skipped."""
    try:
        lines = (project / RUNS).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return [], 0
    runs, skipped = [], 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            record = None
        if not isinstance(record, dict) or not isinstance(record.get("ticket_id"), str) or not record["ticket_id"].strip():
            skipped += 1
            continue
        record["ticket_id"] = record["ticket_id"].strip()
        runs.append((line, record))
    return runs, skipped


def select(runs: List[Tuple[str, Dict[str, Any]]], depth: int) -> List[Tuple[str, Dict[str, Any]]]:
    """The most recent `depth` runs by closed_at, oldest first. Ties keep file order."""
    ordered = sorted(enumerate(runs), key=lambda pair: (parse_time(pair[1][1].get("closed_at")), pair[0]))
    return [run for _, run in ordered[-depth:]] if depth > 0 else []


def digest(selected: List[Tuple[str, Dict[str, Any]]]) -> str:
    """Identifies exactly the lines that were analyzed, so a report cannot be filed against other data."""
    return hashlib.sha256("\n".join(line for line, _ in selected).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- measuring

def rate(part: float, whole: float) -> Optional[float]:
    return part / whole if whole else None


def measure(value: Optional[float], basis: str, target: Optional[str] = None, limit: Optional[float] = None) -> Dict[str, Any]:
    met = None
    if value is not None and target == "<":
        met = value < limit
    elif value is not None and target == ">":
        met = value > limit
    return {"value": None if value is None else round(value, 3), "target": f"{target} {limit}" if target else None, "met": met, "basis": basis}


def scorecard(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    merged = [r for r in records if r.get("outcome") == "merged"]
    rounds = [number(r.get("rounds")) for r in merged]
    rounds = [value for value in rounds if value is not None]
    first = sum(1 for r in merged if r.get("first_pass") is True)
    escalated = sum(1 for r in records if r.get("escalated") is True)
    abandoned = sum(1 for r in records if r.get("outcome") == "abandoned")
    failing = sum(number(r.get("tests_seen_failing_first")) or 0 for r in records)
    passing = sum(number(r.get("tests_passing_on_first_run")) or 0 for r in records)
    deviations = sum(len(items(r.get("deviations"))) for r in records)
    total = len(records)
    return {
        "average_rounds": measure(rate(sum(rounds), len(rounds)), f"{sum(rounds):g} judging rounds over {len(rounds)} merged tickets", "<", TARGETS["rounds"]),
        "first_pass_rate": measure(rate(first, len(merged)), f"{first} of {len(merged)} merged tickets passed on the first round", ">", TARGETS["first_pass"]),
        "escalation_rate": measure(rate(escalated, total), f"{escalated} of {total} tickets were escalated to a person", "<", TARGETS["escalation"]),
        "abandonment_rate": measure(rate(abandoned, total), f"{abandoned} of {total} tickets were abandoned"),
        "tests_failing_first_share": measure(rate(failing, failing + passing), f"{failing:g} of {failing + passing:g} recorded test tasks were seen failing before the code was written", ">", TARGETS["tests_failing_first"]),
        "deviations_per_ticket": measure(rate(deviations, total), f"{deviations} deviations over {total} tickets"),
    }


def finding_kind(finding: str) -> str:
    """What a verify finding is about, from the way verify.py words it: 'AC-06 (scenario): ...', 'R5 (matrix rule): ...'."""
    match = FINDING_RE.match(finding)
    if match:
        target, kind = match.group(1), text_of(match.group(2)).lower()
        if kind in FINDING_KINDS:
            return kind
        if re.match(r"^AC-?\d+", target, re.IGNORECASE):
            return "scenario"
        if re.match(r"^R\d+$", target, re.IGNORECASE):
            return "matrix rule"
        if re.match(r"^H-", target, re.IGNORECASE):
            return "holdout"
    lowered = finding.lower()
    if "test suite" in lowered:
        return "test suite"
    if "contract" in lowered:
        return "contract"
    return "other"


class Groups:
    """Occurrences of one kind of problem, grouped by key, remembering which tickets they came from."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        self.groups: Dict[str, Dict[str, Any]] = {}

    def add(self, key: str, ticket: str, example: str) -> None:
        group = self.groups.setdefault(key, {"kind": self.kind, "key": key, "tickets": [], "count": 0, "examples": []})
        group["count"] += 1
        if ticket not in group["tickets"]:
            group["tickets"].append(ticket)
        example = short(f"{ticket}: {example}" if example else ticket)
        if len(group["examples"]) < MAX_EXAMPLES and example not in group["examples"]:
            group["examples"].append(example)

    def listed(self, analyzed: int) -> List[Dict[str, Any]]:
        found = [{**group, "share": round(len(group["tickets"]) / analyzed, 3)} for group in self.groups.values()]
        return sorted(found, key=lambda g: (-len(g["tickets"]), -g["count"], g["key"]))


def group_findings(records: List[Dict[str, Any]]) -> Tuple[List[Groups], Groups]:
    blockers, deviations, verify, reviewers = Groups("review-blocker"), Groups("deviation"), Groups("verify-failure"), Groups("reviewer")
    for record in records:
        ticket = record["ticket_id"]
        for blocker in items(record.get("blockers")):
            if not isinstance(blocker, dict):
                continue
            reviewer = text_of(blocker.get("reviewer")).lower() or "unknown"
            rule = text_of(blocker.get("rule")).lower()
            title = text_of(blocker.get("title"))
            blockers.add(rule or f"(no rule) {reviewer}", ticket, title)
            reviewers.add(reviewer, ticket, title)
        for deviation in items(record.get("deviations")):
            # 'no-baseline' only says the project had no test suite yet; it is a starting condition, not a habit.
            if isinstance(deviation, dict) and text_of(deviation.get("type")).lower() != "no-baseline":
                deviations.add(text_of(deviation.get("type")).lower() or "unknown", ticket, text_of(deviation.get("detail")))
        for finding in items(record.get("verify_findings")):
            if text_of(finding):
                verify.add(finding_kind(finding), ticket, text_of(finding))
    return [blockers, deviations, verify], reviewers


def patterns(groups: Iterable[Groups], analyzed: int, min_tickets: int, min_share: float) -> List[Dict[str, Any]]:
    if not analyzed:
        return []
    found = []
    for group in groups:
        found += [g for g in group.listed(analyzed) if len(g["tickets"]) >= min_tickets and len(g["tickets"]) / analyzed >= min_share]
    return sorted(found, key=lambda g: (-len(g["tickets"]), -g["count"], g["kind"], g["key"]))


def breakdown(records: List[Dict[str, Any]], field: str) -> Dict[str, Dict[str, Any]]:
    result: Dict[str, Dict[str, Any]] = {}
    for record in records:
        name = text_of(record.get(field)) or "unknown"
        group = result.setdefault(name, {"tickets": 0, "merged": 0, "first_pass": 0})
        group["tickets"] += 1
        if record.get("outcome") == "merged":
            group["merged"] += 1
            group["first_pass"] += 1 if record.get("first_pass") is True else 0
    for group in result.values():
        value = rate(group["first_pass"], group["merged"])
        group["first_pass_rate"] = None if value is None else round(value, 3)
    return dict(sorted(result.items()))


def open_cells(project: Path) -> Dict[str, Any]:
    by_stage: Dict[str, int] = {}
    blocked = []
    for path in sorted((project / ".factory" / "worktrees").glob("*/cell.json")):
        cell = load_json(path)
        if cell is None:
            by_stage["unreadable"] = by_stage.get("unreadable", 0) + 1
            continue
        stage = text_of(cell.get("stage")) or "unknown"
        by_stage[stage] = by_stage.get(stage, 0) + 1
        if stage == "blocked":
            blocked.append(text_of(cell.get("ticket_id")) or path.parent.name)
    return {"total": sum(by_stage.values()), "by_stage": dict(sorted(by_stage.items())), "blocked": blocked}


def audit_summary(project: Path) -> Optional[Dict[str, Any]]:
    report = load_json(project / AUDIT_REPORT)
    if report is None:
        return None
    return {"readiness_score": report.get("readiness_score"), "readiness_tier": report.get("readiness_tier"), "timestamp": report.get("timestamp")}


def cmd_collect(project: Path, args: argparse.Namespace) -> int:
    if args.history_depth < 1 or args.min_tickets < 1 or args.min_tickets_per_pattern < 1 or not 0 <= args.min_share <= 1:
        raise ObserveError("--history-depth, --min-tickets and --min-tickets-per-pattern must be at least 1, and --min-share between 0 and 1.", 2)
    runs, skipped = read_runs(project)
    selected = select(runs, args.history_depth)
    records = [record for _, record in selected]
    analyzed = len(records)
    dated = [record["closed_at"] for record in records if parse_time(record.get("closed_at")) != EARLIEST]
    groups, reviewers = group_findings(records)
    # Reviewer notes do not block a ticket, so they never count as blockers; the model reads them for recurring themes.
    note_items = [{"ticket": text_of(record.get("ticket_id")), "reviewer": text_of(note.get("reviewer")).lower() or "unknown",
                   "title": short(text_of(note.get("title"))), "file": text_of(note.get("file")) or None}
                  for record in records for note in items(record.get("notes")) if isinstance(note, dict) and text_of(note.get("title"))]
    by_reviewer: Dict[str, int] = {}
    for note in note_items:
        by_reviewer[note["reviewer"]] = by_reviewer.get(note["reviewer"], 0) + 1
    metrics = {
        "generated_at": now(),
        "sample": {
            "tickets_analyzed": analyzed,
            "tickets_on_record": len(runs),
            "ticket_ids": [record["ticket_id"] for record in records],
            "id_range": {"first": records[0]["ticket_id"], "last": records[-1]["ticket_id"]} if records else None,
            "date_range": {"from": dated[0], "to": dated[-1]} if dated else None,
            "skipped_malformed_lines": skipped,
            "history_depth": args.history_depth,
            "min_tickets": args.min_tickets,
            "enough_data": analyzed >= args.min_tickets,
            "runs_sha256": digest(selected),
        },
        "scorecard": scorecard(records),
        "pattern_thresholds": {"min_tickets": args.min_tickets_per_pattern, "min_share": args.min_share},
        # With too few tickets, a group that recurs is not yet a pattern: report none.
        "patterns": patterns(groups, analyzed, args.min_tickets_per_pattern, args.min_share) if analyzed >= args.min_tickets else [],
        "blockers_by_reviewer": [{"reviewer": group["key"], "tickets": group["tickets"], "count": group["count"], "share": group["share"]}
                                 for group in reviewers.listed(analyzed or 1)],
        "reviewer_notes": {"count": len(note_items), "by_reviewer": by_reviewer, "samples": note_items[-MAX_NOTE_SAMPLES:]},
        "by_risk": breakdown(records, "risk"),
        "by_app_type": breakdown(records, "app_type"),
        "open_cells": open_cells(project),
        "audit": audit_summary(project),
        # M15: the control bands over every finished ticket on record. A breach is evidence a proposal may cite.
        "bands": bands_summary(project),
    }
    path = project / METRICS
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metrics, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(metrics, indent=2, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- filing the report

def outside_fences(lines: Sequence[str]) -> List[Tuple[int, str]]:
    """The lines that are not inside a fenced code block, with their positions: quoted rule text is not structure."""
    kept, fence = [], None
    for index, line in enumerate(lines):
        marker = re.match(r"^\s*(```|~~~)", line)
        if marker and fence is None:
            fence = marker.group(1)
        elif marker and marker.group(1) == fence:
            fence = None
        elif fence is None:
            kept.append((index, line))
    return kept


def split(lines: Sequence[str], level: int) -> List[Tuple[str, List[str]]]:
    """Cut lines into (heading, body) at headings of exactly this level, ignoring fenced code."""
    heading = re.compile(r"^#{%d}\s+(.+?)\s*#*\s*$" % level)
    starts = [(index, heading.match(line).group(1)) for index, line in outside_fences(lines) if heading.match(line)]
    return [(title, list(lines[index + 1:starts[n + 1][0] if n + 1 < len(starts) else len(lines)])) for n, (index, title) in enumerate(starts)]


def fields(body: Sequence[str]) -> Dict[str, str]:
    """The '- **Name:** value' lines of one proposal; a value runs on until the next field."""
    marks = [(index, FIELD_RE.match(line)) for index, line in outside_fences(body)]
    marks = [(index, match) for index, match in marks if match]
    found: Dict[str, str] = {}
    for n, (index, match) in enumerate(marks):
        end = marks[n + 1][0] if n + 1 < len(marks) else len(body)
        found.setdefault(match.group(1).strip().lower(), "\n".join([match.group(2), *body[index + 1:end]]).strip())
    return found


def target_path(value: str) -> str:
    quoted = re.search(r"`([^`]+)`", value)
    name = quoted.group(1) if quoted else (value.split() or [""])[0].rstrip(".,;:")
    name = name.strip()
    return name[2:] if name.startswith("./") else name


# The secrets and dependency scan is never tuned by the observe station: a proposal that mentions it is refused.
SCAN_RE = re.compile(r"(?i)security\.scan|security_scan|scan_answers|not[-_ ]a[-_ ]secret|secrets?[- ](?:gate|scan(?:ner)?)|dependenc(?:y|ies)[- ]scan|"
                     r"\bscan\.py\b|secret candidates?")


def allowed_target(name: str) -> bool:
    parts = name.split("/")
    if not name or name.startswith("/") or "\\" in name or ".." in parts or "" in parts:
        return False
    return name in RULE_FILES or parts[-1] == "SKILL.md" or bool(REFERENCE_RE.search(name))


def cited(text: str, ticket_ids: Iterable[str]) -> List[str]:
    return [ticket for ticket in ticket_ids
            if re.search(r"(?<![A-Za-z0-9_.-])" + re.escape(ticket) + r"(?![A-Za-z0-9_-]|\.[A-Za-z0-9])", text)]


def check_report(text: str, metrics: Dict[str, Any]) -> Tuple[List[str], List[Dict[str, str]]]:
    """Every reason to refuse the report, and the proposals found in it."""
    problems: List[str] = []
    sample = metrics.get("sample") or {}
    ticket_ids = sorted(set(items(sample.get("ticket_ids"))))
    sections: Dict[str, List[str]] = {}
    for title, body in split(text.splitlines(), 2):
        sections.setdefault(title.lower(), []).extend(body)
    for heading in REQUIRED_HEADINGS:
        if heading.lower() not in sections:
            problems.append(f"The report has no '## {heading}' heading.")
    proposals = []
    for title, body in split(sections.get("proposed changes", []), 3):
        found = fields(body)
        for name in REQUIRED_FIELDS:
            if not found.get(name.lower()):
                problems.append(f"Proposed change '{title}' has no '- **{name}:**' line, or the line is empty.")
        target = target_path(found.get("target", ""))
        if found.get("target") and not allowed_target(target):
            problems.append(f"Proposed change '{title}' targets '{target}'. A proposal may only target REVIEW.md, CLAUDE.md, AGENTS.md, "
                            "a SKILL.md, or a file under a skill's references/; anything else is a person's decision and belongs under 'Not proposed'.")
        if SCAN_RE.search("\n".join(body)):
            problems.append(f"Proposed change '{title}' concerns the security scan (the build station's secrets gate, the review packet's security_scan, "
                            "the security seat's scan answers or security.scan in the settings). Switching it off, narrowing it or changing how it "
                            "is answered is a person's decision; move it under 'Not proposed'.")
        if found.get("evidence"):
            known = cited(found["evidence"], ticket_ids)
            if len(known) < 2:
                problems.append(f"Proposed change '{title}' cites {len(known)} ticket ID(s) from the analyzed sample in its Evidence line; "
                                "it needs at least 2. Only tickets listed in metrics.json under sample.ticket_ids count.")
        proposals.append({"title": title, "target": target, "body": "\n".join(body).strip()})
    if len(proposals) > MAX_PROPOSALS:
        problems.append(f"The report proposes {len(proposals)} changes; the limit is {MAX_PROPOSALS}. Keep the best supported and move the rest under 'Not proposed'.")
    if proposals and not sample.get("enough_data"):
        problems.append(f"Only {sample.get('tickets_analyzed', 0)} finished ticket(s) were analyzed (minimum {sample.get('min_tickets', MIN_TICKETS)}): "
                        "the report must propose nothing. Write '- None.' under '## Proposed changes'.")
    return problems, proposals


def current_metrics(project: Path) -> Tuple[Optional[Dict[str, Any]], bool]:
    """The saved metrics and whether they still describe what runs.jsonl holds now."""
    metrics = load_json(project / METRICS)
    if metrics is None or not isinstance(metrics.get("sample"), dict):
        return None, False
    depth = metrics["sample"].get("history_depth")
    runs, _ = read_runs(project)
    fresh = isinstance(depth, int) and digest(select(runs, depth)) == metrics["sample"].get("runs_sha256")
    return metrics, fresh


def cmd_report(project: Path, args: argparse.Namespace) -> int:
    metrics, fresh = current_metrics(project)
    if metrics is None:
        raise ObserveError(f"No readable {METRICS}. Run 'collect' first.")
    if not fresh:
        raise ObserveError(f"{METRICS} is out of date: {RUNS} has changed since it was collected. Run 'collect' again and check the report against the new numbers.")
    try:
        text = args.file.read_text(encoding="utf-8")
    except (OSError, ValueError) as exc:
        raise ObserveError(f"Cannot read the report file {args.file}: {exc}", 2)
    problems, proposals = check_report(text, metrics)
    if problems:
        raise ObserveError("The report was not filed.\n" + "\n".join(f"- {problem}" for problem in problems))
    folder = project / OBSERVATIONS
    folder.mkdir(parents=True, exist_ok=True)
    attempt = 1
    while True:
        path = folder / f"observation-{today()}{'' if attempt == 1 else f'-{attempt}'}.md"
        try:
            with open(path, "x", encoding="utf-8") as handle:  # never overwrite an earlier report
                handle.write(text if text.endswith("\n") else text + "\n")
            break
        except FileExistsError:
            attempt += 1
    log = project / RUNS
    total = sum(1 for line in log.read_text(encoding="utf-8").splitlines() if line.strip()) if log.is_file() else 0
    (folder / "last-pass.json").write_text(json.dumps({"at": now(), "runs_total": total, "report": path.name, "proposed_changes": len(proposals)}, indent=2) + "\n", encoding="utf-8")
    source = Path(args.file).resolve()
    if source.name == "draft.md" and source.parent == folder.resolve():
        source.unlink()  # the filed copy is the record; the draft is done
    print(json.dumps({
        "status": "FILED", "report": str(path), "tickets_analyzed": metrics["sample"].get("tickets_analyzed"),
        "proposed_changes": len(proposals), "proposed_targets": [proposal["target"] for proposal in proposals],
        "proposals": [{"title": proposal["title"], "target": proposal["target"]} for proposal in proposals],
        "next": ("Nothing has been changed. To put the proposals into the factory, run 'file-ticket': it files one ticket labelled "
                 f"'{TUNING_LABEL}' that goes through the line like any other change." if proposals else "Nothing was proposed, so there is nothing to file."),
    }, indent=2, ensure_ascii=False))
    return 0


def sibling(name: str) -> Path:
    """Another station's skill folder, whichever way MACH is installed."""
    for candidate in (SKILL_DIR.parent / f"mach-{name}", SKILL_DIR.parent / name):
        if candidate.is_dir():
            return candidate
    raise ObserveError(f"The MACH {name} skill is not installed next to this one ({SKILL_DIR.parent}), so the ticket cannot be filed.")


def cmd_file_ticket(project: Path, args: argparse.Namespace) -> int:
    """File one ticket carrying every proposal in an observation report, so the changes reach the rules through the line."""
    folder = project / OBSERVATIONS
    reports = sorted(folder.glob("observation-*.md"), key=lambda path: path.stat().st_mtime) if folder.is_dir() else []
    report = args.report.resolve() if args.report else (reports[-1] if reports else None)
    if report is None or not report.is_file():
        raise ObserveError("There is no filed observation report. Run 'collect' and 'report' first.")
    lines = report.read_text(encoding="utf-8").splitlines()
    sections: Dict[str, List[str]] = {}
    for title, body in split(lines, 2):
        sections.setdefault(title.lower(), []).extend(body)
    proposals = [{"title": title, "target": target_path(fields(body).get("target", "")), "body": "\n".join(body).strip()}
                 for title, body in split(sections.get("proposed changes", []), 3)]
    proposals = [proposal for proposal in proposals if proposal["target"] and allowed_target(proposal["target"])]
    if not proposals:
        print(json.dumps({"status": "NOTHING_TO_FILE", "report": str(report), "note": "The report proposes no changes."}, indent=2))
        return 0
    filed_path = folder / "filed.json"
    filed = load_json(filed_path) or {}
    if report.name in filed:
        print(json.dumps({"status": "ALREADY_FILED", "report": str(report), "ticket_id": filed[report.name]}, indent=2))
        return 0
    relative_report = report.relative_to(project) if project in report.parents else report
    body = "\n".join([
        f"Reported by: the MACH observe station, from {relative_report}.",
        "",
        "Apply the rule changes below to the factory's own rule files. Each was proposed because the same problem recurred across finished tickets; "
        "the evidence is under each change. This is a change to documents: the outcome is checked by reading the files, with no user interface and no outside services.",
        "",
        "Rules for this ticket:",
        "- Change only the files named as targets below.",
        "- Add or sharpen rules only. Do not remove a rule, weaken a gate, lower a threshold, raise a limit, or edit any script or setting.",
        "- Do not switch off, narrow or change the security scan (the secrets gate, the scan in the review packet, or how the security seat answers it).",
        "- Use the exact text given under each change.",
        "",
        "## Changes",
        "",
        *[f"### {proposal['title']}\n\n{proposal['body']}\n" for proposal in proposals],
        "## Acceptance criteria",
        "",
        *[f"- [ ] `{proposal['target']}` contains the rule from \"{proposal['title']}\", worded exactly as given." for proposal in proposals],
        "- [ ] No rule that was already in those files is removed or weakened.",
        "- [ ] No file other than the targets is changed, apart from this ticket's own spec and tests.",
    ])
    script = sibling("ticket") / "scripts" / "ticket.py"
    done = subprocess.run([sys.executable, str(script), "--project", str(project), "create", "--title", f"Tune the factory's rules ({report.stem})",
                           "--label", TUNING_LABEL, "--body", "-"], input=body, capture_output=True, text=True)
    try:
        made = json.loads(done.stdout)
        ticket_id = made["ticket_id"]
    except (ValueError, KeyError, TypeError):
        raise ObserveError("The ticket could not be filed: " + (done.stderr.strip() or done.stdout.strip() or "the ticket script printed nothing"))
    filed[report.name] = ticket_id
    filed_path.write_text(json.dumps(filed, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": "FILED", "ticket_id": ticket_id, "label": TUNING_LABEL, "report": str(report), "changes": len(proposals),
        "targets": sorted({proposal["target"] for proposal in proposals}),
        **({"note": made["note"]} if made.get("note") else {}),  # kept on this computer: the tracker could not take it
        "next": f"The ticket goes through the line like any other: groom it headless, build, verify, and review. A ticket labelled '{TUNING_LABEL}' "
                "is decided by a unanimous review panel, with no person's approval, as long as it changes only the factory's rule files.",
    }, indent=2))
    return 0


def cmd_status(project: Path, args: argparse.Namespace) -> int:
    metrics, fresh = current_metrics(project)
    summary = None
    if metrics is not None:
        summary = {
            "generated_at": metrics.get("generated_at"),
            "up_to_date": fresh,
            "sample": {key: metrics["sample"].get(key) for key in ("tickets_analyzed", "id_range", "date_range", "skipped_malformed_lines", "enough_data")},
            "scorecard": {name: {key: entry.get(key) for key in ("value", "target", "met")} for name, entry in (metrics.get("scorecard") or {}).items() if isinstance(entry, dict)},
            "patterns": [{key: pattern.get(key) for key in ("kind", "key", "tickets")} for pattern in items(metrics.get("patterns")) if isinstance(pattern, dict)],
            "blocked_cells": (metrics.get("open_cells") or {}).get("blocked", []),
        }
    reports = []
    for path in sorted((project / OBSERVATIONS).glob("observation-*.md")):
        try:
            body = split(path.read_text(encoding="utf-8", errors="replace").splitlines(), 2)
        except OSError:
            continue
        proposed = [line for title, lines in body if title.lower() == "proposed changes" for line in lines]
        reports.append({"file": str(path), "proposed_changes": len(split(proposed, 3))})
    print(json.dumps({"metrics": summary, "reports": reports,
                      "next": None if summary and fresh else "Run 'collect': there are no metrics yet." if summary is None else "Run 'collect': the metrics are out of date."},
                     indent=2, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- control bands (M15)
#
# Detection is a script and nothing else: the same runs.jsonl always gives the same answer. Each
# scorecard measure becomes one value per finished ticket, in the order the tickets closed. The band
# is the mean and sample standard deviation of up to `window` values just before the most recent
# `recent` ones; the rules are checked at each of those recent tickets. The rules are the four zone
# rules of the Western Electric Company, as the NIST/SEMATECH e-Handbook of Statistical Methods
# lists them (section 6.3.2): one point beyond 3 sigma; 2 of the last 3 beyond 2 sigma on one side;
# 4 of the last 5 beyond 1 sigma on one side; 8 in a row on one side of the centre line. The
# handbook's trend rules (6 rising, 14 alternating) are not used.

BANDS_LOG = OBSERVATIONS + "/bands-log.jsonl"
BANDS_DISMISSED = OBSERVATIONS + "/bands-dismissed.json"
LAST_PASS = OBSERVATIONS + "/last-pass.json"
CONFIG = ".factory/config.json"
# Which way is better for each measure: a signal in the better direction is only recorded (tier 1).
BAND_DIRECTION = {"average_rounds": "lower", "first_pass_rate": "higher", "escalation_rate": "lower",
                  "abandonment_rate": "lower", "tests_failing_first_share": "higher", "deviations_per_ticket": "lower"}
BAND_DEFAULTS: Dict[str, Any] = {
    "enabled": True, "window": 30, "min_sample": 20, "recent": 8, "measures": list(BAND_DIRECTION),
    "rules": {"1": 2, "2": 2, "3": 3, "4": 3},
    "tiers": {"1": ["record"], "2": ["record", "say"], "3": ["record", "say", "observe-pass"]},
}
TIER_ACTIONS = ("record", "say", "observe-pass")
# (span of tickets, how many of them must be beyond, sigmas from the mean; 0 means the centre line)
WE_RULES = {1: (1, 1, 3), 2: (3, 2, 2), 3: (5, 4, 1), 4: (8, 8, 0)}
WE_TEXT = {1: "one ticket beyond 3 standard deviations from the baseline mean",
           2: "2 of the last 3 tickets beyond 2 standard deviations, on the same side",
           3: "4 of the last 5 tickets beyond 1 standard deviation, on the same side",
           4: "8 tickets in a row on the same side of the baseline mean"}
SAY_LINE = "A Factory measure is outside its control band: {measures}. /mach bands shows the tickets behind it."
NOT_ENOUGH = "not enough finished tickets yet"
MIN_DISMISS_REASON = 10
MAX_DISMISS_REASON = 500


def band_settings(project: Path) -> Tuple[Dict[str, Any], List[str]]:
    """observe.bands from the tracked settings over the defaults, and every problem with what was given."""
    config = load_json(project / CONFIG) or {}
    given = (config.get("observe") or {}).get("bands") if isinstance(config.get("observe"), dict) else None
    settings = json.loads(json.dumps(BAND_DEFAULTS))
    problems: List[str] = []
    if given is None:
        return settings, problems
    if not isinstance(given, dict):
        return settings, ["observe.bands must be an object."]
    for key, value in given.items():
        if key not in settings:
            problems.append(f"observe.bands.{key} is not a setting.")
        else:
            settings[key] = value
    if not isinstance(settings["enabled"], bool):
        problems.append("observe.bands.enabled must be true or false.")
    for key, low, high in (("window", 5, 500), ("min_sample", 5, 500), ("recent", 1, 50)):
        value = settings[key]
        if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
            problems.append(f"observe.bands.{key} must be a whole number from {low} to {high}.")
    if not problems and settings["min_sample"] > settings["window"]:
        problems.append("observe.bands.min_sample cannot be more than observe.bands.window.")
    measures = settings["measures"]
    if not isinstance(measures, list) or not measures or any(m not in BAND_DIRECTION for m in measures):
        problems.append("observe.bands.measures must list scorecard measures: " + ", ".join(BAND_DIRECTION) + ".")
    rules = settings["rules"]
    if not isinstance(rules, dict) or any(k not in ("1", "2", "3", "4") or v not in (1, 2, 3) or isinstance(v, bool) for k, v in rules.items()):
        problems.append("observe.bands.rules maps a rule (\"1\" to \"4\") to the tier it raises (1, 2 or 3).")
    tiers = settings["tiers"]
    if (not isinstance(tiers, dict) or set(tiers) != {"1", "2", "3"}
            or any(not isinstance(v, list) or any(a not in TIER_ACTIONS for a in v) for v in tiers.values())):
        problems.append("observe.bands.tiers names tiers \"1\", \"2\" and \"3\", each with actions from: " + ", ".join(TIER_ACTIONS) + ".")
    return (settings if not problems else json.loads(json.dumps(BAND_DEFAULTS))), problems


def band_series(records: List[Dict[str, Any]]) -> Dict[str, List[Tuple[str, float]]]:
    """Each measure as one value per ticket it counts, in closing order: the scorecard's own definitions, per ticket."""
    series: Dict[str, List[Tuple[str, float]]] = {name: [] for name in BAND_DIRECTION}
    for record in records:
        ticket = record["ticket_id"]
        if record.get("outcome") == "merged":
            rounds = number(record.get("rounds"))
            if rounds is not None:
                series["average_rounds"].append((ticket, float(rounds)))
            series["first_pass_rate"].append((ticket, 1.0 if record.get("first_pass") is True else 0.0))
        series["escalation_rate"].append((ticket, 1.0 if record.get("escalated") is True else 0.0))
        series["abandonment_rate"].append((ticket, 1.0 if record.get("outcome") == "abandoned" else 0.0))
        failing = number(record.get("tests_seen_failing_first")) or 0
        passing = number(record.get("tests_passing_on_first_run")) or 0
        if failing + passing:
            series["tests_failing_first_share"].append((ticket, failing / (failing + passing)))
        series["deviations_per_ticket"].append((ticket, float(len(items(record.get("deviations"))))))
    return series


def rule_signals(values: List[float], point: int, mean: float, sd: float) -> List[Tuple[int, int, List[int]]]:
    """(rule, side, positions) for every rule the ticket at `point` completes. The ticket itself must be one of
    those beyond the line. With no spread in the baseline, any value off the mean is beyond every line."""
    found = []
    for rule, (span, need, sigmas) in WE_RULES.items():
        if point - span + 1 < 0:
            continue
        for side in (1, -1):
            beyond = (lambda x: (x - mean) * side > sigmas * sd) if sigmas else (lambda x: (x - mean) * side > 0)
            if not beyond(values[point]):
                continue
            hits = [i for i in range(point - span + 1, point + 1) if beyond(values[i])]
            if len(hits) >= need:
                found.append((rule, side, hits))
    return found


def band_at(series: List[Tuple[str, float]], end: int, settings: Dict[str, Any], direction: str) -> Optional[Dict[str, Any]]:
    """The band and its signals when the first `end` values were all there was, or None below the minimum sample."""
    if end < settings["min_sample"] + 1:
        return None
    recent = min(settings["recent"], end - settings["min_sample"])
    start = end - recent
    baseline = series[max(0, start - settings["window"]):start]
    base = [value for _, value in baseline]
    mean = statistics.fmean(base)
    sd = statistics.stdev(base) if len(base) > 1 else 0.0
    values = [value for _, value in series[:end]]
    signals = []
    for point in range(start, end):
        for rule, side, hits in rule_signals(values, point, mean, sd):
            worse = (side > 0) == (direction == "lower")
            tier = settings["rules"].get(str(rule)) if worse else 1
            if tier is None:
                continue  # the settings do not apply this rule
            signals.append({"rule": rule, "rule_text": WE_TEXT[rule], "ticket": series[point][0], "side": "above" if side > 0 else "below",
                            "direction": "worse" if worse else "better", "tier": tier, "tickets": [series[i][0] for i in hits]})
    adverse = [s for s in signals if s["direction"] == "worse"]
    return {"mean": mean, "sd": sd, "baseline": baseline, "recent": series[start:end], "signals": signals,
            "tier": max((s["tier"] for s in adverse), default=0)}


def band_episode(series: List[Tuple[str, float]], settings: Dict[str, Any], direction: str, tier: int) -> Tuple[str, str]:
    """When the current breach began (the ticket that first put the measure outside its band, in this run of breaches)
    and the ticket at which it last reached its present tier."""
    end = len(series)
    since = tier_since = series[end - 1][0]
    rising = True
    while end >= 1:
        state = band_at(series, end, settings, direction)
        if state is None or not state["tier"]:
            break
        since = series[end - 1][0]
        if rising and state["tier"] >= tier:
            tier_since = series[end - 1][0]
        else:
            rising = False
        end -= 1
    return since, tier_since


def run_positions(project: Path) -> Dict[str, int]:
    """Each ticket's place among the non-empty lines of runs.jsonl, the count last-pass.json's runs_total is taken from."""
    try:
        lines = (project / RUNS).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return {}
    positions, count = {}, 0
    for line in lines:
        if not line.strip():
            continue
        count += 1
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and isinstance(record.get("ticket_id"), str):
            positions[record["ticket_id"].strip()] = count
    return positions


def dismissals(project: Path) -> List[Dict[str, Any]]:
    data = load_json(project / BANDS_DISMISSED) or {}
    return [entry for entry in items(data.get("dismissed")) if isinstance(entry, dict)]


def bands_summary(project: Path) -> Dict[str, Any]:
    """Every watched measure's band, its signals and any breach, with what the tiers say to do. Reads only."""
    settings, problems = band_settings(project)
    if problems:
        return {"enabled": None, "problems": problems, "measures": {}, "tier": 0, "say": None, "observe_pass_due": [],
                "note": "The control band settings in .factory/config.json are not valid, so no band was computed."}
    if not settings["enabled"]:
        return {"enabled": False, "measures": {}, "tier": 0, "say": None, "observe_pass_due": [], "note": "Control bands are switched off (observe.bands.enabled)."}
    runs, _ = read_runs(project)
    records = [record for _, record in select(runs, len(runs))]
    series = band_series(records)
    positions = run_positions(project)
    seen = (load_json(project / LAST_PASS) or {}).get("runs_total")
    seen = seen if isinstance(seen, int) and not isinstance(seen, bool) else 0
    dismissed = dismissals(project)
    measures: Dict[str, Any] = {}
    say, due = [], []
    for name in settings["measures"]:
        values, direction = series[name], BAND_DIRECTION[name]
        state = band_at(values, len(values), settings, direction)
        entry: Dict[str, Any] = {"direction": f"{direction} is better", "sample": {"tickets_with_a_value": len(values)}}
        if state is None:
            entry.update(state=NOT_ENOUGH, note=f"A band needs {settings['min_sample']} finished tickets with a value for this measure "
                                               f"and one more to check; there are {len(values)}.")
            measures[name] = entry
            continue
        sd = state["sd"]
        entry["sample"].update(baseline=len(state["baseline"]), recent=len(state["recent"]),
                               baseline_tickets=[t for t, _ in state["baseline"]], recent_tickets=[t for t, _ in state["recent"]])
        entry["band"] = {"mean": round(state["mean"], 4), "standard_deviation": round(sd, 4),
                         **{f"{side}_{k}_sigma": round(state["mean"] + sign * k * sd, 4) for k in (1, 2, 3) for side, sign in (("lower", -1), ("upper", 1))}}
        entry["recent_values"] = [{"ticket": t, "value": round(v, 4)} for t, v in state["recent"]]
        entry["signals"] = state["signals"]
        entry["state"] = "inside"
        if state["tier"]:
            since, tier_since = band_episode(values, settings, direction, state["tier"])
            actions = settings["tiers"][str(state["tier"])]
            breach = {"since": since, "tier": state["tier"], "tier_since": tier_since, "actions": actions, "dismissed": None}
            match = next((d for d in reversed(dismissed) if d.get("measure") == name and d.get("since") == since), None)
            if match:
                breach["dismissed"] = {key: match.get(key) for key in ("reason", "by", "at")}
                entry["state"] = "outside, dismissed"
            else:
                entry["state"] = "outside"
                if "say" in actions:
                    say.append(name)
                if "observe-pass" in actions and positions.get(tier_since, 0) > seen:
                    due.append({"measure": name, "tier": state["tier"], "since": since, "tier_since": tier_since,
                                "rules": sorted({s["rule"] for s in state["signals"] if s["direction"] == "worse"})})
            entry["breach"] = breach
        measures[name] = entry
    open_tiers = [m["breach"]["tier"] for m in measures.values() if m.get("breach") and not m["breach"]["dismissed"]]
    return {"enabled": True, "settings": {key: settings[key] for key in ("window", "min_sample", "recent", "rules", "tiers")},
            "method": "Western Electric zone rules (NIST/SEMATECH e-Handbook of Statistical Methods, section 6.3.2) over a baseline of the "
                      "tickets just before the most recent ones: mean and sample standard deviation.",
            "measures": measures, "tier": max(open_tiers, default=0),
            "say": SAY_LINE.format(measures=", ".join(say)) if say else None, "observe_pass_due": due}


def record_bands(project: Path, summary: Dict[str, Any]) -> int:
    """Tier 1: each signal and each breach is written once to bands-log.jsonl. Returns how many lines were added."""
    path = project / BANDS_LOG
    known = set()
    if path.is_file():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                known.add(json.loads(line).get("key"))
            except (ValueError, AttributeError):
                continue
    added = []
    for name, entry in summary.get("measures", {}).items():
        for signal in entry.get("signals") or []:
            key = f"signal:{name}:{signal['rule']}:{signal['side']}:{signal['ticket']}"
            if key not in known and "record" in summary["settings"]["tiers"][str(signal["tier"])]:
                added.append({"key": key, "measure": name, **{k: signal[k] for k in ("rule", "ticket", "side", "direction", "tier", "tickets")}})
                known.add(key)
        breach = entry.get("breach")
        if breach:
            key = f"breach:{name}:{breach['since']}:{breach['tier']}"
            if key not in known:
                added.append({"key": key, "measure": name, "since": breach["since"], "tier": breach["tier"], "tier_since": breach["tier_since"]})
                known.add(key)
    if added:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as handle:
            for line in added:
                handle.write(json.dumps({**line, "recorded_at": now()}, ensure_ascii=False) + "\n")
    return len(added)


def cmd_bands(project: Path, args: argparse.Namespace) -> int:
    if args.action == "dismiss":
        return cmd_bands_dismiss(project, args)
    summary = bands_summary(project)
    if summary.get("enabled"):
        summary["recorded"] = record_bands(project, summary)
    summary["next"] = ("Nothing to do." if not summary.get("say") else
                       "A person decides whether a breach matters. To set one aside: bands dismiss <measure> --reason \"<why>\". "
                       "It is raised again only after the measure returns inside its band and leaves it again.")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


def cmd_bands_dismiss(project: Path, args: argparse.Namespace) -> int:
    if os.environ.get("MACH_EXECUTION_ID"):
        raise ObserveError("A breach is dismissed only on a person's word, never inside a supervised Factory execution.")
    reason = " ".join((args.reason or "").split())
    if len(reason) < MIN_DISMISS_REASON:
        raise ObserveError(f"--reason needs the person's reason, in at least {MIN_DISMISS_REASON} characters.", 2)
    if not args.measure:
        raise ObserveError("Name the measure to dismiss: bands dismiss <measure> --reason \"<why>\".", 2)
    summary = bands_summary(project)
    entry = summary.get("measures", {}).get(args.measure)
    breach = (entry or {}).get("breach")
    if not breach:
        raise ObserveError(f"'{args.measure}' has no breach to dismiss" + ("" if entry else " (it is not a watched measure)") + ".")
    if breach["dismissed"]:
        print(json.dumps({"status": "ALREADY_DISMISSED", "measure": args.measure, "since": breach["since"], "dismissed": breach["dismissed"]}, indent=2))
        return 0
    path = project / BANDS_DISMISSED
    data = load_json(path) or {}
    record = {"measure": args.measure, "since": breach["since"], "tier": breach["tier"], "reason": reason[:MAX_DISMISS_REASON],
              "by": " ".join((args.by or "a person").split())[:80], "at": now()}
    data["dismissed"] = [*dismissals(project), record]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": "DISMISSED", **record,
                      "note": "This breach is no longer said or counted toward an observe pass. It is raised again only after the measure "
                              "returns inside its band and leaves it again. The band itself is unchanged."}, indent=2, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MACH observe station: measure finished tickets and file observation reports.")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("collect", help="compute the scorecard and recurring patterns; write .factory/observations/metrics.json")
    p.add_argument("--history-depth", type=int, default=HISTORY_DEPTH, help=f"how many of the most recently finished tickets to analyze (default {HISTORY_DEPTH})")
    p.add_argument("--min-tickets", type=int, default=MIN_TICKETS, help=f"fewer analyzed tickets than this is not enough data to propose anything (default {MIN_TICKETS})")
    p.add_argument("--min-share", type=float, default=MIN_SHARE, help=f"a pattern must occur in at least this share of analyzed tickets (default {MIN_SHARE})")
    p.add_argument("--min-tickets-per-pattern", type=int, default=MIN_TICKETS_PER_PATTERN, help=f"a pattern must occur in at least this many tickets (default {MIN_TICKETS_PER_PATTERN})")
    p.set_defaults(func=cmd_collect)
    p = sub.add_parser("report", help="check the written report against the metrics and file it")
    p.add_argument("--file", type=Path, required=True, help="the report, in markdown")
    p.set_defaults(func=cmd_report)
    p = sub.add_parser("file-ticket", help="file one ticket carrying the proposals of a filed report, so they go through the line")
    p.add_argument("--report", type=Path, help="the filed observation report (default: the latest)")
    p.set_defaults(func=cmd_file_ticket)
    p = sub.add_parser("status", help="print the latest metrics summary and the filed reports")
    p.set_defaults(func=cmd_status)
    p = sub.add_parser("bands", help="each scorecard measure against its control band; records signals, changes nothing else")
    p.add_argument("action", nargs="?", choices=("dismiss",), help="dismiss: a person sets aside the current breach of one measure")
    p.add_argument("measure", nargs="?", help="with dismiss: the measure, such as first_pass_rate")
    p.add_argument("--reason", help="with dismiss: the person's reason, in their words")
    p.add_argument("--by", help="with dismiss: the role of the person who decided, such as engineering-lead")
    p.set_defaults(func=cmd_bands)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        project = args.project.resolve() if args.project else find_project(Path.cwd())
        if not project.is_dir():
            raise ObserveError(f"{project} is not a folder.", 2)
        return args.func(project, args)
    except ObserveError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.code


if __name__ == "__main__":
    import contextlib as _c, os as _o, runpy as _r  # MACH records an internal error for /mach report (skills/intent/scripts/faults.py)
    with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if _o.path.isfile(p)))["install"](__file__)
    sys.exit(main())
