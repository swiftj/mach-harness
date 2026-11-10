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

This script measures and files. It never edits REVIEW.md, CLAUDE.md, AGENTS.md or any skill:
a proposed change becomes a ticket and goes through the factory like any other work.

Standard library only. It reads files and writes only under .factory/observations/.
"""

import argparse
import hashlib
import json
import re
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
        ticket_id = json.loads(done.stdout)["ticket_id"]
    except (ValueError, KeyError):
        raise ObserveError("The ticket could not be filed: " + (done.stderr.strip() or done.stdout.strip() or "the ticket script printed nothing"))
    filed[report.name] = ticket_id
    filed_path.write_text(json.dumps(filed, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": "FILED", "ticket_id": ticket_id, "label": TUNING_LABEL, "report": str(report), "changes": len(proposals),
        "targets": sorted({proposal["target"] for proposal in proposals}),
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
    sys.exit(main())
