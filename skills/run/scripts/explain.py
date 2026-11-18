#!/usr/bin/env python3
"""MACH explain: why a ticket failed, was sent back or is waiting, from its cell's own records.

Reached as `run.py explain <ticket> [--json]`. It gathers facts and nothing else: it writes no file, runs no
station, starts nothing and records nothing in the lifecycle log. The skill's model phrases the facts.

Sources, all inside .factory/worktrees/<ticket>/ (written by the stations, never by this script):
    cell.json                       stage and risk
    build.json, build-report.json   the revision loop, and every gate override with its reason
    evidence/summary.json           the verification verdict: failed checks (AC-NN, RN, H-...), suite, contracts, unproven items
    review/decision.json            the latest review decision; rejected_by marks a send-back by the merge station or by a person
    review/round-N/votes/*.json     each seat's findings: blocker, rule cited, file, line, class and impact
    review/merge-findings.md        what the merge station sent back
    lifecycle.jsonl                 refused gates (build, an incomplete verification, a merge conflict) and timings
    spec.json                       the title or text of each cited requirement, scenario or rule

Reviewer, verifier and merge text is untrusted data. It appears only in the fields named `detail`, `rule`
and `file`, with control and format characters removed and cut to 400 characters. It is never interpreted.
An archived ticket (.factory/archive/<ticket>.tar.gz) is reported as archived; the archive is never opened.

Standard library only.
"""

import json
import re
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

LIMIT = 400
SPEC_ID_RE = re.compile(r"\b(?:(?:FR|INV|AC)-\d{2,}|R\d{1,3})\b")
VETO_IMPACTS = ("critical", "high")
IMPACTS = ("critical", "high", "medium", "low")
FAILING_STAGES = ("built", "building", "blocked")
HEADLINES = {
    "verification_failed": "Verification failed",
    "verification_incomplete": "Verification could not finish: items were left unproven",
    "review_rejected": "The review panel rejected the build",
    "sent_back_by_merge": "The merge station sent the build back",
    "sent_back_by_person": "A person sent the change back after the panel approved it",
    "merge_refused": "The merge station stopped",
    "build_gate_refused": "A build gate refused",
    "escalated": "The ticket used all its rounds and was escalated to a person",
    "waiting_for_person": "Nothing failed; the ticket is waiting for a person",
    "nothing_failed": "Nothing failed",
    "not_started": "No cell yet: the ticket has not been groomed",
    "finished": "The ticket is finished",
    "archived": "The ticket is finished and archived",
    "unknown_ticket": "Unknown ticket",
}


def clean(value: Any, limit: int = LIMIT) -> Optional[str]:
    """Untrusted text made inert: control and format characters removed, whitespace folded, at most `limit` characters."""
    if value is None:
        return None
    text = "".join(" " if ch in "\t\n\r" else ch for ch in str(value) if ch in "\t\n\r" or not unicodedata.category(ch).startswith("C"))
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


_ADR: List[Any] = []


