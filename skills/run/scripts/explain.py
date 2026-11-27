#!/usr/bin/env python3
"""MACH explain: why a ticket failed, was sent back or is waiting, from its cell's own records.

Reached as `run.py explain <ticket> [--json]`. It gathers facts and nothing else: it writes no file, runs no
station, starts nothing and records nothing in the lifecycle log. The skill's model phrases the facts.

Sources, all inside .factory/worktrees/<ticket>/ (written by the stations, never by this script):
    cell.json                       stage and risk
    build.json, build-report.json   the revision loop, and every gate override with its reason; for a build in lanes (M22)
                                    the lanes, any lane set aside, lanes that failed only together, and the fix task
    lanes/<L>/lane.json             how far each lane has got, while the lanes are open
    evidence/summary.json           the verification verdict: failed checks (AC-NN, RN, H-...), suite, contracts, unproven items
                                    and, for a change verified without screenshots, the station's words saying so and why
    review/decision.json            the latest review decision; rejected_by marks a send-back by the merge station or by a person;
                                    exceptions[] a person's exceptions to security blockers (who, why, expiry)
    review/round-N/votes/*.json     each seat's findings: blocker, rule cited, file, line, class and impact
    review/merge-findings.md        what the merge station sent back
    lifecycle.jsonl                 refused gates (build, an incomplete verification, a merge conflict) and timings
    spec.json                       the title or text of each cited requirement, scenario or rule
    spec.md                         the spec's open policy concerns (pack, statement, owner, why), and cell.json's
                                    policy_acceptances (who accepted one, and how the name was checked)

Reviewer, verifier and merge text is untrusted data. It appears only in the fields named `detail`, `rule`
and `file`, with control and format characters removed and cut to 400 characters. It is never interpreted.
An archived ticket (the archive its run record names) is reported as archived; the archive is never opened. A finished ticket
whose archive was not kept (cleanup.archive) is reported as finished, with `evidence` saying so and why.

Standard library only.
"""

import json
import re
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

