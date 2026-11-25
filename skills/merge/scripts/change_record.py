"""MACH change record (M13): the text record the merge station adds to a ticket's branch as its last act before landing.

The record is one Markdown file, `<records.dir>/<ticket>.md` (default `docs/changes/`), committed on the ticket's branch
alone, so it arrives in the same pull request or merge commit as the change. It holds, as text only: the why, the slice,
the product principles, policy packs and effects on shipped behaviour the spec answered (M15, each only when the spec has
that section), the plan's tasks and the architecture decisions in force, every verification run with the SHA-256 of each evidence file,
every review round (votes, findings, a person's approval or send-back, security exceptions and the scan's answers), the
builder's recorded overrides (and, for a build in lanes, M22, the lanes, any lane set aside, any failure only the joined result
showed with its fix task, and the recorded times), and the commits. The evidence files themselves stay in the local archive only when cleanup keeps one (cleanup.archive); a kept file can be
checked against the hashes here.

Version 2 ends the record with a block for MACH to read (`facts()`, `read_facts()`): the facts release qualification
needs on a machine that did not build the ticket. They are the slice, its revision and the approved spec's SHA-256, the
contracts the plan named, the slices it depends on, the last verification's verdict with each scenario's evidence
hashes, the approving review decision with whether a person's approval was required, the blockers of that round and
the commits. Qualification reads that block from the integration branch and never parses the prose above it.

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

VERSION = 2  # 2: the record ends with a block of facts for release qualification
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
# The block of facts: this heading, this marker line, then one fenced JSON document. Free text elsewhere in the record
# cannot make the marker line: every "<" taken from the cell is written as "&lt;".
FACTS_HEADING = "## For MACH"
FACTS_MARK = f"<!-- mach:change-record version={VERSION} -->"
FACTS_LIMIT = 400_000  # characters of JSON read back; a larger block is not a record


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
            lines += [">", f"> (Cut at {limit} characters; {KEPT_TEXT}.)"]
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
    return lines + ([f"- {items - limit} more {what} not listed here; the ticket's archive holds every one when one is kept."] if items > limit else [])


# ---------------------------------------------------------------- the record

# What the record says about the evidence files. It is written at merge, before cleanup decides whether the ticket's archive is
# kept (cleanup.archive), so it says what is true whatever is decided then.
EVIDENCE_WORDS = ("Each evidence file is named here with its SHA-256. The files themselves are kept after cleanup, in the project's local archive "
                  "(`.factory/archive/`), only when the project keeps archives or a person decided something on this ticket; a file that was kept "
                  "can be checked against its hash here.")
KEPT_TEXT = "the ticket's archive holds the full text when one is kept"


def render(root: Path, info: Dict[str, Any], ticket_id: str, commits: Dict[str, Optional[str]], rules: Any, jira_url: Optional[str] = None,
           spec_sha256: Optional[str] = None) -> str:
    """The record's text for the cell at `root`. Deterministic for the same files and commits.
    `spec_sha256` is the approved spec's SHA-256 as intake takes it (the spec's text without MACH's header line)."""
    t = Text(rules)
    lines = [
        f"# Change record: {t.one(ticket_id, 80)}",
        "",
        "Written by the MACH merge station when this change landed: how it was specified, planned, built, verified and reviewed. "
        "It is text taken from the ticket's working files, with likely secrets masked, mentions and issue references broken, and long text cut. "
        + EVIDENCE_WORDS,
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
    lines += facts_section(facts(root, info, ticket_id, commits, rules, spec_sha256))
    return "\n".join(lines).rstrip() + "\n"


# M18: a small change is said beside the ticket, in the record and in the pull request. A rule's fixed sentence (the intent
# station's small.py) always begins with these words and is one line; anything else in `widened.reason` is a person's words,
# which are not repeated here.
SMALL_KIND = "small"
NOT_SMALL_LEAD = "This is not a small change: "
RULE_CODE_RE = re.compile(r"^[a-z][a-z-]{1,39}$")
SENTENCE_LIMIT = 240


def small_change_words(info: Dict[str, Any]) -> Optional[str]:
    """What the cell records of a small change, in words for people: "a small change", or, when it became a full slice, that it
    began as one and the rule's fixed sentence. None for every other ticket, so its record and pull request are as before."""
    if info.get("kind") != SMALL_KIND:
        return None
    widened = info.get("widened")
    if not isinstance(widened, dict):
        return "a small change"
    rule, reason = widened.get("rule"), widened.get("reason")
    if (isinstance(rule, str) and RULE_CODE_RE.match(rule) and isinstance(reason, str) and reason.startswith(NOT_SMALL_LEAD)
            and "\n" not in reason and len(reason) <= SENTENCE_LIMIT):
        return f"a full slice that began as a small change. {reason}"
    return "a full slice that began as a small change, made a full slice on a person's word"


def ticket_section(t: Text, info: Dict[str, Any], ticket_id: str, rules: Any = None, jira_url: Optional[str] = None) -> List[str]:
    product = info.get("product") if isinstance(info.get("product"), dict) else {}
    slice_id = product.get("slice_id") or info.get("slice_id")
    revision = product.get("revision")
    small = small_change_words(info)
    lines = ["## Ticket", "", f"- Ticket: {t.one(ticket_id, 80)}" + (f", {t.one(small, SENTENCE_LIMIT + 60)}" if small else ""),
             f"- Title: {t.one(info.get('title'), TITLE_LIMIT)}",
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
    unassessed = [row for row in _rows(spec, "principles_not_assessed") or [] if isinstance(row.get("id"), str)]
    if not rows and not unassessed:
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
    # M21: a principle this slice predates (a project brought in from another repository), one line each, after the answers.
    for row in sorted(unassessed, key=lambda item: natural(item.get("id")))[:max(0, MAX_ITEMS - len(shown))]:
        shown.append(f"- {t.one(row.get('id'), 20)} (revision {t.one(row.get('revision'), 10)}) \"{t.one(row.get('statement'), TITLE_LIMIT)}\": "
                     f"not assessed: {t.one(row.get('reason'), REASON_LIMIT)}")
    return lines + capped(shown, len(rows) + len(unassessed), MAX_ITEMS, "principles") + [""]


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
        headless = headless_mode(summary)
        if headless:  # a web, desktop or mobile change verified without screenshots: said once, where the evidence is listed
            lines += [f"Evidence without screenshots: {t.one(headless.get('said'), NOTE_LIMIT)} {t.one(headless.get('why'), NOTE_LIMIT)}", ""]
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


def headless_mode(summary: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The verification's evidence mode when it was headless (no screenshots, nothing could capture the screen); None otherwise."""
    mode = summary.get("evidence_mode")
    return mode if isinstance(mode, dict) and mode.get("mode") == "headless" else None


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
              f"{seen if type(seen) is int else '(not recorded)'}.", ""]
    deviations = [item for item in report.get("deviations") or [] if isinstance(item, dict)]
    lines += lanes_lines(t, report, deviations)  # M22: nothing for a build without lanes, so its record is as before
    lines += commands_lines(t, deviations)  # nothing unless a command was set or changed while building
    by_station = any(item.get("by") == STATION for item in deviations)
    lines += ["Overrides the builder recorded, and what the build station recorded itself, each with its reason:" if by_station
              else "Overrides the builder recorded, each with its reason:", ""]
    lines += capped([deviation_line(t, item) for item in deviations[:MAX_ITEMS]], len(deviations), MAX_ITEMS, "overrides") or ["- None."]
    return lines + [""]


# M22: a build in lanes. The build station records what it did itself (a lane set aside, lanes that fail only together) as
# deviations marked with this `by`; a lane builder's own overrides carry the lane they were made in.
STATION = "build station"
LANE_RE = re.compile(r"^L\d{1,3}$")


def set_aside_words(t: Text, because: Dict[str, Any]) -> str:
    """Why the join set a lane aside, from what landing recorded: the other lane, the file, and the reason's code."""
    other, file, why = t.one(because.get("other"), 10), t.one(because.get("file"), 200), because.get("why")
    if why == "same-file":
        return f"it and lane {other} both changed {file}"
    if why == "frozen-test":
        return f"one of it and lane {other} changed {file}, a test file the other holds"
    return f"{t.one(why, 40)}: {file}, with lane {other}"


def deviation_line(t: Text, item: Dict[str, Any]) -> str:
    """One recorded deviation, whatever its type, with its recorded words. One without a lane or the station's mark (every
    deviation of a build without lanes) reads exactly as before."""
    task = t.one(item.get("task"), 20, "no task")
    if isinstance(item.get("lane"), str) and item.get("lane") and item.get("by") != STATION:
        task += f" (lane {t.one(item.get('lane'), 10)})"
    kind = t.one(item.get("type"), 40) + (", recorded by the build station" if item.get("by") == STATION else "")
    return f"- {task}, {kind}: {t.one(item.get('detail'), REASON_LIMIT)}"


def duration(value: Any) -> str:
    """A recorded number of seconds in words, or "not recorded"."""
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
        return "not recorded"
    text = f"{float(value):.1f} seconds"
    return text + (f" (about {round(value / 60)} min)" if value >= 90 else "")


def task_list(t: Text, ids: Any) -> str:
    items = [t.one(item, 20) for item in ids or [] if isinstance(item, str)] if isinstance(ids, list) else []
    return ", ".join(items[:MAX_TASKS]) if items else "no task"


def lanes_lines(t: Text, report: Dict[str, Any], deviations: List[Dict[str, Any]]) -> List[str]:
    """M22, design 13.3: when the build was planned in lanes, what was recorded of them. How many lanes and which tasks each
    held; any lane set aside, why, and that its tasks were then built one at a time; a failure only the joined result showed
    and the fix task that answered it; the lanes' wall time against their summed time and the build's against its tasks'.
    Every number is a recorded one; one that was not recorded is said to be so. Nothing for a build without lanes."""
    lanes = report.get("lanes")
    if not isinstance(lanes, dict):
        return []
    if lanes.get("state") != "joined":
        return [f"Lanes were planned for this build but did not run: {t.one(lanes.get('why'), REASON_LIMIT)} "
                "It was built one task at a time in the cell.", ""]
    plan = lanes.get("plan") if isinstance(lanes.get("plan"), dict) else {}
    planned = [item for item in plan.get("lanes") or [] if isinstance(item, dict)] or [item for item in lanes.get("lanes") or [] if isinstance(item, dict)]
    join = lanes.get("join") if isinstance(lanes.get("join"), dict) else {}
    aside = {item.get("lane"): item for item in join.get("set_aside") or [] if isinstance(item, dict)}
    lines = [f"Built in {len(planned)} lanes at the same time, each in its own worktree from commit {sha(lanes.get('fork'))}, then joined "
             f"onto the ticket's branch, one commit per task in the plan's order, ending at commit {sha(join.get('tip'))}.", ""]
    if plan.get("before"):
        lines.append(f"- Before the lanes, in the cell: {task_list(t, plan.get('before'))}.")
    handed = handed_back(report, lanes, deviations)
    for item in planned[:MAX_ITEMS]:
        name = item.get("lane")
        line = f"- Lane {t.one(name, 10)} held {task_list(t, item.get('tasks'))}."
        if name in aside:
            because = [b for b in aside[name].get("because") or [] if isinstance(b, dict)]
            words = "; ".join(set_aside_words(t, b) for b in because[:MAX_ITEMS]) or "why was not recorded"
            line += (f" It was set aside at the join ({words}), so its commits were not landed; its tasks were then built again "
                     "one at a time in the cell, after the join.")
        elif name in handed:
            line += " " + handed_back_words(t, report, handed[name])
        lines.append(line)
    if plan.get("after"):
        lines.append(f"- After the lanes, in the cell: {task_list(t, plan.get('after'))}.")
    suite = join.get("suite") if isinstance(join.get("suite"), dict) else {}
    passed = suite.get("passed")
    lines.append("- The whole test suite on the joined result: " + ("passed." if passed is True else "failed." if passed is False else "not recorded."))
    interaction = next((item for item in deviations if item.get("type") == "lanes-interaction"), None)
    if passed is False or interaction is not None:
        fix_id = (interaction or {}).get("task") or "J-T01"
        fix = next((task for task in report.get("tasks") or [] if isinstance(task, dict) and task.get("id") == fix_id), {})
        failing = [item for item in (interaction or {}).get("failing") or [] if isinstance(item, str)]
        involved = [item for item in (interaction or {}).get("lanes") or [] if isinstance(item, str)]
        # Only what was recorded: which lanes' work the joined result held. Nothing records each lane's own suite at its end,
        # so the record does not say that every lane passed it.
        line = ("- The whole suite failed on the joined result" + (f": {', '.join(t.one(item, 200) for item in failing[:20])}" if failing else "")
                + (f" (lanes involved: {', '.join(t.one(item, 10) for item in involved)})" if involved else "") + ". "
                + joined_held(t, planned, aside, handed) + " ")
        already = next((item for item in deviations if item.get("type") == "impl-already-done" and item.get("task") == fix_id), None)
        if fix.get("status") == "done" and fix.get("commit"):
            line += f"The build station added {t.one(fix_id, 20)}, which made them pass together, at commit {sha(fix.get('commit'))}."
        elif fix.get("status") == "done" and already is not None:
            line += (f"The build station added {t.one(fix_id, 20)} to make them pass together; when it was reached nothing was left to change, "
                     f"and it was completed with the reason \"{t.one(already.get('detail'), REASON_LIMIT)}\".")
        elif fix.get("status") == "done":
            line += f"The build station added {t.one(fix_id, 20)} to make them pass together; it is done, and no commit of its own is recorded."
        else:
            line += f"The build station added {t.one(fix_id, 20)} to make them pass together; it is {t.one(fix.get('status'), 20, 'not recorded')}."
        lines.append(line)
    timing = report.get("timing") if isinstance(report.get("timing"), dict) else {}
    part = timing.get("lanes") if isinstance(timing.get("lanes"), dict) else {}
    steps = [step.get("seconds_since_previous_step") for step in timing.get("steps") or [] if isinstance(step, dict)]
    counted = [value for value in steps if isinstance(value, (int, float)) and not isinstance(value, bool)]
    summed = round(sum(counted), 1) if counted else None
    missing = len(steps) - len(counted)
    lines.append(f"- Time: the lanes took {duration(part.get('wall_seconds'))} of wall time, and their own times add up to {duration(part.get('summed_lane_seconds'))}. "
                 f"The whole build took {duration(timing.get('elapsed_seconds'))} from start to finish, and its tasks' recorded times add up to "
                 f"{duration(summed)}" + (f" ({missing} task{'s' if missing != 1 else ''} with no time recorded)" if counted and missing else "") + ". "
                 "A summed time is not what a build one task at a time would have taken; that build was not run.")
    return lines + [""]


def handed_back(report: Dict[str, Any], lanes: Dict[str, Any], deviations: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Each lane handed back to the cell, by name, from what the build recorded: the lane's own record in the report
    (`handed_back`: the reason, the tasks finished then, the tasks built in the cell), or, failing that, the deviations
    `lane-handed-back` (reason, tasks, finished) and `lane-handed-back-joined` (the tasks built in the cell)."""
    found: Dict[str, Dict[str, Any]] = {}
    for item in deviations:
        name = item.get("lane")
        if not isinstance(name, str) or not name:
            continue
        if item.get("type") == "lane-handed-back":
            entry = found.setdefault(name, {})
            entry.setdefault("reason", item.get("reason"))
            entry.setdefault("finished", item.get("finished"))
            entry.setdefault("unfinished", item.get("tasks"))
        elif item.get("type") == "lane-handed-back-joined":
            found.setdefault(name, {}).setdefault("built_in_cell", item.get("tasks"))
    for item in lanes.get("lanes") or []:
        if not isinstance(item, dict) or not isinstance(item.get("handed_back"), dict) or not isinstance(item.get("lane"), str):
            continue
        record = item["handed_back"]
        entry = found.setdefault(item["lane"], {})
        for key, field in (("reason", "reason"), ("finished", "finished_then"), ("unfinished", "unfinished_then"), ("built_in_cell", "built_in_cell")):
            if record.get(field) is not None:
                entry[key] = record.get(field)
    return found


def handed_back_words(t: Text, report: Dict[str, Any], entry: Dict[str, Any]) -> str:
    """A handed-back lane: the reason given, which of its tasks landed from the lane, and where its other tasks stand."""
    status = {task.get("id"): task.get("status") for task in report.get("tasks") or [] if isinstance(task, dict)}
    finished = [item for item in entry.get("finished") or [] if isinstance(item, str)]
    rest = [item for item in (entry.get("built_in_cell") or entry.get("unfinished") or []) if isinstance(item, str)]
    words = f"It was handed back to the cell before it finished, because \"{t.one(entry.get('reason'), REASON_LIMIT)}\""
    parts = [f"{task_list(t, finished)} landed from the lane at the join" if finished else "none of its tasks had finished, so nothing landed from it"]
    built = [item for item in rest if status.get(item) == "done"]
    waiting = [item for item in rest if status.get(item) != "done"]
    if built:
        parts.append(f"{task_list(t, built)} {'was' if len(built) == 1 else 'were'} then built in the cell, one at a time, after the join")
    if waiting:
        states = sorted({t.one(status.get(item), 20, "not recorded") for item in waiting})
        parts.append(f"{task_list(t, waiting)} {'is' if len(waiting) == 1 else 'are'} to be built in the cell after the join; "
                     f"{'it is' if len(waiting) == 1 else 'they are'} {' or '.join(states)}")
    return words + ": " + ", and ".join(parts) + "."


def joined_held(t: Text, planned: List[Dict[str, Any]], aside: Dict[Any, Any], handed: Dict[str, Dict[str, Any]]) -> str:
    """What the joined result held, from the recorded lanes: the work of each lane landed whole, and what each handed-back
    lane had finished. A set-aside lane's work was not landed, so it is not named."""
    whole = [item.get("lane") for item in planned if isinstance(item.get("lane"), str) and item.get("lane") not in aside and item.get("lane") not in handed]
    names = [t.one(name, 10) for name in whole]
    listed = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1] if names else ""
    parts = [f"the work of lane{'s' if len(names) > 1 else ''} {listed}"] if names else []
    for name in sorted(handed):
        finished = [item for item in handed[name].get("finished") or [] if isinstance(item, str)]
        if finished:
            parts.append(f"what lane {t.one(name, 10)} finished before it was handed back ({task_list(t, finished)})")
    return ("It held " + " and ".join(parts) + ".") if parts else "It held no lane's work."


COMMAND_SET = ("test-command-set", "lint-command-set")


def commands_lines(t: Text, deviations: List[Dict[str, Any]]) -> List[str]:
    """A test or lint command set or changed while building (build.py set-commands): each with what it was, what it is
    now, why and when, from the recorded deviation. Nothing when none was, so every record without one is as before."""
    items = [item for item in deviations if item.get("type") in COMMAND_SET]
    if not items:
        return []
    lines: List[str] = []
    for item in items[:MAX_ITEMS]:
        kind = item.get("command") if item.get("command") in ("test", "lint") else str(item.get("type")).split("-", 1)[0]
        if "new" not in item:
            lines.append(f"- The {kind} command: {t.one(item.get('detail'), REASON_LIMIT)}")
            continue
        old, new = item.get("old"), item.get("new")
        when = t.one(item.get("at"), 40) + (f" ({t.one(item.get('during'), 60)})" if item.get("during") else "")
        was = f"it was \"{t.one(old, 300)}\", and" if isinstance(old, str) and old.strip() else "there was none before, and it"
        lines.append(f"- The {kind} command was {'changed' if isinstance(old, str) and old.strip() else 'set'} at {when}: {was} is now "
                     f"\"{t.one(new, 300)}\". Reason: {t.one(item.get('reason'), REASON_LIMIT).rstrip('.')}.")
    return ["Commands set or changed during the build, as recorded:", ""] + capped(lines, len(items), MAX_ITEMS, "command changes") + [""]


def commits_section(commits: Dict[str, Optional[str]]) -> List[str]:
    lines = ["## Commits", "", f"- Approved by review: {sha(commits.get('approved'))}"]
    if commits.get("revalidated"):
        lines.append(f"- Brought up to date with the main branch (at {sha(commits.get('onto'))}) and tested again: {sha(commits.get('revalidated'))}")
    lines += [f"- This record was added on top of: {sha(commits.get('base'))}",
              "- The commit that adds this record, and the merge into the main branch, come after it was written: Git's history and the run record "
              "(`.factory/archive/runs.jsonl`) name them.", ""]
    return lines


# ---------------------------------------------------------------- the facts, for MACH

def facts(root: Path, info: Dict[str, Any], ticket_id: str, commits: Dict[str, Optional[str]], rules: Any, spec_sha256: Optional[str]) -> Dict[str, Any]:
    """What release qualification needs to know of this ticket, as data. Identifiers, verdicts, hashes and commits are
    kept as recorded; a title, reason or note is redacted, bounded and made inert like the text above it, the same way
    on a blocker and on the exception that names it, so the two still match."""
    t = Text(rules)

    def words(value: Any, limit: int) -> Optional[str]:
        return _inert(rules.bound_text(value, limit, one_line=True)[0]) if isinstance(value, str) and value.strip() else None

    def commit(value: Any) -> Optional[str]:
        return value if isinstance(value, str) and SHA_RE.match(value) else None

    product = info.get("product") if isinstance(info.get("product"), dict) else {}
    issue = product.get("issue") if isinstance(product.get("issue"), dict) else {}
    summary = load_dict(root / "evidence" / "summary.json")
    checks = summary.get("checks") if isinstance(summary.get("checks"), dict) else {}
    decision = load_dict(root / "review" / "decision.json")
    rounds = numbered(list((root / "review").glob("round-*")) if (root / "review").is_dir() else [], "round")
    blockers: List[Dict[str, Any]] = []
    votes = rounds[-1] / "votes" if rounds else None
    for path in sorted(votes.glob("*.json")) if votes is not None and votes.is_dir() else []:
        vote = load_dict(path)
        for finding in vote.get("findings") if isinstance(vote.get("findings"), list) else []:
            if isinstance(finding, dict) and finding.get("severity") == "blocker":
                blockers.append({"round": decision.get("round"), "reviewer": words(str(vote.get("reviewer") or path.stem), 40), "rule": words(finding.get("rule"), LINE_LIMIT),
                                 "title": words(finding.get("title"), TITLE_LIMIT) or "", "file": words(finding.get("file"), 200),
                                 "class": finding.get("class") if finding.get("class") == "security" else None})
    human = decision.get("human_approval") if isinstance(decision.get("human_approval"), dict) else None
    return {
        "version": VERSION,
        "ticket_id": ticket_id,
        "slice_id": product.get("slice_id") or info.get("slice_id"),
        "revision": product.get("revision") if type(product.get("revision")) is int else None,
        "epic_id": product.get("epic_id"),
        "issue": issue.get("number") if type(issue.get("number")) is int else None,
        "depends_on": sorted((item for item in product.get("depends_on") or [] if isinstance(item, str)), key=natural),
        "spec": {"path": info.get("spec_path") if isinstance(info.get("spec_path"), str) else None,
                 "sha256": spec_sha256 if isinstance(spec_sha256, str) and SHA256_RE.match(spec_sha256) else None},
        "contracts": sorted(item for item in info.get("contracts") or [] if isinstance(item, str)),
        "commits": {key: commit(commits.get(key)) for key in ("approved", "revalidated", "base")},
        "verification": {
            "status": summary.get("status") if isinstance(summary.get("status"), str) else None, "head": commit(summary.get("head")),
            "checks": {str(key): {"result": check.get("result") if check.get("result") in ("pass", "fail") else None, "note": words(check.get("note"), NOTE_LIMIT),
                                  "evidence": sorted(name for name in check.get("evidence") or [] if isinstance(name, str))[:20]}
                       for key, check in sorted(checks.items(), key=lambda pair: natural(pair[0]))[:MAX_CHECKS] if isinstance(check, dict)},
            "checks_recorded": len(checks),
            "evidence_files": sorted(({"file": entry["file"], "sha256": entry.get("sha256") if SHA256_RE.match(str(entry.get("sha256"))) else None}
                                      for entry in summary.get("evidence_files") or [] if isinstance(entry, dict) and isinstance(entry.get("file"), str)),
                                     key=lambda entry: entry["file"])[:MAX_FILES * 4],
            **({"evidence_mode": {"mode": "headless", "reason": words(headless_mode(summary).get("reason"), 40),
                                  "why": words(headless_mode(summary).get("why"), NOTE_LIMIT)}} if headless_mode(summary) else {}),
        },
        "review": {
            "outcome": decision.get("outcome") if isinstance(decision.get("outcome"), str) else None, "round": decision.get("round"),
            "risk": decision.get("risk") if isinstance(decision.get("risk"), str) else None, "head": commit(decision.get("head")),
            "blockers": decision.get("blockers") if type(decision.get("blockers")) is int else None,
            "human_approval_required": decision.get("human_approval_required") is True,
            "human_approval": {"by": t.one(human.get("by"), 80), "recorded_at": words(human.get("recorded_at"), 40)} if human else None,
            "exceptions": [{"round": item.get("round"), "seat": words(item.get("seat"), 40), "index": item.get("index"), "title": words(item.get("title"), TITLE_LIMIT) or "",
                            "rule": words(item.get("rule"), LINE_LIMIT), "file": words(item.get("file"), 200), "by": words(item.get("by"), 80),
                            "reason": words(item.get("reason"), REASON_LIMIT), "recorded_at": words(item.get("recorded_at"), 40), "head": commit(item.get("head")),
                            "expires": words(item.get("expires"), 12)}
                           for item in (decision.get("exceptions") if isinstance(decision.get("exceptions"), list) else [])[:MAX_ITEMS] if isinstance(item, dict)],
        },
        "blockers": blockers[:MAX_FINDINGS],
        "blockers_recorded": len(blockers),
    }


def facts_section(data: Dict[str, Any]) -> List[str]:
    """The block as the record's last section. One JSON value per line, so a fence mark inside a string can never close the fence."""
    return [FACTS_HEADING, "", "Facts for release qualification, read by MACH from the main branch. Do not edit: a record changed after it landed no longer counts.", "",
            FACTS_MARK, "```json", *json.dumps(data, indent=1, sort_keys=True, ensure_ascii=True).split("\n"), "```", ""]


def read_facts(text: Any) -> Optional[Dict[str, Any]]:
    """The facts a version 2 record carries, or None: no block, more than one, a block that is not the record's last
    section, or JSON that is not this version's. An earlier record (version 1) has none and is never parsed."""
    if not isinstance(text, str):
        return None
    lines = text.split("\n")
    marks = [index for index, line in enumerate(lines) if line == FACTS_MARK]
    if len(marks) != 1 or len(lines) < marks[0] + 3 or lines[marks[0] + 1] != "```json":
        return None
    start = marks[0] + 2
    end = next((index for index in range(start, len(lines)) if lines[index] == "```"), None)
    if end is None or any(line.strip() for line in lines[end + 1:]):
        return None
    body = "\n".join(lines[start:end])
    if len(body) > FACTS_LIMIT:
        return None
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("version") != VERSION:
        return None
    shaped = all(isinstance(data.get(key), dict) for key in ("spec", "commits", "verification", "review")) and \
        all(isinstance(data.get(key), list) for key in ("contracts", "depends_on", "blockers"))
    return data if shaped else None


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
    if FACTS_MARK in text and read_facts(masked) is None:
        raise RecordError("Masking a likely secret left the change record's facts for MACH unreadable, so it was not written and nothing was merged. "
                          "Look at the cell's files for the value.")
    return masked


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
