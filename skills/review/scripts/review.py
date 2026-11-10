#!/usr/bin/env python3
"""MACH review station: seat a panel, count its votes, and decide what happens next.

Reviewers (models, each in a fresh context) read the change and write findings. This script
decides everything a script can decide: whether review may start, who sits on the panel and on
which model, what a valid finding looks like, each reviewer's vote, and the outcome.

    review.py start <ticket>                                   check the gates, write the review packet
    review.py submit <ticket> --reviewer ROLE --findings FILE  one reviewer's findings; the vote follows from them
    review.py tally <ticket>                                   count the votes and decide
    review.py approve-human <ticket> --by NAME                 record a person's sign-off
    review.py status <ticket>

A reviewer never states a vote. A submission with at least one blocker is a REJECT; one with
none is an APPROVE. A blocker must name the rule or spec ID it breaks and the file that shows it.

    High risk    3 reviewers, 3 approvals, and a person must approve
    Medium risk  3 reviewers, 2 approvals
    Low risk     1 reviewer,  1 approval
    Tuning       a ticket labelled factory-tuning: 3 reviewers on the strongest tier, 3 approvals, and no person,
                 provided it changes only the factory's rule files (and its own spec and tests)

The third failed round for a ticket, counting failed verifications, is escalated to a person.

Standard library only.
"""

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
ROLES = {
    "architecture": "Architecture: layering, contracts, dead code, size and shape of the change.",
    "security": "Security and performance: input handling, secrets, permissions, resource use, failure behavior.",
    "product": "Product: the spec's requirements, messages and side effects, checked against the evidence.",
    "general": "General: one reviewer covering architecture, security and product for a low-risk change.",
}
PANELS = {
    "High": {"reviewers": 3, "approvals": 3, "human_approval": True},
    "Medium": {"reviewers": 3, "approvals": 2, "human_approval": False},
    "Low": {"reviewers": 1, "approvals": 1, "human_approval": False},
}
SEVERITIES = ("blocker", "note")
MAX_LOOPS = 3
TUNING_LABEL = "factory-tuning"
# What a ticket that tunes the factory's own rules may change without a person: the rule files, and its own spec and tests.
TUNING_FILES_RE = re.compile(
    r"^(REVIEW|CLAUDE|AGENTS)\.md$|(^|/)SKILL\.md$|(^|/)skills/[^/]+/references/[^/]+$|^specs/slices/[^/]+\.md$"
    r"|(^|/)(tests?|__tests__|spec)/|(^|/)(test_[^/]+|[^/]+_test\.[A-Za-z]+|[^/]+\.(test|spec)\.[A-Za-z]+)$"
)


# Files that running a build or test suite leaves behind. They are never part of a change, so the
# gates ignore them even when the project forgot to git-ignore them.
BYPRODUCT_RE = re.compile(
    r"(^|/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|htmlcov|\.hypothesis|node_modules|\.gradle|\.next|\.turbo|coverage)(/|$)"
    r"|\.py[co]$|(^|/)\.coverage(\..*)?$|(^|/)\.DS_Store$|\.egg-info(/|$)|\.tsbuildinfo$"
)


def is_byproduct(name: str) -> bool:
    return bool(BYPRODUCT_RE.search(name))