LIMIT = 400
SPEC_ID_RE = re.compile(r"\b(?:(?:FR|INV|AC)-\d{2,}|R\d{1,3})\b")
VETO_IMPACTS = ("critical", "high")
IMPACTS = ("critical", "high", "medium", "low")
FAILING_STAGES = ("built", "building", "blocked")
# Which station's failure a headline is: what stopped a ticket last, for a person carrying it on (decide.py's facts.stopped).
LAST_FAILURE_STATION = {"verification_failed": "verify", "review_rejected": "review", "sent_back_by_person": "person", "sent_back_by_merge": "merge"}
HEADLINES = {
    "verification_failed": "Verification failed",
    "verification_incomplete": "Verification could not finish: items were left unproven",
    "review_rejected": "The review panel rejected the build",
    "sent_back_by_merge": "The merge station sent the build back",
    "sent_back_by_person": "A person sent the change back after the panel approved it",
    "merge_refused": "The merge station stopped",
    "build_gate_refused": "A build gate refused",
    "escalated": "The ticket failed its last round and stopped for a person, who can carry it on with a fix",
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


_POLICIES: List[Any] = []


def policies_helper() -> Any:
    """The intent station's policies.py, the shared policy-pack helper, whichever way MACH is installed."""
    if not _POLICIES:
        import importlib.util
        skills = Path(__file__).resolve().parent.parent.parent
        script = next((folder / "scripts" / "policies.py" for folder in (skills / "mach-intent", skills / "intent") if (folder / "scripts" / "policies.py").is_file()), None)
        if script is None:
            raise RuntimeError("The intent station's policies.py is not installed beside this skill.")
        spec = importlib.util.spec_from_file_location("mach_policies_for_explain", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _POLICIES.append(module)
    return _POLICIES[0]


def policy_facts(cellroot: Path, cell: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The spec's open policy concerns (M15), read from the cell's own copy of the spec: which pack, which statement, who
    the owner is and why the slice cannot meet it; and each owner's acceptance recorded in cell.json, with how the name
    was checked. Spec and acceptance text is data, bounded."""
    facts: Dict[str, Any] = {}
    try:
        text = (cellroot / "spec.md").read_text(encoding="utf-8-sig")
    except OSError:
        text = ""
    try:
        concerns = policies_helper().open_concerns(text) if text else []
    except Exception as exc:  # explain reads and reports; a failure to check is said, never hidden
        concerns = []
        facts["not_checked"] = f"The spec's policy concerns could not be read ({exc.__class__.__name__})."
    if concerns:
        facts["open_concerns"] = [{"pack": clean(item.get("pack"), 60), "statement_id": clean(item.get("statement_id"), 60),
                                   "statement": clean(item.get("statement")), "owner": clean(item.get("owner"), 200), "why": clean(item.get("why")),
                                   "source_file": "spec.md"} for item in concerns][:10]
    accepted = [{"statement_id": clean(item.get("statement"), 60), "by": clean(item.get("by"), 120), "owner_check": clean(item.get("owner_check"), 60),
                 "reason": clean(item.get("reason")), "at": clean(item.get("at"), 40), "source_file": "cell.json"}
                for item in cell.get("policy_acceptances") or [] if isinstance(item, dict)]
    if accepted:
        facts["acceptances"] = accepted[:10]
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


def exception_ref(item: Dict[str, Any]) -> str:
    return f"{item.get('round')}/{item.get('seat')}/{item.get('index')}"


def current_exceptions(decision: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """The security exception in force for each finding: the latest recorded for it (review.py's rule)."""
    found: Dict[str, Dict[str, Any]] = {}
    for item in decision.get("exceptions") or [] if isinstance(decision.get("exceptions"), list) else []:
        if isinstance(item, dict):
            found[exception_ref(item)] = item
    return found


def exception_expired(item: Dict[str, Any], on: Optional[date] = None) -> bool:
    """Through its expiry day (UTC) and no longer; one with no expiry holds for the commit reviewed. An unreadable expiry has passed."""
    value = item.get("expires")
    if not value:
        return False
    try:
        return date.fromisoformat(str(value)) < (on or datetime.now(timezone.utc).date())
    except ValueError:
        return True


def lapsed_exceptions(decision: Dict[str, Any], on: Optional[date] = None) -> List[Dict[str, Any]]:
    """The approving round's security exceptions that have expired: the veto stands again until a person decides."""
    if decision.get("outcome") not in ("APPROVED", "AWAITING_HUMAN"):
        return []
    return [item for item in current_exceptions(decision).values() if exception_expired(item, on)]


def exception_facts(decision: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every security exception recorded on the latest decision, who and why, as data."""
    current = {id(item) for item in current_exceptions(decision).values()}
    found = []
    for item in decision.get("exceptions") or [] if isinstance(decision.get("exceptions"), list) else []:
        if not isinstance(item, dict):
            continue
        found.append({"ref": clean(exception_ref(item), 40), "seat": clean(item.get("seat"), 40), "title": clean(item.get("title"), 200),
                      "rule": clean(item.get("rule")), "impact": item.get("impact") if item.get("impact") in IMPACTS else None,
                      "by": clean(item.get("by"), 80), "reason": clean(item.get("reason")), "recorded_at": clean(item.get("recorded_at"), 40),
                      "expires": clean(item.get("expires"), 10), "expired": exception_expired(item), "in_force": id(item) in current,
                      "head": clean(item.get("head"), 64), "source_file": "review/decision.json"})
    return found[:20]


def scan_facts(decision: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """What the security scan flagged on the latest decision and how it was answered: counts, places, package names and the
    answering seat's reasons as bounded data. Never a secret's value (the scan never recorded one). None when nothing was flagged."""
    summary = decision.get("security_scan")
    if not isinstance(summary, dict):
        return None
    if summary.get("enabled") is False:
        return {"enabled": False, "source_file": "review/decision.json"}
    secrets = [{"id": clean(item.get("id"), 10), "file": clean(item.get("file"), 200), "line": item.get("line") if isinstance(item.get("line"), int) else None,
                "kind": clean(item.get("kind"), 40), "answer": clean(item.get("answer"), 20), "reason": clean(item.get("reason")),
                "overridden_by_builder": bool(item.get("overridden_by_builder"))}
               for item in summary.get("secrets") or [] if isinstance(item, dict)][:20]
    deps = [{"id": clean(item.get("id"), 10), "name": clean(item.get("name"), 120), "version": clean(item.get("version"), 60), "change": clean(item.get("change"), 10),
             "ecosystem": clean(item.get("ecosystem"), 20), "dev": item.get("dev") if isinstance(item.get("dev"), bool) else None,
             "answer": clean(item.get("answer"), 20), "reason": clean(item.get("reason"))}
            for item in summary.get("dependencies") or [] if isinstance(item, dict)][:30]
    if not secrets and not deps and not summary.get("lockfile_only"):
        return None
    counts = summary.get("counts") if isinstance(summary.get("counts"), dict) else {}
    return {"enabled": True, "flagged": bool(summary.get("flagged")), "counts": {key: value for key, value in counts.items() if isinstance(value, int)},
            "secrets": secrets, "dependencies": deps, "lockfile_only": [clean(name, 200) for name in summary.get("lockfile_only") or []][:20],
            "panel_change": [clean(text, 300) for text in summary.get("panel_change") or []][:3], "source_file": "review/decision.json"}


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
    excepted = current_exceptions(decision)
    label = folder.name[len("round-"):] if folder.name.startswith("round-") else None
    found = []
    for path in sorted((folder / "votes").glob("*.json")) if (folder / "votes").is_dir() else []:
        vote = load_json(path, {})
        if not isinstance(vote, dict):
            continue
        seat = clean(vote.get("reviewer") or path.stem, 40)
        for number, finding in enumerate(vote.get("findings") or [], start=1):
            if not isinstance(finding, dict) or finding.get("severity") != "blocker":
                continue
            ref = f"{label}/{path.stem}/{number}" if label else None
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
                               round=decision.get("round") if isinstance(decision.get("round"), int) else None,
                               ref=ref, excepted=ref in excepted if ref else False))
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


_ROUNDS: List[Any] = []


def rounds_helper() -> Any:
    """The intent station's rounds.py, the one rule for how many rounds a ticket has, whichever way MACH is installed; None if absent."""
    if not _ROUNDS:
        import importlib.util
        skills = Path(__file__).resolve().parent.parent.parent
        script = next((folder / "scripts" / "rounds.py" for folder in (skills / "mach-intent", skills / "intent") if (folder / "scripts" / "rounds.py").is_file()), None)
        found = None
        if script is not None:
            try:
                spec = importlib.util.spec_from_file_location("mach_rounds_for_explain", script)
                found = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(found)
            except Exception:  # noqa: BLE001 - the same rule is applied below
                found = None
        _ROUNDS.append(found)
    return _ROUNDS[0]


def rounds_base(cell: Optional[Dict[str, Any]]) -> int:
    """Rounds a person's start set aside (cell.json rounds_base): a round counts as its own number less this."""
    helper = rounds_helper()
    if helper is not None:
        return helper.base(cell)
    value = cell.get("rounds_base") if isinstance(cell, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def max_rounds(config: Dict[str, Any], cell: Optional[Dict[str, Any]] = None) -> int:
    """The ticket's last round: review.max_loops plus the rounds a person granted it by carrying it on (cell.json extra_rounds)."""
    helper = rounds_helper()
    if helper is not None:
        return helper.limit(config, cell)
    value = (config.get("review") or {}).get("max_loops", 3) if isinstance(config.get("review"), dict) else 3
    base = value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 3
    extra = cell.get("extra_rounds") if isinstance(cell, dict) else None
    return base + (extra if isinstance(extra, int) and not isinstance(extra, bool) and extra > 0 else 0)


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
        written = record.get("change_record") if isinstance(record.get("change_record"), dict) else {}
        if isinstance(written.get("path"), str):  # M13: where the merge station's change record landed
            facts["change_record"] = clean(written["path"], 200)
        if "archive" in record:  # the archive the run record names, or none kept (cleanup.archive); never an older life's by its name
            named = record.get("archive")
            archive = root / named if isinstance(named, str) and named.startswith(".factory/archive/") and ".." not in named else None
    if archive is not None and archive.is_file():
        return {"headline_code": "archived", "archive": str(archive.relative_to(root)), "run_record": facts or None}, 0
    if record:
        kept = record.get("archive_kept") if isinstance(record.get("archive_kept"), dict) else {}
        evidence = "The evidence files were not kept after cleanup (cleanup.archive)." if "archive" in record else None
        if evidence and isinstance(kept.get("reason"), str):
            evidence += " " + clean(kept["reason"], 300)
        return {"headline_code": "finished", "archive": None, "run_record": facts, **({"evidence": evidence} if evidence else {})}, 0
    known = (factory / "tickets" / f"{ticket_id}.md").is_file() or (factory / "inbox" / f"{ticket_id}.json").is_file()
    if known:
        return {"headline_code": "not_started"}, 0
    return {"headline_code": "unknown_ticket",
            "detail": f"No cell, archive, run record, local ticket or inbox record exists for {ticket_id} in this project."}, 1


def started_before(cell: Dict[str, Any]) -> Optional[str]:
    """The sentence for a ticket a person started before a slice it depends on was merged (intake records it at their dispatch), or None."""
    early = [clean(name, 40) for name in cell.get("started_before") or [] if isinstance(name, str)][:5]
    if not early:
        return None
    return (f"It was started before {', '.join(early)}, which it depends on, {'was' if len(early) == 1 else 'were'} merged: "
            "a failure may come from that work missing.")


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
    limit = max_rounds(config, cell)
    base["max_rounds"] = limit
    build = load_json(cellroot / "build.json", {}) or {}
    report = load_json(cellroot / "build-report.json", {}) or {}
    summary = load_json(cellroot / "evidence" / "summary.json", {}) or {}
    decision = load_json(cellroot / "review" / "decision.json", {}) or {}
    index = spec_index(load_json(cellroot / "spec.json", {}))
    records = read_lines(cellroot / "lifecycle.jsonl")
    review_settings = config.get("review") if isinstance(config.get("review"), dict) else {}
    seat_veto_on = review_settings.get("security_veto") is not False

    loop = build.get("loop") if isinstance(build.get("loop"), int) and not isinstance(build.get("loop"), bool) else 0
    used = max(loop + 1 - rounds_base(cell), 0) if (cellroot / "build.json").is_file() else 0  # rounds a person's start set aside do not count
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
            failed_round, _, headline, causes, findings_file = candidates[-1]
            base["findings_file"] = findings_file if findings_file and (cellroot / findings_file).is_file() else None
            base["last_failure"] = {"station": LAST_FAILURE_STATION.get(headline), "round": failed_round if isinstance(failed_round, int) else None}
        incomplete = refused_gate(records, "verify") if stage == "built" else None
        if incomplete and incomplete.get("reason_code") == "incomplete-evidence" and (not candidates or candidates[-1][0] < loop + 1):
            headline = "verification_incomplete"
            base["last_failure"] = {"station": "verify", "round": loop + 1}
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
                                   detail=f"It failed round {used} of {limit}, the last, so it stopped for a person. A person can carry it on with a fix: "
                                          "the builder gets one more round on the same branch, with these findings and their words."))
    elif stage in ("approved", "pr-open"):
        gate = refused_gate(records, "merge")
        if gate:
            headline = "merge_refused"
            causes.append(cause("merge", clean(gate.get("reason_code"), 60), index, source_file="lifecycle.jsonl",
                                detail=f"The {clean(gate.get('gate'), 60)} gate refused ({clean(gate.get('reason_code'), 60) or 'no reason code'})."))

    if decision.get("outcome") in ("APPROVED", "AWAITING_HUMAN") and not decision.get("rejected_by"):
        base["outvoted_blockers"] = review_blockers(cellroot, decision, index, seat_veto_on)
    exceptions = exception_facts(decision)
    if exceptions:
        base["security_exceptions"] = exceptions
        if isinstance(decision.get("approvals_after_exception"), int):
            base["exception_recount"] = {"approvals_before": decision.get("approvals_before_exception"), "approvals_after": decision.get("approvals_after_exception"),
                                         "rejects_cleared": [clean(seat, 40) for seat in decision.get("rejects_cleared_by_exception") or []][:3],
                                         "source_file": "review/decision.json"}
    scanned = scan_facts(decision)
    if scanned:
        base["security_scan"] = scanned
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
    if nxt.get("needs") == "adr-baseline":  # no ticket is planned until the required topics have accepted ADRs
        facts = dict(facts or {}, baseline_missing=[clean(topic, 40) for topic in next_info.get("missing_topics") or []][:20])
    if facts:
        base["adrs"] = facts
    held = policy_facts(cellroot, cell)
    if held:
        base["policies"] = held
    lanes = lanes_facts(cellroot)  # M22: nothing for a build without lanes
    if lanes:
        base["lanes"] = lanes
    carried = [{"n": item.get("n") if isinstance(item.get("n"), int) else None, "by": clean(item.get("by"), 80), "at": clean(item.get("at"), 40),
                "round": item.get("round") if isinstance(item.get("round"), int) else None,
                "max_rounds": item.get("max_rounds") if isinstance(item.get("max_rounds"), int) else None,
                "guidance_file": clean(item.get("guidance"), 60), "source_file": "cell.json"}
               for item in cell.get("carried_on") or [] if isinstance(item, dict)] if isinstance(cell.get("carried_on"), list) else []
    if carried:  # a person carried this ticket on after it stopped: who, when, and the round it was given
        base["carried_on"] = carried[-10:]
    early = started_before(cell)
    if early and (used or base["headline_code"]):  # it failed or waits, and it was started before what it depends on was merged
        base["started_before"] = early
    mode = summary.get("evidence_mode")
    if isinstance(mode, dict) and mode.get("mode") == "headless":  # verified without screenshots: said so, and why
        base["verification_evidence"] = {"mode": "headless", "said": clean(mode.get("said"), 300), "why": clean(mode.get("why"), 300),
                                         "source_file": "evidence/summary.json"}
    return base, 0


# ---------------------------------------------------------------- a build in lanes (M22)

LANE_RE = re.compile(r"^L\d{1,3}$")
STATION = "build station"
SET_ASIDE, INTERACTION = "lane-set-aside", "lanes-interaction"
# The builder's own overrides (build.py). One of these made in a lane is an override like any other, said with the rest; a
# deviation of any other type recorded in a lane, or by the build station, is said here with its recorded words.
BUILDER_OVERRIDES = ("no-baseline", "test-amended", "files-outside-plan", "not-a-secret", "test-written-early", "test-passed-first-run",
                     "red-not-attributed", "impl-already-done")


def _ids(value: Any) -> List[str]:
    return [clean(item, 20) or "" for item in value if isinstance(item, str)][:50] if isinstance(value, list) else []


def _set_aside_words(because: Dict[str, Any]) -> str:
    other, file, why = clean(because.get("other"), 10), clean(because.get("file"), 200), because.get("why")
    if why == "same-file":
        return f"it and lane {other} both changed {file}"
    if why == "frozen-test":
        return f"one of it and lane {other} changed {file}, a test file the other holds"
    if why == "case-clash":
        return f"its file {file} and a file of lane {other} differ only by letter case"
    if why == "file-folder":
        return f"{file} is a file in one of it and lane {other} and a folder in the other"
    if why == "branch-moved":
        return f"a commit made on the ticket's branch while the lanes were open also changed {file}"
    if why == "did-not-apply":
        return f"its commit {clean(because.get('commit'), 10)} did not apply on the landed work"
    if why == "unrecorded-commits":
        return "its branch held commits no task recorded"
    if why == "lane-history":
        return "its recorded commits were not one chain from the fork point"
    return f"{clean(why, 40)}: {file}, with lane {other}"


def lanes_facts(cellroot: Path) -> Optional[Dict[str, Any]]:
    """What the build station recorded of a build in lanes, in plain words: that it ran in lanes, or is at its lanes now
    with how far each has got; a lane set aside and what was done; lanes that failed only together and the fix task; and
    any other deviation the station or a lane recorded, with its recorded words. None for a build without lanes, so a
    ticket built one task at a time is explained exactly as before. Reads build.json, each lanes/<L>/lane.json and
    build-report.json; nothing is inferred: a number not recorded is said to be so."""
    build = load_json(cellroot / "build.json", {}) or {}
    report = load_json(cellroot / "build-report.json", {}) or {}
    record = build.get("lanes") if isinstance(build, dict) and isinstance(build.get("lanes"), dict) else None
    if record is None and isinstance(report, dict) and isinstance(report.get("lanes"), dict):
        record = report["lanes"]
    if record is None or not isinstance(record.get("lanes"), list):
        return None
    state = record.get("state") if record.get("state") in ("planned", "open", "joined", "sequential") else None
    tasks = {t.get("id"): t for t in (build.get("tasks") if isinstance(build.get("tasks"), list) else []) if isinstance(t, dict)}
    deviations = [d for d in (build.get("deviations") if isinstance(build.get("deviations"), list) else report.get("deviations") or []) if isinstance(d, dict)]
    lanes = []
    for entry in record["lanes"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("lane"), str) or not LANE_RE.match(entry["lane"]):
            continue
        item = {"lane": entry["lane"], "tasks": _ids(entry.get("tasks")), "status": clean(entry.get("status"), 20), "done": None, "of": None, "last_step_at": None}
        own = load_json(cellroot / "lanes" / entry["lane"] / "lane.json", {}) if state == "open" else None
        if isinstance(own, dict) and isinstance(own.get("tasks"), list):
            item.update({"status": clean(own.get("status"), 20) or item["status"], "of": len(own["tasks"]),
                         "done": sum(1 for t in own["tasks"] if isinstance(t, dict) and t.get("status") == "done"),
                         "last_step_at": clean(own.get("last_step_at"), 40)})
        elif state == "open":
            item["of"] = len(item["tasks"])
        lanes.append(item)
    facts: Dict[str, Any] = {"state": state, "count": len(lanes), "lanes": lanes, "source_file": "build.json"}
    join = record.get("join") if isinstance(record.get("join"), dict) else {}
    if state == "joined":
        facts["joined_at"] = clean(join.get("tip"), 64)
        facts["joined_suite_passed"] = (join.get("suite") or {}).get("passed") if isinstance(join.get("suite"), dict) else None
    aside, recorded = [], []
    interaction = None
    for item in deviations:
        kind = item.get("type")
        if kind == SET_ASIDE:
            name = clean(item.get("lane"), 10)
            held = next((lane["tasks"] for lane in lanes if lane["lane"] == item.get("lane")), [])
            because = [b for b in item.get("because") or [] if isinstance(b, dict)]
            done = sum(1 for ident in held if (tasks.get(ident) or {}).get("status") == "done")
            aside.append({"lane": name, "tasks": held, "done": done if tasks else None,
                          "text": f"Lane {name} was set aside at the join: " + ("; ".join(_set_aside_words(b) for b in because[:10]) or "why was not recorded")
                                  + ". Its commits were not landed" + (f"; they are kept under {clean(item.get('kept_as'), 120)}" if item.get("kept_as") else "")
                                  + f"; its tasks ({', '.join(held) or 'not recorded'}) are built again in the cell, one at a time"
                                  + (f": {done} of {len(held)} done." if tasks and held else "."),
                          "detail": clean(item.get("detail"))})
        elif kind == INTERACTION:
            fix = clean(item.get("task"), 20) or "J-T01"
            status = (tasks.get(item.get("task")) or {}).get("status")
            failing = [clean(name, 200) for name in item.get("failing") or [] if isinstance(name, str)][:10]
            involved = _ids(item.get("lanes"))
            interaction = {"task": fix, "status": clean(status, 20), "failing": failing, "lanes": involved,
                           # Only what was recorded: each landed lane's own suite at its end (the station records lanes_passed_alone).
                           "text": ("Every landed lane's own suite was passing at its end, but the whole suite failed on the joined result"
                                    if item.get("lanes_passed_alone") is True else "The lanes' work landed, but the whole suite failed on the joined result")
                                   + (f" ({', '.join(failing)})" if failing else "") + (f"; lanes involved: {', '.join(involved)}" if involved else "")
                                   + f". {fix} was added to make them pass together; " + ("it is done." if status == "done" else "it is still to do." if status else "its state is not recorded."),
                           "detail": clean(item.get("detail"))}
        elif item.get("by") == STATION or (item.get("lane") and kind not in BUILDER_OVERRIDES):
            who = "The build station" if item.get("by") == STATION else f"Lane {clean(item.get('lane'), 10)}"
            recorded.append({"task": clean(item.get("task"), 20), "lane": clean(item.get("lane"), 10), "type": clean(kind, 60), "detail": clean(item.get("detail")),
                             "text": f"{who} recorded {clean(kind, 60) or 'a deviation'}" + (f" for {clean(item.get('task'), 20)}" if item.get("task") else "")
                                     + f": {clean(item.get('detail')) or '(no words recorded)'}"})
    if aside:
        facts["set_aside"] = aside
    if interaction:
        facts["interaction"] = interaction
    if recorded:
        facts["recorded"] = recorded
    facts["summary"] = lanes_summary(facts, record)
    return facts


def lanes_summary(facts: Dict[str, Any], record: Dict[str, Any]) -> str:
    """One plain sentence on where a build in lanes stands."""
    lanes, count = facts["lanes"], facts["count"]
    state = facts["state"]
    if state == "open":
        each = ", ".join(f"{lane['lane']} {lane['done'] if lane['done'] is not None else 'not recorded'} of {lane['of']} done"
                         + (" (finished)" if lane["status"] == "done" else "") for lane in lanes)
        return f"The build is at its lanes: {count} lanes, built at the same time ({each}). When every lane is done the line joins them."
    if state == "planned":
        return (f"The build is planned in {count} lanes (" + "; ".join(f"{lane['lane']}: {', '.join(lane['tasks'])}" for lane in lanes)
                + "). The line opens them once the tasks before the lanes are done.")
    if state == "sequential":
        return f"Lanes were planned for this build but did not run: {clean(record.get('why')) or 'why was not recorded'}"
    if state == "joined":
        passed = facts.get("joined_suite_passed")
        return (f"The build ran in {count} lanes, joined at commit {facts.get('joined_at') or '(not recorded)'}"
                + (f"; {len(facts['set_aside'])} lane{'s' if len(facts['set_aside']) != 1 else ''} set aside" if facts.get("set_aside") else "")
                + ("; the whole suite passed on the joined result." if passed is True else "; the whole suite failed on the joined result." if passed is False
                   else "; whether the whole suite passed on the joined result is not recorded."))
    return f"The build has {count} lanes; their state is not recorded."


def lanes_line(cellroot: Path) -> Optional[str]:
    """The one sentence for a ticket's digest (run.py's `digest`), or None for a build without lanes."""
    facts = lanes_facts(cellroot)
    return facts["summary"] if facts else None


def human(report: Dict[str, Any]) -> str:
    """A short plain list. Quoted text came from a reviewer, the verifier or a test run and is shown as data."""
    lines = []
    digest = report.get("digest") or {}
    for key, label in (("where", "Where"), ("needs_person", "A person must decide"), ("time_and_cost", "Time and cost"), ("lanes", "Lanes")):
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
        kind = "excepted security blocker" if item.get("excepted") else "outvoted blocker"
        lines.append(f"- {kind} from the {item.get('seat')} seat: {item.get('file') or '-'}" + (f' cites "{item["rule"]}"' if item.get("rule") else ""))
    for item in report.get("security_exceptions") or []:
        state = "expired" if item.get("expired") else "in force" if item.get("in_force") else "renewed"
        lines.append(f"- [security exception] {item['ref']} accepted by {item.get('by')}" + (f" until {item['expires']}" if item.get("expires") else "")
                     + f" ({state}): \"{item.get('reason') or ''}\"")
    recount = report.get("exception_recount") or {}
    if recount:
        lines.append(f"- [security exception] approvals {recount.get('approvals_before')} before, {recount.get('approvals_after')} after"
                     + (f"; reject votes cleared: {', '.join(recount.get('rejects_cleared') or [])}" if recount.get("rejects_cleared") else ""))
    scanned = report.get("security_scan") or {}
    if scanned.get("enabled") is False:
        lines.append("- [security scan] switched off for this review (security.scan.enabled is false)")
    for item in scanned.get("secrets") or []:
        lines.append(f"- [security scan] {item['id']} possible secret ({item['kind']}) at {item['file']}:{item['line']}: answered {item.get('answer') or 'none'}"
                     + (" (the builder recorded it as not a secret)" if item.get("overridden_by_builder") else "") + (f': "{item["reason"]}"' if item.get("reason") else ""))
    for item in scanned.get("dependencies") or []:
        lines.append(f"- [security scan] {item['id']} {item['ecosystem']} {item['name']} {item.get('version') or ''} {item['change']}: answered {item.get('answer') or 'none'}"
                     + (f': "{item["reason"]}"' if item.get("reason") else ""))
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
    if facts.get("baseline_missing"):
        lines.append(f"- [adr] required topics with no accepted ADR on the main branch: {', '.join(facts['baseline_missing'])}; no ticket is planned until each has one")
    if facts.get("not_checked"):
        lines.append(f"- [adr] {facts['not_checked']}")
    held = report.get("policies") or {}
    for item in held.get("open_concerns") or []:
        lines.append(f"- [policy] {item['statement_id']} of {item['pack']} waits for its owner, {item.get('owner') or 'not named'}: "
                     f"\"{item.get('statement') or ''}\" cannot be met: \"{item.get('why') or ''}\"")
    for item in held.get("acceptances") or []:
        lines.append(f"- [policy] {item['statement_id']} accepted by {item.get('by')} ({item.get('owner_check') or 'how the name was checked is not recorded'}): "
                     f"\"{item.get('reason') or ''}\"")
    if held.get("not_checked"):
        lines.append(f"- [policy] {held['not_checked']}")
    for line in digest.get("rules_changed") or []:
        lines.append(f"- [older rules] {line}")
    headless = report.get("verification_evidence") or {}
    if headless:
        lines.append(f"- [verification] {headless.get('said') or ''} {headless.get('why') or ''}".rstrip())
    lanes = report.get("lanes") or {}
    if lanes:  # M22: only for a build in lanes
        if digest.get("lanes") != lanes.get("summary"):
            lines.append(f"- [lanes] {lanes.get('summary')}")
        if lanes.get("state") == "open":
            for lane in lanes.get("lanes") or []:
                lines.append(f"- [lanes] {lane['lane']} ({', '.join(lane.get('tasks') or [])}): "
                             f"{lane['done'] if lane.get('done') is not None else 'not recorded'} of {lane.get('of')} done, {lane.get('status') or 'status not recorded'}"
                             + (f", last step at {lane['last_step_at']}" if lane.get("last_step_at") else ""))
        for item in lanes.get("set_aside") or []:
            lines.append(f"- [lanes] {item['text']}")
        if lanes.get("interaction"):
            lines.append(f"- [lanes] {lanes['interaction']['text']}")
        for item in lanes.get("recorded") or []:
            lines.append(f"- [lanes] {item['text']}")
    if report.get("evidence"):  # a finished ticket whose archive was not kept: said plainly, not as something missing
        lines.append(report["evidence"])
    if report.get("headline_code") not in ("unknown_ticket", "archived", "finished"):
        lines.append(f"Rounds: {report['rounds_used']} of {report['max_rounds']} used, {report['rounds_left']} left.")
    nxt = report.get("next") or {}
    if nxt.get("action"):
        lines.append(f"Next: {nxt['action']}" + (f" ({nxt['reason']})" if nxt.get("reason") else ""))
    elif report.get("detail"):
        lines.append(report["detail"])
    return "\n".join(lines)