def adr_helper() -> Any:
    """The intent station's adr.py, the shared architecture-decision helper, whichever way MACH is installed."""
    if not _ADR:
        import importlib.util
        skills = Path(__file__).resolve().parent.parent.parent
        script = next((folder / "scripts" / "adr.py" for folder in (skills / "mach-intent", skills / "intent") if (folder / "scripts" / "adr.py").is_file()), None)
        if script is None:
            raise RuntimeError("The intent station's adr.py is not installed beside this skill.")
        spec = importlib.util.spec_from_file_location("mach_adr_for_explain", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _ADR.append(module)
    return _ADR[0]


def adr_facts(root: Path, cellroot: Path, cell: Dict[str, Any], config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """What the cell records about architecture decisions: a conflict waiting for an engineer, exceptions, the ADRs the plan
    named or proposes, proposals waiting for acceptance, and ADRs changed on the main branch since it was planned."""
    facts: Dict[str, Any] = {}
    conflict = cell.get("adr_conflict")
    if isinstance(conflict, dict):
        facts["conflict"] = {"adr": clean(conflict.get("adr"), 20), "title": clean(conflict.get("title"), 200), "reason": clean(conflict.get("reason")),
                             "source_file": "cell.json"}
    found = [{"adr": clean(item.get("adr"), 20), "by": clean(item.get("by"), 80), "reason": clean(item.get("reason")), "at": clean(item.get("at"), 40)}
             for item in cell.get("adr_exceptions") or [] if isinstance(item, dict)]
    if found:
        facts["exceptions"] = found[:10]
    planned = cell.get("adrs") if isinstance(cell.get("adrs"), dict) else {}
    if planned.get("planned_at"):
        facts["named_in_plan"] = [clean(item, 20) for item in planned.get("named") or []][:20]
        facts["proposed"] = [clean(item.get("id"), 20) for item in planned.get("proposed") or [] if isinstance(item, dict)][:10]
    try:
        A = adr_helper()
        waiting = A.pending_acceptance(cell)
        if waiting and planned.get("planned_at"):
            facts["waiting_for_acceptance"] = [clean(item, 20) for item in waiting][:10]
        flags = A.drift(root, config, cellroot, cell)
        if flags:
            facts["changed_since_plan"] = [{"adr": clean(flag.get("id"), 20), "change": clean(flag.get("change"), 40), "title": clean(flag.get("title"), 200)}
                                           for flag in flags][:20]
            facts["changed_since_plan_note"] = "They apply to tickets planned from now on; this ticket goes on under the ADRs it was planned with."
    except Exception as exc:  # explain reads and reports; a failure to check is said, never hidden
        facts["not_checked"] = f"Architecture decisions could not be checked ({exc.__class__.__name__})."
    return facts or None


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def read_lines(path: Path) -> List[Dict[str, Any]]:
    """Whole JSON objects only; a torn or foreign line is skipped."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    found = []
    for line in text.splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict):
            found.append(item)
    return found


def spec_index(spec: Any) -> Dict[str, str]:
    """Each requirement, invariant, scenario and matrix rule ID with its text or title."""
    index: Dict[str, str] = {}
    if not isinstance(spec, dict):
        return index
    for key, field in (("invariants", "text"), ("functional_requirements", "text"), ("scenarios", "title")):
        for entry in spec.get(key) or []:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                index[entry["id"]] = clean(entry.get(field)) or ""
    for rule in ((spec.get("decision_matrix") or {}).get("rules") or []) if isinstance(spec.get("decision_matrix"), dict) else []:
        if isinstance(rule, dict) and isinstance(rule.get("id"), str):
            index[rule["id"]] = clean(f"Expected: {rule.get('expected_outcome')}") or ""
    return index


def requirement(index: Dict[str, str], ident: Optional[str]) -> Optional[Dict[str, Any]]:
    if not ident:
        return None
    return {"id": ident, "text": index.get(ident) or None}


def cause(kind: str, ident: Optional[str], index: Dict[str, str], *, file: Any = None, line: Any = None, detail: Any = None,
          source_file: str, req: Optional[str] = None, **extra: Any) -> Dict[str, Any]:
    item = {"kind": kind, "id": clean(ident, 80), "requirement": requirement(index, req if req is not None else (ident if ident and SPEC_ID_RE.fullmatch(ident) else None)),
            "file": clean(file, 200), "line": line if isinstance(line, int) and not isinstance(line, bool) else None,
            "detail": clean(detail), "source_file": source_file}
    item.update(extra)
    return item


def verification_causes(cellroot: Path, summary: Dict[str, Any], index: Dict[str, str]) -> List[Dict[str, Any]]:
    found = []
    checks = summary.get("checks") if isinstance(summary.get("checks"), dict) else {}
    for ident, check in checks.items():
        if not isinstance(check, dict) or check.get("result") != "fail":
            continue
        evidence = [clean(name, 200) for name in check.get("evidence") or [] if isinstance(name, str)]
        found.append(cause("verification", ident, index, file=f"evidence/{evidence[0]}" if evidence else None, detail=check.get("note"),
                           source_file="evidence/summary.json", check_kind=clean(check.get("kind"), 40), evidence=[f"evidence/{name}" for name in evidence]))
    suite = summary.get("suite") if isinstance(summary.get("suite"), dict) else {}
    if suite and suite.get("passed") is False:
        code = suite.get("exit_code")
        found.append(cause("verification", "test-suite", index, file=f"evidence/{clean(suite.get('log'), 200)}" if suite.get("log") else None,
                           detail=f"The test suite fails when rerun in the cell (exit code {code if isinstance(code, int) else 'unknown'}).",
                           source_file="evidence/summary.json"))
    if summary.get("contract_valid") is False:
        found.append(cause("verification", "contracts", index, detail="A contract file is missing or malformed.", source_file="evidence/summary.json"))
    for ident in summary.get("unproven") or []:
        if isinstance(ident, str):
            found.append(cause("verification", ident, index, detail="Not proven: no evidence was recorded for this item.", source_file="evidence/summary.json"))
    return found


def round_folder(cellroot: Path, decision: Dict[str, Any]) -> Path:
    """The decided round's folder: from the decision's findings path when it lies inside this cell's review folder."""
    review = cellroot / "review"
    findings = decision.get("findings")
    if isinstance(findings, str) and findings:
        path = Path(findings)
        try:
            inside = review.resolve() in path.resolve().parents
        except (OSError, RuntimeError):
            inside = False
        if inside and path.name == "findings.md":
            return path.parent
    number = decision.get("round")
    return review / f"round-{number if isinstance(number, int) else 1}"


def review_blockers(cellroot: Path, decision: Dict[str, Any], index: Dict[str, str], seat_veto_on: bool) -> List[Dict[str, Any]]:
    folder = round_folder(cellroot, decision)
    outvoted = decision.get("outcome") in ("APPROVED", "AWAITING_HUMAN")
    found = []
    for path in sorted((folder / "votes").glob("*.json")) if (folder / "votes").is_dir() else []:
        vote = load_json(path, {})
        if not isinstance(vote, dict):
            continue
        seat = clean(vote.get("reviewer") or path.stem, 40)
        for finding in vote.get("findings") or []:
            if not isinstance(finding, dict) or finding.get("severity") != "blocker":
                continue
            rule = clean(finding.get("rule"))
            cited = SPEC_ID_RE.findall(str(finding.get("rule") or ""))
            impact = finding.get("impact") if finding.get("impact") in IMPACTS else None
            security = finding.get("class") == "security" or (seat == "security" and impact is not None)
            veto = (security and impact in VETO_IMPACTS) or (seat == "security" and seat_veto_on)
            title, detail = finding.get("title"), finding.get("detail")
            found.append(cause("review", cited[0] if cited else None, index, file=finding.get("file"), line=finding.get("line"),
                               detail=f"{title}. {detail}" if title and detail else (title or detail), req=cited[0] if cited else None,
                               source_file=str(path.relative_to(cellroot)), seat=seat, rule=rule, cites=sorted(set(cited)),
                               **{"class": "security" if security else None}, impact=impact, veto=bool(veto) and not outvoted, outvoted=outvoted,
                               round=decision.get("round") if isinstance(decision.get("round"), int) else None))
    return found


def last_record(records: List[Dict[str, Any]], station: str) -> Optional[Dict[str, Any]]:
    for record in reversed(records):
        if record.get("station") == station:
            return record
    return None


def refused_gate(records: List[Dict[str, Any]], station: str) -> Optional[Dict[str, Any]]:
    """The station's last record, when it is a refused gate."""
    record = last_record(records, station)
    if record and record.get("type") == "gate.evaluated" and isinstance(record.get("data"), dict) and record["data"].get("outcome") == "refuse":
        return record["data"]
    return None


def max_rounds(config: Dict[str, Any]) -> int:
    value = (config.get("review") or {}).get("max_loops", 3) if isinstance(config.get("review"), dict) else 3
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 3


def no_cell(root: Path, ticket_id: str, next_info: Dict[str, Any]) -> Tuple[Dict[str, Any], int]:
    factory = root / ".factory"
    archive = factory / "archive" / f"{ticket_id}.tar.gz"
    record = None
    for item in reversed(read_lines(factory / "archive" / "runs.jsonl")):
        if item.get("ticket_id") == ticket_id:
            record = item
            break
    facts: Dict[str, Any] = {}
    if record:
        facts = {"outcome": clean(record.get("outcome"), 40),
                 **{key: record.get(key) for key in ("rounds", "verification_failures") if isinstance(record.get(key), int) and not isinstance(record.get(key), bool)}}
    if archive.is_file():
        return {"headline_code": "archived", "archive": str(archive.relative_to(root)), "run_record": facts or None}, 0
    if record:
        return {"headline_code": "finished", "archive": None, "run_record": facts}, 0
    known = (factory / "tickets" / f"{ticket_id}.md").is_file() or (factory / "inbox" / f"{ticket_id}.json").is_file()
    if known:
        return {"headline_code": "not_started"}, 0
    return {"headline_code": "unknown_ticket",
            "detail": f"No cell, archive, run record, local ticket or inbox record exists for {ticket_id} in this project."}, 1


def explain(root: Path, ticket_id: str, next_info: Dict[str, Any], config: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, Any], int]:
    """The facts behind where a ticket stands, and the exit code: 1 only for a ticket this project does not know."""
    config = config if isinstance(config, dict) else {}
    limit = max_rounds(config)
    nxt = {key: next_info.get(key) for key in ("action", "stop", "needs", "reason", "stage")}
    cellroot = root / ".factory" / "worktrees" / ticket_id
    cell = load_json(cellroot / "cell.json")
    base = {"ticket_id": ticket_id, "stage": None, "headline_code": None, "headline": None, "causes": [], "overrides": [],
            "outvoted_blockers": [], "findings_file": None, "rounds_used": 0, "rounds_left": limit, "max_rounds": limit, "next": nxt}
    if not isinstance(cell, dict):
        extra, code = no_cell(root, ticket_id, next_info)
        base.update(extra)
        base["headline"] = HEADLINES[base["headline_code"]]
        return base, code

    stage = cell.get("stage") if isinstance(cell.get("stage"), str) else None
    build = load_json(cellroot / "build.json", {}) or {}
    report = load_json(cellroot / "build-report.json", {}) or {}
    summary = load_json(cellroot / "evidence" / "summary.json", {}) or {}
    decision = load_json(cellroot / "review" / "decision.json", {}) or {}
    index = spec_index(load_json(cellroot / "spec.json", {}))
    records = read_lines(cellroot / "lifecycle.jsonl")
    review_settings = config.get("review") if isinstance(config.get("review"), dict) else {}
    seat_veto_on = review_settings.get("security_veto") is not False

    loop = build.get("loop") if isinstance(build.get("loop"), int) and not isinstance(build.get("loop"), bool) else 0
    used = loop + 1 if (cellroot / "build.json").is_file() else 0
    if stage == "blocked":
        used = max(used, limit)
    base.update({"stage": stage, "risk": clean(cell.get("risk"), 20), "rounds_used": used, "rounds_left": max(limit - used, 0)})

    causes: List[Dict[str, Any]] = []
    headline = None
    if stage in FAILING_STAGES:
        candidates = []  # (round, order within a round, headline, causes, findings file)
        if summary.get("status") == "FAIL_WITH_EVIDENCE":
            number = summary.get("review_loop") if isinstance(summary.get("review_loop"), int) else 0
            candidates.append((number + 1, 0, "verification_failed", verification_causes(cellroot, summary, index), "evidence/findings.md"))
        if decision.get("outcome") in ("REJECTED", "ESCALATE"):
            number = decision.get("round") if isinstance(decision.get("round"), int) else 0
            if decision.get("rejected_by") == "a person":
                sent = decision.get("human_send_back") if isinstance(decision.get("human_send_back"), dict) else {}
                where = "/".join(round_folder(cellroot, decision).relative_to(cellroot).parts + ("person-findings.md",))
                candidates.append((number, 2, "sent_back_by_person",
                                   [cause("person", "sent-back", index, detail=sent.get("reason") or "A person sent the change back.", source_file=where)], where))
            elif decision.get("rejected_by"):
                text = ""
                try:
                    text = (cellroot / "review" / "merge-findings.md").read_text(encoding="utf-8", errors="replace")
                except OSError:
                    pass
                body = re.sub(r"^#.*$", "", text, count=1, flags=re.MULTILINE)
                candidates.append((number, 2, "sent_back_by_merge",
                                   [cause("merge", "sent-back", index, detail=body or "The merge station sent the build back.", source_file="review/merge-findings.md")],
                                   "review/merge-findings.md"))
            else:
                folder = round_folder(cellroot, decision)
                findings = folder / "findings.md"
                candidates.append((number, 1, "review_rejected", review_blockers(cellroot, decision, index, seat_veto_on),
                                   str(findings.relative_to(cellroot)) if findings.is_file() else None))
        if candidates:
            candidates.sort(key=lambda item: (item[0], item[1]))
            _, _, headline, causes, findings_file = candidates[-1]
            base["findings_file"] = findings_file if findings_file and (cellroot / findings_file).is_file() else None
        incomplete = refused_gate(records, "verify") if stage == "built" else None
        if incomplete and incomplete.get("reason_code") == "incomplete-evidence" and (not candidates or candidates[-1][0] < used):
            headline = "verification_incomplete"
            causes = [cause("verification", ident, index, detail="Not proven: verification finished without evidence for this item.", source_file="lifecycle.jsonl")
                      for ident in incomplete.get("unproven") or [] if isinstance(ident, str)] or [
                cause("verification", "verify.finish", index, detail="Verification could not finish: evidence was incomplete.", source_file="lifecycle.jsonl")]
        gate = refused_gate(records, "build") if stage in ("building", "blocked") else None
        if gate:
            headline = "build_gate_refused" if stage == "building" else headline
            causes.insert(0, cause("build_gate", clean(gate.get("gate"), 60), index, source_file="lifecycle.jsonl",
                                   detail=f"The {clean(gate.get('gate'), 60)} gate refused ({clean(gate.get('reason_code'), 60) or 'no reason code'}).",
                                   task=clean(gate.get("task"), 20)))
        if stage == "blocked":
            headline = "escalated"
            causes.insert(0, cause("blocked", "round-limit", index, source_file="cell.json",
                                   detail=f"The ticket failed {limit} judging rounds, the limit, and was escalated: a person takes it over."))
    elif stage in ("approved", "pr-open"):
        gate = refused_gate(records, "merge")
        if gate:
            headline = "merge_refused"
            causes.append(cause("merge", clean(gate.get("reason_code"), 60), index, source_file="lifecycle.jsonl",
                                detail=f"The {clean(gate.get('gate'), 60)} gate refused ({clean(gate.get('reason_code'), 60) or 'no reason code'})."))

    if decision.get("outcome") in ("APPROVED", "AWAITING_HUMAN") and not decision.get("rejected_by"):
        base["outvoted_blockers"] = review_blockers(cellroot, decision, index, seat_veto_on)
    if not causes and nxt.get("stop") and nxt.get("needs") not in (None, "nothing"):
        headline = "waiting_for_person"
        reasons = decision.get("human_approval_reasons") if stage == "awaiting-human" and isinstance(decision.get("human_approval_reasons"), list) else []
        causes.append(cause("waiting_for_person", clean(nxt.get("needs"), 40), index, source_file="cell.json",
                            detail=nxt.get("reason"), reasons=[clean(reason, 200) for reason in reasons]))
    base["causes"] = causes
    base["headline_code"] = headline or "nothing_failed"
    base["headline"] = HEADLINES[base["headline_code"]]
    base["overrides"] = [{"task": clean(item.get("task"), 20), "type": clean(item.get("type"), 60), "detail": clean(item.get("detail")),
                          "source_file": "build-report.json"} for item in (report.get("deviations") or [])[:20] if isinstance(item, dict)]
    facts = adr_facts(root, cellroot, cell, config)
    if facts:
        base["adrs"] = facts
    return base, 0


def human(report: Dict[str, Any]) -> str:
    """A short plain list. Quoted text came from a reviewer, the verifier or a test run and is shown as data."""
    lines = []
    digest = report.get("digest") or {}
    for key, label in (("where", "Where"), ("needs_person", "A person must decide"), ("time_and_cost", "Time and cost")):
        if digest.get(key):
            lines.append(f"{label}: {digest[key]}")
    if lines:
        lines.append("")
    if report.get("resolved_from"):
        lines.append(f"({report['resolved_from']} is {report['ticket_id']}.)")
    lines.append(f"{report['ticket_id']}: {report['headline']}." + (f" Stage: {report['stage']}." if report.get("stage") else ""))
    for item in report.get("causes") or []:
        ident = item.get("id") or "-"
        req = item.get("requirement") or {}
        head = f"- [{item['kind']}] {ident}"
        if item.get("seat"):
            head += f", {item['seat']} seat"
        if item.get("veto"):
            head += ", security veto"
        if req.get("text"):
            head += f": {req['text']}"
        lines.append(head)
        where = item.get("file") or item.get("source_file")
        if item.get("line"):
            where += f":{item['line']}"
        rule = f' cites "{item["rule"]}";' if item.get("rule") else ""
        lines.append(f"    {where};{rule} " + (f'"{item["detail"]}"' if item.get("detail") else ""))
    for item in report.get("outvoted_blockers") or []:
        lines.append(f"- outvoted blocker from the {item.get('seat')} seat: {item.get('file') or '-'}" + (f' cites "{item["rule"]}"' if item.get("rule") else ""))
    if report.get("overrides"):
        lines.append(f"Gate overrides recorded by the builder: {len(report['overrides'])} (see build-report.json).")
    facts = report.get("adrs") or {}
    if facts.get("conflict"):
        lines.append(f"- [adr] the plan cannot follow {facts['conflict']['adr']}: \"{facts['conflict'].get('reason') or ''}\"")
    for item in facts.get("exceptions") or []:
        lines.append(f"- [adr] exception to {item['adr']} recorded by {item['by']}: \"{item.get('reason') or ''}\"")
    if facts.get("waiting_for_acceptance"):
        lines.append(f"- [adr] proposed and waiting for an engineer to accept: {', '.join(facts['waiting_for_acceptance'])}")
    for item in facts.get("changed_since_plan") or []:
        lines.append(f"- [adr] {item['adr']} {item['change']}: it applies to tickets planned from now on; this one goes on as planned")
    if facts.get("not_checked"):
        lines.append(f"- [adr] {facts['not_checked']}")
    if report.get("headline_code") not in ("unknown_ticket", "archived", "finished"):
        lines.append(f"Rounds: {report['rounds_used']} of {report['max_rounds']} used, {report['rounds_left']} left.")
    nxt = report.get("next") or {}
    if nxt.get("action"):
        lines.append(f"Next: {nxt['action']}" + (f" ({nxt['reason']})" if nxt.get("reason") else ""))
    elif report.get("detail"):
        lines.append(report["detail"])
    return "\n".join(lines)
