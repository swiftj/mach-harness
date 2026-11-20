"""MACH change record (M13): the text record the merge station adds to a ticket's branch as its last act before landing.

The record is one Markdown file, `<records.dir>/<ticket>.md` (default `docs/changes/`), committed on the ticket's branch
alone, so it arrives in the same pull request or merge commit as the change. It holds, as text only: the why, the slice,
the product principles, policy packs and effects on shipped behaviour the spec answered (M15, each only when the spec has
that section), the plan's tasks and the architecture decisions in force, every verification run with the SHA-256 of each evidence file,
every review round (votes, findings, a person's approval or send-back, security exceptions and the scan's answers), the
builder's recorded overrides, and the commits. The evidence files themselves stay in the local archive, which can be
checked against the hashes here.

Every piece of free text taken from the cell is redacted and bounded by the ticket station's shared rules
(issue_rules.bound_text, handed in by the caller, never copied), and made inert: no mention, no issue link, no closing
keyword, no HTML, no Markdown link or image. The whole text is then read with the security scan's shapes (scan.py, the
intent station's shared helper): a candidate is masked, and if any remains the record is refused.

The same inputs give the same file: stable ordering, and no clock time other than times the stations recorded.

`holds()` is the one rule for the record commit: a commit that adds or changes exactly the record file, and nothing else,
on top of the approved (or revalidated) commit. The merge station and run.py both use it, so the approval stays bound to
what review saw.

Standard library only. Nothing here runs a process except through the git function a caller hands in.
"""

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

VERSION = 1
DEFAULT_DIR = "docs/changes"
DEFAULT_ADR_DIR = "docs/adr"

INTENT_LIMIT = 4000
DETAIL_LIMIT = 600
TITLE_LIMIT = 200
REASON_LIMIT = 600
NOTE_LIMIT = 300
TASK_LIMIT = 300
LINE_LIMIT = 120
MAX_TASKS = 200
MAX_CHECKS = 300
MAX_FILES = 300
MAX_FINDINGS = 100
MAX_ITEMS = 100