class ReviewError(Exception):
    """A gate refused. Printed without a traceback; exit code 1."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, errors="replace")


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


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


class Cell:
    def __init__(self, project: Path, ticket_id: str) -> None:
        if not TICKET_ID_RE.match(ticket_id):
            raise ReviewError(f"'{ticket_id}' is not a usable ticket ID.")
        self.project = project
        self.ticket_id = ticket_id
        self.root = project / ".factory" / "worktrees" / ticket_id
        self.info = load_json(self.root / "cell.json")
        if not isinstance(self.info, dict):
            raise ReviewError(f"No cell for {ticket_id}.")
        self.build = load_json(self.root / "build-report.json", {}) or {}
        self.summary = load_json(self.root / "evidence" / "summary.json", {}) or {}
        config = load_json(project / ".factory" / "config.json", {})
        self.config = config if isinstance(config, dict) else {}
        self.loop = int(self.build.get("review_loop") or 0)
        self.folder = self.root / "review" / f"round-{self.loop + 1}"
        self.packet: Dict[str, Any] = load_json(self.folder / "packet.json", {}) or {}

    @property
    def work(self) -> Path:
        return self.root / "repo" if self.info.get("isolation") == "worktree" else self.project

    def section(self, name: str) -> Dict[str, Any]:
        value = self.config.get(name)
        return value if isinstance(value, dict) else {}

    def head(self) -> str:
        return git(self.work, "rev-parse", "HEAD").stdout.strip()

    def save_info(self) -> None:
        self.info["updated_at"] = now()
        write_json(self.root / "cell.json", self.info)

    def require_started(self) -> None:
        if not self.packet or self.packet.get("head") != self.head():
            raise ReviewError(f"Review has not started for this build of {self.ticket_id}. Run: review.py start {self.ticket_id}")

    def max_loops(self) -> int:
        value = self.section("review").get("max_loops", MAX_LOOPS)
        return value if isinstance(value, int) and value > 0 else MAX_LOOPS

    def votes(self) -> Dict[str, Dict[str, Any]]:
        found = {}
        for seat in self.packet.get("panel", []):
            vote = load_json(self.folder / "votes" / f"{seat['role']}.json")
            if isinstance(vote, dict):
                found[seat["role"]] = vote
        return found


def ticket_labels(cell: Cell) -> List[str]:
    labels = list((load_json(cell.project / ".factory" / "inbox" / f"{cell.ticket_id}.json", {}) or {}).get("labels") or [])
    local = cell.project / ".factory" / "tickets" / f"{cell.ticket_id}.md"
    if local.is_file():
        front = re.match(r"^---\n(.*?)\n---", local.read_text(encoding="utf-8"), re.DOTALL)
        line = re.search(r"^labels:\s*(.*)$", front.group(1), re.MULTILINE) if front else None
        if line:
            labels += [a or b for a, b in re.findall(r'"([^"]*)"|([^\s,\[\]"]+)', line.group(1))]
    return labels


def panel_for(cell: Cell, risk: str, tuning: bool = False) -> Dict[str, Any]:
    if tuning:
        # A change to the factory's own rules: the full panel on the strongest tier must agree, and that is the whole decision.
        model = cell.section("models").get("contracts", "opus")
        return {"reviewers": 3, "approvals": 3, "human_approval": False,
                "panel": [{"role": role, "focus": ROLES[role], "model": model} for role in ("architecture", "security", "product")]}
    rules = dict(PANELS[risk])
    override = cell.section("review").get(risk.lower())
    if isinstance(override, dict):
        for key in ("reviewers", "approvals"):
            if isinstance(override.get(key), int) and override[key] > 0:
                rules[key] = override[key]
        if isinstance(override.get("human_approval"), bool):
            rules["human_approval"] = override["human_approval"]
    rules["reviewers"] = 3 if rules["reviewers"] >= 2 else 1  # a panel is three seats or one; never fewer than asked for
    rules["approvals"] = min(rules["approvals"], rules["reviewers"])
    models = cell.section("models")
    model = models.get("contracts", "opus") if risk == "High" else models.get("build", "sonnet")
    roles = ["architecture", "security", "product"] if rules["reviewers"] == 3 else ["general"]
    rules["panel"] = [{"role": role, "focus": ROLES[role], "model": model} for role in roles]
    return rules


def cmd_start(cell: Cell, args: argparse.Namespace) -> int:
    stage = cell.info.get("stage")
    if stage != "verified":
        raise ReviewError(f"The cell's stage is '{stage}'. Only a verified cell can be reviewed; the verify station must pass it first.")
    head = cell.head()
    if cell.summary.get("status") != "PASS":
        raise ReviewError("There is no passing verification for this cell (evidence/summary.json). Review needs evidence, not claims.")
    if cell.summary.get("head") != head or cell.build.get("head") != head:
        raise ReviewError("The cell's code changed after it was built or verified. Build and verify it again before review.")
    dirty = [line[3:].strip().strip('"') for line in git(cell.work, "status", "--porcelain", "--untracked-files=all").stdout.splitlines() if line.strip()]
    if [name for name in dirty if not is_byproduct(name)]:
        raise ReviewError("The cell has uncommitted changes. Review covers exactly what was built and verified.")
    missing = [entry["file"] for entry in cell.summary.get("evidence_files") or [] if not (cell.root / "evidence" / entry["file"]).is_file()]
    if missing:
        raise ReviewError(f"Evidence listed in the verification summary is missing: {', '.join(missing[:5])}. Verify the ticket again.")
    risk = cell.info.get("risk") if cell.info.get("risk") in PANELS else "High"
    tuning = TUNING_LABEL in ticket_labels(cell)
    rules = panel_for(cell, risk, tuning)
    reasons = []
    if rules["human_approval"]:
        reasons.append(f"the change is {risk} risk")
    audit_note = (load_json(cell.root / "build.json", {}) or {}).get("audit") or {}
    if audit_note.get("human_review_required"):
        reasons.append(f"the repository's readiness tier is {audit_note.get('tier')}")
    elif cell.info.get("human_review_required") and not rules["human_approval"]:
        reasons.append("the build station marked it for a person's review")
    if tuning:
        reasons = []  # decided by the unanimous panel; see the file check below
    human = bool(reasons)
    # Review everything the ticket's branch adds, including the spec and contracts committed before the build started.
    main_branch = git(cell.project, "branch", "--show-current").stdout.strip()
    fork = git(cell.work, "merge-base", "HEAD", main_branch).stdout.strip() if main_branch and cell.info.get("isolation") == "worktree" else ""
    baseline = fork if fork and fork != head else cell.build.get("baseline")
    cell.folder.mkdir(parents=True, exist_ok=True)
    for stale in (cell.folder / "votes").glob("*.json") if (cell.folder / "votes").is_dir() else []:
        stale.unlink()
    diff = git(cell.work, "diff", f"{baseline}..{head}").stdout
    (cell.folder / "diff.patch").write_text(diff, encoding="utf-8")
    previous = cell.root / "review" / f"round-{cell.loop}" / "findings.md"
    verify_findings = sorted((cell.root / "evidence").glob("previous-*/findings.md"))
    review_rules = next((p for p in (cell.work / "REVIEW.md", cell.project / "REVIEW.md") if p.is_file()), None)
    cell.packet = {
        "ticket_id": cell.ticket_id, "slice_id": cell.info.get("slice_id"), "round": cell.loop + 1, "max_rounds": cell.max_loops(),
        "risk": risk, "approvals_needed": rules["approvals"], "human_approval_required": human, "human_approval_reasons": reasons,
        "head": head, "baseline": baseline, "branch": cell.info.get("branch"), "started_at": now(),
        "panel": rules["panel"],
        "paths": {
            "workdir": str(cell.work), "diff": str(cell.folder / "diff.patch"), "review_rules": str(review_rules) if review_rules else None,
            "intent": str(cell.root / "intent.md"), "spec": str(cell.root / "spec.json"), "plan": str(cell.root / "plan.md"),
            "build_report": str(cell.root / "build-report.json"), "evidence_summary": str(cell.root / "evidence" / "summary.json"),
            "evidence_dir": str(cell.root / "evidence"), "review_dir": str(cell.folder),
            "earlier_findings": [str(p) for p in ([previous] if previous.is_file() else []) + verify_findings],
        },
        "diff_stat": git(cell.work, "diff", "--shortstat", f"{baseline}..{head}").stdout.strip(),
        "files_changed": git(cell.work, "diff", "--name-only", f"{baseline}..{head}").stdout.split(),
    }
    if tuning:
        outside = [name for name in cell.packet["files_changed"] if not TUNING_FILES_RE.search(name)]
        if outside:
            cell.packet["human_approval_reasons"] = ["the tuning ticket changes files other than the factory's rules: " + ", ".join(outside[:6])]
            cell.packet["human_approval_required"] = True
    cell.packet["tuning"] = tuning
    write_json(cell.folder / "packet.json", cell.packet)
    print(json.dumps({"status": "STARTED", "packet": str(cell.folder / "packet.json"), **{k: cell.packet[k] for k in (
        "round", "max_rounds", "risk", "tuning", "approvals_needed", "human_approval_required", "human_approval_reasons", "panel", "diff_stat")},
        "next": "Start one fresh reviewer per panel seat, in parallel, each on its seat's model. Then run tally."}, indent=2))
    return 0


def check_findings(cell: Cell, data: Any) -> List[Dict[str, Any]]:
    if not isinstance(data, dict) or not isinstance(data.get("findings"), list) or not isinstance(data.get("summary"), str) or len(data["summary"].split()) < 8:
        raise ReviewError('The findings file must be a JSON object: {"summary": "<two or three sentences on what you reviewed and concluded>", "findings": [...]}.')
    clean: List[Dict[str, Any]] = []
    for number, finding in enumerate(data["findings"], start=1):
        label = f"Finding {number}"
        if not isinstance(finding, dict):
            raise ReviewError(f"{label} must be an object.")
        severity = finding.get("severity")
        if severity not in SEVERITIES:
            raise ReviewError(f"{label}: 'severity' must be 'blocker' (must be fixed before merge) or 'note' (worth knowing, does not block).")
        title, detail = finding.get("title"), finding.get("detail")
        if not isinstance(title, str) or not title.strip() or not isinstance(detail, str) or len(detail.split()) < 6:
            raise ReviewError(f"{label}: needs a 'title' and a 'detail' that says what is wrong and what would fix it.")
        name, line, rule = finding.get("file"), finding.get("line"), finding.get("rule")
        if severity == "blocker":
            if not isinstance(rule, str) or not rule.strip():
                raise ReviewError(f"{label}: a blocker must name the 'rule' it breaks: a spec ID such as FR-04, or the REVIEW.md or CLAUDE.md rule, quoted or named.")
            if not isinstance(name, str) or not name.strip():
                raise ReviewError(f"{label}: a blocker must name the 'file' that shows the problem (a path in the cell's checkout, or evidence/<file>).")
        if isinstance(name, str) and name.strip():
            path = cell.root / name if name.startswith(("evidence/", "review/")) or name in ("plan.md", "intent.md", "spec.json", "build-report.json") else cell.work / name
            resolved = path.resolve()
            inside = any(base.resolve() == resolved or base.resolve() in resolved.parents for base in (cell.work, cell.root))
            if not inside or not path.is_file():
                raise ReviewError(f"{label}: file '{name}' does not exist in the cell. Use a path relative to the checkout, or evidence/<file>.")
            if line is not None:
                count = len(path.read_text(encoding="utf-8", errors="replace").splitlines())
                if not isinstance(line, int) or isinstance(line, bool) or line < 1 or line > max(count, 1):
                    raise ReviewError(f"{label}: line {line} is not a line of {name} (it has {count}).")
        elif line is not None:
            raise ReviewError(f"{label}: 'line' needs a 'file'.")
        clean.append({"severity": severity, "title": " ".join(title.split()), "detail": detail.strip(), "file": name or None,
                      "line": line if isinstance(line, int) else None, "rule": rule.strip() if isinstance(rule, str) and rule.strip() else None})
    return clean


def cmd_submit(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    seats = {seat["role"] for seat in cell.packet["panel"]}
    if args.reviewer not in seats:
        raise ReviewError(f"'{args.reviewer}' is not a seat on this panel. Seats: {', '.join(sorted(seats))}.")
    target = cell.folder / "votes" / f"{args.reviewer}.json"
    if target.is_file():
        raise ReviewError(f"The {args.reviewer} reviewer has already voted in this round. A vote is not revised; a new round follows a new build.")
    source = Path(args.findings)
    data = load_json(source)
    if data is None:
        raise ReviewError(f"{source} is missing or is not valid JSON.")
    findings = check_findings(cell, data)
    blockers = sum(1 for finding in findings if finding["severity"] == "blocker")
    vote = "REJECT" if blockers else "APPROVE"
    write_json(target, {"reviewer": args.reviewer, "vote": vote, "summary": " ".join(data["summary"].split()), "findings": findings,
                        "head": cell.packet["head"], "at": now()})
    print(json.dumps({"status": "RECORDED", "reviewer": args.reviewer, "vote": vote, "blockers": blockers, "notes": len(findings) - blockers}, indent=2))
    return 0


def findings_markdown(cell: Cell, votes: Dict[str, Dict[str, Any]], outcome: str) -> str:
    lines = [f"# Review findings for {cell.ticket_id}, round {cell.packet['round']} of {cell.packet['max_rounds']}", "",
             f"Outcome: {outcome}. " + ", ".join(f"{role}: {vote['vote']}" for role, vote in votes.items()) + ".", ""]
    for severity, heading in (("blocker", "Blockers: each must be fixed"), ("note", "Notes: do not block")):
        items = [(role, finding) for role, vote in votes.items() for finding in vote["findings"] if finding["severity"] == severity]
        if not items:
            continue
        lines += [f"## {heading}", ""]
        for number, (role, finding) in enumerate(items, start=1):
            where = f"`{finding['file']}" + (f":{finding['line']}`" if finding.get("line") else "`") if finding.get("file") else "no file"
            rule = f" Breaks: {finding['rule']}." if finding.get("rule") else ""
            lines.append(f"{number}. **{finding['title']}** ({role}; {where}).{rule} {finding['detail']}")
        lines.append("")
    return "\n".join(lines)


def cmd_tally(cell: Cell, args: argparse.Namespace) -> int:
    cell.require_started()
    earlier = load_json(cell.folder / "decision.json")
    if isinstance(earlier, dict) and earlier.get("head") == cell.packet["head"]:
        raise ReviewError(f"This round was already tallied: {earlier.get('outcome')}. A decision is not recounted; a new round follows a new build.")
    votes = cell.votes()
    absent = [seat["role"] for seat in cell.packet["panel"] if seat["role"] not in votes]
    if absent:
        raise ReviewError(f"No vote yet from: {', '.join(absent)}. Every seat must submit findings before the tally.")
    approvals = sum(1 for vote in votes.values() if vote["vote"] == "APPROVE")
    needed = cell.packet["approvals_needed"]
    blockers = sum(1 for vote in votes.values() for finding in vote["findings"] if finding["severity"] == "blocker")
    if approvals >= needed:
        outcome = "AWAITING_HUMAN" if cell.packet["human_approval_required"] else "APPROVED"
    else:
        outcome = "ESCALATE" if cell.packet["round"] >= cell.packet["max_rounds"] else "REJECTED"
    findings_path = cell.folder / "findings.md"
    findings_path.write_text(findings_markdown(cell, votes, outcome), encoding="utf-8")
    decision = {
        "ticket_id": cell.ticket_id, "round": cell.packet["round"], "risk": cell.packet["risk"], "outcome": outcome,
        "approvals": approvals, "approvals_needed": needed, "votes": {role: vote["vote"] for role, vote in votes.items()},
        "blockers": blockers, "human_approval_required": cell.packet["human_approval_required"],
        "human_approval_reasons": cell.packet.get("human_approval_reasons", []), "human_approval": None,
        "head": cell.packet["head"], "findings": str(findings_path), "decided_at": now(),
    }
    write_json(cell.folder / "decision.json", decision)
    write_json(cell.root / "review" / "decision.json", decision)
    cell.info["stage"] = {"APPROVED": "approved", "AWAITING_HUMAN": "awaiting-human", "REJECTED": "built", "ESCALATE": "blocked"}[outcome]
    cell.info["review"] = outcome
    cell.save_info()
    overruled = [role for role, vote in votes.items() if vote["vote"] == "REJECT"] if approvals >= needed else []
    next_step = {
        "APPROVED": f"Approved. The branch {cell.info.get('branch')} may be merged.",
        "AWAITING_HUMAN": "The panel approved, but a person must approve before merge because " + (" and ".join(cell.packet.get("human_approval_reasons") or []) or "the project requires it")
        + ". Show them the findings and wait; record their decision with approve-human.",
        "REJECTED": f"Post the findings on the ticket, then return it to the build station: build revise {cell.ticket_id} --findings {findings_path}",
        "ESCALATE": f"This was failed round {cell.packet['round']} of {cell.packet['max_rounds']}. Do not send it back to the build station. Label the ticket 'blocked-requires-sme', set its state to blocked, and give a person the findings.",
    }[outcome]
    print(json.dumps({**{k: decision[k] for k in ("outcome", "round", "risk", "approvals", "approvals_needed", "votes", "blockers")},
                      "overruled_blockers_from": overruled, "findings": str(findings_path), "next": next_step}, indent=2))
    return 0 if outcome in ("APPROVED", "AWAITING_HUMAN") else 1


def cmd_approve_human(cell: Cell, args: argparse.Namespace) -> int:
    decision = load_json(cell.folder / "decision.json")
    if not isinstance(decision, dict) or decision.get("outcome") != "AWAITING_HUMAN" or cell.info.get("stage") != "awaiting-human":
        raise ReviewError("This ticket is not waiting for a person's approval. A person signs off only after the panel has approved.")
    if decision.get("head") != cell.head():
        raise ReviewError("The cell's code changed after the panel voted. Review it again.")
    name = " ".join(args.by.split())
    if len(name) < 2:
        raise ReviewError("--by must name the person who approved.")
    decision["human_approval"] = {"by": name, "note": (args.note or "").strip() or None, "recorded_at": now(),
                                  "recorded_by": "an agent, on the person's instruction in conversation"}
    decision["outcome"] = "APPROVED"
    write_json(cell.folder / "decision.json", decision)
    write_json(cell.root / "review" / "decision.json", decision)
    cell.info.update({"stage": "approved", "review": "APPROVED"})
    cell.save_info()
    print(json.dumps({"outcome": "APPROVED", "approved_by": name, "next": f"Approved. The branch {cell.info.get('branch')} may be merged."}, indent=2))
    return 0


def cmd_status(cell: Cell, args: argparse.Namespace) -> int:
    votes = cell.votes()
    print(json.dumps({
        "ticket_id": cell.ticket_id, "stage": cell.info.get("stage"), "review": cell.info.get("review"), "round": cell.loop + 1,
        "panel": [seat["role"] for seat in cell.packet.get("panel", [])], "voted": {role: vote["vote"] for role, vote in votes.items()},
        "waiting_for": [seat["role"] for seat in cell.packet.get("panel", []) if seat["role"] not in votes],
    }, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MACH review station gates.")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, func, text in (("start", cmd_start, "check the gates and write the review packet"), ("tally", cmd_tally, "count the votes and decide"),
                             ("status", cmd_status, "show the panel and who has voted")):
        p = sub.add_parser(name, help=text)
        p.add_argument("ticket_id")
        p.set_defaults(func=func)
    p = sub.add_parser("submit", help="record one reviewer's findings; the vote follows from them")
    p.add_argument("ticket_id")
    p.add_argument("--reviewer", required=True, choices=sorted(ROLES))
    p.add_argument("--findings", required=True, help="JSON file: {\"summary\": ..., \"findings\": [...]}")
    p.set_defaults(func=cmd_submit)
    p = sub.add_parser("approve-human", help="record a person's sign-off after the panel approved")
    p.add_argument("ticket_id")
    p.add_argument("--by", required=True, help="the name of the person who approved")
    p.add_argument("--note")
    p.set_defaults(func=cmd_approve_human)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        project = args.project.resolve() if args.project else find_project(Path.cwd())
        return args.func(Cell(project, args.ticket_id), args)
    except ReviewError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