SHA_RE = re.compile(r"^[0-9a-f]{40,64}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
# A record's path: plain relative folders, then a ticket ID and .md. Nothing that needs quoting, linking or escaping.
PATH_RE = re.compile(r"^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,99}/){1,8}[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$")
TASK_RE = re.compile(r"^\s*[-*+]\s+\[([ xX])\]\s+((?:R\d+-)?T\d+)\s+\[(\w+)\]\s*(.*)$")
NATURAL_RE = re.compile(r"(\d+)")

# The same breaks merge.py's inert() uses for the pull request: a zero-width space after an issue marker or an @.
REFERENCE_RE = re.compile(r"(#|\bGH-|/issues/|/pull/|/discussions/)(?=[0-9])", re.IGNORECASE)
MENTION_RE = re.compile(r"@(?=[A-Za-z0-9_])")
TAG_RE = re.compile(r"<(?=[A-Za-z!/?])")
LINK_RE = re.compile(r"\]\(")
BREAK = "​"
MASK = "[masked]"


class RecordError(Exception):
    """The record cannot be written as it stands. Nothing is committed."""


# ---------------------------------------------------------------- settings

def _folder(value: Any, default: str) -> Tuple[str, bool]:
    """A folder relative to the repository root, and whether the setting was usable."""
    if value is None:
        return default, True
    text = value.strip().strip("/") if isinstance(value, str) else ""
    parts = text.split("/") if text else []
    if (not isinstance(value, str) or not text or value.strip().startswith(("/", "~")) or "\\" in text or ":" in text
            or any(part in ("", ".", "..") for part in parts) or parts[0] in (".factory", ".git", ".claude")
            or len(parts) > 7 or not all(re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9._-]{0,99}", part) for part in parts)):
        return default, False
    return "/".join(parts), True


def _within(inner: str, outer: str) -> bool:
    return inner == outer or inner.startswith(outer.rstrip("/") + "/")


def settings(config: Any) -> Dict[str, Any]:
    """records in .factory/config.json: enabled (default true), dir (default docs/changes), publish_command (cleanup's).
    `problem` is a plain sentence when the settings cannot be used; the merge station refuses rather than guess."""
    section = config.get("records") if isinstance(config, dict) and isinstance(config.get("records"), dict) else {}
    enabled = section.get("enabled") is not False
    folder, usable = _folder(section.get("dir"), DEFAULT_DIR)
    adr_section = config.get("adr") if isinstance(config, dict) and isinstance(config.get("adr"), dict) else {}
    adr_folder, _ = _folder(adr_section.get("dir"), DEFAULT_ADR_DIR)
    problem = None
    if enabled and not usable:
        problem = (f"records.dir in .factory/config.json ({str(section.get('dir'))[:80]!r}) is not a folder inside the repository, such as "
                   f"{DEFAULT_DIR}. Fix it, or set records.enabled to false; nothing is merged until then.")
    elif enabled and (_within(folder, adr_folder) or _within(adr_folder, folder)):
        problem = (f"records.dir ({folder}) and the ADR folder ({adr_folder}) overlap. A change record is never written among architecture "
                   "decisions, which only people change. Choose another records.dir; nothing is merged until then.")
    return {"enabled": enabled, "dir": folder, "problem": problem, "publish_command": section.get("publish_command")}


def path_for(folder: str, ticket_id: str, taken: Callable[[str], bool], earlier: Optional[str] = None) -> str:
    """<dir>/<ticket>.md, or <ticket>-2.md and so on when that file already exists for an earlier life of the ticket.
    A path this station recorded for this cell before (a landing that was sent back) is reused, and replaced."""
    if not TICKET_ID_RE.match(ticket_id):
        raise RecordError(f"'{ticket_id}' is not a usable ticket ID.")
    if isinstance(earlier, str) and earlier.startswith(folder + "/") and earlier.endswith(".md") and "/" not in earlier[len(folder) + 1:]:
        return earlier
    path, number = f"{folder}/{ticket_id}.md", 1
    while taken(path):
        number += 1
        path = f"{folder}/{ticket_id}-{number}.md"
    return path


def holds(git: Callable[..., Any], work: Path, record: Any, head: str, bases: Sequence[Optional[str]]) -> bool:
    """Whether `head` is this station's record commit on top of one of `bases` (the approved commit, or the revalidated
    one): a commit whose only parent is that base and which adds or changes exactly the record file, nothing else.
    Checked in Git each time; what cell.json says is only where to look."""
    if not isinstance(record, dict) or not isinstance(head, str) or not SHA_RE.match(head) or record.get("commit") != head:
        return False
    parent, path = record.get("parent"), record.get("path")
    if not isinstance(parent, str) or parent not in [base for base in bases if isinstance(base, str) and base]:
        return False
    if not isinstance(path, str) or not PATH_RE.match(path) or ".." in path.split("/"):
        return False
    parents = git(work, "rev-list", "--parents", "-n", "1", head).stdout.split()
    if parents != [head, parent]:
        return False
    changed = git(work, "-c", "core.quotePath=false", "diff-tree", "--no-commit-id", "--no-renames", "--name-status", "-r", parent, head).stdout.splitlines()
    return changed in ([f"A\t{path}"], [f"M\t{path}"])


# ---------------------------------------------------------------- text

def _inert(text: str) -> str:
    text = TAG_RE.sub("&lt;", text)
    text = LINK_RE.sub("]" + BREAK + "(", text)
    return MENTION_RE.sub("@" + BREAK, REFERENCE_RE.sub(lambda m: m.group(1) + BREAK, text))


class Text:
    """Free text from the cell made safe for the record, with the ticket station's rules."""

    def __init__(self, rules: Any) -> None:
        if rules is None or not hasattr(rules, "bound_text"):
            raise RecordError("The ticket station's shared rules (issue_rules.py) could not be loaded, so text from the cell cannot be redacted; "
                              "no change record was written and nothing was merged.")
        self.rules = rules

    def one(self, value: Any, limit: int = LINE_LIMIT, empty: str = "(not recorded)") -> str:
        if value is None or (isinstance(value, str) and not value.strip()):
            return empty
        text, cut = self.rules.bound_text(value if isinstance(value, str) else json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else str(value),
                                          limit, one_line=True)
        text = _inert(text).replace("`", "'")
        return text + (" (cut)" if cut else "")

    def block(self, value: Any, limit: int) -> List[str]:
        """Several lines, quoted, with a plain note when cut."""
        if not isinstance(value, str) or not value.strip():
            return ["> (not recorded)"]
        text, cut = self.rules.bound_text(value, limit)
        lines = [("> " + _inert(line)).rstrip() for line in text.strip("\n").splitlines()]
        if cut:
            lines += [">", f"> (Cut at {limit} characters; the full text is in the archive.)"]
        return lines


def sha(value: Any) -> str:
    return f"`{value}`" if isinstance(value, str) and SHA_RE.match(value) else "(not recorded)"


def natural(value: Any) -> List[Any]:
    return [int(part) if part.isdigit() else part for part in NATURAL_RE.split(str(value))]


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def load_dict(path: Path) -> Dict[str, Any]:
    value = load_json(path)
    return value if isinstance(value, dict) else {}


def read_text(path: Path) -> Optional[str]:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def numbered(folders: Sequence[Path], prefix: str) -> List[Path]:
    """round-1, round-2, round-2.1 (a re-review after an approval was voided), previous-3: in numeric order."""
    found = []
    for path in folders:
        match = re.fullmatch(re.escape(prefix) + r"-(\d+)(?:\.(\d+))?", path.name)
        if match and path.is_dir() and not path.is_symlink():
            found.append(((int(match.group(1)), int(match.group(2) or 0)), path))
    return [path for _, path in sorted(found)]


def capped(lines: List[str], items: int, limit: int, what: str) -> List[str]:
    return lines + ([f"- {items - limit} more {what} not listed here; every one is in the archive."] if items > limit else [])


# ---------------------------------------------------------------- the record

def render(root: Path, info: Dict[str, Any], ticket_id: str, commits: Dict[str, Optional[str]], rules: Any, jira_url: Optional[str] = None) -> str:
    """The record's text for the cell at `root`. Deterministic for the same files and commits."""
    t = Text(rules)
    lines = [
        f"# Change record: {t.one(ticket_id, 80)}",
        "",
        "Written by the MACH merge station when this change landed: how it was specified, planned, built, verified and reviewed. "
        "It is text taken from the ticket's working files, with likely secrets masked, mentions and issue references broken, and long text cut. "
        "The evidence files themselves are kept in the project's local archive (`.factory/archive/`); each one is named here with its SHA-256, "
        "so the archive can be checked against this record.",
        "",
    ]
    lines += ticket_section(t, info, ticket_id, rules, jira_url)
    lines += ["## Why", "", *t.block(read_text(root / "intent.md"), INTENT_LIMIT), ""]
    spec = load_dict(root / "spec.json")  # M15: each of the next three sections only when the spec has it
    lines += principles_section(t, spec, info)
    lines += policies_section(t, spec, info)
    lines += effects_section(t, spec, info)
    lines += plan_section(t, root, info)
    lines += verification_section(t, root)
    lines += review_section(t, root)
    lines += build_section(t, root)
    lines += commits_section(commits)
    return "\n".join(lines).rstrip() + "\n"


def ticket_section(t: Text, info: Dict[str, Any], ticket_id: str, rules: Any = None, jira_url: Optional[str] = None) -> List[str]:
    product = info.get("product") if isinstance(info.get("product"), dict) else {}
    slice_id = product.get("slice_id") or info.get("slice_id")
    revision = product.get("revision")
    lines = ["## Ticket", "", f"- Ticket: {t.one(ticket_id, 80)}", f"- Title: {t.one(info.get('title'), TITLE_LIMIT)}",
             f"- Slice: {t.one(slice_id, 80)}" + (f", revision {t.one(revision, 20)}" if revision is not None else "")]
    if product.get("epic_id"):
        lines.append(f"- Epic: {t.one(product.get('epic_id'), 80)}")
    issue = product.get("issue") if isinstance(product.get("issue"), dict) else None
    if issue and isinstance(issue.get("repository"), str) and type(issue.get("number")) is int:
        lines.append(f"- Slice issue: {t.one(issue['repository'], 140)}, issue number {issue['number']}")
    jira = product.get("jira")
    if rules is not None and rules.is_jira_key(jira):  # M13: the Jira key, checked again; a link only through the checked browse_url
        lines.append(f"- Jira: [{jira}]({jira_url}{jira})" if jira_url else f"- Jira: {jira}")
    lines += [f"- Spec: {t.one(info.get('spec_path'), 200)}", f"- Risk tier: {t.one(info.get('risk'), 20)}", f"- App type: {t.one(info.get('app_type'), 20)}", ""]
    return lines


def _rows(spec: Dict[str, Any], key: str) -> Optional[List[Dict[str, Any]]]:
    """spec.json's rows for one section, or None when the spec has no such section (the record then has none either)."""
    value = spec.get(key)
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else None


def principles_section(t: Text, spec: Dict[str, Any], info: Dict[str, Any]) -> List[str]:
    """M15: the product principles the spec answered, each with its answer, from spec.json (and what cell.json read)."""
    rows = _rows(spec, "principles")
    if rows is None:
        return []
    lines = ["## Product principles", ""]
    read = info.get("principles") if isinstance(info.get("principles"), dict) else {}
    if type(read.get("revision")) is int and SHA256_RE.match(str(read.get("sha256"))):
        lines += [f"Answered against the published principles, revision {read['revision']} (SHA-256 {sha(read['sha256'])}).", ""]
    if not rows:
        return lines + ["- None.", ""]
    shown: List[str] = []
    for row in sorted(rows, key=lambda item: natural(item.get("id")))[:MAX_ITEMS]:
        head = f"- {t.one(row.get('id'), 20)} (revision {t.one(row.get('revision'), 10)}) \"{t.one(row.get('statement'), TITLE_LIMIT)}\": "
        answer = row.get("answer")
        if answer == "applies":
            upheld = [item for item in row.get("upheld_by") or [] if isinstance(item, str)]
            shown.append(head + "applies, upheld by " + (", ".join(t.one(item, 20) for item in sorted(upheld, key=natural)) or "(not recorded)") + ".")
        elif answer == "does_not_apply":
            shown.append(head + f"does not apply: {t.one(row.get('reason'), REASON_LIMIT)}")
        elif answer == "exception":
            shown.append(head + f"an exception, the product manager's decision: \"{t.one(row.get('reason'), REASON_LIMIT)}\"")
        else:
            shown.append(head + "(answer not recorded)")
    return lines + capped(shown, len(rows), MAX_ITEMS, "principles") + [""]


SHORT_DIGEST_RE = re.compile(r"^[0-9a-f]{12}$")
OWNER_CHECKS = ("checked against the pack's owner", "checked against the project's list", "not checked against the owner")


def policies_section(t: Text, spec: Dict[str, Any], info: Dict[str, Any]) -> List[str]:
    """M15: the policy packs the spec answered, by digest, and each concern with its resolution: who accepted it, and how
    that name was checked against the owner (policies.owner_check, carried in spec.json)."""
    rows = _rows(spec, "policies")
    if rows is None:
        return []
    kept = info.get("policies") if isinstance(info.get("policies"), dict) else {}
    full = {item.get("id"): item.get("digest") for item in kept.get("packs") or []
            if isinstance(item, dict) and item.get("matches_main") is True and SHA256_RE.match(str(item.get("digest")))}
    lines = ["## Policy packs", ""]
    if SHA_RE.match(str(kept.get("commit"))):
        lines += [f"Packs read at commit {sha(kept['commit'])}.", ""]
    accepted = False
    for row in sorted(rows, key=lambda item: natural(item.get("pack")))[:MAX_ITEMS]:
        short = row.get("sha256") if SHORT_DIGEST_RE.match(str(row.get("sha256"))) else None
        digest = f"digest `{short}`" if short else "digest (not recorded)"
        if short and isinstance(full.get(row.get("pack")), str) and full[row.get("pack")].startswith(short):
            digest += f", SHA-256 {sha(full[row.get('pack')])}"
        answer = {"followed": "followed", "concerns": "concerns"}.get(row.get("answer"), "(answer not recorded)")
        lines.append(f"- {t.one(row.get('pack'), 60)} ({digest}): {answer}.")
        for concern in [item for item in row.get("concerns") or [] if isinstance(item, dict)][:MAX_ITEMS]:
            entry = (f"  - {t.one(concern.get('statement_id'), 60)} \"{t.one(concern.get('statement'), TITLE_LIMIT)}\" cannot be met: "
                     f"{t.one(concern.get('why'), NOTE_LIMIT)} Owner: {t.one(concern.get('owner'), 120)}. ")
            state = concern.get("resolution")
            if state == "accepted":
                accepted = True
                check = concern.get("owner_check") if concern.get("owner_check") in OWNER_CHECKS else None
                by = str(concern.get("by") or "")
                if check and by.endswith(f" ({check})"):
                    by = by[:-len(check) - 3]
                entry += (f"Accepted by {t.one(by, 80)} ({check or 'how the name was checked is not recorded'}) on {t.one(concern.get('on'), 12)}: "
                          f"\"{t.one(concern.get('words'), REASON_LIMIT)}\"")
            elif state == "spec_changed":
                entry += "Resolved by changing the spec."
            elif state == "open":
                entry += "Still open."
            else:
                entry += "Resolution not recorded."
            lines.append(entry)
    if not rows:
        lines.append("- None.")
    if accepted:
        lines += ["", "A name is checked against the owner the pack names, or the project's list, never against GitHub: "
                  "this guards against accident, not forgery."]
    return lines + [""]


def effects_section(t: Text, spec: Dict[str, Any], info: Dict[str, Any]) -> List[str]:
    """M15: the spec's effects on shipped behaviour, row by row, from spec.json; 'None.' when the spec said so."""
    rows = _rows(spec, "effects")
    if rows is None:
        return []
    lines = ["## Effects on shipped behaviour", ""]
    shipped = info.get("shipped") if isinstance(info.get("shipped"), dict) else {}
    if SHA_RE.match(str(shipped.get("commit"))):
        lines += [f"Shipped rules read at commit {sha(shipped['commit'])}.", ""]
    if not rows:
        return lines + ["- None: this slice changes no shipped behaviour.", ""]
    shown: List[str] = []
    for row in sorted(rows, key=lambda item: natural(item.get("shipped_rule")))[:MAX_ITEMS]:
        effect = row.get("effect") if row.get("effect") in ("kept", "changed", "replaced", "retired") else None
        here = t.one(row.get("in_slice"), 20)
        what = {"kept": f"kept, proven again by {here}", "changed": f"changed, by {here} in this slice",
                "replaced": f"replaced, by {here} in this slice", "retired": "retired"}.get(effect, "(effect not recorded)")
        note = f" Note: \"{t.one(row.get('note'), NOTE_LIMIT)}\"" if isinstance(row.get("note"), str) and row["note"].strip() else ""
        shown.append(f"- {t.one(row.get('shipped_rule'), 60)}: {what}.{note}")
    return lines + capped(shown, len(rows), MAX_ITEMS, "effects") + [""]


def plan_section(t: Text, root: Path, info: Dict[str, Any]) -> List[str]:
    lines = ["## Plan", "", "Tasks, in the plan's order:", ""]
    tasks = []
    in_tasks = False
    for line in (read_text(root / "plan.md") or "").splitlines():
        heading = re.match(r"^##\s+(.+?)\s*$", line)
        if heading:
            in_tasks = heading.group(1).strip().lower() == "tasks"
            continue
        match = TASK_RE.match(line) if in_tasks else None
        if match:
            tasks.append(f"- {t.one(match.group(2), 20)} [{t.one(match.group(3), 20)}] {t.one(match.group(4), TASK_LIMIT, '')}".rstrip()
                         + (" (done)" if match.group(1).lower() == "x" else ""))
    lines += capped(tasks[:MAX_TASKS], len(tasks), MAX_TASKS, "tasks") if tasks else ["- None recorded."]
    adrs = info.get("adrs") if isinstance(info.get("adrs"), dict) else {}
    under = sorted([item for item in adrs.get("planned_under") or [] if isinstance(item, dict)], key=lambda item: natural(item.get("id")))
    lines += ["", "Architecture decisions in force when it was planned:", ""]
    lines += [f"- {t.one(item.get('id'), 40)}: {t.one(item.get('title'), TITLE_LIMIT)} (digest {sha(item.get('digest'))})" for item in under[:MAX_ITEMS]] or ["- None."]
    proposed = sorted([item for item in adrs.get("proposed") or [] if isinstance(item, dict)], key=lambda item: natural(item.get("id")))
    if proposed:
        lines += ["", "Proposed by this ticket:", ""]
        lines += [f"- {t.one(item.get('id'), 40)}: {t.one(item.get('title'), TITLE_LIMIT)} (digest {sha(item.get('digest'))})" for item in proposed[:MAX_ITEMS]]
    excepted = [item for item in info.get("adr_exceptions") or [] if isinstance(item, dict)]
    lines += ["", "Exceptions to an architecture decision, recorded by a person:", ""]
    lines += [f"- {t.one(item.get('adr'), 40)} (digest {sha(item.get('digest'))}), by {t.one(item.get('by'), 80)} at {t.one(item.get('at'), 40)}: "
              f"\"{t.one(item.get('reason'), REASON_LIMIT)}\"" for item in excepted[:MAX_ITEMS]] or ["- None."]
    return lines + [""]


def verification_section(t: Text, root: Path) -> List[str]:
    evidence = root / "evidence"
    runs = [(f"evidence/{path.name}/", load_dict(path / "summary.json")) for path in numbered(list(evidence.glob("previous-*")) if evidence.is_dir() else [], "previous")]
    runs.append(("evidence/", load_dict(evidence / "summary.json")))
    runs = [(prefix, summary) for prefix, summary in runs if summary]
    lines = ["## Verification", ""]
    if not runs:
        return lines + ["No verification summary was recorded.", ""]
    for number, (prefix, summary) in enumerate(runs, start=1):
        hashes = {entry.get("file"): entry.get("sha256") for entry in summary.get("evidence_files") or [] if isinstance(entry, dict) and isinstance(entry.get("file"), str)}
        suite = summary.get("suite") if isinstance(summary.get("suite"), dict) else {}
        lines += [f"### Run {number} of {len(runs)}: {t.one(summary.get('status'), 40)}", "",
                  f"Review loop {t.one(summary.get('review_loop'), 10)}, at commit {sha(summary.get('head'))}, recorded {t.one(summary.get('timestamp'), 40)}. "
                  f"Test suite rerun by the verifier: {'passed' if suite.get('passed') is True else 'failed' if suite.get('passed') is False else 'not recorded'}.", ""]
        checks = summary.get("checks") if isinstance(summary.get("checks"), dict) else {}
        shown, cited = [], set()
        for check_id in sorted(checks, key=natural)[:MAX_CHECKS]:
            check = checks[check_id] if isinstance(checks[check_id], dict) else {}
            result = check.get("result") if check.get("result") in ("pass", "fail") else "not recorded"
            files = [name for name in check.get("evidence") or [] if isinstance(name, str)]
            cited.update(files)
            entry = f"- {t.one(check_id, 40)} ({t.one(check.get('kind'), 40)}): {result}."
            if result == "fail":
                entry += f" {t.one(check.get('note'), NOTE_LIMIT)}"
            entry += " Evidence: " + ("; ".join(evidence_line(t, prefix, name, hashes.get(name)) for name in sorted(files)[:20]) if files else "none listed") + "."
            shown.append(entry)
        lines += capped(shown, len(checks), MAX_CHECKS, "checks") if shown else ["- No checks recorded."]
        unproven = [item for item in summary.get("unproven") or [] if isinstance(item, str)]
        if unproven:
            lines.append(f"- Not proven: {', '.join(t.one(item, 40) for item in sorted(unproven, key=natural)[:MAX_ITEMS])}.")
        failures = [item for item in summary.get("failures") or [] if isinstance(item, str)]
        if failures:
            lines += ["", "Failures recorded by the verifier:", ""] + [f"- {t.one(item, NOTE_LIMIT)}" for item in failures[:MAX_ITEMS]]
        lines += mock_lines(t, summary.get("mocks"))  # M14 C: nothing for a slice without design mocks
        lines += neighbour_lines(t, summary.get("neighbours"))  # M15: nothing when no shipped scenario was proven again
        others = sorted(name for name in hashes if name not in cited)
        if others:
            lines += ["", "Other evidence files from this run:", ""]
            lines += capped([f"- {evidence_line(t, prefix, name, hashes[name])}" for name in others[:MAX_FILES]], len(others), MAX_FILES, "files")
        lines.append("")
    return lines


def mock_lines(t: Text, mocks: Any) -> List[str]:
    """M14 C: each approved design mock by its SHA-256, the scenario it is for, and how the built screen compared."""
    if not isinstance(mocks, dict) or not mocks:
        return []
    lines = ["", "Design mocks compared with the built screen:", ""]
    for key in sorted(mocks, key=natural)[:MAX_ITEMS]:
        mock = mocks[key] if isinstance(mocks[key], dict) else {}
        result = mock.get("result") if mock.get("result") in ("matches", "differs", "cannot compare") else "not recorded"
        entry = (f"- {t.one(key, 20)}: SHA-256 {sha(mock.get('sha256')) if SHA256_RE.match(str(mock.get('sha256'))) else '(not recorded)'}, "
                 f"for {t.one(mock.get('for') or 'the whole slice', 20)}{', binding' if mock.get('binding') is True else ''}: {result}.")
        differences = [item for item in mock.get("differences") or [] if isinstance(item, str)]
        lines.append(entry + (" " + "; ".join(t.one(item, NOTE_LIMIT) for item in differences[:MAX_ITEMS]) if differences else ""))
    return lines


def neighbour_lines(t: Text, near: Any) -> List[str]:
    """M15: the shipped scenarios of neighbouring slices proven again, why each was chosen, and the commit they were read at."""
    checks = [item for item in (near.get("checks") or []) if isinstance(item, dict)] if isinstance(near, dict) else []
    if not checks:
        return []
    lines = ["", f"Shipped scenarios of neighbouring slices proven again, read at commit {sha(near.get('commit'))}:", ""]
    for item in checks[:MAX_ITEMS]:
        result = item.get("result") if item.get("result") in ("pass", "fail") else "not recorded"
        lines.append(f"- {t.one(item.get('id'), 20)}: {t.one(item.get('slice_id'), 20)} {t.one(item.get('scenario'), 20)} "
                     f"\"{t.one(item.get('title'), TITLE_LIMIT)}\" ({t.one(item.get('why'), 120)}): {result}.")
    return lines


def evidence_line(t: Text, prefix: str, name: str, digest: Any) -> str:
    return f"{t.one(prefix + name, 240)} (SHA-256 {sha(digest) if isinstance(digest, str) and SHA256_RE.match(digest) else '(not recorded)'})"


def review_section(t: Text, root: Path) -> List[str]:
    review = root / "review"
    rounds = numbered(list(review.glob("round-*")) if review.is_dir() else [], "round")
    lines = ["## Review", ""]
    if not rounds:
        return lines + ["No review round was recorded.", ""]
    for folder in rounds:
        label = folder.name[len("round-"):]
        decision = load_dict(folder / "decision.json")
        outcome = decision.get("outcome")
        lines += [f"### Round {t.one(label, 10)}: {t.one(outcome, 30, 'not decided')}", ""]
        if decision:
            lines.append(f"Risk tier {t.one(decision.get('risk'), 20)}; {t.one(decision.get('approvals'), 5)} approvals, {t.one(decision.get('approvals_needed'), 5)} "
                         f"needed; reviewed commit {sha(decision.get('head'))}; decided {t.one(decision.get('decided_at'), 40)}.")
        if decision.get("outcome_before_void"):
            void = decision.get("void") if isinstance(decision.get("void"), dict) else {}
            lines.append(f"This round's {t.one(decision.get('outcome_before_void'), 30)} was voided at {t.one(void.get('voided_at'), 40)}: "
                         f"{t.one(void.get('reason'), NOTE_LIMIT)} The branch was at {sha(void.get('branch_commit'))}.")
        lines += ["", "Votes:", ""]
        votes = {}
        for path in sorted((folder / "votes").glob("*.json")) if (folder / "votes").is_dir() else []:
            vote = load_dict(path)
            if vote:
                votes[path.stem] = vote
        lines += [f"- {t.one(seat, 40)}: {t.one(vote.get('vote'), 20)}" for seat, vote in sorted(votes.items())] or ["- None recorded."]
        findings = [(seat, finding) for seat, vote in sorted(votes.items()) for finding in (vote.get("findings") if isinstance(vote.get("findings"), list) else [])
                    if isinstance(finding, dict)]
        lines += ["", "Findings:", ""]
        lines += capped([finding_line(t, seat, finding) for seat, finding in findings[:MAX_FINDINGS]], len(findings), MAX_FINDINGS, "findings") or ["- None."]
        dropped = {seat: vote["nits_dropped"] for seat, vote in sorted(votes.items()) if type(vote.get("nits_dropped")) is int and vote["nits_dropped"] > 0}
        lines += [f"- {count} more nit{'s' if count != 1 else ''} from {t.one(seat, 40)} not kept (review.nit_cap)." for seat, count in dropped.items()]
        human = decision.get("human_approval") if isinstance(decision.get("human_approval"), dict) else None
        if human:
            lines += ["", f"Approved by a person: {t.one(human.get('by'), 80)}, recorded {t.one(human.get('recorded_at'), 40)}."
                      + (f" Their note: \"{t.one(human.get('note'), NOTE_LIMIT)}\"" if human.get("note") else "")]
        sent = decision.get("human_send_back") if isinstance(decision.get("human_send_back"), dict) else None
        if sent:
            lines += ["", f"Sent back by a person: {t.one(sent.get('by'), 80)}, recorded {t.one(sent.get('recorded_at'), 40)}: \"{t.one(sent.get('reason'), REASON_LIMIT)}\""]
        lines += exceptions_lines(t, decision)
        lines += scan_lines(t, decision.get("security_scan"))
        lines.append("")
    return lines


def finding_line(t: Text, seat: str, finding: Dict[str, Any]) -> str:
    severity = finding.get("severity") if finding.get("severity") in ("blocker", "note") else "note"
    label = f"{t.one(seat, 40)}, {severity}"
    if severity == "note" and finding.get("weight") in ("important", "nit"):  # M15: shown only when the reviewer gave one
        label += f", {finding['weight']}"
    if finding.get("class") == "security":
        label += f", security, {t.one(finding.get('impact'), 20, 'unstated')} impact"
    line = finding.get("line")
    where = t.one(finding.get("file"), 200, "") + (f":{line}" if type(line) is int and line > 0 else "") if finding.get("file") else "no file"
    text = f"- {label}: **{t.one(finding.get('title'), TITLE_LIMIT, '(no title)')}**"
    if finding.get("detail"):
        text += f" {t.one(finding.get('detail'), DETAIL_LIMIT)}"
    if finding.get("rule"):
        text += f" Cites: {t.one(finding.get('rule'), LINE_LIMIT)}."
    return text + f" File: {where}."


def exceptions_lines(t: Text, decision: Dict[str, Any]) -> List[str]:
    items = [item for item in decision.get("exceptions") or [] if isinstance(item, dict)]
    if not items:
        return []
    lines = ["", "Security exceptions recorded by a person (the finding was accepted, not fixed):", ""]
    for item in items[:MAX_ITEMS]:
        lines.append(f"- {t.one(item.get('round'), 10)}/{t.one(item.get('seat'), 40)}/{t.one(item.get('index'), 10)}: "
                     f"**{t.one(item.get('title'), TITLE_LIMIT)}**, by {t.one(item.get('by'), 80)} at {t.one(item.get('recorded_at'), 40)}, for commit {sha(item.get('head'))}"
                     + (f", until {t.one(item.get('expires'), 12)}" if item.get("expires") else "")
                     + (" (renews an expired one)" if item.get("renews") is not None else "") + f": \"{t.one(item.get('reason'), REASON_LIMIT)}\"")
    before, after = decision.get("approvals_before_exception"), decision.get("approvals_after_exception")
    if type(before) is int and type(after) is int and before != after:
        lines.append(f"- Approvals before the exception: {before}; after: {after}.")
    return lines


def scan_lines(t: Text, summary: Any) -> List[str]:
    if not isinstance(summary, dict):
        return []
    if summary.get("enabled") is False:
        return ["", "Security scan: switched off for this round (security.scan.enabled is false); nothing was checked."]
    secrets = [item for item in summary.get("secrets") or [] if isinstance(item, dict)]
    deps = [item for item in summary.get("dependencies") or [] if isinstance(item, dict)]
    if not secrets and not deps:
        return ["", "Security scan: nothing flagged."]
    lines = ["", "Security scan and its answers (never a value):", ""]
    for item in secrets[:MAX_ITEMS]:
        lines.append(f"- Possible secret ({t.one(item.get('kind'), 40)}) at {t.one(item.get('file'), 200)}:{t.one(item.get('line'), 10)}"
                     + (", recorded by the builder as not a secret" if item.get("overridden_by_builder") else "")
                     + f": answered {t.one(item.get('answer'), 20)}" + (f", \"{t.one(item.get('reason'), NOTE_LIMIT)}\"" if item.get("reason") else "") + ".")
    for item in deps[:MAX_ITEMS]:
        lines.append(f"- Dependency {t.one(item.get('ecosystem'), 20)} {t.one(item.get('name'), 120)} {t.one(item.get('version'), 60, '')} "
                     f"({t.one(item.get('change'), 10)}{', development only' if item.get('dev') else ''}): answered {t.one(item.get('answer'), 20)}"
                     + (f", \"{t.one(item.get('reason'), NOTE_LIMIT)}\"" if item.get("reason") else "") + ".")
    if deps:
        lines.append("- Dependencies were not checked against a vulnerability database.")
    return lines


def build_section(t: Text, root: Path) -> List[str]:
    report = load_dict(root / "build-report.json")
    lines = ["## Build", ""]
    if not report:
        return lines + ["No build report was recorded.", ""]
    seen = report.get("tests_seen_failing_first")
    lines += [f"Revision {t.one(report.get('review_loop'), 10)} was the last build. Tests seen failing before their code was written: "
              f"{seen if type(seen) is int else '(not recorded)'}.", "", "Overrides the builder recorded, each with its reason:", ""]
    deviations = [item for item in report.get("deviations") or [] if isinstance(item, dict)]
    lines += capped([f"- {t.one(item.get('task'), 20, 'no task')}, {t.one(item.get('type'), 40)}: {t.one(item.get('detail'), REASON_LIMIT)}" for item in deviations[:MAX_ITEMS]],
                    len(deviations), MAX_ITEMS, "overrides") or ["- None."]
    return lines + [""]


def commits_section(commits: Dict[str, Optional[str]]) -> List[str]:
    lines = ["## Commits", "", f"- Approved by review: {sha(commits.get('approved'))}"]
    if commits.get("revalidated"):
        lines.append(f"- Brought up to date with the main branch (at {sha(commits.get('onto'))}) and tested again: {sha(commits.get('revalidated'))}")
    lines += [f"- This record was added on top of: {sha(commits.get('base'))}",
              "- The commit that adds this record, and the merge into the main branch, come after it was written: Git's history and the run record "
              "(`.factory/archive/runs.jsonl`) name them.", ""]
    return lines


# ---------------------------------------------------------------- secrets

def mask(text: str, path: str, scan: Any) -> str:
    """Mask every value the security scan's shapes find in the record; refuse if any is still there afterwards."""
    if scan is None or not hasattr(scan, "secrets_in_line"):
        raise RecordError("The intent station's scan.py could not be loaded, so the change record cannot be checked for secrets; "
                          "no change record was written and nothing was merged.")
    out = []
    for line in text.split("\n"):
        found, _ = scan.secrets_in_line(path, line)
        for _, value in sorted(found, key=lambda pair: -len(pair[1])):
            if value:
                line = line.replace(value, MASK)
        out.append(line)
    masked = "\n".join(out)
    left = [kind for line in masked.split("\n") for kind, _ in scan.secrets_in_line(path, line)[0]]
    if left:
        raise RecordError(f"The change record would still carry something shaped like a secret ({', '.join(sorted(set(left)))}) after masking, "
                          "so it was not written and nothing was merged. Look at the cell's files for the value.")
    return masked


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
